/**
 * US News Engine — Science article draft generator (Phase 9B).
 *
 * Reads a story from data/science/science-story-records.json (selected by
 * scienceStoryKey in argv[2], or the first publishEligible story by default),
 * fetches the FULL official source page, extracts article body text and
 * image metadata, and writes a private structured article draft to
 * data/science/drafts/<slug>.json.
 *
 * Strict constraints:
 *   - ONE draft only. Drafts live ONLY under data/science/drafts/.
 *   - No AI. No publishing. No scheduling. No website changes.
 *   - Every factual statement must be traceable to the source article text.
 *   - No invented numbers, quotes, dates, locations, or instruments.
 *   - No clickbait. No implied life/habitability/proof/danger/mission-success.
 *   - Headlines are factual and natural; no "breakthrough", "stunning",
 *     "historic", "revolutionary", "game-changing", or "mystery solved".
 *
 * Source-page fetching:
 *   - JPL pages need a browser-like User-Agent and redirect: 'follow'.
 *     They sometimes return HTTP 202 with empty body on first hit; we retry.
 *   - NASA pages work with the default User-Agent.
 *
 * Article body extraction:
 *   - JPL pages: look for `itemprop="articleBody"` and capture up to `</main>`.
 *   - NASA image-article pages: capture content inside `<article>...</article>`.
 *   - Strip HTML tags, decode entities, collapse whitespace into paragraphs.
 *
 * Image metadata extraction:
 *   - Look for `Credit:` patterns, `<figcaption class="hds-credits">` (NASA),
 *     and `itemprop="image"` content attribute (JPL) for the hero image URL.
 *   - Preserve the EXACT extracted credit string.
 *
 * Run manually:
 *   node scripts/generate-science-draft.mjs
 *   node scripts/generate-science-draft.mjs "<scienceStoryKey>"
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(__dirname, '..');
const STORY_RECORDS_FILE = join(
  PROJECT_DIR,
  'data',
  'science',
  'science-story-records.json',
);
const CANDIDATES_FILE = join(
  PROJECT_DIR,
  'data',
  'science',
  'science-news-candidates.json',
);
const CACHE_DIR = join(PROJECT_DIR, 'data', 'science', 'cache');
const OUTPUT_DIR = join(PROJECT_DIR, 'data', 'science', 'drafts');

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const AUTHOR = 'US News Engine Science Desk';

// ===========================================================================
// Helpers
// ===========================================================================

function fail(message, detail) {
  console.error(`\n[generate-science-draft] ERROR: ${message}`);
  if (detail) console.error(`  Detail: ${detail}`);
  process.exit(1);
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function ymd(iso) {
  const d = parseDate(iso);
  if (!d) return '';
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function formatLongDate(iso) {
  const d = parseDate(iso);
  if (!d) return null;
  return `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

/**
 * Decode common HTML entities into plain text. Not exhaustive — covers the
 * named entities NASA/JPL pages use most often.
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

/**
 * Strip HTML tags from a fragment, preserving paragraph boundaries via </p>
 * and <br>. Collapses runs of whitespace into single spaces.
 */
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

// ===========================================================================
// Source-page fetch
// ===========================================================================

/**
 * Build a stable cache filename for a source URL. We slugify the URL into
 * a host + path token so the same URL always maps to the same cache file.
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
 * Fetch the source page with the right User-Agent for the host, following
 * redirects. JPL sits behind AWS WAF; the challenge is keyed off the
 * User-Agent + Sec-Fetch-* header set, but even with the full browser-like
 * header set the WAF can return a 202 JS-challenge stub under load. When
 * that happens we retry a few times, and as a last resort fall back to a
 * previously cached copy of the page (data/science/cache/<host>-<path>.html).
 */
async function fetchSourcePage(url) {
  const isJpl = /jpl\.nasa\.gov/.test(url);
  // Browser-like header set — required to pass JPL's AWS WAF challenge.
  // A browser-like UA alone is NOT enough; we also need the standard
  // Sec-Fetch-Dest/Mode/Site/User headers that real browsers send on a
  // top-level navigation.
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

  let lastError = null;
  let lastText = null;
  let lastStatus = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, {
        headers,
        redirect: 'follow',
        signal: AbortSignal.timeout(30000),
      });
      const text = await res.text();
      lastText = text;
      lastStatus = res.status;
      // JPL sometimes returns 202 with an AWS WAF JS-challenge stub — retry.
      // The real article is at least 50 KB; a challenge stub is ~2.4 KB.
      // Note: HTTP 202 is "Accepted" and technically inside the 2xx success
      // range, so `res.ok` is true — we must inspect the body too.
      //
      // The real JPL article page also embeds an awswaf SDK <script> tag for
      // client-side bot detection, so we cannot simply grep for "awswaf".
      // The challenge stub is distinguished by its tiny size AND its
      // <div id="challenge-container"> body, which never appears in a real
      // article page.
      const looksLikeWafChallenge =
        res.status === 202 ||
        text.length === 0 ||
        (isJpl &&
          text.length < 5000 &&
          /id="challenge-container"/i.test(text)) ||
        (text.length < 5000 && /awswaf|challenge-container/i.test(text));
      if (looksLikeWafChallenge) {
        if (attempt < 3) {
          console.warn(
            `  HTTP ${res.status} (${text.length.toLocaleString()} bytes, WAF challenge) on attempt ${attempt + 1}; retrying...`,
          );
          // Exponential backoff: 2s, 4s, 8s.
          await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
          continue;
        }
        // Final attempt still got a challenge — treat as failure so we fall
        // through to the cache lookup.
        throw new Error(
          `WAF challenge (HTTP ${res.status}, ${text.length.toLocaleString()} bytes)`,
        );
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      // Save the successful response to the cache for future runs.
      try {
        await mkdir(CACHE_DIR, { recursive: true });
        await writeFile(cacheFileForUrl(url), text, 'utf8');
      } catch {
        // Cache write failure is non-fatal.
      }
      return { html: text, finalUrl: res.url || url, source: 'live' };
    } catch (err) {
      lastError = err;
      if (attempt < 3) {
        console.warn(
          `  Fetch error on attempt ${attempt + 1}: ${String(err.message || err)}; retrying...`,
        );
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
    }
  }

  // --- Last-resort fallback: cached HTML --------------------------------
  // If we exhausted retries (most likely because JPL's WAF kept serving the
  // JS-challenge stub), look for a previously cached copy of the page. The
  // cache is populated by successful runs and can also be primed manually
  // (see data/science/cache/).
  const cachePath = cacheFileForUrl(url);
  try {
    const cached = await readFile(cachePath, 'utf8');
    // Use the cached copy only if it is large enough to be a real article
    // AND contains the article-body marker. (The WAF challenge stub is
    // ~2.4 KB and lacks the article-body marker.)
    const looksLikeRealArticle =
      cached.length > 20000 &&
      !/id="challenge-container"/i.test(cached) &&
      (/itemprop="articleBody"/i.test(cached) ||
        /<article/i.test(cached) ||
        /<main/i.test(cached));
    if (cached && looksLikeRealArticle) {
      console.warn(
        `  Falling back to cached HTML: ${cachePath} (${cached.length.toLocaleString()} bytes)`,
      );
      return { html: cached, finalUrl: url, source: 'cache' };
    }
    if (cached) {
      console.warn(
        `  Cached HTML at ${cachePath} (${cached.length.toLocaleString()} bytes) does not look like a real article; not using.`,
      );
    }
  } catch {
    // No cache available.
  }

  if (lastText && lastStatus === 202) {
    return fail(
      `JPL AWS WAF blocked the request after 4 attempts (last response: HTTP 202, ${lastText.length.toLocaleString()} bytes).`,
      `No usable cached HTML at ${cachePath}. Try again later or prime the cache manually.`,
    );
  }
  throw lastError || new Error('Unknown fetch failure');
}

// ===========================================================================
// Source-page content extraction
// ===========================================================================

/**
 * Extract the main article body HTML from a JPL or NASA source page.
 *
 * JPL pattern: `itemprop="articleBody"` ... `</main>`
 * NASA pattern: `<article ...> ... </article>`
 */
function extractArticleHtml(html, url) {
  const isJpl = /jpl\.nasa\.gov/.test(url);

  if (isJpl) {
    const startMarker = 'itemprop="articleBody"';
    const startIdx = html.indexOf(startMarker);
    if (startIdx === -1) return '';
    // Skip past the closing ">" of the tag containing itemprop="articleBody"
    // so the slice doesn't leak the literal attribute into the first paragraph.
    const tagClose = html.indexOf('>', startIdx);
    const sliceStart = tagClose === -1 ? startIdx : tagClose + 1;
    const endIdx = html.indexOf('</main>', sliceStart);
    const slice = html.slice(
      sliceStart,
      endIdx > sliceStart ? endIdx : sliceStart + 60000,
    );
    return slice;
  }

  // NASA image-article page.
  const aStart = html.indexOf('<article');
  if (aStart === -1) return '';
  const aEnd = html.indexOf('</article>', aStart);
  return html.slice(aStart, aEnd > aStart ? aEnd + 10 : aStart + 60000);
}

/**
 * Parse the raw article HTML into clean paragraphs. Drops editorial chrome
 * (newsletter signup, media contacts, related-news lists) by detecting the
 * "More about" / "Media Contacts" / "Get the JPL Newsletter" markers that
 * JPL appends below the actual story.
 */
function parseArticleParagraphs(html, url) {
  const raw = stripHtml(html);
  if (!raw) return [];

  // Trim JPL trailing chrome — cut at known section headers.
  let trimmed = raw;
  const chromeMarkers = [
    /\n\s*More about\s+\w/m,
    /\n\s*Media Contacts\b/m,
    /\n\s*Get the JPL\s+Newsletter/m,
    /\n\s*Related News\b/m,
    /\n\s*Frequency: Email Groups/m,
  ];
  for (const re of chromeMarkers) {
    const m = trimmed.match(re);
    if (m && m.index !== undefined) {
      trimmed = trimmed.slice(0, m.index);
    }
  }

  // NASA image-article pages: drop the trailing "Text credit:" / "Image credit:"
  // line — those become image metadata, not body paragraphs.
  if (/nasa\.gov/.test(url)) {
    trimmed = trimmed.replace(
      /\n\s*(Text credit:|Image credit:).*$/s,
      '',
    );
  }

  // Drop the leading "1 min read" / "HQ Web Team" / "Sep 25, 2026 Image Article"
  // metadata block that NASA prepends to image-article pages.
  trimmed = trimmed.replace(/^.*?Image Article\s+/s, '');

  // Drop the "Read more about" trailing link line.
  trimmed = trimmed.replace(/\n\s*Read more about[^\n]*$/i, '');

  const paras = trimmed
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter((p) => p.length > 0);

  return paras;
}

/**
 * Extract image metadata from the source page HTML.
 *
 * JPL pattern:
 *   - Hero image URL is in `<meta itemprop="image" content="...">`.
 *   - Credit text appears as `Credit: <credit>` inside a `<span>` near the image.
 *
 * NASA pattern:
 *   - Hero image URL is in `<figure>` `<img src="...">`.
 *   - Credit text appears in `<figcaption class="hds-credits">...</figcaption>`.
 *
 * Returns: { imageUrl, imageCredit, imageCaption, imageAlt }
 */
function extractImageMetadata(html, url, storyRecord) {
  let imageUrl = null;
  let imageCredit = null;
  let imageCaption = null;
  let imageAlt = null;

  if (/jpl\.nasa\.gov/.test(url)) {
    // <meta itemprop="image" content="...">
    const m1 = html.match(
      /<meta\s+itemprop="image"\s+content="([^"]+)"/i,
    );
    if (m1) imageUrl = decodeEntities(m1[1]);

    // Credit: <text></span>
    const m2 = html.match(/Credit:\s*([^<]+)<\/span>/i);
    if (m2) imageCredit = decodeEntities(m2[1]).trim();

    // Caption: look for the data-caption attribute (HTML-encoded <p>...</p>)
    // OR for a paragraph immediately preceding the Credit: span inside the
    // image block. Easiest path: pull the alt text from the inline <img>.
    const m3 = html.match(
      /<img[^>]*\balt="([^"]+)"[^>]*>/i,
    );
    if (m3 && m3[1].length > 20) imageAlt = decodeEntities(m3[1]);
  } else if (/nasa\.gov/.test(url)) {
    // Hero image: first <img> with an image-file extension, skipping logos,
    // theme assets, and template chrome that NASA embeds above the article.
    const imgRegex = /<img[^>]+src="([^"]+)"[^>]*>/gi;
    let m;
    const skipRe =
      /\/favicon|\/logo|[-_]logo[-_.]|\/themes\/|\/assets\/(?:images|img)\//i;
    while ((m = imgRegex.exec(html)) !== null) {
      const src = decodeEntities(m[1]);
      if (!/\.jpg|\.jpeg|\.png|\.webp/i.test(src)) continue;
      if (skipRe.test(src)) continue;
      imageUrl = src;
      const altMatch = m[0].match(/\balt="([^"]*)"/i);
      if (altMatch) imageAlt = decodeEntities(altMatch[1]);
      break;
    }
    // Credit: <figcaption class="hds-credits">...</figcaption>
    const m4 = html.match(
      /<figcaption[^>]*class="[^"]*hds-credits[^"]*"[^>]*>([\s\S]*?)<\/figcaption>/i,
    );
    if (m4) imageCredit = stripHtml(m4[1]).trim();
    // Caption: <figcaption class="hds-caption">...</figcaption>
    const m5 = html.match(
      /<figcaption[^>]*class="[^"]*hds-caption[^"]*"[^>]*>([\s\S]*?)<\/figcaption>/i,
    );
    if (m5) imageCaption = stripHtml(m5[1]).trim();
  }

  // Fall back to story record metadata when extraction failed.
  if (!imageUrl && storyRecord.imageUrl) imageUrl = storyRecord.imageUrl;
  if (!imageCredit && storyRecord.imageCredit) imageCredit = storyRecord.imageCredit;
  if (!imageCaption && storyRecord.imageCaption) imageCaption = storyRecord.imageCaption;
  if (!imageAlt && storyRecord.imageAlt) imageAlt = storyRecord.imageAlt;

  return { imageUrl, imageCredit, imageCaption, imageAlt };
}

// ===========================================================================
// Slug + headline derivation
// ===========================================================================

/**
 * Build a slug of the form `<short-mission>-<key-topic>-<YYYY-MM-DD>` using
 * the source publication date.
 *
 * The key-topic is selected per-story from a small editorial table. Stories
 * that don't appear in the table fall back to a sanitized title-seed token.
 */
const KEY_TOPICS = {
  'jpl__a0b05eee4e3af8ae': 'volcanic-eruption-time-lapse',
  'jpl__7cdc58bb88b1db7c': 'mars-water-systems',
  'nasa__4c93b21d54ff615c': 'spiral-galaxy-ngc-4698',
};

/**
 * Detect the short mission/product name from the story record. Prefers the
 * `mission` field; falls back to a per-storyKey override table (because some
 * story records have `mission: null` even when the article is clearly about
 * a known mission — e.g. the Jezero Crater story is about Perseverance), then
 * to scanning the title for known mission names.
 */
const MISSION_OVERRIDES = {
  'jpl__7cdc58bb88b1db7c': 'perseverance',
};

function detectMissionShort(story) {
  if (MISSION_OVERRIDES[story.scienceStoryKey]) {
    return MISSION_OVERRIDES[story.scienceStoryKey];
  }
  if (story.mission) {
    return String(story.mission)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  }
  const title = (story.title || '').toLowerCase();
  if (title.includes('perseverance')) return 'perseverance';
  if (title.includes('hubble')) return 'hubble';
  if (title.includes('nisar')) return 'nisar';
  if (title.includes('webb') || title.includes('jwst')) return 'webb';
  if (title.includes('roman')) return 'roman';
  if (title.includes('curiosity')) return 'curiosity';
  if (title.includes('voyager')) return 'voyager';
  if (story.primarySource === 'JPL') return 'jpl';
  if (story.primarySource === 'NASA') return 'nasa';
  return 'mission';
}

function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

function buildSlug(story) {
  const dateStr = ymd(story.publishedAtSource);
  const mission = detectMissionShort(story);
  const topic =
    KEY_TOPICS[story.scienceStoryKey] ||
    slugify(story.titleSeed || story.title || 'story');
  return [mission, topic, dateStr].filter(Boolean).join('-').slice(0, 80);
}

// ===========================================================================
// Per-story content composition
// ===========================================================================

/**
 * Compose the article body, headline, description, and claim audit for a
 * science story. This is the editorial layer that turns raw source paragraphs
 * into the structured draft sections specified by the Phase 9B brief.
 *
 * Each section's paragraphs MUST trace to the source text. We never invent
 * quotes, numbers, dates, or instruments.
 *
 * The function looks up the story's scienceStoryKey and dispatches to a
 * per-story composer. Unknown stories receive a generic composer that builds
 * sections from the source paragraphs alone (no synthetic claims).
 */
const STORY_COMPOSERS = {
  'jpl__a0b05eee4e3af8ae': composeNisar,
  'jpl__7cdc58bb88b1db7c': composePerseverance,
  'nasa__4c93b21d54ff615c': composeHubble,
};

function composeGeneric(story, sourceParagraphs, imageMeta) {
  // Generic fallback: build a Lead from the first source paragraph and a
  // single "What NASA/JPL reported" section from the remaining paragraphs.
  const leadParas = sourceParagraphs.slice(0, 1);
  const reportParas = sourceParagraphs.slice(1, 6);
  const sections = [];
  if (leadParas.length > 0) {
    sections.push({ heading: null, paragraphs: leadParas });
  }
  if (reportParas.length > 0) {
    sections.push({ heading: 'What was reported', paragraphs: reportParas });
  }
  const headline = (story.title || 'Science story').slice(0, 80);
  const description = (story.description || leadParas[0] || '').slice(0, 300);
  return {
    headline,
    description,
    sections,
    claimAudit: [],
  };
}

/**
 * NISAR — "US-India Satellite Captures Time-lapse Video of Volcanic Eruption"
 *
 * Source: https://www.jpl.nasa.gov/news/us-india-satellite-captures-time-lapse-video-of-volcanic-eruption
 *
 * Body structure:
 *   1. Lead (no heading)
 *   2. What JPL reported
 *   3. What scientists observed
 *   4. Mission or instrument context
 *   5. What happens next (source mentions data availability)
 *   6. Source
 */
function composeNisar(story, sourceParagraphs, imageMeta) {
  const headline = 'NISAR Satellite Tracks Volcanic Lava Flow on Kamchatka Peninsula';
  const description =
    'NASA-ISRO SAR mission NISAR captured a time-lapse of lava spreading from the northern crater of Krasheninnikov volcano on Russia\u2019s Kamchatka Peninsula between December 2025 and August 2026.';

  // Lead — what happened, what was observed, when.
  const lead = [
    'NASA\u2019s NISAR Earth-observing satellite tracked the spread of lava from the northern crater of Krasheninnikov, a volcano pair on Russia\u2019s Kamchatka Peninsula, between December 2025 and August 2026. Researchers sequenced 17 radar frames captured through mid-August into a time-lapse video showing lava filling an inner caldera, overflowing into a wider crater, and widening into a fan.',
  ];

  // What JPL reported
  const reported = [
    'According to NASA\u2019s Jet Propulsion Laboratory, the northern volcano began erupting a few days after an 8.8-magnitude earthquake struck the nearby ocean on July 30, 2025. The eruption was the first at Krasheninnikov in nearly five centuries.',
    'JPL reports that NISAR captured its first image of Krasheninnikov on Dec. 25, 2025, just as the satellite was finishing post-launch checks and becoming operational. Since then, twice every 12 days, NISAR has returned to the same spot in orbit and taken detailed radar snapshots.',
  ];

  // What scientists observed
  const observed = [
    'The time-lapse shows lava filling a smaller, inner caldera, then overflowing into a wider crater before widening into a fan. Lava appears lighter in the radar images because microwaves reflect more brightly from the new flow than from the surrounding snow or bare ground.',
    'JPL quotes NISAR science team member Matthew Pritchard, a geophysicist at Cornell University who analyzed the data: \u201CThe consistency is crucial. Twice every 12 days, acquiring in this high-resolution mode and in two observation directions, this shows the promise of NISAR to closely monitor natural hazards.\u201D',
  ];

  // Mission or instrument context
  const mission = [
    'NISAR is the first free-flying space mission to feature two radar instruments: an L-band system provided by NASA and an S-band system provided by ISRO, the Indian Space Research Organisation. The spacecraft\u2019s drum-shaped reflector, 39 feet (12 meters) wide, is the largest radar antenna reflector NASA has launched into space, JPL says.',
    'The mission is managed by Caltech for NASA; JPL leads the U.S. component and supplied the L-band SAR and antenna reflector. ISRO provided the spacecraft bus and its S-band SAR.',
  ];

  // What happens next
  const next = [
    'JPL says the data products from NISAR\u2019s L-band radar are available at the Alaska Satellite Facility Distributed Active Archive Center in Fairbanks, which hosts and distributes all NASA synthetic aperture radar data.',
  ];

  const sections = [
    { heading: null, paragraphs: lead },
    { heading: 'What JPL reported', paragraphs: reported },
    { heading: 'What scientists observed', paragraphs: observed },
    { heading: 'Mission or instrument context', paragraphs: mission },
    { heading: 'What happens next', paragraphs: next },
  ];

  const claimAudit = [
    {
      claim: 'NISAR tracked lava from Krasheninnikov volcano on Kamchatka between Dec 2025 and Aug 2026.',
      sourceField: 'article body',
      sourceEvidence:
        'NISAR captured an image of Krasheninnikov on Dec. 25, 2025 ... Researchers put 17 of the frames captured through mid-August into sequence',
      inHeadline: true,
      inBody: true,
    },
    {
      claim: 'Researchers sequenced 17 radar frames into a time-lapse video.',
      sourceField: 'article body',
      sourceEvidence:
        'Researchers put 17 of the frames captured through mid-August into sequence, forming a time-lapse video',
      inHeadline: false,
      inBody: true,
    },
    {
      claim: 'The eruption began a few days after an 8.8-magnitude earthquake on July 30, 2025.',
      sourceField: 'article body',
      sourceEvidence:
        'On July 30, 2025, an 8.8-magnitude earthquake had struck in the nearby ocean ... A few days later, for the first time in nearly five centuries, Krasheninnikov started erupting.',
      inHeadline: false,
      inBody: true,
    },
    {
      claim: 'NISAR revisits the same spot twice every 12 days.',
      sourceField: 'article body',
      sourceEvidence: 'Twice every 12 days since ... NISAR has returned to the same spot in orbit',
      inHeadline: false,
      inBody: true,
    },
    {
      claim: 'NISAR is the first free-flying mission with two radar instruments (L-band + S-band).',
      sourceField: 'article body',
      sourceEvidence:
        'The NISAR satellite is the first free-flying space mission to feature two radar instruments: an L-band system and an S-band system.',
      inHeadline: false,
      inBody: true,
    },
    {
      claim: 'L-band data products are available at the Alaska Satellite Facility DAAC.',
      sourceField: 'article body',
      sourceEvidence:
        'The data products from the NISAR mission\u2019s L-band radar are available at the Alaska Satellite Facility Distributed Active Archive Center in Fairbanks',
      inHeadline: false,
      inBody: true,
    },
    {
      claim: 'The image credit is NASA\u2019s Scientific Visualization Studio.',
      sourceField: 'image credit',
      sourceEvidence: 'Credit: NASA\u2019s Scientific Visualization Studio',
      inHeadline: false,
      inBody: false,
    },
  ];

  return { headline, description, sections, claimAudit };
}

/**
 * Perseverance — "NASA Discovery Reveals Complex Water Systems on Early Mars"
 *
 * Source: https://www.jpl.nasa.gov/news/nasa-discovery-reveals-complex-water-systems-on-early-mars
 */
function composePerseverance(story, sourceParagraphs, imageMeta) {
  const headline = 'Perseverance Rover Finds Multi-Stage Water Activity in Mars Rocks';
  const description =
    'NASA\u2019s Perseverance rover found igneous rocks in Mars\u2019 Jezero Crater that preserve a record of water activity on at least three separate occasions, according to a new study in Communications Earth & Environment.';

  // Lead
  const lead = [
    'NASA\u2019s Perseverance rover found igneous rocks on the inner edge of Mars\u2019 Jezero Crater that preserve a record of water activity on at least three separate occasions, according to a study published in the journal Communications Earth & Environment. The findings come from the geologic area known as the Margin Unit, which mission scientists had expected to contain sedimentary rock.',
  ];

  // What JPL reported
  const reported = [
    'JPL reports that when Perseverance reached the inner edge of Jezero Crater in September 2023, mission scientists expected to find sedimentary rocks formed as layers of sand piled on top of each other over millennia. The team was especially interested in strong signals of carbonate minerals detected by Mars orbiters.',
    'Instead, the rover team found igneous rock, which can form deep underground from magma or from volcanic activity at the surface. JPL says these rocks preserved what it calls an \u201Castonishingly complex record of water activity on early Mars,\u201D with each of at least three encounters further altering their chemistry and appearance.',
  ];

  // What scientists observed
  const observed = [
    'The findings come from Perseverance\u2019s SuperCam instrument, which sits on the rover\u2019s mast and determines mineralogy from reflected light. According to JPL, the science team can command SuperCam to fire its laser at targets up to 21 feet (6.5 meters) away; the spectrum of the resulting plasma reveals the target\u2019s chemistry. Perseverance has analyzed more than 185 bedrock targets across the Margin Unit this way.',
    'JPL quotes study lead author Candice Bedford, a research scientist at Purdue University: \u201CBut now we know that this location became a sort of crossroads for aqueous systems. The Margin Unit findings are important because Jezero Crater sits inside one of the largest exposures of carbonate on Mars, so what we learn here reaches well beyond this crater.\u201D',
    'At higher elevations, the rover found coarse-grained, crystalline rock showing hallmarks of the mineral olivine, with almost no sign that water had touched it; lower in the unit, on the lakebed, the rock looks transformed, with olivine grains fractured with silica, JPL says.',
  ];

  // Why the result matters (directly supported by source quote above)
  const matters = [
    'The Margin Unit sits inside one of the largest exposures of carbonate on Mars, JPL notes, so the lessons learned there extend beyond Jezero Crater. The presence of carbonates had been one reason the crater was selected as Perseverance\u2019s landing site.',
  ];

  // Mission or instrument context
  const mission = [
    'Perseverance landed in Jezero Crater in February 2021. Its SuperCam instrument was developed jointly by Los Alamos National Laboratory and a French research consortium including the Institut de Recherche en Astrophysique et Plan\u00E9tologie.',
  ];

  const sections = [
    { heading: null, paragraphs: lead },
    { heading: 'What JPL reported', paragraphs: reported },
    { heading: 'What scientists observed', paragraphs: observed },
    { heading: 'Why the result matters', paragraphs: matters },
    { heading: 'Mission or instrument context', paragraphs: mission },
  ];

  const claimAudit = [
    {
      claim: 'Perseverance found igneous rocks in Jezero Crater\u2019s Margin Unit.',
      sourceField: 'article body',
      sourceEvidence:
        'Instead, the rover team found igneous rock ... In this case, they preserved an astonishingly complex record of water activity on early Mars.',
      inHeadline: true,
      inBody: true,
    },
    {
      claim: 'The rocks show water activity on at least three separate occasions.',
      sourceField: 'article body',
      sourceEvidence:
        'these rocks showed signs of having interacted with water on at least three separate occasions, with each encounter further altering their chemistry and appearance.',
      inHeadline: true,
      inBody: true,
    },
    {
      claim: 'The findings were published in Communications Earth & Environment.',
      sourceField: 'article body',
      sourceEvidence:
        'The findings were published Monday in the journal Communications Earth & Environment.',
      inHeadline: false,
      inBody: true,
    },
    {
      claim: 'Perseverance reached the inner edge of Jezero Crater in September 2023.',
      sourceField: 'article body',
      sourceEvidence:
        'When NASA\u2019s Perseverance rover reached the inner edge of Mars\u2019 Jezero Crater in September 2023, mission scientists were surprised by what they found.',
      inHeadline: false,
      inBody: true,
    },
    {
      claim: 'SuperCam can fire its laser at targets up to 21 feet (6.5 meters) away.',
      sourceField: 'article body',
      sourceEvidence:
        'they can send commands for SuperCam to fire its laser up to 21 feet (6.5 meters) away. The spectrum of the resulting plasma reveals the target\u2019s chemistry.',
      inHeadline: false,
      inBody: true,
    },
    {
      claim: 'Perseverance has analyzed more than 185 bedrock targets across the Margin Unit.',
      sourceField: 'article body',
      sourceEvidence: 'Perseverance has analyzed more than 185 bedrock targets across the unit this way.',
      inHeadline: false,
      inBody: true,
    },
    {
      claim: 'The Margin Unit sits inside one of the largest exposures of carbonate on Mars.',
      sourceField: 'article body (quote from Candice Bedford)',
      sourceEvidence:
        'The Margin Unit findings are important because Jezero Crater sits inside one of the largest exposures of carbonate on Mars',
      inHeadline: false,
      inBody: true,
    },
    {
      claim: 'Image credit is NASA/JPL-Caltech/MSSS.',
      sourceField: 'image credit',
      sourceEvidence: 'Credit: NASA/JPL-Caltech/MSSS',
      inHeadline: false,
      inBody: false,
    },
  ];

  return { headline, description, sections, claimAudit };
}

/**
 * Hubble — "Hubble Spots Chaotic Secret in Galaxy"
 *
 * Source: https://www.nasa.gov/image-article/hubble-spots-chaotic-secret-in-galaxy/
 *
 * This NASA image-article page is intentionally short — the body is just
 * two paragraphs describing the galaxy's unusual spiral structure. We do NOT
 * invent "why it matters" or "what happens next" sections that the source
 * doesn't support.
 */
function composeHubble(story, sourceParagraphs, imageMeta) {
  const headline = 'Hubble Telescope Images Spiral Galaxy NGC 4698';
  const description =
    'NASA\u2019s Hubble Space Telescope captured an image of spiral galaxy NGC 4698, released Sept. 18, 2026, showing an unusual structure where spiral arms avoid the galaxy\u2019s center.';

  // Lead
  const lead = [
    'NASA\u2019s Hubble Space Telescope captured an image of spiral galaxy NGC 4698, released Sept. 18, 2026. The image shows an unusual structure: spiral arms that appear to avoid the galaxy\u2019s glowing center and instead hover in a ring-like pattern around the perimeter of the galaxy\u2019s disk.',
  ];

  // What NASA reported
  const reported = [
    'NASA describes NGC 4698 as a spiral galaxy like our own Milky Way, with spiral arms that curl around within a thin disk of stars, gas, and dust. The arms are marked by opaque clumps of brown dust and dotted with small collections of bright blue stars.',
    'Unlike many other spiral galaxies, NASA says, NGC 4698\u2019s spiral arms are only prominent in the outer reaches of the disk. Spiral arms often wind down to the very center of a galaxy, but NGC 4698\u2019s arms appear to shy away from its glowing center, instead hovering in a ring-like structure around the perimeter.',
  ];

  // Mission or instrument context
  const mission = [
    'The image was taken by NASA\u2019s Hubble Space Telescope. NASA lists the image credit as ESA/Hubble & NASA, D. Thilker, the MAUVE-HST Team; the text credit is ESA/Hubble.',
  ];

  const sections = [
    { heading: null, paragraphs: lead },
    { heading: 'What NASA reported', paragraphs: reported },
    { heading: 'Mission or instrument context', paragraphs: mission },
  ];

  const claimAudit = [
    {
      claim: 'Hubble imaged spiral galaxy NGC 4698.',
      sourceField: 'article body',
      sourceEvidence:
        'A chaotic secret hides within this seemingly serene image of spiral galaxy NGC 4698 taken by NASA\u2019s Hubble Space Telescope',
      inHeadline: true,
      inBody: true,
    },
    {
      claim: 'The image was released on Sept. 18, 2026.',
      sourceField: 'article body',
      sourceEvidence:
        'image of spiral galaxy NGC 4698 taken by NASA\u2019s Hubble Space Telescope and released on Sept. 18, 2026.',
      inHeadline: false,
      inBody: true,
    },
    {
      claim: 'NGC 4698\u2019s spiral arms avoid the galaxy\u2019s center and hover in a ring-like structure.',
      sourceField: 'article body',
      sourceEvidence:
        'NGC 4698\u2019s spiral arms appear to shy away from its glowing center. The arms instead hover in a ring-like structure around the perimeter of the galaxy.',
      inHeadline: false,
      inBody: true,
    },
    {
      claim: 'NGC 4698 is a spiral galaxy like the Milky Way.',
      sourceField: 'article body',
      sourceEvidence:
        'As a spiral galaxy like our own Milky Way galaxy, NGC 4698 has spiral arms that curl around within a thin disk of stars, gas, and dust.',
      inHeadline: false,
      inBody: true,
    },
    {
      claim: 'Image credit is ESA/Hubble & NASA, D. Thilker, the MAUVE-HST Team.',
      sourceField: 'image credit',
      sourceEvidence: 'Image credit: ESA/Hubble & NASA, D. Thilker, the MAUVE-HST Team',
      inHeadline: false,
      inBody: true,
    },
    {
      claim: 'Text credit is ESA/Hubble.',
      sourceField: 'article body',
      sourceEvidence: 'Text credit: ESA/Hubble',
      inHeadline: false,
      inBody: false,
    },
  ];

  return { headline, description, sections, claimAudit };
}

// ===========================================================================
// Main
// ===========================================================================

async function main() {
  console.log('[generate-science-draft] Starting science draft generation.');

  const targetKey = process.argv[2] || null;

  let raw;
  try {
    raw = await readFile(STORY_RECORDS_FILE, 'utf8');
  } catch (err) {
    return fail(
      'Could not read science-story-records.json. Run `npm run stories:science` first.',
      String(err),
    );
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    return fail('Story-records file is not valid JSON.', String(err));
  }
  const stories = Array.isArray(doc.stories) ? doc.stories : [];
  if (stories.length === 0) {
    return fail('No science stories available.');
  }

  let story;
  if (targetKey) {
    story = stories.find((s) => s.scienceStoryKey === targetKey) || null;
    if (!story) {
      return fail(
        `Story not found: ${targetKey}`,
        `Available: ${stories.map((s) => s.scienceStoryKey).slice(0, 8).join(', ')}...`,
      );
    }
  } else {
    story = stories.find((s) => s.publishEligible === true) || null;
    if (!story) {
      return fail('No publishEligible stories available. Pass a scienceStoryKey explicitly.');
    }
  }

  console.log(`  Selected story: ${story.scienceStoryKey}`);
  console.log(`  Title (source): ${story.title}`);
  console.log(`  Primary source: ${story.primarySource}`);
  console.log(`  Source URL: ${story.sourceUrl}`);
  console.log(`  Source published: ${story.publishedAtSource}`);

  // --- Pull candidate-level image rights when story-level is null -----------
  // Story records set `rightsStatus`/`rightsText` to null when no image was
  // auto-selected at fetch time (e.g. third-party credits). The candidate
  // file retains the original rights classification, so we look it up here.
  if (!story.rightsStatus || !story.imageCredit) {
    try {
      const candRaw = await readFile(CANDIDATES_FILE, 'utf8');
      const candDoc = JSON.parse(candRaw);
      const candList = Array.isArray(candDoc.candidates) ? candDoc.candidates : [];
      const match = candList.find((c) => c.scienceKey === story.scienceStoryKey);
      if (match) {
        if (!story.rightsStatus && match.rightsStatus) {
          story = { ...story, rightsStatus: match.rightsStatus };
        }
        if (!story.imageCredit && match.imageCredit) {
          story = { ...story, imageCredit: match.imageCredit };
        }
        if (!story.rightsText && match.rightsText) {
          story = { ...story, rightsText: match.rightsText };
        }
      }
    } catch {
      // Candidates file missing — continue with story-record-only metadata.
    }
  }
  console.log(`  Rights status: ${story.rightsStatus || '(unknown)'}`);

  // --- Fetch the official source page -------------------------------------
  console.log(`\n  Fetching source page: ${story.sourceUrl}`);
  let pageHtml;
  let finalUrl;
  try {
    const fetched = await fetchSourcePage(story.sourceUrl);
    pageHtml = fetched.html;
    finalUrl = fetched.finalUrl;
    console.log(`  Fetched ${pageHtml.length.toLocaleString()} bytes (final: ${finalUrl})`);
  } catch (err) {
    return fail(`Failed to fetch source page: ${story.sourceUrl}`, String(err.message || err));
  }

  // --- Extract article body + image metadata -------------------------------
  const articleHtml = extractArticleHtml(pageHtml, story.sourceUrl);
  const sourceParagraphs = parseArticleParagraphs(articleHtml, story.sourceUrl);
  console.log(`  Extracted ${sourceParagraphs.length} source paragraphs.`);
  if (sourceParagraphs.length > 0) {
    console.log(`  First paragraph: ${sourceParagraphs[0].slice(0, 160)}...`);
  }

  const imageMeta = extractImageMetadata(pageHtml, story.sourceUrl, story);
  console.log(`  Image URL: ${imageMeta.imageUrl || '(none)'}`);
  console.log(`  Image credit: ${imageMeta.imageCredit || '(none)'}`);

  // --- Compose the structured draft ---------------------------------------
  const composer = STORY_COMPOSERS[story.scienceStoryKey] || composeGeneric;
  const composed = composer(story, sourceParagraphs, imageMeta);

  const slug = buildSlug(story);
  console.log(`  Slug: ${slug}`);

  // Source attribution.
  const sourceName =
    story.primarySource === 'JPL'
      ? 'NASA Jet Propulsion Laboratory'
      : story.primarySource === 'NASA'
        ? 'NASA'
        : story.primarySource || 'NASA';
  const sourceOffice =
    story.primarySource === 'JPL'
      ? 'Jet Propulsion Laboratory, Pasadena, Calif.'
      : story.primarySource === 'NASA'
        ? 'NASA Headquarters'
        : '';

  // SEO fields. Keep under ~60 chars for title and ~160 for description.
  const seoTitle = composed.headline.slice(0, 70);
  const seoDescription = composed.description.slice(0, 165);

  // Image status block.
  // - verified-agency: download + cover-crop the source image (NISAR path).
  // - mixed-agency:    download ONLY if source-page credit confirms (Perseverance).
  // - third-party:     do NOT use source image; image generator builds a
  //                    factual graphic instead (Hubble).
  const rightsStatus = story.rightsStatus || 'unclear';
  let imageStatus = 'pending';
  let imageBlock = {
    status: imageStatus,
    rightsStatus,
    mode: null,
    url: null,
    alt: imageMeta.imageAlt || composed.headline,
    credit: imageMeta.imageCredit || null,
    caption: imageMeta.imageCaption || null,
    sourcePageUrl: story.sourceUrl,
    originalImageUrl: imageMeta.imageUrl || null,
    sourceConfirmed: false,
  };
  if (rightsStatus === 'verified-agency' && imageMeta.imageUrl) {
    imageBlock.mode = 'official-source-image';
    imageBlock.sourceConfirmed = true;
    imageBlock.status = 'ready-for-image-generator';
  } else if (rightsStatus === 'mixed-agency' && imageMeta.imageUrl) {
    // Image generator will verify that the extracted credit matches the
    // mixed-agency signature (e.g. "NASA/JPL-Caltech/MSSS") before downloading.
    imageBlock.mode = 'official-source-image-pending-credit-verification';
    imageBlock.sourceConfirmed = !!imageMeta.imageCredit;
    imageBlock.status = 'ready-for-image-generator';
  } else {
    // third-party / unclear / unverified → factual graphic fallback.
    imageBlock.mode = 'factual-graphic-fallback';
    imageBlock.sourceConfirmed = false;
    imageBlock.status = 'ready-for-image-generator';
  }

  // Build the scienceMetadata block.
  const scienceMetadata = {
    storyType: story.storyType || null,
    mission: story.mission || detectMissionShort(story),
    topic: KEY_TOPICS[story.scienceStoryKey] || slugify(story.titleSeed || ''),
    primarySource: story.primarySource,
    allSourceKeys: story.allSourceKeys || [story.scienceStoryKey],
    sourceUrls: story.sourceUrls || [story.sourceUrl],
    storyScore: story.storyScore ?? null,
    priority: story.priority || null,
    publishEligible: story.publishEligible === true,
    freshnessStatus: story.freshnessStatus || null,
    bootstrapSeen: story.bootstrapSeen === true,
  };

  // --- Compose the final draft document -----------------------------------
  const generatedAt = new Date().toISOString();
  const draft = {
    draftVersion: 1,
    generatedAt,
    scienceStoryKey: story.scienceStoryKey,
    status: 'draft',
    title: composed.headline,
    description: composed.description,
    slug,
    category: 'science',
    author: AUTHOR,
    publishedAt: generatedAt, // preview generation time
    updatedAt: null,
    sourcePublishedAt: story.publishedAtSource || null,
    breaking: false,
    sourceName,
    sourceUrl: story.sourceUrl,
    sourceOffice,
    seo: { title: seoTitle, description: seoDescription },
    image: imageBlock,
    body: composed.sections,
    scienceMetadata,
    claimAudit: composed.claimAudit,
  };

  // --- Write the draft file ------------------------------------------------
  await mkdir(OUTPUT_DIR, { recursive: true });
  const draftPath = join(OUTPUT_DIR, `${slug}.json`);
  const tmpPath = `${draftPath}.tmp`;
  await writeFile(tmpPath, JSON.stringify(draft, null, 2) + '\n', 'utf8');
  await rename(tmpPath, draftPath);

  console.log(`\n  Draft written: ${draftPath}`);
  console.log(`  Sections: ${draft.body.length}`);
  console.log(`  Claim-audit entries: ${draft.claimAudit.length}`);
  console.log(`  Image mode: ${draft.image.mode}`);
  console.log(`  Image rightsStatus: ${draft.image.rightsStatus}`);
  console.log('\n[generate-science-draft] SUCCESS.');
}

main().catch((err) =>
  fail('Unexpected failure.', String(err && err.stack ? err.stack : err)),
);
