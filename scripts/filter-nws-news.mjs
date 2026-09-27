/**
 * US News Engine — NWS newsworthiness filter (Phase 3B).
 *
 * Reads the raw active-alerts snapshot produced by Phase 3A
 * (data/nws-active-alerts.json) and selects only the alerts worth considering
 * as public news article candidates, writing them to
 * data/nws-news-candidates.json.
 *
 * This script does NOT create article files, does NOT touch the website, and
 * does NOT use AI. It is a pure data-selection step.
 *
 * Run manually:
 *   npm run filter:nws
 *   (or) bun run filter:nws
 *
 * No API key is required — it only reads a local JSON file.
 */

import { readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(__dirname, '..');
const INPUT_FILE = join(PROJECT_DIR, 'data', 'nws-active-alerts.json');
const OUTPUT_FILE = join(PROJECT_DIR, 'data', 'nws-news-candidates.json');

// ===========================================================================
// CONFIGURATION — editable newsworthiness rules
// ===========================================================================
// All lists below are intentionally explicit and editable. Adjust them here
// without touching the filtering logic. These drive which alerts become news
// candidates; nothing here is a permanent block — every list can be relaxed
// or tightened later.
// ===========================================================================

/**
 * High-priority event types. Any alert whose `event` matches one of these
 * (case-insensitive) is included as a HIGH-priority candidate, regardless of
 * severity (these events are inherently newsworthy).
 */
const HIGH_PRIORITY_EVENTS = [
  'Tornado Warning',
  'Tornado Watch',
  'Hurricane Warning',
  'Hurricane Watch',
  'Tropical Storm Warning',
  'Tropical Storm Watch',
  'Storm Surge Warning',
  'Storm Surge Watch',
  'Flash Flood Warning',
  'Flash Flood Emergency',
  'Extreme Wind Warning',
  'Blizzard Warning',
  'Ice Storm Warning',
  'Winter Storm Warning',
  'Dust Storm Warning',
  'Severe Thunderstorm Warning',
  'Severe Thunderstorm Watch',
  'Extreme Heat Warning',
  'Excessive Heat Warning',
  'Red Flag Warning',
  'Tsunami Warning',
  'Tsunami Advisory',
];

/**
 * Moderate-severity approved categories. A Moderate-severity alert is NOT a
 * candidate on severity alone — it becomes a MEDIUM-priority candidate only
 * if its event type is in this list.
 */
const MODERATE_APPROVED_EVENTS = [
  'Flood Warning',
  'Coastal Flood Warning',
  'Winter Weather Advisory',
  'Heat Advisory',
];

/**
 * Low-news-value event types that are excluded by default. These are common,
 * routine advisories that rarely warrant a news article.
 *
 * IMPORTANT: this exclusion is OVERRIDDEN when an alert's severity is Severe
 * or Extreme — a Severe-severity example of any of these is still included.
 */
const EXCLUDED_LOW_VALUE_EVENTS = [
  'Small Craft Advisory',
  'Marine Weather Statement',
  'Special Weather Statement',
  'Dense Fog Advisory',
  'Frost Advisory',
  'Freeze Warning',
  'Air Quality Alert',
];

/** Severities that always qualify as high-priority on severity alone. */
const HIGH_SEVERITIES = new Set(['Extreme', 'Severe']);

// ===========================================================================
// Helpers
// ===========================================================================

const normEvent = (s) => (s || '').trim().toLowerCase();

const HIGH_PRIORITY_SET = new Set(HIGH_PRIORITY_EVENTS.map(normEvent));
const MODERATE_APPROVED_SET = new Set(MODERATE_APPROVED_EVENTS.map(normEvent));
const EXCLUDED_SET = new Set(EXCLUDED_LOW_VALUE_EVENTS.map(normEvent));

/**
 * Parse an NWS ISO-8601 timestamp into a Date. Returns null on missing/invalid
 * input so callers can handle gracefully.
 */
function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Determine whether an alert has already expired. An alert is expired when
 * `ends` (if present) or `expires` (fallback) is in the past relative to the
 * supplied "now". If neither field parses, the alert is treated as NOT
 * expired so we never silently drop live alerts.
 */
function isExpired(alert, now) {
  const end = parseDate(alert.ends) || parseDate(alert.expires);
  if (!end) return false;
  return end.getTime() < now.getTime();
}

/**
 * Normalize a free-text label into a URL/filename-safe slug segment.
 * "Oklahoma County, OK" -> "oklahoma-county-ok"
 */
function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

/**
 * Build a future-friendly story key from event + areaDesc + effective date.
 * Example: "tornado-warning__oklahoma-county-ok__2026-09-27"
 *
 * Uses the FIRST area when areaDesc lists several (separated by ';'), so one
 * multi-county alert produces one stable story key.
 */
function buildStoryKey(alert) {
  const eventSlug = slugify(alert.event) || 'unknown-event';
  const firstArea = String(alert.areaDesc || '').split(';')[0] || 'unknown-area';
  const areaSlug = slugify(firstArea);
  const eff = parseDate(alert.effective);
  const dateSlug = eff ? eff.toISOString().slice(0, 10) : 'unknown-date';
  return `${eventSlug}__${areaSlug}__${dateSlug}`;
}

/**
 * The core newsworthiness decision. Returns one of:
 *   { include: true, priority: 'high'|'medium', reason: string }
 *   { include: false, reason: string }   // reason describes why excluded
 */
function evaluate(alert, now) {
  if (isExpired(alert, now)) {
    return { include: false, reason: 'Expired alert' };
  }

  const sev = alert.severity || 'Unknown';
  const evt = normEvent(alert.event);

  // 1) Severe / Extreme severity always qualifies as high priority and
  //    overrides the low-value exclusion list.
  if (HIGH_SEVERITIES.has(sev)) {
    return { include: true, priority: 'high', reason: `Severity is ${sev}` };
  }

  // 2) Explicitly excluded low-value events (non-Severe/Extreme) are dropped.
  if (EXCLUDED_SET.has(evt)) {
    return { include: false, reason: `Low-value event: ${alert.event}` };
  }

  // 3) High-priority event type qualifies as high priority.
  if (HIGH_PRIORITY_SET.has(evt)) {
    return {
      include: true,
      priority: 'high',
      reason: `High-priority event: ${alert.event}`,
    };
  }

  // 4) Moderate severity in an approved category becomes a medium candidate.
  if (sev === 'Moderate' && MODERATE_APPROVED_SET.has(evt)) {
    return {
      include: true,
      priority: 'medium',
      reason: `Moderate alert in approved category (${alert.event})`,
    };
  }

  // 5) Everything else is not newsworthy enough for a candidate.
  return { include: false, reason: `Not newsworthy (event: ${alert.event || 'unknown'}, severity: ${sev})` };
}

/**
 * Sort tier for the required output order:
 *   0 = Extreme severity
 *   1 = Severe severity
 *   2 = high priority (non-Severe/Extreme)
 *   3 = medium priority
 * Lower tier sorts first; within a tier, newest effective date first.
 */
function sortTier(candidate) {
  const sev = candidate.severity;
  if (sev === 'Extreme') return 0;
  if (sev === 'Severe') return 1;
  if (candidate.priority === 'high') return 2;
  return 3; // medium
}

function fail(message, detail) {
  console.error(`\n[filter-nws-news] ERROR: ${message}`);
  if (detail) console.error(`  Detail: ${detail}`);
  process.exit(1);
}

// ===========================================================================
// Main
// ===========================================================================

async function main() {
  console.log('[filter-nws-news] Starting newsworthiness filter.');
  console.log(`  Input:  ${INPUT_FILE}`);

  // --- Load the Phase 3A snapshot -------------------------------------------
  let raw;
  try {
    raw = await readFile(INPUT_FILE, 'utf8');
  } catch (err) {
    return fail('Could not read input file. Run `npm run fetch:nws` first.', String(err));
  }

  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    return fail('Input file is not valid JSON.', String(err));
  }

  const alerts = Array.isArray(doc.alerts) ? doc.alerts : [];
  const now = new Date();
  console.log(`  Input alerts: ${alerts.length}`);
  console.log(`  Filter time (UTC): ${now.toISOString()}`);

  // --- Deduplicate by official NWS alert id --------------------------------
  const seenIds = new Set();
  let duplicateCount = 0;
  const uniqueAlerts = [];
  for (const a of alerts) {
    const id = a?.id;
    if (!id) {
      // No id -> cannot dedupe; keep but it has no dedup protection.
      uniqueAlerts.push(a);
      continue;
    }
    if (seenIds.has(id)) {
      duplicateCount++;
      continue;
    }
    seenIds.add(id);
    uniqueAlerts.push(a);
  }
  if (duplicateCount > 0) {
    console.log(`  Removed duplicates by NWS id: ${duplicateCount}`);
  }

  // --- Evaluate every alert -------------------------------------------------
  const candidates = [];
  const exclusionBreakdown = {};
  for (const a of uniqueAlerts) {
    const decision = evaluate(a, now);
    if (!decision.include) {
      const key = decision.reason.replace(/\s*\(.*\)$/, '');
      exclusionBreakdown[key] = (exclusionBreakdown[key] || 0) + 1;
      continue;
    }
    candidates.push({
      id: a.id ?? null,
      storyKey: buildStoryKey(a),
      priority: decision.priority,
      selectedReason: decision.reason,
      event: a.event ?? null,
      headline: a.headline ?? null,
      severity: a.severity ?? null,
      certainty: a.certainty ?? null,
      urgency: a.urgency ?? null,
      areaDesc: a.areaDesc ?? null,
      senderName: a.senderName ?? null,
      effective: a.effective ?? null,
      onset: a.onset ?? null,
      expires: a.expires ?? null,
      ends: a.ends ?? null,
      description: a.description ?? null,
      instruction: a.instruction ?? null,
      response: a.response ?? null,
      status: a.status ?? null,
      affectedZones: Array.isArray(a.affectedZones) ? a.affectedZones : [],
      sourceUrl: a.sourceUrl ?? null,
    });
  }

  // --- Sort: Extreme -> Severe -> high -> medium; newest effective first ----
  candidates.sort((a, b) => {
    const ta = sortTier(a);
    const tb = sortTier(b);
    if (ta !== tb) return ta - tb;
    const ea = parseDate(a.effective)?.getTime() ?? 0;
    const eb = parseDate(b.effective)?.getTime() ?? 0;
    return eb - ea; // newest first
  });

  // --- Assemble output document --------------------------------------------
  const highPriorityCount = candidates.filter((c) => c.priority === 'high').length;
  const mediumPriorityCount = candidates.filter((c) => c.priority === 'medium').length;
  const excludedCount = uniqueAlerts.length - candidates.length;

  const output = {
    generatedAt: now.toISOString(),
    source: 'National Weather Service',
    inputAlertCount: alerts.length,
    candidateCount: candidates.length,
    highPriorityCount,
    mediumPriorityCount,
    candidates,
  };

  // --- Atomic write --------------------------------------------------------
  await mkdir(dirname(OUTPUT_FILE), { recursive: true });
  const tmp = `${OUTPUT_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(output, null, 2) + '\n', 'utf8');
  await rename(tmp, OUTPUT_FILE);

  const stats = await stat(OUTPUT_FILE);
  console.log('\n[filter-nws-news] SUCCESS');
  console.log(`  Output file:          ${OUTPUT_FILE}`);
  console.log(`  File size:            ${stats.size.toLocaleString()} bytes`);
  console.log(`  Generated at (UTC):   ${output.generatedAt}`);
  console.log(`  Input alerts:         ${output.inputAlertCount}`);
  console.log(`  Duplicates removed:   ${duplicateCount}`);
  console.log(`  Candidates selected:  ${output.candidateCount}`);
  console.log(`    high priority:      ${highPriorityCount}`);
  console.log(`    medium priority:    ${mediumPriorityCount}`);
  console.log(`  Excluded:             ${excludedCount}`);
  console.log('\n  Exclusion breakdown:');
  for (const [reason, count] of Object.entries(exclusionBreakdown).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(count).padStart(4)}  ${reason}`);
  }

  // --- Top 10 candidates (event / severity / area / storyKey) --------------
  console.log('\n  Top 10 candidates:');
  candidates.slice(0, 10).forEach((c, i) => {
    const area = String(c.areaDesc || '').split(';')[0] || '(no area)';
    console.log(`    ${String(i + 1).padStart(2)}. ${c.event} [${c.severity}] — ${area}`);
    console.log(`        storyKey: ${c.storyKey}`);
  });

  // --- Count grouped by event type -----------------------------------------
  const byEvent = {};
  for (const c of candidates) {
    byEvent[c.event || '(none)'] = (byEvent[c.event || '(none)'] || 0) + 1;
  }
  console.log('\n  Candidates grouped by event type:');
  for (const [event, count] of Object.entries(byEvent).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(count).padStart(4)}  ${event}`);
  }
  console.log('');
}

main().catch((err) => fail('Unexpected failure.', String(err && err.stack ? err.stack : err)));
