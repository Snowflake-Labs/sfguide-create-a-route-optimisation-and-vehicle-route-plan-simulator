-- semantic_views_behaviour.sql - the agent BEHAVIOUR layer: what the agents were
-- actually asked, which tools they chose, what failed, and what it cost.
--
-- WHY THIS EXISTS
-- Every existing gate proves an agent is well FORMED: check_agent_verb_coverage
-- asserts each verb is documented, check_verb_js_globals asserts it can compile,
-- validate_app_views asserts the panels return rows. Nothing measured whether the
-- agents BEHAVE well once deployed, and the gap was not theoretical:
--
--   * deep_link failed 4 times out of 4 with "URLSearchParams is not defined".
--     Every static gate passed. The agent, handed an opaque internal error, told
--     the user to escalate a repo bug to their administrator.
--   * run_sql was the single most-used verb, and several calls queried
--     VW_DWELL_SESSIONS and TRIP_DEVIATION_ANALYSIS directly - both modelled by
--     Cortex Analyst tools (query_dwell, query_route_deviation). The instruction
--     to prefer the governed path exists in BOTH the agent spec and run_sql's own
--     tool description, and lost anyway.
--   * 30 of 38 verbs had never been called at all, so a deep_link-class runtime
--     fault could sit undetected in any of them.
--
-- None of that was discoverable without hand-querying three tables, which is why
-- it went unnoticed. This file makes each of those a queryable row.
--
-- WHAT IT ADDS TO SV_FLEET_DEPLOYMENT (semantic_views_deployment.sql)
-- That view already models verb attempts, but binds ONLY the user-bundle table
-- (OPENROUTESERVICE_APP.ROUTING.VERB_ATTEMPT), so every ops and admin attempt is
-- invisible to query_deployment while recent_verb_attempts sees all three. The
-- views here union all three, and add the two grains that had no home at all:
-- the agent TURN (one row per question) and the verb INVENTORY (so a verb that
-- was never called is a row rather than an absence).
--
-- WHY THE TURN GRAIN NEEDS AN APP-SIDE TABLE
-- CORTEX_AGENT_USAGE_HISTORY records one row per turn with REQUEST_ID, duration,
-- credits and interaction_interface, but NOT the question, the answer, or the
-- tools chosen. The question text exists only in the SA app's chat route. So
-- AGENT_TURN is written there and joined to the platform row on REQUEST_ID.
--
-- Two honest limits, recorded here rather than papered over:
--   1. The exact join covers SA APP traffic only. Snowsight and CoWork turns
--      appear in the platform history with no question text, and show up in
--      VW_AGENT_TURNS as rows with a null QUESTION - which is why the interface
--      is a dimension: never compare app and non-app turns without splitting.
--   2. A verb attempt cannot be tied to its turn exactly. The proc has no handle
--      on the agent request - the agent-invoked CALL does not even appear in
--      QUERY_HISTORY - so VW_AGENT_TURN_VERBS joins on actor plus time window,
--      which is ambiguous when one actor runs concurrent turns. The view carries
--      IS_AMBIGUOUS so a consumer can exclude those rows instead of trusting them.
--
-- WHY NOT HYBRID TABLES (Tenet 5b)
-- AGENT_TURN is append-only, has no enforced constraint to defend, and is read by
-- aggregate scans that WANT the result cache. It is a standard table.
--
-- WHY SEMANTIC_OPS
-- Same reason as semantic_views_deployment.sql: role_binding.sql grants
-- FLEET_APP_USER SELECT on ALL and FUTURE semantic views in FLEET_INTELLIGENCE.
-- SEMANTIC, so anything landed there reaches every consumer. Behaviour data names
-- users and carries their questions - it stops at FLEET_APP_OPS. The existing
-- FUTURE VIEWS grants on SEMANTIC_OPS cover every view below automatically; only
-- the AGENT_TURN table needs explicit grants (role_binding.sql).
--
-- OWNER'S RIGHTS IS LOAD-BEARING
-- VW_AGENT_TURNS reads SNOWFLAKE.ACCOUNT_USAGE and VW_AGENT_VERB_INVENTORY reads
-- INFORMATION_SCHEMA, neither of which FLEET_APP_OPS can query directly. Both
-- resolve under the view owner's privileges, so the ops role needs only SELECT on
-- the view. That is deliberately narrower than granting SNOWFLAKE.USAGE_VIEWER,
-- which would expose all account usage to reach one column.
--
-- Runs in install step 5.6, after 5.5 (SV_FLEET_DEPLOYMENT creates the schema)
-- and after step 5 (bundles create the three VERB_ATTEMPT tables). Idempotent.

ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","module":"semantic_views_behaviour"}}';

CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE.SEMANTIC_OPS
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","component":"semantic-views"}}';

-- ============ AGENT_TURN ============
-- One row per agent turn, written by the SA app's /api/chat route on stream end.
-- REQUEST_ID is the platform id when the header exposes one, else NULL - the
-- writer stores its own TURN_ID unconditionally so a turn is never lost just
-- because the correlation id was unavailable.
CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.SEMANTIC_OPS.AGENT_TURN (
    TURN_ID           STRING        NOT NULL
  , REQUEST_ID        STRING
  , STARTED_AT        TIMESTAMP_TZ  NOT NULL
  , ENDED_AT          TIMESTAMP_TZ
  , AGENT_NAME        STRING
  , ACTOR             STRING
  , INTERFACE         STRING
  , QUESTION          STRING
  , ANSWER            STRING
  , TOOLS_USED        ARRAY
  , TOOL_ERRORS       ARRAY
  , ACTIVE_VIEW       STRING
  , REGION            STRING
  , VEHICLE_TYPE      STRING
  , DATASET_ID        STRING
  , FIRST_PART_MS     NUMBER
  , TOTAL_MS          NUMBER
  , OUTCOME           STRING
  , ERROR_MESSAGE     STRING
)
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"app","component":"agent-behaviour"}}';

-- ============ VW_AGENT_VERB_CALLS ============
-- All three audit tables with a BUNDLE discriminator. ARGS_JSON is KEPT here
-- (VW_AGENT_GOVERNED_BYPASS needs the submitted SQL) but is never bound as a
-- semantic-view dimension: it can carry free-text place names, and a VARIANT is
-- not something text-to-SQL should aggregate over.
CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.SEMANTIC_OPS.VW_AGENT_VERB_CALLS
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","component":"agent-behaviour"}}'
AS
SELECT 'user' AS BUNDLE, ID AS ATTEMPT_ID, AT AS ATTEMPT_TS, AT::DATE AS ATTEMPT_DATE
     , VERB, ACTOR, ACTOR_ROLE, OUTCOME, ERROR_CODE, ERROR_MESSAGE
     , (OUTCOME = 'error') AS IS_ERROR, ARGS_JSON
FROM OPENROUTESERVICE_APP.ROUTING.VERB_ATTEMPT
UNION ALL
SELECT 'ops', ID, AT, AT::DATE
     , VERB, ACTOR, ACTOR_ROLE, OUTCOME, ERROR_CODE, ERROR_MESSAGE
     , (OUTCOME = 'error'), ARGS_JSON
FROM FLEET_INTELLIGENCE.SYNAPSE_OPS.VERB_ATTEMPT
UNION ALL
SELECT 'admin', ID, AT, AT::DATE
     , VERB, ACTOR, ACTOR_ROLE, OUTCOME, ERROR_CODE, ERROR_MESSAGE
     , (OUTCOME = 'error'), ARGS_JSON
FROM FLEET_INTELLIGENCE.SYNAPSE_ADMIN.VERB_ATTEMPT;

-- ============ VERB_INVENTORY ============
-- The declared verb surface. Each synapse verb is exactly one stored procedure in
-- its bundle's schema, so the procedure list IS the inventory - measured 21/14/3 =
-- 38, matching the source tree exactly, which is why this is derived rather than
-- hand-maintained or generated into a committed file.
--
-- WHY IT IS A TABLE AND NOT A VIEW OVER INFORMATION_SCHEMA
-- INFORMATION_SCHEMA is filtered by the CURRENT ROLE's privileges, and that
-- filtering is NOT bypassed by an owner's-rights view - unlike ACCOUNT_USAGE,
-- which is. Measured: as ACCOUNTADMIN the view returned all 38 verbs; as
-- FLEET_APP_OPS it returned 35, silently dropping the ENTIRE admin bundle, because
-- the ops role has no privilege on the SYNAPSE_ADMIN procedures (correctly - that
-- is Tenet 3). The coverage report then read "35 declared verbs" as though it were
-- authoritative, which is precisely the class of silent under-reporting this whole
-- file exists to expose.
--
-- Widening the grant to fix it would breach role isolation, so the inventory is
-- captured ONCE by the installer role instead, and read by everyone from here.
-- The trade-off is that this is a SNAPSHOT: it refreshes when this file runs
-- (install step 5.6), so a bundle deployed standalone without a reinstall leaves
-- it stale. REFRESHED_AT is exposed for exactly that reason - a stale inventory
-- should be visible rather than silently wrong.
CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.SEMANTIC_OPS.VERB_INVENTORY (
    BUNDLE       STRING NOT NULL
  , VERB         STRING NOT NULL
  , REFRESHED_AT TIMESTAMP_TZ NOT NULL
)
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","component":"agent-behaviour"}}';

-- INSERT OVERWRITE, so a re-run replaces the snapshot rather than duplicating it
-- and rather than dropping the table (which would lose the grants below).
INSERT OVERWRITE INTO FLEET_INTELLIGENCE.SEMANTIC_OPS.VERB_INVENTORY (BUNDLE, VERB, REFRESHED_AT)
SELECT DISTINCT 'user', LOWER(PROCEDURE_NAME), CURRENT_TIMESTAMP()
FROM OPENROUTESERVICE_APP.INFORMATION_SCHEMA.PROCEDURES
WHERE PROCEDURE_SCHEMA = 'ROUTING'
UNION
SELECT DISTINCT 'ops', LOWER(PROCEDURE_NAME), CURRENT_TIMESTAMP()
FROM FLEET_INTELLIGENCE.INFORMATION_SCHEMA.PROCEDURES
WHERE PROCEDURE_SCHEMA = 'SYNAPSE_OPS'
UNION
SELECT DISTINCT 'admin', LOWER(PROCEDURE_NAME), CURRENT_TIMESTAMP()
FROM FLEET_INTELLIGENCE.INFORMATION_SCHEMA.PROCEDURES
WHERE PROCEDURE_SCHEMA = 'SYNAPSE_ADMIN';

-- ============ VW_AGENT_VERB_INVENTORY ============
-- Stable name for consumers, reading the snapshot above.
--
-- DISTINCT is still applied: a verb whose optional trailing args produce more than
-- one signature would otherwise be counted twice and its call stats duplicated.
CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.SEMANTIC_OPS.VW_AGENT_VERB_INVENTORY
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","component":"agent-behaviour"}}'
AS
SELECT DISTINCT BUNDLE, VERB, REFRESHED_AT
FROM FLEET_INTELLIGENCE.SEMANTIC_OPS.VERB_INVENTORY;

-- ============ VW_AGENT_VERB_COVERAGE ============
-- Inventory LEFT JOIN calls, so a never-called verb is a row with CALLS = 0
-- instead of an absence you have to notice. WAS_CALLED is the column the report
-- counts; ONLY_EVER_FAILED is the deep_link signature - called, never once
-- succeeded - and is the shape that most deserves a human look.
CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.SEMANTIC_OPS.VW_AGENT_VERB_COVERAGE
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","component":"agent-behaviour"}}'
AS
SELECT
    i.BUNDLE                                            AS BUNDLE
  , i.VERB                                              AS VERB
  , COUNT(c.ATTEMPT_ID)                                 AS CALLS
  , COUNT_IF(c.OUTCOME = 'ok')                          AS CALLS_OK
  , COUNT_IF(c.OUTCOME = 'error')                       AS CALLS_ERROR
  , DIV0(COUNT_IF(c.OUTCOME = 'error'), COUNT(c.ATTEMPT_ID)) * 100 AS ERROR_RATE_PCT
  , MIN(c.ATTEMPT_TS)                                   AS FIRST_CALL_AT
  , MAX(c.ATTEMPT_TS)                                   AS LAST_CALL_AT
  , COUNT(c.ATTEMPT_ID) > 0                             AS WAS_CALLED
  , (COUNT(c.ATTEMPT_ID) > 0 AND COUNT_IF(c.OUTCOME = 'ok') = 0) AS ONLY_EVER_FAILED
FROM FLEET_INTELLIGENCE.SEMANTIC_OPS.VW_AGENT_VERB_INVENTORY i
LEFT JOIN FLEET_INTELLIGENCE.SEMANTIC_OPS.VW_AGENT_VERB_CALLS c
       ON c.BUNDLE = i.BUNDLE
      AND LOWER(c.VERB) = i.VERB
GROUP BY i.BUNDLE, i.VERB;

-- ============ VW_AGENT_GOVERNED_SURFACE ============
-- Which physical objects a Cortex Analyst tool already models, derived from
-- INFORMATION_SCHEMA.SEMANTIC_TABLES - the semantic views' own declared base
-- tables, so this cannot drift from the semantic layer.
--
-- Note ACCOUNT_USAGE.OBJECT_DEPENDENCIES does NOT work for this: it records
-- dependencies for VIEW objects but emits no rows for a SEMANTIC VIEW, so the
-- mapping is invisible there. SEMANTIC_TABLES is the only reliable source.
--
-- Scoped to FLEET_INTELLIGENCE.SEMANTIC (the consumer-facing views the query_*
-- tools bind to). SEMANTIC_OPS is excluded on purpose - it is ops-only, so a
-- run_sql against its base tables is not a bypass of a consumer tool.
CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.SEMANTIC_OPS.VW_AGENT_GOVERNED_SURFACE
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","component":"agent-behaviour"}}'
AS
SELECT DISTINCT
    SEMANTIC_VIEW_NAME                                                        AS SEMANTIC_VIEW
  , BASE_TABLE_CATALOG                                                        AS OBJECT_CATALOG
  , BASE_TABLE_SCHEMA                                                         AS OBJECT_SCHEMA
  , BASE_TABLE_NAME                                                           AS OBJECT_NAME
  , UPPER(BASE_TABLE_CATALOG || '.' || BASE_TABLE_SCHEMA || '.' || BASE_TABLE_NAME) AS FQN
  , UPPER(BASE_TABLE_SCHEMA || '.' || BASE_TABLE_NAME)                        AS SCHEMA_QUALIFIED
FROM FLEET_INTELLIGENCE.INFORMATION_SCHEMA.SEMANTIC_TABLES
WHERE SEMANTIC_VIEW_SCHEMA = 'SEMANTIC';

-- ============ VW_AGENT_GOVERNED_BYPASS ============
-- run_sql calls whose SQL targets an object a query_* tool already models. This
-- is the metric the in-band run_sql nudge is judged against - prose guidance for
-- the same thing already exists twice and did not change behaviour, so the fix
-- has to be measured rather than asserted.
--
-- Matched on the fully qualified name OR the schema-qualified form, because the
-- agent writes both (FLEET_APP.DWELL.VW_DWELL_SESSIONS and, after a USE, the
-- shorter form). This is deliberately a containment test on the submitted text:
-- a false positive is an object named in a comment, which is cheap, whereas
-- missing a real bypass defeats the purpose.
CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.SEMANTIC_OPS.VW_AGENT_GOVERNED_BYPASS
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","component":"agent-behaviour"}}'
AS
SELECT
    c.ATTEMPT_ID    AS ATTEMPT_ID
  , c.ATTEMPT_TS    AS ATTEMPT_TS
  , c.ATTEMPT_DATE  AS ATTEMPT_DATE
  , c.ACTOR         AS ACTOR
  , c.OUTCOME       AS OUTCOME
  , g.SEMANTIC_VIEW AS SEMANTIC_VIEW
  , g.FQN           AS GOVERNED_OBJECT
  , LEFT(c.ARGS_JSON:sql::STRING, 400) AS SUBMITTED_SQL
FROM FLEET_INTELLIGENCE.SEMANTIC_OPS.VW_AGENT_VERB_CALLS c
JOIN FLEET_INTELLIGENCE.SEMANTIC_OPS.VW_AGENT_GOVERNED_SURFACE g
  ON POSITION(g.FQN IN UPPER(c.ARGS_JSON:sql::STRING)) > 0
  OR POSITION(g.SCHEMA_QUALIFIED IN UPPER(c.ARGS_JSON:sql::STRING)) > 0
WHERE LOWER(c.VERB) = 'run_sql'
  AND c.ARGS_JSON:sql IS NOT NULL;

-- ============ VW_AGENT_TURNS ============
-- One row per agent turn. The platform history is the LEFT side so a Snowsight or
-- CoWork turn is still counted (with a null QUESTION) rather than dropped by an
-- inner join to app-only rows.
--
-- METADATA.interaction_interface is what separates the surfaces. MEASURED values on
-- a live account, not assumed: 'eval' (evaluation runs), 'agent_admin_ui'
-- (Snowsight), 'external' (SA app and REST callers), 'sql_function'
-- (AI_COMPLETE-style calls). Never report a single latency or cost number across
-- them.
--
-- Evaluation traffic DOMINATES: 404 of 451 turns on tib85385 were 'eval'. So an
-- unsplit "average agent latency" is really the average of an eval harness, and a
-- credit total is mostly the cost of testing rather than of use.
CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.SEMANTIC_OPS.VW_AGENT_TURNS
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","component":"agent-behaviour"}}'
AS
SELECT
    h.REQUEST_ID                                          AS REQUEST_ID
  , h.START_TIME                                          AS STARTED_AT
  , h.START_TIME::DATE                                    AS TURN_DATE
  , h.AGENT_NAME                                          AS AGENT_NAME
  , h.USER_NAME                                           AS ACTOR
  , h.METADATA:interaction_interface::STRING              AS INTERACTION_INTERFACE
  , h.METADATA:role_name::STRING                          AS ACTOR_ROLE
  , DATEDIFF('millisecond', h.START_TIME, h.END_TIME)     AS TOTAL_MS
  , h.TOKENS                                              AS TOKENS
  , h.TOKEN_CREDITS                                       AS TOKEN_CREDITS
  , t.TURN_ID                                             AS TURN_ID
  , t.QUESTION                                            AS QUESTION
  , t.ANSWER                                              AS ANSWER
  , t.TOOLS_USED                                          AS TOOLS_USED
  , t.TOOL_ERRORS                                         AS TOOL_ERRORS
  , ARRAY_SIZE(COALESCE(t.TOOLS_USED, ARRAY_CONSTRUCT())) AS TOOL_COUNT
  , t.ACTIVE_VIEW                                         AS ACTIVE_VIEW
  , t.REGION                                              AS REGION
  , t.VEHICLE_TYPE                                        AS VEHICLE_TYPE
  , t.FIRST_PART_MS                                       AS FIRST_PART_MS
  , t.OUTCOME                                             AS TURN_OUTCOME
  , t.ERROR_MESSAGE                                       AS TURN_ERROR_MESSAGE
  , (t.TURN_ID IS NOT NULL)                               AS HAS_APP_DETAIL
FROM SNOWFLAKE.ACCOUNT_USAGE.CORTEX_AGENT_USAGE_HISTORY h
LEFT JOIN FLEET_INTELLIGENCE.SEMANTIC_OPS.AGENT_TURN t
       ON t.REQUEST_ID = h.REQUEST_ID;

-- ============ VW_AGENT_TURN_VERBS ============
-- The best available turn-to-verb link. There is no exact one: the proc cannot
-- see the agent request, so this joins on actor plus the turn's own time window.
--
-- IS_AMBIGUOUS is the load-bearing column. When the same actor has overlapping
-- turns, a verb attempt falls inside more than one window and the attribution is
-- a guess - so it is FLAGGED rather than silently picked. Filter it out before
-- drawing any conclusion about which question caused which call.
CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.SEMANTIC_OPS.VW_AGENT_TURN_VERBS
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","component":"agent-behaviour"}}'
AS
WITH matched AS (
  SELECT
      h.REQUEST_ID
    , h.AGENT_NAME
    , h.START_TIME
    , c.ATTEMPT_ID
    , c.VERB
    , c.BUNDLE
    , c.OUTCOME
    , COUNT(*) OVER (PARTITION BY c.ATTEMPT_ID) AS WINDOW_MATCHES
  FROM SNOWFLAKE.ACCOUNT_USAGE.CORTEX_AGENT_USAGE_HISTORY h
  JOIN FLEET_INTELLIGENCE.SEMANTIC_OPS.VW_AGENT_VERB_CALLS c
    ON UPPER(c.ACTOR) = UPPER(h.USER_NAME)
   AND c.ATTEMPT_TS BETWEEN h.START_TIME AND h.END_TIME
)
SELECT
    REQUEST_ID
  , AGENT_NAME
  , START_TIME       AS TURN_STARTED_AT
  , ATTEMPT_ID
  , VERB
  , BUNDLE
  , OUTCOME
  , (WINDOW_MATCHES > 1) AS IS_AMBIGUOUS
FROM matched;

-- ============ SV_AGENT_BEHAVIOUR ============
-- Cortex Analyst surface over the two behaviour grains, so an operator can ask
-- "which verbs are failing this week" or "what did the agent cost per turn by
-- interface" in natural language.
--
-- Two grains, deliberately UNRELATED: there is no reliable key between a turn and
-- a verb attempt (see VW_AGENT_TURN_VERBS), so declaring a relationship would
-- invite text-to-SQL to fabricate joins. The ambiguity-flagged bridge stays a
-- plain view for deliberate use.
CREATE OR REPLACE SEMANTIC VIEW FLEET_INTELLIGENCE.SEMANTIC_OPS.SV_AGENT_BEHAVIOUR

  TABLES (
    turns AS FLEET_INTELLIGENCE.SEMANTIC_OPS.VW_AGENT_TURNS
      PRIMARY KEY (REQUEST_ID)
      COMMENT = 'Agent turn fact, one row per question answered.'
    , verb_calls AS FLEET_INTELLIGENCE.SEMANTIC_OPS.VW_AGENT_VERB_CALLS
      PRIMARY KEY (ATTEMPT_ID)
      COMMENT = 'Audited verb attempt fact across all three role bundles.'
    , verb_coverage AS FLEET_INTELLIGENCE.SEMANTIC_OPS.VW_AGENT_VERB_COVERAGE
      PRIMARY KEY (BUNDLE, VERB)
      COMMENT = 'One row per DECLARED verb, including verbs never called.'
  )

  FACTS (
    turns.total_ms AS TOTAL_MS
      COMMENT = 'Wall-clock duration of the turn in milliseconds'
    , turns.first_part_ms AS FIRST_PART_MS
      COMMENT = 'Milliseconds until the first streamed part reached the user (app turns only)'
    , turns.tokens AS TOKENS
      COMMENT = 'Total tokens consumed by the turn'
    , turns.token_credits AS TOKEN_CREDITS
      COMMENT = 'Snowflake credits consumed by the turn'
    , turns.tool_count AS TOOL_COUNT
      COMMENT = 'How many tools the agent invoked in the turn (app turns only)'
    , verb_coverage.calls AS CALLS
      COMMENT = 'Times this verb was called'
    , verb_coverage.calls_error AS CALLS_ERROR
      COMMENT = 'Times this verb errored'
  )

  DIMENSIONS (
    turns.turn_date AS TURN_DATE
      WITH SYNONYMS ('day', 'date')
      COMMENT = 'Calendar date of the turn'
    , turns.agent_name AS AGENT_NAME
      WITH SYNONYMS ('agent', 'which agent')
      COMMENT = 'Agent that answered (FLEET_AGENT, FLEET_OPS_AGENT, FLEET_ADMIN_AGENT, FLEET_SUPER_AGENT)'
    , turns.actor AS ACTOR
      WITH SYNONYMS ('user', 'who asked')
      COMMENT = 'User that asked the question'
    , turns.interaction_interface AS INTERACTION_INTERFACE
      WITH SYNONYMS ('surface', 'channel', 'where')
      COMMENT = 'Where the turn came from. Measured values: eval (evaluation runs), agent_admin_ui (Snowsight), external (SA app / REST), sql_function. Always split cost and latency by this - evaluation traffic dominates the row count.'
    , turns.question AS QUESTION
      COMMENT = 'The user question. Populated for SA app turns only; NULL for Snowsight and CoWork.'
    , turns.active_view AS ACTIVE_VIEW
      COMMENT = 'Which app view was on screen when the question was asked'
    , turns.region AS REGION
      WITH SYNONYMS ('city', 'area')
      COMMENT = 'Region selected in the app when the question was asked'
    , turns.vehicle_type AS VEHICLE_TYPE
      COMMENT = 'Vehicle type selected in the app when the question was asked'
    , turns.turn_outcome AS TURN_OUTCOME
      COMMENT = 'Whether the turn completed or errored (app turns only)'
    , turns.has_app_detail AS HAS_APP_DETAIL
      COMMENT = 'Whether app-side detail (question, answer, tools) exists for this turn'
    , verb_calls.attempt_date AS ATTEMPT_DATE
      WITH SYNONYMS ('day', 'date')
      COMMENT = 'Calendar date of the verb attempt'
    , verb_calls.verb AS VERB
      WITH SYNONYMS ('tool', 'action')
      COMMENT = 'Verb that was attempted'
    , verb_calls.bundle AS BUNDLE
      WITH SYNONYMS ('role bundle', 'mcp server')
      COMMENT = 'Which role bundle owns the verb: user, ops or admin'
    , verb_calls.verb_actor AS ACTOR
      COMMENT = 'User that invoked the verb'
    , verb_calls.verb_actor_role AS ACTOR_ROLE
      COMMENT = 'Snowflake role the verb ran under'
    , verb_calls.outcome AS OUTCOME
      COMMENT = 'ok, error or idempotent_replay'
    , verb_calls.error_code AS ERROR_CODE
      COMMENT = 'Structured error code when the attempt failed'
    , verb_calls.is_error AS IS_ERROR
      COMMENT = 'Whether the attempt failed'
    , verb_coverage.coverage_verb AS VERB
      COMMENT = 'Declared verb name'
    , verb_coverage.coverage_bundle AS BUNDLE
      COMMENT = 'Bundle the declared verb belongs to'
    , verb_coverage.was_called AS WAS_CALLED
      WITH SYNONYMS ('used', 'ever called')
      COMMENT = 'Whether this verb has ever been called. FALSE means declared but unexercised.'
    , verb_coverage.only_ever_failed AS ONLY_EVER_FAILED
      COMMENT = 'Called at least once and never succeeded. The strongest signal of a broken verb.'
    , verb_coverage.last_call_at AS LAST_CALL_AT
      COMMENT = 'Most recent call to this verb'
  )

  METRICS (
    turns.total_turns AS COUNT(*)
      WITH SYNONYMS ('number of questions', 'conversations', 'turn count')
      COMMENT = 'Count of agent turns'
    , turns.avg_turn_ms AS AVG(total_ms)
      WITH SYNONYMS ('average response time')
      COMMENT = 'Average turn duration in milliseconds'
    , turns.p95_turn_ms AS APPROX_PERCENTILE(total_ms, 0.95)
      COMMENT = 'p95 turn duration in milliseconds'
    , turns.total_credits AS SUM(token_credits)
      WITH SYNONYMS ('cost', 'spend')
      COMMENT = 'Total credits consumed by agent turns'
    , turns.avg_credits_per_turn AS AVG(token_credits)
      COMMENT = 'Average credits per turn'
    , turns.avg_tools_per_turn AS AVG(tool_count)
      COMMENT = 'Average number of tools invoked per turn (app turns only)'
    , verb_calls.total_attempts AS COUNT(*)
      WITH SYNONYMS ('verb calls', 'tool calls')
      COMMENT = 'Count of audited verb attempts'
    , verb_calls.failed_attempts AS COUNT_IF(OUTCOME = 'error')
      COMMENT = 'Count of verb attempts that errored'
    , verb_calls.attempt_error_rate_pct AS DIV0(COUNT_IF(OUTCOME = 'error'), COUNT(*)) * 100
      COMMENT = 'Percent of verb attempts that errored'
    , verb_coverage.declared_verbs AS COUNT(*)
      COMMENT = 'Count of declared verbs'
    , verb_coverage.unused_verbs AS COUNT_IF(NOT WAS_CALLED)
      WITH SYNONYMS ('never called', 'unexercised verbs')
      COMMENT = 'Count of declared verbs never once called'
    , verb_coverage.broken_verbs AS COUNT_IF(ONLY_EVER_FAILED)
      COMMENT = 'Count of verbs that were called and never succeeded'
  )

  COMMENT = 'Agent BEHAVIOUR: what the agents were asked, which verbs they chose, what failed, how long turns took and what they cost. Complements SV_FLEET_DEPLOYMENT (which models the deployment and routing history) by modelling the agents themselves.'

  AI_SQL_GENERATION 'Behaviour semantic view for the four Cortex Agents in this deployment (FLEET_AGENT, FLEET_OPS_AGENT, FLEET_ADMIN_AGENT, FLEET_SUPER_AGENT). It answers questions about how the AGENTS are performing, not about the fleet.

Entities:
- turns: FACT, one row per agent turn (question answered). Carries duration, tokens, credits, the interface it came from, and - for SA app turns only - the question text, the answer, and which tools were used.
- verb_calls: FACT, one row per audited MCP verb attempt across all three role bundles (user, ops, admin). Use it for "which tools are being used" and "what is failing".
- verb_coverage: one row per DECLARED verb, including verbs that have never been called. Use it for "which tools has nobody used" and "which tools are broken".

Conventions:
- turns and verb_calls have NO reliable join key: a verb attempt cannot be tied to the turn that caused it, because the stored procedure cannot see the agent request. NEVER join these two entities. Answer questions about each separately.
- ALWAYS split cost and latency by interaction_interface. Measured values are "eval" (evaluation runs), "agent_admin_ui" (Snowsight), "external" (the SA app and REST callers) and "sql_function". Evaluation traffic DOMINATES the row count - 404 of 451 turns on the reference account - so a blended average is mostly the cost and latency of the test harness, not of real use. When a user asks about "our agent usage" they almost never mean eval runs; exclude that interface unless they say otherwise, and say that you did.
- question and answer are NULL for turns that did not come through the SA app (Snowsight, CoWork). Filter on has_app_detail = TRUE before analysing question text, or the counts will silently under-report.
- Durations are MILLISECONDS. Credits are Snowflake credits.
- was_called = FALSE means a verb is declared and documented but has never been exercised - that is a testing gap, not necessarily a bug. only_ever_failed = TRUE is the stronger signal: the verb was called and never once succeeded.
- Scope time questions against turns.turn_date or verb_calls.attempt_date.'
;

-- Grants. The FUTURE VIEWS / FUTURE SEMANTIC VIEWS grants in role_binding.sql
-- already cover every view and the semantic view above; AGENT_TURN is a TABLE and
-- so needs its own. SELECT for reading, INSERT for the SA app writer.
GRANT SELECT ON TABLE FLEET_INTELLIGENCE.SEMANTIC_OPS.AGENT_TURN TO ROLE FLEET_APP_OPS;
GRANT SELECT ON TABLE FLEET_INTELLIGENCE.SEMANTIC_OPS.AGENT_TURN TO ROLE FLEET_APP_ADMIN;
GRANT SELECT ON TABLE FLEET_INTELLIGENCE.SEMANTIC_OPS.VERB_INVENTORY TO ROLE FLEET_APP_OPS;
GRANT SELECT ON TABLE FLEET_INTELLIGENCE.SEMANTIC_OPS.VERB_INVENTORY TO ROLE FLEET_APP_ADMIN;
GRANT INSERT ON TABLE FLEET_INTELLIGENCE.SEMANTIC_OPS.AGENT_TURN TO ROLE FLEET_APP_USER;
-- USAGE on the schema is what lets the consumer role reach the table to INSERT.
-- It does NOT expose the behaviour views: those need SELECT, which FLEET_APP_USER
-- is never granted here (role_binding.sql keeps SEMANTIC_OPS reads at OPS+).
GRANT USAGE ON SCHEMA FLEET_INTELLIGENCE.SEMANTIC_OPS TO ROLE FLEET_APP_USER;
