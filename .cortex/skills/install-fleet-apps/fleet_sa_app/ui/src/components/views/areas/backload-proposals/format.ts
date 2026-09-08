// Pure formatting helpers shared by the Backload Proposals cockpit list/map/
// drawer components. No React.

export const fmtKm = (v: number | null | undefined): string =>
  v == null || !Number.isFinite(Number(v)) ? '-' : Number(v).toFixed(0);

export const fmtSlack = (v: number | null | undefined): string =>
  v == null || !Number.isFinite(Number(v)) ? '-' : Number(v).toFixed(1);

// Neutral place label: "City" or "City (CC)" when a country/region code is
// present and meaningful. Never renders a bare "(?)".
//
// Upstream POI names arrive wrapped in literal double quotes (every row of
// DIM_POIS.NAME carries them), so strip one enclosing pair here rather than in
// each caller - otherwise stop tooltips and load rows read '"SARIZ PETROL"'.
const unquote = (s: string): string =>
  s.length >= 2 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1).trim() : s;

export const place = (city: string | null | undefined, country?: string | null | undefined): string => {
  const c = unquote((city ?? '').trim());
  const cc = (country ?? '').trim();
  if (!c) return cc || '-';
  return cc && cc !== '?' ? `${c} (${cc})` : c;
};

// Idle-hours label: hours under 2 days, else days.
export const fmtIdle = (h: number | null | undefined): string => {
  if (h == null || !Number.isFinite(Number(h))) return '-';
  const n = Number(h);
  return n >= 48 ? `${Math.round(n / 24)}d` : `${Math.round(n)}h`;
};
