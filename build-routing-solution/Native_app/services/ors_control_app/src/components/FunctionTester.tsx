import { useState, useCallback } from 'react';

const FUNCTIONS = [
  { name: 'DIRECTIONS', sig: "(method, start, end)", example: { method: 'driving-car', start: [-122.4194, 37.7749], end: [-122.4082, 37.7852] } },
  { name: 'DIRECTIONS_GEO', sig: "(method, start, end) → TABLE", example: {} },
  { name: 'ISOCHRONES', sig: "(method, lon, lat, range)", example: { method: 'driving-car', lon: -122.4194, lat: 37.7749, range: 600 } },
  { name: 'ISOCHRONES_GEO', sig: "(method, lon, lat, range) → TABLE", example: {} },
  { name: 'OPTIMIZATION', sig: "(jobs, vehicles)", example: {} },
  { name: 'OPTIMIZATION_GEO', sig: "(jobs, vehicles) → TABLE", example: {} },
  { name: 'MATRIX', sig: "(method, locations)", example: { method: 'driving-car', locations: [[-122.4194, 37.7749], [-122.4082, 37.7852]] } },
  { name: 'MATRIX_TABULAR', sig: "(method, origin, destinations)", example: { method: 'driving-car', origin: [-122.4194, 37.7749], destinations: [[-122.4082, 37.7852], [-122.3965, 37.7925]] } },
  { name: 'ORS_STATUS', sig: "()", example: {} },
  { name: 'CHECK_HEALTH', sig: "() → BOOLEAN", example: {} },
];

export default function FunctionTester() {
  const [selectedFn, setSelectedFn] = useState('ORS_STATUS');
  const [sqlInput, setSqlInput] = useState("SELECT CORE.ORS_STATUS()");
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [duration, setDuration] = useState<number | null>(null);

  const generateSql = useCallback((fnName: string) => {
    const fn = FUNCTIONS.find((f) => f.name === fnName);
    if (!fn) return;
    setSelectedFn(fnName);
    switch (fnName) {
      case 'ORS_STATUS':
        setSqlInput('SELECT CORE.ORS_STATUS()');
        break;
      case 'CHECK_HEALTH':
        setSqlInput('SELECT CORE.CHECK_HEALTH()');
        break;
      case 'DIRECTIONS':
        setSqlInput(`SELECT CORE.DIRECTIONS('driving-car', ARRAY_CONSTRUCT(-122.4194, 37.7749), ARRAY_CONSTRUCT(-122.4082, 37.7852))`);
        break;
      case 'DIRECTIONS_GEO':
        setSqlInput(`SELECT * FROM TABLE(CORE.DIRECTIONS_GEO('driving-car', ARRAY_CONSTRUCT(-122.4194, 37.7749), ARRAY_CONSTRUCT(-122.4082, 37.7852)))`);
        break;
      case 'ISOCHRONES':
        setSqlInput(`SELECT CORE.ISOCHRONES('driving-car', -122.4194, 37.7749, 10)`);
        break;
      case 'ISOCHRONES_GEO':
        setSqlInput(`SELECT * FROM TABLE(CORE.ISOCHRONES_GEO('driving-car', -122.4194, 37.7749, 10))`);
        break;
      case 'MATRIX':
        setSqlInput(`SELECT CORE.MATRIX('driving-car', PARSE_JSON('[[-122.4194,37.7749],[-122.4082,37.7852]]'))`);
        break;
      case 'MATRIX_TABULAR':
        setSqlInput(`SELECT CORE.MATRIX_TABULAR('driving-car', ARRAY_CONSTRUCT(-122.4194, 37.7749), ARRAY_CONSTRUCT(ARRAY_CONSTRUCT(-122.4082, 37.7852), ARRAY_CONSTRUCT(-122.3965, 37.7925)))`);
        break;
      case 'OPTIMIZATION':
        setSqlInput(`SELECT CORE.OPTIMIZATION(\n  ARRAY_CONSTRUCT(\n    OBJECT_CONSTRUCT('id', 1, 'location', ARRAY_CONSTRUCT(-122.4194, 37.7749)),\n    OBJECT_CONSTRUCT('id', 2, 'location', ARRAY_CONSTRUCT(-122.4082, 37.7852))\n  ),\n  ARRAY_CONSTRUCT(\n    OBJECT_CONSTRUCT('id', 1, 'start', ARRAY_CONSTRUCT(-122.4313, 37.7691), 'end', ARRAY_CONSTRUCT(-122.4313, 37.7691))\n  )\n)`);
        break;
      case 'OPTIMIZATION_GEO':
        setSqlInput(`SELECT * FROM TABLE(CORE.OPTIMIZATION_GEO(\n  ARRAY_CONSTRUCT(\n    OBJECT_CONSTRUCT('id', 1, 'location', ARRAY_CONSTRUCT(-122.4194, 37.7749)),\n    OBJECT_CONSTRUCT('id', 2, 'location', ARRAY_CONSTRUCT(-122.4082, 37.7852))\n  ),\n  ARRAY_CONSTRUCT(\n    OBJECT_CONSTRUCT('id', 1, 'start', ARRAY_CONSTRUCT(-122.4313, 37.7691), 'end', ARRAY_CONSTRUCT(-122.4313, 37.7691))\n  )\n))`);
        break;
    }
  }, []);

  const executeQuery = useCallback(async () => {
    setRunning(true);
    setResult(null);
    setError(null);
    const start = Date.now();
    try {
      const resp = await fetch('/api/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql: sqlInput }),
      });
      const data = await resp.json();
      setDuration(Date.now() - start);
      if (data.error) {
        setError(data.error);
      } else {
        setResult(data.result);
      }
    } catch (err: any) {
      setDuration(Date.now() - start);
      setError(err.message);
    }
    setRunning(false);
  }, [sqlInput]);

  return (
    <div className="panel">
      <h2>Function Tester</h2>
      <p className="subtitle">Test ORS routing functions directly</p>

      <h3>Select Function</h3>
      <div className="fn-grid">
        {FUNCTIONS.map((fn) => (
          <button key={fn.name} className={`fn-card ${selectedFn === fn.name ? 'active' : ''}`} onClick={() => generateSql(fn.name)}>
            <div className="fn-name">{fn.name}</div>
            <div className="fn-sig">{fn.sig}</div>
          </button>
        ))}
      </div>

      <h3>SQL Query</h3>
      <textarea
        className="sql-editor"
        value={sqlInput}
        onChange={(e) => setSqlInput(e.target.value)}
        rows={Math.max(3, sqlInput.split('\n').length)}
        spellCheck={false}
      />
      <div className="action-row">
        <button className="btn primary" onClick={executeQuery} disabled={running || !sqlInput.trim()}>
          {running ? 'Running...' : 'Execute'}
        </button>
        {duration !== null && <span className="duration">{duration}ms</span>}
      </div>

      {error && (
        <div className="error-banner">
          <strong>Error:</strong> {error}
        </div>
      )}

      {result !== null && (
        <div className="result-panel">
          <h3>Result</h3>
          <pre className="result-json">{typeof result === 'string' ? result : JSON.stringify(result, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}
