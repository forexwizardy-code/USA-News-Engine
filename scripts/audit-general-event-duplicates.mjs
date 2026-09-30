/** Read-only audit of potential headline-level General News repeats. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { compareEventHeadlines, findEventDuplicate } from './lib/general-event-duplicate.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const json = (relative) => JSON.parse(readFileSync(resolve(root, relative), 'utf8'));
const published = json('data/published-general-news.json').stories || [];
const candidates = json('data/general-news/general-news-story-records.json').stories || [];
const publishedKeys = new Set(published.map(s => s.generalStoryKey).filter(Boolean));
const publishedUrls = new Set(published.flatMap(s => s.sourceUrls || []));
const isExact = s => publishedKeys.has(s.generalStoryKey) || (s.allSourceUrls || [s.primarySourceUrl]).some(u => publishedUrls.has(u));

console.log(`\nREAD-ONLY EVENT DUPLICATE AUDIT — published=${published.length}, clustered=${candidates.length}`);
console.log('\nHistorical near-duplicate published pairs (does not modify old articles):');
let history = 0;
for (let i = 0; i < published.length; i++) {
  for (let j = 0; j < i; j++) {
    const x = published[i], y = published[j];
    if (x.generalStoryKey === y.generalStoryKey) continue;
    if ((x.sourceUrls || []).some(u => (y.sourceUrls || []).includes(u))) continue;
    const match = compareEventHeadlines(x, y);
    if (match && history++ < 20) console.log(`  [${match.status}] ${match.score}  "${x.title}"  <>  "${y.title}"`);
  }
}
console.log(`Historical flagged pairs: ${history}`);

console.log('\nNew eligible candidates resembling prior publications (exact key/URL matches excluded):');
let duplicate = 0, review = 0;
for (const s of candidates.filter(c => c.publishEligible && !isExact(c))) {
  const match = findEventDuplicate(s, published);
  if (!match) continue;
  if (match.status === 'duplicate') duplicate++; else review++;
  if (duplicate + review <= 25) console.log(`  [${match.status}] ${match.score}  "${s.title}"  <>  "${match.oldTitle}"`);
}
console.log(`Eligible candidate near matches: ${duplicate} duplicates; ${review} review holds.`);
console.log('AUDIT COMPLETE — no publishing, article edits, registry changes, or network calls.\n');
