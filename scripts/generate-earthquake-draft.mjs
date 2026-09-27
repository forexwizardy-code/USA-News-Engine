/**
 * US News Engine — private earthquake article draft generator (Phase 8B).
 *
 * Reads data/earthquakes/earthquake-story-records.json (or the test fixture at
 * data/earthquakes/test-fixture.json when --fixture is passed) and writes
 * exactly ONE private structured article draft to
 * data/earthquakes/drafts/<slug>.json.
 *
 * Selection rules:
 *   - If argv includes --fixture, the test fixture is used (dry-run / preview).
 *   - Otherwise, argv[2] is treated as a storyKey to look up in the
 *     story-records file.
 *   - If no argv[2], the first publishEligible story in the records file is
 *     used (sorted by storyScore desc — the file is already sorted this way).
 *   - If no publishEligible story exists, exits with code 1.
 *
 * Strict constraints:
 *   - ONE draft only. Drafts live ONLY under data/earthquakes/drafts/.
 *   - No AI. No publishing. No scheduling. No website changes.
 *   - Every factual statement must be traceable to the USGS earthquake data.
 *   - No invented numbers, quotes, damage, or injuries.
 *   - No sensationalism ("massive", "devastating", "major" unless official).
 *
 * Run manually:
 *   node scripts/generate-earthquake-draft.mjs
 *   node scripts/generate-earthquake-draft.mjs "<earthquakeKey>"
 *   node scripts/generate-earthquake-draft.mjs --fixture
 */

import { readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(__dirname, '..');
const STORY_RECORDS_FILE = join(
  PROJECT_DIR,
  'data',
  'earthquakes',
  'earthquake-story-records.json',
);
const TEST_FIXTURE_FILE = join(
  PROJECT_DIR,
  'data',
  'earthquakes',
  'test-fixture.json',
);
const OUTPUT_DIR = join(PROJECT_DIR, 'data', 'earthquakes', 'drafts');

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
  console.error(`\n[generate-earthquake-draft] ERROR: ${message}`);
  if (detail) console.error(`  Detail: ${detail}`);
  process.exit(1);
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Format an ISO timestamp in UTC as "Sunday, September 27, 2026 at 10:00 a.m. UTC".
 * USGS earthquake times are universally UTC; we present them as such to avoid
 * implying a local timezone that we cannot reliably derive from coordinates.
 */
function formatUtcReadable(iso) {
  const d = parseDate(iso);
  if (!d) return null;
  const day = DAY_NAMES[d.getUTCDay()];
  const month = MONTH_NAMES[d.getUTCMonth()];
  const dayNum = d.getUTCDate();
  const year = d.getUTCFullYear();
  const h = d.getUTCHours();
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  const ampm = h < 12 ? 'a.m.' : 'p.m.';
  const min = String(d.getUTCMinutes()).padStart(2, '0');
  return `${day}, ${month} ${dayNum}, ${year} at ${h12}:${min} ${ampm} UTC`;
}

/** Round a number to one decimal place, returning a string for prose. */
function oneDecimal(n) {
  if (n == null || typeof n !== 'number' || !Number.isFinite(n)) return null;
  return n.toFixed(1);
}

/**
 * Convert a magnitude type code (e.g. "ml", "mww", "mb") into a reader-friendly
 * label. We do NOT invent physics; we just expand the abbreviation using the
 * USGS-published glossary terms.
 */
function magnitudeTypeLabel(code) {
  if (!code) return null;
  const c = String(code).toLowerCase();
  const map = {
    ml: 'local magnitude (ML)',
    md: 'duration magnitude (MD)',
    mb: 'body-wave magnitude (Mb)',
    mwb: 'body-wave moment magnitude (Mwb)',
    mwr: 'regional moment magnitude (Mwr)',
    mw: 'moment magnitude (Mw)',
    mww: 'moment magnitude (Mww)',
    mwc: 'centroid moment magnitude (Mwc)',
    mh: 'hand-calculated magnitude (Mh)',
    ms: 'surface-wave magnitude (Ms)',
    mlr: 'Lg-wave magnitude (MLR)',
  };
  return map[c] || `magnitude type ${code}`;
}

/**
 * Strip the "of" prefix off the USGS place string so we get a clean
 * location-only fragment. e.g. "12 km NNE of Anchorage, Alaska" →
 * { distance: "12 km NNE", place: "Anchorage, Alaska" }
 */
function parsePlace(fullPlace) {
  if (!fullPlace) return { distance: null, place: null };
  const text = String(fullPlace).trim();
  // Match patterns like "12 km NNE of Foo, Bar" or "Foo, Bar"
  const m = text.match(/^([\d.]+\s*km\s+[A-Za-z]+\s+of\s+)(.+)$/i);
  if (m) {
    return { distance: m[1].trim(), place: m[2].trim() };
  }
  return { distance: null, place: text };
}

/**
 * Build a clean URL slug from magnitude + place + date.
 * Example: "m5-2-earthquake-anchorage-alaska-2026-09-27"
 */
function buildSlug(magnitude, place, time) {
  const magStr = magnitude != null
    ? `m${String(magnitude).replace('.', '')}`
    : 'earthquake';
  const placeClean = String(place || '')
    .replace(/^[\d.]+\s*km\s+[A-Za-z]+\s+of\s+/i, '')
    .replace(/,\s*/g, '-')
    .replace(/\s+/g, '-');
  const d = parseDate(time);
  const dateStr = d
    ? `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
    : '';
  const parts = [magStr, 'earthquake', placeClean, dateStr].filter(Boolean);
  return parts
    .join('-')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

/**
 * Build a factual, non-sensational headline.
 * Format: "M5.4 Earthquake Strikes Near Anchorage, Alaska, USGS Says"
 * Rules:
 *   - Under ~80 chars
 *   - No "massive", "devastating", "major" unless officially classified
 *   - No damage/injury claims unless officially reported
 */
function buildHeadline(story) {
  const mag = oneDecimal(story.magnitude);
  if (mag == null) return 'Earthquake Reported by USGS';

  const placeInfo = parsePlace(story.place);
  // Choose a short place name for the headline. Strip the state from the
  // place string (the state appears as a separate clause in the article body).
  let placeShort = placeInfo.place || story.place || 'the region';
  // Use only the portion before any comma so we don't blow past 80 chars
  // with "12 km NNE of Anchorage, Alaska, USA".
  placeShort = placeShort.split(',')[0].trim();

  // Prefer a verb that's neutral. "Strikes" is conventional wire-service phrasing
  // for an earthquake without implying damage.
  let headline = `M${mag} Earthquake Strikes ${placeShort}, USGS Says`;

  // If we don't have a state (international event), append the country.
  if (!story.state && story.country && story.country !== 'United States') {
    const candidate = `M${mag} Earthquake Strikes ${placeShort}, ${story.country}, USGS Says`;
    if (candidate.length <= 90) headline = candidate;
  }

  if (headline.length > 90) {
    // Drop ", USGS Says" if needed to stay close to limit.
    const trimmed = `M${mag} Earthquake Strikes ${placeShort}`;
    headline = trimmed.length <= 90 ? `${trimmed}, USGS Says` : trimmed;
  }
  return headline;
}

/**
 * Build the lead paragraph (no heading). States what happened, magnitude,
 * location, and time. Always attributes to USGS.
 */
function buildLead(story) {
  const mag = oneDecimal(story.magnitude) || 'an';
  const placeInfo = parsePlace(story.place);
  const placeStr = placeInfo.place || story.place || 'a region';
  const timeReadable = formatUtcReadable(story.time);
  // Only append the state in parentheses if the place string does NOT already
  // contain it (so "Anchorage, Alaska" stays as-is rather than becoming
  // "Anchorage, Alaska (Alaska)").
  const stateLower = (story.state || '').toLowerCase();
  const alreadyHasState = stateLower && placeStr.toLowerCase().includes(stateLower);
  const locationClause = story.state && !alreadyHasState
    ? `${placeStr} (${story.state})`
    : placeStr;

  const parts = [`A magnitude ${mag} earthquake struck ${locationClause} on ${timeReadable}, the U.S. Geological Survey reported.`];

  // Add factual context that's safe to mention (no damage, no injuries).
  if (story.tsunami === true) {
    parts.push('USGS tsunami information was issued for the event.');
  } else if (story.alert && ['yellow', 'orange', 'red'].includes(story.alert)) {
    parts.push(`USGS assigned a ${story.alert} PAGER alert level for the event.`);
  }
  return escapeHtml(parts.join(' '));
}

/**
 * "What USGS reported" — official details from USGS data.
 */
function buildWhatUsgsReported(story) {
  const paras = [];
  const mag = oneDecimal(story.magnitude);
  const placeStr = story.place || 'the affected region';

  const sentenceParts = [`The U.S. Geological Survey recorded the earthquake at magnitude ${mag || 'an unspecified value'}`];
  if (story.depthKm != null) {
    sentenceParts.push(`at a depth of ${oneDecimal(story.depthKm)} kilometers`);
  }
  sentenceParts.push(`centered near ${placeStr}.`);
  paras.push(escapeHtml(sentenceParts.join(' ')));

  if (story.status === 'reviewed') {
    paras.push(escapeHtml('USGS listed the event status as "reviewed," indicating that a seismologist had reviewed the automated solution.'));
  } else if (story.status === 'automatic') {
    paras.push(escapeHtml('USGS listed the event status as "automatic," meaning the solution had not yet been reviewed by a seismologist at the time of publication.'));
  }

  if (story.significance != null) {
    paras.push(escapeHtml(`USGS assigned the event a significance score of ${story.significance}.`));
  }
  return paras;
}

/**
 * "Magnitude and depth" — technical details.
 */
function buildMagnitudeAndDepth(story) {
  const paras = [];
  const mag = oneDecimal(story.magnitude);
  const magType = magnitudeTypeLabel(story.magnitudeType);
  const depth = oneDecimal(story.depthKm);

  if (mag != null) {
    let sentence = `The earthquake had a magnitude of ${mag}`;
    if (magType) sentence += ` on the ${magType} scale`;
    sentence += '.';
    paras.push(escapeHtml(sentence));
  } else {
    paras.push(escapeHtml('USGS did not publish a final magnitude for the event.'));
  }

  if (depth != null) {
    let depthSentence = `The hypocenter was located at a depth of ${depth} kilometers`;
    if (story.depthKm < 10) {
      depthSentence += ', classified by USGS as a shallow event';
    } else if (story.depthKm < 70) {
      depthSentence += ', within the shallow-to-intermediate range typical of crustal activity';
    }
    depthSentence += '.';
    paras.push(escapeHtml(depthSentence));
  }
  return paras;
}

/**
 * "Where the earthquake occurred" — place, state, coordinates.
 */
function buildWhere(story) {
  const paras = [];
  const placeStr = story.place || 'an area';
  const stateLower = (story.state || '').toLowerCase();
  // Avoid "near X, Alaska in Alaska" by only appending the state clause if the
  // place string does NOT already contain the state name.
  const placeHasState = stateLower && placeStr.toLowerCase().includes(stateLower);

  let sentence = `The epicenter was located near ${placeStr}`;
  if (story.state && !placeHasState) sentence += ` in ${story.state}`;
  if (story.country && story.country !== 'United States') {
    sentence += ` (${story.country})`;
  } else if (story.country === 'United States' && !story.state) {
    sentence += ' (United States)';
  }
  sentence += '.';
  paras.push(escapeHtml(sentence));

  if (story.latitude != null && story.longitude != null) {
    const latStr = `${Math.abs(story.latitude).toFixed(4)}°${story.latitude >= 0 ? 'N' : 'S'}`;
    const lonStr = `${Math.abs(story.longitude).toFixed(4)}°${story.longitude >= 0 ? 'E' : 'W'}`;
    paras.push(escapeHtml(`USGS listed the coordinates as ${latStr}, ${lonStr}.`));
  }
  return paras;
}

/**
 * "Felt reports" — only if felt > 0.
 */
function buildFeltReports(story) {
  const paras = [];
  if (story.felt == null || story.felt === 0) return paras;

  paras.push(
    escapeHtml(
      `As of the most recent USGS update, ${story.felt.toLocaleString()} "Did You Feel It?" report${story.felt === 1 ? ' was' : 's were'} submitted by residents near the epicenter.`,
    ),
  );
  if (story.cdi != null) {
    paras.push(
      escapeHtml(
        `USGS computed a Community Determined Intensity (CDI) of ${oneDecimal(story.cdi)} from those reports.`,
      ),
    );
  }
  if (story.mmi != null) {
    paras.push(
      escapeHtml(
        `USGS estimated a peak Modified Mercalli Intensity (MMI) of ${oneDecimal(story.mmi)} for the event.`,
      ),
    );
  }
  return paras;
}

/**
 * "USGS alert and tsunami information" — only if alert or tsunami present.
 */
function buildAlertAndTsunami(story) {
  const paras = [];
  const alert = story.alert;
  const tsunami = story.tsunami === true;

  if (alert && ['yellow', 'orange', 'red', 'green'].includes(alert)) {
    const alertDescription = {
      green: 'a green (little to no impact expected) PAGER alert level',
      yellow: 'a yellow (limited impact expected) PAGER alert level',
      orange: 'an orange (significant impact expected) PAGER alert level',
      red: 'a red (severe impact expected) PAGER alert level',
    }[alert];
    if (alertDescription) {
      paras.push(
        escapeHtml(`USGS assigned ${alertDescription} for the earthquake through its Prompt Assessment of Global Earthquakes for Response (PAGER) system.`),
      );
    }
  }

  if (tsunami) {
    paras.push(
      escapeHtml('USGS flagged the event with a tsunami marker. The National Tsunami Warning Center issues official tsunami bulletins; this article does not replace those bulletins.'),
    );
  } else if (alert && ['yellow', 'orange', 'red'].includes(alert)) {
    paras.push(escapeHtml('USGS did not flag the event with a tsunami marker.'));
  }
  return paras;
}

/**
 * "Source" — attribution paragraph.
 */
function buildSourceParagraph(story) {
  return escapeHtml(
    'This article was produced from data published by the U.S. Geological Survey Earthquake Hazards Program. The original event page is published by USGS at earthquake.usgs.gov.',
  );
}

// ===========================================================================
// Draft generation
// ===========================================================================

function generateDraft(story, now) {
  const title = buildHeadline(story);
  const slug = buildSlug(story.magnitude, story.place, story.time);
  const placeInfo = parsePlace(story.place);
  const location = (placeInfo.place || story.place || 'the affected region').split(',')[0].trim();

  // --- Breaking flag -------------------------------------------------------
  // Per spec: true for M5+ OR tsunami OR alert red/orange.
  const breaking =
    (typeof story.magnitude === 'number' && story.magnitude >= 5.0) ||
    story.tsunami === true ||
    story.alert === 'red' ||
    story.alert === 'orange';

  // --- Description (1-2 sentence deck) ------------------------------------
  const mag = oneDecimal(story.magnitude);
  const placeStr = placeInfo.place || story.place || 'a region';
  let description = `A magnitude ${mag || 'unknown'} earthquake was reported near ${placeStr}`;
  // Only append "in {state}" if the place string does NOT already contain it
  // (avoids "Anchorage, Alaska in Alaska").
  const stateLowerDesc = (story.state || '').toLowerCase();
  const placeHasStateDesc = stateLowerDesc && placeStr.toLowerCase().includes(stateLowerDesc);
  if (story.state && !placeHasStateDesc) description += ` in ${story.state}`;
  description += ', according to the U.S. Geological Survey.';
  if (story.tsunami === true) {
    description += ' USGS flagged the event with a tsunami marker.';
  } else if (story.alert && ['yellow', 'orange', 'red'].includes(story.alert)) {
    description += ` USGS assigned a ${story.alert} PAGER alert.`;
  }
  description = description.slice(0, 220);

  // --- SEO ----------------------------------------------------------------
  const seoTitle = title.slice(0, 60);
  const seoDescription = description.slice(0, 160);

  // --- Timestamps ---------------------------------------------------------
  // publishedAt = when THIS WEBSITE first publishes (generation time for preview).
  // updatedAt = null on first generation.
  const publishedAt = now.toISOString();
  const updatedAt = null;

  // --- Body sections (skip empty) -----------------------------------------
  const body = [];

  // 1. Lead (no heading)
  body.push({ heading: null, paragraphs: [buildLead(story)] });

  // 2. What USGS reported
  const whatParas = buildWhatUsgsReported(story);
  if (whatParas.length > 0) {
    body.push({ heading: 'What USGS reported', paragraphs: whatParas });
  }

  // 3. Magnitude and depth
  const magParas = buildMagnitudeAndDepth(story);
  if (magParas.length > 0) {
    body.push({ heading: 'Magnitude and depth', paragraphs: magParas });
  }

  // 4. Where the earthquake occurred
  const whereParas = buildWhere(story);
  if (whereParas.length > 0) {
    body.push({ heading: 'Where the earthquake occurred', paragraphs: whereParas });
  }

  // 5. Felt reports — only if felt > 0
  const feltParas = buildFeltReports(story);
  if (feltParas.length > 0) {
    body.push({ heading: 'Felt reports', paragraphs: feltParas });
  }

  // 6. USGS alert and tsunami information — only if alert or tsunami present
  const alertParas = buildAlertAndTsunami(story);
  if (alertParas.length > 0) {
    body.push({ heading: 'USGS alert and tsunami information', paragraphs: alertParas });
  }

  // 7. Source — always
  body.push({ heading: 'Source', paragraphs: [buildSourceParagraph(story)] });

  // --- earthquakeMetadata --------------------------------------------------
  const earthquakeMetadata = {
    magnitude: typeof story.magnitude === 'number' ? story.magnitude : null,
    magnitudeType: story.magnitudeType || null,
    magnitudeTypeLabel: magnitudeTypeLabel(story.magnitudeType),
    depth: typeof story.depthKm === 'number' ? story.depthKm : null,
    depthKm: typeof story.depthKm === 'number' ? story.depthKm : null,
    place: story.place || null,
    state: story.state || null,
    country: story.country || null,
    nearestPlace: story.nearestPlace || null,
    latitude: typeof story.latitude === 'number' ? story.latitude : null,
    longitude: typeof story.longitude === 'number' ? story.longitude : null,
    felt: typeof story.felt === 'number' ? story.felt : null,
    cdi: typeof story.cdi === 'number' ? story.cdi : null,
    mmi: typeof story.mmi === 'number' ? story.mmi : null,
    alert: story.alert || null,
    tsunami: story.tsunami === true,
    significance: typeof story.significance === 'number' ? story.significance : null,
    status: story.status || null,
    time: story.time || null,
    updated: story.updated || null,
    eventId: story.eventId || story.sourceId || null,
    hasShakeMap: story.hasShakeMap === true,
    shakeMapProductUrl: story.shakeMapProductUrl || null,
    shakeMapImageUrl: story.shakeMapImageUrl || null,
    hasDyfi: story.hasDyfi === true,
    hasMomentTensor: story.hasMomentTensor === true,
    hasTsunamiProduct: story.hasTsunamiProduct === true,
    isUS: story.isUS === true,
    isUSRelevant: story.isUSRelevant === true,
    impactRelevant: story.impactRelevant === true,
    publishEligible: story.publishEligible === true,
    scope: story.scope || null,
    priority: story.priority || null,
    storyScore: typeof story.storyScore === 'number' ? story.storyScore : null,
    storyStatus: story.storyStatus || null,
    testOnly: story.testOnly === true,
  };

  return {
    draftVersion: 1,
    generatedAt: now.toISOString(),
    earthquakeKey: story.earthquakeKey,
    eventId: story.eventId || story.sourceId || null,
    status: 'draft',
    title,
    description,
    slug,
    category: 'weather',
    location,
    publishedAt,
    updatedAt,
    breaking,
    author: 'US News Engine Weather Desk',
    sourceName: 'U.S. Geological Survey',
    sourceUrl: story.url || 'https://earthquake.usgs.gov/',
    sourceOffice: 'U.S. Geological Survey',
    hasUpdates: (story.updateCount || 1) > 1,
    seo: { title: seoTitle, description: seoDescription },
    image: {
      status: 'pending',
      url: null,
      alt: null,
      source: null,
      license: null,
    },
    body,
    earthquakeMetadata,
  };
}

// ===========================================================================
// Main
// ===========================================================================

async function main() {
  console.log('[generate-earthquake-draft] Starting private draft generation.');

  const args = process.argv.slice(2);
  const useFixture = args.includes('--fixture');
  const positionalArgs = args.filter((a) => !a.startsWith('--'));
  const targetKey = positionalArgs[0] || null;

  let story = null;
  let sourceLabel = '';

  if (useFixture) {
    console.log(`  Loading test fixture: ${TEST_FIXTURE_FILE}`);
    let raw;
    try {
      raw = await readFile(TEST_FIXTURE_FILE, 'utf8');
    } catch (err) {
      return fail('Could not read test fixture file.', String(err));
    }
    let fixture;
    try {
      fixture = JSON.parse(raw);
    } catch (err) {
      return fail('Test fixture file is not valid JSON.', String(err));
    }
    if (targetKey && fixture.earthquakeKey !== targetKey) {
      return fail(
        `Fixture earthquakeKey does not match requested key: ${targetKey}`,
        `Fixture carries earthquakeKey=${fixture.earthquakeKey}`,
      );
    }
    story = fixture;
    sourceLabel = 'test-fixture';
    console.log(`  Using fixture: ${story.earthquakeKey} (testOnly=${story.testOnly === true})`);
  } else {
    console.log(`  Input:  ${STORY_RECORDS_FILE}`);
    let raw;
    try {
      raw = await readFile(STORY_RECORDS_FILE, 'utf8');
    } catch (err) {
      return fail(
        'Could not read story-records file. Run `npm run stories:earthquakes` first.',
        String(err),
      );
    }
    let doc;
    try {
      doc = JSON.parse(raw);
    } catch (err) {
      return fail('Story-records file is not valid JSON.', String(err));
    }
    const stories = Array.isArray(doc.stories) ? doc.stories : [];
    if (stories.length === 0) {
      return fail('No earthquake stories available. Nothing to draft.');
    }

    if (targetKey) {
      story = stories.find((s) => s.earthquakeKey === targetKey) || null;
      if (!story) {
        return fail(
          `Story not found: ${targetKey}`,
          `Available stories: ${stories.map((s) => s.earthquakeKey).slice(0, 5).join(', ')}...`,
        );
      }
      sourceLabel = 'story-records (by key)';
    } else {
      // Pick the first publishEligible story (already sorted by storyScore desc).
      story = stories.find((s) => s.publishEligible === true) || null;
      if (!story) {
        return fail(
          'No publishEligible stories available. Nothing to draft.',
          `Stories present: ${stories.length}, publishEligible: ${stories.filter((s) => s.publishEligible).length}. Pass a storyKey explicitly or use --fixture to draft a non-eligible story for review.`,
        );
      }
      sourceLabel = 'story-records (first publishEligible)';
    }
  }

  const now = new Date();
  console.log(`  Source: ${sourceLabel}`);
  console.log(`  Selected: ${story.earthquakeKey} (score=${story.storyScore ?? 'n/a'})`);
  console.log(`  Magnitude: ${story.magnitude} | Place: ${story.place || 'n/a'}`);

  const draft = generateDraft(story, now);

  // --- Write exactly one draft file (atomic) -------------------------------
  await mkdir(OUTPUT_DIR, { recursive: true });
  const outFile = join(OUTPUT_DIR, `${draft.slug}.json`);
  const tmp = `${outFile}.tmp`;
  await writeFile(tmp, JSON.stringify(draft, null, 2) + '\n', 'utf8');
  await rename(tmp, outFile);

  // --- Word count ----------------------------------------------------------
  let wordCount = 0;
  for (const sec of draft.body) {
    for (const p of sec.paragraphs) {
      const plain = String(p).replace(/<[^>]+>/g, ' ');
      wordCount += plain.split(/\s+/).filter(Boolean).length;
    }
  }
  wordCount += draft.description.split(/\s+/).filter(Boolean).length;

  const stats = await stat(outFile);
  console.log('\n[generate-earthquake-draft] SUCCESS — exactly one draft written.');
  console.log(`  Output file:  ${outFile}`);
  console.log(`  File size:    ${stats.size.toLocaleString()} bytes`);
  console.log(`  Title:        ${draft.title} (${draft.title.length} chars)`);
  console.log(`  Slug:         ${draft.slug}`);
  console.log(`  Breaking:     ${draft.breaking}`);
  console.log(`  Location:     ${draft.location}`);
  console.log(`  Source:       ${draft.sourceOffice}`);
  console.log(`  Sections:     ${draft.body.length}`);
  console.log(`  Word count:   ~${wordCount}`);
  console.log(`  Event ID:     ${draft.eventId}`);
  console.log(`  Test only:    ${draft.earthquakeMetadata.testOnly === true}`);
  console.log(`  SEO title:    ${draft.seo.title} (${draft.seo.title.length} chars)`);
  console.log(`  SEO desc:     ${draft.seo.description.length} chars`);
  console.log('');
}

main().catch((err) =>
  fail('Unexpected failure.', String(err && err.stack ? err.stack : err)),
);
