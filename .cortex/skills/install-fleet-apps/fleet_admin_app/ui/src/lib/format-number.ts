// Single source of truth for how numbers are shown to a user.
//
// Why this module exists: FLOAT columns summed in a semantic view come back as
// 21289.670000000002, and every render site used to stringify rows verbatim
// (String(v)), so the artifact reached the screen - and, via the agent memo,
// got quoted back as fact. Rounding in SQL alone is not enough (a raw String(v)
// still prints whatever arrives), and formatting alone is not enough (the
// agent's own prose never passes through this file). Both layers are needed;
// this is the display half.
//
// Policy: at most 2 decimals, with two deliberate exemptions.
//   - Coordinate columns keep 5 decimals. 2dp of latitude is ~1 km of error,
//     which would visibly break map tooltips and detail panels.
//   - Values with |v| < 1 keep up to 4 decimals, so ratios and fractional
//     percentages stay readable instead of collapsing to 0.04.
// Grouping has one exemption of its own: a column whose integers are LABELS - a
// year, a week number, an id, a postcode - gets no thousands separator, because
// `YEAR 2026` reading as "2,026" is a misrepresentation, not a style choice.
// Integers, non-finite values, strings and nulls are passed through untouched,
// so ids, years, H3 cell indexes and codes like TEAM-04 are never rewritten.

/** Decimal cap for ordinary numbers. */
export const MAX_DECIMALS = 2;
/** Decimal cap for latitude/longitude-style columns. */
export const COORD_DECIMALS = 5;
/** Decimal cap for magnitudes below 1, where 2dp would destroy the signal. */
export const SMALL_MAGNITUDE_DECIMALS = 4;

// Matched against the column name, so the exemption is driven by what the value
// means rather than by its magnitude (a longitude of 0.5 is still a longitude).
const COORD_COLUMN_RE =
  /(^|[^a-z])(lat|lats|latitude|lon|lng|long|longitude|coord|coords|coordinate|coordinates|x_coord|y_coord)([^a-z]|$)/i;

// Columns whose integers are LABELS, not quantities: a calendar year, a week or
// quarter number, an id, a postcode. A thousands separator on one of these is
// simply wrong - `YEAR 2026` rendered as "2,026", which is what caught this.
//
// Anchored to the FINAL token, not any token. A leading-token match exempted
// `ZIP_POPULATION`, which is a population and must keep its separator; what makes
// a column an identifier is its head noun, so `TRIP_YEAR` and `OPERATOR_ID` match
// while `ZIP_POPULATION` and `IDLE_DAYS` do not.
const IDENTIFIER_COLUMN_RE =
  /(^|_)(year|yr|week|weeknum|week_num|iso_week|quarter|qtr|month|monthnum|month_num|day_of_week|dow|id|ids|code|zip|zipcode|postcode|postal_code|fips|msa|cbsa|h3|geoid)$/i;

export interface NumberFormatOptions {
  /** Source column name, used to detect the coordinate and identifier exemptions. */
  column?: string;
  /** Declarative format key from a view spec, e.g. 'currency' | 'percent'. */
  format?: string;
  /** Emit thousands separators. Defaults to false. */
  grouping?: boolean;
  /** Compact large magnitudes to K/M. Defaults to false. */
  compact?: boolean;
}

/** True when a column holds geographic coordinates and needs sub-metre precision. */
export function isCoordinateColumn(column?: string): boolean {
  if (!column) return false;
  return COORD_COLUMN_RE.test(column);
}

/**
 * True when a column's integers identify something rather than measure it, so a
 * thousands separator would misrepresent them (2026 is a year, not 2,026).
 *
 * Deliberately consulted only for the grouping decision, never for the decimal
 * cap: an id that somehow carries decimals still gets capped.
 */
export function isIdentifierColumn(column?: string): boolean {
  if (!column) return false;
  return IDENTIFIER_COLUMN_RE.test(column);
}

/** Whether this value should carry thousands separators, given its column. */
export function useGroupingFor(value: number, column: string | undefined, requested: boolean): boolean {
  if (!requested) return false;
  // Only integers are exempt. A decimal in an id-named column is a measure that
  // happens to share the name, and grouping it is harmless.
  return !(Number.isInteger(value) && isIdentifierColumn(column));
}

/** Decimal places this value is allowed, under the policy documented above. */
export function decimalsFor(value: number, column?: string): number {
  if (Number.isInteger(value)) return 0;
  if (isCoordinateColumn(column)) return COORD_DECIMALS;
  if (Math.abs(value) < 1) return SMALL_MAGNITUDE_DECIMALS;
  return MAX_DECIMALS;
}

/** The value as it will be displayed, as a number. Useful for chart encodings. */
export function roundForDisplay(value: number, column?: string): number {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** decimalsFor(value, column);
  return Math.round(value * factor) / factor;
}

function toFixedTrimmed(value: number, decimals: number, grouping: boolean): string {
  // maximumFractionDigits is the cap; minimumFractionDigits stays 0 so 21289.70
  // reads as 21289.7 and an integral 1065 does not gain a phantom ".00".
  return value.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
    useGrouping: grouping,
  });
}

/**
 * Format a value under the decimal policy.
 *
 * Returns null - not a string - when the value is not a finite number, so each
 * call site keeps its own placeholder ('-', '', or the original string) instead
 * of this module guessing one.
 */
export function formatNumber(value: unknown, opts: NumberFormatOptions = {}): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    // Numeric strings from a JSON payload are still numbers to a reader.
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
      return formatNumber(Number(value), opts);
    }
    return null;
  }

  const { column, format, grouping: groupingRequested = false, compact = false } = opts;
  const grouping = useGroupingFor(value, column, groupingRequested);

  if (format === 'currency') {
    // Money keeps exactly 2dp: $12.5 reads as an error, $12.50 does not.
    const abs = Math.abs(value);
    if (compact && abs >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
    if (compact && abs >= 1_000) return `$${(value / 1_000).toFixed(2)}K`;
    return `$${value.toLocaleString(undefined, {
      minimumFractionDigits: MAX_DECIMALS,
      maximumFractionDigits: MAX_DECIMALS,
      useGrouping: grouping,
    })}`;
  }

  if (format === 'percent') {
    // A fraction in the source; the scaled value is >= 1 for anything material,
    // so the sub-1 exemption is applied after scaling, not before.
    const scaled = value * 100;
    return `${toFixedTrimmed(scaled, decimalsFor(scaled), grouping)}%`;
  }

  if (compact) {
    const abs = Math.abs(value);
    if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(MAX_DECIMALS)}M`;
    if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  }

  return toFixedTrimmed(value, decimalsFor(value, column), grouping);
}

const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

export interface CellFormatOptions extends NumberFormatOptions {
  /** Shown when the value is null/undefined/''. Defaults to '-'. */
  empty?: string;
  /** Render ISO-8601 strings as locale datetimes. Defaults to true. */
  dates?: boolean;
}

/**
 * Table/tooltip cell renderer: the decimal policy plus the empty placeholder and
 * ISO-date handling that every grid in the app needs. Always returns a string.
 */
export function formatCellValue(value: unknown, opts: CellFormatOptions = {}): string {
  const { empty = '-', dates = true, ...numberOpts } = opts;
  if (value === null || value === undefined || value === '') return empty;

  const asNumber = typeof value === 'number' ? formatNumber(value, numberOpts) : null;
  if (asNumber !== null) return asNumber;

  if (dates && typeof value === 'string' && ISO_DATETIME_RE.test(value)) {
    const d = new Date(value);
    if (!isNaN(d.getTime())) {
      return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    }
  }

  return String(value);
}
