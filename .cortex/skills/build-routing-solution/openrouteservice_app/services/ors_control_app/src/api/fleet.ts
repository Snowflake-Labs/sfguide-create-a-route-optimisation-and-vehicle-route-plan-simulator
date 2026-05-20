// Typed wrappers for /api/backload/* and (TBD) /api/agent/* endpoints.

import { apiPost } from './client';
import { BackloadSeedRequest, BackloadSeedResponse } from './schemas/fleet';

export async function seedBackload(req: BackloadSeedRequest) {
  return apiPost('/api/backload/seed', req, BackloadSeedResponse);
}
