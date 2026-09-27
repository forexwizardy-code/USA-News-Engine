/**
 * US News Engine — Recall story clustering + tightened newsworthiness (Phase 7B).
 *
 * Reads data/recalls/recall-news-candidates.json (or fetches raw), applies a
 * TIGHTENED newsworthiness filter, clusters related records into consumer-facing
 * stories, re-scores each cluster, and writes:
 *   data/recalls/recall-story-clusters.json
 *
 * Clustering groups FDA records that are part of the same recall action
 * (same firm, same date, same product family, same hazard) into one story.
 * CPSC records are typically already one-per-recall.
 *
 * Run:
 *   npm run cluster:recalls
 *   (or) node scripts/cluster-recall-stories.mjs
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(__dirname, '..');
const INPUT_FILE = join(PROJECT_DIR, 'data', 'recalls', 'recall-news-candidates.json');
const OUTPUT_FILE = join(PROJECT_DIR, 'data', 'recalls', 'recall-story-clusters.json');

// ===========================================================================
// Tightened newsworthiness filter
// ===========================================================================

const HIGH_HAZARD_KEYWORDS = [
  'fire', 'burn', 'explosion', 'electrocution', 'shock', 'poisoning', 'poison',
  'suffocation', 'strangulation', 'choking', 'laceration', 'amputation',
  'tip-over', 'fall', 'carbon monoxide', 'lead', 'salmonella', 'listeria',
  'e. coli', 'botulism', 'undeclared allergen', 'undeclared peanut',
  'undeclared milk', 'undeclared egg', 'undeclared soy', 'undeclared wheat',
  'contamination', 'foreign material', 'glass', 'metal', 'plastic',
];

const MEDIUM_HAZARD_KEYWORDS = [
  'failure', 'malfunction', 'defect', 'break', 'detach', 'crack',
  'mislabeled', 'mislabel', 'incorrect labeling',
];

/**
 * Determine if a recall passes the tightened newsworthiness filter.
 * Returns { pass: boolean, priority: 'high'|'medium'|'low', reason: string }
 */
function evaluateNewsworthiness(record) {
  const hazardText = `${record.hazard || ''} ${record.reason || ''} ${record.title || ''}`.toLowerCase();
  const distText = (record.distribution || '').toLowerCase();

  // HIGH priority signals
  if (record.deaths && parseInt(record.deaths) > 0) {
    return { pass: true, priority: 'high', reason: 'Deaths reported' };
  }
  if (record.injuries && parseInt(String(record.injuries).replace(/\D/g, '')) > 0) {
    return { pass: true, priority: 'high', reason: 'Injuries reported' };
  }

  // FDA Class I
  if (record.classification === 'Class I') {
    return { pass: true, priority: 'high', reason: 'FDA Class I recall' };
  }

  // High-severity hazards
  for (const kw of HIGH_HAZARD_KEYWORDS) {
    if (hazardText.includes(kw)) {
      return { pass: true, priority: 'high', reason: `High-severity hazard: ${kw}` };
    }
  }

  // Nationwide or wide distribution (10+ states)
  if (distText.includes('nationwide') || distText.includes('us nationwide')) {
    // Only medium if no high-severity hazard — nationwide alone is medium
    return { pass: true, priority: 'medium', reason: 'Nationwide distribution' };
  }
  const stateMatches = distText.match(/\b[A-Z]{2}\b/g);
  if (stateMatches && stateMatches.length >= 10) {
    return { pass: true, priority: 'medium', reason: `Distribution in ${stateMatches.length}+ states` };
  }

  // Large unit count
  const unitsStr = String(record.units || '');
  const unitNum = parseInt(unitsStr.replace(/\D/g, ''));
  if (unitNum && unitNum >= 50000) {
    return { pass: true, priority: 'medium', reason: `Large unit count: ${unitNum.toLocaleString()}` };
  }

  // Medium hazards (only pass if also has some distribution)
  for (const kw of MEDIUM_HAZARD_KEYWORDS) {
    if (hazardText.includes(kw) && (distText.includes('nationwide') || (stateMatches && stateMatches.length >= 5))) {
      return { pass: true, priority: 'medium', reason: `Hazard with wide distribution: ${kw}` };
    }
  }

  // Exclude: administrative, labeling-only, narrow
  if (hazardText.includes('labeling correction') || hazardText.includes('administrative')) {
    return { pass: false, priority: 'low', reason: 'Administrative/labeling only' };
  }

  // Default: exclude (too low value for consumer news)
  return { pass: false, priority: 'low', reason: 'Below newsworthiness threshold' };
}

// ===========================================================================
// Clustering logic
// ===========================================================================

/**
 * Create a deterministic cluster key for a recall record.
 * Records with the same cluster key belong to the same consumer-facing story.
 *
 * Signals:
 * - Same source agency
 * - Same recalling firm/manufacturer (normalized)
 * - Same recall date window (±3 days)
 * - Same product family (first 40 chars of normalized product description)
 * - Same hazard/reason (normalized keyword)
 */
function createClusterKey(record) {
  const firm = normalizeFirm(record.recallingFirm || record.manufacturer || '');
  const date = record.recallDate || record.reportDate || '';
  const dateWindow = date ? date.slice(0, 10) : 'unknown'; // group by same date

  // Product family: extract a short normalized product identifier
  const product = normalizeProduct(record.productName || record.title || '');
  const productFamily = product.slice(0, 40);

  // Hazard family: extract the primary hazard keyword
  const hazard = normalizeHazard(record.hazard || record.reason || '');

  return `${record.source}__${firm}__${dateWindow}__${productFamily}__${hazard}`;
}

function normalizeFirm(firm) {
  return firm
    .toLowerCase()
    .replace(/[,\s]+(llc|inc|lp|ltd|corp|corporation|company|co)\.?$/i, '')
    .replace(/[^a-z0-9]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

function normalizeProduct(product) {
  return product
    .toLowerCase()
    .replace(/^medline\s+/i, '') // remove "Medline" prefix for grouping
    .replace(/^hudson\s+rci\s+/i, '')
    .replace(/\s+(labeled as|branded as|containing).*/i, '') // cut at variant descriptions
    .replace(/[,;].*$/, '') // cut at model details
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
}

function normalizeHazard(hazard) {
  const h = hazard.toLowerCase();
  // Extract primary hazard keyword
  for (const kw of ['salmonella', 'listeria', 'e. coli', 'botulism', 'lead', 'fire', 'burn',
    'choking', 'suffocation', 'strangulation', 'laceration', 'fall', 'tip-over',
    'contamination', 'undeclared allergen', 'failure', 'malfunction', 'defect',
    'poisoning', 'electrocution', 'shock', 'explosion']) {
    if (h.includes(kw)) return kw.replace(/[^a-z]/g, '-');
  }
  return 'other';
}

// ===========================================================================
// Story scoring (re-scored at cluster level)
// ===========================================================================

function scoreCluster(records) {
  let score = 30; // base
  const reasons = [];

  // Use the aggregate of all records in the cluster
  const hasDeaths = records.some((r) => r.deaths && parseInt(String(r.deaths).replace(/\D/g, '')) > 0);
  const hasInjuries = records.some((r) => r.injuries && parseInt(String(r.injuries).replace(/\D/g, '')) > 0);
  const hasClass1 = records.some((r) => r.classification === 'Class I');
  const hasClass2 = records.some((r) => r.classification === 'Class II');

  const allHazardText = records.map((r) => `${r.hazard || ''} ${r.reason || ''}`).join(' ').toLowerCase();
  const allDistText = records.map((r) => r.distribution || '').join(' ').toLowerCase();

  // Deaths
  if (hasDeaths) { score += 30; reasons.push('deaths reported'); }

  // Injuries
  if (hasInjuries) { score += 15; reasons.push('injuries reported'); }

  // FDA classification
  if (hasClass1) { score += 20; reasons.push('Class I'); }
  else if (hasClass2) { score += 10; reasons.push('Class II'); }

  // Hazard types (only count each once per cluster)
  if (/fire|burn|explosion/.test(allHazardText)) { score += 15; reasons.push('fire/burn hazard'); }
  if (/choking|strangulation|suffocation/.test(allHazardText)) { score += 12; reasons.push('choking/strangulation hazard'); }
  if (/poison|contamination|lead/.test(allHazardText)) { score += 12; reasons.push('poisoning/contamination hazard'); }
  if (/salmonella|listeria|e\.?\s*coli|botulism/.test(allHazardText)) { score += 12; reasons.push('foodborne pathogen'); }
  if (/undeclared allergen|undeclared peanut|undeclared milk|undeclared egg/.test(allHazardText)) { score += 10; reasons.push('undeclared allergen'); }
  if (/failure|malfunction|defect/.test(allHazardText) && records[0]?.sourceType === 'device') { score += 10; reasons.push('critical device failure'); }

  // Distribution
  if (allDistText.includes('nationwide') || allDistText.includes('us nationwide')) {
    score += 8; reasons.push('nationwide distribution');
  }
  const stateMatches = allDistText.match(/\b[A-Z]{2}\b/g);
  if (stateMatches && stateMatches.length >= 10) { score += 5; reasons.push(`${stateMatches.length}+ states`); }

  // Unit count (aggregate)
  let totalUnits = 0;
  for (const r of records) {
    const u = parseInt(String(r.units || '').replace(/\D/g, ''));
    if (u) totalUnits += u;
  }
  if (totalUnits >= 100000) { score += 10; reasons.push(`${totalUnits.toLocaleString()}+ units`); }
  else if (totalUnits >= 10000) { score += 5; reasons.push(`${totalUnits.toLocaleString()} units`); }

  // Children/babies
  if (/child|baby|infant|toddler|toy|crib|pacifier/.test(allHazardText)) { score += 8; reasons.push('children involved'); }

  // Recent (within 7 days)
  const latestDate = records
    .map((r) => new Date(r.recallDate || r.reportDate || 0).getTime())
    .filter(Boolean)
    .sort((a, b) => b - a)[0];
  if (latestDate && Date.now() - latestDate < 7 * 24 * 60 * 60 * 1000) {
    score += 5; reasons.push('recent announcement');
  }

  return { score: Math.min(100, score), reasons };
}

// ===========================================================================
// Build cluster story record
// ===========================================================================

function buildClusterStory(clusterKey, records) {
  const first = records[0];
  const score = scoreCluster(records);

  // Aggregate dates
  const recallDates = [...new Set(records.map((r) => r.recallDate).filter(Boolean))].sort();
  const reportDates = [...new Set(records.map((r) => r.reportDate).filter(Boolean))].sort();

  // Aggregate distribution
  const allDist = records.map((r) => r.distribution).filter(Boolean);
  const distribution = allDist.length > 0 ? allDist[0] : null; // use first (they're similar)

  // Aggregate units
  let totalUnits = 0;
  for (const r of records) {
    const u = parseInt(String(r.units || '').replace(/\D/g, ''));
    if (u) totalUnits += u;
  }

  // Aggregate images
  const imageUrls = [...new Set(records.flatMap((r) => r.imageUrls || []).filter(Boolean))];

  // Aggregate source URLs and IDs
  const sourceRecallIds = records.map((r) => r.sourceId);
  const sourceUrls = records.map((r) => r.sourceUrl).filter(Boolean);

  // Aggregate model/lot/UPC
  const modelNumbers = [...new Set(records.flatMap((r) => r.modelNumbers || []).filter(Boolean))];
  const lotNumbers = [...new Set(records.flatMap((r) => r.lotNumbers || []).filter(Boolean))];
  const upcs = [...new Set(records.flatMap((r) => (r.upc ? [r.upc] : [])).filter(Boolean))];

  // Aggregate injuries/deaths (text)
  const injuryTexts = records.map((r) => r.injuries).filter(Boolean);
  const deathTexts = records.map((r) => r.deaths).filter(Boolean);

  // Create headline seed
  const brand = first.brand || first.recallingFirm || first.manufacturer || '';
  const product = first.productName || first.title || '';
  const hazard = first.hazard || first.reason || '';

  // Create recallStoryKey (deterministic from cluster key)
  const recallStoryKey = clusterKey;

  // Story status (deterministic hash for change detection)
  const signature = createHash('sha256')
    .update(JSON.stringify(records.map((r) => r.sourceId).sort()))
    .digest('hex')
    .slice(0, 16);

  return {
    recallStoryKey,
    source: first.source,
    sourceType: first.sourceType,
    headlineSeed: buildHeadlineSeed(brand, product, hazard, first),
    primaryProductName: product.slice(0, 200),
    brands: [...new Set(records.map((r) => r.brand).filter(Boolean))],
    recallingFirm: first.recallingFirm || first.manufacturer || null,
    manufacturer: first.manufacturer || null,
    hazard: first.hazard || null,
    reason: first.reason || null,
    classification: first.classification || null,
    recallDates,
    reportDates,
    distribution,
    affectedStates: null,
    units: totalUnits > 0 ? String(totalUnits) : null,
    modelNumbers,
    lotNumbers,
    upcs,
    incidents: records.map((r) => r.incidents).filter(Boolean).join('; ') || null,
    injuries: injuryTexts.length > 0 ? injuryTexts.join('; ') : null,
    deaths: deathTexts.length > 0 ? deathTexts.join('; ') : null,
    consumerAction: first.consumerAction || null,
    sourceRecallIds,
    sourceUrls,
    imageUrls,
    recordCount: records.length,
    firstSeenAt: new Date().toISOString(),
    latestSeenAt: new Date().toISOString(),
    storyScore: score.score,
    storyScoreReasons: score.reasons,
    storyStatus: 'new',
    signature,
    rawSourceData: records, // preserve all original records
  };
}

function buildHeadlineSeed(brand, product, hazard, record) {
  // Try to create a natural headline seed
  const parts = [];
  if (brand) parts.push(brand);
  else if (record.recallingFirm) parts.push(record.recallingFirm);

  // Shorten product name
  const shortProduct = (product || '').split(',')[0].split(';')[0].slice(0, 60);
  if (shortProduct) parts.push(shortProduct);

  return parts.join(' ').trim() || 'Product Recall';
}

// ===========================================================================
// Main
// ===========================================================================

async function main() {
  console.log('[cluster-recall-stories] Starting recall story clustering.');

  // Load candidates
  let doc;
  try {
    doc = JSON.parse(await readFile(INPUT_FILE, 'utf8'));
  } catch {
    console.error('  ERROR: recall-news-candidates.json not found. Run filter:recalls first.');
    process.exit(1);
  }

  const candidates = doc.candidates || [];
  console.log(`  Input candidates: ${candidates.length}`);

  // --- Tightened newsworthiness filter ---
  console.log('\n  --- Tightened newsworthiness filter ---');
  const qualified = [];
  const excluded = [];
  for (const record of candidates) {
    const result = evaluateNewsworthiness(record);
    if (result.pass) {
      record._priority = result.priority;
      record._selectedReason = result.reason;
      qualified.push(record);
    } else {
      excluded.push({ record, reason: result.reason });
    }
  }
  console.log(`  Qualified: ${qualified.length} (high: ${qualified.filter(r => r._priority === 'high').length}, medium: ${qualified.filter(r => r._priority === 'medium').length})`);
  console.log(`  Excluded: ${excluded.length}`);

  // --- Cluster records ---
  console.log('\n  --- Clustering records ---');
  const clusters = new Map();
  for (const record of qualified) {
    const key = createClusterKey(record);
    if (!clusters.has(key)) {
      clusters.set(key, []);
    }
    clusters.get(key).push(record);
  }
  console.log(`  Clusters: ${clusters.size} (from ${qualified.length} records)`);
  console.log(`  Records merged into clusters: ${qualified.length - clusters.size}`);

  // --- Build story records ---
  const stories = [];
  for (const [key, records] of clusters) {
    stories.push(buildClusterStory(key, records));
  }

  // --- Sort by score descending ---
  stories.sort((a, b) => b.storyScore - a.storyScore);

  // --- Write output ---
  const output = {
    generatedAt: new Date().toISOString(),
    source: 'CPSC + FDA',
    inputCandidateCount: candidates.length,
    qualifiedCount: qualified.length,
    clusteredStoryCount: stories.length,
    mergedRecordCount: qualified.length - stories.length,
    stories,
  };

  await mkdir(dirname(OUTPUT_FILE), { recursive: true });
  const tmp = `${OUTPUT_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(output, null, 2) + '\n', 'utf8');
  await rename(tmp, OUTPUT_FILE);

  console.log(`\n  Output: ${OUTPUT_FILE}`);
  console.log(`  Unique clustered stories: ${stories.length}`);
  console.log(`  Top 10 stories:`);
  stories.slice(0, 10).forEach((s, i) => {
    console.log(`    ${i + 1}. [score=${s.storyScore}] ${s.source}/${s.sourceType} — ${s.recallingFirm || 'n/a'} — ${(s.primaryProductName || '').slice(0, 50)} (${s.recordCount} records)`);
  });
  console.log('');
}

main().catch((err) => {
  console.error(`[cluster-recall-stories] FATAL: ${err.message}`);
  process.exit(1);
});
