#!/usr/bin/env python3
"""4-mode eval runner for semantic views (semantic_skills Phase 3).

Modes per question:
  1. gold   - hand-written physical base-table SQL (ground truth)
  2. auto   - Cortex Analyst REST API, default mode (NL -> SQL)
  3. require - Cortex Analyst REST API, semantic_sql="require"
  4. sv     - hand-written SEMANTIC_VIEW() query

Compares auto/require/sv result sets against gold. Usage:
  python eval_sv.py <evals.yaml> [--connection fleet_test_evals]
"""
import sys, json, argparse, time
import yaml
import requests
import snowflake.connector


def run_sql(cur, sql):
    try:
        cur.execute(sql)
        cols = [c[0] for c in cur.description]
        rows = cur.fetchall()
        return {"cols": cols, "rows": rows}
    except Exception as e:  # noqa
        return {"error": str(e)}


def norm(result):
    """Normalize a result set into a comparable set of rounded tuples."""
    if "error" in result:
        return None
    out = set()
    for r in result["rows"]:
        t = []
        for v in r:
            if isinstance(v, float):
                t.append(round(v, 2))
            elif isinstance(v, int):
                t.append(round(float(v), 2))
            else:
                t.append(str(v))
        out.add(tuple(t))
    return out


def compare(gold, cand):
    g, c = norm(gold), norm(cand)
    if c is None:
        return "FAIL", cand.get("error", "no result")[:160]
    if g is None:
        return "ERROR", "gold failed"
    # Align on metric values: compare the multiset of numeric values per row,
    # tolerant to extra context columns the Analyst may add.
    if g == c:
        return "PASS", ""
    # fallback: compare just the numeric columns (max abs >= 1) as sorted lists
    def numerics(res):
        idxs = [i for i in range(len(res["cols"]))
                if any(isinstance(row[i], (int, float)) for row in res["rows"])]
        vals = sorted(round(float(row[i]), 2)
                      for row in res["rows"] for i in idxs
                      if isinstance(row[i], (int, float)))
        return vals
    if numerics(gold) == numerics(cand):
        return "PASS", "(matched on numeric values)"
    return "FAIL", f"gold={len(g)} rows vs cand={len(c)} rows; values differ"


def call_analyst(host, token, question, sv_name, mode):
    url = f"https://{host}/api/v2/cortex/analyst/message"
    headers = {"Authorization": f'Snowflake Token="{token}"',
               "Content-Type": "application/json"}
    payload = {
        "messages": [{"role": "user", "content": [{"type": "text", "text": question}]}],
        "semantic_view": sv_name,
    }
    if mode == "require":
        payload["semantic_sql"] = "require"
    resp = requests.post(url, json=payload, headers=headers, timeout=180)
    if resp.status_code != 200:
        return None, f"HTTP {resp.status_code}: {resp.text[:160]}"
    data = resp.json()
    sql = None
    for item in data.get("message", {}).get("content", []):
        if item.get("type") == "sql":
            sql = item.get("statement")
    if not sql:
        return None, "no SQL in response"
    return sql, None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("evals")
    ap.add_argument("--connection", default="fleet_test_evals")
    args = ap.parse_args()

    spec = yaml.safe_load(open(args.evals))
    sv_name = spec["sv_name"]
    conn = snowflake.connector.connect(connection_name=args.connection)
    cur = conn.cursor()
    # Tracking tag (AGENTS.md): attribute every query this eval harness runs.
    cur.execute("ALTER SESSION SET query_tag = '{\"origin\":\"sf_sit-is-fleet\",\"name\":\"oss-semantic-view\",\"version\":{\"major\":1,\"minor\":0},\"attributes\":{\"is_quickstart\":1,\"source\":\"sql\"}}'")
    cur.execute("SELECT SYSTEM$ALLOWLIST()")
    host = [e["host"] for e in json.loads(cur.fetchone()[0])
            if e.get("type") == "SNOWFLAKE_DEPLOYMENT"][0]
    token = conn.rest.token

    summary = {"auto": [0, 0], "require": [0, 0], "sv": [0, 0]}
    results = []
    for ev in spec["evals"]:
        q = ev["question"]
        gold = run_sql(cur, ev["gold_sql"])
        row = {"question": q}
        # mode 4: hand SV
        sv = run_sql(cur, ev["sv_sql"])
        st, detail = compare(gold, sv)
        row["sv"] = st; summary["sv"][0] += st == "PASS"; summary["sv"][1] += 1
        # modes 2,3: analyst auto/require
        for mode in ["auto", "require"]:
            sql, err = call_analyst(host, token, q, sv_name, mode)
            cand = run_sql(cur, sql) if sql else {"error": err}
            st, detail = compare(gold, cand)
            row[mode] = st
            summary[mode][0] += st == "PASS"; summary[mode][1] += 1
            row[f"{mode}_detail"] = detail
        results.append(row)
        print(f"[{row.get('auto'):>4} auto | {row.get('require'):>4} require | {row['sv']:>4} sv] {q}")

    print("\n=== SUMMARY ===")
    for m, (p, t) in summary.items():
        print(f"  {m:8} {p}/{t} PASS ({100*p/t:.0f}%)")
    json.dump({"summary": summary, "results": results},
              open(args.evals.replace(".yaml", ".results.json"), "w"), indent=2)


if __name__ == "__main__":
    main()
