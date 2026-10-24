// Turns "this object does not exist" into "this layer was not built, run this".
//
// A view over a layer the installer skipped (Location when the region has no
// Overture addresses, a pack that failed) used to surface the raw compilation
// error. With nothing better on screen the user, or the agent explaining it,
// guessed a remedy - a customer was sent to a "Location dataset generator in
// the Admin app", which does not exist. The remedy is already written down in
// repair-map.json (shared with scripts/validate_app_views.py --repair), so the
// message names the real builder instead of leaving room for a guess.
import repairMap from './repair-map.json';

interface RepairEntry {
  prefix: string;
  layer: string;
  label?: string;
  action: string;
  fix?: string[];
  note?: string;
}

const ENTRIES: RepairEntry[] = (repairMap as { entries: RepairEntry[] }).entries;

export const MISSING_DEPENDENCY_REASON = 'missing_dependency';

// The two shapes Snowflake uses for an absent object (measured):
//   Object 'FLEET_APP.LOCATION.VW_X' does not exist or not authorized.
//   Unknown user-defined table function FLEET_APP.LOCATION.LIVE_X
// The same text is raised for a missing grant; the remedy still starts with
// the builder, and the message says so rather than claiming the layer is gone.
const MISSING_RE =
  /(?:(?:Object|Schema|Table|View|Function)\s+'([^']+)'\s+does not exist|Unknown user-defined (?:table )?function\s+([A-Za-z0-9_$."]+))/i;

export function missingObjectName(rawMsg: string): string | null {
  const m = MISSING_RE.exec(rawMsg || '');
  if (!m) return null;
  return (m[1] || m[2] || '').replace(/"/g, '').toUpperCase() || null;
}

export function findRepairEntry(objectName: string): RepairEntry | null {
  const name = objectName.toUpperCase();
  return ENTRIES.find((e) => name.startsWith(e.prefix.toUpperCase())) ?? null;
}

function fixSteps(entry: RepairEntry, region: string | null): string[] {
  const steps = entry.fix ?? [
    entry.action.startsWith('@PACK:')
      ? `snow sql -f .cortex/skills/install-fleet-apps/fleet_sa_app/app/packs/fleet/${entry.action.slice(6)}/setup.sql`
      : entry.action.startsWith('@FILE:')
        ? `snow sql -f .cortex/skills/install-fleet-apps/scripts/${entry.action.slice(6)}`
        : `${entry.action};`,
  ];
  return steps.map((s) => s.replace('{region}', region || '<region>'));
}

/** Operator-facing message for a missing-object error, or null when the error
 *  is not one, or names an object no layer owns. */
export function missingDependencyMessage(rawMsg: string, region: string | null): string | null {
  const obj = missingObjectName(rawMsg);
  if (!obj) return null;
  const entry = findRepairEntry(obj);
  if (!entry) return null;
  const label = entry.label || entry.layer;
  const steps = fixSteps(entry, region);
  return [
    `The ${label} layer is not built in this account (${obj} does not exist or this role cannot read it).`,
    entry.note ?? '',
    `To build it, an operator runs: ${steps.join(' then ')}`,
    'Or run scripts/validate_app_views.py -c <connection> --repair, then reload this view.',
  ]
    .filter(Boolean)
    .join(' ');
}
