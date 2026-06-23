import { NextRequest } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const tileCache = new Map<string, { buf: Buffer; ts: number }>();
const TILE_CACHE_TTL = 3600_000;

export async function GET(_req: NextRequest, ctx: { params: Promise<{ z: string; x: string; y: string }> }) {
  const { z, x, y } = await ctx.params;
  const key = `${z}/${x}/${y}`;
  const cached = tileCache.get(key);
  if (cached && Date.now() - cached.ts < TILE_CACHE_TTL) {
    return new Response(new Uint8Array(cached.buf), {
      headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' },
    });
  }
  const url = `https://a.basemaps.cartocdn.com/light_all/${z}/${x}/${y}@2x.png`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch(url);
      if (!resp.ok) continue;
      const buf = Buffer.from(await resp.arrayBuffer());
      tileCache.set(key, { buf, ts: Date.now() });
      if (tileCache.size > 5000) {
        const oldest = [...tileCache.entries()].sort((a, b) => a[1].ts - b[1].ts).slice(0, 1000);
        for (const [k] of oldest) tileCache.delete(k);
      }
      return new Response(new Uint8Array(buf), {
        headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' },
      });
    } catch (e) {
      if (attempt < 2) { await new Promise((r) => setTimeout(r, 200 * (attempt + 1))); continue; }
      console.error(`Tile proxy error for ${key}: ${(e as Error).message}`);
      return new Response('Tile fetch failed', { status: 502 });
    }
  }
  return new Response('Tile fetch failed', { status: 502 });
}
