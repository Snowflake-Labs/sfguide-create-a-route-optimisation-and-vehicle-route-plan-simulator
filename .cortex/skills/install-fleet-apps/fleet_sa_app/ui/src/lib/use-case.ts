import type { SolutionCatalogEntry, UseCase } from './types';

// Two renderings of the single `useCase` block authored per view. Pure functions,
// no React and no store access, so both the info modal and the chat API route can
// call them. Adding a consumer means adding a function here, never copying the
// prose into a second config field.

// Fixed section order for the per-view "i" overlay, in the voice a Solution
// Engineer needs when presenting: what it is, who cares, how to demo it, what it
// proves, what it costs the customer to run, then the honest caveats. Absent
// fields are omitted entirely rather than rendered as empty headings.
export function composeUseCaseMarkdown(uc: UseCase): string {
  const blocks: string[] = [];

  if (uc.headline) blocks.push(uc.headline);
  if (uc.businessQuestion) blocks.push(`**Business question**\n\n${uc.businessQuestion}`);

  const who: string[] = [];
  if (uc.audience?.length) who.push(`Audience: ${uc.audience.join(', ')}`);
  if (uc.industries?.length) who.push(`Industries: ${uc.industries.join(', ')}`);
  if (who.length) blocks.push(`**Who it is for**\n\n${who.join('  \n')}`);

  if (uc.talkTrack?.length) {
    const steps = uc.talkTrack.map((s, i) => `${i + 1}. ${s}`).join('\n');
    blocks.push(`**Demo flow**\n\n${steps}`);
  }
  if (uc.snowflakeCapabilities?.length) {
    blocks.push(`**What it proves**\n\n${bullets(uc.snowflakeCapabilities)}`);
  }
  if (uc.valueDrivers?.length) {
    blocks.push(`**Value**\n\n${bullets(uc.valueDrivers)}`);
  }
  if (uc.dataRequired?.length) {
    blocks.push(`**Data required**\n\n${bullets(uc.dataRequired)}`);
  }
  if (uc.method) blocks.push(`**Method**\n\n${uc.method}`);
  if (uc.caveats) blocks.push(`**Caveats**\n\n${uc.caveats}`);

  return blocks.join('\n\n');
}

function bullets(items: string[]): string {
  return items.map((i) => `- ${i}`).join('\n');
}

// Bounded catalog entry for the chat agent. Keeps only the fields needed to match
// a view to a customer ask; the full talk track is injected only for the view that
// is actually open, so the always-on catalog stays cheap across ~24 views.
export function toCatalogEntry(id: string, label: string, uc: UseCase): SolutionCatalogEntry {
  return {
    id,
    label,
    headline: uc.headline,
    industries: uc.industries,
    audience: uc.audience,
    value: uc.valueDrivers?.[0],
  };
}

// One line per view for the agent prefix. Uses the same [Label](view:id) markdown
// link form the available-views block already defines, so the agent can cite a
// use case and open it in the panel in one step.
export function compactUseCaseLine(entry: SolutionCatalogEntry): string {
  const bits = [`[${entry.label}](view:${entry.id}) - ${entry.headline}`];
  if (entry.industries?.length) bits.push(`industries: ${entry.industries.join(', ')}`);
  if (entry.audience?.length) bits.push(`for: ${entry.audience.join(', ')}`);
  if (entry.value) bits.push(`value: ${entry.value}`);
  return bits.join(' | ');
}
