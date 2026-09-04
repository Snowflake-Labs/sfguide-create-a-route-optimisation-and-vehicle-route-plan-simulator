/**
 * LOCAL PATCH - not present upstream. See ../VENDOR.md.
 *
 * AGENTS.md requires two tracking mechanisms on everything this repo creates:
 * a session `query_tag` on every SQL session, and a JSON `COMMENT` tracking tag
 * on every created object. Both feed attribution and the cleanup skill's
 * COMMENT-tag object discovery.
 *
 * The bundles' materialized `install.sql` is generated output and gitignored, so
 * the tags cannot be added to the file - they have to be emitted by the
 * generator. Centralizing the literals here keeps the three patched call sites
 * (`ddl.ts`, `build/ddl.ts`, `cli/materialize.ts`) consistent and makes the
 * deviation from upstream obvious to the next person re-vendoring.
 *
 * Known exception: `CREATE MCP SERVER` has no COMMENT clause, so MCP servers are
 * tracked via their JSON-tagged parent schema instead.
 */

/** COMMENT tracking tag for objects emitted by the synapse codegen. */
export const TRACKING_COMMENT =
  '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

/** Session query_tag set in the `install.sql` preamble. */
export const TRACKING_QUERY_TAG =
  '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","module":"synapse-bundle"}}';
