"""seed_contract.py - parse the seed loader's table shapes and COPY statements.

One parser for two consumers that must agree:
  * check_seed_copy_columns.py  (static gate: every COPY binds columns by NAME
    and every bound column is declared), and
  * reconcile_existing.py       (install time: add any declared column an
    EXISTING table lacks before the loader runs).

Why both: `CREATE TABLE IF NOT EXISTS` is a no-op on an account that already
holds an older shape, and a transform COPY (`FROM (SELECT $1:...)`) without a
column list maps by POSITION. A previously used account had a 10-column
ROUTE_OPTIMIZATION.LOOKUP, the loader's 13-value COPY failed ("expecting 10 but
got 13"), `snow sql -f` stopped there, and every later seed table - including
CORE.DIM_DATASETS - was never created.

A table's declared shape = its CREATE TABLE columns, then every
`ALTER TABLE ... ADD COLUMN IF NOT EXISTS` for it, in file order (ADD COLUMN
appends, so this is also the physical order on a fresh account).
"""
from __future__ import annotations

import pathlib
import re

REPO = pathlib.Path(__file__).resolve().parents[4]
SEED_SQL = (REPO / ".cortex/skills/install-fleet-apps/scripts/seed_data.sql",
            REPO / "datasets/load-seed-data.sql")
LOADER = SEED_SQL[1]

_CREATE = re.compile(r"CREATE\s+(?:OR\s+REPLACE\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w.$]+)\s*\(", re.I)
_ADD = re.compile(r"ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?([\w.$]+)\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+(\w+)\s+([^;]+?)\s*;", re.I)
_COPY = re.compile(r"COPY\s+INTO\s+([\w.$]+)\s*(\(([^)]*)\))?\s*FROM\s*(\()?", re.I)
_NOT_COLUMN = re.compile(r"(CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|CLUSTER)\b", re.I)


def strip_comments(sql):
    # Blank, not delete: offsets must stay valid for line numbers in the raw file.
    return re.sub(r"--[^\n]*", lambda m: " " * len(m.group()), sql)


def split_top(body):
    """Split on commas at paren/bracket depth 0."""
    out, depth, cur = [], 0, ""
    for ch in body:
        if ch in "([":
            depth += 1
        elif ch in ")]":
            depth -= 1
        if ch == "," and depth == 0:
            out.append(cur)
            cur = ""
        else:
            cur += ch
    out.append(cur)
    return [part.strip() for part in out if part.strip()]


def _paren_body(sql, start):
    depth, j = 1, start
    while depth:
        depth += {"(": 1, ")": -1}.get(sql[j], 0)
        j += 1
    return sql[start:j - 1]


def column_type(spec):
    """'NAME TYPE DEFAULT NULL COMMENT ...' -> 'TYPE' (no DEFAULT: see loader rule)."""
    words = spec.split()[1:]
    keep = []
    for word in words:
        if word.upper() in ("DEFAULT", "NOT", "NULL", "COMMENT", "COLLATE", "AUTOINCREMENT", "IDENTITY"):
            break
        keep.append(word)
    return " ".join(keep)


def table_shapes(paths=SEED_SQL):
    """{FQN: [(COLUMN, TYPE), ...]} in declared order across the seed files."""
    shapes = {}
    for path in paths:
        sql = strip_comments(pathlib.Path(path).read_text())
        for m in _CREATE.finditer(sql):
            cols = [(c.split()[0].strip('"').upper(), column_type(c))
                    for c in split_top(_paren_body(sql, m.end())) if not _NOT_COLUMN.match(c)]
            shapes[m.group(1).upper()] = cols
        for m in _ADD.finditer(sql):
            table, name = m.group(1).upper(), m.group(2).upper()
            cols = shapes.setdefault(table, [])
            if name not in (c for c, _ in cols):
                cols.append((name, column_type(name + " " + m.group(3))))
    return shapes


def copies(path=LOADER):
    """[{table, columns|None, transform, select_arity, match_by_name, line}]"""
    raw = pathlib.Path(path).read_text()
    sql = strip_comments(raw)
    out = []
    for m in _COPY.finditer(sql):
        stmt = sql[m.start():sql.find(";", m.end())]
        arity = None
        if m.group(4):
            select = re.search(r"SELECT(.*?)\bFROM\s+@", stmt, re.I | re.S)
            arity = len(split_top(select.group(1))) if select else None
        out.append({
            "table": m.group(1).upper(),
            "columns": [c.strip().strip('"').upper() for c in m.group(3).split(",")] if m.group(2) else None,
            "transform": bool(m.group(4)),
            "select_arity": arity,
            "match_by_name": "MATCH_BY_COLUMN_NAME" in stmt.upper(),
            "line": raw.count("\n", 0, m.start()) + 1,
        })
    return out


def violations(shapes=None, copy_list=None):
    """Every way a COPY can bind a column by position or to an undeclared column."""
    shapes = table_shapes() if shapes is None else shapes
    copy_list = copies() if copy_list is None else copy_list
    problems = []
    for c in copy_list:
        where = f"load-seed-data.sql:{c['line']} {c['table']}"
        declared = [name for name, _ in shapes.get(c["table"], [])]
        if not declared:
            problems.append(f"{where}: no CREATE TABLE / ADD COLUMN shape in the seed SQL")
            continue
        if c["transform"]:
            if c["columns"] is None:
                problems.append(f"{where}: transform COPY has no target column list (binds by position)")
                continue
            if c["select_arity"] is not None and len(c["columns"]) != c["select_arity"]:
                problems.append(f"{where}: {len(c['columns'])} target columns vs {c['select_arity']} SELECT values")
        elif not c["match_by_name"] and c["columns"] is None:
            problems.append(f"{where}: plain COPY without MATCH_BY_COLUMN_NAME or a column list")
        for name in c["columns"] or []:
            if name not in declared:
                problems.append(f"{where}: column {name} is not declared for the table")
    return problems
