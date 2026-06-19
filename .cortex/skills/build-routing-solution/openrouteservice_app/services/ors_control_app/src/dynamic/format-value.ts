import { fmtDec } from '../shared/format';
import type { NumberFormat } from './spec-types';

/**
 * Format a raw cell value for display per a NumberFormat. Mirrors the inline
 * formatting the hand-coded pages do (fmtDec for decimals/percent, locale
 * grouping for counts) so converted dashboards match their originals.
 */
export function formatValue(value: unknown, format: NumberFormat = 'number', suffix = ''): string {
  if (value == null || value === '') return '—';
  let out: string;
  switch (format) {
    case 'percent':
      out = `${fmtDec(value, 1)}%`;
      break;
    case 'decimal':
      out = fmtDec(value, 1);
      break;
    case 'integer': {
      const n = Number(value);
      out = Number.isFinite(n) ? Math.round(n).toLocaleString() : String(value);
      break;
    }
    case 'number': {
      const n = Number(value);
      out = Number.isFinite(n) ? n.toLocaleString() : String(value);
      break;
    }
    case 'text':
    default:
      out = String(value);
  }
  if (out === '—') return out;
  return suffix ? `${out}${suffix}` : out;
}
