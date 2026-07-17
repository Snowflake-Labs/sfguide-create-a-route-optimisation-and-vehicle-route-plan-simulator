# ops_console - Ops Console

## Summary

**Purpose:** Operator control panel for the routing platform. Provides live service and compute-pool inventory (status, instance counts, auto-suspend drift detection), suspend/resume lifecycle controls, active region setting, substrate healthcheck, and a synapse audit trail (VERB_ATTEMPT) viewer with outcome filtering.

**Source file (component):** `.cortex/skills/install-fleet-apps/fleet_sa_app/ui/src/components/views/areas/ops-console.tsx` (385 lines).

**Registration:** `.cortex/skills/install-fleet-apps/fleet_sa_app/ui/src/lib/packs/fleet/index.ts` lines 66-78. Registered as a custom (code) view with:
- `id`: `ops_console` (file:67)
- `label`: `Ops Console` (file:68)
- `description`: `Operator controls: suspend/resume services, set the active region, and check platform health.` (file:69)
- `category`: `Admin` (file:70)
- `roles`: `['ops']` (file:72)

**agentKnowledge (Channel C):** NONE - not declared in the registration object (file:66-78) and not present in app-views.json (ops_console is a custom view, not config-driven).

**Map:** NONE - the component renders only cards (active region input, services inventory, activity log, audit trail table). No map component.

**Map state (Channel B):** NOT emitted (no map).

**viewState published (Channel A):** The component does NOT call `setMapState`, `updateViewState`, `onStateChange`, or `setViewState` (confirmed via grep - zero matches in ops-console.tsx). Therefore the agent receives ONLY:
- The view label and description (route.ts:35).
- activeContext (region, vehicle_type, dataset_id, date_range - route.ts:108-140).
- No view-specific state keys whatsoever.

**Entities surfaced in UI (but NOT in agent context):**
- Services: name, fq_name, status, compute_pool, min/max/current/target instances, auto_suspend_secs (file:25-35).
- Compute pools: state, instance_family, min/max/active/idle nodes, num_services (file:37-45).
- Audit trail rows: bundle, id, at, verb, actor, actor_role, outcome, error_code, error_message, idempotency_key, args_json (file:56-68).
- Activity log: timestamped action results (local state only, file:93).

**OPS verbs called:** `service_inventory`, `service_control`, `service_status`, `healthcheck`, `set_active_region`, `recent_verb_attempts` (file:70-127).

## User questions & grounding gaps

| # | Question | Category | Answerable now? | Grounding source or gap | Suggested fix | Priority |
|---|----------|----------|-----------------|-------------------------|---------------|----------|
| 1 | How many services are currently running? | Counting | No | The component fetches `service_inventory` and computes `runningCount` (file:176), but this is local React state never published to any agent channel. Agent only sees the static description. | Publish a viewState memo: `{ services_running: N, services_total: M, pools: P }` via `updateViewState` after each inventory fetch. Custom views can do this (emergency_response pattern). | High |
| 2 | Is the ORS service for SanFrancisco running? | Per-entity status | No | Service-level status is in the inventory response (file:25-35) but not in any agent channel. | Same memo fix as #1 - include per-service status summary or at minimum the count. For per-service queries, add `agentKnowledge.preferredTool` pointing to an ops tool that can query service status. | High |
| 3 | Are there any services with AUTO_SUSPEND drift? | Status/anomaly | No | Drift detection logic exists at file:232 (`auto_suspend_secs === 0 && isRunning`) but the result is local rendering only. | Include `drift_services: [list]` in the viewState memo. | Med |
| 4 | What compute pools are active and how many nodes? | Counting | No | `computePools` data is fetched (file:175) but not published. | Publish pool summary in viewState memo. | Med |
| 5 | What region is currently set as active? | Context | Partial | activeContext (Channel A) carries `region` from the global app context (route.ts:124). However, the ops-console's local `region` state (file:84) which reflects what the user typed into the input is NOT published - it may differ from the global context if the user typed but hasn't clicked "Set". | Publish `ops_region_input` or rely on activeContext (sufficient for most cases). | Low |
| 6 | Who ran the last verb and what was the outcome? | Audit/per-entity | No | Audit trail data (`attempts` state, file:89) is fetched via `recent_verb_attempts` but never published. Agent has no visibility into the audit trail. | Publish a compact audit memo: `{ last_verb: "X", last_actor: "Y", last_outcome: "ok", recent_errors: N }` in viewState. | High |
| 7 | Are there any recent errors in the audit trail? | Counting/anomaly | No | Same gap - audit data is local state only. | Same fix as #6. | High |
| 8 | What outcome filter is currently applied to the audit trail? | UI state | No | `auditOutcome` state (file:91) is not published. | Include in viewState memo if desired, but low value. | Low |
| 9 | Can you suspend the ORS service for London? | Action | No | The agent has no tool to invoke `service_control`. Even if it did, the ops-console's controls are UI-only (file:150-155). The FLEET_OPS_AGENT (mentioned in file:7-8) has the ops verbs, but the SA app's chat agent (FLEET_AGENT) attaches only the User MCP bundle (per TENETS.md role isolation). | This is by design (role isolation). Add agentKnowledge.gotchas: "Service lifecycle actions require the FLEET_OPS_AGENT or manual use of the Ops Console buttons. The chat agent cannot suspend/resume services." | Med |
| 10 | Is the platform healthy? | Status | No | `healthcheck` verb result (ok, core_functions count, tool_procs count) is appended to the activity log (file:170-172) but the log is local state. | Publish last healthcheck result in viewState memo: `{ health_ok: true, core_fns: N }`. | Med |
| 11 | How many verb attempts have been recorded? | Counting | No | `attempts.length` (file:338) is rendered but not in agent context. | Include in audit memo. | Low |
| 12 | Which bundle has the most errors? | Ranking | No | Would require aggregation over audit trail data. Not in any channel. | preferredTool pointing to an ops query verb, or publish error breakdown in memo. | Low |
| 13 | What instance family are the compute pools using? | Per-entity detail | No | `instance_family` is in ComputePoolInfo (file:39) but not published. | Include in pool summary memo. | Low |
| 14 | Is this view role-gated? Who can access it? | Meta/access | Partial | The registration declares `roles: ['ops']` (file:72). The description mentions "Role-gated (FLEET_APP_OPS)" in the rendered UI (file:251). The agent sees the description text via Channel A (route.ts:35), which says "Operator controls..." but does NOT mention the role gate. | Add "Role-gated to FLEET_APP_OPS." to the description string in the registration, or add agentKnowledge.gotchas. | Low |
| 15 | What actions have I performed in this session? | Audit/history | No | The activity log (file:86, 93) is purely local React state (`useState<string[]>`), not published. | Publish recent log entries in viewState (bounded, e.g. last 5). | Low |

## Notes

- The ops_console is a custom code view that publishes ZERO viewState and has NO agentKnowledge. The agent's only grounding when this view is active is the static label/description plus activeContext. This means the agent is effectively blind to all platform state displayed on screen.
- The component fetches rich operational data (service inventory, compute pools, audit trail) every 15 seconds (file:109) but keeps it entirely in local React state.
- **Fix pattern (emergency_response gold standard):** Since this is a custom view, it CAN publish viewState via the store's `updateViewState` callback (unlike config views which require view-map.tsx changes). The fix is:
  1. Accept `onStateChange` or `updateViewState` prop (or use the view store hook).
  2. After each `fetchInventory()` and `fetchAudit()`, compute a bounded memo object and publish it.
  3. Example memo: `{ services_running: 4, services_total: 7, pools_active: 2, drift_services: "ORS_SERVICE_SF", last_verb: "healthcheck", last_outcome: "ok", recent_errors: 0, health_ok: true }`.
  4. Optionally add an `agentKnowledge` block in the registration for preferredTool/gotchas (requires editing `fleet/index.ts`).
- The role-isolation design (Tenet 3) intentionally prevents the SA chat agent from executing ops verbs. This is correct - the agent should acknowledge limitations via gotchas, not attempt ops actions.

**Summary: Yes=0, Partial=2, No=13**
