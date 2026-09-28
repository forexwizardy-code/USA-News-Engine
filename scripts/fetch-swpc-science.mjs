/**
 * US News Engine — NOAA SWPC space-weather fetcher (Phase 9A).
 *
 * Fetches space-weather alerts and the current NOAA space-weather scales
 * from the NOAA Space Weather Prediction Center:
 *
 *   - https://services.swpc.noaa.gov/products/alerts.json
 *       A JSON array of alert messages. Each item has:
 *         product_id, issue_datetime, message (multi-line text)
 *
 *   - https://services.swpc.noaa.gov/products/noaa-scales.json
 *       The current R/S/G scale levels (radio blackout, solar radiation,
 *       geomagnetic storm).
 *
 * Alert messages are parsed (via regex on the multi-line text body) to
 * extract:
 *   - messageCode (from "Space Weather Message Code: XXXX")
 *   - serialNumber (from "Serial Number: NNNN")
 *   - issueTime (from "Issue Time:" or "Issued:")
 *   - beginTime / endTime (from "Begin Time:" / "End Time:")
 *   - watchWarningType (from "Watch/Warning Type:" or "Alert Type:")
 *   - severity (R1-R5, S1-S5, G1-G5 parsed from text)
 *   - summary (first 300 chars of body with headers stripped)
 *
 * Only alerts with meaningful severity are included (see MEANINGFUL_SEVERITY).
 * Routine minor alerts (e.g. R1, S1, G1 with no major impact) are dropped.
 *
 * Output schema:
 *   {
 *     source: "NOAA-SWPC",
 *     sourceType: "space-weather-alert",
 *     sourceId: <product_id>,
 *     scienceKey: `swpc__<product_id>_<serial>`,
 *     title, description, publishedAtSource, updatedAtSource: null,
 *     sourceUrl, categories: [],
 *     mission: null, topic: "space-weather",
 *     imageUrl: null, imageAlt: null, imageCredit: "NOAA SWPC",
 *     imageSourceUrl,
 *     severity (e.g. "G3"), messageCode, serialNumber,
 *     beginTime, endTime, watchWarningType,
 *     rawSourceData: { product_id, issue_datetime, message }
 *   }
 *
 * Scales are recorded separately in the output document as `scales`.
 *
 * This script makes exactly TWO requests to the source feeds, writes the
 * normalized records to data/science/swpc-events.json atomically, and
 * prints a brief summary. It does NOT publish anything to the website and
 * does NOT use AI.
 *
 * Run manually:
 *   npm run fetch:swpc
 *
 * No API key is required by these endpoints.
 */

import { mkdir, writeFile, rename, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Phase 9A.1: SWPC records always carry storyType='space-weather'. The
 * Phase 9A.1 filter uses storyType (not the old `topic` field) as the
 * canonical publishEligibility signal.
 */
const SWPC_STORY_TYPE = 'space-weather';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(__dirname, '..');

// --- Configuration ---------------------------------------------------------
const ALERTS_URL = 'https://services.swpc.noaa.gov/products/alerts.json';
const SCALES_URL = 'https://services.swpc.noaa.gov/products/noaa-scales.json';
const OUTPUT_FILE = join(PROJECT_DIR, 'data', 'science', 'swpc-events.json');
const SOURCE_NAME = 'NOAA-SWPC';
const SOURCE_TYPE = 'space-weather-alert';
const USER_AGENT = 'USNewsEngine/1.0 (https://usa-news-engine.forexwizardy.workers.dev)';
const ACCEPT = 'application/json';
const FETCH_TIMEOUT_MS = 30_000;

// Severity codes that indicate a meaningful (non-routine) alert.
// R3+ (Strong radio blackout), S2+ (Solar radiation storm), G3+ (Strong
// geomagnetic storm). Anything below is considered routine.
const MEANINGFUL_SEVERITY = new Set([
  'R3', 'R4', 'R5',
  'S2', 'S3', 'S4', 'S5',
  'G3', 'G4', 'G5',
]);

// All recognized NOAA scale values (for validation).
const RECOGNIZED_SEVERITY = new Set([
  'R1', 'R2', 'R3', 'R4', 'R5',
  'S1', 'S2', 'S3', 'S4', 'S5',
  'G1', 'G2', 'G3', 'G4', 'G5',
]);

// --- Helpers ---------------------------------------------------------------

function fail(message, { exitCode = 1, detail } = {}) {
  console.error(`\n[fetch-swpc-science] ERROR: ${message}`);
  if (detail) console.error(`  Detail: ${detail}`);
  console.error(`  Endpoints: ${ALERTS_URL} , ${SCALES_URL}`);
  process.exit(exitCode);
}

/**
 * Parse an SWPC alert message body into structured fields.
 *
 * SWPC messages use a line-oriented header convention where each header
 * line begins with ":" (e.g. ":Product:", ":Issued:") and free-text
 * content follows. We use simple regexes against the full body for the
 * fields we care about.
 */
function parseAlertMessage(message) {
  if (typeof message !== 'string' || message.length === 0) {
    return { messageCode: null, serialNumber: null, beginTime: null, endTime: null, watchWarningType: null, summary: null };
  }

  // Message code (e.g. "Space Weather Message Code: WATA20")
  const codeMatch = message.match(/Space\s+Weather\s+Message\s+Code:\s*([A-Z0-9]+)/i);
  const messageCode = codeMatch ? codeMatch[1].trim() : null;

  // Serial number (e.g. "Serial Number: 1234")
  const serialMatch = message.match(/Serial\s+Number:\s*(\d+)/i);
  const serialNumber = serialMatch ? serialMatch[1].trim() : null;

  // Begin/end times (e.g. "Begin Time: 2025/12/25 1200 UTC")
  const beginMatch = message.match(/Begin\s+Time:\s*([0-9/:\sUTC-]+)/i);
  const endMatch = message.match(/End\s+Time:\s*([0-9/:\sUTC-]+)/i);
  const beginTime = beginMatch ? beginMatch[1].trim() : null;
  const endTime = endMatch ? endMatch[1].trim() : null;

  // Watch/Warning Type — e.g. "Geomagnetic Storm Watch", "Solar Radiation Alert"
  const watchMatch = message.match(/Watch\/Warning\s+Type:\s*(.+)/i);
  const watchWarningType = watchMatch ? watchMatch[1].trim() : null;

  // Summary — strip header lines (begin with ":") and "#" comment lines,
  // then collapse whitespace. We take the first 300 chars of the result.
  const lines = message.split(/\r?\n/);
  const bodyLines = lines.filter((l) => !l.startsWith(':') && !l.startsWith('#') && l.trim() !== '');
  const summaryFull = bodyLines.join(' ').replace(/\s+/g, ' ').trim();
  const summary = summaryFull.slice(0, 300);

  return {
    messageCode,
    serialNumber,
    beginTime,
    endTime,
    watchWarningType,
    summary,
  };
}

/**
 * Extract a severity code (R1-R5, S1-S5, G1-G5) from the alert message
 * body and/or the watch/warning type. Returns the highest-severity code
 * found, or null if no severity code is present.
 *
 * We deliberately scan for the scale letter followed by a digit 1-5. When
 * multiple severity codes appear (e.g. a watch that mentions both G3 and
 * G2), we keep the highest.
 */
function extractSeverity(message, watchWarningType) {
  const haystack = `${message || ''}\n${watchWarningType || ''}`;
  const matches = haystack.match(/\b([RSG])([1-5])\b/gi);
  if (!matches || matches.length === 0) return null;
  // Pick the highest severity (largest digit).
  let best = null;
  for (const m of matches) {
    const letter = m[0].toUpperCase();
    const digit = Number(m[1]);
    if (best == null || digit > best.digit) {
      best = { letter, digit };
    }
  }
  return best ? `${best.letter}${best.digit}` : null;
}

/**
 * Convert an SWPC issue_datetime string (e.g. "2025-12-24T00:30:00Z" or
 * "2025-12-24 00:30:00.000") to an ISO-8601 string. Returns null when
 * unparseable.
 */
function parseIssueDatetime(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Build a one-line title for an SWPC alert. Uses the watch/warning type
 * when present, otherwise the message code + serial.
 */
function buildTitle(parsed, productId) {
  if (parsed.watchWarningType) {
    const sev = parsed.severityCode ? ` ${parsed.severityCode}` : '';
    return `SWPC: ${parsed.watchWarningType}${sev}`.trim();
  }
  if (parsed.messageCode) {
    return `SWPC Alert ${parsed.messageCode}${parsed.serialNumber ? ` #${parsed.serialNumber}` : ''}`;
  }
  return `SWPC Alert ${productId || '(unknown)'}`;
}

/**
 * Normalize one SWPC alert JSON item into the science schema.
 * Returns null when the alert lacks a usable product_id.
 */
function normalizeAlert(item) {
  if (!item || typeof item !== 'object') return null;
  const productId = item.product_id || null;
  const issueDatetime = item.issue_datetime || null;
  const message = typeof item.message === 'string' ? item.message : '';

  const parsed = parseAlertMessage(message);
  parsed.severityCode = extractSeverity(message, parsed.watchWarningType);

  // Build a stable scienceKey. Format: swpc__<product_id>_<serial>.
  // When serial is missing, fall back to a hash of the message body so
  // each alert still gets a unique key.
  let scienceKey;
  if (productId && parsed.serialNumber) {
    scienceKey = `swpc__${productId}_${parsed.serialNumber}`;
  } else if (productId) {
    const hash = createHash('sha256').update(message || productId, 'utf8').digest('hex').slice(0, 12);
    scienceKey = `swpc__${productId}_${hash}`;
  } else {
    return null;
  }

  const publishedAtSource = parseIssueDatetime(issueDatetime);
  const title = buildTitle({ ...parsed, severityCode: parsed.severityCode }, productId);
  const description = parsed.summary || message.slice(0, 300).replace(/\s+/g, ' ').trim() || null;

  return {
    source: SOURCE_NAME,
    sourceType: SOURCE_TYPE,
    sourceId: productId,
    scienceKey,
    storyType: SWPC_STORY_TYPE,
    title,
    description,
    publishedAtSource,
    updatedAtSource: null,
    sourceUrl: 'https://www.swpc.noaa.gov/',
    categories: [],
    mission: null,
    topic: 'space-weather',
    imageUrl: null,
    imageAlt: null,
    imageCredit: 'NOAA SWPC',
    imageCaption: null,
    imageSourceUrl: 'https://www.swpc.noaa.gov/',
    rightsText: 'NOAA SWPC',
    rightsStatus: 'verified-agency',
    // SWPC-specific fields.
    severity: parsed.severityCode,
    messageCode: parsed.messageCode,
    serialNumber: parsed.serialNumber,
    beginTime: parsed.beginTime,
    endTime: parsed.endTime,
    watchWarningType: parsed.watchWarningType,
    rawSourceData: {
      product_id: productId,
      issue_datetime: issueDatetime,
      message,
    },
  };
}

/**
 * Parse the noaa-scales.json document into a compact summary of the
 * current R/S/G scale levels.
 *
 * The actual SWPC document is a JSON object keyed by day offset:
 *   {
 *     "-1": { R: { Scale: "0", Text: "none", ... }, S: {...}, G: {...} },
 *      "0": { ... today ... },
 *      "1": { ... tomorrow ... },
 *      "2": { ... day after tomorrow ... },
 *      "3": { ... 3 days out ... }
 *   }
 *
 * We extract the "0" (today) entry as the current scale. We also handle
 * the legacy shape (top-level R/S/G or currentRScale/currentSScale/
 * currentGScale) for forward-compatibility.
 */
function parseScales(doc) {
  const out = {
    dateIssued: null,
    currentRScale: null,
    currentSScale: null,
    currentGScale: null,
    raw: doc,
  };
  if (!doc || typeof doc !== 'object') return out;

  // Shape A: keyed-by-day-offset object with "0" as today.
  const todayEntry = doc['0'] || doc.today;
  if (todayEntry && typeof todayEntry === 'object') {
    out.dateIssued = todayEntry.DateStamp || null;
    const rScale = normalizeScale(todayEntry.R);
    const sScale = normalizeScale(todayEntry.S);
    const gScale = normalizeScale(todayEntry.G);
    if (rScale) out.currentRScale = rScale;
    if (sScale) out.currentSScale = sScale;
    if (gScale) out.currentGScale = gScale;
  }

  // Shape B: top-level currentRScale / currentSScale / currentGScale
  if (doc.currentRScale || doc.currentSScale || doc.currentGScale) {
    if (!out.currentRScale) out.currentRScale = normalizeScale(doc.currentRScale);
    if (!out.currentSScale) out.currentSScale = normalizeScale(doc.currentSScale);
    if (!out.currentGScale) out.currentGScale = normalizeScale(doc.currentGScale);
  }

  // Shape C: top-level R/S/G as objects with a Scale field
  if (doc.R && !out.currentRScale) out.currentRScale = normalizeScale(doc.R);
  if (doc.S && !out.currentSScale) out.currentSScale = normalizeScale(doc.S);
  if (doc.G && !out.currentGScale) out.currentGScale = normalizeScale(doc.G);

  return out;

  function normalizeScale(v) {
    if (v == null) return null;
    if (typeof v === 'string') {
      const m = v.match(/\b([RSG])([1-5])\b/i);
      return m ? `${m[1].toUpperCase()}${m[2]}` : null;
    }
    if (typeof v === 'object' && v != null) {
      if (typeof v.Scale === 'string') {
        const m = v.Scale.match(/\b([RSG])([1-5])\b/i);
        return m ? `${m[1].toUpperCase()}${m[2]}` : null;
      }
      if (typeof v.Scale === 'number' && v.Scale >= 1 && v.Scale <= 5) {
        // Numeric scale without a letter — caller must supply the letter.
        return null;
      }
      if (typeof v.Text === 'string' && v.Text.toLowerCase() !== 'none') {
        const m = v.Text.match(/\b([RSG])([1-5])\b/i);
        return m ? `${m[1].toUpperCase()}${m[2]}` : null;
      }
    }
    return null;
  }
}

// --- Fetch -----------------------------------------------------------------

/**
 * Fetch a SWPC JSON endpoint. Returns the parsed JSON body on success.
 * Throws an Error with a descriptive message on HTTP failure, network
 * failure, or malformed JSON. The HTTP status code (when available) is
 * embedded in the error message so the caller can surface it in the
 * output document's `httpStatus` field.
 */
async function fetchJson(url) {
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
      throw new Error(`Request timed out after ${FETCH_TIMEOUT_MS}ms`);
    }
    throw new Error(`Network failure contacting SWPC: ${String(err)}`);
  }
  clearTimeout(timer);

  if (!response.ok) {
    let bodySnippet = '';
    try {
      bodySnippet = (await response.text()).slice(0, 300);
    } catch {
      /* ignore */
    }
    throw new Error(`HTTP ${response.status} ${response.statusText}${bodySnippet ? ` — ${bodySnippet}` : ''}`);
  }

  try {
    return await response.json();
  } catch (err) {
    throw new Error(`Malformed JSON from SWPC: ${String(err)}`);
  }
}

/**
 * Extract the HTTP status code embedded in an error message produced by
 * `fetchJson`. Returns 0 when no status code is found (e.g. network
 * failure or timeout — those errors don't carry an HTTP status).
 */
function statusFromError(errMsg) {
  if (typeof errMsg !== 'string') return 0;
  const m = errMsg.match(/HTTP\s+(\d{3})\b/);
  return m ? Number(m[1]) : 0;
}

// --- Main ------------------------------------------------------------------

async function main() {
  console.log('[fetch-swpc-science] Starting one-shot fetch from NOAA SWPC.');
  console.log(`  Alerts URL: ${ALERTS_URL}`);
  console.log(`  Scales URL: ${SCALES_URL}`);
  console.log(`  User-Agent: ${USER_AGENT}`);

  const now = new Date();

  // Step 1 — fetch alerts.json.
  let alertsRaw = [];
  let alertsError = null;
  let alertsHttpStatus = 0;
  try {
    const data = await fetchJson(ALERTS_URL);
    if (Array.isArray(data)) {
      alertsRaw = data;
      alertsHttpStatus = 200;
    } else {
      alertsError = 'alerts.json payload is not a JSON array';
    }
  } catch (err) {
    alertsError = String(err);
    alertsHttpStatus = statusFromError(alertsError);
    console.warn(`  [warn] alerts.json fetch failed: ${alertsError}`);
  }
  console.log(`  Alerts received: ${alertsRaw.length}`);

  // Step 2 — fetch noaa-scales.json.
  let scalesDoc = null;
  let scalesError = null;
  let scalesHttpStatus = 0;
  try {
    scalesDoc = await fetchJson(SCALES_URL);
    scalesHttpStatus = 200;
  } catch (err) {
    scalesError = String(err);
    scalesHttpStatus = statusFromError(scalesError);
    console.warn(`  [warn] noaa-scales.json fetch failed: ${scalesError}`);
  }

  // Step 3 — normalize alerts, filter to meaningful severity.
  const records = [];
  let droppedRoutine = 0;
  let droppedUnparseable = 0;
  for (const item of alertsRaw) {
    let record;
    try {
      record = normalizeAlert(item);
    } catch {
      droppedUnparseable++;
      continue;
    }
    if (!record) {
      droppedUnparseable++;
      continue;
    }
    // Filter: only keep alerts with meaningful severity.
    if (!record.severity || !MEANINGFUL_SEVERITY.has(record.severity)) {
      droppedRoutine++;
      continue;
    }
    records.push(record);
  }

  // Step 4 — parse scales summary.
  const scalesSummary = scalesDoc ? parseScales(scalesDoc) : null;

  // Step 5 — assemble output document.
  // Phase 9A.1: provenance metadata fields. `sourceAvailable` is true
  // when the primary alerts endpoint returned HTTP 200; `httpStatus` is
  // the alerts endpoint's status; `fetchError` is null on success and a
  // descriptive string on failure. The scales endpoint failure (if any)
  // is reported separately in `scalesError` and does NOT flip
  // sourceAvailable, because the alerts endpoint is the canonical
  // source for recordCount.
  const sourceAvailable = alertsHttpStatus === 200;
  const fetchError = alertsError;
  const httpStatus = alertsHttpStatus;

  const severityBreakdown = {};
  for (const r of records) {
    const sev = r.severity || 'none';
    severityBreakdown[sev] = (severityBreakdown[sev] || 0) + 1;
  }

  const document = {
    fetchedAt: now.toISOString(),
    source: SOURCE_NAME,
    sourceUrls: { alerts: ALERTS_URL, scales: SCALES_URL },
    sourceAvailable,
    httpStatus,
    fetchError,
    recordCount: records.length,
    alertsReceived: alertsRaw.length,
    alertsError,
    alertsHttpStatus,
    scalesError,
    scalesHttpStatus,
    totalRecords: records.length,
    droppedRoutine,
    droppedUnparseable,
    severityBreakdown,
    scales: scalesSummary,
    records,
  };

  // Step 6 — write atomically.
  await mkdir(dirname(OUTPUT_FILE), { recursive: true });
  const tmpFile = `${OUTPUT_FILE}.tmp`;
  await writeFile(tmpFile, JSON.stringify(document, null, 2) + '\n', 'utf8');
  await rename(tmpFile, OUTPUT_FILE);

  // Step 7 — report.
  const stats = await stat(OUTPUT_FILE);
  console.log('\n[fetch-swpc-science] SUCCESS');
  console.log(`  sourceAvailable:     ${sourceAvailable}`);
  console.log(`  httpStatus:          ${httpStatus}`);
  if (fetchError) console.log(`  fetchError:          ${fetchError}`);
  console.log(`  Alerts received:     ${alertsRaw.length}`);
  if (alertsError) console.log(`  Alerts error:        ${alertsError}`);
  if (scalesError) console.log(`  Scales error:        ${scalesError}`);
  console.log(`  Records kept:        ${records.length}`);
  console.log(`  Dropped (routine):   ${droppedRoutine}`);
  console.log(`  Dropped (unparseable): ${droppedUnparseable}`);
  if (scalesSummary) {
    console.log(`  Current scales:      R=${scalesSummary.currentRScale || '-'}, S=${scalesSummary.currentSScale || '-'}, G=${scalesSummary.currentGScale || '-'}`);
  }
  console.log(`  Output file:         ${OUTPUT_FILE}`);
  console.log(`  File size:           ${stats.size.toLocaleString()} bytes`);
  console.log(`  Fetched at (UTC):    ${document.fetchedAt}`);

  if (Object.keys(severityBreakdown).length > 0) {
    console.log('\n  Severity breakdown:');
    for (const [sev, count] of Object.entries(severityBreakdown).sort()) {
      console.log(`    ${sev.padEnd(6)} ${count}`);
    }
  }

  // Top alerts by severity.
  const sorted = [...records].sort((a, b) => {
    const sa = a.severity ? a.severity.charCodeAt(1) : 0;
    const sb = b.severity ? b.severity.charCodeAt(1) : 0;
    return sb - sa;
  });
  console.log('\n  Top alerts (by severity):');
  sorted.slice(0, 5).forEach((r, i) => {
    const titlePreview = (r.title || '(no title)').slice(0, 70);
    console.log(`    ${i + 1}. [${r.severity || '?'}] ${titlePreview}`);
    console.log(`        key=${r.scienceKey} code=${r.messageCode || '-'} serial=${r.serialNumber || '-'}`);
  });
  console.log('');
}

main().catch((err) => {
  fail('Unexpected failure.', { detail: String(err && err.stack ? err.stack : err) });
});
