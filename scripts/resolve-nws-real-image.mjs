/**
 * US News Engine — real-photo-first newsroom image resolver (Phase 4B).
 *
 * Searches official U.S. government sources and Wikimedia Commons for a real,
 * properly licensed photograph related to the story. If found, downloads and
 * processes it into a 1200x675 hero derivative, preserving full provenance
 * metadata. If no suitable image is found, reports realPhotoFound: false and
 * the Phase 4A map-data image remains the fallback.
 *
 * Image priority order:
 *   1. Exact-event official photo
 *   2. Official/public-domain real photo (exact location)
 *   3. Properly licensed real photo (Wikimedia Commons)
 *   4. Factual map/data visual (Phase 4A map-data)
 *   5. Branded generated graphic (fallback)
 *
 * Run manually:
 *   npm run resolve-image:nws
 *   (or) bun run scripts/resolve-nws-real-image.mjs
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBestCommonsImage, downloadAndProcessHero } from './lib/shared-image-resolver.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(__dirname, '..');
const DRAFTS_DIR = join(PROJECT_DIR, 'data', 'drafts');
const OUTPUT_DIR = join(PROJECT_DIR, 'data', 'draft-images');


// ===========================================================================
// Main
// ===========================================================================

async function main() {
  console.log('[resolve-nws-real-image] Starting real-photo resolver.');

  // --- Load the draft ------------------------------------------------------
  const targetStoryKey = process.argv[2] || 'flood-warning__lake-il__2026-09-27';
  const draftPath = join(DRAFTS_DIR, `${targetStoryKey}.json`);
  const draft = JSON.parse(await readFile(draftPath, 'utf8'));
  console.log(`  Draft: ${draftPath}`);
  console.log(`  Story: ${draft.title}`);

  // --- Story keywords for matching -----------------------------------------
  const waterBody = draft.body
    ?.map((s) => s.paragraphs.join(' '))
    .join(' ')
    .match(/(?:along|applies to|covers|near)\s+(?:the\s+)?((?:[A-Z][a-zA-Z]+\s+){1,3}(?:River|Creek|Bayou))/);
  const river = waterBody ? waterBody[1].trim() : null;

  // Build story-specific keywords from the draft location and event
  const event = draft.weatherMetadata?.event || 'Weather Alert';
  const location = draft.location || '';
  const firstArea = String(draft.location || draft.weatherMetadata?.areaDesc || '').split(';')[0].trim();

  const storyKeywords = [
    river,
    firstArea,
    location,
    event.replace(/warning|watch|advisory/i, '').trim().toLowerCase() || 'weather',
    'flood',
  ].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i); // dedupe
  console.log(`  Keywords: ${storyKeywords.join(', ')}`);

  // --- Search Wikimedia Commons with story-specific queries ----------------
  // Build queries from the actual story location, not hardcoded.
  const locationParts = firstArea.split(',').map((s) => s.trim());
  const stateName = locationParts.length > 1 ? locationParts[1] : '';
  const countyName = locationParts[0] || firstArea;
  const eventType = event.replace(/warning|watch|advisory/i, '').trim().toLowerCase();

  const queries = [
    // Try specific location + event
    `${countyName} ${stateName} ${eventType}`.trim(),
    // Try just the location
    `${countyName} ${stateName}`.trim(),
    // Try river name if available
    river ? `${river} ${eventType}` : null,
    river ? river : null,
  ].filter(Boolean).slice(0, 3); // max 3 queries

  const imageSearch = await findBestCommonsImage({
    queries,
    keywords: storyKeywords,
    minScore: 68,
    minKeywordMatches: 1,
    requirePhoto: true,
    perQuery: 12,
  });

  console.log(`\n  Candidates evaluated: ${imageSearch.candidatesEvaluated}`);
  console.log(`  Eligible candidates: ${imageSearch.eligibleCandidates}`);
  console.log(`  Top score: ${imageSearch.topScore}`);

  const THRESHOLD = 68;
  const best = imageSearch.best
    ? {
        img: imageSearch.best.image,
        score: imageSearch.best.score,
        reasons: imageSearch.best.reasons,
        keywordMatches: imageSearch.best.keywordMatches,
      }
    : null;

  if (!best) {
    console.log(`\n  No candidate met the threshold (${THRESHOLD}).`);
    console.log('  realPhotoFound: false');
    console.log('  Phase 4A map-data image remains the correct fallback.');

    // Write a "not found" metadata file for the record
    const notFoundPath = join(OUTPUT_DIR, `${draft.slug}-real.json`);
    await mkdir(OUTPUT_DIR, { recursive: true });
    await writeFile(
      notFoundPath,
      JSON.stringify(
        {
          storyKey: draft.storyKey,
          realPhotoFound: false,
          searchedAt: new Date().toISOString(),
          searchesPerformed: queries,
          candidatesEvaluated: imageSearch.candidatesEvaluated,
          threshold: THRESHOLD,
          topScore: imageSearch.topScore || 0,
          recommendation: 'Use Phase 4A map-data image as fallback.',
        },
        null,
        2,
      ) + '\n',
      'utf8',
    );
    console.log(`  Metadata (not-found): ${notFoundPath}`);
    return;
  }

  // --- Selected image ------------------------------------------------------
  const selected = best.img;
  console.log(`\n  SELECTED: ${selected.title} (score: ${best.score})`);

  // --- Download and process through the shared legal gate ------------------
  const processed = await downloadAndProcessHero({
    candidate: selected,
    outputDir: OUTPUT_DIR,
    slug: draft.slug,
    suffix: 'real',
    keepOriginal: true,
  });

  if (!processed.ok) {
    console.log(`  Reusable image processing failed: ${processed.reason}`);
    console.log('  realPhotoFound: false');
    console.log('  Phase 4A map-data image remains the correct fallback.');
    return;
  }

  const heroPath = processed.heroPath;
  const originalPath = processed.originalPath;
  const width = processed.width;
  const height = processed.height;
  console.log(`  Hero image: ${heroPath} (${width}x${height})`);
  // --- Determine image relation from source metadata -----------------------
  const creator =
    selected.artist ||
    selected.credit ||
    selected.user ||
    'Wikimedia Commons contributor';

  const candidateText = [
    selected.title,
    selected.description,
    selected.categories,
  ].filter(Boolean).join(' ').toLowerCase();

  const countyNeedle = String(countyName || firstArea || '').trim().toLowerCase();
  const stateNeedle = String(stateName || '').trim().toLowerCase();
  const countyMatched =
    Boolean(countyNeedle) && candidateText.includes(countyNeedle);
  const stateMatched =
    !stateNeedle || candidateText.includes(stateNeedle);

  const exactLocationProven = countyMatched && stateMatched;

  const imageRelation = exactLocationProven
    ? 'exact-location'
    : 'illustrative-file-photo';

  const caption = exactLocationProven
    ? `File photo associated with ${firstArea}; it does not depict the current ${event}. Photo: ${creator}${selected.license ? `, ${selected.license}` : ''}.`
    : `Illustrative file photo related to ${event}; it is not presented as the current event or exact alert location. Photo: ${creator}${selected.license ? `, ${selected.license}` : ''}.`;

  // --- Write metadata ------------------------------------------------------
  const metadata = {
    storyKey: draft.storyKey,
    realPhotoFound: true,
    imageMode: 'licensed-photo',
    imageRelation,
    status: 'draft',
    width,
    height,
    source: 'Wikimedia Commons',
    sourceOrganization: `${creator} (Wikimedia Commons)`,
    dataSource: 'Wikimedia Commons API',
    originalImageUrl: selected.originalUrl,
    sourcePageUrl: selected.sourcePageUrl,
    creator,
    credit: selected.credit || creator,
    license: selected.license,
    licenseUrl: selected.licenseUrl,
    attributionRequired: selected.attributionRequired,
    originalDate: selected.date,
    downloadedAt: new Date().toISOString(),
    title: selected.title || '',
    description: selected.description || '',
    alt: selected.description || selected.title || 'Weather file photo',
    caption,
    copyrightCheck: `passed — ${processed.rights?.reason || selected.license || 'reusable license verified'}`,
    selectionReason: best.reasons.join('; '),
    suitabilityScore: best.score,
    keywordMatches: best.keywordMatches,
    files: {
      heroJpg: `data/draft-images/${draft.slug}-real.jpg`,
    },
  };
  const metaPath = join(OUTPUT_DIR, `${draft.slug}-real.json`);
  await writeFile(metaPath, JSON.stringify(metadata, null, 2) + '\n', 'utf8');
  console.log(`  Metadata: ${metaPath}`);

  console.log('\n[resolve-nws-real-image] SUCCESS — real photo resolved.');
  console.log(`  imageRelation: ${imageRelation}`);
  console.log(`  license: ${selected.license}`);
  console.log(`  creator: ${selected.artist}`);
  console.log(`  originalDate: ${selected.date}`);
  console.log(`  caption: ${caption}`);
  console.log('');
}

main().catch((err) => {
  console.error(`\n[resolve-nws-real-image] ERROR: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
