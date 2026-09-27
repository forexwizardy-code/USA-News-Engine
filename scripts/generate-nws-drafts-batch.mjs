/**
 * US News Engine — batch article draft generator for Phase 5A.
 *
 * Generates article drafts for multiple NWS stories in one run.
 * Reads data/nws-story-records.json, generates a draft for each specified
 * storyKey, and writes them to data/drafts/.
 *
 * Usage:
 *   node scripts/generate-nws-drafts-batch.mjs <storyKey1> <storyKey2> ...
 *   (or) bun run scripts/generate-nws-drafts-batch.mjs <storyKey1> ...
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(__dirname, '..');
const STORIES_FILE = join(PROJECT_DIR, 'data', 'nws-story-records.json');
const DRAFTS_DIR = join(PROJECT_DIR, 'data', 'drafts');

async function main() {
  const storyKeys = process.argv.slice(2);
  if (storyKeys.length === 0) {
    console.error('Usage: node scripts/generate-nws-drafts-batch.mjs <storyKey1> <storyKey2> ...');
    process.exit(1);
  }

  console.log(`[batch-drafts] Generating ${storyKeys.length} article drafts`);

  // Load stories
  const storiesDoc = JSON.parse(await readFile(STORIES_FILE, 'utf8'));
  const stories = storiesDoc.stories;

  for (const storyKey of storyKeys) {
    console.log(`\n--- Generating draft for ${storyKey} ---`);
    const story = stories.find((s) => s.storyKey === storyKey);
    if (!story) {
      console.error(`  ERROR: story not found: ${storyKey}`);
      continue;
    }

    // Run the existing single-draft generator with this storyKey.
    // The generator script accepts a storyKey as argv[2].
    try {
      execSync(`node scripts/generate-nws-draft.mjs "${storyKey}"`, {
        cwd: PROJECT_DIR,
        stdio: 'inherit',
      });
      console.log(`  SUCCESS: draft generated for ${storyKey}`);
    } catch (err) {
      console.error(`  ERROR: failed to generate draft for ${storyKey}: ${err.message}`);
    }
  }

  console.log('\n[batch-drafts] Done.');
}

main().catch((err) => {
  console.error(`[batch-drafts] FATAL: ${err.message}`);
  process.exit(1);
});
