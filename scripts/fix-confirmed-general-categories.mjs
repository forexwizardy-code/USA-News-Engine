// Dry run by default. With --apply, updates only 6 allowlisted category values
// in article frontmatter and BOTH published registries. Backups in OS temp.
import { readFileSync, writeFileSync, mkdtempSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { CONFIRMED_CATEGORY_FIXES as FIXES } from './lib/confirmed-general-category-fixes.mjs';
const apply = process.argv.includes('--apply');
const generalFile='data/published-general-news.json';
const sharedFile='data/published-stories.json';
const general=JSON.parse(readFileSync(generalFile,'utf8'));
const shared=JSON.parse(readFileSync(sharedFile,'utf8'));
const gs=general.stories;
const ss=Array.isArray(shared) ? shared : shared.stories;
if (!Array.isArray(gs)||!Array.isArray(ss)) throw Error('Unexpected registry schema; no changes made.');
const articleChanges=[];
for (const [slug, {from,to}] of Object.entries(FIXES)) {
  const a=gs.filter(s=>s.slug===slug);
  const b=ss.filter(s=>s.slug===slug);
  if (a.length!==1 || b.length!==1) throw Error(`Missing/duplicate registry entry for ${slug}; no changes made.`);
  if (a[0].category!==from || b[0].event!==from) throw Error(`Unexpected existing category for ${slug}: ${a[0].category}/${b[0].event}; no changes made.`);
  const path=a[0].articlePath || `src/content/articles/${slug}.md`;
  const original=readFileSync(path,'utf8');
  if (!original.startsWith('---')) throw Error(`Missing frontmatter in ${path}; no changes made.`);
  const second=original.indexOf('\n---',4);
  if (second < 0) throw Error(`Unterminated frontmatter in ${path}; no changes made.`);
  const front=original.slice(0,second);
  const re=/^category:\s*(?:['"])?([a-z]+)(?:['"])?\s*$/gm;
  const matches=[...front.matchAll(re)];
  if(matches.length!==1 || matches[0][1]!==from) throw Error(`Unexpected article category in ${path}; no changes made.`);
  const newFront=front.replace(re,`category: ${to}`);
  articleChanges.push({path,old:original,new:newFront+original.slice(second),from,to,slug});
}
console.log(`${apply?'APPLY':'DRY RUN'} — ${articleChanges.length} exact corrections; slugs, URLs, dates, image fields untouched.`);
for(const x of articleChanges)console.log(`  ${x.from} -> ${x.to}: ${x.slug}`);
if (!apply) {console.log('To apply AFTER reviewing, rerun with --apply. No files changed.');process.exit(0);}
const targetPaths=[generalFile,sharedFile,...articleChanges.map(x=>x.path)];
const dirty=execFileSync('git',['status','--porcelain','--',...targetPaths],{encoding:'utf8'}).trim();
if(dirty)throw Error('Target registries or articles already have local edits; no changes made.');
const backup=mkdtempSync(join(tmpdir(),'usa-news-category-fix-'));
for(const path of [generalFile,sharedFile,...articleChanges.map(x=>x.path)])copyFileSync(path,join(backup,path.replace(/[\\/]/g,'__')));
for(const x of articleChanges) {
  gs.find(s=>s.slug===x.slug).category=x.to;
  ss.find(s=>s.slug===x.slug).event=x.to;
}
for(const x of articleChanges)writeFileSync(x.path,x.new,'utf8');
writeFileSync(generalFile,JSON.stringify(general,null,2)+'\n','utf8');
writeFileSync(sharedFile,JSON.stringify(shared,null,2)+'\n','utf8');
console.log('APPLIED — category-only correction; backups:',backup);
