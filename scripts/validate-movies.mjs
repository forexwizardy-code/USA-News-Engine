/**
 * Validate the Movies release calendar before Astro builds the public page.
 * This is an editorially checked dataset, NOT an unsourced live film API.
 * Release-date freshness is a warning so the newsroom isn't blocked when a
 * studio moves a date, but provenance and malformed data are hard failures.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const fail = [];
const warn = [];
const dataset = JSON.parse(readFileSync(join(root, 'data/upcoming-movies.json'), 'utf8'));
const urlOk = (value) => { try { return new URL(value).protocol === 'https:'; } catch { return false; } };
const dateOk = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  !Number.isNaN(Date.parse(value)) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
const known = new Set();
if (!dateOk(dataset.updatedAt)) fail.push('updatedAt must be an ISO calendar date');
if (dataset.market !== 'United States / Canada') fail.push('Release market must explicitly be U.S./Canada');
if (!Array.isArray(dataset.movies) || dataset.movies.length < 12) fail.push('Expected at least 12 sourced release listings');

for (const [idx, movie] of (dataset.movies || []).entries()) {
  const id = movie.slug || 'row-' + (idx + 1);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) fail.push(id + ': invalid slug');
  if (known.has(id)) fail.push(id + ': duplicate slug');
  known.add(id);
  if (!movie.title || !movie.distributor || !dateOk(movie.releaseDate)) fail.push(id + ': title/distributor/date missing or invalid');
  if (movie.releaseMarket !== 'U.S. / Canada') fail.push(id + ': market missing');
  if (!urlOk(movie.sourceUrl) || !movie.sourceName) fail.push(id + ': attributed HTTPS release-date source required');
  if (!Array.isArray(movie.cast) || !Array.isArray(movie.genres)) fail.push(id + ': cast and genre must be arrays');
  if (movie.cast?.length && !urlOk(movie.castSourceUrl)) fail.push(id + ': cast listed without a cast source');
  for (const field of ['officialUrl','officialTrailerUrl','castSourceUrl']) {
    if (movie[field] && !urlOk(movie[field])) fail.push(id + ': ' + field + ' must be HTTPS');
  }
}
const nav = readFileSync(join(root, 'src/components/Header.astro'), 'utf8');
const page = join(root, 'src/pages/movies/index.astro');
if (!nav.includes("href: '/movies/'")) fail.push('Movies navigation link missing');
if (!existsSync(page)) fail.push('Movies page missing');
else {
  const html = readFileSync(page, 'utf8');
  for (const region of ['release-calendar','movie-news','celebrity-news']) {
    if (!html.includes('id="' + region + '"')) fail.push('Movies section missing: ' + region);
  }
}
if (dateOk(dataset.updatedAt)) {
  const days = Math.floor((Date.now() - Date.parse(dataset.updatedAt+'T00:00:00Z')) / 86400000);
  if (days > 7) warn.push('Release calendar was checked '+days+' days ago. Re-verify studio schedule sources.');
}
const builtPage = join(root, 'dist/movies/index.html');
if (existsSync(builtPage)) {
  const html = readFileSync(builtPage, 'utf8');
  if (!html.includes('Upcoming movie releases') || !html.includes('Street Fighter')) {
    fail.push('Built /movies/ page is missing release-calendar content');
  }
}
for (const msg of warn) console.log('[MOVIES WARN] '+msg);
for (const msg of fail) console.error('[MOVIES FAIL] '+msg);
console.log('[MOVIES] '+(dataset.movies||[]).length+' sourced releases; '+fail.length+' failed; '+warn.length+' freshness warnings');
process.exit(fail.length ? 1 : 0);
