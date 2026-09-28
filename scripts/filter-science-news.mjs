/**
 * US News Engine — Science newsworthiness filter (Phase 9A.2 hardened).
 *
 * Reads the three Phase 9A fetcher outputs:
 *   - data/science/nasa-news.json
 *   - data/science/jpl-news.json
 *   - data/science/swpc-events.json
 *
 * Applies STRICT `publishEligible` gating based on `storyType` AND a
 * new `freshnessStatus` gate, and writes candidates to:
 *   data/science/science-news-candidates.json
 *
 * Phase 9A.2 changes from Phase 9A.1:
 *   - Adds `freshnessStatus` and `sourceAgeDays` to every candidate,
 *     computed from `publishedAtSource` (the SOURCE publication date,
 *     NOT ingestion time). `freshnessStatus` is one of:
 *       * `current`  — <14 days old
 *       * `recent`   — 14-30 days old
 *       * `archive`  — >30 days old
 *       * `null`     — `publishedAtSource` missing or unparsable
 *   - Adds a freshness gate on `publishEligible`:
 *       * `current`  — eligible when `storyType` is publishable AND
 *                      the significance gate passes.
 *       * `recent`   — eligible ONLY when `storyType` is in
 *                      RECENT_ELIGIBLE_TYPES (discovery, launch,
 *                      landing, mission-milestone, earth-science) AND
 *                      the story is genuinely significant (substantive
 *                      title + description).
 *       * `archive`  — NEVER publishEligible during the initial launch
 *                      phase. (Future editorial override possible.)
 *       * missing date — NEVER publishEligible.
 *   - Adds three new storyType overrides:
 *       * `technical-guidance`   — TB / technical bulletin / material
 *                                  guidance / specification / standard.
 *       * `mission-preparation`  — "ahead of launch", "preparing for
 *                                  launch", pre-mission prep.
 *       * `mission-result`       — post-mission data / operational
 *                                  imagery (Earth-obs satellites are
 *                                  routed to `earth-science` by the
 *                                  fetcher's classifier).
 *   - Expands the media-advisory title-pattern override to cover
 *     "to share", "will share", "to announce", "will announce",
 *     "to reveal", "will reveal", "to discuss", "will discuss".
 *   - Each candidate now carries `eligibilityReasons` /
 *     `exclusionReasons` (plural arrays). The legacy `eligibilityReason`
 *     / `exclusionReason` (singular) fields are retained for backward
 *     compatibility with the existing validator/scorer; they're set
 *     to the first element of the corresponding plural array.
 *
 * publishEligible = true ONLY when ALL of:
 *   1. storyType is one of PUBLISH_ELIGIBLE_TYPES
 *   2. The storyType's significance gate passes
 *   3. freshnessStatus is `current` OR (`recent` AND storyType is in
 *      RECENT_ELIGIBLE_TYPES AND the story is substantively significant)
 *   4. publishedAtSource is present (no missing date)
 *
 * publishEligible = false for:
 *   - storyType ∈ {space-policy, administrative, education,
 *     media-advisory, evergreen, technical-guidance,
 *     mission-preparation}
 *   - archive stories (>30 days old)
 *   - missing publishedAtSource
 *   - stories that fail the significance gate
 *   - recent stories whose storyType isn't in RECENT_ELIGIBLE_TYPES
 *
 * Run:
 *   npm run filter:science
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(__dirname, '..');
const INPUT_FILES = {
  nasa: join(PROJECT_DIR, 'data', 'science', 'nasa-news.json'),
  jpl: join(PROJECT_DIR, 'data', 'science', 'jpl-news.json'),
  swpc: join(PROJECT_DIR, 'data', 'science', 'swpc-events.json'),
};
const OUTPUT_FILE = join(PROJECT_DIR, 'data', 'science', 'science-news-candidates.json');

// --- Story-type constants (must match the fetchers) -----------------------
const STORY_TYPES = {
  MISSION_MILESTONE: 'mission-milestone',
  LAUNCH: 'launch',
  LANDING: 'landing',
  DISCOVERY: 'discovery',
  ASTRONOMY: 'astronomy',
  EARTH_SCIENCE: 'earth-science',
  TECHNOLOGY: 'technology',
  CREW_MISSION: 'crew-mission',
  SPACE_WEATHER: 'space-weather',
  SPACE_POLICY: 'space-policy',
  ADMINISTRATIVE: 'administrative',
  EDUCATION: 'education',
  MEDIA_ADVISORY: 'media-advisory',
  EVERGREEN: 'evergreen',
  TECHNICAL_GUIDANCE: 'technical-guidance',
  MISSION_PREPARATION: 'mission-preparation',
  MISSION_RESULT: 'mission-result',
};

// Story types whose members are eligible for publication (subject to
// the freshness gate and additional significance gates below).
const PUBLISH_ELIGIBLE_TYPES = new Set([
  STORY_TYPES.MISSION_MILESTONE,
  STORY_TYPES.LAUNCH,
  STORY_TYPES.LANDING,
  STORY_TYPES.DISCOVERY,
  STORY_TYPES.ASTRONOMY,
  STORY_TYPES.EARTH_SCIENCE,
  STORY_TYPES.TECHNOLOGY,
  STORY_TYPES.CREW_MISSION,
  STORY_TYPES.SPACE_WEATHER,
  STORY_TYPES.MISSION_RESULT,
]);

// Story types that are NEVER publishEligible (regardless of freshness).
const NEVER_PUBLISH_TYPES = new Set([
  STORY_TYPES.SPACE_POLICY,
  STORY_TYPES.ADMINISTRATIVE,
  STORY_TYPES.EDUCATION,
  STORY_TYPES.MEDIA_ADVISORY,
  STORY_TYPES.EVERGREEN,
  STORY_TYPES.TECHNICAL_GUIDANCE,
  STORY_TYPES.MISSION_PREPARATION,
]);

// Story types that may be publishEligible when freshnessStatus='recent'
// (14-30 days old). All other publishable types are restricted to
// `current` (<14 days). Per Phase 9A.2 spec: "eligible ONLY if
// storyType is `discovery`, `launch`, `landing`, `mission-milestone`,
// `earth-science` AND the story is genuinely significant."
const RECENT_ELIGIBLE_TYPES = new Set([
  STORY_TYPES.DISCOVERY,
  STORY_TYPES.LAUNCH,
  STORY_TYPES.LANDING,
  STORY_TYPES.MISSION_MILESTONE,
  STORY_TYPES.EARTH_SCIENCE,
]);

// SWPC severity thresholds (mirror the fetcher's pre-filter).
const SWPC_MEANINGFUL_SEVERITY = new Set([
  'R3', 'R4', 'R5',
  'S2', 'S3', 'S4', 'S5',
  'G3', 'G4', 'G5',
]);
const SWPC_HIGH_PRIORITY_SEVERITY = new Set([
  'R4', 'R5',
  'S3', 'S4', 'S5',
  'G4', 'G5',
]);

// --- Freshness thresholds -------------------------------------------------
const FRESHNESS_CURRENT_MAX_DAYS = 14;   // < 14 days
const FRESHNESS_RECENT_MAX_DAYS = 30;    // 14..30 days
// > 30 days = archive

// --- Title-pattern overrides ----------------------------------------------
// These patterns OVERRIDE the fetcher's storyType classification when
// they appear in the title. They implement the Phase 9A.1 + 9A.2 hard
// exclusions.

const TITLE_PATTERN_OVERRIDES = [
  // APOD items — title starts with "APOD:" or contains "Astronomy
  // Picture of the Day". Force storyType = evergreen.
  {
    name: 'apod',
    storyType: STORY_TYPES.EVERGREEN,
    test: (t) => /^apod[:\s]/i.test(t) || /astronomy\s+picture\s+of\s+the\s+day/i.test(t),
    reason: 'Excluded: APOD (Astronomy Picture of the Day) is evergreen content',
  },
  // Technical bulletin / material guidance / specification / standard.
  // Phase 9A.2 new. Example: "TB 26-07 Aluminum Alloy 2219 Material
  // Guidance". These are engineering reference documents, NOT news.
  {
    name: 'technical-guidance',
    storyType: STORY_TYPES.TECHNICAL_GUIDANCE,
    test: (t) =>
      /^TB\s+\d+/i.test(t) ||
      /\btechnical\s+bulletin\b/i.test(t) ||
      /\bmaterial\s+guidance\b/i.test(t) ||
      /\bmaterial\s+specification\b/i.test(t) ||
      /\bspecification\s+\d+/i.test(t) ||
      /\bstandard\s+\d+/i.test(t) ||
      /\bNASA\s+standard\b/i.test(t),
    reason: 'Excluded: technical guidance / bulletin / specification (not news)',
  },
  // Media advisory / press briefing / future reveal announcement.
  // Phase 9A.2 expanded: now also catches "to share", "will share",
  // "to announce", "will announce", "to reveal", "will reveal",
  // "to discuss", "will discuss".
  {
    name: 'media-advisory',
    storyType: STORY_TYPES.MEDIA_ADVISORY,
    test: (t) =>
      /\bmedia\s+advisory\b/i.test(t) ||
      /\bmedia\s+teleconference\b/i.test(t) ||
      /\bmedia\s+call\b/i.test(t) ||
      /\bto\s+(?:provide\s+update|share|announce|reveal|discuss)\b/i.test(t) ||
      /\bwill\s+(?:provide\s+update|share|announce|reveal|discuss)\b/i.test(t) ||
      /\bpress\s+brief(?:ing)?\b/i.test(t) ||
      /\bpreviews?\b/i.test(t) ||
      /\bbriefing\b/i.test(t),
    reason: 'Excluded: media advisory / press briefing / future reveal announcement',
  },
  // Mission preparation — "ahead of launch", "preparing for launch",
  // pre-mission prep. Phase 9A.2 new. Pre-launch announcements are
  // not publishable.
  {
    name: 'mission-preparation',
    storyType: STORY_TYPES.MISSION_PREPARATION,
    test: (t) =>
      /\bahead\s+of\s+(?:launch|mission|its\s+launch|the\s+launch)/i.test(t) ||
      /\bpreparing\s+for\s+(?:launch|mission)/i.test(t) ||
      /\bready\s+for\s+(?:launch|mission)/i.test(t) ||
      /\bpreliminary\s+design\s+review/i.test(t) ||
      /\bcritical\s+design\s+review/i.test(t) ||
      /\bpre-?launch\s+(?:test|checkout|processing|prep)/i.test(t),
    reason: 'Excluded: mission-preparation (pre-launch announcement, not the launch event)',
  },
  // Space policy — force storyType = space-policy.
  {
    name: 'space-policy',
    storyType: STORY_TYPES.SPACE_POLICY,
    test: (t) =>
      /\bartemis\s+accords\b/i.test(t) ||
      /\bsigning\b/i.test(t) ||
      /\bsigns?\s+(?:the\s+)?(?:artemis|agreement|accord)/i.test(t) ||
      /\bagreement\b/i.test(t) ||
      /\baccord\b/i.test(t) ||
      /\bmemorandum\s+of\s+understanding\b/i.test(t),
    reason: 'Excluded: space-policy / diplomatic announcement',
  },
  // Education — force storyType = education.
  {
    name: 'education',
    storyType: STORY_TYPES.EDUCATION,
    test: (t) =>
      /\bchallenges?\b/i.test(t) ||
      /\bcontests?\b/i.test(t) ||
      /\bstudents?\b/i.test(t) ||
      /\beducation\b/i.test(t) ||
      /\bSTEM\b/i.test(t),
    reason: 'Excluded: education / outreach program',
  },
];

// --- Significance gates (per-storyType) ----------------------------------

const SIGNIFICANCE_GATES = [
  {
    storyType: STORY_TYPES.ASTRONOMY,
    // Major finding indicators — must contain at least one.
    indicatorRe:
      /\bdiscover(?:y|ed|ies)\b|\bfirst\s+(?:image|light|observation|measurement|look)\b|\bmost\s+distant\b|\bearliest\b|\bunprecedented\b|\bnew\s+(?:image|observation|measurement|data)\b|\bcaptures?\b|\bspots\b|\breveals?\b|\bfinding(?:s)?\b|\bresult(?:s)?\b|\bdetected\b/i,
    failReason: 'Excluded: astronomy story is a routine observation (no major-finding indicator)',
  },
  {
    storyType: STORY_TYPES.TECHNOLOGY,
    indicatorRe:
      /\bdemonstrat(?:e|ion|ed)\b|\bfirst\s+(?:successful\s+)?(?:test|flight|demonstration)\b|\bsuccessful\s+test\b|\bprototype\b|\binnovat(?:e|ion|ive)\b|\b3d[\s-]?print\b|\bnew\s+technology\b|\btechnology\s+demonstration\b/i,
    failReason: 'Excluded: technology story is not a significant demonstration',
  },
  {
    storyType: STORY_TYPES.CREW_MISSION,
    // Exclude announcements — actual events (docking, splashdown,
    // spacewalk, launch, return) earn publication. We invert the
    // check: if the item looks like an announcement, fail.
    isAnnouncementRe:
      /\bassign(?:s|ed|ing)?\b|\bnames?\s+crew\b|\bselects?\s+(?:crew|astronaut)|\bannounce(?:s|d|ment)?\b|\bnominat/i,
    failReason: 'Excluded: crew-mission story is an announcement (not an actual event)',
  },
  {
    storyType: STORY_TYPES.MISSION_RESULT,
    // Mission-result stories must mention a result indicator or a
    // science finding to be publishable. This is the same vocabulary
    // the fetcher uses to detect "this is a result, not a launch".
    indicatorRe:
      /\b(?:delivers?\s+data|captures?|reveals?|first\s+(?:image|radar|light|data|map|measurement)s?|new\s+(?:image|data)|finding(?:s)?|result(?:s)?|discover)/i,
    failReason: 'Excluded: mission-result story lacks a result/data indicator',
  },
];

// --- Helpers ---------------------------------------------------------------

function lower(s) {
  return (s == null ? '' : String(s)).toLowerCase();
}

/**
 * Compute the freshness of a record given its publishedAtSource
 * timestamp and the current time. Returns
 *   { sourceAgeDays: number|null, freshnessStatus: 'current'|'recent'|'archive'|null }
 *
 * `freshnessStatus` is null when publishedAtSource is missing or
 * unparsable, or when the date is in the future (which would indicate
 * a data-quality issue rather than a real freshness band).
 */
function computeFreshness(publishedAtSource, now) {
  if (!publishedAtSource) {
    return { sourceAgeDays: null, freshnessStatus: null };
  }
  const pubDate = new Date(publishedAtSource);
  if (Number.isNaN(pubDate.getTime())) {
    return { sourceAgeDays: null, freshnessStatus: null };
  }
  const ageMs = now.getTime() - pubDate.getTime();
  if (ageMs < 0) {
    // Future-dated item — treat as missing freshness (data quality
    // issue, not a real band).
    return { sourceAgeDays: null, freshnessStatus: null };
  }
  const days = ageMs / (24 * 60 * 60 * 1000);
  let status;
  if (days < FRESHNESS_CURRENT_MAX_DAYS) status = 'current';
  else if (days <= FRESHNESS_RECENT_MAX_DAYS) status = 'recent';
  else status = 'archive';
  return { sourceAgeDays: days, freshnessStatus: status };
}

/**
 * Apply the title-pattern overrides to (possibly) re-classify a
 * record's storyType. Returns { storyType, overrideReason } where
 * overrideReason is non-null when an override fired.
 */
function applyTitleOverrides(title) {
  for (const override of TITLE_PATTERN_OVERRIDES) {
    if (override.test(title || '')) {
      return { storyType: override.storyType, overrideReason: override.reason };
    }
  }
  return { storyType: null, overrideReason: null };
}

/**
 * Apply the significance gate for a storyType. Returns { passes, reason }
 * where `passes` is true when no gate applies OR the gate's indicator
 * is found (or, for crew-mission, the announcement indicator is NOT
 * found).
 */
function applySignificanceGate(storyType, title, description) {
  const gate = SIGNIFICANCE_GATES.find((g) => g.storyType === storyType);
  if (!gate) return { passes: true, reason: null };

  const combined = `${title || ''}\n${description || ''}`;

  if (storyType === STORY_TYPES.CREW_MISSION) {
    // Inverted check — fail when the announcement indicator matches.
    if (gate.isAnnouncementRe.test(combined)) {
      return { passes: false, reason: gate.failReason };
    }
    return { passes: true, reason: null };
  }

  if (!gate.indicatorRe.test(combined)) {
    return { passes: false, reason: gate.failReason };
  }
  return { passes: true, reason: null };
}

/**
 * "Genuinely significant" check for recent stories. Per Phase 9A.2
 * spec, a recent (14-30 day old) story is publishEligible ONLY if it
 * is "genuinely significant". We approximate that with a substantive-
 * content heuristic: title length >= 25 chars AND description length
 * >= 50 chars. (This catches bare "Launch successful!" headlines and
 * empty-description placeholder items without needing an LLM.)
 */
function isSubstantive(record) {
  const title = String(record.title || '');
  const desc = String(record.description || '');
  return title.length >= 25 && desc.length >= 50;
}

/**
 * Evaluate a NASA/JPL record for publishEligibility. Always returns
 * a candidate decision object — the filter no longer drops records
 * based on storyType. Every record is included as a candidate, with
 * publishEligible true or false.
 *
 * Returned object shape:
 *   {
 *     storyType, storyTypeSource,
 *     publishEligible: boolean,
 *     priority: 'high' | 'medium' | null,
 *     freshnessStatus, sourceAgeDays,
 *     eligibilityReasons: string[],   // non-empty when publishEligible
 *     exclusionReasons: string[],     // non-empty when !publishEligible
 *   }
 */
function evaluateNasaJpl(record, now) {
  const title = record.title || '';
  const description = record.description || '';

  // 1. Compute freshness from publishedAtSource (the SOURCE pub date,
  //    NOT ingestion time).
  const freshness = computeFreshness(record.publishedAtSource, now);

  // 2. Title-pattern overrides take precedence over the fetcher's
  //    storyType classification.
  const override = applyTitleOverrides(title);
  let storyType = override.storyType || record.storyType || STORY_TYPES.MISSION_MILESTONE;
  let storyTypeSource = override.storyType ? 'title-override' : 'fetcher';

  const exclusionReasons = [];
  const eligibilityReasons = [];

  if (override.overrideReason) {
    exclusionReasons.push(override.overrideReason);
  }

  // 3. NEVER_PUBLISH_TYPES — exclude immediately.
  if (NEVER_PUBLISH_TYPES.has(storyType)) {
    if (exclusionReasons.length === 0) {
      exclusionReasons.push(`storyType "${storyType}" is never publish-eligible`);
    }
    return finalizeDecision({
      storyType,
      storyTypeSource,
      publishEligible: false,
      priority: null,
      freshness,
      eligibilityReasons,
      exclusionReasons,
    });
  }

  // 4. Freshness gate: missing date is NEVER publishEligible.
  if (!freshness.freshnessStatus) {
    exclusionReasons.push('missing or unparsable publishedAtSource date (cannot compute freshness)');
    return finalizeDecision({
      storyType,
      storyTypeSource,
      publishEligible: false,
      priority: null,
      freshness,
      eligibilityReasons,
      exclusionReasons,
    });
  }

  // 5. Freshness gate: archive stories (>30 days) are NEVER
  //    publishEligible during the initial launch phase.
  if (freshness.freshnessStatus === 'archive') {
    exclusionReasons.push(
      `archive story (${freshness.sourceAgeDays.toFixed(1)} days old, >${FRESHNESS_RECENT_MAX_DAYS} days) — not eligible during initial launch phase`,
    );
    return finalizeDecision({
      storyType,
      storyTypeSource,
      publishEligible: false,
      priority: null,
      freshness,
      eligibilityReasons,
      exclusionReasons,
    });
  }

  // 6. storyType not in PUBLISH_ELIGIBLE_TYPES (catch-all for any
  //    other non-publishable type that survived the override check).
  if (!PUBLISH_ELIGIBLE_TYPES.has(storyType)) {
    exclusionReasons.push(`storyType "${storyType}" is not publish-eligible`);
    return finalizeDecision({
      storyType,
      storyTypeSource,
      publishEligible: false,
      priority: null,
      freshness,
      eligibilityReasons,
      exclusionReasons,
    });
  }

  // 7. Per-storyType significance gate (astronomy / technology /
  //    crew-mission / mission-result).
  const gate = applySignificanceGate(storyType, title, description);
  if (!gate.passes) {
    exclusionReasons.push(gate.reason);
    return finalizeDecision({
      storyType,
      storyTypeSource,
      publishEligible: false,
      priority: null,
      freshness,
      eligibilityReasons,
      exclusionReasons,
    });
  }

  // 8. Freshness gate: recent stories (14-30 days) are eligible
  //    ONLY for RECENT_ELIGIBLE_TYPES AND when substantively
  //    significant.
  if (freshness.freshnessStatus === 'recent') {
    if (!RECENT_ELIGIBLE_TYPES.has(storyType)) {
      exclusionReasons.push(
        `recent story (${freshness.sourceAgeDays.toFixed(1)} days old) but storyType "${storyType}" is not in the recent-eligible set`,
      );
      return finalizeDecision({
        storyType,
        storyTypeSource,
        publishEligible: false,
        priority: null,
        freshness,
        eligibilityReasons,
        exclusionReasons,
      });
    }
    if (!isSubstantive(record)) {
      exclusionReasons.push(
        `recent story but not substantively significant (title or description too short)`,
      );
      return finalizeDecision({
        storyType,
        storyTypeSource,
        publishEligible: false,
        priority: null,
        freshness,
        eligibilityReasons,
        exclusionReasons,
      });
    }
  }

  // 9. Eligible — assign priority and reasons.
  const highPriorityTypes = new Set([
    STORY_TYPES.LAUNCH,
    STORY_TYPES.LANDING,
    STORY_TYPES.DISCOVERY,
    STORY_TYPES.MISSION_MILESTONE,
    STORY_TYPES.CREW_MISSION,
  ]);
  const priority = highPriorityTypes.has(storyType) ? 'high' : 'medium';

  eligibilityReasons.push(`storyType "${storyType}" is publish-eligible (${storyTypeSource})`);
  eligibilityReasons.push(
    `freshness "${freshness.freshnessStatus}" (${freshness.sourceAgeDays.toFixed(1)} days old) passes the freshness gate`,
  );
  if (freshness.freshnessStatus === 'recent') {
    eligibilityReasons.push('recent story is genuinely significant (substantive content)');
  }

  return finalizeDecision({
    storyType,
    storyTypeSource,
    publishEligible: true,
    priority,
    freshness,
    eligibilityReasons,
    exclusionReasons,
  });
}

/**
 * Evaluate an SWPC record. The fetcher already pre-filters to
 * meaningful severities (R3+, S2+, G3+); this is the safety net.
 * SWPC records are always storyType = 'space-weather'.
 *
 * SWPC records don't have a `publishedAtSource` from a feed pubDate
 * in the same way NASA/JPL do — they use the alert's `issueTime`. The
 * fetcher sets `publishedAtSource` to the issueTime, so the freshness
 * gate works the same way. Space-weather alerts are real-time: any
 * alert older than 14 days is `recent` and subject to the
 * RECENT_ELIGIBLE_TYPES check (space-weather is NOT in that set, so
 * such alerts are excluded). Older alerts are archive and excluded.
 */
function evaluateSwpc(record, now) {
  const storyType = STORY_TYPES.SPACE_WEATHER;
  const severity = record.severity || null;
  const freshness = computeFreshness(record.publishedAtSource, now);

  const exclusionReasons = [];
  const eligibilityReasons = [];

  if (!severity) {
    exclusionReasons.push('SWPC alert has no severity code parsed');
    return finalizeDecision({
      storyType,
      storyTypeSource: 'fetcher',
      publishEligible: false,
      priority: null,
      freshness,
      eligibilityReasons,
      exclusionReasons,
    });
  }

  if (!SWPC_MEANINGFUL_SEVERITY.has(severity)) {
    exclusionReasons.push(
      `SWPC severity ${severity} below publication threshold (R3+/S2+/G3+)`,
    );
    return finalizeDecision({
      storyType,
      storyTypeSource: 'fetcher',
      publishEligible: false,
      priority: null,
      freshness,
      eligibilityReasons,
      exclusionReasons,
    });
  }

  // Freshness gate: SWPC alerts must be `current` (space-weather is
  // NOT in RECENT_ELIGIBLE_TYPES, so `recent` alerts are excluded;
  // `archive` alerts are excluded by the general rule).
  if (!freshness.freshnessStatus) {
    exclusionReasons.push('SWPC alert has missing or unparsable publishedAtSource (issueTime)');
    return finalizeDecision({
      storyType,
      storyTypeSource: 'fetcher',
      publishEligible: false,
      priority: null,
      freshness,
      eligibilityReasons,
      exclusionReasons,
    });
  }
  if (freshness.freshnessStatus === 'archive') {
    exclusionReasons.push(
      `archive SWPC alert (${freshness.sourceAgeDays.toFixed(1)} days old) — not eligible`,
    );
    return finalizeDecision({
      storyType,
      storyTypeSource: 'fetcher',
      publishEligible: false,
      priority: null,
      freshness,
      eligibilityReasons,
      exclusionReasons,
    });
  }
  if (freshness.freshnessStatus === 'recent') {
    exclusionReasons.push(
      `recent SWPC alert (${freshness.sourceAgeDays.toFixed(1)} days old) — space-weather is real-time, only current alerts are eligible`,
    );
    return finalizeDecision({
      storyType,
      storyTypeSource: 'fetcher',
      publishEligible: false,
      priority: null,
      freshness,
      eligibilityReasons,
      exclusionReasons,
    });
  }

  // current + meaningful severity → eligible.
  const priority = SWPC_HIGH_PRIORITY_SEVERITY.has(severity) ? 'high' : 'medium';
  eligibilityReasons.push(`SWPC severity ${severity} ${record.watchWarningType || ''}`.trim());
  eligibilityReasons.push(
    `freshness "current" (${freshness.sourceAgeDays.toFixed(1)} days old) passes the freshness gate`,
  );

  return finalizeDecision({
    storyType,
    storyTypeSource: 'fetcher',
    publishEligible: true,
    priority,
    freshness,
    eligibilityReasons,
    exclusionReasons,
  });
}

/**
 * Build the final decision object, including the legacy singular
 * `eligibilityReason` / `exclusionReason` fields (set to the first
 * element of the plural arrays) for backward compatibility with
 * the existing validator/scorer.
 */
function finalizeDecision(d) {
  return {
    storyType: d.storyType,
    storyTypeSource: d.storyTypeSource,
    publishEligible: d.publishEligible,
    priority: d.priority,
    freshnessStatus: d.freshness.freshnessStatus,
    sourceAgeDays: d.freshness.sourceAgeDays,
    eligibilityReasons: d.eligibilityReasons,
    exclusionReasons: d.exclusionReasons,
    // Legacy singular fields (first element of the plural arrays,
    // or null when empty) for backward compatibility.
    eligibilityReason: d.eligibilityReasons.length > 0 ? d.eligibilityReasons[0] : null,
    exclusionReason: d.exclusionReasons.length > 0 ? d.exclusionReasons[0] : null,
    // `selectedReason` was the Phase 9A.1 single-string field; keep
    // it populated for the validator's check 9 (publishEligible items
    // must have a non-empty selectedReason).
    selectedReason: d.publishEligible
      ? d.eligibilityReasons.length > 0
        ? d.eligibilityReasons[0]
        : 'Eligible'
      : d.exclusionReasons.length > 0
        ? d.exclusionReasons[0]
        : 'Excluded',
  };
}

// --- Main ------------------------------------------------------------------

async function loadJsonOptional(path) {
  try {
    const raw = await readFile(path, 'utf8');
    return { ok: true, doc: JSON.parse(raw) };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: false, reason: 'missing' };
    return { ok: false, reason: String(err) };
  }
}

async function main() {
  console.log('[filter-science-news] Starting newsworthiness filter (Phase 9A.2).');
  console.log(`  Inputs:  ${Object.values(INPUT_FILES).join(', ')}`);
  console.log(`  Output:  ${OUTPUT_FILE}`);

  // --- Load all three fetcher outputs -------------------------------------
  const nasaRes = await loadJsonOptional(INPUT_FILES.nasa);
  const jplRes = await loadJsonOptional(INPUT_FILES.jpl);
  const swpcRes = await loadJsonOptional(INPUT_FILES.swpc);

  if (!nasaRes.ok) {
    console.error(`  ERROR: nasa-news.json not found (${nasaRes.reason}). Run fetch:nasa first.`);
    process.exit(1);
  }
  if (!jplRes.ok) {
    console.error(`  ERROR: jpl-news.json not found (${jplRes.reason}). Run fetch:jpl first.`);
    process.exit(1);
  }
  if (!swpcRes.ok) {
    console.error(`  ERROR: swpc-events.json not found (${swpcRes.reason}). Run fetch:swpc first.`);
    process.exit(1);
  }

  const nasaRecords = Array.isArray(nasaRes.doc.records) ? nasaRes.doc.records : [];
  const jplRecords = Array.isArray(jplRes.doc.records) ? jplRes.doc.records : [];
  const swpcRecords = Array.isArray(swpcRes.doc.records) ? swpcRes.doc.records : [];

  console.log(
    `  NASA: ${nasaRecords.length} records (sourceAvailable=${nasaRes.doc.sourceAvailable ?? 'n/a'}, httpStatus=${nasaRes.doc.httpStatus ?? 'n/a'})`,
  );
  console.log(
    `  JPL:  ${jplRecords.length} records (sourceAvailable=${jplRes.doc.sourceAvailable ?? 'n/a'}, httpStatus=${jplRes.doc.httpStatus ?? 'n/a'})`,
  );
  console.log(
    `  SWPC: ${swpcRecords.length} records (sourceAvailable=${swpcRes.doc.sourceAvailable ?? 'n/a'}, httpStatus=${swpcRes.doc.httpStatus ?? 'n/a'})`,
  );

  const now = new Date();
  console.log(`  Filter time (UTC): ${now.toISOString()}`);

  const candidates = [];
  const exclusionBreakdown = {};
  const storyTypeBreakdown = {};
  const freshnessBreakdown = { current: 0, recent: 0, archive: 0, missing: 0 };
  let publishEligibleCount = 0;
  let highPriorityCount = 0;

  function evaluateAndPush(record, evaluator, sourceLabel) {
    const decision = evaluator(record, now);
    storyTypeBreakdown[decision.storyType] = (storyTypeBreakdown[decision.storyType] || 0) + 1;
    if (decision.freshnessStatus) {
      freshnessBreakdown[decision.freshnessStatus]++;
    } else {
      freshnessBreakdown.missing++;
    }
    if (decision.publishEligible) {
      publishEligibleCount++;
      if (decision.priority === 'high') highPriorityCount++;
    } else {
      const primaryReason = decision.exclusionReasons[0] || 'unknown';
      const key = `${sourceLabel}: ${primaryReason}`;
      exclusionBreakdown[key] = (exclusionBreakdown[key] || 0) + 1;
    }
    candidates.push({
      ...record,
      storyType: decision.storyType,
      storyTypeSource: decision.storyTypeSource,
      publishEligible: decision.publishEligible,
      priority: decision.priority,
      freshnessStatus: decision.freshnessStatus,
      sourceAgeDays: decision.sourceAgeDays,
      eligibilityReasons: decision.eligibilityReasons,
      exclusionReasons: decision.exclusionReasons,
      // Legacy singular fields (kept for backward compat with the
      // existing validator/scorer).
      eligibilityReason: decision.eligibilityReason,
      exclusionReason: decision.exclusionReason,
      selectedReason: decision.selectedReason,
    });
  }

  for (const r of nasaRecords) evaluateAndPush(r, evaluateNasaJpl, 'NASA');
  for (const r of jplRecords) evaluateAndPush(r, evaluateNasaJpl, 'JPL');
  for (const r of swpcRecords) evaluateAndPush(r, evaluateSwpc, 'SWPC');

  // Sort: publishEligible first, then freshness (current > recent >
  // archive > missing), then priority high, then by publishedAtSource
  // newest. This ensures the candidate file's top entries are the
  // publishEligible-and-current stories.
  const FRESHNESS_RANK = { current: 0, recent: 1, archive: 2 };
  function freshnessRank(s) {
    if (s == null) return 3;
    return FRESHNESS_RANK[s] ?? 3;
  }
  candidates.sort((a, b) => {
    if (a.publishEligible !== b.publishEligible) return b.publishEligible ? 1 : -1;
    const fa = freshnessRank(a.freshnessStatus);
    const fb = freshnessRank(b.freshnessStatus);
    if (fa !== fb) return fa - fb;
    if (a.priority !== b.priority) return a.priority === 'high' ? -1 : 1;
    const ta = a.publishedAtSource ? new Date(a.publishedAtSource).getTime() : 0;
    const tb = b.publishedAtSource ? new Date(b.publishedAtSource).getTime() : 0;
    return tb - ta;
  });

  const output = {
    generatedAt: now.toISOString(),
    source: 'Phase 9A.2 science filter',
    inputCounts: {
      nasa: nasaRecords.length,
      jpl: jplRecords.length,
      swpc: swpcRecords.length,
    },
    sourceAvailability: {
      nasa: { sourceAvailable: nasaRes.doc.sourceAvailable ?? null, httpStatus: nasaRes.doc.httpStatus ?? null, fetchError: nasaRes.doc.fetchError ?? null },
      jpl: { sourceAvailable: jplRes.doc.sourceAvailable ?? null, httpStatus: jplRes.doc.httpStatus ?? null, fetchError: jplRes.doc.fetchError ?? null },
      swpc: { sourceAvailable: swpcRes.doc.sourceAvailable ?? null, httpStatus: swpcRes.doc.httpStatus ?? null, fetchError: swpcRes.doc.fetchError ?? null },
    },
    freshnessThresholds: {
      currentMaxDays: FRESHNESS_CURRENT_MAX_DAYS,
      recentMaxDays: FRESHNESS_RECENT_MAX_DAYS,
    },
    candidateCount: candidates.length,
    publishEligibleCount,
    highPriorityCount,
    freshnessBreakdown,
    storyTypeBreakdown,
    exclusionBreakdown,
    candidates,
  };

  await mkdir(dirname(OUTPUT_FILE), { recursive: true });
  const tmp = `${OUTPUT_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(output, null, 2) + '\n', 'utf8');
  await rename(tmp, OUTPUT_FILE);

  console.log(`\n  Total candidates:   ${candidates.length}`);
  console.log(`  publishEligible:    ${publishEligibleCount}`);
  console.log(`  high priority:      ${highPriorityCount}`);
  console.log(`  Output:             ${OUTPUT_FILE}`);

  console.log('\n  Freshness breakdown:');
  for (const [k, v] of Object.entries(freshnessBreakdown)) {
    console.log(`    ${k.padEnd(8)}  ${v}`);
  }

  console.log('\n  Story-type breakdown:');
  for (const [t, count] of Object.entries(storyTypeBreakdown).sort((a, b) => b[1] - a[1])) {
    const eligible = PUBLISH_ELIGIBLE_TYPES.has(t) ? 'eligible' : 'excluded';
    console.log(`    ${String(count).padStart(4)}  ${t.padEnd(22)} (${eligible})`);
  }

  if (Object.keys(exclusionBreakdown).length > 0) {
    console.log('\n  Exclusion breakdown (top 15):');
    for (const [reason, count] of Object.entries(exclusionBreakdown)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)) {
      console.log(`    ${String(count).padStart(4)}  ${reason}`);
    }
  }

  // Top 10 publishEligible candidates (current freshness first).
  const eligibleTop = candidates.filter((c) => c.publishEligible).slice(0, 10);
  console.log('\n  Top 10 publishEligible candidates:');
  if (eligibleTop.length === 0) {
    console.log('    (none)');
  } else {
    eligibleTop.forEach((c, i) => {
      const titlePreview = (c.title || '(no title)').slice(0, 65);
      const ageStr = c.sourceAgeDays != null ? `${c.sourceAgeDays.toFixed(1)}d` : '?';
      console.log(
        `    ${String(i + 1).padStart(2)}. [${c.priority || '-'}, ${c.storyType}, ${c.freshnessStatus || '-'} (${ageStr})] ${c.source} — ${titlePreview}`,
      );
      console.log(
        `        key=${c.scienceKey} mission=${c.mission || '-'} rights=${c.rightsStatus || '-'} credit=${c.imageCredit || '-'}`,
      );
    });
  }
  console.log('');
}

main().catch((err) => {
  console.error(`[filter-science-news] FATAL: ${err.message}`);
  process.exit(1);
});
