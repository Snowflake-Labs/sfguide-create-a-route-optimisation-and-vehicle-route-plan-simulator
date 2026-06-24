# UI Architecture

## Implementation Status

| Component | Status | Notes |
|-----------|--------|-------|
| App shell (chat + splitter + panel) | Done | Resizable, collapsible panels; **default 50/50 split** (`DEFAULT_RATIO = 0.5` in `app-shell.tsx`) |
| Chat panel (message list, input, streaming) | Done | Markdown rendering, inline components |
| Cortex Agents API integration | Done | Agentless mode with PAT auth, SSE streaming, threading |
| Inline component registry | Done | 6 components: stat, table, confirm, choices, picker, progress |
| View registry + picker | Done | Searchable, lazy-loaded views, click-outside dismiss; `hidden` flag for drilldown views |
| View rendering pipeline | Done | YAML-driven CSS Grid, 5 area components, SQL data fetching |
| SQL query API (`/api/query`) | Done | Snowflake SQL REST API proxy, param resolution, SELECT/WITH only |
| Action API (`/api/action`) | Removed | Unused arbitrary-CALL gateway deleted for security (Tenet 7); CALL flows through audited synapse verbs via `/api/tool` + `/api/ops`. |
| Write API (`/api/write`) | Done | Unified write endpoint for agent and UI; validates entity against entity-manifest.json; parameterized CREATE/UPDATE/DELETE/RESTORE; integer optimistic locking; returns undo token. **`expected_version` optional** — server resolves from DB snapshot if omitted |
| App config (`/api/app-config`) | Done | Dynamic app title, About dialog, sample questions |
| Chat↔View sync (`update_view` tool) | Done | Generic tool with client_side_execute; agent updates filters programmatically |
| Panel context injection | Done | Active view + filters injected into every agent turn |
| Context bar | Done | Date range picker with presets + custom range, driven by app-config.json |
| Framework-level workflow views | Done | Workflow Manager + Workflow Detail auto-registered when `app-config.json` has `"hasWorkflows": true`; hidden for analytics-only apps |
| SPCS deployment | Done | **Single container** (app only). Generic image + stage mount config injection, pre-built Dockerfile |
| View-to-chat links | Done (agent-driven) | Agent receives view descriptions + guidance per turn; writes `[Label](view:id)` markdown links; client renders as chips. `urlTransform` prop whitelists `view:` protocol in react-markdown v9. |
| **Workflow engine (embedded)** | **Done** | TypeScript workflow engine in `src/lib/workflow/`; no separate workflow service |
| **Structured logging** | **Done** | `logger.ts` + `withLogging` HOF in `api-handler.ts` + `middleware.ts`. JSON to stdout → `SYSTEM$GET_SERVICE_LOGS`. Level: `LOG_LEVEL` env var. |
| **YAML-driven EntityDetail** | **Done** | Generic `EntityDetail` area component; replaces per-entity TypeScript views. Config: `component: EntityDetail`, `noPad: true`. Supports properties, text/code/dynamic_sql/related_table sections, status transitions, dependency panel. |
| **Workflow registry** | **Done** | `src/lib/workflow/registry.ts` (framework) + `app-workflows.ts` (CDP seam); framework routes never import CDP workflows directly. |
| **MCP protocol endpoint** | **Done** | `/api/mcp` handles MCP JSON-RPC 2.0; `CDP_WORKFLOW_MCP` CUSTOM MCP SERVER points to it |
| **Workflow HTTP endpoints** | **Done** | `/api/workflow/execute` + `/api/workflow/resume` for direct UI access |
| **Inline ApprovalAction** | **Done** | `execute_workflow` results with `pending_approval` render Approve/Reject card in chat |
| **Workflow step stepper** | **Done** | Colors: green ✓ (done), blue (running), **light yellow `#fef3c7`** (paused_at_gate), red ✗ (failed), grey (pending). |
| Session start overview panel | Not started | |
| User preferences | Not started | |
| URL sync | Not started | |
| Responsive (mobile) | Not started | |
| Stellar theme integration | Partial | CSS variables defined; not wired to Stellar theme provider |

## Overview

Every Solution Accelerator app uses the same UI shell: a **chat-primary layout** with a **view-based right panel**. The agent is the primary interaction mode; the panel provides visual feedback, precision editing, and exploration.

This document defines the architecture of the framework-level UI scaffold that all apps inherit.

---

## Tech Stack

| Layer | Choice | Rationale |
|---|---|---|
| Framework | Next.js (App Router, TypeScript) | Standard React meta-framework |
| Design system | `@snowflake/stellar-components`, `-tokens`, `-icons`, `-charts` | Snowflake standard; ensures certification |
| State | Zustand + `temporal` middleware | Minimal, performant, undo/redo built-in |
| Chat streaming | Cortex Agents API client (custom) | Snowflake-native; no external AI SDK dependency |
| Generative UI | Custom inline component registry | ~100 lines; maps tool results to React components |
| Packaging | Docker (SPCS) / standalone (dev) | Runs locally for development, containerized for production. Pre-built approach: `npm run build` on host, package `.next/standalone` into Alpine image |

### What we deliberately excluded

| Library | Why excluded |
|---|---|
| Vercel AI SDK (`@ai-sdk/react`) | Snowflake already has chat streaming infrastructure (Cortex Agents API). The SDK adds a dependency for functionality we don't need — only the tool→component mapping pattern is valuable, and that's trivial to implement. |
| Google A2UI | A cross-boundary protocol for untrusted remote agents. Our agent and UI are same-trust-boundary, same deployment. We adopt A2UI's *philosophy* (declarative catalog, JSON-serializable state, host controls styling) without the runtime dependency. |
| CopilotKit / AG-UI | Transport protocol for connecting agent backends to frontends. Unnecessary when agent and UI are co-deployed in SPCS. |

### What we borrowed (philosophy, not code)

From A2UI:
- **Declarative component catalog** — views and inline components are registered by ID + metadata; agent references by name
- **JSON-serializable state** — all state payloads between agent and UI are plain JSON objects, never functions or JSX
- **Host controls styling** — agent sends semantic intent ("show stat card with value 1204"), host renders with Stellar

---

## Layout Model

```
┌─────────────────────────────────────────────────────────────────────┐
│  App Name     [Production ▼]                          [⚙] [?]      │  ← header
├─────────────────────────────────────╥───────────────────────────────┤
│                                     ║                               │
│                                     ║  [🔍 Search views...    ▼]    │
│                                     ║  [Context Bar filters]        │
│         CHAT PANEL                  ║─────────────────────────────  │
│         (primary)                   ║                               │
│                                     ║     ACTIVE VIEW               │
│                                     ║     (complement)              │
│                                     ║                               │
│  ┌─────────────────────────────┐    ║                               │
│  │ Type a message...        [→]│    ║                               │
│  └─────────────────────────────┘    ║                               │
├─────────────────────────────────────╨───────────────────────────────┤
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
         ~50% of screen                        ~50% of screen
```

### Splitter behavior

- Draggable vertical divider between chat and panel
- Persists ratio to `localStorage`
- Double-click divider → reset to 50/50 default
- Collapse panel: drag all the way right → full-width chat (panel hidden, small toggle button to restore)
- Collapse chat: drag all the way left → full-width panel (chat collapsed to floating button at bottom-left)

### Responsive (mobile)

- Below 768px: stacked vertically with tab bar (Chat | Panel)
- Swipe gesture to switch between tabs

---

## Chat Panel

### Message Model

```typescript
interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  parts: MessagePart[];
  timestamp: number;
  metadata?: Record<string, unknown>;
}

type MessagePart =
  | { type: 'text'; content: string }
  | { type: 'tool_pending'; toolName: string; input: Record<string, unknown> }
  | { type: 'tool_result'; toolName: string; output: Record<string, unknown> }
  | { type: 'tool_error'; toolName: string; error: string }
  | { type: 'status'; status: string; message: string }
  | { type: 'metadata'; threadId?: number; assistantMessageId?: number };
```

### Rendering rules

1. **Text parts** → render as Markdown (with Stellar typography tokens)
2. **tool_pending** → look up `InlineComponentRegistry` by `toolName`; render skeleton or spinner
3. **tool_result** → look up registry; render the mapped React component with `output` as props
4. **tool_error** → render standard error card with retry option
5. Unknown tool names → fallback to collapsible JSON viewer

### Input bar

- Multi-line textarea (auto-grows, max 6 lines before scroll)
- Larger than CoCo Web's input (chat is primary interface, not a sidebar)
- Send on Enter (Shift+Enter for newline)
- Stop button appears during streaming
- Optional: drag-and-drop zone for referencing panel elements (future)

### Suggestions

Two complementary suggestion mechanisms:

**1. Agent suggestions (contextual, inline)**

The agent suggests next steps at the end of its response — either as plain text ("Would you like to...") or via `render_choices` inline component. These are contextual to what just happened in the conversation.

**2. System suggestion chips (persistent, state-driven)**

Clickable chips rendered above the input bar when the chat is idle (not streaming). These represent general next actions based on overall app state — not tied to the last message. Clicking a chip sends it as a message.

```
│                                     │
│  [Last assistant message...]        │
│                                     │
│  ┌──────────────┐ ┌───────────────┐ │
│  │ Add a trait  │ │ Review mapping│ │  ← system suggestion chips
│  └──────────────┘ └───────────────┘ │
│  ┌─────────────────────────────┐    │
│  │ Type a message...        [→]│    │
│  └─────────────────────────────┘    │
└─────────────────────────────────────┘
```

**Behavior:**
- Chips disappear while agent is streaming
- Chips update when app state changes (e.g., after completing a step, new chips appear for the next logical action)
- Max 3-4 chips visible at once (overflow hidden, not wrapped)
- Chips are generated by the agent at the end of each turn (based on app state, conversation context, and what's logical next) — not hardcoded by the Creator

**Future: externally-informed suggestions.** Agent suggestions can be influenced by signals from external systems (via MCP or External Access Integrations). For example: a user launched a campaign tracked in Meta Ads — the agent monitors campaign metrics and proactively suggests "Campaign X is underperforming — pause it?" or "Campaign Y is exceeding targets — increase budget?" This turns the suggestion chips from reactive (what's next in the user journey) to proactive (what's happening in the world that the user should act on). Requires the agent to have access to external system APIs and the ability to poll or receive webhooks.

---

### Session Start: Status Context

When a user opens the app (new session), the chat panel does not start blank. Above the message scroll area, a **collapsible status panel** orients the user:

```
┌─────────────────────────────────────┐
│  [▼ Overview]                       │  ← toggle button (always visible)
│┌───────────────────────────────────┐│
││ COMPLETED                      ││  ← collapsible section
││ ✓ Connected to ANALYTICS.CORE    ││
││ ✓ Mapped 3 source tables          ││
││ ● Defining traits (2 of 5 done)   ││
││                                   ││
││ UP NEXT                           ││
││ → Complete trait definitions       ││
││ → Configure the agent             ││
││ → Promote to production           ││
│└───────────────────────────────────┘│
│─────────────────────────────────────│
│                                     │
│  [Chat messages...]                 │
│                                     │
│  ┌─────────────────────────────┐    │
│  │ Type a message...        [→]│    │
│  └─────────────────────────────┘    │
└─────────────────────────────────────┘
```

**Behavior:**
- Pinned between the header and the chat scroll area (not part of the message list)
- Open by default on first session load
- User collapses it as they start chatting — chat area expands to reclaim the space
- Re-open anytime via the toggle button; chat scroll position is undisturbed
- Content refreshes each time it's opened (shows current state, not stale from session start)
- Content is contextual to the user's role and app state:
  - **Data App Admin (setup incomplete):** setup progress checklist
  - **Data App Admin (setup complete):** pipeline health, last deploy, recent changes
  - **Consumer (first time):** welcome message + what the app does + starter prompts (Creator-defined in agent config). Transitions to Completed/Up Next format once the user has activity.
  - **Consumer (returning):** recent activity summary (e.g., active audiences, last refresh)

**Content generation:** Agent-generated automatically on session start. The server makes a lightweight agent call (separate from the chat conversation) that queries app state and produces the Overview content. This refreshes each time the panel is opened.

---

## Generative UI Layer (Inline Component Registry)

This is the "custom thin layer" — the only piece that would otherwise require an external AI SDK.

### Interface

```typescript
interface InlineComponentDef<TProps = any> {
  toolName: string;
  component: React.ComponentType<TProps>;
  skeleton?: React.ComponentType;
  maxHeight?: number;  // pixels; scroll if exceeded
}

// Global registry (populated at app startup)
class InlineComponentRegistry {
  private components = new Map<string, InlineComponentDef>();

  register(def: InlineComponentDef): void {
    this.components.set(def.toolName, def);
  }

  get(toolName: string): InlineComponentDef | undefined {
    return this.components.get(toolName);
  }

  list(): InlineComponentDef[] {
    return Array.from(this.components.values());
  }
}

export const inlineRegistry = new InlineComponentRegistry();
```

### Rendering (in MessagePart)

```typescript
function InlineToolResult({ part }: { part: MessagePart }) {
  if (part.type === 'tool_pending') {
    const def = inlineRegistry.get(part.toolName);
    return def?.skeleton ? <def.skeleton /> : <Spinner />;
  }
  if (part.type === 'tool_result') {
    const def = inlineRegistry.get(part.toolName);
    if (!def) return <JsonViewer data={part.output} />;
    return <def.component {...part.output} />;
  }
  if (part.type === 'tool_error') {
    return <ErrorCard toolName={part.toolName} error={part.error} />;
  }
  return null;
}
```

### Framework-provided inline components

These ship with the framework; apps register additional ones:

| Tool name | Component | Purpose |
|---|---|---|
| `render_stat` | `<StatCard />` | Single metric with optional breakdown (max 6 rows) |
| `render_table` | `<DataTable />` | Compact read-only table (max 6 rows; truncates with "show more in panel") |
| `render_confirm` | `<ConfirmAction />` | Confirm/Cancel button pair for destructive actions |
| `render_choices` | `<ChoiceList />` | Agent presents 2-5 options for user to pick |
| `render_picker` | `<InlinePicker />` | Searchable combo box for selecting from a list (e.g., pick an account, database, warehouse) |
| `render_progress` | `<ProgressCard />` | Multi-step progress (e.g., during pipeline deploy) |

### Design constraints (from plan.md)

- Inline components are always **read-only or single-outcome** — the user glances, picks, or confirms, then moves on. Never multi-field editable forms.
- If the user needs to interact beyond a single click → agent should use `show_view` (panel) instead
- Max ~1 screenful of content inline; anything larger goes to the panel
- **Inline components are framework-owned, not Creator-defined.** The inline registry is a fixed set of general-purpose components provided by the framework. Creators do not add custom inline components — they define custom components as view areas in `ui-views.yaml` (Phase 8). This keeps the inline vocabulary small, predictable, and consistent across all apps. If a future app needs an app-specific inline component, we can open this up later.

---

## View-Based Panel Model

### Core concept

The right panel is a **flat collection of views** — independent, self-contained UI components registered in a catalog. No router, no sidebar, no breadcrumbs, no navigation hierarchy.

### View Registry

```typescript
interface ViewDef {
  id: string;
  label: string;
  description: string;       // Agent uses this for intent matching
  component: React.LazyComponent<ViewProps>;
  hidden?: boolean;          // If true, excluded from view picker — only reachable programmatically
  icon?: string;             // Stellar icon name
  tags?: string[];           // For search/filtering in picker
  category?: string;         // Optional grouping in picker dropdown
}

interface ViewProps {
  viewState: Record<string, unknown>;  // Injected from store
  onStateChange: (patch: Record<string, unknown>) => void;
  onSave: () => void;
  onDirty: (isDirty: boolean) => void;
}

class ViewRegistry {
  private views = new Map<string, ViewDef>();

  register(def: ViewDef): void {
    this.views.set(def.id, def);
  }

  get(id: string): ViewDef | undefined {
    return this.views.get(id);
  }

  search(query: string): ViewDef[] {
    const q = query.toLowerCase();
    return this.list().filter(v =>
      v.label.toLowerCase().includes(q) ||
      v.description.toLowerCase().includes(q) ||
      v.tags?.some(t => t.toLowerCase().includes(q))
    );
  }

  list(): ViewDef[] {
    return Array.from(this.views.values()).filter(v => !v.hidden);  // hidden views excluded from picker
  }
}

export const viewRegistry = new ViewRegistry();
```

### View Picker

- Stellar Combobox at the top of the panel
- Shows all registered views, searchable by label/description/tags
- Current view is highlighted
- Optional category grouping (e.g., "Analytics", "Configuration", "Outputs")

### Agent-driven navigation

The agent's tool:

```typescript
// Agent calls this to switch the panel view
function showView(viewId: string, state?: Record<string, unknown>): void {
  const def = viewRegistry.get(viewId);
  if (!def) throw new ToolError(`Unknown view: ${viewId}`);

  const store = useAppStore.getState();

  // Navigation guard
  if (store.panel.hasUnsavedChanges) {
    // Agent should check this BEFORE calling show_view
    // If it didn't, the UI shows the guard dialog
    return;
  }

  store.showView(viewId, state ?? {});
}
```

### View lifecycle

1. Agent (or user via picker) calls `showView(id, state)`
2. Store updates: `panel.activeViewId = id`, `panel.viewState = state`
3. `ViewPanel` component reads store, lazy-loads the view component
4. View mounts, receives `viewState` as props
5. User interacts → view calls `onStateChange(patch)` → store merges into `viewState`
6. View calls `onDirty(true)` when user has unsaved changes
7. On save → view calls `onSave()` → persists to Snowflake → calls `onDirty(false)`

### Design principles (from plan.md)

- Views are independent — no inter-view state coupling
- List → Detail is one view (internal modes)
- Wizard flows are one view (internal stepper)
- Cross-view quick edits use inline modals
- Adding a new view = one `viewRegistry.register()` call

### View Definition

A view has two parts: **declarative layout** (YAML) and **component code** (React + Stellar).

**Layout** — defined declaratively using CSS Grid Template syntax in the view's YAML config. The Creator specifies the grid structure and maps named areas to components:

```yaml
views:
  - id: campaign_performance
    label: "Campaign Performance"
    description: "Overview of campaign metrics, trends, and detail"
    layout:
      default:
        columns: "1fr 2fr 1fr"
        rows: "auto 3fr 1fr"
        grid: |
          "metrics  metrics  metrics"
          "chart    chart    sidebar"
          "table    table    sidebar"
      tablet:
        columns: "1fr 1fr"
        grid: |
          "metrics  metrics"
          "chart    chart"
          "sidebar  sidebar"
          "table    table"
      mobile:
        columns: "1fr"
        grid: |
          "metrics"
          "chart"
          "sidebar"
          "table"
    areas:
      metrics: CampaignMetricCards
      chart: CampaignTrendChart
      sidebar: CampaignFilterPanel
      table: CampaignDataTable
```

- `columns` / `rows` — CSS Grid track sizes (`fr` for ratios, `px` for fixed, `auto` for content-sized)
- `grid` — ASCII template mapping named areas to grid cells. Repeat a name to span multiple cells.
- Breakpoints (`default`, `tablet`, `mobile`) — separate layout per screen size. Same area names, different arrangements.
- `areas` — maps each named area to a React component (registered in the app)

**Components** — each area maps to a React component built with Stellar. Components are standard React code, not declarative. They receive data as props (fetched by the framework — see Data Binding below) and handle interactions and rendering.

```typescript
// audience/src/components/CampaignTrendChart.tsx
function CampaignTrendChart({ data, config }: AreaProps) {
  // Render Stellar chart — data is already fetched by the framework
}
```

**Why this split:**
- Layout changes are common and low-risk (move the sidebar, resize the chart) — declarative makes this safe and fast
- Component logic is complex and app-specific (custom filters, interactive builders) — React code gives full expressiveness
- The skill can generate layouts conversationally ("put the chart on the left, filters on the right") without generating React code
- The Creator can rearrange layouts in YAML without touching component code

### Data Binding

Components do not fetch their own data. The framework owns all data fetching; components are pure renderers that receive data as props.

**How it works:**

1. Each area in the view YAML declares what data it needs (a SQL query + field mapping)
2. When a view loads, each area component independently fetches its data via `POST /api/query`
3. As each query completes, the component renders (others show Stellar Skeleton placeholders)
4. When context bar or viewState values change, affected queries re-fetch automatically

**Stellar alignment:** Stellar components are explicitly presentational ("only concerned with how elements look and behave — no business logic"). Stellar Charts expect `data: Record<string, value>[]` — an array of flat record objects — which is exactly what Snowflake query results produce. No transformation needed.

**YAML declaration:**

```yaml
areas:
  chart:
    component: Chart
    data:
      query: |
        SELECT delivery_date, SUM(impressions) as impressions, SUM(clicks) as clicks
        FROM fact_delivery
        WHERE delivery_date >= :date_range_start
        GROUP BY 1 ORDER BY 1
      params:
        date_range_start: context.date_range
    config:
      height: 300
      palette: categorical
      xAxis:
        field: delivery_date
        fieldType: date
        label: "Date"
      series:
        - type: line
          field: impressions
          label: "Impressions"
        - type: bar
          field: clicks
          label: "Clicks"

  table:
    component: Table
    data:
      query: |
        SELECT campaign_name, spend, impressions, clicks, ctr
        FROM dim_campaign ORDER BY spend DESC LIMIT 100
      params:
        date_range_start: context.date_range

  picker:
    component: ComboBox
    data:
      query: SELECT campaign_id, campaign_name FROM dim_campaign ORDER BY 1
      mapping:
        value: campaign_id
        label: campaign_name

  metrics:
    component: MetricCards
    data:
      query: |
        SELECT SUM(spend) as total_spend, SUM(impressions) as total_impressions,
               AVG(ctr) as avg_ctr
        FROM fact_delivery
        WHERE delivery_date >= :date_range_start
      params:
        date_range_start: context.date_range
      mapping:
        metrics:
          - column: total_spend
            label: "Total Spend"
            format: currency
          - column: total_impressions
            label: "Impressions"
            format: number
          - column: avg_ctr
            label: "Avg CTR"
            format: percent
```

**Framework responsibilities:**
- Execute queries server-side via `/api/query`, never in the browser
- Parameterize queries with context bar and viewState values (`:param` syntax)
- Show Stellar Skeleton placeholders for components still loading
- Show error state on query failure (per-component, not whole-view)
- Re-fetch when viewState or context changes

**Planned (not yet implemented):**
- Server-side query parallelism and SSE streaming per-component
- Query result caching and deduplication across areas

**Component responsibilities:**
- Render the data received as props
- Handle user interactions (click, hover, brush) within the component
- Emit events back to the framework (e.g., selection changes)

### Component Interactions (Actions)

Components within a view can drive each other — e.g., selecting a value in a dropdown filters a table below. This uses **viewState** as the shared coordination layer, built on top of Stellar's standard controlled-component callbacks.

**How Stellar components emit events:**
- ComboBox: `onSelectedValueChange(value: string | null)`
- Select: `onValueChange(value: T)`
- Chart: `onStateChange(state: ChartState)` (click, brush, hover)

These are standard React controlled-component callbacks. Our framework adds a declarative layer so the Creator can wire interactions in YAML without writing React code.

**YAML wiring:**

```yaml
areas:
  campaign_picker:
    component: ComboBox
    data:
      query: SELECT campaign_id, campaign_name FROM dim_campaign
      mapping:
        value: campaign_id
        label: campaign_name
    emits:
      selectedCampaign: selection

  delivery_table:
    component: Table
    data:
      query: |
        SELECT delivery_date, impressions, clicks, spend
        FROM fact_delivery
        WHERE campaign_id = :selected_campaign
        ORDER BY delivery_date DESC
      params:
        selected_campaign: viewState.selectedCampaign

  trend_chart:
    component: Chart
    data:
      query: |
        SELECT delivery_date, SUM(impressions) as impressions
        FROM fact_delivery
        WHERE campaign_id = :selected_campaign
        GROUP BY 1 ORDER BY 1
      params:
        selected_campaign: viewState.selectedCampaign
    config:
      xAxis: { field: delivery_date, fieldType: date }
      series: [{ type: line, field: impressions }]
```

**The flow:**

```
User picks "Campaign X" in picker
  -> Stellar ComboBox calls onSelectedValueChange("X")
  -> Framework writes viewState.selectedCampaign = "X"
  -> Framework detects: table and chart params depend on viewState.selectedCampaign
  -> Re-fetches both queries with new param (in parallel, streaming per-component)
  -> Table and chart re-render with filtered data
```

**Agent-driven interactions work the same way.** The agent can set viewState values directly via `show_view(id, { selectedCampaign: "X" })`, triggering the same reactive cascade.

**Two scopes of shared state:**

| Scope | Store location | Affects | Example |
|---|---|---|---|
| **Context bar** (global) | `store.context` | All views | Date range, region |
| **viewState** (local) | `store.panel.viewState` | Current view only | Selected campaign, active tab |

Both use the same mechanism: write to store, dependent queries re-fetch, components re-render. Context bar persists across view switches; viewState resets when switching views (unless the agent pre-fills it via `show_view`).

**When YAML isn't enough:** For complex interactions (e.g., chart brush selection drives a date filter that affects multiple components plus updates a URL param), the Creator writes a custom React component that manages the coordination. The YAML `emits`/`params` covers the common case; custom code handles the rest.

### View Rendering Pipeline (Implementation)

The view rendering pipeline is fully implemented. Here is how it works end-to-end:

**1. View config loading** — On app startup, `AppShell` fetches `/api/views-config`, which reads the JSON file at `APP_VIEWS_CONFIG` env var. The JSON is parsed by `load-views.tsx`, which creates a lazy `ViewDef` per view and registers it in the `ViewRegistry`.

**2. View selection** — User picks a view from the `ViewPicker` combobox (or agent calls `show_view`). The store updates `panel.activeViewId`. `ViewPanel` reads the registry, lazy-loads the component.

**3. Layout rendering** — `ViewRenderer` receives the parsed view definition and renders a CSS Grid container:
- `gridTemplateColumns` from `layout.default.columns` (e.g., `"1fr 1fr 1fr 1fr"`)
- `gridTemplateRows` from `layout.default.rows` (e.g., `"auto 2fr 1fr"`)
- `gridTemplateAreas` from `layout.default.grid` (parsed from multi-line area template)
- Each `areas` entry is placed in its grid cell using `gridArea`

**4. Area component dispatch** — `ViewRenderer` maps each area's `component` string to a React component:

| YAML `component` | React component | Purpose |
|---|---|---|
| `MetricCards` | `MetricCardsArea` | KPI stat cards from single-row aggregate query |
| `Chart` | `ViewChartArea` | Recharts line/bar/stacked charts with dual-axis support |
| `Table` | `ViewTableArea` | Full sortable data table with numeric formatting |
| `ComboBox` | `ViewComboBoxArea` | Dropdown filter that emits selection to viewState |
| `FilterBar` | `ViewFilterBarArea` | Multiple dropdown filters in a horizontal row |

**5. Data fetching** — Each area component calls `useViewData(query, params)`:
- Resolves `viewState.X` and `context.X` param references from the Zustand store
- Calls `POST /api/query` with the SQL and resolved params (one call per area component)
- `/api/query` proxies to Snowflake SQL REST API (`POST /api/v2/statements`) using the same PAT
- Column names are normalized to lowercase (Snowflake returns UPPERCASE)
- Returns `{ columns, rows, totalRows }` matching the YAML column references

**Note:** Each area fetches independently (no server-side parallelism or SSE streaming for view data). Components render as their individual queries complete.

**6. Reactive updates** — When `viewState` or `context` changes (e.g., user selects a campaign in a ComboBox), `useViewData` detects the param change and re-fetches. All area components that depend on the changed param re-render with fresh data.

```
User selects "Campaign X" in ComboBox
  → ViewComboBoxArea calls updateViewState({ selectedCampaign: "CMP-123" })
  → useViewData in Chart detects viewState.selectedCampaign changed
  → Re-fetches: POST /api/query with selectedCampaign = "CMP-123"
  → Chart re-renders with filtered data
  → Same for Table (also depends on selectedCampaign)
```

### Default View

The panel needs a view to show on initial load (before the agent navigates anywhere). Resolution order:

1. **URL parameter** — if `?view=X` is present, show that view (deeplink / shared URL)
2. **User preference** — if the user has set a personal default view, use that
3. **App default** — the Creator or Data App Admin sets a default view for all users of that role
4. **First registered view** — fallback if nothing else is configured
5. **No views registered** — show the empty panel state (see below)

The user can set their default via the view picker ("Set as my default") or conversationally ("Make this my default view").

### Empty Panel State

When no views are registered (Creator skipped Phase 8, or views haven't been defined yet), the panel shows a helpful empty state instead of a blank area:

```
┌─────────────────────────────────────────────┐
│                                             │
│         ┌─────────────────────┐             │
│         │       📊            │             │
│         └─────────────────────┘             │
│                                             │
│      Select a view                          │
│                                             │
│      Use the picker above to open a view.   │
│                                             │
└─────────────────────────────────────────────┘
```

This is a simple empty state component. Role-specific messaging is planned but not yet implemented.

---

### URL sync

```
?view=audience_builder&vs=eyJhdWRpZW5jZUlkIjoiYWJjMTIzIn0=
```

- `view` — active view ID
- `vs` — base64-encoded viewState (JSON)
- Updated on view switch (replaceState, not pushState — chat is the history)
- On page load: if URL has `?view=`, restore that view + state

---

## Shared State (Zustand Store)

### Store shape

```typescript
interface AppStore {
  // --- Chat ---
  chat: {
    messages: Message[];
    status: 'ready' | 'submitted' | 'streaming' | 'thinking' | 'error';
    statusMessage: string | null;
    error: string | null;
    sessionId: string;
    suggestions: string[];
    threadId: number | undefined;
    parentMessageId: number | undefined;
  };

  // --- Panel ---
  panel: {
    activeViewId: string | null;
    viewState: Record<string, unknown>;
    hasUnsavedChanges: boolean;
  };

  // --- Context Bar (optional, app-defined) ---
  context: Record<string, unknown>;

  // --- Write signal (triggers view data refresh after any write) ---
  // Incremented by bumpViewsVersion() after every successful /api/write call.
  // useViewData and WorkflowManagerArea watch this value and re-fetch when it changes.
  // viewState (filter selections) is untouched — filters are preserved across refreshes.
  viewsVersion: number;

  // --- Actions ---
  sendMessage: (text: string) => Promise<void>;
  addUserMessage: (text: string) => void;
  addAssistantMessage: () => string;
  appendAssistantPart: (messageId: string, part: MessagePart) => void;
  setChatStatus: (status: ChatStatus) => void;
  setChatError: (error: string | null) => void;
  setSuggestions: (suggestions: string[]) => void;
  showView: (viewId: string, state?: Record<string, unknown>) => void;
  updateViewState: (patch: Record<string, unknown>) => void;
  setDirty: (isDirty: boolean) => void;
  setContext: (key: string, value: unknown) => void;
  bumpViewsVersion: () => void;

  // --- Agent context injection ---
  getPanelContext: () => PanelContext;
}

interface PanelContext {
  activeView: { id: string; label: string; description: string } | null;
  viewState: Record<string, unknown>;
  context: Record<string, unknown>;
  hasUnsavedChanges: boolean;
}
```

### Middleware

- `temporal` — undo/redo stack for `panel.viewState` changes (in-session, unsaved edits)

### Agent context injection

**Context chip pattern** — a dismissible chip above the chat input tells the user what panel context the agent will receive. Implemented in `chat-input.tsx`:

- Chip appears when `activeViewId` is set and `viewContextEnabled` is true (store flag)
- Shows: `📊 [View Name] · N filters active` (truncated at 50 chars, full text in tooltip)
- Dismiss (✕) → sets `viewContextEnabled: false` → `getPanelContext()` returns empty context
- Re-add button → sets `viewContextEnabled: true`

**Context injection into agent messages** — when context chip is active, `/api/chat/route.ts` prepends to the user message:

```
[Panel context: Currently showing "Campaign Overview" (KPI dashboard...).
Active filters: selectedPlatform=Google Search.
Use this context when the user asks about their data... When you use the view context,
start with "Looking at [view name] (filtered by [active filters]):"...]
[Available views in the panel:
- Campaign Overview: KPI dashboard...
- Geographic Performance: Regional breakdown...
When suggesting a view, mention its exact name so the user can click to open it.]
```

**View links in agent text** — `message-part.tsx` post-processes text parts:
- Scans for registered view names in lines containing "open", "explore", "looking at", etc.
- Replaces first match with a markdown link `[View Name](#view:VIEW_ID)`
- Custom ReactMarkdown `<a>` renderer turns `#view:*` links into clickable buttons that call `showView()`
- Only one view link per text part (prevents duplicates in analysis text)

**Message part hoisting** — `message-list.tsx` reorders assistant message parts so text containing view links renders before tool results (user sees the view link immediately, not after "Tool result" accordions).

### Chat→View sync status

**Implemented:**
- View → Chat: context injection when chip is active
- View switching: agent mentions view name → clickable link → user clicks → view switches

**Not implemented (parked):**
- Chat → View state modification (filter changes, editor updates from chat)
- Requires reliable server-side tool execution mechanism; Cortex Agents API does not invoke generic tools without `tool_resources` pointing to a UDF/SP

---

### App Config and Branding

Each app provides an `app-config.json` with metadata loaded at startup. **All fields are required** — missing fields cause silent fallback to defaults (e.g., name falls back to "Data App", empty description renders a blank welcome screen).

```json
{
  "name": "CDP",
  "description": "A Customer Data Platform that unifies customer profiles, builds targetable audiences, enforces consent and compliance, and activates campaigns to external marketing channels.",
  "targetUsers": [
    "Marketing Manager / Campaign Manager",
    "Data Analyst / Marketing Ops",
    "Compliance Officer"
  ],
  "capabilities": [
    "Build audiences using natural language — describe criteria and the agent generates SQL",
    "Run compliance-safe campaigns with suppression, consent, and frequency filters applied automatically",
    "Execute campaigns with a human-in-the-loop approval step before any records are pushed"
  ],
  "sampleQuestions": [
    "Show me all active campaigns and their status",
    "How many audiences do I have?",
    "What's my activation success rate this month?",
    "Show consent coverage by channel"
  ],
  "snowflake": {
    "database": "CDP",
    "schema": "APP"
  },
  "contextBar": [
    { "type": "date_range", "id": "date_range_start", "label": "Date Range", "default": "last_30_days" }
  ]
}
```

**Field types and rendering:**

| Field | Type | Required | Rendered in |
|---|---|---|---|
| `name` | `string` (top-level, NOT nested in `app{}`) | Yes | Header title, WelcomeScreen h2, AboutDialog h2 |
| `description` | `string` | Yes | WelcomeScreen paragraph, AboutDialog paragraph |
| `targetUsers` | `string[]` | Yes | "Who is this for" bulleted list |
| `capabilities` | `string[]` | Yes | "What it can do" bulleted list |
| `sampleQuestions` | `string[]` (4 items) | Yes | Chat suggestion chips |
| `snowflake.database` | `string` | Yes | Snowflake DB for workflow views + write layer |
| `snowflake.schema` | `string` | Yes | Snowflake schema for workflow views + write layer |
| `hasWorkflows` | `boolean` | No (default: `false`) | Set `true` to register Workflow Manager + Workflow Detail views and require framework tables in `validate-views.py`. Set `false` (or omit) for analytics-only apps. |
| `contextBar` | `array` | When views use `context.*` params | Global filter bar initialization |

**Critical:** `name` must be a top-level string. Nesting it inside `{"app": {"name": ...}}` causes the header to fall back to `'Data App'` silently.

---

## User Preferences

The framework provides a generic user-level personalization facility. Preferences are per-user, per-app, stored in Snowflake (not localStorage — persists across devices).

### Storage

```
DATA_APP_USER_PREFERENCES (Hybrid Table)
├── user_id          (Snowflake username)
├── tenant_id        (for multi-tenant apps)
├── preferences      (VARIANT — JSON object)
├── updated_at       (TIMESTAMP)
```

### Interface

```typescript
interface UserPreferences {
  defaultViewId?: string;           // Default panel view on session start
  contextBarDefaults?: Record<string, unknown>;  // Preferred filter values
  collapsedOverview?: boolean;      // Whether Overview panel starts collapsed
  // App-specific preferences (extensible)
  [key: string]: unknown;
}

// Read (loaded on session start, cached in store)
const prefs = useUserPreferences();

// Write (persisted to Snowflake immediately)
prefs.set('defaultViewId', 'audience_builder');
```

### Preference Hierarchy

Some preferences have multiple levels. Resolution order (first wins):

| Level | Set by | Example |
|---|---|---|
| **User** | Individual user | "My default view is Segment Analysis" |
| **Role** | Data App Admin (per role) | "All DATA_APP_USER role users start on the Dashboard view" |
| **App** | Creator | "Default view for this app is Audience Builder" |

User preferences override role defaults, which override app defaults. This allows Data App Admins to set sensible defaults while letting individual users customize.

### What's Personalizable (framework-level)

- Default panel view
- Context bar filter defaults
- Overview panel collapsed/expanded on load
- Theme preference (if supported)

Individual apps can extend with app-specific preferences using the same facility (the `preferences` VARIANT column is schemaless).

---

### Request Flow

All communication goes through the app's Node.js server (running in SPCS). The browser never calls Cortex directly.

```
┌──────────┐         ┌──────────────────────┐         ┌────────────────────┐
│          │  SSE    │                      │  SSE    │                    │
│  Browser │ ◀────── │  Node.js Server      │ ◀────── │  Cortex Agents API │
│  (React) │ ──────▶ │  (SPCS container)    │ ──────▶ │                    │
│          │  POST   │                      │  POST   │                    │
└──────────┘         └──────────────────────┘         └────────────────────┘
                              │
                              │  SQL (Snowflake SDK)
                              ▼
                     ┌────────────────────┐
                     │  Snowflake         │
                     │  (app tables,      │
                     │   source tables,   │
                     │   APP_VERSIONS,    │
                     │   APP_AGENT_LOG)   │
                     └────────────────────┘
```

**Why proxied (not direct browser → Cortex):**

1. **System prompt injection** — server injects fresh panel context, tool definitions, user role/permissions into the system prompt on every turn
2. **Tool execution** — data tools (query Snowflake, create/update records) execute server-side with the app's service credentials
3. **Security** — Cortex API credentials stay on the server; browser never sees them
4. **Observability** — server logs every agent turn to `APP_AGENT_LOG` and SQL to `APP_SQL_LOG` as it proxies
5. **Single origin** — browser talks to one host (the Node server); no CORS complexity

### Chat request lifecycle

1. Browser sends `POST /api/chat` with `{ message, panelContext, history, threadId, parentMessageId }`
2. Server builds the full Cortex request:
   - Prepends active view context (label, description, filters) to user message
   - Attaches tools from `AGENT_TOOLS_CONFIG`
   - Includes conversation history and threading info
   - Sets model, instructions (response + orchestration), and budget from env vars
3. Server calls Cortex Agents API (streaming SSE)
4. Server passes the SSE stream through to the browser (no server-side tool execution)
   - Cortex handles all tool execution (Analyst SQL, search, etc.) internally
   - Client-side tools (`update_view`) arrive as `response.tool_use` with `client_side_execute: true`
5. Browser receives SSE → `cortex-stream.ts` parses events → parts dispatched to Zustand store → UI re-renders
6. Client-side tool calls are dispatched immediately (filter updates, view switches)

### Tool categories

| Category | Examples | Executed where | Browser receives |
|---|---|---|---|
| **Panel navigation** | `show_view` | Browser (store update) | `tool_result` with `{viewId, state}` → store updates panel |
| **View state update** | `update_view` | Browser (client_side_execute) | `tool_result` with `{action, filters}` → store updates viewState |
| **Inline render** | `render_stat`, `render_table`, `render_picker` | Browser (component render) | `tool_result` with props → inline registry resolves component |
| **Data read** | `query_audiences`, `get_version_history` | Server (Snowflake SQL) | `tool_result` with data (may feed into inline render) |
| **Data write** | `save_audience`, `promote_to_prod` | Server (Snowflake SQL) | `tool_result` with confirmation → agent narrates success |
| **External** | `sync_to_meta`, `call_api` | Server (External Access) | `tool_result` with status |

### Server API surface

```
POST /api/chat                  → SSE stream (agent conversation, includes panel context injection)
POST /api/query                 → execute SQL against Snowflake (view data fetching, SELECT/WITH only)
POST /api/write                 → unified write: CREATE/UPDATE/DELETE/RESTORE with entity-manifest.json validation
GET  /api/views-config          → serve app-views.json from APP_VIEWS_CONFIG path
GET  /api/app-config            → serve app-config.json (name, description, sample questions)
POST /api/mcp                   → MCP JSON-RPC 2.0 endpoint; serves execute_workflow + resume_workflow tools
POST /api/workflow/execute      → direct HTTP workflow execution (for UI use)
POST /api/workflow/resume       → direct HTTP workflow resume/approval (for ApprovalAction + Workflow Detail)
```

`/api/query` is SELECT-only; stored-procedure (`CALL`) execution flows through the audited synapse verbs via `/api/tool` and `/api/ops` (the former `/api/action` arbitrary-CALL gateway was removed — see below).

`/api/mcp` is the primary entry point for the Cortex Agent's workflow tools. The `CDP_WORKFLOW_MCP` CUSTOM MCP SERVER points to this endpoint (`ENDPOINT = app, PATH = '/api/mcp'`).

`/api/workflow/execute` and `/api/workflow/resume` are for direct UI access (not via MCP). The `ApprovalAction` inline component and the Workflow Detail panel both call `/api/workflow/resume`.

**Planned (not yet implemented):**
```
POST /api/chat/abort    → cancel in-flight request
GET  /api/views         → list registered views (for debugging)
POST /api/app/*         → app-specific CRUD (non-agent operations)
```

### Agent Communication (server-side)

The chat API route (`/api/chat/route.ts`) handles all Cortex Agents API communication directly:

1. `agent-config.ts` reads env vars and builds the request body (supports `agentless` and `agent-object` modes)
2. `/api/chat/route.ts` injects panel context into the user message, calls Cortex, and streams SSE back to browser
3. `cortex-stream.ts` parses the Cortex SSE events (text deltas, tool_use, tool_result, analyst deltas, charts, tables, status, metadata)
4. Client-side tools (`update_view`, `show_view`) are dispatched directly in the store when received

**Note:** `agent-client.ts` exists as a stub for future refactoring but is not currently used.
```

---

## Semantic View Integration and agent-tools.json

### Semantic Views — Mandatory for Conversational Querying

Every app MUST have a deployed Cortex Semantic View covering all tables that users query through the agent. This applies to **both analytical tables and transactional (app-managed) tables**.

The key distinction is *read pattern*, not *write pattern*:

| Table type | Example | Needs semantic view? |
|---|---|---|
| Analytical (views/DTs from source data) | DIM_CAMPAIGN, FACT_DELIVERY | Yes |
| Transactional (app-managed) | CAMPAIGN, ACTIVATION_RECORD, AUDIENCE | Yes — users ask questions about these too |
| Hybrid (app-managed + source data) | CONSENT_PREFERENCES | Yes — if users query them |
| Engine/operational | WORKFLOW_INSTANCES, WORKFLOW_DEFINITIONS | No — internal state only |

Without a semantic view, the agent cannot answer any natural language data questions. The Cortex Analyst `text-to-sql` tool requires a semantic view as its input. Omitting it causes cryptic errors (`"Tool type X is not valid"`, `"generic tool has empty type"`) when users ask data questions.

The semantic view is deployed via:
```sql
CALL SYSTEM$CREATE_SEMANTIC_VIEW_FROM_YAML(
    'DATABASE.SCHEMA',
    $$<yaml content>$$
);
```

**One semantic view per app.** When source data is connected later (Phase 4-6), analytical entities are added to the same semantic view — not a separate one.

**Avoid ambiguous dimension names.** If the same column name (e.g., `created_by`, `status`) appears in multiple tables in the semantic view, do NOT include it as a bare dimension. Rename it table-specifically (e.g., `campaign_status`, `activation_status`) or omit it. Bare ambiguous names cause "Ambiguous semantic expression" errors at query time.

---

### Confirmed `agent-tools.json` Format

`agent-tools.json` is used in **agentless mode only** (analytics apps). In agent-object mode, this file is not sent to the Cortex API — tools are configured on the Snowflake Agent Object. See `agent-config.ts#buildCortexRequestBody`.

**For agentless mode (analytics-only apps):**
```json
{
  "tools": [
    {
      "tool_spec": {
        "type": "cortex_analyst_text_to_sql",
        "name": "cortex_analyst_text_to_sql"
      }
    }
  ],
  "toolResources": {
    "cortex_analyst_text_to_sql": {
      "semantic_view": "DATABASE.SCHEMA.SEMANTIC_VIEW_NAME",
      "execution_environment": {
        "type": "warehouse",
        "warehouse": "COMPUTE_WH"
      }
    }
  }
}
```

**For agent-object mode (apps with workflows and transactional entities):** Tools are defined on `CREATE OR REPLACE AGENT DATABASE.SCHEMA.APP_AGENT FROM SPECIFICATION $${ ... }$$`. The spec includes:
- `cortex_analyst_text_to_sql` tool (with semantic view toolResource)
- `mcp_servers`: points to the app's MCP Custom MCP Server (backed by `/api/mcp`)
- `instructions`: response + orchestration routing rules

`agent-tools.json` in this mode serves only as documentation — it is not read at runtime.

## View-to-Chat Links (Agent-Driven)

When the agent wants to reference a panel view, it writes a standard markdown link with a `view:` protocol href:

```
[Campaign Manager](view:campaign_manager)
```

The client renders any `view:` href as a clickable button chip that calls `showView(viewId)`.

### How the agent knows which views exist

Every chat turn, `route.ts` injects a context block into the user message (prepended as `[...]`). This block lists all registered views with their IDs, labels, and descriptions in the exact format the agent should use:

```
[Available panel views — use the exact markdown link format below when your
response would benefit from the user exploring data or taking action in the UI:
  [Campaign Manager](view:campaign_manager) — create and manage campaigns
  [Audience Manager](view:audience_manager) — browse and manage saved audiences
  ...

Include a view link when: the question is about data that view surfaces, the
user could take a useful action in the view, or the answer alone leaves the
user without an obvious next step. Do not include links for general or
conceptual questions. One or two links per response at most.]
```

The agent uses semantic reasoning — it can recommend `[Audience Manager](view:audience_manager)` even if the user said "manage my audiences" (not the exact view name), because the description matches the intent.

### Implementation

**Data flow:**

```
viewRegistry.list() [browser]
  → getPanelContext() in store.ts (includes id + label + description)
    → POST /api/chat panelContext.availableViews
      → route.ts builds context prefix with link format + guidance
        → LLM receives it prepended to each user message
          → LLM writes [Label](view:id) links in its response
            → ReactMarkdown renders with urlTransform
              → a component override detects view: href
                → renders button chip calling showView(id)
```

**Key files:**
- `store.ts` — `getPanelContext()` includes `id` in `availableViews`
- `route.ts` — builds context prefix with view links + guidance (lines 33–38)
- `message-part.tsx` — `urlTransform` prop whitelists `view:` protocol; `a` override renders button chip

**react-markdown v9 gotcha:** The default `urlTransform` in react-markdown v9 only allows `https?`, `mailto`, `ircs?`, `xmpp` protocols. Custom protocols like `view:` are stripped and replaced with an empty string before reaching the `a` component override. Fix: pass `urlTransform={(url) => url.startsWith('view:') ? url : defaultUrlTransform(url)}` as a prop.

**Context cost:** ~100–200 tokens per turn over the existing view-list injection (which already existed). Negligible — the view list injection was already present before this change.

**Multiple chips per message:** Supported. There is no single-link guard; every `[Label](view:id)` the agent writes becomes its own chip.

**Legacy `#view:` protocol:** Also handled in the `a` override for backward compatibility.

| Error | Root cause | Fix |
|---|---|---|
| `"Tool type procedure is not valid"` | `tool_spec.type` is `"procedure"` | Change to `"generic"` |
| `"Tool type python_tool is not valid"` | `tool_spec.type` is `"python_tool"` | Change to `"generic"` |
| `"generic tool has empty type"` | `toolResources.{name}` missing `"type"` field | Add `"type": "procedure"` |
| `"missing execution environment"` | `"warehouse"` at top level, not nested | Wrap in `"execution_environment": {"type": "warehouse", "warehouse": "..."}` |

---

## Context Bar

### When to use

Optional. Useful for analytics-pattern apps with cross-view filtering dimensions (date range, campaign, region). Record-centric apps (Identity Resolution) typically don't need one.

### Definition (in app config)

```typescript
interface ContextBarField {
  id: string;
  type: 'date_range' | 'entity_picker' | 'enum' | 'text';
  label: string;
  default: unknown;
  // For entity_picker:
  source?: string;          // Snowflake table/view
  labelField?: string;
  valueField?: string;
}
```

### Behavior

- Rendered between view picker and active view
- Changes propagate to store → all views re-render with new context
- Agent can read AND set context bar values
- Values included in `PanelContext` on every agent turn

---

## Unsaved Changes and Navigation Guards

### Trigger conditions

A navigation guard fires when:
1. User selects a different view in the picker AND `panel.hasUnsavedChanges === true`
2. Agent calls `show_view` AND `panel.hasUnsavedChanges === true`

### Agent behavior

The agent checks `panelContext.hasUnsavedChanges` before calling `show_view`. If true, it asks in chat:

> "You have unsaved changes in the audience builder — want to save or discard them before I open the trait editor?"

### User-initiated navigation

Standard dialog:

> "You have unsaved changes. Leave anyway?"
> **[Save & Leave]** **[Discard]** **[Stay]**

---

## Undo / Redo

### In-session (Scope 1)

- Zustand `temporal` middleware on `panel.viewState`
- Cmd+Z / Cmd+Shift+Z keyboard shortcuts
- "Undo that" / "redo that" in chat triggers `undo()` / `redo()` on the store
- Stack cleared on save or confirmed navigation

### Post-save (Scope 2)

- Soft deletes (`deleted_at` timestamp) — row is never hard-deleted; DELETE sets `deleted_at`, RESTORE clears it
- Integer `version` column on every transactional entity — incremented on every write (including batch seed/import/export); provides collision-proof optimistic locking for undo
- `/api/write` returns an `undo_token` containing the reverse operation and `expected_version` after every write
- Undo button appears briefly (10s) in `ConfirmAction` after save/delete (Gmail-style)
- Undo executes `POST /api/write` with the stored undo token; `WHERE version = :expected_version` detects concurrent edits and returns a conflict response instead of silently overwriting

---

## File Structure

```
ui/
├── package.json
├── tsconfig.json
├── next.config.ts
├── .env.example                 env var documentation (connection, agent, app config paths)
├── ARCHITECTURE.md              ← this file
├── src/
│   ├── app/
│   │   ├── layout.tsx           root layout (providers, Stellar theme, fonts)
│   │   ├── page.tsx             renders <AppShell />
│   │   └── api/
│   │       ├── chat/route.ts    Cortex Agents API proxy (SSE streaming, context injection)
│   │       ├── query/route.ts   Snowflake SQL REST API proxy (SELECT/WITH only)
│   │       ├── action/route.ts  Snowflake CALL statement proxy (stored procedure execution)
│   │       ├── write/route.ts   unified write endpoint: CREATE/UPDATE/DELETE/RESTORE with entity-manifest.json validation and integer optimistic locking
│   │       ├── app-config/route.ts  serves app-config.json (name, description, samples)
│   │       ├── views-config/route.ts  serves app-views.json from APP_VIEWS_CONFIG path
│   │       ├── mcp/route.ts     MCP JSON-RPC 2.0 endpoint (execute_workflow + resume_workflow)
│   │       ├── health/route.ts  SPCS readiness probe
│   │       └── workflow/
│   │           ├── execute/route.ts  direct HTTP workflow execution
│   │           └── resume/route.ts   direct HTTP workflow resume/approval
│   ├── components/
│   │   ├── app-shell.tsx        main layout: chat + splitter + panel; loads app+views config in parallel, registers framework views
│   │   ├── header.tsx           dynamic app name, About icon
│   │   ├── about-dialog.tsx     modal showing app metadata from app-config.json
│   │   ├── chat/
│   │   │   ├── chat-panel.tsx   orchestrates message list + input
│   │   │   ├── message-list.tsx renders Message[] with auto-scroll
│   │   │   ├── message-part.tsx dispatches part type → text/inline/error
│   │   │   └── chat-input.tsx   textarea + send + stop
│   │   ├── views/
│   │   │   ├── view-panel.tsx   reads activeViewId, lazy-loads view
│   │   │   ├── view-picker.tsx  searchable combobox
│   │   │   ├── context-bar.tsx  optional cross-view filters
│   │   │   ├── view-renderer.tsx  YAML-driven CSS Grid layout engine
│   │   │   └── areas/           view area components (generic, data-driven)
│   │   │       ├── index.ts     barrel export
│   │   │       ├── metric-cards.tsx   KPI stat cards from single-row query
│   │   │       ├── view-chart.tsx     Recharts line/bar/stacked charts
│   │   │       ├── view-table.tsx     sortable data table with formatting
│   │   │       ├── view-combo-box.tsx dropdown filter → emits to viewState
│   │   │       ├── view-filter-bar.tsx multi-filter horizontal bar
│   │   │       ├── workflow-manager.tsx  [framework] WORKFLOW_INSTANCES table, status badges, row-click → detail
│   │   │       └── workflow-detail.tsx   [framework] step stepper, KV step data, Approve/Reject buttons
│   │   └── inline/              framework-provided inline components
│   │       ├── stat-card.tsx
│   │       ├── data-table.tsx
│   │       ├── confirm-action.tsx
│   │       ├── choice-list.tsx
│   │       ├── inline-picker.tsx
│   │       ├── progress-card.tsx
│   │       └── approval-action.tsx  HITL gate approval card (Approve/Reject → /api/workflow/resume)
│   ├── lib/
│   │   ├── store.ts             Zustand store (chat + panel + context)
│   │   ├── view-registry.ts     ViewDef map + register + search; list() filters hidden views
│   │   ├── inline-registry.ts   InlineComponentDef map + register
│   │   ├── load-views.tsx       YAML/JSON → ViewRegistry bridge (lazy-loads ViewRenderer)
│   │   ├── framework-views.tsx  registerWorkflowViews(db, schema) — auto-registers workflow views
│   │   ├── agent-config.ts      reads env vars, builds Cortex API request
│   │   ├── cortex-stream.ts     SSE event parser for Cortex Agents API
│   │   ├── agent-client.ts      Cortex Agents API streaming client
│   │   ├── snowflake.ts         shared Snowflake REST client (SPCS OAuth + PAT dual-mode)
│   │   ├── types.ts             Message, MessagePart, PanelContext, ViewProps, ViewDef
│   │   └── workflow/            embedded workflow engine (moved from workflow/ Express service)
│   │       ├── engine.ts        WorkflowDefinition, executeWorkflow, createInstance
│   │       ├── campaign-setup.ts  validate_inputs → create_audience → create_offer → create_campaign
│   │       └── campaign-execution.ts  resolve_audience → apply_filters → enrich → push → log_results
│   └── hooks/
│       ├── use-chat.ts          thin hook: sendMessage, status, messages
│       ├── use-panel.ts         activeView, viewState, showView
│       ├── use-panel-context.ts serialized context for agent injection
│       └── use-view-data.ts     generic data hook: resolves params, calls /api/query
├── Dockerfile                   SPCS deployment
└── .env.example                 env var documentation
```

App-specific files live in their own folder (e.g., `cdp/`):

```
cdp/
├── agent-tools.json             Cortex Analyst tool (agent-object mode: not sent to API; MCP tools auto-discovered via CDP_WORKFLOW_MCP)
├── app-config.json              app metadata + snowflake.database/schema (triggers workflow views)
├── app-views.json               app-defined views only (customer_overview, campaign_performance)
├── entity-manifest.json         entity allowlist + writable columns for /api/write validation
├── ui-views.yaml                source view definitions (YAML, human-editable)
└── ...                          domain model, SQL, etc.
```

The framework references app files via env vars (`AGENT_TOOLS_CONFIG`, `APP_VIEWS_CONFIG`, `APP_CONFIG`, `ENTITY_MANIFEST`) — never by static import.

---

## How Apps Extend the Framework

Each app provides files in its own folder — never inside `ui/`:

1. **`app-views.json`** — app-defined view definitions (layouts, data queries, interactions). Loaded at runtime via `APP_VIEWS_CONFIG` env var. **Does NOT include workflow views** — those are framework-provided.
2. **`agent-tools.json`** — Cortex Analyst tool definition. In agent-object mode, this file is NOT sent to the API (see `agent-config.ts`); all write/lookup/workflow tools are served via `CDP_WORKFLOW_MCP` → `/api/mcp`.
3. **`app-config.json`** — app metadata + Snowflake connection info. Set `"hasWorkflows": true` to activate Workflow Manager + Workflow Detail views; omit or set `false` for analytics-only apps.
4. **`entity-manifest.json`** — entity allowlist for `/api/write`. Maps entity name → table, primary key, soft-delete flag, writable columns. Loaded via `ENTITY_MANIFEST` env var. Generated by the skill at Phase 3; never edited manually.
5. **`.env.local`** — agent instructions (`AGENT_RESPONSE_INSTRUCTIONS`), connection details, and paths to the above files.

### Two view registration paths

### View type taxonomy

There are three kinds of views in the system:

| Type | Defined in | Registered by | Visible in picker | Example |
|---|---|---|---|---|
| **YAML-driven** | `*.yaml` in `cdp/views/` → `app-views.json` | `registerViewsFromConfig()` | Yes | `customer_list`, `audience_manager` |
| **Framework** | TypeScript components in `ui/src/components/views/areas/` | `registerWorkflowViews()` | Yes | `workflow_manager` |
| **Detail/hidden** | TypeScript components, registered with `hidden: true` | `registerWorkflowViews()` or `app-shell.tsx` directly | No — reachable only via `showView(id, state)` | `workflow_detail`, `audience_detail` |

**YAML-driven views** are the primary extensibility mechanism for app builders. Add a YAML file, regenerate `app-views.json`, done — no TypeScript needed.

**Framework views** are built into the UI layer and always win on ID conflict. They provide capabilities that can't be expressed in YAML (multi-step workflows, stateful forms).

**Detail/hidden views** are drilldown companions to list views. They receive context via `viewState` (passed to `showView`), which is accessible inside the component via `useViewState()`. They are never shown in the view picker.

---

Views enter the registry through two independent paths, both called in `app-shell.tsx` via a single `Promise.all`:

| Path | Source | Registered by | Wins on conflict |
|---|---|---|---|
| **App views** | `app-views.json` (via `/api/views-config`) | `registerViewsFromConfig()` | First |
| **Framework views** | `app-config.json` (via `/api/app-config`) | `registerWorkflowViews(db, schema)` | **Second (always wins)** |

Framework views are registered last, so they always override any app-defined view with the same ID. This prevents an app from accidentally shadowing a framework view.

### Framework-provided workflow views

When `app-config.json` has a `snowflake.database` + `snowflake.schema` entry, the framework auto-registers:

- **`workflow_manager`** — table of all `WORKFLOW_INSTANCES` with status badges, filter by status, row-click navigates to detail. Visible in view picker.
- **`workflow_detail`** — step stepper, KV step-data block, Approve/Reject buttons (calls `/api/workflow/resume` → TypeScript workflow engine). **`hidden: true`** — not in view picker, only reachable by row-click from Workflow Manager.

These query `{database}.{schema}.WORKFLOW_INSTANCES` and `WORKFLOW_DEFINITIONS` — the standard tables provisioned by Phase 6 of the data-app-build skill.

### Drilldown views (`hidden: true`)

Any view that should only be reachable programmatically (not from the picker) sets `hidden: true` in its `ViewDef`. `viewRegistry.list()` filters these out; `viewRegistry.get(id)` still finds them. The `showView(id, state)` action navigates to them directly. `workflow_detail` is the canonical example.

### `/api/action` — REMOVED (Tenet 7)

This route was an unused arbitrary-`CALL` gateway: it forwarded raw client SQL to Snowflake with only a `CALL ` prefix check, bypassing the synapse verb allowlist + audited envelope (the Tenet 7 anti-pattern). It had no callers in the Fleet app, so it was deleted. Stored-procedure execution now flows exclusively through the role-scoped, audited synapse verbs via `/api/tool` (user) and `/api/ops` (ops), which allowlist the verb + arity and record every call in `VERB_ATTEMPT`.

---

## Security Model

- All rendering uses pre-registered components from a trusted catalog (no arbitrary code execution)
- Agent cannot inject HTML/CSS/JS — it can only reference registered tool names
- `viewState` is validated against a schema before being passed to view components (optional, per-view)
- SPCS container runs with minimal privileges; Snowflake RBAC enforces data access
- `/api/write` defends against SQL injection at two layers: (1) entity and field names validated against `entity-manifest.json` allowlist + `^[a-zA-Z_][a-zA-Z0-9_]*$` regex; (2) all field values escaped before interpolation. `tenant_id` is always injected server-side — never accepted from the client.

---

## Write Layer (`/api/write`)

The unified write endpoint used by both the agent (via `ConfirmAction`) and the UI (via form Save buttons).

> **Synapse audit coverage / Tenet 7 (deferred — C1-C2).** Unlike the routing, ops, and dataset-activation mutations (which now flow through audited synapse verbs — `/api/tool`, `/api/ops`, `set_active_context`, `activate_dataset`), `/api/write` and the workflow routes (`/api/mcp`, `/api/workflow/*`) do **not** yet flow through the synapse envelope. For the **fleet** deployment these paths are **dormant**: no `entity-manifest.json` is configured (so `getManifest()` throws and every `/api/write` call 500s) and `hasWorkflows` is `false` (so the workflow tools/routes are gated off). Converting entity CRUD and the workflow state machine into synapse verbs (`write_entity`, workflow verbs) is real net-new work on the **vendored SA framework** write/workflow model and would benefit any deployment that defines writable entities or enables workflows — it is intentionally deferred until such a deployment exists. **Revisit trigger:** when an app config defines `entities` in an `entity-manifest.json` or sets `hasWorkflows: true`, route those mutations through audited synapse verbs before shipping.

### Request shape

```ts
{ entity: string; operation: 'create'|'update'|'delete'|'restore'; record_id?: string; fields?: Record<string, unknown>; expected_version?: number }
```

### Operation semantics

| Operation | SQL | Requires |
|-----------|-----|----------|
| `create` | `INSERT` with `version=0`, `UUID_STRING()` PK | `entity`, `fields` |
| `update` | SELECT snapshot → `UPDATE SET version=version+1 WHERE pk=:id AND version=:expected` | `entity`, `record_id`, `fields`, `expected_version` |
| `delete` | `UPDATE SET deleted_at=now(), version=version+1 WHERE ... AND version=:expected` | `entity`, `record_id`, `expected_version` |
| `restore` | `UPDATE SET deleted_at=NULL, version=version+1 WHERE ... AND version=:expected` | `entity`, `record_id`, `expected_version` |

### Optimistic locking

Every transactional entity has `version INTEGER NOT NULL DEFAULT 0`. Every write increments it. The `expected_version` in the request must match the current row version or the UPDATE affects 0 rows, triggering a conflict response: `{ success: false, reason: 'conflict', current: {...} }`.

Using an integer (not `updated_at` timestamp) ensures correctness under batch operations (seed, import, export) where many writes can share the same timestamp.

### Uniqueness validation

Entities can declare `unique_columns` in `entity-manifest.json`. Before every `create`, `/api/write` queries for an existing non-deleted row with the same value for each unique column and returns an error if found:

```json
{ "success": false, "reason": "error", "error": "A Campaign named \"X\" already exists. Choose a different name." }
```

This is enforced data-driven — no per-entity code. To add uniqueness to an entity, add `"unique_columns": ["field_name"]` to its manifest entry. Currently applies to: `Audience` (`audience_name`), `Campaign` (`campaign_name`), `OfferCatalogue` (`offer_name`), `SignalLibrary` (`signal_name`). Event/log entities (`ActivationRecord`, `ConsentEventLog`) have no unique columns.

### Undo

Every successful write returns an `undo` token: `{ entity, operation, record_id, fields (pre-write snapshot for update), expected_version (post-write version) }`. The `ConfirmAction` component stores this token and shows a 10-second [Undo] button. Clicking Undo fires the reverse `POST /api/write` with the token. If a concurrent edit happened between write and undo, the version check returns a conflict response with current values.

### Agent write path (MCP tools)

All agent write and lookup tools are served via `CDP_WORKFLOW_MCP` → `/api/mcp`.

**`lookup_entity`** — called before any update/delete/restore. Queries the transactional table directly via `lib/snowflake.ts#query()`. Returns matching records including `record_id` and `version`. The agent passes `record_id` from the lookup result to `propose_write`.

**`propose_write`** — validates the write request against `entity-manifest.json`, generates a human-readable summary, and returns `{ status: "pending_confirmation", summary, write_payload }`. The client intercepts the `tool_result`, renders `ConfirmAction` from `write_payload.entity/operation/record_id/fields`, and POSTs to `/api/write` on confirmation. No echo UDF. No server-side state.

**`execute_workflow` / `resume_workflow`** — served by the same MCP server, backed by the embedded TypeScript workflow engine.

**Current mode: agent-object.** The app uses `AGENT_MODE=agent-object`. All tool specs, instructions, and model config live on `CDP.APP.CDP_AGENT` (created with `CREATE OR REPLACE AGENT`). The chat route calls `POST /api/v2/databases/CDP/schemas/APP/agents/CDP_AGENT:run` with just the message and thread context.

### Agent-object mode vs agentless mode

`agent-config.ts` supports both modes via `AGENT_MODE` env var:

| Mode | `AGENT_MODE` | How config is supplied | Tool routing |
|---|---|---|---|
| **Agentless** | `agentless` | Inline per request (`agent-tools.json` + env vars) | Cortex Analyst only (analytics apps) |
| **Agent-object** | `agent-object` | On `CREATE OR REPLACE AGENT` object in Snowflake | MCP server (`CDP_WORKFLOW_MCP`) for all write/lookup/workflow tools |

In agent-object mode the chat route only sends `messages` and `stream: true`. All tool definitions, instructions, model selection, and tool resources live on the agent object and are managed via `ALTER AGENT`.

### Planned migration: SP tools → TypeScript MCP service

The workflow engine is embedded in the app service as a TypeScript library (`ui/src/lib/workflow/`). It handles entity creation server-side (generates UUIDs, chains IDs), supports external integrations via HTTP (Twilio, SendGrid, ad platforms), and runs all business logic in TypeScript alongside the UI. The MCP server routes `execute_workflow` and `resume_workflow` tool calls to `/api/mcp` which invokes the engine.

### View auto-refresh after writes

Every successful `/api/write` call (create, update, delete, restore) triggers an automatic data refresh of the currently open view via the `viewsVersion` write signal.

**How it works:**
1. `ConfirmAction.handleConfirm` / `handleUndo` calls `bumpViewsVersion()` on success
2. `store.viewsVersion` increments
3. `useViewData` (the shared data hook) watches `viewsVersion` in its `useCallback` dep array — re-fetches all queries for the active view
4. `WorkflowManagerArea` has a matching `useEffect` dep on `viewsVersion`

**Filter preservation:** `viewState` (where FilterBar selections live) is a separate Zustand key from `viewsVersion`. `bumpViewsVersion()` never touches `viewState`, so all active filters survive the refresh. The re-fetch runs with the same filter params — data updates in-place without resetting the UI.

**Scope:** Only the currently mounted view re-fetches, because `ViewPanel` uses conditional rendering (one view mounted at a time). Non-active views are unmounted and their hooks are not running.

---

## SPCS Deployment

### Runtime Config Injection Pattern

The framework deploys as a **generic Docker image** with app config injected at runtime via Snowflake stage volume mounts. This means:

- **One image serves all apps** — no rebuild needed per app
- **Config updates don't require redeployment** — upload new JSON to stage, restart service
- **Follows Kubernetes ConfigMap pattern** — industry standard for container config

### Dockerfile (Pre-built Approach)

```dockerfile
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
COPY .next/standalone ./
COPY .next/static ./.next/static
EXPOSE 3000
CMD ["node", "server.js"]
```

**Why pre-built:** SPCS requires `linux/amd64` images. Building Node.js inside Docker on ARM Macs via QEMU is extremely slow (1700s+). Instead, we build Next.js natively on the host (`npm run build`) and just package the output.

**Prerequisites:**
- `next.config.ts` must have `output: 'standalone'`
- `.dockerignore` must NOT exclude `.next/` (the Dockerfile copies from it)

### Critical Environment Variables

| Env var | Required | Purpose |
|---|---|---|
| `HOSTNAME` | **YES** | Must be `0.0.0.0` — Next.js standalone defaults to `localhost`, which is unreachable by SPCS proxy |
| `PORT` | Yes | `3000` — must match the endpoint port in service spec |
| `SNOWFLAKE_PAT` | Yes | Injected via Snowflake secret — authenticates Cortex API calls |
| `SNOWFLAKE_ACCOUNT_URL` | Yes | Full account URL for API calls |
| `SNOWFLAKE_WAREHOUSE` | Yes | Warehouse for SQL execution |
| `AGENT_TOOLS_CONFIG` | Yes | Path to mounted config file |
| `APP_VIEWS_CONFIG` | Yes | Path to mounted config file |
| `APP_CONFIG` | Yes | Path to mounted config file |

### Build & Deploy Commands

Use `deploy.sh` from the `spcs/` directory. The command must come **first** before flags:

```bash
# 1. Build Next.js + Docker image (generates timestamped tag, writes to spcs/.build-tag)
bash deploy.sh build

# 2. Push to Snowflake registry (reads tag from .build-tag, updates service-spec.yaml)
bash deploy.sh push -c <conn> -d <DB> -s <SCHEMA> --app-dir ../<app>

# 3. Deploy (CREATE on first deploy, ALTER on subsequent deploys)
bash deploy.sh deploy -c <conn> --app-dir ../<app>

# Config-only update (no rebuild needed — views, agent tools, app metadata changed)
bash deploy.sh update-config -c <conn> --app-dir ../<app>

# Local hot-reload dev (no Docker, connects to real Snowflake via ui/.env.local)
bash deploy.sh dev
```

**CRITICAL: Use `ALTER SERVICE FROM SPECIFICATION`, NOT SUSPEND/RESUME.** SUSPEND/RESUME does NOT re-pull the Docker image — the old image keeps running. Only `ALTER SERVICE FROM SPECIFICATION` with a **new unique tag** forces SPCS to pull the new image. `deploy.sh deploy` always uses `ALTER SERVICE FROM SPECIFICATION`.

**First deploy vs. upgrade:** `deploy.sh deploy` detects whether the service exists. New app (or after DROP) → `CREATE SERVICE`. Existing service → `ALTER SERVICE FROM SPECIFICATION`. No manual SQL needed.

**Pre-deploy SQL validation:** `deploy` and `update-config` automatically run `tests/ui-framework/validate-views.py` before uploading anything. If any view SQL fails to compile, the command aborts. Use `--skip-validate` to bypass in emergencies.

**Tag persistence:** `deploy.sh build` generates `IMAGE_TAG=v$(date +%Y%m%d%H%M)` and writes it to `spcs/.build-tag` after a successful Docker build. `deploy.sh push` reads `.build-tag` to recover the tag across shell invocations (variables don't persist between separate bash invocations). Always run `build` before `push` — if you re-run `push` without a fresh `build`, it will use the tag from the last successful build.

**Spec update:** `deploy.sh push` rewrites `<app>/spcs/service-spec.yaml` with the new versioned tag using Python (more reliable than `sed` across platforms). `deploy.sh deploy` then reads this updated spec and issues `ALTER SERVICE ... FROM SPECIFICATION $$<spec>$$`.

### Access

SPCS public endpoints require Snowflake OAuth. Any user on the account with `USAGE` on the service can access it via the endpoint URL. The URL format is:
```
https://<random>-<account>.snowflakecomputing.app
```

---

## Open Questions

- Chat component approach — **Build our own**, visually matching CoCo Web's chat UI (same look and feel) but owned by this framework. CoCo Web's components (in `snapps/pep/ui/apps/ai/`) are not packaged as a reusable library and are deeply coupled to Jotai, ConnectRPC/gRPC, and the Workspaces micro-frontend architecture. We rewrite from Stellar primitives using the same visual patterns. Key differences from CoCo Web: larger input box (chat is our primary interface, not a sidebar), support for our inline component registry, REST+SSE transport (not gRPC), Zustand (not Jotai).

  **Swap-ready design:** When CoCo eventually publishes a reusable chat component, we can replace our internals without rewriting the app. To enable this:
  1. Chat component has a clean props-driven interface (`messages`, `status`, `onSend`, `onStop`, `renderToolResult`) — no store imports leak into rendering internals
  2. Message format uses a similar `{ role, parts[] }` structure compatible with CoCo's model
  3. State management difference (Zustand vs Jotai) is irrelevant at the boundary — our store feeds props in; the component's internal state is encapsulated
  4. Avoid building features that fight CoCo's patterns (e.g., no custom conversation forking — adopt CoCo's if/when needed)
- Stellar MCP (`@snowflake/stellar-mcp`) — use when the app-build skill generates React view components, to ensure correct Stellar component usage. Not blocking; implementation detail for Phase 6 (DEPLOY MODEL).
- Chat message persistence — persist conversations in a dedicated `APP_CHAT_HISTORY` table. Users can create new threads, switch between them, and resume old ones (same pattern as CoCo Web). Separate from `APP_AGENT_LOG` (which is for Creator debugging, not consumer experience).
- Drag-and-drop from panel to chat — v2
- Theme switching (light/dark) — v2

---


## System Architecture Diagram

The diagram below shows how all components interact at runtime. Read top-to-bottom: user action → request path → Snowflake services → data stores.

```
┌─────────────────────────────────────────────────────────────────────────┐
│  USER  (browser)                                                         │
│  https://<endpoint-id>-<account>.snowflakecomputing.app                 │
│                                                                           │
│  Snowflake OAuth injected automatically by SPCS for public endpoints     │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │ HTTPS
                                ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  SPCS: CDP.APP.DATA_APP_SERVICE  (CPU_X64_XS, 1 container)              │
│                                                                           │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  Next.js App  (port 3000)                                          │  │
│  │                                                                     │  │
│  │  ┌─────────────────────┐   ┌───────────────────────────────────┐  │  │
│  │  │  React UI            │   │  API Routes                       │  │  │
│  │  │                      │   │                                   │  │  │
│  │  │  Chat Panel          │   │  POST /api/chat  ─────────────►  │  │  │
│  │  │  ├─ text parts       │   │  POST /api/query ─────────────►  │  │  │
│  │  │  ├─ ConfirmAction ───┼──►│  POST /api/write ─────────────►  │  │  │
│  │  │  ├─ ApprovalAction ──┼──►│  POST /api/workflow/resume     │  │  │  │
│  │  │  └─ tool results     │   │  POST /api/workflow/execute    │  │  │  │
│  │  │                      │   │  POST /api/mcp ─────────────┐  │  │  │  │
│  │  │  View Panel          │   │                             │  │  │  │  │
│  │  │  ├─ Workflow Manager │   │  ┌──────────────────────────▼──┘  │  │  │
│  │  │  ├─ Workflow Detail ─┼──►│  │  Workflow Engine (lib/)        │  │  │
│  │  │  └─ Campaign Views   │   │  │  ├─ engine.ts                  │  │  │
│  │  │                      │   │  │  ├─ campaign-setup.ts          │  │  │
│  │  │  Zustand Store       │   │  │  └─ campaign-execution.ts      │  │  │
│  │  │  └─ viewsVersion ────┼──►│  └──────────────────┬────────────┘  │  │
│  │  └─────────────────────┘   └────────────────────────┼────────────┘  │  │
│  └────────────────────────────────────────────────────────┼────────────┘  │
└───────────────────────────────────────────────────────────┼───────────────┘
                                                            │ Snowflake REST API
                                                            │ (/api/v2/statements)
    ┌───────────────────────────────────────────────────────┼────────────────────┐
    │  Snowflake Account                                     │                    │
    │                                                        │                    │
    │  ┌─────────────────────────────────────┐              ▼                    │
    │  │  CDP.APP Tables                      │  ┌────────────────────────────┐  │
    │  │                                       │  │  WORKFLOW_INSTANCES         │  │
    │  │  AUDIENCE                             │  │  WORKFLOW_DEFINITIONS      │  │
    │  │  CAMPAIGN                             │  └────────────────────────────┘  │
    │  │  OFFER_CATALOGUE                      │                                   │
    │  │  ACTIVATION_RECORD                   │                                   │
    │  │  CONTACT_HISTORY                     │                                   │
    │  └─────────────────────────────────────┘                                   │
    │                                                                              │
    │  ┌───────────────────────────────────────────────────────────────────────┐  │
    │  │  Cortex AI Services                                                    │  │
    │  │                                                                         │  │
    │  │  ┌────────────────────────────────────────────────────────────────┐   │  │
    │  │  │  Cortex Agent  CDP.APP.CDP_AGENT  (agent-object mode)           │   │  │
    │  │  │                                                                  │   │  │
    │  │  │  Tool 1: cortex_analyst_text_to_sql                             │   │  │
    │  │  │           ──► CDP.APP.CDP_SEMANTIC_VIEW                         │   │  │
    │  │  │               (natural language → SQL → result)                 │   │  │
    │  │  │                                                                  │   │  │
    │  │  │  Tool 2: CDP.APP.CDP_WORKFLOW_MCP  (CUSTOM MCP SERVER)          │   │  │
    │  │  │           SERVICE  = CDP.APP.DATA_APP_SERVICE                   │   │  │
    │  │  │           ENDPOINT = app                                        │   │  │
    │  │  │           PATH     = '/api/mcp'   ◄──────────────────────────── │   │  │
    │  │  │           ├─ lookup_entity  ──► /api/mcp ──► Snowflake tables  │   │  │
    │  │  │           ├─ propose_write  ──► /api/mcp ──► pending_confirm   │   │  │
    │  │  │           ├─ execute_workflow ──► /api/mcp ──► Workflow Engine  │   │  │
    │  │  │           └─ resume_workflow  ──► /api/mcp ──► Workflow Engine  │   │  │
    │  │  └────────────────────────────────────────────────────────────────┘   │  │
    │  │                                                                         │  │
    │  │  ┌───────────────────────────────────────────────────────────────┐    │  │
    │  │  │  Cortex Analyst                                                 │    │  │
    │  │  │  semantic view: CDP.APP.CDP_SEMANTIC_VIEW                       │    │  │
    │  │  └───────────────────────────────────────────────────────────────┘    │  │
    │  └───────────────────────────────────────────────────────────────────────┘  │
    │                                                                              │
    │  ┌───────────────────────────────────────────────────────────────────────┐  │
    │  │  PAT Secret: CDP.APP.APP_PAT_SECRET (injected as SNOWFLAKE_PAT env)  │  │
    │  │  Config Stage: @CDP.APP.APP_CONFIG_STAGE (mounted at /app-config)    │  │
    │  └───────────────────────────────────────────────────────────────────────┘  │
    └──────────────────────────────────────────────────────────────────────────────┘
```

---

### Information Flow by User Action

#### 1. Natural language data question

```
User: "How many high-value customers have LTV > 5000?"

  /api/chat → injects panel context → Cortex Agents API
    → Agent: call cortex_analyst_text_to_sql
    → Cortex Analyst queries CDP_SEMANTIC_VIEW
    → SQL generated + executed → result rows
    → SSE text delta → renders inline in chat
```

#### 2. Campaign setup via agent

```
User: "Create a campaign targeting LTV > 5000 customers"

  /api/chat → Cortex Agent
    → Agent: call CDP_WORKFLOW_MCP.execute_workflow
    → Snowflake routes MCP to ENDPOINT=app PATH='/api/mcp'
    → /api/mcp receives JSON-RPC { method: "tools/call", name: "execute_workflow" }
    → Workflow engine: createInstance → executeWorkflow("campaign_setup")
        Step 1: validate_inputs  — name uniqueness checks, param normalization
        Step 2: create_audience  — SQL validation, INSERT into AUDIENCE
        Step 3: create_offer     — INSERT into OFFER_CATALOGUE
        Step 4: create_campaign  — INSERT into CAMPAIGN (status=draft)
    → Return { status: "completed", step_outputs: { audience_id, offer_id, campaign_id } }
    → SSE tool_result → Zustand.bumpViewsVersion() → View panel refreshes
    → Agent narrates summary in chat
```

#### 3. Campaign execution with HITL gate

```
User: "Activate the Q3 retention campaign"

  /api/chat → Cortex Agent
    → Agent: call CDP_WORKFLOW_MCP.execute_workflow("campaign_execution", {campaign_id})
    → /api/mcp → Workflow engine
        Step 1: resolve_audience  — COUNT check, size update
          Gate: metric_check (size > 0), abort on fail
        Step 2: apply_filters     — suppression / consent / freq cap / cooldown
        Step 3: enrich_payload    — payload preparation
          Gate: human_approval — pauses here
              DB: WORKFLOW_INSTANCES.status = 'paused_at_gate'
              Return to MCP: { status: "completed", pending_approval: { instance_id, prompt } }
    → SSE delivers tool_result with pending_approval field
    → message-part.tsx detects pending_approval → renders <ApprovalAction />
    → User reviews activation summary, clicks "Approve"
        POST /api/workflow/resume { instance_id, decision: "approved" }
        → Workflow engine resumes at step index + 1
        Step 4: push_to_destination  — placeholder activation push
        Step 5: log_results          — INSERT ACTIVATION_RECORD, UPDATE CAMPAIGN status=active
    → Zustand.bumpViewsVersion() → Workflow Manager + Campaign views refresh
```

#### 4. Agent looks up and proposes a field update

```
Agent: call cdp_workflow_mcp__lookup_entity({ entity_name: "Campaign", name_query: "NSW High Value" })
  → /api/mcp handleLookupEntity
  → SELECT *, campaign_id AS record_id FROM CDP.APP.CAMPAIGN WHERE ... ILIKE '%NSW High Value%'
  → returns [{ entity: "Campaign", record_id: "abc-123", version: 2, campaign_name: "...", ... }]

Agent: call cdp_workflow_mcp__propose_write({ entity: "Campaign", operation: "update", record_id: "abc-123", fields: '{"status":"active"}' })
  → /api/mcp handleProposeWrite
  → validates against entity-manifest.json
  → returns { status: "pending_confirmation", summary: "Update Campaign: set status", write_payload: {...} }
  → message-part.tsx: detects pending_confirmation in tool_result → renders ConfirmAction
  → User clicks Confirm
      POST /api/write { entity, operation, record_id, fields }
      → validates against entity-manifest.json
      → UPDATE CDP.APP.CAMPAIGN SET ... (version resolved from DB)
      → returns undo_token
  → Zustand.bumpViewsVersion() → view refreshes
```

#### 5. Workflow Manager drill-down

```
User clicks "Workflow Manager" in view picker
  → useViewData → POST /api/query → SELECT * FROM WORKFLOW_INSTANCES ORDER BY created_at DESC
  → Renders status-badged table
  → User clicks a row
      showView("workflow_detail", { instance_id })
      → WorkflowDetailArea: SELECT step_outputs, gate_context FROM WORKFLOW_INSTANCES
      → Renders step stepper + KV step outputs
      → Approve/Reject buttons → POST /api/workflow/resume
```

---

### Architecture Invariants

| Invariant | Where enforced |
|---|---|
| Workflow logic always executes in TypeScript | `CUSTOM MCP SERVER` routes all workflow tool calls to `/api/mcp` → TypeScript engine |
| Workflow resume always hits TypeScript engine | `ApprovalAction` + `WorkflowDetailArea` both POST to `/api/workflow/resume` |
| Agent never stalls on `paused_at_gate` | Engine writes `paused_at_gate` to DB but returns `{status:"completed", pending_approval}` to MCP caller |
| MCP tool names are suffix-matched | UI uses `toolName.endsWith('__execute_workflow')` to handle Cortex-prefixed tool names |
| All entity writes are versioned | `/api/write` increments `version`; `WHERE version = N` provides optimistic locking |
| Views auto-refresh after any write | `bumpViewsVersion()` called on confirm + approval; `useViewData` re-fetches |
| VARIANT columns parsed before `Object.assign` | Snowflake REST API returns VARIANT as JSON strings; engine.ts parses before spreading |
| One container in SPCS | `cdp/spcs/service-spec.yaml` has a single `app` container; no separate workflow container |
