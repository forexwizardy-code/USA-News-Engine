/**
 * US News Engine — build published-recalls registry (Phase 7D).
 *
 * Reads the published recall articles from src/content/articles/ and pairs each
 * one with its clustered-story record from
 * data/recalls/recall-story-clusters.json so the master automation script can
 * reconcile the live cluster feed against what's already public.
 *
 * Output: data/published-recalls.json — the persistent source of truth for
 * recall article publication history. Mirrors the shape of the NWS
 * published-stories.json registry but is keyed on `recallStoryKey` and adds
 * recall-specific fields (sourceType, sourceRecallIds, classification,
 * hazardNormalized, lastSeenAt).
 *
 * Run manually:
 *   node scripts/build-published-recalls-registry.mjs
 *   (or) npm run registry:recalls
 */

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(__dirname, '..');
const ARTICLES_DIR = join(PROJECT_DIR, 'src', 'content', 'articles');
const CLUSTERS_FILE = join(
  PROJECT_DIR,
  'data',
  'recalls',
  'recall-story-clusters.json',
);
const RECALL_DRAFTS_DIR = join(PROJECT_DIR, 'data', 'recalls', 'drafts');
const IMAGE_SIDECARS_DIR = join(PROJECT_DIR, 'data', 'draft-images');
const OUTPUT_FILE = join(PROJECT_DIR, 'data', 'published-recalls.json');

// ===========================================================================
// Frontmatter parser (flat key:value, mirrors build-published-registry.mjs)
// ===========================================================================

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
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    if (val === 'true') val = true;
    else if (val === 'false') val = false;
    else if (/^\d+$/.test(val)) val = parseInt(val, 10);
    else if (val.startsWith('[') && val.endsWith(']')) {
      val = val
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^"|"$/g, ''))
        .filter(Boolean);
    } else if (/^\d{4}-\d{2}-\d{2}T/.test(val)) {
      const d = new Date(val);
      val = Number.isNaN(d.getTime()) ? val : d;
    }
    data[key] = val;
  }
  return data;
}

// ===========================================================================
// Main
// ===========================================================================

async function main() {
  console.log('[build-published-recalls-registry] Building published-recalls registry.');

  // --- Load cluster stories (keyed by recallStoryKey) ---
  let clusterStories = [];
  let clusterDoc = null;
  try {
    clusterDoc = JSON.parse(await readFile(CLUSTERS_FILE, 'utf8'));
    clusterStories = Array.isArray(clusterDoc.stories) ? clusterDoc.stories : [];
    console.log(`  Loaded ${clusterStories.length} cluster stories.`);
  } catch {
    console.log('  Warning: recall-story-clusters.json not found.');
  }

  // --- Load recall drafts (slug → draft, gives storyKey per slug) ---
  const draftsBySlug = new Map();
  try {
    const files = await readdir(RECALL_DRAFTS_DIR);
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const d = JSON.parse(await readFile(join(RECALL_DRAFTS_DIR, f), 'utf8'));
        if (d.slug && d.storyKey) draftsBySlug.set(d.slug, d);
      } catch {
        // skip unreadable
      }
    }
    console.log(`  Loaded ${draftsBySlug.size} recall drafts.`);
  } catch {
    console.log('  Warning: recalls/drafts directory not found.');
  }

  // --- Load image sidecars (slug → metadata) ---
  const sidecarsBySlug = new Map();
  try {
    const files = await readdir(IMAGE_SIDECARS_DIR);
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const m = JSON.parse(await readFile(join(IMAGE_SIDECARS_DIR, f), 'utf8'));
        if (m.slug) {
          // Prefer the sidecar that has a storyKey matching a known cluster
          // story (so a renamed sidecar file still pairs correctly).
          if (!sidecarsBySlug.has(m.slug)) {
            sidecarsBySlug.set(m.slug, m);
          } else {
            // If the existing entry has no storyKey match but this one does, replace.
            const existing = sidecarsBySlug.get(m.slug);
            const existingHasMatch = existing.storyKey &&
              clusterStories.some((c) => c.recallStoryKey === existing.storyKey);
            const thisHasMatch = m.storyKey &&
              clusterStories.some((c) => c.recallStoryKey === m.storyKey);
            if (thisHasMatch && !existingHasMatch) sidecarsBySlug.set(m.slug, m);
          }
        }
      } catch {
        // skip unreadable
      }
    }
    console.log(`  Loaded ${sidecarsBySlug.size} recall image sidecars.`);
  } catch {
    console.log('  Warning: draft-images directory not found.');
  }

  // --- Read all article files, keep only category: recalls ---
  const articleFiles = (await readdir(ARTICLES_DIR)).filter((f) =>
    f.endsWith('.md'),
  );
  const stories = [];
  const now = new Date().toISOString();

  for (const file of articleFiles) {
    const raw = await readFile(join(ARTICLES_DIR, file), 'utf8');
    const fm = parseFrontmatter(raw);
    if (fm.category !== 'recalls') continue;

    const slug = fm.slug;
    if (!slug) {
      console.log(`  Skipping ${file} — no slug in frontmatter.`);
      continue;
    }

    // Resolve the recallStoryKey from the draft JSON (preferred), then verify
    // against the cluster feed. Fall back to a direct slug match against the
    // image sidecar.
    const draft = draftsBySlug.get(slug);
    let recallStoryKey = draft?.storyKey || null;
    let clusterStory = recallStoryKey
      ? clusterStories.find((s) => s.recallStoryKey === recallStoryKey)
      : null;

    if (!clusterStory) {
      // Try the sidecar storyKey.
      const sidecar = sidecarsBySlug.get(slug);
      if (sidecar?.storyKey) {
        const alt = clusterStories.find(
          (s) => s.recallStoryKey === sidecar.storyKey,
        );
        if (alt) {
          recallStoryKey = sidecar.storyKey;
          clusterStory = alt;
        }
      }
    }

    if (!clusterStory) {
      console.log(
        `  Warning: no cluster match for slug "${slug}" — recording with null cluster fields.`,
      );
    } else {
      recallStoryKey = clusterStory.recallStoryKey;
    }

    // Build the registry entry. When the cluster story is missing, fall back
    // to the draft / sidecar / frontmatter fields.
    const sourceType =
      clusterStory?.sourceType ||
      draft?.recallMetadata?.sourceType ||
      null;
    const sourceRecallIds =
      clusterStory?.sourceRecallIds ||
      draft?.sourceRecallIds ||
      [];
    const sourceUrls =
      clusterStory?.sourceUrls ||
      (fm.sourceUrl ? [fm.sourceUrl] : []);
    const classification =
      clusterStory?.classification ||
      draft?.recallMetadata?.classification ||
      null;
    const hazardNormalized = clusterStory?.hazardNormalized || null;
    const lastSeenAt =
      clusterStory?.latestSeenAt ||
      draft?.recallMetadata?.latestSeenAt ||
      draft?.recallMetadata?.firstSeenAt ||
      fm.publishedAt?.toISOString?.() ||
      fm.publishedAt ||
      now;

    // Image metadata — prefer the sidecar, then fall back to frontmatter.
    const sidecar = sidecarsBySlug.get(slug);
    const imageMode =
      fm.imageMode || sidecar?.imageMode || 'fallback-graphic';
    const imageSource = fm.image || '';
    const imageCreator =
      fm.imageCreator ||
      sidecar?.source ||
      '';
    const imageLicense =
      fm.imageLicense || sidecar?.licenseNotes || '';
    // No license URL on file for the existing recall photos / graphics.
    const imageLicenseUrl = fm.imageLicenseUrl || '';
    // The source URL of the image (recall page or FDA data page).
    const imageSourceUrl =
      sidecar?.sourceUrl || fm.sourceUrl || '';

    const publishedAt = fm.publishedAt?.toISOString?.() || fm.publishedAt || now;
    const updatedAt = fm.updatedAt
      ? fm.updatedAt instanceof Date
        ? fm.updatedAt.toISOString()
        : new Date(fm.updatedAt).toISOString()
      : null;

    stories.push({
      recallStoryKey,
      slug,
      articlePath: `src/content/articles/${file}`,
      publishedAt,
      updatedAt,
      sourceType,
      sourceRecallIds,
      allSourceRecallIds: sourceRecallIds,
      sourceUrls,
      storyStatus: 'active',
      classification,
      hazardNormalized,
      lastSeenAt,
      lastCheckedAt: now,
      imageMode,
      imageSource,
      imageCreator,
      imageLicense,
      imageLicenseUrl,
      imageSourceUrl,
    });
  }

  // Sort by publishedAt descending (newest first) for stable output.
  stories.sort((a, b) => {
    const ta = new Date(a.publishedAt).getTime();
    const tb = new Date(b.publishedAt).getTime();
    return tb - ta;
  });

  const registry = {
    generatedAt: now,
    storyCount: stories.length,
    stories,
  };

  await mkdir(dirname(OUTPUT_FILE), { recursive: true });
  await writeFile(OUTPUT_FILE, JSON.stringify(registry, null, 2) + '\n', 'utf8');
  console.log(`\n  Registry written: ${OUTPUT_FILE}`);
  console.log(`  Recall stories: ${stories.length}`);
  for (const s of stories) {
    console.log(
      `    - ${s.slug} [${s.sourceType || 'unknown'}] hazard=${s.hazardNormalized || 'n/a'} image=${s.imageMode}`,
    );
  }
  console.log('');
}

main().catch((err) => {
  console.error(`[build-published-recalls-registry] FATAL: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
