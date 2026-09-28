/**
 * US News Engine — NASA news-release fetcher (Phase 9A).
 *
 * Fetches NASA news releases from the official NASA RSS feed
 *   https://www.nasa.gov/news-release/feed/
 *
 * The feed is XML RSS 2.0. We parse it with regex (no external XML parser
 * dependency is permitted in this project). Each <item> is normalized into
 * the shared science schema used by the rest of Phase 9A:
 *
 *   {
 *     source: "NASA",
 *     sourceType: "news-release",
 *     sourceId: <guid>,
 *     scienceKey: `nasa__<sha256(guid)[0:16]>`,
 *     title, description (HTML-stripped, max 300 chars),
 *     publishedAtSource (ISO), updatedAtSource: null,
 *     sourceUrl: <link>,
 *     categories: [],
 *     mission, topic,
 *     imageUrl, imageAlt, imageCredit: "NASA", imageSourceUrl,
 *     rawSourceData: { ...originalItem }
 *   }
 *
 * Mission extraction is deterministic keyword-based (Artemis, James Webb,
 * Perseverance, etc.). Topic is one of the canonical Phase 9A topics.
 *
 * This script makes exactly ONE request to the source feed, writes the
 * normalized records to data/science/nasa-news.json atomically, and prints
 * a brief summary. It does NOT publish anything to the website and does NOT
 * use AI.
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
  [/\borgel\b/i, 'ORIGINS'],
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
  [/\bspirex\b|\bspire\b/i, 'SPIRE'],
  [/\bswift\b/i, 'Swift'],
  [/\bnu_star\b|\bnustar\b/i, 'NuSTAR'],
  [/\brosky\s+coster\b|\broscosmos\b/i, 'Roscosmos'],
  [/\bspaceliner\b/i, 'SpaceLiner'],
  [/\bblender\b/i, 'BLENDER'],
  [/\bdragon\b/i, 'Dragon'],
  [/\bcygnus\b/i, 'Cygnus'],
  [/\bstarlink\b/i, 'Starlink'],
  [/\blandsat\b/i, 'Landsat'],
  [/\bgoes\b/i, 'GOES'],
  [/\bnoaa[-\s]?20\b/i, 'NOAA-20'],
  [/\bsentinel\b/i, 'Sentinel'],
  [/\bpark\s+solar\b/i, 'Parker Solar Probe'],
  [/\brockets?\b/i, 'Rocket'],
  [/\bnancy\s+grace\s+roman\b|\broman\s+telescope\b/i, 'Nancy Grace Roman'],
  [/\baire\b/i, 'AIRE'],
  [/\bstarlab\b/i, 'Starlab'],
];

// --- Topic keyword table ---------------------------------------------------
// Canonical topics: "mission-update", "discovery", "launch", "landing",
// "crew", "technology", "earth-science", "astronomy", "education",
// "administrative". Patterns are matched in order; the first match wins.
// Items that don't match fall through to "mission-update" as the default
// (the most common case for NASA news releases).
const TOPIC_PATTERNS = [
  // Crew / astronaut
  [/\bastronaut|\bcrew\b|\bnasa\s+personnel\b|\bcosmonaut\b/i, 'crew'],
  // Launch
  [/\blaunch(ed|ing|es)?\b|\blift[\s-]?off\b|\bcountdown\b|\brolled?\s+out\b/i, 'launch'],
  // Landing / splashdown
  [/\bsplash[\s-]?down\b|\bland(ed|ing|s)?\b|\btouchdown\b|\breturn(s|ed|ing)?\s+(to\s+earth|home)\b/i, 'landing'],
  // Discovery / findings / results
  [/\bdiscover(y|ed|ies)\b|\bfinding(s)?\b|\bresult(s)?\b|\bfirst\s+(image|observation|measurement|look|light)\b|\bmilestone\b|\bdetected\b|\bnew\s+image\b|\bcaptures?\b/i, 'discovery'],
  // Earth science
  [/\bearth\s+(science|observation|monitoring|from\s+space)\b|\bclimate\b|\bsea\s+level\b|\bgreenland\b|\bantarctic|\bglacier\b|\bwildfire|\bdisaster\s+response\b|\bhurricane\b|\bstorm\b/i, 'earth-science'],
  // Astronomy (deep-space, multi-mission)
  [/\bexoplanet|\bgalaxy|\bnebula|\bblack\s+hole|\bstar\s+(cluster|formation)|\bquasar|\bsupernova|\bdark\s+(matter|energy)|\bcomet\b|\basteroid\b/i, 'astronomy'],
  // Technology / engineering
  [/\btechnology\b|\btech\b|\bdemonstrat|\bprototype\b|\binnovat|\bengineer|\b3d[\s-]?print|\bpropuls|\bsoftware\b|\bsoftware\b|\bhardware\b|\binstrument\b|\btelescope\s+upgrade\b/i, 'technology'],
  // Education / outreach
  [/\bstudents?\b|\beducation\b|\bSTEM\b|\boutreach\b|\bschool\b|\buniversity\b|\binternship|\bfellowship|\bgrant\b/i, 'education'],
  // Administrative (personnel, budgets, statements)
  [/\bappoint|\bnamed\s+as\b|\bnominat|\badministrator\b|\bbudget\b|\bfunding\b|\bstatement\b|\bpress\s+secretary\b|\bbriefing\b/i, 'administrative'],
];

// --- Helpers ---------------------------------------------------------------

function fail(message, { exitCode = 1, detail } = {}) {
  console.error(`\n[fetch-nasa-news] ERROR: ${message}`);
  if (detail) console.error(`  Detail: ${detail}`);
  console.error(`  Endpoint: ${FEED_URL}`);
  process.exit(exitCode);
}

/**
 * Decode common HTML entities and CDATA sections to plain text.
 * This is intentionally simple — the RSS description is a CDATA-wrapped
 * HTML blob, and we just need a readable plain-text preview.
 */
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

/**
 * Strip HTML tags from a string and collapse whitespace. Used to derive a
 * plain-text description preview from the CDATA-wrapped HTML in the RSS
 * <description> field.
 */
function stripHtml(html) {
  if (html == null) return '';
  let s = String(html);
  // Remove <script> and <style> blocks wholesale.
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  // Drop tags. We do not need to preserve anything inside them.
  s = s.replace(/<[^>]+>/g, ' ');
  // Decode entities (after tag stripping so we don't accidentally decode
  // entities that came from inside a tag attribute).
  s = decodeEntities(s);
  // Collapse whitespace.
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/**
 * Parse an RFC-822 pubDate string (e.g. "Wed, 24 Sep 2025 14:30:00 +0000")
 * into an ISO-8601 string. Returns null when the value is unparseable.
 */
function parsePubDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Extract the URL of the first <media:content url="..."> element from an
 * RSS <item> XML fragment. Returns null when no media:content is present.
 */
function extractMediaContentUrl(itemXml) {
  // media:content may appear as <media:content url="..." medium="image" />
  // or with a namespace prefix variation. We are liberal here.
  const m = itemXml.match(/<media:content\b[^>]*\burl=["']([^"']+)["'][^>]*>/i);
  if (m) return m[1];
  // media:thumbnail fallback (some feeds use this).
  const m2 = itemXml.match(/<media:thumbnail\b[^>]*\burl=["']([^"']+)["'][^>]*>/i);
  if (m2) return m2[1];
  // <enclosure url="..." type="image/*" />
  const m3 = itemXml.match(/<enclosure\b[^>]*\burl=["']([^"']+)["'][^>]*\btype=["']image\/[^"']+["'][^>]*>/i);
  if (m3) return m3[1];
  return null;
}

/**
 * Extract the URL of the first <img src="..."> element from an HTML string
 * (typically the CDATA-wrapped contents of <description> or
 * <content:encoded>). Returns null when no usable image is found.
 *
 * We deliberately skip placeholder/SVG data: URLs and 1x1 spacer GIFs.
 */
function extractFirstImgUrl(html) {
  if (!html || typeof html !== 'string') return null;
  // Match <img ... src="..." ... > — note that attributes can appear in any
  // order, so we look for src= anywhere inside the <img> tag.
  const imgRe = /<img\b[^>]*>/gi;
  let m;
  while ((m = imgRe.exec(html)) !== null) {
    const tag = m[0];
    const srcMatch = tag.match(/\bsrc=["']([^"']+)["']/i);
    if (!srcMatch) continue;
    const url = srcMatch[1];
    // Skip data: URLs (inline SVG/PNG placeholders) and obvious spacers.
    if (/^data:/i.test(url)) continue;
    if (/\/spacer\.gif$/i.test(url)) continue;
    if (/1x1\.(gif|png|jpe?g)$/i.test(url)) continue;
    return url;
  }
  return null;
}

/**
 * Extract the contents of the first <tag>...</tag> element from an XML
 * fragment. Handles CDATA-wrapped content. Returns null when not found.
 * `tag` should be the bare tag name (e.g. "title", "description", "guid").
 */
function extractTag(itemXml, tag) {
  // Allow optional attributes on the opening tag (e.g. <guid isPermaLink="false">).
  // Use [\s\S] for the body so newlines match.
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i');
  const m = itemXml.match(re);
  if (!m) return null;
  let body = m[1];
  // Strip CDATA wrapper.
  const cdata = body.match(/<!\[CDATA\[([\s\S]*?)\]\]>/i);
  if (cdata) body = cdata[1];
  return body.trim();
}

/**
 * Extract all <item> XML fragments from an RSS document. Returns an array
 * of raw XML strings (one per item).
 */
function extractItems(xml) {
  if (!xml || typeof xml !== 'string') return [];
  const items = [];
  // Use a non-greedy match between <item> and </item>. We deliberately
  // allow nested angle brackets inside CDATA — non-greedy handles the
  // common case where items do not contain "</item>" inside CDATA.
  const re = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    items.push(m[0]);
  }
  return items;
}

/**
 * Extract the channel-level <title> for provenance (best-effort).
 */
function extractChannelTitle(xml) {
  const m = xml.match(/<channel\b[^>]*>[\s\S]*?<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return null;
  return decodeEntities(m[1].trim());
}

/**
 * Deterministically extract a mission name from title + description.
 * Returns null when no known mission is matched.
 */
function extractMission(title, description) {
  const haystack = `${title || ''}\n${description || ''}`;
  for (const [pattern, name] of MISSION_PATTERNS) {
    if (pattern.test(haystack)) return name;
  }
  return null;
}

/**
 * Deterministically extract a topic from title + description.
 * Falls back to "mission-update" when no specific topic matches — that is
 * the catch-all for NASA news releases that describe the status of an
 * active mission without falling into a more specific category.
 */
function extractTopic(title, description) {
  const haystack = `${title || ''}\n${description || ''}`;
  for (const [pattern, topic] of TOPIC_PATTERNS) {
    if (pattern.test(haystack)) return topic;
  }
  return 'mission-update';
}

/**
 * Normalize one RSS <item> XML fragment into the science schema.
 */
function normalizeItem(itemXml) {
  const titleRaw = extractTag(itemXml, 'title') || '';
  const title = decodeEntities(titleRaw).trim();

  const link = (extractTag(itemXml, 'link') || '').trim() || null;
  const guid = (extractTag(itemXml, 'guid') || '').trim() || null;
  const pubDateRaw = extractTag(itemXml, 'pubDate');
  const publishedAtSource = parsePubDate(pubDateRaw);

  const descriptionRaw = extractTag(itemXml, 'description') || '';
  // <content:encoded> is the full article HTML body. We extract it
  // separately so we can (a) look for a hero image there and (b) use it
  // for a cleaner plain-text preview when the <description> looks like
  // navigation cruft.
  const contentEncodedRaw = extractTag(itemXml, 'content:encoded') || '';

  // Build a description preview. We prefer the text after the APOD
  // navigation header when present (APOD items always start with a
  // "APOD Science APOD ... Astronomy Picture of the Day" boilerplate
  // block). For non-APOD items we just strip HTML from <description>.
  let descriptionFull = stripHtml(descriptionRaw);
  const apodNavEnd = descriptionFull.indexOf('brief explanation written by a professional astronomer.');
  if (apodNavEnd !== -1) {
    descriptionFull = descriptionFull.slice(apodNavEnd + 'brief explanation written by a professional astronomer.'.length).trim();
  }
  if (!descriptionFull && contentEncodedRaw) {
    descriptionFull = stripHtml(contentEncodedRaw);
  }
  const description = descriptionFull.slice(0, 300);

  // Image URL: prefer media:content / media:thumbnail / enclosure at the
  // RSS-item level; otherwise fall back to the first <img src="..."> in
  // the description or content:encoded HTML.
  let imageUrl = extractMediaContentUrl(itemXml);
  if (!imageUrl && descriptionRaw) {
    imageUrl = extractFirstImgUrl(descriptionRaw);
  }
  if (!imageUrl && contentEncodedRaw) {
    imageUrl = extractFirstImgUrl(contentEncodedRaw);
  }

  // Build the scienceKey deterministically from the guid (or link, as a
  // fallback for items that lack a guid).
  const keyInput = guid || link || title;
  const scienceKey =
    keyInput != null && keyInput !== ''
      ? `nasa__${createHash('sha256').update(keyInput, 'utf8').digest('hex').slice(0, 16)}`
      : null;

  // Determine sourceType — APOD items get a separate sourceType so the
  // filter can down-rank them.
  const isApod = /^apod[:\s]/i.test(title) || /^astronomy\s+picture\s+of\s+the\s+day/i.test(title);
  const sourceType = isApod ? 'apod' : SOURCE_TYPE;

  const mission = extractMission(title, descriptionFull);
  const topic = extractTopic(title, descriptionFull);

  return {
    source: SOURCE_NAME,
    sourceType,
    sourceId: guid || link,
    scienceKey,
    title: title || null,
    description: description || null,
    publishedAtSource,
    updatedAtSource: null,
    sourceUrl: link,
    categories: [],
    mission,
    topic,
    imageUrl,
    imageAlt: title || null,
    imageCredit: 'NASA',
    imageSourceUrl: link,
    rawSourceData: {
      title: titleRaw,
      link,
      guid,
      pubDate: pubDateRaw || null,
      description: descriptionRaw,
      contentEncoded: contentEncodedRaw,
      mediaContentUrl: imageUrl,
    },
  };
}

// --- Fetch -----------------------------------------------------------------

/**
 * Fetch the NASA RSS feed as text. Aborts after FETCH_TIMEOUT_MS.
 * Throws on HTTP error or network failure.
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
      throw new Error(`Request timed out after ${FETCH_TIMEOUT_MS}ms`);
    }
    throw new Error(`Network failure contacting NASA feed: ${String(err)}`);
  }
  clearTimeout(timer);

  if (!response.ok) {
    let bodySnippet = '';
    try {
      bodySnippet = (await response.text()).slice(0, 300);
    } catch {
      /* ignore */
    }
    throw new Error(
      `HTTP ${response.status} ${response.statusText} from NASA feed${bodySnippet ? ` — ${bodySnippet}` : ''}`,
    );
  }

  let text;
  try {
    text = await response.text();
  } catch (err) {
    throw new Error(`Could not read NASA feed body: ${String(err)}`);
  }

  if (!text || text.length === 0) {
    throw new Error('NASA feed returned an empty body');
  }

  return text;
}

// --- Main ------------------------------------------------------------------

async function main() {
  console.log('[fetch-nasa-news] Starting one-shot fetch from NASA RSS feed.');
  console.log(`  Endpoint:   ${FEED_URL}`);
  console.log(`  User-Agent: ${USER_AGENT}`);

  const now = new Date();

  // Step 1 — fetch the feed.
  let xml;
  try {
    xml = await fetchFeed();
  } catch (err) {
    return fail('NASA feed fetch failed.', { detail: String(err) });
  }
  console.log(`  Feed size:  ${xml.length.toLocaleString()} bytes`);

  // Step 2 — extract <item> fragments.
  const itemFragments = extractItems(xml);
  console.log(`  Items:      ${itemFragments.length}`);

  if (itemFragments.length === 0) {
    console.warn('  [warn] No <item> elements found in the feed.');
  }

  // Step 3 — normalize each item.
  const records = [];
  const errors = [];
  for (const fragment of itemFragments) {
    try {
      const record = normalizeItem(fragment);
      if (!record.scienceKey) {
        errors.push({ guid: record.sourceId, error: 'missing scienceKey' });
        continue;
      }
      records.push(record);
    } catch (err) {
      errors.push({ error: String(err) });
    }
  }

  // Step 4 — assemble output document with provenance metadata.
  const channelTitle = extractChannelTitle(xml);
  const apodCount = records.filter((r) => r.sourceType === 'apod').length;
  const withImage = records.filter((r) => r.imageUrl).length;
  const withMission = records.filter((r) => r.mission).length;

  const document = {
    fetchedAt: now.toISOString(),
    source: SOURCE_NAME,
    sourceUrl: FEED_URL,
    channelTitle,
    feedFormat: 'RSS 2.0',
    totalItems: records.length,
    apodCount,
    withImageCount: withImage,
    withMissionCount: withMission,
    parseErrors: errors,
    records,
  };

  // Step 5 — write atomically.
  await mkdir(dirname(OUTPUT_FILE), { recursive: true });
  const tmpFile = `${OUTPUT_FILE}.tmp`;
  await writeFile(tmpFile, JSON.stringify(document, null, 2) + '\n', 'utf8');
  await rename(tmpFile, OUTPUT_FILE);

  // Step 6 — report.
  const stats = await stat(OUTPUT_FILE);
  console.log('\n[fetch-nasa-news] SUCCESS');
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
    console.log(
      `    ${i + 1}. [${r.sourceType}] ${titlePreview}`,
    );
    console.log(
      `        mission=${r.mission || '-'} topic=${r.topic} image=${r.imageUrl ? 'yes' : 'no'} key=${r.scienceKey}`,
    );
  });
  console.log('');
}

main().catch((err) => {
  fail('Unexpected failure.', { detail: String(err && err.stack ? err.stack : err) });
});
