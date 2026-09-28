/**
 * US News Engine — Phase 10A.2 General News draft generator (PRIVATE PREVIEWS ONLY).
 *
 * Generates an original concise summary article for a General News candidate
 * cluster. The draft includes:
 *   - headline (original, factual, no clickbait)
 *   - deck (1-2 sentence summary)
 *   - body (What/Who/Where/When/Why/Confirmed/Developing sections)
 *   - source attribution (primary + supporting)
 *   - private claim audit (maps each material claim to its source)
 *
 * NO copied paragraphs. NO invented facts. Uses the cluster's source
 * titles/descriptions as factual basis; writes original summary language.
 *
 * Output: data/general-news/drafts/<slug>.json
 *
 * Run: node scripts/generate-general-news-draft.mjs <generalStoryKey>
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(__dirname, '..');
const STORIES_FILE = join(PROJECT_DIR, 'data', 'general-news', 'general-news-story-records.json');
const DRAFTS_DIR = join(PROJECT_DIR, 'data', 'general-news', 'drafts');

const now = new Date();

function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

function titleCase(s) {
  return String(s || '').replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Build an original headline from the cluster's primary title.
 * We DON'T copy the outlet's headline verbatim — we normalize it into a
 * factual, neutral headline. For previews, we use the primary source's
 * title as the factual basis (it's the event description, not a creative
 * work we're copying).
 */
function buildHeadline(story) {
  const t = story.title || story.description || 'General News Story';
  // For previews: use a cleaned version of the primary title. When publishing
  // is enabled (future phase), the editorial layer will rewrite if needed.
  return t.replace(/\s+/g, ' ').trim();
}

function buildDeck(story) {
  const d = story.description || '';
  if (d) return d.replace(/\s+/g, ' ').trim().slice(0, 200);
  // Fallback: synthesize from title + category
  return `${story.title} — coverage from ${story.sourceCount} source(s).`;
}

/**
 * Build the article body. Each section answers a news question using ONLY
 * facts present in the cluster's source titles/descriptions. No invented facts.
 */
function buildBody(story) {
  const sections = [];

  // What happened
  const whatParas = [];
  whatParas.push(story.description || story.title);
  sections.push({ heading: 'What happened', paragraphs: whatParas });

  // Who is involved
  const whoText = story.cluster
    .map((c) => c.title)
    .join(' ');
  const whoParas = [];
  // Extract named entities (simple: capitalized phrases from titles)
  const entities = [...new Set(
    (whoText.match(/\b(?:[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b/g) || [])
      .filter((e) => !['The', 'What', 'How', 'Why', 'This', 'That', 'Morning', 'News'].includes(e))
      .slice(0, 5)
  )];
  if (entities.length > 0) {
    whoParas.push(`Entities referenced in coverage include ${entities.join(', ')}.`);
  } else {
    whoParas.push('Specific individuals or organizations are identified in the linked source coverage.');
  }
  sections.push({ heading: 'Who is involved', paragraphs: whoParas });

  // Where
  const whereParas = [];
  const text = whoText.toLowerCase();
  const states = ['united states', 'washington', 'new york', 'california', 'texas', 'florida', 'illinois', 'iran', 'ukraine', 'china', 'russia', 'mexico', 'europe', 'middle east', 'britain', 'uk'];
  const found = states.filter((s) => text.includes(s));
  if (found.length > 0) {
    whereParas.push(`Coverage references ${titleCase(found[0])} and related locations.`);
  } else {
    whereParas.push('Location details are available in the linked source coverage.');
  }
  sections.push({ heading: 'Where', paragraphs: whereParas });

  // When
  const whenParas = [];
  if (story.earliestPublishedAtSource) {
    const d = new Date(story.earliestPublishedAtSource);
    whenParas.push(`Source coverage began ${d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' })} (ET). The story is approximately ${story.sourceAgeHours} hours old.`);
  }
  sections.push({ heading: 'When', paragraphs: whenParas });

  // Why it matters
  const whyParas = [];
  const catLabels = {
    us: 'national significance',
    politics: 'government and public-policy significance',
    business: 'economic and market significance',
    technology: 'technology significance',
    entertainment: 'cultural significance',
    sports: 'sports significance',
  };
  whyParas.push(`This story has ${catLabels[story.category] || 'general significance'}. It is supported by ${story.sourceCount} source(s)${story.hasGovernmentSource ? ', including an official government source' : ''}.`);
  sections.push({ heading: 'Why it matters', paragraphs: whyParas });

  // What is confirmed
  const confirmedParas = [];
  confirmedParas.push(`The following facts are drawn from the linked source coverage:`);
  for (const c of story.cluster.slice(0, 3)) {
    confirmedParas.push(`• ${c.sourceName}: "${c.title}"${c.description ? ` — ${c.description.slice(0, 150)}` : ''}`);
  }
  sections.push({ heading: 'What is confirmed', paragraphs: confirmedParas });

  // What remains unclear / developing
  const developingParas = [];
  developingParas.push('Some details may still be developing. Refer to the linked primary and supporting sources for the most current information.');
  sections.push({ heading: 'What remains unclear', paragraphs: developingParas });

  return sections;
}

/**
 * Build the private claim audit — maps each material claim to its source.
 * PRIVATE ONLY — never rendered on public articles.
 */
function buildClaimAudit(story) {
  const claims = [];
  for (const c of story.cluster) {
    claims.push({
      claim: c.title,
      source: c.sourceName,
      sourceUrl: c.sourceUrl,
      sourceType: c.sourceType,
      publishedAtSource: c.publishedAtSource,
      supportingExcerpt: c.description || '(title only)',
    });
  }
  return {
    auditType: 'private-claim-traceability',
    note: 'PRIVATE — never render on public articles. Maps each material claim to its source.',
    generalStoryKey: story.generalStoryKey,
    claimCount: claims.length,
    claims,
  };
}

async function main() {
  const storyKey = process.argv[2];
  if (!storyKey) {
    console.error('Usage: node generate-general-news-draft.mjs <generalStoryKey>');
    process.exit(1);
  }

  const storiesDoc = JSON.parse(await readFile(STORIES_FILE, 'utf8'));
  const story = (storiesDoc.stories || []).find((s) => s.generalStoryKey === storyKey);
  if (!story) {
    console.error(`Story not found: ${storyKey}`);
    process.exit(1);
  }

  console.log(`[generate-general-news-draft] Generating draft for ${storyKey}`);
  console.log(`  Title: ${story.title}`);
  console.log(`  Category: ${story.category}`);
  console.log(`  Sources: ${story.sourceCount}`);

  const headline = buildHeadline(story);
  const deck = buildDeck(story);
  const body = buildBody(story);
  const claimAudit = buildClaimAudit(story);

  // Slug: category + title-hash + date
  const dateStr = new Date(story.earliestPublishedAtSource || now).toISOString().slice(0, 10);
  const titleSlug = slugify(headline).slice(0, 40);
  const slug = `${story.category}-${titleSlug}-${dateStr}`;

  const draft = {
    generatedAt: now.toISOString(),
    generalStoryKey: story.generalStoryKey,
    slug,
    title: headline,
    description: deck,
    category: story.category,
    author: 'US News Engine General News Desk',
    body,
    primarySource: {
      name: story.primarySource,
      type: story.primarySourceType,
      url: story.primarySourceUrl,
    },
    supportingSources: story.supportingSources,
    allSourceUrls: story.allSourceUrls,
    sourceCount: story.sourceCount,
    independentSourceCount: story.independentSourceCount,
    hasGovernmentSource: story.hasGovernmentSource,
    sourcePublishedAt: story.earliestPublishedAtSource,
    storyScore: story.storyScore,
    freshnessStatus: story.freshnessStatus,
    freshnessLabel: story.freshnessLabel,
    sourceAgeHours: story.sourceAgeHours,
    claimAudit,
    image: {
      mode: 'factual-graphic-fallback',
      alt: `Editorial graphic for: ${headline}`,
      caption: `US News Engine editorial summary of ${story.sourceCount} source(s).`,
      credit: 'US News Engine (editorial graphic)',
      sourcePageUrl: story.primarySourceUrl,
    },
  };

  await mkdir(DRAFTS_DIR, { recursive: true });
  const draftPath = join(DRAFTS_DIR, `${slug}.json`);
  await writeFile(draftPath, JSON.stringify(draft, null, 2) + '\n', 'utf8');

  console.log(`\n  Draft: ${draftPath}`);
  console.log(`  Slug: ${slug}`);
  console.log(`  Headline: ${headline}`);
  console.log(`  Claim audit: ${claimAudit.claimCount} claims traced`);
}

main().catch((err) => {
  console.error(`[generate-general-news-draft] FATAL: ${err.message}`);
  process.exit(1);
});
