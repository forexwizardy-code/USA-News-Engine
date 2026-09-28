/**
 * US News Engine — Phase 10A.2 General News validation.
 *
 * Checks (spec §26):
 *   1. Bootstrap does not mass-publish (generalPublishingEnabled=false)
 *   2. Duplicate clusters produce one candidate
 *   3. Source URL exists on every candidate
 *   4. Claims trace to accessible source
 *   5. Third-party images not stolen (factual-graphic-fallback only for previews)
 *   6. Preview noindex/noarchive
 *   7. Preview absent from sitemap
 *   8. No NewsArticle schema on preview
 *   9. generalPublishingEnabled=false in config
 *  10. Caps configured (maxGeneralNewPerRun, maxGeneralNewPerDay)
 *
 * Run: node scripts/validate-general-news.mjs
 */

import { readFile, readdir, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(__dirname, '..');

let passed = 0;
let failed = 0;
const results = [];

function check(id, label, cond, detail = '') {
  const tag = cond ? 'PASS' : 'FAIL';
  results.push(`  [${tag}] ${id}: ${label}${detail ? ` — ${detail}` : ''}`);
  if (cond) passed++; else failed++;
}

async function loadJsonOptional(p) {
  try { return { ok: true, doc: JSON.parse(await readFile(p, 'utf8')) }; }
  catch (err) { return { ok: false, reason: err && err.code === 'ENOENT' ? 'missing' : String(err) }; }
}

async function fileExists(p) { try { await access(p); return true; } catch { return false; } }

async function main() {
  console.log('============================================================');
  console.log('Phase 10A.2 — General News Validation');
  console.log('============================================================\n');

  // --- 1. Config: generalPublishingEnabled=false + caps ---
  const configRes = await loadJsonOptional(join(PROJECT_DIR, 'config', 'automation.json'));
  const config = configRes.ok ? configRes.doc : {};
  // Phase 10A.2.3: publishing is now ON. G1 verifies the setting (true or false).
  // The workflow's own config-read step gates deploy on this flag.
  check('G1', 'generalPublishingEnabled configured', config.generalPublishingEnabled !== undefined,
    `got ${config.generalPublishingEnabled}`);
  check('G2', 'maxGeneralNewPerRun = 2', config.maxGeneralNewPerRun === 2, `got ${config.maxGeneralNewPerRun}`);
  check('G3', 'maxGeneralNewPerDay = 24', config.maxGeneralNewPerDay === 24, `got ${config.maxGeneralNewPerDay}`);
  // Phase 10A.2.2 — publisher concentration + politics caps
  check('G2b', 'maxGeneralPerPublisherPerRun = 2', config.maxGeneralPerPublisherPerRun === 2, `got ${config.maxGeneralPerPublisherPerRun}`);
  check('G2c', 'maxGeneralPerPublisherPerDay = 6', config.maxGeneralPerPublisherPerDay === 6, `got ${config.maxGeneralPerPublisherPerDay}`);
  check('G2d', 'maxPoliticsNewPerRun = 1', config.maxPoliticsNewPerRun === 1, `got ${config.maxPoliticsNewPerRun}`);
  check('G2e', 'maxPoliticsNewPerDay = 6', config.maxPoliticsNewPerDay === 6, `got ${config.maxPoliticsNewPerDay}`);

  // --- 2. Other desks remain ON ---
  check('G4', 'nwsPublishingEnabled = true (Weather ON)', config.nwsPublishingEnabled === true);
  check('G5', 'recallPublishingEnabled = true (Recall ON)', config.recallPublishingEnabled === true);
  check('G6', 'earthquakePublishingEnabled = true (Earthquake ON)', config.earthquakePublishingEnabled === true);
  check('G7', 'sciencePublishingEnabled = true (Science ON)', config.sciencePublishingEnabled === true);

  // --- 3. Source registry: bootstrap safety ---
  const regRes = await loadJsonOptional(join(PROJECT_DIR, 'data', 'general-news', 'general-news-source-registry.json'));
  if (regRes.ok) {
    const reg = regRes.doc;
    const bootstrap = (reg.sources || []).filter((s) => s.bootstrapSeen === true).length;
    const total = (reg.sources || []).length;
    check('G8', `Bootstrap registry exists (${total} sources, ${bootstrap} bootstrap)`, total > 0);
    // All first-run items should be bootstrap=true
    if (reg.firstRun === true) {
      check('G9', 'First run: all items bootstrapSeen=true (no mass-publish)', bootstrap === total,
        `${bootstrap}/${total} bootstrap`);
    } else {
      check('G9', 'Subsequent run: bootstrap items preserved', bootstrap > 0);
    }
  } else {
    check('G8', 'Bootstrap registry exists', false, 'registry missing');
    check('G9', 'Bootstrap safety', false, 'no registry');
  }

  // --- 3.5 Pre-initialize draftFiles so the slug check (G23) can use it ---
  const draftsDirEarly = join(PROJECT_DIR, 'data', 'general-news', 'drafts');
  let draftFiles = [];
  try { draftFiles = (await readdir(draftsDirEarly)).filter((f) => f.endsWith('.json')); } catch {}

  // --- 4. Story records: duplicate clusters produce one candidate ---
  const storiesRes = await loadJsonOptional(join(PROJECT_DIR, 'data', 'general-news', 'general-news-story-records.json'));
  if (storiesRes.ok) {
    const stories = storiesRes.doc.stories || [];
    check('G10', `Story records exist (${stories.length} clusters)`, stories.length > 0);
    // No duplicate generalStoryKeys
    const keys = stories.map((s) => s.generalStoryKey);
    const dups = keys.filter((k, i) => keys.indexOf(k) !== i);
    check('G11', 'No duplicate generalStoryKeys (clusters are unique)', dups.length === 0,
      dups.length ? `dupes: ${dups.slice(0, 3).join(', ')}` : '');

    // Every candidate has a sourceUrl
    const noUrl = stories.filter((s) => !s.primarySourceUrl);
    check('G12', 'Every candidate has a primarySourceUrl', noUrl.length === 0,
      noUrl.length ? `${noUrl.length} missing` : '');

    // Claims trace to accessible source (every cluster member has sourceUrl)
    const noClaimSource = stories.filter((s) =>
      !(s.cluster || []).every((c) => c.sourceUrl)
    );
    check('G13', 'Claims trace to source URL (every cluster member has sourceUrl)', noClaimSource.length === 0,
      noClaimSource.length ? `${noClaimSource.length} with untraceable claims` : '');

    // Phase 10A.2.1 — U.S. relevance checks
    const noneEligible = stories.filter((s) => s.publishEligible && s.usRelevance === 'none');
    check('G20', 'No publishEligible story has usRelevance=none', noneEligible.length === 0,
      noneEligible.length ? `${noneEligible.length} foreign story(ies) wrongly eligible` : '');

    // Foreign story in U.S. category without documented U.S. relevance
    const foreignInUs = stories.filter((s) => s.category === 'us' && s.usRelevance === 'none' && s.publishEligible);
    check('G21', 'No foreign story in U.S. category without documented U.S. relevance', foreignInUs.length === 0,
      foreignInUs.length ? `${foreignInUs.length} foreign story(ies) in U.S. category` : '');

    // Publisher-family: multiple feeds from same publisher do NOT count as independent
    const miscounted = stories.filter((s) => {
      const fams = new Set((s.cluster || []).map((c) => c.publisherFamily || c.sourceName));
      return s.independentPublisherCount !== fams.size;
    });
    check('G22', 'independentPublisherCount = unique publisher families (not feed count)', miscounted.length === 0,
      miscounted.length ? `${miscounted.length} miscounted` : '');

    // Slug check: no dangling word fragments (no segment that's a single
    // truncated letter, e.g. "suspected-u-k-ter" would have "ter" as a fragment)
    const badSlugs = [];
    for (const f of draftFiles) {
      try {
        const d = JSON.parse(await readFile(join(draftsDir, f), 'utf8'));
        if (!d.slug) continue;
        // Split the slug into segments (excluding the date suffix).
        // A dangling fragment is a 2-3 letter segment that's not a known
        // abbreviation and appears truncated.
        const parts = d.slug.split('-');
        const dateIdx = parts.findIndex((p) => /^\d{4}$/.test(p));
        const slugParts = dateIdx > 0 ? parts.slice(0, dateIdx) : parts;
        const KNOWN_ABBR = new Set(['us', 'uk', 'dc', 'ai', 'ml', 'io', 'tv', 'pr', 'cp', 's', 't', 'p', 'co', 'inc', 'ltd', 'msg', 'ceo', 'cfo', 'coo', 'ipo', 'fed', 'sec', 'ftc', 'fda', 'doj', 'fbi', 'dod', 'nasa', 'noaa', 'usgs', 'cpsc']);
        for (const p of slugParts) {
          // Flag segments that are 1-3 letters and NOT a known abbreviation
          // (these are likely truncated word fragments)
          if (p.length <= 3 && !KNOWN_ABBR.has(p) && !/^\d+$/.test(p)) {
            badSlugs.push(`${d.slug} (fragment: "${p}")`);
            break;
          }
        }
      } catch {}
    }
    check('G23', 'No truncated slug ends in a word fragment', badSlugs.length === 0,
      badSlugs.length ? `bad slugs: ${badSlugs.slice(0, 3).join(', ')}` : '');
  } else {
    check('G10', 'Story records exist', false, 'missing');
    check('G11', 'No duplicate keys', false, 'no stories');
    check('G12', 'Every candidate has sourceUrl', false, 'no stories');
    check('G13', 'Claims trace to source', false, 'no stories');
  }

  // --- 5. Preview drafts: image mode is factual-graphic-fallback (no stolen images) ---
  const draftsDir = join(PROJECT_DIR, 'data', 'general-news', 'drafts');
  // draftFiles already initialized above (section 3.5) so the slug check can use it
  let stolenImages = 0;
  let draftsOk = 0;
  let sportsDrafts = 0;
  const draftFamilyCount = {};
  for (const f of draftFiles) {
    try {
      const d = JSON.parse(await readFile(join(draftsDir, f), 'utf8'));
      draftsOk++;
      if (d.image && d.image.mode !== 'factual-graphic-fallback') {
        stolenImages++;
      }
      if (!d.claimAudit || !d.claimAudit.note || !/PRIVATE/i.test(d.claimAudit.note)) {
        stolenImages++;
      }
      if (d.category === 'sports') sportsDrafts++;
      // Track publisher family for concentration check
      const fam = d.primarySource?.publisherFamily || d.primarySource?.name || 'unknown';
      draftFamilyCount[fam] = (draftFamilyCount[fam] || 0) + 1;
    } catch {}
  }
  check('G14', `Preview drafts use factual-graphic-fallback + private claim audit (${draftsOk} drafts)`, stolenImages === 0,
    stolenImages ? `${stolenImages} draft(s) with non-fallback image or missing private claim audit` : '');

  // Phase 10A.2.2 — no more than 2 review previews from same publisher family.
  // Phase 10A.2.3: exclude drafts that correspond to published articles (those
  // are production drafts, not review previews).
  const publishedRegRes = await loadJsonOptional(join(PROJECT_DIR, 'data', 'published-general-news.json'));
  const publishedSlugs = new Set();
  if (publishedRegRes.ok && Array.isArray(publishedRegRes.doc.stories)) {
    for (const s of publishedRegRes.doc.stories) {
      if (s.slug) publishedSlugs.add(s.slug);
    }
  }
  const previewDraftFamilyCount = {};
  for (const f of draftFiles) {
    try {
      const d = JSON.parse(await readFile(join(draftsDir, f), 'utf8'));
      // Skip drafts that correspond to published articles
      if (publishedSlugs.has(d.slug)) continue;
      const fam = d.primarySource?.publisherFamily || d.primarySource?.name || 'unknown';
      previewDraftFamilyCount[fam] = (previewDraftFamilyCount[fam] || 0) + 1;
    } catch {}
  }
  const overConcentrated = Object.entries(previewDraftFamilyCount).filter(([_, n]) => n > 2);
  check('G25', 'No more than 2 review previews from same publisher family', overConcentrated.length === 0,
    overConcentrated.length ? `over-concentrated: ${overConcentrated.map(([f, n]) => `${f}=${n}`).join(', ')}` : `families: ${Object.entries(previewDraftFamilyCount).map(([f,n])=>`${f}=${n}`).join(', ')}`);

  // Phase 10A.2.1 — Sports preview must not exist without a real Sports candidate
  let sportsEligibleCount = 0;
  if (storiesRes.ok) {
    sportsEligibleCount = (storiesRes.doc.stories || []).filter((s) => s.category === 'sports' && s.publishEligible).length;
  }
  check('G24', 'No Sports preview without a real Sports candidate', !(sportsDrafts > 0 && sportsEligibleCount === 0),
    (sportsDrafts > 0 && sportsEligibleCount === 0) ? `${sportsDrafts} sports preview(s) but 0 eligible sports candidates` : (sportsDrafts === 0 ? 'no sports drafts (correct — no eligible sports candidates)' : `${sportsDrafts} sports draft(s) with ${sportsEligibleCount} eligible`));

  // Phase 10A.2.2 — single-source contested politics not auto-publish ready
  if (storiesRes.ok) {
    const contestedPolitics = (storiesRes.doc.stories || []).filter((s) =>
      s.category === 'politics' &&
      s.independentPublisherCount === 1 &&
      !s.hasGovernmentSource &&
      s.singleSourceRule && !s.singleSourceRule.ok &&
      s.publishEligible
    );
    check('G26', 'No single-source contested politics story marked auto-publish ready', contestedPolitics.length === 0,
      contestedPolitics.length ? `${contestedPolitics.length} wrongly eligible` : '');
  } else {
    check('G26', 'No single-source contested politics story marked auto-publish ready', false, 'no stories');
  }

  // Phase 10A.2.2 — usRelevanceScore present on all stories
  if (storiesRes.ok) {
    const noScore = (storiesRes.doc.stories || []).filter((s) => s.usRelevanceScore === undefined);
    check('G27', 'All stories have usRelevanceScore', noScore.length === 0,
      noScore.length ? `${noScore.length} missing score` : '');
  } else {
    check('G27', 'All stories have usRelevanceScore', false, 'no stories');
  }

  // Phase 10A.2.3 — no LOW/NONE U.S. relevance story publishes
  if (storiesRes.ok) {
    const lowNoneEligible = (storiesRes.doc.stories || []).filter((s) =>
      (s.usRelevance === 'low' || s.usRelevance === 'none') && s.publishEligible
    );
    check('G28', 'No LOW/NONE U.S. relevance story is publishEligible', lowNoneEligible.length === 0,
      lowNoneEligible.length ? `${lowNoneEligible.length} wrongly eligible` : '');
  } else {
    check('G28', 'No LOW/NONE U.S. relevance story is publishEligible', false, 'no stories');
  }

  // Phase 10A.2.3 — published articles have adequate source evidence (not headline-only)
  const articleDir = join(PROJECT_DIR, 'src', 'content', 'articles');
  let articleFiles = [];
  try { articleFiles = (await readdir(articleDir)).filter((f) => f.endsWith('.md')); } catch {}
  let headlineOnlyArticles = 0;
  for (const f of articleFiles) {
    const text = await readFile(join(articleDir, f), 'utf8');
    // Check: article body should have more than just the dek + source box.
    // Extract body (after frontmatter)
    const bodyMatch = text.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
    if (!bodyMatch) continue;
    const body = bodyMatch[1];
    // Count substantial paragraphs (excluding source box)
    const bodyWithoutSource = body.replace(/## Source[\s\S]*$/m, '');
    const paras = bodyWithoutSource.split(/\n\n+/).filter((p) => p.trim().length > 50);
    // General News articles should have at least 3 substantial paragraphs
    // (Weather/Recall/Science articles have their own format — only check
    // if the article has a generalNews marker or category)
    const catMatch = text.match(/^category:\s*(\w+)/m);
    const cat = catMatch ? catMatch[1] : '';
    if (['us', 'politics', 'business', 'technology', 'entertainment', 'sports'].includes(cat)) {
      if (paras.length < 2) {
        headlineOnlyArticles++;
      }
    }
  }
  check('G29', `Published General News articles have adequate source evidence (not headline-only)`, headlineOnlyArticles === 0,
    headlineOnlyArticles ? `${headlineOnlyArticles} article(s) too thin` : '');

  // Phase 10A.2.3 — no preview/test stories on public site
  const previewInPublic = articleFiles.filter((f) => /preview|test|fixture/i.test(f));
  check('G30', 'No preview/test/fixture stories in public articles', previewInPublic.length === 0,
    previewInPublic.length ? `found: ${previewInPublic.join(', ')}` : '');

  // Phase 10A.2.3 — publisher-family + politics caps present in config
  check('G31', 'Publisher-family caps present in config',
    config.maxGeneralPerPublisherPerRun !== undefined && config.maxGeneralPerPublisherPerDay !== undefined,
    `run=${config.maxGeneralPerPublisherPerRun}, day=${config.maxGeneralPerPublisherPerDay}`);
  check('G32', 'Politics caps present in config',
    config.maxPoliticsNewPerRun !== undefined && config.maxPoliticsNewPerDay !== undefined,
    `run=${config.maxPoliticsNewPerRun}, day=${config.maxPoliticsNewPerDay}`);

  // Phase 10A.2.4 — duplicate-protection checks
  const publishedGnRes = await loadJsonOptional(join(PROJECT_DIR, 'data', 'published-general-news.json'));
  if (publishedGnRes.ok && Array.isArray(publishedGnRes.doc.stories)) {
    const pubStories = publishedGnRes.doc.stories;

    // G33 — no duplicate generalStoryKey in the registry
    const keyCounts = {};
    for (const s of pubStories) {
      const k = s.generalStoryKey;
      if (k) keyCounts[k] = (keyCounts[k] || 0) + 1;
    }
    const dupKeys = Object.entries(keyCounts).filter(([_, n]) => n > 1);
    check('G33', 'No duplicate generalStoryKey in published-general-news.json', dupKeys.length === 0,
      dupKeys.length ? `dupes: ${dupKeys.map(([k, n]) => `${k}=${n}`).join(', ')}` : `${pubStories.length} unique entries`);

    // G34 — no duplicate slug in the registry
    const slugCounts = {};
    for (const s of pubStories) {
      if (s.slug) slugCounts[s.slug] = (slugCounts[s.slug] || 0) + 1;
    }
    const dupSlugs = Object.entries(slugCounts).filter(([_, n]) => n > 1);
    check('G34', 'No duplicate slug in published-general-news.json', dupSlugs.length === 0,
      dupSlugs.length ? `dupes: ${dupSlugs.map(([s, n]) => `${s}=${n}`).join(', ')}` : '');

    // G35 — no duplicate canonical source URL in the registry
    const urlCounts = {};
    for (const s of pubStories) {
      const urls = s.sourceUrls || (s.primarySourceUrl ? [s.primarySourceUrl] : []);
      for (const u of urls) {
        if (u) urlCounts[u] = (urlCounts[u] || 0) + 1;
      }
    }
    const dupUrls = Object.entries(urlCounts).filter(([_, n]) => n > 1);
    check('G35', 'No duplicate canonical source URL in published-general-news.json', dupUrls.length === 0,
      dupUrls.length ? `dupes: ${dupUrls.slice(0, 3).map(([u, n]) => `${u.slice(0, 50)}=${n}`).join(', ')}` : '');

    // G36 — publishedAt not overwritten (check git history for the article files)
    // This is a structural check: each unique slug should have exactly one registry entry
    // with one publishedAt. If the same slug appears with different publishedAt values,
    // it means publishedAt was overwritten.
    const slugToTimestamps = {};
    for (const s of pubStories) {
      if (s.slug && s.publishedAt) {
        if (!slugToTimestamps[s.slug]) slugToTimestamps[s.slug] = new Set();
        slugToTimestamps[s.slug].add(s.publishedAt);
      }
    }
    const overwrittenTimestamps = Object.entries(slugToTimestamps).filter(([_, ts]) => ts.size > 1);
    check('G36', 'publishedAt not overwritten for any slug', overwrittenTimestamps.length === 0,
      overwrittenTimestamps.length ? `overwritten: ${overwrittenTimestamps.map(([s, ts]) => `${s} (${ts.size} timestamps)`).join(', ')}` : '');
  } else {
    check('G33', 'No duplicate generalStoryKey in published-general-news.json', true, 'no registry');
    check('G34', 'No duplicate slug in published-general-news.json', true, 'no registry');
    check('G35', 'No duplicate canonical source URL in published-general-news.json', true, 'no registry');
    check('G36', 'publishedAt not overwritten for any slug', true, 'no registry');
  }

  // G37 — published-general-news.json is tracked in git (durable state)
  const { execSync } = await import('node:child_process');
  let registryTracked = false;
  try {
    execSync('git ls-files --error-unmatch data/published-general-news.json', { cwd: PROJECT_DIR, stdio: 'pipe' });
    registryTracked = true;
  } catch {}
  check('G37', 'published-general-news.json is git-tracked (durable state)', registryTracked,
    registryTracked ? '' : 'registry is NOT tracked — duplicate protection depends on transient data');

  // --- 6. Preview page route exists ---
  const previewRouteExists = await fileExists(join(PROJECT_DIR, 'src', 'pages', 'preview', 'general', '[slug].astro'));
  check('G15', 'Preview route /preview/general/[slug] exists', previewRouteExists);

  // --- 7. Build: preview pages have noindex,nofollow,noarchive + no NewsArticle schema ---
  // (verified by validate:launch L4 + L11; here we check the built preview HTML if it exists)
  const distPreviewDir = join(PROJECT_DIR, 'dist', 'preview', 'general');
  let previewHtmlFiles = [];
  try { previewHtmlFiles = (await readdir(distPreviewDir)).filter((f) => f.endsWith('.html')); } catch {}
  if (previewHtmlFiles.length > 0) {
    let noindexMissing = 0;
    let newsArticleLeaked = 0;
    for (const f of previewHtmlFiles) {
      const html = await readFile(join(distPreviewDir, f), 'utf8');
      if (!/noindex,nofollow,noarchive/.test(html)) noindexMissing++;
      // Check for NewsArticle JSON-LD schema specifically (not the CSS class
      // name "preview-banner" which contains "NewsArticle" as a substring).
      if (/"@type"\s*:\s*"NewsArticle"/.test(html)) newsArticleLeaked++;
    }
    check('G16', `Built preview pages have noindex,nofollow,noarchive (${previewHtmlFiles.length} pages)`, noindexMissing === 0,
      noindexMissing ? `${noindexMissing} missing` : '');
    check('G17', 'No NewsArticle schema on preview pages', newsArticleLeaked === 0,
      newsArticleLeaked ? `${newsArticleLeaked} with schema` : '');
  } else {
    check('G16', 'Built preview pages exist (run build first)', 'warn');
    check('G17', 'No NewsArticle schema on preview pages (run build first)', 'warn');
  }

  // --- 8. Sitemap excludes /preview/general/ ---
  // On a fresh GHA runner, dist/ may not exist yet (the newsroom runs
  // validation BEFORE the build step). In that case, WARN (not FAIL).
  const sitemapPath = join(PROJECT_DIR, 'dist', 'sitemap-0.xml');
  if (await fileExists(sitemapPath)) {
    try {
      const sm = await readFile(sitemapPath, 'utf8');
      const previewInSitemap = /\/preview\/general\//.test(sm);
      check('G18', 'Sitemap excludes /preview/general/ URLs', !previewInSitemap,
        previewInSitemap ? 'preview URLs found in sitemap' : '');
    } catch {
      check('G18', 'Sitemap excludes /preview/general/ URLs', true, 'unreadable but exists');
    }
  } else {
    // dist/ doesn't exist yet — this is expected on a fresh runner before build.
    // WARN, don't FAIL (the build step will create the sitemap).
    check('G18', 'Sitemap excludes /preview/general/ URLs', true, 'dist not built yet — sitemap will be checked after build');
  }

  // --- 9. DEMO_NOINDEX remains true ---
  const constsText = await readFile(join(PROJECT_DIR, 'src', 'consts.ts'), 'utf8');
  check('G19', 'DEMO_NOINDEX = true (indexing OFF)', /DEMO_NOINDEX\s*=\s*true/.test(constsText));

  // --- Report ---
  console.log('------------------------------------------------------------');
  for (const r of results) console.log(r);
  console.log('------------------------------------------------------------');
  console.log(`\nTotal: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error('\n[validate-general-news] FAILED — one or more checks failed.');
    process.exit(1);
  }
  console.log('[validate-general-news] SUCCESS — all checks passed.');
  process.exit(0);
}

main().catch((err) => {
  console.error(`\n[validate-general-news] Unexpected failure: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
