/**
 * US News Engine — Recalls data validation (Phase 7A).
 *
 * Validates the recall snapshots and story records produced by Phase 7A.
 *
 * Checks performed:
 *   1.  Every recall record has a recallKey
 *   2.  Every recall record has a sourceUrl
 *   3.  Every recall record has a sourceId
 *   4.  No duplicate recallKeys in the story records
 *   5.  Title/productName fields are not empty (at least one must be present)
 *   6.  Dates (recallDate, reportDate) are valid ISO-8601 when present
 *   7.  source is either "CPSC" or "FDA"
 *   8.  Numeric deaths/injuries must be >= 0
 *   9.  No obviously malformed data (empty objects, non-array imageUrls)
 *
 * Exits with code 1 if ANY check fails, 0 if all pass.
 *
 * Run manually:
 *   npm run validate:recalls
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(__dirname, '..');

const RECALL_SNAPSHOTS = [
  join(PROJECT_DIR, 'data', 'recalls', 'cpsc-recalls.json'),
  join(PROJECT_DIR, 'data', 'recalls', 'fda-food-recalls.json'),
  join(PROJECT_DIR, 'data', 'recalls', 'fda-device-recalls.json'),
];
const CANDIDATES_FILE = join(PROJECT_DIR, 'data', 'recalls', 'recall-news-candidates.json');
const STORIES_FILE = join(PROJECT_DIR, 'data', 'recalls', 'recall-story-records.json');

const VALID_SOURCES = new Set(['CPSC', 'FDA']);

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

function isValidIsoDate(value) {
  if (!value || typeof value !== 'string') return false;
  // Accept ISO 8601 like "2026-09-27T00:00:00.000Z" or "2026-09-27".
  // Reject strings like "20260927" (FDA raw format) — those should have
  // been converted to ISO by the fetcher.
  if (!/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2})?)?$/.test(value)) return false;
  const d = new Date(value);
  return !Number.isNaN(d.getTime());
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

/**
 * Load every recall record from all snapshot files into a single list while
 * tagging each with the file it came from (for clear error messages).
 */
async function loadAllRecalls() {
  const all = [];
  const perFile = [];
  for (const path of RECALL_SNAPSHOTS) {
    const result = await loadJsonOptional(path);
    if (!result.ok) {
      perFile.push({ path, recalls: [], missing: true, reason: result.reason });
      continue;
    }
    const recalls = Array.isArray(result.doc.recalls) ? result.doc.recalls : [];
    for (const r of recalls) {
      all.push({ record: r, source: path });
    }
    perFile.push({ path, recalls, missing: false });
  }
  return { all, perFile };
}

function checkRecallKeyPresent(allRecalls, result) {
  for (const { record, source } of allRecalls) {
    if (!record || typeof record !== 'object') {
      result.fail(`Non-object record in ${source}`);
      continue;
    }
    if (record.recallKey == null || record.recallKey === '') {
      result.fail(`Missing recallKey in ${source} (sourceId=${record.sourceId ?? '?'})`);
    }
  }
}

function checkSourceUrlPresent(allRecalls, result) {
  for (const { record, source } of allRecalls) {
    if (!record || typeof record !== 'object') continue;
    if (record.sourceUrl == null || record.sourceUrl === '') {
      result.fail(`Missing sourceUrl in ${source} (recallKey=${record.recallKey ?? '?'})`);
    }
  }
}

function checkSourceIdPresent(allRecalls, result) {
  for (const { record, source } of allRecalls) {
    if (!record || typeof record !== 'object') continue;
    if (record.sourceId == null || record.sourceId === '') {
      result.fail(`Missing sourceId in ${source} (recallKey=${record.recallKey ?? '?'})`);
    }
  }
}

function checkTitleOrProductNonEmpty(allRecalls, result) {
  for (const { record, source } of allRecalls) {
    if (!record || typeof record !== 'object') continue;
    const title = record.title;
    const productName = record.productName;
    const hasTitle = typeof title === 'string' && title.trim() !== '';
    const hasProduct = typeof productName === 'string' && productName.trim() !== '';
    if (!hasTitle && !hasProduct) {
      result.fail(`Empty title and productName in ${source} (recallKey=${record.recallKey ?? '?'})`);
    }
  }
}

function checkDatesValid(allRecalls, result) {
  for (const { record, source } of allRecalls) {
    if (!record || typeof record !== 'object') continue;
    for (const field of ['recallDate', 'reportDate']) {
      const v = record[field];
      if (v == null || v === '') continue; // null/missing is allowed
      if (!isValidIsoDate(v)) {
        result.fail(
          `Invalid ISO date for ${field}="${v}" in ${source} (recallKey=${record.recallKey ?? '?'})`,
        );
      }
    }
  }
}

function checkSourceValue(allRecalls, result) {
  for (const { record, source } of allRecalls) {
    if (!record || typeof record !== 'object') continue;
    if (!VALID_SOURCES.has(record.source)) {
      result.fail(
        `Invalid source "${record.source}" in ${source} (recallKey=${record.recallKey ?? '?'}) — must be CPSC or FDA`,
      );
    }
  }
}

function checkNumericImpactNonNegative(allRecalls, result) {
  for (const { record, source } of allRecalls) {
    if (!record || typeof record !== 'object') continue;
    for (const field of ['deaths', 'injuries', 'incidents']) {
      const v = record[field];
      if (typeof v === 'number' && v < 0) {
        result.fail(
          `Negative ${field}=${v} in ${source} (recallKey=${record.recallKey ?? '?'})`,
        );
      }
    }
  }
}

function checkNoMalformedData(allRecalls, result) {
  for (const { record, source } of allRecalls) {
    if (!record || typeof record !== 'object') {
      result.fail(`Null or non-object record in ${source}`);
      continue;
    }
    // imageUrls must be an array (possibly empty) — never null.
    if (record.imageUrls == null) {
      result.fail(`imageUrls is null in ${source} (recallKey=${record.recallKey ?? '?'}) — should be []`);
    } else if (!Array.isArray(record.imageUrls)) {
      result.fail(`imageUrls is not an array in ${source} (recallKey=${record.recallKey ?? '?'})`);
    }
    // rawSourceData should be an object (the original record).
    if (record.rawSourceData == null) {
      result.warn(`rawSourceData is null in ${source} (recallKey=${record.recallKey ?? '?'})`);
    }
  }
}

async function checkNoDuplicateStoryKeys(result) {
  const loadResult = await loadJsonOptional(STORIES_FILE);
  if (!loadResult.ok) {
    result.warn(`Could not load story records file (${loadResult.reason}) — skipping duplicate-key check.`);
    return;
  }
  const stories = Array.isArray(loadResult.doc.stories) ? loadResult.doc.stories : [];
  if (stories.length === 0) {
    result.warn('Story records file is empty or has no stories — nothing to check.');
    return;
  }
  const seen = new Set();
  const dups = [];
  for (const s of stories) {
    const key = s?.recallKey;
    if (key == null) {
      result.fail(`Story missing recallKey in ${STORIES_FILE}`);
      continue;
    }
    if (seen.has(key)) {
      dups.push(key);
    } else {
      seen.add(key);
    }
  }
  if (dups.length) {
    for (const k of dups) {
      result.fail(`Duplicate recallKey in story records: ${k}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('[validate-recalls] Starting validation of recall data.');
  console.log(`  Snapshots checked:`);
  for (const p of RECALL_SNAPSHOTS) console.log(`    - ${p}`);
  console.log(`  Stories file: ${STORIES_FILE}`);
  console.log('');

  // Load all recall records up-front so each check can iterate without
  // re-reading files.
  const { all: allRecalls, perFile } = await loadAllRecalls();

  for (const pf of perFile) {
    if (pf.missing) {
      console.log(`  [info] Snapshot file not found: ${pf.path} (skipping)`);
    } else {
      console.log(`  [info] Loaded ${String(pf.recalls.length).padStart(4)} records from ${pf.path}`);
    }
  }
  console.log(`  Total recall records loaded: ${allRecalls.length}\n`);

  const checks = [
    new CheckResult(1, 'Every recall record has a recallKey'),
    new CheckResult(2, 'Every recall record has a sourceUrl'),
    new CheckResult(3, 'Every recall record has a sourceId'),
    new CheckResult(4, 'No duplicate recallKeys in story records'),
    new CheckResult(5, 'Title/productName not empty'),
    new CheckResult(6, 'Dates (recallDate, reportDate) are valid ISO-8601 when present'),
    new CheckResult(7, 'source is either "CPSC" or "FDA"'),
    new CheckResult(8, 'Numeric deaths/injuries/incidents are >= 0'),
    new CheckResult(9, 'No obviously malformed data (null arrays, empty objects)'),
  ];

  // Run checks 1-3, 5-9 against recall snapshots.
  checkRecallKeyPresent(allRecalls, checks[0]);
  checkSourceUrlPresent(allRecalls, checks[1]);
  checkSourceIdPresent(allRecalls, checks[2]);
  // check 4 = story records dedup — runs separately below.
  checkTitleOrProductNonEmpty(allRecalls, checks[4]);
  checkDatesValid(allRecalls, checks[5]);
  checkSourceValue(allRecalls, checks[6]);
  checkNumericImpactNonNegative(allRecalls, checks[7]);
  checkNoMalformedData(allRecalls, checks[8]);

  // Check 4 — duplicate recallKeys in story records.
  await checkNoDuplicateStoryKeys(checks[3]);

  // --- Also check candidates file if present -------------------------------
  const candidatesLoad = await loadJsonOptional(CANDIDATES_FILE);
  if (candidatesLoad.ok && Array.isArray(candidatesLoad.doc.candidates)) {
    const candidates = candidatesLoad.doc.candidates;
    console.log(`  [info] Loaded ${String(candidates.length).padStart(4)} candidates from ${CANDIDATES_FILE}`);
    const candKeys = new Set();
    let candKeyDups = 0;
    for (const c of candidates) {
      if (c?.recallKey == null || c.recallKey === '') {
        checks[0].fail(`Candidate missing recallKey in ${CANDIDATES_FILE}`);
        continue;
      }
      if (candKeys.has(c.recallKey)) candKeyDups++;
      else candKeys.add(c.recallKey);
    }
    if (candKeyDups > 0) {
      checks[0].warn(`${candKeyDups} duplicate recallKeys in candidates file (allowed — build step will dedup)`);
    }
    console.log('');
  } else {
    console.log(`  [info] Candidates file not found or empty (skipping).\n`);
  }

  // --- Print results -------------------------------------------------------
  let allPassed = true;
  for (const c of checks) {
    const status = c.passed ? 'PASS' : 'FAIL';
    console.log(`  [${status}] Check ${c.id}: ${c.label}`);
    if (c.errors.length) {
      allPassed = false;
      for (const e of c.errors.slice(0, 20)) {
        console.log(`          - ${e}`);
      }
      if (c.errors.length > 20) {
        console.log(`          ... and ${c.errors.length - 20} more errors`);
      }
    }
    for (const w of c.warnings) {
      console.log(`          (warn) ${w}`);
    }
  }

  console.log('');
  const failed = checks.filter((c) => !c.passed).length;
  const passed = checks.length - failed;
  console.log(`[validate-recalls] Summary: ${passed}/${checks.length} checks passed, ${failed} failed.`);

  if (allPassed) {
    console.log('[validate-recalls] OVERALL: PASS');
    process.exit(0);
  } else {
    console.log('[validate-recalls] OVERALL: FAIL');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`\n[validate-recalls] Unexpected failure: ${String(err && err.stack ? err.stack : err)}`);
  process.exit(1);
});
