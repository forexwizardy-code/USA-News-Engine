/**
 * US News Engine — Phase 9D.1 Science source-resilience test harness.
 *
 * Deterministic, offline (no network) test of the Science newsroom's
 * source-isolated-degradation rules. Exercises the EXACT same
 * `evaluateSourceDependency` / `computeSourceHealth` /
 * `buildPreservedJplSources` functions the production newsroom uses
 * (imported from science-source-resilience-rules.mjs) against six
 * synthetic scenarios (A-F) plus a JPL-recovery scenario.
 *
 * Scenarios (spec §13):
 *   A — NASA healthy, JPL degraded, SWPC healthy, new independent
 *       NASA/Hubble-like story             → PROCEED
 *   B — NASA healthy, JPL degraded, new JPL-managed planetary-mission
 *       candidate                          → DEFER (deferred-source-dependency)
 *   C — NASA healthy, JPL degraded, significant SWPC event
 *                                          → PROCEED (SWPC independent of JPL)
 *   D — NASA degraded, JPL healthy, new JPL-only story
 *                                          → PROCEED (JPL canonical source)
 *       + NASA candidate with NASA degraded → DEFER (own-source degraded)
 *   E — all sources healthy                → PROCEED (normal Phase 9D)
 *   F — all sources degraded               → 0 publication (every candidate DEFER)
 *   R — JPL recovery: previously-deferred Perseverance candidate is
 *       reconsidered once JPL is healthy   → PROCEED
 *
 * Run:
 *   node scripts/test-science-source-resilience.mjs
 *
 * Exits 1 on any assertion failure, 0 on full pass.
 */

import {
  computeSourceHealth,
  evaluateSourceDependency,
  buildPreservedJplSources,
  isJplManagedMission,
  isTransientStatus,
  JPL_MAX_ATTEMPTS,
  JPL_RETRY_BACKOFF_MS,
} from './science-source-resilience-rules.mjs';

let passed = 0;
let failed = 0;
const results = [];

function assert(name, cond, detail = '') {
  if (cond) {
    passed++;
    results.push(`  [PASS] ${name}`);
  } else {
    failed++;
    results.push(`  [FAIL] ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Build a synthetic fetcher-output doc for a source. */
function doc(source, { available = true, status = 200, error = null, count = 0, fetchedAt = '2026-09-28T12:00:00.000Z' } = {}) {
  return {
    fetchedAt,
    source,
    sourceAvailable: available,
    httpStatus: status,
    fetchError: error,
    recordCount: count,
    records: [],
  };
}

/** Build a synthetic story candidate. */
function candidate({ key, primary, mission, urls = [] }) {
  return {
    scienceStoryKey: key,
    primarySource: primary,
    mission: mission || null,
    allSourceKeys: [key],
    sourceUrls: urls,
    title: `Synthetic ${mission || 'story'} (${key})`,
  };
}

// ===========================================================================
// Scenario A — NASA healthy, JPL degraded, SWPC healthy, independent NASA story
// ===========================================================================
function scenarioA() {
  console.log('\n--- Scenario A: NASA healthy, JPL degraded, SWPC healthy, independent NASA/Hubble story ---');
  const health = computeSourceHealth({
    nasa: doc('NASA', { available: true, count: 40 }),
    jpl: doc('JPL', { available: false, status: 202, error: 'empty body' }),
    swpc: doc('NOAA-SWPC', { available: true, count: 0 }),
  });
  const c = candidate({
    key: 'nasa__hubble_a1b2',
    primary: 'NASA',
    mission: 'Hubble',
    urls: ['https://www.nasa.gov/image-article/hubble-spots-galaxy/'],
  });
  const d = evaluateSourceDependency(c, health, []);
  assert('A: NASA health = HEALTHY', health.NASA.status === 'HEALTHY');
  assert('A: JPL health = DEGRADED', health.JPL.status === 'DEGRADED');
  assert('A: SWPC health = HEALTHY', health.SWPC.status === 'HEALTHY');
  assert('A: independent Hubble story PROCEEDS', d.decision === 'proceed', `got ${d.decision} (${d.reason})`);
}

// ===========================================================================
// Scenario B — JPL-managed planetary mission candidate while JPL degraded
// ===========================================================================
function scenarioB() {
  console.log('\n--- Scenario B: NASA healthy, JPL degraded, JPL-managed (Perseverance) candidate → DEFER ---');
  const health = computeSourceHealth({
    nasa: doc('NASA', { available: true, count: 40 }),
    jpl: doc('JPL', { available: false, status: 202, error: 'empty body' }),
    swpc: doc('NOAA-SWPC', { available: true, count: 0 }),
  });
  const c = candidate({
    key: 'nasa__perseverance_c3d4',
    primary: 'NASA',
    mission: 'Perseverance',
    urls: ['https://www.nasa.gov/missions/mars/perseverance-update/'],
  });
  const d = evaluateSourceDependency(c, health, []);
  assert('B: Perseverance is JPL-managed', isJplManagedMission('Perseverance'));
  assert('B: Perseverance candidate DEFERRED', d.decision === 'defer', `got ${d.decision}`);
  assert('B: deferStatus = deferred-source-dependency', d.deferStatus === 'deferred-source-dependency', `got ${d.deferStatus}`);
}

// ===========================================================================
// Scenario C — significant SWPC event while JPL degraded → PROCEED
// ===========================================================================
function scenarioC() {
  console.log('\n--- Scenario C: NASA healthy, JPL degraded, significant SWPC event → PROCEED ---');
  const health = computeSourceHealth({
    nasa: doc('NASA', { available: true, count: 40 }),
    jpl: doc('JPL', { available: false, status: 503, error: 'HTTP 503 Service Unavailable' }),
    swpc: doc('NOAA-SWPC', { available: true, count: 2 }),
  });
  const c = candidate({
    key: 'swpc__geomagnetic_e5f6',
    primary: 'NOAA-SWPC',
    mission: null,
    urls: ['https://services.swpc.noaa.gov/products/alerts.json'],
  });
  const d = evaluateSourceDependency(c, health, []);
  assert('C: SWPC health = HEALTHY', health.SWPC.status === 'HEALTHY');
  assert('C: SWPC event PROCEEDS despite JPL degraded', d.decision === 'proceed', `got ${d.decision} (${d.reason})`);
}

// ===========================================================================
// Scenario D — NASA degraded, JPL healthy, JPL-only story
//   D1: JPL-only story → PROCEED (JPL is the canonical source)
//   D2: NASA candidate with NASA degraded → DEFER (own-source degraded)
// ===========================================================================
function scenarioD() {
  console.log('\n--- Scenario D: NASA degraded, JPL healthy, JPL-only story → PROCEED; NASA candidate → DEFER ---');
  const health = computeSourceHealth({
    nasa: doc('NASA', { available: false, status: 500, error: 'HTTP 500 Internal Server Error' }),
    jpl: doc('JPL', { available: true, count: 110 }),
    swpc: doc('NOAA-SWPC', { available: true, count: 0 }),
  });
  // D1 — JPL-only story (JPL is canonical for JPL-managed missions).
  const c1 = candidate({
    key: 'jpl__perseverance_g7h8',
    primary: 'JPL',
    mission: 'Perseverance',
    urls: ['https://www.jpl.nasa.gov/news/perseverance-update'],
  });
  const d1 = evaluateSourceDependency(c1, health, []);
  assert('D1: JPL-only story PROCEEDS (JPL canonical source)', d1.decision === 'proceed', `got ${d1.decision} (${d1.reason})`);
  // D2 — NASA candidate while NASA degraded → defer (own-source degraded).
  const c2 = candidate({
    key: 'nasa__hubble_i9j0',
    primary: 'NASA',
    mission: 'Hubble',
    urls: ['https://www.nasa.gov/image-article/hubble/'],
  });
  const d2 = evaluateSourceDependency(c2, health, []);
  assert('D2: NASA candidate DEFERRED (NASA degraded)', d2.decision === 'defer', `got ${d2.decision}`);
  assert('D2: deferStatus = deferred-source-degraded', d2.deferStatus === 'deferred-source-degraded', `got ${d2.deferStatus}`);
}

// ===========================================================================
// Scenario E — all sources healthy → normal Phase 9D behavior
// ===========================================================================
function scenarioE() {
  console.log('\n--- Scenario E: all sources healthy → normal Phase 9D behavior ---');
  const health = computeSourceHealth({
    nasa: doc('NASA', { available: true, count: 40 }),
    jpl: doc('JPL', { available: true, count: 110 }),
    swpc: doc('NOAA-SWPC', { available: true, count: 0 }),
  });
  const c = candidate({
    key: 'nasa__webb_k1l2',
    primary: 'NASA',
    mission: 'James Webb',
    urls: ['https://www.nasa.gov/missions/webb/webb-discovery/'],
  });
  const d = evaluateSourceDependency(c, health, []);
  assert('E: NASA HEALTHY', health.NASA.status === 'HEALTHY');
  assert('E: JPL HEALTHY', health.JPL.status === 'HEALTHY');
  assert('E: SWPC HEALTHY', health.SWPC.status === 'HEALTHY');
  assert('E: Webb story PROCEEDS (normal pipeline)', d.decision === 'proceed', `got ${d.decision}`);
}

// ===========================================================================
// Scenario F — all sources degraded → 0 publication (every candidate DEFER)
// ===========================================================================
function scenarioF() {
  console.log('\n--- Scenario F: all sources degraded → 0 publication, clean degraded run ---');
  const health = computeSourceHealth({
    nasa: doc('NASA', { available: false, status: 500, error: 'HTTP 500' }),
    jpl: doc('JPL', { available: false, status: 202, error: 'empty body' }),
    swpc: doc('NOAA-SWPC', { available: false, status: 503, error: 'HTTP 503' }),
  });
  const nasaC = candidate({ key: 'nasa__x1', primary: 'NASA', mission: 'Hubble' });
  const jplC = candidate({ key: 'jpl__x2', primary: 'JPL', mission: 'Perseverance' });
  const swpcC = candidate({ key: 'swpc__x3', primary: 'NOAA-SWPC', mission: null });
  const dN = evaluateSourceDependency(nasaC, health, []);
  const dJ = evaluateSourceDependency(jplC, health, []);
  const dS = evaluateSourceDependency(swpcC, health, []);
  assert('F: NASA candidate DEFERRED', dN.decision === 'defer', `got ${dN.decision}`);
  assert('F: JPL candidate DEFERRED', dJ.decision === 'defer', `got ${dJ.decision}`);
  assert('F: SWPC candidate DEFERRED', dS.decision === 'defer', `got ${dS.decision}`);
  assert('F: 0 publications (all deferred)', dN.decision === 'defer' && dJ.decision === 'defer' && dS.decision === 'defer');
}

// ===========================================================================
// Scenario R — JPL recovery: deferred Perseverance candidate is reconsidered
// ===========================================================================
function scenarioR() {
  console.log('\n--- Scenario R: JPL recovery — previously-deferred Perseverance candidate is reconsidered ---');
  // While JPL was degraded, the Perseverance candidate was DEFERRED (scenario B).
  const degradedHealth = computeSourceHealth({
    nasa: doc('NASA', { available: true, count: 40 }),
    jpl: doc('JPL', { available: false, status: 202, error: 'empty body' }),
    swpc: doc('NOAA-SWPC', { available: true, count: 0 }),
  });
  const c = candidate({
    key: 'nasa__perseverance_c3d4',
    primary: 'NASA',
    mission: 'Perseverance',
    urls: ['https://www.nasa.gov/missions/mars/perseverance-update/'],
  });
  const dDegraded = evaluateSourceDependency(c, degradedHealth, []);
  assert('R: candidate DEFERRED while JPL degraded', dDegraded.decision === 'defer', `got ${dDegraded.decision}`);

  // JPL recovers — same candidate is now reconsidered and PROCEEDS.
  const recoveredHealth = computeSourceHealth({
    nasa: doc('NASA', { available: true, count: 40 }),
    jpl: doc('JPL', { available: true, count: 110 }),
    swpc: doc('NOAA-SWPC', { available: true, count: 0 }),
  });
  const dRecovered = evaluateSourceDependency(c, recoveredHealth, []);
  assert('R: candidate PROCEEDS after JPL recovery', dRecovered.decision === 'proceed', `got ${dRecovered.decision} (${dRecovered.reason})`);

  // Stable scienceKeys: the candidate's scienceStoryKey is unchanged
  // across the degraded → recovered transition (no key reinterpretation).
  assert('R: scienceStoryKey stable across recovery', c.scienceStoryKey === 'nasa__perseverance_c3d4');
}

// ===========================================================================
// Cross-source duplicate safety (spec §5) — URL/key match → DEFER
// ===========================================================================
function crossSourceDuplicate() {
  console.log('\n--- Cross-source duplicate safety: candidate URL matches preserved JPL source → DEFER ---');
  const health = computeSourceHealth({
    nasa: doc('NASA', { available: true, count: 40 }),
    jpl: doc('JPL', { available: false, status: 202, error: 'empty body' }),
    swpc: doc('NOAA-SWPC', { available: true, count: 0 }),
  });
  // Preserved JPL source (from last-known-good or registry) — same URL
  // as the NASA candidate. This is a hard duplicate signal.
  const preserved = buildPreservedJplSources({
    lastKnownGoodJpl: {
      records: [
        {
          scienceKey: 'jpl__a0b05eee4e3af8ae',
          sourceUrl: 'https://www.jpl.nasa.gov/news/us-india-satellite-captures-time-lapse-video-of-volcanic-eruption',
          title: 'NISAR time-lapse',
          publishedAtSource: '2026-09-24T16:00:00.000Z',
        },
      ],
    },
    registry: {
      sources: [
        {
          scienceKey: 'jpl__a0b05eee4e3af8ae',
          source: 'JPL',
          sourceUrl: 'https://www.jpl.nasa.gov/news/us-india-satellite-captures-time-lapse-video-of-volcanic-eruption',
          publishedAtSource: '2026-09-24T16:00:00.000Z',
        },
      ],
    },
  });
  assert('duplicate: preserved JPL sources de-duplicated to 1', preserved.length === 1, `got ${preserved.length}`);
  // NASA candidate whose sourceUrl matches the preserved JPL source.
  const c = candidate({
    key: 'nasa__nisar_dup',
    primary: 'NASA',
    mission: 'NISAR',
    urls: ['https://www.jpl.nasa.gov/news/us-india-satellite-captures-time-lapse-video-of-volcanic-eruption'],
  });
  const d = evaluateSourceDependency(c, health, preserved);
  assert('duplicate: matching-URL candidate DEFERRED', d.decision === 'defer', `got ${d.decision}`);
  assert('duplicate: deferStatus = deferred-source-dependency', d.deferStatus === 'deferred-source-dependency', `got ${d.deferStatus}`);

  // A DIFFERENT NASA/Hubble candidate (no URL/key match) still PROCEEDS.
  const c2 = candidate({
    key: 'nasa__hubble_unique',
    primary: 'NASA',
    mission: 'Hubble',
    urls: ['https://www.nasa.gov/image-article/hubble-new-target/'],
  });
  const d2 = evaluateSourceDependency(c2, health, preserved);
  assert('duplicate: unrelated Hubble candidate still PROCEEDS', d2.decision === 'proceed', `got ${d2.decision} (${d2.reason})`);
}

// ===========================================================================
// Transient-failure classification + retry config (spec §2)
// ===========================================================================
function retryConfig() {
  console.log('\n--- JPL retry config + transient-failure classification ---');
  assert('retry: 202 is transient', isTransientStatus(202) === true);
  assert('retry: 429 is transient', isTransientStatus(429) === true);
  assert('retry: 500 is transient', isTransientStatus(500) === true);
  assert('retry: 502 is transient', isTransientStatus(502) === true);
  assert('retry: 503 is transient', isTransientStatus(503) === true);
  assert('retry: 504 is transient', isTransientStatus(504) === true);
  assert('retry: 0 (network/timeout) is transient', isTransientStatus(0) === true);
  assert('retry: 403 is NOT transient (hard block)', isTransientStatus(403) === false);
  assert('retry: 404 is NOT transient', isTransientStatus(404) === false);
  assert('retry: 200 is NOT transient (success)', isTransientStatus(200) === false);
  assert('retry: max attempts = 3', JPL_MAX_ATTEMPTS === 3);
  assert('retry: backoff schedule has 2 waits', Array.isArray(JPL_RETRY_BACKOFF_MS) && JPL_RETRY_BACKOFF_MS.length === 2);
  assert('retry: first backoff ~2s', JPL_RETRY_BACKOFF_MS[0] === 2000);
  assert('retry: second backoff ~5s', JPL_RETRY_BACKOFF_MS[1] === 5000);
}

// ===========================================================================
// Source-health model fields (spec §1)
// ===========================================================================
function healthModelFields() {
  console.log('\n--- Source-health model fields (per source) ---');
  const health = computeSourceHealth({
    nasa: doc('NASA', { available: true, count: 40 }),
    jpl: doc('JPL', { available: false, status: 202, error: 'empty body' }),
    swpc: doc('NOAA-SWPC', { available: true, count: 0 }),
  }, {
    // previous health — JPL had been healthy before, then failed once
    JPL: { lastSuccessfulFetchAt: '2026-09-28T10:00:00.000Z', consecutiveFailures: 0 },
  });
  const j = health.JPL;
  assert('health: JPL sourceAvailable=false', j.sourceAvailable === false);
  assert('health: JPL httpStatus=202', j.httpStatus === 202);
  assert('health: JPL fetchedAt set', !!j.fetchedAt);
  assert('health: JPL lastSuccessfulFetchAt preserved', j.lastSuccessfulFetchAt === '2026-09-28T10:00:00.000Z');
  assert('health: JPL consecutiveFailures incremented to 1', j.consecutiveFailures === 1, `got ${j.consecutiveFailures}`);
  assert('health: JPL fetchError="empty body"', j.fetchError === 'empty body');
  assert('health: JPL recordCount=0', j.recordCount === 0);
  assert('health: JPL status=DEGRADED', j.status === 'DEGRADED');
  assert('health: NASA status=HEALTHY', health.NASA.status === 'HEALTHY');
  assert('health: NASA consecutiveFailures=0', health.NASA.consecutiveFailures === 0);
  assert('health: NASA lastSuccessfulFetchAt=fetchedAt', health.NASA.lastSuccessfulFetchAt === health.NASA.fetchedAt);
}

// ===========================================================================
// Main
// ===========================================================================

async function main() {
  console.log('============================================================');
  console.log('Phase 9D.1 — Science Source Resilience Test Harness');
  console.log('============================================================');
  console.log(`Started: ${new Date().toISOString()}`);

  scenarioA();
  scenarioB();
  scenarioC();
  scenarioD();
  scenarioE();
  scenarioF();
  scenarioR();
  crossSourceDuplicate();
  retryConfig();
  healthModelFields();

  console.log('\n------------------------------------------------------------');
  console.log('Results:');
  for (const r of results) console.log(r);
  console.log('------------------------------------------------------------');
  console.log(`\nTotal: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error('\n[science-source-resilience] FAILED — one or more scenarios failed.');
    process.exit(1);
  }
  console.log('[science-source-resilience] SUCCESS — all scenarios passed.');
  process.exit(0);
}

main().catch((err) => {
  console.error(`\n[science-source-resilience] Unexpected failure: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
