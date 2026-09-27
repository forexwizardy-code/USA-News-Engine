# US News Engine — Worklog

This file records each phase of work on the US News Engine project so future
agents (and humans) can pick up where the last one left off.

---

## Phase 5B — NWS story lifecycle + image-license audit (Task 5B-scripts)

**Agent:** general-purpose sub-agent
**Date:** 2026-09-27 (simulated project timeline)
**Scope:** Create three lifecycle / validation scripts and wire them into the
npm script registry.

### Files created

- `scripts/create-image-provenance.mjs`
  Reads every `*-real.json` in `data/draft-images/` and builds
  `data/image-provenance.json` — a registry of image provenance keyed by
  `originalImageUrl`. Each entry carries `sourcePageUrl`, `originalImageUrl`,
  `creator`, `license`, `licenseUrl`, `sourceOrganization`,
  `imageRelation`, `firstUsedAt`, and `storiesUsingImage`.
  Source-organization derivation:
    * If the parenthetical token at the end of the metadata's
      `sourceOrganization` equals `creator`, keep the metadata value (this is
      correct for the Lake County IL story where creator = "LakeCountyIL").
    * Otherwise derive from `creator` + `source`. For Wikimedia Commons
      images this yields `"{creator} (Wikimedia Commons)"` — which gives
      Lake County FL the required `"Ebyabe (Wikimedia Commons)"` instead of
      the stale templated `"LakeCountyIL"` value.
  Stories-using-image is derived strictly from scanning the article
  markdown frontmatter `image:` field and the published-stories registry's
  `heroImageSource`, so images that were prepared but ultimately not
  deployed (Surry, Bristol MA, Lanai Mauka real photos) correctly show an
  empty `storiesUsingImage` array.

- `scripts/validate-publishing.mjs`
  Validates the published-stories registry and article markdown files
  against ten editorial / SEO / image-licensing rules. Prints PASS/FAIL
  messages and exits with code 1 on any failure, 0 otherwise. Loads
  `data/draft-images/*-real.json` to look up `attributionRequired` for the
  creator-when-attribution-required check (falls back to license-based
  inference if the draft metadata is missing).

- `scripts/update-nws-lifecycle.mjs`
  Runs `npm run prepare:nws` (gracefully degrades to existing data files
  on network failure), then categorizes each NWS-derived story as NEW,
  UPDATED, UNCHANGED, EXPIRED, or CANCELLED. Defaults to DRY RUN; passing
  `--publish` applies lifecycle transitions to the registry only — it
  never modifies the 5 existing public article .md files and never
  auto-publishes NEW stories (operator must run the draft→article pipeline
  for those).

### package.json changes

Added two npm scripts:
- `"validate:publishing": "node scripts/validate-publishing.mjs"`
- `"update:nws": "node scripts/update-nws-lifecycle.mjs"`

### Data file produced

- `data/image-provenance.json` — 5 unique images keyed by originalImageUrl.

### Constraints honored

- `DEMO_NOINDEX` remains `true` in `src/consts.ts` (untouched).
- The 5 existing public articles in `src/content/articles/` were NOT
  modified.
- No test fixture articles were created in `src/content/articles/`.
- All three scripts are `.mjs` ES modules.
- Only Node.js built-ins are used (`fs/promises`, `path`, `url`,
  `child_process`). `sharp` is available in the project but not needed by
  any of these scripts. No `gray-matter` dependency — frontmatter is parsed
  manually with a flat key:value parser.

### Run results

1. `node scripts/create-image-provenance.mjs` — SUCCESS
   - 6 `*-real.json` files read; 5 unique images after dedup by
     `originalImageUrl` (one duplicate file
     `flood-warning-lake-county-illinois-real.json` shared the same
     `originalImageUrl` as the Bristol MA file and was merged).
   - Lake County FL correctly recorded as
     `sourceOrganization = "Ebyabe (Wikimedia Commons)"`.
   - Lake County IL kept its metadata value
     `"Lake County, Illinois (LakeCountyIL)"` (parenthetical matches
     creator).
   - `storiesUsingImage` populated only for lake-fl and lake-il (the two
     stories whose articles actually use the real photo). The Surry,
     Bristol MA, and Lanai Mauka real photos were prepared but the
     articles deployed with map images — those entries correctly show
     `storiesUsingImage: []` and `firstUsedAt` falls back to the
     `downloadedAt` from the real.json metadata.

2. `node scripts/validate-publishing.mjs` — SUCCESS (exit code 0)
   - 22 checks passed, 0 failed.
   - All 5 published stories have unique storyKeys, unique slugs, valid
     `heroImageRelation`, and (where licensed-photo) specific licenses with
     source page URLs and creators.
   - No raw `urn:oid:` alert IDs in any article markdown body.
   - All three map-data stories correctly credit "US News Engine" as the
     creator (not a person's name).

3. `node scripts/update-nws-lifecycle.mjs` (dry run) — SUCCESS (exit code 0)
   - `npm run prepare:nws` succeeded: 354 alerts fetched, 33 candidates
     selected, 31 unique NWS stories after dedup.
   - Compared 5 published stories against 31 current NWS stories.
   - Summary:
     ```
     NEW: 26
     UPDATED: 0
     UNCHANGED: 5
     EXPIRED: 0
     CANCELLED: 0
     ```
   - All 5 published stories remain in the active NWS feed with no new
     alert IDs → UNCHANGED. The 26 NEW stories are recent NWS alerts not
     yet covered by the site (operator must run the draft→article pipeline
     to publish any of them).

### Next actions for a future agent

- Decide which of the 26 NEW NWS stories (if any) should be drafted and
  published. The existing `generate-nws-draft.mjs` + `publish-5a-batch.mjs`
  pipeline can be re-run for a new batch.
- Run `node scripts/update-nws-lifecycle.mjs --publish` once the operator
  is ready to flip registry lifecycle states (e.g., when stories actually
  expire). In dry-run mode no files change.
- The validation script can be wired into CI / pre-commit hooks via
  `npm run validate:publishing`.
- The image-provenance registry should be rebuilt whenever new licensed
  photos are added: `node scripts/create-image-provenance.mjs`.

---

## Phase 7A — Recalls ingestion foundation (Task 7A-fetchers)

**Agent:** general-purpose sub-agent
**Date:** 2026-09-27 (simulated project timeline)
**Scope:** Build the recall-ingestion data pipeline that mirrors the existing
NWS pipeline (fetch → filter → stories → validate) for three new sources:
CPSC consumer-product recalls, FDA food enforcement recalls, and FDA device
enforcement recalls. All scripts are pure data-transformation steps — none
publish articles, touch the website, or use AI.

### Files created

- `scripts/fetch-cpsc-recalls.mjs`
  One GET request to `https://www.saferproducts.gov/RestWebServices/Recall`
  with `?format=json&RecallDateStart=YYYY-MM-DD` (30-day window). Falls back
  to keeping the most-recent slice if the date filter returns nothing.
  Normalizes each CPSC record into the shared recall schema (source /
  sourceType / sourceId / recallKey `cpsc__${RecallID}` / title / hazard
  derived from the `Hazards` array / `consumerAction` from `Remedies` +
  `RemedyOptions` / `upc` from `ProductUPCs` / `imageUrls` extracted from
  `Images[].URL` / etc.). Preserves the original CPSC record under
  `rawSourceData`. Atomic temp-file + rename write to
  `data/recalls/cpsc-recalls.json`.

- `scripts/fetch-fda-food-recalls.mjs`
  One GET request to `https://api.fda.gov/food/enforcement.json` with
  `?search=report_date:[YYYYMMDD+TO+YYYYMMDD]&limit=100`. Treats a 404
  response (zero matches) as a successful empty result rather than a hard
  failure so downstream scripts can still run. Converts the FDA `YYYYMMDD`
  date strings to ISO-8601 (`recall_initiation_date` → `recallDate`,
  `report_date` → `reportDate`). Derives a coarse `hazard` label from
  `reason_for_recall` by keyword matching (salmonella, listeria, E. coli,
  undeclared allergen, foreign material, glass, metal, plastic, etc.).
  Sets `recallKey = "fda-food__${recall_number}"`. Atomic write to
  `data/recalls/fda-food-recalls.json`.

- `scripts/fetch-fda-device-recalls.mjs`
  Same shape as the food fetcher but targets
  `https://api.fda.gov/device/enforcement.json` and uses
  `recallKey = "fda-device__${recall_number}"`. The device hazard
  keyword list also includes device-relevant terms (failure, malfunction,
  software error, battery, overheating, shock, sterility, leak, break,
  infection, embolism, airway, occlusion, dose, overdose, needle,
  detachment, etc.). Atomic write to `data/recalls/fda-device-recalls.json`.

- `scripts/filter-recall-news.mjs`
  Reads all three `*-recalls.json` snapshots and applies a newsworthiness
  filter:
  INCLUDE if ANY of — deaths/injuries > 0; hazard/reason contains a
  high-priority keyword (fire, burn, choking, poison, carbon monoxide,
  explosion, laceration, amputation, strangulation, suffocation, electric
  shock, tip-over) or a medium-priority keyword (contamination, lead,
  salmonella, E. coli, listeria, undeclared allergen, botulism, foreign
  material, glass, metal, plastic, infection, sterility, malfunction,
  failure, etc.); FDA Class I classification; nationwide distribution or
  10+ US states parsed out of `distribution_pattern`; unit count > 10000
  parsed out of `product_quantity`.
  EXCLUDE if title+description only mention "labeling correction" /
  "administrative update" with no safety hazard keyword anywhere.
  Each candidate carries a `priority` (`high` for deaths/injuries/Class I/
  fire/burn/choking; `medium` otherwise) and a human-readable
  `selectedReason`. Sorts high-priority first, then newest recallDate.
  Atomic write to `data/recalls/recall-news-candidates.json`.

- `scripts/build-recall-stories.mjs`
  Reads the candidates file, groups by `recallKey`, computes a
  deterministic `storyScore` (0–100) per the spec formula:
  base 30 + deaths 30 + injuries 15 + Class I 20 + Class II 10 +
  fire/burn/explosion 15 + choking/strangulation/suffocation 12 +
  poison/contamination/lead 12 + undeclared allergen 10 + nationwide 8 +
  10+ states 5 + units > 10K 5 + units > 100K 5 more + recent (≤7d) 5 +
  multiple source IDs +3 each (cap +9), capped at 100.
  Loads the previous `data/recalls/recall-story-records.json` snapshot (if
  present) and classifies each story as `new` / `updated` / `unchanged`
  by comparing a SHA-256 content signature (excludes volatile fields like
  `lastUpdatedAt` and `fetchedAt`). Preserves `firstSeenAt` across runs,
  sets `latestSeenAt = now`, tracks `updateCount` (cross-snapshot
  observation count) and `allSourceIds` (union across runs).
  Sorts by storyScore desc, then latestSeenAt newest first. Atomic write
  to `data/recalls/recall-story-records.json`.

- `scripts/validate-recalls.mjs`
  Validates the recall snapshots, candidates, and story records against
  nine rules: (1) every recall has a `recallKey`; (2) every recall has a
  `sourceUrl`; (3) every recall has a `sourceId`; (4) no duplicate
  `recallKey`s in the story records; (5) title/productName not both empty;
  (6) `recallDate` and `reportDate` parse as valid ISO-8601 when present;
  (7) `source` is "CPSC" or "FDA"; (8) numeric `deaths`/`injuries`/
  `incidents` are ≥ 0; (9) no malformed records (`imageUrls` is an array,
  not null; `rawSourceData` is present). Prints PASS/FAIL per check and
  exits with code 1 on any failure.

### package.json changes

Added seven npm scripts:
- `"fetch:cpsc"` / `"fetch:fda-food"` / `"fetch:fda-device"`
- `"fetch:recalls"` (chains all three fetchers)
- `"filter:recalls"`
- `"stories:recalls"`
- `"validate:recalls"`

### Data files produced (in `data/recalls/`)

- `cpsc-recalls.json` — 50 recalls (343 KB)
- `fda-food-recalls.json` — 47 recalls (147 KB)
- `fda-device-recalls.json` — 100 recalls (780 KB)
- `recall-news-candidates.json` — 176 candidates, 64 high + 112 medium
  priority (390 KB)
- `recall-story-records.json` — 176 unique stories (455 KB)

### Constraints honored

- No existing NWS/weather scripts were modified.
- `.github/workflows/nws-newsroom.yml` was not modified.
- `config/automation.json` was not modified.
- No public article files were created or modified.
- `DEMO_NOINDEX` remains `true` in `src/consts.ts` (untouched).
- All six new scripts are `.mjs` ES modules using only Node.js built-ins
  (`fs/promises`, `path`, `url`, `crypto`, `stream`). The only project
  file modified is `package.json` (eight new script entries appended).
- Each fetcher makes exactly ONE HTTP request to its source API, uses the
  shared `User-Agent: USNewsEngine/1.0 (https://usa-news-engine.forexwizardy.workers.dev)`,
  writes its output atomically (temp file + rename), and prints a
  summary (count, file path, file size).
- FDA fetchers treat HTTP 404 (zero-result) as a successful empty result
  so downstream scripts can still run when no recalls match the window.

### Run results

1. `npm run fetch:recalls` — SUCCESS (exit 0)
   - CPSC: 50 records fetched from the 30-day window starting 2026-08-28.
     Date filter was honored by the API (no fallback needed). File:
     `data/recalls/cpsc-recalls.json` (343,811 bytes).
   - FDA food: 47 records fetched from `report_date:[20260828 TO 20260927]`.
     File: `data/recalls/fda-food-recalls.json` (146,563 bytes).
     (Initial run failed with HTTP 500 because `encodeURIComponent` was
     encoding the `+` separators as `%2B`; switched to encoding spaces
     and then replacing `%20` with `+` per openFDA's parser expectation.)
   - FDA device: 100 records fetched (the limit). File:
     `data/recalls/fda-device-recalls.json` (779,551 bytes).
   - Total raw recalls ingested: 197.

2. `npm run filter:recalls` — SUCCESS (exit 0)
   - Input recalls: 197 (CPSC 50 + FDA-food 47 + FDA-device 100).
   - Candidates selected: 176 (high priority: 64, medium priority: 112).
   - Excluded: 21 — all "no newsworthiness trigger matched".
   - Top high-priority hits: ABC Trading light-up toys (burn hazard),
     Hyperfuels methanol/ethanol containers (poison), INMO Air3 smart
     glasses (10 injuries + burn + glass), Love To Dream sleep machines
     (fire + burn), NEWDERY power banks (2 injuries + fire + burn),
     Style Homeware / Xinan Home / ZCK01 mattresses (fire), Blue Cactus
     reclining-chair battery packs (fire + burn), Char-Broil electric
     grills (electric shock).
   - Candidates grouped by source: FDA-device 94, CPSC 48, FDA-food 34.
   - File: `data/recalls/recall-news-candidates.json` (389,847 bytes).

3. `npm run stories:recalls` — SUCCESS (exit 0)
   - First run: 176 unique stories, all `new` (no previous snapshot).
   - Second run (after re-fetching identical data): all 176 stories
     reclassified as `unchanged` with `updateCount=2`, confirming the
     content-signature change-detection and cross-snapshot tracking work.
   - Story score distribution: 0 stories in 90–100, 19 in 70–89, 76 in
     50–69, 81 in 30–49, 0 in 0–29. Top score = 73 (two Medline
     neonatal breathing-circuit recalls — Class II, 145,525 units,
     nationwide distribution, "burning odor" / "thermal damage" in
     reason text, which triggered the fire/burn bonus).
   - File: `data/recalls/recall-story-records.json` (454,929 bytes).

4. `npm run validate:recalls` — SUCCESS (exit 0)
   - 9/9 checks PASS, 0 FAIL.
   - All 197 recall records have `recallKey`, `sourceUrl`, `sourceId`,
     non-empty title/productName, valid ISO-8601 dates, valid `source`,
     non-negative numeric impact fields, and well-formed `imageUrls`
     arrays. No duplicate `recallKey`s in the story records.

### Next actions for a future agent

- The Phase 7A pipeline is wired and verified end-to-end. A future task
  can now build the article-generation layer on top of
  `data/recalls/recall-story-records.json` — analogous to the existing
  `generate-nws-draft.mjs` + `publish-5a-batch.mjs` pair for NWS.
- Consider scheduling `npm run fetch:recalls && npm run filter:recalls &&
  npm run stories:recalls && npm run validate:recalls` as a daily
  cron/CI job (the existing NWS workflow in
  `.github/workflows/nws-newsroom.yml` is the template — DO NOT modify
  that file; create a separate `recalls-newsroom.yml` if needed).
- The story-scoring weights in `build-recall-stories.mjs` are all
  centralized as named constants at the top of the file and can be
  retuned without touching the rest of the pipeline.
- The filter's `HIGH_PRIORITY_HAZARDS` / `MEDIUM_PRIORITY_HAZARDS` lists
  in `filter-recall-news.mjs` are also editable constants.
- Cross-snapshot status detection (`new` / `updated` / `unchanged`) is
  already implemented — a downstream article-publishing step can use
  `storyStatus === 'new'` to trigger a new article draft and
  `storyStatus === 'updated'` to trigger an update of an existing
  article.

---

## Phase 7B — Recall story clustering + editorial preview system (Task 7B-generators)

**Agent:** general-purpose sub-agent
**Date:** 2026-09-27 (simulated project timeline)
**Scope:** Build the article-generation + image-generation + preview-route
layer on top of the Phase 7A recall-ingestion pipeline. The new layer turns
clustered recall stories into private editorial-review article drafts (with
hero images and a hidden preview route) — analogous to the existing
`generate-nws-draft.mjs` + `generate-nws-image.mjs` + `src/pages/preview/[slug].astro`
pipeline for NWS weather stories. No public article files are created; every
output is a private draft or a hidden preview page.

### Files created

- `scripts/generate-recall-draft.mjs`
  Reads `data/recalls/recall-story-clusters.json`, takes the top story
  (or a `storyKey` passed as `argv[2]`), and writes exactly ONE private
  article draft to `data/recalls/drafts/<slug>.json`. The draft schema
  mirrors the NWS draft schema but adds a `recallMetadata` block
  (source, sourceType, recallingFirm, manufacturer, brands,
  primaryProductName, hazard, reason, classification, recallDates,
  reportDates, distribution, affectedStates, units, modelNumbers,
  lotNumbers, upcs, incidents, injuries, deaths, consumerAction,
  recordCount, storyScore, storyScoreReasons, storyStatus, firstSeenAt,
  latestSeenAt).
  Headline generation:
    * CPSC — parses the brand out of the CPSC recall title
      ("X Recalls Y Due to Z") and combines it with the
      `headlineSeed`/`primaryProductName` to produce
      "{Brand} {Product} Recalled Over {Hazard}".
    * FDA — combines `recallingFirm` with the slug-style product name
      embedded in `recallStoryKey` (the 4th `__`-segment) to produce
      "{Firm} {Product} Recalled Over {Hazard}".
  Hazard labels are derived from a keyword table (choking, fire, burn,
  salmonella, listeria, E. coli, lead, undeclared allergen, foreign
  material, etc.) — first match wins, falls back to "Safety Risk".
  Body sections (adapt by source, skip empty):
    1. Lead paragraph (no heading) — what / product / hazard / agency.
    2. "What is being recalled" — CPSC rawSourceData.Description or FDA
       primaryProductName.
    3. "Why it is being recalled" — CPSC hazard field; FDA reason field.
    4. "Products and models affected" — model/lot/UPC bullets (cluster
       arrays + CPSC rawSourceData.ProductUPCs/Products[].Model).
    5. "Where it was sold or distributed" — CPSC SoldAtLabel + Retailers;
       FDA distribution_pattern.
    6. "What consumers should do" — CPSC: preserve official remedy
       verbatim (URLs linkified). FDA: factual fallback
       "Consumers can review the FDA recall record for product and
       distribution details." (never invents "throw it away").
    7. "Reported incidents or injuries" — only emitted if source
       explicitly reports incidents/injuries/deaths (None-reported
       patterns are skipped). Distinguishes Deaths / Injuries / Incidents
       as separate labeled sentences — never inflates "one minor cut"
       into a serious-injury claim.
    8. "Source" — attribution paragraph naming the agency.
  `breaking` is true ONLY for explicit deaths OR hazard text containing
  "death"/"fatal"/"life-threatening" OR CPSC titles with "Serious Injury
  or Death". A Class I classification alone does NOT trigger breaking.
  HTML-escapes all source text and linkifies `http(s)://` URLs in the
  consumer-action paragraph.

- `scripts/generate-recall-image.mjs`
  Generates a 1200×675 hero image for a recall story in two paths:
    * CPSC photo path — if the story has `imageUrls` from the official
      CPSC record, downloads the first image, cover-crops to 1200×675
      (no distortion, sharp `position: 'attention'` for smart-crop
      focus), and saves as `data/draft-images/<slug>.jpg`. Preserves
      the original image URL, source URL, agency, caption, and alt text
      in the metadata sidecar. Looks up the original CPSC image caption
      (the `Images[].Caption` field) when available. CPSC recall photos
      are works of the U.S. federal government and are in the public
      domain — this is noted in `copyrightRisk` + `licenseNotes`.
    * Editorial graphic path — for FDA recalls (no images available)
      and CPSC recalls without `imageUrls`, generates a clean
      newsroom-style recall notice as SVG → PNG via sharp. The SVG has:
        - Dark left panel with "RECALL NOTICE" eyebrow, "RECALL" big
          headline, PRODUCT label + product name, RECALLING FIRM label
          + firm name, agency attribution, US News Engine branding.
        - Light right panel with HAZARD chip, REASON FOR RECALL text,
          and bottom data callouts (CLASSIFICATION, RECALL DATE, UNITS,
          DISTRIBUTION) — each emitted only when the source has it.
        - Subtle US News Engine branding (small text bottom-right).
      CPSC palette uses red (#c8102e, matches site `--color-red`);
      FDA palette uses navy blue (#0f4d8a). No fake product photography.
      No fake agency logos. Saves as `data/draft-images/<slug>.png`.
  The metadata sidecar (`data/draft-images/<slug>.json`) records
  storyKey, slug, type (`official-recall-photo` or
  `generated-editorial-graphic`), visualType, imageMode, dimensions,
  source, dataSource, agency, agencyShort, sourceUrl, originalImageUrl,
  caption, alt, copyrightRisk, licenseNotes, generatedAt, files.

- `scripts/generate-recall-previews.mjs`
  Batch script. Selects exactly 3 stories from recall-story-clusters.json:
    * ONE CPSC story (highest score)
    * ONE FDA food story (highest score)
    * ONE FDA device story (highest score)
  For each story, runs `node scripts/generate-recall-draft.mjs "<storyKey>"`
  and `node scripts/generate-recall-image.mjs "<storyKey>"` as child
  processes (stdio inherited so output streams to the parent), then
  copies the generated image from `data/draft-images/<slug>.{jpg|png}`
  into `public/preview-images/`. At the end, prints a summary table
  with each story's storyKey, slug, draft path, image path, preview
  image path, and preview URL.

- `src/pages/preview/recall/[slug].astro`
  Hidden preview route for recall article drafts. Uses the existing
  `PreviewLayout` (which already emits
  `<meta name="robots" content="noindex,nofollow,noarchive">`,
  self-referencing canonical, and NO NewsArticle schema — only WebSite
  + BreadcrumbList). Key differences from the weather preview at
  `src/pages/preview/[slug].astro`:
    * Category badge: "Recalls" (not "Weather").
    * Author: "US News Engine Consumer Safety Desk" (from the draft).
    * Source box: shows Organization (CPSC or FDA), Office, "Original
      recall →" link to the source URL, and "Official records: N" when
      the cluster has multiple source IDs.
    * Hero image: resolves `<slug>.jpg` first (CPSC photo path), then
      falls back to `<slug>.png` (FDA editorial graphic path).
    * Image caption: loaded from the image metadata sidecar (proper
      attribution — "Photo: Consumer Product Safety Commission" for
      CPSC photos; "Editorial graphic" license note for the generated
      graphics).
    * Aside card ("Recall details"): shows Category, Agency,
      Classification (when known), Distribution, Units, Recalling firm,
      Published, Updated, and Recall IDs (the latter on its own line
      with `word-break: break-all` so long ID lists wrap).
    * Breaking badge: shown when `draft.breaking === true` (red dot +
      "Breaking" label, next to the Recalls category badge).
  `getStaticPaths()` reads `data/recalls/drafts/` and emits one route
  per draft JSON file (drops a new draft in → it gets a preview page on
  the next build).

### package.json changes

Added three npm scripts (no existing entries modified):
- `"draft:recall": "node scripts/generate-recall-draft.mjs"`
- `"image:recall": "node scripts/generate-recall-image.mjs"`
- `"previews:recalls": "node scripts/generate-recall-previews.mjs"`

### Constraints honored

- No existing NWS/weather scripts or files were modified.
- `.github/workflows/nws-newsroom.yml` was not modified.
- `config/automation.json` was not modified.
- `src/consts.ts` (DEMO_NOINDEX) was not modified.
- No public article files were created or modified in
  `src/content/articles/`.
- All three new scripts are `.mjs` ES modules using only Node.js
  built-ins (`fs/promises`, `path`, `url`, `child_process`) plus `sharp`
  (already installed at `node_modules/sharp`).
- The preview route emits `noindex,nofollow,noarchive`, a
  self-referencing canonical to the preview URL, NO NewsArticle schema,
  and is excluded from the sitemap (verified — `dist/sitemap-0.xml`
  contains zero `/preview/` URLs after the build).
- The `node scripts/generate-recall-image.mjs` HTTP fetcher sends the
  shared `User-Agent: USNewsEngine/1.0 (https://usa-news-engine.forexwizardy.workers.dev)`
  header and uses `AbortSignal.timeout(30000)` so a hung download
  fails fast and falls back to the editorial-graphic path.
- All source text is HTML-escaped before being embedded in draft
  paragraphs (set:html in the preview route renders the escaped text
  faithfully — no XSS risk from CPSC/FDA source content).

### Data files produced

In `data/recalls/drafts/`:
- `melissa-and-doug-fire-truck-activity-board-toys-2026-09-17.json` (6,152 bytes)
- `international-sprout-holdings-inc-alfalfa-2026-08-23.json` (3,829 bytes)
- `medline-industries-lp-breathing-circuits-2026-07-13.json` (4,875 bytes)

In `data/draft-images/`:
- `melissa-and-doug-fire-truck-activity-board-toys-2026-09-17.jpg` (98,298 bytes) — official CPSC recall photo (cover-cropped)
- `melissa-and-doug-fire-truck-activity-board-toys-2026-09-17.json` (1,366 bytes) — metadata sidecar
- `international-sprout-holdings-inc-alfalfa-2026-08-23.png` (15,655 bytes) — FDA editorial graphic
- `international-sprout-holdings-inc-alfalfa-2026-08-23.svg` (5,439 bytes) — source SVG
- `international-sprout-holdings-inc-alfalfa-2026-08-23.json` (1,181 bytes) — metadata sidecar
- `medline-industries-lp-breathing-circuits-2026-07-13.png` (21,123 bytes) — FDA editorial graphic
- `medline-industries-lp-breathing-circuits-2026-07-13.svg` (6,040 bytes) — source SVG
- `medline-industries-lp-breathing-circuits-2026-07-13.json` (1,184 bytes) — metadata sidecar

In `public/preview-images/` (copied so the preview route can serve them):
- `melissa-and-doug-fire-truck-activity-board-toys-2026-09-17.jpg`
- `international-sprout-holdings-inc-alfalfa-2026-08-23.png`
- `medline-industries-lp-breathing-circuits-2026-07-13.png`

### Run results

1. `node scripts/generate-recall-previews.mjs` — SUCCESS (exit 0)
   - Selected stories (highest-scored per source/sourceType):
     * [CPSC]      score=72 — `CPSC____2026-09-17__lights sounds fire truck activity board__fire`
       (Melissa & Doug Fire Truck Activity Board, choking hazard, 26 incident reports + 1 minor cut)
     * [FDA Food]  score=79 — `FDA__international-sprout-holdings__2026-08-23__alfalfa__salmonella`
       (International Sprout Holdings alfalfa, Class I, potential E. coli + Salmonella, 43,799 units, 16 states)
     * [FDA Device] score=91 — `FDA__medline-industries__2026-07-13__breathing circuits__failure`
       (Medline Industries breathing circuits, Class II, thermal-damage risk, 416,931 units, worldwide)
   - For each story, generated the draft JSON, the hero image (+ sidecar),
     and copied the image into `public/preview-images/`.
   - Final preview URLs (all noindex,nofollow,noarchive; not in sitemap):
     * `/preview/recall/melissa-and-doug-fire-truck-activity-board-toys-2026-09-17/`
     * `/preview/recall/international-sprout-holdings-inc-alfalfa-2026-08-23/`
     * `/preview/recall/medline-industries-lp-breathing-circuits-2026-07-13/`

2. `npx astro build` — SUCCESS (exit 0)
   - 31 pages built in ~1.1s. Three new preview routes emitted:
     * `/preview/recall/international-sprout-holdings-inc-alfalfa-2026-08-23/index.html`
     * `/preview/recall/medline-industries-lp-breathing-circuits-2026-07-13/index.html`
     * `/preview/recall/melissa-and-doug-fire-truck-activity-board-toys-2026-09-17/index.html`
   - Verified per-page: `<meta name="robots" content="noindex,nofollow,noarchive">`,
     self-referencing canonical (preview URL only), `og:image` pointing
     at the local preview-image, only WebSite + BreadcrumbList JSON-LD
     (no NewsArticle), source box with "View official recall →" link.
   - Verified the FDA-device preview shows "Official records: 2" in the
     source box (cluster has Z-2992-2026 + Z-2993-2026); the CPSC and
     FDA-food previews correctly omit that row (recordCount=1).
   - Verified the FDA-device aside renders Classification (Class II),
     Distribution (Worldwide distribution), Units (416931), Recalling
     firm (Medline Industries, LP), and Recall IDs
     (Z-2992-2026, Z-2993-2026).
   - Verified the CPSC preview renders the "Reported incidents or
     injuries" section (source explicitly reports 26 incident reports +
     one minor cut); the FDA previews correctly skip that section.
   - Verified the CPSC preview renders the official CPSC photo with the
     caption "Recalled Lights & Sounds Fire Truck Activity Board. Photo:
     Consumer Product Safety Commission." and the attribution note
     "Official CPSC recall photo. CPSC recall images are works of the
     U.S. federal government and are in the public domain."
   - `dist/sitemap-0.xml` contains zero `/preview/` URLs (the existing
     `/preview/` filter in astro.config.mjs covers the new
     `/preview/recall/` subroute automatically).

3. `npm run validate:publishing` — SUCCESS (32/32 checks pass, 0 fail)
4. `npm run validate:recalls` — SUCCESS (9/9 checks pass, 0 fail)

### Next actions for a future agent

- The Phase 7B pipeline is wired end-to-end: recall-story-clusters.json →
  draft JSON + hero image + hidden preview page. An operator can now run
  `npm run previews:recalls` after each `npm run cluster:recalls` to
  refresh the 3 highest-priority previews for editorial review.
- The preview route at `/preview/recall/<slug>/` is intentionally NOT
  linked from the public site. Operators must know the slug to view a
  preview. The `getStaticPaths()` reads `data/recalls/drafts/` at build
  time, so dropping a new draft JSON into that directory will produce a
  new preview page on the next `astro build`.
- A future "publish" task could extend this layer to convert approved
  drafts into public `src/content/articles/<slug>.md` files (analogous
  to the existing `publish-5a-batch.mjs` for NWS weather stories). That
  step is intentionally out of scope here — Phase 7B only produces
  private editorial-review assets.
- The hazard-label keyword table at the top of both
  `generate-recall-draft.mjs` and `generate-recall-image.mjs` is a
  duplicated constant. If the lists drift out of sync, the headline
  hazard label and the image hazard chip could disagree. A future
  refactor could move this to a shared module under `src/lib/` or
  `scripts/lib/`. For now the duplication is intentional and the lists
  are byte-identical.
- The image generator's `linkifyUrls` only matches `http(s)://` URLs;
  bare `www.` URLs in CPSC consumer-action text are NOT linkified (the
  Melissa & Doug text mentions "www.melissaanddoug.com/recall" without
  a scheme). The text is preserved verbatim per spec; linkification of
  bare `www.` URLs is a future enhancement.

---

## Phase 7B.1 — Extend recall validation script (Task 7B.1-validation)

**Agent:** general-purpose sub-agent
**Date:** 2026-09-27 (simulated project timeline)
**Scope:** Extend `scripts/validate-recalls.mjs` with 15 new Phase 7B.1
checks against `data/recalls/recall-story-clusters.json`.

### Files modified

- `scripts/validate-recalls.mjs`
  Previously had 9 checks operating on the recall snapshots
  (`cpsc-recalls.json`, `fda-food-recalls.json`, `fda-device-recalls.json`)
  and the older `recall-story-records.json`. Extended with 15 new checks
  (numbered 10-24) that operate on `recall-story-clusters.json` (the
  Phase 7B.1 output of `cluster-recall-stories.mjs`). The existing 9
  checks and their semantics are unchanged; the new 15 checks are added
  alongside them and the script now reports a single combined
  PASS/FAIL summary across all 24 checks.

### New constants added

- `CLUSTERS_FILE` — points to `data/recalls/recall-story-clusters.json`.
- `HAZARD_KEYWORDS` — table mapping each normalized hazard label (e.g.
  "Fire Hazard", "Salmonella Risk", "Contamination Risk",
  "Potential Device Failure") to the keyword(s) that must appear
  (case-insensitive) in the `hazardEvidence` text for the label to be
  considered source-backed. Kept in sync with the
  `extractHazard`/`normalizeCpscHazard`/`normalizeFdaHazard` functions
  in `cluster-recall-stories.mjs`.
- `HAZARD_EVIDENCE_PREFIXES` — the three valid `hazardEvidence` source-
  field prefixes produced by `extractHazard`:
  `CPSC Hazards[].Name:`, `FDA reason_for_recall:`, `CPSC Title:`.
- `CPSC_IMAGE_URL_PREFIXES` — `https?://(www.)?cpsc.gov/` variants.

### New helper / loader

- `loadClusters()` — loads `recall-story-clusters.json` and returns the
  `stories` array (empty + warning if the file is missing or unreadable).
- `isNonEmptyString(v)` — small helper used across the new checks.

### The 15 new checks (numbered 10-24 in the script)

10. **No duplicate recallStoryKey** — collects all `recallStoryKey`
    values across the 138 cluster stories and fails on any duplicate.
11. **No empty key components** — splits each key on `__` and fails if
    any segment is empty (catches e.g. `cpsc____2026-09-17____fire`).
12. **Every story has sourceRecallIds** — fails if `sourceRecallIds`
    is missing or empty.
13. **No cluster with unrelated firms** — for clusters with 2+ records,
    fails if there is more than one distinct non-null `recallingFirm`
    or `manufacturer` value across the cluster's `rawSourceData` array.
14. **No unsupported normalized hazard** — if `hazardNormalized` is set,
    `hazardEvidence` must be a non-empty string starting with one of the
    three known source-field prefixes.
15. **Headline hazard supported by evidence** — if `hazardNormalized` is
    set, the corresponding keyword(s) from `HAZARD_KEYWORDS` must appear
    (case-insensitive) in `hazardEvidence`. For unknown labels (raw CPSC
    hazard names passed through), requires the label text itself to
    appear in the evidence.
16. **No unsupported injury claim** — if `injuries` is set on a story,
    at least one record in `rawSourceData` must have non-empty
    `injuries` text.
17. **No unsupported death claim** — same as above for `deaths`.
18. **No FDA external/unverified photo** — FDA stories must have an
    empty `imageUrls` array (FDA openFDA does not provide images).
19. **CPSC photo has source metadata** — for CPSC stories, every
    `imageUrls` entry must start with one of the `CPSC_IMAGE_URL_PREFIXES`.
20. **reportDate present when expected** — FDA stories must have a
    non-empty `fdaReportDates` array.
21. **No recall initiation/report date confusion** — for FDA stories,
    checks each `rawSourceData` record's `recallDate` <= `reportDate`
    (recall happens before report). Flags any pair where recall is
    later than report as a possible swap.
22. **No empty source URLs** — every entry in `sourceUrls` must be a
    non-empty string.
23. **No duplicate article slug** — checks for a `slug` field on
    cluster stories; if none exists (current state — slugs are generated
    later, at the draft/preview stage), the check passes with a warning
    explaining it's a no-op at this stage.
24. **No malformed source IDs** — every entry in `sourceRecallIds`
    must be a non-empty string.

### Run results

1. `npm run validate:recalls` — **FAIL (exit 1)**
   - **24 total checks** (9 existing + 15 new).
   - **22 passed, 2 failed.**
   - The 9 existing checks all PASS (snapshot data is clean).
   - The 15 new checks: 13 PASS, 2 FAIL.

   **Failures (both are real data-quality issues in the upstream
   pipeline — the validation script is correctly flagging them):**

   - **Check 15 (Headline hazard supported by evidence): 12 stories FAIL.**
     All 12 are FDA device stories with `hazardNormalized="Contamination
     Risk"` (Z-3048 through Z-3061, all BD ChloraPrep / FREPP
     applicator kit recalls). The `cluster-recall-stories.mjs`
     `extractHazard` function truncates the FDA `reason_for_recall`
     text to 200 characters in the `hazardEvidence` field. The full
     reason_for_recall text DOES contain "microbial contamination"
     (around character 240), so the cluster script correctly maps it
     to "Contamination Risk" — but the 200-char truncation cuts off
     the supporting keyword, so the visible `hazardEvidence` no longer
     contains "contamination". Fix would be in `cluster-recall-stories.mjs`:
     either increase the truncation length (e.g. 500 chars), or extract
     a context window around the matched keyword.

   - **Check 20 (reportDate present when expected): 90 stories FAIL.**
     Every FDA story (32 food + 58 device = 90) has
     `fdaReportDates: null` and `recallInitiationDates: null`. Root
     cause: in `cluster-recall-stories.mjs`'s `extractFdaDates(record)`
     function (line ~277), the code reads
     `record.rawSourceData?.recall_initiation_date` and
     `record.rawSourceData?.report_date` — but the candidate records
     passed to `buildClusterStory` have an EMPTY `rawSourceData: {}`
     object. The fetcher / filter pipeline normalized FDA's
     `recall_initiation_date` and `report_date` into the top-level
     `recallDate` and `reportDate` fields (which ARE populated on
     every FDA story), but did not preserve them inside
     `rawSourceData`. Fix would be in `cluster-recall-stories.mjs`:
     change `extractFdaDates` to read from `record.recallDate` and
     `record.reportDate` directly (or, more robustly, fall back to
     those fields when `rawSourceData` is empty).

   **Check 21 (No recall initiation/report date confusion) PASSes
   trivially** because `recallInitiationDates` is null everywhere —
   there are no records to compare. Once check 20 is fixed and the
   cluster script populates `recallInitiationDates` / `fdaReportDates`,
   this check will actually do real work.

### Verification

- Confirmed the script prints PASS/FAIL for each of the 24 checks with
  clear messages (each FAIL lists up to 20 specific offending story
  keys + a "... and N more errors" summary when over the cap).
- Confirmed the summary line: `Summary: 22/24 checks passed, 2 failed.`
- Confirmed the script exits with code 1 when any check fails (and
  would exit 0 if all passed).
- The 9 existing checks remain byte-identical in behavior — only the
  `checks` array and `main()` were extended to also run the 15 new
  checks.
- No NWS/weather files were touched.
- `config/automation.json` was not modified.
- `DEMO_NOINDEX` was not touched.

### Next actions for a future agent

1. **Fix check 15 failures (12 stories)** — in
   `scripts/cluster-recall-stories.mjs`'s `extractHazard` function,
   increase the FDA `reason_for_recall` truncation length in
   `hazardEvidence` from 200 to ~500 characters (or extract a window
   around the matching keyword). Re-run `npm run cluster:recalls` then
   `npm run validate:recalls` to confirm check 15 turns green.

2. **Fix check 20 failures (90 stories)** — in
   `scripts/cluster-recall-stories.mjs`'s `extractFdaDates(record)`
   function, read from `record.recallDate` and `record.reportDate`
   (top-level normalized fields) instead of
   `record.rawSourceData?.recall_initiation_date` and
   `record.rawSourceData?.report_date` (which are empty on candidate
   records). Re-run `npm run cluster:recalls` then
   `npm run validate:recalls`. This will also activate check 21 —
   verify it stays green.

3. **Optional cleanup** — the `HAZARD_KEYWORDS` table at the top of
   `validate-recalls.mjs` and the hazard-mapping logic in
   `cluster-recall-stories.mjs` are a third copy of the hazard-label
   mapping (the other two being `generate-recall-draft.mjs` and
   `generate-recall-image.mjs`, as noted in the previous worklog
   entry). A future refactor could move this to a shared module under
   `scripts/lib/recall-hazards.mjs` and have all four files import
   from it. For now the duplication is intentional and the lists are
   kept in sync.

---
