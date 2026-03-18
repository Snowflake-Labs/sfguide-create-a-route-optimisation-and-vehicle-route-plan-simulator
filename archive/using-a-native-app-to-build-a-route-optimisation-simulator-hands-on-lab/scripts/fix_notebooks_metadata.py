#!/usr/bin/env python3
import json
from pathlib import Path

NOTEBOOK_GLOBS = [
    "dataops/event/notebooks/*.ipynb",
    "using-a-native-app-to-build-a-route-optimisation-simulator-hands-on-lab/dataops/event/notebooks/*.ipynb",
]

LONG_CODE_THRESHOLD = 1500  # characters
TALL_MD_LINES = 12
DEFAULT_RESULT_HEIGHT = 100


def iter_notebooks(repo_root: Path):
    for pattern in NOTEBOOK_GLOBS:
        for p in repo_root.glob(pattern):
            if p.is_file():
                yield p


def load_notebook(path: Path):
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def save_notebook(path: Path, nb):
    with path.open("w", encoding="utf-8") as f:
        json.dump(nb, f, ensure_ascii=False, indent=1)
        f.write("\n")


def fix_notebook(path: Path) -> int:
    nb = load_notebook(path)
    changed = 0
    for cell in nb.get("cells", []):
        ctype = cell.get("cell_type")
        meta = cell.setdefault("metadata", {})
        if ctype == "code":
            src = cell.get("source", "")
            if isinstance(src, list):
                src_len = sum(len(s) for s in src)
            else:
                src_len = len(src or "")
            if src_len > LONG_CODE_THRESHOLD and not meta.get("codeCollapsed"):
                meta["codeCollapsed"] = True
                changed += 1
        elif ctype == "markdown":
            src = cell.get("source", "")
            if isinstance(src, list):
                lines = sum(s.count("\n") + 1 for s in src)
            else:
                lines = (src or "").count("\n") + 1
            if lines > TALL_MD_LINES and not isinstance(meta.get("resultHeight"), (int, float)):
                meta["resultHeight"] = DEFAULT_RESULT_HEIGHT
                changed += 1
    if changed:
        save_notebook(path, nb)
    return changed


def main() -> int:
    repo_root = Path(__file__).resolve().parents[1]
    total_changes = 0
    for nb_path in iter_notebooks(repo_root):
        total_changes += fix_notebook(nb_path)
    print(f"Applied {total_changes} metadata updates across notebooks.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
