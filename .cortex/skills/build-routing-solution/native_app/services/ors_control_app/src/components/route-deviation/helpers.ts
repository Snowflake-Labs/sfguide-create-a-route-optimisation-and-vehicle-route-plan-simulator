import { BitmapLayer } from '@deck.gl/layers';
import { TileLayer } from '@deck.gl/geo-layers';

const RD_DB = 'FLEET_INTELLIGENCE';
const RD_SCHEMA = 'ROUTE_DEVIATION';
const CARTO_LIGHT = '/api/tiles/{z}/{x}/{y}';

export { RD_DB, RD_SCHEMA };

export async function sfQuery(sql: string, database = RD_DB, schema = RD_SCHEMA): Promise<any[]> {
  try {
    const res = await fetch('/api/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql, database, schema }),
    });
    const body = await res.json();
    const rows = Array.isArray(body) ? body : (body.result ?? []);
    return Array.isArray(rows) ? rows : [];
  } catch {
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
