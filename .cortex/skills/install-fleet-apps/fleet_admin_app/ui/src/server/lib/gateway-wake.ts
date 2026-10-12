// Tell a routing gateway that is WAKING UP apart from a region whose routing
// graphs are broken.
//
// ROUTING_GATEWAY_SERVICE auto-suspends after an idle hour (auto_suspend_secs
// 3600). Every ORS function is a service function on that gateway, ORS_STATUS
// included, so the Status & Health page's own readiness probe is what wakes it.
// The first call races the cold start and fails; measured on wgb26798:
//
//   16:11:35.021 UTC  ORS_STATUS('SanFrancisco') -> 100283 "Request failed for
//                     external function _ORS_STATUS_RAW. Error: Could not connect
//                     to server" after 3,694 ms; gateway resumed_on 16:11:35.371
//   16:12:04.325 UTC  same call, SUCCESS in 313 ms
//
// ORS_SERVICE_SANFRANCISCO was RUNNING throughout. The route used to report
// that failure as `error`, which the page renders as a red "Graph Loading
// Failed ... routing functions will return errors" for an engine about to work.
//
// The text alone is not proof: a gateway that has been up for an hour and still
// refuses connections is a real fault. So a match is only treated as waking when
// the gateway's own state agrees - see isGatewayWaking.

import { runSql } from './sql';
import { SF_DATABASE } from '../constants';

// How the gateway reports a connection it could not make. The first is the
// measured cold-start text; the others are the same condition as the gateway
// or SPCS phrase it elsewhere in this repo (routing-suspend.ts, deploy-agent.sql).
const CONNECT_FAILURE_SIGNATURES = [
  /could not connect to server/i,
  /connection refused/i,
  /service_unreachable/i,
];

// A resume older than this is no longer a cold start. The measured wake took
// under 30 s; 300 s leaves room for a busy pool without excusing a real outage.
export const WAKE_WINDOW_S = 300;

// SPCS states in which the gateway is not serving yet but is on its way.
// SUSPENDED counts because the failed call itself triggers auto-resume, so a
// probe a moment later can still read SUSPENDED.
const STARTING_STATES = new Set(['PENDING', 'SUSPENDED', 'RESUMING']);

export interface GatewayState {
  status: string;
  resumedAgoS: number | null;
}

export function isConnectFailure(message: string | null | undefined): boolean {
  if (!message) return false;
  return CONNECT_FAILURE_SIGNATURES.some((re) => re.test(message));
}

export function isGatewayWaking(state: GatewayState | null): boolean {
  if (!state) return false;
  const status = state.status.toUpperCase();
  if (STARTING_STATES.has(status)) return true;
  return status === 'RUNNING' && state.resumedAgoS !== null && state.resumedAgoS <= WAKE_WINDOW_S;
}

// One statement: SHOW piped into a SELECT, so the resume age is computed in SQL
// rather than by parsing a timestamp whose wire format differs between the SPCS
// SQL API and the local CLI transport. Returns null if the probe itself fails;
// the caller then keeps the original error rather than guessing.
export async function readGatewayState(): Promise<GatewayState | null> {
  try {
    const rows = await runSql(
      `SHOW SERVICES LIKE 'ROUTING_GATEWAY_SERVICE' IN SCHEMA ${SF_DATABASE}.CORE `
      + `->> SELECT "status" AS STATUS, DATEDIFF('second', "resumed_on", CURRENT_TIMESTAMP()) AS RESUMED_AGO_S FROM $1`,
    );
    const row = rows?.[0];
    if (!row || row.STATUS == null) return null;
    const ago = row.RESUMED_AGO_S == null ? null : Number(row.RESUMED_AGO_S);
    return { status: String(row.STATUS), resumedAgoS: Number.isFinite(ago) ? ago : null };
  } catch {
    return null;
  }
}

export const GATEWAY_WAKING_MESSAGE =
  'The routing gateway auto-suspends after an hour idle and this check just woke it. '
  + 'It is usually ready within about 30 seconds.';
