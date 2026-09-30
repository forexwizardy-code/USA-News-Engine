import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const articlesDir = join(root, 'src', 'content', 'articles');
const publicDir = join(root, 'public');

if (!existsSync(articlesDir) || !existsSync(publicDir)) {
  console.error('[validate-article-images] ERROR: run this from the project root.');
  process.exit(1);
}

const articles = readdirSync(articlesDir).filter((name) => name.endsWith('.md'));
const missing = [];
const invalid = [];
let checkedImages = 0;

for (const article of articles) {
  const text = readFileSync(join(articlesDir, article), 'utf8');
  const match = text.match(/^image:\s*(?:"([^"]+)"|'([^']+)'|([^\r\n#]+))/m);
  if (!match) continue;

  const image = (match[1] || match[2] || match[3] || '').trim();
  if (!image || /^https?:\/\//i.test(image)) continue;

  checkedImages += 1;
  if (!image.startsWith('/')) {
    invalid.push({ article, image, reason: 'local image path must start with /' });
    continue;
  }

  const localPath = join(publicDir, ...image.replace(/^\/+/, '').split('/'));
  if (!existsSync(localPath)) {
    missing.push({ article, image, reason: 'file does not exist' });
    continue;
  }

  const stat = statSync(localPath);
  if (!stat.isFile() || stat.size === 0) {
    missing.push({ article, image, reason: 'file is empty or not a regular file' });
  }
}

if (invalid.length || missing.length) {
  console.error('\n[validate-article-images] FAILED');
  for (const item of invalid) console.error(`  INVALID | ${item.article} | ${item.image} | ${item.reason}`);
  for (const item of missing) console.error(`  MISSING | ${item.article} | ${item.image} | ${item.reason}`);
  console.error(`\n${invalid.length + missing.length} image problem(s) found. Build blocked.`);
  process.exit(1);
}

console.log(`[validate-article-images] PASS — ${articles.length} articles scanned, ${checkedImages} local image references verified.`);
