/**
 * US News Engine — Phase 10A.2 General News filter + cluster + score + story builder.
 *
 * Reads the raw feed (data/general-news/general-news-feed.json), deduplicates
 * same-event coverage into ONE candidate cluster, scores newsworthiness, and
 * writes story records (data/general-news/general-news-story-records.json).
 *
 * Clustering uses deterministic signals: normalized headline tokens, named
 * entities, shared source links, and time proximity. Multiple outlets
 * covering the same event become ONE candidate with a primarySource +
 * supportingSources[].
 *
 * Freshness model (spec §5):
 *   0–3h: very high | 3–8h: high | 8–18h: normal | 18–36h: publish-if-important | >36h: reject
 *
 * Run: node scripts/build-general-news-stories.mjs
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(__dirname, '..');
const INPUT_FILE = join(PROJECT_DIR, 'data', 'general-news', 'general-news-feed.json');
const OUTPUT_FILE = join(PROJECT_DIR, 'data', 'general-news', 'general-news-story-records.json');

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

// ===========================================================================
// Helpers
// ===========================================================================

function loadJsonOptional(path) {
  return readFile(path, 'utf8').then((raw) => ({ ok: true, doc: JSON.parse(raw) })).catch((err) => {
    if (err && err.code === 'ENOENT') return { ok: false, reason: 'missing' };
    return { ok: false, reason: String(err) };
  });
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by',
  'from', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do',
  'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'must', 'can', 'this',
  'that', 'these', 'those', 'i', 'you', 'he', 'she', 'it', 'we', 'they', 'what', 'which',
  'who', 'when', 'where', 'why', 'how', 'all', 'each', 'every', 'both', 'few', 'more',
  'most', 'other', 'some', 'such', 'no', 'not', 'only', 'own', 'same', 'so', 'than', 'too',
  'very', 's', 't', 'just', 'don', 'now', 'as', 'into', 'over', 'after', 'up', 'out', 'if',
  'about', 'against', 'between', 'through', 'during', 'before', 'after', 'above', 'below',
  'off', 'down', 'under', 'again', 'further', 'once', 'here', 'there', 'said', 'says',
  'new', 'one', 'two', 'us', 'report', 'reports', 'according',
]);

function tokenize(text) {
  if (!text) return [];
  return String(text).toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

function signatureTokens(title, description) {
  const tokens = [...new Set([...tokenize(title), ...tokenize(description)])];
  return tokens.sort().slice(0, 20); // top 20 unique tokens
}

function tokenJaccard(a, b) {
  if (a.length === 0 || b.length === 0) return 0;
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}

function normalizeUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}`.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Classify a story's category. Prefers the item's detected category; falls
 * back to the feed's default category.
 */
function classifyCategory(title, description, itemCategory) {
  const t = `${title || ''} ${description || ''}`.toLowerCase();
  if (/\b(senate|congress|house of representatives|legislat|senator|representative|governor|election|primary|ballot|campaign|policy|federal|administration|executive order|bill |amendment|supreme court|court ruling|department of|agency)\b/i.test(t)) return 'politics';
  if (/\b(stock|market|economy|economic|earnings|fed |federal reserve|inflation|interest rate|tariff|trade|gdp|recession|wall street|s&p|nasdaq|dow jones|bankruptcy|merger|acquisition|ipo|crypto|bitcoin)\b/i.test(t)) return 'business';
  if (/\b(tech|technology|ai |artificial intelligence|software|apple|google|microsoft|amazon|meta |facebook|tesla|openai|cyber|hack|data breach|internet|smartphone|chip|semiconductor|startup)\b/i.test(t)) return 'technology';
  if (/\b(movie|film|hollywood|actor|actress|music|album|concert|celebrity|streaming|netflix|disney|spotify|award|emmy|grammy|oscar|box office|tv show|television)\b/i.test(t)) return 'entertainment';
  if (/\b(nfl|nba|mlb|nhl|soccer|football|basketball|baseball|hockey|tennis|golf|olympic|championship|playoff|super bowl|world series|tournament|coach|athlete)\b/i.test(t)) return 'sports';
  return itemCategory || 'us';
}

function freshnessStatus(ageMs) {
  const hours = ageMs / HOUR_MS;
  if (hours <= 3) return { status: 'very-high', rank: 0, label: 'very high freshness' };
  if (hours <= 8) return { status: 'high', rank: 1, label: 'high freshness' };
  if (hours <= 18) return { status: 'normal', rank: 2, label: 'normal freshness' };
  if (hours <= 36) return { status: 'publish-if-important', rank: 3, label: 'still important/developing' };
  return { status: 'stale', rank: 4, label: 'older than 36 hours — reject' };
}

// ===========================================================================
// Phase 10A.2.1 — U.S. relevance scoring
// ===========================================================================
// US News Engine is primarily a UNITED STATES news website. Every candidate
// receives a usRelevance score: high / medium / low / none.
//
// Automatic/public eligibility requires `high` OR `medium` with a clear
// documented U.S. connection. Ordinary foreign stories with no meaningful
// U.S. impact are rejected (usRelevance=none → publishEligible=false).

// Strong U.S. signals — any match → usRelevance=high
const US_HIGH_SIGNALS = [
  /\bunited states\b/i, /\bu\.s\.\b/i, /\bamerican\b/i, /\bwashington\b/i,
  /\bwhite house\b/i, /\bcongress\b/i, /\bsenate\b/i, /\bhouse of representatives\b/i,
  /\bsupreme court\b/i, /\bdepartment of\b/i, /\bfederal\b/i, /\bpresident (?:trump|biden|harris)\b/i,
  /\bU\.S\. (?:military|troops|forces|officials|government|embassy|citizens|personnel)\b/i,
  /\bamerican (?:troops|soldiers|citizens|officials|companies|workers|consumers)\b/i,
  /\b(?:new york|los angeles|chicago|houston|phoenix|philadelphia|san antonio|san diego|dallas|san jose|austin|jacksonville|fort worth|columbus|charlotte|san francisco|indianapolis|seattle|denver|washington dc|boston|el paso|nashville|detroit|oklahoma city|portland|las vegas|memphis|louisville|baltimore|milwaukee|albuquerque|tucson|fresno|sacramento|kansas city|mesa|atlanta|omaha|colorado springs|raleigh|miami|long beach|virginia beach|oakland|minneapolis|tulsa|arlington|tampa|new orleans)\b/i,
];

// Medium U.S. signals — match → usRelevance=medium (needs documented connection)
const US_MEDIUM_SIGNALS = [
  /\b(?:trump|biden|harris|congressional|senator|representative|governor|secretary of state|attorney general)\b/i,
  /\b(?:wall street|new york stock exchange|nasdaq|dow jones|s&p|federal reserve|treasury|sec |ftc |fda )\b/i,
  /\b(?:nfl|nba|mlb|nhl|super bowl|world series|nba finals|stanley cup)\b/i,
  /\b(?:california|texas|florida|new york|illinois|pennsylvania|ohio|georgia|michigan|north carolina|virginia|washington|arizona|massachusetts|tennessee|indiana|missouri|maryland|wisconsin|minnesota|colorado|oregon|kentucky|oklahoma|connecticut|utah|iowa|nevada|arkansas|mississippi|kansas|new mexico|nebraska|idaho|hawaii|new hampshire|maine|montana|rhode island|delaware|south dakota|north dakota|alaska|vermont|wyoming|west virginia|alabama|louisiana|south carolina)\b/i,
  /\b(?:usdm|usd|dollar|us economy|us markets|us jobs|us inflation|us trade|us tariff|us policy|us military|us nato|us allies)\b/i,
];

// Foreign-location signals — if present AND no U.S. signal → usRelevance=low/none
const FOREIGN_SIGNALS = [
  /\b(?:madrid|spain|spanish|paris|france|french|berlin|germany|german|london|britain|british|uk |u\.k\.|england|english|rome|italy|italian|moscow|russia|russian|beijing|china|chinese|tokyo|japan|japanese|seoul|south korea|korean|tehran|iran|iranian|kyiv|ukraine|ukrainian|tel aviv|israel|israeli|gaza|palestin|beirut|lebanon|lebanese|damascus|syria|syrian|kabul|afghanistan|afghan|baghdad|iraq|iraqi|riyadh|saudi arabia|saudi|dubai|uae |egypt|egyptian|nairobi|kenya|kenyan|lagos|nigeria|nigerian|mumbai|india|indian|jakarta|indonesia|indonesian|manila|philippines|filipino|bangkok|thailand|thai|vietnam|vietnamese|singapore|malaysia|malaysian|australia|australian|new zealand|canada|canadian|mexico|mexican|brazil|brazilian|argentina|argentine|chile|chilean|colombia|colombian|peru|peruvian|venezuela|venezuelan)\b/i,
];

function assessUsRelevance(cluster) {
  const text = cluster.map((r) => `${r.title} ${r.description || ''}`).join(' ').toLowerCase();
  const fullText = text;

  // Check for U.S. HIGH signals
  const hasHigh = US_HIGH_SIGNALS.some((re) => re.test(fullText));
  if (hasHigh) {
    // But if it's primarily a foreign story with only incidental U.S. mention,
    // check the ratio. If foreign signals dominate, downgrade.
    const foreignCount = FOREIGN_SIGNALS.filter((re) => re.test(fullText)).length;
    if (foreignCount >= 3) {
      return { usRelevance: 'medium', reason: 'U.S. signal present but foreign context dominates' };
    }
    return { usRelevance: 'high', reason: 'direct U.S. subject/named entity' };
  }

  // Check for U.S. MEDIUM signals
  const hasMedium = US_MEDIUM_SIGNALS.some((re) => re.test(fullText));
  if (hasMedium) {
    return { usRelevance: 'medium', reason: 'U.S. connection via government/markets/geography' };
  }

  // No U.S. signals — check if it's a foreign story
  const isForeign = FOREIGN_SIGNALS.some((re) => re.test(fullText));
  if (isForeign) {
    return { usRelevance: 'none', reason: 'foreign story with no meaningful U.S. impact' };
  }

  // No U.S. or foreign signal — low relevance by default
  return { usRelevance: 'low', reason: 'no clear U.S. connection identified' };
}

// ===========================================================================
// Clustering — union-find by token similarity + shared URLs + time proximity
// ===========================================================================

function clusterCandidates(records, now) {
  // Only cluster records with a valid publishedAtSource and title.
  const items = records.filter((r) => r && r.title && r.publishedAtSource);
  const parent = new Map();
  function find(x) { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; }
  function union(a, b) { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); }
  for (let i = 0; i < items.length; i++) parent.set(i, i);

  // Precompute signatures
  const sigs = items.map((it) => ({
    tokens: signatureTokens(it.title, it.description),
    url: normalizeUrl(it.sourceUrl),
    time: new Date(it.publishedAtSource).getTime(),
    source: it.sourceName,
  }));

  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = sigs[i];
      const b = sigs[j];
      // Same outlet — don't cluster (an outlet shouldn't cluster with itself)
      // unless it's clearly a re-issue (same URL).
      let sameEvent = false;
      // 1. Shared normalized URL
      if (a.url && b.url && a.url === b.url) sameEvent = true;
      // 2. High token similarity (Jaccard >= 0.55) + within 18h
      const sim = tokenJaccard(a.tokens, b.tokens);
      const timeDiff = Math.abs(a.time - b.time);
      if (sim >= 0.55 && timeDiff <= 18 * HOUR_MS) sameEvent = true;
      // 3. Very high similarity (>= 0.75) + within 36h
      if (sim >= 0.75 && timeDiff <= 36 * HOUR_MS) sameEvent = true;
      if (sameEvent) union(i, j);
    }
  }

  const groups = new Map();
  for (let i = 0; i < items.length; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(items[i]);
  }
  return Array.from(groups.values());
}

// ===========================================================================
// Newsworthiness score (0-100)
// ===========================================================================

function scoreCluster(cluster, now) {
  let score = 0;
  const ages = cluster.map((r) => now - new Date(r.publishedAtSource).getTime());
  const minAge = Math.min(...ages);
  const fresh = freshnessStatus(minAge);
  // Freshness: very-high=28, high=22, normal=15, publish-if-important=8, stale=0
  const freshScore = { 'very-high': 28, 'high': 22, 'normal': 15, 'publish-if-important': 8, 'stale': 0 }[fresh.status] || 0;
  score += freshScore;

  // Number of independent sources (cap at 4)
  const sourceNames = new Set(cluster.map((r) => r.sourceName));
  const sourceCount = Math.min(4, sourceNames.size);
  score += sourceCount * 7; // up to 28

  // Government primary source bonus
  const hasGov = cluster.some((r) => r.sourceType === 'government');
  if (hasGov) score += 6;

  // Category significance (national relevance)
  const primary = pickPrimary(cluster);
  const category = primary.category || 'us';
  const catBonus = { us: 10, politics: 8, business: 6, technology: 6, entertainment: 4, sports: 4 }[category] || 5;
  score += catBonus;

  // Public-safety / economic significance keywords
  const text = cluster.map((r) => `${r.title} ${r.description}`).join(' ').toLowerCase();
  if (/\b(recall|safety|hazard|injury|death|outbreak|emergency|disaster|evacuat|warning|alert|crisis)\b/.test(text)) score += 5;
  if (/\b(economy|jobs|inflation|gdp|market|trade|tariff|fed |interest rate)\b/.test(text)) score += 4;

  // Reject signals: SEO spam / affiliate / sponsored / opinion
  if (/\b(sponsored|advertorial|affiliate|best deals|buy now|click here|sponsored content|paid content|opinion|editorial|letter to the editor)\b/i.test(text)) {
    score = Math.min(score, 10); // hard penalty
  }

  return Math.max(0, Math.min(100, Math.round(score)));
}

function pickPrimary(cluster) {
  // Prefer government source; otherwise the most complete (longest description).
  const gov = cluster.find((r) => r.sourceType === 'government');
  if (gov) return gov;
  return [...cluster].sort((a, b) => (b.description || '').length - (a.description || '').length)[0] || cluster[0];
}

// ===========================================================================
// Main
// ===========================================================================

async function main() {
  console.log('[build-general-news-stories] Starting General News clustering + scoring.');
  const now = new Date();
  console.log(`  Build time (UTC): ${now.toISOString()}`);

  const feedRes = await loadJsonOptional(INPUT_FILE);
  if (!feedRes.ok) { console.error('  Feed missing. Run fetch-general-news first.'); process.exit(1); }
  const feed = feedRes.doc;
  const allRecords = [];
  for (const src of (feed.sources || [])) {
    for (const r of (src.records || [])) allRecords.push(r);
  }
  console.log(`  Input records: ${allRecords.length}`);

  // Reject stale (>36h) items early — they won't be publishEligible.
  const freshRecords = allRecords.filter((r) => {
    if (!r.publishedAtSource) return false;
    const age = now - new Date(r.publishedAtSource).getTime();
    return age <= 36 * HOUR_MS;
  });
  console.log(`  Fresh (<=36h): ${freshRecords.length}`);
  console.log(`  Rejected (>36h): ${allRecords.length - freshRecords.length}`);

  // Cluster
  const clusters = clusterCandidates(freshRecords, now);
  console.log(`  Clusters: ${clusters.length}`);

  // Build story records
  const stories = [];
  let foreignRejected = 0;
  for (const cluster of clusters) {
    const primary = pickPrimary(cluster);
    const category = classifyCategory(primary.title, primary.description, primary.category || primary.sourceCategory);
    const supportingSources = cluster
      .filter((r) => r !== primary)
      .map((r) => ({ sourceName: r.sourceName, sourceUrl: r.sourceUrl, sourceType: r.sourceType, publisherFamily: r.publisherFamily || null }));
    const allSourceUrls = [...new Set(cluster.map((r) => r.sourceUrl).filter(Boolean))];
    const ages = cluster.map((r) => now - new Date(r.publishedAtSource).getTime());
    const minAge = Math.min(...ages);
    const fresh = freshnessStatus(minAge);
    const score = scoreCluster(cluster, now);
    const primaryPublishedAt = primary.publishedAtSource;
    const memberKeys = cluster.map((r) => `${r.sourceName}::${r.sourceUrl}::${r.title}`).sort();
    const storyKey = `gn__${createHash('sha256').update(memberKeys.join('|||'), 'utf8').digest('hex').slice(0, 16)}`;

    // Phase 10A.2.1 — U.S. relevance assessment
    const usRel = assessUsRelevance(cluster);

    // Phase 10A.2.1 — publisher-family deduplication
    // sourceCount = total records in cluster (may include multiple feeds from same publisher)
    // independentPublisherCount = unique publisher families (NPR News + NPR Politics = 1 family)
    const publisherFamilies = [...new Set(cluster.map((r) => r.publisherFamily || r.sourceName).filter(Boolean))];
    const independentPublisherCount = publisherFamilies.length;

    // publishEligible requires: score >= 30, fresh, AND usRelevance high/medium
    const usEligible = usRel.usRelevance === 'high' || usRel.usRelevance === 'medium';
    const publishEligible = score >= 30 && fresh.status !== 'stale' && usEligible;

    if (usRel.usRelevance === 'none') foreignRejected++;

    stories.push({
      generalStoryKey: storyKey,
      primarySource: primary.sourceName,
      primarySourceType: primary.sourceType,
      primarySourceUrl: primary.sourceUrl,
      primaryPublisherFamily: primary.publisherFamily || null,
      supportingSources,
      allSourceUrls,
      publisherFamilies,
      title: primary.title,
      description: primary.description,
      category,
      usRelevance: usRel.usRelevance,
      usRelevanceReason: usRel.reason,
      publishedAtSource: primaryPublishedAt,
      earliestPublishedAtSource: cluster
        .map((r) => r.publishedAtSource)
        .filter(Boolean)
        .sort()[0] || primaryPublishedAt,
      sourceCount: cluster.length,
      independentSourceCount: new Set(cluster.map((r) => r.sourceName)).size,
      independentPublisherCount,
      hasGovernmentSource: cluster.some((r) => r.sourceType === 'government'),
      storyScore: score,
      publishEligible,
      publishEligibleReason: !usEligible ? `usRelevance=${usRel.usRelevance} (${usRel.reason})` : (score < 30 ? `score ${score} below 30 threshold` : (fresh.status === 'stale' ? 'stale (>36h)' : 'eligible')),
      freshnessStatus: fresh.status,
      freshnessLabel: fresh.label,
      sourceAgeHours: Math.round(minAge / HOUR_MS),
      cluster: cluster.map((r) => ({
        sourceName: r.sourceName,
        sourceType: r.sourceType,
        publisherFamily: r.publisherFamily || null,
        sourceUrl: r.sourceUrl,
        title: r.title,
        description: (r.description || '').slice(0, 200),
        publishedAtSource: r.publishedAtSource,
      })),
    });
  }

  // Sort: publishEligible first, then score desc, then freshness rank, then newest
  const FRESH_RANK = { 'very-high': 0, 'high': 1, 'normal': 2, 'publish-if-important': 3, 'stale': 4 };
  stories.sort((a, b) => {
    if (a.publishEligible !== b.publishEligible) return b.publishEligible ? 1 : -1;
    if (b.storyScore !== a.storyScore) return b.storyScore - a.storyScore;
    const fa = FRESH_RANK[a.freshnessStatus] ?? 5;
    const fb = FRESH_RANK[b.freshnessStatus] ?? 5;
    if (fa !== fb) return fa - fb;
    const ta = a.earliestPublishedAtSource ? new Date(a.earliestPublishedAtSource).getTime() : 0;
    const tb = b.earliestPublishedAtSource ? new Date(b.earliestPublishedAtSource).getTime() : 0;
    return tb - ta;
  });

  const usRelevantClusters = stories.filter((s) => s.usRelevance === 'high' || s.usRelevance === 'medium').length;
  const output = {
    generatedAt: now.toISOString(),
    source: 'Phase 10A.2.1 General News story records',
    inputRecordCount: allRecords.length,
    freshRecordCount: freshRecords.length,
    clusterCount: clusters.length,
    usRelevantClusterCount: usRelevantClusters,
    foreignRejectedCount: foreignRejected,
    publishEligibleCount: stories.filter((s) => s.publishEligible).length,
    publisherFamiliesSeen: [...new Set(stories.flatMap((s) => s.publisherFamilies))].sort(),
    stories,
  };

  await mkdir(dirname(OUTPUT_FILE), { recursive: true });
  const tmp = `${OUTPUT_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(output, null, 2) + '\n', 'utf8');
  await rename(tmp, OUTPUT_FILE);

  console.log(`\n  Total clusters:           ${clusters.length}`);
  console.log(`  U.S.-relevant clusters:   ${usRelevantClusters}`);
  console.log(`  Foreign rejected (none):  ${foreignRejected}`);
  console.log(`  publishEligible:          ${output.publishEligibleCount}`);
  console.log(`  Publisher families seen:  ${output.publisherFamiliesSeen.join(', ')}`);
  console.log(`  Output: ${OUTPUT_FILE}`);

  // Category distribution
  const byCat = {};
  for (const s of stories.filter((s) => s.publishEligible)) {
    byCat[s.category] = (byCat[s.category] || 0) + 1;
  }
  console.log('\n  Eligible by category:');
  for (const cat of ['us', 'politics', 'business', 'technology', 'entertainment', 'sports']) {
    console.log(`    ${cat.padEnd(14)} ${byCat[cat] || 0}`);
  }

  // Top 20 candidates summary
  console.log('\n  Top 20 candidates:');
  stories.slice(0, 20).forEach((s, i) => {
    const title = (s.title || '(no title)').slice(0, 60);
    console.log(`    ${String(i + 1).padStart(2)}. [${s.category}/us=${s.usRelevance}/${s.freshnessStatus}] score=${s.storyScore} pub=${s.independentPublisherCount} ${title}`);
  });
}

main().catch((err) => {
  console.error(`[build-general-news-stories] FATAL: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
