# Upstream synapse `apps/` pattern survey

Findings from reading the active apps in `snowflake-eng/synapse` (survey only - no
code was copied from those apps). They are peers of `fleet_tools`, not dependencies:
they solve unrelated domains (meetings, tasks, Slack digests) and are consumers of
the same framework we vendor. Only `packages/synapse` is vendored; everything below
is a lesson reimplemented in files we own.

## Why the survey was scoped this way

| Upstream path | Last commit | Relationship to us |
|---|---|---|
| `packages/synapse` (sole workspace package) | 2026-07-14 | vendored into `fleet_tools/vendor/synapse` |
| `apps/*` (14 apps) | 2026-08-28 | pattern source only |
| `deploy/slack-app` | 2026-08-17 | out of scope |
| `cmd/` | 2026-06-04 | out of scope |

The repo is very active, but the framework package is not: 100+ commits since
2026-07-15 all land in `apps/` or `deploy/`. So the *vendored code* delta is closed
and small (4 commits), while the *pattern* delta is large and lives in `apps/`.

Sources read: `apps/APP_RUNTIME_LEARNINGS.md`, `apps/mtg-intelligence`
(`synapse.config.ts`, `src/catalog.ts`, `src/errors.ts`, layout),
`apps/snowtasks/{PROJECT.md,DECISIONS.md,v1/}`.

Caveat on transferability: `APP_RUNTIME_LEARNINGS.md` documents **Snowflake App
Runtime** apps deployed via `snow app deploy`, using a long-lived `snowflake-sdk`
owner connection. Our fleet apps are **plain SPCS services** deployed via
docker push + `ALTER SERVICE`, and talk to Snowflake over the **SQL REST API**
(`/api/v2/statements`, [fleet_sa_app/ui/src/lib/snowflake.ts](../fleet_sa_app/ui/src/lib/snowflake.ts)).
Each learning below is therefore marked applicable or not, with evidence, so it is
not re-litigated later.

## (a) SPCS / runtime findings applicable to our apps

### a1. Hardcoded `MY_WH` is a fresh-install blocker - APPLICABLE, highest priority

Upstream learning 1 ("don't use the default `APP_WAREHOUSE`, it's shared and
overloaded") has a sharper local form: we do not merely ride a shared warehouse, we
ride one **the installer never creates**.

`MY_WH` is hardcoded in three places:

- [fleet_sa_app/fleet_sa_app_service.yaml](../fleet_sa_app/fleet_sa_app_service.yaml) - `SNOWFLAKE_WAREHOUSE: "MY_WH"`
- [fleet_admin_app/fleet_admin_app_service.yaml](../fleet_admin_app/fleet_admin_app_service.yaml) - `SNOWFLAKE_WAREHOUSE: "MY_WH"`
- [scripts/install_synapse_bundles.sh](../scripts/install_synapse_bundles.sh) - `"warehouse": "MY_WH"` in the generated `install.json`

Verified on the current account:

| Warehouse | Size | Created | COMMENT tag | Created by installer? |
|---|---|---|---|---|
| `MY_WH` | **Large** | 2023-11-15 | **none** | **no** |
| `ROUTING_ANALYTICS` | X-Small | 2026-06-01 | yes | yes (`provision_engine.sh`, `seed_data.sql`, `analytic_layer.sql`) |

So `MY_WH` is a pre-existing, untagged, account-specific Large warehouse that
predates this project by two years. On a clean account it does not exist, and every
SA/admin app query plus every synapse `install.sql` fails with a warehouse error -
and it violates the AGENTS.md tracking-tag requirement because nothing we own
created or tagged it. Size is the lesser issue: the app's queries are point lookups
and small aggregates, so Large buys nothing.

**Fix:** point all three at `ROUTING_ANALYTICS`, which the installer already creates
with a tracking COMMENT. Size is the lesser issue: the app's queries are point lookups
and small aggregates, so Large buys nothing.

**STATUS: FIXED.** All three sites now use `ROUTING_ANALYTICS`. Because the engine,
seed, and analytic scripts that create that warehouse can each be skipped
(`--no-engine`, seed already present), the warehouse is also ensured idempotently -
with its tracking COMMENT - in both app deploy scripts and in
`install_synapse_bundles.sh`, so no ordering assumption is required. This closes
upstream learning 3b as well: an app whose spec names a warehouse that does not exist
deploys "successfully" and then fails every query at runtime.

### a2. Long-lived-connection keepalive and reconnect - NOT APPLICABLE

Upstream learning 2 (idle SPCS service wedges forever because a singleton
`snowflake-sdk` owner connection is GC'd or its OAuth token rotates; needs
`clientSessionKeepAlive` plus a reconnect-once guard) does not transfer. Our apps
hold no persistent session: `callSnowflake()` re-reads auth via `getSnowflakeAuth()`
on **every** request and every poll, and issues a stateless HTTPS call to
`/api/v2/statements`. There is no memoized connection to invalidate, and token
rotation is picked up on the next call by construction. Recorded so nobody adds a
keepalive to a REST client.

### a3. Endpoint (ingress) `USAGE` grant is missing entirely - APPLICABLE

Upstream learning 3c: opening the app in a browser requires the caller's role to
hold `USAGE` **on the service object itself**, separate from data grants; and the
grant must be **re-applied on every deploy** because a teardown/recreate silently
drops it, locking out everyone but the owner.

We have neither half. `GRANT USAGE ON SERVICE` appears nowhere in `scripts/*.sh` or
`references/*.sql`, and neither [scripts/deploy_fleet_sa_app.sh](../scripts/deploy_fleet_sa_app.sh)
nor `deploy_fleet_admin_app.sh` contains any `GRANT`. The apps are therefore
openable only by the deploying (owner) role. This is latent rather than visibly
broken because the accelerator is normally driven by ACCOUNTADMIN.

**Fix:** grant service + schema `USAGE` to the fleet app roles at install time, and
re-apply it in both deploy scripts after the `ALTER SERVICE`, so a service recreate
cannot lock non-owner roles out. Granting `USAGE` to a role does not require owning
that role, so no extra privilege is needed.

**STATUS: FIXED.** Both deploy scripts now grant database + schema + service `USAGE`
after the `ALTER SERVICE ... RESUME`, on every deploy. The SA app grants to
`FLEET_APP_USER`/`OPS`/`ADMIN`; the admin console deliberately grants only to
`OPS`/`ADMIN`. Non-fatal per role: a standalone deploy on an account that has not run
the installer yet warns instead of failing, since the roles may not exist.

### a4. Per-request `SHOW GRANTS TO USER` with no cache - APPLICABLE, low priority

Upstream learning 4 advises caching identity/roster lookups because every Snowflake
round trip is expensive. [fleet_sa_app/ui/src/lib/ingress-identity.ts](../fleet_sa_app/ui/src/lib/ingress-identity.ts)
runs `SHOW GRANTS TO USER "<user>"` on every gated action with no memoization.

Good news on the adjacent trap: we resolve identity from the
`Sf-Context-Current-User` **header** rather than opening a caller's-rights session,
so we never call `CURRENT_AVAILABLE_ROLES()` (which upstream reports **hangs** on a
caller session) and we are not exposed to the ~2-minute caller-JWT rotation.

**Fix (optional):** short-TTL cache keyed on the ingress user. Cheap, but it is an
authorization cache, so the TTL must be short and it should be recorded as a
deliberate staleness window.

**STATUS: NOT DONE**, deliberately. It is a latency optimization on an authorization
path, and caching an authorization decision is exactly the kind of change that wants
its own review rather than riding along in a framework upgrade. Left as a documented
candidate.

## (b) Verb / audit conventions for the 26 fleet verbs

### b1. Layer app error codes on the framework set by spreading
`apps/mtg-intelligence/src/errors.ts` does:

```ts
import { Codes as FrameworkCodes } from '@snowflake/synapse';
export const Codes = { ...FrameworkCodes, SESSION_NOT_FOUND: 'SESSION_NOT_FOUND', /* ... */ } as const;
export type Code = keyof typeof Codes;
```

so every verb can `ctx.fail` with either a canonical framework code
(`BAD_VALUE_TYPE`, `WRONG_STATE_FOR_VERB`, `INSUFFICIENT_ROLE`, `NOT_FOUND`,
`UNKNOWN`) or an app code, from one union. Our `user/src/codes.ts` has 6 codes; ops
and admin have **zero**, which is why their mutation verbs currently fail untyped.
Feeds the `validate`-hook work.

**STATUS: already in place.** 7 verbs carry `validate` hooks, including the mutation
verbs this was aimed at (`set_active_region` in both ops and admin,
`set_active_context`). The remaining gap is that ops and admin still declare no
app-specific codes of their own, so their failures fall back to framework codes.

### b2. Wire the audit config through the catalog, not a literal

`apps/mtg-intelligence/synapse.config.ts`:

```ts
import { Tables, AppIdColumn } from './src/catalog.js';
export default defineSynapseApp({ name: 'mtg-intelligence', audit: { table: Tables.verbAttempt, appIdField: AppIdColumn } });
```

The audit table name comes from the same `defineCatalog` map as everything else, so
the FQN is substituted at bundle time instead of being repeated as a string. This is
the direct template for our `defineCatalog` adoption, and it shows the intended
coupling: catalog first, then config referencing it.

**STATUS: solved one layer down instead.** Copying this shape literally would not have
worked: `synapse.config.ts` is evaluated by the CLI **outside a bundle**, where
`defineCatalog` returns bare names by design, so upstream's audit table is bare too.
The qualification now happens in the bundler, which does know the install target - see
the audit-FQN patch in
[`../fleet_tools/vendor/synapse/VENDOR.md`](../fleet_tools/vendor/synapse/VENDOR.md).
Our verbs' other references stay explicit because they point at objects in other
databases, which `defineCatalog` cannot qualify; that reasoning is recorded in
`fleet_tools/user/src/catalog.ts`.

### b3. Record rejected approaches next to decisions

`apps/snowtasks/DECISIONS.md` keeps a "Rejected approaches" section (with the reason
each was rejected) and "Arbitration rules" beside the accepted design. Cheap habit
that prevents re-proposing a known-bad option. Optional for us; noted, not adopted.

## (c) Explicitly out of scope

- App domain logic (meetings, tasks, org chart, procurement, surveys) - unrelated verticals.
- `web/` surfaces and `skills/` directories of upstream apps - our SA app owns its own UI and the repo owns its own skills.
- Claude-plugin publishing / `.claude-plugin` registries and `apps/synapse-base`'s install registry - a different distribution model from the SA app.
- `deploy/slack-app` - unrelated product.
- Copying any upstream app directory into this repo. If something framework-shaped turns up inside an app, reimplement it in `fleet_tools` and flag it as an upstream candidate rather than vendoring an app.
