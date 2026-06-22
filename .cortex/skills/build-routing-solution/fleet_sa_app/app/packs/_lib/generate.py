#!/usr/bin/env python3
"""
Shared data-contract generator (Solution-Accelerator Phase-6 style).

Reads a logical data-model.yaml + an entity-mapping.yaml (a SOURCE binding) and
emits CREATE SCHEMA + view/dynamic-table + GRANT DDL for the neutral app schema.
Consumers (dashboards, semantic views) bind to these objects; swapping the
--mapping file and re-running repoints the solution at a different source with no
consumer changes.

Usage:
  # generate the app-layer DDL for a pack
  python3 generate.py --model <pack>/data-model.yaml --mapping <pack>/entity-mapping.yaml --out <pack>/setup.sql

  # emit an SV-repoint script: rebinds each semantic view's physical base tables
  # to this pack's FLEET_APP views (GET_DDL -> REPLACE -> recreate, server-side)
  python3 generate.py --model ... --mapping ... --sv-repoint DB.SCHEMA.SV_A,DB.SCHEMA.SV_B --out <pack>/sv_repoint.sql

Entity kinds (data-model access_pattern / mapping materialization):
  mapped / context  -> view (or dynamic table) selecting mapped columns from source_table (+ optional source_join)
  derived           -> computed from sibling pack objects. Two forms:
                       (a) expr/group_by rollup over a single `derived_from` entity (simple aggregates), or
                       (b) `sql:` raw SELECT body (windows, sessionization, joins, H3, multi-step DAG).
                           In `sql:` bodies use `{schema}` for the pack schema and `{src}` for the
                           fully-qualified `derived_from` view; reference any sibling as `{schema}.VW_<NAME>`.
Dependencies / ordering:
  Entities are emitted in TOPOLOGICAL order. A derived entity depends on its `derived_from` (if set)
  plus any names listed in `depends_on:` (use this when a `sql:` body reads several sibling views).
Materialization:
  view (default) | dynamic_table (uses entity.target_lag or model.dynamic_target_lag, entity.warehouse or model.warehouse).
  A `mapped` leaf or any `derived` entity may be materialized as a dynamic_table to build the DAG self-sufficiently.
SV-repoint:
  Any entity may declare `replaces: <PHYSICAL_FQN>` (or a list) -> sv-repoint also rebinds that physical
  name to this pack's VW_<entity>. Lets a semantic view follow physical DTs that have been absorbed as
  `derived` entities (those have no source_table of their own).
"""
import argparse, os, sys
try:
    import yaml
except ImportError:
    sys.exit("PyYAML required: pip install pyyaml")

ROLES = ["FLEET_APP_USER", "FLEET_APP_OPS", "FLEET_APP_ADMIN"]


def obj_name(entity: str) -> str:
    # Stable, materialization-agnostic contract object name consumers bind to.
    return f"VW_{entity}"


def col_expr(m: dict) -> str:
    app = m["app_column"]
    src = m.get("source_column")
    xf = m.get("transform")
    if xf:
        expr = xf.replace("{src}", src) if src else xf
    elif src:
        expr = src
    else:
        expr = "NULL"
    return f"{expr} AS {app}"


def from_clause(binding: dict) -> str:
    src = binding["source_table"]
    joins = binding.get("source_join") or []
    if joins:
        return src + "\n  " + "\n  ".join(joins)
    return src


def materialization(entity: dict, binding: dict, model: dict) -> str:
    return (binding.get("materialization_override")
            or entity.get("materialization")
            or binding.get("materialization")
            or "view")


def create_stmt(schema: str, name: str, body: str, mat: str, entity: dict, model: dict) -> str:
    if mat == "dynamic_table":
        lag = entity.get("target_lag") or model.get("dynamic_target_lag", "1 hour")
        wh = entity.get("warehouse") or model.get("warehouse", "MY_WH")
        return (f"CREATE OR REPLACE DYNAMIC TABLE {schema}.{name}\n"
                f"  TARGET_LAG = '{lag}' WAREHOUSE = {wh} AS\n{body};\n")
    return f"CREATE OR REPLACE VIEW {schema}.{name} AS\n{body};\n"


def gen_mapped(schema, entity, binding, model):
    name = obj_name(entity["name"])
    # Source-shaping escape hatch (lives in the MAPPING layer because it is
    # source-specific: WHERE/QUALIFY/CASE that binds a messy source to the clean
    # contract). Use {src} for the binding's source_table. Keeps data-model.yaml
    # source-agnostic; a customer swap supplies its own sql/mapping here.
    raw = binding.get("sql")
    if raw:
        body = raw.replace("{src}", binding.get("source_table", "")).rstrip().rstrip(";")
        return create_stmt(schema, name, body, materialization(entity, binding, model), entity, model)
    # passthrough: synthetic source already matches the contract 1:1 -> SELECT *
    # (data-model.yaml documents the logical columns; a real customer replaces this
    # with explicit column mappings/transforms).
    if binding.get("passthrough"):
        body = f"SELECT * FROM {from_clause(binding)}"
    else:
        cols = ",\n  ".join(col_expr(m) for m in binding["mapping"])
        body = f"SELECT\n  {cols}\nFROM {from_clause(binding)}"
    return create_stmt(schema, name, body, materialization(entity, binding, model), entity, model)


def gen_derived(schema, entity, model):
    name = obj_name(entity["name"])
    src_view = f"{schema}.{obj_name(entity['derived_from'])}" if entity.get("derived_from") else None
    raw = entity.get("sql")
    if raw:
        # Escape hatch: author supplies a full SELECT body. Substitute {schema}
        # (pack schema) and {src} (the derived_from view, if any). Sibling refs
        # are written explicitly as {schema}.VW_<NAME>.
        body = raw.replace("{src}", src_view or "").replace("{schema}", schema).rstrip().rstrip(";")
        return create_stmt(schema, name, body, entity.get("materialization", "view"), entity, model)
    # Simple rollup form: expr/group_by over a single derived_from view.
    gb = entity.get("group_by", [])
    sel = []
    for c in entity["columns"]:
        if c["name"] in gb:
            sel.append(c["name"])
        elif "expr" in c:
            sel.append(f"{c['expr']} AS {c['name']}")
        else:
            sel.append(f"NULL AS {c['name']}")
    gb_sql = ("\nGROUP BY " + ", ".join(gb)) if gb else ""
    body = f"SELECT\n  " + ",\n  ".join(sel) + f"\nFROM {src_view}{gb_sql}"
    return create_stmt(schema, name, body, entity.get("materialization", "view"), entity, model)


def entity_deps(entity):
    """Intra-pack entity names this entity must be created after."""
    deps = set()
    df = entity.get("derived_from")
    if df:
        deps.add(df)
    for d in entity.get("depends_on", []) or []:
        deps.add(d)
    return deps


def topo_order(entities):
    """Stable topological sort. mapped/context (no intra-pack deps) come first;
    derived entities follow their inputs. Preserves declaration order on ties.
    Raises on a missing dep or a cycle so authoring errors surface at generate time."""
    by_name = {e["name"]: e for e in entities}
    order = []
    state = {}  # name -> 0 visiting, 1 done

    def visit(name, stack):
        if state.get(name) == 1:
            return
        if state.get(name) == 0:
            raise SystemExit(f"Cycle in entity dependencies: {' -> '.join(stack + [name])}")
        ent = by_name.get(name)
        if ent is None:
            raise SystemExit(f"Entity '{name}' referenced as a dependency but not defined")
        state[name] = 0
        for dep in sorted(entity_deps(ent)):
            visit(dep, stack + [name])
        state[name] = 1
        order.append(ent)

    # Outer walk: sources/context first, then derived -- so a derived `sql:` body
    # that references VW_CONFIG or a mapped leaf always finds it already created.
    # Explicit derived->derived deps are still honored by the recursive visit.
    phase = {"mapped": 0, "context": 0, "derived": 1}
    for e in sorted(entities, key=lambda x: phase.get(x["access_pattern"], 2)):
        visit(e["name"], [])
    return order


def load(model_path, mapping_path):
    model = yaml.safe_load(open(model_path))
    mapping = yaml.safe_load(open(mapping_path))
    return model, mapping


def gen_setup(model, mapping):
    schema = model["app_schema"]
    db = schema.split(".")[0]
    bindings = {b["entity"]: b for b in mapping["entities"]}
    out = [
        "-- GENERATED by packs/_lib/generate.py - DO NOT EDIT BY HAND.",
        f"-- pack={model.get('pack','?')} mapping_source_id={mapping.get('source_id','?')}",
        f"CREATE DATABASE IF NOT EXISTS {db} COMMENT='{{\"origin\":\"sf_sit-is-fleet\",\"name\":\"build-routing-solution\",\"attributes\":{{\"component\":\"data-contract-app-layer\"}}}}';",
        f"CREATE SCHEMA IF NOT EXISTS {schema} COMMENT='Stable logical layer for the {model.get('pack','?')} pack (generated from data-model + entity-mapping).';\n",
    ]
    for ent in topo_order(model["entities"]):
        ap = ent["access_pattern"]
        if ap in ("mapped", "context"):
            b = bindings.get(ent["name"])
            if not b or b.get("materialization") == "derived" or not (b.get("mapping") or b.get("passthrough") or b.get("sql")):
                continue
            out.append(gen_mapped(schema, ent, b, model))
        elif ap == "derived":
            out.append(gen_derived(schema, ent, model))
    out.append("-- Grants (additive; roles from fleet_sa_app/app/role_binding.sql)")
    out.append(f"GRANT USAGE ON DATABASE {db} TO ROLE FLEET_APP_USER;")
    for r in ROLES:
        out.append(f"GRANT USAGE ON SCHEMA {schema} TO ROLE {r};")
        out.append(f"GRANT SELECT ON ALL VIEWS IN SCHEMA {schema} TO ROLE {r};")
        out.append(f"GRANT SELECT ON FUTURE VIEWS IN SCHEMA {schema} TO ROLE {r};")
        out.append(f"GRANT SELECT ON ALL DYNAMIC TABLES IN SCHEMA {schema} TO ROLE {r};")
        out.append(f"GRANT SELECT ON FUTURE DYNAMIC TABLES IN SCHEMA {schema} TO ROLE {r};")
    return "\n".join(out) + "\n"


def gen_sv_repoint(model, mapping, sv_list):
    """Emit a scripting block that rebinds each SV's physical base tables to this
    pack's FLEET_APP objects. Replacement map = each mapped/context entity's
    source_table -> FLEET_APP.<schema>.VW_<entity>."""
    schema = model["app_schema"]
    repl = []
    for b in mapping["entities"]:
        st = b.get("source_table")
        if st and b.get("materialization") != "derived":
            # strip any trailing alias from source_table for the replace key
            base = st.split()[0]
            repl.append((base, f"{schema}.{obj_name(b['entity'])}"))
    # `replaces:` on a data-model entity rebinds an absorbed physical table
    # (e.g. a former DT now computed as a `derived` entity) to its VW_.
    for ent in model["entities"]:
        reps = ent.get("replaces")
        if not reps:
            continue
        if isinstance(reps, str):
            reps = [reps]
        for r in reps:
            repl.append((r.split()[0], f"{schema}.{obj_name(ent['name'])}"))
    lines = ["DECLARE", "  ddl STRING;", "BEGIN"]
    for sv in [s.strip() for s in sv_list.split(",") if s.strip()]:
        sv_schema = ".".join(sv.split(".")[:2])
        lines.append(f"  EXECUTE IMMEDIATE 'USE SCHEMA {sv_schema}';")
        lines.append(f"  ddl := (SELECT GET_DDL('SEMANTIC_VIEW', '{sv}'));")
        for old, new in repl:
            lines.append(f"  ddl := REPLACE(ddl, '{old}', '{new}');")
        lines.append("  EXECUTE IMMEDIATE :ddl;")
    lines.append("  RETURN 'repointed semantic views';")
    lines.append("END;")
    return "\n".join(lines) + "\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--mapping", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--sv-repoint", default=None, help="comma-separated SV FQNs to rebind to this pack's views")
    ap.add_argument("--app-schema", default=None, help="override model.app_schema (e.g. a scratch FLEET_APP_VERIFY.<pack> schema for bit-for-bit checks)")
    ap.add_argument("--materialization", default=None, choices=["view", "dynamic_table"],
                    help="force ALL entities to this materialization (e.g. 'view' for instant verification, no DT refresh wait)")
    args = ap.parse_args()
    model, mapping = load(args.model, args.mapping)
    if args.app_schema:
        model["app_schema"] = args.app_schema
    if args.materialization:
        # Stamp every entity so create_stmt/materialization() resolve to the override.
        for e in model.get("entities", []):
            e["materialization"] = args.materialization
        for b in mapping.get("entities", []):
            b.pop("materialization", None)
            b.pop("materialization_override", None)
    if args.sv_repoint:
        sql = gen_sv_repoint(model, mapping, args.sv_repoint)
        open(args.out, "w").write(sql)
        print(f"Wrote {args.out} (SV-repoint for {args.sv_repoint})")
    else:
        sql = gen_setup(model, mapping)
        open(args.out, "w").write(sql)
        n_obj = sql.count("CREATE OR REPLACE")
        print(f"Wrote {args.out} ({n_obj} objects) pack={model.get('pack')} source_id={mapping.get('source_id')}")


if __name__ == "__main__":
    main()
