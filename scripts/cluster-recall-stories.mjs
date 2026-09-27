/**
 * US News Engine — Recall story clustering + quality gate (Phase 7B.1).
 *
 * CORRECTED PIPELINE ORDER:
 *   FETCH → NORMALIZE → CLUSTER → SCORE → FILTER AT STORY LEVEL → VALIDATE
 *
 * Key changes from Phase 7B:
 *   - Cluster BEFORE filtering (not after)
 *   - publishEligible/priority/exclusionReasons at story level
 *   - Stable story keys: cpsc__<RecallID> for single, cluster signature for multi
 *   - Source-backed hazard mapping: hazardRaw/hazardNormalized/hazardEvidence
 *   - FDA date semantics: recallInitiationDate vs reportDate preserved separately
 *   - Tightened CPSC/FDA Food/FDA Device rules
 *
 * Run:
 *   npm run cluster:recalls
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
// Source-backed hazard extraction
// ===========================================================================

/**
 * Extract hazard information from source data ONLY.
 * Never infer a hazard category that the official source does not support.
 *
 * Returns:
 *   hazardRaw: the exact source text
 *   hazardNormalized: a normalized label ONLY if explicitly supported
 *   hazardEvidence: the source field and value used
 */
function extractHazard(record) {
  // CPSC: Hazards array has explicit Name fields
  if (record.source === 'CPSC' && record.rawSourceData?.Hazards) {
    const hazards = record.rawSourceData.Hazards;
    if (Array.isArray(hazards) && hazards.length > 0) {
      const names = hazards.map((h) => h.Name || '').filter(Boolean);
      const raw = names.join('; ');
      const normalized = normalizeCpscHazard(names);
      return {
        hazardRaw: raw,
        hazardNormalized: normalized,
        hazardEvidence: `CPSC Hazards[].Name: ${JSON.stringify(names)}`,
      };
    }
  }

  // FDA: reason_for_recall is the primary source
  const reason = record.reason || record.rawSourceData?.reason_for_recall || '';
  if (reason) {
    const normalized = normalizeFdaHazard(reason);
    return {
      hazardRaw: reason.slice(0, 500),
      hazardNormalized: normalized,
      // Use the FULL reason text in evidence (not truncated) so validation
      // can verify the hazard keyword appears in the source.
      hazardEvidence: `FDA reason_for_recall: "${reason}"`,
    };
  }

  // CPSC title may contain hazard info
  const title = record.title || '';
  if (title && record.source === 'CPSC') {
    const normalized = normalizeCpscTitleHazard(title);
    if (normalized) {
      return {
        hazardRaw: title,
        hazardNormalized: normalized,
        hazardEvidence: `CPSC Title: "${title}"`,
      };
    }
  }

  return {
    hazardRaw: null,
    hazardNormalized: null,
    hazardEvidence: null,
  };
}

/**
 * Normalize CPSC hazard names to standard labels.
 * Only maps when the CPSC source explicitly names the hazard.
 */
function normalizeCpscHazard(names) {
  const text = names.join(' ').toLowerCase();
  const mappings = [
    { pattern: /\bchoking\b/, label: 'Choking Hazard' },
    { pattern: /\bsuffocation\b/, label: 'Suffocation Hazard' },
    { pattern: /\bstrangulation\b/, label: 'Strangulation Hazard' },
    { pattern: /\bfire\b/, label: 'Fire Hazard' },
    { pattern: /\bburn\b/, label: 'Burn Hazard' },
    { pattern: /\blaceration\b/, label: 'Laceration Hazard' },
    { pattern: /\bfall\b/, label: 'Fall Hazard' },
    { pattern: /\btip[- ]?over\b/, label: 'Tip-Over Hazard' },
    { pattern: /\belectrocution\b/, label: 'Electrocution Hazard' },
    { pattern: /\bshock\b/, label: 'Electric Shock Hazard' },
    { pattern: /\bpoisoning\b/, label: 'Poisoning Hazard' },
    { pattern: /\bexplosion\b/, label: 'Explosion Hazard' },
    { pattern: /\bamputation\b/, label: 'Amputation Hazard' },
    { pattern: /\bentrapment\b/, label: 'Entrapment Hazard' },
    { pattern: /\bingestion\b/, label: 'Ingestion Hazard' },
  ];
  for (const m of mappings) {
    if (m.pattern.test(text)) return m.label;
  }
  // Return the raw name if no mapping matches (don't invent)
  return names.length > 0 ? names[0] : null;
}

/**
 * Normalize FDA hazard from reason_for_recall text.
 * ONLY map to a specific hazard when the source text EXPLICITLY uses the word.
 * Do NOT infer "burn" from "burning odor" — that's a symptom, not a burn hazard.
 */
function normalizeFdaHazard(reason) {
  const text = reason.toLowerCase();

  // Food pathogens — explicit mentions only
  if (text.includes('salmonella')) return 'Salmonella Risk';
  if (text.includes('listeria')) return 'Listeria Risk';
  if (text.includes('e. coli') || text.includes('e.coli') || text.includes('escherichia')) return 'E. Coli Risk';
  if (text.includes('botulism') || text.includes('clostridium botulinum')) return 'Botulism Risk';

  // Undeclared allergens — explicit mentions only
  if (text.includes('undeclared allergen') || text.includes('undeclared peanut') ||
      text.includes('undeclared milk') || text.includes('undeclared egg') ||
      text.includes('undeclared soy') || text.includes('undeclared wheat') ||
      text.includes('undeclared tree nut')) {
    return 'Undeclared Allergen Risk';
  }

  // Contamination — explicit mentions only
  if (text.includes('contamination') || text.includes('foreign material') ||
      text.includes('foreign object') || text.includes('glass') ||
      text.includes('metal fragment')) {
    return 'Contamination Risk';
  }

  // Lead — explicit mention
  if (text.includes('lead') && (text.includes('lead content') || text.includes('lead exposure') || text.includes('elevated lead'))) {
    return 'Lead Exposure Risk';
  }

  // Device failure — explicit mentions only
  if (text.includes('device failure') || text.includes('may fail') || text.includes('may experience sporadic failure') ||
      text.includes('may not function') || text.includes('malfunction')) {
    return 'Potential Device Failure';
  }

  // Airway obstruction — explicit mention (NOT "burning odor")
  if (text.includes('airway obstruction') || text.includes('airway')) {
    return 'Potential Airway Obstruction';
  }

  // Do NOT map:
  // - "burning odor" → NOT "Burn Hazard" (it's a symptom of thermal damage, not a burn injury risk)
  // - "melting" → NOT "Burn Hazard"
  // - "smoke" → NOT "Fire Hazard"
  // These are device failure symptoms, not direct consumer hazards.

  // If no explicit match, return null — use the source reason text in the headline
  return null;
}

/**
 * Extract hazard from CPSC title (e.g. "Recalled Due to Choking Hazard")
 */
function normalizeCpscTitleHazard(title) {
  const m = title.match(/Due to (?:Risk of )?([A-Za-z\s]+?)(?:\s*(?:Hazard|Risk|Injury|Death))/i);
  if (m) {
    const hazard = m[1].trim();
    // Only return if it's a recognized hazard
    const recognized = ['Choking', 'Suffocation', 'Strangulation', 'Fire', 'Burn',
      'Laceration', 'Fall', 'Tip-Over', 'Electrocution', 'Shock', 'Poisoning',
      'Explosion', 'Amputation', 'Entrapment', 'Ingestion'];
    for (const r of recognized) {
      if (hazard.toLowerCase().includes(r.toLowerCase())) return `${r} Hazard`;
    }
  }
  return null;
}

// ===========================================================================
// Stable story key generation
// ===========================================================================

/**
 * Generate a stable, collision-safe story key.
 *
 * For single CPSC recalls: cpsc__<RecallID>
 * For single FDA recalls: fda-<type>__<recall_number>
 * For multi-record clusters: <source-prefix>__<sorted-source-ids-hash>
 */
function createStoryKey(records) {
  if (records.length === 1) {
    const r = records[0];
    if (r.source === 'CPSC') return `cpsc__${r.sourceId}`;
    if (r.source === 'FDA') return `fda-${r.sourceType}__${r.sourceId}`;
    return `${r.source}__${r.sourceId}`;
  }

  // Multi-record cluster: use sorted source IDs hashed for stability
  const sortedIds = records.map((r) => r.sourceId).sort();
  const hash = createHash('sha256')
    .update(sortedIds.join('|'))
    .digest('hex')
    .slice(0, 12);
  const first = records[0];
  const prefix = first.source === 'CPSC' ? 'cpsc' : `fda-${first.sourceType}`;
  return `${prefix}__cluster__${hash}`;
}

/**
 * Create a cluster grouping key for records that belong together.
 * This is used for initial grouping, then createStoryKey generates the
 * permanent stable key.
 */
function createClusterGroupKey(record) {
  const firm = normalizeFirm(record.recallingFirm || record.manufacturer || '');
  const date = record.recallDate || record.reportDate || '';
  const dateWindow = date ? date.slice(0, 10) : 'unknown';
  const product = normalizeProduct(record.productName || record.title || '');
  const productFamily = product.slice(0, 40);
  const hazard = normalizeHazardForGrouping(record.hazard || record.reason || '');
  return `${record.source}__${record.sourceType}__${firm}__${dateWindow}__${productFamily}__${hazard}`;
}

function normalizeFirm(firm) {
  return firm
    .toLowerCase()
    .replace(/[,\s]+(llc|inc|lp|ltd|corp|corporation|company|co)\.?$/i, '')
    .replace(/[^a-z0-9]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'unknown-firm';
}

function normalizeProduct(product) {
  return product
    .toLowerCase()
    .replace(/^medline\s+/i, '')
    .replace(/^hudson\s+rci\s+/i, '')
    .replace(/\s+(labeled as|branded as|containing).*/i, '')
    .replace(/[,;].*$/, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40) || 'unknown-product';
}

function normalizeHazardForGrouping(hazard) {
  const h = hazard.toLowerCase();
  for (const kw of ['salmonella', 'listeria', 'e. coli', 'botulism', 'lead', 'fire', 'burn',
    'choking', 'suffocation', 'strangulation', 'laceration', 'fall', 'tip-over',
    'contamination', 'undeclared allergen', 'failure', 'malfunction', 'defect',
    'poisoning', 'electrocution', 'shock', 'explosion', 'airway']) {
    if (h.includes(kw)) return kw.replace(/[^a-z]/g, '-');
  }
  return 'other';
}

// ===========================================================================
// FDA date semantics
// ===========================================================================

function extractFdaDates(record) {
  // FDA dates are normalized to top-level fields by the fetcher:
  // recallDate = recall_initiation_date (when the firm started the recall)
  // reportDate = report_date (when FDA reported/published the recall)
  // Also check rawSourceData for the original YYYYMMDD values.
  const raw = record.rawSourceData || {};
  return {
    recallInitiationDate: raw.recall_initiation_date || null,
    reportDate: raw.report_date || null,
    // Fallback to normalized top-level fields if raw data not preserved
    recallInitiationDateIso: record.recallDate || null,
    reportDateIso: record.reportDate || null,
  };
}

function convertFdaDate(yyyymmdd) {
  if (!yyyymmdd || yyyymmdd.length !== 8) return null;
  const y = yyyymmdd.slice(0, 4);
  const m = yyyymmdd.slice(4, 6);
  const d = yyyymmdd.slice(6, 8);
  return `${y}-${m}-${d}T00:00:00.000Z`;
}

// ===========================================================================
// Story scoring at cluster level
// ===========================================================================

function scoreCluster(records, hazardInfo) {
  let score = 30;
  const reasons = [];

  const hasDeaths = records.some((r) => parseNumeric(r.deaths) > 0);
  const hasInjuries = records.some((r) => parseNumeric(r.injuries) > 0);
  const hasClass1 = records.some((r) => r.classification === 'Class I');
  const hasClass2 = records.some((r) => r.classification === 'Class II');

  const hazardText = `${hazardInfo.hazardRaw || ''} ${hazardInfo.hazardNormalized || ''}`.toLowerCase();
  const allDistText = records.map((r) => r.distribution || '').join(' ').toLowerCase();

  if (hasDeaths) { score += 30; reasons.push('deaths reported'); }
  if (hasInjuries) { score += 15; reasons.push('injuries reported'); }
  if (hasClass1) { score += 20; reasons.push('Class I'); }
  else if (hasClass2) { score += 10; reasons.push('Class II'); }

  // Only score hazards that are EXPLICITLY in the source
  if (/fire/.test(hazardText)) { score += 15; reasons.push('fire hazard'); }
  if (/burn/.test(hazardText) && hazardInfo.hazardNormalized?.includes('Burn')) { score += 15; reasons.push('burn hazard'); }
  if (/choking|strangulation|suffocation/.test(hazardText)) { score += 12; reasons.push('choking/strangulation hazard'); }
  if (/salmonella|listeria|e\.?\s*coli|botulism/.test(hazardText)) { score += 12; reasons.push('foodborne pathogen'); }
  if (/undeclared allergen/.test(hazardText)) { score += 10; reasons.push('undeclared allergen'); }
  if (/contamination|foreign material/.test(hazardText)) { score += 10; reasons.push('contamination'); }
  if (/lead/.test(hazardText) && hazardInfo.hazardNormalized?.includes('Lead')) { score += 12; reasons.push('lead exposure'); }
  if (/failure|malfunction/.test(hazardText)) { score += 8; reasons.push('device failure'); }

  if (allDistText.includes('nationwide') || allDistText.includes('us nationwide')) {
    score += 8; reasons.push('nationwide distribution');
  }
  const stateMatches = allDistText.match(/\b[A-Z]{2}\b/g);
  if (stateMatches && stateMatches.length >= 10) { score += 5; reasons.push(`${stateMatches.length}+ states`); }

  let totalUnits = 0;
  for (const r of records) {
    const u = parseNumeric(r.units);
    if (u) totalUnits += u;
  }
  if (totalUnits >= 100000) { score += 10; reasons.push(`${totalUnits.toLocaleString()}+ units`); }
  else if (totalUnits >= 10000) { score += 5; reasons.push(`${totalUnits.toLocaleString()} units`); }

  if (/child|baby|infant|toddler|toy|crib|pacifier|neonatal/.test(hazardText)) { score += 8; reasons.push('children/infants involved'); }

  // Use report date for freshness, not recall initiation date
  const latestReport = records
    .map((r) => {
      const dates = extractFdaDates(r);
      const reportTs = dates.reportDate ? new Date(convertFdaDate(dates.reportDate) || 0).getTime() : 0;
      const recallTs = r.recallDate ? new Date(r.recallDate).getTime() : 0;
      return Math.max(reportTs, recallTs);
    })
    .filter(Boolean)
    .sort((a, b) => b - a)[0];
  if (latestReport && Date.now() - latestReport < 7 * 24 * 60 * 60 * 1000) {
    score += 5; reasons.push('recent report');
  }

  return { score: Math.min(100, score), reasons };
}

function parseNumeric(val) {
  if (!val) return 0;
  if (typeof val === 'number') return val;
  const m = String(val).match(/\d+/);
  return m ? parseInt(m[0], 10) : 0;
}

// ===========================================================================
// Story-level publish eligibility filter
// ===========================================================================

function evaluatePublishEligibility(story, records, hazardInfo) {
  const reasons = [];
  const exclusions = [];
  const source = story.source;
  const sourceType = story.sourceType;
  const hazardNorm = hazardInfo.hazardNormalized;
  const hazardText = `${hazardInfo.hazardRaw || ''} ${hazardInfo.hazardNormalized || ''}`.toLowerCase();
  const reasonText = (story.reason || '').toLowerCase();
  const distText = (story.distribution || '').toLowerCase();

  const hasDeaths = records.some((r) => parseNumeric(r.deaths) > 0);
  const hasInjuries = records.some((r) => parseNumeric(r.injuries) > 0);
  const hasClass1 = records.some((r) => r.classification === 'Class I');
  const hasClass2 = records.some((r) => r.classification === 'Class II');
  const totalUnits = records.reduce((sum, r) => sum + parseNumeric(r.units), 0);
  const stateMatches = distText.match(/\b[A-Z]{2}\b/g);
  const stateCount = stateMatches ? stateMatches.length : 0;
  const isNationwide = distText.includes('nationwide') || distText.includes('us nationwide');

  // --- CPSC rules ---
  if (source === 'CPSC') {
    if (hasDeaths) { reasons.push('Deaths reported'); }
    if (hasInjuries) { reasons.push('Injuries reported'); }
    if (/choking|suffocation|strangulation/.test(hazardText)) { reasons.push('Choking/suffocation/strangulation hazard'); }
    if (/fire|explosion/.test(hazardText)) { reasons.push('Fire/explosion hazard'); }
    if (/electrocution|shock/.test(hazardText)) { reasons.push('Electrocution/shock hazard'); }
    if (/poisoning/.test(hazardText)) { reasons.push('Poisoning hazard'); }
    if (/child|baby|infant|toddler|toy/.test(hazardText)) { reasons.push('Children/baby hazard'); }
    if (totalUnits >= 10000) { reasons.push(`Large unit count: ${totalUnits.toLocaleString()}`); }
    if (isNationwide || stateCount >= 10) { reasons.push('Broad distribution'); }

    if (reasons.length === 0) {
      exclusions.push('Routine CPSC recall without strong consumer relevance signals');
    }
  }

  // --- FDA Food rules ---
  if (source === 'FDA' && sourceType === 'food') {
    if (hasClass1) { reasons.push('FDA Class I'); }
    if (/salmonella/.test(hazardText)) { reasons.push('Salmonella risk'); }
    if (/listeria/.test(hazardText)) { reasons.push('Listeria risk'); }
    if (/e\.?\s*coli/.test(hazardText)) { reasons.push('E. coli risk'); }
    if (/botulism/.test(hazardText)) { reasons.push('Botulism risk'); }
    if (/undeclared allergen/.test(hazardText)) { reasons.push('Undeclared allergen'); }
    if (hasDeaths || hasInjuries) { reasons.push('Confirmed illnesses/deaths'); }
    if (isNationwide || stateCount >= 10) { reasons.push('Nationwide/multi-state distribution'); }

    // Class II food does NOT automatically qualify
    if (hasClass2 && !hasClass1) {
      // Require additional substantial relevance
      if (!hasDeaths && !hasInjuries && !/salmonella|listeria|e\.?\s*coli|botulism|undeclared allergen/.test(hazardText)) {
        exclusions.push('Class II food recall without pathogen, allergen, or illness signal');
      }
    }

    if (reasons.length === 0 && exclusions.length === 0) {
      exclusions.push('FDA food recall below consumer-news threshold');
    }
  }

  // --- FDA Device rules ---
  if (source === 'FDA' && sourceType === 'device') {
    if (hasClass1) { reasons.push('FDA Class I device'); }
    if (hasDeaths) { reasons.push('Deaths reported'); }
    if (hasInjuries) { reasons.push('Serious injuries reported'); }
    if (/failure|malfunction/.test(hazardText) && /life.?support|respiratory|ventilat|breathing|infusion|implant|pacemaker|defibrillat/i.test(reasonText)) {
      reasons.push('Critical device failure affecting life-support/treatment');
    }
    if (isNationwide && totalUnits >= 50000) { reasons.push('Large nationwide patient exposure'); }

    // Class II device does NOT automatically qualify
    if (hasClass2 && !hasClass1) {
      // Require: critical device type, OR deaths/injuries, OR very large exposure
      const isCritical = /life.?support|respiratory|ventilat|breathing|infusion|implant|pacemaker|defibrillat/i.test(reasonText);
      const hasLargeExposure = isNationwide && totalUnits >= 100000;
      if (!hasDeaths && !hasInjuries && !isCritical && !hasLargeExposure) {
        exclusions.push('Class II device recall without critical failure, injuries, or large exposure');
      }
    }

    if (reasons.length === 0 && exclusions.length === 0) {
      exclusions.push('FDA device recall below consumer-news threshold');
    }
  }

  // --- Exclude administrative/labeling-only ---
  if (/labeling correction|administrative/.test(hazardText)) {
    exclusions.push('Administrative/labeling correction');
  }

  const publishEligible = exclusions.length === 0 && reasons.length > 0;
  const priority = hasDeaths || hasClass1 || /fire|explosion|choking|suffocation|strangulation|salmonella|listeria|botulism/.test(hazardText) ? 'high' : 'medium';

  return { publishEligible, priority, eligibilityReasons: reasons, exclusionReasons: exclusions };
}

// ===========================================================================
// Build cluster story record
// ===========================================================================

function buildClusterStory(records) {
  const first = records[0];
  const hazardInfo = extractHazard(first);
  const score = scoreCluster(records, hazardInfo);
  const eligibility = evaluatePublishEligibility({ source: first.source, sourceType: first.sourceType, distribution: first.distribution, reason: first.reason }, records, hazardInfo);

  const storyKey = createStoryKey(records);

  const recallDates = [...new Set(records.map((r) => r.recallDate).filter(Boolean))].sort();
  const reportDates = [...new Set(records.map((r) => r.reportDate).filter(Boolean))].sort();

  // FDA date semantics — use both raw YYYYMMDD and normalized ISO fallback
  const fdaDates = records.map(extractFdaDates);
  const recallInitiationDates = [
    ...new Set(
      fdaDates
        .map((d) => d.recallInitiationDate || d.recallInitiationDateIso)
        .filter(Boolean),
    ),
  ];
  const fdaReportDates = [
    ...new Set(
      fdaDates
        .map((d) => d.reportDate || d.reportDateIso)
        .filter(Boolean),
    ),
  ];

  let totalUnits = 0;
  for (const r of records) {
    const u = parseNumeric(r.units);
    if (u) totalUnits += u;
  }

  const imageUrls = [...new Set(records.flatMap((r) => r.imageUrls || []).filter(Boolean))];
  const sourceRecallIds = records.map((r) => r.sourceId);
  const sourceUrls = [...new Set(records.map((r) => r.sourceUrl).filter(Boolean))];

  const modelNumbers = [...new Set(records.flatMap((r) => r.modelNumbers || []).filter(Boolean))];
  const lotNumbers = [...new Set(records.flatMap((r) => r.lotNumbers || []).filter(Boolean))];
  const upcs = [...new Set(records.flatMap((r) => (r.upc ? [r.upc] : [])).filter(Boolean))];

  const injuryTexts = records.map((r) => r.injuries).filter(Boolean);
  const deathTexts = records.map((r) => r.deaths).filter(Boolean);

  const brand = first.brand || first.recallingFirm || first.manufacturer || '';
  const product = first.productName || first.title || '';

  return {
    recallStoryKey: storyKey,
    source: first.source,
    sourceType: first.sourceType,
    headlineSeed: buildHeadlineSeed(brand, product, hazardInfo, first),
    primaryProductName: product.slice(0, 200),
    brands: [...new Set(records.map((r) => r.brand).filter(Boolean))],
    recallingFirm: first.recallingFirm || first.manufacturer || null,
    manufacturer: first.manufacturer || null,
    hazardRaw: hazardInfo.hazardRaw,
    hazardNormalized: hazardInfo.hazardNormalized,
    hazardEvidence: hazardInfo.hazardEvidence,
    reason: first.reason || null,
    classification: first.classification || null,
    recallDates,
    reportDates,
    // FDA-specific date semantics
    recallInitiationDates: recallInitiationDates.length > 0 ? recallInitiationDates : null,
    fdaReportDates: fdaReportDates.length > 0 ? fdaReportDates : null,
    distribution: first.distribution || null,
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
    publishEligible: eligibility.publishEligible,
    priority: eligibility.priority,
    eligibilityReasons: eligibility.eligibilityReasons,
    exclusionReasons: eligibility.exclusionReasons,
    storyStatus: 'new',
    rawSourceData: records,
  };
}

function buildHeadlineSeed(brand, product, hazardInfo, record) {
  const parts = [];
  if (brand) parts.push(brand);
  else if (record.recallingFirm) parts.push(record.recallingFirm);
  const shortProduct = (product || '').split(',')[0].split(';')[0].slice(0, 60);
  if (shortProduct) parts.push(shortProduct);
  return parts.join(' ').trim() || 'Product Recall';
}

// ===========================================================================
// Main
// ===========================================================================

async function main() {
  console.log('[cluster-recall-stories] Starting recall story clustering (Phase 7B.1).');

  let doc;
  try {
    doc = JSON.parse(await readFile(INPUT_FILE, 'utf8'));
  } catch {
    console.error('  ERROR: recall-news-candidates.json not found. Run filter:recalls first.');
    process.exit(1);
  }

  const candidates = doc.candidates || [];
  console.log(`  Input candidates: ${candidates.length}`);

  // --- STEP 1: Cluster ALL records first (before filtering) ---
  console.log('\n  --- Step 1: Cluster all records ---');
  const clusterMap = new Map();
  for (const record of candidates) {
    const key = createClusterGroupKey(record);
    if (!clusterMap.has(key)) clusterMap.set(key, []);
    clusterMap.get(key).push(record);
  }
  console.log(`  Clusters from all candidates: ${clusterMap.size}`);

  // --- STEP 2: Build story records ---
  console.log('\n  --- Step 2: Build clustered story records ---');
  const allStories = [];
  for (const [, records] of clusterMap) {
    allStories.push(buildClusterStory(records));
  }
  console.log(`  Total clustered stories: ${allStories.length}`);

  // --- STEP 3: Score (already done in buildClusterStory) ---
  // --- STEP 4: Apply publish eligibility filter at STORY level ---
  console.log('\n  --- Step 4: Apply publish eligibility filter ---');
  const eligible = allStories.filter((s) => s.publishEligible);
  const excluded = allStories.filter((s) => !s.publishEligible);
  const highCount = eligible.filter((s) => s.priority === 'high').length;
  const mediumCount = eligible.filter((s) => s.priority === 'medium').length;
  console.log(`  publishEligible: ${eligible.length}`);
  console.log(`    high: ${highCount}`);
  console.log(`    medium: ${mediumCount}`);
  console.log(`  excluded: ${excluded.length}`);

  // --- Sort by score ---
  allStories.sort((a, b) => b.storyScore - a.storyScore);

  // --- Write output ---
  const output = {
    generatedAt: new Date().toISOString(),
    source: 'CPSC + FDA',
    inputCandidateCount: candidates.length,
    clusteredStoryCount: allStories.length,
    publishEligibleCount: eligible.length,
    highPriorityCount: highCount,
    mediumPriorityCount: mediumCount,
    excludedCount: excluded.length,
    mergedRecordCount: candidates.length - allStories.length,
    stories: allStories,
  };

  await mkdir(dirname(OUTPUT_FILE), { recursive: true });
  const tmp = `${OUTPUT_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(output, null, 2) + '\n', 'utf8');
  await rename(tmp, OUTPUT_FILE);

  console.log(`\n  Output: ${OUTPUT_FILE}`);
  console.log(`  publishEligible: ${eligible.length} / ${allStories.length} stories (${((eligible.length / allStories.length) * 100).toFixed(1)}%)`);
  console.log(`  publishEligible as % of raw candidates: ${((eligible.length / candidates.length) * 100).toFixed(1)}%`);

  console.log(`\n  Top 10 stories:`);
  allStories.slice(0, 10).forEach((s, i) => {
    const status = s.publishEligible ? `[${s.priority}]` : '[EXCLUDED]';
    console.log(`    ${i + 1}. [score=${s.storyScore}] ${status} ${s.source}/${s.sourceType} — ${(s.recallingFirm || 'n/a').slice(0, 25)} — ${(s.primaryProductName || '').slice(0, 40)} (${s.recordCount} records)`);
    if (s.hazardNormalized) console.log(`        hazard: ${s.hazardNormalized}`);
    if (s.exclusionReasons.length > 0) console.log(`        excluded: ${s.exclusionReasons.join('; ')}`);
  });
  console.log('');
}

main().catch((err) => {
  console.error(`[cluster-recall-stories] FATAL: ${err.message}`);
  process.exit(1);
});
