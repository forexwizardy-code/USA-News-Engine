/**
 * US News Engine — FDA device enforcement recall fetcher (Phase 7A).
 *
 * Fetches recent medical-device enforcement recalls from the openFDA API
 * and normalizes them into the shared recall schema used by Phase 7A.
 *
 * Source:  openFDA — Device Enforcement
 * Endpoint: https://api.fda.gov/device/enforcement.json
 *
 * This script makes exactly ONE request to the source API, writes the
 * normalized records to data/recalls/fda-device-recalls.json atomically, and
 * prints a brief summary. It does NOT publish anything to the website and
 * does NOT use AI.
 *
 * Run manually:
 *   npm run fetch:fda-device
 *
 * No API key is required by this endpoint (anonymous tier: 1000 req/day).
 */

import { mkdir, writeFile, rename, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(__dirname, '..');

// --- Configuration ---------------------------------------------------------
const FDA_API_URL = 'https://api.fda.gov/device/enforcement.json';
const OUTPUT_FILE = join(PROJECT_DIR, 'data', 'recalls', 'fda-device-recalls.json');
const SOURCE_NAME = 'FDA';
const SOURCE_TYPE = 'device';
const RECALL_KEY_PREFIX = 'fda-device';

const USER_AGENT = 'USNewsEngine/1.0 (https://usa-news-engine.forexwizardy.workers.dev)';
const ACCEPT = 'application/json';
const FETCH_TIMEOUT_MS = 45_000;

const RECENT_WINDOW_DAYS = 30;
const LIMIT = 100;

// FDA device recall information landing page.
const FDA_LANDING_URL = 'https://open.fda.gov/data/downloads/device/enforcement/';

// --- Helpers ---------------------------------------------------------------

function fail(message, { exitCode = 1, detail } = {}) {
  console.error(`\n[fetch-fda-device-recalls] ERROR: ${message}`);
  if (detail) console.error(`  Detail: ${detail}`);
  console.error(`  Endpoint: ${FDA_API_URL}`);
  process.exit(exitCode);
}

/**
 * Format a Date as YYYYMMDD for the openFDA date-range query syntax.
 */
function formatFdaDate(d) {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}

/**
 * Convert an FDA YYYYMMDD date string to an ISO-8601 timestamp (UTC midnight).
 */
function fdaDateToIso(value) {
  if (!value || typeof value !== 'string') return null;
  const m = value.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!m) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const [, y, mo, da] = m;
  const d = new Date(Date.UTC(+y, +mo - 1, +da));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Derive a coarse hazard label from the FDA reason_for_recall free-text
 * field by matching against device-relevant hazard keywords.
 * Returns the matched keyword(s) joined with '; ', or null if none match.
 */
function deriveHazardFromReason(reason) {
  if (!reason || typeof reason !== 'string') return null;
  const lower = reason.toLowerCase();
  const keywords = [
    'salmonella',
    'listeria',
    'e. coli',
    'e coli',
    'botulism',
    'hepatitis',
    'norovirus',
    'lead',
    'arsenic',
    'cadmium',
    'undeclared allergen',
    'undeclared milk',
    'undeclared egg',
    'undeclared soy',
    'undeclared wheat',
    'undeclared peanut',
    'undeclared tree nut',
    'undeclared sulfite',
    'foreign material',
    'foreign object',
    'glass',
    'metal',
    'plastic',
    'contamination',
    'pathogen',
    'coliform',
    'cronobacter',
    'clostridium',
    'staphylococcus',
    'toxin',
    'allergen',
    'misbranding',
    'tampering',
    // device-specific hazards
    'failure',
    'malfunction',
    'software error',
    'battery',
    'overheating',
    'shock',
    'electrical',
    'sterility',
    'leak',
    'break',
    'crack',
    'infection',
    'embolism',
    'airway',
    'occlusion',
    'flow rate',
    'dose',
    'overdose',
    'underdose',
    'misfeed',
    'needle',
    'tip',
    'detachment',
  ];
  const matches = [];
  for (const k of keywords) {
    if (lower.includes(k)) matches.push(k);
  }
  return matches.length ? [...new Set(matches)].join('; ') : null;
}

/**
 * Normalize a single FDA device enforcement record into the shared schema.
 */
function normalizeFdaRecord(record) {
  const recallNumber = record?.recall_number ?? null;
  const productDescription = record?.product_description ?? null;
  const reasonForRecall = record?.reason_for_recall ?? null;

  return {
    source: SOURCE_NAME,
    sourceType: SOURCE_TYPE,
    sourceId: recallNumber,
    recallKey: recallNumber ? `${RECALL_KEY_PREFIX}__${recallNumber}` : null,
    title: productDescription ? productDescription.slice(0, 100) : null,
    productName: productDescription,
    brand: null,
    manufacturer: null,
    recallingFirm: record?.recalling_firm ?? null,
    description: productDescription,
    hazard: deriveHazardFromReason(reasonForRecall),
    reason: reasonForRecall,
    consumerAction: null,
    classification: record?.classification ?? null,
    recallDate: fdaDateToIso(record?.recall_initiation_date),
    reportDate: fdaDateToIso(record?.report_date),
    distribution: record?.distribution_pattern ?? null,
    affectedStates: null,
    units: record?.product_quantity ?? null,
    modelNumbers: null,
    lotNumbers: record?.code_info ?? null,
    upc: null,
    incidents: null,
    injuries: null,
    deaths: null,
    sourceUrl: FDA_LANDING_URL,
    imageUrls: [],
    lastUpdatedAt: new Date().toISOString(),
    rawSourceData: record,
  };
}

// --- Main ------------------------------------------------------------------

async function main() {
  console.log('[fetch-fda-device-recalls] Starting one-shot fetch from openFDA.');
  console.log(`  Endpoint:  ${FDA_API_URL}`);
  console.log(`  User-Agent: ${USER_AGENT}`);

  const now = new Date();
  const cutoff = new Date(now.getTime() - RECENT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const fromDate = formatFdaDate(cutoff);
  const toDate = formatFdaDate(now);

  // openFDA expects the search parameter with literal `+` characters as
  // spaces inside the bracketed date range. encodeURIComponent would produce
  // %2B which openFDA interprets as a literal `+`; we replace %20 with `+`.
  const searchValue = `report_date:[${fromDate} TO ${toDate}]`;
  const url = `${FDA_API_URL}?search=${encodeURIComponent(searchValue).replace(/%20/g, '+')}&limit=${LIMIT}`;

  // Step 1 — single HTTP request with timeout.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response;
  try {
    console.log(`  GET ${url}`);
    response = await fetch(url, {
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
      fail('Request timed out before FDA responded.', {
        detail: `Aborted after ${FETCH_TIMEOUT_MS}ms.`,
      });
    }
    fail('Network failure while contacting FDA.', { detail: String(err) });
  }
  clearTimeout(timer);

  // Step 2 — HTTP error handling. openFDA returns 404 with a JSON error body
  // when the search returns zero results; treat that as "no recalls found".
  if (response.status === 404) {
    let bodySnippet = '';
    try {
      bodySnippet = (await response.text()).slice(0, 300);
    } catch {
      /* ignore */
    }
    console.log(`  FDA returned 404 (likely no matches in window). Body: ${bodySnippet}`);
    const emptyDoc = {
      fetchedAt: now.toISOString(),
      source: SOURCE_NAME,
      sourceUrl: url,
      count: 0,
      rawApiCount: 0,
      recalls: [],
    };
    await mkdir(dirname(OUTPUT_FILE), { recursive: true });
    const tmp = `${OUTPUT_FILE}.tmp`;
    await writeFile(tmp, JSON.stringify(emptyDoc, null, 2) + '\n', 'utf8');
    await rename(tmp, OUTPUT_FILE);
    const stats = await stat(OUTPUT_FILE);
    console.log('\n[fetch-fda-device-recalls] SUCCESS (empty result)');
    console.log(`  Recalls fetched: 0`);
    console.log(`  Output file:     ${OUTPUT_FILE}`);
    console.log(`  File size:       ${stats.size.toLocaleString()} bytes\n`);
    return;
  }

  if (!response.ok) {
    let bodySnippet = '';
    try {
      bodySnippet = (await response.text()).slice(0, 300);
    } catch {
      /* ignore */
    }
    fail(`FDA returned a non-2xx HTTP status.`, {
      detail: `HTTP ${response.status} ${response.statusText}${bodySnippet ? ` — ${bodySnippet}` : ''}`,
    });
  }

  // Step 3 — parse JSON.
  let payload;
  try {
    payload = await response.json();
  } catch (err) {
    fail('Malformed response — body is not valid JSON.', { detail: String(err) });
  }

  if (!payload || typeof payload !== 'object') {
    fail('Malformed response — top-level payload is not a JSON object.', {
      detail: `Received: ${typeof payload}`,
    });
  }

  const results = Array.isArray(payload.results) ? payload.results : [];
  console.log(`  Raw results returned by API: ${results.length}`);

  // Step 4 — normalize every record.
  const recalls = results
    .map(normalizeFdaRecord)
    .filter((r) => r.sourceId != null);

  // Step 5 — assemble output document with provenance metadata.
  const document = {
    fetchedAt: now.toISOString(),
    source: SOURCE_NAME,
    sourceUrl: url,
    count: recalls.length,
    rawApiCount: results.length,
    recalls,
  };

  // Step 6 — write atomically.
  await mkdir(dirname(OUTPUT_FILE), { recursive: true });
  const tmpFile = `${OUTPUT_FILE}.tmp`;
  await writeFile(tmpFile, JSON.stringify(document, null, 2) + '\n', 'utf8');
  await rename(tmpFile, OUTPUT_FILE);

  // Step 7 — report.
  const stats = await stat(OUTPUT_FILE);
  console.log('\n[fetch-fda-device-recalls] SUCCESS');
  console.log(`  Recalls fetched:    ${recalls.length}`);
  console.log(`  Output file:        ${OUTPUT_FILE}`);
  console.log(`  File size:          ${stats.size.toLocaleString()} bytes`);
  console.log(`  Fetched at (UTC):   ${document.fetchedAt}`);
  console.log(`  Recall window:      ${fromDate} → ${toDate} (YYYYMMDD)`);

  const samples = recalls.slice(0, 3).filter((r) => r.title);
  if (samples.length) {
    console.log('\n  Sample recalls:');
    for (const s of samples) {
      console.log(`    - [${s.recallKey}] ${s.title}`);
    }
  } else {
    console.log('\n  (No sample recalls — results array was empty.)');
  }
  console.log('');
}

main().catch((err) => {
  fail('Unexpected failure.', { detail: String(err && err.stack ? err.stack : err) });
});
