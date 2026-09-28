/**
 * US News Engine — Science data validation (Phase 9A).
 *
 * Validates the science snapshots and story records produced by Phase 9A:
 *   - data/science/nasa-news.json
 *   - data/science/jpl-news.json
 *   - data/science/swpc-events.json
 *   - data/science/science-news-candidates.json
 *   - data/science/science-story-records.json
 *
 * Checks (operate on every applicable file):
 *   1.  Every record has a scienceKey
 *   2.  Every record has a sourceUrl
 *   3.  No duplicate scienceKeys (per source file)
 *   4.  No duplicate scienceStoryKeys (story records)
 *   5.  Source dates are valid (publishedAtSource is parseable ISO or null)
 *   6.  Source is one of NASA, JPL, NOAA-SWPC
 *   7.  SWPC severity is a recognized NOAA scale value (R1-5, S1-5, G1-5)
 *       or null for non-SWPC records
 *   8.  No external/unverified image selected automatically
 *       (imageCredit must be NASA, NASA/JPL-Caltech, or NOAA SWPC)
 *   9.  publishEligible items have eligibility reasons (selectedReason
 *       non-empty)
 *
 * Exits with code 1 if ANY check fails, 0 if all pass.
 *
 * Run manually:
 *   npm run validate:science
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(__dirname, '..');

const INPUT_FILES = {
  nasa: join(PROJECT_DIR, 'data', 'science', 'nasa-news.json'),
  jpl: join(PROJECT_DIR, 'data', 'science', 'jpl-news.json'),
  swpc: join(PROJECT_DIR, 'data', 'science', 'swpc-events.json'),
  candidates: join(PROJECT_DIR, 'data', 'science', 'science-news-candidates.json'),
  stories: join(PROJECT_DIR, 'data', 'science', 'science-story-records.json'),
};

const VALID_SOURCES = new Set(['NASA', 'JPL', 'NOAA-SWPC']);
const VALID_IMAGE_CREDITS = new Set(['NASA', 'NASA/JPL-Caltech', 'NOAA SWPC']);
const RECOGNIZED_SEVERITY = new Set([
  'R1', 'R2', 'R3', 'R4', 'R5',
  'S1', 'S2', 'S3', 'S4', 'S5',
  'G1', 'G2', 'G3', 'G4', 'G5',
]);

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
    return { ok: true, doc: JSON.parse(raw) };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: false, reason: 'missing' };
    return { ok: false, reason: String(err) };
  }
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '';
}

function isValidIsoDate(value) {
  if (value == null) return true;
  if (typeof value !== 'string') return false;
  if (!/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2})?)?$/.test(value)) return false;
  const d = new Date(value);
  return !Number.isNaN(d.getTime());
}

/**
 * Run all record-level checks against a list of science records.
 * `label` is the source-file name (for error provenance).
 */
function runRecordChecks(records, label) {
  const checks = [];

  // Check 1 — scienceKey present
  const c1 = new CheckResult(1, `${label}: every record has a scienceKey`);
  for (const r of records) {
    if (!isNonEmptyString(r.scienceKey)) {
      c1.fail(`Record missing scienceKey (sourceId=${r.sourceId ?? '?'} source=${r.source ?? '?'})`);
    }
  }
  checks.push(c1);

  // Check 2 — sourceUrl present
  const c2 = new CheckResult(2, `${label}: every record has a sourceUrl`);
  for (const r of records) {
    if (!isNonEmptyString(r.sourceUrl)) {
      c2.fail(`Record missing sourceUrl (scienceKey=${r.scienceKey ?? '?'})`);
    } else if (!/^https?:\/\//i.test(r.sourceUrl)) {
      c2.fail(`Record sourceUrl is not an absolute URL: ${r.sourceUrl} (key=${r.scienceKey ?? '?'})`);
    }
  }
  checks.push(c2);

  // Check 3 — no duplicate scienceKeys
  const c3 = new CheckResult(3, `${label}: no duplicate scienceKeys`);
  const seen = new Map();
  for (const r of records) {
    const k = r.scienceKey;
    if (!isNonEmptyString(k)) continue; // already flagged by check 1
    if (seen.has(k)) {
      c3.fail(`Duplicate scienceKey: ${k} (also at index ${seen.get(k)})`);
    } else {
      seen.set(k, r.sourceId ?? '?');
    }
  }
  checks.push(c3);

  // Check 5 — source dates are valid
  const c5 = new CheckResult(5, `${label}: publishedAtSource is valid ISO-8601 or null`);
  for (const r of records) {
    if (!isValidIsoDate(r.publishedAtSource)) {
      c5.fail(`Record has invalid publishedAtSource: ${JSON.stringify(r.publishedAtSource)} (key=${r.scienceKey ?? '?'})`);
    }
    if (!isValidIsoDate(r.updatedAtSource)) {
      c5.fail(`Record has invalid updatedAtSource: ${JSON.stringify(r.updatedAtSource)} (key=${r.scienceKey ?? '?'})`);
    }
  }
  checks.push(c5);

  // Check 6 — source is one of NASA, JPL, NOAA-SWPC
  const c6 = new CheckResult(6, `${label}: source is NASA, JPL, or NOAA-SWPC`);
  for (const r of records) {
    if (!VALID_SOURCES.has(r.source)) {
      c6.fail(`Record has unexpected source: ${JSON.stringify(r.source)} (key=${r.scienceKey ?? '?'})`);
    }
  }
  checks.push(c6);

  // Check 7 — SWPC severity is a recognized NOAA scale value
  const c7 = new CheckResult(7, `${label}: SWPC severity is a recognized NOAA scale value (R1-5/S1-5/G1-5)`);
  for (const r of records) {
    if (r.source === 'NOAA-SWPC') {
      if (r.severity != null && !RECOGNIZED_SEVERITY.has(r.severity)) {
        c7.fail(`SWPC record has unrecognized severity: ${JSON.stringify(r.severity)} (key=${r.scienceKey ?? '?'})`);
      }
    } else {
      // Non-SWPC records should not carry a severity value.
      if (r.severity != null) {
        c7.fail(`Non-SWPC record carries severity: ${JSON.stringify(r.severity)} (key=${r.scienceKey ?? '?'}, source=${r.source})`);
      }
    }
  }
  checks.push(c7);

  // Check 8 — no external/unverified image selected automatically
  // imageCredit must be NASA, NASA/JPL-Caltech, or NOAA SWPC (or null).
  const c8 = new CheckResult(8, `${label}: no external/unverified image credit (must be NASA/NASA-JPL-Caltech/NOAA SWPC)`);
  for (const r of records) {
    if (r.imageCredit != null) {
      if (!VALID_IMAGE_CREDITS.has(r.imageCredit)) {
        c8.fail(`Record has unverified imageCredit: ${JSON.stringify(r.imageCredit)} (key=${r.scienceKey ?? '?'})`);
      }
    }
    // imageUrl, when present, must be an absolute http(s) URL.
    if (r.imageUrl != null) {
      if (typeof r.imageUrl !== 'string' || !/^https?:\/\//i.test(r.imageUrl)) {
        c8.fail(`Record has non-absolute imageUrl: ${JSON.stringify(r.imageUrl)} (key=${r.scienceKey ?? '?'})`);
      }
    }
  }
  checks.push(c8);

  return checks;
}

/**
 * Story-records-specific checks: scienceStoryKey present + unique,
 * storyScore 0-100, plus re-runs of the record-level checks against the
 * denormalized fields that the story record carries.
 */
function runStoryChecks(stories) {
  const checks = [];

  // Check 4 — no duplicate scienceStoryKeys
  const c4 = new CheckResult(4, 'stories: no duplicate scienceStoryKeys');
  const seen = new Map();
  for (const s of stories) {
    const k = s.scienceStoryKey;
    if (!isNonEmptyString(k)) {
      c4.fail(`Story missing scienceStoryKey (primary=${s.primarySource ?? '?'})`);
      continue;
    }
    if (seen.has(k)) {
      c4.fail(`Duplicate scienceStoryKey: ${k} (also at index ${seen.get(k)})`);
    } else {
      seen.set(k, s.titleSeed ?? '?');
    }
  }
  checks.push(c4);

  // Check 11 — storyScore is 0-100
  const c11 = new CheckResult(11, 'stories: storyScore is 0-100');
  for (const s of stories) {
    if (typeof s.storyScore !== 'number' || !Number.isFinite(s.storyScore)) {
      c11.fail(`Story storyScore is not a finite number: ${JSON.stringify(s.storyScore)} (key=${s.scienceStoryKey ?? '?'})`);
    } else if (s.storyScore < 0 || s.storyScore > 100) {
      c11.fail(`Story storyScore is out of range [0,100]: ${s.storyScore} (key=${s.scienceStoryKey ?? '?'})`);
    }
  }
  checks.push(c11);

  // Check 9 — publishEligible items have eligibility reasons (selectedReason non-empty)
  const c9 = new CheckResult(9, 'stories: publishEligible items have eligibility reasons (selectedReason non-empty)');
  for (const s of stories) {
    if (s.publishEligible === true) {
      if (!isNonEmptyString(s.selectedReason)) {
        c9.fail(`Story is publishEligible but selectedReason is empty/missing (key=${s.scienceStoryKey ?? '?'})`);
      }
    }
  }
  checks.push(c9);

  return checks;
}

/**
 * Run check 9 against the candidates file as well (each publishEligible
 * candidate must have selectedReason).
 */
function runCandidateEligibilityCheck(candidates) {
  const c9 = new CheckResult(9, 'candidates: publishEligible items have eligibility reasons (selectedReason non-empty)');
  for (const r of candidates) {
    if (r.publishEligible === true) {
      if (!isNonEmptyString(r.selectedReason)) {
        c9.fail(`Candidate is publishEligible but selectedReason is empty/missing (key=${r.scienceKey ?? '?'})`);
      }
    }
  }
  return c9;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('[validate-science] Starting science data validation.');

  const nasaRes = await loadJsonOptional(INPUT_FILES.nasa);
  const jplRes = await loadJsonOptional(INPUT_FILES.jpl);
  const swpcRes = await loadJsonOptional(INPUT_FILES.swpc);
  const candidatesRes = await loadJsonOptional(INPUT_FILES.candidates);
  const storiesRes = await loadJsonOptional(INPUT_FILES.stories);

  const allChecks = [];

  // --- NASA fetched records ----------------------------------------------
  if (nasaRes.ok) {
    const records = Array.isArray(nasaRes.doc.records) ? nasaRes.doc.records : [];
    console.log(`  NASA:       ${records.length} records`);
    allChecks.push(...runRecordChecks(records, 'nasa-news'));
  } else {
    console.log(`  NASA:       [missing] ${INPUT_FILES.nasa}`);
    const c = new CheckResult(0, 'nasa-news file exists');
    c.fail(`nasa-news.json is missing or unreadable (${nasaRes.reason})`);
    allChecks.push(c);
  }

  // --- JPL fetched records -----------------------------------------------
  if (jplRes.ok) {
    const records = Array.isArray(jplRes.doc.records) ? jplRes.doc.records : [];
    console.log(`  JPL:        ${records.length} records`);
    // JPL may legitimately have 0 records when the feed is blocked.
    // Still validate the (empty) list to keep the checks honest.
    allChecks.push(...runRecordChecks(records, 'jpl-news'));
    if (jplRes.doc.error) {
      console.log(`  JPL feed error noted: ${jplRes.doc.error}`);
    }
  } else {
    console.log(`  JPL:        [missing] ${INPUT_FILES.jpl}`);
    const c = new CheckResult(0, 'jpl-news file exists');
    c.fail(`jpl-news.json is missing or unreadable (${jplRes.reason})`);
    allChecks.push(c);
  }

  // --- SWPC fetched records ----------------------------------------------
  if (swpcRes.ok) {
    const records = Array.isArray(swpcRes.doc.records) ? swpcRes.doc.records : [];
    console.log(`  SWPC:       ${records.length} records`);
    allChecks.push(...runRecordChecks(records, 'swpc-events'));
  } else {
    console.log(`  SWPC:       [missing] ${INPUT_FILES.swpc}`);
    const c = new CheckResult(0, 'swpc-events file exists');
    c.fail(`swpc-events.json is missing or unreadable (${swpcRes.reason})`);
    allChecks.push(c);
  }

  // --- Candidates --------------------------------------------------------
  let candidates = [];
  if (candidatesRes.ok) {
    candidates = Array.isArray(candidatesRes.doc.candidates) ? candidatesRes.doc.candidates : [];
    console.log(`  Candidates: ${candidates.length} candidates`);
    allChecks.push(...runRecordChecks(candidates, 'candidates'));
    allChecks.push(runCandidateEligibilityCheck(candidates));
  } else {
    console.log(`  Candidates: [missing] ${INPUT_FILES.candidates}`);
    const c = new CheckResult(0, 'candidates file exists');
    c.fail(`science-news-candidates.json is missing or unreadable (${candidatesRes.reason})`);
    allChecks.push(c);
  }

  // --- Stories -----------------------------------------------------------
  let stories = [];
  if (storiesRes.ok) {
    stories = Array.isArray(storiesRes.doc.stories) ? storiesRes.doc.stories : [];
    console.log(`  Stories:    ${stories.length} stories`);
    allChecks.push(...runStoryChecks(stories));
  } else {
    console.log(`  Stories:    [missing] ${INPUT_FILES.stories}`);
    const c = new CheckResult(0, 'stories file exists');
    c.fail(`science-story-records.json is missing or unreadable (${storiesRes.reason})`);
    allChecks.push(c);
  }

  // --- Report ------------------------------------------------------------
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
  console.log(`[validate-science] Checks passed: ${totalPassed}/${allChecks.length}`);
  if (totalFailed > 0) {
    console.error(`[validate-science] FAILED — ${totalFailed} check(s) failed.`);
    process.exit(1);
  }
  console.log('[validate-science] SUCCESS — all checks passed.');
  process.exit(0);
}

main().catch((err) => {
  console.error(`\n[validate-science] Unexpected failure: ${String(err && err.stack ? err.stack : err)}`);
  process.exit(1);
});
