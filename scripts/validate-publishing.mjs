/**
 * US News Engine — publishing validation (Phase 5B).
 *
 * Validates the published-stories registry AND the article markdown files
 * against a set of editorial / SEO / image-licensing rules.
 *
 * Checks performed:
 *   1.  No duplicate storyKeys in published-stories.json
 *   2.  No duplicate public slugs
 *   3.  updatedAt <= publishedAt when updatedAt exists
 *       (FAIL if updatedAt exists and is earlier than publishedAt)
 *   4.  Licensed photo has an exact license (not vague like "CC licensed")
 *   5.  Licensed photo has a source page URL
 *   6.  Licensed photo has a creator when attributionRequired
 *   7.  Expired/cancelled story has breaking=false
 *   8.  No raw alert IDs (urn:oid) visible in article reader copy (markdown body)
 *   9.  imageRelation is present for all articles (in the registry)
 *   10. Map-data images don't claim photographic attribution — imageCreator
 *       should NOT be a person's name
 *
 * Exits with code 1 if any validation fails, 0 if all pass.
 *
 * Run manually:
 *   npm run validate:publishing
 *   (or) node scripts/validate-publishing.mjs
 *
 * Uses only Node.js built-ins — no gray-matter, no external deps.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(__dirname, '..');
const PUBLISHED_STORIES_FILE = join(PROJECT_DIR, 'data', 'published-stories.json');
const ARTICLES_DIR = join(PROJECT_DIR, 'src', 'content', 'articles');
const DRAFT_IMAGES_DIR = join(PROJECT_DIR, 'data', 'draft-images');

// ---------------------------------------------------------------------------
// Frontmatter parser (no gray-matter dependency — flat key:value only).
// Returns { data, body } where body is everything after the closing `---`.
// ---------------------------------------------------------------------------

function parseFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return { data: {}, body: text };
  const yaml = match[1];
  const body = text.slice(match[0].length).replace(/^\r?\n+/, '');
  const data = {};
  for (const line of yaml.split(/\r?\n/)) {
    const m = line.match(/^(\w+):\s*(.*)$/);
    if (!m) continue;
    const [, key, rawVal] = m;
    let val = rawVal.trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    else if (val.startsWith("'") && val.endsWith("'")) val = val.slice(1, -1);
    if (val === 'true') val = true;
    else if (val === 'false') val = false;
    else if (/^-?\d+$/.test(val)) val = parseInt(val, 10);
    else if (val.startsWith('[') && val.endsWith(']')) {
      val = val
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    }
    data[key] = val;
  }
  return { data, body };
}

// ---------------------------------------------------------------------------
// License exactness — vague licenses fail check 4.
//
// We accept:
//   - "CC BY 2.0", "CC BY-SA 3.0", "CC BY-NC 4.0", etc. (with version number)
//   - "CC0 1.0" (with version)
//   - "Public domain" (specific dedication; we treat the bare phrase as exact
//     because NWS / Wikimedia flag it this way — the sourcePageUrl check
//     guards against hand-wavy "it's public domain" with no source)
//
// We reject as vague:
//   - "CC licensed"
//   - "Creative Commons" (bare)
//   - "CC BY" / "CC BY-SA" / etc. with NO version number
//   - "" / null / undefined
// ---------------------------------------------------------------------------

function isVagueLicense(license) {
  if (!license || typeof license !== 'string') return true;
  const l = license.toLowerCase().trim();
  if (!l) return true;
  if (l === 'cc licensed' || l === 'creative commons' || l === 'cc') return true;
  // CC family without a version digit anywhere in the string
  if (/^cc[- ]?(by(?:-?(?:sa|nc|nd|nc-sa|nc-nd))?|0)$/.test(l) && !/\d/.test(l)) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Attribution-required inference.
//
// published-stories.json doesn't carry an explicit `attributionRequired`
// flag, so we derive it from the license string. Any CC BY* license requires
// attribution; CC0 and "Public domain" do not.
// ---------------------------------------------------------------------------

function requiresAttribution(license) {
  if (!license) return false;
  const l = license.toLowerCase().trim();
  if (/^cc[- ]?by/.test(l)) return true; // CC BY, CC BY-SA, CC BY-NC, etc.
  if (l.includes('attribution required')) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Person-name heuristic for check 10.
//
// Map-data images are original graphics by US News Engine — the creator
// should be "US News Engine" or an organization, never a person's name.
// We flag any creator that looks like a personal name (2-4 capitalized words
// with no organization signals).
// ---------------------------------------------------------------------------

const ORG_SIGNALS =
  /(us news engine|nps|u\.s\.|national|service|department|office|agency|administration|bureau|noaa|usgs|fema|army corps|county|state of|government|gov\b|inc\.|llc|corp|foundation|society|trust|institute|university|college|press|news|media|commons|wikimedia|geograph|response|team|staff|desk|bureau|agency|department)/i;

function looksLikePersonName(name) {
  if (!name || typeof name !== 'string') return false;
  const n = name.trim();
  if (!n) return false;
  if (ORG_SIGNALS.test(n)) return false;
  // Single-token usernames (e.g. "LakeCountyIL", "Ebyabe") are not "person
  // names" in the photographic-attribution sense — they're account handles.
  if (!/\s/.test(n)) return false;
  const words = n.split(/\s+/);
  if (words.length < 2 || words.length > 4) return false;
  // Each word starts with an uppercase letter (allow initials, apostrophes,
  // hyphens, periods).
  return words.every((w) => /^[A-Z][a-zA-Z'.-]*$/.test(w));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('[validate-publishing] Starting publishing validation.\n');

  const passes = [];
  const fails = [];

  // --- Load published-stories.json ----------------------------------------
  let doc;
  try {
    doc = JSON.parse(await readFile(PUBLISHED_STORIES_FILE, 'utf8'));
  } catch (err) {
    console.error(`  FATAL: Could not read published-stories.json: ${err.message}`);
    process.exit(1);
  }
  const stories = Array.isArray(doc.stories) ? doc.stories : [];
  console.log(`  Stories in registry: ${stories.length}`);

  // Load draft-image real.json metadata so we can look up attributionRequired
  // for the creator-when-attribution-required check.
  const draftImageMetaByStoryKey = new Map();
  try {
    const files = (await readdir(DRAFT_IMAGES_DIR)).filter((f) =>
      f.endsWith('-real.json'),
    );
    for (const f of files) {
      try {
        const meta = JSON.parse(await readFile(join(DRAFT_IMAGES_DIR, f), 'utf8'));
        if (meta.storyKey) draftImageMetaByStoryKey.set(meta.storyKey, meta);
      } catch {
        /* ignore parse errors */
      }
    }
  } catch {
    /* directory missing — non-fatal */
  }

  // =======================================================================
  // Check 1 — No duplicate storyKeys
  // =======================================================================
  {
    const seen = new Set();
    let dups = 0;
    for (const s of stories) {
      if (seen.has(s.storyKey)) {
        fails.push(`Duplicate storyKey: ${s.storyKey}`);
        dups++;
      } else {
        seen.add(s.storyKey);
      }
    }
    if (dups === 0) {
      passes.push(`Check 1 (no duplicate storyKeys): ${stories.length} unique keys`);
    }
  }

  // =======================================================================
  // Check 2 — No duplicate public slugs
  // =======================================================================
  {
    const seen = new Set();
    let dups = 0;
    for (const s of stories) {
      if (!s.slug) {
        fails.push(`Story ${s.storyKey}: missing slug`);
        continue;
      }
      if (seen.has(s.slug)) {
        fails.push(`Duplicate slug: ${s.slug}`);
        dups++;
      } else {
        seen.add(s.slug);
      }
    }
    if (dups === 0) {
      passes.push(`Check 2 (no duplicate slugs): ${stories.length} unique slugs`);
    }
  }

  // =======================================================================
  // Check 3 — updatedAt <= publishedAt when updatedAt exists
  // (FAIL when updatedAt exists and is earlier than publishedAt)
  // =======================================================================
  {
    let checkCount = 0;
    for (const s of stories) {
      if (s.updatedAt) {
        checkCount++;
        const updated = new Date(s.updatedAt).getTime();
        const published = new Date(s.publishedAt).getTime();
        if (Number.isNaN(updated) || Number.isNaN(published)) {
          fails.push(
            `Story ${s.storyKey}: unparseable updatedAt/publishedAt (updatedAt="${s.updatedAt}", publishedAt="${s.publishedAt}")`,
          );
          continue;
        }
        if (updated < published) {
          fails.push(
            `Story ${s.storyKey}: updatedAt (${s.updatedAt}) is earlier than publishedAt (${s.publishedAt})`,
          );
        } else {
          passes.push(`Story ${s.storyKey}: updatedAt (${s.updatedAt}) >= publishedAt (${s.publishedAt})`);
        }
      }
    }
    if (checkCount === 0) {
      passes.push(`Check 3 (updatedAt <= publishedAt): no story has updatedAt — n/a`);
    }
  }

  // =======================================================================
  // Per-story checks (4, 5, 6, 7, 9, 10)
  // =======================================================================
  for (const s of stories) {
    const isLicensedPhoto = s.heroImageMode === 'licensed-photo';

    // --- Check 9 — imageRelation present for all articles ----------------
    if (!s.heroImageRelation) {
      fails.push(`Story ${s.storyKey}: missing heroImageRelation`);
    } else {
      passes.push(`Story ${s.storyKey}: heroImageRelation = "${s.heroImageRelation}"`);
    }

    if (isLicensedPhoto) {
      // --- Check 4 — exact license --------------------------------------
      if (isVagueLicense(s.heroImageLicense)) {
        fails.push(
          `Story ${s.storyKey}: licensed photo has vague license "${s.heroImageLicense}"`,
        );
      } else {
        passes.push(`Story ${s.storyKey}: license is specific: "${s.heroImageLicense}"`);
      }

      // --- Check 5 — source page URL ------------------------------------
      if (!s.heroImageSourcePageUrl) {
        fails.push(`Story ${s.storyKey}: licensed photo missing source page URL`);
      } else {
        passes.push(`Story ${s.storyKey}: has source page URL`);
      }

      // --- Check 6 — creator when attributionRequired -------------------
      // Look up attributionRequired from draft-image metadata if available;
      // otherwise derive from the license string.
      const draftMeta = draftImageMetaByStoryKey.get(s.storyKey);
      const attributionRequired =
        draftMeta && typeof draftMeta.attributionRequired === 'boolean'
          ? draftMeta.attributionRequired
          : requiresAttribution(s.heroImageLicense);

      if (attributionRequired) {
        if (!s.heroImageCreator) {
          fails.push(
            `Story ${s.storyKey}: licensed photo requires attribution but creator is missing`,
          );
        } else {
          passes.push(
            `Story ${s.storyKey}: has creator for attribution: "${s.heroImageCreator}"`,
          );
        }
      }
    }

    // --- Check 7 — Expired/cancelled story has breaking=false ------------
    if (s.lifecycleStatus === 'expired' || s.lifecycleStatus === 'cancelled') {
      if (s.breaking) {
        fails.push(
          `Story ${s.storyKey}: lifecycleStatus=${s.lifecycleStatus} but breaking=true`,
        );
      } else {
        passes.push(
          `Story ${s.storyKey}: ${s.lifecycleStatus} story has breaking=false`,
        );
      }
    }

    // --- Check 10 — Map-data images don't claim photographic attribution -
    if (s.heroImageMode === 'map-data') {
      if (looksLikePersonName(s.heroImageCreator)) {
        fails.push(
          `Story ${s.storyKey}: map-data image creator looks like a person's name: "${s.heroImageCreator}"`,
        );
      } else {
        passes.push(
          `Story ${s.storyKey}: map-data creator OK: "${s.heroImageCreator}"`,
        );
      }
    }
  }

  // =======================================================================
  // Check 8 — No raw alert IDs (urn:oid) in article reader copy
  // =======================================================================
  {
    let articleFiles = [];
    try {
      articleFiles = (await readdir(ARTICLES_DIR)).filter((f) => f.endsWith('.md'));
    } catch {
      console.log('  Warning: src/content/articles/ not found.');
    }
    for (const file of articleFiles) {
      const raw = await readFile(join(ARTICLES_DIR, file), 'utf8');
      const { body } = parseFrontmatter(raw);
      if (/urn:oid:/i.test(body)) {
        fails.push(`Article ${file}: raw NWS alert ID (urn:oid:) found in reader copy`);
      } else {
        passes.push(`Article ${file}: no raw alert IDs in body`);
      }
    }
  }

  // =======================================================================
  // Report
  // =======================================================================
  console.log('\n--- PASSED ---');
  for (const p of passes) console.log(`  ✓ ${p}`);

  console.log('\n--- FAILED ---');
  if (fails.length === 0) {
    console.log('  (none)');
  } else {
    for (const f of fails) console.log(`  ✗ ${f}`);
  }

  console.log(
    `\n[validate-publishing] ${passes.length} check(s) passed, ${fails.length} check(s) failed.`,
  );

  if (fails.length > 0) {
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(`[validate-publishing] FATAL: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
