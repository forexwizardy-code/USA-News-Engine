import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

/**
 * Articles collection.
 *
 * Each article is a Markdown file in `src/content/articles/<slug>.md`.
 * Frontmatter holds all metadata; the Markdown body is the article body.
 *
 * This schema is the contract for future automated article generation:
 * a generator script only needs to emit a .md file whose frontmatter
 * validates against this Zod schema, and the site will publish it on the
 * next build — homepage sections, category pages, related stories, SEO,
 * and structured data are all derived automatically.
 */
const articles = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/articles' }),
  schema: z.object({
    /** Stable, human-readable URL segment, e.g. "senate-infrastructure-vote". */
    slug: z.string(),
    /** Editorial headline. */
    title: z.string(),
    /** One-to-two sentence summary / dek used in cards and meta description. */
    description: z.string(),
    /** Category slug — must match one of the CATEGORIES in src/consts.ts. */
    category: z.enum(['us', 'weather', 'recalls', 'consumer', 'science', 'politics', 'business', 'technology', 'entertainment', 'sports']),
    /** Byline author name. */
    author: z.string(),
    /** ISO 8601 publish time. */
    publishedAt: z.coerce.date(),
    /** ISO 8601 last-updated time. Omitted/null on first publication. */
    updatedAt: z.coerce.date().optional(),
    /** Hero image path (lives in /public). */
    image: z.string(),
    /** Accessibility text for the hero image. */
    imageAlt: z.string(),
    /** Image mode: licensed-photo, map-data, agency-graphic, fallback-graphic. */
    imageMode: z.string().optional(),
    /** Image caption for display beneath the hero. */
    imageCaption: z.string().optional(),
    /** Image creator/photographer for attribution. */
    imageCreator: z.string().optional(),
    /** Image license (e.g. "CC BY 2.0"). */
    imageLicense: z.string().optional(),
    /** Image license URL. */
    imageLicenseUrl: z.string().optional(),
    /** Originating source attribution name. */
    sourceName: z.string(),
    /** Originating source URL. */
    sourceUrl: z.string().url(),
    /** Source office (e.g. "NWS Chicago IL"). Optional. */
    sourceOffice: z.string().optional(),
    /** Free-form tags for related-story matching and discovery. */
    tags: z.array(z.string()).default([]),
    /** U.S. state associated with the story (for "Across America"). Optional. */
    state: z.string().optional(),
    /** Surface in the breaking-news strip. */
    breaking: z.boolean().default(false),
    /** Feature as the lead hero story on the homepage. */
    featured: z.boolean().default(false),
    /** Relative popularity for "Most Read" ranking. Optional. */
    views: z.number().int().nonnegative().default(0),
  }),
});

export const collections = { articles };
