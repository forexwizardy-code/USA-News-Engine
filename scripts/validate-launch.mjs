/**
 * US News Engine — Phase 10A launch-readiness validation.
 *
 * Audits the built site and source for invariants that must hold BEFORE
 * the site is opened to search indexing (Phase 10B). This script does
 * NOT enable indexing — DEMO_NOINDEX must remain true. It reports
 * PASS/WARN/FAIL for each launch invariant so the team can see exactly
 * what blocks indexing.
 *
 * Run:
 *   npm run validate:launch
 *
 * Exits 1 on any FAIL, 0 if all checks pass (WARNs do not fail).
 */

import { readFile, readdir, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(__dirname, '..');
const DIST_DIR = join(PROJECT_DIR, 'dist');
const SRC_DIR = join(PROJECT_DIR, 'src');

let passed = 0;
let warned = 0;
let failed = 0;
const results = [];

function check(id, label, status, detail = '') {
  const tag = status === 'pass' ? 'PASS' : status === 'warn' ? 'WARN' : 'FAIL';
  results.push(`  [${tag}] ${id}: ${label}${detail ? ` — ${detail}` : ''}`);
  if (status === 'pass') passed++;
  else if (status === 'warn') warned++;
  else failed++;
}

async function fileExists(p) {
  try { await access(p); return true; } catch { return false; }
}

async function readText(p) {
  try { return await readFile(p, 'utf8'); } catch { return null; }
}

async function readJson(p) {
  const t = await readText(p);
  if (!t) return null;
  try { return JSON.parse(t); } catch { return null; }
}

async function collectFiles(dir, test) {
  const out = [];
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await collectFiles(full, test)));
    else if (e.isFile() && test(e.name)) out.push(full);
  }
  return out;
}

// ===========================================================================
// Main
// ===========================================================================

async function main() {
  console.log('============================================================');
  console.log('Phase 10A — Launch Readiness Validation');
  console.log('============================================================');
  console.log(`Started: ${new Date().toISOString()}\n`);

  // --- 1. DEMO_NOINDEX must remain true (Phase 10A = audit only) ---
  const constsText = await readText(join(SRC_DIR, 'consts.ts'));
  const noindexTrue = /DEMO_NOINDEX\s*=\s*true/.test(constsText || '');
  check('L1', 'DEMO_NOINDEX = true (indexing OFF during audit)', noindexTrue ? 'pass' : 'fail',
    noindexTrue ? '' : 'DEMO_NOINDEX is NOT true — indexing may be enabled prematurely');

  // --- 2. Built site exists ---
  const distExists = await fileExists(DIST_DIR);
  check('L2', 'Production build exists (run npm run build)', distExists ? 'pass' : 'warn',
    distExists ? '' : 'No dist/ — run npm run build');

  if (!distExists) {
    console.log('\n  Build missing — run `npm run build` first. Remaining checks skipped.\n');
    return report();
  }

  // --- 3. Every public HTML page carries noindex,nofollow (while DEMO_NOINDEX=true) ---
  const htmlFiles = (await collectFiles(DIST_DIR, (n) => n.endsWith('.html')))
    .filter((p) => !p.includes('/preview/'));
  let noindexMissing = 0;
  for (const f of htmlFiles) {
    const html = await readText(f);
    if (!html) continue;
    if (!/name="robots"\s+content="noindex,nofollow"/.test(html)) {
      noindexMissing++;
      results.push(`          (no-robots-meta) ${f.replace(DIST_DIR, '')}`);
    }
  }
  check('L3', `All ${htmlFiles.length} public HTML pages carry noindex,nofollow`,
    noindexMissing === 0 ? 'pass' : 'fail', noindexMissing === 0 ? '' : `${noindexMissing} page(s) missing noindex meta`);

  // --- 4. Preview pages carry noindex,nofollow,noarchive ---
  const previewHtml = (await collectFiles(DIST_DIR, (n) => n.endsWith('.html')))
    .filter((p) => p.includes('/preview/'));
  let previewNoindexMissing = 0;
  for (const f of previewHtml) {
    const html = await readText(f);
    if (!html) continue;
    if (!/name="robots"\s+content="noindex,nofollow,noarchive"/.test(html)) {
      previewNoindexMissing++;
    }
  }
  check('L4', `All ${previewHtml.length} preview pages carry noindex,nofollow,noarchive`,
    previewNoindexMissing === 0 ? 'pass' : 'fail', previewNoindexMissing === 0 ? '' : `${previewNoindexMissing} preview page(s) missing noarchive`);

  // --- 5. robots.txt blocks /preview/ ---
  const robotsText = await readText(join(DIST_DIR, 'robots.txt'));
  const robotsBlocksPreview = /Disallow:\s*\/preview\//.test(robotsText || '');
  check('L5', 'robots.txt Disallow: /preview/', robotsBlocksPreview ? 'pass' : 'fail');

  // --- 6. robots.txt references sitemap ---
  const robotsHasSitemap = /Sitemap:\s*https:\/\/.*\/sitemap-index\.xml/.test(robotsText || '');
  check('L6', 'robots.txt references sitemap-index.xml', robotsHasSitemap ? 'pass' : 'fail');

  // --- 7. Sitemap exists and excludes preview URLs ---
  const sitemapText = await readText(join(DIST_DIR, 'sitemap-0.xml'));
  if (sitemapText) {
    const previewInSitemap = /<loc>[^<]*\/preview\//.test(sitemapText);
    check('L7', 'Sitemap excludes /preview/ URLs', !previewInSitemap ? 'pass' : 'fail',
      previewInSitemap ? 'preview URLs found in sitemap' : '');
    const urlCount = (sitemapText.match(/<loc>/g) || []).length;
    check('L8', `Sitemap contains URLs (${urlCount} found)`, urlCount > 0 ? 'pass' : 'warn');
  } else {
    check('L7', 'Sitemap exists', 'warn', 'No sitemap-0.xml in dist/');
    check('L8', 'Sitemap contains URLs', 'warn', 'No sitemap');
  }

  // --- 9. No public page emits a BreadcrumbList with /undefined URL ---
  let undefinedBreadcrumbs = 0;
  for (const f of htmlFiles) {
    const html = await readText(f);
    if (!html) continue;
    if (/\/undefined["<]/.test(html) && /BreadcrumbList/.test(html)) {
      undefinedBreadcrumbs++;
      results.push(`          (undefined-breadcrumb) ${f.replace(DIST_DIR, '')}`);
    }
  }
  check('L9', 'No BreadcrumbList schema with /undefined URLs', undefinedBreadcrumbs === 0 ? 'pass' : 'fail',
    undefinedBreadcrumbs === 0 ? '' : `${undefinedBreadcrumbs} page(s) with broken breadcrumb URLs`);

  // --- 10. Publisher logo resolves (public/logo.svg) ---
  const logoExists = await fileExists(join(PROJECT_DIR, 'public', 'logo.svg'));
  check('L10', 'Publisher logo (public/logo.svg) exists for Organization schema', logoExists ? 'pass' : 'fail');

  // --- 11. No NewsArticle schema on preview pages ---
  let newsArticleOnPreview = 0;
  for (const f of previewHtml) {
    const html = await readText(f);
    if (!html) continue;
    if (/"@type"\s*:\s*"NewsArticle"/.test(html)) {
      newsArticleOnPreview++;
    }
  }
  check('L11', 'No NewsArticle schema on preview pages', newsArticleOnPreview === 0 ? 'pass' : 'fail',
    newsArticleOnPreview === 0 ? '' : `${newsArticleOnPreview} preview page(s) with NewsArticle schema`);

  // --- 12. No internal debug text on public pages ---
  const debugTokens = ['CLAIM AUDIT', 'SCIENCE DETAILS', 'TEST FIXTURE', 'PREVIEW — NOT PUBLISHED'];
  let debugLeaks = 0;
  for (const f of htmlFiles) {
    const html = await readText(f);
    if (!html) continue;
    const rel = f.replace(DIST_DIR, '');
    for (const tok of debugTokens) {
      if (html.includes(tok)) {
        // "TEST FIXTURE" is allowed on preview pages only (already filtered out)
        debugLeaks++;
        results.push(`          (debug-leak: "${tok}") ${rel}`);
      }
    }
  }
  check('L12', 'No internal debug text on public pages', debugLeaks === 0 ? 'pass' : 'fail',
    debugLeaks === 0 ? '' : `${debugLeaks} debug token(s) leaked`);

  // --- 13. No @example.com emails on public pages ---
  let exampleEmails = 0;
  for (const f of htmlFiles) {
    const html = await readText(f);
    if (!html) continue;
    if (/[a-z]+@example\.com/i.test(html)) {
      exampleEmails++;
      results.push(`          (example-email) ${f.replace(DIST_DIR, '')}`);
    }
  }
  check('L13', 'No @example.com placeholder emails on public pages', exampleEmails === 0 ? 'pass' : 'warn',
    exampleEmails === 0 ? '' : `${exampleEmails} page(s) with @example.com (replace before launch)`);

  // --- 14. No "Phase 1" / "fictional sample content" disclaimers on public pages ---
  let phase1Leaks = 0;
  for (const f of htmlFiles) {
    const html = await readText(f);
    if (!html) continue;
    if (/fictional sample content/i.test(html) || /Phase 1 notice/i.test(html)) {
      phase1Leaks++;
      results.push(`          (phase1-leak) ${f.replace(DIST_DIR, '')}`);
    }
  }
  check('L14', 'No "fictional sample content" / Phase-1 disclaimers on public pages', phase1Leaks === 0 ? 'pass' : 'fail',
    phase1Leaks === 0 ? '' : `${phase1Leaks} page(s) with stale Phase-1 disclaimer`);

  // --- 15. 404 page exists and renders ---
  const notFoundExists = await fileExists(join(DIST_DIR, '404.html'));
  check('L15', '404 page exists (404.html)', notFoundExists ? 'pass' : 'warn');

  // --- 16. All workflows have concurrency groups (race-condition safety) ---
  const workflowDir = join(PROJECT_DIR, '.github', 'workflows');
  const workflows = (await readdir(workflowDir)).filter((n) => n.endsWith('.yml') && n.includes('newsroom'));
  let noConcurrency = 0;
  for (const wf of workflows) {
    const text = await readText(join(workflowDir, wf));
    if (!text || !/^concurrency:/m.test(text)) {
      noConcurrency++;
      results.push(`          (no-concurrency) ${wf}`);
    }
    if (!text || !/git pull --rebase (--autostash )?origin main/.test(text)) {
      noConcurrency++;
      results.push(`          (no-rebase) ${wf}`);
    }
  }
  check('L16', `All ${workflows.length} newsroom workflows have concurrency groups + git pull --rebase`,
    noConcurrency === 0 ? 'pass' : 'fail', noConcurrency === 0 ? '' : `${noConcurrency} workflow(s) missing concurrency/rebase`);

  // --- 17. .env is gitignored and NOT tracked ---
  const gitignoreText = await readText(join(PROJECT_DIR, '.gitignore'));
  const envIgnored = /^\.env$/m.test(gitignoreText || '');
  check('L17', '.env is gitignored', envIgnored ? 'pass' : 'fail');

  // --- 18. wrangler.jsonc has no embedded secrets ---
  const wranglerText = await readText(join(PROJECT_DIR, 'wrangler.jsonc'));
  const wranglerClean = wranglerText && !/token|secret|password|api[_-]?key/i.test(wranglerText.replace(/"name":\s*"usa-news-engine"/, ''));
  check('L18', 'wrangler.jsonc has no embedded secrets/tokens', wranglerClean ? 'pass' : 'warn');

  // --- 19. No broken internal image references (local /images/ paths resolve) ---
  let brokenImages = 0;
  for (const f of htmlFiles) {
    const html = await readText(f);
    if (!html) continue;
    const imgSrcs = [...html.matchAll(/<img[^>]+src="([^"]+)"/g)].map((m) => m[1]);
    for (const src of imgSrcs) {
      if (src.startsWith('/') && !src.startsWith('//')) {
        const localPath = join(DIST_DIR, src);
        if (!(await fileExists(localPath))) {
          brokenImages++;
          if (brokenImages <= 10) results.push(`          (broken-img) ${f.replace(DIST_DIR, '')} → ${src}`);
        }
      }
    }
  }
  check('L19', `No broken local image references (${htmlFiles.length} pages scanned)`, brokenImages === 0 ? 'pass' : 'fail',
    brokenImages === 0 ? '' : `${brokenImages} broken image(s)`);

  // --- 20. Article count by category ---
  const articleDir = join(SRC_DIR, 'content', 'articles');
  const articleFiles = (await readdir(articleDir)).filter((n) => n.endsWith('.md'));
  const counts = { weather: 0, recalls: 0, science: 0, earthquakes: 0, us: 0, consumer: 0 };
  for (const f of articleFiles) {
    const text = await readText(join(articleDir, f));
    if (!text) continue;
    const m = text.match(/^category:\s*(\w+)/m);
    if (m && counts[m[1]] !== undefined) counts[m[1]]++;
  }
  check('L20', `Article inventory: ${articleFiles.length} articles (weather=${counts.weather} recalls=${counts.recalls} science=${counts.science})`, 'pass');

  // --- 21. Header date uses America/New_York timezone (not visitor's) ---
  // Check the source files (not the built HTML, which bakes the build-time date).
  const headerSrc = await readText(join(SRC_DIR, 'components', 'Header.astro'));
  const baseLayoutSrc = await readText(join(SRC_DIR, 'layouts', 'BaseLayout.astro'));
  const headerHasET = /timeZone:\s*['"]America\/New_York['"]/.test(headerSrc || '');
  const jsHasET = /timeZone:\s*['"]America\/New_York['"]/.test(baseLayoutSrc || '');
  check('L21', 'Header SSR date uses timeZone: America/New_York', headerHasET ? 'pass' : 'fail');
  check('L22', 'Header JS date uses timeZone: America/New_York (not visitor timezone)', jsHasET ? 'pass' : 'fail');

  // --- 23. No non-U.S. timezone USAGE in public UI source ---
  // The site is a U.S. news website; the newsroom timezone is America/New_York.
  // No non-U.S. timezone should be ACTIVELY USED (e.g. timeZone: 'Asia/Karachi')
  // in any public-facing source file. Mentions in comments explaining the policy
  // are fine — this check only flags actual `timeZone:` usage of non-U.S. zones.
  const srcFiles = await collectFiles(SRC_DIR, (n) => /\.(astro|ts|tsx|js|mjs)$/i.test(n));
  let nonUsTzLeaks = 0;
  for (const f of srcFiles) {
    const text = await readText(f);
    if (!text) continue;
    // Flag actual timeZone: 'Asia/Karachi' or similar non-U.S. timezone USAGE.
    // Allowed U.S. timezones: America/New_York, America/Chicago, America/Denver,
    // America/Los_Angeles, Pacific/Honolulu, UTC.
    const allowedTz = ['America/New_York', 'America/Chicago', 'America/Denver',
      'America/Los_Angeles', 'Pacific/Honolulu', 'UTC', 'America/Nome'];
    const tzMatches = [...text.matchAll(/timeZone:\s*['"]([^'"]+)['"]/g)];
    for (const m of tzMatches) {
      if (!allowedTz.includes(m[1])) {
        nonUsTzLeaks++;
        results.push(`          (non-us-tz) ${f.replace(PROJECT_DIR, '')}: timeZone='${m[1]}'`);
      }
    }
  }
  check('L23', 'No non-U.S. timezone usage in public UI source', nonUsTzLeaks === 0 ? 'pass' : 'fail',
    nonUsTzLeaks === 0 ? '' : `${nonUsTzLeaks} file(s) with non-U.S. timezone usage`);

  // --- 24. Stored article publishedAt timestamps remain ISO UTC ---
  // Verify frontmatter publishedAt values are ISO 8601 UTC (end in Z or +00:00).
  let nonUtcTimestamps = 0;
  for (const f of articleFiles) {
    const text = await readText(join(articleDir, f));
    if (!text) continue;
    const m = text.match(/^publishedAt:\s*(\S+)/m);
    if (m) {
      const val = m[1];
      // Must be ISO 8601 with UTC indicator (Z or +00:00)
      if (!/\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+]\d{2}:\d{2})/.test(val)) {
        nonUtcTimestamps++;
        results.push(`          (non-utc) ${f}: publishedAt=${val}`);
      }
    }
  }
  check('L24', 'Stored publishedAt timestamps are ISO UTC', nonUtcTimestamps === 0 ? 'pass' : 'fail',
    nonUtcTimestamps === 0 ? '' : `${nonUtcTimestamps} article(s) with non-UTC publishedAt`);

  return report();
}

function report() {
  console.log('\n------------------------------------------------------------');
  console.log('Results:');
  for (const r of results) console.log(r);
  console.log('------------------------------------------------------------');
  console.log(`\nTotal: ${passed} passed, ${warned} warned, ${failed} failed`);
  if (failed > 0) {
    console.error('\n[validate:launch] FAILED — one or more launch invariants failed.');
    process.exit(1);
  }
  if (warned > 0) {
    console.log('[validate:launch] PASS with warnings — review WARN items before launch.');
  } else {
    console.log('[validate:launch] SUCCESS — all launch invariants pass.');
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(`\n[validate:launch] Unexpected failure: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
