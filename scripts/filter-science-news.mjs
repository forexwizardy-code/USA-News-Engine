/**
 * US News Engine — Science newsworthiness filter (Phase 9A.1 hardened).
 *
 * Reads the three Phase 9A fetcher outputs:
 *   - data/science/nasa-news.json
 *   - data/science/jpl-news.json
 *   - data/science/swpc-events.json
 *
 * Applies STRICT `publishEligible` gating based on `storyType` and
 * writes candidates to:
 *   data/science/science-news-candidates.json
 *
 * Phase 9A.1 changes from Phase 9A:
 *   - publishEligible is now driven by `storyType` (set by the
 *     fetcher's classifier or re-derived here). The previous
 *     keyword-only HIGH-priority logic is gone — `storyType` is the
 *     canonical signal.
 *   - Hard exclusions based on title patterns (APOD:, media advisory,
 *     Artemis Accords/signing/agreement, education/challenge/contest)
 *     now OVERRIDE the fetcher's storyType so a misclassified item is
 *     still gated correctly.
 *   - astronomy / technology / crew-mission have additional
 *     "significance" gates so routine observations, minor tech demos,
 *     and crew announcements don't earn publication.
 *   - Each candidate carries `storyType`, `publishEligible`, and either
 *     `eligibilityReason` (when eligible) or `exclusionReason` (when
 *     not).
 *
 * publishEligible = true ONLY when storyType is one of:
 *   mission-milestone, launch, landing, discovery, astronomy (major
 *   findings only), earth-science, technology (significant demos only),
 *   crew-mission (actual events, not announcements), space-weather
 *   (SWPC R3+/S2+/G3+ only).
 *
 * publishEligible = false for:
 *   space-policy, administrative, education, media-advisory, evergreen,
 *   and any record that fails the additional significance gates above.
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
};

// Story types whose members are eligible for publication (subject to
// the additional significance gates below).
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

// --- Title-pattern overrides ----------------------------------------------
// These patterns OVERRIDE the fetcher's storyType classification when
// they appear in the title. They implement the Phase 9A.1 hard
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
  // Media advisory / press briefing — force storyType = media-advisory.
  {
    name: 'media-advisory',
    storyType: STORY_TYPES.MEDIA_ADVISORY,
    test: (t) =>
      /\bmedia\s+advisory\b/i.test(t) ||
      /\bmedia\s+teleconference\b/i.test(t) ||
      /\bmedia\s+call\b/i.test(t) ||
      /\bto\s+provide\s+update\b/i.test(t) ||
      /\bwill\s+provide\s+update\b/i.test(t) ||
      /\bpress\s+brief(?:ing)?\b/i.test(t) ||
      /\bpreviews?\b/i.test(t) ||
      /\bbriefing\b/i.test(t),
    reason: 'Excluded: media advisory / press briefing announcement',
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
// Even when the storyType is in PUBLISH_ELIGIBLE_TYPES, an additional
// significance check must pass for these types. The check looks for
// indicators in the title + description that the item is a major
// finding / significant demo / actual crew event (vs. a routine
// observation / minor demo / crew announcement).

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
];

// --- Helpers ---------------------------------------------------------------

function lower(s) {
  return (s == null ? '' : String(s)).toLowerCase();
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
 * Evaluate a NASA/JPL record for publishEligibility. Always returns
 * a candidate object — the filter no longer drops records based on
 * storyType. Every record is included as a candidate, with
 * publishEligible true or false.
 */
function evaluateNasaJpl(record) {
  const title = record.title || '';
  const description = record.description || '';

  // 1. Title-pattern overrides take precedence over the fetcher's
  //    storyType classification.
  const override = applyTitleOverrides(title);
  let storyType = override.storyType || record.storyType || STORY_TYPES.MISSION_MILESTONE;
  let storyTypeSource = override.storyType ? 'title-override' : 'fetcher';

  // 2. publishEligible based on storyType.
  if (!PUBLISH_ELIGIBLE_TYPES.has(storyType)) {
    return {
      storyType,
      storyTypeSource,
      publishEligible: false,
      priority: null,
      eligibilityReason: null,
      exclusionReason:
        override.overrideReason ||
        `Excluded: storyType "${storyType}" is not publish-eligible`,
    };
  }

  // 3. Significance gates for astronomy / technology / crew-mission.
  const gate = applySignificanceGate(storyType, title, description);
  if (!gate.passes) {
    return {
      storyType,
      storyTypeSource,
      publishEligible: false,
      priority: null,
      eligibilityReason: null,
      exclusionReason: gate.reason,
    };
  }

  // 4. Eligible — assign priority.
  const highPriorityTypes = new Set([
    STORY_TYPES.LAUNCH,
    STORY_TYPES.LANDING,
    STORY_TYPES.DISCOVERY,
    STORY_TYPES.MISSION_MILESTONE,
    STORY_TYPES.CREW_MISSION,
  ]);
  const priority = highPriorityTypes.has(storyType) ? 'high' : 'medium';

  return {
    storyType,
    storyTypeSource,
    publishEligible: true,
    priority,
    eligibilityReason: `Eligible: storyType "${storyType}" is publish-eligible (${storyTypeSource})`,
    exclusionReason: null,
  };
}

/**
 * Evaluate an SWPC record. The fetcher already pre-filters to
 * meaningful severities (R3+, S2+, G3+); this is the safety net.
 * SWPC records are always storyType = 'space-weather'.
 */
function evaluateSwpc(record) {
  const storyType = STORY_TYPES.SPACE_WEATHER;
  const severity = record.severity || null;

  if (!severity) {
    return {
      storyType,
      storyTypeSource: 'fetcher',
      publishEligible: false,
      priority: null,
      eligibilityReason: null,
      exclusionReason: 'Excluded: SWPC alert has no severity code parsed',
    };
  }

  if (!SWPC_MEANINGFUL_SEVERITY.has(severity)) {
    return {
      storyType,
      storyTypeSource: 'fetcher',
      publishEligible: false,
      priority: null,
      eligibilityReason: null,
      exclusionReason: `Excluded: SWPC severity ${severity} below publication threshold (R3+/S2+/G3+)`,
    };
  }

  const priority = SWPC_HIGH_PRIORITY_SEVERITY.has(severity) ? 'high' : 'medium';

  return {
    storyType,
    storyTypeSource: 'fetcher',
    publishEligible: true,
    priority,
    eligibilityReason: `Eligible: SWPC severity ${severity} ${record.watchWarningType || ''}`.trim(),
    exclusionReason: null,
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
  console.log('[filter-science-news] Starting newsworthiness filter.');
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

  // Surface source-availability provenance in the filter log so a
  // reviewer can tell whether an empty source file is "feed blocked"
  // vs. "feed returned zero items".
  console.log(
    `  NASA: ${nasaRecords.length} records (sourceAvailable=${nasaRes.doc.sourceAvailable ?? 'n/a'}, httpStatus=${nasaRes.doc.httpStatus ?? 'n/a'})`,
  );
  console.log(
    `  JPL:  ${jplRecords.length} records (sourceAvailable=${jplRes.doc.sourceAvailable ?? 'n/a'}, httpStatus=${jplRes.doc.httpStatus ?? 'n/a'})`,
  );
  console.log(
    `  SWPC: ${swpcRecords.length} records (sourceAvailable=${swpcRes.doc.sourceAvailable ?? 'n/a'}, httpStatus=${swpcRes.doc.httpStatus ?? 'n/a'})`,
  );

  const candidates = [];
  const exclusionBreakdown = {};
  const storyTypeBreakdown = {};
  let publishEligibleCount = 0;
  let highPriorityCount = 0;

  function evaluateAndPush(record, evaluator, sourceLabel) {
    const decision = evaluator(record);
    storyTypeBreakdown[decision.storyType] = (storyTypeBreakdown[decision.storyType] || 0) + 1;
    if (decision.publishEligible) {
      publishEligibleCount++;
      if (decision.priority === 'high') highPriorityCount++;
    } else {
      const key = `${sourceLabel}: ${decision.exclusionReason || 'unknown'}`;
      exclusionBreakdown[key] = (exclusionBreakdown[key] || 0) + 1;
    }
    candidates.push({
      ...record,
      storyType: decision.storyType,
      storyTypeSource: decision.storyTypeSource,
      publishEligible: decision.publishEligible,
      priority: decision.priority,
      eligibilityReason: decision.eligibilityReason,
      exclusionReason: decision.exclusionReason,
      // Retain the legacy `selectedReason` field for backwards
      // compatibility with the existing validator/scorer.
      selectedReason: decision.publishEligible
        ? decision.eligibilityReason
        : decision.exclusionReason,
    });
  }

  for (const r of nasaRecords) evaluateAndPush(r, evaluateNasaJpl, 'NASA');
  for (const r of jplRecords) evaluateAndPush(r, evaluateNasaJpl, 'JPL');
  for (const r of swpcRecords) evaluateAndPush(r, evaluateSwpc, 'SWPC');

  // Sort: publishEligible first, then priority high, then by publishedAtSource newest.
  candidates.sort((a, b) => {
    if (a.publishEligible !== b.publishEligible) return b.publishEligible ? 1 : -1;
    if (a.priority !== b.priority) return a.priority === 'high' ? -1 : 1;
    const ta = a.publishedAtSource ? new Date(a.publishedAtSource).getTime() : 0;
    const tb = b.publishedAtSource ? new Date(b.publishedAtSource).getTime() : 0;
    return tb - ta;
  });

  const output = {
    generatedAt: new Date().toISOString(),
    source: 'Phase 9A.1 science filter',
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
    candidateCount: candidates.length,
    publishEligibleCount,
    highPriorityCount,
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

  console.log('\n  Story-type breakdown:');
  for (const [t, count] of Object.entries(storyTypeBreakdown).sort((a, b) => b[1] - a[1])) {
    const eligible = PUBLISH_ELIGIBLE_TYPES.has(t) ? 'eligible' : 'excluded';
    console.log(`    ${String(count).padStart(4)}  ${t.padEnd(20)} (${eligible})`);
  }

  if (Object.keys(exclusionBreakdown).length > 0) {
    console.log('\n  Exclusion breakdown (top 15):');
    for (const [reason, count] of Object.entries(exclusionBreakdown)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)) {
      console.log(`    ${String(count).padStart(4)}  ${reason}`);
    }
  }

  // Top 10 publishEligible candidates.
  const eligibleTop = candidates.filter((c) => c.publishEligible).slice(0, 10);
  console.log('\n  Top 10 publishEligible candidates:');
  if (eligibleTop.length === 0) {
    console.log('    (none)');
  } else {
    eligibleTop.forEach((c, i) => {
      const titlePreview = (c.title || '(no title)').slice(0, 65);
      console.log(`    ${String(i + 1).padStart(2)}. [${c.priority}, ${c.storyType}] ${c.source} — ${titlePreview}`);
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
