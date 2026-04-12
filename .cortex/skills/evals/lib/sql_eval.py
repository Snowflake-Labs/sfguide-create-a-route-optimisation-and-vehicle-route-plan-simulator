import re
from pathlib import Path

import yaml


def run(skills_root: str, overrides: dict | None = None) -> list[dict]:
    if overrides is None:
        overrides = {}
    results = []
    for skill_md in sorted(Path(skills_root).rglob("SKILL.md")):
        if "evals" in skill_md.parts:
            continue
        skill_dir = skill_md.parent
        skill_name = skill_dir.name
        skips = set(overrides.get(skill_name, {}).get("skip", []))
        sql_texts = _collect_sql(skill_dir)
        result = _check_skill(skill_name, sql_texts, skips)
        results.append(result)
    return results


def _collect_sql(skill_dir: Path) -> list[tuple[str, str]]:
    texts = []
    for sql_file in skill_dir.rglob("*.sql"):
        texts.append((str(sql_file.relative_to(skill_dir)), sql_file.read_text(encoding="utf-8")))
    for md_file in skill_dir.rglob("*.md"):
        content = md_file.read_text(encoding="utf-8")
        rel = str(md_file.relative_to(skill_dir))
        for m in re.finditer(r"```sql\s*\n(.*?)```", content, re.DOTALL | re.IGNORECASE):
            texts.append((f"{rel}:sql-block", m.group(1)))
    return texts


def _check_skill(skill_name: str, sql_texts: list[tuple[str, str]], skips: set) -> dict:
    checks = {}
    all_sql = "\n".join(text for _, text in sql_texts)

    if "sql_1" not in skips:
        checks["sql_1"] = _check_reserved_word_rows(sql_texts)
    if "sql_2" not in skips:
        checks["sql_2"] = _check_cluster_by_geography(sql_texts)
    if "sql_3" not in skips:
        checks["sql_3"] = _check_comment_after_execute_as(sql_texts)
    if "sql_4" not in skips:
        checks["sql_4"] = _check_future_grants_to_application(sql_texts)
    if "sql_5" not in skips:
        checks["sql_5"] = _check_stale_s3_references(sql_texts)
    if "sql_6" not in skips:
        checks["sql_6"] = _check_set_variable_persistence(sql_texts)

    issues = []
    for key, (ok, msg) in checks.items():
        if not ok:
            issues.append(f"{key}: {msg}")

    return {
        "skill": skill_name,
        "status": "pass" if not issues else "fail",
        "issue_count": len(issues),
        "issues": issues,
        "checks": {k: {"status": "pass" if ok else "fail", "message": msg} for k, (ok, msg) in checks.items()},
    }


def _check_reserved_word_rows(sql_texts: list[tuple[str, str]]) -> tuple[bool, str]:
    pattern = re.compile(r"\bAS\s+ROWS\b", re.IGNORECASE)
    violations = []
    for source, text in sql_texts:
        for m in pattern.finditer(text):
            line_num = text[:m.start()].count("\n") + 1
            violations.append(f"{source}:{line_num}")
    if violations:
        return False, f"ROWS is a reserved word, used as alias in: {', '.join(violations[:3])}"
    return True, "No reserved word ROWS used as alias"


def _check_cluster_by_geography(sql_texts: list[tuple[str, str]]) -> tuple[bool, str]:
    cluster_pattern = re.compile(r"CLUSTER\s+BY\s*\(([^)]+)\)", re.IGNORECASE)
    geo_cols = {"GEOMETRY", "GEOGRAPHY", "GEOM", "POINT_GEOM", "ORIGIN", "DESTINATION", "LINE_GEOM"}
    violations = []
    for source, text in sql_texts:
        for m in cluster_pattern.finditer(text):
            cols = [c.strip().upper() for c in m.group(1).split(",")]
            for col in cols:
                if col in geo_cols:
                    line_num = text[:m.start()].count("\n") + 1
                    violations.append(f"{source}:{line_num} CLUSTER BY ({col})")
    if violations:
        return False, f"GEOGRAPHY column in CLUSTER BY: {', '.join(violations[:3])}"
    return True, "No GEOGRAPHY columns in CLUSTER BY"


def _check_comment_after_execute_as(sql_texts: list[tuple[str, str]]) -> tuple[bool, str]:
    pattern = re.compile(r"EXECUTE\s+AS\s+\w+\s*\n\s*COMMENT\s*=", re.IGNORECASE)
    violations = []
    for source, text in sql_texts:
        for m in pattern.finditer(text):
            line_num = text[:m.start()].count("\n") + 1
            violations.append(f"{source}:{line_num}")
    if violations:
        return False, f"COMMENT after EXECUTE AS (invalid syntax): {', '.join(violations[:3])}"
    return True, "No invalid COMMENT placement in procedures"


def _check_future_grants_to_application(sql_texts: list[tuple[str, str]]) -> tuple[bool, str]:
    pattern = re.compile(r"GRANT\s+.*?\bON\s+FUTURE\s+(?:TABLES|VIEWS)\b.*?\bTO\s+APPLICATION\b", re.IGNORECASE | re.DOTALL)
    violations = []
    for source, text in sql_texts:
        for m in pattern.finditer(text):
            line_num = text[:m.start()].count("\n") + 1
            violations.append(f"{source}:{line_num}")
    if violations:
        return False, f"Future grants to APPLICATION (not supported): {', '.join(violations[:3])}"
    return True, "No future grants to APPLICATION"


def _check_stale_s3_references(sql_texts: list[tuple[str, str]]) -> tuple[bool, str]:
    pattern = re.compile(r"s3://fleet-intelligence/", re.IGNORECASE)
    violations = []
    for source, text in sql_texts:
        for m in pattern.finditer(text):
            line_num = text[:m.start()].count("\n") + 1
            violations.append(f"{source}:{line_num}")
    if violations:
        return False, f"Stale S3 reference (buckets removed): {', '.join(violations[:3])}"
    return True, "No stale S3 references"


def _check_set_variable_persistence(sql_texts: list[tuple[str, str]]) -> tuple[bool, str]:
    set_pattern = re.compile(r"^\s*SET\s+(\w+)\s*=", re.IGNORECASE | re.MULTILINE)
    ref_pattern_template = r"\$\b{var}\b"

    md_blocks = [(s, t) for s, t in sql_texts if ":sql-block" in s]
    if len(md_blocks) < 2:
        return True, "Not enough separate SQL blocks to check SET persistence"

    blocks_with_set = {}
    blocks_with_ref = {}
    for source, text in md_blocks:
        for m in set_pattern.finditer(text):
            var = m.group(1).upper()
            blocks_with_set.setdefault(var, set()).add(source)

    for source, text in md_blocks:
        text_upper = text.upper()
        for var in blocks_with_set:
            if re.search(r"\$" + var + r"\b", text_upper):
                blocks_with_ref.setdefault(var, set()).add(source)

    violations = []
    for var, ref_sources in blocks_with_ref.items():
        set_sources = blocks_with_set.get(var, set())
        orphan_refs = ref_sources - set_sources
        if orphan_refs:
            violations.append(f"${var} used in block without SET")

    if violations:
        return False, f"SET variable persistence risk: {', '.join(violations[:3])}"
    return True, "No SET variable persistence issues detected"
