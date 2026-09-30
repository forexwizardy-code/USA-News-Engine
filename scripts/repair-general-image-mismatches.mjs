import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateGeneralEditorialGraphic } from './lib/general-editorial-graphic.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(__dirname, '..');
const ARTICLES_DIR = join(PROJECT_DIR, 'src', 'content', 'articles');
const DRAFT_IMAGES_DIR = join(PROJECT_DIR, 'data', 'draft-images');
const PUBLIC_IMAGES_DIR = join(PROJECT_DIR, 'public', 'images');
const GENERAL_REGISTRY = join(PROJECT_DIR, 'data', 'published-general-news.json');
const SHARED_REGISTRY = join(PROJECT_DIR, 'data', 'published-stories.json');

// Confirmed false-positive image matches found in the published site audit.
// This script is intentionally conservative and idempotent: after a story is
// on its own editorial graphic, later runs skip it.
const TARGETS = [
  'us-travel-plans-here-s-what-to-know-as-measles-2026-09-30',
  'sports-wizards-big-three-aims-to-change-the-narrative-as-2026-09-30',
  'business-fed-s-preferred-measure-of-inflation-dips-to-3-4-2026-09-30',
  'us-new-york-prosecutors-reopen-investigation-into-2026-09-29',
  'politics-a-very-american-makeover-for-the-state-department-2026-09-30',
  'business-self-regulation-not-enough-for-ai-safety-gary-2026-09-29',
  'politics-supreme-court-allows-trump-administration-s-2026-09-29',
  'politics-senate-blocks-democratic-effort-to-force-report-on-2026-09-30',
  'politics-democrats-in-congress-embrace-a-more-punitive-2026-09-30',
];

function parseField(raw, key) {
  const match = raw.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  if (!match) return '';
  const value = match[1].trim();
  if (value.startsWith('"')) {
    try { return JSON.parse(value); } catch {}
  }
  return value.replace(/^['"]|['"]$/g, '');
}

function quoted(value) {
  return JSON.stringify(String(value ?? ''));
}

function imageBlock(generated, title) {
  return [
    `image: ${quoted(generated.imagePath)}`,
    `imageAlt: ${quoted(generated.alt || `Editorial graphic for ${title}`)}`,
    'imageMode: "factual-graphic-fallback"',
    `imageCaption: ${quoted(generated.caption)}`,
    `imageCreator: ${quoted(generated.creator)}`,
    `imageLicense: ${quoted(generated.license)}`,
    `imageLicenseUrl: ${quoted(generated.licenseUrl || '')}`,
    'imageSourcePageUrl: ""',
  ].join('\n');
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function main() {
  console.log('[repair-general-image-mismatches] Starting confirmed mismatch repair.');

  const generalRegistry = await readJson(GENERAL_REGISTRY);
  const sharedRegistry = await readJson(SHARED_REGISTRY);
  let generalChanged = false;
  let sharedChanged = false;
  let repaired = 0;
  let skipped = 0;

  for (const slug of TARGETS) {
    const articlePath = join(ARTICLES_DIR, `${slug}.md`);
    let raw;
    try {
      raw = await readFile(articlePath, 'utf8');
    } catch {
      console.log(`  [skip] article not found: ${slug}`);
      skipped++;
      continue;
    }

    const expectedImage = `/images/${slug}-editorial.png`;
    if (raw.includes(`image: "${expectedImage}"`)) {
      console.log(`  [ok] already repaired: ${slug}`);
      skipped++;
      continue;
    }

    const title = parseField(raw, 'title');
    const description = parseField(raw, 'description');
    const category = parseField(raw, 'category');
    const sourceName = parseField(raw, 'sourceName');
    const sourceUrl = parseField(raw, 'sourceUrl');

    if (!title || !description || !category) {
      throw new Error(`Required frontmatter missing for ${slug}`);
    }

    const generated = await generateGeneralEditorialGraphic({
      draft: {
        title,
        description,
        category,
        primarySource: { name: sourceName, url: sourceUrl },
      },
      slug,
      draftImagesDir: DRAFT_IMAGES_DIR,
      publicImagesDir: PUBLIC_IMAGES_DIR,
    });

    if (!generated?.ok) {
      throw new Error(`Editorial graphic generation failed for ${slug}`);
    }

    const imageBlockRegex = /^image:\s*.*?^imageSourcePageUrl:\s*.*$/ms;
    if (!imageBlockRegex.test(raw)) {
      throw new Error(`Image frontmatter block not found for ${slug}`);
    }

    raw = raw.replace(imageBlockRegex, imageBlock(generated, title));
    await writeFile(articlePath, raw, 'utf8');

    const general = generalRegistry.stories?.find((story) => story.slug === slug);
    if (general) {
      general.imagePath = generated.imagePath;
      general.imageMode = 'factual-graphic-fallback';
      general.imageCreator = generated.creator;
      general.imageLicense = generated.license;
      general.imageLicenseUrl = generated.licenseUrl || '';
      general.imageSourcePageUrl = '';
      general.imageRelation = generated.relation;
      generalChanged = true;
    }

    const shared = sharedRegistry.stories?.find((story) => story.slug === slug);
    if (shared) {
      shared.heroImageMode = 'factual-graphic-fallback';
      shared.heroImageSource = generated.imagePath;
      shared.heroImageRelation = generated.relation;
      shared.heroImageCreator = generated.creator;
      shared.heroImageLicense = generated.license;
      shared.heroImageLicenseUrl = generated.licenseUrl || '';
      shared.heroImageSourcePageUrl = '';
      sharedChanged = true;
    }

    console.log(`  [fixed] ${slug} -> ${generated.imagePath}`);
    repaired++;
  }

  if (generalChanged) {
    generalRegistry.generatedAt = new Date().toISOString();
    await writeFile(GENERAL_REGISTRY, JSON.stringify(generalRegistry, null, 2) + '\n', 'utf8');
  }
  if (sharedChanged) {
    sharedRegistry.generatedAt = new Date().toISOString();
    await writeFile(SHARED_REGISTRY, JSON.stringify(sharedRegistry, null, 2) + '\n', 'utf8');
  }

  console.log(`[repair-general-image-mismatches] Complete: repaired=${repaired}, skipped=${skipped}`);
}

main().catch((err) => {
  console.error(`[repair-general-image-mismatches] FAILED: ${err.message}`);
  process.exit(1);
});
