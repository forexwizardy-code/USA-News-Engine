import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import { SITE_LANG, SITE_NAME, SITE_URL } from '../consts';

export const prerender = true;

const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;

function escapeXml(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export const GET: APIRoute = async () => {
  const now = Date.now();
  const cutoff = now - TWO_DAYS_MS;
  const articles = await getCollection('articles');

  const recent = articles
    .filter((article) => article.data.publishedAt.getTime() >= cutoff)
    .sort(
      (a, b) =>
        b.data.publishedAt.getTime() - a.data.publishedAt.getTime(),
    );

  const urls = recent
    .map((article) => {
      const loc = new URL(`/news/${article.data.slug}/`, SITE_URL).href;
      return `  <url>
    <loc>${escapeXml(loc)}</loc>
    <news:news>
      <news:publication>
        <news:name>${escapeXml(SITE_NAME)}</news:name>
        <news:language>${escapeXml(SITE_LANG)}</news:language>
      </news:publication>
      <news:publication_date>${article.data.publishedAt.toISOString()}</news:publication_date>
      <news:title>${escapeXml(article.data.title)}</news:title>
    </news:news>
  </url>`;
    })
    .join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">
${urls}
</urlset>
`;

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    },
  });
};
