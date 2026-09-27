/**
 * US News Engine — CPSC recall fetcher (Phase 7A).
 *
 * Fetches recent consumer-product recalls from the U.S. Consumer Product
 * Safety Commission (CPSC) REST API and normalizes them into the shared
 * recall schema used by the rest of Phase 7A.
 *
 * Source:  CPSC SaferProducts.gov
 * Endpoint: https://www.saferproducts.gov/RestWebServices/Recall?format=json
 *
 * This script makes exactly ONE request to the source API, writes the
 * normalized records to data/recalls/cpsc-recalls.json atomically, and prints
 * a brief summary. It does NOT publish anything to the website and does NOT
 * use AI.
 *
 * Run manually:
 *   npm run fetch:cpsc
 *
 * No API key is required by this endpoint.
 */

import { mkdir, writeFile, rename, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(__dirname, '..');

// --- Configuration ---------------------------------------------------------
const CPSC_API_URL = 'https://www.saferproducts.gov/RestWebServices/Recall';
const OUTPUT_FILE = join(PROJECT_DIR, 'data', 'recalls', 'cpsc-recalls.json');
const SOURCE_NAME = 'CPSC';

const USER_AGENT = 'USNewsEngine/1.0 (https://usa-news-engine.forexwizardy.workers.dev)';
const ACCEPT = 'application/json';
const FETCH_TIMEOUT_MS = 45_000;

// How many days back to consider "recent".
const RECENT_WINDOW_DAYS = 30;

// Cap the number of records we keep after local filtering. The CPSC API can
// return very large result sets; we only care about recent activity.
const MAX_RECORDS = 200;

// --- Helpers ---------------------------------------------------------------

function fail(message, { exitCode = 1, detail } = {}) {
  console.error(`\n[fetch-cpsc-recalls] ERROR: ${message}`);
  if (detail) console.error(`  Detail: ${detail}`);
  console.error(`  Endpoint: ${CPSC_API_URL}`);
  process.exit(exitCode);
}

/**
 * Format a Date as yyyy-MM-dd (CPSC RecallDateStart parameter format).
 */
function formatDateParam(d) {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Safely extract the first element of an array field that may be missing,
 * null, or not actually an array. Returns null when nothing usable exists.
 */
function firstOf(maybeArr, key = 'Name') {
  if (!Array.isArray(maybeArr) || maybeArr.length === 0) return null;
  const first = maybeArr[0];
  if (first && typeof first === 'object') return first[key] ?? null;
  if (typeof first === 'string') return first;
  return null;
}

/**
 * Join an array of `{ Name }` objects (or strings) into a single string.
 */
function joinNames(maybeArr, sep = '; ') {
  if (!Array.isArray(maybeArr) || maybeArr.length === 0) return null;
  const parts = maybeArr
    .map((item) => {
      if (item && typeof item === 'object') return item.Name ?? item.name ?? null;
      if (typeof item === 'string') return item;
      return null;
    })
    .filter((s) => s != null && s !== '');
  return parts.length ? parts.join(sep) : null;
}

/**
 * Extract image URLs from the CPSC Images array. Each image entry typically
 * has a `URL` field; we tolerate both `URL` and `Url` casing.
 */
function extractImageUrls(maybeArr) {
  if (!Array.isArray(maybeArr) || maybeArr.length === 0) return [];
  const urls = [];
  for (const img of maybeArr) {
    if (!img || typeof img !== 'object') continue;
    const u = img.URL ?? img.Url ?? img.url ?? null;
    if (typeof u === 'string' && u) urls.push(u);
  }
  return urls;
}

/**
 * Normalize a single CPSC recall record into the shared recall schema.
 */
function normalizeCpscRecord(record) {
  const recallId = record?.RecallID;
  const products = Array.isArray(record?.Products) ? record.Products : [];
  const productName = products.length
    ? (products[0]?.Name ?? products[0]?.Description ?? null)
    : null;

  const manufacturers = Array.isArray(record?.Manufacturers) ? record.Manufacturers : [];
  const manufacturer = manufacturers.length ? manufacturers[0]?.Name ?? null : null;

  const hazards = Array.isArray(record?.Hazards) ? record.Hazards : [];
  const hazard = joinNames(hazards);

  const remedies = Array.isArray(record?.Remedies) ? record.Remedies : [];
  // Some CPSC records also include a RemedyOptions array; merge both.
  const remedyOptions = Array.isArray(record?.RemedyOptions) ? record.RemedyOptions : [];
  const consumerAction = [joinNames(remedies), joinNames(remedyOptions)]
    .filter(Boolean)
    .join(' | ') || null;

  const upcs = Array.isArray(record?.ProductUPCs) ? record.ProductUPCs : [];
  const upc = upcs.length
    ? upcs
        .map((u) => (u && typeof u === 'object' ? u.UPC ?? u.Name ?? null : u))
        .filter((s) => s != null && s !== '')
        .join(', ') || null
    : null;

  const injuries = Array.isArray(record?.Injuries) ? record.Injuries : [];
  // Injuries may be objects or strings; expose count + joined text.
  const injuriesText = joinNames(injuries);

  const imageUrls = extractImageUrls(record?.Images);

  return {
    source: 'CPSC',
    sourceType: 'consumer-product',
    sourceId: recallId != null ? String(recallId) : null,
    recallKey: recallId != null ? `cpsc__${recallId}` : null,
    title: record?.Title ?? null,
    productName,
    brand: null, // CPSC doesn't always separate brand
    manufacturer,
    recallingFirm: null, // CPSC uses Manufacturers
    description: record?.Description ?? null,
    hazard,
    reason: null,
    consumerAction,
    classification: null, // CPSC doesn't use Class I/II/III
    recallDate: record?.RecallDate ?? null,
    reportDate: record?.RecallDate ?? null,
    distribution: record?.SoldAtLabel ?? null,
    affectedStates: null,
    units: null,
    modelNumbers: null,
    lotNumbers: null,
    upc,
    incidents: null,
    injuries: injuriesText,
    deaths: null,
    sourceUrl: record?.URL ?? null,
    imageUrls,
    lastUpdatedAt: new Date().toISOString(),
    rawSourceData: record,
  };
}

/**
 * Decide whether a normalized record is "recent enough" given the cutoff.
 */
function isRecent(record, cutoff) {
  const d = parseDate(record.recallDate);
  if (!d) return false;
  return d.getTime() >= cutoff.getTime();
}

// --- Main ------------------------------------------------------------------

async function main() {
  console.log('[fetch-cpsc-recalls] Starting one-shot fetch from CPSC.');
  console.log(`  Endpoint:  ${CPSC_API_URL}`);
  console.log(`  User-Agent: ${USER_AGENT}`);

  const now = new Date();
  const cutoff = new Date(now.getTime() - RECENT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const cutoffParam = formatDateParam(cutoff);

  // Build the URL with RecallDateStart filter. We attempt a date-filtered
  // request first; if the API ignores the filter or returns nothing usable,
  // we fall back to fetching the most recent records without a date filter.
  const urlWithFilter = `${CPSC_API_URL}?format=json&RecallDateStart=${cutoffParam}`;
  const urlNoFilter = `${CPSC_API_URL}?format=json`;

  // Step 1 — single HTTP request with timeout.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response;
  try {
    console.log(`  GET ${urlWithFilter}`);
    response = await fetch(urlWithFilter, {
      method: 'GET',
      headers: {
        Accept: ACCEPT,
        'User-Agent': USER_AGENT,
        'Accept-Encoding': 'gzip, deflate',
      },
      signal: controller.signal,
      redirect: 'follow',
    });
  } catch (err) {
    clearTimeout(timer);
    if (err && err.name === 'AbortError') {
      fail('Request timed out before CPSC responded.', {
        detail: `Aborted after ${FETCH_TIMEOUT_MS}ms.`,
      });
    }
    fail('Network failure while contacting CPSC.', { detail: String(err) });
  }
  clearTimeout(timer);

  // Step 2 — HTTP error handling.
  if (!response.ok) {
    let bodySnippet = '';
    try {
      bodySnippet = (await response.text()).slice(0, 300);
    } catch {
      /* ignore */
    }
    fail(`CPSC returned a non-2xx HTTP status.`, {
      detail: `HTTP ${response.status} ${response.statusText}${bodySnippet ? ` — ${bodySnippet}` : ''}`,
    });
  }

  // Step 3 — parse + validate JSON.
  let payload;
  try {
    payload = await response.json();
  } catch (err) {
    fail('Malformed response — body is not valid JSON.', { detail: String(err) });
  }

  // The CPSC Recall endpoint returns a top-level array of recall objects.
  let records;
  if (Array.isArray(payload)) {
    records = payload;
  } else if (payload && Array.isArray(payload.Recalls)) {
    records = payload.Recalls;
  } else if (payload && Array.isArray(payload.results)) {
    records = payload.results;
  } else {
    fail('Malformed response — expected a top-level array of recalls.', {
      detail: `Top-level type: ${typeof payload}`,
    });
  }

  console.log(`  Raw records returned by API: ${records.length}`);

  // Step 4 — normalize all records (tolerant of missing fields).
  const normalized = records
    .map(normalizeCpscRecord)
    .filter((r) => r.sourceId != null);

  // Step 5 — local date filter. If RecallDateStart was honored we'll keep
  // almost everything; if not, we filter down to the recent window here.
  let recent = normalized.filter((r) => isRecent(r, cutoff));

  let usedDateFilterFallback = false;
  if (recent.length === 0 && normalized.length > 0) {
    // The API likely ignored the RecallDateStart parameter. Keep the most
    // recent records by recallDate and re-filter locally on a wider window.
    console.log('  Date filter returned no recent records — falling back to most-recent slice.');
    usedDateFilterFallback = true;
    const sorted = [...normalized].sort((a, b) => {
      const da = parseDate(a.recallDate)?.getTime() ?? 0;
      const db = parseDate(b.recallDate)?.getTime() ?? 0;
      return db - da;
    });
    const recentSlice = sorted.slice(0, MAX_RECORDS);
    // Apply a 30-day window to the slice; if even the newest are older than
    // 30 days, keep the slice anyway so downstream has SOMETHING to work with.
    const inWindow = recentSlice.filter((r) => isRecent(r, cutoff));
    recent = inWindow.length ? inWindow : recentSlice;
  }

  // Step 6 — cap to MAX_RECORDS (newest first) for safety.
  recent = [...recent]
    .sort((a, b) => {
      const da = parseDate(a.recallDate)?.getTime() ?? 0;
      const db = parseDate(b.recallDate)?.getTime() ?? 0;
      return db - da;
    })
    .slice(0, MAX_RECORDS);

  // Step 7 — assemble output document with provenance metadata.
  const document = {
    fetchedAt: now.toISOString(),
    source: SOURCE_NAME,
    sourceUrl: urlWithFilter,
    count: recent.length,
    rawApiCount: records.length,
    usedDateFilterFallback,
    recalls: recent,
  };

  // Step 8 — write atomically.
  await mkdir(dirname(OUTPUT_FILE), { recursive: true });
  const tmpFile = `${OUTPUT_FILE}.tmp`;
  await writeFile(tmpFile, JSON.stringify(document, null, 2) + '\n', 'utf8');
  await rename(tmpFile, OUTPUT_FILE);

  // Step 9 — report.
  const stats = await stat(OUTPUT_FILE);
  console.log('\n[fetch-cpsc-recalls] SUCCESS');
  console.log(`  Recalls fetched:    ${recent.length}`);
  console.log(`  Raw API count:      ${records.length}`);
  console.log(`  Date-filter fallback used: ${usedDateFilterFallback ? 'yes' : 'no'}`);
  console.log(`  Output file:        ${OUTPUT_FILE}`);
  console.log(`  File size:          ${stats.size.toLocaleString()} bytes`);
  console.log(`  Fetched at (UTC):   ${document.fetchedAt}`);
  console.log(`  Recall window:      ${cutoffParam} → ${formatDateParam(now)} (UTC)`);

  // Print up to 3 sample titles for eyeball verification.
  const samples = recent.slice(0, 3).filter((r) => r.title);
  if (samples.length) {
    console.log('\n  Sample recalls:');
    for (const s of samples) {
      console.log(`    - [${s.recallKey}] ${s.title}`);
    }
  } else {
    console.log('\n  (No sample titles — recalls array was empty.)');
  }
  console.log('');
}

main().catch((err) => {
  fail('Unexpected failure.', { detail: String(err && err.stack ? err.stack : err) });
});
