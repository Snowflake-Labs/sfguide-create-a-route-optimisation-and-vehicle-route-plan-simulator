// Region-aware Zod-validated client for the ors_control_app server. Wraps
// utils/safeFetch with typed apiGet / apiPost / apiSse helpers that validate
// every response payload against a schema before resolving.
//
// Conventions:
// - Every region-scoped function accepts `region: string | null`. Pass null
//   to opt into the gateway's DEFAULT_REGION_NAME fallback (matches the
//   server-side normalizeRegion helper introduced in Phase 0).
// - Validation errors are surfaced as ApiError so callers can distinguish
//   network failures from schema mismatches.

import { z } from 'zod';
import { safeFetchJson } from '../utils/safeFetch';

export class ApiError extends Error {
  constructor(public status: number, message: string, public detail?: unknown) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function apiGet<T extends z.ZodTypeAny>(
  path: string,
  schema: T,
  init?: RequestInit,
): Promise<z.infer<T>> {
  const result = await safeFetchJson(path, { method: 'GET', ...init });
  if (!result.ok) throw new ApiError(result.status, result.error || 'GET failed');
  const parsed = schema.safeParse(result.data);
  if (!parsed.success) {
    throw new ApiError(result.status, `Schema mismatch on GET ${path}`, parsed.error);
  }
  return parsed.data;
}

export async function apiPost<TBody, TOut extends z.ZodTypeAny>(
  path: string,
  body: TBody,
  outSchema: TOut,
  init?: RequestInit,
): Promise<z.infer<TOut>> {
  const result = await safeFetchJson(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    ...init,
  });
  if (!result.ok) throw new ApiError(result.status, result.error || 'POST failed');
  const parsed = outSchema.safeParse(result.data);
  if (!parsed.success) {
    throw new ApiError(result.status, `Schema mismatch on POST ${path}`, parsed.error);
  }
  return parsed.data;
}

export async function apiDelete<TOut extends z.ZodTypeAny>(
  path: string,
  outSchema: TOut,
  init?: RequestInit,
): Promise<z.infer<TOut>> {
  const result = await safeFetchJson(path, { method: 'DELETE', ...init });
  if (!result.ok) throw new ApiError(result.status, result.error || 'DELETE failed');
  const parsed = outSchema.safeParse(result.data);
  if (!parsed.success) {
    throw new ApiError(result.status, `Schema mismatch on DELETE ${path}`, parsed.error);
  }
  return parsed.data;
}

// Region URL helper. Empty / null region resolves to the gateway's
// DEFAULT_REGION_NAME (server-side mirror of routing_service.py's
// _normalize_region). Use this when building URLs for region-scoped
// endpoints so callers don't need their own fallback branches.
export function regionParam(region: string | null | undefined): string {
  return region ? encodeURIComponent(region) : '';
}
