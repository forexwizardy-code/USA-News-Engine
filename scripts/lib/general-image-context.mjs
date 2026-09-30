// Editorial image relevance safety check for General News.
// A shared surname or one generic keyword is NOT enough to establish that a
// Commons image depicts the subject of a story. Fail closed to the existing
// editorial graphic when relevance is weak or a known namesake/geography
// conflict is present.

const normalize = (value) => String(value || '')
  .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();

const WEAK_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'over', 'under', 'after',
  'before', 'amid', 'about', 'that', 'this', 'these', 'those', 'will',
  'would', 'could', 'should', 'have', 'has', 'had', 'are', 'was', 'were',
  'its', 'their', 'says', 'said', 'say', 'here', 'very', 'more', 'most',
  'latest', 'live', 'news', 'report', 'reports', 'story', 'stories',
  'new', 'old', 'big', 'three', 'four', 'five', 'two', 'one', 'first',
  'last', 'today', 'tomorrow', 'yesterday', 'change', 'changes',
  'january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december',
]);

function tokenSet(value) {
  return new Set(
    normalize(value)
      .split(' ')
      .filter((word) => word.length >= 3 && !WEAK_WORDS.has(word)),
  );
}

function overlapCount(a, b) {
  const left = tokenSet(a);
  const right = tokenSet(b);
  let count = 0;
  for (const word of left) {
    if (right.has(word)) count += 1;
  }
  return count;
}

function containsPhrase(text, phrase) {
  return normalize(text).includes(normalize(phrase));
}

export function checkGeneralPhotoContext(storyTitle, candidate, storyDescription = '') {
  const storyTitleNorm = normalize(storyTitle);
  const story = normalize(`${storyTitle || ''} ${storyDescription || ''}`);
  const photo = normalize([
    candidate?.title,
    candidate?.description,
    candidate?.categories,
  ].filter(Boolean).join(' '));

  const schmittLegalCoverage = /\bschmitt\b/.test(storyTitleNorm) &&
    /\b(jack smith|raskin|fani willis|senat(?:e|or)|hearing)\b/.test(storyTitleNorm);
  if (schmittLegalCoverage) {
    if (/\b(apollo 17|astronaut|lunar|moonwalk|moon surface|taurus littrow)\b/.test(photo)) {
      return { ok: false, reason: 'space exploration image unrelated to political Schmitt story' };
    }
    if (/\bschmitt\b/.test(photo) &&
        !/\beric\s+(?:[a-z]\s+)?schmitt\b/.test(photo) &&
        !/\b(jack smith|jamie raskin)\b/.test(photo)) {
      return { ok: false, reason: 'surname-only match: image does not establish the political subject' };
    }
  }

  // Preserve the original lightweight behavior for legacy callers/tests.
  // Production General News passes a description and therefore enables the
  // stricter checks below.
  if (!storyDescription) {
    return { ok: true, reason: 'no known namesake mismatch' };
  }

  // Known high-risk false-positive patterns observed in production.
  if (/\bwashington wizards\b/.test(story) &&
      !/\b(washington wizards|nba|basketball)\b/.test(photo)) {
    return { ok: false, reason: 'Wizards story requires basketball/NBA context' };
  }

  if (/\bmeasles\b/.test(story) &&
      !/\b(measles|vaccine|vaccination|immunization|health|disease|virus)\b/.test(photo)) {
    return { ok: false, reason: 'measles story image lacks health/disease context' };
  }

  if (/\bcornell university\b/.test(story) &&
      !/\b(cornell university|ithaca|campus)\b/.test(photo)) {
    return { ok: false, reason: 'Cornell story matched a collection/item rather than the university context' };
  }

  if (/\bgary marcus\b/.test(story) && !containsPhrase(photo, 'Gary Marcus')) {
    return { ok: false, reason: 'Gary Marcus story requires the full person name in image metadata' };
  }

  if (/\bsupreme court\b/.test(story) &&
      /\b(australia|darwin|northern territory)\b/.test(photo)) {
    return { ok: false, reason: 'U.S. Supreme Court story matched an Australian court' };
  }

  if (/\bfederal reserve\b|\bfed s? preferred\b|\binflation\b/.test(story) &&
      !/\b(federal reserve|inflation|economy|economic|interest rate|central bank|dollar|money)\b/.test(photo)) {
    return { ok: false, reason: 'inflation/Fed story image lacks economic context' };
  }

  if (/\bstate department\b/.test(story) &&
      !/\b(state department|department of state|diplomat|diplomatic|flag|washington)\b/.test(photo)) {
    return { ok: false, reason: 'State Department story image lacks State Department/flag context' };
  }

  if (/\bwest bank\b/.test(story) &&
      !/\b(west bank|israel|israeli|palestin|senate|congress|capitol)\b/.test(photo)) {
    return { ok: false, reason: 'West Bank/Senate story image lacks relevant geographic or congressional context' };
  }

  const overlap = overlapCount(story, photo);
  if (overlap < 2) {
    return {
      ok: false,
      reason: `weak story/image metadata overlap (${overlap}); use editorial fallback`,
    };
  }

  return { ok: true, reason: `story/image context overlap=${overlap}` };
}
