'use client';

// Inline chart for Cortex `data_to_chart` results in chat.
//
// WHAT CHANGED AND WHY. This used to hand-translate a Vega-Lite spec onto
// recharts, covering only unlayered bar/line/area/point and assuming x=category,
// y=measure. Two consequences, both observed:
//   - the guidance the agent follows asks for pie, box plot, histogram and
//     dual-axis charts, none of which the translator could express;
//   - even a plain HORIZONTAL bar failed, because a ranked list puts the measure
//     on x and the category on y, so `<Bar dataKey="FACILITY_TYPE">` bound a
//     string and drew nothing.
// Extending it further is reimplementing Vega-Lite, so the spec is now rendered
// by Vega-Lite. Every mark, transform and layer works by construction, and the
// server-side `vega_template` merged into the spec upstream is honoured rather
// than discarded.
//
// vega + vega-lite are large, so this module is reached ONLY through
// chart-deferred.tsx (a lazy boundary mirroring map-deferred.tsx for deck.gl).
// Importing it eagerly would put vega in the initial bundle - checked by
// scripts/check_chart_rendering.py.
//
// The invariant from the original file is kept: a chart we cannot draw must not
// become an empty card. Any parse or compile failure shows the reason plus the
// underlying rows.

import { useEffect, useMemo, useRef, useState } from 'react';
import { compile } from 'vega-lite';
import { View, parse } from 'vega';
// `expressionInterpreter` ships in its own package - it is NOT re-exported by
// `vega`. Importing it from 'vega' compiles under TS only to fail at runtime as
// undefined, which Vega accepts silently and then falls back to `new Function`.
import { expressionInterpreter } from 'vega-interpreter';
import { useStyleConfig, resolveChartPalette } from '@/lib/style-config';
import { themeSpec } from '@/lib/vega-theme';
import { extractChartSpecs, sizeSpec, type ChartRow } from '@/lib/chart-spec';
import { DataTable } from './data-table';

const DEFAULT_HEIGHT = 260;

function FallbackNote({ reason, rows }: { reason: string; rows: ChartRow[] }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <div style={{ fontSize: '12px', color: 'var(--text-secondary, #6b7280)' }}>{reason}</div>
      {rows.length ? (
        <DataTable
          columns={Object.keys(rows[0]).map((k) => ({ key: k, label: k }))}
          rows={rows}
          totalRows={rows.length}
        />
      ) : null}
    </div>
  );
}

/** One themed Vega-Lite spec, compiled and mounted into its own container. */
function VegaChart({ spec, palette, height }: {
  spec: Record<string, unknown>;
  palette: string[];
  height: number;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Compiled outside the mount effect so a bad spec is reported even if the
  // container never gets a width (an effect that throws would otherwise leave a
  // permanently blank box with nothing on screen to explain it).
  const compiled = useMemo(() => {
    try {
      const prepared = sizeSpec(themeSpec(spec, palette), height);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { spec: vegaSpec } = compile(prepared as any);
      return { vegaSpec };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }, [spec, palette, height]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !('vegaSpec' in compiled) || !compiled.vegaSpec) return;
    let view: View | null = null;
    try {
      view = new View(parse(compiled.vegaSpec, undefined, { ast: true }), {
        renderer: 'canvas',
        container: host,
        hover: true,
        // `ast: true` + the interpreter evaluates Vega expressions through the
        // parsed AST instead of generating functions with `new Function`, so the
        // charts keep working if a CSP without 'unsafe-eval' is ever applied to
        // the app's ingress.
        expr: expressionInterpreter,
      });
      void view.runAsync();
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
    return () => { view?.finalize(); };
  }, [compiled]);

  const failure = 'error' in compiled ? compiled.error : error;
  if (failure) {
    return <FallbackNote reason={`chart could not be rendered: ${failure}`} rows={[]} />;
  }
  // width:100% + overflow hidden so `width: "container"` measures the bubble and
  // a wide legend cannot push the chat panel sideways.
  return <div ref={hostRef} style={{ width: '100%', overflow: 'hidden' }} />;
}

export function ChartInline(props: Record<string, unknown>) {
  const palette = resolveChartPalette(useStyleConfig());
  const height = typeof props.height === 'number' ? props.height : DEFAULT_HEIGHT;
  const bundle = useMemo(() => extractChartSpecs(props), [props]);

  if (bundle.specs.length === 0) {
    return <FallbackNote reason={bundle.reason ?? 'no chart in result'} rows={bundle.rows} />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', margin: '6px 0' }}>
      {bundle.specs.map((spec, i) => (
        <VegaChart key={i} spec={spec} palette={palette} height={height} />
      ))}
      {bundle.reason ? (
        <div style={{ fontSize: '12px', color: 'var(--text-secondary, #6b7280)' }}>{bundle.reason}</div>
      ) : null}
    </div>
  );
}
