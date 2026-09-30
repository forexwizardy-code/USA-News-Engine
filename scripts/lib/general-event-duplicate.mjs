/**
 * Conservative headline-level event duplication check for General News.
 *
 * This is deliberately NOT topic clustering: when a candidate resembles an
 * existing story but may contain a new angle, return "review" instead of
 * automatically publishing or silently deleting it. The caller holds both
 * "duplicate" and "review" candidates from automatic publication.
 * Existing URL/story-key checks remain the primary exact-identity guard.
 */
const STOP = new Set(`a an the and or but nor of for from to in on at by with as is are was were be been being this that these those their its it his her they he she who whom whose what why how which than then after before during through via amid among over under into out up down will would could should can may might not no yes do does did done has have had having s t says say said according report reported reports news latest update updates live breaking new today yesterday tomorrow more most some any several many top major another about around us u s`.split(' '));
const GENERIC_TOPIC = new Set(`trump biden president administration government whitehouse ai technology tech techfirm firm business company executive senator senate congress court states state american national official leader leaders`.split(' '));
const ALIASES = new Map(Object.entries({
  firms:'firm', companies:'firm', company:'firm', corporation:'firm', corporations:'firm',
  executives:'executive', bosses:'executive', leaders:'leader',
  signed:'sign', signs:'sign', signing:'sign',
  asks:'ask', asked:'ask', requesting:'ask', requests:'ask', requested:'ask',
  hosts:'host', hosted:'host', hosting:'host',
  attended:'attend', attending:'attend', attends:'attend',
  announced:'announce', announces:'announce', announcing:'announce',
  blocked:'block', blocks:'block', blocking:'block', halted:'block', halts:'block', stops:'block', stopped:'block',
  approved:'approve', approves:'approve', approving:'approve',
  rejected:'reject', rejects:'reject', denying:'deny', denied:'deny', denies:'deny',
  arrested:'arrest', arrests:'arrest', released:'release', releases:'release',
  charged:'charge', charges:'charge', charging:'charge',
  investigated:'investigate', investigating:'investigate', investigations:'investigation',
  reopened:'reopen', reopens:'reopen', reversed:'reverse', reverses:'reverse', overturned:'reverse', overturns:'reverse',
  appealed:'appeal', appeals:'appeal', sued:'sue', sues:'sue',
  launched:'launch', launches:'launch', launching:'launch',
  agreed:'agree', agrees:'agree', agreement:'accord', agreements:'accord', pacts:'accord',
  announced:'announce', signed:'sign', selfregulation:'selfregulate', selfregulate:'selfregulate',
  trillion:'trillion', billions:'billion', millions:'million',
}));
const ACTIONS = new Set(`ask sign host attend announce block approve reject deny arrest release charge investigate reopen reverse appeal sue launch agree vote warn fire hire resign kill die buy sell win lose impose lift cancel expand cut raise settle`.split(' '));

function tokens(title) {
  const text = String(title || '').normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\ba\s*\.\s*i\s*\.?\b/gi, 'ai')
    .replace(/\bu\s*\.\s*s\s*\.?\b/gi, 'us')
    .replace(/artificial[\s-]+intelligence/gi, 'ai')
    .replace(/white[\s-]+house/gi, 'whitehouse')
    .replace(/self[\s-]*(?:police|policing|regulate|regulating|regulation)/gi, 'selfregulate')
    .replace(/tech(?:nology)?[\s-]+(?:firms?|companies|giants)/gi, 'techfirm')
    .toLowerCase();
  const words = text.match(/[a-z0-9]+/g) || [];
  return [...new Set(words.map(w => ALIASES.get(w) || w).filter(w => (w.length > 1 || /^\d$/.test(w)) && !STOP.has(w)))];
}

function dateOf(story, published) {
  const cand = Date.parse(story?.publishedAtSource || story?.earliestPublishedAtSource || story?.publishedAt || '');
  const old = Date.parse(published?.publishedAt || published?.publishedAtSource || '');
  return Number.isFinite(cand) && Number.isFinite(old) ? Math.abs(cand - old) / 3600000 : null;
}

/** Return null, or {status:'duplicate'|'review', ...}. Does not mutate inputs. */
export function compareEventHeadlines(story, published, { maxAgeHours = 96 } = {}) {
  if (!story?.title || !published?.title) return null;
  if (story.generalStoryKey && published.generalStoryKey && story.generalStoryKey === published.generalStoryKey) return null; // existing exact-key guard owns this
  const ageHours = dateOf(story, published);
  if (ageHours !== null && ageHours > maxAgeHours) return null;

  const a = tokens(story.title);
  const b = tokens(published.title);
  if (a.length < 4 || b.length < 4) return null;
  const sa = new Set(a), sb = new Set(b);
  const shared = a.filter(w => sb.has(w));
  if (shared.length < 4) return null;
  if (shared.filter(w => !GENERIC_TOPIC.has(w)).length < 2) return null;

  // Different explicit news actions are a strong reason to preserve a new
  // development (request vs signed agreement, block vs reverse, etc.).
  // A reversal is not another instance of the original blocking decision.
  if (a.includes('reverse') !== b.includes('reverse')) return null;
  const actionA = a.filter(w => ACTIONS.has(w));
  const actionB = b.filter(w => ACTIONS.has(w));
  if (actionA.length && actionB.length && !actionA.some(w => actionB.includes(w))) return null;

  // Explicitly different numbers often indicate different figures or cases.
  const numberA = a.filter(w => /^\d+$/.test(w));
  const numberB = b.filter(w => /^\d+$/.test(w));
  if (numberA.length && numberB.length && !numberA.some(w => numberB.includes(w))) return null;

  const jaccard = shared.length / new Set([...sa, ...sb]).size;
  const containment = shared.length / Math.min(sa.size, sb.size);
  let status = null;
  if ((jaccard >= 0.82 && containment >= 0.88) || (shared.length >= 5 && containment >= 0.94)) {
    status = 'duplicate';
  } else if ((jaccard >= 0.66 && containment >= 0.76) || (shared.length >= 5 && containment >= 0.86)) {
    status = 'review';
  }
  if (!status) return null;
  return {
    status,
    score: Number(jaccard.toFixed(3)),
    containment: Number(containment.toFixed(3)),
    shared,
    oldTitle: published.title,
    oldSlug: published.slug || null,
    oldStoryKey: published.generalStoryKey || null,
    ageHours: ageHours === null ? null : Math.round(ageHours),
  };
}

/** Prefer a definite duplicate over a possible related-story review. */
export function findEventDuplicate(story, publishedStories, options = {}) {
  let review = null;
  for (const published of publishedStories || []) {
    const result = compareEventHeadlines(story, published, options);
    if (!result) continue;
    if (result.status === 'duplicate') return result;
    if (!review || result.score > review.score) review = result;
  }
  return review;
}
