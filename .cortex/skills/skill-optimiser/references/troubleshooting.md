# Troubleshooting Guide

Common skill issues and their solutions, extracted from "The Complete Guide to Building Skills for Claude" (Anthropic, Jan 2026).

## Skill Won't Upload

### Error: "Could not find SKILL.md in uploaded folder"
**Cause**: File not named exactly `SKILL.md`
**Solution**:
- Rename to `SKILL.md` (case-sensitive)
- Verify with: `ls -la` should show `SKILL.md`

### Error: "Invalid frontmatter"
**Cause**: YAML formatting issue

Common mistakes:
```yaml
# WRONG - missing delimiters
name: my-skill
description: Does things

# WRONG - unclosed quotes
---
name: my-skill
description: "Does things
---

# CORRECT
---
name: my-skill
description: Does things
---
```

### Error: "Invalid skill name"
**Cause**: Name has spaces or capitals
```yaml
# WRONG
name: My Cool Skill

# CORRECT
name: my-cool-skill
```

## Skill Doesn't Trigger (Undertriggering)

**Symptom**: Skill never loads automatically.

**Diagnostic**: Ask the model: "When would you use the [skill name] skill?" It will quote the description back. Adjust based on what's missing.

**Quick checklist**:
- Is description too generic? ("Helps with projects" won't work)
- Does it include trigger phrases users would actually say?
- Does it mention relevant file types if applicable?
- Are technical terms/keywords included?

**Fix**: Add more detail, keywords, and trigger phrases to the description field.

## Skill Triggers Too Often (Overtriggering)

**Symptom**: Skill loads for unrelated queries.

**Solutions**:

1. **Add negative triggers**:
```yaml
description: Advanced data analysis for CSV files. Use for statistical
  modeling, regression, clustering. Do NOT use for simple data exploration
  (use data-viz skill instead).
```

2. **Be more specific**:
```yaml
# Too broad
description: Processes documents

# More specific
description: Processes PDF legal documents for contract review
```

3. **Clarify scope**:
```yaml
description: PayFlow payment processing for e-commerce. Use specifically
  for online payment workflows, not for general financial queries.
```

## MCP Connection Issues

**Symptom**: Skill loads but MCP calls fail.

**Checklist**:
1. Verify MCP server is connected (Settings > Extensions > [Service])
2. Check authentication (API keys valid, proper permissions, OAuth tokens refreshed)
3. Test MCP independently: "Use [Service] MCP to fetch my projects" - if this fails, issue is MCP not skill
4. Verify tool names are correct (case-sensitive)

## Instructions Not Followed

**Symptom**: Skill loads but the model doesn't follow instructions.

**Common causes and fixes**:

1. **Instructions too verbose**:
   - Keep instructions concise
   - Use bullet points and numbered lists
   - Move detailed reference to separate files in `references/`

2. **Instructions buried**:
   - Put critical instructions at the top
   - Use `## Important` or `## Critical` headers
   - Repeat key points if needed

3. **Ambiguous language**:
   ```
   # BAD
   Make sure to validate things properly

   # GOOD
   CRITICAL: Before calling create_project, verify:
   - Project name is non-empty
   - At least one team member assigned
   - Start date is not in the past
   ```

4. **Model skipping steps**: Add explicit encouragement in user prompts (more effective than in SKILL.md):
   ```
   - Take your time to do this thoroughly
   - Quality is more important than speed
   - Do not skip validation steps
   ```

## Large Context Issues

**Symptom**: Skill seems slow or responses degraded.

**Causes**:
- Skill content too large
- Too many skills enabled simultaneously
- All content loaded instead of progressive disclosure

**Solutions**:
1. Optimize SKILL.md size:
   - Move detailed docs to `references/`
   - Link to references instead of inlining
   - Keep SKILL.md under 5,000 words

2. Reduce enabled skills:
   - Evaluate if more than 20-50 skills enabled simultaneously
   - Recommend selective enablement
   - Consider skill "packs" for related capabilities

## Iteration Signals Summary

| Signal | Type | Solution |
|--------|------|----------|
| Skill doesn't load when it should | Undertriggering | Add keywords and detail to description |
| Users manually enabling it | Undertriggering | Add trigger phrases |
| Skill loads for irrelevant queries | Overtriggering | Add negative triggers, be more specific |
| Users disabling it | Overtriggering | Narrow scope in description |
| Inconsistent results | Execution | Improve instructions, add validation |
| API call failures | Execution | Add error handling, verify tool names |
| User corrections needed | Execution | Make instructions more specific |
