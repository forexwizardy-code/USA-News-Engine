/**
 * US News Engine — Science source registry builder (Phase 9A.2 new).
 *
 * Reads all three Phase 9A fetcher outputs and builds/updates a
 * registry of every source item ever seen:
 *   data/science/science-source-registry.json
 *
 * Bootstrap safety:
 *   - On the FIRST run (when the registry file does not exist), every
 *     item from every fetcher output is marked `bootstrapSeen: true`.
 *     These items are "historical" — they existed before the registry
 *     was created and must NOT be auto-published as if they were new.
 *   - On subsequent runs, items that were not previously in the
 *     registry are added with `bootstrapSeen: false`. These are
 *     genuinely new items the pipeline has never seen before.
 *   - Items already in the registry keep their original `bootstrapSeen`
 *     flag (we never flip it back to false) and have their `lastSeenAt`
 *     updated to the current run's timestamp.
 *
 * The registry is used by `validate-science.mjs` to enforce the
 * "bootstrap historical item treated as new" check — a story that
 * appears as `storyStatus='new'` in `science-story-records.json` must
 * NOT have any source key with `bootstrapSeen=true` in the registry.
 * (build-science-stories.mjs sets `storyStatus='bootstrap'` instead
 * of `'new'` for stories whose sources are all bootstrap, so this
 * invariant holds.)
 *
 * Run manually:
 *   npm run registry:science
 *
 * No API key is required. No network access. The script only reads
 * the three local fetcher output files.
 */

import { readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(__dirname, '..');
const INPUT_FILES = [
  join(PROJECT_DIR, 'data', 'science', 'nasa-news.json'),
  join(PROJECT_DIR, 'data', 'science', 'jpl-news.json'),
  join(PROJECT_DIR, 'data', 'science', 'swpc-events.json'),
];
const OUTPUT_FILE = join(PROJECT_DIR, 'data', 'science', 'science-source-registry.json');

// --- Helpers ---------------------------------------------------------------

async function loadJsonOptional(path) {
  try {
    const raw = await readFile(path, 'utf8');
    return { ok: true, doc: JSON.parse(raw) };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: false, reason: 'missing' };
    return { ok: false, reason: String(err) };
  }
}

// --- Main ------------------------------------------------------------------

async function main() {
  console.log('[build-science-registry] Starting science source registry build.');
  console.log(`  Inputs:  ${INPUT_FILES.join(', ')}`);
  console.log(`  Output:  ${OUTPUT_FILE}`);

  const now = new Date();
  const nowIso = now.toISOString();

  // Load existing registry (if any).
  const existingRes = await loadJsonOptional(OUTPUT_FILE);
  let existingSources = [];
  if (existingRes.ok && Array.isArray(existingRes.doc.sources)) {
    existingSources = existingRes.doc.sources;
    console.log(`  Existing registry:  ${existingSources.length} sources`);
  } else if (existingRes.ok) {
    console.log('  [warn] Existing registry file is malformed; rebuilding from scratch.');
  } else {
    console.log('  No existing registry — first run. All current items will be marked bootstrapSeen=true.');
  }

  // Build a lookup map of existing sources by scienceKey.
  const existingBy = new Map();
  for (const s of existingSources) {
    if (s && typeof s.scienceKey === 'string') {
      existingBy.set(s.scienceKey, { ...s });
    }
  }

  const isFirstRun = existingSources.length === 0;

  // Load all fetcher outputs and collect records.
  const allRecords = [];
  for (const file of INPUT_FILES) {
    const res = await loadJsonOptional(file);
    if (!res.ok) {
      console.warn(`  [warn] Could not load ${file} (${res.reason}). Skipping.`);
      continue;
    }
    const records = Array.isArray(res.doc.records) ? res.doc.records : [];
    for (const r of records) {
      if (r && typeof r.scienceKey === 'string' && r.scienceKey) {
        allRecords.push(r);
      }
    }
    console.log(`  Loaded ${records.length} records from ${file}`);
  }

  console.log(`  Total records seen this run: ${allRecords.length}`);

  // Merge: update existing sources' lastSeenAt; add new sources.
  // `existingBy` is mutated to remove items that are seen this run;
  // updated sources are tracked separately in `updatedSources` so
  // they end up in the final sources list. `retainedSources` (the
  // leftovers in `existingBy` after the loop) are sources that
  // existed in the registry but were NOT seen this run — they're
  // kept as-is so the registry retains historical memory.
  const seenThisRun = new Set();
  const newSources = [];
  const updatedSources = [];
  let newCount = 0;
  let updatedCount = 0;

  for (const r of allRecords) {
    seenThisRun.add(r.scienceKey);
    const existing = existingBy.get(r.scienceKey);
    if (existing) {
      existing.lastSeenAt = nowIso;
      // Keep the original publishedAtSource from the registry (it
      // shouldn't change between runs, but if it does we update it
      // too — this catches cases where the source corrects a date).
      if (r.publishedAtSource && r.publishedAtSource !== existing.publishedAtSource) {
        existing.publishedAtSource = r.publishedAtSource;
      }
      // Update sourceUrl if it changed (rare, but possible).
      if (r.sourceUrl && r.sourceUrl !== existing.sourceUrl) {
        existing.sourceUrl = r.sourceUrl;
      }
      existingBy.delete(r.scienceKey);
      updatedSources.push(existing);
      updatedCount++;
    } else {
      newSources.push({
        scienceKey: r.scienceKey,
        source: r.source || null,
        publishedAtSource: r.publishedAtSource || null,
        firstSeenAt: nowIso,
        lastSeenAt: nowIso,
        // First run: all items are bootstrap. Subsequent runs: new
        // items are NOT bootstrap (they're genuinely new).
        bootstrapSeen: isFirstRun ? true : false,
        sourceUrl: r.sourceUrl || null,
      });
      newCount++;
    }
  }

  // Existing sources not seen this run: keep them in the registry
  // (their lastSeenAt is unchanged from the previous run).
  const retainedSources = Array.from(existingBy.values());

  const finalSources = [...retainedSources, ...updatedSources, ...newSources];

  // Sort by firstSeenAt then scienceKey for stable output ordering.
  finalSources.sort((a, b) => {
    const ta = a.firstSeenAt ? new Date(a.firstSeenAt).getTime() : 0;
    const tb = b.firstSeenAt ? new Date(b.firstSeenAt).getTime() : 0;
    if (ta !== tb) return ta - tb;
    return (a.scienceKey || '').localeCompare(b.scienceKey || '');
  });

  const bootstrapCount = finalSources.filter((s) => s.bootstrapSeen === true).length;
  const nonBootstrapCount = finalSources.length - bootstrapCount;

  const output = {
    generatedAt: nowIso,
    source: 'Phase 9A.2 science source registry',
    sourceCount: finalSources.length,
    firstRun: isFirstRun,
    bootstrapCount,
    nonBootstrapCount,
    sourcesByFeed: finalSources.reduce((acc, s) => {
      const k = s.source || 'unknown';
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {}),
    sources: finalSources,
  };

  // Atomic write.
  await mkdir(dirname(OUTPUT_FILE), { recursive: true });
  const tmp = `${OUTPUT_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(output, null, 2) + '\n', 'utf8');
  await rename(tmp, OUTPUT_FILE);

  const stats = await stat(OUTPUT_FILE);
  console.log('\n[build-science-registry] SUCCESS');
  console.log(`  Output file:        ${OUTPUT_FILE}`);
  console.log(`  File size:          ${stats.size.toLocaleString()} bytes`);
  console.log(`  Generated at (UTC): ${output.generatedAt}`);
  console.log(`  First run:          ${isFirstRun}`);
  console.log(`  Total sources:      ${finalSources.length}`);
  console.log(`  Bootstrap items:    ${bootstrapCount} (historical, not auto-publishable as new)`);
  console.log(`  Non-bootstrap:      ${nonBootstrapCount}`);
  console.log(`  Updated this run:   ${updatedCount}`);
  console.log(`  Added this run:     ${newCount}`);
  console.log(`  Sources by feed:    ${JSON.stringify(output.sourcesByFeed)}`);

  // Top 10 newest non-bootstrap sources (for eyeball verification).
  const newOnes = finalSources
    .filter((s) => s.bootstrapSeen === false)
    .sort((a, b) => new Date(b.firstSeenAt).getTime() - new Date(a.firstSeenAt).getTime())
    .slice(0, 10);
  if (newOnes.length > 0) {
    console.log('\n  Top 10 newest non-bootstrap sources:');
    newOnes.forEach((s, i) => {
      console.log(
        `    ${String(i + 1).padStart(2)}. [${s.source}] ${s.scienceKey}  firstSeen=${s.firstSeenAt}  pub=${s.publishedAtSource || '?'}`,
      );
    });
  } else if (isFirstRun) {
    console.log('\n  First run — all sources marked as bootstrap. Subsequent runs will surface new items here.');
  }
  console.log('');
}

main().catch((err) => {
  console.error(`[build-science-registry] FATAL: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
