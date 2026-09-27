/**
 * US News Engine — Earthquake newsworthiness filter (Phase 8A).
 *
 * Reads data/earthquakes/usgs-earthquakes.json (produced by the fetcher),
 * applies a documented newsworthiness filter, and writes the selected
 * candidates to data/earthquakes/earthquake-news-candidates.json.
 *
 * Newsworthiness thresholds (INCLUDE if ANY of):
 *   - Magnitude >= 5.0 AND isUS                        (significant U.S. earthquake)
 *   - Magnitude >= 4.0 AND isUS AND (felt >= 100
 *       OR alert in [yellow,orange,red] OR tsunami)   (impact-bearing U.S. event)
 *   - Magnitude >= 6.0                                  (major global event)
 *   - USGS alert level is yellow, orange, or red        (PAGER impact)
 *   - tsunami === true                                  (tsunami warning)
 *   - USGS significance >= 500 AND isUS                 (notable U.S. event)
 *   - Magnitude >= 3.5 AND isUS AND felt >= 500         (widely felt)
 *   - Magnitude >= 4.5 AND place mentions Alaska,
 *       Hawaii, or Puerto Rico                          (active U.S. seismic zones)
 *
 * EXCLUDE if:
 *   - status === "deleted"
 *   - Magnitude < 3.0 (too small)
 *   - Magnitude is null
 *
 * Each selected candidate gets `selectedReason` and `priority`
 * ("high" for M5+ or alert/tsunami, "medium" for M4+ felt).
 *
 * This script does NOT create article files, does NOT touch the website,
 * and does NOT use AI. It is a pure data-selection step.
 *
 * Run manually:
 *   npm run filter:earthquakes
 */

import { readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(__dirname, '..');

const INPUT_FILE = join(PROJECT_DIR, 'data', 'earthquakes', 'usgs-earthquakes.json');
const OUTPUT_FILE = join(PROJECT_DIR, 'data', 'earthquakes', 'earthquake-news-candidates.json');

// Active U.S. seismic zones that get an expanded threshold for inclusion.
const ACTIVE_US_SEISMIC_ZONES = ['alaska', 'hawaii', 'puerto rico'];

// Alert levels that imply real PAGER impact.
const IMPACT_ALERT_LEVELS = new Set(['yellow', 'orange', 'red']);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fail(message, detail) {
  console.error(`\n[filter-earthquake-news] ERROR: ${message}`);
  if (detail) console.error(`  Detail: ${detail}`);
  process.exit(1);
}

function lower(s) {
  return (s == null ? '' : String(s)).toLowerCase();
}

function num(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const m = value.replace(/,/g, '').match(/-?\d+(\.\d+)?/);
    return m ? Number(m[0]) : null;
  }
  return null;
}

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * The core newsworthiness decision.
 *
 * Returns:
 *   { include: true,  priority: 'high'|'medium', selectedReason: string }
 *   { include: false, selectedReason: string }
 */
function evaluate(eq) {
  // --- EXCLUDE checks (these short-circuit before any INCLUDE check) -------

  if (eq.status === 'deleted') {
    return {
      include: false,
      selectedReason: 'Excluded: status=deleted',
    };
  }

  const mag = num(eq.magnitude);

  if (mag == null) {
    return {
      include: false,
      selectedReason: 'Excluded: magnitude is null or non-numeric',
    };
  }

  if (mag < 3.0) {
    return {
      include: false,
      selectedReason: `Excluded: magnitude ${mag} < 3.0 (too small)`,
    };
  }

  // --- INCLUDE checks -----------------------------------------------------
  const reasons = [];
  const felt = num(eq.felt);
  const sig = num(eq.significance);
  const alert = lower(eq.alert);
  const tsunami = eq.tsunami === true;
  const isUS = eq.isUS === true;
  const placeLower = lower(eq.place);

  // 1) M5+ and US.
  if (mag >= 5.0 && isUS) {
    reasons.push(`M${mag} >= 5.0 and isUS`);
  }

  // 2) M4+ and US with felt/alert/tsunami impact.
  if (mag >= 4.0 && isUS) {
    const subReasons = [];
    if (felt != null && felt >= 100) subReasons.push(`felt=${felt} >= 100`);
    if (IMPACT_ALERT_LEVELS.has(alert)) subReasons.push(`alert=${alert}`);
    if (tsunami) subReasons.push('tsunami=true');
    if (subReasons.length) {
      reasons.push(`M${mag} >= 4.0 and isUS with ${subReasons.join('; ')}`);
    }
  }

  // 3) M6+ anywhere.
  if (mag >= 6.0) {
    reasons.push(`M${mag} >= 6.0 (major global event)`);
  }

  // 4) PAGER alert yellow/orange/red.
  if (IMPACT_ALERT_LEVELS.has(alert)) {
    reasons.push(`USGS alert level ${alert}`);
  }

  // 5) Tsunami.
  if (tsunami) {
    reasons.push('tsunami warning issued');
  }

  // 6) USGS significance >= 500 and US.
  if (sig != null && sig >= 500 && isUS) {
    reasons.push(`USGS significance ${sig} >= 500 and isUS`);
  }

  // 7) M3.5+ and US and widely felt (>=500 felt reports).
  if (mag >= 3.5 && isUS && felt != null && felt >= 500) {
    reasons.push(`M${mag} >= 3.5, isUS, felt=${felt} >= 500 (widely felt)`);
  }

  // 8) M4.5+ in Alaska/Hawaii/Puerto Rico.
  if (mag >= 4.5 && ACTIVE_US_SEISMIC_ZONES.some((z) => placeLower.includes(z))) {
    reasons.push(`M${mag} >= 4.5 in active U.S. seismic zone (${placeLower})`);
  }

  if (reasons.length === 0) {
    return {
      include: false,
      selectedReason: 'Excluded: no newsworthiness trigger matched',
    };
  }

  // --- Priority decision --------------------------------------------------
  // "high" for M5+ events (significant), or any PAGER alert yellow/orange/red,
  // or any tsunami event.
  // "medium" otherwise (e.g., M4+ felt events in the U.S.).
  const highPriority =
    (mag >= 5.0) ||
    IMPACT_ALERT_LEVELS.has(alert) ||
    tsunami;

  const priority = highPriority ? 'high' : 'medium';

  return {
    include: true,
    priority,
    selectedReason: `Selected: ${reasons.join('; ')}`,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('[filter-earthquake-news] Starting newsworthiness filter.');
  console.log(`  Input:  ${INPUT_FILE}`);
  console.log(`  Output: ${OUTPUT_FILE}`);

  // --- Load input ---------------------------------------------------------
  let raw;
  try {
    raw = await readFile(INPUT_FILE, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return fail(
        'Could not read input file. Run `npm run fetch:earthquakes` first.',
        String(err),
      );
    }
    return fail('Could not read input file.', String(err));
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    return fail('Input file is not valid JSON.', String(err));
  }

  const earthquakes = Array.isArray(doc.earthquakes) ? doc.earthquakes : [];
  const now = new Date();
  console.log(`  Input earthquakes: ${earthquakes.length}`);
  console.log(`  Filter time (UTC): ${now.toISOString()}`);

  // --- Evaluate every earthquake ------------------------------------------
  const candidates = [];
  const exclusionBreakdown = {};
  for (const eq of earthquakes) {
    const decision = evaluate(eq);
    if (!decision.include) {
      const key = decision.selectedReason
        .replace(/^Excluded:\s*/, '')
        .split(/[(.]/)[0]
        .trim();
      exclusionBreakdown[key] = (exclusionBreakdown[key] || 0) + 1;
      continue;
    }
    candidates.push({
      earthquakeKey: eq.earthquakeKey,
      source: eq.source,
      sourceId: eq.sourceId,
      magnitude: eq.magnitude,
      magnitudeType: eq.magnitudeType,
      place: eq.place,
      title: eq.title,
      time: eq.time,
      updated: eq.updated,
      timezone: eq.timezone,
      url: eq.url,
      detailUrl: eq.detailUrl,
      felt: eq.felt,
      cdi: eq.cdi,
      mmi: eq.mmi,
      alert: eq.alert,
      status: eq.status,
      tsunami: eq.tsunami,
      significance: eq.significance,
      network: eq.network,
      code: eq.code,
      ids: eq.ids,
      sources: eq.sources,
      types: eq.types,
      nst: eq.nst,
      dmin: eq.dmin,
      rms: eq.rms,
      gap: eq.gap,
      depthKm: eq.depthKm,
      latitude: eq.latitude,
      longitude: eq.longitude,
      country: eq.country,
      state: eq.state,
      nearestPlace: eq.nearestPlace,
      isUS: eq.isUS,
      priority: decision.priority,
      selectedReason: decision.selectedReason,
    });
  }

  // --- Sort: high priority first, then magnitude desc, then newest time --
  candidates.sort((a, b) => {
    if (a.priority !== b.priority) {
      return a.priority === 'high' ? -1 : 1;
    }
    const ma = num(a.magnitude) ?? -Infinity;
    const mb = num(b.magnitude) ?? -Infinity;
    if (mb !== ma) return mb - ma;
    const ta = parseDate(a.time)?.getTime() ?? 0;
    const tb = parseDate(b.time)?.getTime() ?? 0;
    return tb - ta;
  });

  // --- Assemble output document -------------------------------------------
  const highPriorityCount = candidates.filter((c) => c.priority === 'high').length;
  const mediumPriorityCount = candidates.filter((c) => c.priority === 'medium').length;
  const usCandidateCount = candidates.filter((c) => c.isUS).length;

  const output = {
    generatedAt: now.toISOString(),
    source: doc.source || 'U.S. Geological Survey',
    sourceUrls: doc.sourceUrls || [],
    feedsUsed: doc.feedsUsed || [],
    inputEarthquakeCount: earthquakes.length,
    candidateCount: candidates.length,
    highPriorityCount,
    mediumPriorityCount,
    usCandidateCount,
    candidates,
  };

  // --- Atomic write --------------------------------------------------------
  await mkdir(dirname(OUTPUT_FILE), { recursive: true });
  const tmp = `${OUTPUT_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(output, null, 2) + '\n', 'utf8');
  await rename(tmp, OUTPUT_FILE);

  const stats = await stat(OUTPUT_FILE);
  console.log('\n[filter-earthquake-news] SUCCESS');
  console.log(`  Output file:          ${OUTPUT_FILE}`);
  console.log(`  File size:            ${stats.size.toLocaleString()} bytes`);
  console.log(`  Generated at (UTC):   ${output.generatedAt}`);
  console.log(`  Input earthquakes:    ${output.inputEarthquakeCount}`);
  console.log(`  Candidates selected:  ${output.candidateCount}`);
  console.log(`    high priority:      ${highPriorityCount}`);
  console.log(`    medium priority:    ${mediumPriorityCount}`);
  console.log(`    U.S.-relevant:      ${usCandidateCount}`);
  console.log(`  Excluded:             ${earthquakes.length - candidates.length}`);

  console.log('\n  Exclusion breakdown:');
  const exclusionEntries = Object.entries(exclusionBreakdown).sort((a, b) => b[1] - a[1]);
  if (exclusionEntries.length === 0) {
    console.log('    (none)');
  } else {
    for (const [reason, count] of exclusionEntries) {
      console.log(`    ${String(count).padStart(4)}  ${reason}`);
    }
  }

  // --- Top 10 candidates --------------------------------------------------
  console.log('\n  Top 10 candidates:');
  if (candidates.length === 0) {
    console.log('    (no candidates selected)');
  } else {
    candidates.slice(0, 10).forEach((c, i) => {
      const placePreview = (c.place || c.title || '(no place)').slice(0, 60);
      console.log(
        `    ${String(i + 1).padStart(2)}. [${c.priority}] M${c.magnitude} | ${placePreview} | ${c.isUS ? 'US' : 'non-US'}`,
      );
      console.log(`        key: ${c.earthquakeKey}`);
      console.log(`        why: ${c.selectedReason}`);
    });
  }

  // --- Group by alert level ----------------------------------------------
  const byAlert = {};
  for (const c of candidates) {
    const a = c.alert || '(none)';
    byAlert[a] = (byAlert[a] || 0) + 1;
  }
  console.log('\n  Candidates grouped by alert level:');
  const alertEntries = Object.entries(byAlert).sort((a, b) => b[1] - a[1]);
  if (alertEntries.length === 0) {
    console.log('    (none)');
  } else {
    for (const [alert, count] of alertEntries) {
      console.log(`    ${String(count).padStart(4)}  ${alert}`);
    }
  }
  console.log('');
}

main().catch((err) => fail('Unexpected failure.', String(err && err.stack ? err.stack : err)));
