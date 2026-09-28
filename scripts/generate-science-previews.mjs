/**
 * US News Engine — Science preview batch generator (Phase 9B).
 *
 * Selects exactly 3 publishEligible Science stories from
 * data/science/science-story-records.json:
 *
 *   1. NISAR — JPL volcanic-eruption time-lapse (verified-agency image)
 *   2. Perseverance — JPL Mars water-systems finding (mixed-agency image)
 *   3. Hubble — NASA spiral-galaxy image-article (third-party image →
 *      factual-graphic fallback)
 *
 * For each story, runs:
 *   1. node scripts/generate-science-draft.mjs "<scienceStoryKey>"
 *      → writes data/science/drafts/<slug>.json
 *   2. node scripts/generate-science-image.mjs "<scienceStoryKey>"
 *      → writes data/draft-images/<slug>.{jpg|png} + <slug>.json
 *   3. Copies the generated image into public/preview-images/ so the
 *      preview route at /preview/science/<slug>/ can render it.
 *
 * At the end, prints a summary of the 3 selected stories, their slugs,
 * image modes, and preview URLs.
 *
 * Run manually:
 *   node scripts/generate-science-previews.mjs
 *
 * Constraints:
 *   - Never modifies any weather/recall/earthquake scripts.
 *   - Never modifies .github/workflows/* files.
 *   - Never modifies config/automation.json.
 *   - Never creates public article files in src/content/articles/.
 *   - Never turns off DEMO_NOINDEX.
 *   - All child scripts are invoked as ES modules (.mjs).
 *   - Uses only Node.js built-ins (child_process, fs, path).
 */

import { readFile, copyFile, mkdir, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(__dirname, '..');
const STORY_RECORDS_FILE = join(
  PROJECT_DIR,
  'data',
  'science',
  'science-story-records.json',
);
const DRAFTS_DIR = join(PROJECT_DIR, 'data', 'science', 'drafts');
const DRAFT_IMAGES_DIR = join(PROJECT_DIR, 'data', 'draft-images');
const PREVIEW_IMAGES_DIR = join(PROJECT_DIR, 'public', 'preview-images');

// The 3 publishEligible Science stories this batch always generates previews
// for. Each entry pairs a storyKey with a short editorial label.
const SELECTED_STORIES = [
  {
    label: 'NISAR (verified-agency)',
    scienceStoryKey: 'jpl__a0b05eee4e3af8ae',
  },
  {
    label: 'Perseverance (mixed-agency)',
    scienceStoryKey: 'jpl__7cdc58bb88b1db7c',
  },
  {
    label: 'Hubble (third-party → graphic)',
    scienceStoryKey: 'nasa__4c93b21d54ff615c',
  },
];

// ===========================================================================
// Helpers
// ===========================================================================

function fail(message, detail) {
  console.error(`\n[generate-science-previews] ERROR: ${message}`);
  if (detail) console.error(`  Detail: ${detail}`);
  process.exit(1);
}

/**
 * Run a node script and stream its output to the parent process.
 * Resolves with exit code 0 on success, rejects on non-zero exit.
 */
function runNode(scriptPath, storyKey) {
  return new Promise((resolve, reject) => {
    const args = storyKey ? [scriptPath, storyKey] : [scriptPath];
    const child = spawn('node', args, {
      cwd: PROJECT_DIR,
      stdio: 'inherit',
      env: { ...process.env },
    });
    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${scriptPath} exited with code ${code}`));
    });
  });
}

// ===========================================================================
// Main
// ===========================================================================

async function main() {
  console.log('[generate-science-previews] Starting science preview batch.');
  console.log(`  Input: ${STORY_RECORDS_FILE}`);

  // Sanity-check that the selected stories actually exist in the records.
  let raw;
  try {
    raw = await readFile(STORY_RECORDS_FILE, 'utf8');
  } catch (err) {
    return fail(
      'Could not read science-story-records.json. Run `npm run stories:science` first.',
      String(err),
    );
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    return fail('Story-records file is not valid JSON.', String(err));
  }
  const stories = Array.isArray(doc.stories) ? doc.stories : [];
  if (stories.length === 0) {
    return fail('No science stories available.');
  }

  // Verify each selected story key exists.
  for (const entry of SELECTED_STORIES) {
    const found = stories.find((s) => s.scienceStoryKey === entry.scienceStoryKey);
    if (!found) {
      return fail(
        `Selected story not found: ${entry.scienceStoryKey}`,
        `Available keys: ${stories.map((s) => s.scienceStoryKey).slice(0, 8).join(', ')}...`,
      );
    }
    if (!found.publishEligible) {
      console.warn(
        `  WARNING: ${entry.scienceStoryKey} is NOT publishEligible (continuing anyway).`,
      );
    }
  }

  console.log('\n  Selected stories:');
  for (const entry of SELECTED_STORIES) {
    const s = stories.find((x) => x.scienceStoryKey === entry.scienceStoryKey);
    console.log(
      `    [${entry.label}] score=${s.storyScore} | ${entry.scienceStoryKey}`,
    );
    console.log(`      title: ${s.title}`);
  }
  console.log('');

  // --- Ensure output dirs exist -------------------------------------------
  await mkdir(DRAFTS_DIR, { recursive: true });
  await mkdir(DRAFT_IMAGES_DIR, { recursive: true });
  await mkdir(PREVIEW_IMAGES_DIR, { recursive: true });

  // --- For each story: draft + image + copy --------------------------------
  const results = [];
  for (const entry of SELECTED_STORIES) {
    const storyKey = entry.scienceStoryKey;
    console.log(`\n  ============================================`);
    console.log(`  Processing [${entry.label}]: ${storyKey}`);
    console.log(`  ============================================`);

    // 1. Generate draft.
    console.log(`\n  [1/3] Generating draft...`);
    await runNode(join('scripts', 'generate-science-draft.mjs'), storyKey);

    // Read the draft back to get the slug.
    const { readdir } = await import('node:fs/promises');
    const draftsList = await readdir(DRAFTS_DIR);
    let draftPath = null;
    for (const f of draftsList) {
      if (!f.endsWith('.json')) continue;
      const full = join(DRAFTS_DIR, f);
      const content = await readFile(full, 'utf8');
      try {
        const d = JSON.parse(content);
        if (d.scienceStoryKey === storyKey) {
          draftPath = full;
          break;
        }
      } catch {
        // ignore
      }
    }
    if (!draftPath) {
      throw new Error(`Could not find draft file for ${storyKey}`);
    }
    const draft = JSON.parse(await readFile(draftPath, 'utf8'));
    const slug = draft.slug;
    console.log(`  Draft slug: ${slug}`);

    // 2. Generate image.
    console.log(`\n  [2/3] Generating image...`);
    await runNode(join('scripts', 'generate-science-image.mjs'), storyKey);

    // Find the generated image file (.jpg for verified-agency/mixed-agency,
    // .png for the factual-graphic fallback).
    const draftImagesList = await readdir(DRAFT_IMAGES_DIR);
    let imageFile = null;
    let imageExt = null;
    for (const ext of ['.jpg', '.png']) {
      const candidate = draftImagesList.find((f) => f === `${slug}${ext}`);
      if (candidate) {
        imageFile = candidate;
        imageExt = ext.slice(1);
        break;
      }
    }
    if (!imageFile) {
      throw new Error(
        `Could not find generated image for slug "${slug}" in ${DRAFT_IMAGES_DIR}`,
      );
    }
    const srcImagePath = join(DRAFT_IMAGES_DIR, imageFile);
    const dstImagePath = join(PREVIEW_IMAGES_DIR, imageFile);
    console.log(`  Source image: ${srcImagePath}`);

    // 3. Copy image to public/preview-images/.
    console.log(`\n  [3/3] Copying image to public/preview-images/...`);
    await copyFile(srcImagePath, dstImagePath);
    const imgStats = await stat(dstImagePath);
    console.log(`  Copied: ${dstImagePath} (${imgStats.size.toLocaleString()} bytes)`);

    // Load image metadata sidecar to capture the image mode for the summary.
    let imageMode = null;
    let rightsStatus = null;
    let creditVerification = null;
    try {
      const metaPath = join(DRAFT_IMAGES_DIR, `${slug}.json`);
      const meta = JSON.parse(await readFile(metaPath, 'utf8'));
      imageMode = meta.imageMode || null;
      rightsStatus = meta.rightsStatus || null;
      creditVerification = meta.creditVerification || null;
    } catch {
      // No sidecar — best-effort summary.
    }

    results.push({
      label: entry.label,
      storyKey,
      slug,
      draftPath,
      imagePath: dstImagePath,
      previewPath: `/preview-images/${imageFile}`,
      previewUrl: `/preview/science/${slug}/`,
      imageMode,
      rightsStatus,
      creditVerification,
    });
  }

  // --- Final summary -------------------------------------------------------
  console.log('\n============================================================');
  console.log('[generate-science-previews] SUCCESS — 3 previews generated.');
  console.log('============================================================');
  console.log('');
  console.log('Selected stories and preview paths:');
  for (const r of results) {
    console.log('');
    console.log(`  [${r.label}]`);
    console.log(`    storyKey:         ${r.storyKey}`);
    console.log(`    slug:             ${r.slug}`);
    console.log(`    draft:            ${r.draftPath}`);
    console.log(`    image:            ${r.imagePath}`);
    console.log(`    image mode:       ${r.imageMode}`);
    console.log(`    rights status:    ${r.rightsStatus}`);
    if (r.creditVerification) {
      console.log(
        `    credit check:     ${r.creditVerification.verified ? 'verified' : 'not used'} — ${r.creditVerification.reason}`,
      );
    }
    console.log(`    preview img:      ${r.previewPath}`);
    console.log(`    preview URL:      ${r.previewUrl}`);
  }
  console.log('');
  console.log('Preview URLs (paste into browser):');
  for (const r of results) {
    console.log(`  - ${r.previewUrl}`);
  }
  console.log('');
}

main().catch((err) =>
  fail('Unexpected failure.', String(err && err.stack ? err.stack : err)),
);
