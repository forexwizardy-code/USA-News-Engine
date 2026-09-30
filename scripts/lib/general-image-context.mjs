// Editorial photo relevance safety check for General News.
// A shared surname is NOT enough to establish that a Commons image shows
// the person named in a story. Fail closed to the pre-existing editorial
// graphic when a returned photo clearly concerns another namesake.
const normalize = (value) => String(value || '')
  .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/\s+/g, ' ').trim();

export function checkGeneralPhotoContext(storyTitle, candidate) {
  const story = normalize(storyTitle);
  const photo = normalize([
    candidate?.title, candidate?.description, candidate?.categories,
  ].filter(Boolean).join(' '));

  const schmittLegalCoverage = /\bschmitt\b/.test(story) &&
    /\b(jack smith|raskin|fani willis|senat(?:e|or)|hearing)\b/.test(story);
  if (schmittLegalCoverage) {
    // Three documented false positives all came from keyword matching on
    // Schmitt alone: Harrison H. Schmitt / Apollo 17 / Schmitt Pál.
    if (/\b(apollo 17|astronaut|lunar|moonwalk|moon surface|taurus.littrow)\b/.test(photo)) {
      return { ok: false, reason: 'space exploration photo unrelated to political Schmitt story' };
    }
    if (/\bschmitt\b/.test(photo) &&
        !/\beric\s+(?:[a-z]\.?\s+)?schmitt\b/.test(photo) &&
        !/\b(jack smith|jamie raskin)\b/.test(photo)) {
      return { ok: false, reason: 'surname-only match: photo does not establish the political subject' };
    }
  }
  return { ok: true, reason: 'no known namesake mismatch' };
}
