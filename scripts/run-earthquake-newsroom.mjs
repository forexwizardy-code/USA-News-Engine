/**
 * US News Engine — master earthquake newsroom automation script (Phase 8B).
 *
 * Orchestrates the full earthquake pipeline:
 *   fetch (USGS) → filter → stories → validate →
 *   reconcile against published-earthquakes.json → update existing articles →
 *   publish new articles (draft + image + article file) → update registry →
 *   validate → build.
 *
 * Reads config/automation.json for the kill switch and publishing caps:
 *   - earthquakePublishingEnabled (master kill switch)
 *   - maxEarthquakeNewPerRun (per-run cap on new publications)
 *   - maxEarthquakeNewPerDay (daily UTC cap on new publications)
 *
 * When earthquakePublishingEnabled = false: fetches, analyzes, reports, but
 * makes NO public content changes. This is the default state until a future
 * phase explicitly enables automated publishing.
 *
 * When earthquakePublishingEnabled = true: publishes new stories (up to caps),
 * updates existing stories, then validates and builds. If 0 new + 0 updated,
 * exits before build/deploy (no-change behavior).
 *
 * Test mode:
 *   --test-date=YYYY-MM-DD  Use a fake "today" for daily-cap calculations.
 *   --ignore-daily-cap      Bypass the daily cap (for test runs).
 *   --fixture               Use the test fixture as the only candidate.
 *   --allow-test-publish    Override dry-run mode (test publishing enabled).
 *
 * When ANY test flag is present WITHOUT --allow-test-publish, the script
 * enters DRY RUN mode — NO production files (registry, article markdowns,
 * public images) are modified. The scheduled GitHub workflow MUST NEVER use
 * --allow-test-publish.
 *
 * Run:
 *   npm run newsroom:earthquakes
 *   (or) node scripts/run-earthquake-newsroom.mjs
 */

import { readFile, writeFile, mkdir, copyFile, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { findBestCommonsImage, downloadAndProcessHero } from './lib/shared-image-resolver.mjs';
import { upsertSharedPublishedStory } from './lib/shared-published-registry.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(__dirname, '..');
const CONFIG_FILE = join(PROJECT_DIR, 'config', 'automation.json');
const REGISTRY_FILE = join(PROJECT_DIR, 'data', 'published-earthquakes.json');
const STORIES_FILE = join(
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

// ===========================================================================
// Helpers
// ===========================================================================

/** Run an npm script under PROJECT_DIR; throw with stderr on failure. */
function runNpm(script, label) {
  console.log(`  $ npm run ${script}`);
  try {
    execSync(`npm run ${script}`, { cwd: PROJECT_DIR, stdio: 'pipe' });
  } catch (err) {
    const stderr = err.stderr?.toString?.() || '';
    const stdout = err.stdout?.toString?.() || '';
    throw new Error(
      `${label} failed.\n-- stderr --\n${stderr.slice(0, 800)}\n-- stdout --\n${stdout.slice(0, 400)}`,
    );
  }
}

/** Run a node script under PROJECT_DIR; throw with stderr on failure. */
function runNode(scriptWithArgs, label) {
  console.log(`  $ node ${scriptWithArgs}`);
  try {
    execSync(`node ${scriptWithArgs}`, { cwd: PROJECT_DIR, stdio: 'pipe' });
  } catch (err) {
    const stderr = err.stderr?.toString?.() || '';
    const stdout = err.stdout?.toString?.() || '';
    throw new Error(
      `${label} failed.\n-- stderr --\n${stderr.slice(0, 800)}\n-- stdout --\n${stdout.slice(0, 400)}`,
    );
  }
}

async function fileExists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Escape a string for inclusion inside a YAML double-quoted value. */
function yamlEscape(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// ===========================================================================
// Main
// ===========================================================================

async function main() {
  const startTime = Date.now();
  console.log('============================================');
  console.log('US News Engine — Earthquake Newsroom Automation');
  console.log('============================================');
  console.log(`Started: ${new Date().toISOString()}`);
  console.log('');

  // --- Load configuration (kill switch) ---
  let config;
  try {
    config = JSON.parse(await readFile(CONFIG_FILE, 'utf8'));
  } catch {
    config = {
      earthquakePublishingEnabled: false,
      maxEarthquakeNewPerRun: 1,
      maxEarthquakeNewPerDay: 3,
    };
  }
  const publishingEnabled = config.earthquakePublishingEnabled === true;
  const maxPerRun = Number.isFinite(config.maxEarthquakeNewPerRun)
    ? config.maxEarthquakeNewPerRun
    : 1;
  const maxPerDay = Number.isFinite(config.maxEarthquakeNewPerDay)
    ? config.maxEarthquakeNewPerDay
    : 3;
  console.log(`Kill switch: earthquakePublishingEnabled = ${publishingEnabled}`);
  console.log(`Caps: maxEarthquakeNewPerRun=${maxPerRun}, maxEarthquakeNewPerDay=${maxPerDay}`);

  // --- Test clock / cap override (for dry-run testing ONLY) ---
  const args = process.argv.slice(2);
  const testDateArg = args.find((a) => a.startsWith('--test-date='));
  const ignoreDailyCap = args.includes('--ignore-daily-cap');
  const allowTestPublish = args.includes('--allow-test-publish');
  const useFixture = args.includes('--fixture');
  const testDate = testDateArg ? testDateArg.split('=')[1] : null;
  const hasTestFlag = !!(testDate || ignoreDailyCap || useFixture);
  // Dry run is forced when ANY test flag is present, unless --allow-test-publish
  // is also explicitly provided.
  const dryRunMode = hasTestFlag && !allowTestPublish;
  if (testDate) console.log(`TEST MODE: using test date ${testDate} (does not modify stored timestamps)`);
  if (ignoreDailyCap) console.log('TEST MODE: ignoring daily cap (does not modify stored timestamps)');
  if (useFixture) console.log('TEST MODE: --fixture active (test fixture used as candidate)');
  if (dryRunMode) console.log('TEST MODE: DRY RUN — no production files will be modified');
  if (allowTestPublish) console.log('TEST MODE: --allow-test-publish active (test publishing enabled)');
  console.log('');

  // =========================================================================
  // Steps 1-4: Fetch → Filter → Stories → Validate
  // =========================================================================
  if (!useFixture) {
    console.log('--- Steps 1-4: Fetch USGS → Filter → Stories → Validate ---');
    try {
      runNpm('fetch:earthquakes', 'Fetch USGS earthquakes');
      console.log('  USGS fetch complete.');
      runNpm('filter:earthquakes', 'Filter earthquake candidates');
      console.log('  Earthquake filter complete.');
      runNpm('stories:earthquakes', 'Build earthquake stories');
      console.log('  Earthquake stories complete.');
      try {
        runNpm('validate:earthquakes', 'Validate earthquake data');
        console.log('  validate:earthquakes: PASS');
      } catch (err) {
        console.warn('  validate:earthquakes: FAIL — continuing in dry-run-friendly mode.');
        console.warn(`    ${String(err.message || err).split('\n')[0]}`);
      }
    } catch (err) {
      console.error('\nFATAL: earthquake ingestion pipeline failed. Aborting.');
      console.error(err.message);
      process.exit(1);
    }
  } else {
    console.log('--- TEST FIXTURE MODE: skipping fetch/filter/stories/validate ---');
  }

  // --- Load the fresh story feed (or the test fixture) ---
  let liveStories = [];
  if (useFixture) {
    let fixture;
    try {
      fixture = JSON.parse(await readFile(TEST_FIXTURE_FILE, 'utf8'));
      liveStories = [fixture];
    } catch (err) {
      console.error('\nFATAL: test-fixture.json missing or unreadable.');
      console.error(err.message);
      process.exit(1);
    }
  } else {
    let storiesDoc;
    try {
      storiesDoc = JSON.parse(await readFile(STORIES_FILE, 'utf8'));
    } catch (err) {
      console.error('\nFATAL: earthquake-story-records.json missing or unreadable.');
      console.error(err.message);
      process.exit(1);
    }
    liveStories = Array.isArray(storiesDoc.stories) ? storiesDoc.stories : [];
  }

  // Only consider publishEligible stories for reconciliation/publication.
  // Filter out any testOnly fixture that may have leaked into the production
  // feed (it should never be there, but we are belt-and-suspenders).
  const eligibleStories = liveStories.filter(
    (s) => s.publishEligible === true && s.testOnly !== true,
  );
  console.log(`\n  Story feed: ${liveStories.length} stories total, ${eligibleStories.length} publish-eligible.`);

  // --- Step 5: Load published-earthquakes registry ---
  console.log('\n--- Step 5: Load published-earthquakes registry ---');
  let registry;
  try {
    registry = JSON.parse(await readFile(REGISTRY_FILE, 'utf8'));
    console.log(`  Registry loaded: ${registry.storyCount} published earthquake stories.`);
  } catch {
    registry = {
      generatedAt: new Date().toISOString(),
      storyCount: 0,
      stories: [],
    };
    console.log('  No registry found — treating all stories as new.');
  }
  if (!Array.isArray(registry.stories)) registry.stories = [];

  // --- Step 6: Reconcile feed against registry ---
  console.log('\n--- Step 6: Reconcile story feed against registry ---');
  const categories = { NEW: [], UPDATED: [], UNCHANGED: [], MISSING: [] };
  for (const story of eligibleStories) {
    const published = registry.stories.find(
      (s) => s.earthquakeKey === story.earthquakeKey,
    );
    if (!published) {
      categories.NEW.push(story);
      continue;
    }
    // Detect "UPDATED" — magnitude changed, alert escalated, tsunami flipped,
    // felt jumped, or USGS updated timestamp moved forward materially.
    const prevMag = published.lastMagnitude;
    const currMag = story.magnitude;
    const prevAlert = published.lastAlert;
    const currAlert = story.alert;
    const prevTsunami = published.lastTsunami;
    const currTsunami = story.tsunami === true;
    const prevFelt = published.lastFelt;
    const currFelt = story.felt;
    const feltJumped = prevFelt != null && currFelt != null && currFelt >= prevFelt * 1.5;

    const isUpdated =
      (prevMag != null && currMag != null && prevMag !== currMag) ||
      (prevAlert || null) !== (currAlert || null) ||
      prevTsunami !== currTsunami ||
      feltJumped;

    if (isUpdated) {
      categories.UPDATED.push({ story, published });
    } else {
      categories.UNCHANGED.push(story);
    }
  }
  // Registry entries whose storyKey is no longer in the feed
  const liveKeys = new Set(eligibleStories.map((s) => s.earthquakeKey));
  for (const published of registry.stories) {
    if (!liveKeys.has(published.earthquakeKey)) {
      categories.MISSING.push(published);
    }
  }

  console.log(`  NEW: ${categories.NEW.length}`);
  console.log(`  UPDATED: ${categories.UPDATED.length}`);
  console.log(`  UNCHANGED: ${categories.UNCHANGED.length}`);
  console.log(`  MISSING (registry entries not in feed): ${categories.MISSING.length}`);

  // --- Step 7: Check daily cap ---
  const today = (testDate || new Date().toISOString()).slice(0, 10);
  const publishedToday = registry.stories.filter(
    (s) => s.publishedAt && s.publishedAt.startsWith(today),
  ).length;
  const remainingDaily = ignoreDailyCap ? maxPerDay : Math.max(0, maxPerDay - publishedToday);
  const newAllowed = ignoreDailyCap ? maxPerRun : Math.min(maxPerRun, remainingDaily);
  console.log(
    `\n  Daily cap: ${publishedToday} published today (UTC), ${remainingDaily} remaining, ${newAllowed} allowed this run`,
  );

  // --- Kill switch check ---
  if (!publishingEnabled) {
    console.log('\n============================================');
    console.log('PUBLISHING DISABLED (kill switch active)');
    console.log('No public content changes will be made.');
    console.log('No Git commit. No Cloudflare deploy.');
    console.log('============================================');
    printSummary(categories, 0, 0, 0, startTime, 0, 0);
    return;
  }

  // --- Dry-run check (test mode without --allow-test-publish) ---
  if (dryRunMode) {
    console.log('\n============================================');
    console.log('TEST MODE DRY RUN — no production files modified');
    console.log('Candidate selection and reporting only.');
    console.log('No article files created. No registry changes.');
    console.log('No Git commit. No Cloudflare deploy.');
    console.log('============================================');
    // Report what WOULD be published
    if (categories.UPDATED.length > 0) {
      console.log(`\n  Would update ${categories.UPDATED.length} existing stories:`);
      categories.UPDATED.forEach((u) => console.log(`    - ${u.story.earthquakeKey}`));
    }
    if (newAllowed > 0 && categories.NEW.length > 0) {
      const selected = selectNewStories(categories.NEW, newAllowed);
      console.log(`\n  Would publish ${selected.length} new stories:`);
      for (const story of selected) {
        console.log(`    - ${story.earthquakeKey}`);
        console.log(`        magnitude: ${story.magnitude}`);
        console.log(`        place: ${story.place || 'n/a'}`);
        console.log(`        alert: ${story.alert || 'n/a'}`);
        console.log(`        score: ${story.storyScore}`);
      }
    } else {
      console.log('\n  No new stories would be published (daily cap or no candidates).');
    }
    printSummary(categories, 0, 0, 0, startTime, 0, 0);
    return;
  }

  // --- Step 8: Process UPDATED stories first ---
  console.log('\n--- Step 8: Process UPDATED stories ---');
  let updatedCount = 0;
  for (const upd of categories.UPDATED) {
    try {
      await processUpdate(upd.story, upd.published);
      updatedCount++;
      console.log(`  UPDATED: ${upd.story.earthquakeKey}`);
    } catch (err) {
      console.error(
        `  UPDATE FAILED: ${upd.story.earthquakeKey} — ${err.message}`,
      );
    }
  }
  if (updatedCount > 0) {
    await saveRegistry(registry);
  }

  // --- Step 9: Select NEW stories ---
  console.log('\n--- Step 9: Select NEW stories for publication ---');
  const selectedNew = selectNewStories(categories.NEW, newAllowed);
  console.log(`  Selected ${selectedNew.length} new stories for publication`);
  if (selectedNew.length > 0) {
    console.log('  Selection (priority, score, key):');
    for (const s of selectedNew) {
      console.log(
        `    - [${s.priority || 'medium'}] score=${s.storyScore} ${s.earthquakeKey}`,
      );
    }
  }

  // --- Steps 10-12: Generate drafts, images, publish articles ---
  console.log('\n--- Steps 10-12: Generate drafts → images → publish ---');
  let shakemapHeroes = 0;
  let graphicHeroes = 0;
  let newPublished = 0;
  for (const story of selectedNew) {
    try {
      console.log(`\n  Processing NEW: ${story.earthquakeKey}`);
      const result = await publishNewArticle(story, registry);
      newPublished++;
      if (result.imageKind === 'shakemap') shakemapHeroes++;
      else graphicHeroes++;
      console.log(`    Published: /news/${result.slug}/`);
    } catch (err) {
      console.error(`    PUBLISH FAILED: ${story.earthquakeKey} — ${err.message}`);
    }
  }
  if (newPublished > 0) {
    await saveRegistry(registry);
  }

  // --- No-change behavior: if nothing changed, exit before validation/build ---
  const totalChanges = newPublished + updatedCount;
  if (totalChanges === 0) {
    console.log('\n============================================');
    console.log('NO CONTENT CHANGES — skipping validation and build.');
    console.log('============================================');
    printSummary(categories, 0, updatedCount, 0, startTime, shakemapHeroes, graphicHeroes);
    return;
  }

  // --- Step 13: Run earthquake validation ---
  console.log('\n--- Step 13: Run earthquake validation ---');
  try {
    runNpm('validate:earthquakes', 'Earthquake validation');
    console.log('  validate:earthquakes: PASS');
  } catch (err) {
    console.error('  validate:earthquakes: FAIL — aborting before publishing validation.');
    console.error(err.message);
    process.exit(1);
  }

  // --- Step 14: Run publishing validation ---
  console.log('\n--- Step 14: Run publishing validation ---');
  try {
    runNpm('validate:publishing', 'Publishing validation');
    console.log('  validate:publishing: PASS');
  } catch (err) {
    console.error('  validate:publishing: FAIL — aborting before build.');
    console.error(err.message);
    process.exit(1);
  }

  // --- Step 15: Run Astro production build ---
  console.log('\n--- Step 15: Run Astro production build ---');
  try {
    runNpm('build', 'Astro build');
    console.log('  build: PASS');
  } catch (err) {
    console.error('  build: FAIL — aborting.');
    console.error(err.message);
    process.exit(1);
  }

  printSummary(categories, newPublished, updatedCount, 0, startTime, shakemapHeroes, graphicHeroes);
}

// ===========================================================================
// Selection logic
// ===========================================================================

/**
 * Select new stories respecting the cap.
 * Sort: priority high first, then storyScore descending.
 */
function selectNewStories(newStories, cap) {
  if (cap <= 0 || newStories.length === 0) return [];
  const priorityRank = (p) => (p === 'high' ? 0 : p === 'medium' ? 1 : 2);
  const sorted = [...newStories].sort((a, b) => {
    const pr = priorityRank(a.priority) - priorityRank(b.priority);
    if (pr !== 0) return pr;
    return (b.storyScore || 0) - (a.storyScore || 0);
  });
  return sorted.slice(0, cap);
}

// ===========================================================================
// Update + publish functions
// ===========================================================================

/**
 * Process an UPDATE: the live feed has new details for a story that is already
 * in the registry. Preserve slug + publishedAt, set updatedAt, refresh the
 * last-known magnitude/alert/tsunami/felt fields, and bump the article file's
 * updatedAt frontmatter.
 */
async function processUpdate(story, published) {
  const now = new Date().toISOString();
  published.updatedAt = now;
  published.lastMagnitude = story.magnitude;
  published.lastAlert = story.alert || null;
  published.lastTsunami = story.tsunami === true;
  published.lastFelt = story.felt != null ? story.felt : published.lastFelt;
  published.lastSeenAt = story.latestSeenAt || published.lastSeenAt;
  published.lastCheckedAt = now;
  published.storyStatus = 'active';

  // Update article frontmatter updatedAt
  const articlePath = join(PROJECT_DIR, published.articlePath);
  try {
    let content = await readFile(articlePath, 'utf8');
    if (content.includes('updatedAt:')) {
      content = content.replace(/^updatedAt:.*$/m, `updatedAt: ${now}`);
    } else {
      content = content.replace(
        /^(publishedAt:.*$)/m,
        `$1\nupdatedAt: ${now}`,
      );
    }
    await writeFile(articlePath, content, 'utf8');
  } catch {
    // Article file may have been moved — skip
  }
}

/**
 * Publish a NEW earthquake story:
 *   1. Generate draft via generate-earthquake-draft.mjs
 *   2. Generate image via generate-earthquake-image.mjs
 *   3. Copy image to public/images/
 *   4. Create article markdown in src/content/articles/
 *   5. Add entry to registry (caller saves)
 */
async function publishNewArticle(story, registry) {
  // 1. Generate draft
  runNode(
    `scripts/generate-earthquake-draft.mjs "${story.earthquakeKey}"`,
    `generate-earthquake-draft for ${story.earthquakeKey}`,
  );

  // 2. Generate image
  let imageGenFailed = false;
  try {
    runNode(
      `scripts/generate-earthquake-image.mjs "${story.earthquakeKey}"`,
      `generate-earthquake-image for ${story.earthquakeKey}`,
    );
  } catch (err) {
    console.warn(`    Image generation failed — will use fallback graphic. (${err.message.split('\n')[0]})`);
    imageGenFailed = true;
  }

  // 3. Load the draft
  // The slug is derived inside the draft generator; we mirror its formula
  // here to find the draft JSON.
  const slugGuess = deriveSlug(story);
  const draftPath = join(PROJECT_DIR, 'data', 'earthquakes', 'drafts', `${slugGuess}.json`);
  let draft;
  try {
    draft = JSON.parse(await readFile(draftPath, 'utf8'));
  } catch {
    draft = await findLatestDraftForStory(story.earthquakeKey);
  }
  if (!draft) {
    throw new Error(
      `Could not locate draft JSON for ${story.earthquakeKey} after generate-earthquake-draft.`,
    );
  }
  const slug = draft.slug;

  // 4. Copy image from data/draft-images/ to public/images/
  const sidecarPath = join(PROJECT_DIR, 'data', 'draft-images', `${slug}.json`);
  let sidecar = null;
  try {
    sidecar = JSON.parse(await readFile(sidecarPath, 'utf8'));
  } catch {
    // No sidecar — best effort
  }

  // Determine which image file exists (.jpg for ShakeMap, .png for coordinate-map)
  const draftImagesDir = join(PROJECT_DIR, 'data', 'draft-images');
  const jpgPath = join(draftImagesDir, `${slug}.jpg`);
  const pngPath = join(draftImagesDir, `${slug}.png`);
  const publicImagesDir = join(PROJECT_DIR, 'public', 'images');
  await mkdir(publicImagesDir, { recursive: true });

  // If there is no official USGS ShakeMap, try a verified reusable location photo
  // before falling back to the generated coordinate/data graphic.
  if (sidecar?.imageMode !== 'shakemap') {
    const placeText = String(story.place || '').trim();
    const placeCore = placeText
      .replace(/^\d+(?:\.\d+)?\s*km\s+[A-Z]{1,3}\s+of\s+/i, '')
      .trim();
    const locationKeywords = [...new Set(
      placeCore
        .toLowerCase()
        .replace(/[^a-z0-9\s-]+/g, ' ')
        .split(/\s+/)
        .filter((word) => word.length >= 4 && !['near', 'area', 'region', 'island'].includes(word)),
    )].slice(0, 6);

    if (placeCore && locationKeywords.length > 0) {
      const imageSearch = await findBestCommonsImage({
        queries: [`${placeCore} landscape`, placeCore],
        keywords: locationKeywords,
        minScore: 68,
        minKeywordMatches: 1,
        requirePhoto: true,
        perQuery: 10,
      });

      if (imageSearch.found && imageSearch.best?.image) {
        const selected = imageSearch.best.image;
        const processed = await downloadAndProcessHero({
          candidate: selected,
          outputDir: draftImagesDir,
          slug,
          suffix: '',
          keepOriginal: true,
        });

        if (processed.ok) {
          const creator = selected.artist || selected.credit || selected.user || 'Wikimedia Commons contributor';
          sidecar = {
            ...sidecar,
            provider: 'Wikimedia Commons',
            alt: selected.description || selected.title || `File photo of ${placeCore}`,
            caption: `Illustrative file photo of ${placeCore}; it does not depict damage from this earthquake. Photo: ${creator}${selected.license ? `, ${selected.license}` : ''}.`,
            source: creator,
            licenseNotes: selected.license || selected.usageTerms || 'Reusable Wikimedia Commons license',
            licenseUrl: selected.licenseUrl || '',
            sourceUrl: selected.sourcePageUrl || '',
            imageMode: 'licensed-photo',
            imageRelation: 'illustrative-file-photo',
            originalImageUrl: selected.originalUrl || '',
            downloadedSourceUrl: processed.sourceUrl || '',
            keywordMatches: imageSearch.best.keywordMatches,
            suitabilityScore: imageSearch.best.score,
            generatedAt: new Date().toISOString(),
          };
          await writeFile(sidecarPath, JSON.stringify(sidecar, null, 2) + '\n', 'utf8');
        }
      }
    }
  }

  let imageKind = 'graphic';
  let imageFilename = '';
  let publicImagePath = '';
  if (await fileExists(jpgPath) && ['shakemap', 'licensed-photo'].includes(sidecar?.imageMode)) {
    imageKind = sidecar.imageMode === 'shakemap' ? 'shakemap' : 'photo';
    imageFilename = `${slug}.jpg`;
    publicImagePath = join(publicImagesDir, imageFilename);
    await copyFile(jpgPath, publicImagePath);
  } else if (await fileExists(pngPath)) {
    imageKind = 'graphic';
    imageFilename = `${slug}.png`;
    publicImagePath = join(publicImagesDir, imageFilename);
    await copyFile(pngPath, publicImagePath);
  } else {
    imageKind = 'graphic';
    imageFilename = 'og-default.svg';
  }

  const heroImagePath = `/images/${imageFilename}`;
  const heroImageAlt = sidecar?.alt || draft.image?.alt || draft.title || slug;
  const heroImageCaption =
    sidecar?.caption || `Earthquake graphic for ${draft.title}.`;
  const heroImageCreator =
    sidecar?.source || 'US News Engine (editorial data graphic)';
  const heroImageLicense =
    sidecar?.licenseNotes ||
    (imageKind === 'shakemap'
      ? 'Official USGS ShakeMap — public domain U.S. government work'
      : 'Original editorial graphic generated by US News Engine from USGS data');
  const heroImageLicenseUrl = sidecar?.licenseUrl || '';
  const heroImageSourceUrl = sidecar?.sourceUrl || draft.sourceUrl || '';

  // 5. Build article markdown file
  const now = new Date().toISOString();
  const bodyMarkdown = draft.body
    .map((section) => {
      const heading = section.heading ? `\n## ${section.heading}\n` : '';
      const paras = section.paragraphs.join('\n\n');
      return heading + paras;
    })
    .join('\n\n');

  // Tags: source-driven ("Earthquake", "USGS", plus state if known).
  const tags = ['Earthquake', 'USGS'];
  if (story.state) tags.push(story.state);

  const articleContent = `---
slug: "${yamlEscape(slug)}"
title: "${yamlEscape(draft.title)}"
description: "${yamlEscape(draft.description)}"
category: us
author: "US News Engine Weather Desk"
publishedAt: ${now}
image: "${yamlEscape(heroImagePath)}"
imageAlt: "${yamlEscape(heroImageAlt)}"
imageMode: "${imageKind === 'photo' ? 'licensed-photo' : 'agency-graphic'}"
imageCaption: "${yamlEscape(heroImageCaption)}"
imageCreator: "${yamlEscape(heroImageCreator)}"
imageLicense: "${yamlEscape(heroImageLicense)}"
imageLicenseUrl: "${yamlEscape(heroImageLicenseUrl)}"
imageSourcePageUrl: "${yamlEscape(heroImageSourceUrl)}"
sourceName: "U.S. Geological Survey"
sourceUrl: "${yamlEscape(draft.sourceUrl || story.url || '')}"
sourceOffice: "U.S. Geological Survey"
tags: [${tags.map((t) => `"${t}"`).join(', ')}]
${story.state ? `state: "${yamlEscape(story.state)}"` : ''}
breaking: ${draft.breaking === true}
featured: false
views: 0
---

${bodyMarkdown}
`;

  const articlePath = join(PROJECT_DIR, 'src', 'content', 'articles', `${slug}.md`);
  await mkdir(dirname(articlePath), { recursive: true });
  await writeFile(articlePath, articleContent, 'utf8');

  const sharedImageRelation =
    sidecar?.imageRelation ||
    (imageKind === 'photo' ? 'illustrative-file-photo' : 'current-alert-data');

  await upsertSharedPublishedStory({
    storyKey: slug,
    slug,
    articlePath: `src/content/articles/${slug}.md`,
    publishedAt: now,
    updatedAt: null,
    currentAlertIds: [story.eventId || story.sourceId].filter(Boolean),
    allAlertIds: [story.eventId || story.sourceId].filter(Boolean),
    event: 'Earthquake',
    location: story.place || story.state || 'Unknown',
    sourceOffice: 'U.S. Geological Survey',
    lifecycleStatus: 'active',
    lastNwsEffectiveAt: null,
    lastNwsExpiresAt: null,
    lastNwsEndsAt: null,
    lastCheckedAt: now,
    heroImageMode: imageKind === 'photo' ? 'licensed-photo' : (imageKind === 'shakemap' ? 'source-image' : 'agency-graphic'),
    heroImageSource: heroImagePath,
    heroImageRelation: sharedImageRelation,
    heroImageCreator,
    heroImageLicense,
    heroImageLicenseUrl,
    heroImageSourcePageUrl: heroImageSourceUrl,
    breaking: draft.breaking === true,
  });
  // 6. Add entry to registry (caller will save)
  registry.stories.push({
    earthquakeKey: story.earthquakeKey,
    eventId: story.eventId || story.sourceId || null,
    slug,
    articlePath: `src/content/articles/${slug}.md`,
    publishedAt: now,
    updatedAt: null,
    lastMagnitude: story.magnitude,
    lastAlert: story.alert || null,
    lastTsunami: story.tsunami === true,
    lastFelt: story.felt != null ? story.felt : null,
    storyStatus: 'active',
    lastSeenAt: story.latestSeenAt || now,
    lastCheckedAt: now,
    imageMode: imageKind === 'photo' ? 'licensed-photo' : 'agency-graphic',
    imageSource: heroImagePath,
    imageCreator: heroImageCreator,
    imageLicense: heroImageLicense,
    imageLicenseUrl: heroImageLicenseUrl,
    imageSourceUrl: heroImageSourceUrl,
    breaking: draft.breaking === true,
  });

  return { slug, imageKind };
}

/**
 * Best-effort slug guess by mirroring the draft generator's slug formula.
 * Used only to find the draft JSON file location — the canonical slug comes
 * from the draft itself once loaded.
 */
function deriveSlug(story) {
  const d = story.time ? new Date(story.time) : null;
  const dateStr = d
    ? `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
    : '';
  const magStr = story.magnitude != null
    ? `m${String(story.magnitude).replace('.', '')}`
    : 'earthquake';
  const placeClean = String(story.place || '')
    .replace(/^[\d.]+\s*km\s+[A-Za-z]+\s+of\s+/i, '')
    .replace(/,\s*/g, '-')
    .replace(/\s+/g, '-')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
  return `${magStr}-earthquake-${placeClean}-${dateStr}`;
}

/**
 * Scan data/earthquakes/drafts/ for the most-recently-modified draft whose
 * earthquakeKey matches. Used when the slug guess doesn't match the actual draft.
 */
async function findLatestDraftForStory(earthquakeKey) {
  const draftsDir = join(PROJECT_DIR, 'data', 'earthquakes', 'drafts');
  let files;
  try {
    files = await (await import('node:fs/promises')).readdir(draftsDir);
  } catch {
    return null;
  }
  const jsonFiles = files.filter((f) => f.endsWith('.json'));
  let best = null;
  let bestTime = 0;
  for (const f of jsonFiles) {
    try {
      const d = JSON.parse(await readFile(join(draftsDir, f), 'utf8'));
      if (d.earthquakeKey !== earthquakeKey) continue;
      const t = d.generatedAt ? new Date(d.generatedAt).getTime() : 0;
      if (t >= bestTime) {
        bestTime = t;
        best = d;
      }
    } catch {
      // skip
    }
  }
  return best;
}

// ===========================================================================
// Persistence
// ===========================================================================

async function saveRegistry(registry) {
  registry.generatedAt = new Date().toISOString();
  registry.storyCount = registry.stories.length;
  await mkdir(dirname(REGISTRY_FILE), { recursive: true });
  await writeFile(REGISTRY_FILE, JSON.stringify(registry, null, 2) + '\n', 'utf8');
  console.log(`  Registry saved: ${REGISTRY_FILE} (${registry.storyCount} stories).`);
}

// ===========================================================================
// Summary
// ===========================================================================

function printSummary(categories, newPublished, updatedCount, statusChanges, startTime, shakemapHeroes = 0, graphicHeroes = 0) {
  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('\n============================================');
  console.log('US News Engine Earthquake Newsroom Run Summary');
  console.log('============================================');
  console.log(
    `Story feed: ${categories.NEW.length + categories.UPDATED.length + categories.UNCHANGED.length} publish-eligible stories`,
  );
  console.log('');
  console.log(`NEW FOUND: ${categories.NEW.length}`);
  console.log(`NEW PUBLISHED: ${newPublished}`);
  console.log(`UPDATED: ${updatedCount}`);
  console.log(`UNCHANGED: ${categories.UNCHANGED.length}`);
  console.log(`MISSING (registry, not in feed): ${categories.MISSING.length}`);
  console.log(`STATUS CHANGES: ${statusChanges}`);
  console.log('');
  console.log(`SHAKEMAP HEROES (USGS photo): ${shakemapHeroes}`);
  console.log(`GRAPHIC HEROES (editorial): ${graphicHeroes}`);
  console.log('');
  console.log(`Duration: ${duration}s`);
  console.log('============================================');
}

// ===========================================================================
// Bootstrap
// ===========================================================================

main().catch((err) => {
  console.error(`\nFATAL: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
