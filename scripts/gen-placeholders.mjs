/**
 * One-off generator for polished, consistent SVG placeholder images.
 * Run once: `bun run scripts/gen-placeholders.mjs`
 *
 * Each article in src/content/articles references one of these files via its
 * `image` frontmatter field. To upgrade to real photography later, simply
 * replace the files in public/images/ — no code changes required.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, '..', 'public', 'images');
await mkdir(outDir, { recursive: true });

const W = 1200;
const H = 675;

/**
 * Build a placeholder SVG.
 * - top: thin red accent strip
 * - bg: two-stop linear gradient (themed)
 * - icon: white line-art path(s) drawn at large scale
 * - footer: dark band with "US NEWS ENGINE" + category label
 */
function svg({ id, category, from, to, icon }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${category} placeholder image">
  <defs>
    <linearGradient id="g-${id}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${from}"/>
      <stop offset="1" stop-color="${to}"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#g-${id})"/>
  <rect x="0" y="0" width="${W}" height="10" fill="#c8102e"/>
  <g opacity="0.16" fill="#ffffff">
    <circle cx="${W - 120}" cy="150" r="180"/>
  </g>
  <g transform="translate(600 300)" fill="none" stroke="#ffffff" stroke-width="14" stroke-linecap="round" stroke-linejoin="round" opacity="0.95">
    ${icon}
  </g>
  <rect x="0" y="${H - 90}" width="${W}" height="90" fill="#0f1115" opacity="0.82"/>
  <text x="60" y="${H - 50}" font-family="Georgia, 'Times New Roman', serif" font-size="30" fill="#ffffff" font-weight="700">US News Engine</text>
  <text x="60" y="${H - 22}" font-family="Arial, sans-serif" font-size="18" fill="#b8bdc4" letter-spacing="2">${category.toUpperCase()}</text>
</svg>`;
}

const icons = {
  // Capitol dome + columns
  senate: `<path d="M-150 60 L150 60 L150 40 L-150 40 Z"/>
    <path d="M-120 40 L-120 -10 L120 -10 L120 40"/>
    <path d="M-90 -10 L-90 -60 L90 -60 L90 -10"/>
    <path d="M0 -120 C -70 -120 -90 -70 -90 -60 L90 -60 C 90 -70 70 -120 0 -120 Z"/>
    <path d="M-70 -60 L-70 40 M-35 -60 L-35 40 M0 -60 L0 40 M35 -60 L35 40 M70 -60 L70 40"/>`,
  // Cloud + lightning
  storm: `<path d="M-120 10 C -170 10 -170 -60 -110 -60 C -100 -110 -10 -120 20 -70 C 90 -80 130 -20 90 10 Z"/>
    <path d="M-10 30 L30 30 L0 80 L40 80 L-20 150 L10 95 L-25 95 Z" fill="#ffffff" stroke="none"/>`,
  // Car silhouette
  recall: `<path d="M-150 30 L-120 -20 L120 -20 L150 30 L150 60 L-150 60 Z"/>
    <circle cx="-90" cy="60" r="28"/>
    <circle cx="90" cy="60" r="28"/>
    <path d="M-100 -20 L-70 -55 L70 -55 L100 -20"/>`,
  // Monitor with dollar
  ftc: `<rect x="-130" y="-90" width="260" height="160" rx="10"/>
    <path d="M-60 70 L60 70 L70 100 L-70 100 Z"/>
    <text x="0" y="20" font-family="Georgia, serif" font-size="90" fill="#ffffff" stroke="none" text-anchor="middle" font-weight="700">$</text>`,
  // Asteroid + stars
  asteroid: `<circle cx="0" cy="0" r="110"/>
    <circle cx="-40" cy="-30" r="16"/>
    <circle cx="35" cy="20" r="22"/>
    <circle cx="10" cy="-55" r="10"/>
    <g stroke-width="6">
      <path d="M-150 -120 L-130 -120 M150 -100 L170 -100 M-160 130 L-140 130 M140 140 L160 140"/>
    </g>`,
  // Transmission towers + lines
  grid: `<path d="M-30 -120 L30 -120 L40 -40 L-40 -40 Z M-20 -120 L-20 -40 M20 -120 L20 -40"/>
    <path d="M-150 60 L-40 -40 M150 60 L40 -40"/>
    <path d="M-150 -30 L-40 -30 M150 -30 L40 -30"/>
    <path d="M0 60 L0 100"/>`,
  // Shopping bag
  grocery: `<path d="M-80 -40 L80 -40 L100 120 L-100 120 Z"/>
    <path d="M-45 -40 C -45 -100 45 -100 45 -40"/>`,
  // Crop rows / wheat
  crops: `<g>
      <path d="M-150 60 L150 60"/>
      <path d="M-150 20 L150 20"/>
      <path d="M-150 -20 L150 -20"/>
      <path d="M-150 -60 L150 -60"/>
    </g>
    <path d="M0 -120 L0 60 M-20 -100 L0 -80 M20 -100 L0 -80 M-25 -70 L0 -50 M25 -70 L0 -50"/>`,
  // Sun with rays (heat)
  heat: `<circle cx="0" cy="0" r="70"/>
    <g stroke-width="12">
      <path d="M0 -120 L0 -95 M0 95 L0 120 M-120 0 L-95 0 M95 0 L120 0"/>
      <path d="M-85 -85 L-67 -67 M85 85 L67 67 M-85 85 L-67 67 M85 -85 L67 -67"/>
    </g>`,
  // Snowflake (frozen food)
  foodRecall: `<path d="M0 -120 L0 120 M-104 -60 L104 60 M-104 60 L104 -60"/>
    <path d="M0 -120 L-20 -100 M0 -120 L20 -100 M0 120 L-20 100 M0 120 L20 100"/>
    <path d="M-104 -60 L-90 -35 M-104 -60 L-80 -75 M104 60 L90 35 M104 60 L80 75"/>
    <path d="M104 -60 L90 -35 M104 -60 L80 -75 M-104 60 L-90 35 M-104 60 L-80 75"/>`,
};

const set = [
  { id: 'senate', file: 'article-senate.svg', category: 'U.S. Politics', from: '#1b2a4a', to: '#0e1730', icon: icons.senate },
  { id: 'storm', file: 'article-storm.svg', category: 'Weather', from: '#33414f', to: '#1a222b', icon: icons.storm },
  { id: 'recall', file: 'article-recall.svg', category: 'Recalls', from: '#1f6f6b', to: '#0f3b39', icon: icons.recall },
  { id: 'ftc', file: 'article-ftc.svg', category: 'Consumer', from: '#5b3a8c', to: '#2e1d49', icon: icons.ftc },
  { id: 'asteroid', file: 'article-asteroid.svg', category: 'Science', from: '#1a2236', to: '#070b14', icon: icons.asteroid },
  { id: 'grid', file: 'article-grid.svg', category: 'U.S. Energy', from: '#b5560f', to: '#5e2c06', icon: icons.grid },
  { id: 'grocery', file: 'article-grocery.svg', category: 'Consumer', from: '#2f7d46', to: '#173f24', icon: icons.grocery },
  { id: 'crops', file: 'article-crops.svg', category: 'Science', from: '#4a7d2f', to: '#244016', icon: icons.crops },
  { id: 'heat', file: 'article-heat.svg', category: 'Weather', from: '#c8451a', to: '#6e1f06', icon: icons.heat },
  { id: 'food-recall', file: 'article-food-recall.svg', category: 'Food Recall', from: '#2f6d8c', to: '#163645', icon: icons.foodRecall },
];

for (const item of set) {
  await writeFile(join(outDir, item.file), svg(item), 'utf8');
  console.log('wrote', item.file);
}

// ---- favicon ----
const favicon = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="8" fill="#c8102e"/>
  <text x="32" y="42" font-family="Arial, sans-serif" font-size="26" font-weight="800" fill="#ffffff" text-anchor="middle">US</text>
</svg>`;
await writeFile(join(__dirname, '..', 'public', 'favicon.svg'), favicon, 'utf8');
console.log('wrote favicon.svg');

// ---- OpenGraph default share image ----
const og = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="ogbg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#14161a"/>
      <stop offset="1" stop-color="#0a0c0f"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#ogbg)"/>
  <rect x="0" y="0" width="1200" height="12" fill="#c8102e"/>
  <g transform="translate(120 200)">
    <rect width="86" height="86" rx="6" fill="#c8102e"/>
    <text x="43" y="62" font-family="Arial, sans-serif" font-size="34" font-weight="800" fill="#ffffff" text-anchor="middle">US</text>
  </g>
  <text x="120" y="370" font-family="Georgia, 'Times New Roman', serif" font-size="78" font-weight="700" fill="#ffffff">US News Engine</text>
  <text x="122" y="430" font-family="Arial, sans-serif" font-size="30" fill="#b8bdc4">Source-driven news from across America</text>
  <rect x="120" y="470" width="180" height="6" fill="#c8102e"/>
</svg>`;
await writeFile(join(outDir, 'og-default.svg'), og, 'utf8');
console.log('wrote og-default.svg');

console.log('\nDone. Placeholder images in public/images/');
