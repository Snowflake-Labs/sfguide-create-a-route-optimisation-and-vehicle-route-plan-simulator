// Regression test for lib/missing-dependency.ts: a "does not exist" query error
// over a layer the installer skipped must name the builder that creates it.
//
// Run with (from fleet_sa_app/ui):
//   npx tsx scripts/verify-missing-dependency.mts
//
// Why it exists: a customer whose Location layer was never built was told to
// run a "Location dataset generator in the Admin app", which does not exist.
// The error strings below are verbatim from Snowflake (measured on wgb26798).

import { missingDependencyMessage, missingObjectName } from '../src/lib/missing-dependency';

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`);
  if (!ok) failed++;
}

const OBJECT_ERR =
  "SQL compilation error:\nObject 'FLEET_APP.LOCATION.VW_STORE_FACTS' does not exist or not authorized. " +
  'Your primary role ACCOUNTADMIN or one of your secondary roles must have at least one privilege granted on TABLE FLEET_APP.LOCATION.VW_STORE_FACTS.';
const UDTF_ERR = 'SQL compilation error:\nUnknown user-defined table function FLEET_APP.LOCATION.LIVE_CANNIBALISATION';

check('object error parses its name', missingObjectName(OBJECT_ERR) === 'FLEET_APP.LOCATION.VW_STORE_FACTS', String(missingObjectName(OBJECT_ERR)));
check('UDTF error parses its name', missingObjectName(UDTF_ERR) === 'FLEET_APP.LOCATION.LIVE_CANNIBALISATION', String(missingObjectName(UDTF_ERR)));
check('quoted identifiers are unquoted', missingObjectName(`Object '"FLEET_APP"."LOCATION"."VW_X"' does not exist or not authorized.`) === 'FLEET_APP.LOCATION.VW_X');

for (const [label, err] of [['object', OBJECT_ERR], ['udtf', UDTF_ERR]] as const) {
  const msg = missingDependencyMessage(err, 'London') ?? '';
  check(`${label}: names BUILD_LOCATION_DIAGNOSTICS`, msg.includes('CALL FLEET_INTELLIGENCE.LOCATION.BUILD_LOCATION_DIAGNOSTICS()'), msg);
  check(`${label}: names BUILD_CATCHMENT with the region`, msg.includes("BUILD_CATCHMENT('London', TRUE)"), msg);
  check(`${label}: says there is no generator`, /no Location dataset generator/.test(msg), msg);
  check(`${label}: does not send the user to generate a dataset`, !/generate (a|the) (location )?dataset/i.test(msg), msg);
}

check('no region -> placeholder, not "undefined"', (missingDependencyMessage(OBJECT_ERR, null) ?? '').includes("'<region>'"));
check('pack layer derives a setup.sql step',
  (missingDependencyMessage("Object 'FLEET_APP.DWELL.VW_X' does not exist or not authorized.", null) ?? '').includes('packs/fleet/dwell/setup.sql'));
check('unowned object is left alone', missingDependencyMessage("Object 'OTHER_DB.S.T' does not exist or not authorized.", null) === null);
check('unrelated error is left alone', missingDependencyMessage('Numeric value abc is not recognized', null) === null);

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nall missing-dependency checks passed');
