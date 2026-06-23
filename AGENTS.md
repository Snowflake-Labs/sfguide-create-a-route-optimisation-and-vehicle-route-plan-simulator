# AGENTS.md

Project-level guidance for AI coding assistants (Cortex Code, Cursor, Copilot, etc.) working in this repository.

## Repository Overview

Cortex Code skills that deploy routing, fleet intelligence, and geospatial analytics on Snowflake — powered by the OpenRouteService (ORS) App on Snowpark Container Services (SPCS).

Skills live in `.cortex/skills/`. Each is a self-contained deployment playbook an AI agent follows step-by-step.

## Architecture Tenets (synapse + Solution Accelerator)

**MANDATORY before evolving the SA app, synapse tool bundles, routing contract, or data-contract packs:** read [`TENETS.md`](TENETS.md). It codifies the load-bearing invariants of the agent-first analytics app (`feature/sa-synapse-app`) so future changes preserve swappability, role isolation, auditability, and reproducible deploys:

1. **Two swappable seams** — routing-engine seam (`ROUTING_PLATFORM.CONTRACT.*`) + data seam (data-contract packs). Consumers bind to neutral contracts, never a named engine or physical source.
2. **Best-of-both topology, one repo** — SA owns UI/agent/distribution; synapse owns the typed/audited tool layer; upstream SA + synapse repos are read-only references, everything vendored here.
3. **Role-scoped bundles = isolation** — User/Ops/Admin each get their own MCP server; the consumer agent attaches the User MCP only.
4. **Config-driven, not code-edited** — a domain swap requires zero TS edits; `app-config.json` is the single config surface, fleet literals are fallbacks only.
5. **Self-building, contract-bound data** — analytic layer rebuilt from raw sources, bit-for-bit verifiable; dashboards/SVs read the neutral `FLEET_APP` contract.
6. **Hybrid provisioning** — heavy substrate (graphs, image pipeline) stays in the control app; SA+synapse is the thin surface.
7. **Audited envelope** — every verb flows through the synapse envelope (`VERB_ATTEMPT` + idempotency); no direct unaudited tool calls.
8. **New-deployment-first** — fixes land in pack/config/synapse source so a fresh deploy is correct; live hotfix is always secondary.

See `TENETS.md` for each tenet's *how to apply* + the anti-pattern it prevents.

## Repository Structure

```
.cortex/skills/              # All Cortex Code skills
  ├── <skill-name>/
  │   ├── SKILL.md           # Skill definition (frontmatter + instructions)
  │   ├── references/        # Detailed SQL, code, docs (loaded on demand)
  │   └── assets/            # Notebooks and other deployable artifacts
  ├── evals/                 # Eval framework (trigger, quality, xref)
build-routing-solution/      # ORS app build artifacts (Dockerfiles, configs)
docs/                        # Documentation (dev/ and guides/)
archive/                     # Archived materials
```

## Build, Test, and Lint

```bash
# Run skill evals (trigger accuracy, quality checks, cross-ref validation)
python3 .cortex/skills/evals/run_evals.py

# Audit a single skill interactively
# Invoke the skill-optimiser skill in Cortex Code: "audit skill <name>"

# Validate ORS image tags match image-versions.env (also run by deploy.sh pre-flight)
bash .cortex/skills/build-routing-solution/scripts/check_image_versions.sh

# Validate ORS services are running
snow sql -q "SHOW SERVICES IN DATABASE OPENROUTESERVICE_APP;"
```

**Optional pre-commit hook** (blocks commits when `image-versions.env`, service YAMLs, SQL modules, or scripting guidelines drift):

```bash
chmod +x .githooks/pre-commit
git config core.hooksPath .githooks
```

No global build/lint step — each skill is independently deployable via its own SKILL.md workflow.

## Skills Inventory

| Skill | Category | Purpose |
|-------|----------|---------|
| `install-fleet-apps` | infrastructure | **PRIMARY** installer for the new synapse-based, vehicle/industry-AGNOSTIC architecture: FLEET_SA_APP + FLEET_ADMIN_APP + synapse MCP bundles + FLEET_APP data contract + roles + agents. Self-owning (relocated artifacts, self-provisioned infra, static seed). Delegates only the ORS engine to build-routing-solution. |
| `build-routing-solution` | infrastructure | Builds and deploys the ORS app on SPCS. **Secondary** to install-fleet-apps: the delegated provider of the live ORS/VROOM routing engine behind the `ROUTING_PLATFORM.CONTRACT` seam. |
| `routing-prerequisites` | infrastructure | Checks local build prerequisites (Docker, Snow CLI) |
| `routing-customization` | configuration | Router with 3 subskills for ORS config changes |
| `route-optimization` | demo | VRP demo with Marketplace data + notebook |
| `fleet-intelligence-taxis` | fleet-intelligence | Taxi GPS telemetry generation + React dashboard |
| `fleet-intelligence-food-delivery` | fleet-intelligence | Food delivery courier telemetry + React app |
| `retail-catchment` | demo | Retail location analysis with isochrone catchment zones |
| `route-deviation` | demo | Detour detection ETL pipeline + React dashboard |
| `dwell-analysis` | demo | 12-step Dynamic Table pipeline for dwell/congestion |
| `routing-agent` | advanced | Snowflake Intelligence agent wrapping ORS functions |
| `setup-agent-playground` | demo-setup | Seeds industry-agnostic demo data + uploads agent-demos.json so the Agent Playground shows catchment/delivery/fleet scenarios |
| `skill-optimiser` | developer-tools | Audits and optimizes skills per Anthropic best practices |
| `routing-solution-cleanup` | developer-tools | Discovers and removes skill-created Snowflake objects via COMMENT tag |
| `backload-matching` | demo | DHL Freight backload VRP demo: solves trailer<->load assignment via OPENROUTESERVICE_APP.CORE.OPTIMIZATION, with internal-first priority and Cortex rationale |
| `freight-exchange` | demo | Dispatcher-grade marketplace cockpit (parallel page to Backload Matching). Browse + filter + map of synthesized freight offers per active preset, with trust-score (credit/KYC/blacklist) and market-rate (vs. weekly p25/p50/p75 USD/km RATE_INDEX dynamic table) badges. Powered by FLEET_INTELLIGENCE.MARKETPLACE projection views over per-preset SYNTHETIC_DATASETS.UNIFIED data. |
| `emergency-response` | demo | Single-page, multi-step evacuation-planning wizard. Step 1 colors a state's ZIP codes by FEMA NRI flood/wildfire risk; Step 2 seeds CareConnect PACE centers + Overture participant addresses sampled uniformly across the union of per-center drive-time isochrones (union drawn as a sanity overlay); Step 3 sets per-center vehicles/capacity + max trips per vehicle; Step 4 solves a capacitated multi-depot, multi-trip evacuation VRP (`OPTIMIZATION`, `pickup:[1]` jobs — each van expanded into up to maxTrips round trips) over participants at/above a chosen ZIP risk level, with a selectable trips list, numbered stop markers, and an overflow warning when the trip cap is exceeded. Fully client-driven via read-only `sfQuery`; risk = `V_ZIP_RISK` (NRI county risk joined to ZIP by county FIPS). States via `STATE_REGION_MAP` (CA/CO/PA). |

## Skill Conventions (Quick Reference)

For the full rule set, read `.cortex/skills/skill-optimiser/SKILL.md` and its `references/` directory. That skill encodes all conventions from "The Complete Guide to Building Skills for Claude" (Anthropic, Jan 2026).

Key rules:
- Folder name: **kebab-case**, must match `name` in YAML frontmatter
- Main file: exactly `SKILL.md` (case-sensitive). No `README.md` inside skill folders.
- Description: under **1024 chars**, formula: `[What] + [When] + [Triggers] + [Do NOT use for]`
- Body: under **5,000 words**. Move detailed content to `references/`
- No XML angle brackets in frontmatter. No "claude" or "anthropic" in skill names.
- Cross-skill references use full relative paths from repo root:
  ```
  > Read and follow `.cortex/skills/routing-customization/SKILL.md`
  ```
- Subskills nest as child folders; parent SKILL.md acts as a router
- All skills use `metadata.author: Snowflake SIT-IS` and `metadata.version: 1.0.0`
- Deployment skills must include `depends_on` in frontmatter listing prerequisite skills
- Deployment skills must include a `## Configuration` table with parameterized defaults
- Deployment skills must include a `## Required Privileges` table (no ACCOUNTADMIN assumptions)
- Deployment skills must include a `## Cleanup` section with DROP statements

## Fix Discipline (new-deployment-first)

**MANDATORY:** Every bug fix or improvement MUST first land in the source artifacts that a fresh, from-scratch deployment consumes, so the next clean install is correct with no manual step. A live-environment hotfix is always secondary and is only valid once the same change exists in the repo source.

- **Data / SQL fixes** -> the skill SQL (`references/*.sql`), `datasets/load-seed-data.sql`, and/or the control app's `init.ts` boot path. NOT just an ad-hoc `snow sql` run against a live account.
- **App behavior fixes** (React/server) -> the source under `services/ors_control_app/` PLUS an image-version bump (`image-versions.env` + service YAML + `references/snowflake-scripting-guidelines.md`, enforced by `check_image_versions.sh`). NOT just a redeploy of an unchanged image.
- **Config/pointer/seed fixes** -> seed them in the loader or the boot init (data-derived, not hardcoded), so a fresh install never depends on a demo skill or a restart to become correct.

Before considering any fix done, reason through the fresh-install path (`build-routing-solution` Steps 1-8): "does a brand-new deploy of this repo already include this fix without manual intervention?" If not, fix the source first, then (optionally) apply the same change to the live install. When both are needed, do the repo source edit BEFORE the live hotfix.

## Error Logging

When any step fails or produces unexpected results (SQL errors, missing objects, wrong row counts, service failures, deployment issues), log the issue to `logs/` following the format in `logs/README.md`. Create one log file per execution: `<skill-name>_{YYYY-MM-DD}_{HH-MM}.md`. Continue execution where possible, logging all issues encountered. If execution completes with no issues, do not create a log file.

## Commit Discipline

**MANDATORY:** After each logical change is completed and verified, create a new git commit on the user's single shared branch AND push it immediately. Do not batch unrelated changes into a single commit, and do not leave commits unpushed at the end of a turn.

### Branching Rules (NON-NEGOTIABLE)
- **NEVER commit directly to `main`.** `main` is protected — changes only land via merged PRs from `dev`.
- **NEVER commit directly to `dev`.** `dev` is the integration branch — changes only land via merged PRs from per-user branches.
- **All work happens on ONE per-user long-lived branch named `feat/<GITHUB_LOGIN>-feat`.** The GitHub login MUST be detected dynamically at the start of every session — never hardcoded.
  ```bash
  GITHUB_LOGIN=$(gh api user --jq .login)
  USER_BRANCH="feat/${GITHUB_LOGIN}-feat"
  ```
  Example: for login `sfc-gh-preszke` the branch is `feat/sfc-gh-preszke-feat`.
  This single branch is shared by all parallel Cortex Code chats on the user's machine, so no branch switching is ever needed mid-session.
- **Do NOT create additional branches.** No `<username>/work`, no `<username>/<topic>`, no `feat/*` / `fix/*` / `docs/*` per-change branches. One user, one branch. Multiple parallel chats sharing one working tree cannot each own their own branch — that causes constant `git checkout` thrashing and lost work. Commit straight onto the user's branch instead.
- **All PRs target `dev`** (not `main`). Only release/promotion PRs go from `dev` → `main`, and those are opened by humans, not assistants.
- Before starting work, detect the user branch and verify you are on it:
  ```bash
  GITHUB_LOGIN=$(gh api user --jq .login)
  USER_BRANCH="feat/${GITHUB_LOGIN}-feat"
  CURRENT=$(git branch --show-current)
  if [ "$CURRENT" != "$USER_BRANCH" ]; then
    git checkout "$USER_BRANCH" 2>/dev/null || git checkout -b "$USER_BRANCH"
  fi
  ```
  If `gh` is not authenticated, stop and ask the user to run `gh auth login` — never fall back to a hardcoded branch name.
- After EVERY commit, push the branch immediately. Do not leave local commits unpushed:
  ```bash
  git push -u origin "$USER_BRANCH"
  ```
- Open / update a single PR into `dev` for the branch when there is reviewable work:
  ```bash
  gh pr create --base dev --head "$USER_BRANCH" --title "..." --body "..."
  ```
- A PR may include several commits from the branch. Keep PRs scoped to one logical theme — open a new PR rather than piling unrelated commits into one.

### Commit Rules
- One commit per logical change (one skill edit, one bug fix, one doc update, one refactor)
- Commits land on `$USER_BRANCH` (i.e. `feat/<GITHUB_LOGIN>-feat`). Never on a fresh per-change branch.
- After every commit, run `git push origin "$USER_BRANCH"` immediately. A change is not "done" until it is pushed to remote.
  - **CRITICAL: Plain `git push` will fail with SSH permission denied.** Before your first push in a session, ALWAYS read `/memories/git-push-method.md` for the working command (uses `gh auth token` + `GIT_CONFIG_GLOBAL=/dev/null` to bypass the global SSH `insteadOf` rule). Do NOT attempt `git push origin <branch>` directly — it always fails for this repo.
- Verify the change works (SQL compiles, skill evals pass, notebook runs) BEFORE committing
- Stage only files related to the current change — never use blanket `git add .` if unrelated edits exist
- Commit message format: `<type>(<scope>): <subject>` where type is one of `feat`, `fix`, `docs`, `refactor`, `chore`, `test`
  - Examples:
    - `feat(fleet-intelligence-taxis): add H3 resolution config parameter`
    - `fix(build-routing-solution): handle ARM Mac esbuild segfault`
    - `docs(AGENTS.md): add commit discipline rule`
- If a change spans multiple skills, prefer multiple smaller commits over one large one
- Never amend or force-push commits the user has not explicitly authorized
- Never push directly to `main` or `dev` — push only to `$USER_BRANCH` (`feat/<GITHUB_LOGIN>-feat`)

## Friction Logging

**MANDATORY:** After every `build-routing-solution` execution (regardless of success or failure), generate a friction log in `logs/`. This is NOT optional — every run produces a friction log, even if everything went smoothly.

File name: `friction-log_{YYYY-MM-DD}_{HH-MM}.md`

Follow the friction log template in `logs/README.md`. The log must capture:
- Exact wall-clock duration of each step
- Any friction points (confusing instructions, slow operations, unexpected behavior)
- **For each friction point:** what was done to resolve it during this run, and a recommendation for how to prevent it in future runs (e.g., skill wording change, new validation step, default change)
- A step-by-step status table showing OK/FAILED/SKIPPED for each workflow step
- Final summary with total execution time and overall outcome

If no friction was encountered, the log should still be created with "No friction points" and the step timing table.

## Creating a New Skill

1. Create folder: `.cortex/skills/my-new-skill/`
2. Create `SKILL.md` with YAML frontmatter + body (use `skill-optimiser` for the template)
3. Add `references/` for detailed SQL/code if body would exceed 5,000 words
4. Add `assets/` for notebooks or other deployable artifacts
5. Audit: invoke `skill-optimiser` or run `python3 .cortex/skills/evals/run_evals.py`
6. Update the Skills Inventory table above

## Do NOT

- **Inline large SQL blocks in SKILL.md** — put them in `references/*.md` and link
- **Modify a `FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.*` (or any other shared) view in `references/asset-velocity-views.sql` (or its sibling `*.sql` under `references/`) without also updating its parallel definition in `services/ors_control_app/server/lib/init.ts`.** The control app's `init.ts` runs on every container start and `CREATE OR REPLACE`s the views it owns, silently overwriting any out-of-band changes. If the React page references a column that `init.ts` hasn't recreated, `sfQuery` gets a SQL error, swallows it, and the page renders empty data with no obvious failure. When in doubt, search `init.ts` for the view name before changing a reference SQL file. **The four Asset Velocity views (`VW_IDLE_TRAILERS`, `VW_LANE_DEMAND`, `VW_FLEET_HGV_PROFILE`, `VW_TRAILER_COST_OF_IDLENESS`) specifically live in the `assetVelocityStmts()` helper consumed by the exported `ensureAssetVelocityViews()` in `init.ts` — that function is the single runtime owner (called both at boot and lazily by `POST /api/asset-velocity/ensure`). Edit `assetVelocityStmts()` and keep `references/asset-velocity-views.sql` in sync.**
- **Inline JSON in SQL via single-quoted string literals.** Free-text fields (POI names, addresses, listing text) routinely contain apostrophes, backslashes, and double-quotes that break Snowflake's `PARSE_JSON` once the host string is single-quoted. Use the helper `asSqlJsonLiteral(obj)` from `services/ors_control_app/src/lib/sfQuery.ts` (dollar-quoted literal). Pair it with `sfQuery(..., {throwOnError:true})` whenever the call sits behind a user-visible button — silent `[]` returns are the canonical mask for this entire bug class. The two page-level helper modules (`asset-velocity/helpers.ts` and `backload-matching/helpers.ts`) already re-export from `src/lib/sfQuery.ts`; do NOT add a third copy of `sfQuery`.
- **Skip the query tag** — every skill must set the session query tag for attribution tracking:
  ```sql
  ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-<skill-name>","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
  ```
- **Skip the object COMMENT** — every CREATE statement must include a COMMENT tracking tag (or `ALTER ... SET COMMENT` for CTAS):
  ```sql
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-<skill-name>","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"<sql|notebook|app>"}}';
  ```
- **Assume ORS is running** — always verify with `SHOW SERVICES IN DATABASE OPENROUTESERVICE_APP;` (all 5 services must be RUNNING)
- **Hardcode city/region** — skills must be configurable via parameters, not baked-in coordinates
- **Add README.md inside skill folders** — all docs go in SKILL.md or `references/`
- **Duplicate conventions** — point to `skill-optimiser` references instead of repeating rules
- **Require ACCOUNTADMIN** — document minimum privileges in `## Required Privileges`; never assume ACCOUNTADMIN
- **Skip cleanup instructions** — every deployment skill must have a `## Cleanup` section with DROP statements
- **Skip committing AND pushing after a completed change** — every verified change must result in a commit AND a push to `feat/<GITHUB_LOGIN>-feat` before the turn ends (see `## Commit Discipline`)
- **Commit directly to `main` or `dev`** — both are protected. All work goes on `feat/<GITHUB_LOGIN>-feat` with PRs targeting `dev`. Only humans promote `dev` → `main`.
- **Hardcode the user branch name** — always derive it from `gh api user --jq .login` at session start. Do not paste a literal branch like `feat/sfc-gh-preszke-feat` into AGENTS.md, skill files, or scripts.
- **Create a new branch per change or per topic** — there is exactly one branch per user (`feat/<GITHUB_LOGIN>-feat`). No `<username>/work`, no `<username>/<topic>`, no `feat/*` / `fix/*` / `docs/*` per-change branches. Multiple Cortex Code chats running in parallel against the same working tree must all commit to the same branch.
- **Create any Snowflake object or run any query without tracking tags** — this is a hard requirement with no exceptions. Every new Snowflake object (TABLE, VIEW, PROCEDURE, FUNCTION, STAGE, SCHEMA, DATABASE, WAREHOUSE, TASK, DYNAMIC TABLE, STREAMLIT, SERVICE, AGENT) MUST have a COMMENT tracking tag. Every SQL session MUST set `query_tag` before executing statements. This applies to all skills, notebooks, stored procedures, dynamic SQL inside procedure bodies, ORS control app server code, and any other code path that creates objects or runs queries. For objects created via CTAS or dynamic SQL, use `ALTER ... SET COMMENT` immediately after creation. For service functions (`SERVICE=...` clause) that do not support COMMENT, document the limitation and ensure the parent procedure has a COMMENT tag.

## Control App Image Deployment (ors_control_app)

When changing any source file (`src/`, `server/`, or config), rebuild and push the Docker image.
The multi-stage `Dockerfile.runtime` compiles both the React frontend and the server automatically —
no manual `dist/` or `dist-server/` edits are needed.

**IMPORTANT:** Always use `Dockerfile.runtime` (multi-stage build). Never create a "prebuilt" Dockerfile that copies `dist/` from the host — this conflicts with `.dockerignore` and creates fragile host-build dependencies. The `.dockerignore` intentionally excludes `dist` and `dist-server` because the multi-stage build generates them inside the container. Do not remove those exclusions.

**ARM Mac + Podman:** If `esbuild` crashes with a QEMU segfault during the build stage, build locally first (`npm run build && npx tsc -p tsconfig.server.json`), then use `--ignorefile .dockerignore.prebuilt` when building the image. See `references/troubleshooting.md` for full instructions. Do NOT rename or edit `.dockerignore`.

```bash
APP_DIR=.cortex/skills/build-routing-solution/openrouteservice_app/services/ors_control_app

snow spcs image-registry login -c <connection>
REPO_URL=$(snow spcs image-repository url OPENROUTESERVICE_APP.core.image_repository -c <connection>)

# 1. Edit source files only:
#    - src/components/...  (React frontend)
#    - server/index.ts     (Express backend)

# 2. Build (bump version from current):
docker build --platform linux/amd64 \
  -f $APP_DIR/Dockerfile.runtime \
  -t $REPO_URL/openrouteservice_app/core/image_repository/ors_control_app:vX.Y.Z \
  $APP_DIR

# 3. Push:
docker push $REPO_URL/openrouteservice_app/core/image_repository/ors_control_app:vX.Y.Z

# 3b. If `docker push` hangs (single layer stuck at "Waiting" forever):
#     This is a known SPCS registry token-refresh bug — the bearer token
#     issued by `snow spcs image-registry login` expires mid-PUT and the
#     registry rejects the upload with 401. Docker daemon retries auth
#     silently → re-queues the blob → the layer "Waits" indefinitely.
#     Symptoms: 8 of 9 layers report "Layer already exists", 1 sits on
#     "Waiting". Podman shows the explicit error
#     "unable to retrieve auth token: invalid username/password".
#
#     Workaround: use `crane` (from go-containerregistry), which handles
#     registry token refresh correctly:
brew install crane
snow spcs image-registry login -c <connection>   # refreshes ~/.docker/config.json + keychain
docker save $REPO_URL/openrouteservice_app/core/image_repository/ors_control_app:vX.Y.Z -o /tmp/img.tar
crane push /tmp/img.tar $REPO_URL/openrouteservice_app/core/image_repository/ors_control_app:vX.Y.Z
#     Expected output: `pushed blob: sha256:<hash>` followed by
#     `<image>:<tag>: digest: sha256:... size: 1729`. Total ~5 minutes
#     for a typical 139 MB image with one new layer.
#
#     `docker save | podman load | podman push` does NOT help here —
#     both daemons hit the same registry-side bug. Restarting Docker
#     Desktop and re-logging in does not help either. Only crane works.

# 4. Update version:
#    - $APP_DIR/ors_control_app_service.yaml (image tag)

# 5. Upload updated spec to stage:
snow stage copy $APP_DIR/ors_control_app_service.yaml \
  @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/services/ors_control_app/ \
  -c <connection> --overwrite

# 6. Apply new spec and restart:
# IMPORTANT: ALTER SERVICE while RUNNING does not reliably cycle the container.
# Always use the suspend → update spec → resume pattern to guarantee the new image loads.
```sql
ALTER SERVICE OPENROUTESERVICE_APP.CORE.ORS_CONTROL_APP SUSPEND;

ALTER SERVICE OPENROUTESERVICE_APP.CORE.ORS_CONTROL_APP
  FROM @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/services/ors_control_app/
  SPECIFICATION_FILE = 'ors_control_app_service.yaml';

-- The service does NOT auto-resume after a spec update. Always resume manually:
ALTER SERVICE OPENROUTESERVICE_APP.CORE.ORS_CONTROL_APP RESUME;
```

# 7. After the service restarts, always retrieve and display the endpoint URL:
```sql
SHOW ENDPOINTS IN SERVICE OPENROUTESERVICE_APP.CORE.ORS_CONTROL_APP;
SELECT 'https://' || ingress_url AS control_app_url
FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
WHERE name = 'ors-control-app';
```

## Skill Dependency Graph

```mermaid
graph TD
    RP[routing-prerequisites] --> IFA[install-fleet-apps PRIMARY]
    IFA -.->|"delegates ORS engine only"| BRS[build-routing-solution secondary]
    RP --> BRS
    BRS --> RC[routing-customization]
    BRS --> RO[route-optimization]
    BRS --> FIT[fleet-intelligence-taxis]
    BRS --> FIFD[fleet-intelligence-food-delivery]
    BRS --> RET[retail-catchment]
    BRS --> RD[route-deviation]
    BRS --> RA[routing-agent]
    RA --> SAP[setup-agent-playground]
    RO --> BM[backload-matching]
    BRS --> BM
    BM --> FX[freight-exchange]
    BRS --> FX
    RC --> FIT
    RC --> FIFD
    RC --> RD
 RD --> DA[dwell-analysis]

 style IFA fill:#6c6,stroke:#333
 style BRS fill:#f96,stroke:#333
 style RP fill:#9cf,stroke:#333
 style RC fill:#9cf,stroke:#333
```

**Legend:** Green = primary installer (new architecture). Orange = ORS engine infrastructure (secondary/delegated). Blue = configuration/prerequisites. White = legacy demo/feature skills.

`install-fleet-apps` is the primary path for the new agnostic architecture; it self-provisions infra/data and only delegates the live ORS engine to `build-routing-solution`. The legacy per-vehicle/vertical demo skills (taxis, food-delivery, retail-catchment, backload, freight-exchange) remain under `build-routing-solution` and are NOT part of the agnostic installer.

## Common Patterns

- **ORS dependency**: most demo skills require 4 running ORS services. Use `routing-prerequisites` to verify.
- **DIM_DATASETS bootstrap invariant (friction-log F4 fix, v1.1.58)**: `init.ts` MUST call `ensureUnifiedTables()` (from `server/studio/ensure-tables.ts`) BEFORE any `CREATE OR REPLACE VIEW SYNTHETIC_DATASETS.UNIFIED.V_*_CURRENT` statement. The `V_*_CURRENT` views JOIN to `FLEET_INTELLIGENCE.CORE.DIM_DATASETS`, which is created by `ensureUnifiedTables`. On a fresh install no Studio job has ever run, so without the explicit ensure-tables call at boot start the views fail with "object does not exist" and every demo that reads through them silently breaks. Symmetrically: any SQL that ALTERs `SYNTHETIC_DATASETS.UNIFIED.DIM_FLEET` (e.g. `extend-dim-fleet-hgv.sql`) MUST `DROP VIEW IF EXISTS V_DIM_FLEET_CURRENT` first, otherwise `ADD COLUMN` invalidates the view's declared column count and the next boot fails until the view is dropped manually.
- **Agent Playground region awareness**: The control-app's Agent Playground sends `region`, `vehicle_type`, and the derived ORS `profile` on every `/api/agent/chat` call. The backend prepends a hidden context turn so the Cortex Agent defaults tool args to the active region/profile, and uses the same values as the local geometry-recovery re-execution defaults (no more hard-coded `California` / `driving-car`). Example chips are generated live by `GET /api/agent/examples` via `SNOWFLAKE.CORTEX.COMPLETE` per (region, vehicle); fallback is `config/agent-demos.json` on `ORS_SPCS_STAGE`. No caching — regenerated on every selection change (300 ms debounce).
- **Overture Maps POI data**: fleet skills use Overture Maps for realistic locations. Fallback: synthetic points within configured bounding boxes.
- **ORS Control App deployment**: Edit source → `docker build` (multi-stage, no manual dist/ step) → `docker push` → update YAML version → `snow stage copy` spec to stage → `ALTER SERVICE FROM @stage SPECIFICATION_FILE=...`.
- **Object tracking**: Two tracking mechanisms — session `query_tag` (tracks queries) and object `COMMENT` (tracks created objects). Both are required. For CTAS (`CREATE TABLE ... AS SELECT`), use `ALTER TABLE ... SET COMMENT` after creation since CTAS doesn't support inline COMMENT.
- **REBUILD_GRAPHS management (Issue #59)**: Routing graphs are persisted on `@ORS_GRAPHS_SPCS_STAGE/<region>/` and MUST be reused across suspend/resume cycles. The `create_region_ors_service` proc probes the stage and sets `REBUILD_GRAPHS="false"` if graphs already exist. After first-time provisioning completes (`service_ready=true`), `PROVISION_REGION_WRAPPER` auto-calls `SET_REBUILD_GRAPHS_FLAG(region, 'false')` so the next resume is instant (~1–2 min). For forced rebuilds (PBF update / corruption), call `REBUILD_REGION_GRAPHS(region)`.
- **Parallel graph load on resume**: `ors-config.yml` for every region sets `ors.engine.init_threads` via `WRITE_ORS_CONFIG` to `min(N_profiles, cap)` where cap is **2** for `S`, **4** for `L`, **8** for `XXL` (S-tier 2G heap OOMs above 2 parallel profile loads). Effective on the next suspend/resume cycle after the staged config is re-written (`REROLL_ORS_CONFIG_INIT_THREADS` on deploy, or any provision/re-provision).
- **Per-region VROOM (multi-region OPTIMIZATION)**: Each provisioned region gets its own `VROOM_SERVICE_<REGION>` co-located in `ORS_POOL_<REGION>` (same compute pool as the region's ORS). The VROOM image (`vroom-docker:v1.0.4`) reads `ORS_HOST` from env and substitutes it into `/conf/config.yml` at startup, so the same image serves any region without rebuild. `BUILD_VROOM_SERVICE_SPEC(region)` + `create_region_vroom_service(region)` mirror the ORS pattern; `PROVISION_REGION_WRAPPER` calls `create_region_vroom_service` after the ORS service is up. The routing gateway's `resolve_vroom_host(region)` returns `vroom-service-<region>` and routes `/optimization` there, so VROOM's internal ORS calls land on the right regional graph. To add a new region, no code change is needed — the existing provisioning flow auto-deploys the per-region VROOM. Drop with `drop_region_vroom(region)` (also called by `drop_region_ors`). **v1.1.0 unification**: there is NO global `ORS_SERVICE`/`VROOM_SERVICE` anymore — even the default region (`SanFrancisco`) is served by `ORS_SERVICE_SANFRANCISCO` + `VROOM_SERVICE_SANFRANCISCO` in `ORS_POOL_SANFRANCISCO`. The gateway resolves a missing/NULL `region` to the env var `DEFAULT_REGION_NAME` (default: `SanFrancisco`) so callers may still omit the argument; both omitted and explicit-region paths land on the same per-region service. Passing `region` is recommended in all multi-region payloads to be self-documenting and to avoid relying on the DEFAULT_REGION_NAME setting. The `_OPTIMIZATION_TABULAR_RAW(jobs, vehicles, matrices, region)` form requires region as the 4th arg (do not pass `NULL`). VROOM's `config.yml` body-parser limit is set to `50mb` to fit pre-computed matrices for VRPs up to ~1000 locations.
- **AUTO_SUSPEND_SECS invariant (per-stage contract)**: Only services *strictly involved in the active build* are pinned at `AUTO_SUSPEND_SECS=0`. Every other service stays at the steady-state default. Active build = a row in `REGION_PROVISION_JOBS` with `STATUS IN ('PENDING','RUNNING')` at a specific `STAGE`, OR a row in `MATRIX_BUILD_JOBS` with `STATUS IN ('PENDING','RUNNING')` and `STAGE NOT IN ('COMPLETE','ERROR')`, OR a row in `FLEET_INTELLIGENCE.CORE.GENERATION_JOBS` with `STATUS IN ('PENDING','RUNNING')` (Data Studio synthetic-generation job). The contract:
  - `STAGE = 'DOWNLOADING'` → pin `DOWNLOADER`, `ORS_SERVICE_<REGION>`, and `ORS_POOL_<REGION>` to 0.
  - `STAGE IN ('CONFIGURING','STARTING_SERVICE','WAITING_FOR_SERVICE','BUILDING_GRAPH')` → pin `ORS_SERVICE_<REGION>` and `ORS_POOL_<REGION>` to 0; `DOWNLOADER` returns to 14400 (the PBF is already on stage).
  - Matrix job `STATUS IN ('PENDING','RUNNING')` → pin `routing_gateway_service`, `ORS_SERVICE_<REGION>`, `VROOM_SERVICE_<REGION>`, and `ORS_POOL_<REGION>` to 0.
  - Studio (Data Studio) generation job `STATUS IN ('PENDING','RUNNING')` → pin `routing_gateway_service`, `ORS_SERVICE_<REGION>`, `VROOM_SERVICE_<REGION>`, and `ORS_POOL_<REGION>` to 0. The control-app's `captureAndScaleUp()` performs this pinning in-process at job start and `scaleDown()` restores the captured baselines on every exit. `RECONCILE_AUTO_SUSPEND()` is the global safety net for the case where the control-app container restarts mid-run.
  - All other times → services = `14400` (4h), per-region pools = `3600` (1h). `OPENROUTERSERVICE_APP_COMPUTE_POOL` is unrelated to this invariant (its default is `600`).
  - `ors_control_app` has public endpoints and therefore no `AUTO_SUSPEND_SECS` — it is excluded.
  - Every procedure that flips a value to `0` is responsible for restoring its default on ALL exits (happy path, timeout, early return, exception).
  - The idempotent safety net `OPENROUTESERVICE_APP.CORE.RECONCILE_AUTO_SUSPEND()` is the single source of truth and now reconciles `routing_gateway_service`, `ORS_SERVICE_%`, `VROOM_SERVICE_%`, `DOWNLOADER`, and `ORS_POOL_%` against `REGION_PROVISION_JOBS`, `MATRIX_BUILD_JOBS`, AND `FLEET_INTELLIGENCE.CORE.GENERATION_JOBS`. Auto-called by `SUSPEND_ALL_SERVICES` and `SUSPEND_SERVICE`; safe to call at any time.
- **v1.1.4 default-sentinel retirement**: The legacy `region:'default'` sentinel returned by `/api/regions/provisioned` was retired. `LIST_REGIONS()` now returns SanFrancisco as a regular row in `REGION_ORS_MAP` (with new `IS_DEFAULT BOOLEAN` column, seeded `TRUE` for the canonical default). The control-app server no longer synthesizes a `region:'default'` entry, no longer makes 0-arg `ORS_STATUS()` calls, and no longer special-cases `'default'` in studio job pool scaling, ors-readiness, or stage probing. The `isDefault` boolean is preserved as a pure UI hint (dropdown auto-selection + "(Default)" badge) but is decoupled from SQL routing. Inbound API requests passing `'default'` or empty region are still resolved at the gateway boundary via `normalizeRegion()` -> `DEFAULT_REGION_NAME`, but internal contracts assume real region keys.
- **Dataset versioning (Studio runs are non-destructive)**: Each Data Studio run is recorded as an immutable dataset in `FLEET_INTELLIGENCE.CORE.DIM_DATASETS` keyed by `JOB_ID`. At most ONE row per `(REGION, VEHICLE_TYPE)` has `IS_ACTIVE = TRUE`. Re-running Studio for the same `(REGION, VEHICLE_TYPE)` does NOT delete prior `DIM_*` / `FACT_FREIGHT_OFFERS` / `DIM_PARTNERS` / `FACT_PARTNER_HISTORY` rows — the prior `DIM_DATASETS` row is just flipped to `IS_ACTIVE = FALSE` and a new row is inserted as active (`archivePriorDatasets()` in `server/studio/jobs.ts`). All downstream consumers MUST read from dataset-scoped projection views and never from base tables directly: `SYNTHETIC_DATASETS.UNIFIED.V_DIM_FLEET_CURRENT`, `V_DIM_POIS_CURRENT`, `V_FACT_FREIGHT_OFFERS_CURRENT`, `V_DIM_PARTNERS_CURRENT`, `V_FACT_PARTNER_HISTORY_CURRENT`, `V_FACT_TRIPS_CURRENT`, `V_FACT_VEHICLE_TELEMETRY_CURRENT`, `V_DIM_TRIP_SCHEDULE_CURRENT`, plus app-scoped `FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.V_PLACES_CURRENT` and `FLEET_INTELLIGENCE.MARKETPLACE.V_FACT_OFFER_ROUTES_CURRENT`. Intentional exceptions that still read from base tables: `RATE_INDEX` dynamic table (market-rate signal across all data), `region-sync.ts` / `regions/lifecycle.ts` (telemetry hull derivation wants full spatial coverage). Old datasets are deleted only via the explicit `DELETE /api/studio/datasets/:id` endpoint (Studio Datasets panel "Delete" button) — there is NO auto-prune. The legacy destructive `clearRegionScope()` helper is retained but is now invoked only from this endpoint, never from a generation run. On a `FAILED` run that produced 0 rows, `revertArchivePriorDatasets()` removes the new `DIM_DATASETS` row and re-activates the most recent prior dataset, so a failed empty run never replaces the active one. The Studio Datasets panel UI lists every dataset with row counts and per-row Activate / Rename / Delete buttons; Delete is refused with HTTP 409 if the target is the only dataset in its scope.

## Geospatial Conventions

### Prefer Boundary Polygons over Bounding Boxes

Whenever a region's polygon is available — and it almost always is, because `OPENROUTESERVICE_APP.CORE.REGION_CATALOG.BOUNDARY` is baked for every provisioned region (Geofabrik poly, bbbike bbox, or fallback) — filter spatial data with the polygon, not the bbox. Bbox over-includes ocean, neighbouring states, and even neighbouring countries (e.g. a Germany bbox grabs Czechia, Switzerland, Austria, the North Sea).

| Use case | Bbox (avoid) | Boundary (preferred) |
|---|---|---|
| Filter rows in a region | `LON BETWEEN ... AND LAT BETWEEN ...` | `ST_WITHIN(geog, rc.BOUNDARY)` |
| Map recenter | midpoint of `MIN_LON/MAX_LON, MIN_LAT/MAX_LAT` | `BOUNDARY_CENTROID_LON/LAT` from `/api/regions` |
| Region picker enrich | `REGION_ORS_MAP.MIN_LAT/MAX_LAT/...` | `REGION_CATALOG.BOUNDARY` joined via `LOOKUP_NAME` / `REGION_KEY` |
| Live POI / address query | bbox SET vars at ingest | `JOIN REGION_CATALOG ON ST_WITHIN` at query time |

Standard join pattern (use this verbatim across SQL and React queries):
```sql
JOIN OPENROUTESERVICE_APP.CORE.REGION_CATALOG rc
  ON rc.BOUNDARY IS NOT NULL
 AND (UPPER(rc.LOOKUP_NAME) = UPPER('<region>')
      OR UPPER(rc.REGION_KEY) = UPPER('<region>'))
WHERE ST_WITHIN(<your_geog_col>, rc.BOUNDARY)
```

In React components, prefer the resolved ORS key (the one that successfully answered `ORS_STATUS`) as the `<region>` literal in the join. Do NOT serialize `BOUNDARY_GEOJSON` into the query — it is large (multi-MB for country-sized polygons) and the join keeps the polygon server-side.

Bbox is acceptable ONLY when:
- The boundary doesn't yet exist (e.g. brand new user-added region not yet in `REGION_CATALOG`).
- The downstream API requires bbox literals (Geofabrik PBF download URL builder, ORS provisioning input).
- A `CLUSTER BY` expression is required (GEOGRAPHY isn't allowed in `CLUSTER BY`).
- Performance probing where a cheap bbox prefilter is layered ahead of `ST_WITHIN` — but the `ST_WITHIN` MUST still be present as the authoritative filter.

For SQL pipelines that pre-filter at ingest time, prefer
`ST_WITHIN(geom, (SELECT BOUNDARY FROM OPENROUTESERVICE_APP.CORE.REGION_CATALOG WHERE UPPER(LOOKUP_NAME)=UPPER('<region>') OR UPPER(REGION_KEY)=UPPER('<region>') LIMIT 1))`
over the legacy `SET BBOX_*` pattern when the polygon exists.

### GEOGRAPHY-First Schema Design
- Store point locations as `GEOGRAPHY` columns (not separate FLOAT lat/lon).
- Construct via `ST_MAKEPOINT(longitude, latitude)` — note: **longitude first**.
- Line/polygon geometries: use `TO_GEOGRAPHY('LINESTRING(lon lat, ...)')` or `ST_MAKELINE`.
- Keep redundant FLOAT lat/lon only when required (CLUSTER BY, ORS ARRAY_CONSTRUCT API args, bounding-box configs).

### Preferred Functions
| Instead of | Use |
|---|---|
| `H3_LATLNG_TO_CELL(lat, lon, res)` | `H3_POINT_TO_CELL_STRING(geography, res)` |
| `HAVERSINE(lat1, lon1, lat2, lon2)` (returns km) | `ST_DISTANCE(geog_a, geog_b) / 1000` (meters→km) |
| `ST_DISTANCE` + filter | `ST_DWITHIN(geog_a, geog_b, meters)` (uses spatial index) |
| Separate FLOAT lat/lon in WHERE | `ST_WITHIN`, `ST_INTERSECTS`, `ST_CONTAINS` |

### H3 Index Storage
- Always store H3 indices as `VARCHAR` (string format, e.g. `'8928308280fffff'`).
- Use `H3_POINT_TO_CELL_STRING` (returns VARCHAR directly) — not `H3_LATLNG_TO_CELL` which returns NUMBER.
- Never cast H3 between NUMBER and STRING at query time — store as string from the start.

### Loading GEOGRAPHY Data
- **COPY INTO with transform**: use `ST_MAKEPOINT($col_lon, $col_lat)` or `TO_GEOGRAPHY($col_wkb)` in the SELECT.
- **INSERT via SELECT…UNION ALL**: compute `ST_MAKEPOINT(lon, lat)` inline (VALUES clauses cannot contain function calls).
- `MATCH_BY_COLUMN_NAME` cannot be used when adding computed columns — switch to explicit transform SELECT.

### Direct GEOGRAPHY Column References
All tables are created with GEOGRAPHY columns from the start. Reference them directly:
```sql
t.POINT_GEOM    -- telemetry point
t.ORIGIN        -- trip origin
t.DESTINATION   -- trip destination
```

### deck.gl Layer Selection
| Layer | Data format | Extraction |
|---|---|---|
| `ScatterplotLayer` | `[lng, lat]` array | `ST_X(geog)` / `ST_Y(geog)` in SQL |
| `H3HexagonLayer` | H3 string index | `H3_POINT_TO_CELL_STRING(geog, res)` in SQL |
| `GeoJsonLayer` | GeoJSON string | `ST_ASGEOJSON(geog)::STRING` in SQL |
| `PathLayer` | coordinate array | `ST_ASGEOJSON(geog)` → parse coords client-side |

### When FLOAT lat/lon is Acceptable
- ORS function arguments (`ARRAY_CONSTRUCT` of numeric coords for DIRECTIONS/MATRIX)
- Bounding-box configs (REGION_REGISTRY, city provisioner)
- `CLUSTER BY` expressions (GEOGRAPHY not supported in CLUSTER BY)
- Direct deck.gl `getPosition` callbacks expecting `[Number, Number]`

## Documentation

- `docs/guides/QUICKSTART.md` — End-to-end deployment quickstart
- `docs/dev/server-architecture.md` — One-page map of `ors_control_app` server modules (`server/{lib,routes,studio}/`) and decision tree for "where do I add X?"
- `docs/README.md` — Full index
