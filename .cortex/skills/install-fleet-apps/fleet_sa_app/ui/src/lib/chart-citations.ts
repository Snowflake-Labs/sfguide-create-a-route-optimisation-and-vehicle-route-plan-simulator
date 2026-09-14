// Placing an agent-cited chart where the agent cited it.
//
// The host chart skill tells the agent to cite a chart INLINE in its answer text
// as `<chart>tooluse_ID</chart>`, matching the id of the data_to_chart call.
// Nothing consumed that: `TextPart` renders markdown without `rehype-raw`, so
// the tag was dropped silently and the chart rendered wherever its tool_result
// happened to land in the part stream - which is BEFORE the prose, since the
// tool runs first. Observed exactly that way in a live turn.
//
// This module rewrites a message's parts so a cited chart sits at its citation
// point, and strips the citation tags either way so no raw tag can leak into the
// rendered markdown.
//
// DEGRADATION IS DELIBERATE. An unmatched citation, a chart with no id, or a
// host that sends no ids at all leaves the chart in its original position. The
// failure mode of this feature must be "chart in the wrong place", never
// "chart missing" - the same rule the rest of the chat rendering follows.

import type { MessagePart } from './types';
import { isChartTool } from './tool-names';

/** Citation tags the host may put in answer text. `chart` is the one we place;
 *  the others are stripped so they cannot surface as literal text if a future
 *  host emits them. */
const CITATION_TAG_RE = /<(chart|map|table)>\s*([^<>\s]+)\s*<\/\1>/g;

/** True when a part is a chart tool result. */
function isChartPart(part: MessagePart): boolean {
  return part.type === 'tool_result' && isChartTool(part.toolName);
}

/** Remove every citation tag from a markdown string. */
export function stripCitationTags(text: string): string {
  return text.replace(CITATION_TAG_RE, '');
}

/**
 * Reorder parts so each cited chart renders at its citation point.
 *
 * Text carrying a citation is split around it, with the chart part spliced
 * between the halves. Charts that no citation names keep their original slot.
 */
export function resolveChartCitations(parts: MessagePart[]): MessagePart[] {
  const chartsById = new Map<string, MessagePart>();
  for (const part of parts) {
    if (isChartPart(part) && part.type === 'tool_result' && part.toolUseId) {
      chartsById.set(part.toolUseId, part);
    }
  }
  if (chartsById.size === 0) {
    // Still strip tags: with no ids to match, the tag is pure noise.
    return parts.map((p) => (p.type === 'text'
      ? { ...p, content: stripCitationTags(p.content) }
      : p));
  }

  const placed = new Set<string>();
  const out: MessagePart[] = [];

  for (const part of parts) {
    if (part.type !== 'text') {
      // Hold back charts until we know whether a citation claims them.
      if (isChartPart(part) && part.type === 'tool_result' && part.toolUseId
          && chartsById.has(part.toolUseId)) {
        continue;
      }
      out.push(part);
      continue;
    }

    let cursor = 0;
    let matched = false;
    for (const m of part.content.matchAll(CITATION_TAG_RE)) {
      const [tag, kind, id] = m;
      const chart = kind === 'chart' ? chartsById.get(id) : undefined;
      const start = m.index ?? 0;
      if (!chart || placed.has(id)) {
        // Unknown or duplicate citation: drop the tag, keep the prose intact.
        const before = part.content.slice(cursor, start);
        if (before) out.push({ type: 'text', content: before });
        cursor = start + tag.length;
        matched = true;
        continue;
      }
      const before = part.content.slice(cursor, start);
      if (before.trim()) out.push({ type: 'text', content: before });
      out.push(chart);
      placed.add(id);
      cursor = start + tag.length;
      matched = true;
    }
    if (!matched) {
      out.push(part);
      continue;
    }
    const rest = part.content.slice(cursor);
    if (rest.trim()) out.push({ type: 'text', content: rest });
  }

  // Any held-back chart no citation claimed goes back at the end, so a citation
  // the agent forgot to write still shows its chart.
  for (const [id, chart] of chartsById) {
    if (!placed.has(id)) out.push(chart);
  }

  return out;
}
