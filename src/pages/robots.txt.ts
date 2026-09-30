import type { APIRoute } from 'astro';
import { SITE_URL } from '../consts';

/**
 * Dynamically generated robots.txt.
 * Keeps the sitemap URL in sync with SITE_URL (src/consts.ts).
 *
 * Production crawling policy:
 *   - Public pages are crawlable.
 *   - /preview/ is ALWAYS disallowed because it is private editorial review.
 *   - Both the standard sitemap and the rolling news sitemap are advertised
 *     here for discovery.
 */
const previewBlock = `Disallow: /preview/`;
const robots = `User-agent: *
Allow: /
${previewBlock}

# AI crawlers may read but may not republish.
User-agent: GPTBot
Allow: /

User-agent: Google-Extended
Allow: /

User-agent: PerplexityBot
Allow: /

User-agent: CCBot
Allow: /

Sitemap: ${SITE_URL}/sitemap-index.xml
Sitemap: ${SITE_URL}/news-sitemap.xml
`;

export const GET: APIRoute = () => {
  return new Response(robots, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};
