// Common Zod primitives shared across endpoint schemas.

import { z } from 'zod';

// Region name accepted by the server (same charset as the SF identifier sanitizer).
// Empty string is allowed because the server treats it as "default region".
export const RegionName = z.string().regex(/^[A-Za-z0-9_]*$/);

// ORS profile string. Validated loosely — server accepts profiles dynamically
// per region (driving-car, driving-hgv, cycling-electric, etc.).
export const Profile = z.string().min(1);

// H3 resolution as used by matrix tables (5-9 typical).
export const H3Res = z.number().int().min(0).max(15);

// Generic OK / error envelope used by many POST endpoints.
export const OkEnvelope = z.object({
  ok: z.boolean(),
}).passthrough();

export const StatusOkEnvelope = z.object({
  status: z.union([z.literal('ok'), z.literal('error')]),
}).passthrough();
