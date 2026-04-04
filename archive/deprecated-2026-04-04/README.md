# Archived Code - 2026-04-04

Deprecated code moved here as part of the migration to a React-only architecture (ORS Control App).

## Contents

| Directory | What | Why Archived |
|-----------|------|--------------|
| `demo-dashboard-old-deprecated/` | Full deprecated React dashboard skill | Superseded by ORS Control App |
| `streamlit-artifacts/code_artifacts-streamlit/` | Streamlit routing service manager source | Replaced by React control app |
| `streamlit-artifacts/output-deploy/` | Generated deployment bundle with Streamlit | Stale build artifact; deploy.sh reads from source dirs |
| `deprecated-references/streamlit-deployment.md` | Streamlit deployment guide | Streamlit UI replaced by React |
| `deprecated-references/native-app-deployment.md` | FLEET_INTEL_APP deployment guide | 2 generations old (replaced by demo-dashboard, then ORS Control App) |
| `standalone-scripts/route_cache_batch.py` | One-off batch script for ROUTE_CACHE table | Hardcoded DB/schema, not part of any skill workflow |
| `standalone-scripts/eval_skill.py` | Per-skill eval runner | Redundant with centralized evals framework |
| `logs-and-plans/logs/` | Dated error/execution logs from 2026-03-24 | Historical diagnostic artifacts |
| `logs-and-plans/plans/` | 30 Cortex Code generated plan files | Historical planning artifacts |
| `historical-reports/docs-dev/` | Audit reports, eval reports, infra docs | Point-in-time reports, issues resolved |
| `historical-reports/eval-reports/` | Eval result JSONs from 2026-03-18/19 | Historical baselines |
