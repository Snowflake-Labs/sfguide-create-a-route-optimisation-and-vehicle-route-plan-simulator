# Plan: Subagent Audit Sweep — All 13 Skills

## Approach

Launch read-only subagents in batches to audit every skill. Each subagent receives a detailed prompt with the skill-optimiser checklist and returns a structured report. Results are consolidated into a single audit report.

## Audit Dimensions (per skill)

1. **Structure compliance**: folder name, SKILL.md exists, no README.md, YAML frontmatter valid, name matches folder, description under 1024 chars, body under 5000 words
2. **Description quality**: has WHAT + WHEN + DO NOT USE + Triggers, no XML brackets, specific trigger phrases
3. **Instruction quality**: specific/actionable steps, error handling, stopping points, progressive disclosure (references/ used where needed)
4. **Cross-references**: all file paths in SKILL.md and references/ point to files that actually exist (e.g., `assets/streamlit/`, `references/sql-pipeline.md`)
5. **SQL validation**: compile-check all SQL blocks against Snowflake (using `only_compile=true`)
6. **Trigger matching**: test 2-3 sample user prompts per skill to verify the description would match correctly

## Batching Strategy

Subagents run sequentially, so we batch by related skills to maximize efficiency:

- **Batch 1** (3 skills): `build-routing-solution`, `routing-prerequisites`, `routing-customization` (core infra)
- **Batch 2** (3 skills): `route-optimization`, `route-deviation`, `retail-catchment` (demo solutions)
- **Batch 3** (3 skills): `fleet-intelligence-taxis`, `fleet-intelligence-food-delivery`, `dwell-analysis` (fleet demos)
- **Batch 4** (3 skills): `travel-time-matrix`, `smart-detour-generation`, `routing-agent` (advanced)
- **Batch 5** (1 skill): `skill-optimiser` (meta)

Each batch is a single subagent that audits 3 skills and returns structured results.

## Output

A consolidated markdown report at `.cortex/skills/AUDIT-REPORT.md` with:
- Pass/fail per skill per dimension
- Specific issues found with file paths and line numbers
- Recommended fixes prioritized by severity (blocking vs. cosmetic)

## Post-Audit

After the audit report, we fix all issues found, then proceed to interactive deployment testing skill-by-skill in dependency order:
1. `build-routing-solution` (foundation)
2. `routing-customization` (needed by most demos)
3. `route-optimization` (simplest demo)
4. ... remaining skills
