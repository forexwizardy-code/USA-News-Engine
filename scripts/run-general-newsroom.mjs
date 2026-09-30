import { checkGeneralPhotoContext } from './lib/general-image-context.mjs';
/**
 * US News Engine â€” master General News newsroom automation script (Phase 10A.2.3).
 *
 * Orchestrates: fetch â†’ registry â†’ stories â†’ selection (with all gates) â†’
 * draft â†’ publish â†’ validate â†’ build.
 *
 * Gates (spec Â§1-8):
 *   - U.S. relevance: HIGH gets +15 score bonus; MEDIUM +5; LOW/NONE not eligible.
 *   - Single-source rule: independentPublisherCount=1 needs gov source OR
 *     low-dispute factual; politics contested needs 2 families or official+reporting.
 *   - Publisher concentration: max 2 per family per run, 6 per day.
 *   - Politics cap: max 1 per run, 6 per day; â‰¤30% of homepage Top Stories.
 *   - Category diversity: prefer diversity; don't publish 2 same-category
 *     when other categories have strong eligible.
 *   - Article evidence: no article from headline-only; skip if insufficient.
 *   - Copyright: original summaries only; no publisher text/photos.
 *
 * Reads config/automation.json:
 *   generalPublishingEnabled, maxGeneralNewPerRun, maxGeneralNewPerDay,
 *   maxGeneralPerPublisherPerRun, maxGeneralPerPublisherPerDay,
 *   maxPoliticsNewPerRun, maxPoliticsNewPerDay
 *
 * Run:
 *   npm run newsroom:general
 *   (or) node scripts/run-general-newsroom.mjs [--dry-run]
 */

import { findEventDuplicate } from './lib/general-event-duplicate.mjs';
import { readFile, writeFile, mkdir, access, readdir, copyFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { findBestCommonsImage, downloadAndProcessHero } from './lib/shared-image-resolver.mjs';
import { generateGeneralEditorialGraphic } from './lib/general-editorial-graphic.mjs';

import { upsertSharedPublishedStory } from './lib/shared-published-registry.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(__dirname, '..');
const CONFIG_FILE = join(PROJECT_DIR, 'config', 'automation.json');
const STORIES_FILE = join(PROJECT_DIR, 'data', 'general-news', 'general-news-story-records.json');
const REGISTRY_FILE = join(PROJECT_DIR, 'data', 'published-general-news.json');
const ARTICLES_DIR = join(PROJECT_DIR, 'src', 'content', 'articles');
const DRAFT_IMAGES_DIR = join(PROJECT_DIR, 'data', 'draft-images');
const PUBLIC_IMAGES_DIR = join(PROJECT_DIR, 'public', 'images');

// ===========================================================================
// Helpers
// ===========================================================================

function runNpm(script, label) {
  console.log(`  $ npm run ${script}`);
  try {
    execSync(`npm run ${script}`, { cwd: PROJECT_DIR, stdio: 'pipe' });
  } catch (err) {
    const stderr = err.stderr?.toString?.() || '';
    const stdout = err.stdout?.toString?.() || '';
    // Print the validation output so we can see which check failed
    const failLines = stdout.split('\n').filter((l) => /FAIL/i.test(l)).join('\n');
    throw new Error(`${label} failed.\n-- FAIL lines --\n${failLines.slice(0, 800)}\n-- stderr --\n${stderr.slice(0, 400)}`);
  }
}

function runNode(scriptWithArgs, label) {
  console.log(`  $ node ${scriptWithArgs}`);
  try {
    execSync(`node ${scriptWithArgs}`, { cwd: PROJECT_DIR, stdio: 'pipe' });
  } catch (err) {
    const stderr = err.stderr?.toString?.() || '';
    throw new Error(`${label} failed.\n-- stderr --\n${stderr.slice(0, 800)}`);
  }
}

async function fileExists(p) {
  try { await access(p); return true; } catch { return false; }
}

async function loadJsonOptional(path) {
  try {
    const raw = await readFile(path, 'utf8');
    return { ok: true, doc: JSON.parse(raw) };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: false, reason: 'missing' };
    return { ok: false, reason: String(err) };
  }
}

function yamlEscape(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Slug from a story's title (word-boundary, no fragments). */
function slugify(text) {
  const cleaned = String(text || '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return 'story';
  const words = cleaned.split(/\s+/);
  const result = [];
  let total = 0;
  for (const w of words) {
    if (total + w.length + (result.length > 0 ? 1 : 0) > 50) break;
    result.push(w);
    total += w.length + (result.length > 1 ? 1 : 0);
  }
  return result.join('-').replace(/-{2,}/g, '-').replace(/^-|-$/g, '') || 'story';
}

// ===========================================================================
// Phase 10A.2.4 â€” Durable duplicate identity
// ===========================================================================

/**
 * Build a set of all durable identity keys for already-published stories.
 * A candidate is ALREADY PUBLISHED if ANY of these match:
 *   - generalStoryKey (cluster key)
 *   - slug
 *   - primarySourceUrl (canonical source URL)
 *   - normalized source URL
 *
 * This multi-key approach ensures duplicate protection survives even if
 * one identity field changes (e.g. a new slug derivation).
 */
function buildPublishedIdentitySet(registry) {
  const published = {
    storyKeys: new Set(),
    slugs: new Set(),
    sourceUrls: new Set(),
    normalizedUrls: new Set(),
    publishedTitles: [],
  };
  if (!registry || !Array.isArray(registry.stories)) return published;
  for (const s of registry.stories) {
    if (s.generalStoryKey) published.storyKeys.add(s.generalStoryKey);
    if (s.slug) published.slugs.add(s.slug);
    if (s.sourceUrls && Array.isArray(s.sourceUrls)) {
      for (const u of s.sourceUrls) {
        if (u) {
          published.sourceUrls.add(u);
          // Also add normalized form
          try {
            const nu = new URL(u);
            published.normalizedUrls.add(`${nu.hostname.replace(/^www\./, '')}${nu.pathname.replace(/\/+$/, '')}`.toLowerCase());
          } catch {}
        }
      }
    } else if (s.primarySourceUrl) {
      published.sourceUrls.add(s.primarySourceUrl);
    }
  }
  published.publishedTitles = registry.stories.filter((s) => s && s.title);
  return published;
}

/**
 * Check if a candidate story is already published by matching against
 * the durable identity set. Returns true if ANY identity matches.
 */
function isAlreadyPublished(story, publishedSet) {
  if (story.generalStoryKey && publishedSet.storyKeys.has(story.generalStoryKey)) return true;
  // Check candidate's source URLs against published source URLs
  const candidateUrls = story.allSourceUrls || [story.primarySourceUrl];
  for (const u of candidateUrls) {
    if (!u) continue;
    if (publishedSet.sourceUrls.has(u)) return true;
    try {
      const nu = new URL(u);
      if (publishedSet.normalizedUrls.has(`${nu.hostname.replace(/^www\./, '')}${nu.pathname.replace(/\/+$/, '')}`.toLowerCase())) return true;
    } catch {}
  }
  // Extra, conservative event-level guard across DIFFERENT publisher URLs.
  const related = findEventDuplicate(story, publishedSet.publishedTitles);
  if (related) {
    console.log(`  [event-${related.status}] holding "${story.title}"; related to "${related.oldTitle}" (overlap=${related.score})`);
    return true;
  }
  return false;
}

/**
 * Deduplicate the published-general-news.json registry. If the same
 * generalStoryKey appears multiple times, keep only the FIRST entry
 * (which has the original publishedAt).
 */
function deduplicateRegistry(registry) {
  if (!registry || !Array.isArray(registry.stories)) return registry;
  const seen = new Set();
  const deduped = [];
  for (const s of registry.stories) {
    const key = s.generalStoryKey || s.slug;
    if (key && seen.has(key)) {
      // Duplicate â€” skip (keep the first/original entry)
      continue;
    }
    if (key) seen.add(key);
    deduped.push(s);
  }
  if (deduped.length !== registry.stories.length) {
    console.log(`  [dedup] Registry deduplicated: ${registry.stories.length} â†’ ${deduped.length} entries`);
  }
  registry.stories = deduped;
  registry.storyCount = deduped.length;
  return registry;
}

// ===========================================================================
// Selection logic â€” with all gates + pre-selection duplicate filter
// ===========================================================================

/**
 * Select stories for publication respecting ALL gates:
 *   - DUPLICATE FILTER: already-published stories are removed BEFORE selection
 *   - U.S. relevance: only HIGH or MEDIUM (not LOW/NONE)
 *   - Single-source rule: contested politics needs 2 families or gov source
 *   - Publisher concentration: max N per family per run
 *   - Politics cap: max M per run
 *   - Category diversity: prefer different categories
 *   - Daily caps: per-desk and per-publisher
 */
function selectStories(eligible, opts) {
  const {
    maxPerRun,
    maxPoliticsPerRun,
    maxPerPublisherPerRun,
    maxPerDay,
    maxPoliticsPerDay,
    maxPerPublisherPerDay,
    publishedTodayCount,
    politicsPublishedTodayCount,
    publisherPublishedToday, // {familyName: count}
    publishedSet, // durable identity set from buildPublishedIdentitySet
  } = opts;

  // Phase 10A.2.4 â€” PRE-SELECTION FILTER: remove already-published stories
  // BEFORE ranking. This prevents an old top-ranked article from blocking
  // genuinely new stories.
  const newEligible = [];
  let alreadyPublishedCount = 0;
  for (const story of eligible) {
    if (isAlreadyPublished(story, publishedSet)) {
      alreadyPublishedCount++;
      continue;
    }
    newEligible.push(story);
  }
  if (alreadyPublishedCount > 0) {
    console.log(`  [duplicate-filter] ${alreadyPublishedCount} already-published story(ies) removed from selection pool`);
  }

  // Sort: usRelevance HIGH first, then score desc, then freshness
  const sorted = [...newEligible].sort((a, b) => {
    const ua = a.usRelevance === 'high' ? 0 : 1;
    const ub = b.usRelevance === 'high' ? 0 : 1;
    if (ua !== ub) return ua - ub;
    if (b.storyScore !== a.storyScore) return b.storyScore - a.storyScore;
    return 0;
  });

  const selected = [];
  const familyCountThisRun = {};
  let politicsCountThisRun = 0;
  const categoryCountThisRun = {};

  for (const story of sorted) {
    if (selected.length >= maxPerRun) break;
    if (publishedTodayCount + selected.length >= maxPerDay) break;

    // Politics cap
    if (story.category === 'politics') {
      if (politicsCountThisRun >= maxPoliticsPerRun) continue;
      if (politicsPublishedTodayCount + politicsCountThisRun >= maxPoliticsPerDay) continue;
    }

    // Publisher concentration
    const fam = story.primaryPublisherFamily || story.primarySource || 'unknown';
    if ((familyCountThisRun[fam] || 0) >= maxPerPublisherPerRun) continue;
    if ((publisherPublishedToday[fam] || 0) + (familyCountThisRun[fam] || 0) >= maxPerPublisherPerDay) continue;

    // Category diversity: don't publish 2 same-category when other categories exist
    if ((categoryCountThisRun[story.category] || 0) >= 1) {
      // Check if there are strong eligible from other categories
      const otherCats = sorted.filter((s) =>
        s.category !== story.category &&
        !selected.includes(s) &&
        (categoryCountThisRun[s.category] || 0) === 0
      );
      if (otherCats.length > 0) continue; // prefer diversity
    }

    const relatedInBatch = findEventDuplicate(story, selected);
    if (relatedInBatch) {
      console.log(`  [event-in-batch-${relatedInBatch.status}] holding "${story.title}"; related to "${relatedInBatch.oldTitle}"`);
      continue;
    }

    selected.push(story);
    familyCountThisRun[fam] = (familyCountThisRun[fam] || 0) + 1;
    if (story.category === 'politics') politicsCountThisRun++;
    categoryCountThisRun[story.category] = (categoryCountThisRun[story.category] || 0) + 1;
  }

  return { selected, familyCountThisRun, politicsCountThisRun, categoryCountThisRun };
}

// ===========================================================================
// Publish a new General News article
// ===========================================================================

async function publishNewArticle(story, registry) {
  // Phase 10A.2.4 â€” SAFETY NET: refuse to publish if the storyKey already
  // exists in the registry. This is defense-in-depth; the pre-selection
  // filter should have already removed it, but this prevents any edge case
  // from creating a duplicate.
  const existing = registry.stories.find((s) => s.generalStoryKey === story.generalStoryKey);
  if (existing) {
    console.log(`    [skip-duplicate] ${story.generalStoryKey} already published (slug=${existing.slug}, publishedAt=${existing.publishedAt}) â€” skipping`);
    return null;
  }
  // Last-minute event-level protection, including stories published earlier in this run.
  const relatedBeforePublish = findEventDuplicate(story, registry.stories || []);
  if (relatedBeforePublish) {
    console.log(`    [skip-event-${relatedBeforePublish.status}] "${story.title}" resembles "${relatedBeforePublish.oldTitle}"; holding publication`);
    return null;
  }

  // 1. Generate draft
  runNode(
    `scripts/generate-general-news-draft.mjs "${story.generalStoryKey}"`,
    `generate-general-news-draft for ${story.generalStoryKey}`,
  );

  // 2. Load the draft
  const dateStr = new Date(story.earliestPublishedAtSource || new Date()).toISOString().slice(0, 10);
  const titleSlug = slugify(story.title);
  const slug = `${story.category}-${titleSlug}-${dateStr}`;
  const draftPath = join(PROJECT_DIR, 'data', 'general-news', 'drafts', `${slug}.json`);
  let draft;
  try {
    draft = JSON.parse(await readFile(draftPath, 'utf8'));
  } catch {
    // Fallback: find the latest draft for this storyKey
    const draftsDir = join(PROJECT_DIR, 'data', 'general-news', 'drafts');
    const files = await readdir(draftsDir);
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const d = JSON.parse(await readFile(join(draftsDir, f), 'utf8'));
        if (d.generalStoryKey === story.generalStoryKey) { draft = d; break; }
      } catch {}
    }
  }
  if (!draft) throw new Error(`Could not find draft for ${story.generalStoryKey}`);

  const finalSlug = draft.slug || slug;
  // Resolve a reusable real image first. If no safe/relevant image is available,
  // keep the existing editorial graphic fallback.
  let heroImagePath = '/images/og-default.svg';
  let heroImageAlt = draft.image?.alt || draft.title;
  let heroImageMode = draft.image?.mode || 'factual-graphic-fallback';
  let heroImageCaption = draft.image?.caption || `Editorial graphic for ${draft.title}.`;
  let heroImageCreator = draft.image?.credit || 'US News Engine (editorial graphic)';
  let heroImageLicense = 'Original editorial graphic generated by US News Engine';
  let heroImageLicenseUrl = '';
  let heroImageSourcePageUrl = draft.image?.sourcePageUrl || draft.primarySource?.url || '';
  let heroImageRelation = 'fallback-graphic';

  const imageStopWords = new Set([
    'the', 'and', 'for', 'with', 'from', 'into', 'over', 'after', 'before',
    'amid', 'about', 'that', 'this', 'these', 'those', 'will', 'would', 'could',
    'should', 'have', 'has', 'had', 'are', 'was', 'were', 'its', 'their', 'says',
  ]);

  const titleKeywords = String(draft.title || '')
    .replace(/[^A-Za-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 4 && !imageStopWords.has(word.toLowerCase()))
    .slice(0, 8);

  const entityKeywords = (String(draft.title || '').match(/[A-Za-z0-9][A-Za-z0-9.'-]*/g) || [])
    .filter((word, index) => {
      const clean = word.replace(/[.'-]/g, '');
      if (clean.length < 3 || imageStopWords.has(clean.toLowerCase())) return false;
      const acronym = /^[A-Z0-9]{2,}$/.test(clean);
      const proper = index > 0 && /^[A-Z][a-z0-9]+$/.test(clean);
      const brand = /[a-z][A-Z]|[A-Z].*[A-Z]/.test(word);
      return acronym || proper || brand;
    });

  const imageQueries = [
    entityKeywords.slice(0, 4).join(' '),
    entityKeywords.slice(0, 2).join(' '),
    draft.title,
    titleKeywords.slice(0, 3).join(' '),
  ].filter(Boolean);

  let imageSearch = await findBestCommonsImage({
    queries: imageQueries,
    keywords: [...titleKeywords, draft.category].filter(Boolean),
    minScore: 58,
    minKeywordMatches: 1,
    requirePhoto: true,
    perQuery: 18,
  });

  // Rescue pass: only use strong named-entity context.
  // If we cannot identify enough specific context, keep the safe fallback
  // instead of risking a misleading real photograph.
  if (!imageSearch.found) {
    const genericEntityWords = new Set([
      'British', 'American', 'United', 'States', 'News', 'Live',
      'Latest', 'Five', 'Three', 'Four', 'Two', 'Men', 'Women',
      'President', 'Government', 'Officials', 'Police'
    ]);

    const descriptionEntities = (
      String(draft.description || '')
        .match(/\b[A-Z][A-Za-z0-9.'-]{2,}(?:\s+[A-Z][A-Za-z0-9.'-]{2,}){0,3}\b/g)
      || []
    )
      .map((item) => item.trim())
      .filter((item) => {
        const words = item.split(/\s+/);
        return words.some((word) => !genericEntityWords.has(word));
      });

    const strongEntities = [...new Set([
      ...entityKeywords,
      ...descriptionEntities,
    ])]
      .filter(Boolean)
      .slice(0, 8);

    if (strongEntities.length >= 2) {
      const rescueQueries = [
        strongEntities.slice(0, 3).join(' '),
        strongEntities.slice(0, 2).join(' '),
      ].filter(Boolean);

      imageSearch = await findBestCommonsImage({
        queries: rescueQueries,
        keywords: strongEntities,
        minScore: 58,
        minKeywordMatches: 2,
        requirePhoto: true,
        perQuery: 18,
      });

      if (imageSearch.found && imageSearch.best?.image) {
        console.log(`  General News image rescue found: ${imageSearch.best.image.title}`);
      }
    } else {
      console.log('  General News image rescue skipped: insufficient specific entity context.');
    }
  }
  if (imageSearch.found && imageSearch.best?.image && checkGeneralPhotoContext(draft.title, imageSearch.best.image).ok) {
    const selected = imageSearch.best.image;
    const processed = await downloadAndProcessHero({
      candidate: selected,
      outputDir: DRAFT_IMAGES_DIR,
      slug: finalSlug,
      suffix: 'real',
      keepOriginal: true,
    });

    if (processed.ok) {
      await mkdir(PUBLIC_IMAGES_DIR, { recursive: true });
      const publicFilename = `${finalSlug}-real.jpg`;
      await copyFile(processed.heroPath, join(PUBLIC_IMAGES_DIR, publicFilename));

      const creator = selected.artist || selected.credit || selected.user || 'Wikimedia Commons contributor';
      heroImagePath = `/images/${publicFilename}`;
      heroImageAlt = selected.description || selected.title || draft.title;
      heroImageMode = 'licensed-photo';
      heroImageCaption = `File photo selected from Wikimedia Commons based on the story subject. Photo: ${creator}${selected.license ? `, ${selected.license}` : ''}.`;
      heroImageCreator = creator;
      heroImageLicense = selected.license || selected.usageTerms || 'Reusable Wikimedia Commons license';
      heroImageLicenseUrl = selected.licenseUrl || '';
      heroImageSourcePageUrl = selected.sourcePageUrl || '';
      heroImageRelation = 'illustrative-file-photo';

      const provenance = {
        provider: 'Wikimedia Commons',
        title: selected.title || null,
        creator,
        license: heroImageLicense,
        licenseUrl: heroImageLicenseUrl,
        sourcePageUrl: heroImageSourcePageUrl,
        downloadedSourceUrl: processed.sourceUrl || '',
        originalImageUrl: selected.originalUrl || '',
        relation: heroImageRelation,
        score: imageSearch.best.score,
        keywordMatches: imageSearch.best.keywordMatches,
        width: processed.width,
        height: processed.height,
        generatedAt: new Date().toISOString(),
      };
      await writeFile(join(DRAFT_IMAGES_DIR, `${finalSlug}-real.json`), JSON.stringify(provenance, null, 2) + '\n', 'utf8');
    }
  }

  // Licensed existing graphic search.
  // This runs only after the real-photo searches fail and before we create
  // our own editorial graphic.
  if (heroImagePath === '/images/og-default.svg') {
    const graphicKeywords = [...new Set([
      ...entityKeywords,
      ...titleKeywords,
    ])]
      .filter(Boolean)
      .slice(0, 8);

    if (graphicKeywords.length >= 2) {
      const graphicQueries = [
        `${graphicKeywords.slice(0, 3).join(' ')} illustration`,
        `${graphicKeywords.slice(0, 3).join(' ')} graphic`,
        `${graphicKeywords.slice(0, 2).join(' ')} map`,
      ];

      const graphicSearch = await findBestCommonsImage({
        queries: graphicQueries,
        keywords: graphicKeywords,
        minScore: 70,
        minKeywordMatches: 2,
        requireGraphic: true,
        perQuery: 18,
      });

      if (graphicSearch.found && graphicSearch.best?.image) {
        const selectedGraphic = graphicSearch.best.image;

        console.log(
          `  Licensed General News graphic found: ${selectedGraphic.title}`
        );

        const processedGraphic = await downloadAndProcessHero({
          candidate: selectedGraphic,
          outputDir: DRAFT_IMAGES_DIR,
          slug: finalSlug,
          suffix: 'licensed-graphic',
          keepOriginal: true,
        });

        if (processedGraphic.ok) {
          await mkdir(PUBLIC_IMAGES_DIR, { recursive: true });

          const publicFilename =
            `${finalSlug}-licensed-graphic.jpg`;

          await copyFile(
            processedGraphic.heroPath,
            join(PUBLIC_IMAGES_DIR, publicFilename)
          );

          const creator =
            selectedGraphic.artist ||
            selectedGraphic.credit ||
            selectedGraphic.user ||
            'Wikimedia Commons contributor';

          heroImagePath =
            `/images/${publicFilename}`;

          heroImageAlt =
            selectedGraphic.description ||
            selectedGraphic.title ||
            draft.title;

          // Keep the existing graphic-compatible mode so current validators
          // and article rendering continue to work.
          heroImageMode =
            'factual-graphic-fallback';

          heroImageCaption =
            `Licensed illustrative graphic from Wikimedia Commons, selected for relevance to the story subject. Graphic: ${creator}${selectedGraphic.license ? `, ${selectedGraphic.license}` : ''}.`;

          heroImageCreator = creator;

          heroImageLicense =
            selectedGraphic.license ||
            selectedGraphic.usageTerms ||
            'Reusable Wikimedia Commons license';

          heroImageLicenseUrl =
            selectedGraphic.licenseUrl || '';

          heroImageSourcePageUrl =
            selectedGraphic.sourcePageUrl || '';

          heroImageRelation =
            'licensed-illustrative-graphic';

          const graphicProvenance = {
            provider: 'Wikimedia Commons',
            type: 'licensed-illustrative-graphic',
            title: selectedGraphic.title || null,
            creator,
            license: heroImageLicense,
            licenseUrl: heroImageLicenseUrl,
            sourcePageUrl: heroImageSourcePageUrl,
            originalImageUrl: selectedGraphic.originalUrl || '',
            relation: heroImageRelation,
            score: graphicSearch.best.score,
            keywordMatches: graphicSearch.best.keywordMatches,
            width: processedGraphic.width,
            height: processedGraphic.height,
            generatedAt: new Date().toISOString(),
          };

          await writeFile(
            join(
              DRAFT_IMAGES_DIR,
              `${finalSlug}-licensed-graphic.json`
            ),
            JSON.stringify(graphicProvenance, null, 2) + '\n',
            'utf8'
          );
        }
      } else {
        console.log(
          '  No sufficiently relevant licensed existing graphic found.'
        );
      }
    } else {
      console.log(
        '  Licensed graphic search skipped: insufficient story-specific keywords.'
      );
    }
  }
  // Final visual fallback: create a story-specific editorial graphic when
  // no safe/relevant licensed photograph was found.
  if (heroImagePath === '/images/og-default.svg') {
    try {
      const generated = await generateGeneralEditorialGraphic({
        draft,
        slug: finalSlug,
        draftImagesDir: DRAFT_IMAGES_DIR,
        publicImagesDir: PUBLIC_IMAGES_DIR,
      });

      if (generated?.ok) {
        heroImagePath = generated.imagePath;
        heroImageAlt = generated.alt;
        heroImageMode = 'factual-graphic-fallback';
        heroImageCaption = generated.caption;
        heroImageCreator = generated.creator;
        heroImageLicense = generated.license;
        heroImageLicenseUrl = generated.licenseUrl;
        heroImageSourcePageUrl = generated.sourcePageUrl;
        heroImageRelation = generated.relation;

        console.log(
          `  General News editorial fallback generated: ${generated.imagePath}`
        );
      }
    } catch (err) {
      console.warn(
        `  General News editorial fallback failed; keeping og-default.svg: ${err.message}`
      );
    }
  }
  // 3. Build article markdown
  const now = new Date().toISOString();
  const bodyMarkdown = draft.body
    .map((section) => {
      const heading = section.heading ? `\n## ${section.heading}\n` : '';
      const paras = section.paragraphs.join('\n\n');
      return heading + paras;
    })
    .join('\n\n');

  const tags = [draft.category, 'General News'];
  if (draft.primarySource?.publisherFamily) tags.push(draft.primarySource.publisherFamily);

  // Source attribution box content
  const sourceNote = `This article was produced from the cited publicly accessible source(s). US News Engine is not the original source and did not report from the scene. Original summaries are written from the cited evidence; refer to the linked sources for the full coverage.`;

  const articleContent = `---
slug: "${yamlEscape(finalSlug)}"
title: "${yamlEscape(draft.title)}"
description: "${yamlEscape(draft.description)}"
category: ${draft.category}
author: "${yamlEscape(draft.author)}"
publishedAt: ${now}
image: "${yamlEscape(heroImagePath)}"
imageAlt: "${yamlEscape(heroImageAlt)}"
imageMode: "${yamlEscape(heroImageMode)}"
imageCaption: "${yamlEscape(heroImageCaption)}"
imageCreator: "${yamlEscape(heroImageCreator)}"
imageLicense: "${yamlEscape(heroImageLicense)}"
imageLicenseUrl: "${yamlEscape(heroImageLicenseUrl)}"
imageSourcePageUrl: "${yamlEscape(heroImageSourcePageUrl)}"
sourceName: "${yamlEscape(draft.primarySource.name)}"
sourceUrl: "${yamlEscape(draft.primarySource.url)}"
sourceOffice: "${yamlEscape(draft.primarySource.type === 'government' ? 'U.S. Government' : draft.primarySource.publisherFamily || 'News Publisher')}"
tags: [${tags.map((t) => `"${t}"`).join(', ')}]
breaking: ${draft.storyScore >= 50 && draft.freshnessStatus === 'very-high'}
featured: false
views: 0
---

${bodyMarkdown}

## Source

**Primary source:** ${draft.primarySource.name}
[View original ${draft.primarySource.type === 'government' ? 'release' : 'report'} â†’](${draft.primarySource.url})

${draft.supportingSources && draft.supportingSources.length > 0 ? `**Additional reporting:**\n${draft.supportingSources.map((s) => `- ${s.sourceName} â€” [View original report â†’](${s.sourceUrl})`).join('\n')}\n` : ''}
${sourceNote}
`;

  const articlePath = join(ARTICLES_DIR, `${finalSlug}.md`);
  await mkdir(dirname(articlePath), { recursive: true });
  await writeFile(articlePath, articleContent, 'utf8');

  await upsertSharedPublishedStory({
    storyKey: finalSlug,
    slug: finalSlug,
    articlePath: `src/content/articles/${finalSlug}.md`,
    publishedAt: now,
    updatedAt: null,
    currentAlertIds: [story.generalStoryKey].filter(Boolean),
    allAlertIds: [story.generalStoryKey].filter(Boolean),
    event: draft.category || 'General News',
    location: 'Unknown',
    sourceOffice: draft.primarySource?.name || 'Unknown',
    lifecycleStatus: 'active',
    lastNwsEffectiveAt: null,
    lastNwsExpiresAt: null,
    lastNwsEndsAt: null,
    lastCheckedAt: now,
    heroImageMode,
    heroImageSource: heroImagePath,
    heroImageRelation: heroImageRelation || 'current-alert-data',
    heroImageCreator,
    heroImageLicense,
    heroImageLicenseUrl,
    heroImageSourcePageUrl,
    breaking: draft.breaking === true,
  });
  // 4. Add to registry
  if (!registry.stories) registry.stories = [];
  registry.stories.push({
    generalStoryKey: story.generalStoryKey,
    slug: finalSlug,
    articlePath: `src/content/articles/${finalSlug}.md`,
    title: draft.title,
    publishedAt: now,
    category: draft.category,
    primarySource: draft.primarySource.name,
    primaryPublisherFamily: draft.primarySource.publisherFamily,
    independentPublisherCount: draft.independentPublisherCount,
    publisherFamilies: draft.publisherFamilies,
    usRelevance: draft.usRelevance,
    storyScore: draft.storyScore,
    sourceUrls: draft.allSourceUrls,
    imagePath: heroImagePath,
    imageMode: heroImageMode,
    imageCreator: heroImageCreator,
    imageLicense: heroImageLicense,
    imageLicenseUrl: heroImageLicenseUrl,
    imageSourcePageUrl: heroImageSourcePageUrl,
    imageRelation: heroImageRelation,
  });
  registry.storyCount = registry.stories.length;
  registry.generatedAt = now;

  return { slug: finalSlug, draft };
}

async function saveRegistry(registry) {
  await mkdir(dirname(REGISTRY_FILE), { recursive: true });
  await writeFile(REGISTRY_FILE, JSON.stringify(registry, null, 2) + '\n', 'utf8');
  console.log(`  Registry saved: ${REGISTRY_FILE} (${registry.stories.length} stories).`);
}

// ===========================================================================
// Main
// ===========================================================================

async function main() {
  const startTime = Date.now();
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run') || args.includes('--ignore-daily-cap');

  console.log('============================================');
  console.log('US News Engine â€” General News Newsroom Automation');
  console.log('============================================');
  console.log(`Started: ${new Date().toISOString()}`);
  console.log('');

  // --- Load config ---
  let config;
  try {
    config = JSON.parse(await readFile(CONFIG_FILE, 'utf8'));
  } catch {
    config = { generalPublishingEnabled: false, maxGeneralNewPerRun: 2, maxGeneralNewPerDay: 24 };
  }
  const publishingEnabled = config.generalPublishingEnabled === true;
  const maxPerRun = config.maxGeneralNewPerRun || 2;
  const maxPerDay = config.maxGeneralNewPerDay || 24;
  const maxPoliticsPerRun = config.maxPoliticsNewPerRun || 1;
  const maxPoliticsPerDay = config.maxPoliticsNewPerDay || 6;
  const maxPerPublisherPerRun = config.maxGeneralPerPublisherPerRun || 2;
  const maxPerPublisherPerDay = config.maxGeneralPerPublisherPerDay || 6;

  console.log(`Kill switch: generalPublishingEnabled = ${publishingEnabled}`);
  console.log(`Caps: maxPerRun=${maxPerRun}, maxPerDay=${maxPerDay}, maxPoliticsPerRun=${maxPoliticsPerRun}, maxPoliticsPerDay=${maxPoliticsPerDay}`);
  console.log(`Publisher caps: maxPerPublisherPerRun=${maxPerPublisherPerRun}, maxPerPublisherPerDay=${maxPerPublisherPerDay}`);
  if (dryRun) console.log('DRY RUN MODE â€” no production files will be modified');
  console.log('');

  // --- Step 1-3: Fetch â†’ Registry â†’ Stories ---
  console.log('--- Steps 1-3: Fetch â†’ Registry â†’ Stories ---');
  try {
    runNpm('fetch:general', 'Fetch General News');
    console.log('  Fetch complete.');
    runNpm('registry:general', 'Update General News registry');
    console.log('  Registry update complete.');
    runNpm('stories:general', 'Build General News stories');
    console.log('  Stories complete.');
  } catch (err) {
    console.error('\nFATAL: General News pipeline failed. Aborting.');
    console.error(err.message);
    process.exit(1);
  }

  // --- Load story records ---
  const storiesRes = await loadJsonOptional(STORIES_FILE);
  if (!storiesRes.ok) {
    console.error('\nFATAL: story records missing.');
    process.exit(1);
  }
  const allStories = storiesRes.doc.stories || [];
  const eligible = allStories.filter((s) => s.publishEligible);
  const needsMoreSourcing = allStories.filter((s) => s.singleSourceRule && !s.singleSourceRule.ok);
  const rejected = allStories.filter((s) => !s.publishEligible);

  console.log(`\n--- Candidate summary ---`);
  console.log(`  Total clusters:       ${allStories.length}`);
  console.log(`  publishEligible:      ${eligible.length}`);
  console.log(`  needs-more-sourcing:  ${needsMoreSourcing.length}`);
  console.log(`  rejected:             ${rejected.length}`);

  // Category mix
  const catMix = {};
  for (const s of eligible) catMix[s.category] = (catMix[s.category] || 0) + 1;
  console.log(`  Eligible category mix: ${JSON.stringify(catMix)}`);

  // Publisher-family mix
  const famMix = {};
  for (const s of eligible) {
    const f = s.primaryPublisherFamily || 'unknown';
    famMix[f] = (famMix[f] || 0) + 1;
  }
  console.log(`  Eligible publisher-family mix: ${JSON.stringify(famMix)}`);

  // U.S. relevance mix
  const usMix = {};
  for (const s of eligible) usMix[s.usRelevance] = (usMix[s.usRelevance] || 0) + 1;
  console.log(`  Eligible U.S. relevance mix: ${JSON.stringify(usMix)}`);

  // --- Load published-general-news registry ---
  let registry;
  const regRes = await loadJsonOptional(REGISTRY_FILE);
  if (regRes.ok && Array.isArray(regRes.doc.stories)) {
    registry = regRes.doc;
    console.log(`\n  Registry loaded: ${registry.stories.length} published General News stories.`);
    // Phase 10A.2.4 â€” deduplicate the registry (remove duplicate entries
    // from the republication bug; keep the FIRST entry with original publishedAt)
    registry = deduplicateRegistry(registry);
  } else {
    registry = { generatedAt: new Date().toISOString(), storyCount: 0, stories: [] };
    console.log('\n  No registry found â€” treating all as new.');
  }

  // Phase 10A.2.4 â€” build durable published identity set for duplicate filtering.
  // This is the CANONICAL duplicate-protection mechanism. It uses multiple
  // identity keys (storyKey, slug, sourceUrl, normalizedUrl) so that an
  // already-published story cannot become NEW again on a later run.
  const publishedSet = buildPublishedIdentitySet(registry);
  console.log(`  Published identity set: ${publishedSet.storyKeys.size} storyKeys, ${publishedSet.sourceUrls.size} sourceUrls`);

  // --- Daily cap calculations ---
  // Phase 10A.2.4 â€” count each article only once (use deduplicated registry)
  const today = new Date().toISOString().slice(0, 10);
  const publishedToday = registry.stories.filter((s) => s.publishedAt && s.publishedAt.startsWith(today));
  const publishedTodayCount = publishedToday.length;
  const politicsPublishedToday = publishedToday.filter((s) => s.category === 'politics');
  const politicsPublishedTodayCount = politicsPublishedToday.length;
  const publisherPublishedToday = {};
  for (const s of publishedToday) {
    const f = s.primaryPublisherFamily || 'unknown';
    publisherPublishedToday[f] = (publisherPublishedToday[f] || 0) + 1;
  }

  console.log(`\n  Daily cap: ${publishedTodayCount} published today, ${Math.max(0, maxPerDay - publishedTodayCount)} remaining`);
  console.log(`  Politics today: ${politicsPublishedTodayCount}/${maxPoliticsPerDay}`);

  // --- Select stories ---
  console.log('\n--- Selection (with all gates + duplicate filter) ---');
  const { selected, familyCountThisRun, politicsCountThisRun, categoryCountThisRun } = selectStories(eligible, {
    maxPerRun,
    maxPoliticsPerRun,
    maxPerPublisherPerRun,
    maxPerDay,
    maxPoliticsPerDay,
    maxPerPublisherPerDay,
    publishedTodayCount,
    politicsPublishedTodayCount,
    publisherPublishedToday,
    publishedSet,
  });

  console.log(`  Selected: ${selected.length}`);
  for (const s of selected) {
    console.log(`    - [${s.category}/us=${s.usRelevance}] score=${s.storyScore} pub=${s.independentPublisherCount} fam=${s.primaryPublisherFamily} ${s.title.slice(0, 60)}`);
  }
  console.log(`  Family mix this run: ${JSON.stringify(familyCountThisRun)}`);
  console.log(`  Category mix this run: ${JSON.stringify(categoryCountThisRun)}`);
  console.log(`  Politics this run: ${politicsCountThisRun}`);

  // --- Kill switch / dry-run check ---
  if (!publishingEnabled || dryRun) {
    console.log('\n============================================');
    if (!publishingEnabled) {
      console.log('PUBLISHING DISABLED (kill switch active)');
    } else {
      console.log('DRY RUN â€” no production files modified');
    }
    console.log('No public content changes will be made.');
    console.log('============================================');
    console.log(`\nWould publish ${selected.length} new stories.`);
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`Duration: ${duration}s`);
    return;
  }

  // --- Publish selected stories ---
  console.log('\n--- Publishing ---');
  let newPublished = 0;
  for (const story of selected) {
    try {
      console.log(`\n  Processing: ${story.generalStoryKey}`);
      const result = await publishNewArticle(story, registry);
      if (result === null) {
        // Phase 10A.2.4 â€” already-published duplicate, skip
        continue;
      }
      newPublished++;
      console.log(`    Published: /news/${result.slug}/`);
    } catch (err) {
      console.error(`    PUBLISH FAILED: ${story.generalStoryKey} â€” ${err.message}`);
    }
  }

  // Phase 10A.2.4 â€” always save the (deduplicated) registry even if 0 new
  // stories were published, so the dedup fix is persisted to git.
  await saveRegistry(registry);

  // --- No-change behavior ---
  if (newPublished === 0) {
    console.log('\n============================================');
    console.log('NO CONTENT CHANGES â€” skipping validation and build.');
    console.log('============================================');
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`Duration: ${duration}s`);
    return;
  }

  // --- Validation ---
  console.log('\n--- Validation ---');
  try {
    runNpm('validate:general', 'General News validation');
    console.log('  validate:general: PASS');
  } catch (err) {
    console.error('  validate:general: FAIL â€” aborting before build.');
    console.error(err.message);
    process.exit(1);
  }
  try {
    runNpm('validate:publishing', 'Publishing validation');
    console.log('  validate:publishing: PASS');
  } catch (err) {
    console.error('  validate:publishing: FAIL â€” aborting before build.');
    console.error(err.message);
    process.exit(1);
  }

  // --- Build ---
  console.log('\n--- Build ---');
  try {
    runNpm('build', 'Astro build');
    console.log('  build: PASS');
  } catch (err) {
    console.error('  build: FAIL â€” aborting.');
    console.error(err.message);
    process.exit(1);
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n============================================`);
  console.log(`General News Newsroom Run Summary`);
  console.log(`============================================`);
  console.log(`Candidates evaluated: ${eligible.length}`);
  console.log(`needs-more-sourcing: ${needsMoreSourcing.length}`);
  console.log(`NEW PUBLISHED: ${newPublished}`);
  console.log(`Duration: ${duration}s`);
  console.log(`============================================`);
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
