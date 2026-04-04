import { BitmapLayer } from '@deck.gl/layers';
import { TileLayer } from '@deck.gl/geo-layers';

const DWELL_DB = 'FLEET_INTELLIGENCE';
const DWELL_SCHEMA = 'DWELL_ANALYSIS';
const CARTO_LIGHT = '/api/tiles/{z}/{x}/{y}';

export { DWELL_DB, DWELL_SCHEMA };

export async function sfQuery(sql: string, database = DWELL_DB, schema = DWELL_SCHEMA): Promise<any[]> {
  try {
    const res = await fetch('/api/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql, database, schema }),
    });
    const body = await res.json();
    if (body.error) {
      console.error('[sfQuery]', body.error, sql.slice(0, 120));
      return [];
    }
    const rows = Array.isArray(body) ? body : (body.result ?? []);
    return Array.isArray(rows) ? rows : [];
  } catch (err) {
    console.error('[sfQuery] fetch failed:', err);
    return [];
  }
}

export function cartoBasemap() {
  return new TileLayer({
    id: 'carto-basemap',
    data: CARTO_LIGHT,
    minZoom: 0,
    maxZoom: 19,
    tileSize: 256,
    renderSubLayers: (props: any) => {
      const { boundingBox } = props.tile;
      return new BitmapLayer(props, {
        data: undefined,
        image: props.data,
        bounds: [boundingBox[0][0], boundingBox[0][1], boundingBox[1][0], boundingBox[1][1]],
      });
    },
  });
}

export function formatNumber(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toLocaleString();
}
