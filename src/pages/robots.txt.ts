import type { APIRoute } from 'astro';
import { SITE_URL, DEMO_NOINDEX } from '../consts';

/**
 * Dynamically generated robots.txt.
 * Keeps the sitemap URL in sync with SITE_URL (src/consts.ts).
 *
 * Phase 10A future-launch audit:
 *   - While DEMO_NOINDEX is true, the site is globally noindex via
 *     <meta name="robots"> on every page. robots.txt still Allow: /
 *     so the sitemap can be discovered, but crawlers respect the meta
 *     tag and will not index.
 *   - /preview/ is ALWAYS Disallowed — these are private editorial
 *     review pages (noindex,nofollow,noarchive) that must never be
 *     crawled, even after launch.
 *   - When DEMO_NOINDEX is flipped to false (Phase 10B), the public
 *     category/article paths remain Allow: / and will become crawlable.
 *     No robots.txt change is required at that time.
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
`;

export const GET: APIRoute = () => {
  return new Response(robots, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};
