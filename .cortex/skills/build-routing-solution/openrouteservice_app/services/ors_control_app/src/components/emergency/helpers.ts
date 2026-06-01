// Helpers shared across the 5 emergency-response pages.
// API contract documented in
// .cortex/skills/emergency-response/references/server-api.md

export type Severity = 'Extreme' | 'Severe' | 'Moderate' | 'Minor';

export type EmergencyAlert = {
  alertId: string;
  eventType: string;
  severity: Severity;
  urgency: string;
  certainty: string;
  headline: string;
  description: string;
  instruction: string;
  effectiveTime: string;
  expiresTime: string;
  boundaryGeoJson: GeoJSON.Polygon | GeoJSON.MultiPolygon | null;
};

export type ImpactedParticipant = {
  participantId: string;
  address: string;
  loc: [number, number];
  compositeVulnerability: number;
  requiresLift: boolean;
  milesFromAlertCentroid: number;
  primaryLanguage: string;
};

export type ReachabilityRow = {
  centerId: string;
  centerName: string;
  centerLoc: [number, number];
  isochroneAvoidingGeoJson: any;
  computedAt: string;
};

export const SEVERITY_COLOR: Record<Severity, [number, number, number, number]> = {
  Extreme:  [180, 20, 30, 200],
  Severe:   [220, 100, 40, 200],
  Moderate: [240, 180, 50, 180],
  Minor:    [240, 220, 80, 140],
};

export async function fetchAlerts(): Promise<EmergencyAlert[]> {
  const res = await fetch('/api/emergency/alerts');
  if (!res.ok) throw new Error(`alerts ${res.status}`);
  const json = await res.json();
  return json.alerts || [];
}

export async function fetchKpis(): Promise<{activeAlerts:number;impactedParticipants:number;driversOnShift:number;totalCenters:number}> {
  const res = await fetch('/api/emergency/kpis');
  if (!res.ok) throw new Error(`kpis ${res.status}`);
  return res.json();
}

export async function fetchParticipantsSample(limit = 2000): Promise<{id:string;loc:[number,number];frailty:number;requiresLift:boolean}[]> {
  const res = await fetch(`/api/emergency/entities/participants?limit=${limit}`);
  if (!res.ok) throw new Error(`participants ${res.status}`);
  const j = await res.json();
  return j.participants || [];
}

export async function fetchCenters(): Promise<{id:string;name:string;loc:[number,number];capacity:number;hasGenerator:boolean;isShelter:boolean}[]> {
  const res = await fetch('/api/emergency/entities/centers');
  if (!res.ok) throw new Error(`centers ${res.status}`);
  const j = await res.json();
  return j.centers || [];
}

export async function fetchDrivers(): Promise<{id:string;name:string;status:string;loc:[number,number];vehicleType:string;hasLift:boolean;capacity:number}[]> {
  const res = await fetch('/api/emergency/entities/drivers');
  if (!res.ok) throw new Error(`drivers ${res.status}`);
  const j = await res.json();
  return j.drivers || [];
}

export async function fetchReachabilityLive(alertId: string): Promise<{centers: any[]; alertBoundaryGeoJson: any}> {
  const res = await fetch(`/api/emergency/reachability/live/${encodeURIComponent(alertId)}`);
  if (!res.ok) throw new Error(`reachability/live ${res.status}`);
  return res.json();
}

export async function fetchImpacted(alertId: string): Promise<ImpactedParticipant[]> {
  const res = await fetch(`/api/emergency/impacted/${encodeURIComponent(alertId)}`);
  if (!res.ok) throw new Error(`impacted ${res.status}`);
  const json = await res.json();
  return json.participants || [];
}

export async function postDispatch(alertId: string, topN: number = 30): Promise<any> {
  const res = await fetch('/api/emergency/dispatch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ alertId, topN }),
  });
  if (!res.ok) throw new Error(`dispatch ${res.status}`);
  return res.json();
}

export async function fetchHistory(): Promise<any[]> {
  const res = await fetch('/api/emergency/history?h3_res=7');
  if (!res.ok) throw new Error(`history ${res.status}`);
  const json = await res.json();
  return json.cells || [];
}

export function exportCsvUrl(alertId: string): string {
  return `/api/emergency/export/${encodeURIComponent(alertId)}.csv`;
}

// Snowflake TIMESTAMP_NTZ comes back as 'YYYY-MM-DD HH:MM:SS.SSS' which JS Date
// parses inconsistently across browsers. Coerce to ISO-8601 UTC.
export function fmtTime(t?: string | null): string {
  if (!t) return 'unknown';
  const trimmed = String(t).trim();
  const iso = trimmed.includes('T')
    ? trimmed
    : trimmed.replace(' ', 'T') + (trimmed.endsWith('Z') ? '' : 'Z');
  const d = new Date(iso);
  return isNaN(d.valueOf()) ? trimmed : d.toLocaleString();
}

export const SEVERITY_HEX: Record<Severity, string> = {
  Extreme:  '#b71c1c',
  Severe:   '#e65100',
  Moderate: '#f9a825',
  Minor:    '#fbc02d',
};
