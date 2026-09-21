import { NextRequest, NextResponse } from 'next/server';
import { withLogging } from '@/lib/api-handler';
import { runSql } from '@/server/lib/sql';
import { requireOps } from '@/lib/ingress-identity';
import { SF_DATABASE } from '@/server/constants';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// PBF download mirrors (CORE.PBF_MIRRORS), the failover order used by
// PROVISION_REGION_WRAPPER when the primary origin is unreachable.
//
// Scope is deliberately narrow: this endpoint can ONLY toggle ENABLED. Hosts,
// path coverage and rewrites stay SQL-level operations, because they are
// code-owned (the install seed refreshes them) and because a mirror pointed at
// the wrong path is a defect rather than a preference. Keeping user input to a
// boolean and an integer also means no user-supplied text reaches SQL at all.

interface MirrorRow {
  PRIORITY: number;
  SOURCE_HOST: string;
  MIRROR_BASE: string;
  PATH_REGEX: string | null;
  ENABLED: boolean;
  NOTE: string | null;
}

// Best-effort freshness: does the mirror currently serve the SAME snapshot as
// the origin? A mirror lagging behind is not an error - the downloader's
// snapshot gate will simply refuse to adopt it for a resume - but it is the one
// fact that makes the toggle actionable, so surface it.
//
// Deliberately best-effort: a blocked egress rule, a slow mirror or a missing
// sidecar degrades to 'unknown' rather than failing the panel. Never let this
// determine whether the settings render.
//
// SSRF: the two hosts come from CORE.PBF_MIRRORS, which the install seed owns but
// which is a plain table any role with UPDATE on it can rewrite. That makes this
// a server-side fetch of a semi-trusted URL, so the probe target is validated
// rather than trusted: https only, default port only, no embedded credentials,
// and a public hostname (an IP literal or a loopback / link-local / RFC1918 /
// carrier-grade-NAT / .internal name is refused). An unusable row degrades to
// 'unknown', exactly like an unreachable one - the panel is unaffected either way.
const PRIVATE_HOST =
  /^(localhost|.*\.localhost|.*\.internal|.*\.local|metadata|metadata\..*)$/i;

// Validates an ALREADY-ABSOLUTE probe URL. Takes the finished URL rather than
// (base, path) so the identical checks apply to a redirect target, which is the
// hop that would otherwise bypass them.
function safeProbeUrl(candidate: string): string | null {
  let u: URL;
  try {
    u = new URL(candidate);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  if (u.port) return null;
  if (u.username || u.password) return null;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (PRIVATE_HOST.test(host)) return null;
  // Refuse IP literals outright: every legitimate mirror is a DNS name, and an
  // allowlist of "public" IP ranges is the wrong shape here (DNS rebinding aside,
  // there is no reason to reach a mirror by address).
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return null;
  if (host.includes(':')) return null; // IPv6 literal
  if (!host.includes('.')) return null; // bare hostname = not a public FQDN
  // The probe must stay on the sidecar it was built for. `new URL` already
  // resolves any `..` in the seeded base, so re-check the final path.
  if (!u.pathname.endsWith('.osm.pbf.md5')) return null;
  return u.toString();
}

async function checkFreshness(mirrorBase: string, sourceHost: string): Promise<string> {
  // Probe one file the mirror is known to carry. europe-latest is the largest
  // and the one whose outage motivated mirrors in the first place.
  const path = 'europe-latest.osm.pbf.md5';
  // Join, then validate. A trailing slash on the base is required or `new URL`
  // would drop the last path segment of a nested mirror base.
  const probeUrl = (base: string) => {
    const b = base.endsWith('/') ? base : `${base}/`;
    try {
      return safeProbeUrl(new URL(path, b).toString());
    } catch {
      return null;
    }
  };
  const fetchMd5 = async (rawUrl: string | null) => {
    if (!rawUrl) return null;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 6000);
    try {
      // Redirects are followed MANUALLY so every hop goes back through
      // safeProbeUrl. Blanket `redirect: 'error'` would be the simpler guard and
      // is wrong here: the primary origin answers this sidecar with a 302 (to a
      // mirror), so refusing redirects turns freshness permanently 'unknown' -
      // it removes the only actionable fact on the panel. Letting fetch follow
      // them silently is the actual SSRF hole, because a public host can redirect
      // into an internal address after validation has already passed.
      let url: string | null = rawUrl;
      for (let hop = 0; hop < 4; hop++) {
        if (!url) return null;
        const r: Response = await fetch(url, {
          signal: ctl.signal,
          cache: 'no-store',
          redirect: 'manual',
        });
        if (r.status >= 300 && r.status < 400) {
          const loc = r.headers.get('location');
          if (!loc) return null;
          // Resolve relative Location values against the hop we just made, then
          // re-validate: a redirect target is no more trusted than the seed was.
          url = safeProbeUrl(new URL(loc, url).toString());
          continue;
        }
        if (!r.ok) return null;
        const txt = (await r.text()).trim().split(/\s+/)[0];
        return txt && txt.length === 32 ? txt.toLowerCase() : null;
      }
      return null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
  const [origin, mirror] = await Promise.all([
    fetchMd5(probeUrl(`https://${sourceHost}`)),
    fetchMd5(probeUrl(mirrorBase)),
  ]);
  if (!origin || !mirror) return 'unknown';
  return origin === mirror ? 'in sync with origin' : 'BEHIND origin';
}

export const GET = withLogging(async (req: NextRequest) => {
  const gate = await requireOps(req);
  if (!gate.ok) return NextResponse.json({ error: gate.reason || 'Forbidden' }, { status: gate.status });
  try {
    const rows = (await runSql(
      `SELECT PRIORITY, SOURCE_HOST, MIRROR_BASE, PATH_REGEX, ENABLED, NOTE
       FROM ${SF_DATABASE}.CORE.PBF_MIRRORS
       ORDER BY PRIORITY`,
    )) as unknown as MirrorRow[];

    const mirrors = await Promise.all(
      (rows || []).map(async (r) => {
        let host = r.MIRROR_BASE;
        try {
          host = new URL(r.MIRROR_BASE).host;
        } catch {
          /* keep the raw value if it is not a parseable URL */
        }
        const isPrimary = Number(r.PRIORITY) === 1;
        return {
          priority: Number(r.PRIORITY),
          host,
          mirrorBase: r.MIRROR_BASE,
          sourceHost: r.SOURCE_HOST,
          enabled: r.ENABLED !== false,
          note: r.NOTE || '',
          isPrimary,
          // Human summary of PATH_REGEX. The regex itself is in the note/table
          // for anyone who needs it; the panel needs "what does this cover".
          covers: r.PATH_REGEX ? 'selected extracts only' : 'all paths',
          freshness: isPrimary ? '' : await checkFreshness(r.MIRROR_BASE, r.SOURCE_HOST),
        };
      }),
    );
    return NextResponse.json({ mirrors });
  } catch (err) {
    return NextResponse.json({ mirrors: [], error: (err as Error).message }, { status: 500 });
  }
});

export const POST = withLogging(async (req: NextRequest) => {
  const gate = await requireOps(req);
  if (!gate.ok) return NextResponse.json({ error: gate.reason || 'Forbidden' }, { status: gate.status });
  try {
    const body = await req.json().catch(() => ({}));
    const rawPriority = Number(body?.priority);
    if (!Number.isFinite(rawPriority)) {
      return NextResponse.json({ status: 'error', error: 'priority must be a number' }, { status: 400 });
    }
    const priority = Math.round(rawPriority);
    const enabled = body?.enabled === true;

    // Priority 1 is the primary origin. Disabling it would leave a region with
    // ZERO download candidates, so refuse here rather than only in the UI - the
    // guard has to hold for a direct API call too.
    if (priority === 1 && !enabled) {
      return NextResponse.json(
        { status: 'error', error: 'Cannot disable the primary origin: regions would have no download source.' },
        { status: 400 },
      );
    }

    await runSql(
      `UPDATE ${SF_DATABASE}.CORE.PBF_MIRRORS
       SET ENABLED = ${enabled ? 'TRUE' : 'FALSE'}, UPDATED_AT = SYSDATE()
       WHERE PRIORITY = ${priority}`,
    );
    return NextResponse.json({ status: 'ok', priority, enabled });
  } catch (err) {
    return NextResponse.json({ status: 'error', error: (err as Error).message }, { status: 500 });
  }
});
