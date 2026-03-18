#!/usr/bin/env python3
"""
Eval Suite for synthetic-datasets-genertor skill.

Tests three areas per skill-optimiser testing-checklist.md:
  1. Structural validation (file structure, naming, YAML, size limits)
  2. Triggering tests (should-trigger, should-NOT-trigger phrases)
  3. Functional tests (content quality, workflow completeness, cross-references)

Usage:
    python eval_skill.py
"""

import os
import re
import sys
import yaml
from pathlib import Path

SKILL_DIR = Path(__file__).parent
SKILL_MD = SKILL_DIR / "SKILL.md"

PASS = 0
FAIL = 0
WARN = 0

def result(name, passed, detail=""):
    global PASS, FAIL
    status = "PASS" if passed else "FAIL"
    if passed:
        PASS += 1
    else:
        FAIL += 1
    suffix = f" -- {detail}" if detail else ""
    print(f"  [{status}] {name}{suffix}")
    return passed

def warn(name, detail=""):
    global WARN
    WARN += 1
    suffix = f" -- {detail}" if detail else ""
    print(f"  [WARN] {name}{suffix}")


def load_skill():
    with open(SKILL_MD, "r") as f:
        raw = f.read()
    parts = raw.split("---", 2)
    if len(parts) < 3:
        return None, raw
    frontmatter = yaml.safe_load(parts[1])
    body = parts[2]
    return frontmatter, body


# ============================================================================
# 1. STRUCTURAL TESTS
# ============================================================================

def test_structural():
    print("\n== 1. STRUCTURAL TESTS ==\n")

    fm, body = load_skill()

    # 1.1 Folder name is kebab-case
    folder_name = SKILL_DIR.name
    is_kebab = bool(re.match(r'^[a-z0-9]+(-[a-z0-9]+)*$', folder_name))
    result("Folder name is kebab-case", is_kebab, folder_name)

    # 1.2 SKILL.md exists with exact casing
    result("SKILL.md exists (case-sensitive)", SKILL_MD.exists())

    # 1.3 No README.md inside skill folder
    no_readme = not (SKILL_DIR / "README.md").exists()
    result("No README.md in skill folder", no_readme)

    # 1.4 YAML frontmatter exists
    result("YAML frontmatter parsed successfully", fm is not None)
    if fm is None:
        return

    # 1.5 name field matches folder
    name_matches = fm.get("name") == folder_name
    result("name field matches folder name", name_matches,
           f"name={fm.get('name')}, folder={folder_name}")

    # 1.6 name is kebab-case, no spaces/capitals
    name = fm.get("name", "")
    name_valid = bool(re.match(r'^[a-z0-9]+(-[a-z0-9]+)*$', name))
    result("name field is valid kebab-case", name_valid, name)

    # 1.7 No 'claude' or 'anthropic' in name
    no_reserved = "claude" not in name.lower() and "anthropic" not in name.lower()
    result("No reserved words in name", no_reserved)

    # 1.8 description exists
    desc = fm.get("description", "")
    result("description field exists", bool(desc))

    # 1.9 description under 1024 chars
    desc_len = len(desc)
    result("description under 1024 chars", desc_len <= 1024, f"{desc_len} chars")

    # 1.10 No XML angle brackets in frontmatter
    fm_str = yaml.dump(fm)
    no_xml = "<" not in fm_str and ">" not in fm_str
    result("No XML angle brackets in frontmatter", no_xml)

    # 1.11 SKILL.md body under 5000 words
    word_count = len(body.split())
    result("SKILL.md body under 5000 words", word_count < 5000, f"{word_count} words")

    # 1.12 metadata fields
    meta = fm.get("metadata", {})
    result("metadata.author exists", bool(meta.get("author")))
    result("metadata.version exists", bool(meta.get("version")))
    result("metadata.category exists", bool(meta.get("category")))

    # 1.13 Required subdirectories
    result("references/ directory exists", (SKILL_DIR / "references").is_dir())
    result("scripts/ directory exists", (SKILL_DIR / "scripts").is_dir())

    # 1.14 No assets/ directory (was removed)
    no_assets = not (SKILL_DIR / "assets").exists()
    result("No empty assets/ directory", no_assets)

    # 1.15 Reference files exist
    refs = SKILL_DIR / "references"
    result("references/architecture.md exists", (refs / "architecture.md").exists())
    result("references/configuration-guide.md exists", (refs / "configuration-guide.md").exists())
    result("references/troubleshooting.md exists", (refs / "troubleshooting.md").exists())

    # 1.16 Script files exist
    scripts = SKILL_DIR / "scripts"
    result("scripts/main.py exists", (scripts / "main.py").exists())
    result("scripts/src/__init__.py exists", (scripts / "src" / "__init__.py").exists())
    for module in ["simulate.py", "continuous_generator.py", "driver_profiles.py",
                    "routing.py", "overture.py", "snowflake_io.py", "qa.py"]:
        result(f"scripts/src/{module} exists", (scripts / "src" / module).exists())
    result("scripts/config/config.yml exists", (scripts / "config" / "config.yml").exists())
    result("scripts/config/calibrated_config.yml exists",
           (scripts / "config" / "calibrated_config.yml").exists())


# ============================================================================
# 2. TRIGGERING TESTS
# ============================================================================

def test_triggering():
    print("\n== 2. TRIGGERING TESTS ==\n")

    fm, body = load_skill()
    if fm is None:
        result("Frontmatter available for triggering tests", False)
        return

    desc = fm.get("description", "").lower()
    full_text = (desc + " " + body).lower()

    # 2.1 Description formula: WHAT + WHEN + triggers + negative
    result("Description has WHAT component", "generate" in desc and "telemetry" in desc)
    result("Description has WHEN component", "use when" in desc)
    result("Description has trigger phrases", "triggers:" in desc)
    result("Description has negative triggers", "do not use for" in desc.lower() or "do not" in desc)

    # 2.2 Should-trigger phrases (skill description should match these)
    should_trigger = [
        "generate synthetic telemetry",
        "create fleet data",
        "synthetic truck data",
        "generate GPS data",
        "populate telemetry tables",
        "synthetic dataset",
        "generate synthetic fleet data",
        "creating test telemetry",
        "benchmarking fleet analytics",
    ]
    print("  --- Should trigger ---")
    for phrase in should_trigger:
        words = phrase.lower().split()
        matched = sum(1 for w in words if w in desc) / len(words)
        result(f"  Trigger: '{phrase}'", matched >= 0.5, f"{matched:.0%} word match")

    # 2.3 Should-NOT-trigger phrases (negative triggers should prevent these)
    should_not_trigger = [
        "deploy route deviation",
        "real-time fleet tracking",
        "food delivery simulation",
        "route optimization demo",
        "dwell analysis pipeline",
        "create streamlit dashboard",
    ]
    print("  --- Should NOT trigger ---")
    for phrase in should_not_trigger:
        words = phrase.lower().split()
        in_negative = False
        neg_section = desc[desc.find("do not"):] if "do not" in desc else ""
        if neg_section:
            in_negative = any(w in neg_section for w in words[:2])
        not_in_positive_triggers = phrase.lower() not in desc.replace(neg_section, "")
        result(f"  No-trigger: '{phrase}'", not_in_positive_triggers or in_negative)

    # 2.4 Paraphrased trigger coverage
    paraphrased = [
        "I need fake truck GPS data for testing",
        "generate sample fleet telemetry dataset",
        "create synthetic HGV driving data",
        "populate snowflake with test fleet data",
        "make synthetic vehicle tracking data",
    ]
    print("  --- Paraphrased triggers (keyword coverage in full skill) ---")
    for phrase in paraphrased:
        keywords = [w for w in phrase.lower().split()
                    if w not in ("i", "a", "for", "the", "to", "with", "need")]
        matched = sum(1 for w in keywords if w in full_text) / len(keywords)
        if matched >= 0.4:
            result(f"  Paraphrase: '{phrase}'", True, f"{matched:.0%} keyword coverage")
        else:
            warn(f"  Paraphrase: '{phrase}'", f"only {matched:.0%} keyword coverage")


# ============================================================================
# 3. FUNCTIONAL TESTS (Content Quality)
# ============================================================================

def test_functional():
    print("\n== 3. FUNCTIONAL TESTS ==\n")

    fm, body = load_skill()
    if fm is None:
        result("Frontmatter available", False)
        return

    # 3.1 Required sections in SKILL.md body
    required_sections = [
        ("Important", r"##\s+Important"),
        ("Configuration", r"##\s+Configuration"),
        ("Execution Rules", r"##\s+Execution Rules"),
        ("Workflow", r"##\s+Workflow"),
        ("Output Schema", r"##\s+Output Schema"),
        ("Troubleshooting", r"##\s+Troubleshooting"),
    ]
    for section_name, pattern in required_sections:
        found = bool(re.search(pattern, body))
        result(f"Section '{section_name}' present", found)

    # 3.2 Workflow steps
    workflow_steps = [
        ("Step 1", "Verify Prerequisites", r"Step 1.*Prerequisit"),
        ("Step 2", "Configure Parameters", r"Step 2.*Configur"),
        ("Step 3", "Setup Snowflake Schema", r"Step 3.*Setup"),
        ("Step 4", "Generate and Load", r"Step 4.*Generate"),
        ("Step 5", "Run QA Validation", r"Step 5.*QA"),
        ("Step 6", "Verify Data", r"Step 6.*Verify"),
    ]
    for step_id, step_name, pattern in workflow_steps:
        found = bool(re.search(pattern, body, re.IGNORECASE))
        result(f"Workflow {step_id}: {step_name}", found)

    # 3.3 Query tag present and correct
    query_tag_present = '"origin":"sf_sit-is-fleet"' in body
    result("Query tag with sf_sit-is-fleet origin present", query_tag_present)

    query_tag_name = '"name":"synthetic-datasets-genertor"' in body
    result("Query tag name matches skill name", query_tag_name)

    # 3.4 SQL examples present
    sql_blocks = re.findall(r"```sql\n(.*?)```", body, re.DOTALL)
    result("SQL code blocks present", len(sql_blocks) >= 3, f"{len(sql_blocks)} blocks")

    # 3.5 Bash examples present
    bash_blocks = re.findall(r"```bash\n(.*?)```", body, re.DOTALL)
    result("Bash code blocks present", len(bash_blocks) >= 2, f"{len(bash_blocks)} blocks")

    # 3.6 Configuration table present
    config_table = "|" in body and "Parameter" in body and "Default" in body
    result("Configuration table present", config_table)

    # 3.7 Output schema table
    schema_table = "DIM_WAREHOUSE" in body and "FACT_TRUCK_TELEMETRY" in body
    result("Output schema lists all 7 tables", schema_table and
           "DIM_STOP" in body and "DIM_TRUCK" in body and "DIM_DRIVER" in body and
           "FACT_TRIP" in body and "FACT_VIOLATION" in body)

    # 3.8 Cross-references to other skills
    cross_refs = [
        ("routing-customization", "routing-customization"),
        ("fleet-intelligence-taxis", "fleet-intelligence-taxis"),
    ]
    for ref_name, pattern in cross_refs:
        found = pattern in body
        result(f"Cross-reference to '{ref_name}' skill", found)

    # 3.9 References linked (not inlined)
    ref_links = [
        "references/configuration-guide.md",
        "references/architecture.md",
        "references/troubleshooting.md",
    ]
    for ref in ref_links:
        found = ref in body
        result(f"Link to {ref}", found)

    # 3.10 Execution rules are numbered
    rules_section = body[body.find("## Execution Rules"):body.find("## Workflow")] if "## Execution Rules" in body else ""
    numbered_rules = re.findall(r"^\d+\.", rules_section, re.MULTILINE)
    result("Execution rules are numbered", len(numbered_rules) >= 4, f"{len(numbered_rules)} rules")

    # 3.11 Fully qualified names pattern
    fqn_pattern = r"\{DATABASE\}\.\{SCHEMA\}"
    result("Uses {DATABASE}.{SCHEMA} placeholder pattern",
           bool(re.search(fqn_pattern, body)))

    # 3.12 ORS verification SQL present
    ors_check = "SHOW SERVICES IN APPLICATION OPENROUTESERVICE_NATIVE_APP" in body
    result("ORS verification SQL present", ors_check)

    # 3.13 Expected output estimates
    estimates = "150K" in body or "~150K" in body
    result("Expected output size estimates present", estimates)

    # 3.14 Prerequisites list completeness
    prereqs = body[body.find("## Important"):body.find("## Configuration")] if "## Important" in body else ""
    result("Prerequisite: ORS Native App mentioned", "ORS Native App" in prereqs)
    result("Prerequisite: Python deps mentioned", "snowflake-connector-python" in prereqs)
    result("Prerequisite: Snowflake connection mentioned", "SNOWFLAKE_CONNECTION_NAME" in prereqs)
    result("Prerequisite: Overture Maps mentioned", "Overture Maps" in prereqs)

    # 3.15 Troubleshooting has cause/solution pairs
    troubleshoot_section = body[body.find("## Troubleshooting"):] if "## Troubleshooting" in body else ""
    cause_count = troubleshoot_section.count("**Cause**")
    solution_count = troubleshoot_section.count("**Solution**")
    result("Troubleshooting has cause/solution pairs", cause_count >= 2 and solution_count >= 2,
           f"{cause_count} causes, {solution_count} solutions")


# ============================================================================
# 4. REFERENCE FILE QUALITY TESTS
# ============================================================================

def test_references():
    print("\n== 4. REFERENCE FILE QUALITY ==\n")

    refs = SKILL_DIR / "references"

    # 4.1 architecture.md quality
    arch = (refs / "architecture.md").read_text() if (refs / "architecture.md").exists() else ""
    result("architecture.md has DDL statements", "CREATE TABLE" in arch)
    result("architecture.md has data flow", "Data Flow" in arch or "data flow" in arch.lower())
    result("architecture.md has driver profiles table", "COMPLIANT" in arch and "MILD" in arch and "OUTLIER" in arch)
    result("architecture.md has telemetry model", "Ping Interval" in arch or "ping" in arch.lower())
    result("architecture.md has clustering info", "CLUSTER BY" in arch)
    ddl_count = arch.count("CREATE TABLE")
    result("architecture.md has all 7 table DDLs", ddl_count >= 7, f"{ddl_count} DDLs")

    # 4.2 configuration-guide.md quality
    config = (refs / "configuration-guide.md").read_text() if (refs / "configuration-guide.md").exists() else ""
    config_sections = [
        "seed", "snowflake", "region", "time", "fleet", "distance_distribution",
        "driver_profiles", "routing", "telemetry", "dwell", "overnight", "breaks",
        "speeding", "output"
    ]
    for section in config_sections:
        found = f"### {section}" in config or f"## {section}" in config.lower() or f"`{section}`" in config
        result(f"configuration-guide.md covers '{section}'", found)

    result("configuration-guide.md has preset comparison", "config.yml" in config and "calibrated_config.yml" in config)

    # 4.3 troubleshooting.md quality
    trouble = (refs / "troubleshooting.md").read_text() if (refs / "troubleshooting.md").exists() else ""
    trouble_topics = [
        ("ORS issues", "ORS"),
        ("POI data issues", "POI" ),
        ("Memory errors", "Memory" ),
        ("COPY INTO issues", "COPY INTO"),
        ("Timestamp issues", "epoch" ),
        ("QA validation", "QA"),
    ]
    for topic_name, keyword in trouble_topics:
        found = keyword in trouble
        result(f"troubleshooting.md covers {topic_name}", found)

    cause_count = trouble.count("**Cause**") + trouble.count("**Symptoms**")
    solution_count = trouble.count("**Solution**") + trouble.count("**Fix**")
    result("troubleshooting.md has structured cause/solution pairs",
           cause_count >= 5 and solution_count >= 5,
           f"{cause_count} causes, {solution_count} solutions")


# ============================================================================
# 5. SCRIPT INTEGRITY TESTS
# ============================================================================

def test_scripts():
    print("\n== 5. SCRIPT INTEGRITY ==\n")

    scripts = SKILL_DIR / "scripts"

    # 5.1 main.py has required CLI commands
    main_py = (scripts / "main.py").read_text() if (scripts / "main.py").exists() else ""
    result("main.py has 'setup' command", "cmd_setup" in main_py or "'setup'" in main_py)
    result("main.py has 'generate' command", "cmd_generate" in main_py or "'generate'" in main_py)
    result("main.py has 'qa' command", "cmd_qa" in main_py or "'qa'" in main_py)
    result("main.py has --config argument", "--config" in main_py)
    result("main.py has --load flag", "--load" in main_py)

    # 5.2 Config YAML is valid
    for cfg_name in ["config.yml", "calibrated_config.yml"]:
        cfg_path = scripts / "config" / cfg_name
        if cfg_path.exists():
            try:
                with open(cfg_path) as f:
                    cfg = yaml.safe_load(f)
                result(f"{cfg_name} is valid YAML", True)
                result(f"{cfg_name} has snowflake section", "snowflake" in cfg)
                result(f"{cfg_name} has fleet section", "fleet" in cfg)
                result(f"{cfg_name} has driver_profiles section", "driver_profiles" in cfg)
            except Exception as e:
                result(f"{cfg_name} is valid YAML", False, str(e))

    # 5.3 Python source files are syntactically valid
    src_dir = scripts / "src"
    for py_file in sorted(src_dir.glob("*.py")):
        if py_file.name == "__init__.py":
            continue
        try:
            with open(py_file) as f:
                compile(f.read(), py_file, "exec")
            result(f"src/{py_file.name} compiles", True)
        except SyntaxError as e:
            result(f"src/{py_file.name} compiles", False, str(e))

    # 5.4 Imports between modules are consistent
    modules_with_relative_imports = []
    for py_file in sorted(src_dir.glob("*.py")):
        content = py_file.read_text()
        if "from ." in content:
            modules_with_relative_imports.append(py_file.name)
    result("Source modules use relative imports",
           len(modules_with_relative_imports) >= 2,
           f"{len(modules_with_relative_imports)} modules with relative imports")


# ============================================================================
# MAIN
# ============================================================================

def main():
    print(f"{'='*60}")
    print(f"SKILL EVAL: {SKILL_DIR.name}")
    print(f"{'='*60}")

    test_structural()
    test_triggering()
    test_functional()
    test_references()
    test_scripts()

    print(f"\n{'='*60}")
    total = PASS + FAIL
    print(f"RESULTS: {PASS} passed, {FAIL} failed, {WARN} warnings out of {total} tests")
    print(f"Score: {PASS/total*100:.1f}%")
    print(f"{'='*60}")

    return 0 if FAIL == 0 else 1

if __name__ == "__main__":
    sys.exit(main())
