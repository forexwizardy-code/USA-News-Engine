import { classifyGeneralNewsCategory } from './lib/general-news-category.mjs';
/**
 * US News Engine — Phase 10A.2 General U.S. News source fetcher.
 *
 * Fetches publicly accessible RSS feeds from:
 *   1. Official U.S. government / agency newsrooms (preferred primary sources)
 *   2. Openly accessible publisher RSS feeds (for discovery + attribution)
 *
 * Source-health model: each source is tracked independently. One failed
 * source does not kill unrelated healthy sources.
 *
 * NO scraping of Google Search / Google News HTML. NO paywall bypass.
 * NO copying of full AP/Reuters/CNN/NYT articles. We use RSS for
 * DISCOVERY and factual sourcing only; downstream draft generators
 * write original summaries with clear attribution + link to source.
 *
 * Output: data/general-news/general-news-feed.json
 *   {
 *     fetchedAt, sources: [ {sourceName, sourceType, sourceUrl, sourceAvailable,
 *       httpStatus, fetchedAt, recordCount, fetchError, records: []} ]
 *   }
 *
 * Run: node scripts/fetch-general-news.mjs
 */

import { mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { XMLParser } from 'fast-xml-parser';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(__dirname, '..');
const OUTPUT_FILE = join(PROJECT_DIR, 'data', 'general-news', 'general-news-feed.json');

const FETCH_TIMEOUT_MS = 20_000;
const USER_AGENT = 'USNewsEngine/1.0 (https://usa-news-engine.forexwizardy.workers.dev; news discovery)';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
});

// ===========================================================================
// Source registry — publicly accessible RSS feeds
// ===========================================================================
// Priority order per spec §1:
//   1. official U.S. government / agency newsrooms (preferred)
//   2. official company / organization newsrooms when relevant
//   3. openly accessible publisher RSS feeds (for discovery)
//
// We use these feeds for DISCOVERY and factual sourcing. Downstream draft
// generators write ORIGINAL summaries (no copied paragraphs) and attribute
// the outlet clearly with a link to the source.
const SOURCES = [
  // --- 1. Official U.S. government / agency newsrooms (preferred primary) ---
  // Note: many .gov feed endpoints have been retired or now return HTML/403.
  // We keep the ones that still serve valid RSS/XML to automated access.
  {
    sourceName: 'Federal Trade Commission',
    sourceType: 'government',
    publisherFamily: 'FTC',
    category: 'business',
    feedUrl: 'https://www.ftc.gov/feeds/press-release.xml',
  },

  // --- 2. Openly accessible publisher RSS feeds (discovery + attribution) ---
  // These are used for DISCOVERY. We write original summaries and link back.
  // Phase 10A.2.1: expanded for source diversity + sports coverage.

  // NPR family (publisherFamily = NPR — multiple NPR feeds = 1 family)
  {
    sourceName: 'NPR News',
    sourceType: 'publisher',
    publisherFamily: 'NPR',
    category: 'us',
    feedUrl: 'https://feeds.npr.org/1001/rss.xml',
  },
  {
    sourceName: 'NPR Politics',
    sourceType: 'publisher',
    publisherFamily: 'NPR',
    category: 'politics',
    feedUrl: 'https://feeds.npr.org/1014/rss.xml',
  },
  {
    sourceName: 'NPR Business',
    sourceType: 'publisher',
    publisherFamily: 'NPR',
    category: 'business',
    feedUrl: 'https://feeds.npr.org/1006/rss.xml',
  },
  {
    sourceName: 'NPR Technology',
    sourceType: 'publisher',
    publisherFamily: 'NPR',
    category: 'technology',
    feedUrl: 'https://feeds.npr.org/1009/rss.xml',
  },
  {
    sourceName: 'NPR Entertainment',
    sourceType: 'publisher',
    publisherFamily: 'NPR',
    category: 'entertainment',
    feedUrl: 'https://feeds.npr.org/1004/rss.xml',
  },
  {
    sourceName: 'NPR Movies',
    sourceType: 'publisher',
    publisherFamily: 'NPR',
    category: 'entertainment',
    feedUrl: 'https://feeds.npr.org/1045/rss.xml',
  },
  // Dedicated Hollywood coverage; individual source failures are isolated by
  // the existing feed-health system, and content is for discovery/attribution.
  {
    sourceName: 'Variety',
    sourceType: 'publisher',
    publisherFamily: 'Variety',
    category: 'entertainment',
    feedUrl: 'https://variety.com/feed/',
  },
  {
    sourceName: 'Deadline',
    sourceType: 'publisher',
    publisherFamily: 'Deadline',
    category: 'entertainment',
    feedUrl: 'https://deadline.com/feed/',
  },
  {
    sourceName: 'The Hollywood Reporter',
    sourceType: 'publisher',
    publisherFamily: 'Hollywood Reporter',
    category: 'entertainment',
    feedUrl: 'https://www.hollywoodreporter.com/feed/',
  },

  {
    sourceName: 'NPR Sports',
    sourceType: 'publisher',
    publisherFamily: 'NPR',
    category: 'sports',
    feedUrl: 'https://feeds.npr.org/1005/rss.xml',
  },

  // PBS family
  {
    sourceName: 'PBS NewsHour',
    sourceType: 'publisher',
    publisherFamily: 'PBS',
    category: 'us',
    feedUrl: 'https://www.pbs.org/newshour/feeds/rss/headlines',
  },

  // NYT family (publisherFamily = NYT — multiple NYT feeds = 1 family)
  // Phase 10A.2.1: added for source diversity + sports coverage.
  {
    sourceName: 'New York Times — HomePage',
    sourceType: 'publisher',
    publisherFamily: 'NYT',
    category: 'us',
    feedUrl: 'https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml',
  },
  {
    sourceName: 'New York Times — Politics',
    sourceType: 'publisher',
    publisherFamily: 'NYT',
    category: 'politics',
    feedUrl: 'https://rss.nytimes.com/services/xml/rss/nyt/Politics.xml',
  },
  {
    sourceName: 'New York Times — Business',
    sourceType: 'publisher',
    publisherFamily: 'NYT',
    category: 'business',
    feedUrl: 'https://rss.nytimes.com/services/xml/rss/nyt/Business.xml',
  },
  {
    sourceName: 'New York Times — Technology',
    sourceType: 'publisher',
    publisherFamily: 'NYT',
    category: 'technology',
    feedUrl: 'https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml',
  },
  {
    sourceName: 'New York Times — Sports',
    sourceType: 'publisher',
    publisherFamily: 'NYT',
    category: 'sports',
    feedUrl: 'https://rss.nytimes.com/services/xml/rss/nyt/Sports.xml',
  },
  {
    sourceName: 'New York Times — Arts',
    sourceType: 'publisher',
    publisherFamily: 'NYT',
    category: 'entertainment',
    feedUrl: 'https://rss.nytimes.com/services/xml/rss/nyt/Arts.xml',
  },

  // The Hill (politics — independent family)
  {
    sourceName: 'The Hill',
    sourceType: 'publisher',
    publisherFamily: 'The Hill',
    category: 'politics',
    feedUrl: 'https://thehill.com/feed/',
  },

  // BBC US/Canada (international outlet with a U.S.-focused feed)
  {
    sourceName: 'BBC News — US & Canada',
    sourceType: 'publisher',
    publisherFamily: 'BBC',
    category: 'us',
    feedUrl: 'https://feeds.bbci.co.uk/news/world/us_and_canada/rss.xml',
  },

  // Phase 10A.2.2 — additional publisher families for source diversity

  // Washington Post family (publisherFamily = WaPo)
  {
    sourceName: 'Washington Post — National',
    sourceType: 'publisher',
    publisherFamily: 'WaPo',
    category: 'us',
    feedUrl: 'https://feeds.washingtonpost.com/rss/national',
  },
  {
    sourceName: 'Washington Post — Entertainment',
    sourceType: 'publisher',
    publisherFamily: 'WaPo',
    category: 'entertainment',
    feedUrl: 'https://feeds.washingtonpost.com/rss/entertainment',
  },
  {
    sourceName: 'Washington Post — Sports',
    sourceType: 'publisher',
    publisherFamily: 'WaPo',
    category: 'sports',
    feedUrl: 'https://feeds.washingtonpost.com/rss/sports',
  },

  // CNET (technology — independent family)
  {
    sourceName: 'CNET News',
    sourceType: 'publisher',
    publisherFamily: 'CNET',
    category: 'technology',
    feedUrl: 'https://www.cnet.com/rss/news/',
  },

  // Ars Technica (technology — independent family)
  {
    sourceName: 'Ars Technica',
    sourceType: 'publisher',
    publisherFamily: 'Ars Technica',
    category: 'technology',
    feedUrl: 'https://feeds.arstechnica.com/arstechnica/index',
  },

  // The Verge (technology — independent family)
  {
    sourceName: 'The Verge',
    sourceType: 'publisher',
    publisherFamily: 'The Verge',
    category: 'technology',
    feedUrl: 'https://www.theverge.com/rss/index.xml',
  },

  // TechCrunch (technology — independent family)
  {
    sourceName: 'TechCrunch',
    sourceType: 'publisher',
    publisherFamily: 'TechCrunch',
    category: 'technology',
    feedUrl: 'https://techcrunch.com/feed/',
  },

  // Engadget (technology — independent family)
  {
    sourceName: 'Engadget',
    sourceType: 'publisher',
    publisherFamily: 'Engadget',
    category: 'technology',
    feedUrl: 'https://www.engadget.com/rss.xml',
  },

  // NYT sport-specific feeds (publisherFamily = NYT — same family as NYT
  // categories above, but these provide actual sports items unlike the
  // empty NYT Sports aggregate feed).
  {
    sourceName: 'New York Times — Pro Football',
    sourceType: 'publisher',
    publisherFamily: 'NYT',
    category: 'sports',
    feedUrl: 'https://rss.nytimes.com/services/xml/rss/nyt/ProFootball.xml',
  },
  {
    sourceName: 'New York Times — Pro Basketball',
    sourceType: 'publisher',
    publisherFamily: 'NYT',
    category: 'sports',
    feedUrl: 'https://rss.nytimes.com/services/xml/rss/nyt/ProBasketball.xml',
  },
  {
    sourceName: 'New York Times — Baseball',
    sourceType: 'publisher',
    publisherFamily: 'NYT',
    category: 'sports',
    feedUrl: 'https://rss.nytimes.com/services/xml/rss/nyt/Baseball.xml',
  },
  {
    sourceName: 'New York Times — College Football',
    sourceType: 'publisher',
    publisherFamily: 'NYT',
    category: 'sports',
    feedUrl: 'https://rss.nytimes.com/services/xml/rss/nyt/CollegeFootball.xml',
  },
  {
    sourceName: 'New York Times — College Basketball',
    sourceType: 'publisher',
    publisherFamily: 'NYT',
    category: 'sports',
    feedUrl: 'https://rss.nytimes.com/services/xml/rss/nyt/CollegeBasketball.xml',
  },
];

// ===========================================================================
// Helpers
// ===========================================================================

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

function textOf(node) {
  if (node == null) return null;
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (typeof node === 'object') {
    if (typeof node['#text'] === 'string') return node['#text'];
    if (typeof node['#cdata'] === 'string') return node['#cdata'];
  }
  return null;
}

function arrayOf(node) {
  if (node == null) return [];
  if (Array.isArray(node)) return node;
  return [node];
}

function parsePubDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Categorize an item by its title/description + the feed's default category.
 * Returns one of: us, politics, business, technology, entertainment, sports.
 */
function categorizeItem(title, description, feedCategory) {
  const t = `${title || ''} ${description || ''}`.toLowerCase();

  // Politics / Government
  if (/\b(senate|congress|house of representatives|legislat|senator|representative|governor|election|primary|ballot|campaign|policy|federal|administration|executive order|bill |amendment|supreme court|court ruling|department of|agency)\b/i.test(t)) {
    return 'politics';
  }
  // Business
  if (/\b(stock|market|economy|economic|earnings|fed |federal reserve|inflation|interest rate|tariff|trade|gdp|recession|wall street|s&p|nasdaq|dow jones|bankruptcy|merger|acquisition|ipo|crypto|bitcoin)\b/i.test(t)) {
    return 'business';
  }
  // Technology
  if (/\b(tech|technology|ai |artificial intelligence|software|apple|google|microsoft|amazon|meta |facebook|tesla|openai|cyber|hack|data breach|internet|app |smartphone|chip|semiconductor|startup)\b/i.test(t)) {
    return 'technology';
  }
  // Entertainment
  if (/\b(movie|film|hollywood|actor|actress|music|album|concert|celebrity|streaming|netflix|disney|spotify|award|emmy|grammy|oscar|box office|tv show|television)\b/i.test(t)) {
    return 'entertainment';
  }
  // Sports
  if (/\b(nfl|nba|mlb|nhl|soccer|football|basketball|baseball|hockey|tennis|golf|olympic|championship|playoff|super bowl|world series|tournament|coach|athlete|team )\b/i.test(t)) {
    return 'sports';
  }
  // Safety guard: section feeds occasionally carry stories outside their
  // normal topic. Do not let Entertainment/Sports force obvious crime,
  // public-safety, terrorism, policing, or court stories into those sections.
  if (
    ['entertainment', 'sports'].includes(feedCategory) &&
    /\b(terror|terrorism|terrorist|shooting|shot|gunman|murder|homicide|killed|death|dead|assault|attack|arrest|arrested|charged|charges|crime|criminal|police|sheriff|law enforcement|fbi|ice agent|immigration enforcement|prosecutor|indictment|trial|court case|hostage|bomb|explosion)\b/i.test(t)
  ) {
    return 'us';
  }

  // Default to feed's category (or 'us' for general)
  return feedCategory || 'us';
}

// ===========================================================================
// Fetch one source
// ===========================================================================

async function tryFetch(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/rss+xml, application/xml, text/xml; q=0.9, */*; q=0.5',
        'User-Agent': USER_AGENT,
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: controller.signal,
      redirect: 'follow',
    });
    const text = await res.text();
    if (!text || text.length === 0) {
      return { ok: false, status: res.status, error: 'empty body' };
    }
    return { ok: true, status: res.status, body: text, error: null };
  } catch (err) {
    clearTimeout(timer);
    if (err && err.name === 'AbortError') {
      return { ok: false, status: 0, error: `timeout after ${FETCH_TIMEOUT_MS}ms` };
    }
    return { ok: false, status: 0, error: `network failure: ${String(err).slice(0, 200)}` };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchSource(source) {
  const now = new Date().toISOString();
  const result = await tryFetch(source.feedUrl);

  if (!result.ok) {
    return {
      sourceName: source.sourceName,
      sourceType: source.sourceType,
      category: source.category,
      sourceUrl: source.feedUrl,
      sourceAvailable: false,
      httpStatus: result.status,
      fetchedAt: now,
      recordCount: 0,
      fetchError: result.error,
      records: [],
    };
  }

  // Parse XML
  let parsed;
  try {
    parsed = parser.parse(result.body);
  } catch (err) {
    return {
      sourceName: source.sourceName,
      sourceType: source.sourceType,
      category: source.category,
      sourceUrl: source.feedUrl,
      sourceAvailable: false,
      httpStatus: result.status,
      fetchedAt: now,
      recordCount: 0,
      fetchError: `XML parse failure: ${String(err).slice(0, 200)}`,
      records: [],
    };
  }

  // RSS 2.0: rss.channel.item[]
  const channel = parsed?.rss?.channel;
  const rawItems = channel ? arrayOf(channel.item) : [];
  // Atom: feed.entry[]
  const atomEntries = parsed?.feed ? arrayOf(parsed.feed.entry) : [];

  const records = [];

  for (const item of rawItems) {
    const title = decodeEntities(textOf(item.title) || '').trim();
    const link = (textOf(item.link) || item.link || '').trim();
    const guid = (textOf(item.guid) || '').trim();
    const pubDateRaw = textOf(item.pubDate);
    const publishedAtSource = parsePubDate(pubDateRaw);
    const descriptionRaw = textOf(item.description) || '';
    const description = stripHtml(descriptionRaw).slice(0, 400);
    const category = classifyGeneralNewsCategory(title, description, source.category);

    records.push({
      sourceName: source.sourceName,
      sourceType: source.sourceType,
      publisherFamily: source.publisherFamily || null,
      sourceCategory: source.category,
      category,
      title: title || null,
      description: description || null,
      sourceUrl: link || guid || source.feedUrl,
      publishedAtSource,
      guid: guid || link || null,
    });
  }

  for (const entry of atomEntries) {
    const title = decodeEntities(textOf(entry.title) || '').trim();
    // Atom link is in <link href="..."/>
    let link = '';
    const links = arrayOf(entry.link);
    for (const l of links) {
      if (l && l['@_href']) {
        if (!l['@_rel'] || l['@_rel'] === 'alternate') {
          link = l['@_href'];
          break;
        }
      }
    }
    const pubRaw = textOf(entry.published) || textOf(entry.updated);
    const publishedAtSource = parsePubDate(pubRaw);
    const summary = stripHtml(textOf(entry.summary) || textOf(entry.content) || '').slice(0, 400);
    const category = classifyGeneralNewsCategory(title, summary, source.category);

    records.push({
      sourceName: source.sourceName,
      sourceType: source.sourceType,
      publisherFamily: source.publisherFamily || null,
      sourceCategory: source.category,
      category,
      title: title || null,
      description: summary || null,
      sourceUrl: link || source.feedUrl,
      publishedAtSource,
      guid: (textOf(entry.id) || link || null),
    });
  }

  return {
    sourceName: source.sourceName,
    sourceType: source.sourceType,
    category: source.category,
    sourceUrl: source.feedUrl,
    sourceAvailable: true,
    httpStatus: result.status,
    fetchedAt: now,
    recordCount: records.length,
    fetchError: null,
    records,
  };
}

// ===========================================================================
// Main
// ===========================================================================

async function main() {
  console.log('[fetch-general-news] Starting General U.S. News source discovery.');
  console.log(`  Sources: ${SOURCES.length}`);
  console.log(`  Output:  ${OUTPUT_FILE}`);
  console.log('');

  // Fetch all sources in parallel (with individual timeouts).
  const results = await Promise.all(SOURCES.map((s) => fetchSource(s)));

  // Report
  const healthy = results.filter((r) => r.sourceAvailable);
  const failed = results.filter((r) => !r.sourceAvailable);
  const totalRecords = results.reduce((sum, r) => sum + r.recordCount, 0);

  console.log('  Source health:');
  for (const r of results) {
    const tag = r.sourceAvailable ? 'HEALTHY' : 'DEGRADED';
    console.log(`    ${r.sourceName.padEnd(40)} ${tag}  (${r.recordCount} records${r.fetchError ? ', err=' + r.fetchError.slice(0, 60) : ''})`);
  }
  console.log('');
  console.log(`  Healthy sources: ${healthy.length}/${results.length}`);
  console.log(`  Degraded sources: ${failed.length}`);
  console.log(`  Total raw items: ${totalRecords}`);

  // Write output
  const doc = {
    fetchedAt: new Date().toISOString(),
    source: 'Phase 10A.2 General U.S. News source discovery',
    sourceCount: results.length,
    healthySourceCount: healthy.length,
    degradedSourceCount: failed.length,
    totalRecordCount: totalRecords,
    sources: results,
  };

  await mkdir(dirname(OUTPUT_FILE), { recursive: true });
  const tmp = `${OUTPUT_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  await rename(tmp, OUTPUT_FILE);

  console.log(`\n  Output: ${OUTPUT_FILE}`);
  console.log('  Done.');
}

main().catch((err) => {
  console.error(`[fetch-general-news] FATAL: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
