/**
 * US News Engine — JPL news-release fetcher (Phase 9A).
 *
 * Fetches NASA Jet Propulsion Laboratory (JPL) news releases from the
 * JPL RSS feed:
 *   https://www.jpl.nasa.gov/news/feed/
 *
 * As of 2026-09, the JPL feed returns HTTP 403 to most non-browser user
 * agents (the alternate URL https://www.jpl.nasa.gov/rss/news.php is
 * also blocked). This script is built to:
 *
 *   - Try the primary feed URL first.
 *   - If that fails (403 or any other HTTP error), try the alternate URL.
 *   - If both fail, write an EMPTY result set with an `error` field so the
 *     rest of the Phase 9A pipeline can continue. The fetcher will work
 *     automatically when the feed becomes available.
 *
 * The schema is identical to fetch-nasa-news.mjs (shared science schema),
 * except `source` is "JPL" and `scienceKey` uses the `jpl__` prefix.
 *
 * This script makes at most TWO requests to the source feed (primary +
 * fallback), writes the normalized records to data/science/jpl-news.json
 * atomically, and prints a brief summary. It does NOT publish anything to
 * the website and does NOT use AI.
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(__dirname, '..');

// --- Configuration ---------------------------------------------------------
const FEED_URLS = [
  'https://www.jpl.nasa.gov/news/feed/',
  'https://www.jpl.nasa.gov/rss/news.php',
];
const OUTPUT_FILE = join(PROJECT_DIR, 'data', 'science', 'jpl-news.json');
const SOURCE_NAME = 'JPL';
const SOURCE_TYPE = 'news-release';

const USER_AGENT = 'USNewsEngine/1.0 (https://usa-news-engine.forexwizardy.workers.dev)';
const ACCEPT = 'application/rss+xml, application/xml, text/xml; q=0.9, */*; q=0.5';
const FETCH_TIMEOUT_MS = 30_000;

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
  [/\boc[-\s]?2\b/i, 'OC-2'],
  [/\bnisar\b/i, 'NISAR'],
  [/\bsentinel[\s-]?6\b/i, 'Sentinel-6'],
  [/\bswot\b/i, 'SWOT'],
  [/\btempo\b/i, 'TEMPO'],
  [/\bpace\b/i, 'PACE'],
  [/\bemit\b/i, 'EMIT'],
  [/\bdragonfly\b/i, 'Dragonfly'],
  [/\bastrobiology\b/i, 'Astrobiology'],
];

// --- Topic keyword table ---------------------------------------------------
const TOPIC_PATTERNS = [
  [/\bastronaut|\bcrew\b|\bnasa\s+personnel\b|\bcosmonaut\b/i, 'crew'],
  [/\blaunch(ed|ing|es)?\b|\blift[\s-]?off\b|\bcountdown\b|\brolled?\s+out\b/i, 'launch'],
  [/\bsplash[\s-]?down\b|\bland(ed|ing|s)?\b|\btouchdown\b|\breturn(s|ed|ing)?\s+(to\s+earth|home)\b/i, 'landing'],
  [/\bdiscover(y|ed|ies)\b|\bfinding(s)?\b|\bresult(s)?\b|\bfirst\s+(image|observation|measurement|look|light)\b|\bmilestone\b|\bdetected\b|\bnew\s+image\b|\bcaptures?\b/i, 'discovery'],
  [/\bearth\s+(science|observation|monitoring|from\s+space)\b|\bclimate\b|\bsea\s+level\b|\bgreenland\b|\bantarctic|\bglacier\b|\bwildfire|\bdisaster\s+response\b|\bhurricane\b|\bstorm\b/i, 'earth-science'],
  [/\bexoplanet|\bgalaxy|\bnebula|\bblack\s+hole|\bstar\s+(cluster|formation)|\bquasar|\bsupernova|\bdark\s+(matter|energy)|\bcomet\b|\basteroid\b/i, 'astronomy'],
  [/\btechnology\b|\btech\b|\bdemonstrat|\bprototype\b|\binnovat|\bengineer|\b3d[\s-]?print|\bpropuls|\bsoftware\b|\bhardware\b|\binstrument\b|\btelescope\s+upgrade\b/i, 'technology'],
  [/\bstudents?\b|\beducation\b|\bSTEM\b|\boutreach\b|\bschool\b|\buniversity\b|\binternship|\bfellowship|\bgrant\b/i, 'education'],
  [/\bappoint|\bnamed\s+as\b|\bnominat|\badministrator\b|\bbudget\b|\bfunding\b|\bstatement\b|\bpress\s+secretary\b|\bbriefing\b/i, 'administrative'],
];

// --- Helpers ---------------------------------------------------------------

function fail(message, { exitCode = 1, detail } = {}) {
  console.error(`\n[fetch-jpl-news] ERROR: ${message}`);
  if (detail) console.error(`  Detail: ${detail}`);
  console.error(`  Endpoints: ${FEED_URLS.join(', ')}`);
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

function extractMediaContentUrl(itemXml) {
  const m = itemXml.match(/<media:content\b[^>]*\burl=["']([^"']+)["'][^>]*>/i);
  if (m) return m[1];
  // Some JPL feeds use media:thumbnail instead.
  const m2 = itemXml.match(/<media:thumbnail\b[^>]*\burl=["']([^"']+)["'][^>]*>/i);
  if (m2) return m2[1];
  return null;
}

function extractEnclosureUrl(itemXml) {
  const m = itemXml.match(/<enclosure\b[^>]*\burl=["']([^"']+)["'][^>]*>/i);
  return m ? m[1] : null;
}

/**
 * Extract the URL of the first <img src="..."> element from an HTML string
 * (typically the CDATA-wrapped contents of <description> or
 * <content:encoded>). Returns null when no usable image is found.
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
    return url;
  }
  return null;
}

function extractTag(itemXml, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i');
  const m = itemXml.match(re);
  if (!m) return null;
  let body = m[1];
  const cdata = body.match(/<!\[CDATA\[([\s\S]*?)\]\]>/i);
  if (cdata) body = cdata[1];
  return body.trim();
}

function extractItems(xml) {
  if (!xml || typeof xml !== 'string') return [];
  const items = [];
  const re = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    items.push(m[0]);
  }
  return items;
}

function extractChannelTitle(xml) {
  const m = xml.match(/<channel\b[^>]*>[\s\S]*?<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return null;
  return decodeEntities(m[1].trim());
}

function extractMission(title, description) {
  const haystack = `${title || ''}\n${description || ''}`;
  for (const [pattern, name] of MISSION_PATTERNS) {
    if (pattern.test(haystack)) return name;
  }
  return null;
}

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
  const contentEncodedRaw = extractTag(itemXml, 'content:encoded') || '';
  let descriptionFull = stripHtml(descriptionRaw);
  if (!descriptionFull && contentEncodedRaw) {
    descriptionFull = stripHtml(contentEncodedRaw);
  }
  const description = descriptionFull.slice(0, 300);

  let imageUrl = extractMediaContentUrl(itemXml) || extractEnclosureUrl(itemXml);
  if (!imageUrl && descriptionRaw) {
    imageUrl = extractFirstImgUrl(descriptionRaw);
  }
  if (!imageUrl && contentEncodedRaw) {
    imageUrl = extractFirstImgUrl(contentEncodedRaw);
  }

  const keyInput = guid || link || title;
  const scienceKey =
    keyInput != null && keyInput !== ''
      ? `jpl__${createHash('sha256').update(keyInput, 'utf8').digest('hex').slice(0, 16)}`
      : null;

  const mission = extractMission(title, descriptionFull);
  const topic = extractTopic(title, descriptionFull);

  return {
    source: SOURCE_NAME,
    sourceType: SOURCE_TYPE,
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
    imageCredit: 'NASA/JPL-Caltech',
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
 * Attempt to fetch one feed URL. Returns { ok, status, body, error }.
 * Never throws — callers decide what to do with the result.
 */
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
  console.log(`  Endpoints:  ${FEED_URLS.length} candidate(s)`);
  console.log(`  User-Agent: ${USER_AGENT}`);

  const now = new Date();

  // Step 1 — try each feed URL in order until one succeeds.
  let xml = null;
  let usedUrl = null;
  const attempts = [];
  for (const url of FEED_URLS) {
    const res = await tryFetch(url);
    attempts.push({ url, ok: res.ok, status: res.status, error: res.error });
    if (res.ok) {
      xml = res.body;
      usedUrl = url;
      break;
    }
    console.warn(`  [warn] ${url} -> ${res.error}`);
  }

  // Step 2 — if all fetches failed, write an empty result with an error
  // field so downstream pipelines can continue. We do NOT exit 1 here —
  // a missing JPL feed is an expected condition (JPL currently returns
  // HTTP 403 to most non-browser user agents) and the rest of Phase 9A
  // is designed to handle an empty JPL file.
  if (!xml) {
    const document = {
      fetchedAt: now.toISOString(),
      source: SOURCE_NAME,
      sourceUrls: FEED_URLS,
      sourceUrlUsed: null,
      channelTitle: null,
      feedFormat: 'RSS 2.0',
      totalItems: 0,
      apodCount: 0,
      withImageCount: 0,
      withMissionCount: 0,
      error: 'All JPL feed URLs failed — see `attempts` for details.',
      attempts,
      records: [],
    };

    await mkdir(dirname(OUTPUT_FILE), { recursive: true });
    const tmpFile = `${OUTPUT_FILE}.tmp`;
    await writeFile(tmpFile, JSON.stringify(document, null, 2) + '\n', 'utf8');
    await rename(tmpFile, OUTPUT_FILE);

    const stats = await stat(OUTPUT_FILE);
    console.log('\n[fetch-jpl-news] PARTIAL SUCCESS (feed blocked)');
    console.log('  All JPL feed URLs failed; wrote empty result set.');
    for (const a of attempts) {
      console.log(`    - ${a.url}: ${a.ok ? 'OK' : a.error}`);
    }
    console.log(`  Output file:         ${OUTPUT_FILE}`);
    console.log(`  File size:           ${stats.size.toLocaleString()} bytes`);
    console.log(`  Fetched at (UTC):    ${document.fetchedAt}`);
    console.log('  The fetcher will work automatically when JPL feed becomes available.');
    console.log('');
    return;
  }

  // Step 3 — extract <item> fragments.
  const itemFragments = extractItems(xml);
  console.log(`  Feed size:  ${xml.length.toLocaleString()} bytes`);
  console.log(`  Items:      ${itemFragments.length}`);

  // Step 4 — normalize.
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

  const channelTitle = extractChannelTitle(xml);
  const withImage = records.filter((r) => r.imageUrl).length;
  const withMission = records.filter((r) => r.mission).length;

  const document = {
    fetchedAt: now.toISOString(),
    source: SOURCE_NAME,
    sourceUrls: FEED_URLS,
    sourceUrlUsed: usedUrl,
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
  console.log(`  Source URL:          ${usedUrl}`);
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
    console.log(`    ${i + 1}. [${r.sourceType}] ${titlePreview}`);
    console.log(
      `        mission=${r.mission || '-'} topic=${r.topic} image=${r.imageUrl ? 'yes' : 'no'} key=${r.scienceKey}`,
    );
  });
  console.log('');
}

main().catch((err) => {
  fail('Unexpected failure.', { detail: String(err && err.stack ? err.stack : err) });
});
