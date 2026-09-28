/**
 * US News Engine — NASA news-release fetcher (Phase 9A.1 hardened).
 *
 * Fetches NASA news releases from the official NASA RSS feed:
 *   https://www.nasa.gov/news-release/feed/
 *
 * Phase 9A.1 changes from Phase 9A:
 *   - Replaces regex-based RSS parsing with the `fast-xml-parser` library
 *     (already installed). The XMLParser config matches the project's
 *     shared Science pipeline config.
 *   - Adds provenance metadata fields to the output document:
 *       sourceAvailable, fetchedAt, recordCount, fetchError, httpStatus.
 *   - Hardens image provenance: the hero image's credit, caption, and
 *     rights status are extracted from the `<content:encoded>` HTML
 *     (NASA's hds-credits div, figcaption, APOD-style th/td credit
 *     rows, or general "Credit:" / "Courtesy of" patterns). The
 *     `imageCredit` is the EXACT extracted credit text — never a
 *     hardcoded "NASA". `rightsStatus` is one of:
 *       "verified-agency"        — explicit credit mentions NASA/JPL/NOAA
 *       "verified-third-party"  — explicit non-agency credit text
 *       "unclear"               — no credit text found
 *       "unverified"            — image hosted on a non-agency domain
 *   - Adds a `storyType` field to each record, classifying each item
 *     deterministically as one of:
 *       mission-milestone, launch, landing, discovery, astronomy,
 *       earth-science, technology, crew-mission, space-weather,
 *       space-policy, administrative, education, media-advisory,
 *       evergreen.
 *
 * This script makes exactly ONE HTTP request to the source feed, writes
 * the normalized records to data/science/nasa-news.json atomically, and
 * prints a brief summary. It does NOT publish anything to the website
 * and does NOT use AI.
 *
 * Run manually:
 *   npm run fetch:nasa
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
const FEED_URL = 'https://www.nasa.gov/news-release/feed/';
const OUTPUT_FILE = join(PROJECT_DIR, 'data', 'science', 'nasa-news.json');
const SOURCE_NAME = 'NASA';
const SOURCE_TYPE = 'news-release';

const USER_AGENT = 'USNewsEngine/1.0 (https://usa-news-engine.forexwizardy.workers.dev)';
const ACCEPT = 'application/rss+xml, application/xml, text/xml; q=0.9, */*; q=0.5';
const FETCH_TIMEOUT_MS = 45_000;

// The XMLParser config matches the shared Science pipeline config used
// across all Phase 9A.1 fetchers. `parseAttributeValue: true` causes
// "false"/"true" attribute values to be converted to booleans, and
// numeric strings to numbers; `parseTagValue: false` keeps tag text as
// strings (we don't want "1234" to become the number 1234 in a guid).
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: true,
  parseTagValue: false,
  trimValues: true,
});

// --- Mission keyword table -------------------------------------------------
// Each entry: [pattern, canonical mission name]. Patterns are matched
// case-insensitively as word boundaries against the title + description.
// Longest/most specific patterns are checked first to avoid mismatching
// (e.g. "James Webb" before "Webb"). The first match wins per item.
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
  [/\bgoes\b/i, 'GOES'],
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

// --- Story-type classification --------------------------------------------
// Each item is classified into one of the canonical story types below.
// The order matters: more specific types are checked first (e.g.
// media-advisory before mission-milestone so "NASA, Boeing to Provide
// Update" is classified as media-advisory even though it mentions
// Starliner). When nothing matches, the default is mission-milestone
// for NASA/JPL items (the catch-all for routine mission updates).
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
  console.error(`\n[fetch-nasa-news] ERROR: ${message}`);
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

/**
 * Coerce a parsed XML node into a plain string value. fast-xml-parser
 * produces:
 *   - string for plain-text tags without attributes
 *   - { '#text': string, '@_attr': ... } for tags with attributes AND text
 *   - number when parseTagValue would have converted (we disabled that)
 *   - array when multiple sibling tags share a name
 * This helper unwraps any of those into a string (or null).
 */
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

/**
 * Coerce a possibly-array node into an array of values. Used for
 * <category> which appears once per category in the RSS spec.
 */
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
 * Classify a NASA/JPL item into a canonical storyType using keyword
 * matching on title + description. The order matters — more specific
 * types are checked first.
 */
function classifyStoryType(title, description, sourceName) {
  // SWPC records are always space-weather (handled by the SWPC fetcher).
  if (sourceName === 'NOAA-SWPC') return STORY_TYPES.SPACE_WEATHER;

  const titleStr = String(title || '');
  const descStr = String(description || '');
  const combined = `${titleStr}\n${descStr}`;
  const titleLower = titleStr.toLowerCase();
  const combinedLower = combined.toLowerCase();

  // 1. APOD / evergreen — title starts with "APOD:" or contains
  //    "Astronomy Picture of the Day".
  if (/^apod[:\s]/i.test(titleStr) || /astronomy\s+picture\s+of\s+the\s+day/i.test(titleStr)) {
    return STORY_TYPES.EVERGREEN;
  }

  // 2. Media advisory / press briefing — "media advisory",
  //    "media teleconference", "media call", "to provide update",
  //    "will provide update", "preview", "briefing". This is checked
  //    BEFORE space-policy because press conferences sometimes
  //    announce diplomatic news.
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

  // 3. Space policy / Artemis Accords / diplomatic signing.
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

  // 4. Education — challenges, contests, student programs.
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

  // 5. Administrative — personnel, budgets, statements.
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

  // 6. Launch — spacecraft launch announcements.
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

  // 7. Landing / splashdown.
  if (
    /\bsplash[\s-]?down\b/i.test(combined) ||
    /\btouchdown\b/i.test(combined) ||
    /\breturn(?:s|ed|ing)?\s+(?:to\s+earth|home)\b/i.test(combined) ||
    /\blanding\b/i.test(combined) ||
    /\blanded\b/i.test(combined)
  ) {
    return STORY_TYPES.LANDING;
  }

  // 8. Major mission milestone — arrival, flyby, first image, sample
  //    return, docking. (Distinguished from generic "discovery" because
  //    these mark a specific mission event rather than a science result.)
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

  // 9. Discovery / confirmed scientific finding.
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

  // 10. Crew mission — actual crew assignment/return/ISS event.
  if (
    /\bastronaut\b/i.test(combined) ||
    /\bcosmonaut\b/i.test(combined) ||
    /\bcrew\b/i.test(combined) ||
    /\bISS\b/i.test(combined) ||
    /\binternational\s+space\s+station\b/i.test(combined)
  ) {
    return STORY_TYPES.CREW_MISSION;
  }

  // 11. Earth science finding.
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

  // 12. Astronomy — telescope / planetary science observation.
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

  // 13. Technology demonstration / development.
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

  // 14. Default catch-all for NASA/JPL releases: mission-milestone.
  // (Most NASA news releases describe the status of an active mission
  // without falling into a more specific bucket.)
  return STORY_TYPES.MISSION_MILESTONE;
}

// --- Image provenance extraction ------------------------------------------

/**
 * Decode HTML entities and strip tags from a snippet of HTML, returning
 * a single line of plain text. Used to clean up credit/caption text
 * extracted from `<div class="hds-credits">` and similar containers.
 */
function htmlToText(html) {
  if (html == null) return '';
  let s = String(html);
  // Convert <br> and block-level closers to spaces so words don't run
  // together when we strip the tags.
  s = s.replace(/<\/(p|div|li|h[1-6]|figcaption|figure|td|tr|th|br)\s*>/gi, ' ');
  s = s.replace(/<br\s*\/?>/gi, ' ');
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/**
 * Extract the URL of the first <img src="..."> element from an HTML
 * string. Skips data: URLs, 1x1 spacer GIFs, and SVG placeholders.
 */
function extractFirstImgUrl(html) {
  if (!html || typeof html !== 'string') return null;
  const imgRe = /<img\b[^>]*>/gi;
  let m;
  while ((m = imgRe.exec(html)) !== null) {
    const tag = m[0];
    const srcMatch = tag.match(/\bsrc=["']([^"']+)["']/i);
    if (!srcMatch) continue;
    const url = srcMatch[1];
    if (/^data:/i.test(url)) continue;
    if (/\/spacer\.gif$/i.test(url)) continue;
    if (/1x1\.(gif|png|jpe?g)$/i.test(url)) continue;
    return { url, tag, index: m.index };
  }
  return null;
}

/**
 * Determine whether an image URL is hosted on an "external" (non-agency)
 * domain. For NASA records, agency domains are nasa.gov (including
 * subdomains like assets.science.nasa.gov and www.nasa.gov). For JPL,
 * the agency domains are jpl.nasa.gov and nasa.gov.
 */
function isExternalImageDomain(imageUrl, sourceName) {
  if (!imageUrl) return false;
  let host;
  try {
    host = new URL(imageUrl).hostname.toLowerCase();
  } catch {
    // Relative URL — assume agency-hosted (NASA RSS image URLs are
    // always absolute, so this branch is unlikely to fire).
    return false;
  }
  if (sourceName === 'NASA') {
    return !host.endsWith('nasa.gov');
  }
  if (sourceName === 'JPL') {
    return !host.endsWith('nasa.gov');
  }
  if (sourceName === 'NOAA-SWPC') {
    return !host.endsWith('noaa.gov');
  }
  return false;
}

/**
 * Strip a leading "Credit:" / "Credits:" / "Image credit:" / "Photo
 * credit:" / "Courtesy of:" prefix from an extracted credit string.
 * The prefix is informational (it labels the row in the HTML) but is
 * not part of the actual credit text we want to publish.
 */
function stripCreditPrefix(text) {
  if (!text) return text;
  return text
    .replace(/^\s*(?:Image\s+credit|Credits?|Photo\s+credits?|Courtesy\s+of|Image\s+by)\s*[:\u2013\u2014-]?\s*/i, '')
    .trim();
}

/**
 * Look for a credit/caption pattern in the HTML near the first image.
 * Returns { credit, caption, rightsText } where any field may be null.
 *
 * Strategy (first match wins):
 *   1. NASA's hds-credits div: <div class="hds-credits">CREDIT</div>
 *      (sometimes nested inside <figcaption>).
 *   2. NASA's hds-caption-text div: <div class="hds-caption-text">CAP</div>
 *   3. APOD-style table row: <th>Credit & Copyright:</th><td>...</td>
 *   4. Generic "Credit:" / "Credits:" / "Image credit:" / "Courtesy of"
 *      patterns in nearby text.
 *   5. figcaption (when present and not already captured by 1/2).
 */
function extractImageProvenance(html, sourceName) {
  const out = { credit: null, caption: null, rightsText: null };
  if (!html || typeof html !== 'string') return out;

  // 1. hds-credits div (NASA standard)
  const creditDivRe = /<div[^>]*class="[^"]*hds-credits[^"]*"[^>]*>([\s\S]*?)<\/div>/i;
  const cm = html.match(creditDivRe);
  if (cm) {
    out.credit = stripCreditPrefix(htmlToText(cm[1]).slice(0, 200));
  }

  // 2. hds-caption-text div (NASA standard caption)
  const capDivRe = /<div[^>]*class="[^"]*hds-caption-text[^"]*"[^>]*>([\s\S]*?)<\/div>/i;
  const cpm = html.match(capDivRe);
  if (cpm) {
    out.caption = htmlToText(cpm[1]).slice(0, 400);
  }

  // 3. APOD-style th/td: <th...>Credit & Copyright:</th><td...>...</td>
  //    The th text often contains HTML entities for & (&#038; or &amp;),
  //    so we match "Credit" followed by any non-`<` characters rather
  //    than a specific entity form.
  if (!out.credit) {
    const apodCreditRe = /<th[^>]*>\s*Credit[^<]*<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/i;
    const am = html.match(apodCreditRe);
    if (am) {
      out.credit = stripCreditPrefix(htmlToText(am[1]).slice(0, 200));
    }
  }
  if (!out.caption) {
    const apodExpRe = /<th[^>]*>\s*Explanation[^<]*<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/i;
    const em = html.match(apodExpRe);
    if (em) {
      out.caption = htmlToText(em[1]).slice(0, 400);
    }
  }

  // 4. Generic "Credit:" / "Credits:" / "Image credit:" / "Courtesy of"
  //    patterns in the surrounding text. We look at the first ~2000
  //    chars of the document after the first image to find a credit
  //    line that hasn't already been captured by 1/3.
  if (!out.credit) {
    const firstImg = extractFirstImgUrl(html);
    const startIdx = firstImg ? firstImg.index : 0;
    const window = html.slice(startIdx, startIdx + 2500);
    const windowText = htmlToText(window);
    const genericPatterns = [
      /\b(?:Image\s+credit|Credits?|Photo\s+credits?)\s*[:\u2013\u2014-]?\s*([^\n.]{2,150})/i,
      /\b(?:Courtesy\s+of)\s+([^\n.]{2,150})/i,
      /\b(?:Image\s+by)\s+([^\n.]{2,150})/i,
    ];
    for (const pat of genericPatterns) {
      const gm = windowText.match(pat);
      if (gm) {
        out.credit = gm[1].trim().slice(0, 200);
        break;
      }
    }
  }

  // 5. figcaption fallback (when not captured by 1/2)
  if (!out.caption) {
    const figcapRe = /<figcaption[^>]*>([\s\S]*?)<\/figcaption>/i;
    const fm = html.match(figcapRe);
    if (fm) {
      // If the figcaption contains a credits div, strip it out so the
      // caption text doesn't include the credit.
      let inner = fm[1];
      inner = inner.replace(/<div[^>]*class="[^"]*hds-credits[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '');
      out.caption = htmlToText(inner).slice(0, 400) || null;
    }
  }

  // 6. If we still don't have a caption, try the alt text of the first
  //    image as a fallback (this is sometimes the only descriptive text
  //    available for APOD items).
  if (!out.caption) {
    const firstImg = extractFirstImgUrl(html);
    if (firstImg) {
      const altMatch = firstImg.tag.match(/\balt=["']([^"']*)["']/i);
      if (altMatch && altMatch[1].trim()) {
        out.caption = altMatch[1].trim().slice(0, 400);
      }
    }
  }

  // rightsText is the raw credit-or-caption text used for downstream
  // rights assertions.
  out.rightsText = out.credit || out.caption || null;

  return out;
}

/**
 * Determine the rightsStatus for an image given the extracted credit
 * text and the source name.
 *
 *   "verified-agency"        — credit mentions NASA / NASA/JPL / NOAA
 *   "verified-third-party"  — credit text present but no agency mention
 *   "unclear"               — no credit text found at all
 *   "unverified"            — image hosted on a non-agency domain
 *
 * The "unverified" status overrides "unclear" (an external-domain image
 * with no credit is unverified, not unclear) but is overridden by an
 * explicit agency credit ("verified-agency" wins over domain checks
 * because the credit text is the authoritative source).
 */
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

// --- Normalization ---------------------------------------------------------

/**
 * Normalize one parsed RSS <item> object into the science schema with
 * image-provenance hardening and storyType classification.
 */
function normalizeItem(item) {
  const titleRaw = textOf(item.title) || '';
  const title = decodeEntities(titleRaw).trim();

  const link = (textOf(item.link) || '').trim() || null;

  // guid may be { '#text': '...', '@_isPermaLink': true/false } or a
  // plain string.
  const guidNode = item.guid;
  const guid = (textOf(guidNode) || '').trim() || null;

  const pubDateRaw = textOf(item.pubDate);
  const publishedAtSource = parsePubDate(pubDateRaw);

  const descriptionRaw = textOf(item.description) || '';
  const contentEncodedRaw = textOf(item['content:encoded']) || '';

  // Build a description preview. We prefer the text after the APOD
  // navigation header when present (APOD items always start with a
  // "APOD Science APOD ... Astronomy Picture of the Day" boilerplate
  // block). For non-APOD items we just strip HTML from <description>.
  let descriptionFull = stripHtml(descriptionRaw);
  const apodNavEnd = descriptionFull.indexOf('brief explanation written by a professional astronomer.');
  if (apodNavEnd !== -1) {
    descriptionFull = descriptionFull
      .slice(apodNavEnd + 'brief explanation written by a professional astronomer.'.length)
      .trim();
  }
  if (!descriptionFull && contentEncodedRaw) {
    descriptionFull = stripHtml(contentEncodedRaw);
  }
  const description = descriptionFull.slice(0, 300);

  // Image URL — NASA's RSS does not use <media:content> at the item
  // level; images live inside <content:encoded> (and sometimes inside
  // <description>). We look in content:encoded first because that has
  // the highest-resolution source URL and the credit/caption metadata.
  let imageUrl = null;
  let imageHtmlSource = null;
  if (contentEncodedRaw) {
    const found = extractFirstImgUrl(contentEncodedRaw);
    if (found) {
      imageUrl = found.url;
      imageHtmlSource = contentEncodedRaw;
    }
  }
  if (!imageUrl && descriptionRaw) {
    const found = extractFirstImgUrl(descriptionRaw);
    if (found) {
      imageUrl = found.url;
      imageHtmlSource = descriptionRaw;
    }
  }
  // media:content / media:thumbnail fallback (rare for NASA, but
  // defensive).
  if (!imageUrl) {
    const mc = item['media:content'];
    const mcArr = arrayOf(mc);
    for (const node of mcArr) {
      const url = node && node['@_url'];
      if (typeof url === 'string' && url) {
        imageUrl = url;
        break;
      }
    }
  }
  if (!imageUrl) {
    const mt = item['media:thumbnail'];
    const mtArr = arrayOf(mt);
    for (const node of mtArr) {
      const url = node && node['@_url'];
      if (typeof url === 'string' && url) {
        imageUrl = url;
        break;
      }
    }
  }

  // Image provenance — extract credit/caption from the HTML that
  // contained the image (or from content:encoded as a fallback).
  const provenanceHtml = imageHtmlSource || contentEncodedRaw || '';
  const prov = extractImageProvenance(provenanceHtml, SOURCE_NAME);
  const rightsStatus = deriveRightsStatus(prov.credit, imageUrl, SOURCE_NAME);

  // Determine sourceType — APOD items get a separate sourceType so the
  // filter can down-rank them.
  const isApod = /^apod[:\s]/i.test(title) || /^astronomy\s+picture\s+of\s+the\s+day/i.test(title);
  const sourceType = isApod ? 'apod' : SOURCE_TYPE;

  // Mission extraction.
  const mission = extractMission(title, descriptionFull);

  // Story-type classification (Phase 9A.1 new field).
  const storyType = classifyStoryType(title, descriptionFull, SOURCE_NAME);

  // Build the scienceKey deterministically from the guid (or link, as
  // a fallback for items that lack a guid).
  const keyInput = guid || link || title;
  const scienceKey =
    keyInput != null && keyInput !== ''
      ? `nasa__${createHash('sha256').update(keyInput, 'utf8').digest('hex').slice(0, 16)}`
      : null;

  // Categories — the RSS <category> field may be a string or an array.
  const categories = arrayOf(item.category)
    .map((c) => textOf(c))
    .filter((c) => typeof c === 'string' && c.trim() !== '')
    .map((c) => c.trim());

  return {
    source: SOURCE_NAME,
    sourceType,
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
    imageUrl,
    imageAlt: title || null,
    imageCredit: prov.credit,
    imageCaption: prov.caption,
    imageSourceUrl: link,
    rightsText: prov.rightsText,
    rightsStatus,
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

/**
 * Fetch the NASA RSS feed as text. Returns an object with
 * { ok, status, body, error } so the caller can build provenance
 * metadata without re-throwing. Never throws — callers decide what to
 * do with the result.
 */
async function fetchFeed() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response;
  try {
    console.log(`  GET ${FEED_URL}`);
    response = await fetch(FEED_URL, {
      method: 'GET',
      headers: {
        Accept: ACCEPT,
        'User-Agent': USER_AGENT,
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
    let bodySnippet = '';
    try {
      bodySnippet = (await response.text()).slice(0, 300);
    } catch {
      /* ignore */
    }
    return {
      ok: false,
      status: response.status,
      error: `HTTP ${response.status} ${response.statusText}${bodySnippet ? ` — ${bodySnippet}` : ''}`,
    };
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
  console.log('[fetch-nasa-news] Starting one-shot fetch from NASA RSS feed.');
  console.log(`  Endpoint:   ${FEED_URL}`);
  console.log(`  User-Agent: ${USER_AGENT}`);

  const now = new Date();

  // Step 1 — fetch the feed.
  const fetchResult = await fetchFeed();

  // Hard-failure (network error, timeout, missing endpoint): write an
  // empty result with sourceAvailable=false so downstream pipelines
  // know the fetch failed (vs. a successful empty feed).
  if (!fetchResult.ok) {
    console.warn(`  [warn] NASA feed fetch failed: ${fetchResult.error}`);

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
    console.log('\n[fetch-nasa-news] PARTIAL SUCCESS (feed unavailable)');
    console.log(`  sourceAvailable:     false`);
    console.log(`  httpStatus:          ${fetchResult.status}`);
    console.log(`  fetchError:          ${fetchResult.error}`);
    console.log(`  Output file:         ${OUTPUT_FILE}`);
    console.log(`  File size:           ${stats.size.toLocaleString()} bytes`);
    console.log('');
    return;
  }

  const xml = fetchResult.body;
  console.log(`  Feed size:  ${xml.length.toLocaleString()} bytes`);
  console.log(`  HTTP:       ${fetchResult.status}`);

  // Step 2 — parse the XML.
  let parsed;
  try {
    parsed = parser.parse(xml);
  } catch (err) {
    // XML parse failure — treat as a soft failure with sourceAvailable=false.
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
    return fail('NASA feed XML parse failed.', { detail: String(err) });
  }

  // Step 3 — locate the channel and items.
  const channel = parsed?.rss?.channel;
  const channelTitle = channel && typeof channel.title === 'string' ? channel.title : null;
  const rawItems = channel ? arrayOf(channel.item) : [];
  console.log(`  Items:      ${rawItems.length}`);

  if (rawItems.length === 0) {
    console.warn('  [warn] No <item> elements found in the feed.');
  }

  // Step 4 — normalize each item.
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

  // Step 5 — assemble output document with provenance metadata.
  const apodCount = records.filter((r) => r.sourceType === 'apod').length;
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
    apodCount,
    withImageCount: withImage,
    withMissionCount: withMission,
    parseErrors: errors,
    records,
  };

  // Step 6 — write atomically.
  await mkdir(dirname(OUTPUT_FILE), { recursive: true });
  const tmpFile = `${OUTPUT_FILE}.tmp`;
  await writeFile(tmpFile, JSON.stringify(document, null, 2) + '\n', 'utf8');
  await rename(tmpFile, OUTPUT_FILE);

  // Step 7 — report.
  const stats = await stat(OUTPUT_FILE);
  console.log('\n[fetch-nasa-news] SUCCESS');
  console.log(`  sourceAvailable:     true`);
  console.log(`  httpStatus:          ${fetchResult.status}`);
  console.log(`  Total items:         ${records.length}`);
  console.log(`  APOD items:          ${apodCount}`);
  console.log(`  Items with image:    ${withImage}`);
  console.log(`  Items with mission:  ${withMission}`);
  if (errors.length) {
    console.log(`  Parse errors:        ${errors.length}`);
    for (const e of errors.slice(0, 5)) console.log(`    - ${JSON.stringify(e)}`);
  }
  console.log(`  Output file:         ${OUTPUT_FILE}`);
  console.log(`  File size:           ${stats.size.toLocaleString()} bytes`);
  console.log(`  Fetched at (UTC):    ${document.fetchedAt}`);

  // Top items for eyeball verification.
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
