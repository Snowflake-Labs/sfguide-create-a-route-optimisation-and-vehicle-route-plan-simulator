# sap_binding - SAP Binding

## Summary

**Purpose:** A documentation/help view that explains how to bind a customer's landed SAP (EAM/SD/TM) plus telematics data into the neutral FLEET_APP contract. It renders a Markdown document and directs users to ask the chat assistant for step-by-step guidance.

**Source file:** `.cortex/skills/install-fleet-apps/fleet_sa_app/app/app-views.json` lines 4270-4308.

**Entities:** None (conceptual/help view, not an analytics view).

**Map:** NONE - layout is a single `doc` area with a Markdown component (file:4285-4295).

**Metrics:** None.

**Tables:** None.

**Emits:** None (no interactive controls).

**agentKnowledge (Channel C):** YES (file:4274-4284):
- `preferredTool`: `"search_sap_binding"` (file:4275)
- `keyMetrics`: `[]` (empty - no analytics metrics) (file:4276)
- `exampleQuestions`: 4 questions about SAP equipment matching, binding steps, join strategies, and discoverable tables (file:4277-4282)
- `gotchas`: "This is conceptual how-to knowledge, not analytics over fleet data. SAP and telematics must be co-located into one account first, and the ASSET_CROSSWALK is mandatory." (file:4283)

**Map state (Channel B):** NOT emitted (no map component).

**viewState (Channel A):** Only activeContext (region, vehicle_type, dataset_id, date_range). No view-specific keys since no emits.

## User questions & grounding gaps

| # | Question | Category | Answerable now? | Grounding source or gap | Suggested fix | Priority |
|---|----------|----------|-----------------|-------------------------|---------------|----------|
| 1 | How do I match my SAP equipment to telematics devices? | How-to | Yes | agentKnowledge.preferredTool = `search_sap_binding` (file:4275). Agent is instructed to use this tool for SAP binding questions. Tool returns grounded reference content. | N/A | N/A |
| 2 | What are the steps to bind my SAP data into the fleet dashboards? | How-to | Yes | Same - `search_sap_binding` tool (file:4275, example question file:4279). | N/A | N/A |
| 3 | Which join strategy should I use if SAP has no EQUI? | How-to | Yes | `search_sap_binding` tool covers strategy selection (file:4280). | N/A | N/A |
| 4 | Which SAP tables can I bind in MOCK_SAP? | Discovery | Yes | `search_sap_binding` tool + the `introspect_sap` verb mentioned in Markdown content (file:4303). The gotchas note clarifies this is conceptual knowledge (file:4283). | N/A | N/A |
| 5 | What is the ASSET_CROSSWALK and why is it mandatory? | How-to | Yes | `search_sap_binding` tool (gotchas mentions it, file:4283). | N/A | N/A |
| 6 | Can I see my SAP equipment records on a map? | Spatial | No | This is a documentation view with no map. SAP data visualization would be in a different view (fleet_ops or similar) after binding is complete. No spatial data is available here. | agentKnowledge.gotchas could add: "This view is documentation only - for spatial SAP fleet data, complete the binding and switch to the Fleet Ops view." Or link to the appropriate view. | Low |
| 7 | How many SAP tables have been bound already? | Counting | No | No analytics data is surfaced. The `introspect_sap` verb could answer this via a tool call, but it is not the declared preferredTool here (search_sap_binding is for docs, introspect_sap is a separate ops verb). | Add a second tool hint or gotchas note: "For live introspection of what is bindable, ask the agent to run introspect_sap on a specific database." | Low |
| 8 | What is the current binding status of my account? | Status | No | No runtime state is surfaced. The view is static Markdown. Binding status would require querying FLEET_APP.UNIFIED_FLEET views to see if they point to SAP sources vs synthetic. | Could add agentKnowledge.gotchas note that binding status is not tracked here. | Low |
| 9 | What CDC deduplication approach should I use? | How-to | Yes | `search_sap_binding` tool (the Markdown content at file:4303 mentions "Dedupe CDC" as step 3 of the workflow). | N/A | N/A |
| 10 | What co-location options exist for SAP data? | How-to | Yes | `search_sap_binding` tool (Markdown mentions secure data share and replication at file:4303). | N/A | N/A |
| 11 | Can the assistant scan my database and tell me what SAP objects are there? | Discovery | Yes | The Markdown content explicitly says "You can also ask the assistant to scan a database live" (file:4303). The agent uses the introspect_sap verb. | N/A | N/A |
| 12 | What region is this view scoped to? | Context | Yes | activeContext carries region (route.ts:108-140, Channel A). Though irrelevant for a docs view, the agent can still state the active region. | N/A | N/A |

## Notes

- This is a well-grounded documentation view. The `agentKnowledge` block (Channel C) correctly declares `preferredTool = "search_sap_binding"` so the agent knows to use that tool for all how-to questions.
- The `gotchas` field properly scopes expectations: conceptual knowledge only, not fleet analytics.
- No map means Channel B is silent - appropriate for this view's purpose.
- The few "No" answers are for operational/status questions that are out of scope for a help view. These are low priority because the view's purpose is explicitly conceptual guidance, not runtime analytics.

**Summary: Yes=8, Partial=0, No=4**
