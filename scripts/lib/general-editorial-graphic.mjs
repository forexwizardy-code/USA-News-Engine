import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';

function escapeXml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function wrapText(value, maxChars = 34, maxLines = 4) {
  const words = String(value || '').trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;

    if (candidate.length <= maxChars) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      current = word;
    }

    if (lines.length >= maxLines) break;
  }

  if (current && lines.length < maxLines) {
    lines.push(current);
  }

  if (lines.length > maxLines) {
    return lines.slice(0, maxLines);
  }

  return lines;
}

function buildUnionJackPanel() {
  return `
  <g transform="translate(835,82)">
    <rect x="0" y="0" width="295" height="170" rx="8" fill="#123a72" opacity="0.92"/>
    <clipPath id="ukClip">
      <rect x="0" y="0" width="295" height="170" rx="8"/>
    </clipPath>
    <g clip-path="url(#ukClip)">
      <rect x="128" y="-20" width="38" height="220" fill="#ffffff" opacity="0.95"/>
      <rect x="-20" y="66" width="340" height="38" fill="#ffffff" opacity="0.95"/>

      <polygon points="-10,0 20,0 305,155 305,170 275,170 -10,15" fill="#ffffff" opacity="0.92"/>
      <polygon points="275,0 305,0 20,170 -10,170 -10,155 275,0" fill="#ffffff" opacity="0.92"/>

      <rect x="136" y="-20" width="22" height="220" fill="#cf2136"/>
      <rect x="-20" y="74" width="340" height="22" fill="#cf2136"/>

      <polygon points="-10,0 6,0 305,162 305,170 289,170 -10,8" fill="#cf2136"/>
      <polygon points="289,0 305,0 6,170 -10,170 -10,162 289,0" fill="#cf2136"/>
    </g>
  </g>`;
}

function buildCustodyMotif(accent) {
  return `
  <g transform="translate(865,285)">
    <rect x="-8" y="0" width="10" height="220" fill="${accent}" opacity="0.28"/>
    <rect x="30" y="0" width="10" height="220" fill="${accent}" opacity="0.28"/>
    <rect x="68" y="0" width="10" height="220" fill="${accent}" opacity="0.28"/>
    <rect x="106" y="0" width="10" height="220" fill="${accent}" opacity="0.28"/>
    <rect x="144" y="0" width="10" height="220" fill="${accent}" opacity="0.28"/>

    <circle cx="235" cy="58" r="34" fill="#d9e0e6" opacity="0.88"/>
    <path d="M186 170
             C188 128, 216 108, 236 108
             C256 108, 284 128, 286 170
             L286 205
             L186 205 Z"
          fill="#d9e0e6"
          opacity="0.82"/>

    <rect x="178" y="208" width="116" height="7" fill="${accent}" opacity="0.22"/>
  </g>`;
}

function buildJusticeMotif(accent) {
  return `
  <g transform="translate(852,292)">
    <polygon points="158,0 268,52 48,52" fill="${accent}" opacity="0.20"/>
    <rect x="70" y="52" width="18" height="120" fill="${accent}" opacity="0.26"/>
    <rect x="120" y="52" width="18" height="120" fill="${accent}" opacity="0.26"/>
    <rect x="170" y="52" width="18" height="120" fill="${accent}" opacity="0.26"/>
    <rect x="220" y="52" width="18" height="120" fill="${accent}" opacity="0.26"/>
    <rect x="52" y="172" width="212" height="12" fill="${accent}" opacity="0.24"/>
    <rect x="36" y="188" width="244" height="14" fill="${accent}" opacity="0.18"/>
  </g>`;
}

function buildTechnologyMotif(accent) {
  return `
  <g transform="translate(850,290)">
    <rect x="80" y="30" width="170" height="150" rx="16"
          fill="${accent}" opacity="0.18"
          stroke="${accent}" stroke-width="4"/>

    <rect x="118" y="65" width="94" height="80" rx="8"
          fill="none" stroke="${accent}" stroke-width="5" opacity="0.65"/>

    <circle cx="165" cy="105" r="14" fill="${accent}" opacity="0.75"/>

    <path d="M40 65 H80 M40 105 H80 M40 145 H80
             M250 65 H290 M250 105 H290 M250 145 H290
             M115 0 V30 M165 0 V30 M215 0 V30
             M115 180 V215 M165 180 V215 M215 180 V215"
          stroke="${accent}" stroke-width="7" opacity="0.38"/>
  </g>`;
}

function buildFinanceMotif(accent) {
  return `
  <g transform="translate(850,300)">
    <rect x="35" y="150" width="38" height="70" fill="${accent}" opacity="0.30"/>
    <rect x="95" y="110" width="38" height="110" fill="${accent}" opacity="0.42"/>
    <rect x="155" y="65" width="38" height="155" fill="${accent}" opacity="0.55"/>
    <rect x="215" y="25" width="38" height="195" fill="${accent}" opacity="0.68"/>

    <path d="M25 175 L110 125 L170 105 L260 25"
          fill="none" stroke="#e5ebef" stroke-width="6" opacity="0.78"/>

    <polyline points="238,27 260,25 252,48"
              fill="none" stroke="#e5ebef" stroke-width="6" opacity="0.78"/>
  </g>`;
}

function buildEntertainmentMotif(accent) {
  return `
  <g transform="translate(850,300)">
    <rect x="35" y="55" width="235" height="155" rx="12"
          fill="${accent}" opacity="0.16"
          stroke="${accent}" stroke-width="5"/>

    <rect x="35" y="25" width="235" height="48"
          fill="${accent}" opacity="0.48"/>

    <path d="M55 25 L85 73 M105 25 L135 73
             M155 25 L185 73 M205 25 L235 73"
          stroke="#eef2f5" stroke-width="8" opacity="0.72"/>

    <polygon points="130,95 130,170 195,132"
             fill="#eef2f5" opacity="0.72"/>
  </g>`;
}

function buildMusicMotif(accent) {
  return `
  <g transform="translate(850,285)">
    <circle cx="120" cy="175" r="42" fill="${accent}" opacity="0.55"/>
    <circle cx="245" cy="145" r="42" fill="${accent}" opacity="0.55"/>

    <rect x="152" y="35" width="13" height="145"
          fill="${accent}" opacity="0.75"/>

    <rect x="277" y="5" width="13" height="145"
          fill="${accent}" opacity="0.75"/>

    <path d="M160 42 L284 10 L284 48 L160 80 Z"
          fill="${accent}" opacity="0.68"/>
  </g>`;
}

function buildSportsMotif(accent) {
  return `
  <g transform="translate(855,285)">
    <circle cx="170" cy="120" r="92"
            fill="${accent}" opacity="0.15"
            stroke="${accent}" stroke-width="6"/>

    <path d="M80 120 H260
             M170 28 V212
             M110 55 C160 95 160 145 110 185
             M230 55 C180 95 180 145 230 185"
          fill="none" stroke="${accent}" stroke-width="6" opacity="0.60"/>

    <path d="M75 235 H265"
          stroke="#e5ebef" stroke-width="8" opacity="0.28"/>
  </g>`;
}

function buildVehicleMotif(accent) {
  return `
  <g transform="translate(840,330)">
    <path d="M35 135
             L70 80
             Q82 60 108 60
             H225
             Q250 60 266 88
             L290 135
             V180
             H35 Z"
          fill="${accent}" opacity="0.38"/>

    <path d="M90 75 H215 L245 130 H62 Z"
          fill="#d9e0e6" opacity="0.20"/>

    <circle cx="90" cy="180" r="32" fill="#d9e0e6" opacity="0.72"/>
    <circle cx="240" cy="180" r="32" fill="#d9e0e6" opacity="0.72"/>
  </g>`;
}

function buildAircraftMotif(accent) {
  return `
  <g transform="translate(835,300)">
    <path d="M20 130
             L130 105
             L210 20
             L242 24
             L205 108
             L310 135
             L305 158
             L198 145
             L230 215
             L202 215
             L160 150
             L45 160 Z"
          fill="${accent}" opacity="0.58"/>
  </g>`;
}

function buildMedicalMotif(accent) {
  return `
  <g transform="translate(850,300)">
    <rect x="125" y="25" width="70" height="210" rx="8"
          fill="${accent}" opacity="0.42"/>
    <rect x="55" y="95" width="210" height="70" rx="8"
          fill="${accent}" opacity="0.42"/>

    <path d="M20 220 H90 L120 175 L150 245 L185 155 L215 220 H310"
          fill="none" stroke="#e8edf1" stroke-width="6" opacity="0.65"/>
  </g>`;
}

function buildFireMotif(accent) {
  return `
  <g transform="translate(875,285)">
    <path d="M140 240
             C55 210 45 145 90 95
             C120 62 126 40 117 5
             C190 45 230 100 205 150
             C235 135 252 112 254 88
             C294 150 270 225 205 245
             C185 252 160 252 140 240 Z"
          fill="${accent}" opacity="0.62"/>

    <path d="M155 220
             C120 198 118 165 145 138
             C165 118 172 95 166 73
             C210 104 220 149 198 183
             C185 203 172 217 155 220 Z"
          fill="#f1f4f6" opacity="0.32"/>
  </g>`;
}

function buildEducationMotif(accent) {
  return `
  <g transform="translate(840,305)">
    <path d="M35 80 L165 20 L300 80 L165 140 Z"
          fill="${accent}" opacity="0.52"/>

    <path d="M85 118 V185
             Q165 225 245 185
             V118"
          fill="${accent}" opacity="0.26"/>

    <path d="M300 82 V185"
          stroke="#e8edf1" stroke-width="7" opacity="0.60"/>

    <circle cx="300" cy="195" r="11" fill="#e8edf1" opacity="0.72"/>
  </g>`;
}

function buildHousingMotif(accent) {
  return `
  <g transform="translate(850,315)">
    <polygon points="35,115 155,20 275,115"
             fill="${accent}" opacity="0.52"/>

    <rect x="65" y="110" width="180" height="125"
          fill="${accent}" opacity="0.30"/>

    <rect x="135" y="155" width="45" height="80"
          fill="#e7ecef" opacity="0.28"/>

    <rect x="90" y="140" width="32" height="32"
          fill="#e7ecef" opacity="0.34"/>

    <rect x="195" y="140" width="32" height="32"
          fill="#e7ecef" opacity="0.34"/>
  </g>`;
}

function buildFoodMotif(accent) {
  return `
  <g transform="translate(850,310)">
    <circle cx="170" cy="130" r="100"
            fill="none" stroke="${accent}" stroke-width="10" opacity="0.40"/>

    <circle cx="170" cy="130" r="65"
            fill="${accent}" opacity="0.12"/>

    <path d="M38 30 V220 M22 30 V92 M38 30 V92 M54 30 V92"
          stroke="${accent}" stroke-width="8" opacity="0.55"/>

    <path d="M290 30 V220
             M268 30 C268 90 312 90 312 30"
          fill="none" stroke="${accent}" stroke-width="8" opacity="0.55"/>
  </g>`;
}

function buildSecurityMotif(accent) {
  return `
  <g transform="translate(855,290)">
    <path d="M165 20
             L280 62
             V135
             C280 205 230 245 165 270
             C100 245 50 205 50 135
             V62 Z"
          fill="${accent}" opacity="0.28"
          stroke="${accent}" stroke-width="6"/>

    <rect x="125" y="120" width="80" height="72" rx="10"
          fill="#e6ebef" opacity="0.45"/>

    <path d="M142 120 V95
             C142 62 188 62 188 95
             V120"
          fill="none" stroke="#e6ebef" stroke-width="12" opacity="0.55"/>
  </g>`;
}
function buildGenericMotif(accent) {
  return `
  <g transform="translate(830,285)">
    <circle cx="220" cy="90" r="82" fill="${accent}" opacity="0.10"/>
    <circle cx="220" cy="90" r="124" fill="none" stroke="${accent}" stroke-width="3" opacity="0.18"/>
    <path d="M70 196 L320 196" stroke="${accent}" stroke-width="4" opacity="0.18"/>
    <path d="M100 218 L320 218" stroke="${accent}" stroke-width="4" opacity="0.12"/>
    <path d="M130 240 L320 240" stroke="${accent}" stroke-width="4" opacity="0.10"/>
  </g>`;
}

export async function generateGeneralEditorialGraphic({
  draft,
  slug,
  draftImagesDir,
  publicImagesDir,
}) {
  const text = `${draft.title || ''} ${draft.description || ''}`;
  const lower = text.toLowerCase();

  const sensitive =
    /\b(terror|terrorism|terrorist|shooting|shot|murder|homicide|assault|attack|arrest|charged|charges|crime|criminal|police|fbi|hostage|bomb|explosion|killed|death)\b/i
      .test(lower);

  const ukStory =
    /\b(british|britain|uk|u\.k\.|united kingdom|england|london|scotland|wales)\b/i
      .test(text);

  const custodyStory =
    /\b(prison|jail|detained|detention|bail|arrest|arrested|charged|charges|trial|court|courthouse|custody|sentence|sentenced|police)\b/i
      .test(lower);

  const justiceStory =
    /\b(court|trial|judge|judges|justice|legal|lawsuit|indictment|hearing|senate|congress|parliament)\b/i
      .test(lower);

  const palettes = {
    us:            { accent: '#24577a', dark: '#102838', label: 'U.S. NEWS' },
    politics:      { accent: '#66517d', dark: '#292033', label: 'POLITICS' },
    business:      { accent: '#3e7157', dark: '#193126', label: 'BUSINESS' },
    technology:    { accent: '#355f91', dark: '#15283f', label: 'TECHNOLOGY' },
    entertainment: { accent: '#7a4d72', dark: '#33202f', label: 'ENTERTAINMENT' },
    sports:        { accent: '#8a6633', dark: '#382a16', label: 'SPORTS' },
  };

  const category = String(draft.category || 'us').toLowerCase();

  const palette = sensitive
    ? { accent: '#536879', dark: '#17222b', label: ukStory ? 'UK PUBLIC SAFETY' : 'PUBLIC SAFETY' }
    : (palettes[category] || palettes.us);

  const headlineLines = wrapText(draft.title, 35, 4);
  const descriptionLines = wrapText(draft.description, 60, 3);

  const sourceName =
    draft.primarySource?.name ||
    draft.primarySource?.publisherFamily ||
    'Cited source';

  const headlineSvg = headlineLines
    .map(
      (line, i) =>
        `<text x="70" y="${205 + i * 58}" font-family="Georgia, serif" font-size="45" font-weight="700" fill="#ffffff">${escapeXml(line)}</text>`
    )
    .join('\n');

  const descriptionSvg = descriptionLines
    .map(
      (line, i) =>
        `<text x="70" y="${475 + i * 26}" font-family="Arial, sans-serif" font-size="18" fill="#d6dde3">${escapeXml(line)}</text>`
    )
    .join('\n');

  const topPanel = ukStory ? buildUnionJackPanel() : '';
  // Pick an editorial visual from the actual story language.
  const technologyStory =
    /\b(ai|artificial intelligence|software|computer|cyber|cybersecurity|hack|hacker|chip|semiconductor|internet|app|robot|openai|google|microsoft|apple|technology|tech)\b/i.test(lower);

  const securityStory =
    /\b(cyberattack|security breach|data breach|spyware|malware|ransomware|security)\b/i.test(lower);

  const financeStory =
    /\b(stock|stocks|market|markets|economy|economic|inflation|bank|banking|money|price|prices|tariff|trade|earnings|dollar|finance|financial|bitcoin|crypto)\b/i.test(lower);

  const musicStory =
    /\b(music|musician|singer|song|album|concert|tour|spotify|grammy|band)\b/i.test(lower);

  const entertainmentStory =
    /\b(movie|film|hollywood|actor|actress|television|tv show|netflix|streaming|cinema|box office|emmy|oscar)\b/i.test(lower);

  const sportsStory =
    /\b(nfl|nba|mlb|nhl|football|basketball|baseball|soccer|hockey|tennis|golf|athlete|coach|team|playoff|championship|tournament)\b/i.test(lower);

  const aircraftStory =
    /\b(plane|airplane|aircraft|airline|airport|flight|aviation|jet)\b/i.test(lower);

  const vehicleStory =
    /\b(car|vehicle|truck|automobile|highway|road|crash|collision|driver|driving)\b/i.test(lower);

  const medicalStory =
    /\b(hospital|medical|doctor|health|disease|patient|medicine|drug|vaccine|virus|infection|surgery)\b/i.test(lower);

  const fireStory =
    /\b(fire|wildfire|flame|burning|burned|explosion|exploded|blast)\b/i.test(lower);

  const educationStory =
    /\b(school|university|college|student|students|teacher|education|campus|classroom)\b/i.test(lower);

  const housingStory =
    /\b(home|homes|house|housing|homeless|homelessness|rent|apartment|mortgage|property)\b/i.test(lower);

  const foodStory =
    /\b(food|restaurant|meal|grocery|fruit|vegetable|meat|coffee|drink|beverage)\b/i.test(lower);

  let visualType = 'generic';
  let motif = buildGenericMotif(palette.accent);

  if (custodyStory) {
    visualType = 'custody';
    motif = buildCustodyMotif(palette.accent);
  } else if (justiceStory) {
    visualType = 'justice';
    motif = buildJusticeMotif(palette.accent);
  } else if (securityStory) {
    visualType = 'security';
    motif = buildSecurityMotif(palette.accent);
  } else if (technologyStory) {
    visualType = 'technology';
    motif = buildTechnologyMotif(palette.accent);
  } else if (financeStory && !housingStory && !aircraftStory && !vehicleStory && !medicalStory && !fireStory && !educationStory && !foodStory) {
    visualType = 'finance';
    motif = buildFinanceMotif(palette.accent);
  } else if (musicStory) {
    visualType = 'music';
    motif = buildMusicMotif(palette.accent);
  } else if (entertainmentStory) {
    visualType = 'entertainment';
    motif = buildEntertainmentMotif(palette.accent);
  } else if (sportsStory) {
    visualType = 'sports';
    motif = buildSportsMotif(palette.accent);
  } else if (aircraftStory) {
    visualType = 'aircraft';
    motif = buildAircraftMotif(palette.accent);
  } else if (vehicleStory) {
    visualType = 'vehicle';
    motif = buildVehicleMotif(palette.accent);
  } else if (medicalStory) {
    visualType = 'medical';
    motif = buildMedicalMotif(palette.accent);
  } else if (fireStory) {
    visualType = 'fire';
    motif = buildFireMotif(palette.accent);
  } else if (educationStory) {
    visualType = 'education';
    motif = buildEducationMotif(palette.accent);
  } else if (housingStory) {
    visualType = 'housing';
    motif = buildHousingMotif(palette.accent);
  } else if (foodStory) {
    visualType = 'food';
    motif = buildFoodMotif(palette.accent);
  }

  const svg = `
<svg xmlns="http://www.w3.org/2000/svg"
     width="1200"
     height="675"
     viewBox="0 0 1200 675">

  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${palette.dark}"/>
      <stop offset="1" stop-color="#080d12"/>
    </linearGradient>
  </defs>

  <rect width="1200" height="675" fill="url(#bg)"/>
  <rect width="1200" height="9" fill="${palette.accent}"/>

  <circle cx="1030" cy="150" r="230"
          fill="none"
          stroke="${palette.accent}"
          stroke-width="3"
          opacity="0.12"/>

  <circle cx="1030" cy="150" r="160"
          fill="none"
          stroke="${palette.accent}"
          stroke-width="2"
          opacity="0.10"/>

  <path d="M780 110 L1160 110
           M830 155 L1160 155
           M880 200 L1160 200
           M930 245 L1160 245"
        stroke="${palette.accent}"
        stroke-width="3"
        opacity="0.10"/>

  <text x="70"
        y="82"
        font-family="Arial, sans-serif"
        font-size="15"
        font-weight="800"
        fill="${palette.accent}"
        letter-spacing="4">${escapeXml(palette.label)}</text>

  <rect x="70" y="102" width="110" height="4" fill="${palette.accent}"/>

  <g transform="translate(865,55)">
    <rect width="265" height="40" rx="4"
          fill="${palette.accent}"
          opacity="0.18"/>

    <text x="132"
          y="25"
          text-anchor="middle"
          font-family="Arial, sans-serif"
          font-size="12"
          font-weight="700"
          fill="#e6ebef"
          letter-spacing="1.5">EDITORIAL GRAPHIC</text>
  </g>

  ${topPanel}
  ${motif}

  ${headlineSvg}
  ${descriptionSvg}

  <rect x="0"
        y="610"
        width="1200"
        height="65"
        fill="#080b0f"
        opacity="0.9"/>

  <text x="70"
        y="648"
        font-family="Georgia, serif"
        font-size="18"
        font-weight="700"
        fill="#ffffff">US News Engine</text>

  <text x="245"
        y="648"
        font-family="Arial, sans-serif"
        font-size="12"
        fill="#919ba4">Source: ${escapeXml(sourceName)}</text>

  <text x="1130"
        y="648"
        text-anchor="end"
        font-family="Arial, sans-serif"
        font-size="11"
        fill="#77818a">NOT EVENT PHOTOGRAPHY</text>

</svg>`;

  await mkdir(draftImagesDir, { recursive: true });
  await mkdir(publicImagesDir, { recursive: true });

  const filename = `${slug}-editorial.png`;
  const draftPath = join(draftImagesDir, filename);
  const publicPath = join(publicImagesDir, filename);

  await sharp(Buffer.from(svg))
    .resize(1200, 675, { fit: 'fill' })
    .png({ quality: 90, compressionLevel: 9 })
    .toFile(draftPath);

  if (draftPath !== publicPath) {
    await copyFile(draftPath, publicPath);
  }

  await writeFile(
    draftPath.replace(/\.png$/, '.svg'),
    svg,
    'utf8'
  );

  await writeFile(
    join(draftImagesDir, `${slug}-editorial.json`),
    JSON.stringify({
      provider: 'US News Engine',
      type: 'generated-editorial-graphic',
      title: draft.title,
      category: draft.category,
      sensitiveStory: sensitive,
      ukStory,
      custodyStory,
      justiceStory,
      visualType,
      sourcePageUrl: draft.primarySource?.url || '',
      width: 1200,
      height: 675,
      generatedAt: new Date().toISOString(),
    }, null, 2) + '\n',
    'utf8'
  );

  return {
    ok: true,
    imagePath: `/images/${filename}`,
    alt: `Editorial graphic for ${draft.title}`,
    caption: sensitive
      ? 'US News Engine editorial graphic based on the cited story context. This is not a photograph of the incident or people involved.'
      : 'US News Engine editorial graphic based on the cited story context.',
    creator: 'US News Engine (original editorial graphic)',
    license: 'Original editorial graphic generated by US News Engine',
    licenseUrl: '',
    sourcePageUrl: draft.primarySource?.url || '',
    relation: 'generated-editorial-graphic',
  };
}
