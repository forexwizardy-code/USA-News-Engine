/**
 * US News Engine — earthquake article hero image generator (Phase 8B).
 *
 * Generates hero images for earthquake article drafts in three modes:
 *
 *   1. ShakeMap path — if the story has a USGS ShakeMap image URL
 *      (shakeMapImageUrl) and hasShakeMap=true, download the official image,
 *      cover-crop to 1200x675 using sharp, and save as .jpg.
 *
 *   2. Coordinate-map path — when no ShakeMap is available, generate an SVG
 *      showing the epicenter at lat/lon, a simplified state/region context,
 *      the magnitude + place + depth + USGS attribution. Render to PNG via
 *      sharp at 1200x675.
 *
 *   3. Earthquake-data graphic fallback — if neither of the above is possible
 *      (no coordinates), generate a clean editorial graphic with just the
 *      magnitude, place, and USGS attribution.
 *
 * Reads data/earthquakes/earthquake-story-records.json (or the test fixture
 * when --fixture is passed) to find the story (by earthquakeKey in argv[2],
 * or the first publishEligible story by default), then writes:
 *   - data/draft-images/<slug>.jpg   (ShakeMap path)
 *   - data/draft-images/<slug>.png  (coordinate-map or fallback graphic path)
 *   - data/draft-images/<slug>.svg  (the source SVG, for editability)
 *   - data/draft-images/<slug>.json (metadata sidecar with provenance)
 *
 * Run manually:
 *   node scripts/generate-earthquake-image.mjs
 *   node scripts/generate-earthquake-image.mjs "<earthquakeKey>"
 *   node scripts/generate-earthquake-image.mjs --fixture
 */

import { readFile, writeFile, mkdir, stat, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(__dirname, '..');
const STORY_RECORDS_FILE = join(
  PROJECT_DIR,
  'data',
  'earthquakes',
  'earthquake-story-records.json',
);
const TEST_FIXTURE_FILE = join(
  PROJECT_DIR,
  'data',
  'earthquakes',
  'test-fixture.json',
);
const OUTPUT_DIR = join(PROJECT_DIR, 'data', 'draft-images');

const W = 1200;
const H = 675;

const USER_AGENT = 'USNewsEngine/1.0 (https://usa-news-engine.forexwizardy.workers.dev)';

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// ===========================================================================
// Helpers
// ===========================================================================

function fail(message, detail) {
  console.error(`\n[generate-earthquake-image] ERROR: ${message}`);
  if (detail) console.error(`  Detail: ${detail}`);
  process.exit(1);
}

function escapeXml(s) {
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

function formatLongDate(iso) {
  const d = parseDate(iso);
  if (!d) return null;
  return `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

function oneDecimal(n) {
  if (n == null || typeof n !== 'number' || !Number.isFinite(n)) return null;
  return n.toFixed(1);
}

function parsePlace(fullPlace) {
  if (!fullPlace) return { distance: null, place: null };
  const text = String(fullPlace).trim();
  const m = text.match(/^([\d.]+\s*km\s+[A-Za-z]+\s+of\s+)(.+)$/i);
  if (m) {
    return { distance: m[1].trim(), place: m[2].trim() };
  }
  return { distance: null, place: text };
}

function buildSlug(magnitude, place, time) {
  const magStr = magnitude != null
    ? `m${String(magnitude).replace('.', '')}`
    : 'earthquake';
  const placeClean = String(place || '')
    .replace(/^[\d.]+\s*km\s+[A-Za-z]+\s+of\s+/i, '')
    .replace(/,\s*/g, '-')
    .replace(/\s+/g, '-');
  const d = parseDate(time);
  const dateStr = d
    ? `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
    : '';
  const parts = [magStr, 'earthquake', placeClean, dateStr].filter(Boolean);
  return parts
    .join('-')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

// ===========================================================================
// ShakeMap download + cover-crop
// ===========================================================================

/**
 * Download a USGS ShakeMap image and cover-crop it to 1200x675 using sharp.
 * Returns the local file path. Throws on failure.
 */
async function downloadAndCropShakeMap(imageUrl, slug) {
  console.log(`  Downloading USGS ShakeMap: ${imageUrl}`);
  const res = await fetch(imageUrl, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'image/*' },
    signal: AbortSignal.timeout(30000),
    redirect: 'follow',
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.startsWith('image/')) {
    throw new Error(`Unexpected content-type: ${contentType}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  console.log(`  Downloaded ${buffer.length.toLocaleString()} bytes (${contentType})`);

  const outPath = join(OUTPUT_DIR, `${slug}.jpg`);
  const tmpPath = `${outPath}.tmp`;
  await sharp(buffer)
    .resize(W, H, {
      fit: 'cover',
      position: 'attention',
      withoutEnlargement: false,
    })
    .jpeg({ quality: 88, mozjpeg: true, chromaSubsampling: '4:2:0' })
    .toFile(tmpPath);
  await rename(tmpPath, outPath);

  const stats = await stat(outPath);
  const meta = await sharp(outPath).metadata();
  console.log(`  Output: ${outPath} (${stats.size.toLocaleString()} bytes, ${meta.width}x${meta.height})`);

  return outPath;
}

// ===========================================================================
// Coordinate-map SVG (no ShakeMap available)
// ===========================================================================

/**
 * Project a lat/lon coordinate to x/y in the inner map area.
 *
 * The map area shows a continental-U.S.-centered viewport with a wider range
 * for Alaska/Hawaii/Puerto Rico coverage. We use an equirectangular projection
 * clamped to the map window.
 *
 * @param {number} lat
 * @param {number} lon
 * @param {{latMin:number,latMax:number,lonMin:number,lonMax:number,x:number,y:number,w:number,h:number}} viewport
 */
function projectLatLon(lat, lon, vp) {
  const latRange = vp.latMax - vp.latMin;
  const lonRange = vp.lonMax - vp.lonMin;
  const x = vp.x + ((lon - vp.lonMin) / lonRange) * vp.w;
  // Y is inverted (north is up; latitude increases northward).
  const y = vp.y + ((vp.latMax - lat) / latRange) * vp.h;
  return { x, y };
}

/**
 * Choose a viewport centered roughly on the epicenter, with a sensible zoom
 * level. Lower-48 events get a CONUS viewport; Alaska events get an Alaska
 * viewport; Hawaii / Puerto Rico get their own. International events get a
 * wider world-ish viewport centered on the epicenter.
 *
 * Returns the viewport bounds AND a label describing the region for the SVG.
 */
function chooseViewport(story) {
  const state = (story.state || '').toLowerCase();
  const country = (story.country || '').toLowerCase();
  const lat = typeof story.latitude === 'number' ? story.latitude : null;
  const lon = typeof story.longitude === 'number' ? story.longitude : null;

  // Viewport definitions — lat/lon bounds + map window position.
  const MAP_X = 60;
  const MAP_Y = 110;
  const MAP_W = 1080;
  const MAP_H = 480;

  if (state === 'alaska' || (lat != null && lat >= 55 && lon <= -130)) {
    return {
      region: 'Alaska',
      vp: { latMin: 51, latMax: 71, lonMin: -180, lonMax: -130, x: MAP_X, y: MAP_Y, w: MAP_W, h: MAP_H },
    };
  }
  if (state === 'hawaii' || (lat != null && lat >= 18 && lat <= 23 && lon >= -161 && lon <= -154)) {
    return {
      region: 'Hawaii',
      vp: { latMin: 18.5, latMax: 22.5, lonMin: -160.5, lonMax: -154.5, x: MAP_X, y: MAP_Y, w: MAP_W, h: MAP_H },
    };
  }
  if (state === 'puerto rico' || (lat != null && lat >= 17 && lat <= 19 && lon >= -68 && lon <= -65)) {
    return {
      region: 'Puerto Rico',
      vp: { latMin: 17.5, latMax: 18.7, lonMin: -67.5, lonMax: -65.5, x: MAP_X, y: MAP_Y, w: MAP_W, h: MAP_H },
    };
  }
  if (country === 'united states' || state) {
    // CONUS viewport
    return {
      region: state ? story.state : 'United States',
      vp: { latMin: 24, latMax: 50, lonMin: -125, lonMax: -66, x: MAP_X, y: MAP_Y, w: MAP_W, h: MAP_H },
    };
  }
  // International — center on the epicenter with a generous window.
  if (lat != null && lon != null) {
    const span = 30; // degrees window
    return {
      region: story.country || 'the region',
      vp: {
        latMin: lat - span / 2,
        latMax: lat + span / 2,
        lonMin: lon - span / 2,
        lonMax: lon + span / 2,
        x: MAP_X, y: MAP_Y, w: MAP_W, h: MAP_H,
      },
    };
  }
  // Last-resort: a CONUS-style viewport with no epicenter.
  return {
    region: 'United States',
    vp: { latMin: 24, latMax: 50, lonMin: -125, lonMax: -66, x: MAP_X, y: MAP_Y, w: MAP_W, h: MAP_H },
  };
}

/**
 * Build a simplified, schematic outline for a U.S. state or region. This is
 * NOT a precise cartographic boundary — it's a stylized locator shape used
 * purely for visual context. The epicenter marker is positioned by lat/lon.
 *
 * For now, we draw a generic rounded rectangle as the "region" backdrop, with
 * the state/region name as a label. A future enhancement could trace actual
 * public-domain boundary polygons.
 */
function buildRegionBackdrop(viewport, region) {
  const vp = viewport.vp;
  // A subtle border around the map window. The actual region shape is implied
  // by the lat/lon gridlines (drawn below).
  return `
  <!-- Map window border -->
  <rect x="${vp.x}" y="${vp.y}" width="${vp.w}" height="${vp.h}" fill="#f4f6f8" stroke="#cfd6dd" stroke-width="2" rx="4"/>
  <!-- Lat/lon gridlines (every 10°) -->
  <g stroke="#e0e4e8" stroke-width="1" stroke-dasharray="2 4">
    ${buildGridlines(vp)}
  </g>
  <!-- Region label -->
  <text x="${vp.x + 12}" y="${vp.y + 22}" font-family="Arial, sans-serif" font-size="13" font-weight="700" fill="#5a6470" letter-spacing="1">${escapeXml((region || 'REGION').toUpperCase())}</text>
  `;
}

function buildGridlines(vp) {
  const lines = [];
  const latStep = 10;
  const lonStep = 10;
  // Round gridline starts to multiples of 10 within the viewport.
  const latStart = Math.ceil(vp.latMin / latStep) * latStep;
  for (let lat = latStart; lat < vp.latMax; lat += latStep) {
    const { y } = projectLatLon(lat, vp.lonMin, vp);
    lines.push(`<line x1="${vp.x}" y1="${y}" x2="${vp.x + vp.w}" y2="${y}"/>`);
  }
  const lonStart = Math.ceil(vp.lonMin / lonStep) * lonStep;
  for (let lon = lonStart; lon < vp.lonMax; lon += lonStep) {
    const { x } = projectLatLon(vp.latMin, lon, vp);
    lines.push(`<line x1="${x}" y1="${vp.y}" x2="${x}" y2="${vp.y + vp.h}"/>`);
  }
  return lines.join('\n    ');
}

/**
 * Build the epicenter marker — concentric pulsing rings + a solid dot.
 */
function buildEpicenterMarker(lat, lon, viewport, mag) {
  if (lat == null || lon == null) return '';
  const { x, y } = projectLatLon(lat, lon, viewport.vp);
  // Marker size scales with magnitude (subtly).
  const r = mag != null ? Math.max(8, Math.min(22, 6 + mag * 2)) : 12;
  return `
  <!-- Epicenter marker -->
  <g transform="translate(${x.toFixed(1)} ${y.toFixed(1)})">
    <circle r="${r * 2.5}" fill="#c8102e" fill-opacity="0.10"/>
    <circle r="${r * 1.7}" fill="#c8102e" fill-opacity="0.20"/>
    <circle r="${r}" fill="#c8102e" fill-opacity="0.35"/>
    <circle r="${r * 0.5}" fill="#c8102e"/>
    <line x1="${-r * 3}" y1="0" x2="${-r * 1.2}" y2="0" stroke="#c8102e" stroke-width="1.5"/>
    <line x1="${r * 1.2}" y1="0" x2="${r * 3}" y2="0" stroke="#c8102e" stroke-width="1.5"/>
    <line x1="0" y1="${-r * 3}" x2="0" y2="${-r * 1.2}" stroke="#c8102e" stroke-width="1.5"/>
    <line x1="0" y1="${r * 1.2}" x2="0" y2="${r * 3}" stroke="#c8102e" stroke-width="1.5"/>
  </g>`;
}

/**
 * Build the coordinate-map SVG. Combines a region backdrop, gridlines,
 * epicenter marker, headline + place + depth + USGS attribution + US News
 * Engine branding.
 */
function buildCoordinateMapSvg(story, slug) {
  const mag = oneDecimal(story.magnitude) || '—';
  const placeInfo = parsePlace(story.place);
  const placeStr = placeInfo.place || story.place || 'an area';
  const depth = oneDecimal(story.depthKm);
  const lat = typeof story.latitude === 'number' ? story.latitude : null;
  const lon = typeof story.longitude === 'number' ? story.longitude : null;
  const dateStr = formatLongDate(story.time) || '';

  const viewport = chooseViewport(story);

  // Format coordinates for the readout.
  const coordStr = (lat != null && lon != null)
    ? `${Math.abs(lat).toFixed(4)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(4)}°${lon >= 0 ? 'E' : 'W'}`
    : 'Coordinates unavailable';

  // Headline line: "M5.2 EARTHQUAKE"
  const headlineStr = `M${mag} EARTHQUAKE`;

  // Pulsing epicenter animation is omitted (static PNG). The visual emphasis
  // comes from the concentric rings.

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Map showing the epicenter of a magnitude ${escapeXml(mag)} earthquake near ${escapeXml(placeStr)}">
  <defs>
    <linearGradient id="headerGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#0f1c2c"/>
      <stop offset="1" stop-color="#0a1320"/>
    </linearGradient>
  </defs>

  <!-- Background -->
  <rect width="${W}" height="${H}" fill="#ffffff"/>

  <!-- Top accent strip -->
  <rect x="0" y="0" width="${W}" height="6" fill="#c8102e"/>

  <!-- Top header band -->
  <rect x="0" y="6" width="${W}" height="78" fill="url(#headerGrad)"/>

  <!-- Eyebrow + headline -->
  <g transform="translate(60, 38)">
    <text x="0" y="0" font-family="Arial, sans-serif" font-size="13" font-weight="800" fill="#ff6b7a" letter-spacing="3">U.S. GEOLOGICAL SURVEY · EARTHQUAKE</text>
    <text x="0" y="32" font-family="Arial, Helvetica, sans-serif" font-size="36" font-weight="900" fill="#ffffff" letter-spacing="2">${escapeXml(headlineStr)}</text>
  </g>

  <!-- Right-side metadata readout -->
  <g transform="translate(${W - 60}, 38)" text-anchor="end">
    <text x="0" y="0" font-family="Arial, sans-serif" font-size="11" font-weight="700" fill="#9aa6b2" letter-spacing="2">${escapeXml(dateStr.toUpperCase())}</text>
    <text x="0" y="32" font-family="Arial, sans-serif" font-size="14" font-weight="600" fill="#ffffff">${escapeXml(coordStr)}</text>
  </g>

  <!-- Map window + gridlines + region label -->
  ${buildRegionBackdrop(viewport, viewport.region)}

  <!-- Epicenter marker -->
  ${buildEpicenterMarker(lat, lon, viewport, story.magnitude)}

  <!-- Place + depth callout (left bottom) -->
  <g transform="translate(60, ${H - 110})">
    <rect x="-4" y="-22" width="4" height="56" fill="#c8102e"/>
    <text x="12" y="-6" font-family="Arial, sans-serif" font-size="11" font-weight="700" fill="#6b7178" letter-spacing="2">EPICENTER</text>
    <text x="12" y="14" font-family="Georgia, 'Times New Roman', serif" font-size="22" font-weight="700" fill="#14161a">${escapeXml(placeStr)}</text>
    <text x="12" y="34" font-family="Arial, sans-serif" font-size="13" font-weight="400" fill="#5a6470">${depth != null ? `Depth: ${depth} km` : ''}${depth != null && story.state ? ' · ' : ''}${escapeXml(story.state || '')}</text>
  </g>

  <!-- Magnitude + tsunami/alert callout (right bottom) -->
  <g transform="translate(${W - 60}, ${H - 110})" text-anchor="end">
    <text x="0" y="-6" font-family="Arial, sans-serif" font-size="11" font-weight="700" fill="#6b7178" letter-spacing="2">MAGNITUDE</text>
    <text x="0" y="32" font-family="Arial, Helvetica, sans-serif" font-size="40" font-weight="900" fill="#c8102e">M${escapeXml(mag)}</text>
    ${story.tsunami === true ? `<text x="0" y="52" font-family="Arial, sans-serif" font-size="12" font-weight="700" fill="#c8102e" letter-spacing="1">TSUNAMI FLAG</text>` : ''}
    ${story.alert && story.alert !== 'green' ? `<text x="0" y="${story.tsunami === true ? 68 : 52}" font-family="Arial, sans-serif" font-size="12" font-weight="700" fill="#c8102e" letter-spacing="1">PAGER ALERT: ${escapeXml(story.alert.toUpperCase())}</text>` : ''}
  </g>

  <!-- USGS attribution + US News Engine branding (bottom strip) -->
  <rect x="0" y="${H - 36}" width="${W}" height="36" fill="#0f1c2c"/>
  <text x="60" y="${H - 14}" font-family="Arial, sans-serif" font-size="12" font-weight="600" fill="#9aa6b2">Source: U.S. Geological Survey · earthquake.usgs.gov</text>
  <text x="${W - 60}" y="${H - 14}" font-family="Georgia, serif" font-size="14" font-weight="700" fill="#ffffff" text-anchor="end">US News Engine</text>
  <text x="${W - 200}" y="${H - 14}" font-family="Arial, sans-serif" font-size="10" font-weight="400" fill="#5a6470" text-anchor="end" letter-spacing="0.5">EDITORIAL DATA GRAPHIC</text>
</svg>`;
}

/**
 * Build a fallback earthquake-data graphic (used when no coordinates are
 * available). Shows magnitude, place, depth, USGS attribution, US News
 * Engine branding.
 */
function buildFallbackGraphicSvg(story, slug) {
  const mag = oneDecimal(story.magnitude) || '—';
  const placeStr = parsePlace(story.place).place || story.place || 'an area';
  const depth = oneDecimal(story.depthKm);
  const dateStr = formatLongDate(story.time) || '';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Earthquake data graphic for a magnitude ${escapeXml(mag)} event near ${escapeXml(placeStr)}">
  <defs>
    <linearGradient id="panelGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#0f1c2c"/>
      <stop offset="1" stop-color="#07315a"/>
    </linearGradient>
  </defs>

  <!-- Background -->
  <rect width="${W}" height="${H}" fill="#f4f5f3"/>

  <!-- Left dark panel -->
  <rect x="0" y="0" width="520" height="${H}" fill="url(#panelGrad)"/>

  <!-- Top accent strip -->
  <rect x="0" y="0" width="${W}" height="8" fill="#c8102e"/>

  <!-- Eyebrow + headline -->
  <g transform="translate(50, 70)">
    <text x="0" y="0" font-family="Arial, sans-serif" font-size="14" font-weight="800" fill="#ff6b7a" letter-spacing="4">EARTHQUAKE REPORT</text>
    <rect x="0" y="14" width="60" height="3" fill="#c8102e"/>
  </g>

  <!-- Big magnitude -->
  <text x="50" y="200" font-family="Arial, Helvetica, sans-serif" font-size="120" font-weight="900" fill="#ffffff" letter-spacing="2">M${escapeXml(mag)}</text>
  <text x="50" y="240" font-family="Arial, sans-serif" font-size="16" font-weight="600" fill="#9aa6b2" letter-spacing="2">MAGNITUDE</text>

  <!-- Place + date (left panel, lower) -->
  <g transform="translate(50, 290)">
    <text x="0" y="0" font-family="Arial, sans-serif" font-size="11" font-weight="700" fill="#ff6b7a" letter-spacing="2">LOCATION</text>
    <text x="0" y="28" font-family="Georgia, 'Times New Roman', serif" font-size="22" font-weight="700" fill="#ffffff">${escapeXml(placeStr)}</text>
    ${story.state ? `<text x="0" y="56" font-family="Arial, sans-serif" font-size="14" font-weight="400" fill="#b8c0c8">${escapeXml(story.state)}</text>` : ''}
  </g>

  <!-- Date + depth (left panel, bottom) -->
  <g transform="translate(50, ${H - 130})">
    <text x="0" y="0" font-family="Arial, sans-serif" font-size="11" font-weight="700" fill="#ff6b7a" letter-spacing="2">DATE (UTC)</text>
    <text x="0" y="22" font-family="Arial, sans-serif" font-size="16" font-weight="600" fill="#ffffff">${escapeXml(dateStr)}</text>
    ${depth != null ? `<text x="0" y="56" font-family="Arial, sans-serif" font-size="11" font-weight="700" fill="#ff6b7a" letter-spacing="2">DEPTH</text>` : ''}
    ${depth != null ? `<text x="0" y="78" font-family="Arial, sans-serif" font-size="16" font-weight="600" fill="#ffffff">${depth} km</text>` : ''}
  </g>

  <!-- USGS attribution (left panel, bottom) -->
  <text x="50" y="${H - 22}" font-family="Georgia, serif" font-size="14" font-weight="700" fill="#ffffff">US News Engine</text>
  <text x="180" y="${H - 22}" font-family="Arial, sans-serif" font-size="10" font-weight="400" fill="#8a94a0" letter-spacing="0.5">EDITORIAL DATA GRAPHIC</text>

  <!-- Right light panel -->
  <rect x="520" y="0" width="${W - 520}" height="${H}" fill="#ffffff"/>

  <!-- Alert / tsunami callouts (right panel, top) -->
  <g transform="translate(560, 70)">
    <text x="0" y="0" font-family="Arial, sans-serif" font-size="11" font-weight="700" fill="#6b7178" letter-spacing="2">USGS ALERT</text>
    ${story.alert && story.alert !== 'green'
      ? `<rect x="0" y="14" width="${Math.min((story.alert || '').length * 11 + 32, 320)}" height="32" rx="3" fill="#c8102e"/><text x="${Math.min((story.alert || '').length * 11 + 32, 320) / 2}" y="35" font-family="Arial, sans-serif" font-size="14" font-weight="800" fill="#ffffff" text-anchor="middle" letter-spacing="1">${escapeXml((story.alert || '').toUpperCase())} PAGER</text>`
      : `<rect x="0" y="14" width="120" height="32" rx="3" fill="#3a6f8b"/><text x="60" y="35" font-family="Arial, sans-serif" font-size="14" font-weight="800" fill="#ffffff" text-anchor="middle" letter-spacing="1">NO ALERT</text>`}
  </g>

  <!-- Tsunami flag (right panel, middle) -->
  ${story.tsunami === true ? `
  <g transform="translate(560, 160)">
    <text x="0" y="0" font-family="Arial, sans-serif" font-size="11" font-weight="700" fill="#6b7178" letter-spacing="2">TSUNAMI</text>
    <rect x="0" y="14" width="220" height="32" rx="3" fill="#c8102e"/>
    <text x="110" y="35" font-family="Arial, sans-serif" font-size="14" font-weight="800" fill="#ffffff" text-anchor="middle" letter-spacing="1">TSUNAMI FLAG</text>
  </g>` : ''}

  <!-- Right-panel US News Engine branding (bottom right) -->
  <text x="${W - 50}" y="${H - 24}" font-family="Georgia, serif" font-size="14" font-weight="700" fill="#14161a" text-anchor="end">US News Engine</text>
  <text x="${W - 50}" y="${H - 10}" font-family="Arial, sans-serif" font-size="9" font-weight="400" fill="#8a8f96" text-anchor="end" letter-spacing="0.5">EDITORIAL DATA GRAPHIC</text>
</svg>`;
}

// ===========================================================================
// Metadata sidecar builder
// ===========================================================================

function buildMetadata({
  story, slug, mode, imagePath, imageFilename,
  originalImageUrl, caption, alt, generatedAt,
}) {
  const mag = oneDecimal(story.magnitude) || '—';
  return {
    earthquakeKey: story.earthquakeKey,
    eventId: story.eventId || story.sourceId || null,
    slug,
    status: 'draft',
    type: mode === 'shakemap' ? 'official-usgs-shakemap' : 'generated-coordinate-map',
    visualType: mode === 'shakemap' ? 'usgs-shakemap' : 'earthquake-coordinate-map',
    imageMode: mode,
    width: W,
    height: H,
    source: mode === 'shakemap'
      ? 'U.S. Geological Survey (official ShakeMap)'
      : 'US News Engine (editorial data graphic)',
    dataSource: 'U.S. Geological Survey',
    agency: 'U.S. Geological Survey',
    agencyShort: 'USGS',
    sourceUrl: story.url || null,
    originalImageUrl: originalImageUrl || null,
    caption,
    alt,
    copyrightRisk: mode === 'shakemap'
      ? 'none-known (U.S. government work — USGS ShakeMap images are public domain)'
      : 'none-known (original graphic generated by US News Engine)',
    licenseNotes: mode === 'shakemap'
      ? 'Official USGS ShakeMap. USGS products are works of the U.S. federal government and are in the public domain.'
      : 'Original editorial graphic generated by US News Engine. Coordinates and magnitude derived from USGS data.',
    magnitude: story.magnitude,
    depth: story.depthKm,
    place: story.place,
    testOnly: story.testOnly === true,
    generatedAt,
    files: {
      image: `data/draft-images/${imageFilename}`,
    },
  };
}

// ===========================================================================
// Main
// ===========================================================================

async function main() {
  console.log('[generate-earthquake-image] Starting earthquake image generation.');

  const args = process.argv.slice(2);
  const useFixture = args.includes('--fixture');
  const positionalArgs = args.filter((a) => !a.startsWith('--'));
  const targetKey = positionalArgs[0] || null;

  let story = null;

  if (useFixture) {
    console.log(`  Loading test fixture: ${TEST_FIXTURE_FILE}`);
    let raw;
    try {
      raw = await readFile(TEST_FIXTURE_FILE, 'utf8');
    } catch (err) {
      return fail('Could not read test fixture file.', String(err));
    }
    try {
      story = JSON.parse(raw);
    } catch (err) {
      return fail('Test fixture file is not valid JSON.', String(err));
    }
    console.log(`  Using fixture: ${story.earthquakeKey}`);
  } else {
    let raw;
    try {
      raw = await readFile(STORY_RECORDS_FILE, 'utf8');
    } catch (err) {
      return fail(
        'Could not read story-records file. Run `npm run stories:earthquakes` first.',
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
      return fail('No earthquake stories available.');
    }

    if (targetKey) {
      story = stories.find((s) => s.earthquakeKey === targetKey) || null;
      if (!story) {
        return fail(
          `Story not found: ${targetKey}`,
          `Available: ${stories.map((s) => s.earthquakeKey).slice(0, 5).join(', ')}...`,
        );
      }
    } else {
      story = stories.find((s) => s.publishEligible === true) || null;
      if (!story) {
        return fail(
          'No publishEligible stories available. Pass a storyKey explicitly or use --fixture.',
        );
      }
    }
  }

  console.log(`  Selected story: ${story.earthquakeKey}`);
  console.log(`  Magnitude: ${story.magnitude} | Place: ${story.place || 'n/a'}`);

  // Derive slug (matches the draft generator's slug exactly).
  const slug = buildSlug(story.magnitude, story.place, story.time);
  console.log(`  Slug: ${slug}`);

  await mkdir(OUTPUT_DIR, { recursive: true });
  const generatedAt = new Date().toISOString();

  // =========================================================================
  // Decide image path
  // =========================================================================
  const hasShakeMap = story.hasShakeMap === true && typeof story.shakeMapImageUrl === 'string' && story.shakeMapImageUrl.length > 0;

  if (hasShakeMap) {
    // =====================================================================
    // ShakeMap path — download + cover-crop
    // =====================================================================
    console.log('\n  --- USGS ShakeMap path ---');
    console.log(`  ShakeMap URL: ${story.shakeMapImageUrl}`);

    let imagePath;
    let imageFilename;
    let mode = 'shakemap';
    try {
      imagePath = await downloadAndCropShakeMap(story.shakeMapImageUrl, slug);
      imageFilename = `${slug}.jpg`;
    } catch (err) {
      console.warn(`  ShakeMap download failed: ${String(err.message || err)}`);
      console.warn('  Falling back to coordinate-map path.');
      mode = 'coordinate-map';
      const svg = buildCoordinateMapSvg(story, slug);
      const svgPath = join(OUTPUT_DIR, `${slug}.svg`);
      await writeFile(svgPath, svg, 'utf8');
      console.log(`  SVG: ${svgPath}`);
      imagePath = join(OUTPUT_DIR, `${slug}.png`);
      imageFilename = `${slug}.png`;
      const tmpPath = `${imagePath}.tmp`;
      await sharp(Buffer.from(svg))
        .resize(W, H, { fit: 'fill' })
        .png({ quality: 90, compressionLevel: 9 })
        .toFile(tmpPath);
      await rename(tmpPath, imagePath);
      const stats = await stat(imagePath);
      const meta = await sharp(imagePath).metadata();
      console.log(`  PNG: ${imagePath} (${stats.size.toLocaleString()} bytes, ${meta.width}x${meta.height})`);
    }

    const mag = oneDecimal(story.magnitude) || '—';
    const placeStr = parsePlace(story.place).place || story.place || 'an area';
    const alt = mode === 'shakemap'
      ? `Official USGS ShakeMap for the magnitude ${mag} earthquake near ${placeStr}.`
      : `Epicenter map for the magnitude ${mag} earthquake near ${placeStr}.`;
    const caption = mode === 'shakemap'
      ? `USGS ShakeMap showing shaking intensity for the magnitude ${mag} earthquake near ${placeStr}. Graphic: U.S. Geological Survey.`
      : `Epicenter map for the magnitude ${mag} earthquake near ${placeStr}. Graphic: US News Engine / USGS data.`;

    const metadata = buildMetadata({
      story, slug, mode,
      imagePath, imageFilename,
      originalImageUrl: mode === 'shakemap' ? story.shakeMapImageUrl : null,
      caption, alt, generatedAt,
    });
    const metaPath = join(OUTPUT_DIR, `${slug}.json`);
    const tmpMeta = `${metaPath}.tmp`;
    await writeFile(tmpMeta, JSON.stringify(metadata, null, 2) + '\n', 'utf8');
    await rename(tmpMeta, metaPath);
    console.log(`  Metadata: ${metaPath}`);
    console.log('\n[generate-earthquake-image] SUCCESS.');
    console.log(`  Image:     ${imagePath}`);
    console.log(`  Metadata:  ${metaPath}`);
    if (mode === 'shakemap') console.log(`  ShakeMap URL: ${story.shakeMapImageUrl}`);
    console.log('');
    return;
  }

  // =========================================================================
  // Coordinate-map path (no ShakeMap available)
  // =========================================================================
  console.log('\n  --- Coordinate-map path ---');
  console.log(`  hasShakeMap=${story.hasShakeMap === true}, shakeMapImageUrl=${story.shakeMapImageUrl || 'null'}`);

  const hasCoordinates = typeof story.latitude === 'number' && typeof story.longitude === 'number';
  const svg = hasCoordinates
    ? buildCoordinateMapSvg(story, slug)
    : buildFallbackGraphicSvg(story, slug);
  const mode = hasCoordinates ? 'coordinate-map' : 'fallback-graphic';

  const svgPath = join(OUTPUT_DIR, `${slug}.svg`);
  await writeFile(svgPath, svg, 'utf8');
  console.log(`  SVG: ${svgPath}`);

  const imagePath = join(OUTPUT_DIR, `${slug}.png`);
  const imageFilename = `${slug}.png`;
  const tmpPath = `${imagePath}.tmp`;
  await sharp(Buffer.from(svg))
    .resize(W, H, { fit: 'fill' })
    .png({ quality: 90, compressionLevel: 9 })
    .toFile(tmpPath);
  await rename(tmpPath, imagePath);

  const stats = await stat(imagePath);
  const meta = await sharp(imagePath).metadata();
  console.log(`  PNG: ${imagePath} (${stats.size.toLocaleString()} bytes, ${meta.width}x${meta.height})`);

  const mag = oneDecimal(story.magnitude) || '—';
  const placeStr = parsePlace(story.place).place || story.place || 'an area';
  const alt = hasCoordinates
    ? `Epicenter map for the magnitude ${mag} earthquake near ${placeStr}.`
    : `Earthquake data graphic for the magnitude ${mag} event near ${placeStr}.`;
  const caption = hasCoordinates
    ? `Epicenter map for the magnitude ${mag} earthquake near ${placeStr}. Graphic: US News Engine / USGS data.`
    : `Earthquake data graphic for the magnitude ${mag} event near ${placeStr}. Graphic: US News Engine / USGS data.`;

  const metadata = buildMetadata({
    story, slug, mode,
    imagePath, imageFilename,
    caption, alt, generatedAt,
  });
  const metaPath = join(OUTPUT_DIR, `${slug}.json`);
  const tmpMeta = `${metaPath}.tmp`;
  await writeFile(tmpMeta, JSON.stringify(metadata, null, 2) + '\n', 'utf8');
  await rename(tmpMeta, metaPath);
  console.log(`  Metadata: ${metaPath}`);

  console.log('\n[generate-earthquake-image] SUCCESS.');
  console.log(`  Image:     ${imagePath}`);
  console.log(`  Metadata:  ${metaPath}`);
  console.log('');
}

main().catch((err) =>
  fail('Unexpected failure.', String(err && err.stack ? err.stack : err)),
);
