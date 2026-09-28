/**
 * US News Engine — master General News newsroom automation script (Phase 10A.2.3).
 *
 * Orchestrates: fetch → registry → stories → selection (with all gates) →
 * draft → publish → validate → build.
 *
 * Gates (spec §1-8):
 *   - U.S. relevance: HIGH gets +15 score bonus; MEDIUM +5; LOW/NONE not eligible.
 *   - Single-source rule: independentPublisherCount=1 needs gov source OR
 *     low-dispute factual; politics contested needs 2 families or official+reporting.
 *   - Publisher concentration: max 2 per family per run, 6 per day.
 *   - Politics cap: max 1 per run, 6 per day; ≤30% of homepage Top Stories.
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

import { readFile, writeFile, mkdir, access, readdir, copyFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(__dirname, '..');
const CONFIG_FILE = join(PROJECT_DIR, 'config', 'automation.json');
const STORIES_FILE = join(PROJECT_DIR, 'data', 'general-news', 'general-news-story-records.json');
const REGISTRY_FILE = join(PROJECT_DIR, 'data', 'published-general-news.json');
const ARTICLES_DIR = join(PROJECT_DIR, 'src', 'content', 'articles');

// ===========================================================================
// Helpers
// ===========================================================================

function runNpm(script, label) {
  console.log(`  $ npm run ${script}`);
  try {
    execSync(`npm run ${script}`, { cwd: PROJECT_DIR, stdio: 'pipe' });
  } catch (err) {
    const stderr = err.stderr?.toString?.() || '';
    throw new Error(`${label} failed.\n-- stderr --\n${stderr.slice(0, 800)}`);
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
// Selection logic — with all gates
// ===========================================================================

/**
 * Select stories for publication respecting ALL gates:
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
    existingSlugs, // Set of already-published slugs
  } = opts;

  // Sort: usRelevance HIGH first, then score desc, then freshness
  const sorted = [...eligible].sort((a, b) => {
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
image: "/images/og-default.svg"
imageAlt: "${yamlEscape(draft.image.alt)}"
imageMode: "${yamlEscape(draft.image.mode)}"
imageCaption: "${yamlEscape(draft.image.caption)}"
imageCreator: "${yamlEscape(draft.image.credit)}"
imageLicense: "Original editorial graphic generated by US News Engine"
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
[View original ${draft.primarySource.type === 'government' ? 'release' : 'report'} →](${draft.primarySource.url})

${draft.supportingSources && draft.supportingSources.length > 0 ? `**Additional reporting:**\n${draft.supportingSources.map((s) => `- ${s.sourceName} — [View original report →](${s.sourceUrl})`).join('\n')}\n` : ''}
${sourceNote}
`;

  const articlePath = join(ARTICLES_DIR, `${finalSlug}.md`);
  await mkdir(dirname(articlePath), { recursive: true });
  await writeFile(articlePath, articleContent, 'utf8');

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
  console.log('US News Engine — General News Newsroom Automation');
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
  if (dryRun) console.log('DRY RUN MODE — no production files will be modified');
  console.log('');

  // --- Step 1-3: Fetch → Registry → Stories ---
  console.log('--- Steps 1-3: Fetch → Registry → Stories ---');
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
  } else {
    registry = { generatedAt: new Date().toISOString(), storyCount: 0, stories: [] };
    console.log('\n  No registry found — treating all as new.');
  }

  // --- Daily cap calculations ---
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
  const existingSlugs = new Set(registry.stories.map((s) => s.slug));

  console.log(`\n  Daily cap: ${publishedTodayCount} published today, ${Math.max(0, maxPerDay - publishedTodayCount)} remaining`);
  console.log(`  Politics today: ${politicsPublishedTodayCount}/${maxPoliticsPerDay}`);

  // --- Select stories ---
  console.log('\n--- Selection (with all gates) ---');
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
    existingSlugs,
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
      console.log('DRY RUN — no production files modified');
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
      newPublished++;
      console.log(`    Published: /news/${result.slug}/`);
    } catch (err) {
      console.error(`    PUBLISH FAILED: ${story.generalStoryKey} — ${err.message}`);
    }
  }

  if (newPublished > 0) {
    await saveRegistry(registry);
  }

  // --- No-change behavior ---
  if (newPublished === 0) {
    console.log('\n============================================');
    console.log('NO CONTENT CHANGES — skipping validation and build.');
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
    console.error('  validate:general: FAIL — aborting before build.');
    console.error(err.message);
    process.exit(1);
  }
  try {
    runNpm('validate:publishing', 'Publishing validation');
    console.log('  validate:publishing: PASS');
  } catch (err) {
    console.error('  validate:publishing: FAIL — aborting before build.');
    console.error(err.message);
    process.exit(1);
  }

  // --- Build ---
  console.log('\n--- Build ---');
  try {
    runNpm('build', 'Astro build');
    console.log('  build: PASS');
  } catch (err) {
    console.error('  build: FAIL — aborting.');
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
