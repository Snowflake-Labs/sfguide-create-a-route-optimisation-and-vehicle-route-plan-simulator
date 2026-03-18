---
name: skill-optimiser
description: "Optimize, audit, create, and improve Cortex Code skills following official best practices from the Anthropic skill-building guide. Use when: creating a new skill, reviewing an existing skill, optimizing skill description or triggers, improving SKILL.md structure, auditing skill quality, fixing undertriggering or overtriggering, restructuring skill for progressive disclosure. Do NOT use for: general code review, non-skill markdown editing, MCP server development. Triggers: optimize skill, audit skill, review skill, create skill, improve skill, fix skill triggers, skill best practices, skill quality check."
metadata:
  author: Snowflake SIT-IS
  version: 1.0.0
  category: developer-tools
  source: "The Complete Guide to Building Skills for Claude (Anthropic, Jan 2026)"
---

# Skill Optimiser

Comprehensive guide for creating, auditing, and optimizing skills following official Anthropic best practices. This skill encodes all rules, patterns, and checklists from "The Complete Guide to Building Skills for Claude" (33-page PDF, January 2026).

## Important

Before making any changes to a skill, READ the existing SKILL.md fully. Understand its current structure before applying optimizations.

## Workflow

### 1. Determine the Task

Identify which operation the user needs:
- **Create**: Build a new skill from scratch
- **Audit**: Review an existing skill for compliance with best practices
- **Optimize**: Improve an existing skill's triggering, structure, or instructions
- **Fix**: Address a specific issue (undertriggering, overtriggering, instructions not followed)

### 2. Gather Context

- Read the target skill's SKILL.md (if it exists)
- Identify the skill category (see `references/patterns.md` > Skill Categories)
- List all files in the skill folder to understand its structure

### 3. Apply Best Practices

Consult the reference files for detailed guidance:
- `references/structure-rules.md` for file structure, naming, and YAML frontmatter rules
- `references/description-guide.md` for writing effective descriptions and trigger phrases
- `references/instructions-guide.md` for writing effective SKILL.md body content
- `references/patterns.md` for skill categories and implementation patterns
- `references/testing-checklist.md` for the complete validation checklist
- `references/troubleshooting.md` for diagnosing and fixing common issues

### 4. Validate Changes

After making changes, run through the quick checklist in `references/testing-checklist.md` to ensure compliance.

## Audit Procedure

When auditing an existing skill, check these in order:

1. **Folder name**: kebab-case, no spaces/capitals/underscores
2. **File name**: Exactly `SKILL.md` (case-sensitive)
3. **No README.md** inside the skill folder
4. **YAML frontmatter**: Has `---` delimiters, `name` matches folder, `description` includes WHAT + WHEN + triggers
5. **No XML angle brackets** in frontmatter
6. **Description under 1024 characters**
7. **SKILL.md body under 5,000 words** (move excess to `references/`)
8. **Instructions are specific and actionable** (no vague "validate things properly")
9. **Error handling included** for common failure modes
10. **Examples provided** for key workflows
11. **Progressive disclosure**: detailed docs in `references/`, not inline

## Quick Reference: Description Formula

```
[What it does] + [When to use it] + [Key capabilities/triggers] + [Negative triggers]
```

Good example:
```
description: "Deploy the Route Deviation Analysis demo: load synthetic truck
telemetry from S3, populate ORS route cache, run 5-step ETL pipeline, and
deploy Streamlit dashboards. Use when: setting up route deviation demo, detour
analytics, fleet deviation analysis. Do NOT use for: general fleet tracking,
real-time GPS monitoring, or non-deviation routing tasks. Triggers: deploy
route deviation, deploy detour analytics, setup deviation analysis."
```

Bad examples:
- "Helps with projects." (too vague)
- "Creates sophisticated multi-page documentation systems." (missing triggers)
- "Implements the Project entity model with hierarchical relationships." (too technical, no user triggers)

## Quick Reference: SKILL.md Body Template

```markdown
# Skill Title

Brief 1-2 sentence summary of what this skill does end-to-end.

## Prerequisites / Important

CRITICAL items that must be verified before starting.

## Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|

## Execution Rules

Numbered list of non-negotiable rules.

## Workflow

### Step 1: ...
### Step 2: ...

## Troubleshooting

### Error: [Common error]
Cause: ...
Solution: ...
```
