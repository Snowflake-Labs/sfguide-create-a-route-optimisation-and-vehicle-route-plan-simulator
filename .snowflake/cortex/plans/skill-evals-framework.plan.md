# Plan: Skill Evals Framework

## Overview

Create a reusable evaluation framework at `.cortex/skills/evals/` that validates all 16 skills across three dimensions: **trigger matching**, **quality audit**, and **cross-reference integrity**. The framework should be runnable via a single Python command and produce a structured pass/fail report.

## Directory Structure

```
.cortex/skills/evals/
├── config.yaml                    # Global config: thresholds, scoring weights
├── run_evals.py                   # Main runner script
├── lib/
│   ├── trigger_eval.py            # Trigger-matching evaluator
│   ├── quality_eval.py            # Quality-audit evaluator (11-point checklist)
│   └── xref_eval.py              # Cross-reference integrity evaluator
├── test-cases/
│   ├── triggers.yaml              # All trigger test cases (per-skill)
│   └── quality-overrides.yaml     # Per-skill quality exceptions (e.g., "C4 KEPT")
└── reports/
    └── baseline-2026-03-18.json   # Baseline eval results
```

## Eval Types

### 1. Trigger Matching (`triggers.yaml`)
For each skill, define:
- `should_trigger`: 3-5 prompts that SHOULD activate this skill
- `should_not_trigger`: 2-3 prompts that should NOT activate this skill
- `should_not_trigger_to`: prompts that should go to a DIFFERENT specific skill (cross-skill confusion tests)

Evaluation: Parse each skill's `description` field from YAML frontmatter. Check that trigger keywords from `should_trigger` appear in the description. Check that `should_not_trigger` keywords do NOT appear. This is static analysis — no LLM calls needed.

### 2. Quality Audit (`quality_eval.py`)
Encodes the 11-point audit checklist from skill-optimiser:
1. Folder name: kebab-case
2. File name: exactly `SKILL.md`
3. No README.md inside skill folder
4. YAML frontmatter: `---` delimiters, `name` matches folder
5. No XML angle brackets in frontmatter
6. Description under 1024 chars, includes WHAT + WHEN + triggers
7. Body under 5,000 words
8. Instructions are specific and actionable (heuristic: no vague phrases)
9. Error handling section exists
10. Examples or stopping points provided
11. Progressive disclosure: references linked, not inlined (body word count vs references/ file count ratio)

Scoring: Each check = pass/fail. Total score = X/11. Threshold for "green" = 9/11.

### 3. Cross-Reference Integrity (`xref_eval.py`)
- Every file in `references/` is linked from SKILL.md body
- Every `references/foo.md` link in SKILL.md body resolves to an actual file
- No duplicate metadata (e.g., config.yaml duplicating frontmatter)
- Sister-skill references in `Do NOT use for` point to existing skills
- Subskill folders match router's dispatch list

## Runner (`run_evals.py`)

```
python .cortex/skills/evals/run_evals.py [--skill <name>] [--type trigger|quality|xref] [--verbose]
```

- Discovers all skills via glob `**/SKILL.md`
- Runs selected eval types against selected skills (default: all)
- Outputs summary table + detailed JSON report
- Exit code 0 if all pass, 1 if any failures

## Per-Skill Trigger Test Cases (16 skills)

Each skill gets 3-5 should-trigger and 2-3 should-not-trigger prompts derived from:
- The `Triggers:` list in the description
- The `Do NOT use for:` list
- Common paraphrases and edge cases

## Baseline Run

After building the framework, run it once against the current (fully-audited) skill set. The results become the baseline stored in `reports/baseline-2026-03-18.json`. Future changes can be compared against this baseline.
