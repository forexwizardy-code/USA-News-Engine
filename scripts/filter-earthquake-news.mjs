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

// Remote Alaskan/Aleutian regions where M4.5 alone is not consumer-relevant
const REMOTE_ALASKA_REGIONS = [
  'rat islands', 'aleutian islands', 'andreanof islands', 'fox islands',
  'near islands', 'komandorski', 'kodiak island', 'shumagin',
  'semisopochnoi', 'amchitka', 'buldir', 'tanaga', 'adak',
  'attu', 'kiska', 'amukta', 'chaluka',
];

// Lower 48 state names (for region-based threshold logic)
const LOWER_48_STATES = [
  'alabama', 'arizona', 'arkansas', 'california', 'colorado', 'connecticut',
  'delaware', 'florida', 'georgia', 'idaho', 'illinois', 'indiana', 'iowa',
  'kansas', 'kentucky', 'louisiana', 'maine', 'maryland', 'massachusetts',
  'michigan', 'minnesota', 'mississippi', 'missouri', 'montana', 'nebraska',
  'nevada', 'new hampshire', 'new jersey', 'new mexico', 'new york',
  'north carolina', 'north dakota', 'ohio', 'oklahoma', 'oregon',
  'pennsylvania', 'rhode island', 'south carolina', 'south dakota',
  'tennessee', 'texas', 'utah', 'vermont', 'virginia', 'washington',
  'west virginia', 'wisconsin', 'wyoming',
];

// ===========================================================================
// Remote region detection
// ===========================================================================

/**
 * Determine if an earthquake is in a remote region with no demonstrated
 * consumer impact. Remote regions are areas far from populated communities
 * where routine M4-M5 activity has little news value.
 */
function detectRemoteRegion(place, state) {
  const placeLower = (place || '').toLowerCase();
  const stateLower = (state || '').toLowerCase();

  // Remote Alaska/Aleutian
  for (const region of REMOTE_ALASKA_REGIONS) {
    if (placeLower.includes(region)) {
      return { remoteRegion: true, remoteReason: `Remote Alaska region: ${region}` };
    }
  }

  // Remote offshore events (no named populated place nearby)
  if (placeLower.includes('offshore') && !placeLower.match(/of\s+\w+,\s*(alaska|hawaii|california|oregon|washington|puerto rico)/i)) {
    // Offshore but not near a named populated U.S. community
    if (stateLower === 'alaska' || placeLower.includes('aleutian') || placeLower.includes('rat islands')) {
      return { remoteRegion: true, remoteReason: 'Remote offshore Alaska' };
    }
  }

  return { remoteRegion: false, remoteReason: null };
}

// ===========================================================================
// Impact relevance evaluation (consumer/news value)
// ===========================================================================

/**
 * Determine if a U.S.-relevant earthquake has enough consumer/news impact
 * to be worth publishing. This is the SECOND gate after U.S. relevance.
 *
 * Remote Alaska/Aleutian events require stronger signals (M5+, felt 100+,
 * alert, tsunami, or sig 500+).
 * Hawaii/Puerto Rico/territories: M4+ with some impact signal.
 * Lower 48: M4+ near populated areas, or M3.5+ with strong felt reports.
 */
function evaluateImpactRelevance(eq, remoteInfo) {
  const mag = eq.magnitude;
  const felt = eq.felt;
  const alert = eq.alert;
  const tsunami = eq.tsunami === true;
  const sig = eq.significance;
  const placeLower = (eq.place || '').toLowerCase();
  const stateLower = (eq.state || '').toLowerCase();
  const isRemote = remoteInfo.remoteRegion;

  const impactReasons = [];
  const impactExclusions = [];

  // --- Strong impact signals (apply to ALL U.S. regions) ---
  if (mag >= 5.0) impactReasons.push(`M${mag} >= 5.0`);
  if (felt != null && felt >= 100) impactReasons.push(`felt=${felt} >= 100`);
  if (IMPACT_ALERT_LEVELS.has(alert)) impactReasons.push(`alert=${alert}`);
  if (tsunami) impactReasons.push('tsunami flag');
  if (sig != null && sig >= 500) impactReasons.push(`significance ${sig} >= 500`);

  // --- Region-specific impact thresholds ---

  if (isRemote) {
    // Remote Alaska/Aleutian: require stronger signals (already checked above)
    // M4.5 alone is NOT enough for remote regions
    if (impactReasons.length === 0) {
      impactExclusions.push(`Remote region (${remoteInfo.remoteReason}) without strong impact signals (M5+, felt 100+, alert, tsunami, or sig 500+)`);
    }
  } else if (stateLower === 'alaska' || placeLower.includes('alaska')) {
    // Non-remote Alaska: M4.5+ may qualify if near populated areas
    if (mag >= 4.5 && impactReasons.length === 0) {
      // Check if near a populated Alaska community
      const populatedAlaska = ['anchorage', 'fairbanks', 'juneau', 'wasilla', 'kenai', 'kodiak city', 'sitka', 'ketchikan', 'palmer', 'homer', 'valdez'];
      const nearPopulated = populatedAlaska.some(p => placeLower.includes(p));
      if (nearPopulated) {
        impactReasons.push(`M${mag} near populated Alaska community`);
      } else {
        impactExclusions.push('Alaska event but not near populated community and no strong impact signals');
      }
    }
  } else if (stateLower === 'hawaii' || placeLower.includes('hawaii')) {
    // Hawaii: M4+ with some impact signal
    if (mag >= 4.0 && (felt != null && felt >= 10 || IMPACT_ALERT_LEVELS.has(alert) || tsunami)) {
      impactReasons.push(`M${mag} in Hawaii with impact signal`);
    } else if (impactReasons.length === 0) {
      impactExclusions.push('Hawaii event below impact threshold (M4+ with felt/alert/tsunami)');
    }
  } else if (stateLower === 'puerto rico' || placeLower.includes('puerto rico')) {
    // Puerto Rico: M4+ with some impact signal
    if (mag >= 4.0 && (felt != null && felt >= 10 || IMPACT_ALERT_LEVELS.has(alert) || tsunami)) {
      impactReasons.push(`M${mag} in Puerto Rico with impact signal`);
    } else if (impactReasons.length === 0) {
      impactExclusions.push('Puerto Rico event below impact threshold');
    }
  } else if (LOWER_48_STATES.some(s => stateLower === s || placeLower.includes(s))) {
    // Lower 48: M4+ near populated area, or M3.5+ with strong felt reports
    if (mag >= 4.0 && impactReasons.length === 0) {
      // M4+ in lower 48 is generally impactful near populated areas
      impactReasons.push(`M${mag} in continental U.S.`);
    }
    if (mag >= 3.5 && felt != null && felt >= 500) {
      impactReasons.push(`M${mag} with felt=${felt} >= 500 (widely felt)`);
    }
    if (impactReasons.length === 0) {
      impactExclusions.push('Lower 48 event below impact threshold (M4+ or M3.5+ with 500+ felt)');
    }
  }

  const impactRelevant = impactReasons.length > 0;
  return { impactRelevant, impactReasons, impactExclusions };
}

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
    return { include: false, publishEligible: false, impactRelevant: false, reason: 'Excluded: deleted event' };
  }
  if (mag == null || isNaN(mag)) {
    return { include: false, publishEligible: false, impactRelevant: false, reason: 'Excluded: magnitude is null' };
  }
  if (mag < 3.0) {
    return { include: false, publishEligible: false, impactRelevant: false, reason: 'Excluded: magnitude < 3.0' };
  }

  // --- Determine U.S. relevance and scope ---
  const scope = isUS ? 'us' : 'international';

  // --- Detect remote region ---
  const remoteInfo = detectRemoteRegion(eq.place, eq.state);

  // --- Evaluate impact relevance (second gate) ---
  const impactResult = evaluateImpactRelevance(eq, remoteInfo);
  const impactRelevant = impactResult.impactRelevant;

  // --- Determine include (newsworthy enough to track internally) ---
  // Include U.S. events that pass the old eligibility rules OR have impact signals
  // Include notable global events (M6+) for internal tracking
  const isNotableGlobal = mag >= 6.0;
  const hasAlertGlobal = IMPACT_ALERT_LEVELS.has(alert);
  const hasTsunamiGlobal = tsunami;

  // For inclusion: U.S. events with any eligibility reason OR notable global events
  const eligibilityReasons = [];
  if (mag >= 5.0 && isUS) eligibilityReasons.push(`M${mag} >= 5.0 and U.S.-relevant`);
  if (mag >= 4.0 && isUS && felt != null && felt >= 100) eligibilityReasons.push(`M${mag} >= 4.0, U.S., felt=${felt} >= 100`);
  if (mag >= 4.0 && isUS && IMPACT_ALERT_LEVELS.has(alert)) eligibilityReasons.push(`M${mag} >= 4.0, U.S., alert=${alert}`);
  if (tsunami && isUS) eligibilityReasons.push('tsunami flag and U.S.-relevant');
  if (sig != null && sig >= 500 && isUS) eligibilityReasons.push(`significance ${sig} >= 500 and U.S.`);
  if (mag >= 3.5 && isUS && felt != null && felt >= 500) eligibilityReasons.push(`M${mag} >= 3.5, U.S., felt=${felt} >= 500`);
  if (mag >= 4.5 && ACTIVE_US_SEISMIC_ZONES.some((z) => placeLower.includes(z))) {
    eligibilityReasons.push(`M${mag} >= 4.5 in active U.S. seismic zone`);
  }

  const include = eligibilityReasons.length > 0 || isNotableGlobal || hasAlertGlobal || hasTsunamiGlobal;

  if (!include) {
    return {
      include: false,
      publishEligible: false,
      impactRelevant: false,
      reason: 'Excluded: no newsworthiness trigger matched',
    };
  }

  // --- Determine publishEligible (requires BOTH isUS AND impactRelevant) ---
  const exclusionReasons = [];
  const publishEligible = isUS && impactRelevant;

  if (!publishEligible) {
    if (!isUS) {
      exclusionReasons.push('Not U.S.-relevant (international scope)');
    } else if (!impactRelevant) {
      exclusionReasons.push(...impactResult.impactExclusions);
    }
  }

  // --- Priority ---
  const highPriority = (mag >= 5.0 && isUS && impactRelevant) || (isUS && IMPACT_ALERT_LEVELS.has(alert)) || (tsunami && isUS);
  const priority = highPriority ? 'high' : 'medium';

  // --- Build selected reason ---
  const allReasons = [...eligibilityReasons];
  if (isNotableGlobal && !isUS) allReasons.push(`M${mag} >= 6.0 (notable global, internal only)`);
  if (hasAlertGlobal && !isUS) allReasons.push(`alert=${alert} (global, internal only)`);
  if (hasTsunamiGlobal && !isUS) allReasons.push('tsunami (global, internal only)');

  return {
    include: true,
    publishEligible,
    impactRelevant,
    priority,
    scope,
    isUSRelevant: isUS,
    remoteRegion: remoteInfo.remoteRegion,
    remoteReason: remoteInfo.remoteReason,
    impactReasons: impactResult.impactReasons,
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

    // USGS detail feeds expose each product type as an array of product
    // objects. Treat shakemap as an array directly; the previous code
    // incorrectly indexed into the first product a second time, which could
    // leave hasShakeMap=true while shakeMapImageUrl stayed null.
    const shakeMapProducts = Array.isArray(products.shakemap)
      ? products.shakemap
      : [];
    const hasShakeMapProduct = shakeMapProducts.length > 0;
    let shakeMapProductUrl = null;
    let shakeMapImageUrl = null;

    if (hasShakeMapProduct) {
      // USGS orders products with the preferred/current product first.
      const smEntry = shakeMapProducts[0];
      if (smEntry) {
        shakeMapProductUrl =
          smEntry.properties?.map ||
          smEntry.properties?.url ||
          null;

        // Prefer the canonical download path but support the shorter key too.
        const intensityImage =
          smEntry.contents?.['download/intensity.jpg'] ||
          smEntry.contents?.['intensity.jpg'];

        if (intensityImage?.url) {
          shakeMapImageUrl = intensityImage.url;
        }
      }
    }

    // Downstream image generation needs an actual downloadable image URL.
    // A ShakeMap product can exist without the expected JPEG asset, so only
    // claim hasShakeMap when a usable image URL was found.
    const hasShakeMap = typeof shakeMapImageUrl === 'string' && shakeMapImageUrl.trim() !== '';

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
      impactRelevant: decision.impactRelevant,
      remoteRegion: decision.remoteRegion,
      remoteReason: decision.remoteReason,
      impactReasons: decision.impactReasons,
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
