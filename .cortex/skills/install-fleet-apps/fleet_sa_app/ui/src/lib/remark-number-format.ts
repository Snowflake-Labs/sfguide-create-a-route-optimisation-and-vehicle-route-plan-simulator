// The decimal policy applied to the agent's own PROSE.
//
// WHY THIS EXISTS. lib/format-number.ts is the display half of a two-layer fix,
// and check_number_formatting.py names the hole both layers left open: "the
// agent's PROSE never passes through a React component". That is not a corner
// case on this surface - agent-spec.json instructs the model to present verb and
// analyst results as MARKDOWN TABLES, so the grid a user reads in the agent tab
// is a string the model wrote, not rows a formatter ever saw. A semantic-view
// FACT summed by Cortex Analyst (hours_to_date is declared as a fact, and gate
// rule B wraps ROUND() around METRICS only) arrives as 21289.670000000002 and was
// quoted verbatim.
//
// It is a remark plugin rather than a regex over the raw markdown so that code
// spans and fenced blocks are excluded BY NODE TYPE. A number inside `code` may
// be a literal someone will copy - an id, a coordinate, a snippet of SQL - and
// rewriting it would change meaning, not presentation.
//
// The cap itself is NOT duplicated here: `decimalsFor` from format-number.ts is
// the single source of truth, so widening the policy in one place cannot leave
// prose behind on the old one.

import { decimalsFor, formatNumber } from './format-number';

/** Numbers with a fractional part, with or without thousands separators. An
 *  integer needs no rewrite, so it is deliberately not matched. */
const DECIMAL_RE = /-?\d+(?:,\d{3})*\.\d+/g;

/** Dotted runs of three or more groups: a version, a release tag, an IP. These
 *  are not quantities and the middle group would be mangled into a rounded one
 *  ("v1.1.16" -> "v1.1.16" only because this protects it). */
const DOTTED_SEQUENCE_RE = /\d+(?:\.\d+){2,}/g;

/** A coordinate pair. Prose carries no column name, so the coordinate exemption
 *  in format-number.ts cannot be keyed on one; the recognisable signal is two
 *  high-precision numbers separated by a comma. 2dp of latitude is about a km,
 *  which would move a place to a different part of the city. */
const COORD_PAIR_RE = /-?\d+\.\d{4,}\s*,\s*-?\d+\.\d{4,}/g;

interface Range { start: number; end: number }

function protectedRanges(text: string): Range[] {
  const ranges: Range[] = [];
  for (const re of [DOTTED_SEQUENCE_RE, COORD_PAIR_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      ranges.push({ start: m.index, end: m.index + m[0].length });
    }
  }
  return ranges;
}

/**
 * Rewrite over-precise numeric literals in one run of prose.
 *
 * Exported for the gate and for direct testing: this is the whole behaviour, and
 * it must be convictable without mounting React.
 */
export function formatNumbersInText(text: string): string {
  if (!text.includes('.')) return text;
  const skip = protectedRanges(text);
  DECIMAL_RE.lastIndex = 0;
  return text.replace(DECIMAL_RE, (match, offset: number) => {
    const end = offset + match.length;
    if (skip.some((r) => offset < r.end && end > r.start)) return match;

    const grouped = match.includes(',');
    const value = Number(grouped ? match.replace(/,/g, '') : match);
    if (!Number.isFinite(value)) return match;

    // Already within policy: leave it exactly as written, so a deliberate
    // "12.50" keeps its trailing zero instead of being trimmed to "12.5".
    const fractionDigits = match.split('.')[1]?.length ?? 0;
    if (fractionDigits <= decimalsFor(value)) return match;

    return formatNumber(value, { grouping: grouped }) ?? match;
  });
}

// Minimal mdast shape. Typed locally rather than pulling in @types/mdast, which
// is not a dependency of this app.
interface MdastNode {
  type: string;
  value?: string;
  children?: MdastNode[];
}

/** Node types whose text is a literal to be copied, not prose to be formatted. */
const OPAQUE = new Set(['code', 'inlineCode', 'html', 'math', 'inlineMath']);

function walk(node: MdastNode): void {
  if (OPAQUE.has(node.type)) return;
  if (node.type === 'text' && typeof node.value === 'string') {
    node.value = formatNumbersInText(node.value);
    return;
  }
  for (const child of node.children ?? []) walk(child);
}

/**
 * remark plugin: caps decimals in every text node of a markdown tree.
 *
 * The tree is walked here rather than with unist-util-visit because that package
 * is only present transitively; a direct recursion keeps this file free of a
 * dependency the app's package.json does not declare.
 */
export function remarkNumberFormat() {
  return (tree: MdastNode) => {
    walk(tree);
  };
}
