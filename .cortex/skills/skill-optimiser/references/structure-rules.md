# Skill Structure Rules

All rules extracted from "The Complete Guide to Building Skills for Claude" (Anthropic, Jan 2026).

## File Structure

```
your-skill-name/
├── SKILL.md              # Required - main skill file
├── scripts/              # Optional - executable code
│   ├── process_data.py
│   └── validate.sh
├── references/           # Optional - documentation loaded as needed
│   ├── api-guide.md
│   └── examples/
└── assets/               # Optional - templates, fonts, icons
    └── report-template.md
```

## Critical Naming Rules

### SKILL.md
- Must be exactly `SKILL.md` (case-sensitive)
- No variations: `SKILL.MD`, `skill.md`, `Skill.md` are all WRONG

### Skill Folder
- Use **kebab-case**: `notion-project-setup`
- No spaces: `Notion Project Setup` is WRONG
- No underscores: `notion_project_setup` is WRONG
- No capitals: `NotionProjectSetup` is WRONG
- Folder name must match the `name` field in YAML frontmatter

### No README.md
- Do NOT include `README.md` inside the skill folder
- All documentation goes in `SKILL.md` or `references/`
- Repo-level README for human visitors is separate (outside skill folder)

## YAML Frontmatter

### Required Format
```yaml
---
name: your-skill-name
description: What it does. Use when user asks to [specific phrases].
---
```

### Required Fields

**name** (required):
- kebab-case only
- No spaces or capitals
- Must match folder name

**description** (required):
- MUST include BOTH: what the skill does AND when to use it (trigger conditions)
- Under 1024 characters
- No XML tags (< or >)
- Include specific tasks users might say
- Mention file types if relevant

### Optional Fields

**license** (optional):
- Use if making skill open source
- Common values: `MIT`, `Apache-2.0`

**compatibility** (optional):
- 1-500 characters
- Indicates environment requirements (intended product, required system packages, network access)

**allowed-tools** (optional):
- Restrict tool access: `"Bash(python:*) Bash(npm:*) WebFetch"`

**metadata** (optional):
- Any custom key-value pairs
- Suggested: `author`, `version`, `mcp-server`, `category`, `tags`

Example:
```yaml
metadata:
  author: Company Name
  version: 1.0.0
  mcp-server: server-name
  category: productivity
  tags: [project-management, automation]
```

## Security Restrictions

### Forbidden in Frontmatter
- XML angle brackets (< >) - frontmatter appears in system prompt; malicious content could inject instructions
- Code execution in YAML (uses safe YAML parsing)
- Skills named with "claude" or "anthropic" prefix (reserved)

### Allowed
- Any standard YAML types (strings, numbers, booleans, lists, objects)
- Custom metadata fields
- Long descriptions (up to 1024 characters)

## Progressive Disclosure (Three-Level System)

### Level 1: YAML Frontmatter
- **Always loaded** in system prompt
- Provides just enough info for triggering decisions
- Keep minimal: name + description + metadata

### Level 2: SKILL.md Body
- Loaded when skill is **deemed relevant** to current task
- Contains full instructions and guidance
- Keep under **5,000 words**

### Level 3: Linked Files (references/, scripts/, assets/)
- Loaded **on demand** when explicitly referenced
- Detailed docs, API patterns, templates, validation scripts
- Use for anything that would bloat SKILL.md

## Core Design Principles

### Composability
- Skills can load simultaneously; don't assume your skill is the only one
- Design for coexistence with other skills

### Portability
- Skills work across Claude.ai, Claude Code, and API
- Create once, works everywhere (if environment supports dependencies)

## Size Guidelines
- SKILL.md body: under 5,000 words
- Move detailed documentation to `references/`
- Link to references instead of inlining
- If more than 20-50 skills enabled simultaneously, recommend selective enablement
