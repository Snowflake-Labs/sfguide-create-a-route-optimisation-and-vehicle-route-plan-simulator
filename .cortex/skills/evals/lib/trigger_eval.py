import re
from pathlib import Path


def run(skills_root: str, triggers: dict) -> list[dict]:
    results = []
    skill_descriptions = _load_descriptions(skills_root)

    for skill_name, cases in triggers.items():
        desc = skill_descriptions.get(skill_name, "")
        if not desc:
            results.append({
                "skill": skill_name,
                "status": "error",
                "message": f"No description found for '{skill_name}'",
                "should_trigger": {"total": 0, "matched": 0, "details": []},
                "should_not_trigger": {"total": 0, "matched": 0, "details": []},
            })
            continue

        triggers_section = _extract_triggers_section(desc)
        desc_lower = desc.lower()

        st_cases = cases.get("should_trigger", [])
        st_results = []
        for prompt in st_cases:
            matched = _trigger_match(prompt, triggers_section, desc_lower)
            st_results.append({"prompt": prompt, "matched": matched})

        snt_cases = cases.get("should_not_trigger", [])
        snt_results = []
        for prompt in snt_cases:
            matched = _trigger_match(prompt, triggers_section, None)
            snt_results.append({"prompt": prompt, "matched": matched})

        st_matched = sum(1 for r in st_results if r["matched"])
        snt_matched = sum(1 for r in snt_results if r["matched"])

        st_pass = st_matched / len(st_cases) >= 0.6 if st_cases else True
        snt_pass = snt_matched == 0

        results.append({
            "skill": skill_name,
            "status": "pass" if (st_pass and snt_pass) else "fail",
            "should_trigger": {
                "total": len(st_cases),
                "matched": st_matched,
                "pct": round(st_matched / len(st_cases) * 100) if st_cases else 100,
                "details": st_results,
            },
            "should_not_trigger": {
                "total": len(snt_cases),
                "false_triggers": snt_matched,
                "details": snt_results,
            },
        })

    return results


def _extract_triggers_section(desc: str) -> str:
    lower = desc.lower()
    triggers_idx = lower.find("triggers:")
    do_not_idx = lower.find("do not use")
    if do_not_idx == -1:
        do_not_idx = lower.find("do not use for")

    if triggers_idx != -1:
        return lower[triggers_idx:]

    if do_not_idx != -1:
        positive = lower[:do_not_idx]
    else:
        positive = lower

    use_when_idx = positive.find("use when:")
    if use_when_idx != -1:
        return positive[use_when_idx:]

    return positive


def _trigger_match(prompt: str, triggers_section: str, full_desc: str | None) -> bool:
    prompt_lower = prompt.lower()
    if prompt_lower in triggers_section:
        return True

    words = prompt_lower.split()
    significant = [w for w in words if len(w) > 3]
    if not significant:
        return False

    if len(significant) <= 2:
        return all(w in triggers_section for w in significant)

    matched_words = sum(1 for w in significant if w in triggers_section)
    return matched_words / len(significant) >= 0.8


def _load_descriptions(skills_root: str) -> dict[str, str]:
    import yaml
    descriptions = {}
    for skill_md in Path(skills_root).rglob("SKILL.md"):
        if "evals" in skill_md.parts:
            continue
        text = skill_md.read_text(encoding="utf-8")
        m = re.match(r"^---\n(.*?)\n---", text, re.DOTALL)
        if m:
            try:
                fm = yaml.safe_load(m.group(1))
                name = fm.get("name", skill_md.parent.name)
                descriptions[name] = fm.get("description", "")
            except yaml.YAMLError:
                pass
    return descriptions
