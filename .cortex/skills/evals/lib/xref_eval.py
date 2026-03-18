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
        skill_name = skill_md.parent.name
        ignore_prefixes = overrides.get(skill_name, {}).get("ignore_prefixes", [])
        result = _check_skill(skill_md, ignore_prefixes)
        results.append(result)
    return results


def _clean_ref_name(name: str) -> str:
    name = name.rstrip("`).,:;!?'\"")
    name = name.lstrip("[(`'\"")
    name = re.sub(r"\].*$", "", name)
    name = re.sub(r"#.*$", "", name)
    return name.strip()


def _check_skill(skill_md: Path, ignore_prefixes: list[str] | None = None) -> dict:
    if ignore_prefixes is None:
        ignore_prefixes = []
    skill_dir = skill_md.parent
    folder_name = skill_dir.name
    text = skill_md.read_text(encoding="utf-8")
    issues = []

    refs_dir = skill_dir / "references"
    if refs_dir.is_dir():
        ref_files = [f for f in refs_dir.iterdir() if f.is_file()]
        for ref_file in ref_files:
            if ref_file.name not in text:
                issues.append(f"Orphaned reference: {ref_file.name} not linked from SKILL.md")

        raw_refs = re.findall(r"references/([^\s)>]+)", text)
        seen = set()
        for raw in raw_refs:
            cleaned = _clean_ref_name(raw)
            if not cleaned or cleaned in seen:
                continue
            seen.add(cleaned)
            if not (refs_dir / cleaned).exists():
                issues.append(f"Broken link: references/{cleaned} does not exist")

    assets_dir = skill_dir / "assets"
    if assets_dir.is_dir():
        asset_files = list(assets_dir.rglob("*"))
        asset_dirs_referenced = set()
        for asset in asset_files:
            if asset.is_file():
                rel = asset.relative_to(skill_dir)
                if asset.name in text or str(rel) in text:
                    for parent in rel.parents:
                        if str(parent) != ".":
                            asset_dirs_referenced.add(str(parent))

        dir_names_in_text = set()
        for asset in asset_files:
            if asset.is_dir():
                rel = str(asset.relative_to(skill_dir))
                if rel in text:
                    dir_names_in_text.add(rel)

        for asset in asset_files:
            if asset.is_file():
                rel = asset.relative_to(skill_dir)
                rel_str = str(rel)
                parent_str = str(rel.parent)
                if (asset.name not in text
                        and rel_str not in text
                        and parent_str not in dir_names_in_text
                        and parent_str not in asset_dirs_referenced):
                    is_covered = False
                    for p in rel.parents:
                        p_str = str(p)
                        if p_str != "." and (p_str + "/" in text or p_str + "`" in text or p_str + ")" in text):
                            is_covered = True
                            break
                    if not is_covered:
                        if not any(rel_str.startswith(pfx) for pfx in ignore_prefixes):
                            issues.append(f"Orphaned asset: {rel} not referenced in SKILL.md")

    fm_text = ""
    m = re.match(r"^---\n(.*?)\n---", text, re.DOTALL)
    if m:
        fm_text = m.group(1)

    config_yaml = skill_dir / "config.yaml"
    if config_yaml.exists() and fm_text:
        issues.append("Duplicate metadata: config.yaml co-exists with YAML frontmatter")

    subdirs = [d for d in skill_dir.iterdir() if d.is_dir() and d.name not in ("references", "assets", "__pycache__")]
    for subdir in subdirs:
        if (subdir / "SKILL.md").exists():
            subskill_name = subdir.name
            if subskill_name not in text:
                issues.append(f"Subskill '{subskill_name}' not mentioned in router SKILL.md")

    return {
        "skill": folder_name,
        "path": str(skill_md),
        "status": "pass" if not issues else "fail",
        "issue_count": len(issues),
        "issues": issues,
    }
