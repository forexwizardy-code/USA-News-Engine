/**
 * US News Engine — image provenance registry builder (Phase 5B).
 *
 * Reads every `*-real.json` file in `data/draft-images/` (one per licensed
 * photo we've selected for a story) and builds `data/image-provenance.json`:
 * a registry of image provenance keyed by `originalImageUrl`.
 *
 * Each entry stores:
 *   - sourcePageUrl
 *   - originalImageUrl
 *   - creator
 *   - license
 *   - licenseUrl
 *   - sourceOrganization  (derived from creator; the metadata field is often
 *                          a leftover template value and is overridden when
 *                          it doesn't actually describe the image's creator)
 *   - imageRelation
 *   - firstUsedAt         (the earliest publishedAt among stories using it;
 *                          falls back to downloadedAt if no story yet)
 *   - storiesUsingImage   (array of storyKeys)
 *
 * The script also scans all article markdown files in `src/content/articles/`
 * to find which stories reference each image (via the `image:` frontmatter
 * field), so the registry reflects reality even when a draft's storyKey and
 * the published article's slug drift apart.
 *
 * Run manually:
 *   node scripts/create-image-provenance.mjs
 *
 * Uses only Node.js built-in modules — no gray-matter, no external deps.
 */

import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(__dirname, '..');
const DRAFT_IMAGES_DIR = join(PROJECT_DIR, 'data', 'draft-images');
const ARTICLES_DIR = join(PROJECT_DIR, 'src', 'content', 'articles');
const PUBLISHED_STORIES_FILE = join(PROJECT_DIR, 'data', 'published-stories.json');
const OUTPUT_FILE = join(PROJECT_DIR, 'data', 'image-provenance.json');

// ---------------------------------------------------------------------------
// Frontmatter parser (no gray-matter dependency — flat key:value only).
// ---------------------------------------------------------------------------

function parseFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return { data: {}, body: text };
  const yaml = match[1];
  const body = text.slice(match[0].length).replace(/^\r?\n+/, '');
  const data = {};
  for (const line of yaml.split(/\r?\n/)) {
    const m = line.match(/^(\w+):\s*(.*)$/);
    if (!m) continue;
    const [, key, rawVal] = m;
    let val = rawVal.trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    else if (val.startsWith("'") && val.endsWith("'")) val = val.slice(1, -1);
    if (val === 'true') val = true;
    else if (val === 'false') val = false;
    else if (/^-?\d+$/.test(val)) val = parseInt(val, 10);
    else if (val.startsWith('[') && val.endsWith(']')) {
      val = val
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    }
    data[key] = val;
  }
  return { data, body };
}

// ---------------------------------------------------------------------------
// Source-organization derivation.
//
// The metadata field `sourceOrganization` in the draft-images *-real.json
// files is templated to "Lake County, Illinois (LakeCountyIL)" for every
// story — that value is correct only for the Lake County IL story (whose
// creator is "LakeCountyIL"). For every other story it's a stale leftover.
//
// Rule:
//   - If the parenthetical token at the end of `sourceOrganization` equals
//     `creator`, the metadata value is accurate — use it as-is.
//   - Otherwise, derive a fresh value from `creator` + `source`. For
//     Wikimedia Commons images this is "{creator} (Wikimedia Commons)".
//     For the Lake County FL story specifically (creator = "Ebyabe") this
//     yields "Ebyabe (Wikimedia Commons)" — which is what the task requires.
// ---------------------------------------------------------------------------

function deriveSourceOrganization(meta) {
  const creator = String(meta.creator || '').trim();
  const metaSourceOrg = String(meta.sourceOrganization || '').trim();
  const source = String(meta.source || '').trim();

  if (creator && metaSourceOrg) {
    const parenMatch = metaSourceOrg.match(/\(([^)]+)\)\s*$/);
    if (parenMatch && parenMatch[1] === creator) {
      return metaSourceOrg;
    }
  }

  if (!creator) {
    return metaSourceOrg || source || 'Unknown';
  }
  if (source === 'Wikimedia Commons') {
    return `${creator} (Wikimedia Commons)`;
  }
  return creator;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('[create-image-provenance] Building image provenance registry.');

  // --- Load published-stories.json for firstUsedAt + slug↔storyKey mapping -
  let publishedStories = [];
  try {
    const doc = JSON.parse(await readFile(PUBLISHED_STORIES_FILE, 'utf8'));
    publishedStories = Array.isArray(doc.stories) ? doc.stories : [];
  } catch {
    console.log('  Warning: published-stories.json not found or unreadable.');
  }
  const storyByStoryKey = new Map(publishedStories.map((s) => [s.storyKey, s]));
  const storyBySlug = new Map(publishedStories.map((s) => [s.slug, s]));

  console.log(`  Published stories: ${publishedStories.length}`);

  // --- Scan article markdown files to build image-path → storyKey(s) map ----
  // The article frontmatter `image:` field is the deployed path like
  // "/images/<slug>-real.jpg". We map that to the storyKey by looking up the
  // slug in the registry (or falling back to the frontmatter slug).
  const imagePathToStoryKeys = new Map();
  let articleFiles = [];
  try {
    articleFiles = (await readdir(ARTICLES_DIR)).filter((f) => f.endsWith('.md'));
  } catch {
    console.log('  Warning: src/content/articles/ not found.');
  }

  for (const file of articleFiles) {
    const raw = await readFile(join(ARTICLES_DIR, file), 'utf8');
    const { data: fm } = parseFrontmatter(raw);
    if (!fm.image) continue;

    let storyKey = null;
    if (fm.slug && storyBySlug.has(fm.slug)) {
      storyKey = storyBySlug.get(fm.slug).storyKey;
    } else if (fm.slug) {
      storyKey = fm.slug; // fallback when no registry entry yet
    }
    if (!storyKey) continue;

    if (!imagePathToStoryKeys.has(fm.image)) {
      imagePathToStoryKeys.set(fm.image, []);
    }
    const arr = imagePathToStoryKeys.get(fm.image);
    if (!arr.includes(storyKey)) arr.push(storyKey);
  }

  console.log(`  Article markdown files scanned: ${articleFiles.length}`);
  console.log(`  Distinct hero image paths in articles: ${imagePathToStoryKeys.size}`);

  // --- Read all `*-real.json` files in data/draft-images/ ------------------
  let draftImageFiles = [];
  try {
    draftImageFiles = (await readdir(DRAFT_IMAGES_DIR)).filter((f) =>
      f.endsWith('-real.json'),
    );
  } catch {
    console.log('  Warning: data/draft-images/ not found.');
  }
  console.log(`  Draft-image real.json files: ${draftImageFiles.length}`);

  // --- Build the registry keyed by originalImageUrl ------------------------
  const registry = {};

  for (const file of draftImageFiles) {
    let meta;
    try {
      meta = JSON.parse(await readFile(join(DRAFT_IMAGES_DIR, file), 'utf8'));
    } catch (err) {
      console.log(`  Warning: could not parse ${file}: ${err.message}`);
      continue;
    }

    const originalImageUrl = meta.originalImageUrl;
    if (!originalImageUrl) {
      console.log(`  Warning: ${file} has no originalImageUrl — skipping.`);
      continue;
    }

    // Find stories that ACTUALLY USE this image, by matching the deployed
    // image path against the article markdown scan and the published-stories
    // registry's heroImageSource. A real.json file may exist for a story that
    // ultimately published with a map instead — in that case the photo was
    // prepared but not deployed, and storiesUsingImage stays empty.
    const storiesUsingImage = new Set();

    // The slug-derived deployed path for this real.json file:
    //   <slug>-real.json  →  /images/<slug>-real.jpg
    const slugGuess = file.replace(/-real\.json$/, '');
    const expectedDeployedPath = `/images/${slugGuess}-real.jpg`;

    // Signal 1: article markdown `image:` field matches the deployed path.
    for (const [imgPath, storyKeys] of imagePathToStoryKeys.entries()) {
      if (imgPath === expectedDeployedPath) {
        for (const sk of storyKeys) storiesUsingImage.add(sk);
      }
    }

    // Signal 2: published-stories.json heroImageSource matches the deployed
    // path. (Same story also appears in the markdown scan, but this is a
    // belt-and-suspenders check in case an article file is missing.)
    for (const s of publishedStories) {
      if (s.heroImageSource === expectedDeployedPath) {
        storiesUsingImage.add(s.storyKey);
      }
    }

    // Determine firstUsedAt: earliest publishedAt among stories using image.
    let firstUsedAt = null;
    for (const sk of storiesUsingImage) {
      const s = storyByStoryKey.get(sk);
      if (s && s.publishedAt) {
        if (!firstUsedAt || s.publishedAt < firstUsedAt) {
          firstUsedAt = s.publishedAt;
        }
      }
    }
    // Fallback: downloadedAt from the real.json metadata.
    if (!firstUsedAt && meta.downloadedAt) {
      firstUsedAt = meta.downloadedAt;
    }

    const entry = {
      sourcePageUrl: meta.sourcePageUrl || '',
      originalImageUrl,
      creator: meta.creator || '',
      license: meta.license || '',
      licenseUrl: meta.licenseUrl || '',
      sourceOrganization: deriveSourceOrganization(meta),
      imageRelation: meta.imageRelation || '',
      firstUsedAt,
      storiesUsingImage: Array.from(storiesUsingImage).sort(),
    };

    // Merge if same originalImageUrl already seen (two real.json files can
    // reference the same original image — e.g., a duplicate draft).
    if (registry[originalImageUrl]) {
      const existing = registry[originalImageUrl];
      for (const sk of entry.storiesUsingImage) {
        if (!existing.storiesUsingImage.includes(sk)) {
          existing.storiesUsingImage.push(sk);
        }
      }
      existing.storiesUsingImage.sort();
      if (
        entry.firstUsedAt &&
        (!existing.firstUsedAt || entry.firstUsedAt < existing.firstUsedAt)
      ) {
        existing.firstUsedAt = entry.firstUsedAt;
      }
      // Prefer the entry that has non-empty sourcePageUrl / creator.
      if (!existing.sourcePageUrl && entry.sourcePageUrl) {
        existing.sourcePageUrl = entry.sourcePageUrl;
      }
      if (!existing.creator && entry.creator) existing.creator = entry.creator;
    } else {
      registry[originalImageUrl] = entry;
    }
  }

  const output = {
    generatedAt: new Date().toISOString(),
    imageCount: Object.keys(registry).length,
    images: registry,
  };

  await mkdir(dirname(OUTPUT_FILE), { recursive: true });
  await writeFile(OUTPUT_FILE, JSON.stringify(output, null, 2) + '\n', 'utf8');

  console.log('\n[create-image-provenance] SUCCESS');
  console.log(`  Output:        ${OUTPUT_FILE}`);
  console.log(`  Unique images: ${output.imageCount}`);
  console.log('');
  for (const [, entry] of Object.entries(registry)) {
    console.log(
      `    - creator="${entry.creator}" license="${entry.license}" sourceOrg="${entry.sourceOrganization}"`,
    );
    console.log(`      stories: ${entry.storiesUsingImage.join(', ') || '(none)'}`);
    console.log(`      relation: ${entry.imageRelation}`);
    console.log(`      firstUsedAt: ${entry.firstUsedAt}`);
  }
  console.log('');
}

main().catch((err) => {
  console.error(`[create-image-provenance] FATAL: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
