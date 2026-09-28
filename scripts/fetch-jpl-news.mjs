/**
 * US News Engine — JPL news-release fetcher (Phase 9A.1 hardened).
 *
 * Fetches NASA Jet Propulsion Laboratory (JPL) news releases from the
 * JPL RSS feed:
 *   https://www.jpl.nasa.gov/feeds/news/
 *
 * Phase 9A.1 changes from Phase 9A:
 *   - Uses the corrected endpoint `/feeds/news/` (Phase 9A tried
 *     `/news/feed/` which is wrong).
 *   - Uses a browser-like User-Agent. As of 2026-09, the JPL feed
 *     returns HTTP 403 to the project's default `USNewsEngine/1.0`
 *     user-agent but returns HTTP 200 (724 KB) to a Chrome User-Agent.
 *     The User-Agent is hardcoded below.
 *   - Replaces regex-based RSS parsing with `fast-xml-parser`. The JPL
 *     feed contains a malformed `<content:encoded<![CDATA[ ... ]]>/></...>`
 *     pattern that confuses the parser; we pre-process the XML to
 *     normalize those tags before parsing.
 *   - Adds provenance metadata: sourceAvailable, fetchedAt, recordCount,
 *     fetchError, httpStatus.
 *   - Hardens image provenance: JPL's RSS exposes <media:content> with
 *     <media:credit>, <media:title>, and <media:text> child elements at
 *     the item level, so the credit/caption come straight from the
 *     MediaRSS extension (no HTML scraping required). The imageCredit
 *     is the EXACT extracted credit text. `rightsStatus` follows the
 *     same rules as NASA's fetcher.
 *   - Adds a `storyType` field (same classifier as NASA).
 *
 * Output schema is identical to fetch-nasa-news.mjs (shared science
 * schema) except `source` is "JPL" and `scienceKey` uses the `jpl__`
 * prefix.
 *
 * This script makes exactly ONE HTTP request to the JPL feed, writes
 * the normalized records to data/science/jpl-news.json atomically, and
 * prints a brief summary. It does NOT publish anything to the website
 * and does NOT use AI.
 *
 * Run manually:
 *   npm run fetch:jpl
 *
 * No API key is required by this endpoint.
 */

import { mkdir, writeFile, rename, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { XMLParser } from 'fast-xml-parser';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(__dirname, '..');

// --- Configuration ---------------------------------------------------------
const FEED_URL = 'https://www.jpl.nasa.gov/feeds/news/';
const OUTPUT_FILE = join(PROJECT_DIR, 'data', 'science', 'jpl-news.json');
const SOURCE_NAME = 'JPL';
const SOURCE_TYPE = 'news-release';

// Browser-like User-Agent — required for JPL. With the project's
// default `USNewsEngine/1.0` User-Agent, JPL returns HTTP 403.
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const ACCEPT = 'application/rss+xml, application/xml, text/xml; q=0.9, */*; q=0.5';
const FETCH_TIMEOUT_MS = 30_000;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: true,
  parseTagValue: false,
  trimValues: true,
});

// --- Mission keyword table (shared with NASA, duplicated for independence) -
const MISSION_PATTERNS = [
  [/\bartemis\b/i, 'Artemis'],
  [/\bstarliner\b/i, 'Starliner'],
  [/\bcrew[\s-]?dragon\b/i, 'Crew Dragon'],
  [/\bspacex\s+crew\b/i, 'Crew Dragon'],
  [/\bjames\s+webb\b/i, 'James Webb'],
  [/\bjwst\b/i, 'James Webb'],
  [/\bwebb\s+telescope\b/i, 'James Webb'],
  [/\bhubble\b/i, 'Hubble'],
  [/\bperseverance\b/i, 'Perseverance'],
  [/\bcuriosity\b/i, 'Curiosity'],
  [/\bpsyche\b/i, 'Psyche'],
  [/\beuropa\s+clipper\b/i, 'Europa Clipper'],
  [/\bviper\b/i, 'VIPER'],
  [/\bdragonfly\b/i, 'Dragonfly'],
  [/\biss\b|\binternational\s+space\s+station\b/i, 'ISS'],
  [/\bspacex\b/i, 'SpaceX'],
  [/\bfalcon\s+(heavy|9)\b/i, 'Falcon'],
  [/\bsls\b|\bspace\s+launch\s+system\b/i, 'SLS'],
  [/\borion\b/i, 'Orion'],
  [/\bnew\s+horizons\b/i, 'New Horizons'],
  [/\bvoyager\b/i, 'Voyager'],
  [/\bcassini\b/i, 'Cassini'],
  [/\bjuno\b/i, 'Juno'],
  [/\bparker\s+solar\s+probe\b/i, 'Parker Solar Probe'],
  [/\blucy\b/i, 'Lucy'],
  [/\bdart\b/i, 'DART'],
  [/\binsight\b/i, 'InSight'],
  [/\bchandra\b/i, 'Chandra'],
  [/\bswift\b/i, 'Swift'],
  [/\bnustar\b/i, 'NuSTAR'],
  [/\bnu_star\b/i, 'NuSTAR'],
  [/\bdragon\b/i, 'Dragon'],
  [/\bcygnus\b/i, 'Cygnus'],
  [/\bstarlink\b/i, 'Starlink'],
  [/\blandsat\b/i, 'Landsat'],
  [/\bsentinel\b/i, 'Sentinel'],
  [/\bnancy\s+grace\s+roman\b|\broman\s+telescope\b/i, 'Nancy Grace Roman'],
  [/\bsmap\b/i, 'SMAP'],
  [/\bgrace[\s-]?fo\b/i, 'GRACE-FO'],
  [/\bnisar\b/i, 'NISAR'],
  [/\bswot\b/i, 'SWOT'],
  [/\btempo\b/i, 'TEMPO'],
  [/\bpace\b/i, 'PACE'],
  [/\bemit\b/i, 'EMIT'],
  [/\bastrobiology\b/i, 'Astrobiology'],
];

// --- Story-type classification (shared with NASA) -------------------------
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

// --- Helpers ---------------------------------------------------------------

function fail(message, { exitCode = 1, detail } = {}) {
  console.error(`\n[fetch-jpl-news] ERROR: ${message}`);
  if (detail) console.error(`  Detail: ${detail}`);
  console.error(`  Endpoint: ${FEED_URL}`);
  process.exit(exitCode);
}

function decodeEntities(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function stripHtml(html) {
  if (html == null) return '';
  let s = String(html);
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

function parsePubDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function textOf(node) {
  if (node == null) return null;
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (typeof node === 'boolean') return String(node);
  if (typeof node === 'object') {
    if (typeof node['#text'] === 'string') return node['#text'];
    if (typeof node['#text'] === 'number') return String(node['#text']);
    if (typeof node['#cdata'] === 'string') return node['#cdata'];
  }
  return null;
}

function arrayOf(node) {
  if (node == null) return [];
  if (Array.isArray(node)) return node;
  return [node];
}

function extractMission(title, description) {
  const haystack = `${title || ''}\n${description || ''}`;
  for (const [pattern, name] of MISSION_PATTERNS) {
    if (pattern.test(haystack)) return name;
  }
  return null;
}

/**
 * Classify a JPL item into a canonical storyType. Same logic as the
 * NASA fetcher's classifier (duplicated for independence).
 */
function classifyStoryType(title, description, sourceName) {
  if (sourceName === 'NOAA-SWPC') return STORY_TYPES.SPACE_WEATHER;

  const titleStr = String(title || '');
  const descStr = String(description || '');
  const combined = `${titleStr}\n${descStr}`;

  if (/^apod[:\s]/i.test(titleStr) || /astronomy\s+picture\s+of\s+the\s+day/i.test(titleStr)) {
    return STORY_TYPES.EVERGREEN;
  }
  if (
    /\bmedia\s+advisory\b/i.test(titleStr) ||
    /\bmedia\s+teleconference\b/i.test(titleStr) ||
    /\bmedia\s+call\b/i.test(titleStr) ||
    /\bto\s+provide\s+update\b/i.test(titleStr) ||
    /\bwill\s+provide\s+update\b/i.test(titleStr) ||
    /\bpress\s+brief(?:ing)?\b/i.test(titleStr) ||
    /\bpreviews?\b/i.test(titleStr) ||
    /\bbriefing\b/i.test(titleStr)
  ) {
    return STORY_TYPES.MEDIA_ADVISORY;
  }
  if (
    /\bartemis\s+accords\b/i.test(titleStr) ||
    /\bsigning\b/i.test(titleStr) ||
    /\bsigns?\s+(?:the\s+)?(?:artemis|agreement|accord)/i.test(titleStr) ||
    /\bagreement\b/i.test(titleStr) ||
    /\baccord\b/i.test(titleStr) ||
    /\bmemorandum\s+of\s+understanding\b/i.test(titleStr)
  ) {
    return STORY_TYPES.SPACE_POLICY;
  }
  if (
    /\bchallenges?\b/i.test(titleStr) ||
    /\bcontests?\b/i.test(titleStr) ||
    /\bstudents?\b/i.test(titleStr) ||
    /\beducation\b/i.test(titleStr) ||
    /\bSTEM\b/i.test(titleStr) ||
    /\binternship\b/i.test(titleStr) ||
    /\bfellowship\b/i.test(titleStr) ||
    /\bmiddle\s+school\b/i.test(titleStr) ||
    /\bhigh\s+school\b/i.test(titleStr) ||
    /\buniversity\b/i.test(titleStr)
  ) {
    return STORY_TYPES.EDUCATION;
  }
  if (
    /\bappoint/i.test(titleStr) ||
    /\bnamed\s+as\b/i.test(titleStr) ||
    /\bnominat/i.test(titleStr) ||
    /\badministrator\b/i.test(titleStr) ||
    /\bbudget\b/i.test(titleStr) ||
    /\bfunding\b/i.test(titleStr) ||
    /\bstatement\b/i.test(titleStr) ||
    /\bpress\s+secretary\b/i.test(titleStr)
  ) {
    return STORY_TYPES.ADMINISTRATIVE;
  }
  if (
    /\blaunch(?:ed|ing|es)?\b/i.test(combined) ||
    /\blift[\s-]?off\b/i.test(combined) ||
    /\bcountdown\b/i.test(combined) ||
    /\brolled?\s+out\b/i.test(combined) ||
    /\bprelaunch\b/i.test(combined) ||
    /\bpre-launch\b/i.test(combined)
  ) {
    return STORY_TYPES.LAUNCH;
  }
  if (
    /\bsplash[\s-]?down\b/i.test(combined) ||
    /\btouchdown\b/i.test(combined) ||
    /\breturn(?:s|ed|ing)?\s+(?:to\s+earth|home)\b/i.test(combined) ||
    /\blanding\b/i.test(combined) ||
    /\blanded\b/i.test(combined)
  ) {
    return STORY_TYPES.LANDING;
  }
  if (
    /\barrival\b/i.test(combined) ||
    /\bflyby\b/i.test(combined) ||
    /\bfly-by\b/i.test(combined) ||
    /\bsample\s+return\b/i.test(combined) ||
    /\bsample-return\b/i.test(combined) ||
    /\bfirst\s+image\b/i.test(combined) ||
    /\bfirst\s+light\b/i.test(combined) ||
    /\bfirst\s+observation\b/i.test(combined) ||
    /\bdocking\b/i.test(combined) ||
    /\bundocking\b/i.test(combined) ||
    /\bspacewalk\b/i.test(combined) ||
    /\bEVA\b/i.test(combined) ||
    /\brendezvous\b/i.test(combined) ||
    /\bmilestone\b/i.test(combined)
  ) {
    return STORY_TYPES.MISSION_MILESTONE;
  }
  if (
    /\bdiscover(?:y|ed|ies)\b/i.test(combined) ||
    /\bfinding(?:s)?\b/i.test(combined) ||
    /\bresult(?:s)?\b/i.test(combined) ||
    /\bdetected\b/i.test(combined) ||
    /\bconfirmed\b/i.test(combined) ||
    /\bnew\s+image\b/i.test(combined) ||
    /\bcaptures?\b/i.test(combined) ||
    /\bspots\b/i.test(combined)
  ) {
    return STORY_TYPES.DISCOVERY;
  }
  if (
    /\bastronaut\b/i.test(combined) ||
    /\bcosmonaut\b/i.test(combined) ||
    /\bcrew\b/i.test(combined) ||
    /\bISS\b/i.test(combined) ||
    /\binternational\s+space\s+station\b/i.test(combined)
  ) {
    return STORY_TYPES.CREW_MISSION;
  }
  if (
    /\bearth\s+(?:science|observation|monitoring|from\s+space)\b/i.test(combined) ||
    /\bclimate\b/i.test(combined) ||
    /\bsea\s+level\b/i.test(combined) ||
    /\bgreenland\b/i.test(combined) ||
    /\bantarctic/i.test(combined) ||
    /\bglacier\b/i.test(combined) ||
    /\bwildfire/i.test(combined) ||
    /\bhurricane\b/i.test(combined) ||
    /\bstorm\b/i.test(combined) ||
    /\bdisaster\s+response\b/i.test(combined) ||
    /\bNISAR\b/i.test(combined) ||
    /\bPace\b/i.test(combined) ||
    /\bTEMPO\b/i.test(combined) ||
    /\bEMIT\b/i.test(combined) ||
    /\bLandsat\b/i.test(combined)
  ) {
    return STORY_TYPES.EARTH_SCIENCE;
  }
  if (
    /\bexoplanet\b/i.test(combined) ||
    /\bgalaxy\b/i.test(combined) ||
    /\bnebula\b/i.test(combined) ||
    /\bblack\s+hole\b/i.test(combined) ||
    /\bstar\s+(?:cluster|formation)\b/i.test(combined) ||
    /\bquasar\b/i.test(combined) ||
    /\bsupernova\b/i.test(combined) ||
    /\bdark\s+(?:matter|energy)\b/i.test(combined) ||
    /\bcomet\b/i.test(combined) ||
    /\basteroid\b/i.test(combined) ||
    /\btelescope\b/i.test(combined) ||
    /\bWebb\b/i.test(combined) ||
    /\bHubble\b/i.test(combined) ||
    /\bChandra\b/i.test(combined)
  ) {
    return STORY_TYPES.ASTRONOMY;
  }
  if (
    /\btechnology\b/i.test(combined) ||
    /\btech\b/i.test(combined) ||
    /\bdemonstrat/i.test(combined) ||
    /\bprototype\b/i.test(combined) ||
    /\binnovat/i.test(combined) ||
    /\bengineer/i.test(combined) ||
    /\b3d[\s-]?print/i.test(combined) ||
    /\bpropuls/i.test(combined) ||
    /\bsoftware\b/i.test(combined) ||
    /\bhardware\b/i.test(combined) ||
    /\binstrument\b/i.test(combined)
  ) {
    return STORY_TYPES.TECHNOLOGY;
  }
  return STORY_TYPES.MISSION_MILESTONE;
}

// --- Image provenance ------------------------------------------------------

/**
 * For JPL, the MediaRSS <media:content> element carries structured
 * credit/title/text children. We extract these directly without HTML
 * scraping. Returns { imageUrl, imageCredit, imageCaption, imageAlt,
 * rightsText, rightsStatus }.
 */
function extractMediaProvenance(item, sourceName) {
  const out = {
    imageUrl: null,
    imageCredit: null,
    imageCaption: null,
    imageAlt: null,
    rightsText: null,
    rightsStatus: 'unclear',
  };

  const mediaContents = arrayOf(item['media:content']);
  // Pick the first media:content with an image URL (or any URL).
  let chosen = null;
  for (const mc of mediaContents) {
    const url = mc && mc['@_url'];
    if (typeof url === 'string' && url) {
      chosen = mc;
      out.imageUrl = url;
      break;
    }
  }
  // media:thumbnail fallback.
  if (!chosen) {
    for (const mt of arrayOf(item['media:thumbnail'])) {
      const url = mt && mt['@_url'];
      if (typeof url === 'string' && url) {
        chosen = mt;
        out.imageUrl = url;
        break;
      }
    }
  }
  if (!chosen) return out;

  // <media:credit> — the credit text (e.g. "NASA's Scientific
  // Visualization Studio", "NASA", "ESA/Hubble & NASA, D. Thilker").
  const creditNode = chosen['media:credit'];
  const creditText = textOf(creditNode);
  if (creditText && creditText.trim()) {
    out.imageCredit = decodeEntities(creditText).trim().slice(0, 200);
  }

  // <media:text> — a caption / description of the image.
  const textNode = chosen['media:text'];
  const textContent = textOf(textNode);
  if (textContent && textContent.trim()) {
    out.imageCaption = decodeEntities(textContent).trim().slice(0, 400);
  }

  // <media:title> — a short title for the image; use as alt text.
  const titleNode = chosen['media:title'];
  const titleContent = textOf(titleNode);
  if (titleContent && titleContent.trim()) {
    out.imageAlt = decodeEntities(titleContent).trim().slice(0, 200);
  }

  out.rightsText = out.imageCredit || out.imageCaption || null;
  out.rightsStatus = deriveRightsStatus(out.imageCredit, out.imageUrl, sourceName);
  return out;
}

function isExternalImageDomain(imageUrl, sourceName) {
  if (!imageUrl) return false;
  let host;
  try {
    host = new URL(imageUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (sourceName === 'NASA') return !host.endsWith('nasa.gov');
  if (sourceName === 'JPL') return !host.endsWith('nasa.gov');
  if (sourceName === 'NOAA-SWPC') return !host.endsWith('noaa.gov');
  return false;
}

function deriveRightsStatus(creditText, imageUrl, sourceName) {
  const hasCredit = typeof creditText === 'string' && creditText.trim().length > 0;
  if (hasCredit && /\bNASA\b|\bNASA\/JPL\b|\bNOAA\b/i.test(creditText)) {
    return 'verified-agency';
  }
  if (hasCredit) {
    return 'verified-third-party';
  }
  if (isExternalImageDomain(imageUrl, sourceName)) {
    return 'unverified';
  }
  return 'unclear';
}

// --- XML pre-processing ---------------------------------------------------

/**
 * Fix the malformed `<content:encoded<![CDATA[ ... ]]>/></media:content>`
 * pattern that the JPL feed emits. The opening tag is missing a `>`
 * (turning `<content:encoded>` into `<content:encoded<!`) and the
 * closing uses `/>` instead of `</content:encoded>`.
 *
 * Without this fix, fast-xml-parser misinterprets the structure: the
 * `<p>` tags inside the CDATA are surfaced as siblings of the item's
 * other child elements, and the `<media:content>` element is treated
 * as nested inside `<content:encoded>`.
 *
 * The fix rewrites the malformed pattern to a well-formed
 * `<content:encoded><![CDATA[ ... ]]></content:encoded>` block before
 * the parser runs.
 */
function preprocessJplXml(xml) {
  if (!xml || typeof xml !== 'string') return xml;
  // The pattern is non-greedy on the CDATA body so we don't accidentally
  // swallow multiple items in one match.
  return xml.replace(
    /<content:encoded<!\[CDATA\[([\s\S]*?)\]\]>\/>/g,
    '<content:encoded><![CDATA[$1]]></content:encoded>',
  );
}

// --- Normalization ---------------------------------------------------------

function normalizeItem(item) {
  const titleRaw = textOf(item.title) || '';
  const title = decodeEntities(titleRaw).trim();

  const link = (textOf(item.link) || '').trim() || null;
  const guid = (textOf(item.guid) || '').trim() || null;
  const pubDateRaw = textOf(item.pubDate);
  const publishedAtSource = parsePubDate(pubDateRaw);

  const descriptionRaw = textOf(item.description) || '';
  const contentEncodedRaw = textOf(item['content:encoded']) || '';

  // JPL's <description> is plain text (no HTML). Use it directly as
  // the description preview; fall back to content:encoded.
  let descriptionFull = stripHtml(descriptionRaw);
  if (!descriptionFull && contentEncodedRaw) {
    descriptionFull = stripHtml(contentEncodedRaw);
  }
  const description = descriptionFull.slice(0, 300);

  // Image provenance — JPL uses MediaRSS <media:content> at the item
  // level, so we extract credit/caption/alt directly from the
  // structured children (no HTML scraping needed).
  const prov = extractMediaProvenance(item, SOURCE_NAME);

  const mission = extractMission(title, descriptionFull);
  const storyType = classifyStoryType(title, descriptionFull, SOURCE_NAME);

  const keyInput = guid || link || title;
  const scienceKey =
    keyInput != null && keyInput !== ''
      ? `jpl__${createHash('sha256').update(keyInput, 'utf8').digest('hex').slice(0, 16)}`
      : null;

  const categories = arrayOf(item.category)
    .map((c) => textOf(c))
    .filter((c) => typeof c === 'string' && c.trim() !== '')
    .map((c) => c.trim());

  return {
    source: SOURCE_NAME,
    sourceType: SOURCE_TYPE,
    sourceId: guid || link,
    scienceKey,
    storyType,
    title: title || null,
    description: description || null,
    publishedAtSource,
    updatedAtSource: null,
    sourceUrl: link,
    categories,
    mission,
    imageUrl: prov.imageUrl,
    imageAlt: prov.imageAlt || title || null,
    imageCredit: prov.imageCredit,
    imageCaption: prov.imageCaption,
    imageSourceUrl: link,
    rightsText: prov.rightsText,
    rightsStatus: prov.rightsStatus,
    rawSourceData: {
      title: titleRaw,
      link,
      guid,
      pubDate: pubDateRaw || null,
      description: descriptionRaw,
      contentEncoded: contentEncodedRaw,
      categories,
    },
  };
}

// --- Fetch -----------------------------------------------------------------

async function tryFetch(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response;
  try {
    console.log(`  GET ${url}`);
    response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: ACCEPT,
        'User-Agent': USER_AGENT,
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate',
      },
      signal: controller.signal,
      redirect: 'follow',
    });
  } catch (err) {
    clearTimeout(timer);
    if (err && err.name === 'AbortError') {
      return { ok: false, status: 0, error: `timeout after ${FETCH_TIMEOUT_MS}ms` };
    }
    return { ok: false, status: 0, error: `network failure: ${String(err)}` };
  }
  clearTimeout(timer);

  if (!response.ok) {
    return { ok: false, status: response.status, error: `HTTP ${response.status} ${response.statusText}` };
  }

  let text;
  try {
    text = await response.text();
  } catch (err) {
    return { ok: false, status: response.status, error: `body read failure: ${String(err)}` };
  }

  if (!text || text.length === 0) {
    return { ok: false, status: response.status, error: 'empty body' };
  }

  return { ok: true, status: response.status, body: text, error: null };
}

// --- Main ------------------------------------------------------------------

async function main() {
  console.log('[fetch-jpl-news] Starting one-shot fetch from JPL RSS feed.');
  console.log(`  Endpoint:   ${FEED_URL}`);
  console.log(`  User-Agent: ${USER_AGENT.slice(0, 60)}...`);

  const now = new Date();

  // Step 1 — fetch the feed.
  const fetchResult = await tryFetch(FEED_URL);

  // If the fetch failed, write an empty result with sourceAvailable=false
  // so downstream pipelines know the fetch failed (vs. a successful
  // empty feed). We do NOT exit 1 — a missing JPL feed is an expected
  // condition (JPL's bot mitigation may resume at any time) and the
  // rest of Phase 9A is designed to handle an empty JPL file.
  if (!fetchResult.ok) {
    console.warn(`  [warn] JPL feed fetch failed: ${fetchResult.error}`);

    const document = {
      fetchedAt: now.toISOString(),
      source: SOURCE_NAME,
      sourceUrl: FEED_URL,
      sourceAvailable: false,
      httpStatus: fetchResult.status,
      fetchError: fetchResult.error,
      recordCount: 0,
      channelTitle: null,
      feedFormat: 'RSS 2.0',
      totalItems: 0,
      apodCount: 0,
      withImageCount: 0,
      withMissionCount: 0,
      parseErrors: [],
      records: [],
    };

    await mkdir(dirname(OUTPUT_FILE), { recursive: true });
    const tmpFile = `${OUTPUT_FILE}.tmp`;
    await writeFile(tmpFile, JSON.stringify(document, null, 2) + '\n', 'utf8');
    await rename(tmpFile, OUTPUT_FILE);

    const stats = await stat(OUTPUT_FILE);
    console.log('\n[fetch-jpl-news] PARTIAL SUCCESS (feed unavailable)');
    console.log(`  sourceAvailable:     false`);
    console.log(`  httpStatus:          ${fetchResult.status}`);
    console.log(`  fetchError:          ${fetchResult.error}`);
    console.log(`  Output file:         ${OUTPUT_FILE}`);
    console.log(`  File size:           ${stats.size.toLocaleString()} bytes`);
    console.log('');
    return;
  }

  // Step 2 — pre-process the XML to fix the malformed content:encoded
  // tags that the JPL feed emits.
  let xml = fetchResult.body;
  console.log(`  Feed size:  ${xml.length.toLocaleString()} bytes`);
  console.log(`  HTTP:       ${fetchResult.status}`);
  xml = preprocessJplXml(xml);

  // Step 3 — parse the XML.
  let parsed;
  try {
    parsed = parser.parse(xml);
  } catch (err) {
    const document = {
      fetchedAt: now.toISOString(),
      source: SOURCE_NAME,
      sourceUrl: FEED_URL,
      sourceAvailable: false,
      httpStatus: fetchResult.status,
      fetchError: `XML parse failure: ${String(err)}`,
      recordCount: 0,
      channelTitle: null,
      feedFormat: 'RSS 2.0',
      totalItems: 0,
      apodCount: 0,
      withImageCount: 0,
      withMissionCount: 0,
      parseErrors: [{ error: String(err) }],
      records: [],
    };
    await mkdir(dirname(OUTPUT_FILE), { recursive: true });
    const tmpFile = `${OUTPUT_FILE}.tmp`;
    await writeFile(tmpFile, JSON.stringify(document, null, 2) + '\n', 'utf8');
    await rename(tmpFile, OUTPUT_FILE);
    return fail('JPL feed XML parse failed.', { detail: String(err) });
  }

  // Step 4 — locate the channel and items.
  const channel = parsed?.rss?.channel;
  const channelTitle = channel && typeof channel.title === 'string' ? channel.title : null;
  const rawItems = channel ? arrayOf(channel.item) : [];
  console.log(`  Items:      ${rawItems.length}`);

  // Step 5 — normalize each item.
  const records = [];
  const errors = [];
  for (const item of rawItems) {
    try {
      const record = normalizeItem(item);
      if (!record.scienceKey) {
        errors.push({ guid: record.sourceId, error: 'missing scienceKey' });
        continue;
      }
      records.push(record);
    } catch (err) {
      errors.push({ error: String(err) });
    }
  }

  const withImage = records.filter((r) => r.imageUrl).length;
  const withMission = records.filter((r) => r.mission).length;

  const document = {
    fetchedAt: now.toISOString(),
    source: SOURCE_NAME,
    sourceUrl: FEED_URL,
    sourceAvailable: true,
    httpStatus: fetchResult.status,
    fetchError: null,
    recordCount: records.length,
    channelTitle,
    feedFormat: 'RSS 2.0',
    totalItems: records.length,
    apodCount: 0,
    withImageCount: withImage,
    withMissionCount: withMission,
    parseErrors: errors,
    records,
  };

  await mkdir(dirname(OUTPUT_FILE), { recursive: true });
  const tmpFile = `${OUTPUT_FILE}.tmp`;
  await writeFile(tmpFile, JSON.stringify(document, null, 2) + '\n', 'utf8');
  await rename(tmpFile, OUTPUT_FILE);

  const stats = await stat(OUTPUT_FILE);
  console.log('\n[fetch-jpl-news] SUCCESS');
  console.log(`  sourceAvailable:     true`);
  console.log(`  httpStatus:          ${fetchResult.status}`);
  console.log(`  Total items:         ${records.length}`);
  console.log(`  Items with image:    ${withImage}`);
  console.log(`  Items with mission:  ${withMission}`);
  if (errors.length) {
    console.log(`  Parse errors:        ${errors.length}`);
    for (const e of errors.slice(0, 5)) console.log(`    - ${JSON.stringify(e)}`);
  }
  console.log(`  Output file:         ${OUTPUT_FILE}`);
  console.log(`  File size:           ${stats.size.toLocaleString()} bytes`);
  console.log(`  Fetched at (UTC):    ${document.fetchedAt}`);

  console.log('\n  Sample items:');
  records.slice(0, 5).forEach((r, i) => {
    const titlePreview = (r.title || '(no title)').slice(0, 70);
    console.log(`    ${i + 1}. [${r.sourceType}/${r.storyType}] ${titlePreview}`);
    console.log(
      `        mission=${r.mission || '-'} image=${r.imageUrl ? 'yes' : 'no'} rights=${r.rightsStatus} credit=${r.imageCredit || '-'} key=${r.scienceKey}`,
    );
  });
  console.log('');
}

main().catch((err) => {
  fail('Unexpected failure.', { detail: String(err && err.stack ? err.stack : err) });
});
