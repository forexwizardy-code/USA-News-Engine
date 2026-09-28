/**
 * US News Engine — Science story deduplication & scoring (Phase 9A.2 hardened).
 *
 * Reads data/science/science-news-candidates.json (produced by the
 * Phase 9A.2 filter) and groups NASA + JPL candidates that describe
 * the SAME event (same mission AND overlapping date window ±2 days)
 * into a single story record. SWPC alerts are kept separate (each
 * alert is its own story).
 *
 * Phase 9A.2 changes from Phase 9A.1:
 *   - Each story record now carries `freshnessStatus`,
 *     `sourceAgeDays`, `storyType`, `bootstrapSeen`,
 *     `eligibilityReasons` (array), and `exclusionReasons` (array)
 *     denormalized from the primary candidate / source registry.
 *   - Story re-ranking now considers freshness: sort by
 *     publishEligible first, then freshnessStatus (current > recent >
 *     archive > missing), then storyScore descending. Archive stories
 *     no longer dominate the top of the list even when their
 *     storyScore is high.
 *   - `storyStatus` gains a new value `'bootstrap'` for stories
 *     whose sources all appear in the science source registry with
 *     `bootstrapSeen=true` AND that are not in the previous snapshot.
 *     This is the bootstrap-safety mechanism: historical items are
 *     tracked but never auto-published as new.
 *   - Image auto-selection now uses the Phase 9A.2 rights vocabulary:
 *     only `verified-agency` and `mixed-agency` images may be
 *     auto-selected. `third-party`, `unclear`, and `unverified`
 *     images are NOT auto-selected (the story is still tracked but
 *     `imageUrl=null` so the future article-draft generator must
 *     fall back to a factual graphic).
 *
 * Phase 9A.1 changes retained:
 *   - Story scoring uses `storyType` as the primary signal. No
 *     points are awarded merely because "NASA" appears in the title.
 *     Major-mission bonus (+10) is gated on storyType ∈
 *     {mission-milestone, discovery, launch, landing} AND a major
 *     mission name (Artemis, Webb, Perseverance, Starliner) appearing
 *     in the title.
 *   - Space-policy / administrative / education / media-advisory /
 *     evergreen / technical-guidance / mission-preparation story
 *     types receive NO bonuses beyond the base 20. They are still
 *     tracked (so cross-snapshot change detection works) but rank at
 *     the bottom.
 *   - `storyType` is added to the story record (taken from the
 *     primary candidate's storyType, which was set by the filter).
 *   - `publishEligible` is taken from the filter (never recomputed
 *     here). When the primary candidate is publishEligible, the story
 *     is publishEligible.
 *   - Cross-snapshot tracking is preserved (storyStatus new/updated/
 *     unchanged/bootstrap, firstSeenAt, latestSeenAt, updateCount).
 *
 * Story score (0-100, internal ranking only — never public/SEO):
 *   Base: 20
 *   Launch/landing: +20
 *   Major discovery/finding: +15
 *   Crew mission event (actual, not announcement): +10
 *   Major mission name in title (Artemis, Webb, Perseverance, Starliner)
 *     — ONLY when storyType is mission-milestone/discovery/launch/landing: +10
 *   Multiple official sources (NASA+JPL): +8
 *   Recent (within 3 days): +5
 *   SWPC G4+: +20, G3: +12, S3+: +12, R3+: +8
 *   Cap at 100
 *
 * Output: data/science/science-story-records.json
 *
 * Run manually:
 *   npm run stories:science
 */

import { readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(__dirname, '..');
const INPUT_FILE = join(PROJECT_DIR, 'data', 'science', 'science-news-candidates.json');
const REGISTRY_FILE = join(PROJECT_DIR, 'data', 'science', 'science-source-registry.json');
const OUTPUT_FILE = join(PROJECT_DIR, 'data', 'science', 'science-story-records.json');

// --- Scoring weights ------------------------------------------------------
const BASE_SCORE = 20;
const BONUS_LAUNCH_LANDING = 20;
const BONUS_DISCOVERY = 15;
const BONUS_CREW = 10;
const BONUS_MAJOR_MISSION = 10;
const BONUS_MULTI_SOURCE = 8;
const BONUS_RECENT = 5;
const BONUS_SWPC_G4_PLUS = 20;
const BONUS_SWPC_G3 = 12;
const BONUS_SWPC_S3_PLUS = 12;
const BONUS_SWPC_R3_PLUS = 8;
const SCORE_CAP = 100;

// Major missions that earn the +10 bonus — but ONLY when the story's
// storyType is one of MAJOR_MISSION_ELIGIBLE_TYPES.
const MAJOR_MISSIONS = new Set(['Artemis', 'James Webb', 'Perseverance', 'Starliner']);
const MAJOR_MISSION_ELIGIBLE_TYPES = new Set([
  'mission-milestone',
  'discovery',
  'launch',
  'landing',
]);

// Story types that should NOT receive any bonus beyond the base 20.
// These are the types the filter marks as publishEligible=false for
// policy/administrative reasons; the scorer still tracks them (so
// cross-snapshot change detection works) but ranks them at the bottom.
const NO_BONUS_TYPES = new Set([
  'space-policy',
  'administrative',
  'education',
  'media-advisory',
  'evergreen',
  'technical-guidance',
  'mission-preparation',
]);

// Keywords for the launch/landing and discovery bonuses.
const LAUNCH_LANDING_KEYWORDS = [
  'launch', 'landing', 'splashdown', 'splash-down', 'lift off', 'liftoff',
  'touchdown', 'rolled out', 'countdown', 'prelaunch', 'pre-launch',
  'rendezvous', 'docking', 'undocking', 'spacewalk', 'eva',
];
const DISCOVERY_KEYWORDS = [
  'discover', 'discovery', 'discovered',
  'first image', 'first light', 'first observation', 'first measurement',
  'finding', 'findings', 'result', 'results', 'milestone',
  'detected', 'new image', 'captures', 'captured', 'reveals', 'spots',
];
const CREW_KEYWORDS = [
  'astronaut', 'cosmonaut', 'spacewalk', 'eva',
  'docking', 'undocking', 'splashdown',
];

// Cluster date window: ±2 days for matching NASA+JPL events.
const CLUSTER_DATE_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;

// Recent-window for the +5 recency bonus.
const RECENT_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

// --- Helpers --------------------------------------------------------------

function fail(message, detail) {
  console.error(`\n[build-science-stories] ERROR: ${message}`);
  if (detail) console.error(`  Detail: ${detail}`);
  process.exit(1);
}

function lower(s) {
  return (s == null ? '' : String(s)).toLowerCase();
}

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function containsKeyword(haystack, keywords) {
  const h = lower(haystack);
  return keywords.find((k) => h.includes(lower(k)));
}

/**
 * Compute the deterministic internal story score (0-100) for a cluster
 * of records. The score reflects the "weight" of the story for internal
 * ranking only — it is never used for SEO or public display.
 *
 * Phase 9A.1: scoring is gated on `storyType`. The NO_BONUS_TYPES
 * (space-policy, administrative, education, media-advisory, evergreen)
 * get the base 20 and nothing else.
 */
function computeStoryScore(records, primaryRecord, now) {
  let score = BASE_SCORE;

  const storyType = primaryRecord.storyType;

  // No-bonus types: cap at base. (We still track them so cross-snapshot
  // change detection works, but they rank at the bottom.)
  if (storyType && NO_BONUS_TYPES.has(storyType)) {
    return Math.min(SCORE_CAP, score);
  }

  const combined = records
    .map((r) => `${r.title || ''}\n${r.description || ''}`)
    .join('\n');

  // Launch/landing/splashdown
  if (containsKeyword(combined, LAUNCH_LANDING_KEYWORDS)) {
    score += BONUS_LAUNCH_LANDING;
  }

  // Major discovery / finding
  if (containsKeyword(combined, DISCOVERY_KEYWORDS)) {
    score += BONUS_DISCOVERY;
  }

  // Crew mission EVENT (not announcement). The filter already gated
  // crew-mission storyType on non-announcement items, so any
  // crew-mission record here is an actual event.
  if (storyType === 'crew-mission' || containsKeyword(combined, CREW_KEYWORDS)) {
    score += BONUS_CREW;
  }

  // Major mission name in title — gated on storyType.
  if (storyType && MAJOR_MISSION_ELIGIBLE_TYPES.has(storyType)) {
    const titleHasMajorMission = records.some((r) => {
      const t = lower(r.title || '');
      return Array.from(MAJOR_MISSIONS).some((m) => t.includes(lower(m)));
    });
    if (titleHasMajorMission) {
      score += BONUS_MAJOR_MISSION;
    }
  }

  // Multiple official sources (NASA + JPL)
  const sourceSet = new Set(records.map((r) => r.source));
  if (sourceSet.has('NASA') && sourceSet.has('JPL')) {
    score += BONUS_MULTI_SOURCE;
  }

  // Recent (within 3 days of now)
  const publishedDate = parseDate(primaryRecord.publishedAtSource);
  if (publishedDate && now.getTime() - publishedDate.getTime() <= RECENT_WINDOW_MS) {
    score += BONUS_RECENT;
  }

  // SWPC severity bonuses
  if (primaryRecord.source === 'NOAA-SWPC') {
    const sev = primaryRecord.severity || '';
    const letter = sev.charAt(0).toUpperCase();
    const level = Number(sev.charAt(1));
    if (!Number.isNaN(level)) {
      if (letter === 'G' && level >= 4) score += BONUS_SWPC_G4_PLUS;
      else if (letter === 'G' && level === 3) score += BONUS_SWPC_G3;
      else if (letter === 'S' && level >= 3) score += BONUS_SWPC_S3_PLUS;
      else if (letter === 'R' && level >= 3) score += BONUS_SWPC_R3_PLUS;
    }
  }

  return Math.min(SCORE_CAP, score);
}

/**
 * Build a deterministic scienceStoryKey for a cluster of records.
 *
 * For SWPC single-record clusters, the key is the record's own scienceKey
 * (which is already `swpc__...`). For NASA/JPL clusters, we hash the
 * sorted list of member scienceKeys so the key is stable regardless of
 * member ordering.
 */
function buildStoryKey(cluster) {
  if (cluster.length === 1) {
    // Single-record cluster — use the record's own scienceKey.
    return cluster[0].scienceKey;
  }
  const memberKeys = cluster.map((r) => r.scienceKey).sort();
  const hash = createHash('sha256').update(memberKeys.join('|'), 'utf8').digest('hex').slice(0, 16);
  // Prefix with a stable scope tag so the key namespace is clear.
  const sources = new Set(cluster.map((r) => r.source));
  const scope = sources.has('NOAA-SWPC') ? 'swpc' : 'science';
  return `${scope}__${hash}`;
}

/**
 * Pick the canonical "primary" record from a cluster.
 * Order:
 *   1. publishEligible > not-eligible
 *   2. priority 'high' > 'medium'
 *   3. NASA > JPL > NOAA-SWPC (multi-source clusters prefer NASA voice)
 *   4. newest publishedAtSource
 */
function pickPrimary(cluster) {
  const sourceRank = { NASA: 3, JPL: 2, 'NOAA-SWPC': 1 };
  return [...cluster].sort((a, b) => {
    if (a.publishEligible !== b.publishEligible) return b.publishEligible ? 1 : -1;
    if (a.priority !== b.priority) return a.priority === 'high' ? -1 : 1;
    const ra = sourceRank[a.source] || 0;
    const rb = sourceRank[b.source] || 0;
    if (rb !== ra) return rb - ra;
    const ta = a.publishedAtSource ? new Date(a.publishedAtSource).getTime() : 0;
    const tb = b.publishedAtSource ? new Date(b.publishedAtSource).getTime() : 0;
    return tb - ta;
  })[0];
}

/**
 * Pick the canonical image for the story. Returns
 * { imageUrl, imageAlt, imageCredit, imageCaption, imageSourceUrl,
 *   rightsText, rightsStatus }.
 *
 * Phase 9A.2: NEVER auto-select an image whose rightsStatus is
 * `third-party`, `unclear`, or `unverified`. Only `verified-agency`
 * and `mixed-agency` images may be auto-selected for unattended
 * publication. When the primary candidate's image is not auto-
 * selectable, scan the cluster for a member with verified-agency or
 * mixed-agency rights. If none, return imageUrl=null (the story is
 * still tracked but no image is auto-selected — the future article-
 * draft generator must fall back to a factual graphic).
 */
function pickStoryImage(cluster, primaryRecord) {
  // Phase 9A.2 vocabulary: only verified-agency and mixed-agency
  // images are auto-selectable. (Phase 9A.1 used verified-third-party
  // instead; that value is renamed to `third-party` and is no longer
  // auto-selectable per the new editorial policy.)
  const VERIFIED = new Set(['verified-agency', 'mixed-agency']);

  // 1. Try the primary record's image when it has verified rights.
  if (
    primaryRecord.imageUrl &&
    VERIFIED.has(primaryRecord.rightsStatus)
  ) {
    return {
      imageUrl: primaryRecord.imageUrl,
      imageAlt: primaryRecord.imageAlt || null,
      imageCredit: primaryRecord.imageCredit || null,
      imageCaption: primaryRecord.imageCaption || null,
      imageSourceUrl: primaryRecord.imageSourceUrl || primaryRecord.sourceUrl || null,
      rightsText: primaryRecord.rightsText || null,
      rightsStatus: primaryRecord.rightsStatus,
    };
  }

  // 2. Scan the rest of the cluster for a verified image.
  for (const r of cluster) {
    if (r === primaryRecord) continue;
    if (r.imageUrl && VERIFIED.has(r.rightsStatus)) {
      return {
        imageUrl: r.imageUrl,
        imageAlt: r.imageAlt || null,
        imageCredit: r.imageCredit || null,
        imageCaption: r.imageCaption || null,
        imageSourceUrl: r.imageSourceUrl || r.sourceUrl || null,
        rightsText: r.rightsText || null,
        rightsStatus: r.rightsStatus,
      };
    }
  }

  // 3. No verified image available — do not auto-select.
  return {
    imageUrl: null,
    imageAlt: null,
    imageCredit: null,
    imageCaption: null,
    imageSourceUrl: null,
    rightsText: null,
    rightsStatus: null,
  };
}

/**
 * Normalize a title into a "title seed" by collapsing whitespace and
 * lowercasing. This is used for change detection / deduplication, not
 * for display.
 */
function titleSeed(title) {
  return lower(title).replace(/\s+/g, ' ').trim().slice(0, 120);
}

/**
 * Compute a content signature for change detection. Excludes volatile
 * fields like fetchedAt; focuses on what would change if the story
 * meaningfully evolved.
 */
function computeSignature(cluster, primary) {
  const relevant = {
    storyKey: buildStoryKey(cluster),
    memberKeys: cluster.map((r) => r.scienceKey).sort(),
    primaryTitle: primary.title,
    primarySource: primary.source,
    severity: primary.severity || null,
    mission: primary.mission,
    storyType: primary.storyType,
    topic: primary.topic,
    priority: primary.priority,
    publishEligible: primary.publishEligible,
  };
  const json = JSON.stringify(relevant, Object.keys(relevant).sort());
  return createHash('sha256').update(json, 'utf8').digest('hex');
}

/**
 * Cluster NASA/JPL records when they share the same mission AND have
 * overlapping date windows (±2 days). SWPC records are kept as
 * single-record clusters (never merged).
 */
function clusterCandidates(candidates) {
  const nasaJpl = candidates.filter((c) => c.source === 'NASA' || c.source === 'JPL');
  const swpc = candidates.filter((c) => c.source === 'NOAA-SWPC');

  // Step 1 — SWPC: each record is its own cluster.
  const clusters = swpc.map((r) => [r]);

  // Step 2 — NASA/JPL: union-find by (mission, ±2-day overlap).
  // Two records are in the same cluster when:
  //   - both have the same non-null mission
  //   - their publishedAtSource dates are within ±2 days of each other
  // Records with null mission form singleton clusters.
  const parent = new Map();
  function find(x) {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  }
  function union(a, b) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }
  for (let i = 0; i < nasaJpl.length; i++) parent.set(i, i);

  for (let i = 0; i < nasaJpl.length; i++) {
    for (let j = i + 1; j < nasaJpl.length; j++) {
      const a = nasaJpl[i];
      const b = nasaJpl[j];
      if (!a.mission || !b.mission) continue;
      if (a.mission !== b.mission) continue;
      const ta = a.publishedAtSource ? new Date(a.publishedAtSource).getTime() : null;
      const tb = b.publishedAtSource ? new Date(b.publishedAtSource).getTime() : null;
      if (ta == null || tb == null) continue;
      if (Math.abs(ta - tb) <= CLUSTER_DATE_WINDOW_MS) {
        union(i, j);
      }
    }
  }

  // Group records by their root.
  const groups = new Map();
  for (let i = 0; i < nasaJpl.length; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(nasaJpl[i]);
  }
  for (const group of groups.values()) clusters.push(group);

  return clusters;
}

// --- Main ------------------------------------------------------------------

async function main() {
  console.log('[build-science-stories] Starting story clustering & scoring.');
  console.log(`  Input:  ${INPUT_FILE}`);
  console.log(`  Output: ${OUTPUT_FILE}`);

  let raw;
  try {
    raw = await readFile(INPUT_FILE, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return fail('Could not read input file. Run `npm run filter:science` first.', String(err));
    }
    return fail('Could not read input file.', String(err));
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    return fail('Input file is not valid JSON.', String(err));
  }
  const candidates = Array.isArray(doc.candidates) ? doc.candidates : [];
  const now = new Date();
  console.log(`  Input candidates: ${candidates.length}`);
  console.log(`  Build time (UTC): ${now.toISOString()}`);

  // --- Load previous snapshot for new/updated/unchanged tracking ---------
  let previousStories = [];
  const previousBy = new Map();
  try {
    const prevRaw = await readFile(OUTPUT_FILE, 'utf8');
    const prevDoc = JSON.parse(prevRaw);
    if (Array.isArray(prevDoc.stories)) {
      previousStories = prevDoc.stories;
      for (const s of previousStories) {
        if (s && s.scienceStoryKey) previousBy.set(s.scienceStoryKey, s);
      }
      console.log(`  Previous snapshot loaded: ${previousStories.length} stories`);
    }
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      console.log('  No previous snapshot found — all stories will be "new" or "bootstrap".');
    } else {
      console.log(`  [warn] Could not parse previous snapshot: ${String(err)}`);
    }
  }

  // --- Load the science source registry (Phase 9A.2) ---------------------
  // The registry tells us which source keys are "bootstrap" (historical
  // items the pipeline saw on its first run, NOT new items). A story
  // whose source keys are all bootstrap is given storyStatus='bootstrap'
  // instead of 'new' on first sight, so the validator's bootstrap-safety
  // check passes (a bootstrapSeen=true source may not appear as a 'new'
  // story).
  const registryBootstrapKeys = new Set();
  let registryLoaded = false;
  try {
    const regRaw = await readFile(REGISTRY_FILE, 'utf8');
    const regDoc = JSON.parse(regRaw);
    if (Array.isArray(regDoc.sources)) {
      for (const s of regDoc.sources) {
        if (s && s.bootstrapSeen === true && typeof s.scienceKey === 'string') {
          registryBootstrapKeys.add(s.scienceKey);
        }
      }
      registryLoaded = true;
      console.log(`  Registry loaded: ${regDoc.sources.length} sources (${registryBootstrapKeys.size} bootstrap)`);
    }
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      console.log('  [warn] No science-source-registry.json found. Run `npm run registry:science` first.');
      console.log('         Without the registry, bootstrap safety cannot be enforced and all');
      console.log('         new stories will be marked storyStatus="new".');
    } else {
      console.log(`  [warn] Could not parse registry: ${String(err)}`);
    }
  }

  // --- Cluster -----------------------------------------------------------
  const clusters = clusterCandidates(candidates);
  console.log(`  Clusters:         ${clusters.length}`);

  // --- Build one story record per cluster --------------------------------
  const stories = [];
  let newCount = 0;
  let updatedCount = 0;
  let unchangedCount = 0;
  let bootstrapCount = 0;
  const previousKeysStillSeen = new Set();

  for (const cluster of clusters) {
    if (cluster.length === 0) continue;
    const primary = pickPrimary(cluster);
    const storyKey = buildStoryKey(cluster);
    const sig = computeSignature(cluster, primary);
    const storyScore = computeStoryScore(cluster, primary, now);
    const image = pickStoryImage(cluster, primary);

    // Cross-snapshot tracking.
    let firstSeenAt = now.toISOString();
    let latestSeenAt = now.toISOString();
    let updateCount = 1;
    let storyStatus = 'new';
    const prev = previousBy.get(storyKey);
    if (prev) {
      previousKeysStillSeen.add(storyKey);
      firstSeenAt = prev.firstSeenAt || firstSeenAt;
      updateCount = (prev.updateCount || 0) + 1;
      if (prev.contentSignature && prev.contentSignature === sig) {
        storyStatus = 'unchanged';
        unchangedCount++;
      } else {
        storyStatus = 'updated';
        updatedCount++;
      }
    } else {
      // No previous snapshot entry — would normally be 'new'. But
      // Phase 9A.2: if ALL source keys are bootstrapSeen=true in the
      // registry, this is a historical item the pipeline is seeing
      // for the first time (because the previous story snapshot didn't
      // include it). Mark it as 'bootstrap' so the validator's
      // bootstrap-safety check passes and the future article-draft
      // generator knows NOT to auto-publish.
      const allSourceKeysList = cluster.map((r) => r.scienceKey);
      const anyNonBootstrap = allSourceKeysList.some((k) => !registryBootstrapKeys.has(k));
      if (registryLoaded && !anyNonBootstrap && allSourceKeysList.length > 0) {
        storyStatus = 'bootstrap';
        bootstrapCount++;
      } else {
        storyStatus = 'new';
        newCount++;
      }
    }

    const allSourceKeys = cluster.map((r) => r.scienceKey);
    const sourceUrls = Array.from(new Set(cluster.map((r) => r.sourceUrl).filter(Boolean)));
    const publishedDates = cluster
      .map((r) => parseDate(r.publishedAtSource))
      .filter(Boolean)
      .sort((a, b) => a.getTime() - b.getTime());
    const earliestPublishedAtSource = publishedDates.length ? publishedDates[0].toISOString() : primary.publishedAtSource || null;

    // Phase 9A.2: bootstrapSeen flag (true when ALL source keys are
    // bootstrap in the registry). Used by the validator to enforce
    // the bootstrap-safety check.
    const bootstrapSeen =
      registryLoaded &&
      allSourceKeys.length > 0 &&
      allSourceKeys.every((k) => registryBootstrapKeys.has(k));

    stories.push({
      scienceStoryKey: storyKey,
      primarySource: primary.source,
      allSourceKeys,
      sourceUrls,
      titleSeed: titleSeed(primary.title),
      title: primary.title,
      storyType: primary.storyType || null,
      topic: primary.topic,
      mission: primary.mission,
      publishedAtSource: earliestPublishedAtSource,
      // Phase 9A.2: freshness fields denormalized from the primary
      // candidate. These come straight from the filter (which
      // computed them from publishedAtSource).
      freshnessStatus: primary.freshnessStatus || null,
      sourceAgeDays: primary.sourceAgeDays != null ? primary.sourceAgeDays : null,
      // Phase 9A.2: bootstrap flag from the registry.
      bootstrapSeen,
      storyScore,
      publishEligible: primary.publishEligible === true,
      priority: primary.priority,
      recordCount: cluster.length,
      storyStatus,
      updateCount,
      firstSeenAt,
      latestSeenAt,
      contentSignature: sig,
      // Denormalized primary-record fields for downstream consumption.
      severity: primary.severity || null,
      sourceUrl: primary.sourceUrl,
      imageUrl: image.imageUrl,
      imageAlt: image.imageAlt,
      imageCredit: image.imageCredit,
      imageCaption: image.imageCaption,
      imageSourceUrl: image.imageSourceUrl,
      rightsText: image.rightsText,
      rightsStatus: image.rightsStatus,
      description: primary.description || null,
      // Phase 9A.2: plural eligibility/exclusion reason arrays (and
      // the legacy singular fields for backward compatibility).
      eligibilityReasons: Array.isArray(primary.eligibilityReasons)
        ? primary.eligibilityReasons
        : primary.eligibilityReason
          ? [primary.eligibilityReason]
          : [],
      exclusionReasons: Array.isArray(primary.exclusionReasons)
        ? primary.exclusionReasons
        : primary.exclusionReason
          ? [primary.exclusionReason]
          : [],
      selectedReason: primary.selectedReason || null,
      eligibilityReason: primary.eligibilityReason || null,
      exclusionReason: primary.exclusionReason || null,
    });
  }

  // --- Sort: publishEligible first, then freshness (current > recent >
  //    archive > missing), then storyScore desc, then latestSeenAt newest.
  //    Phase 9A.2: archive stories no longer dominate the top of the
  //    list even when their storyScore is high.
  const FRESHNESS_RANK = { current: 0, recent: 1, archive: 2 };
  function freshnessRank(s) {
    if (s == null) return 3;
    return FRESHNESS_RANK[s] ?? 3;
  }
  stories.sort((a, b) => {
    if (a.publishEligible !== b.publishEligible) return b.publishEligible ? 1 : -1;
    const fa = freshnessRank(a.freshnessStatus);
    const fb = freshnessRank(b.freshnessStatus);
    if (fa !== fb) return fa - fb;
    if (b.storyScore !== a.storyScore) return b.storyScore - a.storyScore;
    const la = parseDate(a.latestSeenAt)?.getTime() ?? 0;
    const lb = parseDate(b.latestSeenAt)?.getTime() ?? 0;
    return lb - la;
  });

  // --- Duplicate-protection assertion ------------------------------------
  const seenKeys = new Set();
  for (const s of stories) {
    if (seenKeys.has(s.scienceStoryKey)) {
      return fail('Duplicate scienceStoryKey detected after clustering.', s.scienceStoryKey);
    }
    seenKeys.add(s.scienceStoryKey);
  }

  // --- Output ------------------------------------------------------------
  const previousMissingCount = previousStories.length - previousKeysStillSeen.size;

  const output = {
    generatedAt: now.toISOString(),
    source: 'Phase 9A.2 science stories',
    inputCandidateCount: candidates.length,
    uniqueStoryCount: stories.length,
    publishEligibleCount: stories.filter((s) => s.publishEligible).length,
    highPriorityCount: stories.filter((s) => s.priority === 'high').length,
    freshnessBreakdown: stories.reduce((acc, s) => {
      const k = s.freshnessStatus || 'missing';
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {}),
    storyTypeBreakdown: stories.reduce((acc, s) => {
      const t = s.storyType || 'unknown';
      acc[t] = (acc[t] || 0) + 1;
      return acc;
    }, {}),
    storyStatusBreakdown: stories.reduce((acc, s) => {
      const k = s.storyStatus || 'unknown';
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {}),
    newCount,
    updatedCount,
    unchangedCount,
    bootstrapCount,
    previousSnapshotCount: previousStories.length,
    previousMissingCount,
    stories,
  };

  // --- Atomic write ------------------------------------------------------
  await mkdir(dirname(OUTPUT_FILE), { recursive: true });
  const tmp = `${OUTPUT_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(output, null, 2) + '\n', 'utf8');
  await rename(tmp, OUTPUT_FILE);

  const stats = await stat(OUTPUT_FILE);
  console.log('\n[build-science-stories] SUCCESS');
  console.log(`  Output file:          ${OUTPUT_FILE}`);
  console.log(`  File size:            ${stats.size.toLocaleString()} bytes`);
  console.log(`  Generated at (UTC):   ${output.generatedAt}`);
  console.log(`  Input candidates:     ${output.inputCandidateCount}`);
  console.log(`  Unique stories:       ${output.uniqueStoryCount}`);
  console.log(`  New:                  ${newCount}`);
  console.log(`  Updated:              ${updatedCount}`);
  console.log(`  Unchanged:            ${unchangedCount}`);
  console.log(`  Bootstrap:            ${bootstrapCount}`);
  console.log(`  publishEligible:      ${output.publishEligibleCount}`);
  console.log(`  high priority:        ${output.highPriorityCount}`);
  if (previousStories.length > 0) {
    console.log(`  Previously seen, missing this run: ${previousMissingCount}`);
  }

  // --- Freshness breakdown -----------------------------------------------
  console.log('\n  Freshness breakdown:');
  for (const [k, v] of Object.entries(output.freshnessBreakdown)) {
    console.log(`    ${k.padEnd(8)}  ${v}`);
  }

  // --- Score distribution ------------------------------------------------
  const scoreBuckets = { '90-100': 0, '70-89': 0, '50-69': 0, '30-49': 0, '0-29': 0 };
  for (const s of stories) {
    if (s.storyScore >= 90) scoreBuckets['90-100']++;
    else if (s.storyScore >= 70) scoreBuckets['70-89']++;
    else if (s.storyScore >= 50) scoreBuckets['50-69']++;
    else if (s.storyScore >= 30) scoreBuckets['30-49']++;
    else scoreBuckets['0-29']++;
  }
  console.log('\n  Story score distribution:');
  for (const [bucket, count] of Object.entries(scoreBuckets)) {
    console.log(`    ${bucket.padStart(6)}  ${count}`);
  }

  // --- Top 10 stories ----------------------------------------------------
  console.log('\n  Top 10 stories (by publishEligible, freshness, score):');
  if (stories.length === 0) {
    console.log('    (no stories)');
  } else {
    stories.slice(0, 10).forEach((s, i) => {
      const titlePreview = (s.title || '(no title)').slice(0, 60);
      const eligible = s.publishEligible ? 'eligible' : 'not-eligible';
      const ageStr = s.sourceAgeDays != null ? `${s.sourceAgeDays.toFixed(1)}d` : '?';
      console.log(
        `    ${String(i + 1).padStart(2)}. [score=${s.storyScore}, ${s.storyType || '?'}, ${s.freshnessStatus || '-'} (${ageStr}), ${eligible}] ${s.primarySource} — ${titlePreview}`,
      );
      console.log(
        `        key=${s.scienceStoryKey} mission=${s.mission || '-'} image=${s.imageUrl ? 'yes' : 'no'} rights=${s.rightsStatus || '-'} status=${s.storyStatus}${s.bootstrapSeen ? ' [BOOTSTRAP]' : ''}`,
      );
    });
  }
  console.log('');
}

main().catch((err) => fail('Unexpected failure.', String(err && err.stack ? err.stack : err)));
