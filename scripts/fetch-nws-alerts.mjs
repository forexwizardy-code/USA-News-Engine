/**
 * US News Engine — National Weather Service active-alerts fetcher.
 *
 * Phase 3A: data ingestion only. This script does NOT publish alerts to the
 * website, does NOT transform them into articles, and does NOT use AI.
 * It makes exactly ONE request to the official NWS API and writes the raw,
 * normalized alerts to data/nws-active-alerts.json.
 *
 * Source:  U.S. National Weather Service (free, open government data)
 * Endpoint: https://api.weather.gov/alerts/active  (GeoJSON)
 *
 * Run manually:
 *   npm run fetch:nws
 *   (or) bun run fetch:nws
 *
 * No API key is required by this endpoint. Nothing in this script reads or
 * transmits any secret.
 */

import { mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(__dirname, '..');

// --- Configuration ---------------------------------------------------------
const NWS_ALERTS_URL = 'https://api.weather.gov/alerts/active';
const OUTPUT_FILE = join(PROJECT_DIR, 'data', 'nws-active-alerts.json');
const SOURCE_NAME = 'National Weather Service';

// NWS asks clients to identify themselves with a User-Agent that includes
// the app name and a way to be contacted. No secret is included.
const USER_AGENT = 'USNewsEngine/1.0 (https://www.usnewsengine.com)';
const ACCEPT = 'application/geo+json';
const FETCH_TIMEOUT_MS = 30_000;

// --- Helpers ---------------------------------------------------------------

/**
 * Normalize a single NWS GeoJSON alert feature into the flat record shape
 * required by Phase 3A. Missing fields become null rather than undefined so
 * the output JSON stays predictable for downstream consumers.
 */
function normalizeAlert(feature) {
  const p = feature && typeof feature === 'object' ? feature.properties : null;
  const id = p?.id ?? null;
  return {
    // Official NWS alert id (UUID) — the stable key for duplicate detection.
    id,
    // Full canonical feature id (URI) as returned at the GeoJSON level.
    alertUri: feature?.id ?? null,
    event: p?.event ?? null,
    headline: p?.headline ?? null,
    description: p?.description ?? null,
    instruction: p?.instruction ?? null,
    severity: p?.severity ?? null,
    certainty: p?.certainty ?? null,
    urgency: p?.urgency ?? null,
    effective: p?.effective ?? null,
    onset: p?.onset ?? null,
    expires: p?.expires ?? null,
    ends: p?.ends ?? null,
    areaDesc: p?.areaDesc ?? null,
    senderName: p?.senderName ?? null,
    response: p?.response ?? null,
    messageType: p?.messageType ?? null,
    status: p?.status ?? null,
    category: p?.category ?? null,
    affectedZones: Array.isArray(p?.affectedZones) ? p.affectedZones : [],
    // Canonical per-alert URL on api.weather.gov.
    sourceUrl: id ? `https://api.weather.gov/alerts/${id}` : null,
  };
}

function fail(message, { exitCode = 1, detail } = {}) {
  console.error(`\n[fetch-nws-alerts] ERROR: ${message}`);
  if (detail) console.error(`  Detail: ${detail}`);
  console.error(`  Endpoint: ${NWS_ALERTS_URL}`);
  process.exit(exitCode);
}

// --- Main ------------------------------------------------------------------

async function main() {
  console.log('[fetch-nws-alerts] Starting one-shot fetch from NWS.');
  console.log(`  Endpoint:  ${NWS_ALERTS_URL}`);
  console.log(`  User-Agent: ${USER_AGENT}`);
  console.log(`  Accept:     ${ACCEPT}`);

  // Step 1 — single HTTP request with timeout.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(NWS_ALERTS_URL, {
      method: 'GET',
      headers: {
        Accept: ACCEPT,
        'User-Agent': USER_AGENT,
        // NWS supports gzip; fetch handles decompression automatically.
        'Accept-Encoding': 'gzip, deflate',
      },
      signal: controller.signal,
      redirect: 'follow',
    });
  } catch (err) {
    clearTimeout(timer);
    if (err && err.name === 'AbortError') {
      fail('Request timed out before NWS responded.', {
        detail: `Aborted after ${FETCH_TIMEOUT_MS}ms.`,
      });
    }
    fail('Network failure while contacting NWS.', { detail: String(err) });
  }
  clearTimeout(timer);

  // Step 2 — HTTP error handling.
  if (!response.ok) {
    let bodySnippet = '';
    try {
      bodySnippet = (await response.text()).slice(0, 300);
    } catch {
      /* ignore body read errors */
    }
    fail(`NWS returned a non-2xx HTTP status.`, {
      detail: `HTTP ${response.status} ${response.statusText}${bodySnippet ? ` — ${bodySnippet}` : ''}`,
    });
  }

  // Step 3 — parse + validate JSON (guard against malformed / non-JSON bodies).
  const contentType = response.headers.get('content-type') || '';
  let payload;
  try {
    payload = await response.json();
  } catch (err) {
    fail('Malformed response — body is not valid JSON.', {
      detail: `Content-Type was "${contentType}". ${String(err)}`,
    });
  }

  if (!payload || typeof payload !== 'object') {
    fail('Malformed response — top-level payload is not a JSON object.', {
      detail: `Received: ${typeof payload}`,
    });
  }

  // The active-alerts endpoint returns a GeoJSON FeatureCollection.
  const features = Array.isArray(payload.features) ? payload.features : null;
  if (features === null) {
    fail('Malformed response — missing "features" array.', {
      detail: `Top-level keys: ${Object.keys(payload).join(', ') || '(none)'}`,
    });
  }

  // Step 4 — normalize every alert, tolerating missing fields per feature.
  const alerts = features.map(normalizeAlert);

  // Step 5 — assemble output document with provenance metadata.
  const document = {
    fetchedAt: new Date().toISOString(),
    source: SOURCE_NAME,
    sourceUrl: NWS_ALERTS_URL,
    count: alerts.length,
    alerts,
  };

  // Step 6 — write atomically (temp file + rename) so a partial write can
  // never leave a corrupt alerts file behind.
  await mkdir(dirname(OUTPUT_FILE), { recursive: true });
  const tmpFile = `${OUTPUT_FILE}.tmp`;
  await writeFile(tmpFile, JSON.stringify(document, null, 2) + '\n', 'utf8');
  await rename(tmpFile, OUTPUT_FILE);

  // Step 7 — report.
  const { stat } = await import('node:fs/promises');
  const stats = await stat(OUTPUT_FILE);
  console.log('\n[fetch-nws-alerts] SUCCESS');
  console.log(`  Alerts fetched: ${alerts.length}`);
  console.log(`  Output file:    ${OUTPUT_FILE}`);
  console.log(`  File size:      ${stats.size.toLocaleString()} bytes`);
  console.log(`  Fetched at:     ${document.fetchedAt}`);

  // Print up to 3 sample event names for quick eyeball verification.
  const samples = alerts.slice(0, 3).filter((a) => a.event);
  if (samples.length) {
    console.log('\n  Sample event names:');
    for (const s of samples) {
      console.log(`    - ${s.event}`);
    }
  } else {
    console.log('\n  (No sample event names — alerts array was empty.)');
  }
  console.log('');
}

main().catch((err) => {
  fail('Unexpected failure.', { detail: String(err && err.stack ? err.stack : err) });
});
