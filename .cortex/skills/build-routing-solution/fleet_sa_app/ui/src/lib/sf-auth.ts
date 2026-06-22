// Re-export shim (R1): the implementation now lives in the shared UI kit so both
// the Analytics App and the modernized Routing admin console share one auth
// resolver. Importers across the app (agent-config, snowflake, api/query) keep
// importing from '@/lib/sf-auth' unchanged.
export * from '@fleet-kit/core/sf-auth';
