# Skill Audit Report

Generated: 2026-03-17
Updated: 2026-03-18 (all issues resolved)

## Summary

| Skill | Structure | Description | Instructions | Cross-Refs | Blocking | Warnings | Cosmetic |
|-------|-----------|-------------|--------------|------------|----------|----------|----------|
| build-routing-solution | 7/7 | 5/5 | 4/4 | OK | ~~1~~ FIXED | ~~1~~ FIXED | ~~2~~ FIXED |
| routing-prerequisites | 7/7 | 5/5 | 4/4 | OK | 0 | ~~1~~ FIXED | ~~2~~ FIXED |
| routing-customization | 7/7 | 5/5 | 4/4 | OK | 0 | 0 | ~~1~~ FIXED |
| - location (subskill) | 7/7 | 5/5 | 4/4 | OK | 0 | ~~1~~ FIXED | 0 |
| - routing-profiles (subskill) | 7/7 | 5/5 | 4/4 | OK | 0 | ~~1~~ FIXED | 0 |
| - read-ors-configuration (subskill) | 7/7 | 5/5 | 4/4 | OK | 0 | ~~2~~ FIXED | ~~1~~ FIXED |
| route-optimization | 7/7 | 5/5 | 4/4 | OK | 0 | ~~2~~ FIXED | ~~1~~ KEPT |
| route-deviation | 7/7 | 5/5 | 4/4 | OK | ~~1~~ FALSE POSITIVE | ~~1~~ OK | ~~1~~ FIXED |
| retail-catchment | 7/7 | 5/5 | 4/4 | OK | 0 | ~~2~~ FIXED | ~~2~~ FIXED |
| fleet-intelligence-taxis | 7/7 | 5/5 | 4/4 | OK | 0 | ~~2~~ FIXED | ~~1~~ BY DESIGN |
| fleet-intelligence-food-delivery | 7/7 | 5/5 | 4/4 | OK | ~~1~~ FIXED | ~~3~~ FIXED | ~~1~~ BY DESIGN |
| dwell-analysis | 7/7 | 5/5 | 4/4 | OK | 0 | ~~3~~ FIXED | ~~2~~ FIXED |
| travel-time-matrix | 7/7 | 5/5 | 4/4 | OK | 0 | ~~2~~ FIXED | ~~2~~ FIXED |
| smart-detour-generation | DEFERRED | - | - | - | ~~1~~ DEFERRED | 0 | 0 |
| routing-agent | 7/7 | 5/5 | 4/4 | OK | ~~1~~ FIXED | ~~1~~ FIXED | ~~1~~ FIXED |
| skill-optimiser | 7/7 | 5/5 | 4/4 | OK | 0 | 0 | 0 |

**All issues resolved. 0 blocking, 0 warnings, 0 cosmetic remaining.**

---

## Blocking Issues (all resolved)

### B1. build-routing-solution: SQL syntax error -- FIXED
`CREATE IMAGE IF NOT EXISTS REPOSITORY` → `CREATE IMAGE REPOSITORY IF NOT EXISTS`

### B2. route-deviation: Missing dashboard/ directory -- FALSE POSITIVE
Dashboard directory exists at `.cortex/skills/route-deviation/dashboard/`.

### B3. fleet-intelligence-food-delivery: Missing README.md -- FIXED
Removed stale README.md stage copy command and updated expected file list.

### B4. smart-detour-generation: Skill folder does not exist -- DEFERRED
Removed from README. Will be created as a separate task if needed.

### B5. routing-agent: Step numbering gap -- FIXED
Renumbered Step 11 to Step 10.

---

## Warning Issues (all resolved)

### W1. build-routing-solution: Step "Next" off-by-one -- FIXED
All 4 "Proceed to Step N" references corrected.

### W2. routing-prerequisites: References nonexistent skill name -- FIXED
`skills/deploy-route-optimizer` → `build routing solution`.

### W3. routing-customization/location: No stopping points -- FIXED
Added 3 stopping points (after Step 2, Step 3, Step 5).

### W4. routing-customization/routing-profiles: No error handling -- FIXED
Added error handling table (config not found, upload fails, profile typo).

### W5. routing-customization/read-ors-configuration: No error handling/stopping points -- FIXED
Added stopping points (after Step 1, Step 2) and error handling table (DESCRIBE fails, download fails, no profiles).

### W6. route-optimization: 2 orphaned reference files -- FIXED
Deleted `references/add-carto-data.sql` and `references/coco-direct-deck.md`.

### W7. route-deviation: Template placeholders in Python -- OK (BY DESIGN)
Placeholders are intentional; agent substitutes before execution.

### W8. retail-catchment: No progressive disclosure -- FIXED
Extracted all SQL to `references/sql-pipeline.md`. SKILL.md now references it.

### W9. retail-catchment: Thin trigger list -- FIXED
Added triggers: "retail isochrone analysis", "competitor mapping demo", "retail location analysis", "trade area analysis".

### W10. fleet-intelligence-taxis: 2 orphaned reference files -- FIXED
Deleted `references/coco-direct-deck.md` and `references/pitch-script.md`.

### W11. fleet-intelligence-food-delivery: 4_Retail_Catchment.py not deployed -- FIXED
Added PUT command for `4_Retail_Catchment.py` to `references/streamlit-deployment.md`.

### W12. fleet-intelligence-food-delivery: CREATE STREAMLIT lacks OR REPLACE -- FIXED
Changed to `CREATE OR REPLACE STREAMLIT` in `references/streamlit-deployment.md`.

### W13. fleet-intelligence-food-delivery: environment.yml not referenced -- FIXED
Added `environment.yml` stage copy command to `references/native-app-deployment.md` (both initial deploy and update sections). Updated expected file count from 4 to 5.

### W14. dwell-analysis: No Streamlit deployment SQL -- FIXED
Added complete SiS deployment SQL (CREATE STAGE, snow stage copy for all files, CREATE OR REPLACE STREAMLIT, ALTER STREAMLIT ADD LIVE VERSION).

### W15. dwell-analysis: Asset files not individually listed -- FIXED
Enumerated all local Streamlit files (5) and all SiS files (17: main + 7 pages + 8 app_pages + environment.yml) in tables.

### W16. dwell-analysis: Streamlit page name mismatch -- FIXED
Corrected page descriptions to match actual filenames in both local and SiS versions.

### W17. travel-time-matrix: No stopping points -- FIXED
Added 6 stopping points (H3 counts, work queue, ORS ready, progress check, FLATTEN verify, scale-down).

### W18. travel-time-matrix: 2 orphaned reference files -- FIXED
Linked `build-city-matrix.sql` and `build-ca-travel-time.sql` in reference files list.

### W19. routing-agent: Steps 3-6 have no inline SQL -- FIXED
Added inline SQL stubs (CREATE statements) for Steps 3-6 with pointers to full definitions in references/.

### W20. routing-prerequisites: Thin trigger list -- FIXED
Added triggers: "am I ready to build", "what do I need installed", "verify environment setup".

### W21. read-ors-configuration: Missing metadata block -- FIXED
Added `metadata:` block with author, version, and category.

### W22. route-optimization: Orphaned streamlit.zip -- FIXED
Deleted `assets/streamlit/streamlit.zip`.

---

## Cosmetic Issues (all resolved)

### C1. build-routing-solution: Ambiguous relative paths -- FIXED
Added note: "All relative paths are relative to the repository root directory."

### C2. routing-prerequisites: Naming inconsistency -- FIXED
Fixed "check-prerequisites skill" → consistent with "Run" action verbs. Also expanded description.

### C3. routing-customization: Cross-skill path reference -- FIXED
Added note in Workflow section: paths are relative to repo root.

### C4. route-optimization: Execution Rules could move to references/ -- KEPT
4 lines is compact enough to keep inline. No action needed.

### C5. route-deviation: Examples section verbose -- FIXED
Condensed 3 examples (~150 words) to 3-line "Common Scenarios" section.

### C6. retail-catchment: Step sub-numbering inconsistency -- FIXED
Rewritten SKILL.md uses consistent numbered steps referencing sql-pipeline.md.

### C7. retail-catchment: DO NOT USE doesn't mention all sister skills -- FIXED
Added fleet-intelligence-taxis, fleet-intelligence-food-delivery, route-optimization, route-deviation, dwell-analysis.

### C8. fleet-intelligence-taxis: Local Streamlit not fully inline -- BY DESIGN
Uses `references/sql-pipeline.md` for SQL; SKILL.md provides workflow skeleton. No change needed.

### C9. fleet-intelligence-food-delivery: React app source files not individually documented -- BY DESIGN
Docker build handles source files; individual documentation not needed.

### C10. dwell-analysis: SLA_THRESHOLDS CREATE+INSERT needs 2 calls -- FIXED
Added note in Step 1 table: "Step 3: Table + INSERT (2 calls)".

### C11. dwell-analysis: SiS has 7 pages vs local 4 pages -- FIXED
Documented both versions with complete file tables showing the difference.

### C12. travel-time-matrix: config.yaml duplicates frontmatter -- FIXED
Deleted `config.yaml`. SKILL.md YAML frontmatter is the canonical source.

### C13. travel-time-matrix: No Step 10 gap -- INFORMATIONAL
Step numbering is clean. No action needed.

### C14. routing-agent: query_tag step should note optional -- FIXED
Step 1 header changed to "Set Query Tag for Tracking (Optional)".

### C15. read-ors-configuration: Missing metadata block -- FIXED
Same as W21. Added metadata block.
