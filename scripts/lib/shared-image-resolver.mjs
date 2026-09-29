import { writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import sharp from 'sharp';

const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
const UA = 'USNewsEngine/1.0 (https://usa-news-engine.forexwizardy.workers.dev)';

export const HERO_WIDTH = 1200;
export const HERO_HEIGHT = 675;

export function stripHtml(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .trim();
}

export function checkReusableLicense(image) {
  const license = String(image?.license || '').trim();
  const usageTerms = String(image?.usageTerms || '').trim();
  const combined = `${license} ${usageTerms}`.toLowerCase().trim();

  if (image?.nonFree === true) {
    return {
      allowed: false,
      reason: 'Image is explicitly marked non-free.',
    };
  }

  if (!combined) {
    return {
      allowed: false,
      reason: 'No clear license information.',
    };
  }

  if (
    combined.includes('noncommercial') ||
    combined.includes('non-commercial') ||
    combined.includes('cc by-nc') ||
    combined.includes('cc-by-nc') ||
    combined.includes('cc by nc')
  ) {
    return {
      allowed: false,
      reason: 'Non-commercial license is not accepted.',
    };
  }

  if (
    combined.includes('no derivatives') ||
    combined.includes('no-derivatives') ||
    combined.includes('cc by-nd') ||
    combined.includes('cc-by-nd') ||
    combined.includes('cc by nd')
  ) {
    return {
      allowed: false,
      reason: 'No-derivatives license is not accepted because hero cropping creates a derivative.',
    };
  }

  const publicDomain =
    combined.includes('public domain') ||
    combined.includes('public-domain') ||
    combined === 'pd';

  const cc0 =
    combined.includes('cc0') ||
    combined.includes('cc zero');

  const ccBy =
    combined.includes('cc by') ||
    combined.includes('cc-by');

  if (publicDomain || cc0 || ccBy) {
    return {
      allowed: true,
      reason: publicDomain
        ? 'Public domain'
        : cc0
          ? 'CC0'
          : 'Creative Commons attribution license',
    };
  }

  return {
    allowed: false,
    reason: `License not on reusable allowlist: ${license || usageTerms}`,
  };
}


export const SHARED_IMAGE_RESOLVER_VERSION = 1;

export async function searchCommons(query, limit = 12) {
  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    generator: 'search',
    gsrsearch: query,
    gsrnamespace: '6',
    gsrlimit: String(limit),
    prop: 'imageinfo',
    iiprop: 'url|extmetadata|size|mime|timestamp|user',
    iiurlwidth: '1600',
  });

  const response = await fetch(`${COMMONS_API}?${params}`, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    throw new Error(`Commons API returned ${response.status}`);
  }

  const data = await response.json();
  const pages = data.query?.pages || {};

  return Object.values(pages)
    .map((page) => {
      const info = page.imageinfo?.[0];
      if (!info) return null;

      const meta = info.extmetadata || {};
      return {
        title: page.title,
        originalUrl: info.url,
        thumbUrl: info.thumburl || info.url,
        width: Number(info.width || 0),
        height: Number(info.height || 0),
        mime: info.mime || '',
        user: info.user || '',
        timestamp: info.timestamp || '',
        description: stripHtml(meta.ImageDescription?.value || ''),
        artist: stripHtml(meta.Artist?.value || ''),
        credit: stripHtml(meta.Credit?.value || ''),
        license: stripHtml(
          meta.LicenseShortName?.value || meta.License?.value || '',
        ),
        licenseUrl: stripHtml(meta.LicenseUrl?.value || ''),
        usageTerms: stripHtml(meta.UsageTerms?.value || ''),
        attributionRequired:
          stripHtml(meta.AttributionRequired?.value || '').toLowerCase() === 'true',
        nonFree:
          stripHtml(meta.NonFree?.value || '').toLowerCase() === 'true',
        date: stripHtml(meta.DateTimeOriginal?.value || ''),
        categories: stripHtml(meta.Categories?.value || ''),
        sourcePageUrl: `https://commons.wikimedia.org/wiki/${encodeURIComponent(page.title)}`,
      };
    })
    .filter(Boolean);
}

function isLikelyPhoto(image) {
  const mime = String(image?.mime || '').toLowerCase();
  const text = `${image?.title || ''}  `.toLowerCase();
  if (!['image/jpeg', 'image/jpg', 'image/webp'].includes(mime)) return false;
  if (/(logo|diagram|map|chart|icon|flag|coat of arms|seal|poster|screenshot|illustration|drawing|symbol|infographic)/i.test(text)) return false;
  return true;
}

export function scoreImageCandidate(image, keywords = []) {
  const rights = checkReusableLicense(image);
  if (!rights.allowed) {
    return {
      eligible: false,
      score: 0,
      reasons: [rights.reason],
      rights,
    };
  }

  let score = 35;
  const reasons = [rights.reason];
  const text = [
    image?.title,
    image?.description,
    image?.categories,
    image?.artist,
    image?.credit,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  const normalizedKeywords = [...new Set(
    keywords
      .map((value) => String(value || '').trim().toLowerCase())
      .filter((value) => value.length >= 3),
  )];

  let matches = 0;
  for (const keyword of normalizedKeywords) {
    if (text.includes(keyword)) {
      matches += 1;
      score += 12;
      reasons.push(`keyword match: ${keyword}`);
    }
  }

  if (matches === 0) {
    score -= 25;
    reasons.push('no story keyword match');
  }

  const width = Number(image?.width || 0);
  const height = Number(image?.height || 0);

  if (width >= height && width > 0 && height > 0) {
    score += 8;
    reasons.push('landscape orientation');
  } else if (height > width) {
    score -= 8;
    reasons.push('portrait orientation');
  }

  if (width >= 2000) {
    score += 8;
    reasons.push('high resolution');
  } else if (width >= 1200) {
    score += 4;
    reasons.push('adequate resolution');
  } else {
    score -= 10;
    reasons.push('low resolution');
  }

  const sourceText = `${image?.artist || ''} ${image?.credit || ''} ${image?.user || ''}`.toLowerCase();
  if (/(nasa|noaa|national weather service|\bnws\b|usgs|u\.s\. geological survey|fema|white house|department of|national park service|u\.s\. government|united states government)/i.test(sourceText)) {
    score += 10;
    reasons.push('official/public-agency source signal');
  }

  return {
    eligible: true,
    score: Math.max(0, Math.min(100, score)),
    reasons,
    rights,
    keywordMatches: matches,
  };
}

export async function safeSearchCommons(query, limit = 12) {
  try {
    const results = await searchCommons(query, limit);
    return {
      ok: true,
      provider: 'Wikimedia Commons',
      query,
      results,
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      provider: 'Wikimedia Commons',
      query,
      results: [],
      error: error?.message || String(error),
    };
  }
}

export async function findBestCommonsImage({ queries = [], keywords = [], minScore = 60, minKeywordMatches = 0, requirePhoto = false, perQuery = 12 } = {}) {
  const uniqueQueries = [...new Set(
    queries
      .map((q) => String(q || '').trim())
      .filter(Boolean),
  )].slice(0, 4);

  const searches = [];
  const candidates = [];

  for (const query of uniqueQueries) {
    const result = await safeSearchCommons(query, perQuery);
    searches.push({
      query,
      ok: result.ok,
      count: result.results.length,
      error: result.error,
    });
    if (result.ok) candidates.push(...result.results);
  }

  const seen = new Set();
  const uniqueCandidates = candidates.filter((image) => {
    const key = image.title || image.originalUrl;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const evaluated = uniqueCandidates
    .map((image) => ({ image, ...scoreImageCandidate(image, keywords) }))
    .sort((a, b) => b.score - a.score);

  const eligible = evaluated.filter((item) => item.eligible && item.keywordMatches >= minKeywordMatches && (!requirePhoto || isLikelyPhoto(item.image)));
  const best = eligible.find((item) => item.score >= minScore) || null;

  return {
    found: Boolean(best),
    best,
    threshold: minScore,
    topScore: eligible[0]?.score || 0,
    candidatesEvaluated: uniqueCandidates.length,
    eligibleCandidates: eligible.length,
    searches,
  };
}



export async function downloadAndProcessHero({
  candidate,
  outputDir,
  slug,
  suffix = 'real',
  keepOriginal = true,
} = {}) {
  if (!candidate) throw new Error('candidate is required');
  if (!outputDir) throw new Error('outputDir is required');
  if (!slug) throw new Error('slug is required');

  const rights = checkReusableLicense(candidate);
  if (!rights.allowed) {
    return {
      ok: false,
      reason: rights.reason,
      rights,
      files: null,
    };
  }

  const sourceUrl = candidate.thumbUrl || candidate.originalUrl;
  if (!sourceUrl) {
    return {
      ok: false,
      reason: 'Candidate has no downloadable image URL.',
      rights,
      files: null,
    };
  }

  await mkdir(outputDir, { recursive: true });

  let response;
  try {
    response = await fetch(sourceUrl, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
  } catch (error) {
    return {
      ok: false,
      reason: error?.message || String(error),
      rights,
      files: null,
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      reason: `Image download returned ${response.status}`,
      rights,
      files: null,
    };
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) {
    return {
      ok: false,
      reason: 'Downloaded image was empty.',
      rights,
      files: null,
    };
  }

  const baseName = suffix ? `${slug}-${suffix}` : slug;
  const heroPath = join(outputDir, `${baseName}.jpg`);
  let originalFilePath = null;

  try {
    const inputMeta = await sharp(buffer, { failOn: 'error' }).metadata();

    await sharp(buffer, { failOn: 'error' })
      .resize(HERO_WIDTH, HERO_HEIGHT, {
        fit: 'cover',
        position: 'attention',
      })
      .jpeg({ quality: 88, progressive: true })
      .toFile(heroPath);

    if (keepOriginal) {
      const ext =
        inputMeta.format === 'png' ? '.png'
          : inputMeta.format === 'webp' ? '.webp'
            : inputMeta.format === 'gif' ? '.gif'
              : '.jpg';
      originalFilePath = join(outputDir, `${baseName}-original${ext}`);
      await writeFile(originalFilePath, buffer);
    }

    const heroMeta = await sharp(heroPath).metadata();

    return {
      ok: true,
      reason: 'Downloaded and processed reusable image.',
      rights,
      width: heroMeta.width,
      height: heroMeta.height,
      sourceUrl,
      heroPath,
      originalPath: originalFilePath,
    };
  } catch (error) {
    return {
      ok: false,
      reason: `Image processing failed: ${error?.message || String(error)}`,
      rights,
      files: null,
    };
  }
}
