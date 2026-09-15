/**
 * Shared budget for agent memos: the ONE place the publisher and the consumer
 * agree on how much on-screen text can reach the model.
 *
 * This lives apart from `lib/agent-memo.ts` because that module is `'use client'`
 * and carries React hooks and the zustand store, while the consumer
 * (`app/api/chat/route.ts`) is a server route. A server route importing the
 * client module would drag both into the server bundle, so the numbers live here
 * and `agent-memo.ts` re-exports them for the components.
 *
 * WHY THEY ARE SHARED AT ALL: they drifted once, and the failure was silent. The
 * backload assignments memo grew to 3,627 chars against a consumer total of
 * 3,000, and because the consumer trimmed WHOLE PANELS, the only memo on that
 * view was deleted outright. The agent kept the scalar KPIs (published as
 * "Active filters"), so it could total a 21-trip plan and could not name a
 * single trip in it - and nothing anywhere reported a problem.
 */

/** Total memo budget across ALL panels of a view, enforced in the chat route. */
export const MEMO_TOTAL_MAX = 3600;

/**
 * Per-memo budget for pages that publish a LIST of records (backload
 * assignments, backload proposals, triangle chains) rather than a table sample.
 * Deliberately below MEMO_TOTAL_MAX so such a page still fits alongside a KPI
 * strip. Bounding by ROW COUNT alone is not a bound: 12 rows of unbounded prose
 * is unbounded.
 */
export const TRIP_MEMO_MAX_LEN = 2200;
