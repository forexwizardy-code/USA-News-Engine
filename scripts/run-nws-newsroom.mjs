/**
 * US News Engine — master NWS newsroom automation script (Phase 6A).
 *
 * Orchestrates the entire NWS pipeline: fetch → filter → stories →
 * lifecycle reconciliation → updates/expirations → new story selection →
 * draft generation → image resolution → publishing → validation → build.
 *
 * Reads config/automation.json for the kill switch and publishing caps.
 *
 * When nwsPublishingEnabled = false: fetches, analyzes, reports, but
 * makes NO public content changes.
 *
 * When nwsPublishingEnabled = true: publishes new stories (up to caps),
 * updates existing stories, processes expirations, then validates and builds.
 *
 * Run:
 *   npm run newsroom:nws
 *   (or) node scripts/run-nws-newsroom.mjs
 */

import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(__dirname, '..');
const CONFIG_FILE = join(PROJECT_DIR, 'config', 'automation.json');
const REGISTRY_FILE = join(PROJECT_DIR, 'data', 'published-stories.json');

// ===========================================================================
// Main
// ===========================================================================

async function main() {
  const startTime = Date.now();
  console.log('========================================');
  console.log('US News Engine — NWS Newsroom Automation');
  console.log('========================================');
  console.log(`Started: ${new Date().toISOString()}`);
  console.log('');

  // --- Load configuration (kill switch) ---
  let config;
  try {
    config = JSON.parse(await readFile(CONFIG_FILE, 'utf8'));
  } catch {
    config = { nwsPublishingEnabled: false, maxNewPerRun: 3, maxNewPerDay: 12 };
  }
  console.log(`Kill switch: nwsPublishingEnabled = ${config.nwsPublishingEnabled}`);
  console.log(`Caps: maxNewPerRun=${config.maxNewPerRun}, maxNewPerDay=${config.maxNewPerDay}`);
  console.log('');

  // --- Step 1-3: Fetch → Filter → Stories ---
  console.log('--- Step 1-3: Fetch NWS → Filter → Build stories ---');
  try {
    execSync('npm run prepare:nws', { cwd: PROJECT_DIR, stdio: 'pipe' });
    console.log('  NWS pipeline completed.');
  } catch (err) {
    console.error('  FATAL: NWS pipeline failed. Aborting.');
    console.error(err.stderr?.toString()?.slice(0, 500) || err.message);
    process.exit(1);
  }

  // Load the fresh story records
  const storiesDoc = JSON.parse(
    await readFile(join(PROJECT_DIR, 'data', 'nws-story-records.json'), 'utf8'),
  );
  const currentStories = storiesDoc.stories || [];
  console.log(`  Fetched stories: ${storiesDoc.inputCandidateCount || 'n/a'} candidates → ${storiesDoc.uniqueStoryCount} unique`);

  // --- Step 4: Load published-stories registry ---
  console.log('\n--- Step 4: Load published-stories registry ---');
  let registry;
  try {
    registry = JSON.parse(await readFile(REGISTRY_FILE, 'utf8'));
    console.log(`  Registry loaded: ${registry.storyCount} published stories`);
  } catch {
    registry = { generatedAt: new Date().toISOString(), storyCount: 0, stories: [] };
    console.log('  No registry found — treating all stories as new.');
  }

  // --- Step 5: Reconcile lifecycle ---
  console.log('\n--- Step 5: Reconcile lifecycle ---');
  const now = Date.now();
  const categories = { NEW: [], UPDATED: [], UNCHANGED: [], EXPIRED: [], CANCELLED: [] };

  for (const story of currentStories) {
    const published = registry.stories.find((s) => s.storyKey === story.storyKey);
    if (!published) {
      categories.NEW.push(story);
      continue;
    }

    // Check for new alert IDs
    const newAlertIds = story.alertIds.filter(
      (id) => !published.allAlertIds.includes(id),
    );
    if (newAlertIds.length > 0) {
      categories.UPDATED.push({ story, published, newAlertIds });
      continue;
    }

    // Check for expiration
    const expires = story.expires || story.ends;
    if (expires && new Date(expires).getTime() < now) {
      categories.EXPIRED.push({ story, published });
      continue;
    }

    // Check for explicit cancellation (status field)
    if (story.status === 'Cancel') {
      categories.CANCELLED.push({ story, published });
      continue;
    }

    categories.UNCHANGED.push(story);
  }

  // Phase 10A.1 — MISSING story detection (lifecycle bug fix).
  // Published stories whose storyKey is NOT in the current NWS feed have
  // disappeared from the source. This happens when:
  //   - The alert expired and NWS removed it from the active feed
  //   - The alert was cancelled
  //   - The storyKey date changed (the alert was re-issued with a new date)
  //
  // For these, we check the stored lastNwsEndsAt / lastNwsExpiresAt
  // timestamp. If it's in the past, the alert has expired → mark as
  // EXPIRED and clear breaking. This ensures the homepage stops showing
  // expired alerts as "breaking" and the article gets a lifecycle notice.
  //
  // Without this step, expired alerts would remain "active" forever
  // because the reconcile loop only iterates over currentStories (which
  // no longer includes the expired alert).
  const currentStoryKeys = new Set(currentStories.map((s) => s.storyKey));
  for (const published of registry.stories) {
    // Skip non-weather stories (recalls, science) — they don't expire.
    if (published.storyKey && !published.storyKey.match(/^(flood|wind|storm|tornado|hurricane|winter|heat|fire|coastal|special|rip|dust|hazardous|extreme|severe|gale|small-craft|freeze|frost|high-wind)/i)) {
      continue;
    }
    if (currentStoryKeys.has(published.storyKey)) continue;
    // Already expired/cancelled — skip.
    if (published.lifecycleStatus === 'expired' || published.lifecycleStatus === 'cancelled') continue;

    // Check stored expiration timestamps.
    const endsAt = published.lastNwsEndsAt || published.lastNwsExpiresAt;
    if (endsAt && new Date(endsAt).getTime() < now) {
      categories.EXPIRED.push({ story: { storyKey: published.storyKey, title: published.slug }, published });
      console.log(`  [missing→expired] ${published.storyKey}: not in current feed, endsAt=${endsAt} is in the past`);
    }
  }

  console.log(`  NEW: ${categories.NEW.length}`);
  console.log(`  UPDATED: ${categories.UPDATED.length}`);
  console.log(`  UNCHANGED: ${categories.UNCHANGED.length}`);
  console.log(`  EXPIRED: ${categories.EXPIRED.length}`);
  console.log(`  CANCELLED: ${categories.CANCELLED.length}`);

  // --- Check daily cap ---
  const today = new Date().toISOString().slice(0, 10);
  const publishedToday = registry.stories.filter(
    (s) => s.publishedAt?.startsWith(today),
  ).length;
  const remainingDaily = Math.max(0, (config.maxNewPerDay || 12) - publishedToday);
  const newAllowed = Math.min(config.maxNewPerRun || 3, remainingDaily);

  console.log(`\n  Daily cap: ${publishedToday} published today, ${remainingDaily} remaining, ${newAllowed} allowed this run`);

  // --- Kill switch check ---
  if (!config.nwsPublishingEnabled) {
    console.log('\n========================================');
    console.log('PUBLISHING DISABLED (kill switch active)');
    console.log('No public content changes will be made.');
    console.log('No Git commit. No Cloudflare deploy.');
    console.log('========================================');
    printSummary(categories, 0, 0, 0, 0, 0, startTime);
    return;
  }

  // --- Step 6: Process updates/expirations first ---
  console.log('\n--- Step 6: Process updates and expirations ---');
  let updatedCount = 0;
  let expiredCount = 0;
  let cancelledCount = 0;

  for (const upd of categories.UPDATED) {
    try {
      await processUpdate(upd.story, upd.published, upd.newAlertIds, registry);
      updatedCount++;
      console.log(`  UPDATED: ${upd.story.storyKey}`);
    } catch (err) {
      console.error(`  UPDATE FAILED: ${upd.story.storyKey} — ${err.message}`);
    }
  }

  for (const exp of categories.EXPIRED) {
    try {
      await processExpiration(exp.published, registry);
      expiredCount++;
      console.log(`  EXPIRED: ${exp.story.storyKey}`);
    } catch (err) {
      console.error(`  EXPIRE FAILED: ${exp.story.storyKey} — ${err.message}`);
    }
  }

  for (const can of categories.CANCELLED) {
    try {
      await processCancellation(can.published, registry);
      cancelledCount++;
      console.log(`  CANCELLED: ${can.story.storyKey}`);
    } catch (err) {
      console.error(`  CANCEL FAILED: ${can.story.storyKey} — ${err.message}`);
    }
  }

  // --- Step 7: Select safe NEW stories ---
  console.log('\n--- Step 7: Select safe NEW stories ---');
  const selectedNew = selectNewStories(categories.NEW, newAllowed, registry);
  console.log(`  Selected ${selectedNew.length} new stories for publication`);

  // --- Steps 8-11: Generate drafts, resolve images, publish ---
  console.log('\n--- Steps 8-11: Generate drafts → resolve images → publish ---');
  let photoHeroes = 0;
  let mapFallbacks = 0;
  let newPublished = 0;

  for (const story of selectedNew) {
    try {
      console.log(`\n  Processing NEW: ${story.storyKey}`);

      // Generate draft
      execSync(`node scripts/generate-nws-draft.mjs "${story.storyKey}"`, {
        cwd: PROJECT_DIR,
        stdio: 'pipe',
      });

      // Generate map image (always needed as fallback or secondary)
      try {
        execSync(`node scripts/generate-nws-image.mjs "${story.storyKey}"`, {
          cwd: PROJECT_DIR,
          stdio: 'pipe',
        });
      } catch {
        console.log('    Map generation failed — will use fallback');
      }

      // Resolve real photo (with strict auto-publish gate)
      let heroMode = 'map-data'; // default to map
      try {
        execSync(`node scripts/resolve-nws-real-image.mjs "${story.storyKey}"`, {
          cwd: PROJECT_DIR,
          stdio: 'pipe',
        });
        // Check if the real photo passes the strict auto-publish gate
        const draftPath = join(PROJECT_DIR, 'data', 'drafts', `${story.storyKey}.json`);
        const draft = JSON.parse(await readFile(draftPath, 'utf8'));
        const realMetaPath = join(
          PROJECT_DIR,
          'data',
          'draft-images',
          `${draft.slug}-real.json`,
        );
        try {
          const realMeta = JSON.parse(await readFile(realMetaPath, 'utf8'));
          if (passesStrictPhotoGate(realMeta, story)) {
            heroMode = 'licensed-photo';
            photoHeroes++;
            console.log('    Hero: licensed photo (passed strict gate)');
          } else {
            mapFallbacks++;
            console.log('    Hero: map fallback (photo failed strict gate)');
          }
        } catch {
          mapFallbacks++;
          console.log('    Hero: map fallback (no real photo metadata)');
        }
      } catch {
        mapFallbacks++;
        console.log('    Hero: map fallback (photo resolution failed)');
      }

      // Publish the article
      const publishedSlug = await publishNewArticle(story, heroMode, registry);
      newPublished++;
      console.log(`    Published: /news/${publishedSlug}/`);
    } catch (err) {
      console.error(`    PUBLISH FAILED: ${story.storyKey} — ${err.message}`);
    }
  }

  // --- Step 12: Update registries ---
  console.log('\n--- Step 12: Update registries ---');
  // Shared published-stories registry is maintained by the newsroom publish/update paths.
  // Do not run the legacy full rebuild here because it can drop cross-desk metadata.
  // Rebuild image provenance
  try {
    execSync('node scripts/create-image-provenance.mjs', { cwd: PROJECT_DIR, stdio: 'pipe' });
    console.log('  Image provenance rebuilt.');
  } catch {
    console.log('  Image provenance rebuild skipped');
  }

  // --- Step 13: Run publishing validation ---
  console.log('\n--- Step 13: Run publishing validation ---');
  try {
    execSync('npm run validate:publishing', { cwd: PROJECT_DIR, stdio: 'pipe' });
    console.log('  Validation: PASS');
  } catch (err) {
    console.error('  Validation: FAIL — aborting before build/deploy');
    console.error(err.stdout?.toString()?.slice(0, 500));
    process.exit(1);
  }

  // --- Step 14: Run Astro production build ---
  console.log('\n--- Step 14: Run Astro production build ---');
  try {
    execSync('npm run build', { cwd: PROJECT_DIR, stdio: 'pipe' });
    console.log('  Build: PASS');
  } catch (err) {
    console.error('  Build: FAIL — aborting before deploy');
    console.error(err.stderr?.toString()?.slice(0, 500));
    process.exit(1);
  }

  // --- Check for no changes ---
  const totalChanges = newPublished + updatedCount + expiredCount + cancelledCount;
  if (totalChanges === 0) {
    console.log('\n========================================');
    console.log('NO CHANGES — deployment skipped.');
    console.log('========================================');
    printSummary(categories, 0, updatedCount, expiredCount, cancelledCount, 0, startTime);
    return;
  }

  // --- Summary ---
  console.log('');
  printSummary(categories, newPublished, updatedCount, expiredCount, cancelledCount, photoHeroes, startTime, mapFallbacks);
}

// ===========================================================================
// Helper functions
// ===========================================================================

/**
 * Strict auto-publish photo gate.
 * Only allows a licensed photo when there's deterministic metadata evidence
 * of exact-location relevance. Visual appearance alone is NOT sufficient.
 */
function passesStrictPhotoGate(realMeta, story) {
  if (!realMeta) return false;

  // Must have exact license (not vague)
  const license = realMeta.license || '';
  if (!license || /unknown|free image|probably|cc licensed$/i.test(license)) {
    return false;
  }
  if (!realMeta.licenseUrl) return false;
  if (!realMeta.creator) return false;
  if (!realMeta.sourcePageUrl) return false;
  if (!realMeta.originalImageUrl) return false;
  if (!realMeta.imageRelation) return false;

  // Must be exact-event or exact-location
  if (!['exact-event', 'exact-location'].includes(realMeta.imageRelation)) {
    return false;
  }

  // For exact-location: require strong metadata evidence
  if (realMeta.imageRelation === 'exact-location') {
    // The story's location/city/county must appear in the image metadata
    const storyLocation = story.areaDesc || '';
    const firstArea = storyLocation.split(';')[0].trim().toLowerCase();
    const imageText = [
      realMeta.caption,
      realMeta.alt,
      realMeta.description,
      realMeta.title,
    ].filter(Boolean).join(' ').toLowerCase();

    // Check if the first area (county/location) appears in image metadata
    const locationParts = firstArea.split(',').map((s) => s.trim());
    const countyName = locationParts[0] || '';
    const stateCode = locationParts[1] || '';

    // At least the county or state must appear in the image metadata
    if (countyName && !imageText.includes(countyName.toLowerCase())) {
      // Check if the story's state appears
      if (stateCode) {
        const stateName = stateCodeToName(stateCode);
        if (!stateName || !imageText.includes(stateName.toLowerCase())) {
          return false; // No location match in metadata
        }
      } else {
        return false;
      }
    }

    // Reject if image metadata mentions a different state/country
    // (contradictory location)
    // This is a conservative check — if we can't confirm, reject.
  }

  return true;
}

function stateCodeToName(code) {
  const map = {
    AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
    CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia',
    FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
    IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana',
    ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
    MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada',
    NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
    NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon',
    PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota',
    TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia',
    WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
    PR: 'Puerto Rico', HI: 'Hawaii',
  };
  return map[code] || null;
}

/**
 * Select new stories with diversity, respecting the cap.
 */
function selectNewStories(newStories, cap, registry) {
  if (cap <= 0 || newStories.length === 0) return [];

  // Sort by storyScore descending
  const sorted = [...newStories].sort((a, b) => b.storyScore - a.storyScore);

  // Apply geographic/event diversity: avoid publishing 3 alerts from the same
  // state or same event type if diverse alternatives exist.
  const selected = [];
  const usedStates = new Set();
  const usedEvents = new Set();

  for (const story of sorted) {
    if (selected.length >= cap) break;

    // Derive state from areaDesc
    const areaParts = (story.areaDesc || '').split(',')[0].trim();
    const stateMatch = (story.areaDesc || '').match(/,\s*([A-Z]{2})/);
    const state = stateMatch ? stateMatch[1] : areaParts;
    const event = story.event;

    // Prefer diversity: if we already have a story from this state+event combo,
    // skip unless we don't have enough diverse candidates
    const sameCombo = selected.filter(
      (s) => s._state === state && s._event === event,
    ).length;

    if (sameCombo >= 1 && selected.length < cap && sorted.length > selected.length + 2) {
      // Skip this one — we have enough diversity candidates
      continue;
    }

    story._state = state;
    story._event = event;
    selected.push(story);
  }

  // If we didn't fill the cap with diverse stories, fill from remaining
  if (selected.length < cap) {
    for (const story of sorted) {
      if (selected.length >= cap) break;
      if (!selected.includes(story)) {
        selected.push(story);
      }
    }
  }

  return selected.slice(0, cap);
}

/**
 * Process an UPDATE to an existing story.
 */
async function processUpdate(story, published, newAlertIds, registry) {
  // Update the registry entry
  published.updatedAt = new Date().toISOString();
  published.allAlertIds = [...new Set([...published.allAlertIds, ...newAlertIds])];
  published.currentAlertIds = story.alertIds;
  published.lastNwsEffectiveAt = story.effective || published.lastNwsEffectiveAt;
  published.lastNwsExpiresAt = story.expires || published.lastNwsExpiresAt;
  published.lastNwsEndsAt = story.ends || published.lastNwsEndsAt;
  published.lastCheckedAt = new Date().toISOString();

  // Note: Full article file regeneration would happen here in a complete
  // implementation. For Phase 6A, we update the registry and article frontmatter.
  const articlePath = join(PROJECT_DIR, published.articlePath);
  try {
    let content = await readFile(articlePath, 'utf8');
    // Update updatedAt in frontmatter
    if (content.includes('updatedAt:')) {
      content = content.replace(
        /^updatedAt:.*$/m,
        `updatedAt: ${published.updatedAt}`,
      );
    } else {
      // Add updatedAt after publishedAt
      content = content.replace(
        /^(publishedAt:.*$)/m,
        `$1\nupdatedAt: ${published.updatedAt}`,
      );
    }
    await writeFile(articlePath, content, 'utf8');
  } catch {
    // Article file may not exist — skip
  }

  // Save registry
  await writeFile(REGISTRY_FILE, JSON.stringify(registry, null, 2) + '\n', 'utf8');
}

/**
 * Process EXPIRATION of a story.
 */
async function processExpiration(published, registry) {
  published.lifecycleStatus = 'expired';
  published.breaking = false;
  published.lastCheckedAt = new Date().toISOString();

  // Update article frontmatter — set breaking to false
  const articlePath = join(PROJECT_DIR, published.articlePath);
  try {
    let content = await readFile(articlePath, 'utf8');
    content = content.replace(/^breaking:.*$/m, 'breaking: false');
    await writeFile(articlePath, content, 'utf8');
  } catch {
    // Article file may not exist
  }

  await writeFile(REGISTRY_FILE, JSON.stringify(registry, null, 2) + '\n', 'utf8');
}

/**
 * Process CANCELLATION of a story.
 */
async function processCancellation(published, registry) {
  published.lifecycleStatus = 'cancelled';
  published.breaking = false;
  published.lastCheckedAt = new Date().toISOString();

  const articlePath = join(PROJECT_DIR, published.articlePath);
  try {
    let content = await readFile(articlePath, 'utf8');
    content = content.replace(/^breaking:.*$/m, 'breaking: false');
    await writeFile(articlePath, content, 'utf8');
  } catch {}

  await writeFile(REGISTRY_FILE, JSON.stringify(registry, null, 2) + '\n', 'utf8');
}

/**
 * Publish a new article.
 */
async function publishNewArticle(story, heroMode, registry) {
  // Load the generated draft
  const draftPath = join(PROJECT_DIR, 'data', 'drafts', `${story.storyKey}.json`);
  const draft = JSON.parse(await readFile(draftPath, 'utf8'));
  const slug = draft.slug;

  // Copy hero image to public/images/
  const publicImagesDir = join(PROJECT_DIR, 'public', 'images');
  await mkdir(publicImagesDir, { recursive: true });

  let heroImagePath;
  let heroImageAlt = draft.image?.alt || `${story.event} for ${draft.location}`;
  let heroImageCaption = '';
  let heroImageCreator = 'US News Engine';
  let heroImageLicense = 'Original graphic generated by US News Engine from factual NWS data';
  let heroImageLicenseUrl = '';
  let realMeta = null;

  if (heroMode === 'licensed-photo') {
    const realPhotoPath = join(PROJECT_DIR, 'data', 'draft-images', `${slug}-real.jpg`);
    const publicPhotoPath = join(publicImagesDir, `${slug}-real.jpg`);
    const { copyFile } = await import('node:fs/promises');
    await copyFile(realPhotoPath, publicPhotoPath);
    heroImagePath = `/images/${slug}-real.jpg`;

    const realMetaPath = join(PROJECT_DIR, 'data', 'draft-images', `${slug}-real.json`);
    realMeta = JSON.parse(await readFile(realMetaPath, 'utf8'));
    heroImageAlt = realMeta.alt;
    heroImageCaption = realMeta.caption;
    heroImageCreator = realMeta.creator;
    heroImageLicense = realMeta.license;
    heroImageLicenseUrl = realMeta.licenseUrl;
  } else {
    const mapPath = join(PROJECT_DIR, 'data', 'draft-images', `${slug}-map.png`);
    const publicMapPath = join(publicImagesDir, `${slug}-map.png`);
    const { copyFile } = await import('node:fs/promises');
    await copyFile(mapPath, publicMapPath);
    heroImagePath = `/images/${slug}-map.png`;
    heroImageCaption = `National Weather Service alert area for ${draft.location}. Map: US News Engine using NWS geographic data.`;
  }

  // Build article markdown
  const now = new Date().toISOString();
  const stateMatch = (story.areaDesc || '').match(/,\s*([A-Z]{2})/);
  const state = stateMatch ? stateMatch[1] : undefined;
  const breaking = story.severity === 'Extreme' || story.urgency === 'Immediate';

  // Build body from draft sections
  const bodyMarkdown = draft.body
    .map((section) => {
      const heading = section.heading ? `\n## ${section.heading}\n` : '';
      const paras = section.paragraphs.join('\n\n');
      return heading + paras;
    })
    .join('\n\n');

  const tags = [story.event, 'Weather', story.severity].filter(Boolean);
  const articleContent = `---
slug: "${slug}"
title: "${draft.title.replace(/"/g, '\\"')}"
description: "${draft.description.replace(/"/g, '\\"')}"
category: weather
author: "US News Engine Weather Desk"
publishedAt: ${now}
image: "${heroImagePath}"
imageAlt: "${heroImageAlt.replace(/"/g, '\\"')}"
imageMode: "${heroMode}"
imageCaption: "${heroImageCaption.replace(/"/g, '\\"')}"
imageCreator: "${heroImageCreator.replace(/"/g, '\\"')}"
imageLicense: "${heroImageLicense.replace(/"/g, '\\"')}"
${heroImageLicenseUrl ? `imageLicenseUrl: "${heroImageLicenseUrl}"\n` : ''}sourceName: "National Weather Service"
sourceUrl: "${story.sourceUrl}"
sourceOffice: "${story.senderName || 'National Weather Service'}"
tags: [${tags.map((t) => `"${t}"`).join(', ')}]
${state ? `state: "${state}"\n` : ''}breaking: ${breaking}
featured: false
views: 0
---

${bodyMarkdown}
`;

  const articlePath = join(PROJECT_DIR, 'src', 'content', 'articles', `${slug}.md`);
  await writeFile(articlePath, articleContent, 'utf8');

  // Add to registry
  registry.stories.push({
    storyKey: story.storyKey,
    slug,
    articlePath: `src/content/articles/${slug}.md`,
    publishedAt: now,
    updatedAt: null,
    currentAlertIds: story.alertIds,
    allAlertIds: story.alertIds,
    event: story.event,
    location: draft.location,
    sourceOffice: story.senderName || 'National Weather Service',
    lifecycleStatus: 'active',
    lastNwsEffectiveAt: story.effective || null,
    lastNwsExpiresAt: story.expires || null,
    lastNwsEndsAt: story.ends || null,
    lastCheckedAt: now,
    heroImageMode: heroMode,
    heroImageSource: heroImagePath,
    heroImageRelation: heroMode === 'licensed-photo' ? 'exact-location' : 'current-alert-data',
    heroImageCreator,
    heroImageLicense,
    heroImageLicenseUrl,
    heroImageSourcePageUrl: heroMode === 'licensed-photo' ? (realMeta?.sourcePageUrl || story.sourceUrl || '') : '',
    breaking,
  });

  await writeFile(REGISTRY_FILE, JSON.stringify(registry, null, 2) + '\n', 'utf8');
  return slug;
}

/**
 * Print the run summary.
 */
function printSummary(categories, newPublished, updatedCount, expiredCount, cancelledCount, photoHeroes, startTime, mapFallbacks = 0) {
  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('\n========================================');
  console.log('US News Engine NWS Run Summary');
  console.log('========================================');
  console.log(`Fetched: ${categories.NEW.length + categories.UPDATED.length + categories.UNCHANGED.length + categories.EXPIRED.length + categories.CANCELLED.length} stories`);
  console.log('');
  console.log(`NEW FOUND: ${categories.NEW.length}`);
  console.log(`NEW PUBLISHED: ${newPublished}`);
  console.log(`UPDATED: ${updatedCount}`);
  console.log(`EXPIRED: ${expiredCount}`);
  console.log(`CANCELLED: ${cancelledCount}`);
  console.log(`UNCHANGED: ${categories.UNCHANGED.length}`);
  console.log('');
  console.log(`PHOTO HEROES: ${photoHeroes}`);
  console.log(`MAP FALLBACKS: ${mapFallbacks || newPublished - photoHeroes}`);
  console.log('');
  console.log(`Duration: ${duration}s`);
  console.log('========================================');
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
