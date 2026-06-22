export interface SafeFetchResult<T = any> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
}

export async function safeFetchJson<T = any>(
  input: RequestInfo,
  init?: RequestInit
): Promise<SafeFetchResult<T>> {
  let resp: Response;
  try {
    resp = await fetch(input, init);
  } catch (e: any) {
    return { ok: false, status: 0, error: e.message || 'Network error' };
  }

  const ct = resp.headers.get('content-type') || '';

  if (!resp.ok) {
    if (ct.includes('application/json')) {
      try {
        const body = await resp.json();
        return { ok: false, status: resp.status, error: body?.error || JSON.stringify(body) };
      } catch {
        return { ok: false, status: resp.status, error: `HTTP ${resp.status}` };
      }
    }
    const text = await resp.text();
    if (resp.status === 504) {
      return { ok: false, status: 504, error: 'Server timed out (HTTP 504). The request took too long to complete.' };
    }
    return { ok: false, status: resp.status, error: text || `HTTP ${resp.status}` };
  }

  if (!ct.includes('application/json')) {
    const text = await resp.text();
    return { ok: false, status: resp.status, error: `Unexpected response type: ${ct || 'unknown'}. Body: ${text.slice(0, 200)}` };
  }

  try {
    const data = await resp.json();
    return { ok: true, status: resp.status, data };
  } catch (e: any) {
    return { ok: false, status: resp.status, error: `Failed to parse JSON: ${e.message}` };
  }
}
