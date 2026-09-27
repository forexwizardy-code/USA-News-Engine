/**
 * US News Engine — NWS story lifecycle updater (Phase 5B).
 *
 * Categorizes every NWS-derived story against the published-stories registry
 * as NEW, UPDATED, UNCHANGED, EXPIRED, or CANCELLED, then prints a summary.
 *
 * Workflow:
 *   1. Runs `npm run prepare:nws` (fetch → filter → stories) — gracefully
 *      degrades to existing data files if the network call fails.
 *   2. Reads data/published-stories.json (the registry).
 *   3. Reads data/nws-story-records.json (current NWS story snapshot).
 *   4. Reads data/nws-active-alerts.json (used for cancellation detection).
 *   5. Categorizes each story.
 *   6. Prints a clear summary.
 *
 * Categorization rules:
 *
 *   NEW        — storyKey is in the current NWS feed but NOT in the registry.
 *
 *   UPDATED    — storyKey is in BOTH the registry and the current NWS feed,
 *                 AND the current NWS story has alert IDs not present in the
 *                 registry's `allAlertIds`.
 *
 *   UNCHANGED  — storyKey is in BOTH the registry and the current NWS feed,
 *                 and no new alert IDs are present.
 *                 Also: a registry-only story whose expiration has not yet
 *                 passed and has no cancellation marker — this is a
 *                 transient "missing from the latest snapshot" state we
 *                 conservatively treat as unchanged rather than inferring
 *                 cancellation.
 *
 *   EXPIRED    — registry-only story whose `lastNwsExpiresAt` / `lastNwsEndsAt`
 *                 is in the past relative to the current time. We do NOT
 *                 infer expiration from disappearance alone — the timestamp
 *                 must actually have passed.
 *
 *   CANCELLED  — registry-only story where one of its known alert IDs is
 *                 found in the NWS active-alerts snapshot with an explicit
 *                 cancellation marker in the `status` or `messageType`
 *                 field (case-insensitive contains "cancel"). We never infer
 *                 cancellation from disappearance alone.
 *
 * Mode:
 *   DRY RUN (default) — only prints the summary; no files are changed.
 *   --publish          — applies lifecycle transitions to the registry:
 *                         * EXPIRED  → lifecycleStatus="expired", breaking=false
 *                         * CANCELLED→ lifecycleStatus="cancelled", breaking=false
 *                         * UPDATED  → merge new alert IDs, set updatedAt
 *                         * UNCHANGED→ refresh lastCheckedAt
 *                         * NEW      → left for an operator to publish via
 *                                       the existing draft→article pipeline.
 *                         The 5 existing public articles are NEVER modified.
 *
 * Run manually:
 *   npm run update:nws                  (dry run)
 *   node scripts/update-nws-lifecycle.mjs --publish
 *
 * Uses only Node.js built-ins. No gray-matter, no external deps.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(__dirname, '..');
const PUBLISHED_STORIES_FILE = join(PROJECT_DIR, 'data', 'published-stories.json');
const NWS_STORIES_FILE = join(PROJECT_DIR, 'data', 'nws-story-records.json');
const NWS_CANDIDATES_FILE = join(PROJECT_DIR, 'data', 'nws-news-candidates.json');
const NWS_ACTIVE_ALERTS_FILE = join(PROJECT_DIR, 'data', 'nws-active-alerts.json');

const isPublish = process.argv.includes('--publish');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseDate(s) {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function runPrepareNws() {
  return new Promise((resolve) => {
    console.log('[update-nws-lifecycle] Running `npm run prepare:nws` (fetch → filter → stories)...');
    const child = spawn('npm', ['run', 'prepare:nws'], {
      cwd: PROJECT_DIR,
      stdio: 'inherit',
      shell: true,
    });
    child.on('error', (err) => {
      console.log(`  Warning: could not spawn npm: ${err.message}`);
      resolve(1);
    });
    child.on('close', (code) => {
      if (code !== 0) {
        console.log(
          `  Warning: prepare:nws exited with code ${code}. Will use existing data files.`,
        );
      }
      resolve(code ?? 1);
    });
  });
}

async function readJsonOrNull(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Determine if an NWS alert record carries an explicit cancellation marker.
 * NWS uses `messageType: "Cancel"` for cancellations; some feeds also set
 * `status` to a string containing "Cancel". We check both, case-insensitively.
 */
function isCancellationMarker(alert) {
  if (!alert) return false;
  const status = String(alert.status || '').toLowerCase();
  const messageType = String(alert.messageType || '').toLowerCase();
  return status.includes('cancel') || messageType === 'cancel';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('[update-nws-lifecycle] Starting NWS lifecycle update.');
  console.log(
    `  Mode: ${isPublish ? 'PUBLISH (will update registry)' : 'DRY RUN (no file changes)'}`,
  );
  console.log('');

  // --- Step 1: run prepare:nws (or fall back to existing data) ------------
  await runPrepareNws();

  // --- Step 2: read published-stories.json --------------------------------
  const publishedDoc = await readJsonOrNull(PUBLISHED_STORIES_FILE);
  if (!publishedDoc || !Array.isArray(publishedDoc.stories)) {
    console.error(
      `  FATAL: Could not read published-stories.json. Run build-published-registry.mjs first.`,
    );
    process.exit(1);
  }
  const publishedStories = publishedDoc.stories;
  console.log(`  Published stories in registry: ${publishedStories.length}`);

  // --- Step 3: read current NWS stories (nws-story-records.json) ----------
  // Falls back to nws-news-candidates.json if the dedup output is missing.
  let nwsStories = [];
  const storiesDoc = await readJsonOrNull(NWS_STORIES_FILE);
  if (storiesDoc && Array.isArray(storiesDoc.stories)) {
    nwsStories = storiesDoc.stories;
    console.log(`  Current NWS stories: ${nwsStories.length} (from nws-story-records.json)`);
  } else {
    const candDoc = await readJsonOrNull(NWS_CANDIDATES_FILE);
    if (candDoc && Array.isArray(candDoc.candidates)) {
      nwsStories = candDoc.candidates;
      console.log(
        `  Current NWS stories: ${nwsStories.length} (fallback from nws-news-candidates.json)`,
      );
    } else {
      console.log('  Warning: no NWS stories file available — every registry story will be registry-only.');
    }
  }

  // --- Step 4: read NWS active alerts (for cancellation detection) --------
  let activeAlerts = [];
  const alertsDoc = await readJsonOrNull(NWS_ACTIVE_ALERTS_FILE);
  if (alertsDoc && Array.isArray(alertsDoc.alerts)) {
    activeAlerts = alertsDoc.alerts;
  }
  const alertById = new Map();
  for (const a of activeAlerts) {
    if (a && a.id) alertById.set(a.id, a);
  }

  // --- Build lookups -------------------------------------------------------
  const nwsByStoryKey = new Map();
  for (const s of nwsStories) {
    if (s && s.storyKey) nwsByStoryKey.set(s.storyKey, s);
  }
  const publishedByStoryKey = new Map();
  for (const s of publishedStories) {
    if (s && s.storyKey) publishedByStoryKey.set(s.storyKey, s);
  }

  const now = new Date();
  console.log(`  Current time (UTC): ${now.toISOString()}`);
  console.log('');

  // --- Step 5: categorize every published story ---------------------------
  const categories = {
    NEW: [],
    UPDATED: [],
    UNCHANGED: [],
    EXPIRED: [],
    CANCELLED: [],
  };

  for (const pub of publishedStories) {
    const nwsStory = nwsByStoryKey.get(pub.storyKey);

    if (nwsStory) {
      // Story is in both the registry and the current NWS feed.
      const knownAlertIds = new Set(pub.allAlertIds || []);
      const currentAlertIds = Array.isArray(nwsStory.alertIds)
        ? nwsStory.alertIds
        : [];
      const hasNewAlerts = currentAlertIds.some((id) => !knownAlertIds.has(id));

      if (hasNewAlerts) {
        categories.UPDATED.push({
          storyKey: pub.storyKey,
          event: pub.event,
          location: pub.location,
          newAlertIds: currentAlertIds.filter((id) => !knownAlertIds.has(id)),
        });
      } else {
        categories.UNCHANGED.push({
          storyKey: pub.storyKey,
          event: pub.event,
          location: pub.location,
        });
      }
      continue;
    }

    // Story is in the registry but NOT in the current NWS feed snapshot.
    // Check cancellation first (explicit marker on a known alert id).
    let cancelled = false;
    let cancelledAlertId = null;
    for (const alertId of pub.allAlertIds || []) {
      const alert = alertById.get(alertId);
      if (alert && isCancellationMarker(alert)) {
        cancelled = true;
        cancelledAlertId = alertId;
        break;
      }
    }
    if (cancelled) {
      categories.CANCELLED.push({
        storyKey: pub.storyKey,
        event: pub.event,
        location: pub.location,
        cancelledAlertId,
      });
      continue;
    }

    // Check expiration: compare lastNwsExpiresAt/lastNwsEndsAt against now.
    const endsAt = parseDate(pub.lastNwsEndsAt);
    const expiresAt = parseDate(pub.lastNwsExpiresAt);
    const end = endsAt || expiresAt;
    if (end && end.getTime() < now.getTime()) {
      categories.EXPIRED.push({
        storyKey: pub.storyKey,
        event: pub.event,
        location: pub.location,
        endedAt: end.toISOString(),
      });
      continue;
    }

    // Registry-only, not expired, no cancellation marker — treat as
    // UNCHANGED. We do NOT infer cancellation from disappearance alone.
    categories.UNCHANGED.push({
      storyKey: pub.storyKey,
      event: pub.event,
      location: pub.location,
      note: 'not in current NWS feed but not expired and no cancellation marker',
    });
  }

  // --- Step 6: count NEW stories (in NWS feed but not in registry) --------
  for (const nwsStory of nwsStories) {
    if (!nwsStory || !nwsStory.storyKey) continue;
    if (!publishedByStoryKey.has(nwsStory.storyKey)) {
      categories.NEW.push({
        storyKey: nwsStory.storyKey,
        event: nwsStory.event,
        location: nwsStory.areaDesc ? String(nwsStory.areaDesc).split(';')[0] : '',
      });
    }
  }

  // --- Step 7: print summary ---------------------------------------------
  console.log('=== NWS Lifecycle Summary ===');
  for (const cat of ['NEW', 'UPDATED', 'UNCHANGED', 'EXPIRED', 'CANCELLED']) {
    console.log(`${cat}: ${categories[cat].length}`);
  }

  // Per-category detail
  console.log('\n--- Details ---');
  for (const cat of ['NEW', 'UPDATED', 'UNCHANGED', 'EXPIRED', 'CANCELLED']) {
    const items = categories[cat];
    if (items.length === 0) continue;
    console.log(`\n${cat} (${items.length}):`);
    for (const item of items.slice(0, 50)) {
      const parts = [`  - ${item.storyKey}`];
      if (item.event) parts.push(item.event);
      if (item.location) parts.push(item.location);
      console.log(`    ${parts.join(' — ')}`);
      if (item.newAlertIds && item.newAlertIds.length) {
        console.log(`      new alert IDs: ${item.newAlertIds.join(', ')}`);
      }
      if (item.endedAt) {
        console.log(`      ended at: ${item.endedAt}`);
      }
      if (item.cancelledAlertId) {
        console.log(`      cancelled alert: ${item.cancelledAlertId}`);
      }
      if (item.note) {
        console.log(`      note: ${item.note}`);
      }
    }
    if (items.length > 50) {
      console.log(`    ... and ${items.length - 50} more`);
    }
  }

  // --- Step 8: publish (if --publish) ------------------------------------
  if (!isPublish) {
    console.log('\n[DRY RUN] No files were modified.');
    console.log('  Pass --publish to apply lifecycle transitions to the registry.');
    return;
  }

  console.log('\n[PUBLISH MODE] Applying lifecycle transitions to the registry...');
  let registryChanged = false;
  for (const s of publishedStories) {
    const isExpired = categories.EXPIRED.some((e) => e.storyKey === s.storyKey);
    const isCancelled = categories.CANCELLED.some((c) => c.storyKey === s.storyKey);
    const isUpdated = categories.UPDATED.some((u) => u.storyKey === s.storyKey);

    if (isExpired) {
      if (s.lifecycleStatus !== 'expired' || s.breaking) {
        registryChanged = true;
      }
      s.lifecycleStatus = 'expired';
      s.breaking = false;
    } else if (isCancelled) {
      if (s.lifecycleStatus !== 'cancelled' || s.breaking) {
        registryChanged = true;
      }
      s.lifecycleStatus = 'cancelled';
      s.breaking = false;
    } else if (isUpdated) {
      const nwsStory = nwsByStoryKey.get(s.storyKey);
      if (nwsStory && Array.isArray(nwsStory.alertIds)) {
        const known = new Set(s.allAlertIds || []);
        for (const id of nwsStory.alertIds) known.add(id);
        s.allAlertIds = Array.from(known);
        s.currentAlertIds = nwsStory.alertIds;
        s.updatedAt = now.toISOString();
        s.lifecycleStatus = 'active';
        registryChanged = true;
      }
    } else {
      s.lifecycleStatus = 'active';
    }
    s.lastCheckedAt = now.toISOString();
  }

  publishedDoc.generatedAt = now.toISOString();
  await writeFile(
    PUBLISHED_STORIES_FILE,
    JSON.stringify(publishedDoc, null, 2) + '\n',
    'utf8',
  );
  console.log(`  Updated: ${PUBLISHED_STORIES_FILE}`);
  console.log(
    `  Note: NEW stories (${categories.NEW.length}) are NOT auto-published — an operator must run the draft→article pipeline.`,
  );
  console.log(`  Note: The 5 existing public article .md files were NOT modified.`);
  if (registryChanged) {
    console.log('  Registry transitions applied.');
  } else {
    console.log('  No lifecycle transitions needed (only lastCheckedAt refreshed).');
  }
}

main().catch((err) => {
  console.error(`[update-nws-lifecycle] FATAL: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
