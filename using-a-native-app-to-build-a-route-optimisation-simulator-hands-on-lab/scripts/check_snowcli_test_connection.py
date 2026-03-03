#!/usr/bin/env python3
import subprocess
import sys
from pathlib import Path

try:
    import yaml
except Exception:
    print("PyYAML is required. Install with: pip install pyyaml", file=sys.stderr)
    sys.exit(2)


def read_connection_name(repo_root: Path) -> str:
    cfg = yaml.safe_load((repo_root / 'snowcli_testing.yml').read_text())
    return cfg['testing']['connection_name']


def snow_connection_exists(name: str) -> bool:
    try:
        out = subprocess.check_output(['snow', 'connection', 'list'], text=True)
    except Exception as e:
        print(f"Failed to run snow cli: {e}", file=sys.stderr)
        return False
    # crude table match: line that starts with | name |
    needle = f"| {name} "
    return any(line.startswith("|") and needle in line for line in out.splitlines())


def main() -> int:
    repo_root = Path(__file__).resolve().parents[1]
    name = read_connection_name(repo_root)
    if snow_connection_exists(name):
        print(f"OK: SnowCLI connection '{name}' exists")
        return 0
    else:
        print(f"MISSING: SnowCLI connection '{name}' not found")
        return 1


if __name__ == '__main__':
    raise SystemExit(main())


