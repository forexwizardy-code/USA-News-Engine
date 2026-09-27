/**
 * US News Engine — NWS story deduplication & update tracking (Phase 3C).
 *
 * Reads the Phase 3B candidate list (data/nws-news-candidates.json) and merges
 * multiple NWS alerts that describe the SAME weather story (by storyKey) into
 * a single story record. This is the layer that lets a later phase UPDATE an
 * existing article instead of creating a duplicate one every time NWS
 * reissues or updates an alert.
 *
 * This script does NOT create article files, does NOT touch the website, and
 * does NOT use AI. It is a pure data-transformation step.
 *
 * Output: data/nws-story-records.json
 *
 * Run manually:
 *   npm run stories:nws
 *   (or) bun run stories:nws
 */

import { readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(__dirname, '..');
const INPUT_FILE = join(PROJECT_DIR, 'data', 'nws-news-candidates.json');
const OUTPUT_FILE = join(PROJECT_DIR, 'data', 'nws-story-records.json');

// ===========================================================================
// CONFIGURATION — scoring weights (internal ranking only, never public/SEO)
// ===========================================================================
const SEVERITY_SCORES = {
  Extreme: 100,
  Severe: 70,
  Moderate: 35,
  Minor: 10,
  Unknown: 0,
};

const URGENCY_SCORES = {
  Immediate: 30,
  Expected: 20,
  Future: 10,
  Past: 0,
  Unknown: 0,
};

const PRIORITY_SCORES = {
  high: 25,
  medium: 10,
};

// Named event bonuses (case-insensitive). These stack on top of the
// severity + urgency + priority base score.
const EVENT_BONUSES = {
  'Tornado Warning': 50,
  'Flash Flood Emergency': 50,
  'Hurricane Warning': 50,
  'Tsunami Warning': 50,
  'Tornado Watch': 30,
  'Hurricane Watch': 30,
  'Severe Thunderstorm Warning': 20,
  'Flash Flood Warning': 20,
  'Blizzard Warning': 20,
  'Extreme Heat Warning': 20,
};

// A story is "ending-soon" when its expiration is within this many minutes.
const ENDING_SOON_WINDOW_MIN = 60;

// ===========================================================================
// Helpers
// ===========================================================================

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function fail(message, detail) {
  console.error(`\n[build-nws-stories] ERROR: ${message}`);
  if (detail) console.error(`  Detail: ${detail}`);
  process.exit(1);
}

/**
 * Choose the newest alert in a group. Primary sort: effective (newest first).
 * Tie-break 1: onset (newest first). Tie-break 2: original input order
 * (stable, deterministic).
 *
 * Returns the array sorted newest-first so index 0 is the canonical alert and
 * the rest are preserved in deterministic order for alertIds / history.
 */
function sortByNewest(alerts) {
  return alerts
    .map((a, originalIndex) => ({
      a,
      originalIndex,
      eff: parseDate(a.effective)?.getTime() ?? 0,
      onset: parseDate(a.onset)?.getTime() ?? 0,
    }))
    .sort((x, y) => {
      if (x.eff !== y.eff) return y.eff - x.eff; // newest effective first
      if (x.onset !== y.onset) return y.onset - x.onset; // newest onset first
      return x.originalIndex - y.originalIndex; // stable input order
    })
    .map((x) => x.a);
}

/**
 * Compute the internal ranking score for a story. Deterministic; for internal
 * prioritization only — never exposed to the public site or SEO.
 */
function computeStoryScore(canonical, group) {
  let score = 0;
  score += SEVERITY_SCORES[canonical.severity] ?? 0;
  score += URGENCY_SCORES[canonical.urgency] ?? 0;
  score += PRIORITY_SCORES[canonical.priority] ?? 0;

  const bonus = EVENT_BONUSES[String(canonical.event || '').trim()];
  if (bonus) score += bonus;

  // Multiple updates: +5 per additional alert after the first, max +20.
  const additional = Math.max(0, group.length - 1);
  score += Math.min(20, additional * 5);

  return score;
}

/**
 * Determine story status from expiration.
 *   - active       = expiration is more than ENDING_SOON_WINDOW_MIN away
 *   - ending-soon  = expiration within the next ENDING_SOON_WINDOW_MIN
 *
 * If an alert has no parseable expiration we conservatively call it "active"
 * rather than silently dropping it. Truly expired alerts are excluded.
 */
function computeStoryStatus(canonical, now) {
  const exp = parseDate(canonical.ends) || parseDate(canonical.expires);
  if (!exp) return 'active';
  if (exp.getTime() <= now.getTime()) return 'expired'; // safety: drop later
  const minutesUntilExpiry = (exp.getTime() - now.getTime()) / 60_000;
  return minutesUntilExpiry <= ENDING_SOON_WINDOW_MIN ? 'ending-soon' : 'active';
}

// ===========================================================================
// Main
// ===========================================================================

async function main() {
  console.log('[build-nws-stories] Starting story deduplication.');
  console.log(`  Input:  ${INPUT_FILE}`);

  // --- Load Phase 3B candidates --------------------------------------------
  let raw;
  try {
    raw = await readFile(INPUT_FILE, 'utf8');
  } catch (err) {
    return fail('Could not read input file. Run `npm run filter:nws` first.', String(err));
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

  // --- Group by storyKey (preserve first-seen order) -----------------------
  const groupsMap = new Map(); // storyKey -> { firstIndex, alerts: [] }
  candidates.forEach((c, idx) => {
    const key = c.storyKey || `no-story-key__${idx}`;
    if (!groupsMap.has(key)) {
      groupsMap.set(key, { firstIndex: idx, alerts: [] });
    }
    groupsMap.get(key).alerts.push(c);
  });

  // --- Build one story record per group ------------------------------------
  const stories = [];
  for (const [storyKey, group] of groupsMap) {
    // Sort the group's alerts newest-first; index 0 is canonical.
    const ordered = sortByNewest(group.alerts);
    const canonical = ordered[0];

    const status = computeStoryStatus(canonical, now);
    if (status === 'expired') {
      // Phase 3B should have removed these, but exclude defensively.
      console.log(`  [skip] expired story: ${storyKey}`);
      continue;
    }

    // Collect all official NWS alert ids (preserve newest-first order).
    const alertIds = ordered
      .map((a) => a.id)
      .filter((id) => id != null);

    // Effective timestamps across the whole group for update history.
    const effs = ordered
      .map((a) => parseDate(a.effective))
      .filter((d) => d)
      .sort((a, b) => a.getTime() - b.getTime()); // oldest first
    const firstEffectiveAt = effs.length ? effs[0].toISOString() : null;
    const latestEffectiveAt = effs.length ? effs[effs.length - 1].toISOString() : null;

    const storyScore = computeStoryScore(canonical, ordered);

    stories.push({
      storyKey,
      storyStatus: status,
      storyScore,
      updateCount: ordered.length,
      alertIds,
      firstEffectiveAt,
      latestEffectiveAt,
      // Canonical alert fields (newest alert in the group)
      priority: canonical.priority ?? null,
      event: canonical.event ?? null,
      headline: canonical.headline ?? null,
      severity: canonical.severity ?? null,
      certainty: canonical.certainty ?? null,
      urgency: canonical.urgency ?? null,
      areaDesc: canonical.areaDesc ?? null,
      senderName: canonical.senderName ?? null,
      effective: canonical.effective ?? null,
      onset: canonical.onset ?? null,
      expires: canonical.expires ?? null,
      ends: canonical.ends ?? null,
      description: canonical.description ?? null,
      instruction: canonical.instruction ?? null,
      response: canonical.response ?? null,
      status: canonical.status ?? null,
      affectedZones: Array.isArray(canonical.affectedZones)
        ? canonical.affectedZones
        : [],
      sourceUrl: canonical.sourceUrl ?? null,
    });
  }

  // --- Sort: storyScore desc, then latestEffectiveAt newest first ---------
  stories.sort((a, b) => {
    if (b.storyScore !== a.storyScore) return b.storyScore - a.storyScore;
    const la = parseDate(a.latestEffectiveAt)?.getTime() ?? 0;
    const lb = parseDate(b.latestEffectiveAt)?.getTime() ?? 0;
    return lb - la;
  });

  // --- Duplicate-protection assertions -------------------------------------
  const seenStoryKeys = new Set();
  const seenAlertIds = new Set();
  for (const s of stories) {
    if (seenStoryKeys.has(s.storyKey)) {
      return fail('Duplicate storyKey detected after grouping.', s.storyKey);
    }
    seenStoryKeys.add(s.storyKey);
    for (const id of s.alertIds) {
      if (seenAlertIds.has(id)) {
        return fail('An NWS alert id appears in two different stories.', id);
      }
      seenAlertIds.add(id);
    }
  }

  // --- Output metadata -----------------------------------------------------
  const mergedUpdateCount = candidates.length - stories.length;
  const activeCount = stories.filter((s) => s.storyStatus === 'active').length;
  const endingSoonCount = stories.filter((s) => s.storyStatus === 'ending-soon').length;

  const output = {
    generatedAt: now.toISOString(),
    source: 'National Weather Service',
    inputCandidateCount: candidates.length,
    uniqueStoryCount: stories.length,
    mergedUpdateCount,
    stories,
  };

  // --- Atomic write --------------------------------------------------------
  await mkdir(dirname(OUTPUT_FILE), { recursive: true });
  const tmp = `${OUTPUT_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(output, null, 2) + '\n', 'utf8');
  await rename(tmp, OUTPUT_FILE);

  const stats = await stat(OUTPUT_FILE);
  console.log('\n[build-nws-stories] SUCCESS');
  console.log(`  Output file:          ${OUTPUT_FILE}`);
  console.log(`  File size:            ${stats.size.toLocaleString()} bytes`);
  console.log(`  Generated at (UTC):   ${output.generatedAt}`);
  console.log(`  Input candidates:     ${output.inputCandidateCount}`);
  console.log(`  Unique stories:       ${output.uniqueStoryCount}`);
  console.log(`  Merged updates:       ${output.mergedUpdateCount}`);
  console.log(`  Active stories:       ${activeCount}`);
  console.log(`  Ending-soon stories:  ${endingSoonCount}`);

  // --- Top 10 stories ------------------------------------------------------
  console.log('\n  Top 10 stories (by score, then latest effective):');
  stories.slice(0, 10).forEach((s, i) => {
    const area = String(s.areaDesc || '').split(';')[0] || '(no area)';
    console.log(
      `    ${String(i + 1).padStart(2)}. ${s.event} [${s.severity}/${s.urgency}] (${s.priority}) — ${area}`,
    );
    console.log(
      `        score=${s.storyScore} updates=${s.updateCount} status=${s.storyStatus} key=${s.storyKey}`,
    );
  });

  // --- Multi-update inspection --------------------------------------------
  const multiUpdate = stories.filter((s) => s.updateCount > 1);
  const maxUpdate = stories.reduce((m, s) => Math.max(m, s.updateCount), 0);
  console.log('\n  Update history summary:');
  console.log(`    stories with multiple updates: ${multiUpdate.length}`);
  console.log(`    maximum updateCount:           ${maxUpdate}`);
  if (multiUpdate.length) {
    console.log('    merged-story examples:');
    multiUpdate.slice(0, 8).forEach((s) => {
      const area = String(s.areaDesc || '').split(';')[0] || '(no area)';
      console.log(
        `      - ${s.event} — ${area}  (updates=${s.updateCount}, ids=${s.alertIds.length})`,
      );
      console.log(`          storyKey: ${s.storyKey}`);
      console.log(`          firstEffective: ${s.firstEffectiveAt}`);
      console.log(`          latestEffective: ${s.latestEffectiveAt}`);
    });
  }
  console.log('');
}

main().catch((err) => fail('Unexpected failure.', String(err && err.stack ? err.stack : err)));
