import type { APIRoute } from 'astro';
import { SITE_URL } from '../consts';

/**
 * Dynamically generated robots.txt.
 * Keeps the sitemap URL in sync with SITE_URL (src/consts.ts).
 */
const robots = `User-agent: *
Allow: /

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
