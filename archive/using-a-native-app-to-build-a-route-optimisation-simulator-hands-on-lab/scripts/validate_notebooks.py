#!/usr/bin/env python3
import json
import sys
from pathlib import Path


NOTEBOOK_GLOBS = [
    "dataops/event/notebooks/*.ipynb",
    "using-a-native-app-to-build-a-route-optimisation-simulator-hands-on-lab/dataops/event/notebooks/*.ipynb",
]


def iter_notebooks(repo_root: Path):
    for pattern in NOTEBOOK_GLOBS:
        for p in repo_root.glob(pattern):
            if p.is_file():
                yield p


def load_notebook(path: Path):
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def validate_notebook(path: Path) -> list[str]:
    problems: list[str] = []
    nb = load_notebook(path)
    seen_names: set[str] = set()

    if not isinstance(nb.get("cells"), list):
        problems.append("Notebook missing 'cells' list")
        return problems

    for idx, cell in enumerate(nb["cells"]):
        ctype = cell.get("cell_type")
        meta = cell.get("metadata", {}) or {}
        name = meta.get("name")
        language = meta.get("language")
        collapsed = meta.get("collapsed")
        code_collapsed = meta.get("codeCollapsed")
        result_height = meta.get("resultHeight")

        # Name checks
        if ctype in {"code", "markdown"}:
            if not name:
                problems.append(f"{path.name}: cell {idx} missing metadata.name")
            elif name in seen_names:
                problems.append(f"{path.name}: duplicate metadata.name '{name}' at cell {idx}")
            else:
                seen_names.add(name)

        # Language checks for code cells
        if ctype == "code":
            if language not in {"sql", "python"}:
                problems.append(
                    f"{path.name}: cell {idx} has invalid metadata.language '{language}' (expected 'sql' or 'python')"
                )

            # Suggest codeCollapsed for long source blocks
            src = cell.get("source", "")
            if isinstance(src, list):
                src_len = sum(len(s) for s in src)
            else:
                src_len = len(src or "")
            if src_len > 1500 and not code_collapsed:
                problems.append(
                    f"{path.name}: cell {idx} is long ({src_len} chars); consider metadata.codeCollapsed=true"
                )

        # Markdown result height guidance
        if ctype == "markdown":
            src = cell.get("source")
            if isinstance(src, list):
                lines = sum(s.count("\n") + 1 for s in src)
            else:
                lines = (src or "").count("\n") + 1
            if lines > 10 and not isinstance(result_height, (int, float)):
                problems.append(
                    f"{path.name}: markdown cell {idx} is tall (~{lines} lines); consider metadata.resultHeight"
                )

        # Collapsed field should be boolean when present
        if collapsed is not None and not isinstance(collapsed, bool):
            problems.append(f"{path.name}: cell {idx} metadata.collapsed should be boolean")

    return problems


def main() -> int:
    repo_root = Path(__file__).resolve().parents[1]
    all_problems: list[str] = []
    for nb_path in iter_notebooks(repo_root):
        all_problems.extend(validate_notebook(nb_path))

    if all_problems:
        print("Notebook validation issues found:")
        for p in all_problems:
            print("- ", p)
        return 1
    else:
        print("All notebooks passed metadata validation.")
        return 0


if __name__ == "__main__":
    sys.exit(main())


