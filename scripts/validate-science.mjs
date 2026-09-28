/**
 * US News Engine — Science data validation (Phase 9A.2 hardened).
 *
 * Validates the science snapshots and story records produced by Phase
 * 9A.2:
 *   - data/science/nasa-news.json
 *   - data/science/jpl-news.json
 *   - data/science/swpc-events.json
 *   - data/science/science-news-candidates.json
 *   - data/science/science-source-registry.json   (Phase 9A.2 new)
 *   - data/science/science-story-records.json
 *
 * Phase 9A.2 adds these new checks on top of the Phase 9A.1 checks:
 *
 *   24. Archive story (>30 days old) must NOT be publishEligible.
 *   25. technical-guidance story must NOT be publishEligible.
 *   26. mission-preparation story must NOT be publishEligible.
 *   27. PublishEligible story must have a non-null publishedAtSource
 *       (a story without a source publication date cannot be freshness-
 *       gated and therefore cannot be publishEligible).
 *   28. current/recent/archive age calculation must be well-formed:
 *       every candidate carries a `freshnessStatus` of 'current',
 *       'recent', 'archive', or null (when publishedAtSource is
 *       missing). When `freshnessStatus` is non-null, `sourceAgeDays`
 *       must be a non-negative finite number; `current` < 14, `recent`
 *       in [14, 30], `archive` > 30.
 *   29. Third-party image must NOT be marked verified-agency. (The
 *       Phase 9A.2 rightsStatus vocabulary distinguishes `verified-
 *       agency`, `mixed-agency`, `third-party`, `unclear`, and
 *       `unverified`. A `third-party` credit — named individual,
 *       commercial entity, or non-approved org — must not be labelled
 *       `verified-agency` even when an approved agency is also
 *       mentioned.)
 *   30. Bootstrap historical item treated as new: a story whose source
 *       keys are all `bootstrapSeen=true` in the source registry must
 *       NOT have `storyStatus='new'` (it must be `bootstrap`,
 *       `updated`, or `unchanged`). This is the bootstrap-safety net
 *       that prevents mass backfill on first run.
 *
 * Phase 9A.1 checks retained (12-23) with vocabulary updates:
 *   12. Each fetcher output carries sourceAvailable, httpStatus,
 *       fetchError, recordCount, fetchedAt.
 *   13. Failed source fetch must NOT look like a successful zero-result
 *       fetch.
 *   14. When sourceAvailable=true, httpStatus must be 200.
 *   15. Every NASA/JPL record carries a storyType from the canonical
 *       Phase 9A.2 set (which now includes `technical-guidance`,
 *       `mission-preparation`, `mission-result`).
 *   16. APOD items must be storyType=evergreen AND publishEligible=false.
 *   17. space-policy story must NOT be publishEligible.
 *   18. media-advisory story must NOT be publishEligible.
 *   19. education story must NOT be publishEligible.
 *   20. administrative story must NOT be publishEligible.
 *   21. evergreen story must NOT be publishEligible.
 *   22. Hero image (when set) must have rightsStatus `verified-agency`
 *       or `mixed-agency` (Phase 9A.2 vocabulary: `third-party`,
 *       `unclear`, `unverified` are NOT auto-selectable).
 *   23. Image credit must NOT be inferred from hostname: when an image
 *       is auto-selected with `verified-agency` or `mixed-agency`
 *       rightsStatus, `imageCredit` must be non-empty.
 *
 * Existing Phase 9A checks retained (1-9, 11):
 *   1.  Every record has a scienceKey
 *   2.  Every record has a sourceUrl (absolute http/https)
 *   3.  No duplicate scienceKeys (per source file)
 *   4.  No duplicate scienceStoryKeys (story records)
 *   5.  Source dates are valid (publishedAtSource is parseable ISO or null)
 *   6.  Source is one of NASA, JPL, NOAA-SWPC
 *   7.  SWPC severity is a recognized NOAA scale value (R1-5, S1-5, G1-5)
 *       or null for non-SWPC records
 *   8.  Image credit/URL sanity (Phase 9A.1 hardened with the updated
 *       rightsStatus vocabulary)
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
  registry: join(PROJECT_DIR, 'data', 'science', 'science-source-registry.json'),
  stories: join(PROJECT_DIR, 'data', 'science', 'science-story-records.json'),
};

const VALID_SOURCES = new Set(['NASA', 'JPL', 'NOAA-SWPC']);
const RECOGNIZED_SEVERITY = new Set([
  'R1', 'R2', 'R3', 'R4', 'R5',
  'S1', 'S2', 'S3', 'S4', 'S5',
  'G1', 'G2', 'G3', 'G4', 'G5',
]);

// Valid storyType values (Phase 9A.2 — three new types added:
// technical-guidance, mission-preparation, mission-result).
const VALID_STORY_TYPES = new Set([
  'mission-milestone', 'launch', 'landing', 'discovery',
  'astronomy', 'earth-science', 'technology', 'crew-mission',
  'space-weather', 'space-policy', 'administrative', 'education',
  'media-advisory', 'evergreen',
  'technical-guidance', 'mission-preparation', 'mission-result',
]);

// Story types that must NEVER be publishEligible (Phase 9A.2 adds
// technical-guidance and mission-preparation).
const NEVER_PUBLISH_TYPES = new Set([
  'space-policy', 'administrative', 'education',
  'media-advisory', 'evergreen',
  'technical-guidance', 'mission-preparation',
]);

// Valid rightsStatus values (Phase 9A.2 vocabulary).
// `verified-third-party` is renamed to `third-party`; `mixed-agency`
// is new.
const VALID_RIGHTS_STATUSES = new Set([
  'verified-agency', 'mixed-agency', 'third-party', 'unclear', 'unverified',
]);

// Auto-selectable rightsStatuses for hero images (Phase 9A.2).
const AUTO_SELECTABLE_RIGHTS = new Set(['verified-agency', 'mixed-agency']);

// Freshness thresholds (must match the filter).
const FRESHNESS_CURRENT_MAX_DAYS = 14;
const FRESHNESS_RECENT_MAX_DAYS = 30;
const FRESHNESS_VALID_STATUSES = new Set(['current', 'recent', 'archive']);

// Day in milliseconds.
const DAY_MS = 24 * 60 * 60 * 1000;

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

  // Check 8 — image credit/URL sanity (Phase 9A.2 hardened)
  //   - imageUrl, when present, must be an absolute http(s) URL.
  //   - imageCredit, when present, must be a non-empty string.
  //   - rightsStatus, when present, must be one of VALID_RIGHTS_STATUSES
  //     (Phase 9A.2: verified-agency / mixed-agency / third-party /
  //     unclear / unverified).
  //   - When imageUrl is present, rightsStatus must NOT be null.
  //   - When rightsStatus is "unclear", imageCredit must be null
  //     (unclear means no credit text was extracted).
  //   - When rightsStatus is "unverified", imageCredit MAY be set
  //     (extracted text from a non-agency credit) but the image is on
  //     an external domain; the validator does NOT fail this case here.
  //   - imageCredit must NOT be just the source name when rightsStatus
  //     is "unclear" — that would mean we inferred the credit from the
  //     hostname, which Phase 9A.1 explicitly forbids.
  const c8 = new CheckResult(8, `${label}: image credit/URL sanity (Phase 9A.2 hardened)`);
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

  // Check 15 — every record carries a storyType field (Phase 9A.2)
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
 * Phase 9A.2 freshness well-formedness check (check 28). Runs against
 * the candidates list. Verifies that:
 *   - freshnessStatus is null, 'current', 'recent', or 'archive'
 *   - when freshnessStatus is null, sourceAgeDays is null
 *   - when freshnessStatus is non-null, sourceAgeDays is a finite
 *     non-negative number
 *   - current < 14, recent in [14, 30], archive > 30
 */
function runFreshnessWellFormedCheck(candidates) {
  const c28 = new CheckResult(28, 'candidates: freshnessStatus / sourceAgeDays well-formed');
  for (const r of candidates) {
    const status = r.freshnessStatus;
    const age = r.sourceAgeDays;
    if (status == null) {
      if (age != null) {
        c28.fail(
          `Candidate has freshnessStatus=null but sourceAgeDays=${JSON.stringify(age)} (key=${r.scienceKey ?? '?'})`,
        );
      }
      // If publishedAtSource is also missing, that's consistent.
      // If publishedAtSource is present but freshnessStatus is null,
      // that's a calculation bug.
      if (isNonEmptyString(r.publishedAtSource)) {
        const d = new Date(r.publishedAtSource);
        if (!Number.isNaN(d.getTime())) {
          // Future date is allowed to produce null freshness, but a
          // past date must produce a non-null freshness.
          if (d.getTime() <= Date.now()) {
            c28.fail(
              `Candidate has a valid past publishedAtSource but freshnessStatus=null (calculation bug) (key=${r.scienceKey ?? '?'}, publishedAtSource=${r.publishedAtSource})`,
            );
          }
        }
      }
      continue;
    }
    if (!FRESHNESS_VALID_STATUSES.has(status)) {
      c28.fail(
        `Candidate has invalid freshnessStatus=${JSON.stringify(status)} (key=${r.scienceKey ?? '?'})`,
      );
      continue;
    }
    if (!isFiniteNumber(age) || age < 0) {
      c28.fail(
        `Candidate has freshnessStatus=${status} but sourceAgeDays is invalid: ${JSON.stringify(age)} (key=${r.scienceKey ?? '?'})`,
      );
      continue;
    }
    if (status === 'current' && age >= FRESHNESS_CURRENT_MAX_DAYS) {
      c28.fail(
        `Candidate has freshnessStatus=current but sourceAgeDays=${age.toFixed(2)} >= ${FRESHNESS_CURRENT_MAX_DAYS} (key=${r.scienceKey ?? '?'})`,
      );
    }
    if (status === 'recent' && (age < FRESHNESS_CURRENT_MAX_DAYS || age > FRESHNESS_RECENT_MAX_DAYS)) {
      c28.fail(
        `Candidate has freshnessStatus=recent but sourceAgeDays=${age.toFixed(2)} not in [${FRESHNESS_CURRENT_MAX_DAYS}, ${FRESHNESS_RECENT_MAX_DAYS}] (key=${r.scienceKey ?? '?'})`,
      );
    }
    if (status === 'archive' && age <= FRESHNESS_RECENT_MAX_DAYS) {
      c28.fail(
        `Candidate has freshnessStatus=archive but sourceAgeDays=${age.toFixed(2)} <= ${FRESHNESS_RECENT_MAX_DAYS} (key=${r.scienceKey ?? '?'})`,
      );
    }
  }
  return c28;
}

/**
 * Phase 9A.2 candidate-level archive + publishEligible check (part of
 * check 24 — runs against candidates as well as stories).
 */
function runCandidateArchiveEligibilityCheck(candidates) {
  const c = new CheckResult(24, 'candidates: archive (>30 days) candidates are publishEligible=false');
  for (const r of candidates) {
    if (r.freshnessStatus === 'archive' && r.publishEligible === true) {
      c.fail(
        `Candidate is archive (${r.sourceAgeDays != null ? r.sourceAgeDays.toFixed(1) : '?'} days old) but publishEligible=true (key=${r.scienceKey ?? '?'})`,
      );
    }
    if (!r.freshnessStatus && r.publishEligible === true) {
      c.fail(
        `Candidate has missing freshnessStatus but publishEligible=true (key=${r.scienceKey ?? '?'})`,
      );
    }
  }
  return c;
}

/**
 * Phase 9A.2 candidate-level technical-guidance / mission-preparation
 * publish-eligibility check (part of checks 25 and 26 — runs against
 * candidates as well as stories).
 */
function runCandidateTypeEligibilityCheck(candidates) {
  const checks = [];
  for (const type of ['technical-guidance', 'mission-preparation']) {
    const c = new CheckResult(
      type === 'technical-guidance' ? 25 : 26,
      `candidates: ${type} candidate is publishEligible=false`,
    );
    for (const r of candidates) {
      if (r.storyType === type && r.publishEligible !== false) {
        c.fail(
          `${type} candidate is publishEligible=${JSON.stringify(r.publishEligible)} (expected false) (key=${r.scienceKey ?? '?'})`,
        );
      }
    }
    checks.push(c);
  }
  return checks;
}

/**
 * Phase 9A.2 candidate-level publish-eligible-must-have-date check
 * (part of check 27 — runs against candidates as well as stories).
 */
function runCandidateEligibilityDateCheck(candidates) {
  const c = new CheckResult(27, 'candidates: publishEligible candidate has non-null publishedAtSource');
  for (const r of candidates) {
    if (r.publishEligible === true) {
      if (!isNonEmptyString(r.publishedAtSource)) {
        c.fail(
          `Candidate is publishEligible but publishedAtSource is empty/missing (key=${r.scienceKey ?? '?'})`,
        );
      }
      if (!FRESHNESS_VALID_STATUSES.has(r.freshnessStatus)) {
        c.fail(
          `Candidate is publishEligible but freshnessStatus is missing/invalid: ${JSON.stringify(r.freshnessStatus)} (key=${r.scienceKey ?? '?'})`,
        );
      }
    }
  }
  return c;
}

/**
 * Phase 9A.2 third-party / verified-agency contradiction check
 * (check 29). Runs against candidates + story records. Detects when
 * an image whose credit contains a named individual or commercial
 * entity is mis-labelled `verified-agency` or `mixed-agency`.
 *
 * We re-run the same `hasThirdPartyIndicator` heuristic the fetcher
 * uses (named-individual regex + commercial/non-approved org list)
 * against each candidate's imageCredit. If a third-party indicator is
 * present, the rightsStatus must be `third-party` (NOT `verified-
 * agency` or `mixed-agency`).
 *
 * NOTE: This function is duplicated from fetch-nasa-news.mjs. We
 * intentionally don't import from the fetcher (the fetcher is a
 * standalone CLI script). If the heuristic diverges, this check
 * becomes a no-op rather than a false positive.
 */
const VALIDATOR_NON_AGENCY_ENTITY_RE =
  /\b(?:SpaceX|Blue\s+Canyon\s+Technologies|Blue\s+Canyon|Lockheed\s+Martin|Lockheed|Boeing|Northrop\s+Grumman|Northrop|U\.S\.\s+Department\s+of\s+State|U\.S\.\s+Space\s+Force|Space\s+Dynamics\s+Laboratory|Maxar|Airbus|Thales|Astrium)\b/i;

const VALIDATOR_INDIVIDUAL_NAME_RE =
  /\b[A-Z][\p{L}]+\s+[A-Z][\p{L}]+\b/u;

const VALIDATOR_INITIAL_NAME_RE =
  /\b[A-Z]\.\s*[A-Z][\p{L}]+\b/u;

const VALIDATOR_ORG_NAME_MASK_RE =
  /\b(?:Space\s+Force|Canyon\s+Technologies|Department\s+of\s+State|Dynamics\s+Laboratory|Scientific\s+Visualization\s+Studio|Space\s+Science\s+Institute|Southwest\s+Research\s+Institute|Malin\s+Space\s+Science\s+Systems|Jet\s+Propulsion\s+Laboratory|Space\s+Telescope\s+Science\s+Institute|California\s+Institute\s+of\s+Technology|Arizona\s+State\s+University|Johns\s+Hopkins\s+University|Massachusetts\s+Institute\s+of\s+Technology|United\s+States|U\.S\.\s+Government|Canadian\s+Space\s+Agency|European\s+Space\s+Agency)\b/gi;

function validatorHasThirdPartyIndicator(creditText) {
  if (!creditText || typeof creditText !== 'string') return false;
  if (VALIDATOR_NON_AGENCY_ENTITY_RE.test(creditText)) return true;
  const masked = creditText.replace(VALIDATOR_ORG_NAME_MASK_RE, ' ');
  if (VALIDATOR_INDIVIDUAL_NAME_RE.test(masked)) return true;
  if (VALIDATOR_INITIAL_NAME_RE.test(masked)) return true;
  return false;
}

function runThirdPartyContradictionCheck(records, label) {
  const c29 = new CheckResult(29, `${label}: third-party credit not marked verified-agency/mixed-agency`);
  for (const r of records) {
    if (!r.imageCredit || typeof r.imageCredit !== 'string') continue;
    if (!r.rightsStatus) continue;
    if (r.rightsStatus !== 'verified-agency' && r.rightsStatus !== 'mixed-agency') continue;
    if (validatorHasThirdPartyIndicator(r.imageCredit)) {
      c29.fail(
        `${label} record has rightsStatus=${r.rightsStatus} but imageCredit contains a third-party indicator: imageCredit=${JSON.stringify(r.imageCredit)} (key=${r.scienceKey ?? r.scienceStoryKey ?? '?'})`,
      );
    }
  }
  return c29;
}

/**
 * Phase 9A.2 bootstrap-safety check (check 30). Loads the source
 * registry and verifies that no story with storyStatus='new' has all
 * its source keys marked bootstrapSeen=true in the registry.
 *
 * (build-science-stories.mjs sets storyStatus='bootstrap' for such
 * stories on first sight, so a story that is 'new' should NOT have
 * bootstrapSeen=true sources. If it does, the pipeline is treating
 * historical items as new — a mass-backfill bug.)
 */
function runBootstrapSafetyCheck(stories, registryDoc) {
  const c30 = new CheckResult(30, 'stories: bootstrap historical item not treated as new');
  if (!registryDoc || !Array.isArray(registryDoc.sources)) {
    // No registry → check is a no-op (the build-science-stories
    // script will have warned about the missing registry).
    c30.warn('Source registry not loaded — bootstrap-safety check skipped.');
    return c30;
  }
  const bootstrapKeys = new Set();
  for (const s of registryDoc.sources) {
    if (s && s.bootstrapSeen === true && typeof s.scienceKey === 'string') {
      bootstrapKeys.add(s.scienceKey);
    }
  }
  for (const s of stories) {
    if (s.storyStatus !== 'new') continue;
    const sourceKeys = Array.isArray(s.allSourceKeys) ? s.allSourceKeys : [];
    if (sourceKeys.length === 0) continue;
    const allBootstrap = sourceKeys.every((k) => bootstrapKeys.has(k));
    if (allBootstrap) {
      c30.fail(
        `Story is storyStatus="new" but all its source keys are bootstrapSeen=true in the registry (would cause mass backfill): storyKey=${s.scienceStoryKey ?? '?'}, sourceKeys=${JSON.stringify(sourceKeys)}, title="${s.title ?? '?'}"`,
      );
    }
  }
  return c30;
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

  // Checks 17-21, 25, 26 — story types that must NEVER be publishEligible.
  // Phase 9A.2 adds 25 (technical-guidance) and 26 (mission-preparation).
  const neverPublishChecks = [
    [17, 'space-policy'],
    [18, 'media-advisory'],
    [19, 'education'],
    [20, 'administrative'],
    [21, 'evergreen'],
    [25, 'technical-guidance'],
    [26, 'mission-preparation'],
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

  // Check 22 — Image auto-selection respects Phase 9A.2 rights
  // vocabulary. Only `verified-agency` and `mixed-agency` images may
  // be auto-selected. `third-party`, `unclear`, `unverified` must
  // NOT be auto-selected (story.imageUrl must be null).
  const c22 = new CheckResult(22, 'stories: hero image (when set) has rightsStatus verified-agency or mixed-agency');
  for (const s of stories) {
    if (s.imageUrl != null) {
      if (!AUTO_SELECTABLE_RIGHTS.has(s.rightsStatus)) {
        c22.fail(
          `Story auto-selected an image with non-auto-selectable rightsStatus=${JSON.stringify(s.rightsStatus)} (key=${s.scienceStoryKey ?? '?'}, title="${s.title ?? '?'}")`,
        );
      }
    }
  }
  checks.push(c22);

  // Check 23 — Image credit must NOT be inferred only from hostname.
  // When a story auto-selects an image with `verified-agency` or
  // `mixed-agency` rightsStatus, imageCredit must be a non-empty
  // string (those rightsStatuses are only set when an approved agency
  // is explicitly credited).
  const c23 = new CheckResult(23, 'stories: image credit not inferred from hostname (verified-agency/mixed-agency implies non-empty credit)');
  for (const s of stories) {
    if (s.imageUrl != null && AUTO_SELECTABLE_RIGHTS.has(s.rightsStatus)) {
      if (!isNonEmptyString(s.imageCredit)) {
        c23.fail(
          `Story has rightsStatus=${JSON.stringify(s.rightsStatus)} but imageCredit is empty (credit may have been inferred from hostname) (key=${s.scienceStoryKey ?? '?'})`,
        );
      }
    }
  }
  checks.push(c23);

  // Check 24 — Archive story (>30 days old) must NOT be publishEligible.
  // Phase 9A.2 freshness gate.
  const c24 = new CheckResult(24, 'stories: archive (>30 days) stories are publishEligible=false');
  for (const s of stories) {
    if (s.freshnessStatus === 'archive' && s.publishEligible === true) {
      c24.fail(
        `Story is archive (${s.sourceAgeDays != null ? s.sourceAgeDays.toFixed(1) : '?'} days old) but publishEligible=true (key=${s.scienceStoryKey ?? '?'}, title="${s.title ?? '?'}")`,
      );
    }
  }
  checks.push(c24);

  // Check 27 — PublishEligible story must have a non-null
  // publishedAtSource. The freshness gate requires a source pub date
  // to compute freshness; a story without one cannot be publishEligible.
  const c27 = new CheckResult(27, 'stories: publishEligible story has non-null publishedAtSource');
  for (const s of stories) {
    if (s.publishEligible === true) {
      if (!isNonEmptyString(s.publishedAtSource)) {
        c27.fail(
          `Story is publishEligible but publishedAtSource is empty/missing (key=${s.scienceStoryKey ?? '?'}, title="${s.title ?? '?'}")`,
        );
      }
      // Also: publishEligible implies a non-null freshnessStatus.
      if (!FRESHNESS_VALID_STATUSES.has(s.freshnessStatus)) {
        c27.fail(
          `Story is publishEligible but freshnessStatus is missing/invalid: ${JSON.stringify(s.freshnessStatus)} (key=${s.scienceStoryKey ?? '?'})`,
        );
      }
    }
  }
  checks.push(c27);

  // Check 29 — Third-party image must NOT be marked verified-agency.
  // (Phase 9A.2: a named individual / commercial entity is always
  // `third-party`, even when an approved agency is also credited.)
  // This check operates on the candidates' image rights assignments
  // (the story record's rightsStatus is denormalized from a single
  // chosen image, so a story with rightsStatus=verified-agency means
  // the chosen image's credit was just an approved agency — not a
  // named individual). We can't fully re-derive rights from the story
  // record alone; instead, we check the candidates' imageCredit +
  // rightsStatus pairs: when a candidate's imageCredit contains a
  // named individual / commercial entity, its rightsStatus must NOT
  // be verified-agency.
  // This check is performed in runCandidateRightsCheck (see main()).
  // Here we keep a stub for the check-ID documentation.
  const c29 = new CheckResult(29, 'stories: third-party image not marked verified-agency/mixed-agency (checked at candidate level)');
  checks.push(c29);

  // Check 30 — Bootstrap historical item treated as new.
  // A story whose source keys are all bootstrapSeen=true in the
  // source registry must NOT have storyStatus='new'. (The
  // build-science-stories.mjs sets storyStatus='bootstrap' for such
  // stories on first sight; if we see storyStatus='new' with
  // bootstrapSeen=true, that's a bug — the pipeline would auto-
  // publish a historical item as new.)
  // This check is performed in runBootstrapSafetyCheck (see main()).
  // Here we keep a stub for the check-ID documentation.
  const c30 = new CheckResult(30, 'stories: bootstrap historical item not treated as new (checked via registry)');
  checks.push(c30);

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
    // Phase 9A.2 freshness + classification + rights checks at the
    // candidate level.
    allChecks.push(runFreshnessWellFormedCheck(candidates));
    allChecks.push(runCandidateArchiveEligibilityCheck(candidates));
    allChecks.push(...runCandidateTypeEligibilityCheck(candidates));
    allChecks.push(runCandidateEligibilityDateCheck(candidates));
    allChecks.push(runThirdPartyContradictionCheck(candidates, 'candidates'));
  } else {
    console.log(`  Candidates: [missing] ${INPUT_FILES.candidates}`);
    const c = new CheckResult(0, 'candidates file exists');
    c.fail(`science-news-candidates.json is missing or unreadable (${candidatesRes.reason})`);
    allChecks.push(c);
  }

  // --- Source registry (Phase 9A.2) -------------------------------------
  const registryRes = await loadJsonOptional(INPUT_FILES.registry);
  let registryDoc = null;
  if (registryRes.ok) {
    registryDoc = registryRes.doc;
    const regSources = Array.isArray(registryRes.doc.sources) ? registryRes.doc.sources : [];
    const bootstrapCount = regSources.filter((s) => s && s.bootstrapSeen === true).length;
    console.log(
      `  Registry:  ${regSources.length} sources (${bootstrapCount} bootstrap)`,
    );
  } else {
    console.log(`  Registry:  [missing] ${INPUT_FILES.registry}`);
    console.log('             Run `npm run registry:science` to enable bootstrap-safety check.');
  }

  // --- Stories -----------------------------------------------------------
  let stories = [];
  if (storiesRes.ok) {
    stories = Array.isArray(storiesRes.doc.stories) ? storiesRes.doc.stories : [];
    console.log(`  Stories:    ${stories.length} stories`);
    const storyChecks = runStoryChecks(stories);
    allChecks.push(...storyChecks);
    // Replace the stub c29 and c30 with the real checks (they were
    // pushed as stubs by runStoryChecks for documentation; we now
    // run the real implementations against the candidates/stories
    // and the registry).
    const realC29 = runThirdPartyContradictionCheck(stories, 'stories');
    const realC30 = runBootstrapSafetyCheck(stories, registryDoc);
    // Find and replace the stubs by ID.
    for (let i = 0; i < allChecks.length; i++) {
      if (allChecks[i].id === 29 && allChecks[i].errors.length === 0 && allChecks[i].label.includes('checked at candidate level')) {
        allChecks[i] = realC29;
      } else if (allChecks[i].id === 30 && allChecks[i].label.includes('checked via registry')) {
        allChecks[i] = realC30;
      }
    }
    // Also run the candidate-level third-party contradiction check
    // (already done above) and the candidate-level freshness check
    // (already done above) — they're pushed separately.
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
