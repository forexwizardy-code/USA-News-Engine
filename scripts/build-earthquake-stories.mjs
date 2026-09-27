/**
 * US News Engine — Earthquake story deduplication & scoring (Phase 8A).
 *
 * Reads the Phase 8A candidate list (data/earthquakes/earthquake-news-candidates.json)
 * and merges candidates that describe the SAME earthquake (by earthquakeKey)
 * into a single story record. Each unique earthquakeKey becomes one story,
 * with a deterministic story score (0-100) for internal ranking only.
 *
 * Story score (0-100):
 *   Base: 20
 *   Magnitude >= 7.0: +30 (tiered — highest applicable only)
 *   Magnitude >= 6.0: +20
 *   Magnitude >= 5.0: +12
 *   Magnitude >= 4.0: +6
 *   USGS alert "red":    +20
 *   USGS alert "orange": +15
 *   USGS alert "yellow": +8
 *   tsunami === true:    +15
 *   felt >= 1000: +10 (stacks with felt >= 100)
 *   felt >= 100:  +5
 *   isUS: +8
 *   depth < 10 km (shallow): +5
 *   USGS significance >= 1000: +5
 *   Cap at 100
 *
 * Cross-snapshot tracking:
 *   - firstSeenAt, latestSeenAt, updateCount persisted across runs
 *   - previousMagnitude is set to the prior run's magnitude when it
 *     differs from the current run; null otherwise (and null on first run)
 *   - storyStatus is "new" on first run, "updated"/"unchanged" on later runs
 *
 * Output: data/earthquakes/earthquake-story-records.json
 *
 * Run manually:
 *   npm run stories:earthquakes
 */

import { readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(__dirname, '..');
const INPUT_FILE = join(PROJECT_DIR, 'data', 'earthquakes', 'earthquake-news-candidates.json');
const OUTPUT_FILE = join(PROJECT_DIR, 'data', 'earthquakes', 'earthquake-story-records.json');

// ===========================================================================
// CONFIGURATION — scoring weights (internal ranking only, never public/SEO)
// ===========================================================================
const BASE_SCORE = 20;
const BONUS_MAG_7 = 30;
const BONUS_MAG_6 = 20;
const BONUS_MAG_5 = 12;
const BONUS_MAG_4 = 6;
const BONUS_ALERT_RED = 20;
const BONUS_ALERT_ORANGE = 15;
const BONUS_ALERT_YELLOW = 8;
const BONUS_TSUNAMI = 15;
const BONUS_FELT_1000 = 10;
const BONUS_FELT_100 = 5;
const BONUS_IS_US = 8;
const BONUS_SHALLOW = 5; // depth < 10 km
const BONUS_SIG_1000 = 5;
const SCORE_CAP = 100;

// ===========================================================================
// Helpers
// ===========================================================================

function fail(message, detail) {
  console.error(`\n[build-earthquake-stories] ERROR: ${message}`);
  if (detail) console.error(`  Detail: ${detail}`);
  process.exit(1);
}

function lower(s) {
  return (s == null ? '' : String(s)).toLowerCase();
}

function num(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const m = value.replace(/,/g, '').match(/-?\d+(\.\d+)?/);
    return m ? Number(m[0]) : null;
  }
  return null;
}

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Compute the deterministic internal story score (0-100).
 *
 * Magnitude bonuses are tiered: only the largest applicable tier applies.
 * Felt bonuses stack (felt >= 1000 implies felt >= 100).
 */
function computeStoryScore(canonical) {
  let score = BASE_SCORE;

  // Magnitude (tiered — pick the highest applicable tier).
  const mag = num(canonical.magnitude);
  if (mag != null) {
    if (mag >= 7.0) score += BONUS_MAG_7;
    else if (mag >= 6.0) score += BONUS_MAG_6;
    else if (mag >= 5.0) score += BONUS_MAG_5;
    else if (mag >= 4.0) score += BONUS_MAG_4;
  }

  // USGS PAGER alert (single value per event).
  const alert = lower(canonical.alert);
  if (alert === 'red') score += BONUS_ALERT_RED;
  else if (alert === 'orange') score += BONUS_ALERT_ORANGE;
  else if (alert === 'yellow') score += BONUS_ALERT_YELLOW;

  // Tsunami flag.
  if (canonical.tsunami === true) score += BONUS_TSUNAMI;

  // Felt reports (stack: >= 1000 implies >= 100).
  const felt = num(canonical.felt);
  if (felt != null) {
    if (felt >= 1000) score += BONUS_FELT_1000;
    if (felt >= 100) score += BONUS_FELT_100;
  }

  // U.S. relevance.
  if (canonical.isUS === true) score += BONUS_IS_US;

  // Shallow depth (< 10 km).
  const depth = num(canonical.depthKm);
  if (depth != null && depth < 10) score += BONUS_SHALLOW;

  // USGS significance.
  const sig = num(canonical.significance);
  if (sig != null && sig >= 1000) score += BONUS_SIG_1000;

  return Math.min(SCORE_CAP, score);
}

/**
 * Compute a content signature for change detection. Excludes volatile
 * fields like time/updated (USGS may revise these without changing the
 * physical event). Focuses on what would change if the story meaningfully
 * evolved (magnitude, alert, tsunami, status, felt).
 */
function computeSignature(record) {
  const relevant = {
    earthquakeKey: record.earthquakeKey,
    sourceId: record.sourceId,
    magnitude: record.magnitude,
    alert: record.alert,
    tsunami: record.tsunami,
    status: record.status,
    significance: record.significance,
    felt: record.felt,
    cdi: record.cdi,
    mmi: record.mmi,
    place: record.place,
    depthKm: record.depthKm,
    latitude: record.latitude,
    longitude: record.longitude,
  };
  const json = JSON.stringify(relevant, Object.keys(relevant).sort());
  return createHash('sha256').update(json, 'utf8').digest('hex');
}

// ===========================================================================
// Main
// ===========================================================================

async function main() {
  console.log('[build-earthquake-stories] Starting story deduplication.');
  console.log(`  Input:  ${INPUT_FILE}`);
  console.log(`  Output: ${OUTPUT_FILE}`);

  // --- Load Phase 8A candidates --------------------------------------------
  let raw;
  try {
    raw = await readFile(INPUT_FILE, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return fail(
        'Could not read input file. Run `npm run filter:earthquakes` first.',
        String(err),
      );
    }
    return fail('Could not read input file.', String(err));
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    return fail('Input file is not valid JSON.', String(err));
  }
  const candidates = Array.isArray(doc.candidates) ? doc.candidates : [];
  const now = new Date();
  console.log(`  Input candidates: ${candidates.length}`);
  console.log(`  Build time (UTC): ${now.toISOString()}`);

  // --- Load previous story snapshot (for new/updated/unchanged) -----------
  let previousStories = [];
  const previousBy = new Map();
  try {
    const prevRaw = await readFile(OUTPUT_FILE, 'utf8');
    const prevDoc = JSON.parse(prevRaw);
    if (Array.isArray(prevDoc.stories)) {
      previousStories = prevDoc.stories;
      for (const s of previousStories) {
        if (s && s.earthquakeKey) previousBy.set(s.earthquakeKey, s);
      }
      console.log(`  Previous snapshot loaded: ${previousStories.length} stories`);
    }
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      console.log('  No previous snapshot found — all stories will be "new".');
    } else {
      console.log(`  [warn] Could not parse previous snapshot: ${String(err)}`);
    }
  }

  // --- Group candidates by earthquakeKey (preserve first-seen order) ------
  const groupsMap = new Map();
  candidates.forEach((c, idx) => {
    const key = c.earthquakeKey || `no-key__${idx}`;
    if (!groupsMap.has(key)) groupsMap.set(key, { firstIndex: idx, items: [] });
    groupsMap.get(key).items.push(c);
  });

  // --- Build one story record per group -----------------------------------
  const stories = [];
  let newCount = 0;
  let updatedCount = 0;
  let unchangedCount = 0;
  const previousKeysStillSeen = new Set();

  for (const [earthquakeKey, group] of groupsMap) {
    // Canonical = highest-priority, highest-magnitude, newest-time item.
    const ordered = [...group.items].sort((a, b) => {
      if (a.priority !== b.priority) return a.priority === 'high' ? -1 : 1;
      const ma = num(a.magnitude) ?? -Infinity;
      const mb = num(b.magnitude) ?? -Infinity;
      if (mb !== ma) return mb - ma;
      const ta = parseDate(a.time)?.getTime() ?? 0;
      const tb = parseDate(b.time)?.getTime() ?? 0;
      return tb - ta;
    });
    const canonical = ordered[0];

    // Content signature for change detection.
    const currentSig = computeSignature(canonical);

    // Cross-snapshot tracking.
    let firstSeenAt = now.toISOString();
    let latestSeenAt = now.toISOString();
    let updateCount = 1;
    let previousMagnitude = null;
    let storyStatus = 'new';
    const prev = previousBy.get(earthquakeKey);
    if (prev) {
      previousKeysStillSeen.add(earthquakeKey);
      firstSeenAt = prev.firstSeenAt || firstSeenAt;
      updateCount = (prev.updateCount || 0) + 1;

      // previousMagnitude: the prior run's magnitude if it differs from the
      // current magnitude; otherwise null. (On first run, null.)
      const prevMag = num(prev.currentMagnitude ?? prev.magnitude);
      const curMag = num(canonical.magnitude);
      if (prevMag != null && curMag != null && prevMag !== curMag) {
        previousMagnitude = prevMag;
      } else if (prevMag != null && curMag == null) {
        // Magnitude went from a known value to unknown — flag it.
        previousMagnitude = prevMag;
      }

      if (prev.contentSignature && prev.contentSignature === currentSig) {
        storyStatus = 'unchanged';
        unchangedCount++;
      } else {
        storyStatus = 'updated';
        updatedCount++;
      }
    } else {
      newCount++;
    }

    const storyScore = computeStoryScore(canonical);

    stories.push({
      earthquakeKey,
      eventId: canonical.sourceId ?? null,
      storyStatus,
      storyScore,
      updateCount,
      firstSeenAt,
      latestSeenAt,
      previousMagnitude,
      currentMagnitude: canonical.magnitude ?? null,
      contentSignature: currentSig,
      // Canonical fields (denormalized for downstream consumption).
      source: canonical.source ?? null,
      sourceId: canonical.sourceId ?? null,
      magnitude: canonical.magnitude ?? null,
      magnitudeType: canonical.magnitudeType ?? null,
      place: canonical.place ?? null,
      title: canonical.title ?? null,
      time: canonical.time ?? null,
      updated: canonical.updated ?? null,
      timezone: canonical.timezone ?? null,
      url: canonical.url ?? null,
      detailUrl: canonical.detailUrl ?? null,
      felt: canonical.felt ?? null,
      cdi: canonical.cdi ?? null,
      mmi: canonical.mmi ?? null,
      alert: canonical.alert ?? null,
      status: canonical.status ?? null,
      tsunami: canonical.tsunami === true,
      significance: canonical.significance ?? null,
      network: canonical.network ?? null,
      code: canonical.code ?? null,
      ids: canonical.ids ?? null,
      sources: canonical.sources ?? null,
      types: canonical.types ?? null,
      nst: canonical.nst ?? null,
      dmin: canonical.dmin ?? null,
      rms: canonical.rms ?? null,
      gap: canonical.gap ?? null,
      depthKm: canonical.depthKm ?? null,
      latitude: canonical.latitude ?? null,
      longitude: canonical.longitude ?? null,
      country: canonical.country ?? null,
      state: canonical.state ?? null,
      nearestPlace: canonical.nearestPlace ?? null,
      isUS: canonical.isUS === true,
      isUSRelevant: canonical.isUSRelevant === true,
      impactRelevant: canonical.impactRelevant === true,
      remoteRegion: canonical.remoteRegion === true,
      remoteReason: canonical.remoteReason ?? null,
      impactReasons: canonical.impactReasons ?? [],
      scope: canonical.scope ?? null,
      publishEligible: canonical.publishEligible === true,
      eligibilityReasons: canonical.eligibilityReasons ?? [],
      exclusionReasons: canonical.exclusionReasons ?? [],
      priority: canonical.priority ?? null,
      selectedReason: canonical.selectedReason ?? null,
      // USGS detail product metadata
      hasShakeMap: canonical.hasShakeMap === true,
      shakeMapProductUrl: canonical.shakeMapProductUrl ?? null,
      shakeMapImageUrl: canonical.shakeMapImageUrl ?? null,
      hasDyfi: canonical.hasDyfi === true,
      hasMomentTensor: canonical.hasMomentTensor === true,
      hasTsunamiProduct: canonical.hasTsunamiProduct === true,
    });
  }

  // --- Sort: storyScore desc, then latestSeenAt newest first --------------
  stories.sort((a, b) => {
    if (b.storyScore !== a.storyScore) return b.storyScore - a.storyScore;
    const la = parseDate(a.latestSeenAt)?.getTime() ?? 0;
    const lb = parseDate(b.latestSeenAt)?.getTime() ?? 0;
    return lb - la;
  });

  // --- Duplicate-protection assertion --------------------------------------
  const seenKeys = new Set();
  for (const s of stories) {
    if (seenKeys.has(s.earthquakeKey)) {
      return fail('Duplicate earthquakeKey detected after grouping.', s.earthquakeKey);
    }
    seenKeys.add(s.earthquakeKey);
  }

  // --- Output metadata -----------------------------------------------------
  const previousMissingCount = previousStories.length - previousKeysStillSeen.size;

  const output = {
    generatedAt: now.toISOString(),
    source: 'U.S. Geological Survey',
    inputCandidateCount: candidates.length,
    uniqueStoryCount: stories.length,
    publishEligibleCount: stories.filter(s => s.publishEligible).length,
    usRelevantCount: stories.filter(s => s.isUSRelevant).length,
    internationalNotableCount: stories.filter(s => s.scope === 'international').length,
    newCount,
    updatedCount,
    unchangedCount,
    previousSnapshotCount: previousStories.length,
    previousMissingCount,
    stories,
  };

  // --- Atomic write --------------------------------------------------------
  await mkdir(dirname(OUTPUT_FILE), { recursive: true });
  const tmp = `${OUTPUT_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(output, null, 2) + '\n', 'utf8');
  await rename(tmp, OUTPUT_FILE);

  const stats = await stat(OUTPUT_FILE);
  console.log('\n[build-earthquake-stories] SUCCESS');
  console.log(`  Output file:          ${OUTPUT_FILE}`);
  console.log(`  File size:            ${stats.size.toLocaleString()} bytes`);
  console.log(`  Generated at (UTC):   ${output.generatedAt}`);
  console.log(`  Input candidates:     ${output.inputCandidateCount}`);
  console.log(`  Unique stories:       ${output.uniqueStoryCount}`);
  console.log(`  New:                  ${newCount}`);
  console.log(`  Updated:              ${updatedCount}`);
  console.log(`  Unchanged:            ${unchangedCount}`);
  if (previousStories.length > 0) {
    console.log(`  Previously seen, missing this run: ${previousMissingCount}`);
  }

  // --- Score distribution --------------------------------------------------
  const scoreBuckets = { '90-100': 0, '70-89': 0, '50-69': 0, '30-49': 0, '0-29': 0 };
  for (const s of stories) {
    const sc = s.storyScore;
    if (sc >= 90) scoreBuckets['90-100']++;
    else if (sc >= 70) scoreBuckets['70-89']++;
    else if (sc >= 50) scoreBuckets['50-69']++;
    else if (sc >= 30) scoreBuckets['30-49']++;
    else scoreBuckets['0-29']++;
  }
  console.log('\n  Story score distribution:');
  for (const [bucket, count] of Object.entries(scoreBuckets)) {
    console.log(`    ${bucket.padStart(6)}  ${count}`);
  }

  // --- Top 10 stories ------------------------------------------------------
  console.log('\n  Top 10 stories (by score):');
  if (stories.length === 0) {
    console.log('    (no stories)');
  } else {
    stories.slice(0, 10).forEach((s, i) => {
      const placePreview = (s.place || s.title || '(no place)').slice(0, 60);
      console.log(
        `    ${String(i + 1).padStart(2)}. [score=${s.storyScore}] M${s.magnitude ?? '?'} | ${placePreview} | ${s.isUS ? 'US' : 'non-US'}`,
      );
      console.log(
        `        key=${s.earthquakeKey} status=${s.storyStatus} updates=${s.updateCount} priority=${s.priority || '?'}`,
      );
    });
  }
  console.log('');
}

main().catch((err) => fail('Unexpected failure.', String(err && err.stack ? err.stack : err)));
