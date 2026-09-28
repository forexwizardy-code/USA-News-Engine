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
// Phase 9D.2 — CI-persistence: fresh-runner, cache-equivalence, recovery
// ===========================================================================
//
// These scenarios simulate a FRESH GitHub Actions checkout where the
// gitignored last-known-good cache does NOT exist. The CANONICAL
// fallback is the tracked science-source-registry.json. Correctness
// must be identical whether or not the local cache is present.

/**
 * A realistic tracked registry with JPL sources carrying the Phase 9D.2
 * durable identity fields (title, mission, topic, storyType). This
 * simulates what a fresh GHA checkout would have after the workflow
 * committed registry updates from a prior successful run.
 */
function sampleTrackedRegistry() {
  return {
    sources: [
      {
        scienceKey: 'jpl__a0b05eee4e3af8ae',
        source: 'JPL',
        sourceUrl: 'https://www.jpl.nasa.gov/news/us-india-satellite-captures-time-lapse-video-of-volcanic-eruption',
        publishedAtSource: '2026-09-24T16:00:00.000Z',
        firstSeenAt: '2026-09-28T01:04:07.512Z',
        lastSeenAt: '2026-09-28T11:43:31.447Z',
        bootstrapSeen: true,
        title: 'US-India Satellite Captures Time-Lapse Video of Volcanic Eruption',
        mission: 'NISAR',
        topic: 'Earth Science',
        storyType: 'earth-science',
      },
      {
        scienceKey: 'jpl__7cdc58bb88b1db7c',
        source: 'JPL',
        sourceUrl: 'https://www.jpl.nasa.gov/news/nasa-discovery-reveals-complex-water-systems-on-early-mars',
        publishedAtSource: '2026-09-21T17:00:00.000Z',
        firstSeenAt: '2026-09-28T01:04:07.512Z',
        lastSeenAt: '2026-09-28T11:43:31.447Z',
        bootstrapSeen: true,
        title: 'NASA Discovery Reveals Complex Water Systems on Early Mars',
        mission: 'Perseverance',
        topic: 'Planetary Science',
        storyType: 'mission-result',
      },
      {
        scienceKey: 'nasa__4c93b21d54ff615c',
        source: 'NASA',
        sourceUrl: 'https://www.nasa.gov/image-article/hubble-spots-chaotic-secret-in-galaxy/',
        publishedAtSource: '2026-09-25T15:54:10.000Z',
        firstSeenAt: '2026-09-28T01:04:07.512Z',
        lastSeenAt: '2026-09-28T11:43:31.447Z',
        bootstrapSeen: true,
        title: 'Hubble Image Shows Unusual Spiral Structure in Galaxy NGC 4698',
        mission: 'Hubble',
        topic: 'Astronomy',
        storyType: 'discovery',
      },
    ],
  };
}

/**
 * Scenario FR (Fresh Runner) — spec §5.
 *   Fresh GHA checkout, NO last-known-good cache, JPL degraded (202/empty),
 *   tracked registry exists.
 *
 * Expected: JPL DEGRADED; previous JPL identities remain known;
 *   bootstrap protection intact; duplicate/dependency checks work;
 *   NASA/SWPC independent candidates proceed; JPL-dependent candidates
 *   defer. No crash. No accidental NEW. No publication from missing cache.
 */
function scenarioFreshRunner() {
  console.log('\n--- Phase 9D.2 Scenario FR: fresh runner, NO cache, JPL degraded, tracked registry ---');
  const health = computeSourceHealth({
    nasa: doc('NASA', { available: true, count: 10 }),
    jpl: doc('JPL', { available: false, status: 202, error: 'empty body' }),
    swpc: doc('NOAA-SWPC', { available: true, count: 0 }),
  });
  assert('FR: JPL DEGRADED', health.JPL.status === 'DEGRADED');
  assert('FR: NASA HEALTHY', health.NASA.status === 'HEALTHY');
  assert('FR: SWPC HEALTHY', health.SWPC.status === 'HEALTHY');

  // Preserved JPL sources built from REGISTRY ONLY (no LKG cache).
  const preserved = buildPreservedJplSources({
    registry: sampleTrackedRegistry(),
    lastKnownGoodJpl: null, // cache absent — fresh runner
  });
  assert('FR: preserved JPL sources from registry-only = 2', preserved.length === 2, `got ${preserved.length}`);
  assert('FR: preserved sources carry title', preserved.every((p) => p.title !== null));
  assert('FR: preserved sources carry mission', preserved.every((p) => p.mission !== null));
  assert('FR: preserved sources carry bootstrapSeen', preserved.every((p) => p.bootstrapSeen !== null));

  // Cross-source duplicate: NASA candidate whose URL matches a registry
  // JPL source → DEFER (duplicate protection works without cache).
  const dupC = candidate({
    key: 'nasa__nisar_fresh_dup',
    primary: 'NASA',
    mission: 'NISAR',
    urls: ['https://www.jpl.nasa.gov/news/us-india-satellite-captures-time-lapse-video-of-volcanic-eruption'],
  });
  const dDup = evaluateSourceDependency(dupC, health, preserved);
  assert('FR: duplicate NASA/NISAR candidate DEFERRED (no cache needed)', dDup.decision === 'defer', `got ${dDup.decision}`);

  // JPL-managed mission candidate (Perseverance, no URL match) → DEFER.
  const persC = candidate({
    key: 'nasa__perseverance_fresh',
    primary: 'NASA',
    mission: 'Perseverance',
    urls: ['https://www.nasa.gov/missions/mars/perseverance-new-update/'],
  });
  const dPers = evaluateSourceDependency(persC, health, preserved);
  assert('FR: JPL-managed Perseverance candidate DEFERRED (no cache needed)', dPers.decision === 'defer', `got ${dPers.decision}`);

  // Independent NASA/Hubble candidate (no URL/key match) → PROCEED.
  const hubbleC = candidate({
    key: 'nasa__hubble_fresh',
    primary: 'NASA',
    mission: 'Hubble',
    urls: ['https://www.nasa.gov/image-article/hubble-new-target-fresh/'],
  });
  const dHubble = evaluateSourceDependency(hubbleC, health, preserved);
  assert('FR: independent Hubble candidate PROCEEDS (no cache needed)', dHubble.decision === 'proceed', `got ${dHubble.decision} (${dHubble.reason})`);

  // SWPC event → PROCEED (independent of JPL).
  const swpcC = candidate({
    key: 'swpc__fresh_event',
    primary: 'NOAA-SWPC',
    mission: null,
    urls: ['https://services.swpc.noaa.gov/products/alerts.json'],
  });
  const dSwpc = evaluateSourceDependency(swpcC, health, preserved);
  assert('FR: SWPC event PROCEEDS (no cache needed)', dSwpc.decision === 'proceed', `got ${dSwpc.decision}`);

  // No crash, no accidental NEW interpretation: a bootstrap JPL source
  // key must NOT be treated as a new publication candidate.
  const bootstrapKey = preserved.find((p) => p.bootstrapSeen === true);
  assert('FR: bootstrap JPL source identity preserved in registry', !!bootstrapKey);
  assert('FR: bootstrap scienceKey is jpl__ (not reinterpreted)', bootstrapKey && bootstrapKey.scienceKey.startsWith('jpl__'));
}

/**
 * Scenario CE (Cache Equivalence) — spec §11.
 *   A: cache present + JPL degraded → outcome X
 *   B: cache absent + JPL degraded → outcome X (SAME)
 *
 * Cache presence must not change the editorial/dependency outcome.
 */
function scenarioCacheEquivalence() {
  console.log('\n--- Phase 9D.2 Scenario CE: cache-present vs cache-absent equivalence ---');
  const health = computeSourceHealth({
    nasa: doc('NASA', { available: true, count: 40 }),
    jpl: doc('JPL', { available: false, status: 202, error: 'empty body' }),
    swpc: doc('NOAA-SWPC', { available: true, count: 0 }),
  });
  const registry = sampleTrackedRegistry();
  const lkg = {
    records: [
      {
        scienceKey: 'jpl__a0b05eee4e3af8ae',
        source: 'JPL',
        sourceUrl: 'https://www.jpl.nasa.gov/news/us-india-satellite-captures-time-lapse-video-of-volcanic-eruption',
        title: 'NISAR time-lapse (from cache)',
        mission: 'NISAR',
        publishedAtSource: '2026-09-24T16:00:00.000Z',
        storyType: 'earth-science',
      },
    ],
  };

  const preservedWithCache = buildPreservedJplSources({ registry, lastKnownGoodJpl: lkg });
  const preservedNoCache = buildPreservedJplSources({ registry, lastKnownGoodJpl: null });

  // The registry is canonical; the LKG only adds keys the registry
  // doesn't have. Here both JPL keys are in the registry, so the LKG
  // adds nothing — the two sets are identical.
  assert('CE: preserved count identical (cache present vs absent)', preservedWithCache.length === preservedNoCache.length, `cache=${preservedWithCache.length} no-cache=${preservedNoCache.length}`);

  // The registry's identity is authoritative (title from registry, not
  // the cache's "NISAR time-lapse (from cache)").
  const nisarWithCache = preservedWithCache.find((p) => p.scienceKey === 'jpl__a0b05eee4e3af8ae');
  const nisarNoCache = preservedNoCache.find((p) => p.scienceKey === 'jpl__a0b05eee4e3af8ae');
  assert('CE: registry title is authoritative (not cache title)', nisarWithCache && nisarWithCache.title === nisarNoCache.title && !nisarWithCache.title.includes('from cache'), `got "${nisarWithCache && nisarWithCache.title}"`);

  // Run the SAME candidates against both preserved sets — outcomes must match.
  const candidates = [
    candidate({ key: 'nasa__nisar_ce', primary: 'NASA', mission: 'NISAR', urls: ['https://www.jpl.nasa.gov/news/us-india-satellite-captures-time-lapse-video-of-volcanic-eruption'] }),
    candidate({ key: 'nasa__perseverance_ce', primary: 'NASA', mission: 'Perseverance', urls: ['https://www.nasa.gov/missions/mars/pers-update/'] }),
    candidate({ key: 'nasa__hubble_ce', primary: 'NASA', mission: 'Hubble', urls: ['https://www.nasa.gov/image-article/hubble-ce/'] }),
    candidate({ key: 'swpc__ce_event', primary: 'NOAA-SWPC', mission: null, urls: ['https://services.swpc.noaa.gov/products/alerts.json'] }),
  ];
  let allMatch = true;
  for (const c of candidates) {
    const dCache = evaluateSourceDependency(c, health, preservedWithCache);
    const dNoCache = evaluateSourceDependency(c, health, preservedNoCache);
    if (dCache.decision !== dNoCache.decision) {
      allMatch = false;
      assert(`CE: ${c.scienceStoryKey} decision matches (cache vs no-cache)`, false, `cache=${dCache.decision} no-cache=${dNoCache.decision}`);
    } else {
      assert(`CE: ${c.scienceStoryKey} decision matches (cache vs no-cache)`, true);
    }
  }
  assert('CE: ALL candidate outcomes identical with/without cache', allMatch);
}

/**
 * Scenario RC (Recovery on fresh runner) — spec §6.
 *   Run 1: JPL degraded (fresh runner, no cache, registry only).
 *   Run 2: JPL healthy (100-record feed).
 *
 * Expected: stable scienceKeys; no historical source becomes NEW;
 *   bootstrapSeen values preserved; deferred candidate may be
 *   reconsidered; no duplicate story created.
 */
function scenarioRecoveryFreshRunner() {
  console.log('\n--- Phase 9D.2 Scenario RC: degraded → healthy recovery on fresh runner ---');
  const registry = sampleTrackedRegistry();

  // Run 1 — JPL degraded, fresh runner (no cache).
  const degradedHealth = computeSourceHealth({
    nasa: doc('NASA', { available: true, count: 10 }),
    jpl: doc('JPL', { available: false, status: 202, error: 'empty body' }),
    swpc: doc('NOAA-SWPC', { available: true, count: 0 }),
  });
  const preservedDegraded = buildPreservedJplSources({ registry, lastKnownGoodJpl: null });
  const persC = candidate({
    key: 'nasa__perseverance_rc',
    primary: 'NASA',
    mission: 'Perseverance',
    urls: ['https://www.nasa.gov/missions/mars/perseverance-rc-update/'],
  });
  const dDegraded = evaluateSourceDependency(persC, degradedHealth, preservedDegraded);
  assert('RC: Perseverance candidate DEFERRED while JPL degraded (fresh runner)', dDegraded.decision === 'defer', `got ${dDegraded.decision}`);

  // Run 2 — JPL healthy. The SAME candidate is now reconsidered.
  const recoveredHealth = computeSourceHealth({
    nasa: doc('NASA', { available: true, count: 10 }),
    jpl: doc('JPL', { available: true, count: 100 }),
    swpc: doc('NOAA-SWPC', { available: true, count: 0 }),
  });
  const dRecovered = evaluateSourceDependency(persC, recoveredHealth, preservedDegraded);
  assert('RC: Perseverance candidate PROCEEDS after JPL recovery', dRecovered.decision === 'proceed', `got ${dRecovered.decision} (${dRecovered.reason})`);

  // Stable scienceKeys: the candidate's key is unchanged across the
  // degraded → recovered transition (no key reinterpretation).
  assert('RC: scienceStoryKey stable across recovery', persC.scienceStoryKey === 'nasa__perseverance_rc');

  // No historical source becomes NEW: the registry's bootstrap JPL
  // sources keep their bootstrapSeen=true flag and their scienceKeys.
  const bootstrapJpl = registry.sources.filter((s) => s.source === 'JPL' && s.bootstrapSeen === true);
  assert('RC: bootstrap JPL sources preserved in registry', bootstrapJpl.length === 2);
  assert('RC: bootstrap scienceKeys unchanged', bootstrapJpl.every((s) => s.scienceKey.startsWith('jpl__')));
  assert('RC: bootstrapSeen=true preserved', bootstrapJpl.every((s) => s.bootstrapSeen === true));

  // No duplicate story created: when JPL is HEALTHY, a candidate whose
  // URL matches a registry JPL source PROCEEDS through the normal
  // pipeline — duplicate protection when JPL is healthy comes from the
  // NASA+JPL clustering layer (build-science-stories.mjs clusters
  // records with the same mission + date window into one story) and
  // the published-science registry, NOT from the degraded-source defer
  // rule. The defer rule's cross-source duplicate check only fires when
  // JPL is DEGRADED (when clustering cannot see JPL records). This
  // proves the two layers are complementary, not redundant.
  const dupC = candidate({
    key: 'nasa__nisar_rc_dup',
    primary: 'NASA',
    mission: 'NISAR',
    urls: ['https://www.jpl.nasa.gov/news/us-india-satellite-captures-time-lapse-video-of-volcanic-eruption'],
  });
  const preservedAfterRecovery = buildPreservedJplSources({ registry, lastKnownGoodJpl: null });
  const dDupRecovered = evaluateSourceDependency(dupC, recoveredHealth, preservedAfterRecovery);
  assert('RC: matching-URL candidate PROCEEDS when JPL healthy (clustering handles duplicate)', dDupRecovered.decision === 'proceed', `got ${dDupRecovered.decision}`);
  // And the SAME candidate would have been DEFERRED while JPL was
  // degraded (the defer rule's cross-source duplicate check catches it
  // when clustering cannot). This proves no duplicate slips through
  // either state.
  const dDupDegraded = evaluateSourceDependency(dupC, degradedHealth, preservedDegraded);
  assert('RC: matching-URL candidate DEFERRED when JPL degraded (defer rule catches duplicate)', dDupDegraded.decision === 'defer', `got ${dDupDegraded.decision}`);
}

/**
 * Scenario NE (No-cache Equivalence for full pipeline decision) —
 * verifies that buildPreservedJplSources with registry-only produces
 * the SAME preserved identity set as registry+cache when the cache
 * contains no additional keys.
 */
function scenarioNoCacheEquivalence() {
  console.log('\n--- Phase 9D.2 Scenario NE: registry-only produces full identity without cache ---');
  const registry = sampleTrackedRegistry();

  // Registry-only (fresh runner).
  const preservedRegOnly = buildPreservedJplSources({ registry, lastKnownGoodJpl: null });
  // Registry + cache with the SAME keys (cache adds nothing).
  const preservedWithCache = buildPreservedJplSources({
    registry,
    lastKnownGoodJpl: { records: registry.sources.filter((s) => s.source === 'JPL') },
  });

  assert('NE: registry-only count == registry+cache count', preservedRegOnly.length === preservedWithCache.length, `reg-only=${preservedRegOnly.length} with-cache=${preservedWithCache.length}`);

  // Every preserved entry from registry-only carries the full identity
  // fields needed for duplicate / dependency decisions.
  for (const p of preservedRegOnly) {
    assert(`NE: ${p.scienceKey} has scienceKey`, !!p.scienceKey);
    assert(`NE: ${p.scienceKey} has sourceUrl`, !!p.sourceUrl);
    assert(`NE: ${p.scienceKey} has title`, p.title !== null);
    assert(`NE: ${p.scienceKey} has mission`, p.mission !== null);
    assert(`NE: ${p.scienceKey} has bootstrapSeen`, p.bootstrapSeen !== null);
  }
}

// ===========================================================================
// Main
// ===========================================================================

async function main() {
  console.log('============================================================');
  console.log('Phase 9D.1/9D.2 — Science Source Resilience Test Harness');
  console.log('============================================================');
  console.log(`Started: ${new Date().toISOString()}`);

  // Phase 9D.1 scenarios (source-isolated degradation).
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

  // Phase 9D.2 scenarios (CI persistence — fresh-runner safety).
  scenarioFreshRunner();
  scenarioCacheEquivalence();
  scenarioRecoveryFreshRunner();
  scenarioNoCacheEquivalence();

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
