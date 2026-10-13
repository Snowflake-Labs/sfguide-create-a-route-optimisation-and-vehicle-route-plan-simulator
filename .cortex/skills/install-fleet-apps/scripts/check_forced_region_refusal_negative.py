#!/usr/bin/env python3
"""Negative tests for check_forced_region_refusal.py - each case re-creates one
shape of the forced-region dead end (an active-region default, a JSON-null-blind
off-graph test, a mis-ordered refusal, a refusal with no recovery flag, or a
blanket no-retry ban) and the gate must convict it with that rule's message.

Ported from mutate_forced_region_refusal.py, which mutates the checkout in
place, and extended so every half of every rule is exercised."""
import json
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from negtest import Harness  # noqa: E402

SKILL = ".cortex/skills/install-fleet-apps"
TOOLS = ".cortex/skills/routing-agent/references/deploy-agent.sql"
CHAT = f"{SKILL}/fleet_sa_app/ui/src/app/api/chat/route.ts"
VERB = f"{SKILL}/fleet_tools/user/src/procs/get_directions.ts"
SPEC = f"{SKILL}/fleet_sa_app/app/agent-spec.json"
SUPER = f"{SKILL}/fleet_sa_app/app/super-agent-spec.json"

h = Harness("check_forced_region_refusal.py")


def edit(name: str, rel: str, fn, expect: str) -> None:
    """A case whose mutation is a function of the file text."""
    p = h.path(rel)
    original = p.read_text()

    def apply():
        changed = fn(original)
        assert changed != original, f"mutation leaves {rel} unchanged"
        p.write_text(changed)

    h.custom(name, apply, lambda: p.write_text(original), expect)


def if_block(src: str, head: str) -> tuple[int, int]:
    """(start, end) of the IF ... END IF; block opened by `head`."""
    start = src.index(head)
    return start, src.index("END IF;", start) + len("END IF;")


UNSNAPPED_IF = "        IF (v_unsnapped_count IS NOT NULL AND v_unsnapped_count > 0) THEN"
LEG_IF = "        IF (v_unroutable_legs IS NOT NULL AND v_unroutable_legs > 0) THEN"

# ---- RULE A: the active-context prefix --------------------------------------
h.replace(CHAT,
          "`The region above scopes fleet DATA, not routing: routing verbs resolve their own region from "
          "the places named, so pass region = null to them and never force this one. ` +\n"
          "      `Pass the routing profile shown above when the user does not name a travel type. ` +",
          "`When a routing tool needs a region or profile and the user did not name one, default to this "
          "region and pass the routing profile shown above (or null to use the active vehicle). ` +",
          expect="tells the agent to 'default to this region'", name="A: prefix defaults a routing region (shipped)")
h.replace(CHAT, "so pass region = null to them and never force this one", "so never force this one",
          expect="never tells the agent to pass region = null", name="A: prefix loses the region = null instruction")
h.replace(CHAT, "The region above scopes fleet DATA, not routing: routing verbs",
          "Routing verbs", expect="does not say the active region scopes DATA",
          name="A: prefix loses the DATA-not-routing distinction")
h.replace(CHAT, "activeContextPrefix", "ctxHiddenTurnPrefix", count=-1,
          expect="no activeContextPrefix assignment found", name="A: prefix renamed away (vacuity)")

# ---- RULE B: JSON-null-blind destination test ---------------------------------
h.replace(TOOLS, "IS_NULL_VALUE(m.R:destinations[s.INDEX]) AS UNSNAPPED",
          "m.R:destinations[s.INDEX] IS NULL AS UNSNAPPED",
          expect="tests a destination entry with a bare `IS NULL`", name="B: destination entry tested with bare IS NULL")


# ---- RULE C: unsnapped refusal ordering -------------------------------------
def unsnapped_after_leg(src: str) -> str:
    u0, u1 = if_block(src, UNSNAPPED_IF)
    block, rest = src[u0:u1], src[:u0] + src[u1:]
    _, l1 = if_block(rest, LEG_IF)
    return rest[:l1] + "\n\n" + block + rest[l1:]


def drop_unsnapped(src: str) -> str:
    u0, u1 = if_block(src, UNSNAPPED_IF)
    return src[:u0] + src[u1:]


edit("C: unsnapped branch moved after the leg branch", TOOLS, unsnapped_after_leg,
     expect="the unsnappable-coordinate branch sits AFTER the unroutable-leg")
edit("C: unsnapped refusal branch removed", TOOLS, drop_unsnapped,
     expect="has no unsnappable-coordinate refusal branch")


# ---- RULE D: recovery flags on every region-naming refusal -------------------
def drop_key_in_branch(error_code: str, line: str):
    def fn(src: str) -> str:
        i = src.index(f"'error_code', '{error_code}'")
        assert line in src[i:i + 800], f"{line.strip()} not in the {error_code} branch"
        return src[:i] + src[i:].replace(line, "", 1)
    return fn


edit("D: UNROUTABLE_LEG refusal loses suggested_region", TOOLS,
     drop_key_in_branch("UNROUTABLE_LEG", "                'suggested_region', v_suggested_region,\n"),
     expect="omits 'suggested_region'")
edit("D: OFF_GRAPH_PLACE refusal loses retry_without_region", TOOLS,
     drop_key_in_branch("OFF_GRAPH_PLACE",
                        "                'retry_without_region', IFF(v_forced_region_hint IS NOT NULL, TRUE, FALSE),\n"),
     expect="omits 'retry_without_region'")
h.replace(TOOLS,
          "            SELECT OPENROUTESERVICE_APP.CORE.COVERING_REGION_FOR_POINTS(:v_coords):lookup_name::STRING\n"
          "              INTO :v_suggested_region;",
          "            v_suggested_region := NULL;",
          expect="the caller-region branch does not call COVERING_REGION_FOR_POINTS",
          name="D: forced path never consults the covering region")
h.replace(TOOLS, "    IF (v_region_source = 'caller') THEN", "    IF (FALSE) THEN",
          expect="never branches on v_region_source = 'caller'", name="D: caller-region branch removed")


# ---- RULE E: the retry exception, in the SHIPPED strings ----------------------
EXCEPTION = re.compile(r" - the ONE exception is a result carrying retry_without_region.*?never treat"
                       r" that case as final\.", re.S)


def spec_edit(fn):
    def apply(src: str) -> str:
        d = json.loads(src)
        d["instructions"]["orchestration"] = fn(d["instructions"]["orchestration"])
        return json.dumps(d, indent=2, ensure_ascii=False) + "\n"
    return apply


edit("E: consumer spec keeps the blanket no-retry ban", SPEC,
     spec_edit(lambda o: EXCEPTION.sub(".", o, 1)),
     expect="agent-spec.json orchestration still bans re-issuing")
edit("E: super spec keeps the blanket no-retry ban", SUPER,
     spec_edit(lambda o: EXCEPTION.sub(".", o, 1)),
     expect="super-agent-spec.json orchestration still bans re-issuing")
edit("E: spec names the flag but not the action", SPEC,
     spec_edit(lambda o: o.replace("retry exactly once with region null", "that case is recoverable", 1)),
     expect="agent-spec.json mentions retry_without_region without telling")


def comment_only(src: str) -> str:
    src = src.replace(" - unless the result ' +\n    'carries retry_without_region, which means the region was "
                      "forced and ' +\n    'suggested_region covers every place: then retry exactly once with "
                      "region null.',", ".',")
    return src.replace("export const get_directions = defineProc({",
                       "// retry_without_region means the region was forced: retry exactly once with\n"
                       "// region null when suggested_region covers every place.\n"
                       "export const get_directions = defineProc({")


edit("E: retry rule demoted to a comment in the verb", VERB, comment_only,
     expect="the get_directions description never names retry_without_region")
h.replace(VERB, "then retry exactly once with region null.", "then the refusal is recoverable.",
          expect="description names retry_without_region but never states the action",
          name="E: verb names the flag but not the action")

sys.exit(h.finish())
