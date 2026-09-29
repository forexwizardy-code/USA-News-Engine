import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findBestCommonsImage,
  downloadAndProcessHero
} from './lib/shared-image-resolver.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const ARTICLE_DIR = join(ROOT, 'src', 'content', 'articles');
const IMAGE_DIR = join(ROOT, 'public', 'images');

const targets = [
  {
    slug: 'foods-alive-inc-foods-alive-organic-moringa-leaf-2026-09-23',
    desk: 'recall',
    queries: [
      'Moringa oleifera powder',
      'Moringa leaves powder'
    ],
    keywords: ['moringa', 'powder'],
    required: /moringa/i,
    minScore: 58,
    minKeywordMatches: 1,
    relation: 'illustrative-file-photo',
    alt: 'Illustrative photograph of moringa leaf powder',
    caption: 'Illustrative file photo of moringa leaf powder; this is not the recalled Foods Alive package.'
  },
  {
    slug: 'lexunder-inc-food-to-live-organic-supergrass-powd-2026-09-09',
    desk: 'recall',
    queries: [
      'spirulina powder',
      'green dietary supplement powder'
    ],
    keywords: ['spirulina', 'powder'],
    required: /powder/i,
    minScore: 58,
    minKeywordMatches: 1,
    relation: 'illustrative-file-photo',
    alt: 'Illustrative photograph of green dietary powder',
    caption: 'Illustrative file photo of green dietary powder; this is not the recalled Food to Live SuperGrass package.'
  },
  {
    slug: 'the-hampton-grocer-brand-2026-09-09',
    desk: 'recall',
    queries: [
      'granola bowl',
      'granola'
    ],
    keywords: ['granola'],
    required: /granola/i,
    minScore: 58,
    minKeywordMatches: 1,
    relation: 'illustrative-file-photo',
    alt: 'Illustrative photograph of granola',
    caption: 'Illustrative file photo of granola; this is not the recalled Hampton Grocer package.'
  },
  {
    slug: 'hubble-spiral-galaxy-ngc-4698-2026-09-25',
    desk: 'science',
    queries: [
      'NGC 4698 Hubble',
      'A galaxy spinning out of sync NGC 4698',
      'NGC 4698'
    ],
    keywords: ['4698', 'hubble', 'galaxy'],
    required: /4698/i,
    minScore: 60,
    minKeywordMatches: 2,
    relation: 'exact-subject',
    alt: 'Hubble Space Telescope image of spiral galaxy NGC 4698',
    caption: null
  }
];

function yamlEscape(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, ' ');
}

function setField(text, field, value) {
  const line = `${field}: "${yamlEscape(value)}"`;
  const re = new RegExp(`^${field}:\\s*.*$`, 'm');

  if (re.test(text)) {
    return text.replace(re, line);
  }

  const sourceNameRe = /^sourceName:\s*.*$/m;
  if (sourceNameRe.test(text)) {
    return text.replace(sourceNameRe, `${line}\n$&`);
  }

  const end = text.indexOf('\n---', 4);
  if (end !== -1) {
    return `${text.slice(0, end)}\n${line}${text.slice(end)}`;
  }

  throw new Error(`Could not insert ${field}`);
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function loadJson(path) {
  if (!(await exists(path))) return null;
  return JSON.parse(await readFile(path, 'utf8'));
}

async function saveJson(path, doc) {
  await writeFile(path, JSON.stringify(doc, null, 2) + '\n', 'utf8');
}

function entriesOf(doc) {
  if (!doc) return [];
  if (Array.isArray(doc)) return doc;
  if (Array.isArray(doc.stories)) return doc.stories;
  return [];
}

function findEntry(doc, slug) {
  return entriesOf(doc).find(
    (e) =>
      e?.slug === slug ||
      String(e?.articlePath || '').endsWith(`/${slug}.md`)
  );
}

async function updateRegistries(target, meta) {
  const sharedPath = join(ROOT, 'data', 'published-stories.json');
  const shared = await loadJson(sharedPath);

  if (shared) {
    const entry = findEntry(shared, target.slug);
    if (entry) {
      entry.heroImageMode = 'licensed-photo';
      entry.heroImageSource = meta.imagePath;
      entry.heroImageRelation = target.relation;
      entry.heroImageCreator = meta.creator;
      entry.heroImageLicense = meta.license;
      entry.heroImageLicenseUrl = meta.licenseUrl;
      entry.heroImageSourcePageUrl = meta.sourcePageUrl;
      await saveJson(sharedPath, shared);
    }
  }

  if (target.desk === 'recall') {
    const recallPath = join(ROOT, 'data', 'published-recalls.json');
    const recall = await loadJson(recallPath);

    if (recall) {
      const entry = findEntry(recall, target.slug);
      if (entry) {
        entry.imageMode = 'licensed-photo';
        entry.imageSource = meta.imagePath;
        entry.imageCreator = meta.creator;
        entry.imageLicense = meta.license;
        entry.imageLicenseUrl = meta.licenseUrl;
        entry.imageSourceUrl = meta.sourcePageUrl;
        await saveJson(recallPath, recall);
      }
    }
  }

  if (target.desk === 'science') {
    const sciencePath = join(ROOT, 'data', 'published-science.json');
    const science = await loadJson(sciencePath);

    if (science) {
      const entry = findEntry(science, target.slug);
      if (entry) {
        entry.imageMode = 'licensed-photo';
        entry.imageSourceUrl = meta.imagePath;
        entry.imageCredit = meta.creator;
        entry.imageLicense = meta.license;
        entry.imageLicenseUrl = meta.licenseUrl;
        entry.imageSourcePageUrl = meta.sourcePageUrl;
        await saveJson(sciencePath, science);
      }
    }
  }
}

await mkdir(IMAGE_DIR, { recursive: true });

let replaced = 0;
let skipped = 0;

for (const target of targets) {
  console.log(`\n=== ${target.slug} ===`);

  const articlePath = join(ARTICLE_DIR, `${target.slug}.md`);

  if (!(await exists(articlePath))) {
    console.log('SKIP: article missing');
    skipped++;
    continue;
  }

  const article = await readFile(articlePath, 'utf8');

  if (
    !/imageMode:\s*"factual-graphic-fallback"/.test(article) &&
    !/image:\s*"\/images\/og-default\.svg"/.test(article)
  ) {
    console.log('SKIP: article already has a non-fallback image');
    skipped++;
    continue;
  }

  const result = await findBestCommonsImage({
    queries: target.queries,
    keywords: target.keywords,
    minScore: target.minScore,
    minKeywordMatches: target.minKeywordMatches,
    requirePhoto: true,
    perQuery: 20
  });

  if (!result.found || !result.best?.image) {
    console.log('SKIP: no safely licensed match');
    skipped++;
    continue;
  }

  const selected = result.best.image;

  const candidateText = [
    selected.title,
    selected.description,
    selected.caption
  ].filter(Boolean).join(' ');

  if (!target.required.test(candidateText)) {
    console.log(`SKIP: relevance guard failed -> ${selected.title || 'unknown'}`);
    skipped++;
    continue;
  }

  const processed = await downloadAndProcessHero({
    candidate: selected,
    outputDir: IMAGE_DIR,
    slug: target.slug,
    suffix: '-real',
    keepOriginal: false
  });

  if (!processed.ok) {
    console.log('SKIP: image processing failed');
    skipped++;
    continue;
  }

  const creator =
    selected.artist ||
    selected.credit ||
    selected.user ||
    'Wikimedia Commons contributor';

  const license =
    selected.license ||
    selected.usageTerms ||
    'Reusable Wikimedia Commons license';

  const licenseUrl = selected.licenseUrl || '';
  const sourcePageUrl = selected.sourcePageUrl || '';
  const imagePath = `/images/${target.slug}-real.jpg`;

  const caption =
    target.caption ||
    `Licensed file image of NGC 4698. Credit: ${creator}${license ? `, ${license}` : ''}.`;

  let updated = article;
  updated = setField(updated, 'image', imagePath);
  updated = setField(updated, 'imageAlt', target.alt);
  updated = setField(updated, 'imageMode', 'licensed-photo');
  updated = setField(updated, 'imageCaption', caption);
  updated = setField(updated, 'imageCreator', creator);
  updated = setField(updated, 'imageLicense', license);
  updated = setField(updated, 'imageLicenseUrl', licenseUrl);
  updated = setField(updated, 'imageSourcePageUrl', sourcePageUrl);

  await writeFile(articlePath, updated, 'utf8');

  await updateRegistries(target, {
    imagePath,
    creator,
    license,
    licenseUrl,
    sourcePageUrl
  });

  console.log(`REPLACED: ${selected.title || 'licensed image'}`);
  console.log(`SCORE: ${result.best.score}`);
  console.log(`MATCHES: ${result.best.keywordMatches}`);
  console.log(`SOURCE: ${sourcePageUrl}`);

  replaced++;
}

console.log('\n================================');
console.log(`TARGETS: ${targets.length}`);
console.log(`REPLACED: ${replaced}`);
console.log(`SKIPPED: ${skipped}`);
console.log('================================');

if (replaced === 0) {
  throw new Error('No fallback images were replaced.');
}
