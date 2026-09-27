/**
 * US News Engine — recall article hero image generator (Phase 7B).
 *
 * Generates hero images for recall article drafts in two modes:
 *
 *   1. CPSC photo path — if the story has imageUrls from the official CPSC
 *      recall record, download the first image, cover-crop to 1200x675
 *      (no distortion), and save as a .jpg. Preserves the original image
 *      URL, source URL, agency, caption, and alt text in a metadata JSON.
 *
 *   2. Editorial graphic path — for FDA recalls (no images available) and
 *      for CPSC recalls without imageUrls, generate a clean, factual
 *      newsroom-style recall notice as SVG → PNG via sharp. The graphic
 *      carries the product name, recalling firm, FDA/CPSC attribution,
 *      classification (when known), hazard/reason, and subtle US News
 *      Engine branding. No fake product photography, no fake agency logos.
 *
 * Reads data/recalls/recall-story-clusters.json to find the story (by
 * storyKey in argv[2], or stories[0] by default), then writes:
 *   - data/draft-images/<slug>.jpg   (CPSC photo path)
 *   - data/draft-images/<slug>.png  (editorial graphic path)
 *   - data/draft-images/<slug>.json (metadata sidecar with provenance)
 *
 * Run manually:
 *   node scripts/generate-recall-image.mjs
 *   node scripts/generate-recall-image.mjs "<storyKey>"
 */

import { readFile, writeFile, mkdir, stat, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(__dirname, '..');
const CLUSTERS_FILE = join(
  PROJECT_DIR,
  'data',
  'recalls',
  'recall-story-clusters.json',
);
const OUTPUT_DIR = join(PROJECT_DIR, 'data', 'draft-images');

const W = 1200;
const H = 675;

const USER_AGENT = 'USNewsEngine/1.0 (https://usa-news-engine.forexwizardy.workers.dev)';

// ===========================================================================
// Helpers
// ===========================================================================

function fail(message, detail) {
  console.error(`\n[generate-recall-image] ERROR: ${message}`);
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

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function formatLongDate(iso) {
  const d = parseDate(iso);
  if (!d) return null;
  return `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

function agencyName(source) {
  if (source === 'CPSC') return 'Consumer Product Safety Commission';
  if (source === 'FDA') return 'U.S. Food and Drug Administration';
  return source || 'the recalling agency';
}

function agencyShort(source) {
  if (source === 'CPSC') return 'CPSC';
  if (source === 'FDA') return 'FDA';
  return source || 'the agency';
}

// ===========================================================================
// Headline / short-name helpers (mirror the draft generator)
// ===========================================================================

function titleCaseProduct(text) {
  if (!text) return '';
  const cleaned = String(text).replace(/[_-]+/g, ' ').trim();
  const tokens = cleaned.split(/\s+/);
  return tokens
    .map((tok) => {
      if (/^[A-Z0-9]+$/.test(tok)) return tok;
      if (/^[A-Za-z]+\d+$|^\d+[A-Za-z]+$/.test(tok)) return tok;
      return tok.charAt(0).toUpperCase() + tok.slice(1).toLowerCase();
    })
    .join(' ');
}

function shortProductName(story) {
  const storyKeyParts = String(story.recallStoryKey || '').split('__');
  const productSlug = storyKeyParts[3] || '';
  return titleCaseProduct(productSlug);
}

function parseCpscTitleBrand(title) {
  if (!title) return null;
  const m = String(title).match(/^([^,]+?)\s+Recalls\s+(.+?)\s+Due\s+To\b/i);
  if (!m) return null;
  let brand = m[1].trim();
  let product = m[2].trim();
  product = product.replace(/;.*$/, '').trim();
  return { brand, product };
}

function recallingFirmDisplay(story) {
  if (story.recallingFirm) return story.recallingFirm;
  if (story.brands && story.brands.length > 0) return story.brands[0];
  if (story.source === 'CPSC') {
    const cpscTitle = story.rawSourceData?.[0]?.title || '';
    const parsed = parseCpscTitleBrand(cpscTitle);
    if (parsed) return parsed.brand;
  }
  return null;
}

const HAZARD_LABEL_RULES = [
  { kw: 'carbon monoxide', label: 'Carbon Monoxide Hazard' },
  { kw: 'choking', label: 'Choking Hazard' },
  { kw: 'strangulation', label: 'Strangulation Hazard' },
  { kw: 'suffocation', label: 'Suffocation Hazard' },
  { kw: 'laceration', label: 'Laceration Hazard' },
  { kw: 'amputation', label: 'Amputation Hazard' },
  { kw: 'tip-over', label: 'Tip-Over Hazard' },
  { kw: 'electric shock', label: 'Electric Shock Hazard' },
  { kw: 'shock', label: 'Electric Shock Hazard' },
  { kw: 'electrocution', label: 'Electrocution Hazard' },
  { kw: 'explosion', label: 'Explosion Hazard' },
  { kw: 'fire', label: 'Fire Hazard' },
  { kw: 'burn', label: 'Burn Hazard' },
  { kw: 'poison', label: 'Poisoning Hazard' },
  { kw: 'lead', label: 'Lead Hazard' },
  { kw: 'salmonella', label: 'Salmonella Risk' },
  { kw: 'listeria', label: 'Listeria Risk' },
  { kw: 'e. coli', label: 'E. Coli Risk' },
  { kw: 'e coli', label: 'E. Coli Risk' },
  { kw: 'botulism', label: 'Botulism Risk' },
  { kw: 'undeclared allergen', label: 'Undeclared Allergen' },
  { kw: 'undeclared peanut', label: 'Undeclared Allergen' },
  { kw: 'undeclared milk', label: 'Undeclared Allergen' },
  { kw: 'undeclared egg', label: 'Undeclared Allergen' },
  { kw: 'undeclared soy', label: 'Undeclared Allergen' },
  { kw: 'undeclared wheat', label: 'Undeclared Allergen' },
  { kw: 'foreign material', label: 'Foreign Material Risk' },
  { kw: 'glass', label: 'Glass Fragment Risk' },
  { kw: 'metal', label: 'Metal Fragment Risk' },
  { kw: 'plastic', label: 'Plastic Fragment Risk' },
  { kw: 'contamination', label: 'Contamination Risk' },
  { kw: 'infection', label: 'Infection Risk' },
  { kw: 'sterility', label: 'Sterility Risk' },
  { kw: 'malfunction', label: 'Malfunction Risk' },
  { kw: 'failure', label: 'Failure Risk' },
  { kw: 'airway', label: 'Airway Risk' },
];

function deriveHazardLabel(hazard, reason) {
  const text = `${hazard || ''} ${reason || ''}`.toLowerCase();
  for (const rule of HAZARD_LABEL_RULES) {
    if (text.includes(rule.kw)) return rule.label;
  }
  return 'Safety Risk';
}

function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

function buildSlug(story, headline) {
  const baseName = headline.replace(/\s+Recalled Over\s+.+$/i, '');
  const date = parseDate(story.recallDates?.[0]);
  const dateStr = date
    ? `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
    : '';
  const slugBase = slugify(baseName);
  return dateStr ? `${slugBase}-${dateStr}` : slugBase;
}

function buildHeadline(story) {
  const hazardLabel = deriveHazardLabel(story.hazard, story.reason);

  if (story.source === 'CPSC') {
    const firstRaw = story.rawSourceData?.[0] || {};
    const cpscTitle = firstRaw.title || '';
    const parsed = parseCpscTitleBrand(cpscTitle);
    let product = story.headlineSeed || story.primaryProductName || 'Product';
    let brand = null;
    if (parsed) {
      brand = parsed.brand;
      if (parsed.product && parsed.product.length <= 50) product = parsed.product;
    }
    if (brand && product.toLowerCase().startsWith(brand.toLowerCase())) {
      product = product.slice(brand.length).replace(/^[\s,-]+/, '').trim();
    }
    let headline = brand
      ? `${brand} ${product} Recalled Over ${hazardLabel}`
      : `${product} Recalled Over ${hazardLabel}`;
    if (headline.length > 80) {
      const over = headline.length - 80;
      const trimmedProduct = product.slice(0, Math.max(8, product.length - over - 1)).trim();
      headline = brand
        ? `${brand} ${trimmedProduct}… Recalled Over ${hazardLabel}`
        : `${trimmedProduct}… Recalled Over ${hazardLabel}`;
    }
    return headline;
  }

  const firm = story.recallingFirm || 'Firm';
  const product = shortProductName(story) || story.headlineSeed || 'Product';
  let headline = `${firm} ${product} Recalled Over ${hazardLabel}`;
  if (headline.length > 80) {
    const over = headline.length - 80;
    const trimmedProduct = product.slice(0, Math.max(8, product.length - over - 1)).trim();
    headline = `${firm} ${trimmedProduct}… Recalled Over ${hazardLabel}`;
  }
  return headline;
}

// ===========================================================================
// Text wrapping for SVG (greedy word-fit)
// ===========================================================================

/**
 * Wrap a string into N lines of at most maxChars characters each.
 * Greedy word-fit. Returns an array of line strings.
 */
function wrapText(text, maxChars) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const lines = [];
  let current = words[0];
  for (let i = 1; i < words.length; i++) {
    const candidate = `${current} ${words[i]}`;
    if (candidate.length <= maxChars) {
      current = candidate;
    } else {
      lines.push(current);
      current = words[i];
    }
  }
  lines.push(current);
  return lines;
}

// ===========================================================================
// CPSC photo path: download + cover-crop to 1200x675
// ===========================================================================

/**
 * Download a CPSC recall image and cover-crop it to 1200x675 using sharp.
 * Returns the local file path. Throws on failure.
 */
async function downloadAndCropCpscImage(imageUrl, slug, story) {
  console.log(`  Downloading CPSC image: ${imageUrl}`);
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

  // Cover-crop to 1200x675 — no distortion. sharp's `cover` fit preserves
  // aspect ratio by cropping the overflow.
  const outPath = join(OUTPUT_DIR, `${slug}.jpg`);
  const tmpPath = `${outPath}.tmp`;
  await sharp(buffer)
    .resize(W, H, {
      fit: 'cover',
      position: 'attention', // smart-crop focus (faces/regions of interest)
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
// Editorial graphic path: SVG → PNG
// ===========================================================================

/**
 * Build a clean, professional recall-notice SVG.
 *
 * Design:
 *   - Dark left panel: "RECALL" headline + classification chip + product name
 *     + recalling firm.
 *   - Light right panel: hazard/reason summary + recall date + distribution.
 *   - Bottom attribution bar with agency name + subtle US News Engine branding.
 *
 * No fake product photography. No fake agency logos. Just typography and
 * factual data from the source.
 */
function buildRecallNoticeSvg(story, slug) {
  const agencyFull = agencyName(story.source);
  const agencyAbbr = agencyShort(story.source);
  const firm = recallingFirmDisplay(story) || 'Recalling firm not named';
  const product = story.source === 'FDA'
    ? (shortProductName(story) || story.headlineSeed || 'Product')
    : (story.headlineSeed || story.primaryProductName || 'Product');
  const hazardLabel = deriveHazardLabel(story.hazard, story.reason);
  const classification = story.classification || null;
  const recallDate = formatLongDate(story.recallDates?.[0]);

  // Truncate the reason text for the right panel — preserve meaning, drop
  // lengthy device-clinical detail that won't fit a hero graphic.
  const reasonText = (story.reason || story.hazard || 'See the official recall record for details.').trim();
  const reasonLines = wrapText(reasonText, 52).slice(0, 5); // max 5 lines

  // Pick a palette based on the source agency.
  const palette = story.source === 'CPSC'
    ? { accent: '#c8102e', accentDark: '#7a0f1d', panel: '#1a1d23', panelText: '#ffffff' }
    : { accent: '#0f4d8a', accentDark: '#07315a', panel: '#0f1c2c', panelText: '#ffffff' };

  const accent = palette.accent;
  const accentDark = palette.accentDark;
  const panel = palette.panel;
  const panelText = palette.panelText;

  // Wrap the product name (left panel) — allow up to 4 lines.
  const productLines = wrapText(product, 22).slice(0, 4);
  // Wrap the firm name — up to 2 lines.
  const firmLines = wrapText(firm, 26).slice(0, 2);

  // Right-panel data callouts.
  const callouts = [];
  if (classification) callouts.push({ label: 'CLASSIFICATION', value: classification });
  if (recallDate) callouts.push({ label: 'RECALL DATE', value: recallDate });
  if (story.units) {
    const unitsNum = parseInt(String(story.units).replace(/\D/g, ''), 10);
    const unitsStr = unitsNum ? unitsNum.toLocaleString() : story.units;
    callouts.push({ label: 'UNITS', value: `${unitsStr} units` });
  }
  if (story.distribution) {
    // Show only a short distribution label.
    const distLower = story.distribution.toLowerCase();
    let distShort = story.distribution;
    if (distLower.includes('worldwide')) distShort = 'Worldwide distribution';
    else if (distLower.includes('us nationwide') || distLower.includes('nationwide')) distShort = 'Nationwide (U.S.)';
    else {
      // Count US state abbreviations.
      const STATE_ABBRS = ['AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY'];
      const found = new Set();
      for (const abbr of STATE_ABBRS) {
        if (new RegExp(`\\b${abbr}\\b`).test(story.distribution)) found.add(abbr);
      }
      if (found.size >= 5) distShort = `${found.size} states`;
      else if (found.size > 0) distShort = Array.from(found).join(', ');
      else distShort = story.distribution.length > 60 ? story.distribution.slice(0, 57) + '…' : story.distribution;
    }
    callouts.push({ label: 'DISTRIBUTION', value: distShort });
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Recall notice for ${escapeXml(product)} from ${escapeXml(firm)}">
  <defs>
    <linearGradient id="panelGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${panel}"/>
      <stop offset="1" stop-color="${accentDark}"/>
    </linearGradient>
  </defs>

  <!-- Background -->
  <rect width="${W}" height="${H}" fill="#f4f5f3"/>

  <!-- Left dark panel -->
  <rect x="0" y="0" width="520" height="${H}" fill="url(#panelGrad)"/>

  <!-- Top accent strip -->
  <rect x="0" y="0" width="${W}" height="8" fill="${accent}"/>

  <!-- RECALL eyebrow -->
  <g transform="translate(50, 70)">
    <text x="0" y="0" font-family="Arial, Helvetica, sans-serif" font-size="14" font-weight="800" fill="${accent}" letter-spacing="4">RECALL NOTICE</text>
    <rect x="0" y="14" width="60" height="3" fill="${accent}"/>
  </g>

  <!-- RECALL headline (large, white on dark) -->
  <text x="50" y="160" font-family="Arial, Helvetica, sans-serif" font-size="74" font-weight="900" fill="${panelText}" letter-spacing="2">RECALL</text>

  <!-- Product name (left panel) -->
  <g transform="translate(50, 220)">
    <text x="0" y="0" font-family="Arial, sans-serif" font-size="11" font-weight="700" fill="${accent}" letter-spacing="2">PRODUCT</text>
    ${productLines.map((line, i) => `<text x="0" y="${28 + i * 30}" font-family="Georgia, 'Times New Roman', serif" font-size="22" font-weight="700" fill="${panelText}">${escapeXml(line)}</text>`).join('\n    ')}
  </g>

  <!-- Recalling firm (left panel) -->
  <g transform="translate(50, ${Math.min(220 + productLines.length * 30 + 40, 420)})">
    <text x="0" y="0" font-family="Arial, sans-serif" font-size="11" font-weight="700" fill="${accent}" letter-spacing="2">RECALLING FIRM</text>
    ${firmLines.map((line, i) => `<text x="0" y="${22 + i * 22}" font-family="Arial, sans-serif" font-size="16" font-weight="600" fill="${panelText}">${escapeXml(line)}</text>`).join('\n    ')}
  </g>

  <!-- Agency attribution on left panel (bottom) -->
  <g transform="translate(50, ${H - 70})">
    <rect x="0" y="-4" width="4" height="28" fill="${accent}"/>
    <text x="14" y="10" font-family="Arial, sans-serif" font-size="13" font-weight="700" fill="${panelText}" letter-spacing="1">${escapeXml(agencyFull.toUpperCase())}</text>
    <text x="14" y="26" font-family="Arial, sans-serif" font-size="10" font-weight="400" fill="#b8c0c8">Source: ${escapeXml(agencyAbbr)} recall record</text>
  </g>

  <!-- US News Engine branding (left panel, bottom) -->
  <text x="50" y="${H - 24}" font-family="Georgia, serif" font-size="14" font-weight="700" fill="${panelText}">US News Engine</text>
  <text x="180" y="${H - 24}" font-family="Arial, sans-serif" font-size="10" font-weight="400" fill="#8a94a0" letter-spacing="0.5">EDITORIAL NOTICE</text>

  <!-- Right light panel -->
  <rect x="520" y="0" width="${W - 520}" height="${H}" fill="#ffffff"/>

  <!-- Hazard label chip (right panel, top) -->
  <g transform="translate(560, 70)">
    <text x="0" y="0" font-family="Arial, sans-serif" font-size="11" font-weight="700" fill="#6b7178" letter-spacing="2">HAZARD</text>
    <rect x="0" y="14" width="${Math.min(hazardLabel.length * 9 + 24, 320)}" height="32" rx="3" fill="${accent}"/>
    <text x="${Math.min(hazardLabel.length * 9 + 24, 320) / 2}" y="35" font-family="Arial, sans-serif" font-size="14" font-weight="800" fill="#ffffff" text-anchor="middle" letter-spacing="1">${escapeXml(hazardLabel.toUpperCase())}</text>
  </g>

  <!-- Reason text (right panel) -->
  <g transform="translate(560, 150)">
    <text x="0" y="0" font-family="Arial, sans-serif" font-size="11" font-weight="700" fill="#6b7178" letter-spacing="2">REASON FOR RECALL</text>
    ${reasonLines.map((line, i) => `<text x="0" y="${28 + i * 22}" font-family="Georgia, 'Times New Roman', serif" font-size="15" font-weight="400" fill="#23262b">${escapeXml(line)}</text>`).join('\n    ')}
  </g>

  <!-- Data callouts (right panel, bottom) -->
  <g transform="translate(560, ${H - 60 - callouts.length * 38})">
    ${callouts.map((c, i) => `
    <g transform="translate(0, ${i * 38})">
      <text x="0" y="0" font-family="Arial, sans-serif" font-size="10" font-weight="700" fill="#6b7178" letter-spacing="1.5">${escapeXml(c.label)}</text>
      <text x="0" y="20" font-family="Arial, sans-serif" font-size="15" font-weight="700" fill="#14161a">${escapeXml(c.value)}</text>
    </g>`).join('')}
  </g>

  <!-- Right-panel US News Engine branding (bottom right) -->
  <text x="${W - 50}" y="${H - 24}" font-family="Georgia, serif" font-size="14" font-weight="700" fill="#14161a" text-anchor="end">US News Engine</text>
  <text x="${W - 50}" y="${H - 10}" font-family="Arial, sans-serif" font-size="9" font-weight="400" fill="#8a8f96" text-anchor="end" letter-spacing="0.5">EDITORIAL GRAPHIC</text>
</svg>`;
}

// ===========================================================================
// Metadata sidecar builder
// ===========================================================================

function buildMetadata({
  story,
  slug,
  mode, // 'cpsc-photo' or 'editorial-graphic'
  imagePath,
  imageFilename,
  originalImageUrl,
  caption,
  alt,
  generatedAt,
}) {
  const agencyFull = agencyName(story.source);
  return {
    storyKey: story.recallStoryKey,
    slug,
    status: 'draft',
    type: mode === 'cpsc-photo' ? 'official-recall-photo' : 'generated-editorial-graphic',
    visualType: mode === 'cpsc-photo' ? 'cpsc-recall-photo' : 'recall-notice-graphic',
    imageMode: mode,
    width: W,
    height: H,
    source: mode === 'cpsc-photo'
      ? `${agencyFull} (official recall photo)`
      : 'US News Engine (editorial graphic)',
    dataSource: agencyFull,
    agency: agencyFull,
    agencyShort: agencyShort(story.source),
    sourceUrl: story.sourceUrls?.[0] || null,
    originalImageUrl: originalImageUrl || null,
    caption,
    alt,
    copyrightRisk: mode === 'cpsc-photo'
      ? 'none-known (U.S. government work — CPSC recall photos are public domain)'
      : 'none-known (original graphic generated by US News Engine)',
    licenseNotes: mode === 'cpsc-photo'
      ? 'Official CPSC recall photo. CPSC recall images are works of the U.S. federal government and are in the public domain.'
      : 'Original editorial graphic generated by US News Engine. No external copyrighted assets used.',
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
  console.log('[generate-recall-image] Starting recall image generation.');

  let raw;
  try {
    raw = await readFile(CLUSTERS_FILE, 'utf8');
  } catch (err) {
    return fail(
      'Could not read recall-story-clusters.json. Run `npm run cluster:recalls` first.',
      String(err),
    );
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    return fail('Clusters file is not valid JSON.', String(err));
  }
  const stories = Array.isArray(doc.stories) ? doc.stories : [];
  if (stories.length === 0) {
    return fail('No recall stories available.');
  }

  // Select story — argv[2] = storyKey, otherwise stories[0].
  const targetStoryKey = process.argv[2];
  const story = targetStoryKey
    ? stories.find((s) => s.recallStoryKey === targetStoryKey)
    : stories[0];
  if (!story) {
    return fail(
      `Story not found: ${targetStoryKey}`,
      `Available: ${stories.map((s) => s.recallStoryKey).slice(0, 5).join(', ')}...`,
    );
  }

  console.log(`  Selected story: ${story.recallStoryKey} (score=${story.storyScore})`);
  console.log(`  Source: ${story.source} / ${story.sourceType}`);

  // Derive slug (matches the draft generator's slug exactly).
  const headline = buildHeadline(story);
  const slug = buildSlug(story, headline);
  console.log(`  Slug: ${slug}`);

  await mkdir(OUTPUT_DIR, { recursive: true });
  const generatedAt = new Date().toISOString();

  // =========================================================================
  // Decide image path
  // =========================================================================
  const imageUrls = Array.isArray(story.imageUrls) ? story.imageUrls : [];
  const hasCpscPhoto = story.source === 'CPSC' && imageUrls.length > 0;

  if (hasCpscPhoto) {
    // =====================================================================
    // CPSC photo path — download + cover-crop
    // =====================================================================
    console.log('\n  --- CPSC photo path ---');
    console.log(`  ${imageUrls.length} official image(s) available.`);

    const firstImageUrl = imageUrls[0];
    // Try to find the original CPSC caption for the first image.
    const cpscImages = story.rawSourceData?.[0]?.rawSourceData?.Images
      || story.rawSourceData?.[0]?.Images
      || [];
    // The cluster's rawSourceData is the normalized record (not the raw CPSC
    // JSON). The original CPSC Images array is on the original record — let's
    // look it up by matching the URL.
    let originalCaption = null;
    if (Array.isArray(cpscImages)) {
      const match = cpscImages.find((img) => img && img.URL === firstImageUrl);
      if (match && match.Caption) originalCaption = match.Caption;
    }

    let imagePath;
    let imageFilename;
    try {
      imagePath = await downloadAndCropCpscImage(firstImageUrl, slug, story);
      imageFilename = `${slug}.jpg`;
    } catch (err) {
      console.warn(`  CPSC photo download failed: ${String(err.message || err)}`);
      console.warn('  Falling back to editorial graphic path.');
      // Fall through to the editorial-graphic path below.
      const svg = buildRecallNoticeSvg(story, slug);
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
      console.log(`  Editorial graphic: ${imagePath} (${stats.size.toLocaleString()} bytes, ${meta.width}x${meta.height})`);

      const alt = `Editorial recall notice graphic for ${headline}.`;
      const caption = `Recall notice for ${story.headlineSeed || story.primaryProductName || 'the recalled product'}. Graphic: US News Engine / ${agencyName(story.source)} data.`;
      const metadata = buildMetadata({
        story, slug, mode: 'editorial-graphic',
        imagePath, imageFilename,
        caption, alt, generatedAt,
      });
      const metaPath = join(OUTPUT_DIR, `${slug}.json`);
      const tmpMeta = `${metaPath}.tmp`;
      await writeFile(tmpMeta, JSON.stringify(metadata, null, 2) + '\n', 'utf8');
      await rename(tmpMeta, metaPath);
      console.log(`  Metadata: ${metaPath}`);
      console.log('\n[generate-recall-image] SUCCESS — editorial graphic generated (CPSC photo fallback).');
      console.log(`  Image:     ${imagePath}`);
      console.log(`  Metadata:  ${metaPath}`);
      console.log('');
      return;
    }

    // Build caption + alt text.
    const product = story.headlineSeed || story.primaryProductName || 'the recalled product';
    const captionBase = originalCaption || `Recalled ${product}`;
    const alt = `Official ${agencyShort(story.source)} recall photo: ${captionBase}`;
    const caption = `${captionBase}. Photo: ${agencyName(story.source)}.`;

    const metadata = buildMetadata({
      story, slug, mode: 'cpsc-photo',
      imagePath, imageFilename,
      originalImageUrl: firstImageUrl,
      caption, alt, generatedAt,
    });
    const metaPath = join(OUTPUT_DIR, `${slug}.json`);
    const tmpMeta = `${metaPath}.tmp`;
    await writeFile(tmpMeta, JSON.stringify(metadata, null, 2) + '\n', 'utf8');
    await rename(tmpMeta, metaPath);
    console.log(`  Metadata: ${metaPath}`);

    console.log('\n[generate-recall-image] SUCCESS — CPSC photo downloaded + cropped.');
    console.log(`  Image:     ${imagePath}`);
    console.log(`  Metadata:  ${metaPath}`);
    console.log(`  Source URL: ${firstImageUrl}`);
    console.log('');
    return;
  }

  // =========================================================================
  // Editorial graphic path — FDA or CPSC without photos
  // =========================================================================
  console.log('\n  --- Editorial graphic path ---');
  console.log(`  Source: ${story.source} | Available image URLs: ${imageUrls.length}`);

  const svg = buildRecallNoticeSvg(story, slug);
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

  const alt = `Editorial recall notice graphic for ${headline}.`;
  // Use the cleaner product name (short name for FDA, headlineSeed for CPSC)
  // so the caption doesn't include a multi-SKU manifest.
  const captionProduct = story.source === 'FDA'
    ? (shortProductName(story) || story.headlineSeed || 'the recalled product')
    : (story.headlineSeed || story.primaryProductName || 'the recalled product');
  const caption = `Recall notice for ${captionProduct}. Graphic: US News Engine / ${agencyName(story.source)} data.`;
  const metadata = buildMetadata({
    story, slug, mode: 'editorial-graphic',
    imagePath, imageFilename,
    caption, alt, generatedAt,
  });
  const metaPath = join(OUTPUT_DIR, `${slug}.json`);
  const tmpMeta = `${metaPath}.tmp`;
  await writeFile(tmpMeta, JSON.stringify(metadata, null, 2) + '\n', 'utf8');
  await rename(tmpMeta, metaPath);
  console.log(`  Metadata: ${metaPath}`);

  console.log('\n[generate-recall-image] SUCCESS — editorial graphic generated.');
  console.log(`  Image:     ${imagePath}`);
  console.log(`  Metadata:  ${metaPath}`);
  console.log('');
}

main().catch((err) =>
  fail('Unexpected failure.', String(err && err.stack ? err.stack : err)),
);
