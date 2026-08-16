// Pure formatting helpers shared by the Backload Proposals cockpit list/map/
// drawer components. No React.

export const fmtKm = (v: number | null | undefined): string =>
  v == null || !Number.isFinite(Number(v)) ? '-' : Number(v).toFixed(0);

export const fmtSlack = (v: number | null | undefined): string =>
  v == null || !Number.isFinite(Number(v)) ? '-' : Number(v).toFixed(1);

// Neutral place label: "City" or "City (CC)" when a country/region code is
// present and meaningful. Never renders a bare "(?)".
export const place = (city: string | null | undefined, country?: string | null | undefined): string => {
  const c = (city ?? '').trim();
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
