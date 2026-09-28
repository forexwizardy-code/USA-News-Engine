/**
 * US News Engine — Science article hero image generator (Phase 9B).
 *
 * Generates hero images for Science article drafts in three modes:
 *
 *   1. verified-agency path — download the official source-page image,
 *      cover-crop to 1200x675 using sharp, save as .jpg. (NISAR.)
 *
 *   2. mixed-agency path — same as above, BUT only after re-verifying that
 *      the extracted image credit confirms the multi-agency signature
 *      (e.g. "NASA/JPL-Caltech/MSSS"). If provenance becomes unclear,
 *      fall back to the factual-graphic path. (Perseverance.)
 *
 *   3. factual-graphic fallback — generate a clean SVG → PNG graphic with
 *      a "SCIENCE" headline, mission/telescope name, story topic, and NASA
 *      attribution. No fake imagery, no AI space art, no simulated photos.
 *      Used for third-party / unclear / unverified credits (Hubble) and
 *      when the verified/mixed path fails.
 *
 * Reads the draft from data/science/drafts/<slug>.json (selected by
 * scienceStoryKey in argv[2], or the first draft by default) and writes:
 *   - data/draft-images/<slug>.jpg   (verified-agency or mixed-agency path)
 *   - data/draft-images/<slug>.png  (factual-graphic fallback path)
 *   - data/draft-images/<slug>.svg  (the source SVG, for editability)
 *   - data/draft-images/<slug>.json (metadata sidecar with provenance)
 *
 * Run manually:
 *   node scripts/generate-science-image.mjs
 *   node scripts/generate-science-image.mjs "<scienceStoryKey>"
 *
 * Constraints:
 *   - Never modifies any weather / recall / earthquake scripts.
 *   - All scripts are .mjs ES modules using only Node.js built-ins + sharp.
 */

import { readFile, writeFile, mkdir, stat, rename, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(__dirname, '..');
const DRAFTS_DIR = join(PROJECT_DIR, 'data', 'science', 'drafts');
const OUTPUT_DIR = join(PROJECT_DIR, 'data', 'draft-images');

const W = 1200;
const H = 675;

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ===========================================================================
// Helpers
// ===========================================================================

function fail(message, detail) {
  console.error(`\n[generate-science-image] ERROR: ${message}`);
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

// ===========================================================================
// Mixed-agency credit verification
// ===========================================================================

/**
 * Verify that an extracted image credit confirms a known multi-agency
 * signature. The mixed-agency path is only used when the credit mentions
 * NASA/JPL AND a co-equal partner organization (e.g. MSSS, ASU, USGS,
 * Caltech, SwRI, Malin, ESA, CSA, JHU, APL, STScI, Lockheed).
 *
 * The point: avoid accidentally publishing a credit that turns out to be
 * "NASA/John Kraus" (a named individual = third-party) under the
 * mixed-agency banner.
 *
 * @param {string} credit - The extracted image credit string.
 * @returns {{verified: boolean, reason: string}}
 */
function verifyMixedAgencyCredit(credit) {
  if (!credit || typeof credit !== 'string') {
    return { verified: false, reason: 'no credit extracted' };
  }
  const c = credit.trim();
  // Must contain at least one NASA/JPL token.
  if (!/NASA|JPL/i.test(c)) {
    return { verified: false, reason: 'credit does not mention NASA/JPL' };
  }
  // Must NOT contain a named-individual pattern. The Phase 9A.2 heuristic
  // treats a credit containing a likely personal name as third-party.
  // Simple heuristic: look for "First Last" or "F. Last" tokens that are
  // NOT one of the known agency/org names.
  const nameMatch = c.match(
    /\b([A-Z][a-z]+\s+[A-Z][a-z]+|[A-Z]\.\s*[A-Z][a-z]+)\b/,
  );
  if (nameMatch) {
    return {
      verified: false,
      reason: `credit appears to name an individual ("${nameMatch[0]}") — third-party`,
    };
  }
  // Must contain at least one of the known partner-org tokens.
  const partnerOrgs =
    /MSSS|ASU|USGS|Caltech|SwRI|Malin|ESA|CSA|JHU|APL|STScI|Lockheed|Ball Aerospace|Northrop Grumman/i;
  if (!partnerOrgs.test(c)) {
    return {
      verified: false,
      reason: 'credit does not mention a recognized partner organization',
    };
  }
  return { verified: true, reason: 'mixed-agency signature confirmed' };
}

// ===========================================================================
// Image download + cover-crop
// ===========================================================================

/**
 * Download the official source image and cover-crop to 1200x675 using sharp.
 * Returns the local file path. Throws on failure.
 */
async function downloadAndCropImage(imageUrl, slug, sourceUrl) {
  console.log(`  Downloading image: ${imageUrl}`);
  // JPL's image CDN (d2pn8kiwq2w21t.cloudfront.net) and NASA's images-assets
  // CDN both accept standard image requests; no WAF challenge here.
  const headers = {
    'User-Agent': BROWSER_UA,
    Accept: 'image/*',
  };
  // Add Referer for NASA images-assets.nasa.gov which sometimes 403s without one.
  if (sourceUrl) {
    headers.Referer = sourceUrl;
  }
  const res = await fetch(imageUrl, {
    headers,
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
  console.log(
    `  Output: ${outPath} (${stats.size.toLocaleString()} bytes, ${meta.width}x${meta.height})`,
  );

  return outPath;
}

// ===========================================================================
// Factual graphic SVG (third-party / fallback)
// ===========================================================================

/**
 * Build the factual Science graphic SVG. Carries:
 *   - "SCIENCE" eyebrow + headline
 *   - Mission / telescope name (e.g. "Hubble Space Telescope")
 *   - Story topic (e.g. "Spiral Galaxy Discovery")
 *   - NASA attribution
 *   - Subtle US News Engine branding
 *
 * No fake galaxy imagery, no AI space art, no simulated Hubble photos.
 */
function buildScienceGraphicSvg({
  missionName,
  missionSubtitle,
  topic,
  sourceName,
  dateStr,
}) {
  const headlineStr = (missionName || 'Science').toUpperCase();
  const topicStr = (topic || 'Discovery').toUpperCase();
  const sourceStr = (sourceName || 'NASA').toUpperCase();
  const subtitleStr = missionSubtitle || '';
  const dateUpper = (dateStr || '').toUpperCase();

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Science graphic: ${escapeXml(missionName || 'Science')} — ${escapeXml(topic || 'discovery')}">
  <defs>
    <linearGradient id="panelGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#0a1320"/>
      <stop offset="1" stop-color="#102844"/>
    </linearGradient>
    <linearGradient id="rightGrad" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#f4f5f3"/>
      <stop offset="1" stop-color="#e8ecee"/>
    </linearGradient>
  </defs>

  <!-- Background -->
  <rect width="${W}" height="${H}" fill="url(#rightGrad)"/>

  <!-- Left dark panel -->
  <rect x="0" y="0" width="520" height="${H}" fill="url(#panelGrad)"/>

  <!-- Top accent strip -->
  <rect x="0" y="0" width="${W}" height="8" fill="#c8102e"/>

  <!-- Eyebrow + headline (left panel) -->
  <g transform="translate(50, 70)">
    <text x="0" y="0" font-family="Arial, sans-serif" font-size="14" font-weight="800" fill="#ff6b7a" letter-spacing="4">SCIENCE</text>
    <rect x="0" y="14" width="60" height="3" fill="#c8102e"/>
  </g>

  <!-- Big mission/telescope name (left panel) -->
  <text x="50" y="190" font-family="Arial, Helvetica, sans-serif" font-size="48" font-weight="900" fill="#ffffff" letter-spacing="2">${escapeXml(headlineStr)}</text>
  ${subtitleStr ? `<text x="50" y="220" font-family="Arial, sans-serif" font-size="14" font-weight="600" fill="#9aa6b2" letter-spacing="2">${escapeXml(subtitleStr)}</text>` : ''}

  <!-- Topic block (left panel, lower) -->
  <g transform="translate(50, 290)">
    <text x="0" y="0" font-family="Arial, sans-serif" font-size="11" font-weight="700" fill="#ff6b7a" letter-spacing="2">DISCOVERY</text>
    <text x="0" y="28" font-family="Georgia, 'Times New Roman', serif" font-size="24" font-weight="700" fill="#ffffff">${escapeXml(topicStr)}</text>
  </g>

  <!-- Source + date (left panel, bottom) -->
  <g transform="translate(50, ${H - 130})">
    <text x="0" y="0" font-family="Arial, sans-serif" font-size="11" font-weight="700" fill="#ff6b7a" letter-spacing="2">SOURCE</text>
    <text x="0" y="22" font-family="Arial, sans-serif" font-size="16" font-weight="600" fill="#ffffff">${escapeXml(sourceStr)}</text>
    ${dateUpper ? `<text x="0" y="48" font-family="Arial, sans-serif" font-size="12" font-weight="400" fill="#b8c0c8">${escapeXml(dateUpper)}</text>` : ''}
  </g>

  <!-- US News Engine branding (left panel, bottom) -->
  <text x="50" y="${H - 22}" font-family="Georgia, serif" font-size="14" font-weight="700" fill="#ffffff">US News Engine</text>
  <text x="180" y="${H - 22}" font-family="Arial, sans-serif" font-size="10" font-weight="400" fill="#8a94a0" letter-spacing="0.5">EDITORIAL DATA GRAPHIC</text>

  <!-- Right light panel content -->
  <!-- Stylized orbital arc motif (NOT a simulated photo) -->
  <g transform="translate(${W - 280}, ${H / 2})">
    <circle r="160" fill="none" stroke="#cfd6dd" stroke-width="1" stroke-dasharray="3 6"/>
    <ellipse rx="200" ry="80" fill="none" stroke="#d8dde2" stroke-width="1" stroke-dasharray="2 5" transform="rotate(-15)"/>
    <ellipse rx="120" ry="60" fill="none" stroke="#d8dde2" stroke-width="1" stroke-dasharray="2 5" transform="rotate(25)"/>
    <circle r="40" fill="#0a1320" stroke="#c8102e" stroke-width="3"/>
    <circle r="40" fill="none" stroke="#ffffff" stroke-width="1" stroke-opacity="0.4"/>
    <text x="0" y="6" font-family="Arial, sans-serif" font-size="11" font-weight="700" fill="#ff6b7a" text-anchor="middle" letter-spacing="1">NASA</text>
  </g>

  <!-- Right-panel topic label (top) -->
  <g transform="translate(560, 70)">
    <text x="0" y="0" font-family="Arial, sans-serif" font-size="11" font-weight="700" fill="#6b7178" letter-spacing="2">STORY TOPIC</text>
    <text x="0" y="32" font-family="Georgia, 'Times New Roman', serif" font-size="22" font-weight="700" fill="#14161a">${escapeXml(topic || 'Science discovery')}</text>
  </g>

  <!-- Right-panel US News Engine branding (bottom right) -->
  <text x="${W - 50}" y="${H - 24}" font-family="Georgia, serif" font-size="14" font-weight="700" fill="#14161a" text-anchor="end">US News Engine</text>
  <text x="${W - 50}" y="${H - 10}" font-family="Arial, sans-serif" font-size="9" font-weight="400" fill="#8a8f96" text-anchor="end" letter-spacing="0.5">EDITORIAL DATA GRAPHIC · NOT A PHOTOGRAPH</text>
</svg>`;
}

// ===========================================================================
// Metadata sidecar
// ===========================================================================

function buildMetadata({
  draft,
  mode,
  imagePath,
  imageFilename,
  originalImageUrl,
  caption,
  alt,
  credit,
  generatedAt,
  creditVerification,
}) {
  const rightsStatus = draft.image?.rightsStatus || 'unclear';
  return {
    scienceStoryKey: draft.scienceStoryKey,
    slug: draft.slug,
    status: 'draft',
    type:
      mode === 'verified-agency' || mode === 'mixed-agency'
        ? 'official-source-image'
        : 'generated-science-graphic',
    visualType:
      mode === 'verified-agency' || mode === 'mixed-agency'
        ? 'official-source-image'
        : 'science-editorial-graphic',
    imageMode: mode,
    width: W,
    height: H,
    source:
      mode === 'verified-agency' || mode === 'mixed-agency'
        ? draft.sourceName
        : 'US News Engine (editorial data graphic)',
    agency: draft.sourceName,
    agencyShort: draft.scienceMetadata?.primarySource || null,
    sourceUrl: draft.sourceUrl,
    sourcePageUrl: draft.image?.sourcePageUrl || draft.sourceUrl,
    originalImageUrl: originalImageUrl || null,
    credit: credit || null,
    rightsStatus,
    caption,
    alt,
    copyrightRisk:
      mode === 'verified-agency'
        ? 'none-known (NASA / NASA-affiliated agency work; public domain or NASA media-usage policy)'
        : mode === 'mixed-agency'
          ? 'low (NASA/JPL + partner org; co-branded agency work — verify per-partner policy before publishing)'
          : 'none-known (original graphic generated by US News Engine)',
    licenseNotes:
      mode === 'verified-agency'
        ? `Official source image. Credit: ${credit || '(extracted from source page)'}. NASA/JPL imagery is generally a U.S. government work or released under NASA's media-usage policy.`
        : mode === 'mixed-agency'
          ? `Official source image with mixed-agency credit. Credit: ${credit || '(extracted from source page)'}. NASA/JPL imagery is generally a U.S. government work; partner-org contributions may carry additional terms — verify before publishing.`
          : 'Original editorial graphic generated by US News Engine. No third-party imagery used. Factual text derived from the official source article.',
    creditVerification: creditVerification || null,
    mission: draft.scienceMetadata?.mission || null,
    topic: draft.scienceMetadata?.topic || null,
    storyType: draft.scienceMetadata?.storyType || null,
    primarySource: draft.scienceMetadata?.primarySource || null,
    sourcePublishedAt: draft.sourcePublishedAt || null,
    generatedAt,
    files: {
      image: `data/draft-images/${imageFilename}`,
    },
  };
}

// ===========================================================================
// Per-story graphic parameters
// ===========================================================================

/**
 * Per-story parameters for the factual-graphic fallback. Each entry picks a
 * missionName / missionSubtitle / topic that reads naturally and stays
 * strictly factual (no invented claims).
 */
const GRAPHIC_PARAMS = {
  'jpl__a0b05eee4e3af8ae': {
    missionName: 'NISAR',
    missionSubtitle: 'NASA-ISRO Synthetic Aperture Radar',
    topic: 'Volcanic Eruption Time-lapse',
  },
  'jpl__7cdc58bb88b1db7c': {
    missionName: 'Perseverance',
    missionSubtitle: 'Mars Rover · SuperCam',
    topic: 'Ancient Water Systems on Mars',
  },
  'nasa__4c93b21d54ff615c': {
    missionName: 'Hubble Space Telescope',
    missionSubtitle: 'NASA · ESA',
    topic: 'Spiral Galaxy NGC 4698',
  },
};

function formatLongDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

// ===========================================================================
// Main
// ===========================================================================

async function main() {
  console.log('[generate-science-image] Starting science image generation.');

  const targetKey = process.argv[2] || null;

  // --- Load the draft -----------------------------------------------------
  let draftFiles;
  try {
    draftFiles = await readdir(DRAFTS_DIR);
  } catch (err) {
    return fail(
      'Could not read drafts directory. Run `npm run draft:science` first.',
      String(err),
    );
  }
  draftFiles = draftFiles.filter((f) => f.endsWith('.json'));
  if (draftFiles.length === 0) {
    return fail('No science drafts available. Run `npm run draft:science` first.');
  }

  let draft = null;
  let draftPath = null;
  for (const f of draftFiles) {
    const full = join(DRAFTS_DIR, f);
    const content = await readFile(full, 'utf8');
    try {
      const d = JSON.parse(content);
      if (targetKey) {
        if (d.scienceStoryKey === targetKey) {
          draft = d;
          draftPath = full;
          break;
        }
      } else {
        // No key passed — use the first draft.
        draft = d;
        draftPath = full;
        break;
      }
    } catch {
      // ignore
    }
  }
  if (!draft) {
    return fail(
      `Draft not found for scienceStoryKey=${targetKey || '(none)'}`,
      `Available drafts: ${draftFiles.join(', ')}`,
    );
  }

  console.log(`  Loaded draft: ${draftPath}`);
  console.log(`  Story key:    ${draft.scienceStoryKey}`);
  console.log(`  Slug:         ${draft.slug}`);
  console.log(`  Title:        ${draft.title}`);
  console.log(`  Image mode:   ${draft.image?.mode}`);
  console.log(`  Rights:       ${draft.image?.rightsStatus}`);

  await mkdir(OUTPUT_DIR, { recursive: true });
  const generatedAt = new Date().toISOString();

  // =========================================================================
  // Branch on image mode
  // =========================================================================
  const imageMode = draft.image?.mode;
  const rightsStatus = draft.image?.rightsStatus;
  const originalImageUrl = draft.image?.originalImageUrl;
  const extractedCredit = draft.image?.credit;

  // --- verified-agency path -----------------------------------------------
  if (imageMode === 'official-source-image' && rightsStatus === 'verified-agency' && originalImageUrl) {
    console.log('\n  --- verified-agency path ---');
    let imagePath;
    let imageFilename;
    let mode = 'verified-agency';
    try {
      imagePath = await downloadAndCropImage(originalImageUrl, draft.slug, draft.sourceUrl);
      imageFilename = `${draft.slug}.jpg`;
    } catch (err) {
      console.warn(`  Image download failed: ${String(err.message || err)}`);
      console.warn('  Falling back to factual-graphic path.');
      mode = 'factual-graphic-fallback';
      const svg = buildScienceGraphicSvg({
        ...GRAPHIC_PARAMS[draft.scienceStoryKey],
        sourceName: draft.sourceName,
        dateStr: formatLongDate(draft.sourcePublishedAt),
      });
      const svgPath = join(OUTPUT_DIR, `${draft.slug}.svg`);
      await writeFile(svgPath, svg, 'utf8');
      console.log(`  SVG: ${svgPath}`);
      imagePath = join(OUTPUT_DIR, `${draft.slug}.png`);
      imageFilename = `${draft.slug}.png`;
      const tmpPath = `${imagePath}.tmp`;
      await sharp(Buffer.from(svg))
        .resize(W, H, { fit: 'fill' })
        .png({ quality: 90, compressionLevel: 9 })
        .toFile(tmpPath);
      await rename(tmpPath, imagePath);
    }

    const stats = await stat(imagePath);
    const meta = await sharp(imagePath).metadata();
    console.log(`  Final: ${imagePath} (${stats.size.toLocaleString()} bytes, ${meta.width}x${meta.height})`);

    const caption = draft.image?.caption ||
      `Image from ${draft.sourceName}. Credit: ${extractedCredit || '(see source page)'}.`;
    const alt = draft.image?.alt || draft.title;
    const metadata = buildMetadata({
      draft,
      mode,
      imagePath,
      imageFilename,
      originalImageUrl: mode === 'verified-agency' ? originalImageUrl : null,
      caption,
      alt,
      credit: extractedCredit,
      generatedAt,
      creditVerification: { verified: true, reason: 'verified-agency (no further check needed)' },
    });
    const metaPath = join(OUTPUT_DIR, `${draft.slug}.json`);
    const tmpMeta = `${metaPath}.tmp`;
    await writeFile(tmpMeta, JSON.stringify(metadata, null, 2) + '\n', 'utf8');
    await rename(tmpMeta, metaPath);
    console.log(`  Metadata: ${metaPath}`);
    console.log('\n[generate-science-image] SUCCESS.');
    return;
  }

  // --- mixed-agency path (with credit re-verification) --------------------
  if (imageMode === 'official-source-image-pending-credit-verification' && rightsStatus === 'mixed-agency' && originalImageUrl) {
    console.log('\n  --- mixed-agency path (verifying credit) ---');
    const verification = verifyMixedAgencyCredit(extractedCredit);
    console.log(`  Credit verification: ${verification.verified ? 'PASS' : 'FAIL'} — ${verification.reason}`);

    if (verification.verified) {
      let imagePath;
      let imageFilename;
      let mode = 'mixed-agency';
      try {
        imagePath = await downloadAndCropImage(originalImageUrl, draft.slug, draft.sourceUrl);
        imageFilename = `${draft.slug}.jpg`;
      } catch (err) {
        console.warn(`  Image download failed: ${String(err.message || err)}`);
        console.warn('  Falling back to factual-graphic path.');
        mode = 'factual-graphic-fallback';
        const svg = buildScienceGraphicSvg({
          ...GRAPHIC_PARAMS[draft.scienceStoryKey],
          sourceName: draft.sourceName,
          dateStr: formatLongDate(draft.sourcePublishedAt),
        });
        const svgPath = join(OUTPUT_DIR, `${draft.slug}.svg`);
        await writeFile(svgPath, svg, 'utf8');
        console.log(`  SVG: ${svgPath}`);
        imagePath = join(OUTPUT_DIR, `${draft.slug}.png`);
        imageFilename = `${draft.slug}.png`;
        const tmpPath = `${imagePath}.tmp`;
        await sharp(Buffer.from(svg))
          .resize(W, H, { fit: 'fill' })
          .png({ quality: 90, compressionLevel: 9 })
          .toFile(tmpPath);
        await rename(tmpPath, imagePath);
      }

      const stats = await stat(imagePath);
      const meta = await sharp(imagePath).metadata();
      console.log(`  Final: ${imagePath} (${stats.size.toLocaleString()} bytes, ${meta.width}x${meta.height})`);

      const caption = draft.image?.caption ||
        `Image from ${draft.sourceName}. Credit: ${extractedCredit || '(see source page)'}.`;
      const alt = draft.image?.alt || draft.title;
      const metadata = buildMetadata({
        draft,
        mode,
        imagePath,
        imageFilename,
        originalImageUrl: mode === 'mixed-agency' ? originalImageUrl : null,
        caption,
        alt,
        credit: extractedCredit,
        generatedAt,
        creditVerification: verification,
      });
      const metaPath = join(OUTPUT_DIR, `${draft.slug}.json`);
      const tmpMeta = `${metaPath}.tmp`;
      await writeFile(tmpMeta, JSON.stringify(metadata, null, 2) + '\n', 'utf8');
      await rename(tmpMeta, metaPath);
      console.log(`  Metadata: ${metaPath}`);
      console.log('\n[generate-science-image] SUCCESS.');
      return;
    }

    // Credit not verified — fall through to factual-graphic fallback.
    console.warn('  Mixed-agency credit NOT verified — using factual-graphic fallback.');
  }

  // --- factual-graphic fallback (third-party / unclear / unverified) ------
  console.log('\n  --- factual-graphic fallback ---');
  const params = GRAPHIC_PARAMS[draft.scienceStoryKey] || {
    missionName: draft.scienceMetadata?.mission || 'NASA Mission',
    missionSubtitle: draft.sourceName,
    topic: draft.scienceMetadata?.topic || draft.title,
  };

  const svg = buildScienceGraphicSvg({
    ...params,
    sourceName: draft.sourceName,
    dateStr: formatLongDate(draft.sourcePublishedAt),
  });
  const svgPath = join(OUTPUT_DIR, `${draft.slug}.svg`);
  await writeFile(svgPath, svg, 'utf8');
  console.log(`  SVG: ${svgPath}`);

  const imagePath = join(OUTPUT_DIR, `${draft.slug}.png`);
  const imageFilename = `${draft.slug}.png`;
  const tmpPath = `${imagePath}.tmp`;
  await sharp(Buffer.from(svg))
    .resize(W, H, { fit: 'fill' })
    .png({ quality: 90, compressionLevel: 9 })
    .toFile(tmpPath);
  await rename(tmpPath, imagePath);

  const stats = await stat(imagePath);
  const meta = await sharp(imagePath).metadata();
  console.log(`  PNG: ${imagePath} (${stats.size.toLocaleString()} bytes, ${meta.width}x${meta.height})`);

  const caption = `Editorial data graphic. ${draft.sourceName} · ${params.missionName}. Graphic: US News Engine.`;
  const alt = `Science graphic for ${params.missionName} — ${params.topic}.`;
  const metadata = buildMetadata({
    draft,
    mode: 'factual-graphic-fallback',
    imagePath,
    imageFilename,
    originalImageUrl: null,
    caption,
    alt,
    credit: null,
    generatedAt,
    creditVerification: rightsStatus === 'third-party'
      ? { verified: false, reason: `third-party credit ("${extractedCredit || ''}") — source image not used` }
      : { verified: false, reason: `rightsStatus=${rightsStatus} — source image not used` },
  });
  const metaPath = join(OUTPUT_DIR, `${draft.slug}.json`);
  const tmpMeta = `${metaPath}.tmp`;
  await writeFile(tmpMeta, JSON.stringify(metadata, null, 2) + '\n', 'utf8');
  await rename(tmpMeta, metaPath);
  console.log(`  Metadata: ${metaPath}`);

  console.log('\n[generate-science-image] SUCCESS.');
}

main().catch((err) =>
  fail('Unexpected failure.', String(err && err.stack ? err.stack : err)),
);
