#!/usr/bin/env python3
"""Negative tests for check_cowork_surfaces.py - every CoWork surface fails
SILENTLY when mis-wired, so each case breaks one surface the way it actually
broke (or plausibly would) and the gate must name the rule and the object."""
import json
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from negtest import Harness  # noqa: E402

SKILL = ".cortex/skills/install-fleet-apps"
APP = f"{SKILL}/fleet_sa_app/app"
VQR = f"{SKILL}/scripts/verified_queries.py"
SVS = f"{APP}/semantic_views.sql"
SKILLS = f"{APP}/cowork_skills"
SKILL_MD = f"{SKILLS}/asset_velocity/SKILL.md"
OPEN, CLOSE = "<chart_customization>", "</chart_customization>"
HEADER = "CHART CUSTOMIZATION (how a chart should look):\n"

h = Harness("check_cowork_surfaces.py")


def spec_case(name: str, spec: str, fn, expect: str) -> None:
    p = h.path(f"{APP}/{spec}")
    original = p.read_text()

    def apply():
        d = json.loads(original)
        fn(d)
        changed = json.dumps(d, indent=2, ensure_ascii=False) + "\n"
        assert changed != original, f"mutation leaves {spec} unchanged"
        p.write_text(changed)

    h.custom(name, apply, lambda: p.write_text(original), expect)


def orch(fn):
    def apply(d):
        d["instructions"]["orchestration"] = fn(d["instructions"]["orchestration"])
    return apply


def text_case(name: str, rel: str, fn, expect: str) -> None:
    p = h.path(rel)
    original = p.read_text()

    def apply():
        changed = fn(original)
        assert changed != original, f"mutation leaves {rel} unchanged"
        p.write_text(changed)

    h.custom(name, apply, lambda: p.write_text(original), expect)


def block_of(o: str) -> str:
    return o[o.index(OPEN):o.index(CLOSE) + len(CLOSE)]


def must(o: str, old: str, new: str) -> str:
    assert old in o, f"anchor not found: {old[:60]!r}"
    return o.replace(old, new, 1)


# ---- RULE A: sandbox tool + its resource entry -------------------------------
spec_case("A: ops agent loses the code_execution tool", "ops-agent-spec.json",
          lambda d: d.__setitem__("tools", [t for t in d["tools"]
                                            if t["tool_spec"]["name"] != "code_execution"]),
          expect="RULE A ops-agent-spec.json: no code_execution tool")
spec_case("A: tool declared without its tool_resources entry", "admin-agent-spec.json",
          lambda d: d["tool_resources"].pop("code_execution"),
          expect="RULE A admin-agent-spec.json: code_execution has no tool_resources entry")
spec_case("A: permission_policy left to the default", "super-agent-spec.json",
          lambda d: d["tool_resources"]["code_execution"].pop("permission_policy"),
          expect="RULE A super-agent-spec.json: code_execution has no permission_policy.type")

# ---- RULE B: chart_customization block ---------------------------------------
spec_case("B: chart block removed", "admin-agent-spec.json",
          orch(lambda o: o.replace(block_of(o), "", 1)),
          expect="RULE B admin-agent-spec.json: no <chart_customization> block")
spec_case("B: chart block duplicated", "ops-agent-spec.json",
          orch(lambda o: o + "\n" + block_of(o)),
          expect="RULE B ops-agent-spec.json: 2 chart_customization blocks")
spec_case("B: vega_template is broken JSON", "agent-spec.json",
          orch(lambda o: must(o, '  "usermeta": {\n    "merge": "extend"\n  }\n}\n' + CLOSE,
                              '  "usermeta": {\n    "merge": "extend",\n  }\n}\n' + CLOSE)),
          expect="RULE B agent-spec.json: vega_template is not valid JSON")
spec_case("B: named font in the template", "agent-spec.json",
          orch(lambda o: must(o, '      "labelFont": "sans-serif",', '      "labelFont": "Arial",')),
          expect="= 'Arial' is not a CSS generic family")

# ---- RULE C: the block owns its section ---------------------------------------
spec_case("C: block appended to the previous section (no header)", "ops-agent-spec.json",
          orch(lambda o: must(o, HEADER + OPEN, OPEN)),
          expect="RULE C ops-agent-spec.json: the chart_customization block has no")


def move_block_to_last_section(o: str) -> str:
    """The append bug with the header left behind: the block now sits at the end
    of the AUTOMATIONS section, under an empty CHART CUSTOMIZATION header."""
    block = block_of(o)
    return o.replace(block + "\n", "", 1).rstrip("\n") + "\n" + block


spec_case("C: block moved under the last section, header left behind", "agent-spec.json",
          orch(move_block_to_last_section), expect="RULE C agent-spec.json")

# ---- RULE D: verified queries <-> DDL -----------------------------------------
h.replace(VQR, '        "top_origins_per_region",', '        "top_origins_by_region",',
          expect="RULE D SV_FLEET_OPS: AI_VERIFIED_QUERIES does not contain 'top_origins_by_region'",
          name="D: verified_queries.py and the DDL diverge")


def drop_vqr_clause(src: str) -> str:
    start = src.index("  AI_VERIFIED_QUERIES (\n    top_origins_per_region AS (")
    end = src.index("\n  )\n;", start) + len("\n  )")
    return src[:start].rstrip("\n") + src[end:]


text_case("D: semantic view loses its AI_VERIFIED_QUERIES clause", SVS, drop_vqr_clause,
          expect="RULE D SV_FLEET_OPS: no AI_VERIFIED_QUERIES clause")
h.replace(VQR, 'VQRS = {\n', 'VQRS = {\n    "SV_NEGTEST": ("q", "Q?", False, "SELECT 1"),\n',
          expect="RULE D SV_NEGTEST: verified_queries.py names a view with no CREATE",
          name="D: verified query for a view that does not exist")

# ---- RULE E: skills array <-> folders on disk ---------------------------------
spec_case("E: no skills array", "agent-spec.json", lambda d: d.pop("skills"),
          expect="RULE E agent-spec.json: no skills array")
h.delete(SKILL_MD, expect="spec points at /skills/asset_velocity but", name="E: dangling skill reference")
h.add(f"{SKILLS}/negtest_orphan/SKILL.md", "---\nname: negtest-orphan\ndescription: orphan\n---\n",
      expect="RULE E negtest_orphan: SKILL.md exists but no agent spec references it",
      name="E: SKILL.md on disk that no spec references")
spec_case("E: unparseable stage path", "agent-spec.json",
          lambda d: d["skills"][0]["source"].__setitem__("path", "@FLEET_INTELLIGENCE.SEMANTIC.COWORK_SKILLS"),
          expect="has an unparseable stage path")

# ---- RULE F: front matter that PARSES -----------------------------------------
text_case("F: unquoted description containing ': ' (shipped)", SKILL_MD,
          lambda s: re.sub(r"^description: '(.*?)'$", lambda m: "description: " + m.group(1), s, 1, re.M | re.S),
          expect="RULE F asset_velocity: SKILL.md front matter is not valid YAML")
text_case("F: description missing", SKILL_MD,
          lambda s: re.sub(r"^description: '.*?'\n", "", s, 1, re.M | re.S),
          expect="RULE F asset_velocity: SKILL.md front matter has no usable description")
text_case("F: name disagrees with the spec entry", SKILL_MD,
          lambda s: must(s, "name: asset-velocity\n", "name: asset-velocity-v2\n"),
          expect="does not match the agent spec entry 'asset-velocity'")
text_case("F: no front matter block", SKILL_MD, lambda s: s[s.index("\n---", 3) + 4:],
          expect="RULE F asset_velocity: SKILL.md has no YAML front matter block")

sys.exit(h.finish())
