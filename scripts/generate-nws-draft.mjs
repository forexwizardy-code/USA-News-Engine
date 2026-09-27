/**
 * US News Engine — private NWS article draft generator (Phase 3E).
 *
 * Reads data/nws-story-records.json, takes the HIGHEST-ranked story
 * (stories[0]), and writes exactly ONE private structured article draft to
 * data/drafts/<storyKey>.json.
 *
 * Phase 3E improvements over 3D:
 *   - Preserves NWS proper-noun capitalization (no blind lowercasing).
 *   - Natural, non-robotic reader-facing prose.
 *   - Human-friendly dates with safe U.S. timezone abbreviations.
 *   - Concise headline (~<= 70 chars).
 *   - Concise safety-guidance summary (not verbatim instruction).
 *   - No internal technical details (zone counts, alert IDs) in reader copy.
 *   - originalInstruction preserved in metadata.
 *
 * Strict constraints:
 *   - ONE draft only. Drafts live ONLY under data/drafts/.
 *   - No AI. No publishing. No scheduling. No website changes.
 *   - Every factual statement must be traceable to the NWS story record.
 *
 * Run manually:
 *   npm run draft:nws
 *   (or) bun run draft:nws
 */

import { readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(__dirname, '..');
const INPUT_FILE = join(PROJECT_DIR, 'data', 'nws-story-records.json');
const OUTPUT_DIR = join(PROJECT_DIR, 'data', 'drafts');

// ===========================================================================
// U.S. state + DC abbreviation map (for safe location normalization)
// ===========================================================================
const STATE_NAME_BY_ABBR = {
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
  PR: 'Puerto Rico', VI: 'U.S. Virgin Islands', GU: 'Guam', AS: 'American Samoa',
  MP: 'Northern Mariana Islands',
};

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const DAY_NAMES = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
];

// ===========================================================================
// Helpers
// ===========================================================================

function fail(message, detail) {
  console.error(`\n[generate-nws-draft] ERROR: ${message}`);
  if (detail) console.error(`  Detail: ${detail}`);
  process.exit(1);
}

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Parse the LOCAL components (year, month, day, hour, minute) and the UTC
 * offset directly from an ISO-8601 string like
 * "2026-09-27T10:28:00-05:00". This avoids any reliance on the host system
 * timezone and lets us format the time as it was locally recorded.
 */
function parseIsoLocal(iso) {
  if (!iso) return null;
  const m = String(iso).match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})([+-])(\d{2}):(\d{2})$/,
  );
  if (!m) return null;
  const [, year, month, day, hour, minute, , offsetH, offsetM] = m;
  const offsetMinutes =
    (m[7] === '-' ? -1 : 1) * (parseInt(offsetH, 10) * 60 + parseInt(offsetM, 10));
  // Build a Date for day-of-week calculation. We construct it from the LOCAL
  // components so getDay() reflects the local weekday, not UTC.
  const localDate = new Date(
    parseInt(year, 10),
    parseInt(month, 10) - 1,
    parseInt(day, 10),
    parseInt(hour, 10),
    parseInt(minute, 10),
  );
  return {
    year: parseInt(year, 10),
    month: parseInt(month, 10), // 1-12
    day: parseInt(day, 10),
    hour: parseInt(hour, 10),
    minute: parseInt(minute, 10),
    offsetMinutes, // e.g. -300 for UTC-5
    localDate,
  };
}

/**
 * Determine whether a given local date falls within U.S. Daylight Saving Time.
 * DST starts the second Sunday of March and ends the first Sunday of November.
 * Used only as a tiebreaker for timezone-abbreviation derivation.
 */
function isUSDST(date) {
  const year = date.getFullYear();
  // Second Sunday of March
  let dstStart = null;
  let sundayCount = 0;
  for (let d = 1; d <= 14; d++) {
    const test = new Date(year, 2, d);
    if (test.getDay() === 0) {
      sundayCount++;
      if (sundayCount === 2) {
        dstStart = test;
        break;
      }
    }
  }
  // First Sunday of November
  let dstEnd = null;
  for (let d = 1; d <= 7; d++) {
    const test = new Date(year, 10, d);
    if (test.getDay() === 0) {
      dstEnd = test;
      break;
    }
  }
  if (!dstStart || !dstEnd) return false;
  return date >= dstStart && date < dstEnd;
}

/**
 * Derive a safe U.S. timezone abbreviation for a parsed ISO timestamp.
 *
 * Strategy (in order of safety):
 *   1. Extract the TZ abbreviation directly from the NWS headline (most
 *      reliable — it's the NWS's own abbreviation for the alert's local time).
 *   2. Map the numeric UTC offset + DST status to a standard U.S. abbreviation.
 *   3. Fall back to a numeric "UTC±HH:MM" string if neither is safe.
 *
 * Hawaii (UTC-10) never observes DST → always HST.
 */
function deriveTimezoneAbbr(parsed, headline) {
  if (!parsed) return null;

  // 1) Extract from NWS headline if present.
  // NWS headlines look like: "...issued September 27 at 10:28AM CDT until..."
  if (headline) {
    const hm = String(headline).match(/\d{1,2}:\d{2}[AP]M\s+([A-Z]{2,5})\b/);
    if (hm) return hm[1];
  }

  // 2) Offset + DST heuristic.
  const offsetHours = -parsed.offsetMinutes / 60; // e.g. UTC-5 → 5
  const dst = isUSDST(parsed.localDate);

  // Hawaii never observes DST.
  if (offsetHours === 10) return 'HST';

  const dstMap = { 4: 'EDT', 5: 'CDT', 6: 'MDT', 7: 'PDT', 8: 'AKDT' };
  const stdMap = { 5: 'EST', 6: 'CST', 7: 'MST', 8: 'PST', 9: 'AKST' };

  if (dst && dstMap[offsetHours]) return dstMap[offsetHours];
  if (!dst && stdMap[offsetHours]) return stdMap[offsetHours];

  // 3) Numeric fallback.
  const sign = parsed.offsetMinutes <= 0 ? '-' : '+';
  const absH = Math.floor(Math.abs(parsed.offsetMinutes) / 60);
  return `UTC${sign}${String(absH).padStart(2, '0')}`;
}

/**
 * Format an ISO timestamp into reader-friendly U.S. prose.
 *
 * Produces: "Sunday, September 27 at 10:28 a.m. CDT"
 *
 * Rules:
 *   - Day of week derived from the LOCAL date in the timestamp.
 *   - Year omitted when the date is within the current calendar year.
 *   - lowercase a.m. / p.m.
 *   - Timezone abbreviation derived safely (see deriveTimezoneAbbr).
 *   - No timezone conversion — preserves the original offset's local time.
 */
function readableTime(iso, headline) {
  const parsed = parseIsoLocal(iso);
  if (!parsed) return null;

  const now = new Date();
  const isCurrentYear = parsed.year === now.getFullYear();

  const monthName = MONTH_NAMES[parsed.month - 1];
  const dateStr = isCurrentYear
    ? `${monthName} ${parsed.day}`
    : `${monthName} ${parsed.day}, ${parsed.year}`;

  const dayOfWeek = DAY_NAMES[parsed.localDate.getDay()];

  const h = parsed.hour;
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  const ampm = h < 12 ? 'a.m.' : 'p.m.';
  const timeStr = `${h12}:${String(parsed.minute).padStart(2, '0')} ${ampm}`;

  const tzAbbr = deriveTimezoneAbbr(parsed, headline);

  return `${dayOfWeek}, ${dateStr} at ${timeStr}${tzAbbr ? ' ' + tzAbbr : ''}`;
}

/**
 * Format just the day-of-week + date portion (no time), e.g. "Monday afternoon"
 * or "Monday". Used for natural prose like "through Monday afternoon".
 */
function readableDay(iso) {
  const parsed = parseIsoLocal(iso);
  if (!parsed) return null;
  return DAY_NAMES[parsed.localDate.getDay()];
}

/**
 * Normalize an NWS areaDesc segment like "Lake, IL" into
 * "Lake County, Illinois". Returns null if the format is ambiguous.
 */
function normalizeArea(areaDesc) {
  if (!areaDesc) return null;
  const first = String(areaDesc).split(';')[0].trim();
  const m = first.match(/^(.*?),\s*([A-Z]{2})$/);
  if (!m) return null;
  const rawName = m[1].trim();
  const abbr = m[2];
  const stateName = STATE_NAME_BY_ABBR[abbr];
  if (!stateName) return null;
  const name = /county$/i.test(rawName) ? rawName : `${rawName} County`;
  return { display: `${name}, ${stateName}`, state: stateName, stateAbbr: abbr, raw: first };
}

/**
 * Build a clean public slug from event + display location + date.
 */
function buildSlug(event, locationDisplay, effective) {
  const parts = [];
  if (event) parts.push(event.toLowerCase());
  if (locationDisplay) {
    parts.push(locationDisplay.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
  }
  const parsed = parseIsoLocal(effective);
  if (parsed) {
    parts.push(MONTH_NAMES[parsed.month - 1].toLowerCase(), String(parsed.day), String(parsed.year));
  }
  return parts
    .join('-')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Collapse whitespace in source text without changing capitalization.
 * Preserves original NWS casing (proper nouns etc.).
 */
function cleanSourceText(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Lowercase ONLY the first character of a string. Used when embedding an NWS
 * fragment mid-sentence where the first word is a common noun (WHAT/WHEN/
 * IMPACTS fields typically start with common nouns like "Minor", "Until").
 *
 * For WHERE fields (which start with proper nouns like "Des Plaines River"),
 * do NOT use this — preserve the original capitalization entirely.
 */
function lowercaseFirst(text) {
  if (!text) return text;
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/**
 * Tidy an NWS bullet-point fragment: strip the leading label punctuation
 * ("..."), collapse whitespace, and return with original capitalization
 * preserved. The first letter is NOT changed (callers decide whether to
 * lowercase it based on context).
 */
function tidyFragment(text) {
  return cleanSourceText(text)
    .replace(/^[\s.]+/, '') // strip leading dots/whitespace from "...WHAT"
    .replace(/[\s.]+$/, '') // strip trailing dots/whitespace
    .replace(/\s+/g, ' ');
}

/**
 * Extract a labeled section (* WHAT... / * WHERE... / etc.) from the NWS
 * description text. Returns the raw fragment with original capitalization.
 */
function extractLabeled(description, label) {
  if (!description) return null;
  const cleaned = cleanSourceText(description);
  const re = new RegExp(`\\*\\s*${label}\\s*[\\.\\.\\.]*([\\s\\S]*?)(?=\\n\\s*\\*|$)`, 'i');
  const m = cleaned.match(re);
  return m ? tidyFragment(m[1]) : null;
}

/**
 * Extract the ADDITIONAL DETAILS bullet points from the NWS description.
 * Unlike extractLabeled (which collapses newlines), this preserves the
 * bullet-point structure so each datum can be processed individually.
 *
 * Returns an array of cleaned bullet strings (labels stripped, URLs dropped,
 * AM/PM normalized to a.m./p.m. for consistency with reader-facing times).
 */
function extractDetailBullets(description) {
  if (!description) return [];
  const cleaned = cleanSourceText(description);
  const re = /\*\s*ADDITIONAL DETAILS\s*[\.…]*([\s\S]*?)(?=\n\s*\*|$)/i;
  const m = cleaned.match(re);
  if (!m) return [];
  const raw = m[1].trim();
  // Split on newline + dash (the NWS bullet marker "- ").
  return raw
    .split(/\n\s*-\s*/)
    .map((s) => s.replace(/^-\s*/, '').replace(/\n/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    // Strip NWS sub-labels like "Recent Activity..." / "Forecast..."
    .map((s) => s.replace(/^(Recent Activity|Forecast|Additional Details)[\.…]*/i, '').trim())
    // Drop URLs (safety links etc.)
    .filter((s) => !/^https?:\/\//i.test(s))
    // Normalize AM/PM to a.m./p.m. for consistency with reader-facing times.
    .map((s) => s.replace(/\bAM\b/g, 'a.m.').replace(/\bPM\b/g, 'p.m.'))
    .filter(Boolean);
}

/**
 * Build a concise summary of the official NWS instruction text.
 * Extracts actionable guidance sentences and presents them with attribution.
 * Drops boilerplate ("Additional information", "next statement") from the
 * reader-facing summary. The full original text is preserved separately in
 * metadata as originalInstruction.
 */
function summarizeInstruction(instruction) {
  if (!instruction) return null;
  // Join wrapped lines (single newline → space) so sentences aren't split
  // mid-sentence, then split on real sentence boundaries.
  const cleaned = cleanSourceText(instruction).replace(/([^\n])\n([^\n])/g, '$1 $2');

  // Split on period + whitespace + capital letter — this avoids breaking on
  // periods inside URLs (e.g. "www.weather.gov") or abbreviations.
  const sentences = cleaned
    .split(/\.\s+(?=[A-Z])/)
    .map((s) => tidyFragment(s))
    .filter(Boolean)
    // Drop boilerplate that isn't useful reader guidance.
    .filter((s) => !/^(additional information|the next statement|for more information)/i.test(s));

  if (sentences.length === 0) return null;

  // Prefer actionable guidance ("should") and definitions ("means").
  const advice = sentences.find((s) => /\bshould\b/i.test(s));
  const definition = sentences.find((s) => /\bmeans\b/i.test(s));
  const parts = [];
  if (advice) {
    parts.push(
      `The National Weather Service advises that ${lowercaseFirst(advice)}`.replace(/\.$/, '') + '.',
    );
  }
  if (definition) {
    parts.push(
      `The agency said ${lowercaseFirst(definition)}`.replace(/\.$/, '') + '.',
    );
  }
  if (parts.length === 0) {
    // Fallback: use the first substantive sentence.
    parts.push(
      `The National Weather Service advises that ${lowercaseFirst(sentences[0])}`.replace(/\.$/, '') + '.',
    );
  }
  return parts.join(' ');
}

// ===========================================================================
// Draft generation
// ===========================================================================

function generateDraft(story, now) {
  const event = story.event || 'Weather Alert';
  const areaDesc = story.areaDesc || '';
  const areaInfo = normalizeArea(areaDesc);
  const locationDisplay = areaInfo ? areaInfo.display : areaDesc || 'the affected area';

  // --- Parse NWS description fields ----------------------------------------
  const whatFrag = extractLabeled(story.description, 'WHAT');
  const whereFrag = extractLabeled(story.description, 'WHERE');
  const whenFrag = extractLabeled(story.description, 'WHEN');
  const impactsFrag = extractLabeled(story.description, 'IMPACTS');
  const detailBullets = extractDetailBullets(story.description);

  // --- Headline (concise, <= ~70 chars) ------------------------------------
  const title = `${event} Issued for ${locationDisplay}`;

  // --- Human-friendly times ------------------------------------------------
  const effReadable = readableTime(story.effective, story.headline);
  const expReadable = readableTime(story.expires, story.headline);
  const endsReadable = readableTime(story.ends, story.headline);
  const effDay = readableDay(story.effective);
  const endsDay = readableDay(story.ends);

  // --- Description (1-2 sentences, natural, not repeating headline) --------
  const descParts = [];
  if (whatFrag) {
    descParts.push(
      `The NWS said ${lowercaseFirst(whatFrag)}`,
    );
  } else {
    descParts.push(`The NWS has issued a ${event} for ${locationDisplay}`);
  }
  if (whereFrag) {
    // WHERE starts with proper nouns (Des Plaines River, US-41, etc.) —
    // do NOT lowercase. Preserve original NWS capitalization.
    descParts[0] += ` along ${whereFrag}`;
  }
  let description = descParts[0] + '.';
  if (whenFrag) {
    description += ` The alert remains in effect ${lowercaseFirst(whenFrag)}.`;
  }

  // --- Slug ----------------------------------------------------------------
  const slug = buildSlug(event, locationDisplay, story.effective);

  // --- Breaking flag -------------------------------------------------------
  const breaking = story.severity === 'Extreme' || story.urgency === 'Immediate';

  // --- Source office -------------------------------------------------------
  const sourceOffice = story.senderName || 'National Weather Service';

  // --- Timestamps ----------------------------------------------------------
  const publishedAt = now.toISOString();
  const updatedAt = story.latestEffectiveAt || publishedAt;

  // --- SEO -----------------------------------------------------------------
  const seoTitle = `${event}: ${locationDisplay}`.slice(0, 60);
  let seoDescription = `The National Weather Service has issued a ${event} for ${locationDisplay}.`;
  if (whenFrag) {
    seoDescription += ` In effect ${lowercaseFirst(whenFrag)}.`;
  }
  seoDescription = seoDescription.slice(0, 160);

  // =========================================================================
  // Article body — structured, natural, source-backed
  // =========================================================================
  const body = [];

  // --- Lead paragraph (no heading) -----------------------------------------
  // Natural opening prose. Day-of-week derived from effective date.
  // Does NOT repeat the description verbatim.
  const leadParts = [];
  if (effDay) {
    leadParts.push(
      `The National Weather Service issued a ${event} ${effDay} for ${locationDisplay}`,
    );
  } else {
    leadParts.push(
      `The National Weather Service issued a ${event} for ${locationDisplay}`,
    );
  }
  // If the WHAT field confirms current conditions, add a factual clause.
  if (whatFrag) {
    leadParts[0] += `, where ${lowercaseFirst(whatFrag)}`;
  }
  leadParts[0] += `, according to the agency's alert.`;
  body.push({
    heading: null,
    paragraphs: [leadParts[0]],
  });

  // --- "What the warning says" ---------------------------------------------
  const whatParas = [];
  if (whatFrag) {
    whatParas.push(`The NWS alert states that ${lowercaseFirst(whatFrag)}.`);
  }
  // Include factual river-stage data from ADDITIONAL DETAILS if present.
  // This is source-backed factual data (stage readings, flood stage, trend).
  if (detailBullets.length > 0) {
    // Each bullet is already cleaned (labels stripped, URLs dropped,
    // AM/PM normalized). Join into a readable multi-sentence paragraph.
    const detailText = detailBullets.join(' ').replace(/\.+$/, '');
    if (detailText) {
      whatParas.push(`The NWS reported that ${lowercaseFirst(detailText)}.`);
    }
  }
  if (impactsFrag) {
    whatParas.push(`Potential impacts, per the NWS: ${lowercaseFirst(impactsFrag)}.`);
  }
  body.push({
    heading: `What the ${event.toLowerCase().includes('warning') ? 'warning' : 'alert'} says`,
    paragraphs: whatParas.length > 0
      ? whatParas
      : ['The full details are provided in the official NWS alert.'],
  });

  // --- "Areas affected" ----------------------------------------------------
  const areaParas = [`The alert covers ${locationDisplay}.`];
  if (whereFrag) {
    // Preserve WHERE capitalization entirely (proper nouns like "Des Plaines
    // River", "US-41", "Gurnee" must keep their original casing).
    areaParas.push(`The NWS said the warning applies to ${whereFrag}.`);
  }
  body.push({
    heading: 'Areas affected',
    paragraphs: areaParas,
  });

  // --- "How long the warning is in effect" ---------------------------------
  // For readers, `ends` (when the weather event itself ends) is the primary
  // end time. `expires` (when the NWS refreshes the alert message) is an
  // administrative detail — only mention if no `ends` is available.
  const alertWord = event.toLowerCase().includes('warning') ? 'warning' : 'alert';
  const timeParas = [];
  if (effReadable) {
    timeParas.push(`The ${alertWord} took effect ${effReadable}.`);
  }
  if (endsReadable) {
    timeParas.push(`It remains in effect until ${endsReadable}, the NWS said.`);
  } else if (expReadable) {
    timeParas.push(`It is scheduled to expire ${expReadable}.`);
  }
  body.push({
    heading: 'How long the warning is in effect',
    paragraphs: timeParas.length > 0
      ? timeParas
      : ['Timing details were not specified in the alert.'],
  });

  // --- "Safety information" (concise summary, not verbatim) ----------------
  const safetySummary = summarizeInstruction(story.instruction);
  body.push({
    heading: 'Safety information',
    paragraphs: safetySummary
      ? [safetySummary]
      : ['The National Weather Service did not include specific safety instructions with this alert.'],
  });

  // --- "Source" (no alert IDs in reader copy) ------------------------------
  body.push({
    heading: 'Source',
    paragraphs: [
      `This article was produced from an official alert issued by ${sourceOffice}. The original alert is published by the National Weather Service.`,
    ],
  });

  // --- Assemble draft ------------------------------------------------------
  return {
    draftVersion: 2,
    generatedAt: now.toISOString(),
    storyKey: story.storyKey,
    sourceAlertIds: story.alertIds,
    status: 'draft',
    title,
    description,
    slug,
    category: 'weather',
    location: locationDisplay,
    publishedAt,
    updatedAt,
    breaking,
    author: 'US News Engine Weather Desk',
    sourceName: 'National Weather Service',
    sourceUrl: story.sourceUrl || 'https://api.weather.gov/alerts/active',
    sourceOffice,
    hasUpdates: (story.updateCount || 1) > 1,
    originalInstruction: story.instruction || null,
    seo: { title: seoTitle, description: seoDescription },
    image: { status: 'pending', url: null, alt: null, source: null, license: null },
    body,
    weatherMetadata: {
      event: story.event,
      severity: story.severity,
      certainty: story.certainty,
      urgency: story.urgency,
      effective: story.effective,
      onset: story.onset,
      expires: story.expires,
      ends: story.ends,
      affectedZones: story.affectedZones || [],
      priority: story.priority,
      storyScore: story.storyScore,
      updateCount: story.updateCount,
      firstEffectiveAt: story.firstEffectiveAt || null,
      latestEffectiveAt: story.latestEffectiveAt || null,
    },
  };
}

// ===========================================================================
// Main
// ===========================================================================

async function main() {
  console.log('[generate-nws-draft] Starting private draft generation.');
  console.log(`  Input:  ${INPUT_FILE}`);

  let raw;
  try {
    raw = await readFile(INPUT_FILE, 'utf8');
  } catch (err) {
    return fail('Could not read input file. Run `npm run stories:nws` first.', String(err));
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    return fail('Input file is not valid JSON.', String(err));
  }
  const stories = Array.isArray(doc.stories) ? doc.stories : [];
  if (stories.length === 0) {
    return fail('No stories available. Nothing to draft.');
  }

  // Select the single highest-ranked story.
  const story = stories[0];
  const now = new Date();
  console.log(`  Selected story: ${story.storyKey} (score=${story.storyScore})`);
  console.log(`  Event: ${story.event} | Severity: ${story.severity} | Urgency: ${story.urgency}`);

  const draft = generateDraft(story, now);

  // --- Write exactly one draft file (overwrite) ----------------------------
  await mkdir(OUTPUT_DIR, { recursive: true });
  const outFile = join(OUTPUT_DIR, `${story.storyKey}.json`);
  const tmp = `${outFile}.tmp`;
  await writeFile(tmp, JSON.stringify(draft, null, 2) + '\n', 'utf8');
  await rename(tmp, outFile);

  // --- Word count ----------------------------------------------------------
  let wordCount = 0;
  for (const sec of draft.body) {
    for (const p of sec.paragraphs) {
      wordCount += p.split(/\s+/).filter(Boolean).length;
    }
  }
  wordCount += draft.description.split(/\s+/).filter(Boolean).length;

  const stats = await stat(outFile);
  console.log('\n[generate-nws-draft] SUCCESS — exactly one draft written.');
  console.log(`  Output file:  ${outFile}`);
  console.log(`  File size:    ${stats.size.toLocaleString()} bytes`);
  console.log(`  Title:        ${draft.title} (${draft.title.length} chars)`);
  console.log(`  Slug:         ${draft.slug}`);
  console.log(`  Breaking:     ${draft.breaking}`);
  console.log(`  Location:     ${draft.location}`);
  console.log(`  Source:       ${draft.sourceOffice}`);
  console.log(`  Sections:     ${draft.body.length}`);
  console.log(`  Word count:   ~${wordCount} (target 250–450)`);
  console.log(`  Alert IDs:    ${draft.sourceAlertIds.length} (in metadata only)`);
  console.log(`  Has updates:  ${draft.hasUpdates}`);
  console.log(`  SEO title:    ${draft.seo.title} (${draft.seo.title.length} chars)`);
  console.log(`  SEO desc:     ${draft.seo.description.length} chars`);
  console.log('');
}

main().catch((err) => fail('Unexpected failure.', String(err && err.stack ? err.stack : err)));
