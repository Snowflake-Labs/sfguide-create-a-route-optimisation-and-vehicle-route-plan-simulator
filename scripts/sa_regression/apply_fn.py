import re, sys, snowflake.connector
src = open("/Users/obielov/Documents/GitHub/sfguide-create-a-route-optimisation-and-vehicle-route-plan-simulator/.cortex/skills/install-fleet-apps/scripts/analytic_layer_live_routing.sql").read()
name = sys.argv[1]
m = re.search(r"CREATE OR REPLACE FUNCTION " + re.escape(name) + r"\(.*?\n\$\$;", src, re.S)
c = snowflake.connector.connect(connection_name="TIB")
c.cursor().execute(m.group(0)[:-1])
print("applied", name)
