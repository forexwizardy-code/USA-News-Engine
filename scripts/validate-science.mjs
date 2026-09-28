/**
 * US News Engine — Science data validation (Phase 9A.1 hardened).
 *
 * Validates the science snapshots and story records produced by Phase
 * 9A.1:
 *   - data/science/nasa-news.json
 *   - data/science/jpl-news.json
 *   - data/science/swpc-events.json
 *   - data/science/science-news-candidates.json
 *   - data/science/science-story-records.json
 *
 * Phase 9A.1 adds these new checks on top of the Phase 9A checks:
 *
 *   12. Each fetcher output carries sourceAvailable (boolean),
 *       httpStatus (number), fetchError (string|null), recordCount
 *       (number), fetchedAt (ISO string).
 *   13. Failed source fetch must NOT be represented as a successful
 *       zero-result fetch: when sourceAvailable=false, fetchError must
 *       be non-empty AND recordCount must be 0.
 *   14. When sourceAvailable=true, httpStatus must be 200 (the only
 *       success code our fetchers accept).
 *   15. Every NASA/JPL record carries a storyType field (one of the
 *       canonical Phase 9A.1 types).
 *   16. APOD items (title starts with "APOD:") must be
 *       publishEligible=false AND storyType="evergreen".
 *   17. space-policy story must NOT be publishEligible.
 *   18. media-advisory story must NOT be publishEligible.
 *   19. education story must NOT be publishEligible.
 *   20. administrative story must NOT be publishEligible.
 *   21. evergreen story must NOT be publishEligible.
 *   22. Image with rightsStatus "unclear" or "unverified" must NOT
 *       be auto-selected as a story's hero image (story.imageUrl must
 *       be null when the chosen image's rightsStatus is unclear or
 *       unverified).
 *   23. Image credit must NOT be inferred only from hostname: when an
 *       imageUrl is set, imageCredit must be either null (no credit
 *       text found) or a non-empty string extracted from explicit
 *       credit text. The credit may not be just the bare source name
 *       "NASA" / "JPL" / "NOAA SWPC" UNLESS that exact string was the
 *       extracted credit (we approximate this check by allowing those
 *       values when rightsStatus is "verified-agency", since that
 *       status is only set when the credit text contains "NASA" or
 *       "NOAA").
 *
 * Existing Phase 9A checks retained:
 *   1.  Every record has a scienceKey
 *   2.  Every record has a sourceUrl (absolute http/https)
 *   3.  No duplicate scienceKeys (per source file)
 *   4.  No duplicate scienceStoryKeys (story records)
 *   5.  Source dates are valid (publishedAtSource is parseable ISO or null)
 *   6.  Source is one of NASA, JPL, NOAA-SWPC
 *   7.  SWPC severity is a recognized NOAA scale value (R1-5, S1-5, G1-5)
 *       or null for non-SWPC records
 *   8.  No external/unverified image credit (imageCredit must be null
 *       OR a non-empty string; imageUrl, when present, must be an
 *       absolute http(s) URL)
 *   9.  publishEligible items have non-empty selectedReason
 *   11. storyScore is 0-100 (story records only)
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
const RECOGNIZED_SEVERITY = new Set([
  'R1', 'R2', 'R3', 'R4', 'R5',
  'S1', 'S2', 'S3', 'S4', 'S5',
  'G1', 'G2', 'G3', 'G4', 'G5',
]);

// Valid storyType values (Phase 9A.1).
const VALID_STORY_TYPES = new Set([
  'mission-milestone', 'launch', 'landing', 'discovery',
  'astronomy', 'earth-science', 'technology', 'crew-mission',
  'space-weather', 'space-policy', 'administrative', 'education',
  'media-advisory', 'evergreen',
]);

// Story types that must NEVER be publishEligible.
const NEVER_PUBLISH_TYPES = new Set([
  'space-policy', 'administrative', 'education',
  'media-advisory', 'evergreen',
]);

// Valid rightsStatus values.
const VALID_RIGHTS_STATUSES = new Set([
  'verified-agency', 'verified-third-party', 'unclear', 'unverified',
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

function isBoolean(v) {
  return typeof v === 'boolean';
}

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
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

  // Check 8 — image credit/URL sanity (Phase 9A.1 hardened)
  //   - imageUrl, when present, must be an absolute http(s) URL.
  //   - imageCredit, when present, must be a non-empty string.
  //   - rightsStatus, when present, must be one of VALID_RIGHTS_STATUSES.
  //   - When imageUrl is present, rightsStatus must NOT be null.
  //   - When rightsStatus is "unclear", imageCredit must be null
  //     (unclear means no credit text was extracted).
  //   - When rightsStatus is "unverified", imageCredit MAY be set
  //     (extracted text from a non-agency credit) but the image is on
  //     an external domain; the validator does NOT fail this case here.
  //   - imageCredit must NOT be just the source name when rightsStatus
  //     is "unclear" — that would mean we inferred the credit from the
  //     hostname, which Phase 9A.1 explicitly forbids.
  const c8 = new CheckResult(8, `${label}: image credit/URL sanity (Phase 9A.1 hardened)`);
  for (const r of records) {
    if (r.imageUrl != null) {
      if (typeof r.imageUrl !== 'string' || !/^https?:\/\//i.test(r.imageUrl)) {
        c8.fail(`Record has non-absolute imageUrl: ${JSON.stringify(r.imageUrl)} (key=${r.scienceKey ?? '?'})`);
      }
      // When an imageUrl is set, rightsStatus must be one of the valid
      // values (not null).
      if (!VALID_RIGHTS_STATUSES.has(r.rightsStatus)) {
        c8.fail(`Record has imageUrl but rightsStatus is missing/invalid: ${JSON.stringify(r.rightsStatus)} (key=${r.scienceKey ?? '?'})`);
      }
    }
    if (r.imageCredit != null) {
      if (typeof r.imageCredit !== 'string' || r.imageCredit.trim() === '') {
        c8.fail(`Record has non-string/empty imageCredit: ${JSON.stringify(r.imageCredit)} (key=${r.scienceKey ?? '?'})`);
      }
    }
    if (r.rightsStatus != null && !VALID_RIGHTS_STATUSES.has(r.rightsStatus)) {
      c8.fail(`Record has unrecognized rightsStatus: ${JSON.stringify(r.rightsStatus)} (key=${r.scienceKey ?? '?'})`);
    }
    // rightsStatus "unclear" must imply imageCredit=null. This is the
    // key check that prevents us from auto-selecting images with
    // inferred-from-hostname credits.
    if (r.rightsStatus === 'unclear' && r.imageCredit != null) {
      c8.fail(
        `Record has rightsStatus="unclear" but imageCredit is non-null (credit may have been inferred from hostname): imageCredit=${JSON.stringify(r.imageCredit)} (key=${r.scienceKey ?? '?'})`,
      );
    }
  }
  checks.push(c8);

  // Check 15 — every record carries a storyType field (Phase 9A.1)
  const c15 = new CheckResult(15, `${label}: every record carries a valid storyType`);
  for (const r of records) {
    if (!isNonEmptyString(r.storyType)) {
      c15.fail(`Record missing storyType (key=${r.scienceKey ?? '?'})`);
    } else if (!VALID_STORY_TYPES.has(r.storyType)) {
      c15.fail(`Record has unrecognized storyType: ${JSON.stringify(r.storyType)} (key=${r.scienceKey ?? '?'})`);
    }
  }
  checks.push(c15);

  return checks;
}

/**
 * Story-records-specific checks.
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
    if (!isFiniteNumber(s.storyScore)) {
      c11.fail(`Story storyScore is not a finite number: ${JSON.stringify(s.storyScore)} (key=${s.scienceStoryKey ?? '?'})`);
    } else if (s.storyScore < 0 || s.storyScore > 100) {
      c11.fail(`Story storyScore is out of range [0,100]: ${s.storyScore} (key=${s.scienceStoryKey ?? '?'})`);
    }
  }
  checks.push(c11);

  // Check 9 — publishEligible items have non-empty selectedReason
  const c9 = new CheckResult(9, 'stories: publishEligible items have eligibility reasons (selectedReason non-empty)');
  for (const s of stories) {
    if (s.publishEligible === true) {
      if (!isNonEmptyString(s.selectedReason)) {
        c9.fail(`Story is publishEligible but selectedReason is empty/missing (key=${s.scienceStoryKey ?? '?'})`);
      }
    }
  }
  checks.push(c9);

  // Check 16 — APOD items must NOT be publishEligible AND must be
  // storyType="evergreen". An APOD item is identified by its title
  // starting with "APOD:" or containing "Astronomy Picture of the Day".
  const c16 = new CheckResult(16, 'stories: APOD items are storyType=evergreen and publishEligible=false');
  for (const s of stories) {
    const title = String(s.title || '');
    const isApod = /^apod[:\s]/i.test(title) || /astronomy\s+picture\s+of\s+the\s+day/i.test(title);
    if (isApod) {
      if (s.storyType !== 'evergreen') {
        c16.fail(`APOD story has storyType=${JSON.stringify(s.storyType)} (expected "evergreen") (key=${s.scienceStoryKey ?? '?'})`);
      }
      if (s.publishEligible !== false) {
        c16.fail(`APOD story is publishEligible=true (expected false) (key=${s.scienceStoryKey ?? '?'})`);
      }
    }
  }
  checks.push(c16);

  // Checks 17-21 — story types that must NEVER be publishEligible.
  const neverPublishChecks = [
    [17, 'space-policy'],
    [18, 'media-advisory'],
    [19, 'education'],
    [20, 'administrative'],
    [21, 'evergreen'],
  ];
  for (const [id, type] of neverPublishChecks) {
    const c = new CheckResult(id, `stories: ${type} story is publishEligible=false`);
    for (const s of stories) {
      if (s.storyType === type && s.publishEligible !== false) {
        c.fail(`${type} story is publishEligible=${JSON.stringify(s.publishEligible)} (expected false) (key=${s.scienceStoryKey ?? '?'}, title="${s.title ?? '?'}")`);
      }
    }
    checks.push(c);
  }

  // Check 22 — Image with rightsStatus "unclear" or "unverified" must
  // NOT be auto-selected as a story's hero image.
  const c22 = new CheckResult(22, 'stories: hero image (when set) has verified rightsStatus');
  for (const s of stories) {
    if (s.imageUrl != null) {
      // imageUrl is set — rightsStatus must be verified-agency or
      // verified-third-party.
      if (s.rightsStatus !== 'verified-agency' && s.rightsStatus !== 'verified-third-party') {
        c22.fail(
          `Story auto-selected an image with non-verified rightsStatus=${JSON.stringify(s.rightsStatus)} (key=${s.scienceStoryKey ?? '?'}, title="${s.title ?? '?'}")`,
        );
      }
    }
  }
  checks.push(c22);

  // Check 23 — Image credit must NOT be inferred only from hostname.
  // When a story auto-selects an image, imageCredit must be either
  // null (no credit text) OR a non-empty extracted string. The
  // "verified-agency" status is only set when the credit text contains
  // "NASA" or "NOAA", so a story with rightsStatus="verified-agency"
  // MUST have a non-empty imageCredit (we can't have inferred it from
  // the hostname alone).
  const c23 = new CheckResult(23, 'stories: image credit not inferred from hostname (verified-agency implies non-empty credit)');
  for (const s of stories) {
    if (s.imageUrl != null && s.rightsStatus === 'verified-agency') {
      if (!isNonEmptyString(s.imageCredit)) {
        c23.fail(
          `Story has rightsStatus="verified-agency" but imageCredit is empty (credit may have been inferred from hostname) (key=${s.scienceStoryKey ?? '?'})`,
        );
      }
    }
  }
  checks.push(c23);

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

/**
 * Run the Phase 9A.1 provenance-metadata checks against a fetcher
 * output document (checks 12, 13, 14).
 */
function runProvenanceChecks(doc, label) {
  const checks = [];

  // Check 12 — provenance metadata fields present.
  const c12 = new CheckResult(12, `${label}: provenance metadata fields present (sourceAvailable, httpStatus, fetchError, recordCount, fetchedAt)`);
  if (!isBoolean(doc.sourceAvailable)) {
    c12.fail(`${label}: sourceAvailable is not a boolean: ${JSON.stringify(doc.sourceAvailable)}`);
  }
  if (!isFiniteNumber(doc.httpStatus)) {
    c12.fail(`${label}: httpStatus is not a finite number: ${JSON.stringify(doc.httpStatus)}`);
  }
  if (doc.fetchError != null && !isNonEmptyString(doc.fetchError)) {
    c12.fail(`${label}: fetchError is neither null nor a non-empty string: ${JSON.stringify(doc.fetchError)}`);
  }
  if (!isFiniteNumber(doc.recordCount)) {
    c12.fail(`${label}: recordCount is not a finite number: ${JSON.stringify(doc.recordCount)}`);
  }
  if (!isValidIsoDate(doc.fetchedAt)) {
    c12.fail(`${label}: fetchedAt is not a valid ISO-8601 string: ${JSON.stringify(doc.fetchedAt)}`);
  }
  checks.push(c12);

  // Check 13 — failed fetch must NOT look like a successful zero-result
  // fetch. When sourceAvailable=false, fetchError must be non-empty
  // AND recordCount must be 0.
  const c13 = new CheckResult(13, `${label}: failed fetch (sourceAvailable=false) carries fetchError and zero records`);
  if (doc.sourceAvailable === false) {
    if (!isNonEmptyString(doc.fetchError)) {
      c13.fail(`${label}: sourceAvailable=false but fetchError is empty (would look like a successful zero-result fetch)`);
    }
    if (doc.recordCount !== 0) {
      c13.fail(`${label}: sourceAvailable=false but recordCount=${doc.recordCount} (must be 0)`);
    }
  }
  checks.push(c13);

  // Check 14 — when sourceAvailable=true, httpStatus must be 200.
  const c14 = new CheckResult(14, `${label}: successful fetch (sourceAvailable=true) has httpStatus=200`);
  if (doc.sourceAvailable === true && doc.httpStatus !== 200) {
    c14.fail(`${label}: sourceAvailable=true but httpStatus=${doc.httpStatus} (expected 200)`);
  }
  checks.push(c14);

  return checks;
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
    console.log(`  NASA:       ${records.length} records (sourceAvailable=${nasaRes.doc.sourceAvailable}, httpStatus=${nasaRes.doc.httpStatus})`);
    allChecks.push(...runRecordChecks(records, 'nasa-news'));
    allChecks.push(...runProvenanceChecks(nasaRes.doc, 'nasa-news'));
  } else {
    console.log(`  NASA:       [missing] ${INPUT_FILES.nasa}`);
    const c = new CheckResult(0, 'nasa-news file exists');
    c.fail(`nasa-news.json is missing or unreadable (${nasaRes.reason})`);
    allChecks.push(c);
  }

  // --- JPL fetched records -----------------------------------------------
  if (jplRes.ok) {
    const records = Array.isArray(jplRes.doc.records) ? jplRes.doc.records : [];
    console.log(`  JPL:        ${records.length} records (sourceAvailable=${jplRes.doc.sourceAvailable}, httpStatus=${jplRes.doc.httpStatus})`);
    allChecks.push(...runRecordChecks(records, 'jpl-news'));
    allChecks.push(...runProvenanceChecks(jplRes.doc, 'jpl-news'));
  } else {
    console.log(`  JPL:        [missing] ${INPUT_FILES.jpl}`);
    const c = new CheckResult(0, 'jpl-news file exists');
    c.fail(`jpl-news.json is missing or unreadable (${jplRes.reason})`);
    allChecks.push(c);
  }

  // --- SWPC fetched records ----------------------------------------------
  if (swpcRes.ok) {
    const records = Array.isArray(swpcRes.doc.records) ? swpcRes.doc.records : [];
    console.log(`  SWPC:       ${records.length} records (sourceAvailable=${swpcRes.doc.sourceAvailable}, httpStatus=${swpcRes.doc.httpStatus})`);
    allChecks.push(...runRecordChecks(records, 'swpc-events'));
    allChecks.push(...runProvenanceChecks(swpcRes.doc, 'swpc-events'));
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
