/**
 * US News Engine — build published-stories registry (Phase 5B).
 *
 * Reads all published articles from src/content/articles/ and creates
 * data/published-stories.json — the persistent source of truth for
 * publication history, lifecycle status, and image provenance.
 *
 * Run manually:
 *   node scripts/build-published-registry.mjs
 */

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Simple YAML frontmatter parser for our article files.
 * Handles the flat key-value format we use (no nested structures).
 */
function parseFrontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const yaml = match[1];
  const data = {};
  for (const line of yaml.split('\n')) {
    const m = line.match(/^(\w+):\s*(.*)$/);
    if (!m) continue;
    const [, key, rawVal] = m;
    let val = rawVal.trim();
    // Remove surrounding quotes
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    // Parse booleans
    if (val === 'true') val = true;
    else if (val === 'false') val = false;
    // Parse numbers
    else if (/^\d+$/.test(val)) val = parseInt(val, 10);
    // Parse arrays: ["a", "b"]
    else if (val.startsWith('[') && val.endsWith(']')) {
      val = val.slice(1, -1).split(',').map((s) => s.trim().replace(/^"|"$/g, '')).filter(Boolean);
    }
    // Parse dates
    else if (/^\d{4}-\d{2}-\d{2}T/.test(val)) val = new Date(val);
    data[key] = val;
  }
  return data;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(__dirname, '..');
const ARTICLES_DIR = join(PROJECT_DIR, 'src', 'content', 'articles');
const DRAFTS_DIR = join(PROJECT_DIR, 'data', 'drafts');
const STORIES_FILE = join(PROJECT_DIR, 'data', 'nws-story-records.json');
const OUTPUT_FILE = join(PROJECT_DIR, 'data', 'published-stories.json');

async function main() {
  console.log('[build-published-registry] Building published-stories registry.');

  // Load NWS story records for alert IDs and weather metadata
  let nwsStories = [];
  try {
    const storiesDoc = JSON.parse(await readFile(STORIES_FILE, 'utf8'));
    nwsStories = storiesDoc.stories || [];
  } catch {
    console.log('  Warning: nws-story-records.json not found, using article frontmatter only');
  }

  // Load all drafts for image metadata
  const drafts = new Map();
  try {
    const draftFiles = await readdir(DRAFTS_DIR);
    for (const f of draftFiles) {
      if (!f.endsWith('.json')) continue;
      const d = JSON.parse(await readFile(join(DRAFTS_DIR, f), 'utf8'));
      if (d.slug) drafts.set(d.slug, d);
    }
  } catch {
    console.log('  Warning: drafts directory not found');
  }

  // Read all article files
  const articleFiles = (await readdir(ARTICLES_DIR)).filter((f) => f.endsWith('.md'));
  const stories = [];
  const now = new Date().toISOString();

  for (const file of articleFiles) {
    const raw = await readFile(join(ARTICLES_DIR, file), 'utf8');
    const fm = parseFrontmatter(raw);
    const slug = fm.slug;
    const draft = drafts.get(slug);

    // Find matching NWS story record for alert IDs
    const nwsStory = nwsStories.find(
      (s) => s.storyKey === draft?.storyKey || s.areaDesc?.includes(fm.state || ''),
    );

    const heroImage = draft?.heroImage || {};
    const weatherMeta = draft?.weatherMetadata || {};

    const expires = weatherMeta.expires || weatherMeta.ends;
    const isExpired = expires ? new Date(expires).getTime() < Date.now() : false;

    stories.push({
      storyKey: draft?.storyKey || slug,
      slug,
      articlePath: `src/content/articles/${file}`,
      publishedAt: fm.publishedAt?.toISOString() || now,
      updatedAt: fm.updatedAt ? new Date(fm.updatedAt).toISOString() : null,
      currentAlertIds: nwsStory?.alertIds || draft?.sourceAlertIds || [],
      allAlertIds: nwsStory?.alertIds || draft?.sourceAlertIds || [],
      event: weatherMeta.event || fm.tags?.[0] || 'Weather Alert',
      location: draft?.location || fm.state || 'Unknown',
      sourceOffice: fm.sourceOffice || 'National Weather Service',
      lifecycleStatus: isExpired ? 'expired' : 'active',
      lastNwsEffectiveAt: weatherMeta.effective || null,
      lastNwsExpiresAt: weatherMeta.expires || null,
      lastNwsEndsAt: weatherMeta.ends || null,
      lastCheckedAt: now,
      heroImageMode: fm.imageMode || heroImage.mode || 'fallback-graphic',
      heroImageSource: fm.image || heroImage.path || '',
      heroImageRelation: heroImage.relation || (fm.imageMode === 'licensed-photo' ? 'exact-location' : 'current-alert-data'),
      heroImageCreator: fm.imageCreator || heroImage.creator || '',
      heroImageLicense: fm.imageLicense || heroImage.license || '',
      heroImageLicenseUrl: fm.imageLicenseUrl || heroImage.licenseUrl || '',
      heroImageSourcePageUrl: heroImage.sourcePageUrl || '',
      breaking: fm.breaking || false,
    });
  }

  const registry = {
    generatedAt: now,
    storyCount: stories.length,
    stories,
  };

  await mkdir(dirname(OUTPUT_FILE), { recursive: true });
  await writeFile(OUTPUT_FILE, JSON.stringify(registry, null, 2) + '\n', 'utf8');
  console.log(`  Registry written: ${OUTPUT_FILE}`);
  console.log(`  Stories: ${stories.length}`);
  for (const s of stories) {
    console.log(`    - ${s.storyKey} [${s.lifecycleStatus}] breaking=${s.breaking} hero=${s.heroImageMode}`);
  }
}

main().catch((err) => {
  console.error(`[build-published-registry] FATAL: ${err.message}`);
  process.exit(1);
});
