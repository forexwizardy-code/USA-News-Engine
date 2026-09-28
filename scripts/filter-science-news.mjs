/**
 * US News Engine — Science newsworthiness filter (Phase 9A).
 *
 * Reads the three Phase 9A fetcher outputs:
 *   - data/science/nasa-news.json
 *   - data/science/jpl-news.json
 *   - data/science/swpc-events.json
 *
 * Applies a U.S.-focused newsworthiness filter with `publishEligible`
 * gating, and writes candidates to:
 *   data/science/science-news-candidates.json
 *
 * Each candidate carries the full normalized record plus:
 *   - publishEligible: boolean
 *   - priority: 'high' | 'medium'
 *   - selectedReason: short human-readable summary
 *
 * NASA / JPL filter:
 *   HIGH priority when:
 *     - Title/description contains launch, landing, splashdown, crew,
 *       astronaut, discovery, milestone, arrival, flyby, sample return,
 *       first image, results, findings
 *     - Known major mission name in title (Artemis, Webb, Perseverance,
 *       Starliner, etc.)
 *   Exclude:
 *     - APOD items (title starts with "APOD:")
 *     - Podcast / educational / administrative items (when not about a
 *       major event)
 *     - "media advisory" or "media teleconference" only (unless about a
 *       major event)
 *
 * SWPC filter:
 *   Include if: G3+ (Strong geomagnetic storm), S2+ (Solar radiation),
 *   R3+ (Radio blackout). The fetcher already pre-filters by these
 *   severities, so this filter is a safety net.
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

// --- Keyword tables --------------------------------------------------------

// High-priority NASA/JPL triggers — appear in title or description.
const HIGH_PRIORITY_KEYWORDS = [
  'launch', 'landing', 'splashdown', 'splash-down',
  'crew', 'astronaut', 'cosmonaut',
  'discover', 'discovery', 'discovered',
  'milestone', 'arrival', 'flyby', 'fly-by',
  'sample return', 'sample-return',
  'first image', 'first light', 'first observation',
  'results', 'findings', 'finding',
  'docking', 'undocking', 'spacewalk', 'eva',
  'prelaunch', 'pre-launch',
  'rolled out', 'rollout',
  'rendezvous',
];

// Known major mission names — when present in title, mark HIGH priority.
const MAJOR_MISSION_NAMES = [
  'artemis', 'starliner', 'webb', 'james webb', 'jwst',
  'perseverance', 'curiosity', 'psyche', 'europa clipper',
  'viper', 'dragonfly', 'parker solar probe', 'juno',
  'new horizons', 'voyager', 'cassini', 'lucy', 'dart',
  'insight', 'chandra', 'hubble',
  'sls', 'space launch system', 'orion',
  'iss', 'international space station',
];

// Exclude phrases (case-insensitive substring match against title).
const EXCLUDE_PHRASES_APOD = [
  /^apod[:\s]/i,
  /^astronomy\s+picture\s+of\s+the\s+day/i,
];

// "Media advisory" / "media teleconference" only — these are excluded
// unless the title ALSO contains a high-priority keyword.
const MEDIA_ROUTINE_PATTERNS = [
  /media\s+advisory/i,
  /media\s+teleconference/i,
  /media\s+call/i,
  /press\s+brief/i,
];

// Podcast / educational indicators — excluded when not about a major event.
const PODCAST_PATTERNS = [
  /podcast/i,
  /^NASA's\s+Curious\s+Universe/i,
  /episode\s+\d+/i,
  /\beducation(al)?\s+(series|episode|resource)/i,
];

// --- Helpers ---------------------------------------------------------------

function lower(s) {
  return (s == null ? '' : String(s)).toLowerCase();
}

function containsKeyword(haystack, keywords) {
  const h = lower(haystack);
  return keywords.find((k) => h.includes(lower(k)));
}

function matchesAny(haystack, regexes) {
  return regexes.find((re) => re.test(haystack || ''));
}

/**
 * Evaluate a NASA/JPL record for publishEligibility and priority.
 */
function evaluateNasaJpl(record) {
  const title = record.title || '';
  const description = record.description || '';
  const combined = `${title}\n${description}`;

  // --- EXCLUDE: APOD items ---
  if (matchesAny(title, EXCLUDE_PHRASES_APOD)) {
    return {
      include: false,
      publishEligible: false,
      priority: null,
      selectedReason: 'Excluded: APOD (Astronomy Picture of the Day) item',
    };
  }

  // --- HIGH priority when title or description contains a high-priority keyword ---
  const highKeyword = containsKeyword(combined, HIGH_PRIORITY_KEYWORDS);

  // --- HIGH priority when title contains a major mission name ---
  const majorMission = containsKeyword(title, MAJOR_MISSION_NAMES) || containsKeyword(description, MAJOR_MISSION_NAMES);

  // --- EXCLUDE: media advisory / teleconference ONLY (unless about major event) ---
  const mediaRoutine = matchesAny(title, MEDIA_ROUTINE_PATTERNS);
  if (mediaRoutine && !highKeyword && !majorMission) {
    return {
      include: false,
      publishEligible: false,
      priority: null,
      selectedReason: `Excluded: routine ${mediaRoutine} (no major-event keyword)`,
    };
  }

  // --- EXCLUDE: podcast / educational series (unless about major event) ---
  const podcastIndicator = matchesAny(title, PODCAST_PATTERNS);
  if (podcastIndicator && !highKeyword && !majorMission) {
    return {
      include: false,
      publishEligible: false,
      priority: null,
      selectedReason: `Excluded: podcast/educational series (no major-event keyword)`,
    };
  }

  // --- Decide inclusion ---
  const isHigh = !!(highKeyword || majorMission);
  if (!isHigh) {
    // Track internally but mark not publish-eligible.
    return {
      include: true,
      publishEligible: false,
      priority: 'medium',
      selectedReason: 'Tracked internally: NASA/JPL release without high-priority keyword or major mission name',
    };
  }

  // --- Build reason ---
  const reasons = [];
  if (highKeyword) reasons.push(`keyword "${highKeyword}"`);
  if (majorMission) reasons.push(`mission "${majorMission}"`);

  return {
    include: true,
    publishEligible: true,
    priority: 'high',
    selectedReason: `Selected: ${reasons.join(' + ')}`,
  };
}

/**
 * Evaluate an SWPC record. The fetcher already pre-filters to meaningful
 * severities (R3+, S2+, G3+); this is the safety net.
 */
function evaluateSwpc(record) {
  const severity = record.severity || null;
  if (!severity) {
    return {
      include: false,
      publishEligible: false,
      priority: null,
      selectedReason: 'Excluded: no severity code parsed from alert',
    };
  }

  const letter = severity.charAt(0).toUpperCase();
  const level = Number(severity.charAt(1));

  // Fetcher pre-filters to R3+, S2+, G3+. We re-validate here in case
  // the upstream filter changes.
  const passes =
    (letter === 'R' && level >= 3) ||
    (letter === 'S' && level >= 2) ||
    (letter === 'G' && level >= 3);

  if (!passes) {
    return {
      include: false,
      publishEligible: false,
      priority: null,
      selectedReason: `Excluded: severity ${severity} below publication threshold (R3+/S2+/G3+)`,
    };
  }

  // Priority — G4+, S3+, R4+ are HIGH; G3, S2, R3 are MEDIUM.
  const isHigh =
    (letter === 'G' && level >= 4) ||
    (letter === 'S' && level >= 3) ||
    (letter === 'R' && level >= 4);

  return {
    include: true,
    publishEligible: true,
    priority: isHigh ? 'high' : 'medium',
    selectedReason: `Selected: SWPC severity ${severity} ${record.watchWarningType || ''}`.trim(),
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

  console.log(`  NASA records:  ${nasaRecords.length}`);
  console.log(`  JPL records:   ${jplRecords.length}`);
  console.log(`  SWPC records:  ${swpcRecords.length}`);

  const candidates = [];
  const exclusionBreakdown = {};
  let publishEligibleCount = 0;
  let highPriorityCount = 0;

  function evaluateAndPush(record, evaluator, sourceLabel) {
    const decision = evaluator(record);
    if (!decision.include) {
      const key = decision.selectedReason.replace(/^Excluded:\s*/, '').split(/[.(]/)[0].trim();
      exclusionBreakdown[`${sourceLabel}: ${key}`] = (exclusionBreakdown[`${sourceLabel}: ${key}`] || 0) + 1;
      return;
    }
    if (decision.publishEligible) publishEligibleCount++;
    if (decision.priority === 'high') highPriorityCount++;
    candidates.push({
      ...record,
      publishEligible: decision.publishEligible,
      priority: decision.priority,
      selectedReason: decision.selectedReason,
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
    source: 'Phase 9A science filter',
    inputCounts: {
      nasa: nasaRecords.length,
      jpl: jplRecords.length,
      swpc: swpcRecords.length,
    },
    candidateCount: candidates.length,
    publishEligibleCount,
    highPriorityCount,
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
  console.log('\n  Exclusion breakdown:');
  for (const [reason, count] of Object.entries(exclusionBreakdown).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(count).padStart(4)}  ${reason}`);
  }

  // Top 10 candidates
  console.log('\n  Top 10 candidates:');
  candidates.slice(0, 10).forEach((c, i) => {
    const titlePreview = (c.title || '(no title)').slice(0, 65);
    const status = c.publishEligible ? `[${c.priority}, eligible]` : `[${c.priority}, not eligible]`;
    console.log(`    ${String(i + 1).padStart(2)}. ${status} ${c.source} — ${titlePreview}`);
    console.log(`        key=${c.scienceKey} mission=${c.mission || '-'} topic=${c.topic}`);
  });
  console.log('');
}

main().catch((err) => {
  console.error(`[filter-science-news] FATAL: ${err.message}`);
  process.exit(1);
});
