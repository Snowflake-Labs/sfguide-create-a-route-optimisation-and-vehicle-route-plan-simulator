# Server API Surface (`server/routes/emergency.ts`)

All endpoints live under `/api/emergency/*` in the existing `ors_control_app` Express server. Region defaults to `CONFIG.PARAMS.REGION` and is resolved via `normalizeRegion()` (per AGENTS.md v1.1.4 default-sentinel retirement).

## Endpoints

| Method | Path | Returns | Used by |
|---|---|---|---|
| `GET` | `/api/emergency/alerts?region=...` | `{alerts: Alert[]}` GeoJSON `FeatureCollection` for map | Page 1 Hazard Ops |
| `GET` | `/api/emergency/impacted/:alert_id` | `{participants: ImpactedParticipant[]}` ranked by composite_vulnerability DESC | Page 2 Triage |
| `GET` | `/api/emergency/reachability/:alert_id` | `{rows: ReachabilityRow[]}` -- one row per (center, range_seconds) with isochrone GeoJSON | Page 3 Reachability |
| `POST` | `/api/emergency/dispatch` | `{plan: VroomResponse}` -- routes by driver | Page 4 Dispatch |
| `GET` | `/api/emergency/history?h3_res=7` | `{cells: H3Cell[]}` from FACT_HAZARD_HISTORY_H3 | Page 5 Vulnerability |
| `GET` | `/api/emergency/export/:alert_id.csv` | text/csv attachment | Page 2 Triage "Export CSV" button |

## Request / response shapes

```ts
type Alert = {
  alertId: string; eventType: string; severity: 'Extreme'|'Severe'|'Moderate'|'Minor';
  urgency: string; certainty: string;
  headline: string; description: string; instruction: string;
  effectiveTime: string; expiresTime: string;
  boundaryGeoJson: GeoJSON.MultiPolygon;
};

type ImpactedParticipant = {
  participantId: string; address: string; loc: [number, number];
  compositeVulnerability: number; requiresLift: boolean;
  milesFromAlertCentroid: number;
};

type ReachabilityRow = {
  centerId: string; centerName: string; centerLoc: [number, number];
  rangeSeconds: number;
  isochroneAvoidingGeoJson: GeoJSON.Polygon;     // with hazard avoided
  isochroneNormalGeoJson:    GeoJSON.Polygon;    // baseline (separate call)
  unreachableParticipantCount: number;
};

type DispatchRequest = {
  alertId: string;
  driverIds?: string[];        // optional whitelist; default = all ON_SHIFT drivers
  topNImpacted?: number;       // default 50
};
```

## Caching strategy

- Page 1 (`/alerts`): 60s TTL in-memory.
- Page 3 (`/reachability/:id`): served straight from FACT_REACHABILITY_BY_CENTER; no app-level cache (DT lag is the cache).
- Page 4 (`/dispatch`): synchronous call to ORS_OPTIMIZATION_AVOIDING; no caching (expected to recompute when the user adjusts driver set).

## Auth

All routes require the existing app session cookie. No new auth surface.
