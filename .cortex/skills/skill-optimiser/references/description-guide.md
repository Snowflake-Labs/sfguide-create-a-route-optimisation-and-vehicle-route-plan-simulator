# Writing Effective Descriptions

The description field is the single most important part of your skill. It determines whether your skill gets loaded at the right time.

## The Description Formula

```
[What it does] + [When to use it] + [Key capabilities] + [Negative triggers]
```

The description is the **first level of progressive disclosure** - it appears in the system prompt and provides just enough information for triggering decisions.

## Good Description Examples

### Specific and actionable
```yaml
description: Analyzes Figma design files and generates developer handoff
  documentation. Use when user uploads .fig files, asks for "design specs",
  "component documentation", or "design-to-code handoff".
```

### Includes trigger phrases
```yaml
description: Manages Linear project workflows including sprint planning,
  task creation, and status tracking. Use when user mentions "sprint",
  "Linear tasks", "project planning", or asks to "create tickets".
```

### Clear value proposition with negative triggers
```yaml
description: "Deploy the Route Deviation Analysis demo: load synthetic truck
  telemetry from S3, populate ORS route cache, run 5-step ETL pipeline, and
  deploy Streamlit dashboards. Use when: setting up route deviation demo,
  detour analytics, fleet deviation analysis. Do NOT use for: general fleet
  tracking, real-time GPS monitoring, or non-deviation routing tasks.
  Triggers: deploy route deviation, deploy detour analytics, setup
  deviation analysis, route deviation demo."
```

### End-to-end workflow
```yaml
description: End-to-end customer onboarding workflow for PayFlow. Handles
  account creation, payment setup, and subscription management. Use when user
  says "onboard new customer", "set up subscription", or "create PayFlow
  account".
```

## Bad Description Examples

### Too vague
```yaml
description: Helps with projects.
```
Problem: No specificity, no triggers. Will either never trigger or trigger on everything.

### Missing triggers
```yaml
description: Creates sophisticated multi-page documentation systems.
```
Problem: Says what it does but not WHEN to use it.

### Too technical, no user triggers
```yaml
description: Implements the Project entity model with hierarchical relationships.
```
Problem: Users don't talk this way. No trigger phrases.

## Rules

1. Under 1024 characters
2. No XML angle brackets (< or >)
3. Must include WHAT and WHEN
4. Include exact phrases users would say (trigger phrases)
5. Include negative triggers ("Do NOT use for...") to prevent overtriggering
6. Mention relevant file types if applicable
7. Include technical terms/keywords for discoverability

## Debugging Trigger Issues

Ask the model: "When would you use the [skill name] skill?" It will quote the description back. Adjust based on what's missing.

### Undertriggering Signals
- Skill doesn't load when it should
- Users manually enabling it
- Support questions about when to use it
- **Fix**: Add more keywords, trigger phrases, and detail to description

### Overtriggering Signals
- Skill loads for irrelevant queries
- Users disabling it
- Confusion about purpose
- **Fix**: Add negative triggers ("Do NOT use for..."), be more specific about scope
