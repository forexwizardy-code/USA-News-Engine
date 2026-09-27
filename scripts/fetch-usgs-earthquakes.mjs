/**
 * US News Engine — USGS earthquake fetcher (Phase 8A).
 *
 * Fetches earthquake data from the official U.S. Geological Survey (USGS)
 * Earthquake Hazards Program GeoJSON feeds and normalizes them into the
 * shared earthquake schema used by Phase 8A.
 *
 * Sources:
 *   - https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_week.geojson
 *     All M2.5+ earthquakes, past 7 days.
 *   - https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_week.geojson
 *     Significant earthquakes, past 7 days (PAGER events of M4.5+ or
 *     M4.5+ in the U.S. etc.). May include events below M2.5 that are
 *     still noteworthy.
 *
 * Both feeds are fetched and merged; duplicates (by USGS event ID) are
 * de-duplicated. U.S. relevance is determined deterministically from the
 * `place` field and the recorded coordinates. Output is written atomically
 * to data/earthquakes/usgs-earthquakes.json.
 *
 * This script makes exactly ONE request per feed (2 total), does NOT publish
 * anything to the website, and does NOT use AI.
 *
 * Run manually:
 *   npm run fetch:earthquakes
 *
 * No API key is required by these endpoints.
 */

import { mkdir, writeFile, rename, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(__dirname, '..');

// --- Configuration ---------------------------------------------------------
const FEEDS = [
  {
    key: '2.5_week',
    label: 'USGS Magnitude 2.5+ Earthquakes, Past Week',
    url: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_week.geojson',
  },
  {
    key: 'significant_week',
    label: 'USGS Significant Earthquakes, Past Week',
    url: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_week.geojson',
  },
];

const OUTPUT_FILE = join(PROJECT_DIR, 'data', 'earthquakes', 'usgs-earthquakes.json');
const SOURCE_NAME = 'U.S. Geological Survey';

const USER_AGENT = 'USNewsEngine/1.0 (https://usa-news-engine.forexwizardy.workers.dev)';
const ACCEPT = 'application/json';
const FETCH_TIMEOUT_MS = 45_000;

// --- U.S. geography tables -------------------------------------------------
// Maps a lower-cased search key to the canonical display name. Order matters
// only in the sense that we test territories (which are longer phrases) and
// multi-word state names before shorter ones, so "New Mexico" is matched
// before "Mexico". We achieve this by iterating longest-key-first.

const US_STATES = {
  alaska: 'Alaska',
  hawaii: 'Hawaii',
  california: 'California',
  nevada: 'Nevada',
  utah: 'Utah',
  oregon: 'Oregon',
  washington: 'Washington',
  oklahoma: 'Oklahoma',
  texas: 'Texas',
  idaho: 'Idaho',
  montana: 'Montana',
  wyoming: 'Wyoming',
  colorado: 'Colorado',
  arizona: 'Arizona',
  'new mexico': 'New Mexico',
  tennessee: 'Tennessee',
  arkansas: 'Arkansas',
  kansas: 'Kansas',
  missouri: 'Missouri',
  virginia: 'Virginia',
  georgia: 'Georgia',
  'north carolina': 'North Carolina',
  'south carolina': 'South Carolina',
  alabama: 'Alabama',
  florida: 'Florida',
  louisiana: 'Louisiana',
  mississippi: 'Mississippi',
  kentucky: 'Kentucky',
  illinois: 'Illinois',
  indiana: 'Indiana',
  ohio: 'Ohio',
  michigan: 'Michigan',
  wisconsin: 'Wisconsin',
  minnesota: 'Minnesota',
  iowa: 'Iowa',
  nebraska: 'Nebraska',
  'north dakota': 'North Dakota',
  'south dakota': 'South Dakota',
  'new york': 'New York',
  pennsylvania: 'Pennsylvania',
  'new jersey': 'New Jersey',
  'new hampshire': 'New Hampshire',
  vermont: 'Vermont',
  maine: 'Maine',
  massachusetts: 'Massachusetts',
  'rhode island': 'Rhode Island',
  connecticut: 'Connecticut',
  delaware: 'Delaware',
  maryland: 'Maryland',
  'west virginia': 'West Virginia',
  'district of columbia': 'District of Columbia',
};

// U.S. territories. Treated as isUS = true but country is the territory name
// (per task spec — "United States", "Puerto Rico", or the country name).
const US_TERRITORIES = {
  'puerto rico': 'Puerto Rico',
  'u.s. virgin islands': 'U.S. Virgin Islands',
  'virgin islands': 'U.S. Virgin Islands',
  'american samoa': 'American Samoa',
  'northern mariana islands': 'Northern Mariana Islands',
  guam: 'Guam',
};

// Common offshore phrases that imply U.S. waters when followed by a U.S.
// state name. (We don't need a separate table — the state lookup already
// covers "offshore Northern California" via the state name match.)

// Sort lookup keys longest-first so multi-word names beat shorter ones.
const TERRITORY_KEYS_SORTED = Object.keys(US_TERRITORIES).sort((a, b) => b.length - a.length);
const STATE_KEYS_SORTED = Object.keys(US_STATES).sort((a, b) => b.length - a.length);

// --- Helpers ---------------------------------------------------------------

function fail(message, { exitCode = 1, detail } = {}) {
  console.error(`\n[fetch-usgs-earthquakes] ERROR: ${message}`);
  if (detail) console.error(`  Detail: ${detail}`);
  console.error(`  Endpoints: ${FEEDS.map((f) => f.url).join(', ')}`);
  process.exit(exitCode);
}

function asIso(value) {
  if (value == null) return null;
  // USGS time/updated are epoch milliseconds.
  let d;
  if (typeof value === 'number' || /^\d+$/.test(String(value))) {
    d = new Date(Number(value));
  } else {
    d = new Date(value);
  }
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Extract the nearest place name from a USGS `place` field.
 *
 * The canonical USGS place format is:
 *   "<distance> km <DIR> of <PlaceName>, <State|Region>"
 * e.g. "37 km ENE of Chase, Alaska" -> "Chase"
 *
 * When there is no "of" phrase (e.g. "South Sandwich Islands region" or
 * "Central Alaska"), the whole string is returned as the nearest place.
 */
function extractNearestPlace(place) {
  if (!place || typeof place !== 'string') return null;
  const m = place.match(/\bof\s+([^,]+?)\s*,/i);
  if (m) return m[1].trim();
  // No comma after "of" — try "of X" without comma.
  const m2 = place.match(/\bof\s+(.+)$/i);
  if (m2) return m2[1].trim();
  return place.trim();
}

/**
 * Extract the trailing region/country token from a place string (the part
 * after the final comma). Returns null when there is no comma.
 */
function extractTrailingRegion(place) {
  if (!place || typeof place !== 'string') return null;
  const parts = place.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  return parts[parts.length - 1];
}

/**
 * Determine U.S. relevance for an earthquake based on its place field.
 * Returns { isUS, state, country, nearestPlace }.
 *
 * Strategy:
 *   1. Lower-case the place string.
 *   2. First test U.S. territories (longest-key first) — these are more
 *      specific than states and a hit means isUS = true.
 *   3. Then test U.S. state names (longest-key first).
 *   4. If nothing matches, isUS = false and we attempt to extract the
 *      country from the trailing region.
 */
function detectUSRelevance(place) {
  const nearestPlace = extractNearestPlace(place);
  const lower = place ? place.toLowerCase() : '';

  // 1) Territories.
  for (const key of TERRITORY_KEYS_SORTED) {
    if (lower.includes(key)) {
      const territory = US_TERRITORIES[key];
      // For territories we keep country = the territory name (Puerto Rico,
      // Guam, etc.) per task spec; state stays null because these are not
      // U.S. states.
      return {
        isUS: true,
        state: null,
        country: territory,
        nearestPlace,
      };
    }
  }

  // 2) States.
  for (const key of STATE_KEYS_SORTED) {
    if (lower.includes(key)) {
      return {
        isUS: true,
        state: US_STATES[key],
        country: 'United States',
        nearestPlace,
      };
    }
  }

  // 3) Not U.S.-relevant. Try to surface a country/region token from the
  //    trailing comma segment.
  const trailing = extractTrailingRegion(place);
  return {
    isUS: false,
    state: null,
    country: trailing || null,
    nearestPlace,
  };
}

/**
 * Normalize a single USGS GeoJSON Feature into the shared earthquake schema.
 */
function normalizeFeature(feature, feedKey) {
  if (!feature || typeof feature !== 'object') return null;
  const id = feature.id;
  const properties = feature.properties || {};
  const geometry = feature.geometry || {};
  const coords = Array.isArray(geometry.coordinates) ? geometry.coordinates : [];

  const isUSInfo = detectUSRelevance(properties.place);

  return {
    source: 'USGS',
    sourceId: id != null ? String(id) : null,
    earthquakeKey: id != null ? `usgs__${id}` : null,
    magnitude: typeof properties.mag === 'number' ? properties.mag : null,
    magnitudeType: properties.magType ?? null,
    place: properties.place ?? null,
    title: properties.title ?? null,
    time: asIso(properties.time),
    updated: asIso(properties.updated),
    timezone: properties.tz ?? null,
    url: properties.url ?? null, // official USGS event page URL
    detailUrl: properties.detail ?? null,
    felt: properties.felt ?? null,
    cdi: properties.cdi ?? null,
    mmi: properties.mmi ?? null,
    alert: properties.alert ?? null, // "green", "yellow", "orange", "red", or null
    status: properties.status ?? null, // "automatic", "reviewed", "deleted"
    tsunami: properties.tsunami === 1, // boolean
    significance: properties.sig ?? null,
    network: properties.net ?? null,
    code: properties.code ?? null,
    ids: properties.ids ?? null,
    sources: properties.sources ?? null,
    types: properties.types ?? null,
    nst: properties.nst ?? null,
    dmin: properties.dmin ?? null,
    rms: properties.rms ?? null,
    gap: properties.gap ?? null,
    depthKm: typeof coords[2] === 'number' ? coords[2] : null,
    latitude: typeof coords[1] === 'number' ? coords[1] : null,
    longitude: typeof coords[0] === 'number' ? coords[0] : null,
    locationType: null, // determined later by filter
    country: isUSInfo.country,
    state: isUSInfo.state,
    nearestPlace: isUSInfo.nearestPlace,
    isUS: isUSInfo.isUS,
    feedSource: feedKey, // provenance: which feed this event came from
    rawSourceData: { properties, geometry },
  };
}

/**
 * Fetch a single USGS feed. Returns the parsed GeoJSON document.
 * Aborts after FETCH_TIMEOUT_MS. Throws on HTTP/parse error.
 */
async function fetchFeed(feed) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response;
  try {
    console.log(`  GET ${feed.url}`);
    response = await fetch(feed.url, {
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
      throw new Error(`Request timed out after ${FETCH_TIMEOUT_MS}ms (${feed.key})`);
    }
    throw new Error(`Network failure contacting ${feed.key}: ${String(err)}`);
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
      `HTTP ${response.status} ${response.statusText} from ${feed.key}${bodySnippet ? ` — ${bodySnippet}` : ''}`,
    );
  }

  let payload;
  try {
    payload = await response.json();
  } catch (err) {
    throw new Error(`Malformed JSON from ${feed.key}: ${String(err)}`);
  }

  if (!payload || !Array.isArray(payload.features)) {
    throw new Error(`Unexpected payload shape from ${feed.key} (no features array)`);
  }

  return payload;
}

// --- Main ------------------------------------------------------------------

async function main() {
  console.log('[fetch-usgs-earthquakes] Starting one-shot fetch from USGS.');
  console.log(`  Feeds:     ${FEEDS.length}`);
  for (const f of FEEDS) console.log(`    - ${f.key}: ${f.url}`);
  console.log(`  User-Agent: ${USER_AGENT}`);

  const now = new Date();

  // Step 1 — fetch both feeds, tolerating individual feed failures.
  const feedResults = [];
  const feedErrors = [];
  for (const feed of FEEDS) {
    try {
      const payload = await fetchFeed(feed);
      const count = payload.features ? payload.features.length : 0;
      const metadata = payload.metadata || {};
      console.log(`    ${feed.key}: ${count} features (API count: ${metadata.count ?? '?'})`);
      feedResults.push({ feed, payload, count });
    } catch (err) {
      feedErrors.push({ feed, error: String(err) });
      console.error(`    [warn] ${feed.key} failed: ${String(err)}`);
    }
  }

  // If BOTH feeds failed, abort.
  if (feedResults.length === 0) {
    return fail('All USGS feeds failed; no data fetched.', {
      detail: feedErrors.map((e) => `${e.feed.key}: ${e.error}`).join('\n  '),
    });
  }

  // Step 2 — normalize and merge, deduplicating by event ID.
  const mergedMap = new Map();
  for (const { feed, payload } of feedResults) {
    for (const feature of payload.features) {
      const normalized = normalizeFeature(feature, feed.key);
      if (!normalized || !normalized.sourceId) continue;
      // If the same event appears in both feeds, prefer the one with the
      // "significant_week" feed tag (it is the more curated source) — but
      // only when the existing entry is from the 2.5_week feed. Otherwise
      // keep the first-seen entry to preserve stable ordering.
      const existing = mergedMap.get(normalized.sourceId);
      if (!existing) {
        mergedMap.set(normalized.sourceId, normalized);
      } else if (existing.feedSource === '2.5_week' && feed.key === 'significant_week') {
        mergedMap.set(normalized.sourceId, normalized);
      }
    }
  }

  const earthquakes = Array.from(mergedMap.values());
  const usRelevantCount = earthquakes.filter((e) => e.isUS).length;
  const sourceUrls = FEEDS.map((f) => f.url);
  const feedsUsed = feedResults.map((r) => r.feed.key);

  // Step 3 — assemble output document with provenance metadata.
  const document = {
    fetchedAt: now.toISOString(),
    source: SOURCE_NAME,
    sourceUrls,
    feedsUsed,
    feedErrors: feedErrors.length
      ? feedErrors.map((e) => ({ feed: e.feed.key, error: e.error }))
      : [],
    totalEvents: earthquakes.length,
    usRelevantCount,
    earthquakes,
  };

  // Step 4 — write atomically.
  await mkdir(dirname(OUTPUT_FILE), { recursive: true });
  const tmpFile = `${OUTPUT_FILE}.tmp`;
  await writeFile(tmpFile, JSON.stringify(document, null, 2) + '\n', 'utf8');
  await rename(tmpFile, OUTPUT_FILE);

  // Step 5 — report.
  const stats = await stat(OUTPUT_FILE);
  console.log('\n[fetch-usgs-earthquakes] SUCCESS');
  console.log(`  Feeds used:          ${feedsUsed.join(', ')}`);
  if (feedErrors.length) {
    console.log(`  Feed errors:         ${feedErrors.length}`);
    for (const e of feedErrors) console.log(`    - ${e.feed.key}: ${e.error}`);
  }
  console.log(`  Total events:        ${earthquakes.length}`);
  console.log(`  U.S.-relevant:       ${usRelevantCount}`);
  console.log(`  Non-U.S.:            ${earthquakes.length - usRelevantCount}`);
  console.log(`  Output file:         ${OUTPUT_FILE}`);
  console.log(`  File size:           ${stats.size.toLocaleString()} bytes`);
  console.log(`  Fetched at (UTC):    ${document.fetchedAt}`);

  // Top 5 by magnitude for eyeball verification.
  const topByMag = [...earthquakes]
    .filter((e) => typeof e.magnitude === 'number')
    .sort((a, b) => b.magnitude - a.magnitude)
    .slice(0, 5);
  if (topByMag.length) {
    console.log('\n  Top 5 by magnitude:');
    for (const e of topByMag) {
      const placePreview = (e.place || '(no place)').slice(0, 60);
      console.log(
        `    - M${e.magnitude} | ${placePreview} | ${e.isUS ? 'US' : 'non-US'} | ${e.earthquakeKey}`,
      );
    }
  }

  // U.S.-relevant sample (up to 5).
  const usSample = earthquakes.filter((e) => e.isUS).slice(0, 5);
  if (usSample.length) {
    console.log('\n  Sample U.S.-relevant events:');
    for (const e of usSample) {
      const placePreview = (e.place || '(no place)').slice(0, 60);
      console.log(
        `    - M${e.magnitude ?? '?'} | ${placePreview} | state=${e.state || e.country || '?'} | ${e.earthquakeKey}`,
      );
    }
  } else {
    console.log('\n  (No U.S.-relevant events in this fetch.)');
  }
  console.log('');
}

main().catch((err) => {
  fail('Unexpected failure.', { detail: String(err && err.stack ? err.stack : err) });
});
