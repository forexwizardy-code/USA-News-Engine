/**
 * US News Engine — private recall article draft generator (Phase 7B).
 *
 * Reads data/recalls/recall-story-clusters.json, takes the HIGHEST-ranked
 * story (stories[0]) or a specific storyKey passed as argv[2], and writes
 * exactly ONE private structured article draft to
 * data/recalls/drafts/<slug>.json.
 *
 * Strict constraints:
 *   - ONE draft only. Drafts live ONLY under data/recalls/drafts/.
 *   - No AI. No publishing. No scheduling. No website changes.
 *   - Every factual statement must be traceable to the recall source data.
 *   - No invented numbers, quotes, or locations.
 *   - No clickbait. No implied injuries/deaths unless source states them.
 *
 * Run manually:
 *   node scripts/generate-recall-draft.mjs
 *   node scripts/generate-recall-draft.mjs "<storyKey>"
 */

import { readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(__dirname, '..');
const INPUT_FILE = join(
  PROJECT_DIR,
  'data',
  'recalls',
  'recall-story-clusters.json',
);
const OUTPUT_DIR = join(PROJECT_DIR, 'data', 'recalls', 'drafts');

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// ===========================================================================
// Helpers
// ===========================================================================

function fail(message, detail) {
  console.error(`\n[generate-recall-draft] ERROR: ${message}`);
  if (detail) console.error(`  Detail: ${detail}`);
  process.exit(1);
}

/**
 * Escape HTML special characters in a string so it can be safely embedded
 * in a paragraph that is rendered with set:html in the preview page.
 */
function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Wrap any URLs found in the text in <a> tags (rel=nofollow, target=_blank).
 * Used so consumer-action text that references a registration URL becomes a
 * clickable link in the preview without altering the original wording.
 */
function linkifyUrls(text) {
  // Match http(s) URLs ending at whitespace or end-of-string. Include common
  // trailing punctuation only when it's clearly part of the URL (slash).
  return String(text || '').replace(
    /(https?:\/\/[^\s<>"']+)/g,
    (url) => `<a href="${escapeHtml(url)}" rel="nofollow noopener" target="_blank">${escapeHtml(url)}</a>`,
  );
}

/**
 * Collapse whitespace in source text without changing capitalization.
 */
function cleanSourceText(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Normalize a string into a clean URL slug.
 * Lowercases, replaces non-alphanumerics with hyphens, collapses repeats.
 */
function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

/**
 * Title-case a slug-style product name so it reads naturally in the headline.
 * "fire truck activity board" → "Fire Truck Activity Board".
 * Preserves known acronyms (UPC, SKU, E. coli) and short all-caps tokens.
 */
function titleCaseProduct(text) {
  if (!text) return '';
  const cleaned = String(text).replace(/[_-]+/g, ' ').trim();
  // Preserve all-caps tokens that are likely acronyms (2-6 uppercase letters).
  const tokens = cleaned.split(/\s+/);
  return tokens
    .map((tok) => {
      // Keep acronyms / model numbers intact (e.g. "INMO", "AIR3", "5Color").
      if (/^[A-Z0-9]+$/.test(tok)) return tok;
      // Keep tokens that mix letters + digits (e.g. "AIR3", "5Color").
      if (/^[A-Za-z]+\d+$|^\d+[A-Za-z]+$/.test(tok)) return tok;
      // Otherwise title-case.
      return tok.charAt(0).toUpperCase() + tok.slice(1).toLowerCase();
    })
    .join(' ');
}

/**
 * Parse a "YYYY-MM-DD" or ISO timestamp into a Date. Returns null on failure.
 */
function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Format an ISO date for a human-readable "Month DD, YYYY" string.
 */
function formatLongDate(iso) {
  const d = parseDate(iso);
  if (!d) return null;
  return `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

// ===========================================================================
// Source/agency helpers
// ===========================================================================

function agencyName(source) {
  if (source === 'CPSC') return 'Consumer Product Safety Commission';
  if (source === 'FDA') return 'U.S. Food and Drug Administration';
  return source || 'the recalling agency';
}

function agencyShortName(source) {
  if (source === 'CPSC') return 'CPSC';
  if (source === 'FDA') return 'FDA';
  return source || 'the agency';
}

/**
 * Try to extract the recalling brand from a CPSC recall title that matches
 * the pattern "{Brand} Recalls {Product} Due to ...".
 * Returns { brand, product } or null.
 */
function parseCpscTitleBrand(title) {
  if (!title) return null;
  const m = String(title).match(/^([^,]+?)\s+Recalls\s+(.+?)\s+Due\s+To\b/i);
  if (!m) return null;
  let brand = m[1].trim();
  let product = m[2].trim();
  // Strip trailing retail-channel fragments like "; Sold Exclusively at Target".
  product = product.replace(/;.*$/, '').trim();
  // Trim trailing "Toys" / "Sets" only if the product is otherwise long enough.
  return { brand, product };
}

// ===========================================================================
// Hazard short-label derivation
// ===========================================================================

/**
 * Keyword → reader-facing short hazard label. Ordered by priority — the FIRST
 * match wins. This keeps the headline factual and consumer-friendly without
 * reproducing the long source hazard text verbatim.
 */
const HAZARD_LABEL_RULES = [
  { kw: 'carbon monoxide', label: 'Carbon Monoxide Hazard' },
  { kw: 'choking', label: 'Choking Hazard' },
  { kw: 'strangulation', label: 'Strangulation Hazard' },
  { kw: 'suffocation', label: 'Suffocation Hazard' },
  { kw: 'laceration', label: 'Laceration Hazard' },
  { kw: 'amputation', label: 'Amputation Hazard' },
  { kw: 'tip-over', label: 'Tip-Over Hazard' },
  { kw: 'electric shock', label: 'Electric Shock Hazard' },
  { kw: 'shock', label: 'Electric Shock Hazard' },
  { kw: 'electrocution', label: 'Electrocution Hazard' },
  { kw: 'explosion', label: 'Explosion Hazard' },
  { kw: 'fire', label: 'Fire Hazard' },
  { kw: 'burn', label: 'Burn Hazard' },
  { kw: 'poison', label: 'Poisoning Hazard' },
  { kw: 'lead', label: 'Lead Hazard' },
  { kw: 'salmonella', label: 'Salmonella Risk' },
  { kw: 'listeria', label: 'Listeria Risk' },
  { kw: 'e. coli', label: 'E. Coli Risk' },
  { kw: 'e coli', label: 'E. Coli Risk' },
  { kw: 'botulism', label: 'Botulism Risk' },
  { kw: 'undeclared allergen', label: 'Undeclared Allergen' },
  { kw: 'undeclared peanut', label: 'Undeclared Allergen' },
  { kw: 'undeclared milk', label: 'Undeclared Allergen' },
  { kw: 'undeclared egg', label: 'Undeclared Allergen' },
  { kw: 'undeclared soy', label: 'Undeclared Allergen' },
  { kw: 'undeclared wheat', label: 'Undeclared Allergen' },
  { kw: 'foreign material', label: 'Foreign Material Risk' },
  { kw: 'glass', label: 'Glass Fragment Risk' },
  { kw: 'metal', label: 'Metal Fragment Risk' },
  { kw: 'plastic', label: 'Plastic Fragment Risk' },
  { kw: 'contamination', label: 'Contamination Risk' },
  { kw: 'infection', label: 'Infection Risk' },
  { kw: 'sterility', label: 'Sterility Risk' },
  { kw: 'malfunction', label: 'Malfunction Risk' },
  { kw: 'failure', label: 'Failure Risk' },
  { kw: 'airway', label: 'Airway Risk' },
];

/**
 * Derive a short, reader-facing hazard label from the hazard + reason text.
 * Falls back to "Safety Risk" when no keyword matches.
 */
function deriveHazardLabel(hazard, reason) {
  const text = `${hazard || ''} ${reason || ''}`.toLowerCase();
  for (const rule of HAZARD_LABEL_RULES) {
    if (text.includes(rule.kw)) return rule.label;
  }
  return 'Safety Risk';
}

// ===========================================================================
// Headline + slug generation
// ===========================================================================

/**
 * Derive a clean, short product display name from the recallStoryKey.
 * Pattern: SOURCE__firm-slug__date__product-slug__hazard-slug
 * Returns a title-cased product name (e.g. "Breathing Circuits", "Alfalfa").
 */
function shortProductName(story) {
  const storyKeyParts = String(story.recallStoryKey || '').split('__');
  const productSlug = storyKeyParts[3] || '';
  return titleCaseProduct(productSlug);
}

/**
 * Derive the recalling-firm display name for use in the lead / description.
 * For CPSC recalls, the firm field is usually null — parse it from the
 * recall title ("X Recalls Y..."). For FDA recalls, use recallingFirm directly.
 */
function recallingFirmDisplay(story) {
  if (story.recallingFirm) return story.recallingFirm;
  if (story.brands && story.brands.length > 0) return story.brands[0];
  if (story.source === 'CPSC') {
    const cpscTitle = story.rawSourceData?.[0]?.title || '';
    const parsed = parseCpscTitleBrand(cpscTitle);
    if (parsed) return parsed.brand;
  }
  return null;
}

/**
 * Build a natural consumer-news headline, e.g.
 *   "Melissa & Doug Fire Truck Activity Board Recalled Over Choking Hazard"
 *
 * Strategy:
 *   - For CPSC: parse the brand from the CPSC recall title ("X Recalls Y...").
 *     Combine with the headlineSeed / primaryProductName as the product name.
 *     If no brand is derivable, use the product name alone.
 *   - For FDA: use the recalling firm + a short product name (from storyKey).
 *
 * Then append "Recalled Over {ShortHazard}".
 *
 * Keeps the headline under ~80 chars (truncates the product name if needed).
 */
function buildHeadline(story) {
  // Use the story's hazardNormalized from the clustering pipeline (source-backed).
  // Fall back to deriveHazardLabel only if hazardNormalized is null.
  const hazardLabel = story.hazardNormalized || deriveHazardLabel(story.hazard, story.reason);

  // --- CPSC path ---
  if (story.source === 'CPSC') {
    const firstRaw = story.rawSourceData?.[0] || {};
    const cpscTitle = firstRaw.title || '';
    const parsed = parseCpscTitleBrand(cpscTitle);
    let product = story.headlineSeed || story.primaryProductName || 'Product';
    let brand = null;
    if (parsed) {
      brand = parsed.brand;
      // Prefer the parsed product only if it's reasonably short; otherwise
      // fall back to the cleaner headlineSeed.
      if (parsed.product && parsed.product.length <= 50) product = parsed.product;
    }
    // Strip a leading brand from the product name to avoid repetition.
    if (brand && product.toLowerCase().startsWith(brand.toLowerCase())) {
      product = product.slice(brand.length).replace(/^[\s,-]+/, '').trim();
    }
    let headline = brand
      ? `${brand} ${product} Recalled Over ${hazardLabel}`
      : `${product} Recalled Over ${hazardLabel}`;
    // Hard cap at 80 chars — truncate the product portion if needed.
    if (headline.length > 80) {
      const over = headline.length - 80;
      const trimmedProduct = product.slice(0, Math.max(8, product.length - over - 1)).trim();
      headline = brand
        ? `${brand} ${trimmedProduct}… Recalled Over ${hazardLabel}`
        : `${trimmedProduct}… Recalled Over ${hazardLabel}`;
    }
    return headline;
  }

  // --- FDA path ---
  const firm = story.recallingFirm || 'Firm';
  // Use the slug-style product name embedded in the recallStoryKey.
  let product = shortProductName(story) || story.headlineSeed || 'Product';

  // Strip the firm name from the beginning of the product to avoid duplication
  // (e.g. "Medline Industries, LP Medline breathing circuits" → "breathing circuits")
  const firmLower = firm.toLowerCase();
  if (product.toLowerCase().startsWith(firmLower)) {
    product = product.slice(firm.length).replace(/^[\s,-]+/, '').trim();
  }
  // Also strip common firm suffixes from the product
  product = product.replace(/^(medline|hudson rci)\s+/i, '').trim();

  let headline = `${firm} ${product} Recalled Over ${hazardLabel}`;
  if (headline.length > 80) {
    const over = headline.length - 80;
    const trimmedProduct = product.slice(0, Math.max(8, product.length - over - 1)).trim();
    headline = `${firm} ${trimmedProduct}… Recalled Over ${hazardLabel}`;
  }
  return headline;
}

/**
 * Build a clean URL slug from the headline + recall date.
 * Pattern: "{headline-slug}-{YYYY-MM-DD}" for uniqueness across recalls.
 */
function buildSlug(story, headline) {
  // Strip the "Recalled Over ..." tail so the slug focuses on identity.
  const baseName = headline.replace(/\s+Recalled Over\s+.+$/i, '');
  const date = parseDate(story.recallDates?.[0]);
  const dateStr = date
    ? `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
    : '';
  const slugBase = slugify(baseName);
  return dateStr ? `${slugBase}-${dateStr}` : slugBase;
}

// ===========================================================================
// Breaking flag
// ===========================================================================

/**
 * A story is breaking ONLY when:
 *   - The source explicitly reports one or more deaths, OR
 *   - For FDA: it is Class I AND the hazard text contains a serious-hazard
 *     keyword (death, serious injury, life-threatening, etc.), OR
 *   - For CPSC: the hazard text contains "death" or "serious injury or death".
 *
 * Never break on a Class I recall alone — many Class I recalls are precautionary.
 */
function deriveBreaking(story) {
  if (story.deaths) {
    const n = parseInt(String(story.deaths).replace(/\D/g, ''), 10);
    if (n > 0) return true;
  }
  const text = `${story.hazard || ''} ${story.reason || ''}`.toLowerCase();
  if (/\bdeath\b|fatal|life-threatening/.test(text)) return true;
  // CPSC titles often say "Risk of Serious Injury or Death".
  const cpscTitle = story.rawSourceData?.[0]?.title || '';
  if (/serious injury or death/i.test(cpscTitle)) return true;
  return false;
}

// ===========================================================================
// Location derivation from distribution text
// ===========================================================================

/**
 * Derive a short, reader-facing location string from the distribution field.
 * Returns "Nationwide" for US nationwide distribution, "Worldwide" if the
 * distribution explicitly mentions worldwide, or a list of US states if a
 * bounded state list is named. Falls back to null if no safe derivation.
 */
function deriveLocation(distribution) {
  if (!distribution) return null;
  const dist = String(distribution).trim();
  const lower = dist.toLowerCase();

  // Worldwide (FDA device recalls sometimes say "Worldwide distribution - US Nationwide and ...")
  if (/worldwide/.test(lower)) return 'Worldwide distribution';

  // US Nationwide
  if (/us nationwide|nationwide\s+distribution/.test(lower)) return 'Nationwide';

  // Otherwise, try to parse a list of US state abbreviations.
  const STATE_ABBRS = [
    'AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN',
    'IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH',
    'NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT',
    'VT','VA','WA','WV','WI','WY','PR','VI',
  ];
  const found = new Set();
  for (const abbr of STATE_ABBRS) {
    const re = new RegExp(`\\b${abbr}\\b`);
    if (re.test(dist)) found.add(abbr);
  }
  if (found.size >= 5) {
    return `${found.size} states`;
  }
  if (found.size > 0 && found.size < 5) {
    return `${Array.from(found).join(', ')}`;
  }
  return null;
}

// ===========================================================================
// Body section builders
// ===========================================================================

/**
 * Lead paragraph (no heading): what happened, what product, what hazard.
 * Factual, no inflated severity.
 */
function buildLeadParagraph(story, agencyFullName) {
  const firm = recallingFirmDisplay(story);
  // For FDA, the short product name (from storyKey) reads much better than
  // the long primaryProductName (which can be a multi-SKU manifest). For
  // CPSC, the headlineSeed / primaryProductName is already short and clean.
  const product = story.source === 'FDA'
    ? (shortProductName(story) || story.headlineSeed || story.primaryProductName || 'a product')
    : (story.headlineSeed || story.primaryProductName || 'a product');
  const hazardLabel = story.hazardNormalized || deriveHazardLabel(story.hazard, story.reason);

  // Two natural variants depending on whether we have a firm name.
  const actor = firm || 'A manufacturer';
  let lead = `${actor} is recalling ${product} because of a ${hazardLabel.toLowerCase()}, according to the ${agencyFullName}.`;
  // If we have a recall date, append it.
  const dateStr = formatLongDate(story.recallDates?.[0]);
  if (dateStr) {
    lead += ` The recall was initiated on ${dateStr}.`;
  }
  return lead;
}

/**
 * "What is being recalled" — product description from the source.
 * For CPSC, the rawSourceData.Description is the most authoritative source.
 * For FDA, the productName field contains the product description.
 */
function buildWhatIsBeingRecalled(story) {
  const paras = [];
  if (story.source === 'CPSC') {
    const desc = story.rawSourceData?.[0]?.description || story.rawSourceData?.[0]?.Description;
    if (desc) {
      paras.push(escapeHtml(cleanSourceText(desc)));
    } else if (story.primaryProductName) {
      paras.push(escapeHtml(`The recalled product is ${story.primaryProductName}.`));
    }
  } else {
    // FDA
    if (story.primaryProductName) {
      paras.push(escapeHtml(cleanSourceText(story.primaryProductName)));
    }
  }
  return paras;
}

/**
 * "Why it is being recalled" — hazard/reason from the source.
 * CPSC: hazard field. FDA: hazard + reason fields.
 */
function buildWhyRecalled(story) {
  const paras = [];
  if (story.source === 'CPSC') {
    if (story.hazard) {
      paras.push(escapeHtml(cleanSourceText(story.hazard)));
    }
  } else {
    // FDA — reason is the detailed narrative.
    if (story.reason) {
      paras.push(escapeHtml(cleanSourceText(story.reason)));
    } else if (story.hazard) {
      paras.push(escapeHtml(cleanSourceText(story.hazard)));
    }
  }
  return paras;
}

/**
 * "Products and models affected" — model numbers, lot numbers, UPCs.
 * For CPSC, the rawSourceData may contain ProductUPCs and Products[].Model.
 * For FDA, the rawSourceData.code_info field often has lot/model/UDI detail.
 */
function buildProductsAndModels(story) {
  const paras = [];
  const lines = [];

  if (story.source === 'CPSC') {
    const raw = story.rawSourceData?.[0] || {};
    // Products array — name + model + units
    if (Array.isArray(raw.Products) && raw.Products.length > 0) {
      for (const p of raw.Products) {
        const parts = [];
        if (p.Name) parts.push(p.Name);
        if (p.Model) parts.push(`Model ${p.Model}`);
        if (p.NumberOfUnits) parts.push(`${p.NumberOfUnits} units`);
        if (parts.length > 0) lines.push(parts.join(' · '));
      }
    }
    // UPCs
    if (Array.isArray(raw.ProductUPCs) && raw.ProductUPCs.length > 0) {
      for (const u of raw.ProductUPCs) {
        if (u && u.UPC) lines.push(`UPC ${u.UPC}`);
      }
    }
  } else {
    // FDA — code_info / more_code_info
    const raw = story.rawSourceData?.[0] || {};
    // rawSourceData here is the normalized record, so its top-level fields
    // come from our recall schema. The original FDA fields live under
    // rawSourceData.rawSourceData... but our pipeline flattened them.
    // The cluster's rawSourceData is the normalized record we wrote —
    // it does not preserve code_info. We use the cluster-level modelNumbers,
    // lotNumbers, upcs arrays instead (which were derived in build-recall-stories).
    if (Array.isArray(story.modelNumbers) && story.modelNumbers.length > 0) {
      for (const m of story.modelNumbers) lines.push(`Model ${m}`);
    }
    if (Array.isArray(story.lotNumbers) && story.lotNumbers.length > 0) {
      for (const l of story.lotNumbers) lines.push(`Lot ${l}`);
    }
    if (Array.isArray(story.upcs) && story.upcs.length > 0) {
      for (const u of story.upcs) lines.push(`UPC ${u}`);
    }
  }

  // Also include cluster-level model/lot/upc arrays for CPSC (when available).
  if (story.source === 'CPSC') {
    if (Array.isArray(story.modelNumbers) && story.modelNumbers.length > 0) {
      for (const m of story.modelNumbers) {
        if (!lines.some((l) => l.includes(`Model ${m}`))) {
          lines.push(`Model ${m}`);
        }
      }
    }
    if (Array.isArray(story.lotNumbers) && story.lotNumbers.length > 0) {
      for (const l of story.lotNumbers) {
        if (!lines.some((li) => li.includes(`Lot ${l}`))) {
          lines.push(`Lot ${l}`);
        }
      }
    }
    if (Array.isArray(story.upcs) && story.upcs.length > 0) {
      for (const u of story.upcs) {
        if (!lines.some((l) => l.includes(`UPC ${u}`))) {
          lines.push(`UPC ${u}`);
        }
      }
    }
  }

  if (lines.length > 0) {
    // Render as a single bulleted-style paragraph with HTML line breaks.
    paras.push(lines.map((l) => `• ${escapeHtml(l)}`).join('<br>'));
  }
  return paras;
}

/**
 * "Where it was sold or distributed" — distribution info.
 * For CPSC: SoldAtLabel + Retailers. For FDA: distribution field.
 */
function buildDistribution(story) {
  const paras = [];
  if (story.source === 'CPSC') {
    const raw = story.rawSourceData?.[0] || {};
    const soldAt = raw.SoldAtLabel;
    if (soldAt && String(soldAt).trim()) {
      paras.push(escapeHtml(cleanSourceText(soldAt)));
    }
    if (Array.isArray(raw.Retailers) && raw.Retailers.length > 0) {
      const names = raw.Retailers.map((r) => r.Name).filter(Boolean).map((n) => cleanSourceText(n));
      if (names.length > 0) {
        paras.push(escapeHtml(`Sold at: ${names.join('; ')}.`));
      }
    }
  }
  // Both sources can carry the cluster-level distribution field.
  if (paras.length === 0 && story.distribution) {
    paras.push(escapeHtml(cleanSourceText(story.distribution)));
  }
  return paras;
}

/**
 * "What consumers should do" — official remedy / consumer action.
 *
 * CPSC: preserve the official remedy text verbatim (with URLs linkified).
 * FDA: if no explicit consumer instruction is provided, use a factual
 *      fallback that does NOT invent "throw it away" or "return it".
 */
function buildConsumerAction(story) {
  if (story.source === 'CPSC') {
    if (story.consumerAction) {
      return [linkifyUrls(escapeHtml(cleanSourceText(story.consumerAction)))];
    }
    // Fallback — factual, no invented action.
    return ['Consumers can review the CPSC recall record for product details and remedy instructions.'];
  }

  // FDA — only use consumerAction if the source explicitly provided one.
  // FDA enforcement reports do not typically include a consumer-action field.
  if (story.consumerAction && String(story.consumerAction).trim()) {
    return [linkifyUrls(escapeHtml(cleanSourceText(story.consumerAction)))];
  }
  return ['Consumers can review the FDA recall record for product and distribution details.'];
}

/**
 * "Reported incidents or injuries" — only if the source explicitly reports
 * them. Preserves text exactly. Does NOT inflate "one minor cut" into a
 * serious-injury claim.
 *
 * Returns null if no incidents/injuries/deaths are reported (so the section
 * is skipped entirely).
 */
function buildIncidents(story) {
  const out = [];
  const NONE_PATTERNS = /^none\s+reported|no\s+incidents|no\s+injuries|no\s+reports|0\s*reported/i;

  // Distinguish incidents from injuries from deaths — never conflate them.
  if (story.deaths && !NONE_PATTERNS.test(String(story.deaths).trim())) {
    const text = cleanSourceText(story.deaths).replace(/\.+$/, '');
    out.push(`Deaths: ${escapeHtml(text)}.`);
  }
  if (story.injuries && !NONE_PATTERNS.test(String(story.injuries).trim())) {
    const text = cleanSourceText(story.injuries).replace(/\.+$/, '');
    out.push(`Injuries: ${escapeHtml(text)}.`);
  }
  if (story.incidents && !NONE_PATTERNS.test(String(story.incidents).trim())) {
    const text = cleanSourceText(story.incidents).replace(/\.+$/, '');
    out.push(`Incidents: ${escapeHtml(text)}.`);
  }

  // CPSC carries injuries in the rawSourceData.Injuries array. The cluster
  // pipeline copied the FIRST injury text into story.injuries, so the above
  // branch handles the common case. We don't double-count here.
  if (out.length === 0) return null;
  return out;
}

/**
 * "Source" — attribution paragraph.
 */
function buildSourceParagraph(story, agencyFullName) {
  const agencyShort = agencyShortName(story.source);
  const dateStr = formatLongDate(story.recallDates?.[0]);
  const dateClause = dateStr ? ` initiated on ${dateStr}` : '';
  return `This article was produced from an official ${agencyShort} recall record${dateClause}. ${agencyFullName} is the original source of this recall notice.`;
}

// ===========================================================================
// Draft generation
// ===========================================================================

function generateDraft(story, now) {
  const agencyFullName = agencyName(story.source);
  const title = buildHeadline(story);
  const slug = buildSlug(story, title);
  const location = deriveLocation(story.distribution);
  const breaking = deriveBreaking(story);
  const sourceUrl = story.sourceUrls?.[0] || '';
  const sourceOffice = agencyFullName;

  // --- Description (1-2 sentence deck) ------------------------------------
  const hazardLabel = story.hazardNormalized || deriveHazardLabel(story.hazard, story.reason);
  const firm = recallingFirmDisplay(story) || 'A manufacturer';
  // Use the short product name for FDA (the long primaryProductName can be a
  // multi-SKU manifest that doesn't read well in a deck). For CPSC, the
  // headlineSeed is already clean.
  const product = story.source === 'FDA'
    ? (shortProductName(story) || story.headlineSeed || story.primaryProductName || 'a product')
    : (story.headlineSeed || story.primaryProductName || 'a product');
  let description = `${firm} is recalling ${product} over a ${hazardLabel.toLowerCase()}.`;
  if (location) {
    description += ` Distribution: ${location.toLowerCase()}.`;
  }
  description = description.slice(0, 200);

  // --- SEO ----------------------------------------------------------------
  const seoTitle = title.slice(0, 60);
  const seoDescription = description.slice(0, 160);

  // --- Timestamps ---------------------------------------------------------
  const publishedAt = now.toISOString();
  const updatedAt = null;

  // --- Body sections (skip empty) -----------------------------------------
  const body = [];

  // 1. Lead paragraph (no heading)
  const lead = buildLeadParagraph(story, agencyFullName);
  body.push({ heading: null, paragraphs: [escapeHtml(lead)] });

  // 2. What is being recalled
  const whatParas = buildWhatIsBeingRecalled(story);
  if (whatParas.length > 0) {
    body.push({ heading: 'What is being recalled', paragraphs: whatParas });
  }

  // 3. Why it is being recalled
  const whyParas = buildWhyRecalled(story);
  if (whyParas.length > 0) {
    body.push({ heading: 'Why it is being recalled', paragraphs: whyParas });
  }

  // 4. Products and models affected
  const modelParas = buildProductsAndModels(story);
  if (modelParas.length > 0) {
    body.push({ heading: 'Products and models affected', paragraphs: modelParas });
  }

  // 5. Where it was sold or distributed
  const distParas = buildDistribution(story);
  if (distParas.length > 0) {
    body.push({ heading: 'Where it was sold or distributed', paragraphs: distParas });
  }

  // 6. What consumers should do
  const actionParas = buildConsumerAction(story);
  body.push({ heading: 'What consumers should do', paragraphs: actionParas });

  // 7. Reported incidents or injuries (only if source explicitly reports)
  const incidentParas = buildIncidents(story);
  if (incidentParas !== null) {
    body.push({ heading: 'Reported incidents or injuries', paragraphs: incidentParas });
  }

  // 8. Source
  body.push({
    heading: 'Source',
    paragraphs: [escapeHtml(buildSourceParagraph(story, agencyFullName))],
  });

  // --- recallMetadata ----------------------------------------------------
  const recallMetadata = {
    source: story.source,
    sourceType: story.sourceType,
    recallingFirm: story.recallingFirm || null,
    manufacturer: story.manufacturer || null,
    brands: Array.isArray(story.brands) ? story.brands : [],
    primaryProductName: story.primaryProductName || null,
    hazard: story.hazard || null,
    reason: story.reason || null,
    classification: story.classification || null,
    recallDates: Array.isArray(story.recallDates) ? story.recallDates : [],
    reportDates: Array.isArray(story.reportDates) ? story.reportDates : [],
    distribution: story.distribution || null,
    affectedStates: story.affectedStates || null,
    units: story.units || null,
    modelNumbers: Array.isArray(story.modelNumbers) ? story.modelNumbers : [],
    lotNumbers: Array.isArray(story.lotNumbers) ? story.lotNumbers : [],
    upcs: Array.isArray(story.upcs) ? story.upcs : [],
    incidents: story.incidents || null,
    injuries: story.injuries || null,
    deaths: story.deaths || null,
    consumerAction: story.consumerAction || null,
    recordCount: story.recordCount || 1,
    storyScore: story.storyScore || 0,
    storyScoreReasons: Array.isArray(story.storyScoreReasons) ? story.storyScoreReasons : [],
    storyStatus: story.storyStatus || 'new',
    firstSeenAt: story.firstSeenAt || null,
    latestSeenAt: story.latestSeenAt || null,
  };

  return {
    draftVersion: 1,
    generatedAt: now.toISOString(),
    storyKey: story.recallStoryKey,
    sourceRecallIds: Array.isArray(story.sourceRecallIds) ? story.sourceRecallIds : [],
    status: 'draft',
    title,
    description,
    slug,
    category: 'recalls',
    location,
    publishedAt,
    updatedAt,
    breaking,
    author: 'US News Engine Consumer Safety Desk',
    sourceName: agencyFullName,
    sourceUrl,
    sourceOffice,
    hasUpdates: false,
    seo: { title: seoTitle, description: seoDescription },
    image: {
      status: 'pending',
      url: null,
      alt: null,
      source: null,
      license: null,
    },
    body,
    recallMetadata,
  };
}

// ===========================================================================
// Main
// ===========================================================================

async function main() {
  console.log('[generate-recall-draft] Starting private draft generation.');
  console.log(`  Input:  ${INPUT_FILE}`);

  let raw;
  try {
    raw = await readFile(INPUT_FILE, 'utf8');
  } catch (err) {
    return fail(
      'Could not read input file. Run `npm run cluster:recalls` first.',
      String(err),
    );
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    return fail('Input file is not valid JSON.', String(err));
  }
  const stories = Array.isArray(doc.stories) ? doc.stories : [];
  if (stories.length === 0) {
    return fail('No recall stories available. Nothing to draft.');
  }

  // Select the story — accept a storyKey as argv[2], otherwise use stories[0].
  const targetStoryKey = process.argv[2];
  const story = targetStoryKey
    ? stories.find((s) => s.recallStoryKey === targetStoryKey)
    : stories[0];
  if (!story) {
    return fail(
      `Story not found: ${targetStoryKey}`,
      `Available stories: ${stories.map((s) => s.recallStoryKey).slice(0, 5).join(', ')}...`,
    );
  }
  const now = new Date();
  console.log(`  Selected story: ${story.recallStoryKey} (score=${story.storyScore})`);
  console.log(`  Source: ${story.source} / ${story.sourceType} | Firm: ${story.recallingFirm || 'n/a'}`);

  const draft = generateDraft(story, now);

  // --- Write exactly one draft file (overwrite) ----------------------------
  await mkdir(OUTPUT_DIR, { recursive: true });
  const outFile = join(OUTPUT_DIR, `${draft.slug}.json`);
  const tmp = `${outFile}.tmp`;
  await writeFile(tmp, JSON.stringify(draft, null, 2) + '\n', 'utf8');
  await rename(tmp, outFile);

  // --- Word count ----------------------------------------------------------
  let wordCount = 0;
  for (const sec of draft.body) {
    for (const p of sec.paragraphs) {
      // Strip HTML tags before counting words.
      const plain = String(p).replace(/<[^>]+>/g, ' ');
      wordCount += plain.split(/\s+/).filter(Boolean).length;
    }
  }
  wordCount += draft.description.split(/\s+/).filter(Boolean).length;

  const stats = await stat(outFile);
  console.log('\n[generate-recall-draft] SUCCESS — exactly one draft written.');
  console.log(`  Output file:  ${outFile}`);
  console.log(`  File size:    ${stats.size.toLocaleString()} bytes`);
  console.log(`  Title:        ${draft.title} (${draft.title.length} chars)`);
  console.log(`  Slug:         ${draft.slug}`);
  console.log(`  Breaking:     ${draft.breaking}`);
  console.log(`  Location:     ${draft.location || 'n/a'}`);
  console.log(`  Source:       ${draft.sourceName}`);
  console.log(`  Sections:     ${draft.body.length}`);
  console.log(`  Word count:   ~${wordCount}`);
  console.log(`  Recall IDs:   ${draft.sourceRecallIds.length}`);
  console.log(`  SEO title:    ${draft.seo.title} (${draft.seo.title.length} chars)`);
  console.log(`  SEO desc:     ${draft.seo.description.length} chars`);
  console.log('');
}

main().catch((err) =>
  fail('Unexpected failure.', String(err && err.stack ? err.stack : err)),
);
