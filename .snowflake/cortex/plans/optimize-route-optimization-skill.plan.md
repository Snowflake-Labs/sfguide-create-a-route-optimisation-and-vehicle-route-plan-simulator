# Plan: Optimize route-optimization Skill

## Problem

[`.cortex/skills/route-optimization/SKILL.md`](.cortex/skills/route-optimization/SKILL.md) is 3,378 words — the largest skill in the repo. While technically under 5,000 words, it violates progressive disclosure best practices by inlining:
- Verbose SQL blocks (Steps 1, 4, 5, 6, 8)
- Detailed notebook cell-by-cell editing instructions (Steps 6.2-6.3, 8.1-8.2)
- Streamlit deployment with landmark lookup tables (Step 9)
- Industry customization reference with full SQL examples (~120 words)
- Extended troubleshooting table

## Target

Reduce SKILL.md body to ~1,200-1,500 words by keeping the workflow skeleton (step summaries, goals, outputs, stopping points) inline and extracting all verbose detail to `references/`.

## Extraction Plan

### Reference File 1: `references/sql-setup.md`
Extract from Steps 1, 2, 4, 5:
- Query tag SQL
- SHOW SERVICES / ALTER SERVICE SQL
- Marketplace acquisition SQL
- CREATE DATABASE / SCHEMA / WAREHOUSE SQL

### Reference File 2: `references/notebook-deployment.md`
Extract from Steps 6, 7, 8:
- Geohash lookup table and calculation SQL
- Notebook cell editing rules (8.1.1 text replacement rules)
- Cell-by-cell update tables (Steps 6.2, 8.2)
- Post-replacement validation checks (8.2.1)
- Upload/create notebook SQL and bash commands
- Claude model check instructions

### Reference File 3: `references/streamlit-deployment.md`
Extract from Step 9:
- Landmark lookup table
- Stage creation SQL
- `snow stage copy` commands
- CREATE STREAMLIT SQL
- Config auto-detection note

### Reference File 4: `references/industry-customization.md`
Extract from "Industry Customization Reference" section:
- Default industries table
- Custom industry field specifications
- Example SQL (Beverages, Electronics)
- Discovering available categories SQL

## Slimmed SKILL.md Structure

```markdown
# Deploy Route Optimization Demo
1-2 sentence summary.

## Prerequisites
- ORS Native App deployed and activated
- Active Snowflake connection

## Execution Rules
1. All snow stage copy commands use --connection <ACTIVE_CONNECTION>
2. Never use bulk sed/replace_all on .ipynb files
3. Replace longer phrases before shorter ones in notebook edits

## Workflow
### Step 1: Set Query Tag
Goal + "See references/sql-setup.md"

### Step 2: Verify ORS Services
Goal + brief check + "See references/sql-setup.md for service resume SQL"

### Step 3: Read ORS Config & Gather Preferences
(Keep inline — this is interactive, needs full context)

### Step 4: Get Carto Overture Dataset
Goal + "See references/sql-setup.md"

### Step 5: Setup Snowflake Objects
Goal + "See references/sql-setup.md"

### Step 6: Deploy Carto Data Notebook
Goal + summary + "See references/notebook-deployment.md"

### Step 7: Check Claude Model
Goal + summary + "See references/notebook-deployment.md"

### Step 8: Deploy AISQL Notebook
Goal + summary + "See references/notebook-deployment.md"

### Step 9: Deploy Streamlit App
Goal + summary + "See references/streamlit-deployment.md"

### Step 10: Run the Demo
(Keep inline — brief user-facing instructions)

## Industry Customization
Brief note + "See references/industry-customization.md"

## Stopping Points
(Keep inline — concise list)

## Troubleshooting
(Keep inline — compact table, already well-structured)

## Recovery
(Keep inline — 4-line note)

## Output
(Keep inline — final summary + URL SQL)
```

## Validation Checklist (from skill-optimiser)
1. Folder name: `route-optimization` (kebab-case) -- ok
2. File name: `SKILL.md` -- ok
3. No README.md inside skill folder -- ok
4. YAML frontmatter: name matches folder, description has WHAT + WHEN + triggers -- ok
5. No XML angle brackets -- ok
6. Description under 1024 chars -- verify
7. Body under 5,000 words -- target ~1,500
8. Instructions specific and actionable -- keep step goals/outputs
9. Error handling included -- keep troubleshooting table
10. Progressive disclosure -- references/ for all verbose content
