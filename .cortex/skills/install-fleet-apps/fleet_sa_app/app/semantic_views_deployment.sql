-- semantic_views_deployment.sql - Cortex Analyst semantic view for the OPS and
-- ADMIN agents (and, by inheritance, FLEET_SUPER_AGENT).
--
-- WHY THIS EXISTS
-- FLEET_OPS_AGENT and FLEET_ADMIN_AGENT were MCP-only: every capability they had
-- was an action verb. That left two gaps. (1) Snowsight's agent setup checklist
-- flagged "Connect a semantic view" as undone, because no tool of theirs was a
-- cortex_analyst_text_to_sql tool. (2) More importantly, an operator could ask
-- "is San Francisco running?" (a verb answers that) but NOT "how many routing
-- calls did we make per region last week, and where did they fail?" - an
-- aggregate over history that no verb can answer and that nothing else modeled.
--
-- WHAT IT MODELS
-- Deployment + routing HISTORY, not live state. Live state stays behind the
-- ops verbs and the shared FLEET_INTELLIGENCE.SEMANTIC.DESCRIBE_DEPLOYMENT proc
-- (deployment_facts.sql), which is deliberately a SHOW SERVICES read rather than
-- an HTTP probe. This semantic view NEVER touches a service.
--
-- TENET 3 (role-scoped isolation) IS PRESERVED
-- This is a read-only view over audit/telemetry tables. Suspend / resume / drop
-- remain Ops-only ACTION verbs. The isolation boundary is the GRANT: the SV and
-- its base views are granted to FLEET_APP_OPS (inherited by FLEET_APP_ADMIN) and
-- never to FLEET_APP_USER (role_binding.sql).
--
-- WHY A SEPARATE SCHEMA (SEMANTIC_OPS, not SEMANTIC)
-- role_binding.sql grants FLEET_APP_USER SELECT on ALL *and FUTURE* semantic
-- views in FLEET_INTELLIGENCE.SEMANTIC, so anything landed there is exposed to
-- every consumer automatically. Putting this view in its own schema makes the
-- boundary explicit rather than relying on the consumer lacking base-table
-- SELECT, which would leave a granted-but-broken tool in the consumer's reach.
--
-- GRAIN MODEL (one parent dimension + three independent facts)
--   regions       - DIMENSION, one row per provisioned region (REGION_ORS_MAP
--                   enriched from REGION_CATALOG). Parent of requests and jobs.
--   requests      - FACT, one row per gateway routing call (ORS_REQUEST_LOG).
--   jobs          - FACT, one row per build job (region provisioning + travel
--                   matrix builds, unioned with a JOB_KIND discriminator).
--   verb_attempts - FACT, one row per synapse envelope attempt (VERB_ATTEMPT).
--                   No region column upstream, so it does NOT join to regions.
--
-- Region join key: ORS_REQUEST_LOG.REGION is nullable (the keep-warm reconciler
-- already derives region from ORS_HOST for exactly this reason), so the base
-- view derives REGION_KEY from the host name and normalizes to upper case on
-- both sides of the relationship.
--
-- Runs in install step 4.95, BEFORE step 5/6 (bundles + agents bind to this SV).
-- Self-contained: it creates its own schema and depends only on the ORS control
-- app tables, which exist from step 1. Idempotent.

ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","module":"semantic_views_deployment"}}';

CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE.SEMANTIC_OPS
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","component":"semantic-views"}}';

-- ============ Base views ============
-- Thin, GEOGRAPHY-free projections. The semantic view binds to these rather than
-- to the physical tables so each grain (and its primary key) is explicit and so
-- the multi-DB reads live in one auditable place.

-- regions: one row per provisioned region. REGION_CATALOG holds ~5k candidate
-- regions, so the enrichment is de-duplicated to exactly one catalog row per
-- provisioned region (a fan-out here would multiply every joined fact).
CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.SEMANTIC_OPS.VW_DEPLOY_REGIONS
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","component":"semantic-views"}}'
AS
WITH cat AS (
  SELECT
      UPPER(COALESCE(REGION_KEY, LOOKUP_NAME))       AS JOIN_KEY
    , REGION_NAME
    , CONTINENT
    , COUNTRY
    , ISO_COUNTRY_A2
    , LEVEL
    , PBF_SIZE_MB
    , BOUNDARY_AREA_KM2
    , ROW_NUMBER() OVER (
        PARTITION BY UPPER(COALESCE(REGION_KEY, LOOKUP_NAME))
        ORDER BY BOUNDARY_AREA_KM2 DESC NULLS LAST, UPDATED_AT DESC NULLS LAST
      ) AS RN
  FROM OPENROUTESERVICE_APP.CORE.REGION_CATALOG
)
SELECT
    UPPER(m.REGION)                       AS REGION_KEY
  , m.REGION                              AS REGION
  , COALESCE(m.DISPLAY_NAME, m.REGION)    AS REGION_DISPLAY_NAME
  , m.STATUS                              AS REGION_STATUS
  , m.COMPUTE_SIZE                        AS COMPUTE_SIZE
  , m.INSTANCE_FAMILY                     AS INSTANCE_FAMILY
  , m.IS_DEFAULT                          AS IS_DEFAULT
  , c.CONTINENT                            AS CONTINENT
  , c.COUNTRY                              AS COUNTRY
  , c.ISO_COUNTRY_A2                       AS ISO_COUNTRY_A2
  , c.LEVEL                                AS CATALOG_LEVEL
  , c.PBF_SIZE_MB                          AS PBF_SIZE_MB
  , c.BOUNDARY_AREA_KM2                    AS BOUNDARY_AREA_KM2
  , m.CREATED_AT                           AS PROVISIONED_AT
FROM OPENROUTESERVICE_APP.CORE.REGION_ORS_MAP m
LEFT JOIN cat c
  ON c.JOIN_KEY = UPPER(m.REGION) AND c.RN = 1;

-- requests: one row per gateway routing call. REQUEST_ID can repeat or be NULL,
-- so a surrogate key is synthesized to keep the fact uniquely keyed. The
-- tie-breaker is a deterministic ROW_NUMBER, not SEQ8() - a non-deterministic
-- key would change identity on every read of the view.
CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.SEMANTIC_OPS.VW_DEPLOY_REQUESTS
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","component":"semantic-views"}}'
AS
SELECT
    SHA2(CONCAT_WS('|', COALESCE(REQUEST_ID, ''), TO_VARCHAR(REQUEST_TS),
                        COALESCE(ENDPOINT, ''), COALESCE(ORS_HOST, ''),
                        TO_VARCHAR(ROW_NUMBER() OVER (
                          PARTITION BY COALESCE(REQUEST_ID, ''), REQUEST_TS
                          ORDER BY ENDPOINT NULLS LAST, ORS_HOST NULLS LAST,
                                   LATENCY_MS NULLS LAST))), 256)
                                                        AS REQUEST_ROW_ID
  , REQUEST_TS                                          AS REQUEST_TS
  , REQUEST_TS::DATE                                    AS REQUEST_DATE
  , ENDPOINT                                            AS ENDPOINT
  , PROFILE                                             AS PROFILE
  , ORS_HOST                                            AS ORS_HOST
  , CALLER                                              AS CALLER
  , STATUS_CODE                                         AS STATUS_CODE
  , ERROR_CODE                                          AS ERROR_CODE
  , LATENCY_MS                                          AS LATENCY_MS
  , REQUEST_BYTES                                       AS REQUEST_BYTES
  , RESPONSE_BYTES                                      AS RESPONSE_BYTES
  , (STATUS_CODE IS NOT NULL AND STATUS_CODE >= 400)    AS IS_ERROR
  -- Region is derived from the host because the REGION column is frequently
  -- NULL (same reason RECONCILE_AUTO_SUSPEND matches on ORS_HOST).
  , UPPER(COALESCE(
        REGION,
        REGEXP_REPLACE(ORS_HOST, '^(ors|vroom)-service-', '')
      ))                                                AS REGION_KEY
  , CASE
      WHEN ORS_HOST ILIKE 'vroom-%' THEN 'OPTIMIZATION'
      WHEN ORS_HOST ILIKE 'ors-%'   THEN 'ROUTING'
      ELSE 'OTHER'
    END                                                 AS SERVICE_KIND
FROM OPENROUTESERVICE_APP.OBSERVABILITY.ORS_REQUEST_LOG;

-- jobs: region provisioning + travel-matrix builds in one fact, discriminated by
-- JOB_KIND. Keyed on JOB_KIND || JOB_ID because the two source tables mint their
-- ids independently and could collide.
CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.SEMANTIC_OPS.VW_DEPLOY_JOBS
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","component":"semantic-views"}}'
AS
SELECT
    'PROVISION:' || JOB_ID                        AS JOB_KEY
  , 'PROVISION'                                   AS JOB_KIND
  , JOB_ID                                        AS JOB_ID
  , UPPER(REGION)                                 AS REGION_KEY
  , STATUS                                        AS JOB_STATUS
  , STAGE                                         AS JOB_STAGE
  , NULL::VARCHAR                                 AS PROFILE
  , CREATED_AT                                    AS CREATED_AT
  , STARTED_AT                                    AS STARTED_AT
  , COMPLETED_AT                                  AS COMPLETED_AT
  , DATEDIFF('second', STARTED_AT, COMPLETED_AT)  AS DURATION_SECONDS
  , ERROR_MSG                                     AS ERROR_MSG
  , NULL::FLOAT                                   AS PCT_COMPLETE
FROM OPENROUTESERVICE_APP.CORE.REGION_PROVISION_JOBS
UNION ALL
SELECT
    'MATRIX:' || JOB_ID                           AS JOB_KEY
  , 'MATRIX'                                      AS JOB_KIND
  , JOB_ID                                        AS JOB_ID
  , UPPER(REGION)                                 AS REGION_KEY
  , STATUS                                        AS JOB_STATUS
  , STAGE                                         AS JOB_STAGE
  , PROFILE                                       AS PROFILE
  , CREATED_AT                                    AS CREATED_AT
  , STARTED_AT                                    AS STARTED_AT
  , COMPLETED_AT                                  AS COMPLETED_AT
  , DATEDIFF('second', STARTED_AT, COMPLETED_AT)  AS DURATION_SECONDS
  , ERROR_MSG                                     AS ERROR_MSG
  , PCT_COMPLETE                                  AS PCT_COMPLETE
FROM OPENROUTESERVICE_APP.TRAVEL_MATRIX.MATRIX_BUILD_JOBS;

-- verb_attempts: the synapse audit envelope. ARGS_JSON is deliberately excluded
-- (VARIANT payloads are not something text-to-SQL should aggregate over, and
-- they can carry free-text location names).
CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.SEMANTIC_OPS.VW_DEPLOY_VERB_ATTEMPTS
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","component":"semantic-views"}}'
AS
SELECT
    ID                          AS ATTEMPT_ID
  , AT                          AS ATTEMPT_TS
  , AT::DATE                    AS ATTEMPT_DATE
  , VERB                        AS VERB
  , ACTOR                       AS ACTOR
  , ACTOR_ROLE                  AS ACTOR_ROLE
  , OUTCOME                     AS OUTCOME
  , ERROR_CODE                  AS ERROR_CODE
  , (OUTCOME = 'error')         AS IS_ERROR
FROM OPENROUTESERVICE_APP.ROUTING.VERB_ATTEMPT;

-- ============ SV_FLEET_DEPLOYMENT ============
CREATE OR REPLACE SEMANTIC VIEW FLEET_INTELLIGENCE.SEMANTIC_OPS.SV_FLEET_DEPLOYMENT

  TABLES (
    regions AS FLEET_INTELLIGENCE.SEMANTIC_OPS.VW_DEPLOY_REGIONS
      PRIMARY KEY (REGION_KEY)
      COMMENT = 'Provisioned region dimension. Parent of requests and jobs.'
    , requests AS FLEET_INTELLIGENCE.SEMANTIC_OPS.VW_DEPLOY_REQUESTS
      PRIMARY KEY (REQUEST_ROW_ID)
      COMMENT = 'Routing call fact, one row per gateway request.'
    , jobs AS FLEET_INTELLIGENCE.SEMANTIC_OPS.VW_DEPLOY_JOBS
      PRIMARY KEY (JOB_KEY)
      COMMENT = 'Build job fact (region provisioning + travel matrix builds).'
    , verb_attempts AS FLEET_INTELLIGENCE.SEMANTIC_OPS.VW_DEPLOY_VERB_ATTEMPTS
      PRIMARY KEY (ATTEMPT_ID)
      COMMENT = 'Synapse audit envelope fact. Standalone (no region upstream).'
  )

  RELATIONSHIPS (
    requests_to_regions AS requests(REGION_KEY) REFERENCES regions(REGION_KEY)
    , jobs_to_regions AS jobs(REGION_KEY) REFERENCES regions(REGION_KEY)
  )

  FACTS (
    requests.latency_ms AS LATENCY_MS
      COMMENT = 'Gateway round-trip latency for one routing call, milliseconds'
    , requests.request_bytes AS REQUEST_BYTES
      COMMENT = 'Request payload size in bytes'
    , requests.response_bytes AS RESPONSE_BYTES
      COMMENT = 'Response payload size in bytes'
    , jobs.duration_seconds AS DURATION_SECONDS
      COMMENT = 'Wall-clock build duration in seconds (started to completed)'
    , jobs.pct_complete AS PCT_COMPLETE
      COMMENT = 'Progress percent, matrix build jobs only'
    , regions.pbf_size_mb AS PBF_SIZE_MB
      COMMENT = 'Size of the OSM extract the region graph was built from (MB)'
    , regions.boundary_area_km2 AS BOUNDARY_AREA_KM2
      COMMENT = 'Region boundary area in square km'
  )

  DIMENSIONS (
    regions.region AS REGION
      WITH SYNONYMS ('region name', 'city', 'area', 'geography')
      COMMENT = 'Provisioned region key as used by every routing call (e.g. SanFrancisco, Germany)'
    , regions.region_display_name AS REGION_DISPLAY_NAME
      COMMENT = 'Human-readable region label'
    , regions.region_status AS REGION_STATUS
      WITH SYNONYMS ('registry status')
      COMMENT = 'Region registry status. This is the REGISTRY row state, NOT live service run-state.'
    , regions.compute_size AS COMPUTE_SIZE
      WITH SYNONYMS ('tier', 'instance size')
      COMMENT = 'Compute tier the region graph service runs on (S, L, XXL)'
    , regions.instance_family AS INSTANCE_FAMILY
      COMMENT = 'SPCS instance family of the region compute pool'
    , regions.is_default AS IS_DEFAULT
      COMMENT = 'Whether this is the account default region'
    , regions.continent AS CONTINENT
      COMMENT = 'Continent from the region catalog'
    , regions.country AS COUNTRY
      COMMENT = 'Country from the region catalog'
    , regions.provisioned_at AS PROVISIONED_AT
      COMMENT = 'When the region was first registered'
    , requests.request_ts AS REQUEST_TS
      WITH SYNONYMS ('call time', 'request time')
      COMMENT = 'Timestamp of the routing call'
    , requests.request_date AS REQUEST_DATE
      WITH SYNONYMS ('day', 'date')
      COMMENT = 'Calendar date of the routing call'
    , requests.endpoint AS ENDPOINT
      WITH SYNONYMS ('api', 'route', 'operation')
      COMMENT = 'Routing endpoint called (directions, isochrones, matrix, optimization, snap, match)'
    , requests.profile AS PROFILE
      WITH SYNONYMS ('vehicle profile', 'routing profile')
      COMMENT = 'Routing profile (driving-car, driving-hgv, cycling-electric, foot-walking)'
    , requests.service_kind AS SERVICE_KIND
      COMMENT = 'Which service served the call: ROUTING (ORS) or OPTIMIZATION (VROOM)'
    , requests.caller AS CALLER
      WITH SYNONYMS ('user', 'invoker')
      COMMENT = 'Caller identity recorded by the gateway'
    , requests.status_code AS STATUS_CODE
      COMMENT = 'HTTP status returned by the routing engine'
    , requests.error_code AS ERROR_CODE
      WITH SYNONYMS ('failure code')
      COMMENT = 'Gateway error code (e.g. service_unreachable, circuit_open, timeout, service_warming_up)'
    , requests.is_error AS IS_ERROR
      COMMENT = 'Whether the call failed (HTTP status 400 or above)'
    , jobs.job_kind AS JOB_KIND
      WITH SYNONYMS ('build type')
      COMMENT = 'PROVISION (region graph build) or MATRIX (travel-matrix build)'
    , jobs.job_status AS JOB_STATUS
      WITH SYNONYMS ('build status')
      COMMENT = 'Job status (PENDING, RUNNING, COMPLETE, ERROR)'
    , jobs.job_stage AS JOB_STAGE
      WITH SYNONYMS ('build stage', 'phase')
      COMMENT = 'Job stage (DOWNLOADING, CONFIGURING, BUILDING_GRAPH, COMPLETE, ERROR, ...)'
    , jobs.job_profile AS PROFILE
      COMMENT = 'Routing profile the matrix job was built for (matrix jobs only)'
    , jobs.created_at AS CREATED_AT
      COMMENT = 'When the job was enqueued'
    , jobs.completed_at AS COMPLETED_AT
      COMMENT = 'When the job finished'
    , jobs.error_msg AS ERROR_MSG
      COMMENT = 'Failure message for a job that errored'
    , verb_attempts.verb AS VERB
      WITH SYNONYMS ('tool', 'action')
      COMMENT = 'Name of the synapse verb that was attempted'
    , verb_attempts.actor AS ACTOR
      WITH SYNONYMS ('who', 'user')
      COMMENT = 'User that invoked the verb'
    , verb_attempts.actor_role AS ACTOR_ROLE
      COMMENT = 'Role the verb ran under'
    , verb_attempts.outcome AS OUTCOME
      COMMENT = 'Verb outcome (ok, error)'
    , verb_attempts.attempt_ts AS ATTEMPT_TS
      COMMENT = 'When the verb was attempted'
    , verb_attempts.attempt_date AS ATTEMPT_DATE
      COMMENT = 'Calendar date of the verb attempt'
    , verb_attempts.attempt_error_code AS ERROR_CODE
      COMMENT = 'Error code recorded by the envelope when the verb failed'
    , verb_attempts.attempt_is_error AS IS_ERROR
      COMMENT = 'Whether the verb attempt failed'
  )

  METRICS (
    regions.total_regions AS COUNT(DISTINCT REGION_KEY)
      WITH SYNONYMS ('number of regions', 'provisioned regions')
      COMMENT = 'Distinct count of provisioned regions'
    , requests.total_requests AS COUNT(*)
      WITH SYNONYMS ('routing calls', 'number of requests', 'call volume')
      COMMENT = 'Count of routing calls'
    , requests.error_requests AS COUNT_IF(IS_ERROR)
      WITH SYNONYMS ('failed calls', 'errors')
      COMMENT = 'Count of routing calls that failed'
    , requests.error_rate_pct AS DIV0(COUNT_IF(IS_ERROR), COUNT(*)) * 100
      WITH SYNONYMS ('failure rate')
      COMMENT = 'Percent of routing calls that failed'
    , requests.avg_latency_ms AS AVG(latency_ms)
      WITH SYNONYMS ('average latency', 'mean response time')
      COMMENT = 'Average gateway latency in milliseconds'
    , requests.p50_latency_ms AS MEDIAN(latency_ms)
      WITH SYNONYMS ('median latency')
      COMMENT = 'Median gateway latency in milliseconds'
    , requests.p95_latency_ms AS APPROX_PERCENTILE(latency_ms, 0.95)
      WITH SYNONYMS ('95th percentile latency', 'tail latency')
      COMMENT = 'p95 gateway latency in milliseconds'
    , requests.max_latency_ms AS MAX(latency_ms)
      COMMENT = 'Slowest routing call in milliseconds'
    , requests.total_response_bytes AS SUM(response_bytes)
      COMMENT = 'Total bytes returned by the routing engine'
    , jobs.total_jobs AS COUNT(*)
      WITH SYNONYMS ('number of builds', 'build count')
      COMMENT = 'Count of build jobs'
    , jobs.failed_jobs AS COUNT_IF(JOB_STATUS = 'ERROR')
      WITH SYNONYMS ('failed builds')
      COMMENT = 'Count of build jobs that errored'
    , jobs.avg_duration_seconds AS AVG(duration_seconds)
      WITH SYNONYMS ('average build time')
      COMMENT = 'Average build duration in seconds'
    , jobs.max_duration_seconds AS MAX(duration_seconds)
      WITH SYNONYMS ('longest build')
      COMMENT = 'Longest build duration in seconds'
    , verb_attempts.total_attempts AS COUNT(*)
      WITH SYNONYMS ('verb calls', 'tool calls', 'audited attempts')
      COMMENT = 'Count of audited verb attempts'
    , verb_attempts.failed_attempts AS COUNT_IF(OUTCOME = 'error')
      WITH SYNONYMS ('verb errors', 'failed tool calls')
      COMMENT = 'Count of verb attempts that errored'
    , verb_attempts.attempt_error_rate_pct AS DIV0(COUNT_IF(OUTCOME = 'error'), COUNT(*)) * 100
      COMMENT = 'Percent of verb attempts that errored'
    , verb_attempts.distinct_actors AS COUNT(DISTINCT ACTOR)
      WITH SYNONYMS ('number of users')
      COMMENT = 'Distinct users that invoked a verb'
  )

  COMMENT = 'Deployment and routing HISTORY for operators and installers: routing-call volume, error rate and latency per region / endpoint / profile, region graph and travel-matrix build outcomes and durations, and the audited synapse verb attempts. Historical and aggregate only - live service run-state comes from the ops verbs, not from here.'

  AI_SQL_GENERATION 'Operations semantic view for the Route Optimisation & Fleet Intelligence routing platform. It answers HISTORICAL and AGGREGATE questions about the deployment itself, not about the fleet, and not about live service state.

Entities:
- regions: DIMENSION, one row per provisioned region (region, compute_size, instance_family, is_default, country, pbf_size_mb, boundary_area_km2). Parent of requests and jobs.
- requests: FACT, one row per routing call made through the gateway (endpoint, profile, service_kind, status_code, error_code, latency_ms). Use it for call volume, error rate, and latency questions.
- jobs: FACT, one row per build job, with job_kind = PROVISION (region graph build) or MATRIX (travel-matrix build). Use it for "how long did provisioning take" and "which builds failed".
- verb_attempts: standalone FACT over the audit envelope, one row per attempted agent verb (verb, actor, actor_role, outcome). Use it for "which tools are being used" and "what is failing". It has no region column, so never try to join it to regions.

Conventions:
- This view is HISTORY. If the user asks whether a service is currently running, whether a region is suspended, or asks to suspend/resume/provision/drop anything, this is the WRONG tool - defer to the deployment/service tools instead.
- Error rate: prefer requests.error_rate_pct over computing it by hand; the underlying is_error flag is HTTP status >= 400.
- Latency is in MILLISECONDS. Use p95_latency_ms for tail latency questions.
- service_kind separates ROUTING (ORS) from OPTIMIZATION (VROOM) traffic; endpoint is finer grained (directions, isochrones, matrix, optimization, snap, match).
- Region on requests is derived from the gateway host because the raw region column is often null; group by regions.region or requests-side dimensions, both resolve.
- jobs.duration_seconds is only populated once a job has both started and completed; a running job has a null duration.
- Scope time questions with explicit dates against requests.request_date, jobs.created_at, or verb_attempts.attempt_date.'
;
