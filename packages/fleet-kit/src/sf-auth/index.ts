// SPCS OAuth / local PAT dual-mode Snowflake REST auth resolver.
// Extracted to @fleet-kit/core (R1) from the consumer app's lib/sf-auth.ts so both
// the Analytics App and the modernized Routing admin console share one resolver.
//
// Resolves Snowflake REST auth for both runtimes:
//   - SPCS (deployed service): OAuth token injected at /snowflake/session/token,
//     ingress host in SNOWFLAKE_HOST. Token type = OAUTH.
//   - Local dev: SNOWFLAKE_ACCOUNT_URL + SNOWFLAKE_PAT. Token type = PAT.
// Called per-request so the SPCS token (which is refreshed on disk) is always current.

import { readFileSync, existsSync } from 'fs';

const SPCS_TOKEN_FILE = '/snowflake/session/token';

export interface SnowflakeAuth {
  baseUrl: string;
  token: string;
  tokenType: 'OAUTH' | 'PROGRAMMATIC_ACCESS_TOKEN';
}

export function getSnowflakeAuth(): SnowflakeAuth {
  const host = process.env.SNOWFLAKE_HOST;
  if (host && existsSync(SPCS_TOKEN_FILE)) {
    return {
      baseUrl: `https://${host}`.replace(/\/+$/, ''),
      token: readFileSync(SPCS_TOKEN_FILE, 'utf8').trim(),
      tokenType: 'OAUTH',
    };
  }
  return {
    baseUrl: (process.env.SNOWFLAKE_ACCOUNT_URL ?? '').replace(/\/+$/, ''),
    token: process.env.SNOWFLAKE_PAT ?? '',
    tokenType: 'PROGRAMMATIC_ACCESS_TOKEN',
  };
}
