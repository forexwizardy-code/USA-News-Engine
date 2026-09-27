import { getCollection, type CollectionEntry } from 'astro:content';

export type Article = CollectionEntry<'articles'>;

/**
 * Return all articles, newest first. Collection entries are keyed by `slug`
 * inside frontmatter (we also keep the slug field explicit for automation).
 */
export async function getAllArticles(): Promise<Article[]> {
  const articles = await getCollection('articles');
  return articles.sort(
    (a, b) => b.data.publishedAt.getTime() - a.data.publishedAt.getTime(),
  );
}

/** Articles flagged breaking, newest first. */
export async function getBreaking(): Promise<Article[]> {
  const all = await getAllArticles();
  return all.filter((a) => a.data.breaking);
}

/** The single featured hero story (falls back to the newest article). */
export async function getFeatured(): Promise<Article> {
  const all = await getAllArticles();
  return all.find((a) => a.data.featured) ?? all[0];
}

/** Newest N articles, optionally excluding a set of slugs. */
export async function getLatest(
  limit: number,
  exclude: Set<string> = new Set(),
): Promise<Article[]> {
  const all = await getAllArticles();
  return all.filter((a) => !exclude.has(a.data.slug)).slice(0, limit);
}

/** Articles in a category, newest first. */
export async function getByCategory(category: string): Promise<Article[]> {
  const all = await getAllArticles();
  return all.filter((a) => a.data.category === category);
}

/** Most-read ranking (by views desc), newest first as tiebreaker. */
export async function getMostRead(limit: number): Promise<Article[]> {
  const all = await getAllArticles();
  return [...all]
    .sort(
      (a, b) =>
        b.data.views - a.data.views ||
        b.data.publishedAt.getTime() - a.data.publishedAt.getTime(),
    )
    .slice(0, limit);
}

/** Articles that carry a U.S. state, for "Across America". */
export async function getAcrossAmerica(limit = 8): Promise<Article[]> {
  const all = await getAllArticles();
  return all.filter((a) => a.data.state).slice(0, limit);
}

/**
 * Related stories: prefer same category, then overlapping tags, then newest.
 * Never includes the current article.
 */
export async function getRelated(
  current: Article,
  limit = 3,
): Promise<Article[]> {
  const all = await getAllArticles();
  const others = all.filter((a) => a.data.slug !== current.data.slug);

  const sameCategory = others.filter(
    (a) => a.data.category === current.data.category,
  );
  const tagMatches = others
    .map((a) => ({
      article: a,
      overlap: a.data.tags.filter((t) => current.data.tags.includes(t)).length,
    }))
    .filter((x) => x.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap)
    .map((x) => x.article);

  const ranked = [...sameCategory, ...tagMatches];
  const seen = new Set<string>();
  const out: Article[] = [];
  for (const a of ranked) {
    if (seen.has(a.data.slug)) continue;
    seen.add(a.data.slug);
    out.push(a);
    if (out.length >= limit) break;
  }
  // Pad with newest remaining articles if we don't have enough.
  if (out.length < limit) {
    for (const a of others) {
      if (seen.has(a.data.slug)) continue;
      seen.add(a.data.slug);
      out.push(a);
      if (out.length >= limit) break;
    }
  }
  return out;
}

/** "5 hours ago"-style relative time for cards; falls back to absolute date. */
export function relativeTime(date: Date, now: Date = new Date()): string {
  const diffMs = now.getTime() - date.getTime();
  const sec = Math.round(diffMs / 1000);
  const min = Math.round(sec / 60);
  const hr = Math.round(min / 60);
  const day = Math.round(hr / 24);
  if (sec < 60) return 'just now';
  if (min < 60) return `${min} min ago`;
  if (hr < 24) return `${hr} hr ago`;
  if (day === 1) return 'yesterday';
  if (day < 7) return `${day} days ago`;
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/** Long, human-readable timestamp, e.g. "March 14, 2025 at 9:42 PM EDT". */
export function formatDateTime(date: Date): string {
  return date.toLocaleString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

/** ISO timestamp for <time dateTime> attributes and structured data. */
export function iso(date: Date): string {
  return date.toISOString();
}

/**
 * Format a date for U.S. readers in a specific timezone.
 * Produces: "September 27, 2026 at 12:03 p.m. CDT"
 *
 * Uses Intl.DateTimeFormat with the America/Chicago (or other) timezone
 * to convert from the stored UTC timestamp. Falls back to UTC offset if the
 * timezone cannot be determined.
 *
 * Only use a specific timezone when it can be safely derived from the story's
 * source context (e.g. NWS office location). Otherwise, use formatDateTimeUTC.
 */
export function formatDateTimeTZ(date: Date, timezone: string = 'America/Chicago'): string {
  try {
    const dateFormatter = new Intl.DateTimeFormat('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
      timeZone: timezone,
    });
    const timeFormatter = new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: timezone,
      timeZoneName: 'short',
    });
    // Intl produces "12:03 PM CDT" — convert to "12:03 p.m. CDT"
    const timeStr = timeFormatter
      .format(date)
      .replace(/\bAM\b/g, 'a.m.')
      .replace(/\bPM\b/g, 'p.m.');
    return `${dateFormatter.format(date)} at ${timeStr}`;
  } catch {
    // Invalid timezone — fall back to UTC display
    return formatDateTime(date);
  }
}

/**
 * Format a date for U.S. readers in UTC (fallback when no safe timezone can
 * be derived). Produces: "September 27, 2026 at 5:03 p.m. UTC"
 */
export function formatDateTimeUTC(date: Date): string {
  return date.toLocaleString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short',
    hour12: true,
  }).replace(/\bAM\b/g, 'a.m.').replace(/\bPM\b/g, 'p.m.');
}
