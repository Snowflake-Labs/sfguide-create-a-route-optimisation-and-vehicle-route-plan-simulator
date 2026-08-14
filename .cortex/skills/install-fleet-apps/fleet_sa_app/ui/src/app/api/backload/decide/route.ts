import { NextResponse } from 'next/server';
import { query } from '@/lib/snowflake';
import { logger } from '@/lib/logger';
import { withLogging } from '@/lib/api-handler';

// Backload Matching decision write-back.
//
// The page posts the accepted trailer<->load matches; we INSERT them into
// FLEET_INTELLIGENCE.BACKLOAD_MATCHING.PROPOSAL_DECISIONS (the audit table the
// SV_BACKLOAD_MATCHING semantic view reads). /api/query is SELECT-only, so the
// write path lives here. Values are bound (never string-concatenated) so free
// text (rationale) can contain quotes safely.
//
// Body: { decisions: [{ trailerId, offerId, source, score, emptyKm, netBenefitUsd, rationale }], decidedBy? }

interface Decision {
  trailerId?: string;
  offerId?: string;
  source?: string;
  score?: number;
  emptyKm?: number;
  netBenefitUsd?: number;
  rationale?: string;
}

async function handlePost(req: Request) {
  let body: { decisions?: Decision[]; decidedBy?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const decisions = Array.isArray(body.decisions) ? body.decisions : [];
  if (!decisions.length) {
    return NextResponse.json({ error: 'decisions[] is required' }, { status: 400 });
  }
  const decidedBy = typeof body.decidedBy === 'string' && body.decidedBy.trim()
    ? body.decidedBy.trim() : 'dispatcher';

  // One multi-row INSERT ... VALUES with fully-bound params.
  const rowsSql: string[] = [];
  const binds: (string | number | null)[] = [];
  for (const d of decisions) {
    rowsSql.push('(?, ?, ?, ?, ?, ?, ?, ?)');
    binds.push(
      d.trailerId ?? null,
      d.offerId ?? null,
      d.source ?? null,
      Number.isFinite(d.score as number) ? (d.score as number) : null,
      Number.isFinite(d.emptyKm as number) ? (d.emptyKm as number) : null,
      Number.isFinite(d.netBenefitUsd as number) ? (d.netBenefitUsd as number) : null,
      decidedBy,
      d.rationale ?? null,
    );
  }

  const sql =
    `INSERT INTO FLEET_INTELLIGENCE.BACKLOAD_MATCHING.PROPOSAL_DECISIONS ` +
    `(TRAILER_ID, OFFER_ID, SOURCE, SCORE, EMPTY_KM, NET_BENEFIT_USD, DECIDED_BY, RATIONALE) ` +
    `VALUES ${rowsSql.join(', ')}`;

  try {
    await query(sql, binds);
    return NextResponse.json({ ok: true, written: decisions.length });
  } catch (err) {
    logger.error('backload-decide', {}, err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Decision write failed' },
      { status: 500 },
    );
  }
}

export const POST = withLogging(handlePost);
