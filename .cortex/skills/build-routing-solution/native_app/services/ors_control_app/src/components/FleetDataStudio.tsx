import { useState, useEffect, useCallback, useRef, useMemo } from 'react';

interface Preset { id: string; name: string; description: string; parameters: Record<string, any>; }
interface Job { id: string; status: string; progress: number; preset: string; started_at: string; completed_at?: string; }

async function studioFetch(path: string, options?: RequestInit): Promise<any> {
  try {
    const res = await fetch(`/api/studio${path}`, options);
    const body = await res.json();
    return body;
  } catch { return null; }
}

export default function FleetDataStudio() {
  const [presets, setPresets] = useState<Preset[]>([]);
  const [selectedPreset, setSelectedPreset] = useState<Preset | null>(null);
  const [params, setParams] = useState<Record<string, any>>({});
  const [jobs, setJobs] = useState<Job[]>([]);
  const [runningJobId, setRunningJobId] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState('');
  const [generatePrompt, setGeneratePrompt] = useState('');
  const [generating, setGenerating] = useState(false);
  const [generatedResult, setGeneratedResult] = useState('');
  const progressRef = useRef<EventSource | null>(null);

  useEffect(() => {
    studioFetch('/presets').then(r => { if (Array.isArray(r)) setPresets(r); });
    studioFetch('/jobs').then(r => { if (Array.isArray(r)) setJobs(r); });
  }, []);

  const selectPreset = useCallback((p: Preset) => {
    setSelectedPreset(p);
    setParams(p.parameters ? { ...p.parameters } : {});
  }, []);

  const runJob = useCallback(async () => {
    if (!selectedPreset) return;
    setStatus('Starting...');
    setProgress(0);
    const result = await studioFetch('/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preset_id: selectedPreset.id, parameters: params }),
    });
    if (result?.id) {
      setRunningJobId(result.id);
      const es = new EventSource(`/api/studio/jobs/${result.id}/progress`);
      progressRef.current = es;
      es.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          setProgress(data.progress || 0);
          setStatus(data.status || '');
          if (data.status === 'completed' || data.status === 'failed') {
            es.close();
            setRunningJobId(null);
            studioFetch('/jobs').then(r => { if (Array.isArray(r)) setJobs(r); });
          }
        } catch {}
      };
      es.onerror = () => { es.close(); setRunningJobId(null); };
    }
  }, [selectedPreset, params]);

  const generate = useCallback(async () => {
    if (!generatePrompt.trim()) return;
    setGenerating(true);
    setGeneratedResult('');
    try {
      const res = await fetch('/api/studio/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: generatePrompt }),
      });
      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      let result = '';
      if (reader) {
        let done = false;
        while (!done) {
          const { value, done: d } = await reader.read();
          done = d;
          if (value) {
            const chunk = decoder.decode(value, { stream: true });
            const lines = chunk.split('\n');
            for (const line of lines) {
              if (line.startsWith('data: ')) {
                try {
                  const parsed = JSON.parse(line.slice(6));
                  if (parsed.content) { result += parsed.content; setGeneratedResult(result); }
                } catch {}
              }
            }
          }
        }
      }
    } catch {}
    setGenerating(false);
  }, [generatePrompt]);

  useEffect(() => { return () => { progressRef.current?.close(); }; }, []);

  const paramEntries = useMemo(() => Object.entries(params), [params]);
  const paramSections = useMemo(() => {
    const sections: Record<string, [string, any][]> = {};
    paramEntries.forEach(([k, v]) => {
      const [section = 'General'] = k.includes('.') ? k.split('.') : ['General'];
      if (!sections[section]) sections[section] = [];
      sections[section].push([k, v]);
    });
    return sections;
  }, [paramEntries]);

  return (
    <div className="panel">
      <h2 style={{ fontSize: 20, marginBottom: 4 }}>Data Studio</h2>
      <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 16 }}>Generate and manage fleet data pipelines</p>

      <div style={{ display: 'grid', gridTemplateColumns: '250px 1fr 280px', gap: 16, minHeight: 500 }}>
        <div style={{ borderRight: '1px solid var(--border)', paddingRight: 16, overflowY: 'auto', maxHeight: 600 }}>
          <h3 style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>Presets</h3>
          {presets.map(p => (
            <div key={p.id} onClick={() => selectPreset(p)} style={{ padding: '10px 12px', borderRadius: 8, marginBottom: 6, cursor: 'pointer', border: '1px solid var(--border)', background: selectedPreset?.id === p.id ? 'rgba(41,181,232,0.08)' : 'transparent', transition: 'all 0.15s' }}>
              <div style={{ fontSize: 13, fontWeight: 500 }}>{p.name}</div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>{p.description}</div>
            </div>
          ))}
          {presets.length === 0 && <div style={{ color: 'var(--text-secondary)', fontSize: 13, padding: 16, textAlign: 'center' }}>No presets found</div>}
        </div>

        <div style={{ overflowY: 'auto', maxHeight: 600 }}>
          {selectedPreset ? (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
                <div>
                  <h3 style={{ fontSize: 16, margin: 0 }}>{selectedPreset.name}</h3>
                  <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: 0 }}>{selectedPreset.description}</p>
                </div>
                <button className="btn-primary" onClick={runJob} disabled={!!runningJobId}>{runningJobId ? 'Running...' : 'Run Job'}</button>
              </div>

              {runningJobId && (
                <div style={{ marginBottom: 16, padding: 12, borderRadius: 8, background: 'rgba(41,181,232,0.06)', border: '1px solid rgba(41,181,232,0.15)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
                    <span>{status}</span><span>{progress}%</span>
                  </div>
                  <div style={{ height: 6, borderRadius: 3, background: 'var(--border)', overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${progress}%`, background: 'var(--accent)', borderRadius: 3, transition: 'width 0.3s' }} />
                  </div>
                </div>
              )}

              {Object.entries(paramSections).map(([section, entries]) => (
                <div key={section} style={{ marginBottom: 16 }}>
                  <h4 style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>{section}</h4>
                  <div style={{ display: 'grid', gap: 8 }}>
                    {entries.map(([key, val]) => (
                      <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <label style={{ flex: '0 0 140px', fontSize: 12, color: 'var(--text-secondary)' }}>{key.split('.').pop()}</label>
                        {typeof val === 'boolean' ? (
                          <input type="checkbox" checked={val} onChange={e => setParams(prev => ({ ...prev, [key]: e.target.checked }))} />
                        ) : typeof val === 'number' ? (
                          <input type="number" className="select" value={val} onChange={e => setParams(prev => ({ ...prev, [key]: Number(e.target.value) }))} style={{ width: 100 }} />
                        ) : (
                          <input className="select" value={String(val)} onChange={e => setParams(prev => ({ ...prev, [key]: e.target.value }))} style={{ flex: 1 }} />
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))}

              <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
                <h4 style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 8, textTransform: 'uppercase' }}>AI Generate</h4>
                <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                  <input className="select" value={generatePrompt} onChange={e => setGeneratePrompt(e.target.value)} onKeyDown={e => e.key === 'Enter' && generate()} placeholder="Describe what to generate..." style={{ flex: 1 }} />
                  <button className="btn-primary" onClick={generate} disabled={generating}>{generating ? '...' : 'Generate'}</button>
                </div>
                {generatedResult && <pre style={{ fontSize: 11, background: 'rgba(0,0,0,0.04)', padding: 12, borderRadius: 6, overflow: 'auto', maxHeight: 200, whiteSpace: 'pre-wrap' }}>{generatedResult}</pre>}
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-secondary)', fontSize: 13 }}>Select a preset to configure</div>
          )}
        </div>

        <div style={{ borderLeft: '1px solid var(--border)', paddingLeft: 16, overflowY: 'auto', maxHeight: 600 }}>
          <h3 style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>Jobs</h3>
          {jobs.map(j => (
            <div key={j.id} style={{ padding: '8px 10px', borderRadius: 6, marginBottom: 6, border: '1px solid var(--border)', fontSize: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <span style={{ fontWeight: 500 }}>{j.preset || j.id}</span>
                <span style={{ padding: '2px 6px', borderRadius: 4, fontSize: 10, background: j.status === 'completed' ? 'rgba(13,176,72,0.1)' : j.status === 'failed' ? 'rgba(229,72,77,0.1)' : 'rgba(234,179,8,0.1)', color: j.status === 'completed' ? '#0DB048' : j.status === 'failed' ? '#E5484D' : '#E5A100' }}>{j.status}</span>
              </div>
              <div style={{ fontSize: 10, color: 'var(--text-secondary)' }}>{j.started_at}</div>
              {j.progress !== undefined && j.progress < 100 && j.status !== 'completed' && (
                <div style={{ height: 4, borderRadius: 2, background: 'var(--border)', overflow: 'hidden', marginTop: 4 }}>
                  <div style={{ height: '100%', width: `${j.progress}%`, background: 'var(--accent)', borderRadius: 2 }} />
                </div>
              )}
            </div>
          ))}
          {jobs.length === 0 && <div style={{ color: 'var(--text-secondary)', fontSize: 12, textAlign: 'center', padding: 16 }}>No jobs yet</div>}
        </div>
      </div>
    </div>
  );
}
