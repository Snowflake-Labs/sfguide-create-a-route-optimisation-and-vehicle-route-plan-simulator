---
name: sap-binding
description: 'How to point these dashboards and the assistant at a customer''s real SAP plus telematics data without rebuilding anything above the contract. Use for: Our asset master lives in SAP and our positions come from a telematics vendor. What does it take to run all of this on our own data? Covers the SAP Binding use case of the Fleet Intelligence accelerator.'
---

# SAP Binding

**Business question.** Our asset master lives in SAP and our positions come from a telematics vendor. What does it take to run all of this on our own data?

**Who asks it.** Enterprise architect, Data platform lead, SAP data owner, Solution Engineer

## How to answer

1. Call the `search_sap_binding` tool. Its result is an MCP tool result, so it CANNOT be charted: `data_to_chart` accepts only a Cortex Analyst or `run_sql` result. Present the figures as a markdown table instead.
2. Scope the question before aggregating. This deployment holds EVERY loaded region and asset mode at once, so an unfiltered aggregate mixes them. `region` is the key (for example SanFrancisco); `region_label` or `city` is the readable form a person types. Say which slice you used.
3. Answer with figures and a chart - this view has no map, so there is nothing you are unable to draw. Offer `deep_link(view_id="sap_binding", region=...)` only when the user wants to explore interactively.

## How the numbers are produced

This is a guidance page rather than analytics over fleet data. The assistant answers from a Cortex Search knowledge base of the binding playbook, and can introspect a target database live to list bindable objects.

## Caveats you MUST state

SAP and telematics must be co-located in one Snowflake account before binding, and the asset crosswalk is mandatory - without a reliable asset-to-device match, nothing above the contract can be trusted. Maintenance objects and SAP write-back are later phases.

## Questions this skill covers

- How do I match my SAP equipment to telematics devices?
- What are the steps to bind my SAP data into the fleet dashboards?
- Which join strategy should I use if SAP has no EQUI?
- Which SAP tables can I bind in MOCK_SAP?

## What the answer is worth

- Get from demo to the customer's own data in days, using a documented mapping
- Avoid a bespoke integration project per dashboard
- Keep SAP as the system of record while the analytics run in Snowflake
