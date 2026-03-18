#!/usr/bin/env python3
"""Skill evals runner.

Usage:
    python run_evals.py [--skill NAME] [--type trigger|quality|xref] [--verbose] [--save]
"""
import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

import yaml

EVALS_DIR = Path(__file__).parent
SKILLS_ROOT = (EVALS_DIR / "..").resolve()


def load_config() -> dict:
    with open(EVALS_DIR / "config.yaml") as f:
        return yaml.safe_load(f)


def load_triggers() -> dict:
    with open(EVALS_DIR / "test-cases" / "triggers.yaml") as f:
        return yaml.safe_load(f)


def load_overrides() -> dict:
    p = EVALS_DIR / "test-cases" / "quality-overrides.yaml"
    if p.exists():
        with open(p) as f:
            return yaml.safe_load(f) or {}
    return {}


def load_xref_overrides() -> dict:
    p = EVALS_DIR / "test-cases" / "xref-overrides.yaml"
    if p.exists():
        with open(p) as f:
            return yaml.safe_load(f) or {}
    return {}


def run_trigger_evals(skill_filter: str | None, verbose: bool) -> tuple[int, int, list]:
    from lib import trigger_eval
    triggers = load_triggers()
    if skill_filter:
        triggers = {k: v for k, v in triggers.items() if k == skill_filter}
    results = trigger_eval.run(str(SKILLS_ROOT), triggers)
    passed = sum(1 for r in results if r["status"] == "pass")
    total = len(results)
    print(f"\n{'='*60}")
    print(f"TRIGGER EVALS: {passed}/{total} skills pass")
    print(f"{'='*60}")
    for r in results:
        icon = "PASS" if r["status"] == "pass" else "FAIL"
        st = r["should_trigger"]
        snt = r["should_not_trigger"]
        print(f"  [{icon}] {r['skill']:<35} should_trigger={st['matched']}/{st['total']} should_not_trigger_violations={snt['false_triggers']}/{snt['total']}")
        if verbose and r["status"] == "fail":
            for d in st["details"]:
                if not d["matched"]:
                    print(f"         MISS: '{d['prompt']}'")
            for d in snt["details"]:
                if d["matched"]:
                    print(f"         FALSE TRIGGER: '{d['prompt']}'")
    return passed, total, results


def run_quality_evals(skill_filter: str | None, verbose: bool) -> tuple[int, int, list]:
    from lib import quality_eval
    config = load_config()
    overrides = load_overrides()
    results = quality_eval.run(str(SKILLS_ROOT), config, overrides)
    if skill_filter:
        results = [r for r in results if r["skill"] == skill_filter]
    threshold = config.get("scoring", {}).get("quality_pass_threshold", 9) if isinstance(config.get("scoring"), dict) else 9
    passed = sum(1 for r in results if r["passed"] >= threshold)
    total = len(results)
    print(f"\n{'='*60}")
    print(f"QUALITY EVALS: {passed}/{total} skills pass (threshold={threshold}/11)")
    print(f"{'='*60}")
    for r in results:
        icon = "PASS" if r["passed"] >= threshold else "FAIL"
        print(f"  [{icon}] {r['skill']:<35} score={r['score']}")
        if verbose:
            for key, detail in r["checks"].items():
                if detail["status"] == "fail":
                    print(f"         {key}: {detail['message']}")
    return passed, total, results


def run_xref_evals(skill_filter: str | None, verbose: bool) -> tuple[int, int, list]:
    from lib import xref_eval
    overrides = load_xref_overrides()
    results = xref_eval.run(str(SKILLS_ROOT), overrides)
    if skill_filter:
        results = [r for r in results if r["skill"] == skill_filter]
    passed = sum(1 for r in results if r["status"] == "pass")
    total = len(results)
    print(f"\n{'='*60}")
    print(f"XREF EVALS: {passed}/{total} skills pass")
    print(f"{'='*60}")
    for r in results:
        icon = "PASS" if r["status"] == "pass" else "FAIL"
        print(f"  [{icon}] {r['skill']:<35} issues={r['issue_count']}")
        if verbose and r["issues"]:
            for issue in r["issues"]:
                print(f"         - {issue}")
    return passed, total, results


def main():
    parser = argparse.ArgumentParser(description="Skill evals runner")
    parser.add_argument("--skill", help="Run evals for a single skill only")
    parser.add_argument("--type", choices=["trigger", "quality", "xref"], help="Run a single eval type")
    parser.add_argument("--verbose", "-v", action="store_true", help="Show detailed failure info")
    parser.add_argument("--save", action="store_true", help="Save results to reports/")
    args = parser.parse_args()

    eval_types = [args.type] if args.type else ["trigger", "quality", "xref"]
    all_results = {}
    total_passed = 0
    total_total = 0

    if "trigger" in eval_types:
        p, t, r = run_trigger_evals(args.skill, args.verbose)
        total_passed += p
        total_total += t
        all_results["trigger"] = r

    if "quality" in eval_types:
        p, t, r = run_quality_evals(args.skill, args.verbose)
        total_passed += p
        total_total += t
        all_results["quality"] = r

    if "xref" in eval_types:
        p, t, r = run_xref_evals(args.skill, args.verbose)
        total_passed += p
        total_total += t
        all_results["xref"] = r

    print(f"\n{'='*60}")
    print(f"OVERALL: {total_passed}/{total_total} eval groups pass")
    print(f"{'='*60}")

    if args.save:
        ts = datetime.now().strftime("%Y-%m-%d")
        report_path = EVALS_DIR / "reports" / f"eval-{ts}.json"
        with open(report_path, "w") as f:
            json.dump({
                "timestamp": datetime.now().isoformat(),
                "summary": {"passed": total_passed, "total": total_total},
                "results": all_results,
            }, f, indent=2, default=str)
        print(f"\nReport saved to {report_path}")

    sys.exit(0 if total_passed == total_total else 1)


if __name__ == "__main__":
    main()
