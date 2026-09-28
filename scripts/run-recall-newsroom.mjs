/**
 * US News Engine â€” master recall newsroom automation script (Phase 7D).
 *
 * Orchestrates the full recall pipeline:
 *   fetch (CPSC + FDA food + FDA device) â†’ filter â†’ cluster â†’
 *   reconcile against published-recalls.json â†’ update existing articles â†’
 *   publish new articles (draft + image + article file) â†’ update registry â†’
 *   validate (recalls + publishing) â†’ build.
 *
 * Reads config/automation.json for the kill switch and publishing caps:
 *   - recallPublishingEnabled (master kill switch)
 *   - maxRecallNewPerRun (per-run cap on new publications)
 *   - maxRecallNewPerDay (daily UTC cap on new publications)
 *
 * When recallPublishingEnabled = false: fetches, analyzes, reports, but
 * makes NO public content changes.
 *
 * When recallPublishingEnabled = true: publishes new stories (up to caps),
 * updates existing stories, then validates and builds. If 0 new + 0 updated
 * + 0 status changes, exits before build/deploy.
 *
 * Run:
 *   npm run newsroom:recalls
 *   (or) node scripts/run-recall-newsroom.mjs
 */

import { readFile, writeFile, mkdir, copyFile, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { findBestCommonsImage, downloadAndProcessHero } from './lib/shared-image-resolver.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(__dirname, '..');
const CONFIG_FILE = join(PROJECT_DIR, 'config', 'automation.json');
const REGISTRY_FILE = join(PROJECT_DIR, 'data', 'published-recalls.json');
const CLUSTERS_FILE = join(
  PROJECT_DIR,
  'data',
  'recalls',
  'recall-story-clusters.json',
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
  console.log('US News Engine â€” Recall Newsroom Automation');
  console.log('============================================');
  console.log(`Started: ${new Date().toISOString()}`);
  console.log('');

  // --- Load configuration (kill switch) ---
  let config;
  try {
    config = JSON.parse(await readFile(CONFIG_FILE, 'utf8'));
  } catch {
    config = {
      recallPublishingEnabled: false,
      maxRecallNewPerRun: 1,
      maxRecallNewPerDay: 3,
    };
  }
  const publishingEnabled = config.recallPublishingEnabled === true;
  const maxPerRun = Number.isFinite(config.maxRecallNewPerRun)
    ? config.maxRecallNewPerRun
    : 1;
  const maxPerDay = Number.isFinite(config.maxRecallNewPerDay)
    ? config.maxRecallNewPerDay
    : 3;
  console.log(`Kill switch: recallPublishingEnabled = ${publishingEnabled}`);
  console.log(`Caps: maxRecallNewPerRun=${maxPerRun}, maxRecallNewPerDay=${maxPerDay}`);

  // --- Test clock / cap override (for dry-run testing ONLY) ---
  // Supports: --test-date=YYYY-MM-DD and --ignore-daily-cap
  // When ANY testing option is supplied, the script enters DRY RUN mode
  // and will NOT create/modify any production files, registry, or articles.
  // To override dry-run (for intentional test publishing), also pass
  // --allow-test-publish. The scheduled GitHub workflow must NEVER use
  // --allow-test-publish.
  const args = process.argv.slice(2);
  const testDateArg = args.find((a) => a.startsWith('--test-date='));
  const ignoreDailyCap = args.includes('--ignore-daily-cap');
  const allowTestPublish = args.includes('--allow-test-publish');
  const testDate = testDateArg ? testDateArg.split('=')[1] : null;
  const hasTestFlag = !!(testDate || ignoreDailyCap);
  // Dry run is forced when ANY test flag is present, unless --allow-test-publish
  // is also explicitly provided.
  const dryRunMode = hasTestFlag && !allowTestPublish;
  if (testDate) console.log(`TEST MODE: using test date ${testDate} (does not modify stored timestamps)`);
  if (ignoreDailyCap) console.log('TEST MODE: ignoring daily cap (does not modify stored timestamps)');
  if (dryRunMode) console.log('TEST MODE: DRY RUN â€” no production files will be modified');
  if (allowTestPublish) console.log('TEST MODE: --allow-test-publish active (test publishing enabled)');
  console.log('');

  // --- Steps 1-4: Fetch â†’ Filter â†’ Cluster ---
  console.log('--- Steps 1-4: Fetch recalls â†’ Filter â†’ Cluster ---');
  try {
    runNpm('fetch:cpsc', 'Fetch CPSC recalls');
    console.log('  CPSC fetch complete.');
    runNpm('fetch:fda-food', 'Fetch FDA food recalls');
    console.log('  FDA food fetch complete.');
    runNpm('fetch:fda-device', 'Fetch FDA device recalls');
    console.log('  FDA device fetch complete.');
    runNpm('filter:recalls', 'Filter recall candidates');
    console.log('  Recall filter complete.');
    runNpm('cluster:recalls', 'Cluster recall stories');
    console.log('  Recall clustering complete.');
  } catch (err) {
    console.error('\nFATAL: recall ingestion pipeline failed. Aborting.');
    console.error(err.message);
    process.exit(1);
  }

  // --- Load the fresh cluster feed ---
  let clusterDoc;
  try {
    clusterDoc = JSON.parse(await readFile(CLUSTERS_FILE, 'utf8'));
  } catch (err) {
    console.error('\nFATAL: recall-story-clusters.json missing or unreadable.');
    console.error(err.message);
    process.exit(1);
  }
  const clusterStories = Array.isArray(clusterDoc.stories)
    ? clusterDoc.stories
    : [];
  const eligibleStories = clusterStories.filter((s) => s.publishEligible);
  console.log(`\n  Cluster feed: ${clusterStories.length} stories total, ${eligibleStories.length} publish-eligible.`);

  // --- Step 5: Load published-recalls registry ---
  console.log('\n--- Step 5: Load published-recalls registry ---');
  let registry;
  try {
    registry = JSON.parse(await readFile(REGISTRY_FILE, 'utf8'));
    console.log(`  Registry loaded: ${registry.storyCount} published recall stories.`);
  } catch {
    registry = {
      generatedAt: new Date().toISOString(),
      storyCount: 0,
      stories: [],
    };
    console.log('  No registry found â€” treating all cluster stories as new.');
  }
  if (!Array.isArray(registry.stories)) registry.stories = [];

  // --- Step 6: Reconcile cluster feed against registry ---
  console.log('\n--- Step 6: Reconcile cluster feed against registry ---');
  const categories = { NEW: [], UPDATED: [], UNCHANGED: [], MISSING: [] };
  for (const clusterStory of eligibleStories) {
    const published = registry.stories.find(
      (s) => s.recallStoryKey === clusterStory.recallStoryKey,
    );
    if (!published) {
      categories.NEW.push(clusterStory);
      continue;
    }
    const newIds = (clusterStory.sourceRecallIds || []).filter(
      (id) => !published.allSourceRecallIds.includes(id),
    );
    if (newIds.length > 0) {
      categories.UPDATED.push({ clusterStory, published, newIds });
    } else {
      categories.UNCHANGED.push(clusterStory);
    }
  }
  // Registry entries whose storyKey is no longer in the cluster feed
  const liveKeys = new Set(eligibleStories.map((s) => s.recallStoryKey));
  for (const published of registry.stories) {
    if (!liveKeys.has(published.recallStoryKey)) {
      categories.MISSING.push(published);
    }
  }

  console.log(`  NEW: ${categories.NEW.length}`);
  console.log(`  UPDATED: ${categories.UPDATED.length}`);
  console.log(`  UNCHANGED: ${categories.UNCHANGED.length}`);
  console.log(`  MISSING (registry entries not in feed): ${categories.MISSING.length}`);

  // --- Step 7: Check daily cap ---
  // Use test date if provided (for dry-run testing only â€” never modifies stored timestamps)
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
    printSummary(categories, 0, 0, 0, startTime);
    return;
  }

  // --- Dry-run check (test mode without --allow-test-publish) ---
  if (dryRunMode) {
    console.log('\n============================================');
    console.log('TEST MODE DRY RUN â€” no production files modified');
    console.log('Candidate selection and reporting only.');
    console.log('No article files created. No registry changes.');
    console.log('No Git commit. No Cloudflare deploy.');
    console.log('============================================');
    // Report what WOULD be published
    if (categories.UPDATED.length > 0) {
      console.log(`\n  Would update ${categories.UPDATED.length} existing stories:`);
      categories.UPDATED.forEach((u) => console.log(`    - ${u.clusterStory.recallStoryKey}`));
    }
    if (newAllowed > 0 && categories.NEW.length > 0) {
      const selected = categories.NEW.slice(0, newAllowed);
      console.log(`\n  Would publish ${selected.length} new stories:`);
      for (const story of selected) {
        console.log(`    - ${story.recallStoryKey}`);
        console.log(`        firm: ${story.recallingFirm || 'n/a'}`);
        console.log(`        product: ${(story.primaryProductName || '').slice(0, 60)}`);
        console.log(`        hazard: ${story.hazardNormalized || 'n/a'}`);
        console.log(`        score: ${story.storyScore}`);
      }
    } else {
      console.log('\n  No new stories would be published (daily cap or no candidates).');
    }
    printSummary(categories, 0, 0, 0, startTime);
    return;
  }

  // --- Step 8: Process UPDATED stories first ---
  console.log('\n--- Step 8: Process UPDATED stories ---');
  let updatedCount = 0;
  for (const upd of categories.UPDATED) {
    try {
      await processUpdate(upd.clusterStory, upd.published, upd.newIds, registry);
      updatedCount++;
      console.log(`  UPDATED: ${upd.clusterStory.recallStoryKey}`);
    } catch (err) {
      console.error(
        `  UPDATE FAILED: ${upd.clusterStory.recallStoryKey} â€” ${err.message}`,
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
        `    - [${s.priority}] score=${s.storyScore} ${s.recallStoryKey}`,
      );
    }
  }

  // --- Steps 10-12: Generate drafts, images, publish articles ---
  console.log('\n--- Steps 10-12: Generate drafts â†’ images â†’ publish ---');
  let photoHeroes = 0;
  let graphicHeroes = 0;
  let newPublished = 0;
  for (const story of selectedNew) {
    try {
      console.log(`\n  Processing NEW: ${story.recallStoryKey}`);
      const result = await publishNewArticle(story, registry);
      newPublished++;
      if (result.imageKind === 'photo') photoHeroes++;
      else graphicHeroes++;
      console.log(`    Published: /news/${result.slug}/`);
    } catch (err) {
      console.error(`    PUBLISH FAILED: ${story.recallStoryKey} â€” ${err.message}`);
    }
  }
  if (newPublished > 0) {
    await saveRegistry(registry);
  }

  // --- No-change behavior: if nothing changed, exit before validation/build ---
  const totalChanges = newPublished + updatedCount;
  if (totalChanges === 0) {
    console.log('\n============================================');
    console.log('NO CONTENT CHANGES â€” skipping validation and build.');
    console.log('============================================');
    printSummary(categories, 0, updatedCount, 0, startTime, photoHeroes, graphicHeroes);
    return;
  }

  // --- Step 13: Run recall validation ---
  console.log('\n--- Step 13: Run recall validation ---');
  try {
    runNpm('validate:recalls', 'Recall validation');
    console.log('  validate:recalls: PASS');
  } catch (err) {
    console.error('  validate:recalls: FAIL â€” aborting before publishing validation.');
    console.error(err.message);
    process.exit(1);
  }

  // --- Step 14: Run publishing validation ---
  console.log('\n--- Step 14: Run publishing validation ---');
  try {
    runNpm('validate:publishing', 'Publishing validation');
    console.log('  validate:publishing: PASS');
  } catch (err) {
    console.error('  validate:publishing: FAIL â€” aborting before build.');
    console.error(err.message);
    process.exit(1);
  }

  // --- Step 15: Run Astro production build ---
  console.log('\n--- Step 15: Run Astro production build ---');
  try {
    runNpm('build', 'Astro build');
    console.log('  build: PASS');
  } catch (err) {
    console.error('  build: FAIL â€” aborting.');
    console.error(err.message);
    process.exit(1);
  }

  printSummary(categories, newPublished, updatedCount, 0, startTime, photoHeroes, graphicHeroes);
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
 * Process an UPDATE: the cluster feed has new sourceRecallIds for a story that
 * is already in the registry. Preserve slug + publishedAt, set updatedAt,
 * merge the new IDs into allSourceRecallIds, refresh hazard/classification
 * fields from the cluster, and bump the article file's updatedAt frontmatter.
 */
async function processUpdate(clusterStory, published, newIds, registry) {
  const now = new Date().toISOString();
  published.updatedAt = now;
  published.allSourceRecallIds = [
    ...new Set([...published.allSourceRecallIds, ...(clusterStory.sourceRecallIds || [])]),
  ];
  published.sourceRecallIds = clusterStory.sourceRecallIds || published.sourceRecallIds;
  published.sourceUrls = clusterStory.sourceUrls || published.sourceUrls;
  published.classification = clusterStory.classification ?? published.classification;
  published.hazardNormalized = clusterStory.hazardNormalized ?? published.hazardNormalized;
  published.lastSeenAt = clusterStory.latestSeenAt || published.lastSeenAt;
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
    // Article file may have been moved â€” skip
  }
}

/**
 * Publish a NEW recall story:
 *   1. Generate draft via generate-recall-draft.mjs
 *   2. Generate image via generate-recall-image.mjs
 *   3. Copy image to public/images/
 *   4. Create article markdown in src/content/articles/
 *   5. Add entry to registry (caller saves)
 */
async function publishNewArticle(story, registry) {
  // 1. Generate draft
  runNode(
    `scripts/generate-recall-draft.mjs "${story.recallStoryKey}"`,
    `generate-recall-draft for ${story.recallStoryKey}`,
  );

  // 2. Generate image
  let imageGenFailed = false;
  try {
    runNode(
      `scripts/generate-recall-image.mjs "${story.recallStoryKey}"`,
      `generate-recall-image for ${story.recallStoryKey}`,
    );
  } catch (err) {
    console.warn(`    Image generation failed â€” will use fallback graphic. (${err.message.split('\n')[0]})`);
    imageGenFailed = true;
  }

  // 3. Load the draft
  const draftPath = join(PROJECT_DIR, 'data', 'recalls', 'drafts', `${deriveSlug(story)}.json`);
  // The slug is derived inside the draft generator; we don't know it until we
  // load the draft. If our derived slug guess doesn't match, scan the drafts
  // directory for the most-recently-written draft whose storyKey matches.
  let draft;
  try {
    draft = JSON.parse(await readFile(draftPath, 'utf8'));
  } catch {
    draft = await findLatestDraftForStory(story.recallStoryKey);
  }
  if (!draft) {
    throw new Error(
      `Could not locate draft JSON for ${story.recallStoryKey} after generate-recall-draft.`,
    );
  }
  const slug = draft.slug;

  // 4. Copy image from data/draft-images/ to public/images/
  const sidecarPath = join(PROJECT_DIR, 'data', 'draft-images', `${slug}.json`);
  let sidecar = null;
  try {
    sidecar = JSON.parse(await readFile(sidecarPath, 'utf8'));
  } catch {
    // No sidecar â€” best effort
  }

  // Determine which image file exists (.jpg for CPSC photo, .png for graphic)
  const draftImagesDir = join(PROJECT_DIR, 'data', 'draft-images');
  const jpgPath = join(draftImagesDir, `${slug}.jpg`);
  const pngPath = join(draftImagesDir, `${slug}.png`);
  const publicImagesDir = join(PROJECT_DIR, 'public', 'images');

  // Keep official recall JPG first; otherwise try a verified reusable photo before the graphic fallback.
  if (!(await fileExists(jpgPath))) {
    const recallKeywords = [...new Set(
      [draft.title, story.recallingFirm, story.headlineSeed, ...(Array.isArray(story.brands) ? story.brands : [])]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .replace(/[^a-z0-9\s-]+/g, ' ')
        .split(/\s+/)
        .filter((word) => word.length >= 4 && !['recalled', 'recall', 'hazard', 'risk', 'product', 'products', 'brand'].includes(word)),
    )].slice(0, 8);

    const imageSearch = await findBestCommonsImage({
      queries: [draft.title, `${story.recallingFirm || ''} ${story.headlineSeed || ''}`.trim()].filter(Boolean),
      keywords: recallKeywords,
      minScore: 72,
      minKeywordMatches: 2,
      requirePhoto: true,
      perQuery: 10,
    });

    if (imageSearch.found && imageSearch.best?.image) {
      const selected = imageSearch.best.image;
      const processed = await downloadAndProcessHero({ candidate: selected, outputDir: draftImagesDir, slug, suffix: '', keepOriginal: true });
      if (processed.ok) {
        const creator = selected.artist || selected.credit || selected.user || 'Wikimedia Commons contributor';
        sidecar = {
          alt: selected.description || selected.title || draft.title,
          caption: `Illustrative file photo for ${draft.title}. Photo: ${creator}${selected.license ? `, ${selected.license}` : ''}.`,
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
  await mkdir(publicImagesDir, { recursive: true });

  let imageKind = 'graphic';
  let imageFilename = '';
  let publicImagePath = '';
  if (await fileExists(jpgPath)) {
    imageKind = 'photo';
    imageFilename = `${slug}.jpg`;
    publicImagePath = join(publicImagesDir, imageFilename);
    await copyFile(jpgPath, publicImagePath);
  } else if (await fileExists(pngPath)) {
    imageKind = 'graphic';
    imageFilename = `${slug}.png`;
    publicImagePath = join(publicImagesDir, imageFilename);
    await copyFile(pngPath, publicImagePath);
  } else {
    // Fallback: nothing to copy â€” the article will reference an image that
    // may not exist. Use the og-default as a last resort.
    imageKind = 'graphic';
    imageFilename = 'og-default.svg';
  }

  const heroImagePath = `/images/${imageFilename}`;
  const heroImageAlt = sidecar?.alt || draft.image?.alt || draft.title || slug;
  const heroImageCaption =
    sidecar?.caption || `Recall notice for ${story.headlineSeed || 'the recalled product'}.`;
  const heroImageCreator =
    sidecar?.source || 'US News Engine (editorial graphic)';
  const heroImageLicense =
    sidecar?.licenseNotes ||
    (imageKind === 'photo'
      ? 'Official CPSC recall photo â€” public domain U.S. government work'
      : 'Original editorial graphic generated by US News Engine from FDA data');
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

  // Tags: source-driven ("Recall" + agency short).
  const tags = ['Recall', story.source === 'CPSC' ? 'CPSC' : 'FDA'];
  const sourceName =
    story.source === 'CPSC'
      ? 'Consumer Product Safety Commission'
      : 'U.S. Food and Drug Administration';

  const articleContent = `---
slug: "${yamlEscape(slug)}"
title: "${yamlEscape(draft.title)}"
description: "${yamlEscape(draft.description)}"
category: recalls
author: "US News Engine Consumer Safety Desk"
publishedAt: ${now}
image: "${yamlEscape(heroImagePath)}"
imageAlt: "${yamlEscape(heroImageAlt)}"
imageMode: "${imageKind === 'photo' ? 'licensed-photo' : 'agency-graphic'}"
imageCaption: "${yamlEscape(heroImageCaption)}"
imageCreator: "${yamlEscape(heroImageCreator)}"
imageLicense: "${yamlEscape(heroImageLicense)}"
imageLicenseUrl: "${yamlEscape(heroImageLicenseUrl)}"
imageSourcePageUrl: "${yamlEscape(heroImageSourceUrl)}"
sourceName: "${yamlEscape(sourceName)}"
sourceUrl: "${yamlEscape(draft.sourceUrl || story.sourceUrls?.[0] || '')}"
sourceOffice: "${yamlEscape(sourceName)}"
tags: [${tags.map((t) => `"${t}"`).join(', ')}]
breaking: ${draft.breaking === true}
featured: false
views: 0
---

${bodyMarkdown}
`;

  const articlePath = join(PROJECT_DIR, 'src', 'content', 'articles', `${slug}.md`);
  await mkdir(dirname(articlePath), { recursive: true });
  await writeFile(articlePath, articleContent, 'utf8');

  // 6. Add entry to registry (caller will save)
  registry.stories.push({
    recallStoryKey: story.recallStoryKey,
    slug,
    articlePath: `src/content/articles/${slug}.md`,
    publishedAt: now,
    updatedAt: null,
    sourceType: story.sourceType,
    sourceRecallIds: story.sourceRecallIds || [],
    allSourceRecallIds: story.sourceRecallIds || [],
    sourceUrls: story.sourceUrls || [],
    storyStatus: 'active',
    classification: story.classification || null,
    hazardNormalized: story.hazardNormalized || null,
    lastSeenAt: story.latestSeenAt || now,
    lastCheckedAt: now,
    imageMode: imageKind === 'photo' ? 'licensed-photo' : 'agency-graphic',
    imageSource: heroImagePath,
    imageCreator: heroImageCreator,
    imageLicense: heroImageLicense,
    imageLicenseUrl: heroImageLicenseUrl,
    imageSourceUrl: heroImageSourceUrl,
  });

  return { slug, imageKind };
}

/**
 * Best-effort slug guess by mirroring the draft generator's slug formula.
 * Used only to find the draft JSON file location â€” the canonical slug comes
 * from the draft itself once loaded.
 */
function deriveSlug(story) {
  // We can't perfectly mirror buildSlug here without importing the generator,
  // so this is just a fallback guess. The real lookup happens via
  // findLatestDraftForStory when the guess fails.
  const recallDate = story.recallDates?.[0];
  const dateStr = recallDate
    ? (() => {
        const d = new Date(recallDate);
        return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
      })()
    : '';
  const slugify = (text) =>
    String(text || '')
      .toLowerCase()
      .replace(/&/g, 'and')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 80);
  return dateStr ? `${slugify(story.headlineSeed || story.primaryProductName || 'recall')}-${dateStr}` : slugify(story.headlineSeed);
}

/**
 * Scan data/recalls/drafts/ for the most-recently-modified draft whose
 * storyKey matches. Used when the slug guess doesn't match the actual draft.
 */
async function findLatestDraftForStory(storyKey) {
  const draftsDir = join(PROJECT_DIR, 'data', 'recalls', 'drafts');
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
      if (d.storyKey !== storyKey) continue;
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

function printSummary(categories, newPublished, updatedCount, statusChanges, startTime, photoHeroes = 0, graphicHeroes = 0) {
  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('\n============================================');
  console.log('US News Engine Recall Newsroom Run Summary');
  console.log('============================================');
  console.log(
    `Cluster feed: ${categories.NEW.length + categories.UPDATED.length + categories.UNCHANGED.length} publish-eligible stories`,
  );
  console.log('');
  console.log(`NEW FOUND: ${categories.NEW.length}`);
  console.log(`NEW PUBLISHED: ${newPublished}`);
  console.log(`UPDATED: ${updatedCount}`);
  console.log(`UNCHANGED: ${categories.UNCHANGED.length}`);
  console.log(`MISSING (registry, not in feed): ${categories.MISSING.length}`);
  console.log(`STATUS CHANGES: ${statusChanges}`);
  console.log('');
  console.log(`PHOTO HEROES (CPSC photo): ${photoHeroes}`);
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
