/**
 * US News Engine — recall preview batch generator (Phase 7B).
 *
 * Selects exactly 3 recall stories from recall-story-clusters.json:
 *   - ONE CPSC story (highest score)
 *   - ONE FDA Food story (highest score)
 *   - ONE FDA Device story (highest score)
 *
 * For each story, runs:
 *   1. node scripts/generate-recall-draft.mjs "<storyKey>"
 *      → writes data/recalls/drafts/<slug>.json
 *   2. node scripts/generate-recall-image.mjs "<storyKey>"
 *      → writes data/draft-images/<slug>.{jpg|png} + <slug>.json
 *   3. Copies the generated image into public/preview-images/ so the
 *      preview route at /preview/recall/<slug>/ can render it.
 *
 * At the end, prints a summary of the 3 selected stories, their slugs,
 * and preview paths.
 *
 * Run manually:
 *   node scripts/generate-recall-previews.mjs
 *
 * Constraints:
 *   - Never modifies any NWS/weather scripts.
 *   - Never modifies .github/workflows/nws-newsroom.yml.
 *   - Never modifies config/automation.json.
 *   - Never creates public article files in src/content/articles/.
 *   - Never turns off DEMO_NOINDEX.
 *   - All child scripts are invoked as ES modules (.mjs).
 *   - Uses only Node.js built-ins (child_process, fs, path).
 */

import { readFile, copyFile, mkdir, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(__dirname, '..');
const CLUSTERS_FILE = join(
  PROJECT_DIR,
  'data',
  'recalls',
  'recall-story-clusters.json',
);
const DRAFTS_DIR = join(PROJECT_DIR, 'data', 'recalls', 'drafts');
const DRAFT_IMAGES_DIR = join(PROJECT_DIR, 'data', 'draft-images');
const PREVIEW_IMAGES_DIR = join(PROJECT_DIR, 'public', 'preview-images');

// ===========================================================================
// Helpers
// ===========================================================================

function fail(message, detail) {
  console.error(`\n[generate-recall-previews] ERROR: ${message}`);
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
// Story selection
// ===========================================================================

/**
 * Pick the top-scoring story for a given source/sourceType filter.
 * Returns the story object or null if no match.
 */
function pickTopStory(stories, predicate, label) {
  const matches = stories
    .filter(predicate)
    .sort((a, b) => (b.storyScore || 0) - (a.storyScore || 0));
  if (matches.length === 0) {
    console.warn(`  WARNING: No stories matched for ${label}.`);
    return null;
  }
  return matches[0];
}

// ===========================================================================
// Main
// ===========================================================================

async function main() {
  console.log('[generate-recall-previews] Starting recall preview batch.');
  console.log(`  Input: ${CLUSTERS_FILE}`);

  let raw;
  try {
    raw = await readFile(CLUSTERS_FILE, 'utf8');
  } catch (err) {
    return fail(
      'Could not read recall-story-clusters.json. Run `npm run cluster:recalls` first.',
      String(err),
    );
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    return fail('Clusters file is not valid JSON.', String(err));
  }
  const stories = Array.isArray(doc.stories) ? doc.stories : [];
  if (stories.length === 0) {
    return fail('No recall stories available.');
  }

  // --- Select 3 stories ----------------------------------------------------
  const cpscStory = pickTopStory(
    stories,
    (s) => s.source === 'CPSC',
    'CPSC',
  );
  const fdaFoodStory = pickTopStory(
    stories,
    (s) => s.source === 'FDA' && s.sourceType === 'food',
    'FDA food',
  );
  const fdaDeviceStory = pickTopStory(
    stories,
    (s) => s.source === 'FDA' && s.sourceType === 'device',
    'FDA device',
  );

  const selected = [
    { label: 'CPSC', story: cpscStory },
    { label: 'FDA Food', story: fdaFoodStory },
    { label: 'FDA Device', story: fdaDeviceStory },
  ].filter((entry) => entry.story !== null);

  if (selected.length === 0) {
    return fail('No qualifying stories found across CPSC / FDA food / FDA device.');
  }

  console.log('\n  Selected stories:');
  for (const entry of selected) {
    console.log(
      `    [${entry.label}] score=${entry.story.storyScore} | ${entry.story.recallStoryKey}`,
    );
  }
  console.log('');

  // --- Ensure output dirs exist -------------------------------------------
  await mkdir(DRAFTS_DIR, { recursive: true });
  await mkdir(DRAFT_IMAGES_DIR, { recursive: true });
  await mkdir(PREVIEW_IMAGES_DIR, { recursive: true });

  // --- For each story: draft + image + copy --------------------------------
  const results = [];
  for (const entry of selected) {
    const storyKey = entry.story.recallStoryKey;
    console.log(`\n  ============================================`);
    console.log(`  Processing [${entry.label}]: ${storyKey}`);
    console.log(`  ============================================`);

    // 1. Generate draft.
    console.log(`\n  [1/3] Generating draft...`);
    await runNode(join('scripts', 'generate-recall-draft.mjs'), storyKey);

    // Read the draft back to get the slug (the image generator derives the
    // same slug, but reading the draft file gives us a single source of
    // truth).
    const { readdir } = await import('node:fs/promises');
    const draftsList = await readdir(DRAFTS_DIR);
    // Find the most recent draft JSON for this storyKey.
    let draftPath = null;
    for (const f of draftsList) {
      if (!f.endsWith('.json')) continue;
      const full = join(DRAFTS_DIR, f);
      const content = await readFile(full, 'utf8');
      try {
        const d = JSON.parse(content);
        if (d.storyKey === storyKey) {
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
    await runNode(join('scripts', 'generate-recall-image.mjs'), storyKey);

    // Find the generated image file (.jpg for CPSC photo path, .png for editorial).
    const draftImagesList = await readdir(DRAFT_IMAGES_DIR);
    let imageFile = null;
    let imageExt = null;
    for (const ext of ['.jpg', '.png']) {
      const candidate = draftImagesList.find((f) => f === `${slug}${ext}`);
      if (candidate) {
        imageFile = candidate;
        imageExt = ext;
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

    results.push({
      label: entry.label,
      storyKey,
      slug,
      draftPath,
      imagePath: dstImagePath,
      previewPath: `/preview-images/${imageFile}`,
      previewUrl: `/preview/recall/${slug}/`,
    });
  }

  // --- Final summary -------------------------------------------------------
  console.log('\n============================================================');
  console.log('[generate-recall-previews] SUCCESS — 3 previews generated.');
  console.log('============================================================');
  console.log('');
  console.log('Selected stories and preview paths:');
  for (const r of results) {
    console.log('');
    console.log(`  [${r.label}]`);
    console.log(`    storyKey:     ${r.storyKey}`);
    console.log(`    slug:         ${r.slug}`);
    console.log(`    draft:        ${r.draftPath}`);
    console.log(`    image:        ${r.imagePath}`);
    console.log(`    preview img:  ${r.previewPath}`);
    console.log(`    preview URL:  ${r.previewUrl}`);
  }
  console.log('');
}

main().catch((err) =>
  fail('Unexpected failure.', String(err && err.stack ? err.stack : err)),
);
