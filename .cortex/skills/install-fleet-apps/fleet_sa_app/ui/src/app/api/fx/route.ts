import { NextResponse } from 'next/server';
import { query } from '@/lib/snowflake';
import { logger } from '@/lib/logger';
import { withLogging } from '@/lib/api-handler';

// Freight Exchange helper verbs for the Tier-3 Freight Exchange page.
// - draft_counter: uses AI_COMPLETE (mistral-large2) to draft a professional
//   counter-offer negotiation message given an offer's economics. This is the
//   `fx_draft_counter` capability from the original control app's /api/fx/*.
// Round-trip / bundle optimization reuse the User `optimize_routes` verb via
// /api/tool (VROOM); lane-density H3 + offers load via /api/query directly.

const MODEL = 'mistral-large2';

interface OfferCtx {
  pickup?: string;
  dropoff?: string;
  equipment?: string;
  price?: number;
  per_km?: number;
  market_p50?: number;
  partner?: string;
  target_pct?: number; // desired discount vs offer price
}

function buildPrompt(o: OfferCtx): string {
  const price = Number(o.price) || 0;
  const median = Number(o.market_p50) || 0;
  const targetPct = Number(o.target_pct) || 8;
  const targetPrice = Math.round(price * (1 - targetPct / 100));
  return [
    'You are a freight broker negotiating a backhaul lane. Draft a short, professional',
    'counter-offer message (max 90 words) to the carrier. Be courteous, reference the',
    'market rate, and propose a specific counter price.',
    '',
    `Lane: ${o.pickup ?? 'origin'} -> ${o.dropoff ?? 'destination'}`,
    `Equipment: ${o.equipment ?? 'n/a'}`,
    `Carrier: ${o.partner ?? 'the carrier'}`,
    `Their asking price: ${price} USD` + (o.per_km ? ` (${o.per_km} USD/km)` : ''),
    median ? `Market median rate per km (P50): ${median} USD/km` : '',
    `Your target counter price: ${targetPrice} USD (about ${targetPct}% below ask).`,
    '',
    'Return only the message text, no preamble.',
  ].filter(Boolean).join('\n');
}

async function handlePost(req: Request) {
  let body: { action?: string; offer?: OfferCtx };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const action = String(body.action ?? '');
  if (action !== 'draft_counter') {
    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  }

  const prompt = buildPrompt(body.offer ?? {});
  try {
    const rows = await query('SELECT AI_COMPLETE(?, ?) AS draft', [MODEL, prompt]);
    const row = rows[0] as Record<string, unknown> | undefined;
    const draft = row ? String(Object.values(row)[0] ?? '').trim() : '';
    return NextResponse.json({ ok: true, draft });
  } catch (err) {
    logger.error('fx-draft', { action }, err);
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Draft failed' }, { status: 500 });
  }
}

export const POST = withLogging(handlePost);
