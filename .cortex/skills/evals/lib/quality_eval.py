import os
import re
import yaml
from pathlib import Path


def run(skills_root: str, config: dict, overrides: dict) -> list[dict]:
    results = []
    for skill_md in sorted(Path(skills_root).rglob("SKILL.md")):
        if "evals" in skill_md.parts:
            continue
        result = _audit_skill(skill_md, config, overrides)
        results.append(result)
    return results


def _audit_skill(skill_md: Path, config: dict, overrides: dict) -> dict:
    text = skill_md.read_text(encoding="utf-8")
    skill_dir = skill_md.parent
    folder_name = skill_dir.name

    skips = set()
    if folder_name in overrides:
        skips = set(overrides[folder_name].get("skip", []))

    checks = {}

    checks["check_1"] = _check_kebab_case(folder_name)
    checks["check_2"] = _check_filename(skill_md)
    checks["check_3"] = _check_no_readme(skill_dir)

    fm = _extract_frontmatter(text)
    checks["check_4"] = _check_frontmatter(fm, folder_name)
    checks["check_5"] = _check_no_xml(fm.get("_raw", ""))
    checks["check_6"] = _check_description(fm, config)
    checks["check_7"] = _check_body_length(text, config)
    checks["check_8"] = _check_actionable(text, config)
    checks["check_9"] = _check_error_handling(text)
    checks["check_10"] = _check_examples_or_stops(text)
    checks["check_11"] = _check_progressive_disclosure(skill_dir, text)
    checks["check_12"] = _check_step_numbering(text)
    checks["check_13"] = _check_precheck_tables(skill_dir, text)

    passed = 0
    total = 0
    details = {}
    for key, (ok, msg) in checks.items():
        if key in skips:
            details[key] = {"status": "skipped", "message": msg}
            passed += 1
            total += 1
        else:
            details[key] = {"status": "pass" if ok else "fail", "message": msg}
            if ok:
                passed += 1
            total += 1

    return {
        "skill": folder_name,
        "path": str(skill_md),
        "score": f"{passed}/{total}",
        "passed": passed,
        "total": total,
        "checks": details,
    }


def _check_kebab_case(name: str) -> tuple[bool, str]:
    ok = bool(re.match(r"^[a-z0-9]+(-[a-z0-9]+)*$", name))
    return ok, f"Folder '{name}' {'is' if ok else 'is NOT'} kebab-case"


def _check_filename(path: Path) -> tuple[bool, str]:
    return path.name == "SKILL.md", f"Filename is '{path.name}'"


def _check_no_readme(skill_dir: Path) -> tuple[bool, str]:
    has_readme = (skill_dir / "README.md").exists()
    return not has_readme, "README.md found" if has_readme else "No README.md"


def _extract_frontmatter(text: str) -> dict:
    m = re.match(r"^---\n(.*?)\n---", text, re.DOTALL)
    if not m:
        return {}
    raw = m.group(1)
    try:
        fm = yaml.safe_load(raw)
        fm["_raw"] = raw
        return fm
    except yaml.YAMLError:
        return {"_raw": raw}


def _check_frontmatter(fm: dict, folder_name: str) -> tuple[bool, str]:
    if not fm:
        return False, "No YAML frontmatter found"
    name = fm.get("name", "")
    if name != folder_name:
        return False, f"name '{name}' != folder '{folder_name}'"
    return True, f"Frontmatter OK, name='{name}'"


def _check_no_xml(raw: str) -> tuple[bool, str]:
    has_xml = bool(re.search(r"<[a-zA-Z/]", raw))
    return not has_xml, "XML angle brackets found" if has_xml else "No XML in frontmatter"


def _check_description(fm: dict, config: dict) -> tuple[bool, str]:
    desc = fm.get("description", "")
    if not desc:
        return False, "No description"
    max_chars = config.get("description_max_chars", 1024)
    if len(desc) > max_chars:
        return False, f"Description {len(desc)} chars > {max_chars}"
    has_what = bool(desc.strip())
    has_when = "use when" in desc.lower() or "when:" in desc.lower()
    has_triggers = "trigger" in desc.lower()
    if not (has_what and has_when):
        return False, "Description missing WHAT or WHEN"
    return True, f"Description OK ({len(desc)} chars, has_triggers={has_triggers})"


def _check_body_length(text: str, config: dict) -> tuple[bool, str]:
    body = re.sub(r"^---\n.*?\n---\n?", "", text, count=1, flags=re.DOTALL)
    word_count = len(body.split())
    max_words = config.get("body_max_words", 5000)
    ok = word_count <= max_words
    return ok, f"Body {word_count} words {'<=' if ok else '>'} {max_words}"


def _check_actionable(text: str, config: dict) -> tuple[bool, str]:
    vague = config.get("vague_phrases", [])
    found = [p for p in vague if p.lower() in text.lower()]
    ok = len(found) == 0
    return ok, f"Vague phrases found: {found}" if found else "No vague phrases"


def _check_error_handling(text: str) -> tuple[bool, str]:
    patterns = [r"error handling", r"troubleshoot", r"\| *issue *\|", r"\| *error *\|", r"## Error"]
    for p in patterns:
        if re.search(p, text, re.IGNORECASE):
            return True, "Error handling section found"
    return False, "No error handling section"


def _check_examples_or_stops(text: str) -> tuple[bool, str]:
    patterns = [r"example", r"stopping point", r"common scenario", r"✋"]
    for p in patterns:
        if re.search(p, text, re.IGNORECASE):
            return True, "Examples or stopping points found"
    return False, "No examples or stopping points"


def _check_progressive_disclosure(skill_dir: Path, text: str) -> tuple[bool, str]:
    refs_dir = skill_dir / "references"
    has_refs = refs_dir.is_dir() and any(refs_dir.iterdir())
    body = re.sub(r"^---\n.*?\n---\n?", "", text, count=1, flags=re.DOTALL)
    word_count = len(body.split())
    if word_count > 2000 and not has_refs:
        return False, f"Body {word_count} words with no references/ — needs extraction"
    if has_refs:
        ref_files = list(refs_dir.iterdir())
        linked = sum(1 for f in ref_files if f.name in text)
        if linked < len(ref_files):
            return False, f"Only {linked}/{len(ref_files)} reference files linked"
    return True, f"Progressive disclosure OK (body={word_count}w, refs={'yes' if has_refs else 'no'})"


def _check_step_numbering(text: str) -> tuple[bool, str]:
    step_pattern = re.compile(r"^#{2,3}\s+Step\s+(\d+)", re.MULTILINE | re.IGNORECASE)
    steps = [int(m.group(1)) for m in step_pattern.finditer(text)]
    if len(steps) < 2:
        return True, "Fewer than 2 numbered steps (skip check)"
    for i in range(1, len(steps)):
        expected = steps[i - 1] + 1
        if steps[i] != expected:
            return False, f"Step numbering gap: Step {steps[i - 1]} followed by Step {steps[i]} (expected {expected})"
    return True, f"Step numbering sequential: {steps[0]}-{steps[-1]}"


def _check_precheck_tables(skill_dir: Path, text: str) -> tuple[bool, str]:
    precheck_match = re.search(r"(?i)pre-?check.*?```sql\s*\n(.*?)```", text, re.DOTALL)
    if not precheck_match:
        return True, "No pre-check SQL found (skip check)"
    precheck_sql = precheck_match.group(1)
    from_pattern = re.compile(r"\bFROM\s+([A-Z_][A-Z0-9_.]+)", re.IGNORECASE)
    tables = set()
    for m in from_pattern.finditer(precheck_sql):
        tables.add(m.group(1).upper().split(".")[-1])
    if not tables:
        return True, "No tables in pre-check query"
    all_text = text
    refs_dir = skill_dir / "references"
    if refs_dir.is_dir():
        for f in refs_dir.iterdir():
            if f.is_file() and f.suffix in (".md", ".sql"):
                all_text += "\n" + f.read_text(encoding="utf-8")
    create_pattern = re.compile(r"CREATE\s+(?:OR\s+REPLACE\s+)?(?:TABLE|VIEW|DYNAMIC\s+TABLE)\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Z_][A-Z0-9_.]+)", re.IGNORECASE)
    created_tables = set()
    for m in create_pattern.finditer(all_text):
        created_tables.add(m.group(1).upper().split(".")[-1])
    missing = tables - created_tables
    if missing:
        return False, f"Pre-check references tables not created by pipeline: {', '.join(sorted(missing))}"
    return True, f"Pre-check tables verified: {', '.join(sorted(tables))}"
