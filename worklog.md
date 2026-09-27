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
