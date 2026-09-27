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
