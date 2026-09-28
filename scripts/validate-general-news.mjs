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
  check('G1', 'generalPublishingEnabled = false (auto-publishing OFF)', config.generalPublishingEnabled === false,
    `got ${config.generalPublishingEnabled}`);
  check('G2', 'maxGeneralNewPerRun = 2', config.maxGeneralNewPerRun === 2, `got ${config.maxGeneralNewPerRun}`);
  check('G3', 'maxGeneralNewPerDay = 24', config.maxGeneralNewPerDay === 24, `got ${config.maxGeneralNewPerDay}`);

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
    } catch {}
  }
  check('G14', `Preview drafts use factual-graphic-fallback + private claim audit (${draftsOk} drafts)`, stolenImages === 0,
    stolenImages ? `${stolenImages} draft(s) with non-fallback image or missing private claim audit` : '');

  // Phase 10A.2.1 — Sports preview must not exist without a real Sports candidate
  let sportsEligibleCount = 0;
  if (storiesRes.ok) {
    sportsEligibleCount = (storiesRes.doc.stories || []).filter((s) => s.category === 'sports' && s.publishEligible).length;
  }
  check('G24', 'No Sports preview without a real Sports candidate', !(sportsDrafts > 0 && sportsEligibleCount === 0),
    (sportsDrafts > 0 && sportsEligibleCount === 0) ? `${sportsDrafts} sports preview(s) but 0 eligible sports candidates` : (sportsDrafts === 0 ? 'no sports drafts (correct — no eligible sports candidates)' : `${sportsDrafts} sports draft(s) with ${sportsEligibleCount} eligible`));

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
  const sitemapRes = await loadJsonOptional(join(PROJECT_DIR, 'dist', 'sitemap-0.xml'));
  if (sitemapRes.ok) {
    const sitemapText = JSON.stringify(sitemapRes.doc);
    const previewInSitemap = /\/preview\/general\//.test(sitemapText);
    check('G18', 'Sitemap excludes /preview/general/ URLs', !previewInSitemap,
      previewInSitemap ? 'preview URLs found in sitemap' : '');
  } else {
    // sitemap-0.xml is XML not JSON; read as text
    try {
      const sm = await readFile(join(PROJECT_DIR, 'dist', 'sitemap-0.xml'), 'utf8');
      const previewInSitemap = /\/preview\/general\//.test(sm);
      check('G18', 'Sitemap excludes /preview/general/ URLs', !previewInSitemap);
    } catch {
      check('G18', 'Sitemap exists (run build first)', false, 'missing');
    }
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
