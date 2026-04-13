# Skill Patterns and Categories

Patterns and categories extracted from "The Complete Guide to Building Skills for Claude" (Anthropic, Jan 2026).

## Three Skill Categories

### Category 1: Document and Asset Creation

**Used for**: Creating consistent, high-quality output including documents, presentations, apps, designs, code.

**Key techniques**:
- Embedded style guides and brand standards
- Template structures for consistent output
- Quality checklists before finalizing
- No external tools required - uses built-in capabilities

**Example**: frontend-design skill
```
"Create distinctive, production-grade frontend interfaces with high design
quality. Use when building web components, pages, artifacts, posters, or
applications."
```

### Category 2: Workflow Automation

**Used for**: Multi-step processes that benefit from consistent methodology, including coordination across multiple MCP servers.

**Key techniques**:
- Step-by-step workflow with validation gates
- Templates for common structures
- Built-in review and improvement suggestions
- Iterative refinement loops

**Example**: skill-creator skill
```
"Interactive guide for creating new skills. Walks the user through use case
definition, frontmatter generation, instruction writing, and validation."
```

### Category 3: MCP Enhancement

**Used for**: Workflow guidance to enhance the tool access an MCP server provides.

**Key techniques**:
- Coordinates multiple MCP calls in sequence
- Embeds domain expertise
- Provides context users would otherwise need to specify
- Error handling for common MCP issues

**Example**: sentry-code-review skill (from Sentry)
```
"Automatically analyzes and fixes detected bugs in GitHub Pull Requests using
Sentry's error monitoring data via their MCP server."
```

## Five Implementation Patterns

### Pattern 1: Sequential Workflow Orchestration

**Use when**: Multi-step processes in a specific order.

```markdown
## Workflow: Onboard New Customer

### Step 1: Create Account
Call MCP tool: `create_customer`
Parameters: name, email, company

### Step 2: Setup Payment
Call MCP tool: `setup_payment_method`
Wait for: payment method verification

### Step 3: Create Subscription
Call MCP tool: `create_subscription`
Parameters: plan_id, customer_id (from Step 1)

### Step 4: Send Welcome Email
Call MCP tool: `send_email`
Template: welcome_email_template
```

**Key techniques**: Explicit step ordering, dependencies between steps, validation at each stage, rollback instructions for failures.

### Pattern 2: Multi-MCP Coordination

**Use when**: Workflows span multiple services.

```markdown
### Phase 1: Design Export (Figma MCP)
1. Export design assets from Figma
2. Generate design specifications
3. Create asset manifest

### Phase 2: Asset Storage (Drive MCP)
1. Create project folder in Drive
2. Upload all assets
3. Generate shareable links

### Phase 3: Task Creation (Linear MCP)
1. Create development tasks
2. Attach asset links to tasks
3. Assign to engineering team
```

**Key techniques**: Clear phase separation, data passing between MCPs, validation before moving to next phase, centralized error handling.

### Pattern 3: Iterative Refinement

**Use when**: Output quality improves with iteration.

```markdown
## Iterative Report Creation

### Initial Draft
1. Fetch data via MCP
2. Generate first draft report
3. Save to temporary file

### Quality Check
1. Run validation script: `scripts/check_report.py`
2. Identify issues

### Refinement Loop
1. Address each identified issue
2. Regenerate affected sections
3. Re-validate
4. Repeat until quality threshold met
```

**Key techniques**: Explicit quality criteria, iterative improvement, validation scripts, know when to stop iterating.

### Pattern 4: Context-Aware Tool Selection

**Use when**: Same outcome, different tools depending on context.

```markdown
## Smart File Storage

### Decision Tree
1. Check file type and size
2. Determine best storage location:
   - Large files (>10MB): Use cloud storage MCP
   - Collaborative docs: Use Notion/Docs MCP
   - Code files: Use GitHub MCP
   - Temporary files: Use local storage
```

**Key techniques**: Clear decision criteria, fallback options, transparency about choices.

### Pattern 5: Domain-Specific Intelligence

**Use when**: Skill adds specialized knowledge beyond tool access.

```markdown
## Payment Processing with Compliance

### Before Processing (Compliance Check)
1. Fetch transaction details via MCP
2. Apply compliance rules
3. Document compliance decision

### Processing
IF compliance passed:
    - Process transaction
ELSE:
    - Flag for review
    - Create compliance case

### Audit Trail
- Log all compliance checks
- Record processing decisions
```

**Key techniques**: Domain expertise embedded in logic, compliance before action, comprehensive documentation, clear governance.

## Choosing Your Approach

- **Problem-first**: "I need to set up a project workspace" - Skill orchestrates the right MCP calls. Users describe outcomes; skill handles tools.
- **Tool-first**: "I have Notion MCP connected" - Skill teaches optimal workflows. Users have access; skill provides expertise.

## Use Case Definition Template

```
Use Case: [Name]
Trigger: User says "[phrase 1]" or "[phrase 2]"
Steps:
  1. [First action]
  2. [Second action]
  3. [Third action]
Result: [Expected outcome]
```

## Success Criteria

### Quantitative
- Skill triggers on ~90% of relevant queries
- Completes workflow in X tool calls (compare with vs without skill)
- 0 failed API calls per workflow

### Qualitative
- Users don't need to prompt about next steps
- Workflows complete without user correction
- Consistent results across sessions
