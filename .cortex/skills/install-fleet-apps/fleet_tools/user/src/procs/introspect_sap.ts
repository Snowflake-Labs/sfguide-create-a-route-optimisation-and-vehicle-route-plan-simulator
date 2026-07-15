import { defineProc, t } from '@snowflake/synapse';
import { Procs } from '../catalog.js';
import { callTool } from '../helpers.js';

export const introspect_sap = defineProc({
  name: 'introspect_sap',
  description:
    'Identify which SAP fleet tables and telematics columns are present in a landed ' +
    'database, so the user can see what can be bound into the fleet contract. Scans ' +
    'the given SAP database (and optional telematics database) INFORMATION_SCHEMA ' +
    'read-only and returns the SAP fleet objects (EQUI/IFLOT/LIKP/LIPS/...), the CDC ' +
    'metadata-column fingerprint (qlik/odp/fivetran/slt), the candidate telematics ' +
    'device/serial/ts/lat/lon columns, and suggested cdc_tool + join strategy. Use ' +
    'for "which SAP tables can I bind/connect", "what SAP data do I have in <db>", ' +
    '"scan <db> for bindable tables". NOT for analytics over fleet data (use the ' +
    'query_* tools) and NOT for conceptual how-to questions (use the SAP binding ' +
    'knowledge). Provide a database name; for a demo use MOCK_SAP and MOCK_TELEMATICS.',
  roles: ['user'],
  args: {
    sap_db: t
      .string({ min: 1, max: 255 })
      .describe('Name of the landed SAP database to scan (e.g. MOCK_SAP or the co-located SAP inbound DB).'),
    telematics_db: t
      .string({ max: 255 })
      .nullable()
      .describe('Optional telematics database to scan for the GPS fact shape (e.g. MOCK_TELEMATICS). Null to scan SAP only.'),
  },
  returns: {
    result: t
      .object({})
      .describe('Discovery result: sap_objects, cdc_fingerprint, telematics_columns, and suggested cdc_tool / join strategy.'),
  },
  execute: async (args, ctx) => {
    const result = await callTool(ctx.conn, Procs.introspectSap, [
      args.sap_db,
      args.telematics_db,
    ]);
    return { result };
  },
});
