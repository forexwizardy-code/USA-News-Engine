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

## Phase 7D — Recall newsroom automation (Task 7D-automation)

**Agent:** general-purpose sub-agent
**Date:** 2026-09-27 (simulated project timeline)
**Scope:** Wire the Phase 7A–7C recall ingestion + draft + image pipeline into
an unattended GitHub-Actions-driven newsroom loop, mirroring the existing
NWS newsroom automation. Adds a published-recalls registry, a master
orchestration script with a kill switch + daily/per-run caps, and a
standalone `recall-newsroom.yml` workflow that runs twice daily on cron.

### Files created

- `scripts/build-published-recalls-registry.mjs`
  Reads every `*.md` article in `src/content/articles/` whose frontmatter
  `category` is `recalls`, pairs each one with its clustered-story record
  from `data/recalls/recall-story-clusters.json` (via the slug → storyKey
  mapping in `data/recalls/drafts/*.json`, with a fallback to the image
  sidecar's `storyKey`), and emits `data/published-recalls.json` — the
  persistent source of truth for recall publication history.
  Each registry entry carries: `recallStoryKey`, `slug`, `articlePath`,
  `publishedAt`, `updatedAt`, `sourceType` (`consumer-product` for CPSC,
  `food` / `device` for FDA), `sourceRecallIds`, `allSourceRecallIds`,
  `sourceUrls`, `storyStatus`, `classification`, `hazardNormalized`,
  `lastSeenAt` (from the cluster's `latestSeenAt`), `lastCheckedAt`,
  `imageMode`, `imageSource`, `imageCreator`, `imageLicense`,
  `imageLicenseUrl`, and `imageSourceUrl` (the recall page URL for CPSC
  photos, or the FDA data-downloads URL for FDA graphics).

- `scripts/run-recall-newsroom.mjs`
  Master recall automation script. Orchestrates: fetch (CPSC + FDA food +
  FDA device) → filter → cluster → load registry → reconcile against the
  cluster feed → process UPDATED stories (preserve slug + publishedAt,
  set `updatedAt`, merge new `sourceRecallIds` into `allSourceRecallIds`,
  refresh classification/hazard from the cluster, bump the article file's
  `updatedAt` frontmatter) → check daily UTC cap → select NEW stories
  (`publishEligible=true`, sorted by `priority` high-first then
  `storyScore` descending, capped at `maxRecallNewPerRun` AND the daily
  remaining) → for each new story run `generate-recall-draft` + image,
  copy the generated image to `public/images/`, write the article
  markdown file, append a registry entry → save registry → run
  `validate:recalls` + `validate:publishing` + `astro build`. Exits
  before validation/build if 0 new + 0 updated (no-change behavior).
  Uses `execSync` for every sub-script and surfaces stderr on failure.

- `.github/workflows/recall-newsroom.yml`
  Standalone GitHub Actions workflow. `workflow_dispatch` +
  `schedule: 17 8,20 * * *` (twice daily at 08:17 and 20:17 UTC).
  `ubuntu-latest`, `permissions: contents: write`. Steps: checkout →
  setup Bun + Node.js 24 → `bun install` → `npm run newsroom:recalls` →
  read `recallPublishingEnabled` from `config/automation.json` →
  `git diff --quiet -- src/ public/ data/published-recalls.json` →
  if changes AND publishing enabled: `npm run build`, commit with
  `git config user.name "US News Engine Bot"` /
  `newsroom@users.noreply.github.com` and message
  `"Automated recall newsroom update: YYYY-MM-DD HH:mm UTC"`, push,
  `npx wrangler deploy` with `CLOUDFLARE_API_TOKEN` +
  `CLOUDFLARE_ACCOUNT_ID`, then live-verify that `/`, `/recalls/`,
  and `/latest/` all return HTTP 200. No-change path: exit success.

### package.json changes

Added two npm scripts (no existing entries modified):
- `"registry:recalls": "node scripts/build-published-recalls-registry.mjs"`
- `"newsroom:recalls": "node scripts/run-recall-newsroom.mjs"`

### Data file produced

- `data/published-recalls.json` — 3 entries, one per existing published
  recall article:
  - `fda-food__H-1341-2026` → `international-sprout-holdings-inc-alfalfa-2026-08-23`
    (FDA food, Class I, Salmonella Risk, agency-graphic hero).
  - `fda-device__cluster__dfe5b4e87f8d` → `medline-industries-lp-breathing-circuit-2026-07-13`
    (FDA device, Class II, Potential Device Failure, agency-graphic hero).
  - `cpsc__11000` → `newdery-power-banks-2026-09-24`
    (CPSC consumer-product, Fire Hazard, licensed-photo hero — official
    CPSC recall photo, public-domain U.S. government work).

### Run results

1. `node scripts/build-published-recalls-registry.mjs` — SUCCESS (exit 0)
   - Loaded 138 cluster stories, 8 recall drafts, 6 image sidecars.
   - Wrote `data/published-recalls.json` with 3 stories.
   - All three slugs mapped cleanly to a `recallStoryKey` via the
     `data/recalls/drafts/<slug>.json` → `storyKey` field; cluster
     stories were then located by `recallStoryKey`.
   - The `medline-industries-lp-breathing-circuit-2026-07-13.md` article
     pairs with `fda-device__cluster__dfe5b4e87f8d` (the cluster that
     merges Z-2992-2026 + Z-2993-2026); the sidecar file was renamed by
     an editor at publish time but the draft JSON's `storyKey` field
     still pointed at the correct cluster, so the registry entry is
     correct.

2. `npm run newsroom:recalls` (dry run — `recallPublishingEnabled=false`) —
   SUCCESS (exit 0, duration 3.1s)
   - Kill switch: `recallPublishingEnabled = false`
   - Caps: `maxRecallNewPerRun=1`, `maxRecallNewPerDay=3`
   - Pipeline: fetched (CPSC 50, FDA-food 47, FDA-device 100 records)
     → filtered (176 candidates) → clustered (138 stories, 40
     publish-eligible, 26 high-priority + 14 medium-priority).
   - Reconciled against the 3-entry registry:
     - NEW: 37 publish-eligible stories not yet published
     - UPDATED: 0
     - UNCHANGED: 3 (the 3 already-published articles)
     - MISSING: 0
   - Daily cap: 3 already published today (UTC, all carrying
     `publishedAt = 2026-09-27T21:41:17.264Z`), so 0 remaining, 0
     allowed this run — this is a temporary artifact of the simulated
     project timeline (all 3 articles were "published" today); the
     cap will reset on the next UTC day.
   - Kill switch active → printed summary and exited. NO content changes
     were made. Verified via `git diff --name-only HEAD -- src/ public/
     data/published-recalls.json data/published-stories.json` → empty
     (only transient fetcher output files under `data/recalls/` and the
     derived cluster file changed, which the workflow's change-detection
     step correctly ignores).
   - The `.github/workflows/recall-newsroom.yml` change-detection step
     (`git diff --quiet -- src/ public/ data/published-recalls.json`)
     would have evaluated to "no changes" and the workflow would have
     taken the no-change notification path — exactly the intended
     behavior when the kill switch is off.

### Constraints honored

- `.github/workflows/nws-newsroom.yml` was NOT modified.
- `scripts/run-nws-newsroom.mjs` was NOT modified.
- `config/automation.json` was NOT modified — `recallPublishingEnabled`
  remains `false`, `maxRecallNewPerRun=1`, `maxRecallNewPerDay=3`, and
  the existing NWS settings (`nwsPublishingEnabled=true`,
  `maxNewPerRun=2`, `maxNewPerDay=8`) are untouched.
- `data/published-stories.json` (NWS registry) was NOT modified.
- No weather article files in `src/content/articles/` were modified.
- `DEMO_NOINDEX` remains `true` in `src/consts.ts` (untouched).
- Both new scripts are `.mjs` ES modules using only Node.js built-ins
  (`fs/promises`, `path`, `url`, `child_process`). No new dependencies
  added. `sharp` is already installed and is only invoked indirectly
  via `generate-recall-image.mjs`.
- The workflow uses `GITHUB_TOKEN` (via `permissions: contents: write`)
  — no personal PAT required.
- Git identity: `US News Engine Bot <newsroom@users.noreply.github.com>`.
- Commit message format: `"Automated recall newsroom update: YYYY-MM-DD HH:mm UTC"`.
- Deploy: `npx wrangler deploy` with `CLOUDFLARE_API_TOKEN` +
  `CLOUDFLARE_ACCOUNT_ID` secrets (same as the NWS workflow).
- Live verification: 3-page check (`/`, `/recalls/`, `/latest/` — all
  must return HTTP 200).

### Next actions for a future agent

1. **Flip the kill switch to enable automated publishing.** Edit
   `config/automation.json` and set `recallPublishingEnabled: true`.
   The next scheduled run (08:17 or 20:17 UTC) will then publish the
   single highest-priority NEW story (subject to the daily cap of 3).
   The 37 NEW publish-eligible stories in the current feed would be
   published 1 per run / 3 per day, in priority-then-score order.

2. **Daily-cap reset.** All 3 existing recall articles carry
   `publishedAt` on 2026-09-27 (UTC), which saturates today's cap. The
   cap will reset at 00:00 UTC the following day. If a same-day emergency
   publish is needed, manually bump `maxRecallNewPerDay` in
   `config/automation.json` or temporarily delete the stale registry
   entries (NOT recommended — they're real publications).

3. **UPDATE path is wired but not yet exercised.** The Phase 7D
   `processUpdate()` updates the registry entry, bumps `updatedAt` in
   the article frontmatter, and refreshes classification/hazard fields
   from the cluster — but it does NOT regenerate the article body. A
   future enhancement could call `generate-recall-draft.mjs` with the
   storyKey and re-render the body sections (similar to how
   `update-article-frontmatter.mjs` works for NWS). For now, updates
   only bump metadata.

4. **MISSING path is detected but not acted on.** When a registry
   story's `recallStoryKey` is no longer present in the cluster feed
   (because the upstream source removed the recall from the API
   response, or because re-clustering produced a different cluster
   signature), the story is counted in `MISSING` but no automatic
   lifecycle transition is applied. A future enhancement could set
   `storyStatus: 'stale'` and add a banner to the article (similar to
   the NWS `expired` lifecycle).

5. **The `imageLicenseUrl` field is currently always empty for recall
   articles.** CPSC recall photos are public-domain U.S. government
   works (no license URL needed), and FDA editorial graphics are
   original US News Engine works (no external license URL). If a future
   CPSC photo source provides a specific license URL, the registry
   builder will pick it up from the article frontmatter's
   `imageLicenseUrl` field automatically.

6. **The Phase 7B.1 worklog noted that 2 of the 24 `validate:recalls`
   checks fail (check 15 and check 20).** Those failures are upstream
   data-quality issues in `cluster-recall-stories.mjs` and are not
   introduced by Phase 7D. The `run-recall-newsroom.mjs` script runs
   `validate:recalls` as Step 13 — if the kill switch is flipped on,
   the script will exit with code 1 at Step 13 because those two
   checks still fail. Fix the two upstream issues (per the Phase 7B.1
   "Next actions" list) BEFORE enabling `recallPublishingEnabled`.

---

## Phase 8A — USGS earthquake ingestion foundation (Task 8A-pipeline)

**Agent:** general-purpose sub-agent
**Date:** 2026-09-27 (simulated project timeline)
**Scope:** Create the four-script earthquake pipeline (fetch → filter →
stories → validate), wire it into the npm script registry, and run it
end-to-end against the live USGS GeoJSON feeds. No article files,
automation.json, workflows, or other-domain (NWS / recall) scripts are
touched.

### Files created

- `scripts/fetch-usgs-earthquakes.mjs`
  Fetches BOTH USGS Earthquake Hazards Program GeoJSON feeds with a single
  HTTP request each (2 total, aborts after 45 s):
    * `2.5_week` — all M2.5+ earthquakes, past 7 days.
    * `significant_week` — significant earthquakes, past 7 days (PAGER
      events; can include sub-M2.5 noteworthy quakes).
  User-Agent is `USNewsEngine/1.0 (https://usa-news-engine.forexwizardy.workers.dev)`.
  Each GeoJSON Feature is normalized into the shared earthquake schema
  (source/sourceId/earthquakeKey/magnitude/place/time/url/alert/tsunami/
  significance/depth/lat/lon/isUS/state/country/nearestPlace/
  rawSourceData…). U.S. relevance is detected deterministically from the
  `place` field — every U.S. state name (Alaska, Hawaii, California,
  Puerto Rico, etc.) and every U.S. territory (Guam, U.S. Virgin Islands,
  American Samoa, Northern Mariana Islands) is matched longest-key-first
  so multi-word names like "New Mexico" beat shorter substrings. The
  nearest place name is parsed from the canonical USGS place format
  ("X km DIR of PlaceName, State"). Events from both feeds are merged and
  de-duplicated by USGS event ID (preferring the significant_week entry
  when the same event appears in both feeds). Output is written atomically
  to `data/earthquakes/usgs-earthquakes.json` with metadata wrapper
  (fetchedAt, source, sourceUrls, feedsUsed, totalEvents,
  usRelevantCount, earthquakes[]). If one feed fails the other is still
  processed; if both fail the script exits with code 1.

- `scripts/filter-earthquake-news.mjs`
  Reads `usgs-earthquakes.json` and applies the documented newsworthiness
  filter. INCLUDE if ANY of: M5+ & isUS / M4+ & isUS with felt≥100 or
  alert∈{yellow,orange,red} or tsunami / M6+ anywhere / PAGER alert
  yellow-orange-red / tsunami / significance≥500 & isUS / M3.5+ & isUS &
  felt≥500 / M4.5+ in Alaska/Hawaii/Puerto Rico. EXCLUDE if status=deleted,
  magnitude<3.0, or magnitude is null. Each candidate gets a
  `selectedReason` (semicolon-joined list of triggers) and a `priority`
  ("high" for M5+ or alert/tsunami events; "medium" otherwise). Output is
  sorted high-priority first, then magnitude desc, then newest first.
  Writes `data/earthquakes/earthquake-news-candidates.json` atomically.

- `scripts/build-earthquake-stories.mjs`
  Reads candidates, deduplicates by `earthquakeKey`, and writes
  `data/earthquakes/earthquake-story-records.json`. Story score (0-100,
  deterministic):
    * Base 20
    * Magnitude tiered bonus (highest applicable only): +30 (M7+), +20
      (M6+), +12 (M5+), +6 (M4+)
    * PAGER alert: +20 (red), +15 (orange), +8 (yellow)
    * Tsunami: +15
    * Felt (stacks): +10 (≥1000), +5 (≥100)
    * isUS: +8
    * Shallow depth (<10 km): +5
    * USGS significance ≥1000: +5
    * Cap 100
  Cross-snapshot tracking: firstSeenAt, latestSeenAt, updateCount
  (incremented each run the story reappears), previousMagnitude (set to
  the prior run's magnitude only when it changed; null on first run / no
  change), currentMagnitude, storyStatus ("new" on first run;
  "updated"/"unchanged" by SHA-256 content signature on subsequent runs).
  Content signature excludes volatile time/updated fields and focuses on
  magnitude/alert/tsunami/status/felt/cdi/mmi/place/depth/coordinates.
  Sorted by storyScore desc, then latestSeenAt desc.

- `scripts/validate-earthquakes.mjs`
  Runs the 12 documented checks against all three Phase 8A files. The
  record-level checks (1-10 and 12) run against BOTH the fetched snapshot
  and the candidates file, and are then re-run against the story-records
  file (so every story also has a valid key/id/url/magnitude/coordinates/
  depth/timestamp/boolean isUS/boolean tsunami). Check 11 (storyScore
  0-100) runs against the story-records file only. Exits with code 1 on
  any failure, 0 otherwise. 34 total checks (11 per file × 3 files plus
  the stories-file storyScore check, with the "file exists" check firing
  only when a file is missing). All 34 passed in the live run.

### package.json changes

Added five npm scripts:
- `"fetch:earthquakes": "node scripts/fetch-usgs-earthquakes.mjs"`
- `"filter:earthquakes": "node scripts/filter-earthquake-news.mjs"`
- `"stories:earthquakes": "node scripts/build-earthquake-stories.mjs"`
- `"validate:earthquakes": "node scripts/validate-earthquakes.mjs"`
- `"prepare:earthquakes": "npm run fetch:earthquakes && npm run filter:earthquakes && npm run stories:earthquakes && npm run validate:earthquakes"`

### Data files produced (live run on 2026-09-27)

- `data/earthquakes/usgs-earthquakes.json` (742,656 bytes, 320 events)
- `data/earthquakes/earthquake-news-candidates.json` (3,122 bytes, 2 candidates)
- `data/earthquakes/earthquake-story-records.json` (3,644 bytes, 2 stories)

### Run results

1. `npm run fetch:earthquakes` — fetched 320 events from `2.5_week`
   (320 features) + 1 event from `significant_week` (1 feature). After
   dedup by USGS event ID, 320 total events (the significant_week M6.6
   New Caledonia event was already present in 2.5_week). 126 U.S.-relevant,
   194 non-U.S. Top 5 by magnitude all non-U.S. (New Caledonia M6.6,
   Tonga M5.7, Papua New Guinea M5.6, New Caledonia M5.5, Indonesia M5.5).
   Sample U.S.-relevant events all M2.5-2.6 quakes in Alaska and New
   Mexico.

2. `npm run filter:earthquakes` — selected 2 of 320 candidates:
    * `usgs__us6000txpi` — M6.6 New Caledonia (high priority,
      "M6.6 >= 6.0 (major global event)"), alert=green, tsunami=false.
    * `usgs__us6000txxm` — M4.6 Rat Islands, Aleutian Islands, Alaska
      (medium priority, "M4.6 >= 4.5 in active U.S. seismic zone"), isUS
      true, state=Alaska, alert=null.
   318 excluded: 226 "no newsworthiness trigger matched", 92 "magnitude <
   3.0 (too small)". 1 U.S.-relevant candidate, 1 high-priority candidate,
   1 medium-priority candidate.

3. `npm run stories:earthquakes` — 2 unique stories, both "new" on first
   run. Story scores:
    * `usgs__us6000txpi` — score=40 (base 20 + M6 tier 20; alert=green
      gives no bonus, felt=11 doesn't hit 100, depth=10 doesn't hit <10,
      sig=678 doesn't hit 1000).
    * `usgs__us6000txxm` — score=34 (base 20 + M4 tier 6 + isUS 8).
   Verified second-run behavior: re-running stories marked both as
   "unchanged" with updateCount=2 and previousMagnitude=null (no magnitude
   change between runs).

4. `npm run validate:earthquakes` — all 34 checks PASS across all three
   data files (11 record-level checks × 3 files + 1 storyScore check).
   Exit code 0.

### Design decisions

1. **Magnitude bonuses are tiered (highest applicable only).** An M7.0
   event is also ≥6.0 and ≥5.0 and ≥4.0, but the spec lists each tier as
   a separate line without a "stacks" annotation. Tiering prevents an
   M7 from picking up +30+20+12+6=68 magnitude points alone (which would
   saturate the cap). Felt bonuses ARE stacked (felt≥1000 implies
   felt≥100), mirroring the Phase 7A precedent where BONUS_UNITS_GT_10K
   and BONUS_UNITS_GT_100K explicitly stack.

2. **previousMagnitude is null on first run AND when magnitude is
   unchanged.** The literal reading of "previousMagnitude (if changed
   from last run — use null on first run)" is: only populate
   previousMagnitude when the prior run's magnitude differs from the
   current run's magnitude. On first run (no prior) or when magnitudes
   match, previousMagnitude stays null. This makes the field a discrete
   "magnitude-changed-from-last-run" signal rather than a copy of the
   previous value.

3. **Both feeds fetched even on partial failure.** If `2.5_week` succeeds
   but `significant_week` fails (or vice versa), the script continues
   with whichever feeds returned data and records the failures in
   `feedErrors[]` in the output document. Only if BOTH feeds fail does
   the script exit with code 1. This matches the spirit of "Handle API
   errors gracefully" while still surfacing failures.

4. **Feed-source preference for dedup.** When the same USGS event ID
   appears in both feeds, the `significant_week` entry wins over the
   `2.5_week` entry (significant_week is the more curated feed). Same-feed
   duplicates are first-seen-wins to preserve stable ordering.

5. **U.S. territory country value.** For territories (Puerto Rico, Guam,
   U.S. Virgin Islands, American Samoa, Northern Mariana Islands), the
   task spec lists "United States", "Puerto Rico", or the country name
   as valid `country` values. We set `country` to the territory display
   name (e.g. "Puerto Rico", "Guam") and leave `state` null (these are
   not U.S. states). `isUS` is true.

6. **locationType stays null in the fetcher.** The task spec marks
   `locationType` as "determined later by filter" but the filter does
   not actually set it (no locationType thresholds in the spec). It
   remains null in all three output files. A future phase can populate
   it if needed.

7. **Validate re-runs record checks on stories.** The story-records file
   denormalizes the canonical candidate fields, so it can be validated
   with the same record-level checks as the fetched snapshot. This gives
   us 11 × 3 = 33 record checks plus the stories-only storyScore check
   for 34 total. All checks pass.

### Constraints honored

- ✅ NWS weather scripts untouched.
- ✅ Recall scripts untouched.
- ✅ `.github/workflows/` untouched.
- ✅ `config/automation.json` untouched.
- ✅ No public article files created.
- ✅ DEMO_NOINDEX untouched.
- ✅ All new scripts are `.mjs` ES modules.
- ✅ Only Node.js built-in modules used (`node:fs/promises`, `node:path`,
  `node:url`, `node:crypto`).
- ✅ API errors handled gracefully (per-feed try/catch, atomic writes,
  non-zero exit on total failure).
- ✅ User-Agent matches the spec exactly.
- ✅ Exactly one HTTP request per feed (2 total).

### Next actions (for a future phase)

1. **Wire `prepare:earthquakes` into `config/automation.json` and the
   GitHub Actions workflow.** Phase 8A deliberately does NOT touch those
   files per the constraints; a future Phase 8B should add the hourly /
   sub-daily schedule and any required kill switch.

2. **Build a draft/article pipeline for earthquakes** mirroring the NWS
   `generate-nws-draft.mjs` / `generate-nws-image.mjs` /
   `resolve-nws-real-image.mjs` trio. Earthquake stories have natural
   map-based imagery (USGS ShakeMap, epicenter maps) that could be
   fetched directly from the `detailUrl` GeoJSON endpoint rather than
   needing a real-image search.

3. **Expand the U.S. relevance detector with coordinate-based fallback.**
   Phase 8A relies entirely on the `place` field. A future enhancement
   could use the USGS `geometry.coordinates` against a state-shape
   boundary file to catch events that are U.S.-relevant but whose `place`
   field is generic (e.g. "off the west coast of the United States").

4. **Add a `run-earthquake-newsroom.mjs` orchestrator** that mirrors
   `run-recall-newsroom.mjs` once a draft pipeline exists, and a
   `validate:earthquakes` kill-switch in the newsroom runner.

5. **Track felt/tsunami/alert changes between runs.** Phase 8A only
   surfaces `previousMagnitude`. A richer lifecycle would also flag when
   `felt` jumps, `alert` escalates (green→yellow→orange→red), or
   `tsunami` flips from false→true, so the newsroom can re-promote an
   evolving story to breaking-news status.

---

## Phase 8B — Dormant earthquake publishing engine (Task 8B-engine)

**Agent:** general-purpose sub-agent
**Date:** 2026-09-27 (simulated project timeline)
**Scope:** Build the dormant earthquake publishing engine on top of the
Phase 8A ingestion pipeline. Draft generator + image generator + master
newsroom script + test fixture + GitHub Actions workflow + hidden preview
page + 5 new validation checks. Kill switch
(`earthquakePublishingEnabled: false`) keeps the engine dormant until a
future phase explicitly enables automated publishing.

### Files created

- `scripts/generate-earthquake-draft.mjs`
  Reads `data/earthquakes/earthquake-story-records.json`, picks the first
  `publishEligible` story (or accepts a `earthquakeKey` as `argv[2]`, or
  uses the test fixture when `--fixture` is passed), and writes exactly
  ONE private article draft to `data/earthquakes/drafts/<slug>.json`.
  The draft includes draftVersion, generatedAt, earthquakeKey, eventId,
  status, title, description, slug, category (`weather` — there's no
  earthquake category yet), location, publishedAt, updatedAt, breaking,
  author (`US News Engine Weather Desk`), sourceName
  (`U.S. Geological Survey`), sourceUrl (USGS event page), sourceOffice,
  hasUpdates, seo, image (pending), body sections, and a full
  earthquakeMetadata block (magnitude, magnitudeType, magnitudeTypeLabel,
  depth, depthKm, place, state, country, nearestPlace, latitude,
  longitude, felt, cdi, mmi, alert, tsunami, significance, status, time,
  updated, eventId, hasShakeMap, shakeMapProductUrl, shakeMapImageUrl,
  hasDyfi, hasMomentTensor, hasTsunamiProduct, isUS, isUSRelevant,
  impactRelevant, publishEligible, scope, priority, storyScore,
  storyStatus, testOnly).
  Headline rule: `M{mag} Earthquake Strikes {PlaceShort}, USGS Says` —
  under ~80 chars, no sensationalism ("massive", "devastating", "major"
  are not used unless officially classified), no damage/injury claims
  unless officially reported. Article body structure: lead (no heading)
  → "What USGS reported" → "Magnitude and depth" → "Where the earthquake
  occurred" → "Felt reports" (only if felt > 0) → "USGS alert and
  tsunami information" (only if alert or tsunami) → "Source". Empty
  sections are skipped. Every factual statement is traceable to USGS
  data. Place deduplication logic avoids "Anchorage, Alaska (Alaska)"
  and "Anchorage, Alaska in Alaska" by checking whether the USGS place
  string already contains the state name before appending it.

- `scripts/generate-earthquake-image.mjs`
  Generates hero images for earthquake article drafts in three modes:
  (1) ShakeMap path — if `hasShakeMap=true` and `shakeMapImageUrl` is
  present, download the official USGS ShakeMap image, cover-crop to
  1200x675 using sharp, save as `data/draft-images/<slug>.jpg`.
  (2) Coordinate-map path — for stories with lat/lon but no ShakeMap,
  generate an SVG showing the epicenter marker at lat/lon, a state/
  region viewport (CONUS / Alaska / Hawaii / Puerto Rico / international
  window), lat/lon gridlines, "M{mag} EARTHQUAKE" headline, place name,
  depth, USGS attribution, and US News Engine branding. Render to PNG
  via sharp at 1200x675. Save as `data/draft-images/<slug>.png`.
  (3) Fallback earthquake-data graphic — when no coordinates are
  available, render a two-panel SVG with the magnitude, place, date,
  depth, PAGER alert chip, tsunami flag, and USGS attribution. Render
  to PNG via sharp.
  Outputs the SVG source (for editability) and a metadata JSON sidecar
  with provenance (source, agency, originalImageUrl, caption, alt,
  copyrightRisk, licenseNotes). The `--fixture` flag forces use of the
  test fixture.

- `data/published-earthquakes.json`
  Empty initial registry: `{ generatedAt, storyCount: 0, stories: [] }`.
  The newsroom script appends one entry per published earthquake article
  with: earthquakeKey, eventId, slug, articlePath, publishedAt,
  updatedAt, lastMagnitude, lastAlert, lastTsunami, lastFelt,
  storyStatus, lastSeenAt, lastCheckedAt, imageMode, imageSource,
  imageCreator, imageLicense, imageLicenseUrl, imageSourceUrl, breaking.

- `scripts/run-earthquake-newsroom.mjs`
  Master automation script. Pipeline: read config (kill switch) →
  fetch USGS (`npm run fetch:earthquakes`) → filter
  (`npm run filter:earthquakes`) → stories
  (`npm run stories:earthquakes`) → validate
  (`npm run validate:earthquakes`) → load published-earthquakes.json
  registry → reconcile NEW / UPDATED / UNCHANGED / MISSING → if kill
  switch off: print summary and exit (no changes) → process UPDATED
  stories first (preserve slug, publishedAt; set updatedAt; refresh
  lastMagnitude/lastAlert/lastTsunami/lastFelt; bump article file's
  updatedAt frontmatter) → check daily UTC cap from registry → select
  NEW stories (publishEligible=true, testOnly!=true, sorted by priority
  then storyScore descending, capped at maxEarthquakeNewPerRun AND the
  daily remaining) → for each: generate draft, generate image, copy
  image to public/images/, write article markdown file, append a
  registry entry → save registry → validate:earthquakes +
  validate:publishing → astro build. Exits before validation/build if
  0 new + 0 updated (no-change behavior). Uses `execSync` for every
  sub-script and surfaces stderr on failure.
  Test mode: `--test-date=YYYY-MM-DD`, `--ignore-daily-cap`,
  `--fixture`, and `--allow-test-publish` flags. When ANY test flag is
  present without `--allow-test-publish`, enters DRY RUN mode — no
  production files modified. The test fixture is also explicitly
  filtered out of the eligibleStories set (testOnly !== true) so even
  with `--allow-test-publish`, the fixture cannot reach the publishing
  path.

- `data/earthquakes/test-fixture.json`
  Synthetic publishEligible U.S. earthquake: M5.2, 12 km NNE of
  Anchorage, Alaska, depth 28.5 km, alert=yellow, significance 650,
  felt=342, CDI=4.2, storyScore=65, priority=high. `testOnly: true`
  and `eventId: TEST_FIXTURE_001` mark it as a non-real event. Includes
  `_fixtureNote` explaining it must never appear in the production
  article collection, registry, or live site. The fixture is loaded by
  `generate-earthquake-draft.mjs --fixture` and
  `generate-earthquake-image.mjs --fixture` and by the preview page at
  `src/pages/preview/earthquake-test.astro`, but is filtered out of the
  newsroom's eligibleStories set.

- `.github/workflows/earthquake-newsroom.yml`
  Standalone GitHub Actions workflow. `workflow_dispatch` +
  `schedule: 47 * * * *` (hourly at minute 47, offset from NWS at 17
  and recall at 17 8,20). `ubuntu-latest`, `permissions: contents:
  write`, `timeout-minutes: 15`. Steps: checkout → setup Bun + Node 24
  → `bun install` → `npm run newsroom:earthquakes` → read
  `earthquakePublishingEnabled` from `config/automation.json` →
  `git diff --quiet -- src/ public/ data/published-earthquakes.json` →
  if changes AND publishing enabled: `npm run build`, commit with
  `git config user.name "US News Engine Bot"` /
  `newsroom@users.noreply.github.com` and message
  `"Automated earthquake newsroom update: YYYY-MM-DD HH:mm UTC"`,
  push, `npx wrangler deploy` with `CLOUDFLARE_API_TOKEN` +
  `CLOUDFLARE_ACCOUNT_ID`, then live-verify that `/`, `/weather/`, and
  `/latest/` all return HTTP 200. No-change path: exit success.

- `src/pages/preview/earthquake-test.astro`
  Hidden preview route at `/preview/earthquake-test/` that renders the
  test fixture using the production article design. Shows a prominent
  orange "TEST FIXTURE — NOT A REAL EARTHQUAKE" banner above the
  article. Uses `PreviewLayout` (which emits
  `<meta name="robots" content="noindex,nofollow,noarchive">` and a
  self-referencing canonical and NO NewsArticle schema). The page is
  excluded from the sitemap by the existing
  `filter: (page) => !page.includes('/preview/')` rule in
  `astro.config.mjs`. The source box links to
  `https://earthquake.usgs.gov/earthquakes/eventpage/TEST_FIXTURE_001`
  (a non-existent USGS event page) with `rel="nofollow noopener"` so
  clicks are harmless. The page loads the test fixture JSON, the
  generated draft JSON (matching by earthquakeKey), and the image
  sidecar; gracefully falls back to a placeholder section if the draft
  or image are missing (instructs the editor to run the test commands).
  Article aside displays all earthquake metadata fields (magnitude,
  depth, place, state, coordinates, felt, CDI, PAGER alert, tsunami,
  significance, status, story score, priority, hasShakeMap, hasDYFI,
  testOnly).

### package.json changes

Added three npm scripts (no existing entries modified):
- `"draft:earthquake": "node scripts/generate-earthquake-draft.mjs"`
- `"image:earthquake": "node scripts/generate-earthquake-image.mjs"`
- `"newsroom:earthquakes": "node scripts/run-earthquake-newsroom.mjs"`

### validate-earthquakes.mjs extensions

Added 5 new publishing-pipeline checks (Phase 8B):
- **Check 13** — no testOnly fixture in the public article collection.
  Scans every `src/content/articles/*.md` file for the markers
  `TEST_FIXTURE`, `usgs__TEST`, `testOnly: true`. Fails if any article
  file contains any marker.
- **Check 14** — no testOnly fixture in the publication registry.
  Scans `data/published-earthquakes.json` for any entry whose
  `earthquakeKey` contains `TEST`, `eventId` contains `TEST_FIXTURE`,
  or `testOnly === true`.
- **Check 15** — non-U.S. event is not publishEligible. Scans both
  `earthquake-news-candidates.json` and `earthquake-story-records.json`
  for any record with `publishEligible=true` and `isUSRelevant !== true`.
- **Check 16** — impactRelevant=false event is not publishEligible.
  Same files; fails if any record has `publishEligible=true` and
  `impactRelevant === false`.
- **Check 17** — ShakeMap claimed without USGS product evidence. Same
  files; fails if any record has `hasShakeMap=true` but
  `shakeMapImageUrl` is missing, empty, or not an absolute `http(s)://`
  URL.

Total check count went from 34 (Phase 8A) to 39 (Phase 8B). All 39
passed in the live run.

### Run results

1. `npm run newsroom:earthquakes` (dry run — `earthquakePublishingEnabled=false`)
   — SUCCESS (exit 0, duration 1.4-1.6s across runs)
   - Kill switch: `earthquakePublishingEnabled = false`
   - Caps: `maxEarthquakeNewPerRun=1`, `maxEarthquakeNewPerDay=3`
   - Pipeline: fetched (320 events from `2.5_week` + 1 from
     `significant_week` after dedup) → filtered (2 candidates) →
     stories (2 stories, 0 publishEligible) → validate (PASS).
   - Reconciled against the empty registry:
     - NEW: 0 publish-eligible stories (the 2 live stories are
       non-U.S. New Caledonia M6.6 and remote Rat Islands M4.6 —
       both filtered as not publishEligible by Phase 8A.1)
     - UPDATED: 0
     - UNCHANGED: 0
     - MISSING: 0
   - Daily cap: 0 published today (UTC), 3 remaining, 1 allowed this run
   - Kill switch active → printed summary and exited. NO content changes
     were made. Verified that no article files were created in
     `src/content/articles/`, no images were copied to `public/images/`,
     and the published-earthquakes.json registry remained empty (0
     stories).

2. `node scripts/generate-earthquake-draft.mjs --fixture` — SUCCESS
   (exit 0)
   - Loaded the test fixture (earthquakeKey `usgs__TEST_FIXTURE_001`,
     testOnly=true).
   - Output: `data/earthquakes/drafts/m52-earthquake-anchorage-alaska-2026-09-27.json`
     (4,335 bytes).
   - Title: "M5.2 Earthquake Strikes Anchorage, USGS Says" (44 chars).
   - Slug: `m52-earthquake-anchorage-alaska-2026-09-27`.
   - Breaking: true (M5.2 ≥ 5.0).
   - 7 body sections (lead + What USGS reported + Magnitude and depth +
     Where the earthquake occurred + Felt reports + USGS alert and
     tsunami information + Source).
   - Word count: ~241.
   - earthquakeMetadata block fully populated (magnitude=5.2, ml,
     depth=28.5km, place, state=Alaska, coordinates, felt=342, cdi=4.2,
     alert=yellow, tsunami=false, significance=650, status=reviewed,
     eventId=TEST_FIXTURE_001, testOnly=true, etc.).

3. `node scripts/generate-earthquake-image.mjs --fixture` — SUCCESS
   (exit 0)
   - Loaded the test fixture.
   - Chose coordinate-map path (hasShakeMap=false, shakeMapImageUrl=null).
   - Generated SVG: `data/draft-images/m52-earthquake-anchorage-alaska-2026-09-27.svg`
     (4,747 bytes, 82 lines). SVG includes dark header band with
     "U.S. GEOLOGICAL SURVEY · EARTHQUAKE" eyebrow + "M5.2 EARTHQUAKE"
     headline, date + coordinates readout, map window with gridlines
     (every 10° lat/lon), epicenter marker (concentric rings + cross
     hairs) at 61.2250°N 149.7350°W, place + depth callout, magnitude +
     PAGER alert callout, bottom USGS attribution + US News Engine
     branding.
   - Rendered PNG via sharp: 1200x675, 14,553 bytes.
   - Metadata sidecar:
     `data/draft-images/m52-earthquake-anchorage-alaska-2026-09-27.json`
     (1,240 bytes). Carries earthquakeKey, eventId, slug, type
     (`generated-coordinate-map`), visualType
     (`earthquake-coordinate-map`), source (`US News Engine (editorial
     data graphic)`), agency, sourceUrl, originalImageUrl=null,
     caption, alt, copyrightRisk, licenseNotes, magnitude, depth,
     place, testOnly=true.

4. `npm run validate:earthquakes` — SUCCESS (exit 0, 39/39 checks pass)
   - All 34 Phase 8A checks continue to pass.
   - All 5 Phase 8B checks pass (no testOnly fixture in article
     collection; no testOnly fixture in registry; no non-U.S.
     publishEligible events; no impactRelevant=false publishEligible
     events; no ShakeMap-claimed-without-evidence records).

5. `npm run build` — SUCCESS (exit 0, 36 pages built in 1.13s)
   - `/preview/earthquake-test/index.html` generated.
   - Sitemap (`dist/sitemap-0.xml`) excludes all `/preview/` URLs (0
     occurrences of "preview" — correct).
   - Preview page HTML correctly includes:
     - `<title>M5.2 Earthquake Strikes Anchorage, USGS Says | PREVIEW | US News Engine</title>`
     - `<meta name="robots" content="noindex,nofollow,noarchive">`
     - Self-referencing canonical to
       `https://usa-news-engine.forexwizardy.workers.dev/preview/earthquake-test/`
     - NO NewsArticle JSON-LD (only WebSite + BreadcrumbList schemas)
     - TEST FIXTURE banner with "TEST FIXTURE — NOT A REAL EARTHQUAKE"
       text
     - Article body with all 7 sections rendered
     - Hero image: `/preview-images/m52-earthquake-anchorage-alaska-2026-09-27.png`
       with caption + attribution
     - Source box: "U.S. Geological Survey" organization + office +
       "TEST_FIXTURE_001" event ID + "View official USGS event →" link
       (rel="nofollow noopener" target="_blank") + source note
       explaining the link is fake
     - Article aside with 17 metadata fields (category, source,
       magnitude, depth, place, state, coordinates, felt, CDI, PAGER
       alert, tsunami flag, significance, status, story score,
       priority, has ShakeMap, has DYFI, test only)

### Design decisions

1. **Earthquake category = `weather`.** The existing CATEGORIES array
   in `src/consts.ts` does not include an "earthquakes" category, and
   the content collection Zod schema validates `category` against the
   enum `['us', 'weather', 'recalls', 'consumer', 'science']`. The
   task spec explicitly says "use 'weather' since there's no earthquake
   category in the existing CATEGORIES array." So earthquake articles
   are filed under `weather`. A future phase can add an
   `earthquakes` category if editorial decides earthquakes deserve
   their own section.

2. **Draft slug format: `m{mag}-{earthquake}-{place}-{date}`.** The
   slug strips the "X km DIR of" prefix from the USGS place string so
   the URL reads `m52-earthquake-anchorage-alaska-2026-09-27` rather
   than `m52-earthquake-12-km-nne-of-anchorage-alaska-alaska-...`. The
   slug is generated identically by both `generate-earthquake-draft.mjs`
   and `generate-earthquake-image.mjs` (using the same `buildSlug`
   formula) so the draft JSON, image files, and image sidecar all
   share the slug.

3. **Dry-run safety for test fixture.** The newsroom script applies
   TWO filters to the test fixture: (a) `testOnly !== true` in the
   eligibleStories filter, and (b) the test-only `--fixture` flag
   triggers DRY RUN mode unless `--allow-test-publish` is also passed.
   Even with `--allow-test-publish`, the testOnly filter would prevent
   the fixture from reaching the publishing path. This is belt-and-
   suspenders: a future agent cannot accidentally publish the test
   fixture to production.

4. **Headline places use the clean place name (no "12 km NNE of"
   prefix).** The lead sentence uses `placeInfo.place` (e.g.
   "Anchorage, Alaska") rather than the raw `story.place` (e.g.
   "12 km NNE of Anchorage, Alaska"). The "What USGS reported" and
   "Where the earthquake occurred" sections DO use the full USGS place
   string because those sections are about official USGS-reported
   location details.

5. **State deduplication.** USGS place strings like
   "12 km NNE of Anchorage, Alaska" already include the state name.
   The draft generator checks whether the place string already contains
   the state name (case-insensitive) before appending "(Alaska)" or
   "in Alaska" — preventing "Anchorage, Alaska (Alaska)" and
   "Anchorage, Alaska in Alaska" repetitions. The same check is
   applied to the description deck.

6. **Coordinate-map viewport selection.** The image generator chooses
   a viewport based on the story's state and coordinates: Alaska
   viewport for events in/near Alaska (lat ≥ 55 and lon ≤ -130, or
   state=Alaska); Hawaii viewport for Hawaii events; Puerto Rico
   viewport for PR events; CONUS viewport for all other U.S. events;
   and a 30°-span international viewport centered on the epicenter for
   non-U.S. events. The viewport bounds drive the equirectangular
   projection used to place the epicenter marker.

7. **ShakeMap fallback chain.** If `hasShakeMap=true` but the download
   fails (network error, content-type mismatch, etc.), the image
   generator falls back to the coordinate-map path rather than
   failing the entire image generation. This keeps the newsroom
   resilient to transient USGS CDN issues.

8. **Earthquake times are always UTC.** USGS publishes event times in
   UTC. The draft generator formats them as "Sunday, September 27,
   2026 at 10:00 a.m. UTC" rather than trying to derive a local
   timezone from the coordinates (which would require a timezone
   lookup service or polygon matching). This is the safest approach
   for earthquake reporting — the time is what USGS reported, in the
   timezone USGS uses.

### Constraints honored

- ✅ NWS weather scripts untouched (`run-nws-newsroom.mjs`,
  `generate-nws-draft.mjs`, `generate-nws-image.mjs`,
  `resolve-nws-real-image.mjs`, etc.).
- ✅ Recall scripts untouched (`run-recall-newsroom.mjs`,
  `generate-recall-draft.mjs`, `generate-recall-image.mjs`, etc.).
- ✅ `.github/workflows/nws-newsroom.yml` NOT modified.
- ✅ `.github/workflows/recall-newsroom.yml` NOT modified.
- ✅ `config/automation.json` NOT modified —
  `earthquakePublishingEnabled` remains `false`,
  `maxEarthquakeNewPerRun=1`, `maxEarthquakeNewPerDay=3`. The existing
  NWS settings (`nwsPublishingEnabled=true`, `maxNewPerRun=2`,
  `maxNewPerDay=8`) and recall settings (`recallPublishingEnabled=true`,
  `maxRecallNewPerRun=1`, `maxRecallNewPerDay=3`) are untouched.
- ✅ `data/published-stories.json` (NWS registry) NOT modified.
- ✅ `data/published-recalls.json` (recall registry) NOT modified.
- ✅ No public article files created in `src/content/articles/`.
- ✅ `DEMO_NOINDEX` remains `true` in `src/consts.ts` (untouched).
- ✅ All new scripts are `.mjs` ES modules using only Node.js built-ins
  (`node:fs/promises`, `node:path`, `node:url`, `node:child_process`)
  + `sharp` (already installed, no new dependencies added).
- ✅ The new GitHub Actions workflow uses `GITHUB_TOKEN` (via
  `permissions: contents: write`) — no personal PAT required.
- ✅ Git identity: `US News Engine Bot <newsroom@users.noreply.github.com>`.
- ✅ Commit message format:
  `"Automated earthquake newsroom update: YYYY-MM-DD HH:mm UTC"`.
- ✅ Deploy: `npx wrangler deploy` with `CLOUDFLARE_API_TOKEN` +
  `CLOUDFLARE_ACCOUNT_ID` secrets (same as the NWS and recall workflows).
- ✅ Live verification: 3-page check (`/`, `/weather/`, `/latest/` —
  all must return HTTP 200). The `/weather/` path is used instead of
  `/earthquakes/` because earthquakes are filed under the existing
  Weather category.
- ✅ The preview page uses `PreviewLayout` (which emits
  `noindex,nofollow,noarchive` and NO NewsArticle schema).
- ✅ The preview page is excluded from the sitemap by the existing
  `/preview/` filter in `astro.config.mjs` — verified by inspecting
  `dist/sitemap-0.xml` (0 occurrences of "preview").
- ✅ The test fixture carries `testOnly: true` and is filtered out of
  the newsroom's eligibleStories set.
- ✅ The earthquake category is `weather` (no earthquake category in
  the existing CATEGORIES array).

### Next actions for a future agent

1. **Flip the kill switch to enable automated publishing.** Edit
   `config/automation.json` and set `earthquakePublishingEnabled: true`.
   The next scheduled run (minute 47 of any hour) will then publish
   the single highest-priority NEW publishEligible story (subject to
   the daily cap of 3). Currently the live USGS feed has 0
   publishEligible U.S. stories (the two notable events — New Caledonia
   M6.6 and Rat Islands M4.6 — are non-U.S. and remote-Alaska
   respectively, both filtered out by Phase 8A.1's publishEligible
   gate). The first publishable U.S. M5+ earthquake will trigger the
   first publication.

2. **Verify the ShakeMap download path end-to-end.** The Phase 8B
   image generator implements the ShakeMap download path but the test
   fixture has `hasShakeMap=false`, so the path was not exercised in
   the live run. The first real publishEligible earthquake with a
   ShakeMap product will exercise this path. If the USGS ShakeMap CDN
   returns an unexpected content-type or the cover-crop fails, the
   generator falls back to the coordinate-map path — but the
   fallback should be verified against a real ShakeMap URL.

3. **Add a dedicated `earthquakes` category.** If editorial decides
   earthquakes deserve their own section (separate from Weather),
   add a new category slug to `CATEGORIES` in `src/consts.ts` and
   to the Zod enum in `src/content.config.ts`, then update the draft
   generator + newsroom script to use `category: 'earthquakes'`
   instead of `category: 'weather'`. The `/earthquakes/` index page
   would automatically render via the existing `[category]/index.astro`
   route. The live-verification check in the workflow would also need
   to swap `/weather/` → `/earthquakes/`.

4. **Surface felt/alert/tsunami changes in the UPDATE path.** The
   Phase 8B `processUpdate()` detects updates by checking magnitude,
   alert, tsunami, and felt-jump (≥1.5x). When an update is detected,
   it bumps `updatedAt` in the registry and the article frontmatter
   but does NOT regenerate the article body. A future enhancement
   could call `generate-earthquake-draft.mjs` with the earthquakeKey
   and re-render the body sections (similar to how the NWS pipeline
   regenerates alerts). For now, updates only bump metadata.

5. **Add an "earthquake lifecycle" status similar to NWS.** NWS
   articles carry a `lifecycleStatus` (`active` / `ending-soon` /
   `expired` / `cancelled` / `superseded`). Earthquake articles
   currently only carry `storyStatus: 'active'`. A future enhancement
   could add a `lifecycleStatus` field that transitions to `archived`
   when the USGS event is older than 30 days and no further updates
   have been received, so the article can be moved out of the active
   news feed.

6. **Coordinate-map state boundary polygons.** The current
   coordinate-map graphic uses a generic gridline backdrop without
   actual state boundary polygons. A future enhancement could trace
   simplified state outlines from public-domain U.S. Census
   cartographic boundary data (similar to how the NWS image generator
   uses `data/geo-cache/state-*.json` for state shapes) to give the
   epicenter map more geographic context.

---

## Phase 9A — Science news ingestion foundation (Task 9A-pipeline)

**Agent:** general-purpose sub-agent
**Date:** 2026-09-28 (simulated project timeline)
**Scope:** Build the Phase 9A science news pipeline — fetchers for NASA
news releases, JPL news releases (gracefully handling the current 403),
and NOAA SWPC space-weather alerts/scales; a newsworthiness filter that
gates publication; a story clustering & scoring step that merges
NASA+JPL duplicates and ranks stories; and a validator that asserts
data integrity. Wire all six scripts into the npm script registry.

### Files created

- `scripts/fetch-nasa-news.mjs`
  Fetches the NASA news-release RSS feed
  (`https://www.nasa.gov/news-release/feed/`) and parses it with regex
  (no external XML parser dependency). Each `<item>` is normalized to
  the shared science schema with `source: "NASA"` and a deterministic
  `scienceKey: nasa__<sha256(guid)[0:16]>`. The normalizer also:
    * Strips the APOD navigation boilerplate ("APOD Science APOD …
      brief explanation written by a professional astronomer.") from
      the description preview.
    * Extracts a hero image URL by walking media:content →
      media:thumbnail → enclosure → first `<img src="…">` in either
      `<description>` or `<content:encoded>` (skipping data: URLs and
      1×1 spacer GIFs).
    * Tags APOD items with `sourceType: "apod"` so the filter can
      down-rank them.
    * Derives `mission` (Artemis, Starliner, James Webb, Hubble,
      Perseverance, Curiosity, Psyche, Europa Clipper, VIPER, Dragonfly,
      Parker Solar Probe, Juno, New Horizons, Voyager, Cassini, Lucy,
      DART, InSight, Chandra, SLS, Orion, ISS, SpaceX, Falcon, Crew
      Dragon, Dragon, Cygnus, Starlink, Landsat, GOES, Sentinel, Nancy
      Grace Roman, …) and `topic` (mission-update, discovery, launch,
      landing, crew, technology, earth-science, astronomy, education,
      administrative) deterministically from title + description.
  Output: `data/science/nasa-news.json` with metadata wrapper.

- `scripts/fetch-jpl-news.mjs`
  Same pattern as NASA but for JPL. Tries
  `https://www.jpl.nasa.gov/news/feed/` first, then falls back to
  `https://www.jpl.nasa.gov/rss/news.php`. As of 2026-09-28 both URLs
  return HTTP 403 to our user-agent; the fetcher handles this
  gracefully by writing an EMPTY result set with an `error` field and
  an `attempts` array listing each URL's status. The fetcher will work
  automatically when the feed becomes available. `scienceKey` uses
  `jpl__<sha256(guid)[0:16]>` and `imageCredit` is `NASA/JPL-Caltech`.

- `scripts/fetch-swpc-science.mjs`
  Fetches two SWPC JSON endpoints:
    * `https://services.swpc.noaa.gov/products/alerts.json` — array of
      alert messages. Each message body is parsed (via regex) to
      extract `messageCode` (from "Space Weather Message Code: XXXX"),
      `serialNumber` (from "Serial Number: NNNN"), `beginTime`/
      `endTime`, `watchWarningType`, and a 300-char summary with
      header (`:` and `#`) lines stripped.
    * `https://services.swpc.noaa.gov/products/noaa-scales.json` —
      current R/S/G scale levels. The document is keyed by day-offset
      ("-1" / "0" / "1" / "2" / "3"); we extract the "0" (today)
      entry's R/S/G Scale values into `currentRScale`, `currentSScale`,
      `currentGScale`. Falls back to legacy shapes (top-level
      `currentRScale` or top-level `R`/`S`/`G` objects) for forward
      compatibility.
  `scienceKey` is `swpc__<product_id>_<serial>` (or a 12-char hash of
  the message body when the serial number is missing). Only alerts with
  meaningful severity are kept (R3+, S2+, G3+) — routine minor alerts
  (R1/R2, S1, G1/G2, K-index alerts, electron-flux alerts) are dropped
  at fetch time. The filter is a safety net on top of this. Output:
  `data/science/swpc-events.json` with metadata wrapper.

- `scripts/filter-science-news.mjs`
  Reads all three fetcher outputs and applies the newsworthiness
  filter:
    * NASA/JPL HIGH priority: title or description contains launch,
      landing, splashdown, crew, astronaut, discovery, milestone,
      arrival, flyby, sample return, first image, results, findings,
      docking, undocking, spacewalk, EVA, rollout, rendezvous; OR a
      known major mission name in the title (Artemis, Webb, Hubble,
      Perseverance, Starliner, Psyche, Europa Clipper, VIPER,
      Dragonfly, Parker Solar Probe, Juno, New Horizons, Voyager,
      Cassini, Lucy, DART, InSight, Chandra, SLS, Orion, ISS).
    * NASA/JPL EXCLUDE: APOD items (title starts with "APOD:");
      podcast/educational series without a major-event keyword;
      "media advisory"/"media teleconference"/"press brief" without a
      major-event keyword.
    * NASA/JPL non-eligible (tracked internally, not publish-eligible):
      releases without a high-priority keyword or major mission.
    * SWPC: include only R3+ (radio blackout), S2+ (solar radiation),
      G3+ (geomagnetic storm). G4+, S3+, R4+ are HIGH priority; G3,
      S2, R3 are MEDIUM.
  Each candidate gets `publishEligible`, `priority` (high/medium), and
  `selectedReason`. Output: `data/science/science-news-candidates.json`.

- `scripts/build-science-stories.mjs`
  Reads the candidates file and clusters NASA+JPL candidates that
  describe the SAME event (same mission AND overlapping date window
  ±2 days). SWPC alerts are kept as single-record clusters. Each
  cluster becomes one story with:
    * `scienceStoryKey` (deterministic hash of the cluster's member
      scienceKeys for multi-record clusters; the record's own
      scienceKey for singletons).
    * `primarySource`, `allSourceKeys`, `sourceUrls`, `titleSeed`,
      `topic`, `mission`, `publishedAtSource` (earliest in cluster).
    * `storyScore` (0-100): base 20 + launch/landing/splashdown (+20)
      + major discovery/finding (+15) + crew/astronaut (+10) + known
      major mission Artemis/Webb/Perseverance (+10) + multiple sources
      NASA+JPL (+8) + recent within 3 days (+5) + SWPC G4+ (+20) /
      G3 (+12) / S3+ (+12) / R3+ (+8). Capped at 100.
    * `storyStatus` ('new'/'updated'/'unchanged') via cross-snapshot
      content signature comparison against the previous
      `science-story-records.json`.
    * `updateCount`, `firstSeenAt`, `latestSeenAt` for cross-snapshot
      tracking.
  Output: `data/science/science-story-records.json`.

- `scripts/validate-science.mjs`
  Validates science data across all 5 Phase 9A JSON files. Exits 1 on
  any failure. Checks:
    1. Every record has a scienceKey
    2. Every record has a sourceUrl (absolute http/https)
    3. No duplicate scienceKeys (per source file)
    4. No duplicate scienceStoryKeys (story records)
    5. publishedAtSource / updatedAtSource are valid ISO-8601 or null
    6. Source is one of NASA, JPL, NOAA-SWPC
    7. SWPC severity is a recognized NOAA scale value (R1-5/S1-5/G1-5)
       or null; non-SWPC records must not carry a severity
    8. No external/unverified image credit (must be NASA,
       NASA/JPL-Caltech, or NOAA SWPC)
    9. publishEligible items have a non-empty selectedReason
   11. storyScore is 0-100 (story records only)
  Also re-runs the record-level checks against the candidates file and
  the denormalized fields on story records. 32 checks total.

### npm scripts added to package.json

```json
"fetch:nasa":       "node scripts/fetch-nasa-news.mjs"
"fetch:jpl":        "node scripts/fetch-jpl-news.mjs"
"fetch:swpc":       "node scripts/fetch-swpc-science.mjs"
"fetch:science":    "npm run fetch:nasa && npm run fetch:jpl && npm run fetch:swpc"
"filter:science":   "node scripts/filter-science-news.mjs"
"stories:science":  "node scripts/build-science-stories.mjs"
"validate:science": "node scripts/validate-science.mjs"
"prepare:science":  "npm run fetch:science && npm run filter:science && npm run stories:science && npm run validate:science"
```

### Live run results (2026-09-28 ~00:18-00:20 UTC)

**fetch:nasa** — 10 items fetched (3 APOD, 7 news releases). All 10 had
images extracted from the article HTML (NASA's RSS does not use
`<media:content>` at the item level; images live inside the
`<content:encoded>` CDATA). 3 items matched known missions (Starliner,
Artemis, Hubble).

**fetch:jpl** — Both candidate URLs returned HTTP 403. Wrote empty
result set with `error` and `attempts` fields. Pipeline continued.

**fetch:swpc** — 66 alerts received. All 66 were routine (K-index
alerts, electron-flux alerts, K04/K05 warnings with G1 mentions at
most); all dropped at fetch time. Scales: R=-, S=-, G=- (no current
space-weather event). Wrote empty records array with the scales summary.

**filter:science** — 7 candidates:
  - 4 publishEligible HIGH priority:
    1. NASA, Boeing to Provide Update on Starliner Development
       (mission=Starliner, topic=crew)
    2. NASA Welcomes San Marino Signing the Artemis Accords
       (mission=Artemis, topic=administrative)
    3. NASA Tests Dual Mode Propulsion CubeSat Ahead of Launch
       (mission=null, topic=launch)
    4. Hubble Spots Chaotic Secret in Galaxy
       (mission=Hubble, topic=astronomy)
  - 3 ineligible MEDIUM priority (tracked internally):
    5. 2026-2027 DWU: Middle School Design Challenge (topic=education)
    6. 2026-2027 DWU: High School Engineering Challenge (topic=technology)
    7. TB 26-07 Aluminum Alloy 2219 Material Guidance (topic=discovery)
  - 3 excluded: APOD items (title starts with "APOD:").

**stories:science** — 7 unique stories (no NASA+JPL clusters since JPL
was blocked). Story score distribution: 4 stories in 30-49, 3 in 0-29.
Top 5:
  1. [score=45] NASA Tests Dual Mode Propulsion CubeSat Ahead of Launch
     (launch keyword +20, recent +5; base 20 → 45)
  2. [score=40] TB 26-07 Aluminum Alloy 2219 Material Guidance
     (discovery keyword +15, recent +5; base 20 → 40)
  3. [score=35] NASA, Boeing to Provide Update on Starliner Development
     (crew keyword +10, Starliner mission +5 only if major; base 20 → 35)
  4. [score=35] NASA Welcomes San Marino Signing the Artemis Accords
     (Artemis major mission +10, recent +5; base 20 → 35)
  5. [score=25] Hubble Spots Chaotic Secret in Galaxy
     (Hubble not in MAJOR_MISSIONS set so no +10; base 20 + 5 recent → 25)

Second `stories:science` run correctly marked all 7 stories as
`status=unchanged` (content signature matched), confirming the
cross-snapshot tracking works.

**validate:science** — All 32 checks passed:
  - 8 record-level checks × 4 source files (NASA, JPL, SWPC,
    candidates) = 32
  - Plus story-specific checks: scienceStoryKey uniqueness,
    storyScore range, publishEligible reason.
  Exit code 0.

### Constraints honored

- ✅ NWS weather scripts untouched (`fetch-nws-alerts.mjs`,
  `filter-nws-news.mjs`, `build-nws-stories.mjs`,
  `run-nws-newsroom.mjs`, `generate-nws-draft.mjs`, etc.).
- ✅ Recall scripts untouched (`fetch-cpsc-recalls.mjs`,
  `fetch-fda-food-recalls.mjs`, `fetch-fda-device-recalls.mjs`,
  `filter-recall-news.mjs`, `build-recall-stories.mjs`,
  `run-recall-newsroom.mjs`, etc.).
- ✅ Earthquake scripts untouched (`fetch-usgs-earthquakes.mjs`,
  `filter-earthquake-news.mjs`, `build-earthquake-stories.mjs`,
  `validate-earthquakes.mjs`, `run-earthquake-newsroom.mjs`, etc.).
- ✅ `.github/workflows/nws-newsroom.yml` NOT modified.
- ✅ `.github/workflows/recall-newsroom.yml` NOT modified.
- ✅ `.github/workflows/earthquake-newsroom.yml` NOT modified.
- ✅ `config/automation.json` NOT modified — all existing settings
  preserved. No new `sciencePublishingEnabled` flag was added (the
  Phase 9A pipeline is fetch+filter+score only; publishing comes in a
  later phase).
- ✅ `data/published-stories.json` (NWS registry) NOT modified.
- ✅ `data/published-recalls.json` (recall registry) NOT modified.
- ✅ `data/published-earthquakes.json` (earthquake registry) NOT
  modified.
- ✅ No public article files created in `src/content/articles/`.
- ✅ `DEMO_NOINDEX` remains `true` in `src/consts.ts` (untouched).
- ✅ All new scripts are `.mjs` ES modules using only Node.js built-ins
  (`node:fs/promises`, `node:path`, `node:url`, `node:crypto`). No
  new dependencies added. `sharp` was already installed but is not
  used by Phase 9A (no image generation in this phase).
- ✅ XML parsing uses regex only — no external XML parser dependency.
- ✅ JPL 403 is handled gracefully — empty result set written with an
  `error` field; pipeline continues.
- ✅ SWPC alerts with no meaningful severity (R3+/S2+/G3+) are
  dropped at fetch time and again at filter time (double-gate).
- ✅ User-Agent for all three fetchers is
  `USNewsEngine/1.0 (https://usa-news-engine.forexwizardy.workers.dev)`.

### Notes for a future agent

1. **JPL feed is blocked.** As of 2026-09-28, `www.jpl.nasa.gov`
   returns HTTP 403 to our user-agent on both
   `/news/feed/` and `/rss/news.php`. The fetcher is in place and will
   start producing records automatically when the feed becomes
   available. No code change will be needed. If JPL unblocks, the
   cluster step will start producing multi-source stories (NASA+JPL)
   that earn the +8 multiple-sources bonus and the +5 recency bonus
   more often.

2. **SWPC scales may not always be empty.** The current run found R=-,
   S=-, G=- (no space-weather event in progress). When a real G3+
   geomagnetic storm or S2+ solar-radiation event occurs, the fetcher
   will start producing records and the filter will pass them through.
   Story scores for SWPC events: G4+/S3+/R4+ earn +20/+12/+8
   respectively and start with a base of 20 — so a G4 alone would
   score 40 (20 base + 20 G4+ bonus). Add the +5 recency bonus and a
   SWPC G4 storm lands at score 45, well above most NASA news
   releases.

3. **Image extraction from NASA RSS is heuristic.** NASA's RSS does
   not use `<media:content>` at the item level — images live inside
   the `<content:encoded>` CDATA as `<img src="…">` tags. The fetcher
   extracts the first usable image (skipping data: URLs and 1×1
   spacers). This works for the 10 items in the live feed but may
   need adjustment if NASA changes their RSS template. The
   `imageCredit` is hardcoded to `NASA` (NASA) or `NASA/JPL-Caltech`
   (JPL) and the validator enforces that no other imageCredit is
   used.

4. **Mission extraction is keyword-based.** The mission table is
   intentionally liberal (matches like `/\bartemis\b/i` rather than
   full mission-name parsing). Some items may match a mission that
   isn't the actual focus of the release (e.g. an Artemis Accords
   signing ceremony is tagged `mission=Artemis` even though the
   release is really about diplomatic relations). This is acceptable
   for the Phase 9A use case (clustering and scoring); the article
   draft generator (a future phase) will need to look at the full
   title + description to decide whether to lead with the mission
   name.

5. **The MAJOR_MISSIONS bonus is limited to Artemis, James Webb,
   Perseverance.** Other missions (Hubble, Starliner, etc.) get the
   keyword/topic bonuses but not the +10 major-mission bonus. This is
   a deliberate editorial choice — these three missions are the
   highest-profile NASA programs right now. A future agent can expand
   this set in `scripts/build-science-stories.mjs` if editorial
   priorities change.

6. **No article draft generator yet.** Phase 9A is fetch+filter+score
   only. The next phase (9B?) will need to build
   `generate-science-draft.mjs` (analogous to
   `generate-nws-draft.mjs` / `generate-recall-draft.mjs` /
   `generate-earthquake-draft.mjs`) and a `run-science-newsroom.mjs`
   that picks the highest-scoring publishEligible story and writes a
   markdown article. The science-story-records.json file produced by
   this phase is the input for that future newsroom.

7. **No GitHub Actions workflow yet.** The NWS/recall/earthquake
   pipelines each have a `.github/workflows/*-newsroom.yml` that runs
   hourly / twice-daily. Phase 9A does not add a science-newsroom
   workflow. The fetch step is designed to be safe to run as
   frequently as hourly (each fetcher makes at most 2 HTTP requests
   and writes atomically), so a future workflow can be added without
   changes to the fetchers.

8. **SWPC message parsing is regex-based.** The SWPC alert message
   body uses a line-oriented header convention (`:`-prefixed headers,
   `#`-prefixed comments). The parser uses regex against the full
   message body to extract `messageCode`, `serialNumber`,
   `beginTime`, `endTime`, `watchWarningType`, and a 300-char
   summary. This works for the current SWPC format but may need
   adjustment if SWPC changes their message template. The
   `rawSourceData.message` field is preserved verbatim so future
   re-parsing is possible without re-fetching.
