# Writing Effective Instructions

Best practices for the SKILL.md body content (the markdown after the YAML frontmatter).

## Recommended SKILL.md Structure

```markdown
---
name: your-skill
description: [...]
---

# Your Skill Name

Brief 1-2 sentence description of what this skill does end-to-end.

## Prerequisites / Important

CRITICAL items the user must verify before starting.

## Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|
| ...       | ...     | ...         |

## Execution Rules

Numbered list of non-negotiable rules for this skill.

## Workflow

### Step 1: [First Major Step]
Clear explanation of what happens.

Example:
  ```bash
  python scripts/fetch_data.py --project-id PROJECT_ID
  ```
Expected output: [describe what success looks like]

### Step 2: [...]
(continue for each step)

## Examples

### Example 1: [Common scenario]
User says: "..."
Actions:
1. ...
2. ...
Result: ...

## Troubleshooting

### Error: [Common error message]
**Cause**: [Why it happens]
**Solution**: [How to fix]
```

## Best Practice: Be Specific and Actionable

### Good
```
Run `python scripts/validate.py --input {filename}` to check data format.
If validation fails, common issues include:
- Missing required fields (add them to the CSV)
- Invalid date formats (use YYYY-MM-DD)
```

### Bad
```
Validate the data before proceeding.
```

## Best Practice: Include Error Handling

```markdown
## Common Issues

### MCP Connection Failed
If you see "Connection refused":
1. Verify MCP server is running: Check Settings > Extensions
2. Confirm API key is valid
3. Try reconnecting: Settings > Extensions > [Your Service] > Reconnect
```

## Best Practice: Reference Bundled Resources Clearly

```markdown
Before writing queries, consult `references/api-patterns.md` for:
- Rate limiting guidance
- Pagination patterns
- Error codes and handling
```

## Best Practice: Use Progressive Disclosure

- Keep SKILL.md focused on core instructions
- Move detailed documentation to `references/`
- Link to references instead of inlining
- Keep SKILL.md under 5,000 words

## Best Practice: Put Critical Instructions at the Top

- Use `## Important` or `## Critical` headers
- Place non-negotiable rules near the top of the document
- Repeat key points if needed for emphasis

## Best Practice: Avoid Ambiguous Language

### Bad
```
Make sure to validate things properly
```

### Good
```
CRITICAL: Before calling create_project, verify:
- Project name is non-empty
- At least one team member assigned
- Start date is not in the past
```

## Advanced: Use Scripts for Critical Validations

For critical validations, consider bundling a script (in `scripts/`) that performs checks programmatically rather than relying on language instructions. Code is deterministic; language interpretation isn't.

## Handling Model "Laziness"

If the model skips steps, add explicit encouragement (more effective in user prompts than in SKILL.md):

```markdown
## Performance Notes
- Take your time to do this thoroughly
- Quality is more important than speed
- Do not skip validation steps
```

## Instructions Not Followed: Common Causes

1. **Instructions too verbose**: Keep concise, use bullet points and numbered lists, move details to references
2. **Instructions buried**: Put critical instructions at the top, use ## Important headers
3. **Ambiguous language**: Replace vague directives with specific, verifiable conditions
4. **Missing context**: Provide enough information for the model to make correct decisions
