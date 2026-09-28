/**
 * US News Engine — Phase 10A.2 General News source registry builder.
 *
 * Builds/updates data/general-news/general-news-source-registry.json — the
 * persistent tracked source-history registry for General News. Analogous to
 * the Science source registry: bootstrap safety (first run = all items
 * bootstrapSeen=true) + per-source durable identity.
 *
 * Run: node scripts/build-general-news-registry.mjs
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(__dirname, '..');
const INPUT_FILE = join(PROJECT_DIR, 'data', 'general-news', 'general-news-feed.json');
const OUTPUT_FILE = join(PROJECT_DIR, 'data', 'general-news', 'general-news-source-registry.json');

async function loadJsonOptional(path) {
  try {
    const raw = await readFile(path, 'utf8');
    return { ok: true, doc: JSON.parse(raw) };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: false, reason: 'missing' };
    return { ok: false, reason: String(err) };
  }
}

function sourceKey(record) {
  // Deterministic key: hash of sourceName + sourceUrl + title
  const keyInput = `${record.sourceName}::${record.sourceUrl}::${record.title || ''}`;
  return `gn__${createHash('sha256').update(keyInput, 'utf8').digest('hex').slice(0, 16)}`;
}

async function main() {
  console.log('[build-general-news-registry] Building General News source registry.');
  console.log(`  Input:  ${INPUT_FILE}`);
  console.log(`  Output: ${OUTPUT_FILE}`);

  const now = new Date();
  const nowIso = now.toISOString();

  const feedRes = await loadJsonOptional(INPUT_FILE);
  if (!feedRes.ok) {
    console.error(`  ERROR: feed file not found. Run fetch-general-news first.`);
    process.exit(1);
  }
  const feed = feedRes.doc;
  const allRecords = [];
  for (const src of (feed.sources || [])) {
    for (const r of (src.records || [])) {
      allRecords.push({ ...r, sourceAvailable: src.sourceAvailable });
    }
  }
  console.log(`  Total records from feed: ${allRecords.length}`);

  // Load existing registry
  const existingRes = await loadJsonOptional(OUTPUT_FILE);
  let existingSources = [];
  if (existingRes.ok && Array.isArray(existingRes.doc.sources)) {
    existingSources = existingRes.doc.sources;
    console.log(`  Existing registry: ${existingSources.length} sources`);
  } else {
    console.log('  No existing registry — first run. All items will be bootstrapSeen=true.');
  }

  const existingBy = new Map();
  for (const s of existingSources) {
    if (s && typeof s.sourceKey === 'string') existingBy.set(s.sourceKey, { ...s });
  }
  const isFirstRun = existingSources.length === 0;

  const seenThisRun = new Set();
  const newSources = [];
  const updatedSources = [];
  let newCount = 0;
  let updatedCount = 0;

  for (const r of allRecords) {
    const key = sourceKey(r);
    if (!key) continue;
    seenThisRun.add(key);
    const existing = existingBy.get(key);
    if (existing) {
      existing.lastSeenAt = nowIso;
      if (r.title && r.title !== existing.title) existing.title = r.title;
      if (r.sourceUrl && r.sourceUrl !== existing.sourceUrl) existing.sourceUrl = r.sourceUrl;
      if (r.publishedAtSource && r.publishedAtSource !== existing.publishedAtSource) {
        existing.publishedAtSource = r.publishedAtSource;
      }
      existingBy.delete(key);
      updatedSources.push(existing);
      updatedCount++;
    } else {
      newSources.push({
        sourceKey: key,
        sourceName: r.sourceName || null,
        sourceType: r.sourceType || null,
        sourceUrl: r.sourceUrl || null,
        title: r.title || null,
        category: r.category || r.sourceCategory || null,
        publishedAtSource: r.publishedAtSource || null,
        firstSeenAt: nowIso,
        lastSeenAt: nowIso,
        bootstrapSeen: isFirstRun ? true : false,
      });
      newCount++;
    }
  }

  const retainedSources = Array.from(existingBy.values());
  const finalSources = [...retainedSources, ...updatedSources, ...newSources];
  finalSources.sort((a, b) => {
    const ta = a.firstSeenAt ? new Date(a.firstSeenAt).getTime() : 0;
    const tb = b.firstSeenAt ? new Date(b.firstSeenAt).getTime() : 0;
    if (ta !== tb) return ta - tb;
    return (a.sourceKey || '').localeCompare(b.sourceKey || '');
  });

  const bootstrapCount = finalSources.filter((s) => s.bootstrapSeen === true).length;
  const nonBootstrapCount = finalSources.length - bootstrapCount;

  const output = {
    generatedAt: nowIso,
    source: 'Phase 10A.2 General News source registry',
    sourceCount: finalSources.length,
    firstRun: isFirstRun,
    bootstrapCount,
    nonBootstrapCount,
    sourcesByFeed: finalSources.reduce((acc, s) => {
      const k = s.sourceName || 'unknown';
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {}),
    sources: finalSources,
  };

  await mkdir(dirname(OUTPUT_FILE), { recursive: true });
  const tmp = `${OUTPUT_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(output, null, 2) + '\n', 'utf8');
  await rename(tmp, OUTPUT_FILE);

  console.log(`\n  Total sources:      ${finalSources.length}`);
  console.log(`  Bootstrap items:    ${bootstrapCount} (historical, not auto-publishable as new)`);
  console.log(`  Non-bootstrap:      ${nonBootstrapCount}`);
  console.log(`  Updated this run:   ${updatedCount}`);
  console.log(`  Added this run:     ${newCount}`);
  console.log(`  Output: ${OUTPUT_FILE}`);
}

main().catch((err) => {
  console.error(`[build-general-news-registry] FATAL: ${err.message}`);
  process.exit(1);
});
