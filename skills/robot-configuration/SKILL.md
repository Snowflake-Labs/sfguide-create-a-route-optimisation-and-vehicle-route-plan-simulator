# Robot Configuration Skill

You are helping the user modify the robot/sensor fleet at an existing manufacturing plant. This skill handles resizing, renaming, re-purposing, and simulating scenarios.

## When to Use This Skill

Use when the user says things like:
- "Scale up robots at [plant]"
- "Rename the AGVs to something else"
- "What are the robots doing right now?"
- "Simulate a fire drill" / "Put all robots in emergency mode"
- "I need more inspection robots in the QC lab"
- "Change the robot activities to reflect a batch changeover"

## Step 1: Understand Current State

Before making changes, query the pharma_supply_chain semantic view to show:
- Current robot count by building and type at the target plant
- Current status distribution (how many moving/charging/error)
- Any robots with low battery or maintenance due

Present this as a summary table.

## Step 2: Determine What to Change

The user might want one or more of:

### A. Resize (change robot count)
- **Whole plant**: "Set Hudson Valley to 200 robots total"
- **Per building**: "Put 50 robots in the cold warehouse"
- **Per type in building**: "I need 30 AGVs in distribution"

**Sizing guidelines:**
| Plant Capacity | Recommended Robots |
|---|---|
| < 150 batches/month | 24-48 |
| 150-300 batches/month | 48-150 |
| 300-500 batches/month | 150-300 |
| > 500 batches/month | 300-600 |

### B. Rename (change what robots are called)
Pass a `robot_type_labels` object:
```json
{"AGV": "Autonomous Forklift", "INSPECT": "Vision System", "CLEAN": "UV Sterilizer"}
```

**Industry-specific naming suggestions:**
| Context | AGV name | INSPECT name | CLEAN name |
|---|---|---|---|
| Pharma default | Transport AGV | Inspection Robot | Cleaning Robot |
| Warehouse/logistics | Pallet Mover | Inventory Scanner | Floor Scrubber |
| Biologics | Bioreactor Shuttle | Culture Monitor | Containment Cleaner |
| Food/beverage | Ingredient Shuttle | Quality Scanner | Sanitization Bot |
| Electronics | Component Carrier | AOI Inspector | ESD Cleaner |
| Automotive | Parts Shuttle | Weld Inspector | Paint Booth Cleaner |

### C. Change Activities (what robots are currently doing)
Pass a `status_descriptions` object mapping old → new status:
```json
{"moving": "Delivering batch ONC-042 to fill line 3", "charging": "Rapid charge — next task in 8 min"}
```

Or set ALL robots in scope to the same activity:
```json
{"all": "EMERGENCY STOP — contamination alert in Zone C"}
```

**Scenario presets the user might request:**
| Scenario | Status to apply |
|---|---|
| Normal operations | Use defaults (moving/charging/error) |
| Batch changeover | "Clearing line for product changeover" |
| Fire drill / evacuation | "Emergency halt — evacuation in progress" |
| Maintenance window | "Scheduled maintenance — offline until 06:00" |
| Peak production | "High-priority batch delivery — express mode" |
| Contamination alert | "LOCKDOWN — containment protocol active" |
| Shift change | "Returning to charging bay — shift handover" |

## Step 3: Confirm & Execute

Present the planned changes in a clear summary:
```
Plant: Hudson Valley Site
Scope: cold warehouse, AGV only
Changes:
  - Count: 4 → 50
  - Label: "Transport AGV" → "Cryo-Logistics Bot"  
  - Activity: "moving" → "Shuttling vaccine vials to -70C storage"
```

Ask: "Shall I apply these changes?"

Then call TOOL_ALTER_PLANT with the appropriate parameters. You can combine resize + rename + status in a single call.

## Step 4: Verify

After applying, query pharma_supply_chain to confirm:
- New robot counts match expectations
- Labels are updated
- Statuses reflect the new activities

If anything doesn't look right, offer to fix it.

## Important Rules

- NEVER resize without confirming with the user first
- When renaming, always show before/after
- For emergency scenarios (fire drill, contamination), apply immediately without asking — time matters
- If the user asks to "reset" or "go back to normal", resize to the standard fleet (24 per plant) with default labels and statuses
- Building roles are fixed: api, form, cold, qc, util, dist — you cannot add new ones
- Robot types are fixed: AGV, INSPECT, CLEAN — but their LABELS can be anything
