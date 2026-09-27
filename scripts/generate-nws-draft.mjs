/**
 * US News Engine — private NWS article draft generator (Phase 3D).
 *
 * Reads data/nws-story-records.json, takes the HIGHEST-ranked story
 * (stories[0]), and writes exactly ONE private structured article draft to
 * data/drafts/<storyKey>.json.
 *
 * Strict constraints (Phase 3D):
 *   - ONE draft only.
 *   - Drafts live ONLY under data/drafts/. Never in src/content/articles/.
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
  // Territories occasionally seen in NWS areaDesc — normalized for safety.
  PR: 'Puerto Rico', VI: 'U.S. Virgin Islands', GU: 'Guam', AS: 'American Samoa',
  MP: 'Northern Mariana Islands',
};

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
 * Format an ISO timestamp for readers, preserving the original timezone
 * offset/abbreviation where present in the NWS string. We do NOT convert
 * timezones (per the Phase 3D rules) — we only reformat for readability.
 *
 * NWS timestamps look like "2026-09-27T10:28:00-05:00". We produce
 * "September 27, 2026 at 10:28 AM (UTC-05:00)".
 */
function readableTime(iso) {
  const d = parseDate(iso);
  if (!d) return null;
  const date = d.toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric',
    timeZone: 'UTC',
  });
  const time = d.toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit',
    timeZone: 'UTC', hour12: true,
  });
  // Extract the original offset from the ISO string to avoid any conversion.
  const offsetMatch = String(iso).match(/([+-]\d{2}:\d{2})$/);
  const offset = offsetMatch ? ` (UTC${offsetMatch[1]})` : '';
  return `${date} at ${time}${offset}`;
}

/**
 * Normalize an NWS areaDesc segment like "Lake, IL" into
 * "Lake County, Illinois". Returns null if the format is ambiguous so the
 * caller can fall back to the raw areaDesc.
 *
 * Handles: "Name, ST"  ->  "Name County, <State>"
 * Does NOT guess for formats without a recognizable 2-letter state code.
 */
function normalizeArea(areaDesc) {
  if (!areaDesc) return null;
  // Use the first segment of a multi-area list for the primary display.
  const first = String(areaDesc).split(';')[0].trim();
  // Match "Something, ST" at the end (2 uppercase letters).
  const m = first.match(/^(.*?),\s*([A-Z]{2})$/);
  if (!m) return null; // ambiguous — caller falls back to raw
  const rawName = m[1].trim();
  const abbr = m[2];
  const stateName = STATE_NAME_BY_ABBR[abbr];
  if (!stateName) return null; // unknown abbreviation — don't guess
  // If the name already ends with "County", don't duplicate it.
  const name = /county$/i.test(rawName) ? rawName : `${rawName} County`;
  return { display: `${name}, ${stateName}`, state: stateName, stateAbbr: abbr, raw: first };
}

/**
 * Build a clean public slug from event + display location + date.
 * Example: "flood-warning-lake-county-illinois-september-27-2026"
 */
function buildSlug(event, locationDisplay, effective) {
  const parts = [];
  if (event) parts.push(event.toLowerCase());
  if (locationDisplay) {
    parts.push(locationDisplay.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
  }
  const d = parseDate(effective);
  if (d) {
    const month = d.toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' }).toLowerCase();
    parts.push(month, String(d.getUTCDate()), String(d.getUTCFullYear()));
  }
  return parts
    .join('-')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Escape any literal NWS description text that we embed so it reads cleanly.
 * Collapses runs of whitespace/newlines into single spaces and trims.
 */
function cleanSourceText(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ===========================================================================
// Draft generation
// ===========================================================================

function generateDraft(story, now) {
  const event = story.event || 'Weather Alert';
  const areaDesc = story.areaDesc || '';
  const areaInfo = normalizeArea(areaDesc);
  const locationDisplay = areaInfo ? areaInfo.display : areaDesc || 'the affected area';

  // --- Headline (factual, no sensationalism) -------------------------------
  const title = `National Weather Service Issues ${event} for ${locationDisplay}`;

  // --- Description (1-2 sentences, traceable to the record) ----------------
  const expiresReadable = readableTime(story.expires) || readableTime(story.ends);
  const description = expiresReadable
    ? `The National Weather Service has issued a ${event} for ${locationDisplay}. The alert remains in effect until ${expiresReadable}, according to the latest NWS alert.`
    : `The National Weather Service has issued a ${event} for ${locationDisplay}, according to the latest NWS alert.`;

  // --- Slug ----------------------------------------------------------------
  const slug = buildSlug(event, locationDisplay, story.effective);

  // --- Breaking flag -------------------------------------------------------
  const breaking = story.severity === 'Extreme' || story.urgency === 'Immediate';

  // --- Source office (derived safely from senderName) ----------------------
  // senderName is e.g. "NWS Chicago IL" — keep it verbatim; no guessing.
  const sourceOffice = story.senderName || 'National Weather Service';

  // --- Timestamps ----------------------------------------------------------
  // Drafts are not published, so publishedAt mirrors generation time and is
  // marked by status:"draft". updatedAt = latest effective time of the story.
  const publishedAt = now.toISOString();
  const updatedAt = story.latestEffectiveAt || publishedAt;

  // --- SEO -----------------------------------------------------------------
  // <= ~60 chars title, ~120-160 chars description, factual only.
  const seoTitle = `${event}: ${locationDisplay}`.slice(0, 60);
  let seoDescription = `The National Weather Service has issued a ${event} for ${locationDisplay}.`;
  if (expiresReadable) {
    seoDescription += ` In effect until ${expiresReadable}.`;
  }
  seoDescription = seoDescription.slice(0, 160);

  // --- Article body (structured, original prose from facts) ----------------
  const body = [];

  // Lead section (no heading)
  const leadTime = readableTime(story.effective) || 'the time of issue';
  body.push({
    heading: null,
    paragraphs: [
      `The National Weather Service has issued a ${event} for ${locationDisplay}. The alert was issued at ${leadTime}, according to the official NWS alert.`,
      story.urgency
        ? `The NWS classifies the urgency of this alert as "${story.urgency}".`
        : '',
    ].filter(Boolean),
  });

  // What the warning says
  const descClean = cleanSourceText(story.description);
  const descParagraphs = [];
  if (descClean) {
    // Summarize the WHAT/WHERE/WHEN/IMPACTS structure without copying the
    // full block verbatim. Pull the short labeled facts where present.
    const grab = (label) => {
      const re = new RegExp(`\\*\\s*${label}\\s*[\\.\\.\\.]*([\\s\\S]*?)(?=\\n\\s*\\*|$)`, 'i');
      const m = descClean.match(re);
      return m ? cleanSourceText(m[1]) : null;
    };
    const what = grab('WHAT');
    const where = grab('WHERE');
    const when = grab('WHEN');
    const impacts = grab('IMPACTS');

    /**
     * Clean a fragment extracted from the NWS WHAT/WHERE/etc. labels so it
     * reads as natural prose: collapse whitespace, strip leading/trailing
     * punctuation, and capitalize the first letter. No words are changed.
     */
    const tidy = (frag) => {
      let s = cleanSourceText(frag)
        .replace(/^[\s.]+/, '')
        .replace(/[\s.]+$/, '')
        .replace(/\s+/g, ' ');
      if (s) s = s.charAt(0).toUpperCase() + s.slice(1);
      return s;
    };

    if (what) descParagraphs.push(`According to the NWS alert, ${tidy(what).toLowerCase()}.`);
    if (where) descParagraphs.push(`The affected area is described as ${tidy(where).toLowerCase()}.`);
    if (when) descParagraphs.push(`The alert timing, as stated by the NWS: ${tidy(when).toLowerCase()}.`);
    if (impacts) descParagraphs.push(`The NWS notes the following potential impacts: ${tidy(impacts).toLowerCase()}.`);
  }
  body.push({
    heading: 'What the alert says',
    paragraphs:
      descParagraphs.length > 0
        ? descParagraphs
        : ['The full details of the alert are provided by the National Weather Service.'],
  });

  // Areas affected
  const zoneCount = Array.isArray(story.affectedZones) ? story.affectedZones.length : 0;
  body.push({
    heading: 'Areas affected',
    paragraphs: [
      `The alert covers ${locationDisplay}.`,
      areaInfo && areaInfo.raw !== locationDisplay
        ? `The NWS lists the area as "${areaInfo.raw}".`
        : '',
      zoneCount > 0
        ? `The alert references ${zoneCount} NWS forecast zone${zoneCount === 1 ? '' : 's'}.`
        : '',
    ].filter(Boolean),
  });

  // When the alert expires
  const effReadable = readableTime(story.effective);
  const endsReadable = readableTime(story.ends);
  const expReadable = readableTime(story.expires);
  body.push({
    heading: 'When the alert is in effect',
    paragraphs: [
      effReadable ? `Effective: ${effReadable}.` : '',
      expReadable ? `Scheduled to expire: ${expReadable}.` : '',
      endsReadable && endsReadable !== expReadable ? `Ends: ${endsReadable}.` : '',
    ].filter(Boolean),
  });

  // What residents should know (official NWS instruction only)
  const instructionClean = cleanSourceText(story.instruction);
  body.push({
    heading: 'What residents should know',
    paragraphs: instructionClean
      ? [
          'The National Weather Service provides the following safety guidance:',
          instructionClean,
        ]
      : [
          'The National Weather Service did not include specific safety instructions with this alert. Residents should monitor official NWS channels for updates.',
        ],
  });

  // Source
  body.push({
    heading: 'Source',
    paragraphs: [
      `This report is based on an official alert issued by the ${sourceOffice}. The original alert is published by the National Weather Service.`,
      story.sourceUrl
        ? `Source: ${story.sourceUrl}`
        : '',
      `Official NWS alert ID${story.alertIds.length === 1 ? '' : 's'}: ${story.alertIds.join(', ')}`,
    ].filter(Boolean),
  });

  // --- Assemble draft ------------------------------------------------------
  return {
    draftVersion: 1,
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

  // --- Write exactly one draft file ----------------------------------------
  await mkdir(OUTPUT_DIR, { recursive: true });
  const outFile = join(OUTPUT_DIR, `${story.storyKey}.json`);
  const tmp = `${outFile}.tmp`;
  await writeFile(tmp, JSON.stringify(draft, null, 2) + '\n', 'utf8');
  await rename(tmp, outFile);

  const stats = await stat(outFile);
  console.log('\n[generate-nws-draft] SUCCESS — exactly one draft written.');
  console.log(`  Output file: ${outFile}`);
  console.log(`  File size:   ${stats.size.toLocaleString()} bytes`);
  console.log(`  Title:       ${draft.title}`);
  console.log(`  Slug:        ${draft.slug}`);
  console.log(`  Breaking:    ${draft.breaking}`);
  console.log(`  Location:    ${draft.location}`);
  console.log(`  Source:      ${draft.sourceOffice} (${draft.sourceName})`);
  console.log(`  Sections:    ${draft.body.length}`);
  console.log(`  Alert IDs:   ${draft.sourceAlertIds.length}`);
  console.log(`  Has updates: ${draft.hasUpdates}`);
  console.log('');
}

main().catch((err) => fail('Unexpected failure.', String(err && err.stack ? err.stack : err)));
