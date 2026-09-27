/**
 * Phase 5A.1 — Update article frontmatter with image attribution fields
 * and remove updatedAt (first publication).
 */
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(__dirname, '..');
const ARTICLES_DIR = join(PROJECT_DIR, 'src', 'content', 'articles');
const DRAFTS_DIR = join(PROJECT_DIR, 'data', 'drafts');

async function main() {
  const files = await readdir(ARTICLES_DIR);
  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    const articlePath = join(ARTICLES_DIR, file);
    let content = await readFile(articlePath, 'utf8');

    // Extract the slug from the frontmatter
    const slugMatch = content.match(/^slug:\s*"([^"]+)"/m);
    if (!slugMatch) continue;
    const slug = slugMatch[1];

    // Find the corresponding draft to get image metadata
    let draft = null;
    try {
      const draftFiles = await readdir(DRAFTS_DIR);
      for (const df of draftFiles) {
        if (!df.endsWith('.json')) continue;
        const d = JSON.parse(await readFile(join(DRAFTS_DIR, df), 'utf8'));
        if (d.slug === slug) {
          draft = d;
          break;
        }
      }
    } catch {}

    if (!draft) {
      console.log(`  WARNING: no draft found for ${slug}`);
      continue;
    }

    // Remove the updatedAt line from frontmatter
    content = content.replace(/^updatedAt:.*$/m, '');

    // Add new fields after the imageAlt line
    const heroImage = draft.heroImage || {};
    const newFields = [];
    if (heroImage.mode) newFields.push(`imageMode: "${heroImage.mode}"`);
    if (heroImage.caption) newFields.push(`imageCaption: "${heroImage.caption.replace(/"/g, '\\"')}"`);
    if (heroImage.creator) newFields.push(`imageCreator: "${heroImage.creator.replace(/"/g, '\\"')}"`);
    if (heroImage.license) newFields.push(`imageLicense: "${heroImage.license.replace(/"/g, '\\"')}"`);
    if (heroImage.licenseUrl) newFields.push(`imageLicenseUrl: "${heroImage.licenseUrl}"`);

    // Add sourceOffice after sourceUrl
    if (draft.sourceOffice) {
      content = content.replace(
        /^(sourceUrl:.*$)/m,
        `$1\nsourceOffice: "${draft.sourceOffice.replace(/"/g, '\\"')}"`,
      );
    }

    // Insert image fields after imageAlt
    if (newFields.length > 0) {
      content = content.replace(
        /^(imageAlt:.*$)/m,
        `$1\n${newFields.join('\n')}`,
      );
    }

    // Clean up any double blank lines left by removing updatedAt
    content = content.replace(/\n{3,}/g, '\n\n');

    await writeFile(articlePath, content, 'utf8');
    console.log(`  Updated: ${file}`);
  }
  console.log('Done.');
}

main().catch(console.error);
