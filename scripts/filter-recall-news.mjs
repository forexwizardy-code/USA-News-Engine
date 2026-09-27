/**
 * US News Engine — Recall newsworthiness filter (Phase 7A).
 *
 * Reads all three Phase 7A recall snapshots:
 *   - data/recalls/cpsc-recalls.json
 *   - data/recalls/fda-food-recalls.json
 *   - data/recalls/fda-device-recalls.json
 *
 * Applies a newsworthiness filter (deaths/injuries/severe hazards/Class I/
 * wide distribution/large unit counts) and writes the selected candidates to
 *   data/recalls/recall-news-candidates.json
 *
 * This script does NOT create article files, does NOT touch the website, and
 * does NOT use AI. It is a pure data-selection step.
 *
 * Run manually:
 *   npm run filter:recalls
 */

import { readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(__dirname, '..');

const INPUT_FILES = [
  { path: join(PROJECT_DIR, 'data', 'recalls', 'cpsc-recalls.json'), label: 'CPSC' },
  { path: join(PROJECT_DIR, 'data', 'recalls', 'fda-food-recalls.json'), label: 'FDA-food' },
  { path: join(PROJECT_DIR, 'data', 'recalls', 'fda-device-recalls.json'), label: 'FDA-device' },
];
const OUTPUT_FILE = join(PROJECT_DIR, 'data', 'recalls', 'recall-news-candidates.json');

// ===========================================================================
// CONFIGURATION — newsworthiness rules
// ===========================================================================

/**
 * High-priority hazard keywords. If any of these appear in the hazard or
 * reason text (case-insensitive), the candidate is selected as "high"
 * priority.
 */
const HIGH_PRIORITY_HAZARDS = [
  'fire',
  'burn',
  'choking',
  'poison',
  'carbon monoxide',
  'explosion',
  'laceration',
  'amputation',
  'strangulation',
  'suffocation',
  'electric shock',
  'electrocution',
  'tip-over',
  'tipover',
  'fall hazard',
];

/**
 * Medium-priority hazard keywords. If any of these appear in the hazard or
 * reason text, the candidate is selected as "medium" priority.
 */
const MEDIUM_PRIORITY_HAZARDS = [
  'contamination',
  'lead',
  'salmonella',
  'e. coli',
  'e coli',
  'listeria',
  'undeclared allergen',
  'undeclared milk',
  'undeclared egg',
  'undeclared soy',
  'undeclared wheat',
  'undeclared peanut',
  'undeclared tree nut',
  'undeclared sulfite',
  'botulism',
  'allergen',
  'pathogen',
  'toxin',
  'foreign material',
  'glass',
  'metal',
  'plastic',
  'infection',
  'sterility',
  'malfunction',
  'failure',
];

/**
 * Phrases that indicate a non-safety administrative recall. If the title
 * AND description contain ONLY these phrases and there is no safety hazard
 * keyword anywhere, the candidate is excluded.
 */
const ADMIN_ONLY_PHRASES = [
  'labeling correction',
  'administrative update',
  'minor labeling',
  'documentation update',
];

const NATIONWIDE_PHRASES = ['nationwide', 'all 50 states', 'all fifty states', 'all us states'];

// ===========================================================================
// Helpers
// ===========================================================================

function fail(message, detail) {
  console.error(`\n[filter-recall-news] ERROR: ${message}`);
  if (detail) console.error(`  Detail: ${detail}`);
  process.exit(1);
}

function lower(s) {
  return (s == null ? '' : String(s)).toLowerCase();
}

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Count comma/semicolon-separated state-like tokens in a distribution string.
 * Returns the number of distinct tokens that look like US state references.
 *
 * Examples:
 *   "Nationwide"                              -> 50 (treat as nationwide)
 *   "CA, OR, WA"                              -> 3
 *   "California; Oregon; Washington"          -> 3
 *   "US (CA, TX, NY, FL, IL, PA, OH, GA, NC)" -> 9
 */
function countStatesInDistribution(dist) {
  if (!dist || typeof dist !== 'string') return 0;
  const lowerDist = lower(dist);

  // Nationwide counts as 50 (i.e., >=10).
  for (const phrase of NATIONWIDE_PHRASES) {
    if (lowerDist.includes(phrase)) return 50;
  }

  // Split on common delimiters.
  const tokens = dist
    .split(/[,;|()]/)
    .map((t) => t.trim())
    .filter(Boolean);

  // Heuristic: a token is a "state-like" reference if it's a 2-letter
  // uppercase abbreviation OR a recognized full state name.
  const STATE_NAMES = new Set([
    'alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado',
    'connecticut', 'delaware', 'florida', 'georgia', 'hawaii', 'idaho',
    'illinois', 'indiana', 'iowa', 'kansas', 'kentucky', 'louisiana',
    'maine', 'maryland', 'massachusetts', 'michigan', 'minnesota',
    'mississippi', 'missouri', 'montana', 'nebraska', 'nevada',
    'new hampshire', 'new jersey', 'new mexico', 'new york',
    'north carolina', 'north dakota', 'ohio', 'oklahoma', 'oregon',
    'pennsylvania', 'rhode island', 'south carolina', 'south dakota',
    'tennessee', 'texas', 'utah', 'vermont', 'virginia', 'washington',
    'west virginia', 'wisconsin', 'wyoming', 'district of columbia',
    'puerto rico',
  ]);

  let count = 0;
  for (const tok of tokens) {
    const cleaned = tok.replace(/\.$/, '').trim();
    if (!cleaned) continue;
    // 2-letter abbreviation (e.g., "CA", "TX")
    if (/^[A-Za-z]{2}$/.test(cleaned) && cleaned === cleaned.toUpperCase()) {
      count++;
      continue;
    }
    if (STATE_NAMES.has(lower(cleaned))) {
      count++;
    }
  }
  return count;
}

/**
 * Parse a numeric unit count out of the `units` field, which may be a
 * free-text string like "1,234 units", "5 cases", "12,500 bottles (8 oz)".
 * Returns a number (>= 0) or null when no number can be parsed.
 */
function parseUnitCount(units) {
  if (units == null) return null;
  if (typeof units === 'number') return Number.isFinite(units) ? units : null;
  if (typeof units !== 'string') return null;
  // Look for the first integer-like token in the string (allow commas).
  const m = units.replace(/,/g, '').match(/\d+/);
  return m ? parseInt(m[0], 10) : null;
}

/**
 * Decide whether a record's deaths/injuries counts indicate a real impact.
 * Both fields may be null, a number, or a free-text string. Returns the
 * numeric count if any number > 0 was detected, otherwise 0.
 */
function numericImpact(value) {
  if (value == null) return 0;
  if (typeof value === 'number') return value > 0 ? value : 0;
  if (typeof value === 'string') {
    // Find the first integer in the string.
    const m = value.replace(/,/g, '').match(/\d+/);
    return m ? parseInt(m[0], 10) : 0;
  }
  return 0;
}

/**
 * Determine whether a record is purely an administrative / labeling
 * correction with no real safety hazard.
 */
function isAdministrativeOnly(record) {
  const title = lower(record.title);
  const desc = lower(record.description);
  const hazard = lower(record.hazard);
  const reason = lower(record.reason);

  const mentionsAdmin = ADMIN_ONLY_PHRASES.some(
    (p) => title.includes(p) || desc.includes(p),
  );
  if (!mentionsAdmin) return false;

  // If ANY hazard keyword appears anywhere, it's not admin-only.
  const allHazardText = `${hazard} ${reason} ${desc}`;
  const allHazards = [...HIGH_PRIORITY_HAZARDS, ...MEDIUM_PRIORITY_HAZARDS];
  const hasHazard = allHazards.some((k) => allHazardText.includes(k));
  return !hasHazard;
}

/**
 * The core newsworthiness decision.
 *
 * Returns:
 *   { include: true, priority: 'high'|'medium', selectedReason: string }
 *   { include: false, selectedReason: string }
 */
function evaluate(record) {
  // --- EXCLUDE checks -----------------------------------------------------
  if (isAdministrativeOnly(record)) {
    return {
      include: false,
      selectedReason: 'Excluded: administrative/labeling-only with no safety hazard',
    };
  }

  // No product/title at all → not enough signal to write a story.
  const title = lower(record.title);
  const productName = lower(record.productName);
  if (!title && !productName) {
    return {
      include: false,
      selectedReason: 'Excluded: no title and no product name',
    };
  }

  // --- INCLUDE checks -----------------------------------------------------
  const hazardText = lower(record.hazard);
  const reasonText = lower(record.reason);
  const combinedHazardText = `${hazardText} ${reasonText}`;
  const reasons = [];

  const deaths = numericImpact(record.deaths);
  const injuries = numericImpact(record.injuries);
  const isClassI = record.classification && lower(record.classification) === 'class i';
  const distStateCount = countStatesInDistribution(record.distribution);
  const isNationwide = distStateCount >= 50 || NATIONWIDE_PHRASES.some(
    (p) => lower(record.distribution).includes(p),
  );
  const unitCount = parseUnitCount(record.units);

  // 1) Deaths.
  if (deaths > 0) {
    reasons.push(`deaths reported (${deaths})`);
  }
  // 2) Injuries.
  if (injuries > 0) {
    reasons.push(`injuries reported (${injuries})`);
  }
  // 3) High-priority hazard keyword.
  const highHazardsHit = HIGH_PRIORITY_HAZARDS.filter((k) =>
    combinedHazardText.includes(k),
  );
  if (highHazardsHit.length) {
    reasons.push(`high-priority hazard: ${[...new Set(highHazardsHit)].join('; ')}`);
  }
  // 4) Medium-priority hazard keyword.
  const medHazardsHit = MEDIUM_PRIORITY_HAZARDS.filter((k) =>
    combinedHazardText.includes(k),
  );
  if (medHazardsHit.length) {
    reasons.push(`hazard: ${[...new Set(medHazardsHit)].join('; ')}`);
  }
  // 5) FDA Class I.
  if (isClassI) {
    reasons.push('FDA Class I classification');
  }
  // 6) Wide distribution.
  if (isNationwide) {
    reasons.push('nationwide distribution');
  } else if (distStateCount >= 10) {
    reasons.push(`distribution across ${distStateCount} states`);
  }
  // 7) Large unit count.
  if (unitCount != null && unitCount > 10000) {
    reasons.push(`large unit count (${unitCount.toLocaleString()})`);
  }

  if (reasons.length === 0) {
    return {
      include: false,
      selectedReason: 'Excluded: no newsworthiness trigger matched',
    };
  }

  // --- Priority decision --------------------------------------------------
  // "high" for deaths/injuries/Class I/fire/burn/choking; "medium" otherwise.
  const highPriorityTriggers =
    deaths > 0 ||
    injuries > 0 ||
    isClassI ||
    highHazardsHit.some((h) =>
      ['fire', 'burn', 'choking', 'explosion', 'carbon monoxide', 'strangulation', 'suffocation', 'amputation', 'laceration', 'electric shock', 'electrocution', 'poison'].some(
        (trigger) => h.includes(trigger),
      ),
    );

  const priority = highPriorityTriggers ? 'high' : 'medium';

  return {
    include: true,
    priority,
    selectedReason: `Selected: ${reasons.join('; ')}`,
  };
}

// ===========================================================================
// Main
// ===========================================================================

async function loadInputFile(entry) {
  try {
    const raw = await readFile(entry.path, 'utf8');
    const doc = JSON.parse(raw);
    const recalls = Array.isArray(doc.recalls) ? doc.recalls : [];
    return { label: entry.label, recalls, ok: true, error: null };
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      console.log(`  [skip] ${entry.path} does not exist yet (run the fetcher first).`);
      return { label: entry.label, recalls: [], ok: false, error: 'missing' };
    }
    console.log(`  [warn] Could not parse ${entry.path}: ${String(err)}`);
    return { label: entry.label, recalls: [], ok: false, error: String(err) };
  }
}

async function main() {
  console.log('[filter-recall-news] Starting newsworthiness filter.');
  console.log(`  Inputs:`);
  for (const f of INPUT_FILES) console.log(`    - ${f.path}`);

  // --- Load all three inputs -----------------------------------------------
  const loaded = [];
  for (const entry of INPUT_FILES) {
    loaded.push(await loadInputFile(entry));
  }

  const sourceLabels = loaded.filter((l) => l.recalls.length > 0 || l.ok).map((l) => l.label);
  const allRecalls = [];
  for (const l of loaded) {
    for (const r of l.recalls) {
      allRecalls.push({ ...r, sourceLabel: l.label });
    }
  }

  const now = new Date();
  console.log(`  Total input recalls: ${allRecalls.length}`);
  console.log(`  Sources with data:   ${sourceLabels.join(', ') || '(none)'}`);
  console.log(`  Filter time (UTC):   ${now.toISOString()}`);

  // --- Evaluate every recall -----------------------------------------------
  const candidates = [];
  const exclusionBreakdown = {};
  for (const r of allRecalls) {
    const decision = evaluate(r);
    if (!decision.include) {
      const key = decision.selectedReason.replace(/^Excluded:\s*/, '').split(':')[0].trim();
      exclusionBreakdown[key] = (exclusionBreakdown[key] || 0) + 1;
      continue;
    }
    candidates.push({
      recallKey: r.recallKey,
      source: r.source,
      sourceType: r.sourceType,
      sourceId: r.sourceId,
      sourceLabel: r.sourceLabel,
      title: r.title,
      productName: r.productName,
      brand: r.brand,
      manufacturer: r.manufacturer,
      recallingFirm: r.recallingFirm,
      description: r.description,
      hazard: r.hazard,
      reason: r.reason,
      consumerAction: r.consumerAction,
      classification: r.classification,
      recallDate: r.recallDate,
      reportDate: r.reportDate,
      distribution: r.distribution,
      units: r.units,
      upc: r.upc,
      incidents: r.incidents,
      injuries: r.injuries,
      deaths: r.deaths,
      sourceUrl: r.sourceUrl,
      imageUrls: Array.isArray(r.imageUrls) ? r.imageUrls : [],
      priority: decision.priority,
      selectedReason: decision.selectedReason,
    });
  }

  // --- Sort: high priority first, then newest recallDate first ------------
  candidates.sort((a, b) => {
    if (a.priority !== b.priority) {
      return a.priority === 'high' ? -1 : 1;
    }
    const da = parseDate(a.recallDate)?.getTime() ?? 0;
    const db = parseDate(b.recallDate)?.getTime() ?? 0;
    return db - da;
  });

  // --- Assemble output document -------------------------------------------
  const highPriorityCount = candidates.filter((c) => c.priority === 'high').length;
  const mediumPriorityCount = candidates.filter((c) => c.priority === 'medium').length;

  const output = {
    generatedAt: now.toISOString(),
    sources: sourceLabels.length ? sourceLabels : ['CPSC', 'FDA-food', 'FDA-device'],
    inputRecallCount: allRecalls.length,
    candidateCount: candidates.length,
    highPriorityCount,
    mediumPriorityCount,
    candidates,
  };

  // --- Atomic write --------------------------------------------------------
  await mkdir(dirname(OUTPUT_FILE), { recursive: true });
  const tmp = `${OUTPUT_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(output, null, 2) + '\n', 'utf8');
  await rename(tmp, OUTPUT_FILE);

  const stats = await stat(OUTPUT_FILE);
  console.log('\n[filter-recall-news] SUCCESS');
  console.log(`  Output file:          ${OUTPUT_FILE}`);
  console.log(`  File size:            ${stats.size.toLocaleString()} bytes`);
  console.log(`  Generated at (UTC):   ${output.generatedAt}`);
  console.log(`  Input recalls:        ${output.inputRecallCount}`);
  console.log(`  Candidates selected:  ${output.candidateCount}`);
  console.log(`    high priority:      ${highPriorityCount}`);
  console.log(`    medium priority:    ${mediumPriorityCount}`);
  console.log(`  Excluded:             ${allRecalls.length - candidates.length}`);

  console.log('\n  Exclusion breakdown:');
  for (const [reason, count] of Object.entries(exclusionBreakdown).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(count).padStart(4)}  ${reason}`);
  }

  // --- Top 10 candidates --------------------------------------------------
  console.log('\n  Top 10 candidates:');
  candidates.slice(0, 10).forEach((c, i) => {
    const titlePreview = (c.title || c.productName || '(no title)').slice(0, 80);
    console.log(
      `    ${String(i + 1).padStart(2)}. [${c.priority}] ${titlePreview}`,
    );
    console.log(`        key: ${c.recallKey}`);
    console.log(`        why: ${c.selectedReason}`);
  });

  // --- Group by source label ----------------------------------------------
  const bySource = {};
  for (const c of candidates) {
    bySource[c.sourceLabel] = (bySource[c.sourceLabel] || 0) + 1;
  }
  console.log('\n  Candidates grouped by source:');
  for (const [label, count] of Object.entries(bySource).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(count).padStart(4)}  ${label}`);
  }
  console.log('');
}

main().catch((err) => fail('Unexpected failure.', String(err && err.stack ? err.stack : err)));
