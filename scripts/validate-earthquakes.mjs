/**
 * US News Engine — Earthquake data validation (Phase 8A).
 *
 * Validates the earthquake snapshots and story records produced by Phase 8A.
 *
 * Checks (operate on both usgs-earthquakes.json and earthquake-story-records.json
 * where applicable):
 *   1.  Every record has an earthquakeKey
 *   2.  Every record has a sourceId
 *   3.  Every record has a URL (official USGS event page)
 *   4.  Magnitude is a valid number (or null)
 *   5.  Coordinates are valid (latitude -90 to 90, longitude -180 to 180)
 *   6.  Depth is valid (>= -10 and <= 800 km, or null)
 *   7.  Timestamps are valid ISO format (time, updated)
 *   8.  No duplicate earthquakeKeys
 *   9.  isUS field is boolean
 *   10. tsunami field is boolean
 *   11. storyScore is 0-100 (story records only)
 *   12. No obviously malformed data (empty objects, non-array rawSourceData
 *       geometry, missing/invalid source)
 *
 * Exits with code 1 if ANY check fails, 0 if all pass.
 *
 * Run manually:
 *   npm run validate:earthquakes
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(__dirname, '..');

const INPUT_FILES = {
  fetched: join(PROJECT_DIR, 'data', 'earthquakes', 'usgs-earthquakes.json'),
  candidates: join(PROJECT_DIR, 'data', 'earthquakes', 'earthquake-news-candidates.json'),
  stories: join(PROJECT_DIR, 'data', 'earthquakes', 'earthquake-story-records.json'),
};

const VALID_ALERT_LEVELS = new Set([null, 'green', 'yellow', 'orange', 'red']);
const VALID_STATUSES = new Set([null, 'automatic', 'reviewed', 'deleted']);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class CheckResult {
  constructor(id, label) {
    this.id = id;
    this.label = label;
    this.passed = true;
    this.errors = [];
    this.warnings = [];
  }
  fail(message) {
    this.passed = false;
    this.errors.push(message);
  }
  warn(message) {
    this.warnings.push(message);
  }
}

async function loadJsonOptional(path) {
  try {
    const raw = await readFile(path, 'utf8');
    return { ok: true, doc: JSON.parse(raw), raw };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: false, reason: 'missing' };
    return { ok: false, reason: String(err) };
  }
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '';
}

function isBoolean(v) {
  return typeof v === 'boolean';
}

function isNumberOrNull(v) {
  return v == null || (typeof v === 'number' && Number.isFinite(v));
}

function isValidIsoDate(value) {
  if (value == null) return true; // null is allowed for optional timestamps
  if (typeof value !== 'string') return false;
  if (!/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2})?)?$/.test(value)) return false;
  const d = new Date(value);
  return !Number.isNaN(d.getTime());
}

function num(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  return null;
}

// ---------------------------------------------------------------------------
// Check runners
// ---------------------------------------------------------------------------

/**
 * Run all checks against a list of earthquake records (either the fetched
 * snapshot's `earthquakes` array or the candidates `candidates` array).
 * Returns an array of CheckResult objects.
 */
function runRecordChecks(records, sourceLabel) {
  const checks = [];

  // Check 1 — earthquakeKey present
  const c1 = new CheckResult(1, `${sourceLabel}: every record has an earthquakeKey`);
  for (const r of records) {
    if (!isNonEmptyString(r.earthquakeKey)) {
      c1.fail(`Record missing earthquakeKey (sourceId=${r.sourceId ?? '?'})`);
    }
  }
  checks.push(c1);

  // Check 2 — sourceId present
  const c2 = new CheckResult(2, `${sourceLabel}: every record has a sourceId`);
  for (const r of records) {
    if (!isNonEmptyString(r.sourceId)) {
      c2.fail(`Record missing sourceId (earthquakeKey=${r.earthquakeKey ?? '?'})`);
    }
  }
  checks.push(c2);

  // Check 3 — URL (official USGS event page) present
  const c3 = new CheckResult(3, `${sourceLabel}: every record has a URL (USGS event page)`);
  for (const r of records) {
    if (!isNonEmptyString(r.url)) {
      c3.fail(`Record missing url (earthquakeKey=${r.earthquakeKey ?? '?'})`);
    } else if (!/^https?:\/\//i.test(r.url)) {
      c3.fail(`Record url is not an absolute URL: ${r.url} (key=${r.earthquakeKey ?? '?'})`);
    }
  }
  checks.push(c3);

  // Check 4 — magnitude is a number or null
  const c4 = new CheckResult(4, `${sourceLabel}: magnitude is a valid number or null`);
  for (const r of records) {
    if (r.magnitude != null && typeof r.magnitude !== 'number') {
      c4.fail(`Record magnitude is not a number: ${JSON.stringify(r.magnitude)} (key=${r.earthquakeKey ?? '?'})`);
    } else if (typeof r.magnitude === 'number' && !Number.isFinite(r.magnitude)) {
      c4.fail(`Record magnitude is not finite: ${r.magnitude} (key=${r.earthquakeKey ?? '?'})`);
    }
  }
  checks.push(c4);

  // Check 5 — coordinates are valid
  const c5 = new CheckResult(5, `${sourceLabel}: coordinates valid (lat -90..90, lon -180..180)`);
  for (const r of records) {
    const lat = num(r.latitude);
    const lon = num(r.longitude);
    if (lat == null || lat < -90 || lat > 90) {
      c5.fail(`Record has invalid latitude: ${JSON.stringify(r.latitude)} (key=${r.earthquakeKey ?? '?'})`);
    }
    if (lon == null || lon < -180 || lon > 180) {
      c5.fail(`Record has invalid longitude: ${JSON.stringify(r.longitude)} (key=${r.earthquakeKey ?? '?'})`);
    }
  }
  checks.push(c5);

  // Check 6 — depth valid (>= -10 and <= 800 km, or null)
  const c6 = new CheckResult(6, `${sourceLabel}: depth valid (>= -10 and <= 800 km, or null)`);
  for (const r of records) {
    const d = num(r.depthKm);
    if (d != null && (d < -10 || d > 800)) {
      c6.fail(`Record has out-of-range depth: ${d} km (key=${r.earthquakeKey ?? '?'})`);
    }
    if (r.depthKm != null && typeof r.depthKm !== 'number') {
      c6.fail(`Record depthKm is not a number: ${JSON.stringify(r.depthKm)} (key=${r.earthquakeKey ?? '?'})`);
    }
  }
  checks.push(c6);

  // Check 7 — timestamps are valid ISO
  const c7 = new CheckResult(7, `${sourceLabel}: time/updated are valid ISO-8601 or null`);
  for (const r of records) {
    if (!isValidIsoDate(r.time)) {
      c7.fail(`Record has invalid time: ${JSON.stringify(r.time)} (key=${r.earthquakeKey ?? '?'})`);
    }
    if (!isValidIsoDate(r.updated)) {
      c7.fail(`Record has invalid updated: ${JSON.stringify(r.updated)} (key=${r.earthquakeKey ?? '?'})`);
    }
  }
  checks.push(c7);

  // Check 8 — no duplicate earthquakeKeys
  const c8 = new CheckResult(8, `${sourceLabel}: no duplicate earthquakeKeys`);
  const seenKeys = new Map();
  for (const r of records) {
    const k = r.earthquakeKey;
    if (!isNonEmptyString(k)) continue; // already flagged by check 1
    if (seenKeys.has(k)) {
      c8.fail(`Duplicate earthquakeKey: ${k} (also at index ${seenKeys.get(k)})`);
    } else {
      seenKeys.set(k, r.sourceId ?? '?');
    }
  }
  checks.push(c8);

  // Check 9 — isUS is boolean
  const c9 = new CheckResult(9, `${sourceLabel}: isUS is a boolean`);
  for (const r of records) {
    if (!isBoolean(r.isUS)) {
      c9.fail(`Record isUS is not a boolean: ${JSON.stringify(r.isUS)} (key=${r.earthquakeKey ?? '?'})`);
    }
  }
  checks.push(c9);

  // Check 10 — tsunami is boolean
  const c10 = new CheckResult(10, `${sourceLabel}: tsunami is a boolean`);
  for (const r of records) {
    if (!isBoolean(r.tsunami)) {
      c10.fail(`Record tsunami is not a boolean: ${JSON.stringify(r.tsunami)} (key=${r.earthquakeKey ?? '?'})`);
    }
  }
  checks.push(c10);

  // Check 12 — no malformed data (alert/status values, rawSourceData shape)
  const c12 = new CheckResult(12, `${sourceLabel}: no obviously malformed data`);
  for (const r of records) {
    // source must be "USGS"
    if (r.source !== 'USGS') {
      c12.fail(`Record source is not "USGS": ${JSON.stringify(r.source)} (key=${r.earthquakeKey ?? '?'})`);
    }
    // alert value must be a recognized PAGER level (or null)
    if (!VALID_ALERT_LEVELS.has(r.alert)) {
      c12.fail(`Record has unexpected alert value: ${JSON.stringify(r.alert)} (key=${r.earthquakeKey ?? '?'})`);
    }
    // status value must be a recognized USGS status (or null)
    if (!VALID_STATUSES.has(r.status)) {
      c12.fail(`Record has unexpected status value: ${JSON.stringify(r.status)} (key=${r.earthquakeKey ?? '?'})`);
    }
    // rawSourceData is present and has the expected shape (only for fetched)
    if (r.rawSourceData != null) {
      if (typeof r.rawSourceData !== 'object' || Array.isArray(r.rawSourceData)) {
        c12.fail(`Record rawSourceData is not an object (key=${r.earthquakeKey ?? '?'})`);
      } else {
        const props = r.rawSourceData.properties;
        const geom = r.rawSourceData.geometry;
        if (!props || typeof props !== 'object') {
          c12.fail(`Record rawSourceData.properties is missing or not an object (key=${r.earthquakeKey ?? '?'})`);
        }
        if (!geom || typeof geom !== 'object' || !Array.isArray(geom.coordinates)) {
          c12.fail(`Record rawSourceData.geometry is missing or has no coordinates array (key=${r.earthquakeKey ?? '?'})`);
        }
      }
    }
    // significance, if present, must be a number
    if (!isNumberOrNull(r.significance)) {
      c12.fail(`Record significance is not a number or null: ${JSON.stringify(r.significance)} (key=${r.earthquakeKey ?? '?'})`);
    }
    // felt, if present, must be a number >= 0
    if (r.felt != null && (typeof r.felt !== 'number' || r.felt < 0 || !Number.isFinite(r.felt))) {
      c12.fail(`Record felt is not a non-negative number: ${JSON.stringify(r.felt)} (key=${r.earthquakeKey ?? '?'})`);
    }
  }
  checks.push(c12);

  return checks;
}

/**
 * Story-records-specific checks: storyScore 0-100, plus a re-run of the
 * generic record checks (story records carry the same canonical fields).
 */
function runStoryChecks(stories) {
  const checks = [];

  // Re-run the generic checks against stories (they carry the same fields).
  const generic = runRecordChecks(stories, 'stories');
  // Renumber generic checks so they don't collide with the storyScore check.
  // We'll prefix them to indicate they apply to the stories file.
  for (const c of generic) {
    c.label = `stories (re-check ${c.id}): ${c.label.split(':').slice(1).join(':').trim()}`;
  }
  checks.push(...generic);

  // Check 11 — storyScore is 0-100
  const c11 = new CheckResult(11, 'stories: storyScore is 0-100');
  for (const s of stories) {
    if (typeof s.storyScore !== 'number' || !Number.isFinite(s.storyScore)) {
      c11.fail(`Story storyScore is not a finite number: ${JSON.stringify(s.storyScore)} (key=${s.earthquakeKey ?? '?'})`);
    } else if (s.storyScore < 0 || s.storyScore > 100) {
      c11.fail(`Story storyScore is out of range [0,100]: ${s.storyScore} (key=${s.earthquakeKey ?? '?'})`);
    }
  }
  checks.push(c11);

  return checks;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('[validate-earthquakes] Starting earthquake data validation.');

  // --- Load all three files -----------------------------------------------
  const fetchedRes = await loadJsonOptional(INPUT_FILES.fetched);
  const candidatesRes = await loadJsonOptional(INPUT_FILES.candidates);
  const storiesRes = await loadJsonOptional(INPUT_FILES.stories);

  const allChecks = [];

  // Fetched snapshot — primary record checks (1-10, 12).
  if (fetchedRes.ok) {
    const earthquakes = Array.isArray(fetchedRes.doc.earthquakes) ? fetchedRes.doc.earthquakes : [];
    console.log(`  Fetched:  ${earthquakes.length} earthquakes`);
    allChecks.push(...runRecordChecks(earthquakes, 'fetched'));
  } else {
    console.log(`  Fetched:  [missing] ${INPUT_FILES.fetched}`);
    const c = new CheckResult(0, 'fetched file exists');
    c.fail(`Fetched file is missing or unreadable: ${INPUT_FILES.fetched} (${fetchedRes.reason})`);
    allChecks.push(c);
  }

  // Candidates — same record checks (the candidate file carries the same
  // canonical fields, minus rawSourceData).
  if (candidatesRes.ok) {
    const candidates = Array.isArray(candidatesRes.doc.candidates) ? candidatesRes.doc.candidates : [];
    console.log(`  Candidates: ${candidates.length} candidates`);
    allChecks.push(...runRecordChecks(candidates, 'candidates'));
  } else {
    console.log(`  Candidates: [missing] ${INPUT_FILES.candidates}`);
    const c = new CheckResult(0, 'candidates file exists');
    c.fail(`Candidates file is missing or unreadable: ${INPUT_FILES.candidates} (${candidatesRes.reason})`);
    allChecks.push(c);
  }

  // Stories — story checks (record checks + storyScore).
  if (storiesRes.ok) {
    const stories = Array.isArray(storiesRes.doc.stories) ? storiesRes.doc.stories : [];
    console.log(`  Stories:   ${stories.length} stories`);
    allChecks.push(...runStoryChecks(stories));
  } else {
    console.log(`  Stories:   [missing] ${INPUT_FILES.stories}`);
    const c = new CheckResult(0, 'stories file exists');
    c.fail(`Stories file is missing or unreadable: ${INPUT_FILES.stories} (${storiesRes.reason})`);
    allChecks.push(c);
  }

  // --- Report -------------------------------------------------------------
  console.log('');
  let totalPassed = 0;
  let totalFailed = 0;
  for (const c of allChecks) {
    const status = c.passed ? 'PASS' : 'FAIL';
    console.log(`  [${status}] Check ${c.id}: ${c.label}`);
    if (c.passed) {
      totalPassed++;
    } else {
      totalFailed++;
      for (const err of c.errors.slice(0, 10)) {
        console.log(`          - ${err}`);
      }
      if (c.errors.length > 10) {
        console.log(`          ... and ${c.errors.length - 10} more`);
      }
    }
    for (const w of c.warnings.slice(0, 3)) {
      console.log(`          (warn) ${w}`);
    }
  }

  console.log('');
  console.log(`[validate-earthquakes] Checks passed: ${totalPassed}/${allChecks.length}`);
  if (totalFailed > 0) {
    console.error(`[validate-earthquakes] FAILED — ${totalFailed} check(s) failed.`);
    process.exit(1);
  }
  console.log('[validate-earthquakes] SUCCESS — all checks passed.');
  process.exit(0);
}

main().catch((err) => {
  console.error(`\n[validate-earthquakes] Unexpected failure: ${String(err && err.stack ? err.stack : err)}`);
  process.exit(1);
});
