/**
 * US News Engine — Phase 9D.1 Science source-resilience rules (shared module).
 *
 * Pure, deterministic helpers used by BOTH the live Science newsroom
 * (scripts/run-science-newsroom.mjs) AND the offline resilience test
 * harness (scripts/test-science-source-resilience.mjs). Keeping the
 * decision logic in one place guarantees the test harness exercises
 * the exact same rules the production newsroom uses.
 *
 * Goals (Phase 9D.1):
 *   - Track source health independently for NASA, JPL, SWPC.
 *   - Tolerate temporary failure of ONE official source (e.g. JPL
 *     returning HTTP 202 with an empty body) without compromising
 *     duplicate protection or factual safety.
 *   - Source-isolated degradation: a degraded JPL feed must NOT block
 *     otherwise-healthy NASA / SWPC stories.
 *   - Cross-source duplicate safety: when JPL is degraded, defer
 *     candidates that plausibly duplicate an unseen JPL release.
 *   - SWPC independence: a significant SWPC event is never blocked by
 *     a JPL outage.
 *
 * These rules do NOT change editorial thresholds, do NOT add new
 * sources, and do NOT modify Weather / Recall / Earthquake automation.
 * DEMO_NOINDEX remains true.
 */

// ===========================================================================
// JPL-managed missions
// ===========================================================================
//
// JPL (NASA Jet Propulsion Laboratory) designs and operates NASA's
// robotic planetary missions and several Earth-science instruments.
// News releases about these missions are issued BOTH by JPL
// (www.jpl.nasa.gov/news/...) and frequently cross-published or
// echoed by NASA HQ (www.nasa.gov/...). When JPL's feed is degraded,
// we CANNOT determine whether a NASA-HQ candidate about a JPL-managed
// mission is a duplicate of a JPL release we cannot currently see —
// so we DEFER it (status = deferred-source-dependency) and reconsider
// it on the next scheduled run after JPL recovers.
//
// Missions NOT in this set are treated as independent of JPL and MAY
// publish during a JPL outage (subject to all other Phase 9D gates):
//   - Hubble, James Webb, Chandra (Goddard / STScI / Harvard-Smithsonian)
//   - Parker Solar Probe (APL)
//   - Nancy Grace Roman (Goddard)
//   - ISS, Artemis, SLS, Orion, Starliner, Crew Dragon, SpaceX, Starlink
//   - NASA Headquarters science / policy releases
export const JPL_MANAGED_MISSIONS = new Set([
  // Mars surface missions (JPL-operated)
  'Perseverance',
  'Curiosity',
  'InSight',
  // Outer-planet / deep-space robotic missions (JPL-managed)
  'Europa Clipper',
  'Psyche',
  'Lucy',
  'Juno',
  'Cassini',
  'Voyager',
  'New Horizons', // JPL-affiliated payload; treated conservatively
  'DART', // APL-led but JPL Deep Space Network tracking — conservative defer
  'Dawn',
  'Stardust',
  'Deep Impact',
  'GRAIL',
  'MRO',
  // Earth-observation instruments designed/operated by JPL
  'NISAR',
  'SMAP',
  'SWOT',
  'GRACE-FO',
  'EMIT',
  'OCO',
  // Astrophysics instruments with JPL hardware/management
  'NuSTAR',
]);

/**
 * Return true when a mission is managed by JPL (conservative defer when
 * JPL is degraded). null/undefined mission → false (treated as
 * independent; the cross-source URL/key duplicate check still runs).
 */
export function isJplManagedMission(mission) {
  if (!mission || typeof mission !== 'string') return false;
  return JPL_MANAGED_MISSIONS.has(mission);
}

// ===========================================================================
// HTTP transient-failure classification (for JPL retries)
// ===========================================================================

/**
 * Classify an HTTP status as a TRANSIENT failure worth retrying.
 *
 * Transient:
 *   - 0   : network failure / timeout (AbortController)
 *   - 202 : JPL WAF "accepted but empty body" (the live Phase 9D.1 issue)
 *   - 408 : Request Timeout
 *   - 425 : Too Early
 *   - 429 : Too Many Requests
 *   - 5xx : server errors (500/502/503/504)
 *
 * Hard (no retry):
 *   - 403 : JPL bot-mitigation block (retrying immediately won't help)
 *   - 404 / 410 : not found / gone
 *   - other 4xx
 */
export function isTransientStatus(status) {
  if (typeof status !== 'number') return false;
  if (status === 0) return true;
  if (status === 202) return true;
  if (status === 408 || status === 425 || status === 429) return true;
  if (status >= 500 && status < 600) return true;
  return false;
}

/**
 * Modest exponential backoff schedule for JPL retries (milliseconds).
 * Three attempts total: attempt 1 immediately, then wait ~2s, then ~5s.
 * Per the Phase 9D.1 spec: "do not hammer JPL".
 */
export const JPL_RETRY_BACKOFF_MS = [2000, 5000];
export const JPL_MAX_ATTEMPTS = 3;

// ===========================================================================
// Source health model
// ===========================================================================

/**
 * Canonical short labels for the three Science sources. The fetcher
 * output documents use `source: "NASA" | "JPL" | "NOAA-SWPC"`.
 */
export const SOURCE_KEYS = ['NASA', 'JPL', 'SWPC'];

/** Map a fetcher document's `source` field to a canonical short label. */
export function canonicalSourceLabel(doc) {
  if (!doc || typeof doc.source !== 'string') return null;
  if (doc.source === 'NASA') return 'NASA';
  if (doc.source === 'JPL') return 'JPL';
  if (doc.source === 'NOAA-SWPC') return 'SWPC';
  return doc.source;
}

/**
 * Build the per-source health model from the three fetcher output
 * documents.
 *
 * @param {object} docs        - { nasa: doc|null, jpl: doc|null, swpc: doc|null }
 * @param {object} [prevHealth] - previous health state (for consecutiveFailures
 *                               / lastSuccessfulFetchAt continuity). Keys:
 *                               NASA/JPL/SWPC.
 * @returns {object} health map keyed by NASA/JPL/SWPC, each entry:
 *   {
 *     sourceAvailable: boolean,
 *     httpStatus: number|null,
 *     fetchedAt: string|null,
 *     lastSuccessfulFetchAt: string|null,
 *     consecutiveFailures: number,
 *     fetchError: string|null,
 *     recordCount: number,
 *     status: 'HEALTHY' | 'DEGRADED'
 *   }
 */
export function computeSourceHealth(docs, prevHealth = {}) {
  const inputs = [
    { key: 'NASA', doc: docs?.nasa ?? null },
    { key: 'JPL', doc: docs?.jpl ?? null },
    { key: 'SWPC', doc: docs?.swpc ?? null },
  ];
  const health = {};
  for (const { key, doc } of inputs) {
    const prev = prevHealth && prevHealth[key] ? prevHealth[key] : {};
    const available = !!(doc && doc.sourceAvailable === true);
    const fetchedAt = doc && doc.fetchedAt ? doc.fetchedAt : null;
    const prevSuccessAt = prev.lastSuccessfulFetchAt || null;
    const prevConsecutive =
      Number.isFinite(prev.consecutiveFailures) ? prev.consecutiveFailures : 0;
    health[key] = {
      sourceAvailable: available,
      httpStatus: doc && typeof doc.httpStatus === 'number' ? doc.httpStatus : null,
      fetchedAt,
      lastSuccessfulFetchAt: available ? fetchedAt : prevSuccessAt,
      consecutiveFailures: available ? 0 : prevConsecutive + 1,
      fetchError: doc && doc.fetchError ? doc.fetchError : null,
      recordCount: doc && typeof doc.recordCount === 'number' ? doc.recordCount : 0,
      status: available ? 'HEALTHY' : 'DEGRADED',
    };
  }
  return health;
}

/**
 * True when ALL THREE sources are degraded (Scenario F). A clean,
 * successful-but-degraded run that publishes nothing and mutates no
 * production state.
 */
export function allSourcesDegraded(health) {
  return SOURCE_KEYS.every((k) => health[k]?.status === 'DEGRADED');
}

// ===========================================================================
// URL / key normalization for cross-source duplicate matching
// ===========================================================================

/**
 * Normalize a URL for duplicate comparison: lowercase host, strip the
 * trailing slash, drop query/fragment. Two URLs that differ only in
 * trailing slash / query / fragment / case are treated as the same.
 */
export function normalizeUrl(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const u = new URL(url);
    let path = u.pathname.replace(/\/+$/, '');
    if (path === '') path = '/';
    return `${u.protocol}//${u.hostname.toLowerCase()}${path}`;
  } catch {
    return null;
  }
}

/**
 * Build the set of preserved JPL source identities used for cross-source
 * duplicate matching and source-dependency decisions when JPL is degraded.
 *
 * Phase 9D.2 — CANONICAL FALLBACK IS THE TRACKED REGISTRY.
 *
 *   CANONICAL (required for correctness):
 *     data/science/science-source-registry.json  — git-tracked, committed
 *     by the workflow. Survives fresh GitHub Actions checkouts. Carries
 *     scienceKey, sourceUrl, title, mission, topic, publishedAtSource,
 *     storyType, bootstrapSeen, firstSeenAt, lastSeenAt.
 *
 *   NON-CANONICAL CACHE (optional, never required for correctness):
 *     data/science/last-known-good/jpl-news.json — gitignored, local
 *     runtime optimization only. May supplement the registry with the
 *     most recent full fetcher output, but deleting it MUST NOT change
 *     the editorial / dependency outcome.
 *
 * The registry is processed FIRST so its identity is authoritative.
 * The LKG cache (when present) only fills in fields the registry might
 * not yet carry (e.g. on the very first run before the registry builder
 * has persisted the new fields). The merge is key-stable: a scienceKey
 * already seen from the registry is never replaced by the LKG entry.
 *
 * @param {object} opts
 * @param {object|null} opts.lastKnownGoodJpl - parsed last-known-good jpl-news.json doc (NON-CANONICAL cache)
 * @param {object|null} opts.registry         - parsed science-source-registry.json doc (CANONICAL)
 * @returns {Array<{scienceKey:string, source:string|null, sourceUrl:string|null, title:string|null, mission:string|null, topic:string|null, publishedAtSource:string|null, storyType:string|null, bootstrapSeen:boolean|null, firstSeenAt:string|null, lastSeenAt:string|null}>}
 */
export function buildPreservedJplSources({ lastKnownGoodJpl, registry } = {}) {
  const out = [];
  const seenKeys = new Set();
  const push = (entry) => {
    if (!entry || !entry.scienceKey || seenKeys.has(entry.scienceKey)) return;
    seenKeys.add(entry.scienceKey);
    out.push({
      scienceKey: entry.scienceKey,
      source: entry.source || null,
      sourceUrl: entry.sourceUrl || null,
      title: entry.title || null,
      mission: entry.mission || null,
      topic: entry.topic || null,
      publishedAtSource: entry.publishedAtSource || null,
      storyType: entry.storyType || null,
      bootstrapSeen: entry.bootstrapSeen ?? null,
      firstSeenAt: entry.firstSeenAt || null,
      lastSeenAt: entry.lastSeenAt || null,
    });
  };

  // 1. CANONICAL — tracked registry. This is the source of truth that
  //    survives fresh GitHub Actions checkouts.
  if (registry && Array.isArray(registry.sources)) {
    for (const s of registry.sources) {
      if (s && s.scienceKey && (s.source === 'JPL' || /^jpl__/.test(s.scienceKey))) {
        push(s);
      }
    }
  }

  // 2. NON-CANONICAL CACHE — local last-known-good. Optional supplement;
  //    only adds scienceKeys the registry does not already know. Deleting
  //    this file must not change the outcome because the registry already
  //    carries every identity field needed for duplicate / dependency
  //    decisions.
  if (lastKnownGoodJpl && Array.isArray(lastKnownGoodJpl.records)) {
    for (const r of lastKnownGoodJpl.records) {
      if (r && r.scienceKey) {
        push({
          scienceKey: r.scienceKey,
          source: r.source || 'JPL',
          sourceUrl: r.sourceUrl || null,
          title: r.title || null,
          mission: r.mission || null,
          topic: r.topic || null,
          publishedAtSource: r.publishedAtSource || null,
          storyType: r.storyType || null,
          bootstrapSeen: null,
          firstSeenAt: null,
          lastSeenAt: null,
        });
      }
    }
  }

  return out;
}

// ===========================================================================
// Source-dependency decision (the core Phase 9D.1 rule)
// ===========================================================================

/**
 * Decide whether a NEW publication candidate may PROCEED during a
 * degraded-source state, or must be DEFERRED until the missing source
 * recovers.
 *
 * Rules (deterministic — see Phase 9D.1 spec sections 4-8):
 *
 *   SWPC candidate:
 *     - SWPC degraded → defer (deferred-source-degraded).
 *     - otherwise     → proceed (SWPC is independent of JPL).
 *
 *   NASA/JPL candidate:
 *     - own source degraded → defer (deferred-source-degraded).
 *     - JPL healthy         → proceed (normal Phase 9D pipeline).
 *     - JPL DEGRADED:
 *         * hard duplicate (sourceKey or sourceUrl matches a preserved
 *           JPL source) → defer (deferred-source-dependency).
 *         * JPL-managed mission → defer (deferred-source-dependency).
 *         * otherwise (NASA-only / independent mission, no duplicate
 *           match) → proceed.
 *
 * @param {object} candidate           - story object: { primarySource, mission,
 *                                        scienceStoryKey, allSourceKeys, sourceUrls }
 * @param {object} sourceHealth        - health map from computeSourceHealth
 * @param {Array}  [preservedJplSources] - from buildPreservedJplSources
 * @returns {{ decision: 'proceed'|'defer', reason: string, deferStatus?: string }}
 */
export function evaluateSourceDependency(candidate, sourceHealth, preservedJplSources = []) {
  if (!candidate || !sourceHealth) {
    return { decision: 'proceed', reason: 'no health info — default proceed' };
  }

  const isSwpc =
    candidate.primarySource === 'NOAA-SWPC' ||
    (typeof candidate.scienceStoryKey === 'string' && candidate.scienceStoryKey.startsWith('swpc__'));
  const isNasa = candidate.primarySource === 'NASA' ||
    (typeof candidate.scienceStoryKey === 'string' && candidate.scienceStoryKey.startsWith('nasa__'));
  const isJpl = candidate.primarySource === 'JPL' ||
    (typeof candidate.scienceStoryKey === 'string' && candidate.scienceStoryKey.startsWith('jpl__'));

  // --- SWPC independence (section 6) --------------------------------------
  if (isSwpc) {
    if (sourceHealth.SWPC?.status === 'DEGRADED') {
      return {
        decision: 'defer',
        reason: 'SWPC source degraded — cannot verify the event',
        deferStatus: 'deferred-source-degraded',
      };
    }
    return {
      decision: 'proceed',
      reason: 'SWPC event independent of JPL — may publish during JPL outage',
    };
  }

  // --- Own-source degraded check (sections 3, 11) -------------------------
  if (isNasa && sourceHealth.NASA?.status === 'DEGRADED') {
    return {
      decision: 'defer',
      reason: 'NASA source degraded — cannot verify the candidate',
      deferStatus: 'deferred-source-degraded',
    };
  }
  if (isJpl && sourceHealth.JPL?.status === 'DEGRADED') {
    return {
      decision: 'defer',
      reason: 'JPL source degraded — cannot verify the JPL candidate',
      deferStatus: 'deferred-source-degraded',
    };
  }

  // --- JPL healthy → normal Phase 9D pipeline (section 13 Scenario E) -----
  if (sourceHealth.JPL?.status !== 'DEGRADED') {
    return { decision: 'proceed', reason: 'JPL healthy — normal pipeline' };
  }

  // === JPL is DEGRADED — cross-source duplicate safety (sections 4, 5, 8) ===

  // 1. Hard duplicate: the candidate's sourceKey or any sourceUrl matches
  //    a preserved JPL source. This is a strong deterministic signal that
  //    the story is (or duplicates) a JPL release we cannot currently see.
  const candKeys = new Set(
    Array.isArray(candidate.allSourceKeys) && candidate.allSourceKeys.length > 0
      ? candidate.allSourceKeys
      : [candidate.scienceStoryKey].filter(Boolean),
  );
  const candUrls = new Set(
    (Array.isArray(candidate.sourceUrls) ? candidate.sourceUrls : [])
      .map(normalizeUrl)
      .filter(Boolean),
  );
  for (const js of preservedJplSources) {
    if (js.scienceKey && candKeys.has(js.scienceKey)) {
      return {
        decision: 'defer',
        reason: `cross-source duplicate: candidate source key ${js.scienceKey} matches a preserved JPL source`,
        deferStatus: 'deferred-source-dependency',
      };
    }
    const jsUrl = normalizeUrl(js.sourceUrl);
    if (jsUrl && candUrls.has(jsUrl)) {
      return {
        decision: 'defer',
        reason: 'cross-source duplicate: candidate source URL matches a preserved JPL source',
        deferStatus: 'deferred-source-dependency',
      };
    }
  }

  // 2. JPL-managed mission → defer (uncertain cross-source duplicate).
  if (isJplManagedMission(candidate.mission)) {
    return {
      decision: 'defer',
      reason: `JPL-managed mission "${candidate.mission}" with JPL degraded — cross-source duplicate uncertain`,
      deferStatus: 'deferred-source-dependency',
    };
  }

  // 3. NASA-only / independent mission (Hubble, Webb, HQ, Earth-science
  //    unrelated to JPL, or no mission) → proceed (section 7).
  return {
    decision: 'proceed',
    reason: `NASA-only story (mission=${candidate.mission || 'none'}) independent of JPL — may publish during JPL outage`,
  };
}

// ===========================================================================
// Internal-only diagnostic terms (must NEVER appear on public pages)
// ===========================================================================

/**
 * Tokens that identify internal source-health diagnostics. These must
 * never appear in public article markdown or rendered pages. Used by
 * validate-science check 77 (no public source-health exposure).
 */
export const INTERNAL_SOURCE_HEALTH_TOKENS = [
  'sourceAvailable',
  'fetchError',
  'httpStatus',
  'consecutiveFailures',
  'lastSuccessfulFetchAt',
  'DEGRADED',
  'deferred-source-dependency',
  'deferred-source-degraded',
  'source-health',
  'last-known-good',
];
