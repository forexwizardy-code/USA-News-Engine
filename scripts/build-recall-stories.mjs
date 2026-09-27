/**
 * US News Engine — Recall story deduplication & scoring (Phase 7A).
 *
 * Reads the Phase 7A candidate list (data/recalls/recall-news-candidates.json)
 * and merges multiple candidates that describe the SAME recall story (by
 * recallKey) into a single story record. Each unique recallKey becomes one
 * story, with a deterministic story score (0-100) for internal ranking only.
 *
 * Status detection compares against the previous
 * data/recalls/recall-story-records.json snapshot (if present):
 *   - "new"       — recallKey not previously seen
 *   - "updated"   — recallKey seen before but content signature changed
 *   - "unchanged" — recallKey seen before with identical signature
 *
 * Output: data/recalls/recall-story-records.json
 *
 * Run manually:
 *   npm run stories:recalls
 */

import { readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(__dirname, '..');
const INPUT_FILE = join(PROJECT_DIR, 'data', 'recalls', 'recall-news-candidates.json');
const OUTPUT_FILE = join(PROJECT_DIR, 'data', 'recalls', 'recall-story-records.json');

// ===========================================================================
// CONFIGURATION — scoring weights (internal ranking only, never public/SEO)
// ===========================================================================
const BASE_SCORE = 30;
const BONUS_DEATHS = 30;
const BONUS_INJURIES = 15;
const BONUS_CLASS_I = 20;
const BONUS_CLASS_II = 10;
const BONUS_HAZARD_FIRE_BURN_EXPLOSION = 15;
const BONUS_HAZARD_CHOKE_STRANGLE_SUFFOCATE = 12;
const BONUS_HAZARD_POISON_CONTAM_LEAD = 12;
const BONUS_UNDECLARED_ALLERGEN = 10;
const BONUS_NATIONWIDE = 8;
const BONUS_10PLUS_STATES = 5;
const BONUS_UNITS_GT_10K = 5;
const BONUS_UNITS_GT_100K = 5; // stacks on top of the 10K bonus
const BONUS_RECENT_7D = 5;
const BONUS_PER_ADDITIONAL_SOURCE_ID = 3;
const BONUS_ADDITIONAL_SOURCE_ID_CAP = 9;
const SCORE_CAP = 100;

const RECENT_WINDOW_DAYS = 7;

const HAZARD_KEYWORDS = {
  fireBurnExplosion: ['fire', 'burn', 'explosion', 'combust'],
  chokeStrangleSuffocate: ['choking', 'choke', 'strangulation', 'strangulate', 'suffocation', 'suffocate'],
  poisonContamLead: ['poison', 'contamination', 'contaminat', 'lead', 'toxic', 'pathogen'],
  undeclaredAllergen: ['undeclared allergen', 'undeclared milk', 'undeclared egg', 'undeclared soy', 'undeclared wheat', 'undeclared peanut', 'undeclared tree nut', 'undeclared sulfite', 'undeclared fish', 'undeclared shellfish'],
};

const NATIONWIDE_PHRASES = ['nationwide', 'all 50 states', 'all fifty states', 'all us states'];

// ===========================================================================
// Helpers
// ===========================================================================

function fail(message, detail) {
  console.error(`\n[build-recall-stories] ERROR: ${message}`);
  if (detail) console.error(`  Detail: ${detail}`);
  process.exit(1);
}

function lower(s) {
  return (s == null ? '' : String(s)).toLowerCase();
}

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function numericImpact(value) {
  if (value == null) return 0;
  if (typeof value === 'number') return value > 0 ? value : 0;
  if (typeof value === 'string') {
    const m = value.replace(/,/g, '').match(/\d+/);
    return m ? parseInt(m[0], 10) : 0;
  }
  return 0;
}

function parseUnitCount(units) {
  if (units == null) return null;
  if (typeof units === 'number') return Number.isFinite(units) ? units : null;
  if (typeof units !== 'string') return null;
  const m = units.replace(/,/g, '').match(/\d+/);
  return m ? parseInt(m[0], 10) : null;
}

/**
 * Count comma/semicolon-separated US state-like tokens in a distribution
 * string. Treats "nationwide" as 50.
 */
function countStatesInDistribution(dist) {
  if (!dist || typeof dist !== 'string') return 0;
  const lowerDist = lower(dist);
  for (const phrase of NATIONWIDE_PHRASES) {
    if (lowerDist.includes(phrase)) return 50;
  }
  const tokens = dist
    .split(/[,;|()]/)
    .map((t) => t.trim())
    .filter(Boolean);

  const STATE_NAMES = new Set([
    'alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado',
    'connecticut', 'delaware', 'florida', 'georgia', 'hawaii', 'idaho',
    'illinois', 'indiana', 'iowa', 'kansas', 'kentucky', 'louisiana',
    'maine', 'maryland', 'massachusetts', 'michigan', 'minnesota',
    'mississippi', 'missouri', 'montana', 'nebraska', 'nevada',
    'new hampshire', 'new jersey', 'new mexico', 'new york',
    'north carolina', 'north dakota', 'ohio', 'oklahoma', 'oregon',
    'pennsylvania', 'rhode island', 'south carolina', 'south dakota',
    'tennessee', 'texas', 'utah', 'vermont', 'virginia', 'washington',
    'west virginia', 'wisconsin', 'wyoming', 'district of columbia',
    'puerto rico',
  ]);

  let count = 0;
  for (const tok of tokens) {
    const cleaned = tok.replace(/\.$/, '').trim();
    if (!cleaned) continue;
    if (/^[A-Za-z]{2}$/.test(cleaned) && cleaned === cleaned.toUpperCase()) {
      count++;
      continue;
    }
    if (STATE_NAMES.has(lower(cleaned))) count++;
  }
  return count;
}

function hasHazardIn(text, keywords) {
  const t = lower(text);
  return keywords.some((k) => t.includes(k));
}

/**
 * Compute a content signature for change detection. Excludes fields that
 * legitimately change every run (lastUpdatedAt, fetchedAt, generatedAt).
 */
function computeSignature(record) {
  const relevant = {
    source: record.source,
    sourceType: record.sourceType,
    sourceId: record.sourceId,
    recallKey: record.recallKey,
    title: record.title,
    productName: record.productName,
    recallingFirm: record.recallingFirm,
    description: record.description,
    hazard: record.hazard,
    reason: record.reason,
    classification: record.classification,
    recallDate: record.recallDate,
    reportDate: record.reportDate,
    distribution: record.distribution,
    units: record.units,
    injuries: record.injuries,
    deaths: record.deaths,
    sourceUrl: record.sourceUrl,
  };
  const json = JSON.stringify(relevant, Object.keys(relevant).sort());
  return createHash('sha256').update(json, 'utf8').digest('hex');
}

/**
 * Compute the deterministic internal story score (0-100).
 */
function computeStoryScore(canonical, group, now) {
  let score = BASE_SCORE;

  // Deaths.
  if (numericImpact(canonical.deaths) > 0) score += BONUS_DEATHS;

  // Injuries.
  if (numericImpact(canonical.injuries) > 0) score += BONUS_INJURIES;

  // FDA classification.
  const cls = lower(canonical.classification);
  if (cls === 'class i') score += BONUS_CLASS_I;
  else if (cls === 'class ii') score += BONUS_CLASS_II;

  // Hazard keywords (may stack).
  const hazardText = `${lower(canonical.hazard)} ${lower(canonical.reason)} ${lower(canonical.description)}`;
  if (hasHazardIn(hazardText, HAZARD_KEYWORDS.fireBurnExplosion)) score += BONUS_HAZARD_FIRE_BURN_EXPLOSION;
  if (hasHazardIn(hazardText, HAZARD_KEYWORDS.chokeStrangleSuffocate)) score += BONUS_HAZARD_CHOKE_STRANGLE_SUFFOCATE;
  if (hasHazardIn(hazardText, HAZARD_KEYWORDS.poisonContamLead)) score += BONUS_HAZARD_POISON_CONTAM_LEAD;
  if (hasHazardIn(hazardText, HAZARD_KEYWORDS.undeclaredAllergen)) score += BONUS_UNDECLARED_ALLERGEN;

  // Distribution.
  const stateCount = countStatesInDistribution(canonical.distribution);
  const isNationwide = stateCount >= 50 ||
    NATIONWIDE_PHRASES.some((p) => lower(canonical.distribution).includes(p));
  if (isNationwide) score += BONUS_NATIONWIDE;
  if (!isNationwide && stateCount >= 10) score += BONUS_10PLUS_STATES;

  // Units.
  const units = parseUnitCount(canonical.units);
  if (units != null) {
    if (units > 10000) score += BONUS_UNITS_GT_10K;
    if (units > 100000) score += BONUS_UNITS_GT_100K;
  }

  // Recent.
  const recallDate = parseDate(canonical.recallDate) || parseDate(canonical.reportDate);
  if (recallDate) {
    const ageDays = (now.getTime() - recallDate.getTime()) / (24 * 60 * 60 * 1000);
    if (ageDays <= RECENT_WINDOW_DAYS) score += BONUS_RECENT_7D;
  }

  // Multiple source IDs (updates within this run).
  // allSourceIds is the set of unique sourceIds across the merged group;
  // additional = (count - 1).
  const allSourceIds = new Set();
  for (const c of group) {
    if (c.sourceId != null) allSourceIds.add(c.sourceId);
  }
  const additional = Math.max(0, allSourceIds.size - 1);
  score += Math.min(BONUS_ADDITIONAL_SOURCE_ID_CAP, additional * BONUS_PER_ADDITIONAL_SOURCE_ID);

  return Math.min(SCORE_CAP, score);
}

// ===========================================================================
// Main
// ===========================================================================

async function main() {
  console.log('[build-recall-stories] Starting story deduplication.');
  console.log(`  Input:  ${INPUT_FILE}`);
  console.log(`  Output: ${OUTPUT_FILE}`);

  // --- Load Phase 7A candidates --------------------------------------------
  let raw;
  try {
    raw = await readFile(INPUT_FILE, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return fail(
        'Could not read input file. Run `npm run filter:recalls` first.',
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
  let previousBy = new Map();
  try {
    const prevRaw = await readFile(OUTPUT_FILE, 'utf8');
    const prevDoc = JSON.parse(prevRaw);
    if (Array.isArray(prevDoc.stories)) {
      previousStories = prevDoc.stories;
      for (const s of previousStories) {
        previousBy.set(s.recallKey, s);
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

  // --- Group candidates by recallKey (preserve first-seen order) ----------
  const groupsMap = new Map();
  candidates.forEach((c, idx) => {
    const key = c.recallKey || `no-recall-key__${idx}`;
    if (!groupsMap.has(key)) groupsMap.set(key, { firstIndex: idx, items: [] });
    groupsMap.get(key).items.push(c);
  });

  // --- Build one story record per group -----------------------------------
  const stories = [];
  let newCount = 0;
  let updatedCount = 0;
  let unchangedCount = 0;
  const previousKeysStillSeen = new Set();

  for (const [recallKey, group] of groupsMap) {
    // Canonical = highest-priority, newest-recallDate item.
    const ordered = [...group.items].sort((a, b) => {
      if (a.priority !== b.priority) return a.priority === 'high' ? -1 : 1;
      const da = parseDate(a.recallDate)?.getTime() ?? 0;
      const db = parseDate(b.recallDate)?.getTime() ?? 0;
      return db - da;
    });
    const canonical = ordered[0];

    // Collect all source IDs across the merged group.
    const allSourceIds = [];
    const seen = new Set();
    for (const c of ordered) {
      if (c.sourceId != null && !seen.has(c.sourceId)) {
        seen.add(c.sourceId);
        allSourceIds.push(c.sourceId);
      }
    }

    // Content signature for change detection.
    const currentSig = computeSignature(canonical);

    // Cross-snapshot tracking.
    let firstSeenAt = now.toISOString();
    let latestSeenAt = now.toISOString();
    let crossSnapshotUpdateCount = ordered.length;
    let storyStatus = 'new';
    const prev = previousBy.get(recallKey);
    if (prev) {
      previousKeysStillSeen.add(recallKey);
      firstSeenAt = prev.firstSeenAt || firstSeenAt;
      // Preserve previously-known allSourceIds we no longer see this run,
      // but DON'T double-count: take the union so we never lose history.
      const mergedIds = [];
      const mergedSeen = new Set();
      for (const id of [...allSourceIds, ...(prev.allSourceIds || [])]) {
        if (id != null && !mergedSeen.has(id)) {
          mergedSeen.add(id);
          mergedIds.push(id);
        }
      }
      mergedIds.length = 0;
      mergedIds.push(...Array.from(mergedSeen));
      // crossSnapshotUpdateCount = previous updateCount + (current run observation).
      crossSnapshotUpdateCount = (prev.updateCount || 0) + ordered.length;
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

    const storyScore = computeStoryScore(canonical, ordered, now);

    stories.push({
      storyKey: recallKey, // alias — keeps consistency with NWS story shape
      recallKey,
      storyStatus,
      storyScore,
      updateCount: crossSnapshotUpdateCount,
      allSourceIds,
      firstSeenAt,
      latestSeenAt,
      contentSignature: currentSig,
      // Canonical fields
      source: canonical.source ?? null,
      sourceType: canonical.sourceType ?? null,
      sourceId: canonical.sourceId ?? null,
      sourceLabel: canonical.sourceLabel ?? null,
      title: canonical.title ?? null,
      productName: canonical.productName ?? null,
      brand: canonical.brand ?? null,
      manufacturer: canonical.manufacturer ?? null,
      recallingFirm: canonical.recallingFirm ?? null,
      description: canonical.description ?? null,
      hazard: canonical.hazard ?? null,
      reason: canonical.reason ?? null,
      consumerAction: canonical.consumerAction ?? null,
      classification: canonical.classification ?? null,
      recallDate: canonical.recallDate ?? null,
      reportDate: canonical.reportDate ?? null,
      distribution: canonical.distribution ?? null,
      units: canonical.units ?? null,
      upc: canonical.upc ?? null,
      incidents: canonical.incidents ?? null,
      injuries: canonical.injuries ?? null,
      deaths: canonical.deaths ?? null,
      sourceUrl: canonical.sourceUrl ?? null,
      imageUrls: Array.isArray(canonical.imageUrls) ? canonical.imageUrls : [],
      priority: canonical.priority ?? null,
      selectedReason: canonical.selectedReason ?? null,
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
    if (seenKeys.has(s.recallKey)) {
      return fail('Duplicate recallKey detected after grouping.', s.recallKey);
    }
    seenKeys.add(s.recallKey);
  }

  // --- Output metadata -----------------------------------------------------
  const previousMissingCount = previousStories.length - previousKeysStillSeen.size;

  const output = {
    generatedAt: now.toISOString(),
    source: 'CPSC + FDA',
    inputCandidateCount: candidates.length,
    uniqueStoryCount: stories.length,
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
  console.log('\n[build-recall-stories] SUCCESS');
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
  stories.slice(0, 10).forEach((s, i) => {
    const titlePreview = (s.title || s.productName || '(no title)').slice(0, 70);
    console.log(
      `    ${String(i + 1).padStart(2)}. [${s.storyScore}] ${titlePreview}`,
    );
    console.log(
      `        key=${s.recallKey} status=${s.storyStatus} updates=${s.updateCount} priority=${s.priority || '?'}`,
    );
  });
  console.log('');
}

main().catch((err) => fail('Unexpected failure.', String(err && err.stack ? err.stack : err)));
