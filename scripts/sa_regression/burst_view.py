import json, re, sys, time, concurrent.futures as cf
import snowflake.connector
VIEW, REGION, CAND = sys.argv[1], sys.argv[2], sys.argv[3]
KEY = "selected_candidate"
vals = {"region": REGION, KEY: CAND}
for kv in sys.argv[4:]:
    k, _, x = kv.partition("=")
    vals[k] = x
d = json.load(open("/Users/obielov/Documents/GitHub/sfguide-create-a-route-optimisation-and-vehicle-route-plan-simulator/.cortex/skills/install-fleet-apps/fleet_sa_app/app/app-views.json"))
views = d.get("views", d)
v = views[VIEW] if isinstance(views, dict) else [x for x in views if x.get("id") == VIEW][0]
qs = []
def walk(o, path):
    if isinstance(o, dict):
        if isinstance(o.get("query"), str) and "LIVE_" in o["query"]:
            qs.append((path, o["query"]))
        for k, x in o.items():
            walk(x, path + "/" + k)
    elif isinstance(o, list):
        for i, x in enumerate(o):
            walk(x, path + f"[{i}]")
walk(v.get("areas", {}), VIEW)
def bind(q):
    return re.sub(r":([a-z_]+)", lambda m: ("'" + vals[m.group(1)] + "'") if m.group(1) in vals else "NULL", q)
def run(pq):
    path, q = pq
    c = snowflake.connector.connect(connection_name="TIB")
    t = time.time()
    try:
        cur = c.cursor()
        cur.execute("ALTER SESSION SET STATEMENT_TIMEOUT_IN_SECONDS=80")
        cur.execute(bind(q))
        n = len(cur.fetchall())
        return f"OK   {time.time()-t:6.1f}s rows={n} {path}"
    except Exception as e:
        return f"FAIL {time.time()-t:6.1f}s {path} {str(e)[:160]}"
    finally:
        c.close()
print(len(qs), "live queries")
with cf.ThreadPoolExecutor(len(qs)) as ex:
    for r in ex.map(run, qs):
        print(r, flush=True)
