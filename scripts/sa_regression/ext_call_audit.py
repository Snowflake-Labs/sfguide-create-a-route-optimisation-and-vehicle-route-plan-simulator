"""Audit repeated ORS engine calls per statement.

For every distinct LIVE_* statement in recent query history, read its operator
stats and report ExternalFunction input rows. A statement that should make ONE
engine call but shows N > 1 has the per-row re-evaluation defect.
"""
import re, sys, snowflake.connector as s

c = s.connect(connection_name=sys.argv[1] if len(sys.argv) > 1 else "TIB").cursor()
c.execute("""
SELECT query_id, query_text, total_elapsed_time/1000
FROM TABLE(FLEET_INTELLIGENCE.INFORMATION_SCHEMA.QUERY_HISTORY(
       END_TIME_RANGE_START => DATEADD('hour', -12, CURRENT_TIMESTAMP()), RESULT_LIMIT => 10000))
WHERE execution_status = 'SUCCESS' AND query_text ILIKE '%TABLE(FLEET_%LIVE_%'
  AND query_text NOT ILIKE '%QUERY_HISTORY%'
QUALIFY ROW_NUMBER() OVER (PARTITION BY REGEXP_SUBSTR(query_text, 'LIVE_[A-Z_]+') ORDER BY total_elapsed_time DESC) = 1
""")
rows = c.fetchall()
for qid, q, secs in rows:
    fn = re.search(r"LIVE_[A-Z_]+", q).group(0)
    c.execute(f"SELECT operator_statistics:input_rows::INT FROM TABLE(GET_QUERY_OPERATOR_STATS('{qid}')) WHERE operator_type = 'ExternalFunction'")
    calls = [r[0] for r in c.fetchall()]
    flag = "REPEAT" if any((n or 0) > 1 for n in calls) else "ok"
    print(f"{flag:6} {fn:28} {secs:6.1f}s ext_rows={calls}")
