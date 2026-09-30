// Read-only historical category audit. Does not fetch, publish or modify data.
import { readFileSync } from 'node:fs';
import { classifyGeneralNewsCategory } from './lib/general-news-category.mjs';
import { CONFIRMED_CATEGORY_FIXES } from './lib/confirmed-general-category-fixes.mjs';
const registry = JSON.parse(readFileSync('data/published-general-news.json','utf8'));
const stories = registry.stories || [];
console.log(`READ-ONLY GENERAL CATEGORY AUDIT — published=${stories.length}`);
console.log('\nConfirmed historical corrections (existing URLs/slugs preserved):');
let confirmed = 0;
for (const [slug, {from,to}] of Object.entries(CONFIRMED_CATEGORY_FIXES)) {
  const s = stories.find(x => x.slug === slug);
  if (!s) { console.log(`  MISSING: ${slug}`); continue; }
  const state = s.category === from ? 'PROPOSE' : (s.category === to ? 'ALREADY CORRECTED' : 'UNEXPECTED CATEGORY');
  console.log(`  ${state}: [${s.category} -> ${to}] ${s.title}`);
  if (s.category === from) confirmed++;
}
console.log(`Confirmed pending: ${confirmed}`);
console.log('\nAdditional classifier differences: REVIEW ONLY (not auto-edited):');
let flagged=0;
for (const s of stories) {
  if (CONFIRMED_CATEGORY_FIXES[s.slug]) continue;
  let desc = '';
  try {
    const article = readFileSync(s.articlePath || `src/content/articles/${s.slug}.md`,'utf8');
    const match = article.match(/^description:\s*['\"]?(.*?)['\"]?\s*$/m);
    desc = match?.[1] || '';
  } catch {}
  const proposal = classifyGeneralNewsCategory(s.title,desc,s.category);
  if (proposal !== s.category) {
    console.log(`  REVIEW [${s.category} -> ${proposal}] ${s.title}`);
    flagged++;
  }
}
console.log(`Other review-only differences: ${flagged}`);
console.log('\nIMAGE-PROVENANCE ALERT (separate from categories):');
const shared = JSON.parse(readFileSync('data/published-stories.json','utf8'));
const sharedStories = Array.isArray(shared) ? shared : shared.stories || [];
for (const s of sharedStories) {
  if (/sports-watch-schmitt-suggests-jack-smith/.test(s.slug || '') && /Schmitt(?:%20|\s)P(?:%C3%A1|á)l/i.test(s.heroImageSourcePageUrl || '')) {
    console.log('  Review Schmitt story image: provenance names Schmitt Pal, not the person in the headline. Image unchanged by category patch.');
  }
}
console.log('AUDIT COMPLETE — read-only; no files changed or articles published.');
