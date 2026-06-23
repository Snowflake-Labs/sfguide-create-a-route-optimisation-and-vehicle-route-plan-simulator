export function fmtDec(v: unknown, decimals = 1): string {
  const n = Number(v);
  if (v == null || v === '' || isNaN(n)) return '—';
  return n.toFixed(decimals);
}
