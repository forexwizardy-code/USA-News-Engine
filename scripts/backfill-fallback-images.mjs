import { readFile, writeFile, readdir, mkdir, copyFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBestCommonsImage, downloadAndProcessHero } from './lib/shared-image-resolver.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const ARTICLES = join(ROOT, 'src', 'content', 'articles');
const PUBLIC_IMAGES = join(ROOT, 'public', 'images');
const DRAFT_IMAGES = join(ROOT, 'data', 'draft-images');
const SHARED_REGISTRY = join(ROOT, 'data', 'published-stories.json');

function field(text, name) {
  const m = text.match(new RegExp(`^${name}:\\s*"([^"]*)"`, 'm'));
  return m ? m[1] : '';
}

function setField(text, name, value) {
  const safe = String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');

  const re = new RegExp(`^${name}:.*$`, 'm');

  if (re.test(text)) {
    return text.replace(re, `${name}: "${safe}"`);
  }

  const closingFrontmatter = text.indexOf('\n---', 4);

  if (closingFrontmatter === -1) {
    throw new Error(`Could not locate closing frontmatter while adding ${name}`);
  }

  return (
    text.slice(0, closingFrontmatter) +
    `\n${name}: "${safe}"` +
    text.slice(closingFrontmatter)
  );
}
const stop = new Set([
  'the','and','for','with','from','into','over','after','before','amid','about',
  'that','this','these','those','will','would','could','should','have','has',
  'had','are','was','were','its','their','says'
]);

await mkdir(PUBLIC_IMAGES, { recursive: true });
await mkdir(DRAFT_IMAGES, { recursive: true });

const registry = JSON.parse(await readFile(SHARED_REGISTRY, 'utf8'));
const files = (await readdir(ARTICLES)).filter(f => f.endsWith('.md'));

let attempted = 0;
let replaced = 0;
let skipped = 0;

for (const file of files) {
  const path = join(ARTICLES, file);
  let text = await readFile(path, 'utf8');

  if (!/^author:\s*"US News Engine General News Desk"/m.test(text)) continue;

  const isFallback =
    /image:\s*"\/images\/og-default\.svg"/m.test(text) ||
    /imageMode:\s*"factual-graphic-fallback"/m.test(text);

  if (!isFallback) continue;

  attempted++;

  const slug = field(text, 'slug');
  const title = field(text, 'title');
  const category = (text.match(/^category:\s*([^\r\n]+)/m)?.[1] || '').trim();

  if (!slug || !title) {
    console.log(`\n[SKIP] ${file} — missing slug/title`);
    skipped++;
    continue;
  }

  const keywords = title
    .replace(/[^A-Za-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .map(x => x.trim())
    .filter(x => x.length >= 4 && !stop.has(x.toLowerCase()))
    .slice(0, 8);

  const entityKeywords = (String(title || '').match(/[A-Za-z0-9][A-Za-z0-9.'-]*/g) || [])
    .filter((word, index) => {
      const clean = word.replace(/[.'-]/g, '');
      if (clean.length < 3 || stop.has(clean.toLowerCase())) return false;
      const acronym = /^[A-Z0-9]{2,}$/.test(clean);
      const proper = index > 0 && /^[A-Z][a-z0-9]+$/.test(clean);
      const brand = /[a-z][A-Z]|[A-Z].*[A-Z]/.test(word);
      return acronym || proper || brand;
    });

  const queries = [
    entityKeywords.slice(0, 4).join(' '),
    entityKeywords.slice(0, 2).join(' '),
    title,
    keywords.slice(0, 3).join(' ')
  ].filter(Boolean);

  console.log(`\n[${attempted}] ${title}`);

  try {
    const result = await findBestCommonsImage({
      queries,
      keywords: [...keywords, category].filter(Boolean),
      minScore: 58,
      minKeywordMatches: 1,
      requirePhoto: true,
      perQuery: 18
    });

    if (!result.found || !result.best?.image) {
      console.log(`  KEPT FALLBACK — topScore=${result.topScore}, eligible=${result.eligibleCandidates}`);
      skipped++;
      continue;
    }

    const img = result.best.image;

    const processed = await downloadAndProcessHero({
      candidate: img,
      outputDir: DRAFT_IMAGES,
      slug,
      suffix: 'real',
      keepOriginal: true
    });

    if (!processed.ok) {
      console.log(`  DOWNLOAD FAILED — ${processed.reason || 'unknown reason'}`);
      skipped++;
      continue;
    }

    const filename = `${slug}-real.jpg`;
    const publicPath = `/images/${filename}`;
    await copyFile(processed.heroPath, join(PUBLIC_IMAGES, filename));

    const creator =
      img.artist ||
      img.credit ||
      img.user ||
      'Wikimedia Commons contributor';

    const license =
      img.license ||
      img.usageTerms ||
      'Reusable Wikimedia Commons license';

    const caption =
      `Illustrative file photo selected from Wikimedia Commons based on the story subject. Photo: ${creator}${img.license ? `, ${img.license}` : ''}.`;

    text = setField(text, 'image', publicPath);
    text = setField(text, 'imageAlt', img.description || img.title || title);
    text = setField(text, 'imageMode', 'licensed-photo');
    text = setField(text, 'imageCaption', caption);
    text = setField(text, 'imageCreator', creator);
    text = setField(text, 'imageLicense', license);
    text = setField(text, 'imageLicenseUrl', img.licenseUrl || '');
    text = setField(text, 'imageSourcePageUrl', img.sourcePageUrl || '');

    await writeFile(path, text, 'utf8');

    const reg = registry.stories?.find(s => s.slug === slug);
    if (!reg) {
      throw new Error(`Shared registry entry missing for ${slug}`);
    }

    reg.heroImageMode = 'licensed-photo';
    reg.heroImageSource = publicPath;
    reg.heroImageRelation = 'illustrative-file-photo';
    reg.heroImageCreator = creator;
    reg.heroImageLicense = license;
    reg.heroImageLicenseUrl = img.licenseUrl || '';
    reg.heroImageSourcePageUrl = img.sourcePageUrl || '';

    replaced++;
    console.log(`  REPLACED -> ${filename}`);
    console.log(`  Commons: ${img.sourcePageUrl}`);
  } catch (error) {
    console.log(`  ERROR — ${error.message}`);
    skipped++;
  }
}

if (replaced > 0) {
  await writeFile(SHARED_REGISTRY, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
}

console.log('\n================================');
console.log(`General fallbacks checked: ${attempted}`);
console.log(`Real images added:         ${replaced}`);
console.log(`Fallbacks remaining:       ${skipped}`);
console.log('================================');