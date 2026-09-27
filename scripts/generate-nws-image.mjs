/**
 * US News Engine — automated NWS editorial image generator (Phase 3F).
 *
 * Reads a private NWS article draft (data/drafts/<storyKey>.json) and
 * generates a professional, data-driven NEWS GRAPHIC (not a fake photograph)
 * as SVG + PNG, plus a JSON metadata sidecar.
 *
 * Design goals:
 *   - Original US News Engine visual identity (not copied from any publisher).
 *   - Communicates: event type, location, geographic context, NWS attribution.
 *   - Restrained, readable on mobile, 16:9 / 1200x675.
 *   - No fake disaster imagery. No copyrighted assets. No external image APIs.
 *
 * Reusable for any NWS weather event type (Flood Warning, Tornado Warning,
 * Hurricane Warning, Winter Storm Warning, Heat Advisory, etc.) via an
 * event-theme map.
 *
 * Run manually:
 *   npm run image:nws
 *   (or) bun run image:nws
 */

import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(__dirname, '..');
const DRAFTS_DIR = join(PROJECT_DIR, 'data', 'drafts');
const OUTPUT_DIR = join(PROJECT_DIR, 'data', 'draft-images');

const W = 1200;
const H = 675;

// ===========================================================================
// Event theme configuration — drives color + icon per NWS event type.
// Editable; extend with more event types as needed.
// ===========================================================================
const EVENT_THEMES = {
  'Flood Warning': { accent: '#1f6f8b', accentDark: '#0f4a5e', icon: 'waves' },
  'Flash Flood Warning': { accent: '#2a7a4a', accentDark: '#16502e', icon: 'waves' },
  'Flash Flood Emergency': { accent: '#7a1f3a', accentDark: '#4a0f22', icon: 'waves' },
  'Flood Watch': { accent: '#3a6f8b', accentDark: '#1f4a5e', icon: 'waves' },
  'Coastal Flood Warning': { accent: '#1f5f7a', accentDark: '#0f3a4e', icon: 'waves' },
  'Coastal Flood Watch': { accent: '#3a6f8a', accentDark: '#1f4a5e', icon: 'waves' },
  'Tornado Warning': { accent: '#7a1f3a', accentDark: '#4a0f22', icon: 'tornado' },
  'Tornado Watch': { accent: '#a05a2c', accentDark: '#6e3d1c', icon: 'tornado' },
  'Severe Thunderstorm Warning': { accent: '#7a5a1f', accentDark: '#4e3a0f', icon: 'storm' },
  'Severe Thunderstorm Watch': { accent: '#8a6a2f', accentDark: '#5e4a1c', icon: 'storm' },
  'Hurricane Warning': { accent: '#7a1f3a', accentDark: '#4a0f22', icon: 'hurricane' },
  'Hurricane Watch': { accent: '#a05a2c', accentDark: '#6e3d1c', icon: 'hurricane' },
  'Tropical Storm Warning': { accent: '#2a6f7a', accentDark: '#1a4a52', icon: 'storm' },
  'Tropical Storm Watch': { accent: '#3a7f8a', accentDark: '#1f525a', icon: 'storm' },
  'Storm Surge Warning': { accent: '#1f5f7a', accentDark: '#0f3a4e', icon: 'surge' },
  'Winter Storm Warning': { accent: '#3a5a7a', accentDark: '#1f3a4e', icon: 'snow' },
  'Blizzard Warning': { accent: '#4a5a7a', accentDark: '#2f3a4e', icon: 'snow' },
  'Ice Storm Warning': { accent: '#3a7a8a', accentDark: '#1f4a52', icon: 'snow' },
  'Winter Weather Advisory': { accent: '#5a7a9a', accentDark: '#3a5a6e', icon: 'snow' },
  'Extreme Heat Warning': { accent: '#b5560f', accentDark: '#7a3608', icon: 'sun' },
  'Excessive Heat Warning': { accent: '#b5300f', accentDark: '#7a1c08', icon: 'sun' },
  'Heat Advisory': { accent: '#c87830', accentDark: '#8a4f1c', icon: 'sun' },
  'Extreme Wind Warning': { accent: '#7a4a1f', accentDark: '#4e2f0f', icon: 'wind' },
  'High Wind Warning': { accent: '#7a5a2f', accentDark: '#4e3a1c', icon: 'wind' },
  'Wind Advisory': { accent: '#8a7a4f', accentDark: '#5e523a', icon: 'wind' },
  'Red Flag Warning': { accent: '#b5300f', accentDark: '#7a1c08', icon: 'fire' },
  'Fire Weather Watch': { accent: '#c85530', accentDark: '#8a381c', icon: 'fire' },
  'Dust Storm Warning': { accent: '#8a6a30', accentDark: '#5e4a1c', icon: 'wind' },
  'Tsunami Warning': { accent: '#7a1f3a', accentDark: '#4a0f22', icon: 'waves' },
  'Tsunami Advisory': { accent: '#3a6f7a', accentDark: '#1f4a52', icon: 'waves' },
};

const DEFAULT_THEME = { accent: '#3a5a7a', accentDark: '#1f3a4e', icon: 'alert' };

function themeFor(event) {
  return EVENT_THEMES[event] || DEFAULT_THEME;
}

// ===========================================================================
// U.S. state + county geometry (approximate, for safe location graphics)
// ===========================================================================

/**
 * Approximate U.S. state bounding boxes and a simple centroid, derived from
 * public domain U.S. Census cartographic boundary data. Used ONLY to place a
 * state marker on a generic U.S. silhouette — never for precise boundaries.
 *
 * Values are approximate lat/long of the state centroid and a rough bounding
 * box. This is sufficient for a "where in the U.S." locator graphic.
 */
const STATE_CENTROIDS = {
  AL: { name: 'Alabama', lat: 32.8, lon: -86.8 },
  AK: { name: 'Alaska', lat: 64.7, lon: -152.6 },
  AZ: { name: 'Arizona', lat: 34.3, lon: -111.6 },
  AR: { name: 'Arkansas', lat: 34.8, lon: -92.4 },
  CA: { name: 'California', lat: 37.2, lon: -119.5 },
  CO: { name: 'Colorado', lat: 39.0, lon: -105.5 },
  CT: { name: 'Connecticut', lat: 41.6, lon: -72.7 },
  DE: { name: 'Delaware', lat: 39.0, lon: -75.5 },
  DC: { name: 'District of Columbia', lat: 38.9, lon: -77.0 },
  FL: { name: 'Florida', lat: 28.5, lon: -82.4 },
  GA: { name: 'Georgia', lat: 32.8, lon: -83.3 },
  HI: { name: 'Hawaii', lat: 20.3, lon: -156.4 },
  ID: { name: 'Idaho', lat: 44.4, lon: -114.5 },
  IL: { name: 'Illinois', lat: 40.0, lon: -89.2 },
  IN: { name: 'Indiana', lat: 39.8, lon: -86.3 },
  IA: { name: 'Iowa', lat: 42.0, lon: -93.5 },
  KS: { name: 'Kansas', lat: 38.5, lon: -98.0 },
  KY: { name: 'Kentucky', lat: 37.5, lon: -85.3 },
  LA: { name: 'Louisiana', lat: 30.8, lon: -92.0 },
  ME: { name: 'Maine', lat: 45.3, lon: -69.0 },
  MD: { name: 'Maryland', lat: 39.0, lon: -76.7 },
  MA: { name: 'Massachusetts', lat: 42.3, lon: -71.8 },
  MI: { name: 'Michigan', lat: 44.0, lon: -85.0 },
  MN: { name: 'Minnesota', lat: 46.3, lon: -94.2 },
  MS: { name: 'Mississippi', lat: 32.7, lon: -89.7 },
  MO: { name: 'Missouri', lat: 38.3, lon: -92.5 },
  MT: { name: 'Montana', lat: 47.0, lon: -109.5 },
  NE: { name: 'Nebraska', lat: 41.5, lon: -99.8 },
  NV: { name: 'Nevada', lat: 39.4, lon: -116.9 },
  NH: { name: 'New Hampshire', lat: 43.5, lon: -71.6 },
  NJ: { name: 'New Jersey', lat: 40.1, lon: -74.4 },
  NM: { name: 'New Mexico', lat: 34.3, lon: -106.0 },
  NY: { name: 'New York', lat: 42.8, lon: -75.5 },
  NC: { name: 'North Carolina', lat: 35.5, lon: -79.0 },
  ND: { name: 'North Dakota', lat: 47.5, lon: -100.3 },
  OH: { name: 'Ohio', lat: 40.2, lon: -82.8 },
  OK: { name: 'Oklahoma', lat: 35.5, lon: -97.5 },
  OR: { name: 'Oregon', lat: 43.8, lon: -120.5 },
  PA: { name: 'Pennsylvania', lat: 40.9, lon: -77.7 },
  RI: { name: 'Rhode Island', lat: 41.7, lon: -71.5 },
  SC: { name: 'South Carolina', lat: 33.8, lon: -81.0 },
  SD: { name: 'South Dakota', lat: 44.3, lon: -100.3 },
  TN: { name: 'Tennessee', lat: 35.8, lon: -86.3 },
  TX: { name: 'Texas', lat: 31.5, lon: -99.0 },
  UT: { name: 'Utah', lat: 39.3, lon: -111.7 },
  VT: { name: 'Vermont', lat: 44.0, lon: -72.7 },
  VA: { name: 'Virginia', lat: 37.8, lon: -78.2 },
  WA: { name: 'Washington', lat: 47.4, lon: -120.6 },
  WV: { name: 'West Virginia', lat: 38.5, lon: -80.5 },
  WI: { name: 'Wisconsin', lat: 44.6, lon: -89.7 },
  WY: { name: 'Wyoming', lat: 42.8, lon: -107.3 },
  PR: { name: 'Puerto Rico', lat: 18.2, lon: -66.4 },
};

/**
 * Extract a U.S. state abbreviation from the affected zone URL.
 * NWS zone URLs look like "https://api.weather.gov/zones/county/ILC097".
 * The state abbreviation is the first 2 characters of the zone code (IL).
 */
function stateFromZone(zoneUrl) {
  if (!zoneUrl) return null;
  const m = String(zoneUrl).match(/\/zones\/(?:county|forecast|fire|land|marine|public|offshore|coastal)\/([A-Z]{2})[A-Z0-9]/i);
  return m ? m[1].toUpperCase() : null;
}

/**
 * Extract a county FIPS code from the affected zone URL.
 * "ILC097" → FIPS "17097" (IL=17, 097). Returns { fips, countyName } when the
 * county name is known, or { fips, countyName: null } when not.
 */
const FIPS_BY_STATE = {
  AL: '01', AK: '02', AZ: '04', AR: '05', CA: '06', CO: '08', CT: '09',
  DE: '10', DC: '11', FL: '12', GA: '13', HI: '15', ID: '16', IL: '17',
  IN: '18', IA: '19', KS: '20', KY: '21', LA: '22', ME: '23', MD: '24',
  MA: '25', MI: '26', MN: '27', MS: '28', MO: '29', MT: '30', NE: '31',
  NV: '32', NH: '33', NJ: '34', NM: '35', NY: '36', NC: '37', ND: '38',
  OH: '39', OK: '40', OR: '41', PA: '42', RI: '44', SC: '45', SD: '46',
  TN: '47', TX: '48', UT: '49', VT: '50', VA: '51', WA: '53', WV: '54',
  WI: '55', WY: '56', PR: '72',
};

function countyFromZone(zoneUrl) {
  if (!zoneUrl) return null;
  const m = String(zoneUrl).match(/\/zones\/county\/([A-Z]{2})([A-Z])(\d{3})/i);
  if (!m) return null;
  const stateAbbr = m[1].toUpperCase();
  const stateFips = FIPS_BY_STATE[stateAbbr];
  if (!stateFips) return null;
  const countyFips = stateFips + m[3];
  return { stateAbbr, fips: countyFips, countyName: null };
}

// ===========================================================================
// Icon paths (simple, clean, original line-art)
// ===========================================================================

const ICONS = {
  waves: (cx, cy, scale) => `
    <g transform="translate(${cx} ${cy}) scale(${scale})" fill="none" stroke="#ffffff" stroke-width="3" stroke-linecap="round">
      <path d="M-40 -10 Q-20 -22 0 -10 T40 -10"/>
      <path d="M-40 5 Q-20 -7 0 5 T40 5"/>
      <path d="M-40 20 Q-20 8 0 20 T40 20"/>
    </g>`,
  tornado: (cx, cy, scale) => `
    <g transform="translate(${cx} ${cy}) scale(${scale})" fill="#ffffff">
      <path d="M-35 -25 L35 -25 L25 -8 L20 -8 L28 5 L18 5 L24 18 L14 18 L18 30 L-18 30 L-14 18 L-24 18 L-18 5 L-28 5 L-20 -8 L-25 -8 Z"/>
    </g>`,
  storm: (cx, cy, scale) => `
    <g transform="translate(${cx} ${cy}) scale(${scale})" fill="#ffffff">
      <path d="M-30 -20 Q-40 -20 -40 -10 Q-40 0 -30 0 L25 0 Q38 0 38 -10 Q38 -22 25 -22 Q22 -32 10 -32 Q-5 -32 -10 -22 Q-20 -24 -30 -20 Z"/>
      <path d="M-5 8 L-15 22 L-5 22 L-10 35 L10 18 L0 18 L8 8 Z" fill="#FFD54F"/>
    </g>`,
  hurricane: (cx, cy, scale) => `
    <g transform="translate(${cx} ${cy}) scale(${scale})" fill="none" stroke="#ffffff" stroke-width="3" stroke-linecap="round">
      <circle cx="0" cy="0" r="8" fill="#ffffff"/>
      <path d="M8 0 Q30 -20 15 -35 M-8 0 Q-30 20 -15 35 M0 8 Q20 30 35 15 M0 -8 Q-20 -30 -35 -15"/>
    </g>`,
  surge: (cx, cy, scale) => `
    <g transform="translate(${cx} ${cy}) scale(${scale})" fill="none" stroke="#ffffff" stroke-width="3" stroke-linecap="round">
      <path d="M-40 -5 Q-20 -25 0 -5 T40 -5"/>
      <path d="M-40 15 Q-20 -5 0 15 T40 15"/>
      <path d="M-35 30 L35 30" stroke-dasharray="6 6"/>
    </g>`,
  snow: (cx, cy, scale) => `
    <g transform="translate(${cx} ${cy}) scale(${scale})" fill="none" stroke="#ffffff" stroke-width="2.5" stroke-linecap="round">
      <path d="M0 -30 L0 30 M-26 -15 L26 15 M-26 15 L26 -15"/>
      <path d="M0 -22 L-6 -28 M0 -22 L6 -28 M0 22 L-6 28 M0 22 L6 28"/>
      <path d="M-22 -11 L-29 -13 M-22 -11 L-20 -18 M22 11 L29 13 M22 11 L20 18"/>
      <path d="M-22 11 L-29 13 M-22 11 L-20 18 M22 -11 L29 -13 M22 -11 L20 -18"/>
    </g>`,
  sun: (cx, cy, scale) => `
    <g transform="translate(${cx} ${cy}) scale(${scale})" fill="none" stroke="#ffffff" stroke-width="3" stroke-linecap="round">
      <circle cx="0" cy="0" r="14" fill="#ffffff"/>
      <path d="M0 -28 L0 -22 M0 22 L0 28 M-28 0 L-22 0 M22 0 L28 0"/>
      <path d="M-20 -20 L-16 -16 M16 16 L20 20 M-20 20 L-16 16 M16 -16 L20 -20"/>
    </g>`,
  wind: (cx, cy, scale) => `
    <g transform="translate(${cx} ${cy}) scale(${scale})" fill="none" stroke="#ffffff" stroke-width="3" stroke-linecap="round">
      <path d="M-35 -10 L15 -10 Q28 -10 28 -22 Q28 -32 18 -32"/>
      <path d="M-35 5 L25 5 Q38 5 38 -5 Q38 -15 28 -15"/>
      <path d="M-35 18 L10 18 Q22 18 22 8 Q22 -2 12 -2"/>
    </g>`,
  fire: (cx, cy, scale) => `
    <g transform="translate(${cx} ${cy}) scale(${scale})" fill="#ffffff">
      <path d="M0 -30 Q-18 -10 -18 5 Q-18 22 0 28 Q18 22 18 5 Q18 -10 0 -30 Z M-8 5 Q-8 -2 -2 -8 Q0 0 4 -5 Q8 2 8 8 Q8 18 0 22 Q-8 18 -8 5 Z"/>
    </g>`,
  alert: (cx, cy, scale) => `
    <g transform="translate(${cx} ${cy}) scale(${scale})" fill="#ffffff">
      <path d="M0 -30 L30 25 L-30 25 Z" fill="none" stroke="#ffffff" stroke-width="4" stroke-linejoin="round"/>
      <rect x="-3" y="-8" width="6" height="18" fill="#ffffff"/>
      <circle cx="0" cy="16" r="3.5" fill="#ffffff"/>
    </g>`,
};

// ===========================================================================
// U.S. silhouette path (simplified, original, public-domain-style outline)
// Used as a background locator element. This is a stylized representation,
// not a precise boundary — it communicates "U.S. location" only.
// ===========================================================================

/**
 * A recognizable U.S. (lower 48) outline path in a viewBox of 0 0 1000 580.
 * Constructed to clearly read as the United States with distinctive features:
 * - Florida peninsula in the southeast
 * - Texas tapering in the southwest
 * - Wide northern border (Canada)
 * - West Coast and East Coast both visible
 *
 * Hand-simplified stylized outline — not traced from any copyrighted source.
 */
const US_SILHOUETTE = 'M0.0 11.6 L17.1 104.4 L17.1 220.4 L85.5 336.4 L136.8 406.0 L153.8 406.0 L239.3 429.2 L290.6 452.4 L376.1 475.6 L427.4 498.8 L461.5 545.2 L478.6 545.2 L529.9 522.0 L581.2 475.6 L615.4 452.4 L649.6 452.4 L683.8 475.6 L717.9 452.4 L735.0 498.8 L769.2 545.2 L786.3 568.4 L820.5 568.4 L854.7 522.0 L752.1 475.6 L786.3 382.8 L854.7 313.2 L854.7 266.8 L888.9 220.4 L940.2 174.0 L974.4 127.6 L974.4 58.0 L923.1 81.2 L854.7 104.4 L786.3 150.8 L717.9 174.0 L649.6 174.0 L683.8 104.4 L598.3 34.8 L512.8 11.6 L256.4 11.6 L85.5 11.6 L0.0 11.6 Z';

/**
 * Map a lat/lon to x/y coordinates within the U.S. silhouette viewBox.
 * Approximate equirectangular projection clipped to the contiguous U.S.
 */
function projectLatLon(lat, lon) {
  // Contiguous U.S. approx bounding: lat 24.5–49.5, lon -125 to -66.5
  const minLat = 24.5, maxLat = 49.5;
  const minLon = -125, maxLon = -66.5;
  const x = ((lon - minLon) / (maxLon - minLon)) * 1000;
  const y = (1 - (lat - minLat) / (maxLat - minLat)) * 580;
  return { x: Math.max(0, Math.min(1000, x)), y: Math.max(0, Math.min(580, y)) };
}

// ===========================================================================
// Helpers
// ===========================================================================

function fail(message, detail) {
  console.error(`\n[generate-nws-image] ERROR: ${message}`);
  if (detail) console.error(`  Detail: ${detail}`);
  process.exit(1);
}

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Parse the LOCAL components from an ISO timestamp (preserves original tz).
 */
function parseIsoLocal(iso) {
  if (!iso) return null;
  const m = String(iso).match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})([+-])(\d{2}):(\d{2})$/,
  );
  if (!m) return null;
  return {
    year: parseInt(m[1], 10),
    month: parseInt(m[2], 10),
    day: parseInt(m[3], 10),
    hour: parseInt(m[4], 10),
    minute: parseInt(m[5], 10),
    localDate: new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10)),
  };
}

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

/**
 * Human-friendly date for the graphic: "through Monday afternoon" style.
 * If the NWS WHEN field is available (e.g. "Until Monday afternoon"), use it
 * verbatim. Otherwise derive from the ends timestamp.
 */
function deriveInEffectLabel(draft) {
  // Try to extract the NWS WHEN field from the description.
  const desc = draft.weatherMetadata;
  // The draft doesn't store WHEN directly, but we can re-derive a short label.
  const ends = parseIsoLocal(draft.weatherMetadata.ends || draft.weatherMetadata.expires);
  if (!ends) return null;
  const dayOfWeek = DAY_NAMES[ends.localDate.getDay()];
  const hour = ends.hour;
  let timeOfDay = '';
  if (hour < 12) timeOfDay = 'morning';
  else if (hour < 17) timeOfDay = 'afternoon';
  else if (hour < 21) timeOfDay = 'evening';
  else timeOfDay = 'night';
  return `In effect through ${dayOfWeek} ${timeOfDay}`;
}

/**
 * Extract a river/location name from the draft body or description.
 * For Flood Warnings, the WHERE field typically names the river.
 */
function extractWaterBodyName(draft) {
  // Check the body paragraphs for river/creek mentions.
  const bodyText = draft.body.map((s) => s.paragraphs.join(' ')).join(' ');
  // Match "Des Plaines River" — a capitalized name (1-3 words) followed by
  // River/Creek/Bayou. Handles "along Des Plaines River" and
  // "along the Des Plaines River".
  const riverMatch = bodyText.match(/(?:along|applies to|covers|near)\s+(?:the\s+)?((?:[A-Z][a-zA-Z]+\s+){1,3}(?:River|Creek|Bayou))/);
  if (riverMatch) return riverMatch[1].trim();
  return null;
}

// ===========================================================================
// SVG generation
// ===========================================================================

function buildSvg(draft, theme, locationInfo) {
  const event = draft.weatherMetadata.event || 'Weather Alert';
  const location = draft.location || 'the affected area';
  const inEffectLabel = deriveInEffectLabel(draft);
  const waterBody = extractWaterBodyName(draft);
  const accent = theme.accent;
  const accentDark = theme.accentDark;
  const iconFn = ICONS[theme.icon] || ICONS.alert;

  // State locator data
  const stateAbbr = locationInfo?.stateAbbr;
  const stateInfo = stateAbbr ? STATE_CENTROIDS[stateAbbr] : null;
  const stateProjected = stateInfo ? projectLatLon(stateInfo.lat, stateInfo.lon) : null;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${event} graphic for ${location}">
  <defs>
    <linearGradient id="bgGrad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${accentDark}"/>
      <stop offset="1" stop-color="#0a0f14"/>
    </linearGradient>
    <linearGradient id="accentBar" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${accent}"/>
      <stop offset="1" stop-color="${accentDark}"/>
    </linearGradient>
  </defs>

  <!-- Background -->
  <rect width="${W}" height="${H}" fill="url(#bgGrad)"/>

  <!-- Top accent bar -->
  <rect x="0" y="0" width="${W}" height="8" fill="${accent}"/>

  <!-- Left content column -->
  <g transform="translate(80, 0)">
    <!-- Event icon -->
    ${iconFn(0, 140, 2.2)}

    <!-- Event headline -->
    <text x="0" y="220" font-family="Arial, Helvetica, sans-serif" font-size="58" font-weight="800" fill="#ffffff" letter-spacing="2">${escapeXml(event.toUpperCase())}</text>

    <!-- Accent divider -->
    <rect x="0" y="245" width="80" height="5" fill="${accent}"/>

    <!-- Location -->
    <text x="0" y="295" font-family="Georgia, 'Times New Roman', serif" font-size="38" font-weight="700" fill="#ffffff">${escapeXml(location)}</text>

    <!-- Water body (if applicable) -->
    ${waterBody ? `<text x="0" y="340" font-family="Georgia, serif" font-size="24" font-weight="400" fill="#b8c4cc">${escapeXml(waterBody)}</text>` : ''}

    <!-- In-effect label -->
    ${inEffectLabel ? `<text x="0" y="${waterBody ? 395 : 375}" font-family="Arial, sans-serif" font-size="20" font-weight="600" fill="#8ab4c8">${escapeXml(inEffectLabel)}</text>` : ''}
  </g>

  <!-- Right column: U.S. locator -->
  ${stateProjected ? `
  <g transform="translate(740, 130)">
    <!-- Locator panel background -->
    <rect x="-20" y="-20" width="380" height="360" rx="12" fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.15)" stroke-width="1"/>

    <!-- Locator label -->
    <text x="170" y="15" font-family="Arial, sans-serif" font-size="13" font-weight="700" fill="#8ab4c8" text-anchor="middle" letter-spacing="2">LOCATION</text>

    <!-- Simplified U.S. silhouette -->
    <g transform="translate(20, 40) scale(0.36)">
      <path d="${US_SILHOUETTE}" fill="rgba(255,255,255,0.15)" stroke="rgba(255,255,255,0.4)" stroke-width="2.5"/>
      <!-- State marker -->
      <circle cx="${stateProjected.x}" cy="${stateProjected.y}" r="26" fill="${accent}" opacity="0.35"/>
      <circle cx="${stateProjected.x}" cy="${stateProjected.y}" r="14" fill="${accent}"/>
      <circle cx="${stateProjected.x}" cy="${stateProjected.y}" r="6" fill="#ffffff"/>
    </g>

    <!-- State name below map -->
    <text x="170" y="300" font-family="Arial, sans-serif" font-size="16" font-weight="700" fill="#8ab4c8" text-anchor="middle" letter-spacing="2">${escapeXml(stateInfo ? stateInfo.name.toUpperCase() : '')}</text>
  </g>
  ` : ''}

  <!-- Bottom attribution bar -->
  <rect x="0" y="${H - 56}" width="${W}" height="56" fill="rgba(0,0,0,0.4)"/>

  <!-- NWS attribution -->
  <g transform="translate(80, ${H - 22})">
    <rect x="0" y="-16" width="4" height="20" fill="${accent}"/>
    <text x="14" y="-2" font-family="Arial, sans-serif" font-size="15" font-weight="700" fill="#ffffff" letter-spacing="1">NATIONAL WEATHER SERVICE</text>
    <text x="280" y="-2" font-family="Arial, sans-serif" font-size="13" font-weight="400" fill="#8a949c">Source: NWS alert</text>
  </g>

  <!-- US News Engine branding (subtle, right) -->
  <g transform="translate(${W - 80}, ${H - 22})">
    <text x="0" y="-2" font-family="Georgia, serif" font-size="14" font-weight="700" fill="#ffffff" text-anchor="end" letter-spacing="1">US News Engine</text>
    <text x="0" y="14" font-family="Arial, sans-serif" font-size="10" font-weight="400" fill="#6a747c" text-anchor="end">EDITORIAL GRAPHIC</text>
  </g>
</svg>`;
}

function escapeXml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ===========================================================================
// Main
// ===========================================================================

async function main() {
  console.log('[generate-nws-image] Starting editorial image generation.');

  // --- Load the draft ------------------------------------------------------
  // For Phase 3F, we process the single current draft. The script is reusable:
  // pass a storyKey as argv[2] to target a different draft later.
  const targetStoryKey = process.argv[2] || 'flood-warning__lake-il__2026-09-27';
  const draftPath = join(DRAFTS_DIR, `${targetStoryKey}.json`);
  console.log(`  Draft: ${draftPath}`);

  let raw;
  try {
    raw = await readFile(draftPath, 'utf8');
  } catch (err) {
    return fail('Could not read draft file.', `${draftPath} — ${String(err)}`);
  }
  let draft;
  try {
    draft = JSON.parse(raw);
  } catch (err) {
    return fail('Draft file is not valid JSON.', String(err));
  }

  // --- Determine theme + location info -------------------------------------
  const event = draft.weatherMetadata?.event || 'Weather Alert';
  const theme = themeFor(event);
  console.log(`  Event: ${event} | Theme accent: ${theme.accent} | Icon: ${theme.icon}`);

  // Derive state from the first affected zone (if available).
  const zones = draft.weatherMetadata?.affectedZones || [];
  const firstZone = zones[0];
  const stateAbbr = stateFromZone(firstZone);
  const countyInfo = countyFromZone(firstZone);
  const locationInfo = stateAbbr ? { stateAbbr, ...countyInfo } : null;
  console.log(`  State: ${stateAbbr || 'unknown'} | County FIPS: ${countyInfo?.fips || 'n/a'}`);

  // --- Build the SVG -------------------------------------------------------
  const svg = buildSvg(draft, theme, locationInfo);
  const baseName = draft.slug || targetStoryKey;
  await mkdir(OUTPUT_DIR, { recursive: true });
  const svgPath = join(OUTPUT_DIR, `${baseName}.svg`);
  await writeFile(svgPath, svg, 'utf8');
  console.log(`  SVG written: ${svgPath}`);

  // --- Render PNG with sharp ----------------------------------------------
  const pngPath = join(OUTPUT_DIR, `${baseName}.png`);
  await sharp(Buffer.from(svg))
    .resize(W, H, { fit: 'fill' })
    .png({ quality: 90, compressionLevel: 9 })
    .toFile(pngPath);
  const pngStats = await stat(pngPath);
  console.log(`  PNG written: ${pngPath} (${pngStats.size.toLocaleString()} bytes)`);

  // --- Verify PNG dimensions ----------------------------------------------
  const meta = await sharp(pngPath).metadata();
  console.log(`  PNG dimensions: ${meta.width}x${meta.height}`);

  // --- Image metadata sidecar ---------------------------------------------
  const alt = `${event} graphic for ${draft.location}${extractWaterBodyName(draft) ? `, covering the ${extractWaterBodyName(draft)}` : ''}.`;
  const caption = `An editorial graphic showing a ${event} for ${draft.location}, with a U.S. locator map. Source: National Weather Service.`;
  const metadataDoc = {
    storyKey: draft.storyKey,
    status: 'draft',
    type: 'generated-editorial-graphic',
    width: W,
    height: H,
    source: 'US News Engine',
    dataSource: 'National Weather Service',
    copyrightRisk: 'none-known',
    alt,
    caption,
    generatedAt: new Date().toISOString(),
    files: {
      svg: `data/draft-images/${baseName}.svg`,
      png: `data/draft-images/${baseName}.png`,
    },
  };
  const metaPath = join(OUTPUT_DIR, `${baseName}.json`);
  await writeFile(metaPath, JSON.stringify(metadataDoc, null, 2) + '\n', 'utf8');
  console.log(`  Metadata written: ${metaPath}`);

  // --- Update the draft's image object ------------------------------------
  draft.image = {
    status: 'ready',
    url: null,
    draftPath: `data/draft-images/${baseName}.png`,
    alt,
    source: 'US News Engine',
    dataSource: 'National Weather Service',
    license: 'Original graphic generated by US News Engine from factual NWS data',
  };
  draft.draftVersion = (draft.draftVersion || 1) + 1;
  await writeFile(draftPath, JSON.stringify(draft, null, 2) + '\n', 'utf8');
  console.log(`  Draft updated: ${draftPath} (image.status = ready)`);

  console.log('\n[generate-nws-image] SUCCESS — editorial graphic generated.');
  console.log(`  SVG:        ${svgPath}`);
  console.log(`  PNG:        ${pngPath} (${meta.width}x${meta.height}, ${pngStats.size.toLocaleString()} bytes)`);
  console.log(`  Metadata:   ${metaPath}`);
  console.log(`  Alt text:   ${alt}`);
  console.log(`  No external image API used. No copyrighted assets used.`);
  console.log('');
}

main().catch((err) => fail('Unexpected failure.', String(err && err.stack ? err.stack : err)));
