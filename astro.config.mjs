// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// Change this to your production domain before launch.
// Used for canonical URLs, sitemap, OpenGraph, and structured data.
const SITE = 'https://www.usnewsengine.com';

// https://astro.build/config
export default defineConfig({
  site: SITE,
  // Static-first output. Future automation can drop new .md files into
  // src/content/articles and a rebuild will publish them automatically.
  output: 'static',
  trailingSlash: 'ignore',
  build: {
    format: 'directory',
  },
  integrations: [
    sitemap({
      // Sitemap is generated automatically at /sitemap-index.xml on build.
      // Individual article + category pages are included by default.
      // Exclude draft/preview pages from the sitemap.
      filter: (page) => !page.includes('/draft/') && !page.includes('/preview/'),
    }),
  ],
  image: {
    // Allow remote placeholder domains if ever needed; local assets by default.
    domains: [],
  },
  prefetch: {
    prefetchAll: false,
    defaultStrategy: 'hover',
  },
  // Forwarded to the underlying Vite dev server.
  // The preview gateway reaches the dev server through a dynamic runtime
  // hostname (e.g. ws-*.cn-hongkong-vpc.fcapp.run), so we allow all hosts to
  // avoid Vite's "Blocked request ... not allowed" guard in development.
  // This only affects `astro dev`, never the production build.
  vite: {
    server: {
      allowedHosts: true,
    },
  },
});
