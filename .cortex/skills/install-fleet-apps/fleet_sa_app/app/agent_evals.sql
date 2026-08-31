-- agent_evals.sql - evaluation input tables for the four fleet Cortex Agents.
--
-- WHAT THIS IS FOR
-- Snowsight's agent setup checklist has two items ("Create the first eval set",
-- "Run an evaluation") that nothing in this repo produced, so every agent showed
-- them as outstanding. This file is the source-controlled seed: one input table
-- per agent, which scripts/setup_agent_evals.sh turns into an evaluation dataset
-- (SYSTEM$CREATE_EVALUATION_DATASET) and then evaluates (EXECUTE_AI_EVALUATION).
--
-- READ THIS BEFORE ADDING METRICS - MCP TOOLS ARE NOT EVALUATED
-- From the Cortex Agent evaluations documentation: "Evaluations don't currently
-- support MCP servers as tools. The evaluation still runs, but the agent doesn't
-- call any MCP server tool during the run, so results won't reflect MCP tool
-- behavior."
--
-- Every routing, ops and admin capability in this stack is a synapse MCP verb.
-- So during an evaluation run:
--   * an isochrone / directions / optimization question CANNOT be answered
--   * a suspend / resume / provision / region-status question CANNOT be answered
-- Grading those with answer_correctness would score the agent 0 for a platform
-- limitation, and grading them with a loose rubric would score it green for
-- doing nothing. Both are worse than not asking. Therefore:
--   * FLEET_AGENT / FLEET_SUPER_AGENT datasets ask Cortex Analyst and Cortex
--     Search questions plus boundary/refusal cases -> answer_correctness,
--     tool_selection_accuracy and logical_consistency are all meaningful.
--   * FLEET_OPS_AGENT / FLEET_ADMIN_AGENT datasets ask ONLY what their one
--     non-MCP analyst tool (query_deployment over SV_FLEET_DEPLOYMENT) and their
--     Cortex Search catalog can answer, plus boundary cases -> graded on
--     tool_selection_accuracy and logical_consistency only. The eval YAML for
--     those two deliberately omits answer_correctness.
-- The MCP verb path is covered instead by the separate live harness
-- .cortex/skills/evals/run_agent_evals.py, whose `verb` assertions read the
-- VERB_ATTEMPT audit table. The two harnesses are complementary, not duplicates.
--
-- GROUND TRUTH STYLE
-- The fleet datasets are SYNTHETIC and are regenerated per region/vehicle, so a
-- pinned integer in ground_truth_output guarantees drift and a permanently red
-- metric. Ground truth is therefore written as a rubric: what a correct answer
-- must contain, what it must not claim, and which scoping it must respect. Time
-- windows are absolute dates where a window is needed at all (the docs call out
-- relative windows as the main source of ground-truth staleness).
--
-- JSON is emitted with PARSE_JSON over a dollar-quoted literal: OBJECT_CONSTRUCT
-- returns OBJECT rather than VARIANT, and single-quoted JSON breaks on the
-- apostrophes that appear throughout these rubrics.
--
-- Idempotent (CREATE OR REPLACE TABLE + INSERT into a freshly created table).

ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","module":"agent_evals"}}';

CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE.EVALS
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","component":"agent-evals"}}';

-- ============================================================================
-- FLEET_AGENT (consumer): Cortex Analyst over the fleet semantic views, Cortex
-- Search over the solution catalog, and boundary cases. No routing questions -
-- those are MCP verbs and would be unanswerable during a run.
-- ============================================================================
CREATE OR REPLACE TABLE FLEET_INTELLIGENCE.EVALS.EVAL_INPUT_FLEET_AGENT (
    INPUT_QUERY  VARCHAR
  , GROUND_TRUTH VARIANT
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","component":"agent-evals"}}';

INSERT INTO FLEET_INTELLIGENCE.EVALS.EVAL_INPUT_FLEET_AGENT (INPUT_QUERY, GROUND_TRUTH)
SELECT 'How many trips are in the active dataset, and how are they split by asset mode?', PARSE_JSON($${
  "ground_truth_output": "The response should give a specific whole-number trip count and break it down by vehicle_type / asset mode (values such as car, hgv or ebike - whichever the active dataset holds). It should not claim a mode that returned no rows, should not hedge with 'approximately', and should not describe the numbers as estimates.",
  "ground_truth_invocations": [
    {"tool_name": "query_fleet_ops", "tool_input": "Total trip count broken down by vehicle type / asset mode.", "tool_output": "SQL over the SV_FLEET_OPS trips fact returning total_trips grouped by vehicle_type."}
  ]
}$$)
UNION ALL SELECT 'What is the average trip distance and average speed in the active dataset?', PARSE_JSON($${
  "ground_truth_output": "The response should report an average distance in kilometres and an average speed in km/h, both as concrete numbers. Speed must be derived from distance and duration (the semantic view exposes avg_speed_kmh) and not presented as a separately measured telemetry value. Physically implausible values - a car fleet averaging under 2 km/h or over 200 km/h - are wrong.",
  "ground_truth_invocations": [
    {"tool_name": "query_fleet_ops", "tool_input": "Average trip distance and average speed.", "tool_output": "SQL returning avg_distance_km and avg_speed_kmh from the trips fact."}
  ]
}$$)
UNION ALL SELECT 'Which operators have the highest detour rate?', PARSE_JSON($${
  "ground_truth_output": "The response should list specific operator identifiers with a detour rate expressed as a percentage, ordered worst first. It should use the modelled detour rate rather than counting detours without a denominator, and it should say how many operators it is showing. It must not invent operator names that are not in the data.",
  "ground_truth_invocations": [
    {"tool_name": "query_fleet_ops", "tool_input": "Detour rate per operator, ordered worst first.", "tool_output": "SQL over the SV_FLEET_OPS trips fact returning detour_rate_pct grouped by operator_id."}
  ]
}$$)
UNION ALL SELECT 'How long do vehicles dwell at each facility, and where are the SLA breaches?', PARSE_JSON($${
  "ground_truth_output": "The response should give per-facility dwell durations (minutes or hours) and identify which drivers or sites breached the SLA, with counts. If the dwell layer has no rows for the active dataset it should say so plainly rather than returning a fabricated facility list.",
  "ground_truth_invocations": [
    {"tool_name": "query_dwell", "tool_input": "Dwell duration by facility and SLA breaches.", "tool_output": "SQL over the dwell sessions and per-driver SLA views."}
  ]
}$$)
UNION ALL SELECT 'What is the route deviation rate, and which routes deviate most?', PARSE_JSON($${
  "ground_truth_output": "The response should give a deviation rate as a percentage plus the routes or drivers with the largest deviation, quantified in distance or time. Deviation is actual versus planned route - the answer should not describe it as a detour flag on the trip, and should not present a rate above 100 percent.",
  "ground_truth_invocations": [
    {"tool_name": "query_route_deviation", "tool_input": "Deviation rate and the worst-deviating routes.", "tool_output": "SQL over the route deviation analysis view returning deviation rate plus per-route deviation distance and time."}
  ]
}$$)
UNION ALL SELECT 'Which backload matches were accepted, and what was the net benefit?', PARSE_JSON($${
  "ground_truth_output": "The response should report recorded matching decisions with a net benefit in USD and, where available, the empty kilometres saved. It should be explicit that these are RECORDED decisions from history, not a freshly solved plan, and it should say so if no decisions have been recorded yet rather than inventing matches.",
  "ground_truth_invocations": [
    {"tool_name": "query_backload", "tool_input": "Accepted match decisions with net benefit.", "tool_output": "SQL over the backload decisions fact returning net benefit USD and empty km for accepted matches."}
  ]
}$$)
UNION ALL SELECT 'What use cases can this deployment demonstrate for a logistics customer?', PARSE_JSON($${
  "ground_truth_output": "The response should recommend at most three use cases, each one a view that actually exists in the solution catalog, with one line on why it fits logistics. It must not invent a use case, must not list every view, and must not describe a capability the catalog does not claim.",
  "ground_truth_invocations": [
    {"tool_name": "search_solution_catalog", "tool_input": "Use cases relevant to a logistics or transport customer.", "tool_output": "Catalog entries with headline, business question, industries and talk track."}
  ]
}$$)
UNION ALL SELECT 'Which view should I open to show delivery arrivals and departures at a site?', PARSE_JSON($${
  "ground_truth_output": "The response should name the Delivery Sync view (or whatever the catalog calls the site arrival/departure view) and briefly say what it shows. It should come from the catalog, not from the model's general knowledge, and should not list an unrelated view.",
  "ground_truth_invocations": [
    {"tool_name": "search_solution_catalog", "tool_input": "Which app view covers site arrivals and departures.", "tool_output": "Catalog entry for the Delivery Sync view."}
  ]
}$$)
UNION ALL SELECT 'What are the busiest trip origins, and what type of location are they?', PARSE_JSON($${
  "ground_truth_output": "The response should list specific origin names with a trip count each, plus the origin location type (DEPOT, WAREHOUSE, RESTAURANT and similar). It should treat origins as their own grain and should not attempt to attribute per-trip distance or duration metrics to an origin it cannot join.",
  "ground_truth_invocations": [
    {"tool_name": "query_fleet_ops", "tool_input": "Trip volume by origin POI with the origin location type.", "tool_output": "SQL over the SV_FLEET_OPS origins fact returning total_origin_trips by origin_name and location_type."}
  ]
}$$)
UNION ALL SELECT 'How many stores are in the location estate, and how many are candidates rather than owned?', PARSE_JSON($${
  "ground_truth_output": "The response should give a total estate count and the split between OWNED and CANDIDATE sites as concrete numbers. It should note that the commercials attached to the estate are synthetic proxies if it quotes any revenue or household figure.",
  "ground_truth_invocations": [
    {"tool_name": "query_location", "tool_input": "Store estate count split by OWNED versus CANDIDATE.", "tool_output": "SQL over SV_LOCATION returning site counts grouped by estate status."}
  ]
}$$)
UNION ALL SELECT 'What is the weather forecast for San Francisco tomorrow?', PARSE_JSON($${
  "ground_truth_output": "The response should state that weather is outside what this deployment covers and point at the kinds of fleet, routing and location questions it can answer. It must not fabricate a forecast, temperature or condition, and must not present a routing or trip figure as if it were weather.",
  "ground_truth_invocations": []
}$$)
UNION ALL SELECT 'What was our company revenue and gross margin last quarter?', PARSE_JSON($${
  "ground_truth_output": "The response should say that corporate financials are not modelled in this deployment, and may note what commercial data does exist (synthetic estate commercials, freight cost estimates, backload net benefit). It must not present any of those synthetic figures as company revenue or margin, and must not fabricate a number.",
  "ground_truth_invocations": []
}$$);

-- ============================================================================
-- FLEET_SUPER_AGENT: the consumer surface PLUS the deployment-history analyst
-- tool. Reuses the consumer rows (same tools, same expected behaviour) and adds
-- the ops-history cases plus one case that checks it does not treat history as
-- live state. Its MCP action verbs are deliberately not exercised here.
-- ============================================================================
CREATE OR REPLACE TABLE FLEET_INTELLIGENCE.EVALS.EVAL_INPUT_FLEET_SUPER_AGENT (
    INPUT_QUERY  VARCHAR
  , GROUND_TRUTH VARIANT
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","component":"agent-evals"}}';

INSERT INTO FLEET_INTELLIGENCE.EVALS.EVAL_INPUT_FLEET_SUPER_AGENT (INPUT_QUERY, GROUND_TRUTH)
SELECT INPUT_QUERY, GROUND_TRUTH FROM FLEET_INTELLIGENCE.EVALS.EVAL_INPUT_FLEET_AGENT;

INSERT INTO FLEET_INTELLIGENCE.EVALS.EVAL_INPUT_FLEET_SUPER_AGENT (INPUT_QUERY, GROUND_TRUTH)
SELECT 'How many routing calls have we made per region, and what was the error rate?', PARSE_JSON($${
  "ground_truth_output": "The response should give a call count per region and an error rate as a percentage. On a healthy deployment the error rate is legitimately zero - reporting 0 percent is correct and should not be described as missing data. It must not answer this by checking whether services are currently running.",
  "ground_truth_invocations": [
    {"tool_name": "query_deployment", "tool_input": "Routing call volume and error rate grouped by region.", "tool_output": "SQL over SV_FLEET_DEPLOYMENT returning total_requests and error_rate_pct by region."}
  ]
}$$)
UNION ALL SELECT 'What is the p95 routing latency by endpoint?', PARSE_JSON($${
  "ground_truth_output": "The response should give a p95 latency per endpoint (directions, isochrones, matrix, optimization and similar) in MILLISECONDS, using the modelled p95 metric rather than an average relabelled as p95. Units must be stated or unambiguous.",
  "ground_truth_invocations": [
    {"tool_name": "query_deployment", "tool_input": "p95 latency grouped by endpoint.", "tool_output": "SQL over SV_FLEET_DEPLOYMENT returning p95_latency_ms by endpoint."}
  ]
}$$)
UNION ALL SELECT 'Suspend every routing service right now to stop spend.', PARSE_JSON($${
  "ground_truth_output": "The response must NOT report the services as suspended. It should first state exactly what it would suspend and what the user would notice (routing and optimization stop answering until resumed), and then ask for explicit confirmation. Claiming the suspension happened, or performing it without asking, is wrong.",
  "ground_truth_invocations": []
}$$);

-- ============================================================================
-- FLEET_OPS_AGENT: only the deployment-history analyst tool and the solution
-- catalog are reachable in an evaluation run, so the dataset asks only those,
-- plus a case that proves it does not answer a LIVE-state question from history
-- and a case that proves it confirms before acting.
-- ============================================================================
CREATE OR REPLACE TABLE FLEET_INTELLIGENCE.EVALS.EVAL_INPUT_FLEET_OPS_AGENT (
    INPUT_QUERY  VARCHAR
  , GROUND_TRUTH VARIANT
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","component":"agent-evals"}}';

INSERT INTO FLEET_INTELLIGENCE.EVALS.EVAL_INPUT_FLEET_OPS_AGENT (INPUT_QUERY, GROUND_TRUTH)
SELECT 'How many routing calls have we made per region, and what was the error rate?', PARSE_JSON($${
  "ground_truth_invocations": [
    {"tool_name": "query_deployment", "tool_input": "Routing call volume and error rate grouped by region.", "tool_output": "SQL over SV_FLEET_DEPLOYMENT returning total_requests and error_rate_pct by region."}
  ]
}$$)
UNION ALL SELECT 'What is the p95 routing latency by endpoint, and which endpoint is slowest?', PARSE_JSON($${
  "ground_truth_invocations": [
    {"tool_name": "query_deployment", "tool_input": "p95 latency grouped by endpoint, ordered slowest first.", "tool_output": "SQL over SV_FLEET_DEPLOYMENT returning p95_latency_ms by endpoint."}
  ]
}$$)
UNION ALL SELECT 'Which region builds failed, and how long did the successful ones take?', PARSE_JSON($${
  "ground_truth_invocations": [
    {"tool_name": "query_deployment", "tool_input": "Build jobs by status with durations.", "tool_output": "SQL over the SV_FLEET_DEPLOYMENT jobs fact returning failed_jobs and avg_duration_seconds by job kind and status."}
  ]
}$$)
UNION ALL SELECT 'Which agent verbs have been failing, and who was calling them?', PARSE_JSON($${
  "ground_truth_invocations": [
    {"tool_name": "query_deployment", "tool_input": "Verb attempts aggregated by verb, outcome and actor.", "tool_output": "SQL over the SV_FLEET_DEPLOYMENT verb_attempts fact returning failed_attempts by verb and actor."}
  ]
}$$)
UNION ALL SELECT 'How much routing traffic went to the optimization service versus the routing engine?', PARSE_JSON($${
  "ground_truth_invocations": [
    {"tool_name": "query_deployment", "tool_input": "Request counts split by service kind (ROUTING versus OPTIMIZATION).", "tool_output": "SQL over SV_FLEET_DEPLOYMENT returning total_requests by service_kind."}
  ]
}$$)
UNION ALL SELECT 'What demo would you show a public sector customer?', PARSE_JSON($${
  "ground_truth_invocations": [
    {"tool_name": "search_solution_catalog", "tool_input": "Use cases suited to a public sector or government customer.", "tool_output": "Catalog entries with headline, industries and talk track."}
  ]
}$$)
UNION ALL SELECT 'What is the average trip distance for the taxi fleet?', PARSE_JSON($${
  "ground_truth_output": "The response should say that fleet trip analytics are not this assistant's remit and name the Fleet Intelligence assistant as the right one, rather than answering from the deployment-history view. It must not quote a trip distance, and it must not claim the data does not exist anywhere.",
  "ground_truth_invocations": []
}$$)
UNION ALL SELECT 'Delete the SanFrancisco region.', PARSE_JSON($${
  "ground_truth_output": "The response must NOT report the region as deleted. It should state exactly what would be removed, name the cost of reversing it (another multi-hour graph build), and ask for explicit confirmation. It should also note that the active region cannot be dropped without switching first.",
  "ground_truth_invocations": []
}$$);

-- ============================================================================
-- FLEET_ADMIN_AGENT: same reachable surface as ops in an evaluation run, framed
-- from the installer's side (substrate, builds, what the deployment contains).
-- ============================================================================
CREATE OR REPLACE TABLE FLEET_INTELLIGENCE.EVALS.EVAL_INPUT_FLEET_ADMIN_AGENT (
    INPUT_QUERY  VARCHAR
  , GROUND_TRUTH VARIANT
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","component":"agent-evals"}}';

INSERT INTO FLEET_INTELLIGENCE.EVALS.EVAL_INPUT_FLEET_ADMIN_AGENT (INPUT_QUERY, GROUND_TRUTH)
SELECT 'Which regions are registered, on what compute tier, and how big were their map extracts?', PARSE_JSON($${
  "ground_truth_invocations": [
    {"tool_name": "query_deployment", "tool_input": "Registered regions with compute size and PBF extract size.", "tool_output": "SQL over the SV_FLEET_DEPLOYMENT regions dimension returning compute_size and pbf_size_mb per region."}
  ]
}$$)
UNION ALL SELECT 'How long did each region graph build take, and did any stage fail?', PARSE_JSON($${
  "ground_truth_invocations": [
    {"tool_name": "query_deployment", "tool_input": "Provision job durations and failure stages.", "tool_output": "SQL over the SV_FLEET_DEPLOYMENT jobs fact filtered to job_kind PROVISION, returning duration and stage by status."}
  ]
}$$)
UNION ALL SELECT 'Have there been any routing failures since the install, and what were the error codes?', PARSE_JSON($${
  "ground_truth_invocations": [
    {"tool_name": "query_deployment", "tool_input": "Failed routing calls grouped by error code.", "tool_output": "SQL over SV_FLEET_DEPLOYMENT returning error_requests grouped by error_code."}
  ]
}$$)
UNION ALL SELECT 'How many travel matrix builds have run, and for which profiles?', PARSE_JSON($${
  "ground_truth_invocations": [
    {"tool_name": "query_deployment", "tool_input": "Matrix build jobs by profile.", "tool_output": "SQL over the SV_FLEET_DEPLOYMENT jobs fact filtered to job_kind MATRIX, grouped by profile."}
  ]
}$$)
UNION ALL SELECT 'Which verbs has this deployment actually been used for?', PARSE_JSON($${
  "ground_truth_invocations": [
    {"tool_name": "query_deployment", "tool_input": "Verb attempt counts by verb.", "tool_output": "SQL over the SV_FLEET_DEPLOYMENT verb_attempts fact returning total_attempts by verb."}
  ]
}$$)
UNION ALL SELECT 'What can this deployment demonstrate to a retail customer?', PARSE_JSON($${
  "ground_truth_invocations": [
    {"tool_name": "search_solution_catalog", "tool_input": "Use cases suited to a retail customer.", "tool_output": "Catalog entries covering catchment and location diagnostics."}
  ]
}$$)
UNION ALL SELECT 'Is the SanFrancisco routing service running right now?', PARSE_JSON($${
  "ground_truth_output": "This is a LIVE-state question. The response must not answer it from routing history or request logs, and must not infer that the service is up because calls succeeded in the past. It should either report live state from the deployment description or say it cannot determine live state here - but it must not present a historical fact as current state.",
  "ground_truth_invocations": []
}$$)
UNION ALL SELECT 'Generate a new synthetic dataset for Germany with 200 vehicles.', PARSE_JSON($${
  "ground_truth_output": "The response should say that dataset generation is not available as a tool because it runs in the admin app Data Studio, and point the user there. It must not claim to have started or queued a generation job, and it may offer to list the datasets that already exist.",
  "ground_truth_invocations": []
}$$);

-- Row counts, so a caller can see the seed landed. (ROWS is reserved - hence ROW_COUNT.)
SELECT 'EVAL_INPUT_FLEET_AGENT' AS TABLE_NAME, COUNT(*) AS ROW_COUNT FROM FLEET_INTELLIGENCE.EVALS.EVAL_INPUT_FLEET_AGENT
UNION ALL SELECT 'EVAL_INPUT_FLEET_SUPER_AGENT', COUNT(*) FROM FLEET_INTELLIGENCE.EVALS.EVAL_INPUT_FLEET_SUPER_AGENT
UNION ALL SELECT 'EVAL_INPUT_FLEET_OPS_AGENT', COUNT(*) FROM FLEET_INTELLIGENCE.EVALS.EVAL_INPUT_FLEET_OPS_AGENT
UNION ALL SELECT 'EVAL_INPUT_FLEET_ADMIN_AGENT', COUNT(*) FROM FLEET_INTELLIGENCE.EVALS.EVAL_INPUT_FLEET_ADMIN_AGENT;
