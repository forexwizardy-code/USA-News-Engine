/**
 * Site-wide configuration for US News Engine.
 *
 * These values drive the masthead, navigation, SEO, structured data,
 * and sitemap. Update `SITE_URL` and `SITE_NAME` before launch.
 *
 * This file is intentionally centralized so that future automation
 * (article generators, schedulers) and the frontend share one source
 * of truth for site metadata.
 */

export const SITE_URL = 'https://usa-news-engine.forexwizardy.workers.dev';
export const SITE_NAME = 'US News Engine';
export const SITE_TAGLINE = 'Independent reporting from across America';
export const SITE_DESCRIPTION =
  'US News Engine delivers fast, factual coverage of U.S. news, weather, recalls, consumer affairs, and science — all in one place.';
export const SITE_LOCALE = 'en_US';
export const SITE_LANG = 'en';

/**
 * DEMO CONTENT SAFETY — temporary, Phase 1 only.
 *
 * While the site serves fictional sample articles, this flag emits
 * `<meta name="robots" content="noindex,nofollow">` on every page so the
 * demo content can never be accidentally indexed by search engines.
 *
 * Set this to `false` (and remove the flag) once real, automated news
 * replaces the demo content and the site is ready to be crawled.
 */
export const DEMO_NOINDEX = true;

/** Default OpenGraph / Twitter share image (lives in /public). */
export const DEFAULT_SHARE_IMAGE = '/images/og-default.svg';

/** Organization info used in Organization + NewsArticle schema. */
export const ORG = {
  name: SITE_NAME,
  url: SITE_URL,
  logo: `${SITE_URL}/logo.svg`,
  sameAs: [] as string[],
};

/**
 * Canonical category registry. Order here controls nav + sitemap grouping.
 * `slug` is the URL segment, `label` is the display name, `nav` controls
 * whether it appears in the main navigation bar.
 */
export interface CategoryDef {
  slug: string;
  label: string;
  nav: boolean;
  description: string;
}

export const CATEGORIES: CategoryDef[] = [
  {
    slug: 'us',
    label: 'U.S.',
    nav: true,
    description:
      'National and state-level coverage of government, politics, and civic life across the United States.',
  },
  {
    slug: 'weather',
    label: 'Weather',
    nav: true,
    description:
      'Forecasts, severe weather alerts, storm tracking, and climate reporting for every region.',
  },
  {
    slug: 'recalls',
    label: 'Recalls',
    nav: true,
    description:
      'Product, food, and medical-device recall notices plus safety information for consumers.',
  },
  {
    slug: 'consumer',
    label: 'Consumer',
    nav: true,
    description:
      'Money, markets, prices, and investigations that help Americans make informed decisions.',
  },
  {
    slug: 'science',
    label: 'Science',
    nav: true,
    description:
      'Discoveries, research, and breakthroughs from the worlds of space, health, and technology.',
  },
  // Phase 10A.2 — General U.S. News categories. nav=false: not in top
  // navigation yet (previews only; will surface after publishing enables).
  {
    slug: 'politics',
    label: 'Politics',
    nav: false,
    description:
      'Government actions, legislation, court decisions, and documented political developments.',
  },
  {
    slug: 'business',
    label: 'Business',
    nav: false,
    description:
      'Markets, the economy, companies, and developments affecting American wallets and work.',
  },
  {
    slug: 'technology',
    label: 'Technology',
    nav: false,
    description:
      'Artificial intelligence, cybersecurity, consumer tech, and the industry shaping America\u2019s future.',
  },
  {
    slug: 'entertainment',
    label: 'Entertainment',
    nav: false,
    description:
      'Film, music, streaming, and cultural developments from across the entertainment industry.',
  },
  {
    slug: 'sports',
    label: 'Sports',
    nav: false,
    description:
      'Major leagues, championships, and the stories shaping American professional and college sports.',
  },
];

/** "Latest" is a reverse-chronological feed of all articles, not a category. */
export const LATEST = {
  slug: 'latest',
  label: 'Latest',
  description: 'The most recent stories from every section of US News Engine.',
};

/** Helper: map a category slug to its display label. */
export function categoryLabel(slug: string): string {
  const found = CATEGORIES.find((c) => c.slug === slug);
  return found ? found.label : slug;
}

/** Helper: absolute URL for a path. */
export function absUrl(path: string): string {
  const clean = path.startsWith('/') ? path : `/${path}`;
  return `${SITE_URL}${clean}`;
}
