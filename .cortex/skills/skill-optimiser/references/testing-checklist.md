# Testing and Validation Checklist

Complete checklist from "The Complete Guide to Building Skills for Claude" Reference A.

## Before You Start

- [ ] Identified 2-3 concrete use cases
- [ ] Tools identified (built-in or MCP)
- [ ] Reviewed guide and example skills
- [ ] Planned folder structure

## During Development

- [ ] Folder named in kebab-case
- [ ] SKILL.md file exists (exact spelling, case-sensitive)
- [ ] YAML frontmatter has `---` delimiters
- [ ] `name` field: kebab-case, no spaces, no capitals, matches folder name
- [ ] `description` includes WHAT and WHEN
- [ ] No XML tags (< >) anywhere in frontmatter
- [ ] No "claude" or "anthropic" in skill name
- [ ] Instructions are clear and actionable
- [ ] Error handling included
- [ ] Examples provided
- [ ] References clearly linked (not inlined)
- [ ] SKILL.md body under 5,000 words
- [ ] No README.md inside skill folder

## Before Upload

- [ ] Tested triggering on obvious tasks
- [ ] Tested triggering on paraphrased requests
- [ ] Verified doesn't trigger on unrelated topics
- [ ] Functional tests pass
- [ ] Tool integration works (if applicable)
- [ ] Compressed as .zip file (for Claude.ai upload)

## After Upload

- [ ] Test in real conversations
- [ ] Monitor for under/over-triggering
- [ ] Collect user feedback
- [ ] Iterate on description and instructions
- [ ] Update version in metadata

## Testing Approaches

### Manual Testing (Claude.ai)
Run queries directly and observe behavior. Fast iteration, no setup required.

### Scripted Testing (Claude Code)
Automate test cases for repeatable validation across changes.

### Programmatic Testing (API)
Build evaluation suites that run systematically against defined test sets.

## Three Testing Areas

### 1. Triggering Tests

**Goal**: Ensure skill loads at the right times.

```
Should trigger:
- "Help me set up a new ProjectHub workspace"
- "I need to create a project in ProjectHub"
- "Initialize a ProjectHub project for Q4 planning"

Should NOT trigger:
- "What's the weather in San Francisco?"
- "Help me write Python code"
- "Create a spreadsheet"
```

### 2. Functional Tests

**Goal**: Verify correct outputs.

```
Test: Create project with 5 tasks
Given: Project name "Q4 Planning", 5 task descriptions
When: Skill executes workflow
Then:
  - Project created in ProjectHub
  - 5 tasks created with correct properties
  - All tasks linked to project
  - No API errors
```

### 3. Performance Comparison

**Goal**: Prove skill improves results vs. baseline.

```
Without skill:
- User provides instructions each time
- 15 back-and-forth messages
- 3 failed API calls requiring retry
- 12,000 tokens consumed

With skill:
- Automatic workflow execution
- 2 clarifying questions only
- 0 failed API calls
- 6,000 tokens consumed
```

## Pro Tip

Iterate on a single challenging task until it succeeds, then extract the winning approach into a skill. This leverages in-context learning and provides faster signal than broad testing.
