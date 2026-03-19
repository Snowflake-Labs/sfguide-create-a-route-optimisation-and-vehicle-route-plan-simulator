# Skill Execution Logs

This directory collects error and issue reports from skill executions. Logs help improve skills by capturing real-world failures, unexpected states, and workarounds.

## When to Log

Log an entry whenever a skill execution encounters:
- **SQL errors** — query compilation failures, runtime exceptions, permission denied
- **Missing objects** — table/view/schema/database/stage not found when expected
- **Unexpected data** — 0 rows returned, NULL columns, wrong row counts, data type mismatches
- **Service failures** — ORS services not starting, health checks failing, SPCS container errors
- **Deployment failures** — Docker build errors, image push failures, stage upload errors, Streamlit deployment issues
- **Workarounds applied** — any time you had to deviate from the documented steps to make something work
- **Ambiguous instructions** — steps in the SKILL.md that were unclear, missing, or contradictory

## Log File Format

One file per skill execution. **File name:** `{skill-name}_{YYYY-MM-DD}_{HH-MM}.md`

Example: `fleet-intelligence-taxis_2026-03-19_14-30.md`

### Template

```markdown
# {Skill Name} — Execution Log

- **Date:** {YYYY-MM-DD HH:MM}
- **Skill:** {skill-name}
- **Connection:** {snowflake connection name}
- **Role:** {current role}
- **Warehouse:** {current warehouse}
- **Outcome:** {COMPLETED_WITH_ISSUES | FAILED | COMPLETED_WITH_WORKAROUNDS}

## Issues

### Issue 1: {Short title}

- **Step:** {Step number/name from SKILL.md}
- **Severity:** {BLOCKER | ERROR | WARNING | INFO}
- **Category:** {SQL_ERROR | MISSING_OBJECT | UNEXPECTED_DATA | SERVICE_FAILURE | DEPLOYMENT_FAILURE | PERMISSION_ERROR | DOCS_GAP | WORKAROUND}

**What happened:**
{Description of the issue}

**SQL/Command that failed:**
```sql
{The exact SQL or bash command}
```

**Error message:**
```
{The exact error message returned}
```

**Resolution:**
{How was it resolved, or "UNRESOLVED" if it blocked execution}

**Suggested fix:**
{What should change in the SKILL.md or reference files to prevent this}

---

### Issue 2: ...
```

## Severity Levels

| Level | Meaning |
|-------|---------|
| BLOCKER | Execution cannot continue, skill failed |
| ERROR | Step failed but was recoverable or skippable |
| WARNING | Unexpected state that didn't block but may indicate a problem |
| INFO | Minor issue or documentation improvement suggestion |

## Categories

| Category | Examples |
|----------|----------|
| SQL_ERROR | Syntax error, compilation failure, runtime exception |
| MISSING_OBJECT | Table/view/schema/database/function/stage not found |
| UNEXPECTED_DATA | 0 rows, NULL values, wrong counts, type mismatch |
| SERVICE_FAILURE | ORS health check fails, SPCS service won't start |
| DEPLOYMENT_FAILURE | Docker build fails, image push fails, Streamlit deploy fails |
| PERMISSION_ERROR | Insufficient privileges, role doesn't have access |
| DOCS_GAP | SKILL.md instructions unclear, missing, or wrong |
| WORKAROUND | Had to deviate from documented steps |
