/**
 * US News Engine — Recalls data validation (Phase 7A + 7B.1).
 *
 * Validates the recall snapshots and story records produced by Phase 7A,
 * plus the clustered story records produced by Phase 7B.1.
 *
 * Existing checks (1-9) — operate on recall snapshots + story records:
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
 * New Phase 7B.1 checks (10-24) — operate on recall-story-clusters.json:
 *   10. No duplicate recallStoryKey (every story key must be unique)
 *   11. No empty key components (story keys must not contain empty segments)
 *   12. Every story has sourceRecallIds (array must be non-empty)
 *   13. No cluster with unrelated firms (same recallingFirm/manufacturer)
 *   14. No unsupported normalized hazard (evidence references real source field)
 *   15. Headline hazard supported by evidence (hazardNormalized in evidence text)
 *   16. No unsupported injury claim (injuries must come from source data)
 *   17. No unsupported death claim (deaths must come from source data)
 *   18. No FDA external/unverified photo (FDA stories have no imageUrls)
 *   19. CPSC photo has source metadata (imageUrls from cpsc.gov)
 *   20. reportDate present when expected (FDA stories have fdaReportDates)
 *   21. No recall initiation/report date confusion (dates must not be swapped)
 *   22. No empty source URLs (all sourceUrls must be non-empty strings)
 *   23. No duplicate article slug (skipped if slugs not generated yet)
 *   24. No malformed source IDs (sourceRecallIds must be non-empty strings)
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
const CLUSTERS_FILE = join(PROJECT_DIR, 'data', 'recalls', 'recall-story-clusters.json');

const VALID_SOURCES = new Set(['CPSC', 'FDA']);

// ---------------------------------------------------------------------------
// Hazard keyword table — used by check 15 (headline hazard supported by
// evidence). Maps each normalized hazard label to the keyword(s) that must
// appear (case-insensitive) in the hazardEvidence text for the label to be
// considered source-backed. Keep in sync with scripts/cluster-recall-stories.mjs
// extractHazard / normalizeCpscHazard / normalizeFdaHazard.
// ---------------------------------------------------------------------------

const HAZARD_KEYWORDS = {
  'Fire Hazard': ['fire'],
  'Burn Hazard': ['burn'],
  'Choking Hazard': ['choking'],
  'Suffocation Hazard': ['suffocation'],
  'Strangulation Hazard': ['strangulation'],
  'Laceration Hazard': ['laceration'],
  'Fall Hazard': ['fall'],
  'Tip-Over Hazard': ['tip-over', 'tipover', 'tip over'],
  'Electrocution Hazard': ['electrocution'],
  'Electric Shock Hazard': ['shock'],
  'Poisoning Hazard': ['poisoning'],
  'Explosion Hazard': ['explosion'],
  'Amputation Hazard': ['amputation'],
  'Entrapment Hazard': ['entrapment'],
  'Ingestion Hazard': ['ingestion'],
  'Salmonella Risk': ['salmonella'],
  'Listeria Risk': ['listeria'],
  'E. Coli Risk': ['e. coli', 'e.coli', 'escherichia'],
  'Botulism Risk': ['botulism', 'clostridium botulinum'],
  'Undeclared Allergen Risk': [
    'undeclared allergen', 'undeclared peanut', 'undeclared milk',
    'undeclared egg', 'undeclared soy', 'undeclared wheat',
    'undeclared tree nut',
  ],
  'Contamination Risk': [
    'contamination', 'foreign material', 'foreign object',
    'glass', 'metal fragment',
  ],
  'Lead Exposure Risk': ['lead'],
  'Potential Device Failure': ['fail', 'failure', 'malfunction'],
  'Potential Airway Obstruction': ['airway'],
};

// Valid hazardEvidence source-field prefixes (produced by extractHazard in
// cluster-recall-stories.mjs). If hazardEvidence doesn't start with one of
// these, the hazard claim is not source-backed.
const HAZARD_EVIDENCE_PREFIXES = [
  'CPSC Hazards[].Name:',
  'FDA reason_for_recall:',
  'CPSC Title:',
];

// CPSC image URL prefixes — CPSC recall photos are hosted on cpsc.gov.
const CPSC_IMAGE_URL_PREFIXES = [
  'https://cpsc.gov/',
  'http://cpsc.gov/',
  'https://www.cpsc.gov/',
  'http://www.cpsc.gov/',
];

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

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '';
}

// ---------------------------------------------------------------------------
// Loaders (existing — recall snapshots + story records)
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

// ---------------------------------------------------------------------------
// Loader (new — clusters file)
// ---------------------------------------------------------------------------

async function loadClusters() {
  const result = await loadJsonOptional(CLUSTERS_FILE);
  if (!result.ok) {
    return { ok: false, stories: [], reason: result.reason };
  }
  const stories = Array.isArray(result.doc.stories) ? result.doc.stories : [];
  return { ok: true, stories, doc: result.doc };
}

// ---------------------------------------------------------------------------
// Existing checks (1-9) — operate on recall snapshots + story records
// ---------------------------------------------------------------------------

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
// New Phase 7B.1 checks (10-24) — operate on recall-story-clusters.json
// ---------------------------------------------------------------------------

// Check 10: No duplicate recallStoryKey — every story key must be unique.
function checkUniqueStoryKeys(stories, result) {
  const seen = new Map(); // key -> count
  for (const s of stories) {
    const key = s?.recallStoryKey;
    if (key == null) {
      result.fail(`Story missing recallStoryKey in ${CLUSTERS_FILE}`);
      continue;
    }
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  for (const [key, count] of seen) {
    if (count > 1) {
      result.fail(`Duplicate recallStoryKey in clusters file: "${key}" (appears ${count} times)`);
    }
  }
}

// Check 11: No empty key components — story keys must not contain empty
// segments (e.g. `cpsc____2026-09-17____fire`). Segments are joined by `__`
// (double underscore). An empty segment means a `____` (4+ underscores) in
// the key, or a leading/trailing `__`.
function checkNoEmptyKeySegments(stories, result) {
  for (const s of stories) {
    const key = s?.recallStoryKey;
    if (typeof key !== 'string' || key === '') {
      // Already flagged by check 10 if null. Skip empty-string here to
      // avoid double-reporting.
      continue;
    }
    const segments = key.split('__');
    for (let i = 0; i < segments.length; i++) {
      if (segments[i] === '') {
        result.fail(
          `recallStoryKey has empty segment(s): "${key}" in ${CLUSTERS_FILE}`,
        );
        break; // one failure per story is enough
      }
    }
  }
}

// Check 12: Every story has sourceRecallIds — array must be non-empty.
function checkSourceRecallIdsPresent(stories, result) {
  for (const s of stories) {
    const ids = s?.sourceRecallIds;
    if (!Array.isArray(ids) || ids.length === 0) {
      result.fail(
        `Story missing or empty sourceRecallIds: "${s?.recallStoryKey ?? '?'}" in ${CLUSTERS_FILE}`,
      );
    }
  }
}

// Check 13: No cluster with unrelated firms — all records in a cluster must
// have the same recallingFirm/manufacturer (allow null). If two or more
// distinct non-null values appear in the same cluster, the cluster is
// incoherent (likely a clustering bug).
function checkNoUnrelatedFirmsInCluster(stories, result) {
  for (const s of stories) {
    const records = Array.isArray(s?.rawSourceData) ? s.rawSourceData : [];
    if (records.length < 2) continue; // single-record clusters are trivially coherent

    const firms = new Set();
    const manufacturers = new Set();
    for (const r of records) {
      if (!r || typeof r !== 'object') continue;
      if (r.recallingFirm != null && r.recallingFirm !== '') {
        firms.add(String(r.recallingFirm).trim().toLowerCase());
      }
      if (r.manufacturer != null && r.manufacturer !== '') {
        manufacturers.add(String(r.manufacturer).trim().toLowerCase());
      }
    }
    if (firms.size > 1) {
      result.fail(
        `Cluster "${s.recallStoryKey}" has multiple distinct recallingFirm values: ${[...firms].join(' | ')}`,
      );
    }
    if (manufacturers.size > 1) {
      result.fail(
        `Cluster "${s.recallStoryKey}" has multiple distinct manufacturer values: ${[...manufacturers].join(' | ')}`,
      );
    }
  }
}

// Check 14: No unsupported normalized hazard — if hazardNormalized is set,
// hazardEvidence must exist and reference a real source field. The valid
// source-field references are the prefixes produced by extractHazard in
// cluster-recall-stories.mjs (see HAZARD_EVIDENCE_PREFIXES).
function checkHazardEvidenceValid(stories, result) {
  for (const s of stories) {
    if (!s?.hazardNormalized) continue; // null/missing is OK
    const ev = s.hazardEvidence;
    if (!isNonEmptyString(ev)) {
      result.fail(
        `Story "${s.recallStoryKey}" has hazardNormalized="${s.hazardNormalized}" but no hazardEvidence`,
      );
      continue;
    }
    const startsWithKnownPrefix = HAZARD_EVIDENCE_PREFIXES.some((p) => ev.startsWith(p));
    if (!startsWithKnownPrefix) {
      result.fail(
        `Story "${s.recallStoryKey}" hazardEvidence does not reference a known source field: "${ev.slice(0, 80)}..."`,
      );
    }
  }
}

// Check 15: Headline hazard supported by evidence — if a story has
// hazardNormalized, it must be directly supported by the hazardEvidence
// text (the hazard keyword must appear in the evidence).
function checkHazardSupportedByEvidence(stories, result) {
  for (const s of stories) {
    if (!s?.hazardNormalized) continue;
    const ev = (s.hazardEvidence || '').toLowerCase();
    if (ev === '') {
      // Already flagged by check 14. Don't double-report.
      continue;
    }
    const label = s.hazardNormalized;
    const keywords = HAZARD_KEYWORDS[label];
    let supported;
    if (Array.isArray(keywords)) {
      supported = keywords.some((kw) => ev.includes(kw.toLowerCase()));
    } else {
      // Unknown label (e.g., raw CPSC hazard name passed through). Require
      // the label text itself to appear in the evidence (case-insensitive).
      supported = ev.includes(label.toLowerCase());
    }
    if (!supported) {
      result.fail(
        `Story "${s.recallStoryKey}" hazardNormalized="${label}" is not supported by hazardEvidence text: "${s.hazardEvidence.slice(0, 100)}..."`,
      );
    }
  }
}

// Check 16: No unsupported injury claim — if injuries field is set, it must
// come from source data (at least one rawSourceData record has injury text).
function checkInjuriesSourceBacked(stories, result) {
  for (const s of stories) {
    if (!isNonEmptyString(s?.injuries)) continue; // null/missing is OK
    const records = Array.isArray(s.rawSourceData) ? s.rawSourceData : [];
    const hasSource = records.some(
      (r) => r && isNonEmptyString(r.injuries),
    );
    if (!hasSource) {
      result.fail(
        `Story "${s.recallStoryKey}" has injuries field but no rawSourceData record has injuries text`,
      );
    }
  }
}

// Check 17: No unsupported death claim — if deaths field is set, it must
// come from source data.
function checkDeathsSourceBacked(stories, result) {
  for (const s of stories) {
    if (!isNonEmptyString(s?.deaths)) continue;
    const records = Array.isArray(s.rawSourceData) ? s.rawSourceData : [];
    const hasSource = records.some(
      (r) => r && isNonEmptyString(r.deaths),
    );
    if (!hasSource) {
      result.fail(
        `Story "${s.recallStoryKey}" has deaths field but no rawSourceData record has deaths text`,
      );
    }
  }
}

// Check 18: No FDA external/unverified photo — FDA stories must not have
// imageUrls (the FDA openFDA API does not provide images; any photo on an
// FDA story would have to come from an external/unverified source).
function checkNoFdaImages(stories, result) {
  for (const s of stories) {
    if (s?.source !== 'FDA') continue;
    const imgs = Array.isArray(s?.imageUrls) ? s.imageUrls : [];
    if (imgs.length > 0) {
      result.fail(
        `FDA story "${s.recallStoryKey}" has ${imgs.length} imageUrls — FDA API does not provide images (urls: ${imgs.slice(0, 2).map((u) => String(u).slice(0, 60)).join(', ')}...)`,
      );
    }
  }
}

// Check 19: CPSC photo has source metadata — if a CPSC story has imageUrls,
// they must be from the CPSC source (hosted on cpsc.gov).
function checkCpscImagesFromSource(stories, result) {
  for (const s of stories) {
    if (s?.source !== 'CPSC') continue;
    const imgs = Array.isArray(s?.imageUrls) ? s.imageUrls : [];
    for (const url of imgs) {
      if (!isNonEmptyString(url)) {
        result.fail(
          `CPSC story "${s.recallStoryKey}" has non-string image URL: ${JSON.stringify(url)}`,
        );
        continue;
      }
      const fromCpsc = CPSC_IMAGE_URL_PREFIXES.some((p) => url.startsWith(p));
      if (!fromCpsc) {
        result.fail(
          `CPSC story "${s.recallStoryKey}" has image URL not from cpsc.gov: "${url.slice(0, 80)}..."`,
        );
      }
    }
  }
}

// Check 20: reportDate present when expected — FDA stories should have
// fdaReportDates (a non-empty array). The cluster pipeline preserves the
// FDA report_date field as fdaReportDates.
function checkFdaReportDatesPresent(stories, result) {
  for (const s of stories) {
    if (s?.source !== 'FDA') continue;
    const d = s?.fdaReportDates;
    if (!Array.isArray(d) || d.length === 0) {
      result.fail(
        `FDA story "${s.recallStoryKey}" is missing fdaReportDates (expected non-empty array)`,
      );
    }
  }
}

// Check 21: No recall initiation/report date confusion — for FDA stories,
// recallInitiationDates and fdaReportDates must not be swapped. A recall
// initiation date should be <= its corresponding report date. We check at
// the per-record level using rawSourceData (each candidate record's
// recallDate / reportDate pair, which mirror FDA's recall_initiation_date
// and report_date after normalization by the fetcher).
function checkNoDateConfusion(stories, result) {
  for (const s of stories) {
    if (s?.source !== 'FDA') continue;
    const records = Array.isArray(s.rawSourceData) ? s.rawSourceData : [];
    for (const r of records) {
      if (!r || typeof r !== 'object') continue;
      // Skip if either date is missing — we can't compare.
      if (!isNonEmptyString(r.recallDate) || !isNonEmptyString(r.reportDate)) continue;
      const recallTs = new Date(r.recallDate).getTime();
      const reportTs = new Date(r.reportDate).getTime();
      if (Number.isNaN(recallTs) || Number.isNaN(reportTs)) continue;
      if (recallTs > reportTs) {
        result.fail(
          `FDA story "${s.recallStoryKey}" record ${r.sourceId ?? '?'}: recallDate "${r.recallDate}" is later than reportDate "${r.reportDate}" (dates may be swapped)`,
        );
      }
    }
  }
}

// Check 22: No empty source URLs — all sourceUrls must be non-empty strings.
function checkNoEmptySourceUrls(stories, result) {
  for (const s of stories) {
    const urls = Array.isArray(s?.sourceUrls) ? s.sourceUrls : [];
    if (urls.length === 0) {
      result.fail(
        `Story "${s?.recallStoryKey ?? '?'}" has empty sourceUrls array`,
      );
      continue;
    }
    for (const url of urls) {
      if (!isNonEmptyString(url)) {
        result.fail(
          `Story "${s.recallStoryKey}" has empty or non-string sourceUrl: ${JSON.stringify(url)}`,
        );
      }
    }
  }
}

// Check 23: No duplicate article slug — check if we generate slugs; if not
// yet, skip. At the cluster stage, no `slug` field is produced, so this
// check is a no-op (passes with a warning noting that slugs are generated
// later in the pipeline, at the draft/preview stage).
function checkNoDuplicateArticleSlug(stories, result) {
  const hasSlugField = stories.some(
    (s) => s && Object.prototype.hasOwnProperty.call(s, 'slug'),
  );
  if (!hasSlugField) {
    result.warn(
      'No "slug" field present on cluster stories — slugs are generated later in the pipeline (draft/preview stage). Check is a no-op at this stage.',
    );
    return;
  }
  const seen = new Map();
  for (const s of stories) {
    const slug = s?.slug;
    if (slug == null || slug === '') continue;
    seen.set(slug, (seen.get(slug) ?? 0) + 1);
  }
  for (const [slug, count] of seen) {
    if (count > 1) {
      result.fail(`Duplicate article slug in clusters file: "${slug}" (appears ${count} times)`);
    }
  }
}

// Check 24: No malformed source IDs — sourceRecallIds must be non-empty
// strings.
function checkNoMalformedSourceIds(stories, result) {
  for (const s of stories) {
    const ids = Array.isArray(s?.sourceRecallIds) ? s.sourceRecallIds : [];
    for (const id of ids) {
      if (!isNonEmptyString(id)) {
        result.fail(
          `Story "${s?.recallStoryKey ?? '?'}" has empty or non-string sourceRecallId: ${JSON.stringify(id)}`,
        );
      }
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
  console.log(`  Clusters file: ${CLUSTERS_FILE}`);
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
  console.log(`  Total recall records loaded: ${allRecalls.length}`);

  // Load clusters file for the new Phase 7B.1 checks.
  const clustersLoad = await loadClusters();
  let clustersStories = [];
  if (!clustersLoad.ok) {
    console.log(`  [info] Clusters file not found or unreadable (${clustersLoad.reason}) — Phase 7B.1 checks will be skipped.`);
  } else {
    clustersStories = clustersLoad.stories;
    console.log(`  [info] Loaded ${String(clustersStories.length).padStart(4)} cluster stories from ${CLUSTERS_FILE}`);
  }
  console.log('');

  // Build the full check list. The first 9 operate on snapshots + story
  // records; checks 10-24 operate on the clusters file.
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
    new CheckResult(10, 'No duplicate recallStoryKey in clusters file'),
    new CheckResult(11, 'No empty key components in story keys'),
    new CheckResult(12, 'Every story has sourceRecallIds (non-empty array)'),
    new CheckResult(13, 'No cluster with unrelated firms (same recallingFirm/manufacturer)'),
    new CheckResult(14, 'No unsupported normalized hazard (evidence references real source field)'),
    new CheckResult(15, 'Headline hazard supported by evidence (keyword in evidence text)'),
    new CheckResult(16, 'No unsupported injury claim (injuries come from source data)'),
    new CheckResult(17, 'No unsupported death claim (deaths come from source data)'),
    new CheckResult(18, 'No FDA external/unverified photo (FDA stories have no imageUrls)'),
    new CheckResult(19, 'CPSC photo has source metadata (imageUrls from cpsc.gov)'),
    new CheckResult(20, 'reportDate present when expected (FDA stories have fdaReportDates)'),
    new CheckResult(21, 'No recall initiation/report date confusion (dates not swapped)'),
    new CheckResult(22, 'No empty source URLs (all sourceUrls non-empty strings)'),
    new CheckResult(23, 'No duplicate article slug (skipped if slugs not generated yet)'),
    new CheckResult(24, 'No malformed source IDs (sourceRecallIds non-empty strings)'),
  ];

  // --- Existing checks 1-3, 5-9 against recall snapshots.
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

  // --- New Phase 7B.1 checks (10-24) against clusters file ----------------
  if (clustersStories.length > 0) {
    checkUniqueStoryKeys(clustersStories, checks[9]);              // check 10
    checkNoEmptyKeySegments(clustersStories, checks[10]);          // check 11
    checkSourceRecallIdsPresent(clustersStories, checks[11]);      // check 12
    checkNoUnrelatedFirmsInCluster(clustersStories, checks[12]);   // check 13
    checkHazardEvidenceValid(clustersStories, checks[13]);         // check 14
    checkHazardSupportedByEvidence(clustersStories, checks[14]);   // check 15
    checkInjuriesSourceBacked(clustersStories, checks[15]);        // check 16
    checkDeathsSourceBacked(clustersStories, checks[16]);          // check 17
    checkNoFdaImages(clustersStories, checks[17]);                 // check 18
    checkCpscImagesFromSource(clustersStories, checks[18]);        // check 19
    checkFdaReportDatesPresent(clustersStories, checks[19]);       // check 20
    checkNoDateConfusion(clustersStories, checks[20]);             // check 21
    checkNoEmptySourceUrls(clustersStories, checks[21]);           // check 22
    checkNoDuplicateArticleSlug(clustersStories, checks[22]);      // check 23
    checkNoMalformedSourceIds(clustersStories, checks[23]);        // check 24
  } else {
    for (let i = 9; i < 24; i++) {
      checks[i].warn(`Clusters file not loaded — Phase 7B.1 check skipped.`);
    }
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
