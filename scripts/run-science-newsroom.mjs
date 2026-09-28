/**
 * US News Engine — master Science newsroom automation script (Phase 9D).
 *
 * Orchestrates the full Science pipeline:
 *   fetch (NASA + JPL + SWPC) → registry update → filter → stories →
 *   validate →
 *   reconcile against published-science.json →
 *   check existing published stories for meaningful source-content changes →
 *   publish NEW post-bootstrap articles (draft + image + article file) →
 *   update registry → validate → build.
 *
 * Reads config/automation.json for the kill switch and publishing caps:
 *   - sciencePublishingEnabled (master kill switch — Phase 9D default: false)
 *   - maxScienceNewPerRun  (per-run cap on new publications)
 *   - maxScienceNewPerDay  (daily UTC cap on new publications)
 *
 * BOOTSTRAP SAFETY (the critical Phase 9A.2 invariant):
 *   Items with `bootstrapSeen: true` in the source registry are
 *   "historical" — they existed before the registry was created. The
 *   newsroom MUST NEVER auto-publish them as NEW. Only items with
 *   `bootstrapSeen: false` (first seen AFTER automation activation)
 *   can be NEW candidates. This prevents mass backfill of NASA/JPL
 *   archive content the first time the newsroom runs after activation.
 *
 * SOURCE FAILURE SAFETY:
 *   If JPL (or NASA/SWPC) returns 403 / 5xx / empty body / WAF challenge
 *   and the fetcher marks `sourceAvailable=false`, the newsroom treats it
 *   as a SOURCE FAILURE (not 0 stories). It preserves the previous
 *   registry state and exits without publishing — we never publish based
 *   on incomplete source state.
 *
 * SOURCE CONTENT HASH (meaningful-update detection):
 *   For each published Science story, the newsroom fetches the live
 *   source page, computes a SHA-256 hash of the title + article body
 *   text, and compares it to the stored `sourceContentHash`. Only when
 *   the hash changes does the story get marked UPDATED (updatedAt
 *   bumped). `lastSourceCheckedAt` is bumped on every check;
 *   `lastSourceChangedAt` only when the hash actually changes.
 *
 * Test mode (identical to recall/earthquake):
 *   --test-date=YYYY-MM-DD  Use a fake "today" for daily-cap calculations.
 *   --ignore-daily-cap      Bypass the daily cap (for test runs).
 *   --fixture               Use the test fixture as the only NEW candidate.
 *   --allow-test-publish    Override dry-run mode (test publishing enabled).
 *
 *   When ANY test flag is present WITHOUT --allow-test-publish, the
 *   script enters DRY RUN mode — NO production files (registry, article
 *   markdowns, public images) are modified. The scheduled GitHub
 *   workflow MUST NEVER use --allow-test-publish.
 *
 * No-change behavior:
 *   If 0 new + 0 updated, exits before build/deploy (no content changes).
 *
 * Run:
 *   npm run newsroom:science
 *   (or) node scripts/run-science-newsroom.mjs
 */

import { readFile, writeFile, mkdir, copyFile, access, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import {
  computeSourceHealth,
  evaluateSourceDependency,
  buildPreservedJplSources,
  allSourcesDegraded,
  canonicalSourceLabel,
  SOURCE_KEYS,
} from './science-source-resilience-rules.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(__dirname, '..');
const CONFIG_FILE = join(PROJECT_DIR, 'config', 'automation.json');
const REGISTRY_FILE = join(PROJECT_DIR, 'data', 'published-science.json');
const STORIES_FILE = join(
  PROJECT_DIR,
  'data',
  'science',
  'science-story-records.json',
);
const SOURCE_REGISTRY_FILE = join(
  PROJECT_DIR,
  'data',
  'science',
  'science-source-registry.json',
);
const TEST_FIXTURE_FILE = join(
  PROJECT_DIR,
  'data',
  'science',
  'test-fixture.json',
);
const JPL_FILE = join(PROJECT_DIR, 'data', 'science', 'jpl-news.json');
const NASA_FILE = join(PROJECT_DIR, 'data', 'science', 'nasa-news.json');
const SWPC_FILE = join(PROJECT_DIR, 'data', 'science', 'swpc-events.json');
const CACHE_DIR = join(PROJECT_DIR, 'data', 'science', 'cache');

// Phase 9D.1/9D.2 — source-resilience files.
//
// CANONICAL persistent fallback (tracked, committed by the workflow):
//   data/science/science-source-registry.json
//     The source registry carries every source identity ever seen
//     (scienceKey, sourceUrl, title, mission, topic, storyType,
//     bootstrapSeen, firstSeenAt, lastSeenAt). It survives fresh
//     GitHub Actions checkouts and is the CANONICAL source of truth
//     for cross-source duplicate protection and source-dependency
//     decisions. Correctness MUST NOT depend on any untracked file.
//
// NON-CANONICAL CACHE (gitignored, local runtime optimization ONLY):
//   data/science/last-known-good/{nasa,jpl,swpc}-news.json
//     A copy of each fetcher output saved ONLY on a successful fetch.
//     Never overwritten by a failed fetch. Deleting these files MUST
//     NOT change the editorial / dependency outcome — the registry is
//     sufficient. Kept as a local optimization to avoid re-parsing the
//     registry for the full fetcher output; never required for correctness.
//
// Internal diagnostics (gitignored, never committed):
//   source-health: the per-source health model (NASA/JPL/SWPC).
//   deferred-candidates: NEW candidates deferred this run because of a
//   degraded source dependency. Internal diagnostic only.
const LAST_KNOWN_GOOD_DIR = join(PROJECT_DIR, 'data', 'science', 'last-known-good');
const LAST_KNOWN_GOOD = {
  NASA: join(LAST_KNOWN_GOOD_DIR, 'nasa-news.json'),
  JPL: join(LAST_KNOWN_GOOD_DIR, 'jpl-news.json'),
  SWPC: join(LAST_KNOWN_GOOD_DIR, 'swpc-events.json'),
};
const SOURCE_HEALTH_FILE = join(PROJECT_DIR, 'data', 'science', 'source-health.json');
const DEFERRED_CANDIDATES_FILE = join(
  PROJECT_DIR,
  'data',
  'science',
  'deferred-candidates.json',
);

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ===========================================================================
// Helpers
// ===========================================================================

/** Run an npm script under PROJECT_DIR; throw with stderr on failure. */
function runNpm(script, label) {
  console.log(`  $ npm run ${script}`);
  try {
    execSync(`npm run ${script}`, { cwd: PROJECT_DIR, stdio: 'pipe' });
  } catch (err) {
    const stderr = err.stderr?.toString?.() || '';
    const stdout = err.stdout?.toString?.() || '';
    throw new Error(
      `${label} failed.\n-- stderr --\n${stderr.slice(0, 800)}\n-- stdout --\n${stdout.slice(0, 400)}`,
    );
  }
}

/** Run a node script under PROJECT_DIR; throw with stderr on failure. */
function runNode(scriptWithArgs, label) {
  console.log(`  $ node ${scriptWithArgs}`);
  try {
    execSync(`node ${scriptWithArgs}`, { cwd: PROJECT_DIR, stdio: 'pipe' });
  } catch (err) {
    const stderr = err.stderr?.toString?.() || '';
    const stdout = err.stdout?.toString?.() || '';
    throw new Error(
      `${label} failed.\n-- stderr --\n${stderr.slice(0, 800)}\n-- stdout --\n${stdout.slice(0, 400)}`,
    );
  }
}

async function fileExists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function loadJsonOptional(path) {
  try {
    const raw = await readFile(path, 'utf8');
    return { ok: true, doc: JSON.parse(raw) };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: false, reason: 'missing' };
    return { ok: false, reason: String(err) };
  }
}

/** Escape a string for inclusion inside a YAML double-quoted value. */
function yamlEscape(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Decode common HTML entities into plain text (mirrors the helper in
 * generate-science-draft.mjs).
 */
function decodeEntities(text) {
  return String(text || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#8217;|&rsquo;/g, '\u2019')
    .replace(/&#8216;|&lsquo;/g, '\u2018')
    .replace(/&#8220;|&ldquo;/g, '\u201C')
    .replace(/&#8221;|&rdquo;/g, '\u201D')
    .replace(/&#8211;|&ndash;/g, '\u2013')
    .replace(/&#8212;|&mdash;/g, '\u2014')
    .replace(/&#8230;|&hellip;/g, '\u2026')
    .replace(/&#160;/g, ' ')
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));
}

/** Strip HTML tags from a fragment, preserving paragraph boundaries. */
function stripHtml(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .split('\n')
    .map((line) => decodeEntities(line).replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Extract the main article body HTML from a JPL or NASA source page.
 * Mirrors generate-science-draft.mjs so the hash is consistent with
 * what a draft generator would see.
 */
function extractArticleHtml(html, url) {
  const isJpl = /jpl\.nasa\.gov/.test(url);
  if (isJpl) {
    const startMarker = 'itemprop="articleBody"';
    const startIdx = html.indexOf(startMarker);
    if (startIdx === -1) return '';
    const tagClose = html.indexOf('>', startIdx);
    const sliceStart = tagClose === -1 ? startIdx : tagClose + 1;
    const endIdx = html.indexOf('</main>', sliceStart);
    return html.slice(
      sliceStart,
      endIdx > sliceStart ? endIdx : sliceStart + 60000,
    );
  }
  // NASA image-article page.
  const aStart = html.indexOf('<article');
  if (aStart === -1) return '';
  const aEnd = html.indexOf('</article>', aStart);
  return html.slice(aStart, aEnd > aStart ? aEnd + 10 : aStart + 60000);
}

/**
 * Pull the <title>...</title> from a source page (best-effort). Used as
 * part of the source-content hash so a headline correction at the
 * source will trigger an update.
 */
function extractTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return '';
  return decodeEntities(m[1]).replace(/\s+/g, ' ').trim();
}

/**
 * Build a stable cache filename for a source URL (mirrors
 * generate-science-draft.mjs so we share the same cache).
 */
function cacheFileForUrl(url) {
  const u = new URL(url);
  const host = u.hostname.replace(/^www\./, '').replace(/\./g, '-');
  const path = u.pathname
    .replace(/^\//, '')
    .replace(/\/$/, '')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'index';
  return join(CACHE_DIR, `${host}-${path}.html`);
}

/**
 * Fetch the source page with browser-like headers for JPL, following
 * redirects. Falls back to the cache when the live fetch fails. Returns
 * { html, finalUrl, source } or null when no usable copy is available.
 *
 * This mirrors generate-science-draft.mjs's fetchSourcePage but is
 * non-fatal: a null return lets the caller skip the update check for
 * this story instead of aborting the whole run.
 */
async function fetchSourcePageSafe(url, { forUpdateCheck = false } = {}) {
  const isJpl = /jpl\.nasa\.gov/.test(url);
  const headers = isJpl
    ? {
        'User-Agent': BROWSER_UA,
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
      }
    : {
        'User-Agent': 'USNewsEngine/1.0 (https://usa-news-engine.forexwizardy.workers.dev)',
        Accept: 'text/html,application/xhtml+xml',
      };

  let lastText = null;
  let lastStatus = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers,
        redirect: 'follow',
        signal: AbortSignal.timeout(30000),
      });
      const text = await res.text();
      lastText = text;
      lastStatus = res.status;
      const looksLikeWafChallenge =
        res.status === 202 ||
        text.length === 0 ||
        (isJpl &&
          text.length < 5000 &&
          /id="challenge-container"/i.test(text)) ||
        (text.length < 5000 && /awswaf|challenge-container/i.test(text));
      if (looksLikeWafChallenge) {
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
          continue;
        }
        break; // fall through to cache
      }
      if (!res.ok) {
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
          continue;
        }
        break; // fall through to cache
      }
      // Save the successful response to cache (best-effort).
      try {
        await mkdir(CACHE_DIR, { recursive: true });
        await writeFile(cacheFileForUrl(url), text, 'utf8');
      } catch {
        // Cache write failure is non-fatal.
      }
      return { html: text, finalUrl: res.url || url, source: 'live' };
    } catch {
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        continue;
      }
      break;
    }
  }

  // Fall back to cache.
  const cachePath = cacheFileForUrl(url);
  try {
    const cached = await readFile(cachePath, 'utf8');
    const looksLikeRealArticle =
      cached.length > 20000 &&
      !/id="challenge-container"/i.test(cached) &&
      (/itemprop="articleBody"/i.test(cached) ||
        /<article/i.test(cached) ||
        /<main/i.test(cached));
    if (looksLikeRealArticle) {
      return { html: cached, finalUrl: url, source: 'cache' };
    }
  } catch {
    // No cache available.
  }
  if (forUpdateCheck) {
    console.warn(
      `    [update-check] Could not fetch source page (${url}); lastStatus=${lastStatus}, lastBytes=${lastText ? lastText.length : 0}. Skipping update check for this story.`,
    );
  }
  return null;
}

/**
 * Compute a SHA-256 hash of the source content used to detect meaningful
 * updates: title + article body text. The hash is stable across runs as
 * long as the source page text is unchanged.
 */
function computeSourceContentHash(html, url) {
  const title = extractTitle(html);
  const articleHtml = extractArticleHtml(html, url);
  const bodyText = stripHtml(articleHtml);
  const composite = `TITLE:${title}\n\nBODY:\n${bodyText}`;
  return createHash('sha256').update(composite, 'utf8').digest('hex');
}

// ===========================================================================
// Source failure detection
// ===========================================================================

/**
 * Inspect a fetcher output document and decide whether it represents a
 * SOURCE FAILURE (not just an empty feed).
 *
 * A source is "failed" when:
 *   - sourceAvailable === false (the fetcher set this explicitly)
 *   - OR httpStatus is 4xx (except 429, treated as transient) / 5xx
 *   - OR fetchError is a non-empty string AND recordCount === 0
 *
 * Returns { failed: boolean, reason: string|null }.
 */
function detectSourceFailure(doc, label) {
  if (!doc) return { failed: true, reason: `${label}: document missing` };
  if (doc.sourceAvailable === false) {
    return {
      failed: true,
      reason: `${label}: sourceAvailable=false (fetchError=${doc.fetchError || '?'}, httpStatus=${doc.httpStatus ?? '?'})`,
    };
  }
  if (typeof doc.httpStatus === 'number') {
    if (doc.httpStatus === 403) {
      return {
        failed: true,
        reason: `${label}: HTTP 403 (bot mitigation / WAF block)`,
      };
    }
    if (doc.httpStatus >= 500 && doc.httpStatus < 600) {
      return {
        failed: true,
        reason: `${label}: HTTP ${doc.httpStatus} (server error)`,
      };
    }
  }
  if (
    typeof doc.fetchError === 'string' &&
    doc.fetchError.trim() !== '' &&
    doc.recordCount === 0
  ) {
    return {
      failed: true,
      reason: `${label}: fetchError="${doc.fetchError.slice(0, 120)}" with recordCount=0`,
    };
  }
  return { failed: false, reason: null };
}

/**
 * Phase 9D.1 — map a published story's source URL (and registry entry)
 * to a canonical source label (NASA / JPL / SWPC) so the step-10 hash
 * check can decide whether the story's source is currently degraded.
 *
 * URL host takes precedence over registry.primarySource (the NISAR and
 * Perseverance stories carry primarySource="NASA" but their sourceUrls
 * point at jpl.nasa.gov, so they are JPL-sourced for resilience
 * purposes).
 */
function labelForSourceUrl(url, published) {
  const u = String(url || '').toLowerCase();
  if (/jpl\.nasa\.gov/.test(u)) return 'JPL';
  if (/swpc\.noaa\.gov|noaa\.gov/.test(u)) return 'SWPC';
  if (/nasa\.gov/.test(u)) return 'NASA';
  // Fallback to the registry's primarySource / scienceStoryKey prefix.
  const key = published && published.scienceStoryKey ? published.scienceStoryKey : '';
  if (published && published.primarySource === 'NASA') return 'NASA';
  if (published && published.primarySource === 'JPL') return 'JPL';
  if (published && published.primarySource === 'NOAA-SWPC') return 'SWPC';
  if (key.startsWith('jpl__')) return 'JPL';
  if (key.startsWith('nasa__')) return 'NASA';
  if (key.startsWith('swpc__')) return 'SWPC';
  return null;
}

// ===========================================================================
// Main
// ===========================================================================

async function main() {
  const startTime = Date.now();
  console.log('============================================');
  console.log('US News Engine — Science Newsroom Automation');
  console.log('============================================');
  console.log(`Started: ${new Date().toISOString()}`);
  console.log('');

  // --- Load configuration (kill switch) ---
  let config;
  try {
    config = JSON.parse(await readFile(CONFIG_FILE, 'utf8'));
  } catch {
    config = {
      sciencePublishingEnabled: false,
      maxScienceNewPerRun: 1,
      maxScienceNewPerDay: 3,
    };
  }
  const publishingEnabled = config.sciencePublishingEnabled === true;
  const maxPerRun = Number.isFinite(config.maxScienceNewPerRun)
    ? config.maxScienceNewPerRun
    : 1;
  const maxPerDay = Number.isFinite(config.maxScienceNewPerDay)
    ? config.maxScienceNewPerDay
    : 3;
  console.log(`Kill switch: sciencePublishingEnabled = ${publishingEnabled}`);
  console.log(`Caps: maxScienceNewPerRun=${maxPerRun}, maxScienceNewPerDay=${maxPerDay}`);

  // --- Test clock / cap override (for dry-run testing ONLY) ---
  const args = process.argv.slice(2);
  const testDateArg = args.find((a) => a.startsWith('--test-date='));
  const ignoreDailyCap = args.includes('--ignore-daily-cap');
  const allowTestPublish = args.includes('--allow-test-publish');
  const useFixture = args.includes('--fixture');
  const testDate = testDateArg ? testDateArg.split('=')[1] : null;
  const hasTestFlag = !!(testDate || ignoreDailyCap || useFixture);
  // Dry run is forced when ANY test flag is present, unless --allow-test-publish
  // is also explicitly provided.
  const dryRunMode = hasTestFlag && !allowTestPublish;
  if (testDate) console.log(`TEST MODE: using test date ${testDate} (does not modify stored timestamps)`);
  if (ignoreDailyCap) console.log('TEST MODE: ignoring daily cap (does not modify stored timestamps)');
  if (useFixture) console.log('TEST MODE: --fixture active (test fixture used as candidate)');
  if (dryRunMode) console.log('TEST MODE: DRY RUN — no production files will be modified');
  if (allowTestPublish) console.log('TEST MODE: --allow-test-publish active (test publishing enabled)');
  console.log('');

  // Phase 9D.1 — source-health state (populated by the real fetch path
  // below; stays null in --fixture mode). Used by the reconcile step
  // (defer rule), the source-content hash check (skip degraded-source
  // stories), and the run summary.
  let sourceHealth = null;
  let preservedJplSources = [];

  // =========================================================================
  // Steps 1-5: Fetch NASA → JPL → SWPC → Update registry → Filter → Stories → Validate
  // =========================================================================
  if (!useFixture) {
    console.log('--- Steps 1-4: Fetch NASA + JPL + SWPC → Update registry → Filter → Stories → Validate ---');
    try {
      runNpm('fetch:nasa', 'Fetch NASA news');
      console.log('  NASA fetch complete.');
      runNpm('fetch:jpl', 'Fetch JPL news');
      console.log('  JPL fetch complete.');
      runNpm('fetch:swpc', 'Fetch SWPC science events');
      console.log('  SWPC fetch complete.');

      // ====================================================================
      // Phase 9D.1 — SOURCE-ISOLATED DEGRADATION
      // ====================================================================
      // Track health independently for NASA, JPL, SWPC. A degraded source
      // (e.g. JPL returning HTTP 202 with an empty body) is marked
      // DEGRADED. The pipeline CONTINUES with the healthy sources; it no
      // longer aborts the whole Science newsroom when one source fails.
      //
      // We also preserve the last-known-good fetcher output for each
      // source (written ONLY on a successful fetch) so cross-source
      // duplicate checking can use preserved JPL records while JPL is
      // degraded. A failed fetch NEVER overwrites the last-known-good
      // copy.
      const nasaRes = await loadJsonOptional(NASA_FILE);
      const jplRes = await loadJsonOptional(JPL_FILE);
      const swpcRes = await loadJsonOptional(SWPC_FILE);

      const fetchDocs = {
        nasa: nasaRes.ok ? nasaRes.doc : null,
        jpl: jplRes.ok ? jplRes.doc : null,
        swpc: swpcRes.ok ? swpcRes.doc : null,
      };

      // Load previous source-health (for consecutiveFailures /
      // lastSuccessfulFetchAt continuity across local runs).
      const prevHealthRes = await loadJsonOptional(SOURCE_HEALTH_FILE);
      const prevHealth =
        prevHealthRes.ok && prevHealthRes.doc && prevHealthRes.doc.sources
          ? prevHealthRes.doc.sources
          : {};

      sourceHealth = computeSourceHealth(fetchDocs, prevHealth);

      // --- Last-known-good preservation ---------------------------------
      // Save a copy of each fetcher output ONLY when the fetch succeeded.
      // A failed fetch never overwrites the preserved good copy. The
      // registry's retained JPL sources are the persistent fallback
      // (committed to the repo) when no last-known-good exists yet.
      await mkdir(LAST_KNOWN_GOOD_DIR, { recursive: true });
      for (const key of SOURCE_KEYS) {
        const docKey = key === 'NASA' ? 'nasa' : key === 'JPL' ? 'jpl' : 'swpc';
        const doc = fetchDocs[docKey];
        if (doc && doc.sourceAvailable === true) {
          try {
            await writeFile(
              LAST_KNOWN_GOOD[key],
              JSON.stringify(doc, null, 2) + '\n',
              'utf8',
            );
          } catch {
            // Non-fatal — last-known-good is best-effort.
          }
        }
      }

      // --- Log source-health status -------------------------------------
      console.log('\n  Source health (Phase 9D.1):');
      for (const key of SOURCE_KEYS) {
        const h = sourceHealth[key];
        const tag = h.status === 'HEALTHY' ? 'HEALTHY' : 'DEGRADED';
        const extra =
          h.status === 'HEALTHY'
            ? `${h.recordCount} records`
            : `httpStatus=${h.httpStatus ?? '?'}, fetchError="${h.fetchError || '?'}", consecutiveFailures=${h.consecutiveFailures}`;
        console.log(`    ${key.padEnd(5)} ${tag}  (${extra})`);
      }

      // --- All-sources-degraded (Scenario F) ----------------------------
      // If ALL THREE sources are degraded, the pipeline still runs (it
      // will produce 0 candidates → clean no-change exit) but we log it
      // explicitly so the run is unambiguous.
      if (allSourcesDegraded(sourceHealth)) {
        console.warn(
          '\n  WARN: ALL Science sources degraded (NASA + JPL + SWPC).',
        );
        console.warn('  Pipeline will continue; expected 0 publications and no production mutation.');
      }

      // --- Build preserved JPL sources for cross-source duplicate safety --
      // Phase 9D.2: the CANONICAL fallback is the tracked science-source-
      // registry.json (committed, survives fresh GHA checkouts). The
      // local last-known-good cache is a NON-CANONICAL optional supplement
      // — deleting it must not change the editorial / dependency outcome.
      // Used by the reconcile step's defer rule when JPL is degraded.
      const regResForJpl = await loadJsonOptional(SOURCE_REGISTRY_FILE);
      const lkgJplRes = await loadJsonOptional(LAST_KNOWN_GOOD.JPL);
      const lkgJpl = lkgJplRes.ok ? lkgJplRes.doc : null;
      preservedJplSources = buildPreservedJplSources({
        registry: regResForJpl.ok ? regResForJpl.doc : null,
        lastKnownGoodJpl: lkgJpl,
      });
      const lkgTag = lkgJplRes.ok ? 'present (non-canonical cache)' : 'absent (canonical registry only)';
      console.log(
        `  Preserved JPL sources for cross-source duplicate check: ${preservedJplSources.length} (last-known-good cache ${lkgTag})`,
      );

      // --- Update source registry (Phase 9A.2 bootstrap safety) ---
      runNpm('registry:science', 'Update science source registry');
      console.log('  Registry update complete.');

      runNpm('filter:science', 'Filter science candidates');
      console.log('  Science filter complete.');
      runNpm('stories:science', 'Build science stories');
      console.log('  Science stories complete.');
      try {
        runNpm('validate:science', 'Validate science data');
        console.log('  validate:science: PASS');
      } catch (err) {
        console.warn('  validate:science: FAIL — continuing in dry-run-friendly mode.');
        console.warn(`    ${String(err.message || err).split('\n')[0]}`);
      }
    } catch (err) {
      console.error('\nFATAL: Science ingestion pipeline failed. Aborting.');
      console.error(err.message);
      process.exit(1);
    }
  } else {
    console.log('--- TEST FIXTURE MODE: skipping fetch/filter/stories/validate ---');
  }

  // --- Load the fresh story feed (or the test fixture) ---
  let liveStories = [];
  if (useFixture) {
    let fixture;
    try {
      fixture = JSON.parse(await readFile(TEST_FIXTURE_FILE, 'utf8'));
      liveStories = [fixture];
    } catch (err) {
      console.error('\nFATAL: data/science/test-fixture.json missing or unreadable.');
      console.error(err.message);
      process.exit(1);
    }
  } else {
    let storiesDoc;
    try {
      storiesDoc = JSON.parse(await readFile(STORIES_FILE, 'utf8'));
    } catch (err) {
      console.error('\nFATAL: science-story-records.json missing or unreadable.');
      console.error(err.message);
      process.exit(1);
    }
    liveStories = Array.isArray(storiesDoc.stories) ? storiesDoc.stories : [];
  }

  // Only consider publishEligible stories for reconciliation/publication.
  // In normal mode we filter out any testOnly fixture that may have leaked
  // into the production feed (it should never be there, but we are
  // belt-and-suspenders). In --fixture mode the testOnly flag is allowed
  // through because the user has explicitly asked to exercise the
  // NEW-candidate selection logic with the synthetic fixture.
  const eligibleStories = liveStories.filter(
    (s) =>
      s.publishEligible === true &&
      (useFixture || s.testOnly !== true),
  );
  console.log(`\n  Story feed: ${liveStories.length} stories total, ${eligibleStories.length} publish-eligible.`);

  // --- Load source registry (for bootstrap safety) ---
  let sourceRegistry = null;
  {
    const regRes = await loadJsonOptional(SOURCE_REGISTRY_FILE);
    if (regRes.ok && Array.isArray(regRes.doc.sources)) {
      sourceRegistry = regRes.doc;
      const bsCount = regRes.doc.sources.filter(
        (s) => s && s.bootstrapSeen === true,
      ).length;
      console.log(
        `  Source registry: ${regRes.doc.sources.length} sources (${bsCount} bootstrap).`,
      );
    }
  }
  const bootstrapSourceKeys = new Set();
  if (sourceRegistry) {
    for (const s of sourceRegistry.sources) {
      if (s && s.bootstrapSeen === true && typeof s.scienceKey === 'string') {
        bootstrapSourceKeys.add(s.scienceKey);
      }
    }
  }

  // --- Step 5: Load published-science registry ---
  console.log('\n--- Step 5: Load published-science registry ---');
  let registry;
  try {
    registry = JSON.parse(await readFile(REGISTRY_FILE, 'utf8'));
    console.log(`  Registry loaded: ${registry.storyCount} published Science stories.`);
  } catch {
    registry = {
      generatedAt: new Date().toISOString(),
      storyCount: 0,
      stories: [],
    };
    console.log('  No registry found — treating all eligible stories as new.');
  }
  if (!Array.isArray(registry.stories)) registry.stories = [];

  // --- Step 6: Reconcile feed against registry ---
  console.log('\n--- Step 6: Reconcile story feed against registry ---');
  const categories = { NEW: [], UPDATED: [], UNCHANGED: [], MISSING: [], DEFERRED: [] };
  for (const story of eligibleStories) {
    const published = registry.stories.find(
      (s) => s.scienceStoryKey === story.scienceStoryKey,
    );
    if (!published) {
      // Bootstrap safety: a story with bootstrapSeen=true source keys
      // must NEVER be a NEW publication candidate. We track it under
      // UNCHANGED so it shows up in the summary but is never selected.
      const allSourceKeys = Array.isArray(story.allSourceKeys)
        ? story.allSourceKeys
        : [story.scienceStoryKey];
      const isBootstrapStory =
        story.bootstrapSeen === true ||
        (bootstrapSourceKeys.size > 0 &&
          allSourceKeys.length > 0 &&
          allSourceKeys.every((k) => bootstrapSourceKeys.has(k)));
      if (isBootstrapStory) {
        console.warn(
          `  [bootstrap-safety] Skipping bootstrap historical story: ${story.scienceStoryKey} ("${story.title}")`,
        );
        categories.UNCHANGED.push(story);
        continue;
      }

      // Phase 9D.1 — source-dependency defer rule. When a source is
      // degraded, a NEW candidate that plausibly duplicates an unseen
      // release from the degraded source is DEFERRED (not published)
      // and reconsidered on the next scheduled run after recovery.
      // SWPC events are independent of JPL and always proceed (subject
      // to SWPC's own health). See science-source-resilience-rules.mjs.
      if (sourceHealth) {
        const dep = evaluateSourceDependency(story, sourceHealth, preservedJplSources);
        if (dep.decision === 'defer') {
          console.log(
            `  [defer] ${story.scienceStoryKey} ("${story.title}") — ${dep.reason}`,
          );
          categories.DEFERRED.push({
            story,
            reason: dep.reason,
            deferStatus: dep.deferStatus || 'deferred-source-dependency',
          });
          continue;
        }
      }

      categories.NEW.push(story);
      continue;
    }
    // We've seen this story before — its update detection happens in
    // step 10 (source-content hash check) for stories that have been
    // published. For now classify as UNCHANGED pending the hash check.
    categories.UNCHANGED.push({ story, published });
  }
  // Registry entries whose storyKey is no longer in the feed.
  const liveKeys = new Set(eligibleStories.map((s) => s.scienceStoryKey));
  for (const published of registry.stories) {
    if (!liveKeys.has(published.scienceStoryKey)) {
      categories.MISSING.push(published);
    }
  }

  console.log(`  NEW (post-bootstrap candidates): ${categories.NEW.length}`);
  console.log(`  DEFERRED (source-dependency): ${categories.DEFERRED.length}`);
  console.log(`  UPDATED: pending source-content hash check`);
  console.log(`  UNCHANGED: ${categories.UNCHANGED.length}`);
  console.log(`  MISSING (registry, not in feed): ${categories.MISSING.length}`);

  // =========================================================================
  // Step 10: Source-content hash check for published stories
  // =========================================================================
  console.log('\n--- Step 10: Source-content hash check for published stories ---');
  // We always run the hash check (even in dry-run mode) so we can report
  // what WOULD be updated. But in dry-run mode we don't persist the
  // lastSourceCheckedAt / lastSourceChangedAt bumps.
  const updatesDetected = [];
  for (const published of registry.stories) {
    const sourceUrls = Array.isArray(published.sourceUrls)
      ? published.sourceUrls
      : [published.sourceUrl].filter(Boolean);
    if (sourceUrls.length === 0) {
      console.warn(`    [skip] ${published.scienceStoryKey}: no source URLs in registry`);
      continue;
    }
    // Phase 9D.1 — if the source for this published story is currently
    // DEGRADED, skip the update check entirely. We do NOT fetch the
    // source page (it would likely fail), we do NOT bump
    // lastSourceCheckedAt, and we do NOT mark the story updated. The
    // article is left untouched until the source recovers. (spec §11)
    if (sourceHealth) {
      const storyLabel = labelForSourceUrl(sourceUrls[0], published);
      if (storyLabel && sourceHealth[storyLabel]?.status === 'DEGRADED') {
        console.log(
          `    [skip-degraded] ${published.scienceStoryKey}: source ${storyLabel} degraded — article left untouched`,
        );
        continue;
      }
    }
    const url = sourceUrls[0];
    const fetched = await fetchSourcePageSafe(url, { forUpdateCheck: true });
    if (!fetched) {
      // Could not fetch source page — skip update detection. We do NOT
      // mark this as updated (no evidence of a change) and we do NOT
      // bump lastSourceCheckedAt (we couldn't check).
      continue;
    }
    const currentHash = computeSourceContentHash(fetched.html, url);
    const prevHash = published.sourceContentHash || null;
    const changed = prevHash !== null && prevHash !== currentHash;
    if (changed) {
      console.log(
        `    [CHANGED] ${published.scienceStoryKey}: hash changed (${(prevHash || '').slice(0, 8)} → ${currentHash.slice(0, 8)})`,
      );
      updatesDetected.push({
        published,
        newHash: currentHash,
        source: fetched.source,
      });
    } else if (prevHash === null) {
      // First time we've computed the hash for this story. We store it
      // but do NOT treat it as an update (we have no baseline to
      // compare against). This is the normal case for stories that
      // were published before Phase 9D.
      console.log(
        `    [BASELINE] ${published.scienceStoryKey}: storing initial hash (${currentHash.slice(0, 8)})`,
      );
      // In non-dry-run mode, persist the baseline hash.
      if (!dryRunMode) {
        published.sourceContentHash = currentHash;
        published.lastSourceCheckedAt = new Date().toISOString();
        // lastSourceChangedAt stays null — we have no prior baseline.
      }
    } else {
      console.log(
        `    [unchanged] ${published.scienceStoryKey}: hash stable (${currentHash.slice(0, 8)})`,
      );
      if (!dryRunMode) {
        published.lastSourceCheckedAt = new Date().toISOString();
      }
    }
  }
  // Promote detected updates into categories.UPDATED.
  for (const upd of updatesDetected) {
    categories.UPDATED.push(upd);
    // Remove from UNCHANGED.
    const idx = categories.UNCHANGED.findIndex(
      (u) => u && u.published && u.published.scienceStoryKey === upd.published.scienceStoryKey,
    );
    if (idx >= 0) categories.UNCHANGED.splice(idx, 1);
  }
  console.log(
    `  Source-content hash check: ${updatesDetected.length} meaningful update(s) detected.`,
  );

  // --- Step 11: Re-report reconciliation ---
  console.log('\n--- Reconciliation summary ---');
  console.log(`  NEW (post-bootstrap candidates): ${categories.NEW.length}`);
  console.log(`  DEFERRED (source-dependency): ${categories.DEFERRED.length}`);
  console.log(`  UPDATED: ${categories.UPDATED.length}`);
  console.log(`  UNCHANGED: ${categories.UNCHANGED.length}`);
  console.log(`  MISSING (registry, not in feed): ${categories.MISSING.length}`);

  // --- Phase 9D.1: persist internal resilience diagnostics ---
  // These files live under data/science/ (NOT committed by the GitHub
  // Actions workflow — only src/ public/ data/published-science.json
  // are committed). They are internal-only and never appear on public
  // pages. Writing them does NOT constitute a content change and does
  // NOT trigger a commit or deploy.
  await saveSourceHealth(sourceHealth);
  await saveDeferredCandidates(categories.DEFERRED, sourceHealth);

  // --- Step 12: Check daily cap ---
  const today = (testDate || new Date().toISOString()).slice(0, 10);
  const publishedToday = registry.stories.filter(
    (s) => s.publishedAt && s.publishedAt.startsWith(today),
  ).length;
  const remainingDaily = ignoreDailyCap ? maxPerDay : Math.max(0, maxPerDay - publishedToday);
  const newAllowed = ignoreDailyCap ? maxPerRun : Math.min(maxPerRun, remainingDaily);
  console.log(
    `\n  Daily cap: ${publishedToday} published today (UTC), ${remainingDaily} remaining, ${newAllowed} allowed this run`,
  );

  // --- Kill switch check ---
  if (!publishingEnabled) {
    console.log('\n============================================');
    console.log('PUBLISHING DISABLED (kill switch active)');
    console.log('No public content changes will be made.');
    console.log('No Git commit. No Cloudflare deploy.');
    console.log('============================================');
    printSummary(categories, 0, 0, startTime, 0, 0, { sourceHealth });
    return;
  }

  // --- Dry-run check (test mode without --allow-test-publish) ---
  if (dryRunMode) {
    console.log('\n============================================');
    console.log('TEST MODE DRY RUN — no production files modified');
    console.log('Candidate selection and reporting only.');
    console.log('No article files created. No registry changes.');
    console.log('No Git commit. No Cloudflare deploy.');
    console.log('============================================');
    if (categories.UPDATED.length > 0) {
      console.log(`\n  Would update ${categories.UPDATED.length} existing stories:`);
      for (const u of categories.UPDATED) {
        console.log(
          `    - ${u.published.scienceStoryKey} (slug=${u.published.slug})`,
        );
      }
    }
    if (categories.DEFERRED.length > 0) {
      console.log(`\n  Deferred (${categories.DEFERRED.length}) — source-dependency:`);
      for (const d of categories.DEFERRED) {
        console.log(
          `    - ${d.story.scienceStoryKey} [${d.deferStatus}] ${d.reason}`,
        );
      }
    }
    if (newAllowed > 0 && categories.NEW.length > 0) {
      const selected = selectNewStories(categories.NEW, newAllowed);
      console.log(`\n  Would publish ${selected.length} new stories:`);
      for (const story of selected) {
        console.log(`    - ${story.scienceStoryKey}`);
        console.log(`        title: ${story.title}`);
        console.log(`        mission: ${story.mission || 'n/a'}`);
        console.log(`        storyType: ${story.storyType || 'n/a'}`);
        console.log(`        priority: ${story.priority || 'medium'}`);
        console.log(`        score: ${story.storyScore}`);
        console.log(`        bootstrapSeen: ${story.bootstrapSeen === true}`);
      }
    } else {
      console.log('\n  No new stories would be published (daily cap or no candidates).');
    }
    printSummary(categories, 0, 0, startTime, 0, 0, { sourceHealth });
    return;
  }

  // =========================================================================
  // Step 13: Process UPDATES first
  // =========================================================================
  console.log('\n--- Step 13: Process UPDATED stories ---');
  let updatedCount = 0;
  for (const upd of categories.UPDATED) {
    try {
      await processUpdate(upd);
      updatedCount++;
      console.log(`  UPDATED: ${upd.published.scienceStoryKey}`);
    } catch (err) {
      console.error(
        `  UPDATE FAILED: ${upd.published.scienceStoryKey} — ${err.message}`,
      );
    }
  }
  if (updatedCount > 0 || hasBaselineHashesToPersist(registry)) {
    await saveRegistry(registry);
  }

  // --- Step 14-15: Select NEW stories ---
  console.log('\n--- Step 14-15: Select NEW stories for publication ---');
  const selectedNew = selectNewStories(categories.NEW, newAllowed);
  console.log(`  Selected ${selectedNew.length} new stories for publication`);
  if (selectedNew.length > 0) {
    console.log('  Selection (priority, score, key):');
    for (const s of selectedNew) {
      console.log(
        `    - [${s.priority || 'medium'}] score=${s.storyScore} ${s.scienceStoryKey}`,
      );
    }
  }

  // =========================================================================
  // Steps 16-17: Generate drafts, images, publish articles
  // =========================================================================
  console.log('\n--- Steps 16-17: Generate drafts → images → publish ---');
  let sourceImageHeroes = 0;
  let graphicHeroes = 0;
  let newPublished = 0;
  for (const story of selectedNew) {
    try {
      console.log(`\n  Processing NEW: ${story.scienceStoryKey}`);
      const result = await publishNewArticle(story, registry);
      newPublished++;
      if (result.imageKind === 'source-image') sourceImageHeroes++;
      else graphicHeroes++;
      console.log(`    Published: /news/${result.slug}/`);
    } catch (err) {
      console.error(`    PUBLISH FAILED: ${story.scienceStoryKey} — ${err.message}`);
    }
  }
  if (newPublished > 0) {
    await saveRegistry(registry);
  }

  // --- No-change behavior: if nothing changed, exit before validation/build ---
  const totalChanges = newPublished + updatedCount;
  if (totalChanges === 0) {
    console.log('\n============================================');
    console.log('NO CONTENT CHANGES — skipping validation and build.');
    console.log('============================================');
    printSummary(categories, 0, updatedCount, startTime, sourceImageHeroes, graphicHeroes, { sourceHealth });
    return;
  }

  // --- Step 18: Run science validation ---
  console.log('\n--- Step 18: Run science validation ---');
  try {
    runNpm('validate:science', 'Science validation');
    console.log('  validate:science: PASS');
  } catch (err) {
    console.error('  validate:science: FAIL — aborting before publishing validation.');
    console.error(err.message);
    process.exit(1);
  }

  // --- Step 19: Run publishing validation ---
  console.log('\n--- Step 19: Run publishing validation ---');
  try {
    runNpm('validate:publishing', 'Publishing validation');
    console.log('  validate:publishing: PASS');
  } catch (err) {
    console.error('  validate:publishing: FAIL — aborting before build.');
    console.error(err.message);
    process.exit(1);
  }

  // --- Step 20: Run Astro production build ---
  console.log('\n--- Step 20: Run Astro production build ---');
  try {
    runNpm('build', 'Astro build');
    console.log('  build: PASS');
  } catch (err) {
    console.error('  build: FAIL — aborting.');
    console.error(err.message);
    process.exit(1);
  }

  printSummary(categories, newPublished, updatedCount, startTime, sourceImageHeroes, graphicHeroes, { sourceHealth });
}

// ===========================================================================
// Selection logic
// ===========================================================================

/**
 * Select new stories respecting the cap.
 * Sort: priority high first, then storyScore descending.
 */
function selectNewStories(newStories, cap) {
  if (cap <= 0 || newStories.length === 0) return [];
  const priorityRank = (p) => (p === 'high' ? 0 : p === 'medium' ? 1 : 2);
  const sorted = [...newStories].sort((a, b) => {
    const pr = priorityRank(a.priority) - priorityRank(b.priority);
    if (pr !== 0) return pr;
    return (b.storyScore || 0) - (a.storyScore || 0);
  });
  return sorted.slice(0, cap);
}

/**
 * Return true if the registry has any stories whose sourceContentHash
 * was newly set during this run (baseline persistence).
 */
function hasBaselineHashesToPersist(registry) {
  for (const s of registry.stories) {
    if (s.sourceContentHash && !s.lastSourceCheckedAt) return true;
  }
  return false;
}

// ===========================================================================
// Update + publish functions
// ===========================================================================

/**
 * Process an UPDATE: the live source page has changed meaningfully.
 * Preserve slug + publishedAt, set updatedAt, refresh the source
 * content hash + lastSourceChangedAt, and bump the article file's
 * updatedAt frontmatter.
 */
async function processUpdate(update) {
  const now = new Date().toISOString();
  const { published, newHash } = update;
  published.updatedAt = now;
  published.sourceContentHash = newHash;
  published.lastSourceCheckedAt = now;
  published.lastSourceChangedAt = now;
  published.lastSeenAt = now;
  published.lastCheckedAt = now;
  published.status = 'active';

  // Update article frontmatter updatedAt
  const articlePath = join(PROJECT_DIR, published.articlePath);
  try {
    let content = await readFile(articlePath, 'utf8');
    if (content.includes('updatedAt:')) {
      content = content.replace(/^updatedAt:.*$/m, `updatedAt: ${now}`);
    } else {
      content = content.replace(
        /^(publishedAt:.*$)/m,
        `$1\nupdatedAt: ${now}`,
      );
    }
    await writeFile(articlePath, content, 'utf8');
  } catch {
    // Article file may have been moved — skip
  }
}

/**
 * Publish a NEW Science story:
 *   1. Generate draft via generate-science-draft.mjs
 *   2. Generate image via generate-science-image.mjs
 *   3. Copy image to public/images/
 *   4. Create article markdown in src/content/articles/
 *   5. Add entry to registry (caller saves)
 *
 * Before publication, the story is verified to be NON-bootstrap
 * (bootstrapSeen must be false) — this is the bootstrap-safety net.
 */
async function publishNewArticle(story, registry) {
  // --- Bootstrap safety net (defense-in-depth) ---
  // We already filtered bootstrap stories out of NEW in step 6, but we
  // re-check here so a bug in the upstream filter cannot cause a
  // bootstrap backfill.
  const allSourceKeys = Array.isArray(story.allSourceKeys)
    ? story.allSourceKeys
    : [story.scienceStoryKey];
  const allBootstrap =
    story.bootstrapSeen === true ||
    (bootstrapSourceKeys.size > 0 &&
      allSourceKeys.length > 0 &&
      allSourceKeys.every((k) => bootstrapSourceKeys.has(k)));
  if (allBootstrap) {
    throw new Error(
      `Refusing to publish bootstrap historical story ${story.scienceStoryKey} (bootstrap-safety net)`,
    );
  }

  // 1. Generate draft (fetches full source page + claim audit)
  runNode(
    `scripts/generate-science-draft.mjs "${story.scienceStoryKey}"`,
    `generate-science-draft for ${story.scienceStoryKey}`,
  );

  // 2. Generate image
  let imageGenFailed = false;
  try {
    runNode(
      `scripts/generate-science-image.mjs "${story.scienceStoryKey}"`,
      `generate-science-image for ${story.scienceStoryKey}`,
    );
  } catch (err) {
    console.warn(`    Image generation failed — will use fallback graphic. (${err.message.split('\n')[0]})`);
    imageGenFailed = true;
  }

  // 3. Load the draft
  // The slug is derived inside the draft generator; we mirror its formula
  // here to find the draft JSON.
  const slugGuess = deriveSlug(story);
  const draftPath = join(PROJECT_DIR, 'data', 'science', 'drafts', `${slugGuess}.json`);
  let draft;
  try {
    draft = JSON.parse(await readFile(draftPath, 'utf8'));
  } catch {
    draft = await findLatestDraftForStory(story.scienceStoryKey);
  }
  if (!draft) {
    throw new Error(
      `Could not locate draft JSON for ${story.scienceStoryKey} after generate-science-draft.`,
    );
  }
  const slug = draft.slug;

  // 4. Copy image from data/draft-images/ to public/images/
  const sidecarPath = join(PROJECT_DIR, 'data', 'draft-images', `${slug}.json`);
  let sidecar = null;
  try {
    sidecar = JSON.parse(await readFile(sidecarPath, 'utf8'));
  } catch {
    // No sidecar — best effort
  }

  // Determine which image file exists (.jpg for verified-agency / mixed-agency
  // source images; .png for factual-graphic fallback).
  const draftImagesDir = join(PROJECT_DIR, 'data', 'draft-images');
  const jpgPath = join(draftImagesDir, `${slug}.jpg`);
  const pngPath = join(draftImagesDir, `${slug}.png`);
  const svgPath = join(draftImagesDir, `${slug}.svg`);
  const publicImagesDir = join(PROJECT_DIR, 'public', 'images');
  await mkdir(publicImagesDir, { recursive: true });

  let imageKind = 'graphic';
  let imageFilename = '';
  let publicImagePath = '';
  if (await fileExists(jpgPath)) {
    imageKind = 'source-image';
    imageFilename = `${slug}.jpg`;
    publicImagePath = join(publicImagesDir, imageFilename);
    await copyFile(jpgPath, publicImagePath);
  } else if (await fileExists(pngPath)) {
    imageKind = 'graphic';
    imageFilename = `${slug}.png`;
    publicImagePath = join(publicImagesDir, imageFilename);
    await copyFile(pngPath, publicImagePath);
  } else {
    imageKind = 'graphic';
    imageFilename = 'og-default.svg';
  }

  const heroImagePath = `/images/${imageFilename}`;
  const heroImageAlt = sidecar?.alt || draft.image?.alt || draft.title || slug;
  const heroImageCaption =
    sidecar?.caption || draft.image?.caption || `Science graphic for ${draft.title}.`;
  const heroImageCreator =
    sidecar?.source ||
    draft.image?.credit ||
    'US News Engine (editorial data graphic)';
  const heroImageLicense =
    sidecar?.licenseNotes ||
    (imageKind === 'source-image'
      ? 'Official NASA/JPL source image — U.S. government work'
      : 'Original editorial graphic generated by US News Engine from NASA source information');
  const heroImageLicenseUrl = '';
  const heroImageSourceUrl =
    sidecar?.sourceUrl || draft.image?.sourcePageUrl || draft.sourceUrl || '';

  // 5. Build article markdown file
  const now = new Date().toISOString();
  // IMPORTANT: publishedAt is the time we publish the article, NOT the
  // source publication date. sourcePublishedAt is stored separately.
  const bodyMarkdown = draft.body
    .map((section) => {
      const heading = section.heading ? `\n## ${section.heading}\n` : '';
      const paras = section.paragraphs.join('\n\n');
      return heading + paras;
    })
    .join('\n\n');

  // Tags: source-driven ("NASA" + mission + topic).
  const tags = ['NASA'];
  if (story.mission) tags.push(story.mission);
  const topicTag = story.topic || story.scienceMetadata?.topic;
  if (topicTag) tags.push(topicTag);

  const articleContent = `---
slug: "${yamlEscape(slug)}"
title: "${yamlEscape(draft.title)}"
description: "${yamlEscape(draft.description)}"
category: science
author: "US News Engine Science Desk"
publishedAt: ${now}
sourcePublishedAt: ${draft.sourcePublishedAt || story.publishedAtSource || ''}
image: "${yamlEscape(heroImagePath)}"
imageAlt: "${yamlEscape(heroImageAlt)}"
imageMode: "${yamlEscape(draft.image?.mode || (imageKind === 'source-image' ? 'official-source-image' : 'factual-graphic-fallback'))}"
imageCaption: "${yamlEscape(heroImageCaption)}"
imageCreator: "${yamlEscape(heroImageCreator)}"
imageLicense: "${yamlEscape(heroImageLicense)}"
sourceName: "${yamlEscape(draft.sourceName || 'NASA')}"
sourceUrl: "${yamlEscape(draft.sourceUrl || story.sourceUrl || '')}"
sourceOffice: "${yamlEscape(draft.sourceOffice || 'NASA')}"
tags: [${tags.map((t) => `"${t}"`).join(', ')}]
breaking: ${draft.breaking === true}
featured: false
views: 0
---

${bodyMarkdown}
`;

  const articlePath = join(PROJECT_DIR, 'src', 'content', 'articles', `${slug}.md`);
  await mkdir(dirname(articlePath), { recursive: true });
  await writeFile(articlePath, articleContent, 'utf8');

  // 6. Compute the initial sourceContentHash for this story so future
  // update checks have a baseline.
  let sourceContentHash = null;
  try {
    const sourceHtml = await readFile(
      cacheFileForUrl(draft.sourceUrl || story.sourceUrl),
      'utf8',
    );
    sourceContentHash = computeSourceContentHash(
      sourceHtml,
      draft.sourceUrl || story.sourceUrl,
    );
  } catch {
    // Cache not present (the draft generator may have used the live
    // response without caching). We'll compute the baseline on the
    // next newsroom run.
  }

  // 7. Add entry to registry (caller will save)
  registry.stories.push({
    scienceStoryKey: story.scienceStoryKey,
    primarySource: story.primarySource || 'NASA',
    sourceKeys: Array.isArray(story.allSourceKeys)
      ? story.allSourceKeys
      : [story.scienceStoryKey],
    slug,
    articlePath: `src/content/articles/${slug}.md`,
    title: draft.title,
    publishedAt: now,
    updatedAt: null,
    sourcePublishedAt: draft.sourcePublishedAt || story.publishedAtSource || null,
    sourceUrls: Array.isArray(story.sourceUrls)
      ? story.sourceUrls
      : [story.sourceUrl],
    storyType: story.storyType || null,
    mission: story.mission || null,
    topic: story.topic || null,
    imageMode: draft.image?.mode || (imageKind === 'source-image' ? 'official-source-image' : 'factual-graphic-fallback'),
    imageSourceUrl: heroImagePath,
    imageCredit: heroImageCreator,
    imageLicense: heroImageLicense,
    imageLicenseUrl: heroImageLicenseUrl,
    imageSourcePageUrl: heroImageSourceUrl,
    sourceContentHash,
    lastSourceCheckedAt: sourceContentHash ? now : null,
    lastSourceChangedAt: null,
    status: 'active',
    firstSeenAt: now,
    lastSeenAt: now,
    lastCheckedAt: now,
    breaking: draft.breaking === true,
  });

  return { slug, imageKind };
}

/**
 * Best-effort slug guess by mirroring the draft generator's slug formula.
 * The canonical slug comes from the draft itself once loaded.
 */
function deriveSlug(story) {
  const d = story.publishedAtSource ? new Date(story.publishedAtSource) : null;
  const dateStr = d
    ? `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
    : '';
  const mission = String(story.mission || 'mission')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const topic = String(story.titleSeed || story.title || 'story')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return [mission, topic, dateStr].filter(Boolean).join('-').slice(0, 80);
}

/**
 * Scan data/science/drafts/ for the most-recently-modified draft whose
 * scienceStoryKey matches. Used when the slug guess doesn't match.
 */
async function findLatestDraftForStory(scienceStoryKey) {
  const draftsDir = join(PROJECT_DIR, 'data', 'science', 'drafts');
  let files;
  try {
    files = await readdir(draftsDir);
  } catch {
    return null;
  }
  const jsonFiles = files.filter((f) => f.endsWith('.json'));
  let best = null;
  let bestTime = 0;
  for (const f of jsonFiles) {
    try {
      const d = JSON.parse(await readFile(join(draftsDir, f), 'utf8'));
      if (d.scienceStoryKey !== scienceStoryKey) continue;
      const t = d.generatedAt ? new Date(d.generatedAt).getTime() : 0;
      if (t >= bestTime) {
        bestTime = t;
        best = d;
      }
    } catch {
      // skip
    }
  }
  return best;
}

// ===========================================================================
// Persistence
// ===========================================================================

async function saveRegistry(registry) {
  registry.generatedAt = new Date().toISOString();
  registry.storyCount = registry.stories.length;
  await mkdir(dirname(REGISTRY_FILE), { recursive: true });
  await writeFile(REGISTRY_FILE, JSON.stringify(registry, null, 2) + '\n', 'utf8');
  console.log(`  Registry saved: ${REGISTRY_FILE} (${registry.storyCount} stories).`);
}

/**
 * Phase 9D.1 — persist the per-source health model. INTERNAL ONLY:
 * lives under data/science/ (not committed by the workflow). Used for
 * consecutiveFailures / lastSuccessfulFetchAt continuity across local
 * runs and for post-run diagnostics.
 */
async function saveSourceHealth(health) {
  if (!health) return;
  try {
    const doc = {
      generatedAt: new Date().toISOString(),
      source: 'Phase 9D.1 Science source health',
      sources: health,
    };
    await mkdir(dirname(SOURCE_HEALTH_FILE), { recursive: true });
    await writeFile(SOURCE_HEALTH_FILE, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  } catch {
    // Non-fatal — diagnostics only.
  }
}

/**
 * Phase 9D.1 — persist the list of NEW candidates deferred this run
 * because of a degraded-source dependency. INTERNAL ONLY: lives under
 * data/science/ (not committed by the workflow). Used by
 * validate-science to confirm deferred candidates never reach
 * published-science.json.
 */
async function saveDeferredCandidates(deferred, health) {
  try {
    const doc = {
      generatedAt: new Date().toISOString(),
      source: 'Phase 9D.1 deferred Science candidates',
      sourceHealth: health || null,
      deferredCount: deferred.length,
      deferred: deferred.map((d) => ({
        scienceStoryKey: d.story?.scienceStoryKey || null,
        title: d.story?.title || null,
        mission: d.story?.mission || null,
        primarySource: d.story?.primarySource || null,
        reason: d.reason || null,
        deferStatus: d.deferStatus || null,
      })),
    };
    await mkdir(dirname(DEFERRED_CANDIDATES_FILE), { recursive: true });
    await writeFile(DEFERRED_CANDIDATES_FILE, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  } catch {
    // Non-fatal — diagnostics only.
  }
}

// ===========================================================================
// Summary
// ===========================================================================

function printSummary(
  categories,
  newPublished,
  updatedCount,
  startTime,
  sourceImageHeroes = 0,
  graphicHeroes = 0,
  extra = {},
) {
  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('\n============================================');
  console.log('US News Engine Science Newsroom Run Summary');
  console.log('============================================');
  const eligibleCount =
    (categories.NEW?.length || 0) +
    (categories.UPDATED?.length || 0) +
    (categories.UNCHANGED?.length || 0) +
    (categories.DEFERRED?.length || 0);
  console.log(`Candidates evaluated: ${eligibleCount} publish-eligible stories considered`);
  console.log('');
  // --- Source health status (Phase 9D.1) ---
  if (extra.sourceHealth) {
    console.log('Source health:');
    for (const key of SOURCE_KEYS) {
      const h = extra.sourceHealth[key];
      if (!h) continue;
      console.log(`  ${key.padEnd(5)} ${h.status}`);
    }
    console.log('');
  }
  console.log(`NEW FOUND (post-bootstrap): ${categories.NEW?.length || 0}`);
  console.log(`NEW PUBLISHED: ${newPublished}`);
  console.log(`UPDATED: ${updatedCount}`);
  console.log(`UNCHANGED: ${categories.UNCHANGED?.length || 0}`);
  console.log(`DEFERRED (source-dependency): ${categories.DEFERRED?.length || 0}`);
  console.log(`MISSING (registry, not in feed): ${categories.MISSING?.length || 0}`);
  if (extra.sourceFailure) {
    console.log('');
    console.log('SOURCE FAILURE: pipeline did not proceed');
    console.log(`  reason: ${extra.sourceFailureReason}`);
  }
  if ((newPublished === 0) && (updatedCount === 0) && (categories.DEFERRED?.length || 0) === 0) {
    console.log('NO-CHANGE STATUS: no content changes this run');
  }
  console.log('');
  console.log(`SOURCE-IMAGE HEROES (NASA/JPL photo): ${sourceImageHeroes}`);
  console.log(`GRAPHIC HEROES (editorial): ${graphicHeroes}`);
  console.log('');
  console.log(`Duration: ${duration}s`);
  console.log('============================================');
}

// ===========================================================================
// Bootstrap
// ===========================================================================

main().catch((err) => {
  console.error(`\nFATAL: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
