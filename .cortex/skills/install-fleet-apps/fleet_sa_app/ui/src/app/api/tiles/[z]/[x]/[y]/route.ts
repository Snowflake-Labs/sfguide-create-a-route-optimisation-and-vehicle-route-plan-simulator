import { NextResponse } from 'next/server';

// CARTO basemap tile proxy (ported from the control app's /api/tiles route).
// Proxies light_all raster tiles so the deck.gl TileLayer can fetch them
// same-origin, with a small in-memory LRU-ish cache.

const TILE_CACHE_TTL = 86_400_000; // 24h
const tileCache = new Map<string, { buf: Buffer; ts: number }>();

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ z: string; x: string; y: string }> },
) {
  const { z, x, y } = await ctx.params;
  if (!/^\d+$/.test(z) || !/^\d+$/.test(x) || !/^\d+$/.test(y)) {
    return new NextResponse('Bad tile coords', { status: 400 });
  }

  const key = `${z}/${x}/${y}`;
  const cached = tileCache.get(key);
  if (cached && Date.now() - cached.ts < TILE_CACHE_TTL) {
    return new NextResponse(new Uint8Array(cached.buf), {
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
      return new NextResponse(new Uint8Array(buf), {
        headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' },
      });
    } catch {
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
        continue;
      }
      return new NextResponse('Tile fetch failed', { status: 502 });
    }
  }
  return new NextResponse('Tile fetch failed', { status: 502 });
}
