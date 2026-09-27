/**
 * US News Engine — Earthquake newsworthiness filter (Phase 8A.1).
 *
 * Reads data/earthquakes/usgs-earthquakes.json (produced by the fetcher),
 * applies a U.S.-focused newsworthiness filter with publishEligible gating,
 * and writes candidates to data/earthquakes/earthquake-news-candidates.json.
 *
 * KEY CHANGE from Phase 8A:
 *   - Removed "M6+ anywhere" and "alert/tsunami anywhere" as publication triggers
 *   - publishEligible requires isUSRelevant = true
 *   - International events are retained internally but publishEligible = false
 *   - Added scope, eligibilityReasons, exclusionReasons fields
 *   - Added USGS detail product metadata (ShakeMap, DYFI, etc.)
 *
 * PUBLICATION THRESHOLDS (require isUSRelevant = true):
 *   - M5.0+ U.S.-relevant
 *   - M4.0+ plus >=100 felt reports
 *   - M4.0+ plus Yellow/Orange/Red USGS alert
 *   - tsunami flag affecting U.S.-relevant event
 *   - significance >=500 and U.S.-relevant
 *   - M3.5+ with >=500 felt reports
 *   - M4.5+ Alaska/Hawaii/Puerto Rico/U.S. territory
 *
 * EXCLUDE if:
 *   - status === "deleted"
 *   - Magnitude < 3.0
 *   - Magnitude is null
 *
 * Run:
 *   npm run filter:earthquakes
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(__dirname, '..');
const INPUT_FILE = join(PROJECT_DIR, 'data', 'earthquakes', 'usgs-earthquakes.json');
const OUTPUT_FILE = join(PROJECT_DIR, 'data', 'earthquakes', 'earthquake-news-candidates.json');

const IMPACT_ALERT_LEVELS = new Set(['yellow', 'orange', 'red']);
const ACTIVE_US_SEISMIC_ZONES = ['alaska', 'hawaii', 'puerto rico', 'guam', 'northern mariana', 'american samoa', 'virgin islands'];

// ===========================================================================
// Newsworthiness evaluation (U.S.-focused)
// ===========================================================================

function evaluate(eq) {
  const mag = eq.magnitude;
  const isUS = eq.isUS === true;
  const felt = eq.felt;
  const alert = eq.alert;
  const tsunami = eq.tsunami === true;
  const sig = eq.significance;
  const placeLower = (eq.place || '').toLowerCase();
  const status = eq.status;

  // --- EXCLUDE: deleted, too small, null magnitude ---
  if (status === 'deleted') {
    return { include: false, publishEligible: false, reason: 'Excluded: deleted event' };
  }
  if (mag == null || isNaN(mag)) {
    return { include: false, publishEligible: false, reason: 'Excluded: magnitude is null' };
  }
  if (mag < 3.0) {
    return { include: false, publishEligible: false, reason: 'Excluded: magnitude < 3.0' };
  }

  // --- Determine U.S. relevance and scope ---
  const scope = isUS ? 'us' : 'international';

  // --- Evaluate publication eligibility (REQUIRES isUS) ---
  const eligibilityReasons = [];
  const exclusionReasons = [];

  // Rule 1: M5.0+ U.S.-relevant
  if (mag >= 5.0 && isUS) {
    eligibilityReasons.push(`M${mag} >= 5.0 and U.S.-relevant`);
  }

  // Rule 2: M4.0+ plus >=100 felt reports (U.S.)
  if (mag >= 4.0 && isUS && felt != null && felt >= 100) {
    eligibilityReasons.push(`M${mag} >= 4.0, U.S., felt=${felt} >= 100`);
  }

  // Rule 3: M4.0+ plus alert (U.S.)
  if (mag >= 4.0 && isUS && IMPACT_ALERT_LEVELS.has(alert)) {
    eligibilityReasons.push(`M${mag} >= 4.0, U.S., alert=${alert}`);
  }

  // Rule 4: tsunami affecting U.S.-relevant event
  if (tsunami && isUS) {
    eligibilityReasons.push('tsunami flag and U.S.-relevant');
  }

  // Rule 5: significance >= 500 and U.S.
  if (sig != null && sig >= 500 && isUS) {
    eligibilityReasons.push(`significance ${sig} >= 500 and U.S.`);
  }

  // Rule 6: M3.5+ with >=500 felt (U.S.)
  if (mag >= 3.5 && isUS && felt != null && felt >= 500) {
    eligibilityReasons.push(`M${mag} >= 3.5, U.S., felt=${felt} >= 500`);
  }

  // Rule 7: M4.5+ Alaska/Hawaii/Puerto Rico/U.S. territory
  if (mag >= 4.5 && ACTIVE_US_SEISMIC_ZONES.some((z) => placeLower.includes(z))) {
    eligibilityReasons.push(`M${mag} >= 4.5 in active U.S. seismic zone`);
  }

  // --- Determine include (newsworthy enough to track) vs exclude ---
  // Include if ANY eligibility reason OR if it's a notable global event (M6+)
  // for internal tracking, but publishEligible requires isUS.
  const isNotableGlobal = mag >= 6.0;
  const hasAlertGlobal = IMPACT_ALERT_LEVELS.has(alert);
  const hasTsunamiGlobal = tsunami;

  const include = eligibilityReasons.length > 0 || isNotableGlobal || hasAlertGlobal || hasTsunamiGlobal;

  if (!include) {
    return {
      include: false,
      publishEligible: false,
      reason: 'Excluded: no newsworthiness trigger matched',
    };
  }

  // --- Determine publishEligible ---
  const publishEligible = isUS && eligibilityReasons.length > 0;

  if (!publishEligible) {
    if (!isUS) {
      exclusionReasons.push('Not U.S.-relevant (international scope)');
    } else if (eligibilityReasons.length === 0) {
      exclusionReasons.push('U.S. event but below publication thresholds');
    }
  }

  // --- Priority ---
  const highPriority = (mag >= 5.0 && isUS) || (isUS && IMPACT_ALERT_LEVELS.has(alert)) || (tsunami && isUS);
  const priority = highPriority ? 'high' : 'medium';

  // --- Build selected reason ---
  const allReasons = [...eligibilityReasons];
  if (isNotableGlobal && !isUS) allReasons.push(`M${mag} >= 6.0 (notable global, internal only)`);
  if (hasAlertGlobal && !isUS) allReasons.push(`alert=${alert} (global, internal only)`);
  if (hasTsunamiGlobal && !isUS) allReasons.push('tsunami (global, internal only)');

  return {
    include: true,
    publishEligible,
    priority,
    scope,
    isUSRelevant: isUS,
    eligibilityReasons,
    exclusionReasons,
    selectedReason: `Selected: ${allReasons.join('; ')}`,
  };
}

// ===========================================================================
// USGS detail product inspection
// ===========================================================================

/**
 * Fetch the USGS detail JSON for an earthquake and inspect its products.
 * Records ShakeMap, DYFI, moment tensor, and tsunami product availability.
 * Does NOT fabricate URLs — only records what USGS explicitly provides.
 */
async function inspectUsgsProducts(eq) {
  const detailUrl = eq.detailUrl;
  if (!detailUrl) {
    return {
      hasShakeMap: false,
      shakeMapProductUrl: null,
      shakeMapImageUrl: null,
      hasDyfi: false,
      hasMomentTensor: false,
      hasTsunamiProduct: false,
    };
  }

  try {
    const res = await fetch(detailUrl, {
      headers: { 'User-Agent': 'USNewsEngine/1.0 (https://usa-news-engine.forexwizardy.workers.dev)' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      return {
        hasShakeMap: false,
        shakeMapProductUrl: null,
        shakeMapImageUrl: null,
        hasDyfi: false,
        hasMomentTensor: false,
        hasTsunamiProduct: false,
        detailFetchError: `HTTP ${res.status}`,
      };
    }
    const data = await res.json();
    const products = data.properties?.products || {};

    const hasShakeMap = !!products.shakemap;
    let shakeMapProductUrl = null;
    let shakeMapImageUrl = null;

    if (hasShakeMap) {
      const sm = products.shakemap;
      // Get the first available ShakeMap product
      const firstKey = Object.keys(sm)[0];
      const smEntry = sm[firstKey]?.[0];
      if (smEntry) {
        shakeMapProductUrl = smEntry.properties?.map || smEntry.properties?.url || null;
        // Look for the intensity image
        if (smEntry.contents) {
          const intensityImage = smEntry.contents['intensity.jpg'] || smEntry.contents['download/intensity.jpg'];
          if (intensityImage?.url) {
            shakeMapImageUrl = intensityImage.url;
          }
        }
      }
    }

    return {
      hasShakeMap,
      shakeMapProductUrl,
      shakeMapImageUrl,
      hasDyfi: !!products.dyfi,
      hasMomentTensor: !!products['moment-tensor'],
      hasTsunamiProduct: !!products.tsunami,
    };
  } catch {
    return {
      hasShakeMap: false,
      shakeMapProductUrl: null,
      shakeMapImageUrl: null,
      hasDyfi: false,
      hasMomentTensor: false,
      hasTsunamiProduct: false,
      detailFetchError: 'fetch failed',
    };
  }
}

// ===========================================================================
// Main
// ===========================================================================

async function main() {
  console.log('[filter-earthquake-news] Starting newsworthiness filter (Phase 8A.1).');
  console.log(`  Input:  ${INPUT_FILE}`);
  console.log(`  Output: ${OUTPUT_FILE}`);

  let raw;
  try {
    raw = await readFile(INPUT_FILE, 'utf8');
  } catch (err) {
    console.error('  ERROR: usgs-earthquakes.json not found. Run fetch:earthquakes first.');
    process.exit(1);
  }
  const doc = JSON.parse(raw);
  const earthquakes = Array.isArray(doc.earthquakes) ? doc.earthquakes : [];
  console.log(`  Input earthquakes: ${earthquakes.length}`);

  const candidates = [];
  const exclusionBreakdown = {};
  let usRelevantCount = 0;
  let publishEligibleCount = 0;
  let internationalNotableCount = 0;

  for (const eq of earthquakes) {
    const decision = evaluate(eq);
    if (!decision.include) {
      const key = decision.reason.replace(/^Excluded:\s*/, '').split(/[(.]/)[0].trim();
      exclusionBreakdown[key] = (exclusionBreakdown[key] || 0) + 1;
      continue;
    }

    if (decision.isUSRelevant) usRelevantCount++;
    if (decision.publishEligible) publishEligibleCount++;
    if (decision.scope === 'international') internationalNotableCount++;

    // For publishEligible candidates, fetch USGS detail products
    let usgsProducts = null;
    if (decision.publishEligible) {
      console.log(`  Fetching USGS detail for ${eq.earthquakeKey}...`);
      usgsProducts = await inspectUsgsProducts(eq);
      console.log(`    ShakeMap: ${usgsProducts.hasShakeMap} | DYFI: ${usgsProducts.hasDyfi} | MT: ${usgsProducts.hasMomentTensor} | Tsunami: ${usgsProducts.hasTsunamiProduct}`);
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
      isUSRelevant: decision.isUSRelevant,
      scope: decision.scope,
      publishEligible: decision.publishEligible,
      priority: decision.priority,
      eligibilityReasons: decision.eligibilityReasons,
      exclusionReasons: decision.exclusionReasons,
      selectedReason: decision.selectedReason,
      // USGS detail product metadata (only for publishEligible candidates)
      hasShakeMap: usgsProducts?.hasShakeMap ?? false,
      shakeMapProductUrl: usgsProducts?.shakeMapProductUrl ?? null,
      shakeMapImageUrl: usgsProducts?.shakeMapImageUrl ?? null,
      hasDyfi: usgsProducts?.hasDyfi ?? false,
      hasMomentTensor: usgsProducts?.hasMomentTensor ?? false,
      hasTsunamiProduct: usgsProducts?.hasTsunamiProduct ?? false,
    });
  }

  // Sort: publishEligible first, then priority, then magnitude desc
  candidates.sort((a, b) => {
    if (a.publishEligible !== b.publishEligible) return b.publishEligible ? 1 : -1;
    if (a.priority !== b.priority) return a.priority === 'high' ? -1 : 1;
    return (b.magnitude || 0) - (a.magnitude || 0);
  });

  const output = {
    generatedAt: new Date().toISOString(),
    source: 'U.S. Geological Survey',
    inputEarthquakeCount: earthquakes.length,
    candidateCount: candidates.length,
    usRelevantCount,
    publishEligibleCount,
    internationalNotableCount,
    exclusionBreakdown,
    candidates,
  };

  await mkdir(dirname(OUTPUT_FILE), { recursive: true });
  const tmp = `${OUTPUT_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(output, null, 2) + '\n', 'utf8');
  await rename(tmp, OUTPUT_FILE);

  console.log(`\n  Output: ${OUTPUT_FILE}`);
  console.log(`  Total candidates: ${candidates.length}`);
  console.log(`  U.S.-relevant: ${usRelevantCount}`);
  console.log(`  publishEligible: ${publishEligibleCount}`);
  console.log(`  International notable (internal only): ${internationalNotableCount}`);
  console.log(`  Excluded: ${earthquakes.length - candidates.length}`);
  console.log('\n  Exclusion breakdown:');
  for (const [reason, count] of Object.entries(exclusionBreakdown).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(count).padStart(4)}  ${reason}`);
  }

  // Top candidates
  console.log('\n  Top candidates:');
  candidates.slice(0, 10).forEach((c, i) => {
    const status = c.publishEligible ? `[${c.priority}, eligible]` : `[${c.scope}, not eligible]`;
    console.log(`    ${i + 1}. ${status} M${c.magnitude} — ${c.place} (key=${c.earthquakeKey})`);
    if (c.publishEligible) {
      console.log(`        ShakeMap: ${c.hasShakeMap} | DYFI: ${c.hasDyfi} | felt: ${c.felt || 0}`);
    }
  });
  console.log('');
}

main().catch((err) => {
  console.error(`[filter-earthquake-news] FATAL: ${err.message}`);
  process.exit(1);
});
