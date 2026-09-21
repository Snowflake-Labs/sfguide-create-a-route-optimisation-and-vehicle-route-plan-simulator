// Regression test for routing-suspend.ts's ENGINE-STATE vs PAYLOAD-DEFECT split.
//
// Run with: npx tsx verify_routing_suspend.mts   (from fleet_tools/user)
//
// It lives here rather than under fleet_sa_app/ui for one practical reason: this
// package already carries tsx as a devDependency, while the SA app UI does not -
// running it there makes npx block on an interactive install prompt and then
// download tsx on every invocation. routing-suspend.ts is dependency-free pure
// TypeScript (no `@/` aliases, no runtime imports), so a relative import works.
//
// What it protects. The detector decides whether an unusable routing call is an
// ENGINE STATE the app can fix by resuming, or a PAYLOAD the app must correct.
// Getting that backwards produced a user-visible dead end: a Europe solve
// carrying 29 San Francisco coordinates was refused by the Europe road graph in
// 5 ms (ORS 6010, "out of bounds"), the detector called it a suspended engine,
// the resume path found the service RUNNING and downgraded it to `not_ready`,
// and the page advertised a 2-to-5-minute wait for an engine that was already
// up. Retry could never clear it. The two directions both matter, which is why
// the suspended cases are asserted here too: over-broadening the off-graph
// patterns would silently disable auto-resume.
import {
  detectOrsSuspended,
  detectSuspendedInResult,
  isOutOfGraph,
  parseOutOfGraphPoints,
  outOfGraphMessage,
} from '../../fleet_sa_app/ui/src/lib/routing-suspend';

// The EXACT body the live v1.1.14 gateway returned for a Europe solve carrying a
// San Francisco coordinate. Captured from the account, not hand-written.
const live = {
  code: 99,
  error: 'matrix_precompute_failed',
  hint: "One or more locations are outside this region's road graph. Check that the selected region matches the data being solved; waiting or retrying will not help.",
  message:
    'matrix pre-compute rejected by ors-service-europe: ORS code 6010: Source point(s) [1] out of bounds: 37.5789081,-122.3460332. Destination point(s) [1] out of bounds: 37.5789081,-122.3460332',
  ors_code: 6010,
  ors_message: 'Source point(s) [1] out of bounds: 37.5789081,-122.3460332',
};

// The pre-v1.1.14 body, which flattened the ORS error into a nested dict. Kept
// because the fix must NOT depend on the gateway roll landing first - a client
// deployed ahead of the gateway has to classify this correctly too.
const legacy = {
  code: 99,
  error: 'matrix_precompute_failed',
  hint: 'Try again after the ORS graph is fully loaded',
  message: { code: 6010, message: 'Source point(s) [1] out of bounds: 37.5789081,-122.3460332' },
};

let fails = 0;
const chk = (name: string, cond: boolean) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) fails++;
};

// --- off-graph payloads must NOT be reported as an engine state ---------------
const d1 = detectOrsSuspended(live.message);
chk('live message -> not suspended', d1.suspended === false);
chk('live message -> outOfGraph', d1.outOfGraph === true);
const d2 = detectSuspendedInResult(live);
chk('live result object -> not suspended', d2.suspended === false);
chk('live result object -> outOfGraph', d2.outOfGraph === true);
const d3 = detectSuspendedInResult(legacy);
chk('legacy gateway payload -> not suspended', d3.suspended === false);
chk('legacy gateway payload -> outOfGraph', d3.outOfGraph === true);

// --- a genuinely unavailable engine must STILL be detected -------------------
chk('service_unreachable -> suspended',
  detectOrsSuspended('ORS service_unreachable host=ors-service-europe').suspended === true);
chk('DNS failure -> suspended, not outOfGraph',
  detectOrsSuspended("Failed to resolve 'ors-service-europe'").suspended === true
  && !detectOrsSuspended("Failed to resolve 'ors-service-europe'").outOfGraph);
chk('service_warming_up -> not_ready',
  detectOrsSuspended('ORS service_warming_up host=ors-service-europe').state === 'not_ready');
// A matrix pre-compute failure with no off-graph cause is a real outage: the
// off-graph precedence must not swallow the whole code.
chk('matrix_precompute_failed with no off-graph cause -> suspended',
  detectOrsSuspended('{"error":"matrix_precompute_failed","message":"matrix pre-compute timed out after 45s on ors-service-europe"}').suspended === true);

// --- coordinate parsing must SWAP ORS's lat,lon into lon,lat ----------------
// ORS REPORTS lat first while ACCEPTING lon first. Passing it through unswapped
// would place a San Francisco stop at 37.57E 122.34S, in the Southern Ocean.
const pts = parseOutOfGraphPoints(live.message);
chk('parses both reported points', pts.length === 2);
chk('lon is negative (San Francisco)', pts[0].lon < -122 && pts[0].lon > -123);
chk('lat is ~37.5789', Math.abs(pts[0].lat - 37.5789081) < 1e-6);

// --- the copy must not promise a wait ---------------------------------------
const msg = outOfGraphMessage('Europe', 29, pts);
chk('message names the region', msg.includes('Europe'));
chk('message names the count', msg.includes('29 locations'));
chk('message promises NO wait', !/minute/i.test(msg));
chk('message says the engine is healthy', /healthy/.test(msg));

// --- unrelated failures must not be misread as off-graph --------------------
chk('view column-count error -> nothing',
  !isOutOfGraph('Snowflake API 422: view produces 22 columns'));
chk('Snowflake statement timeout -> nothing',
  !isOutOfGraph('Statement reached its statement or warehouse timeout'));

console.log(fails ? `\n${fails} FAILURE(S)` : `\nall ${19} assertions passed`);
process.exit(fails ? 1 : 0);
