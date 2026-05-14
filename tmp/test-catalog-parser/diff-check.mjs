import fs from 'fs';
const ts = fs.readFileSync('.cortex/skills/build-routing-solution/openrouteservice_app/services/ors_control_app/server/index.ts','utf8');
const m = ts.match(/function parseGeofabrikIndex[\s\S]*?\n  \}\n/);
if (!m) { console.log('not found'); process.exit(1); }
const tsBody = m[0];
const harness = fs.readFileSync('tmp/test-catalog-parser/run.mjs','utf8');
const m2 = harness.match(/function parseGeofabrikIndex_NEW[\s\S]*?\n\}\n/);
const harnessBody = m2 ? m2[0] : 'not found';
console.log('--- TS function length:', tsBody.length, 'Harness length:', harnessBody.length);
console.log('TS has bpLast:', /bpLast/.test(tsBody));
console.log('TS has bpParent:', /bpParent/.test(tsBody));
console.log('TS has cleanHref.startsWith(bp + ):', /cleanHref\.startsWith\(bp \+ /.test(tsBody));
console.log('TS has bpLast && cleanHref.startsWith:', /bpLast && cleanHref\.startsWith/.test(tsBody));
console.log('Harness has bpLast:', /bpLast/.test(harnessBody));
console.log('Harness has bpParent:', /bpParent/.test(harnessBody));

// Also extract the recursion bbox lookup lines
const recM = ts.match(/for \(const subReg of subRegions\)[\s\S]*?\n        \}/);
if (recM) {
  console.log('\nRecursion bbox lookup:');
  console.log('Has gfBbox.get(srKey):', /gfBbox\.get\(srKey\)/.test(recM[0]));
  console.log('Has split.slice(1).join:', /split\('\/'\)\.slice\(1\)\.join/.test(recM[0]));
}
