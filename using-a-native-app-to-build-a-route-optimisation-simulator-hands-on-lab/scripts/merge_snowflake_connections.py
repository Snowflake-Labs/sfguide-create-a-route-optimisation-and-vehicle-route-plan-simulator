#!/usr/bin/env python3
import shutil
from pathlib import Path
import tomllib


HOME = Path.home()
CLI_PATH = HOME / ".snowflake" / "config.toml"
VSC_PATH = HOME / "Library" / "Application Support" / "Code" / "User" / "globalStorage" / "snowflake.snowflake-vsc" / "connections.toml"


def read_toml(path: Path) -> dict:
    if not path.exists():
        return {}
    with path.open("rb") as f:
        return tomllib.load(f)


def write_toml(path: Path, data: dict) -> None:
    # Minimal TOML writer to avoid external deps
    lines: list[str] = []

    def dump_value(v):
        if isinstance(v, bool):
            return "true" if v else "false"
        if isinstance(v, (int, float)):
            return str(v)
        if v is None:
            return '""'
        s = str(v).replace("\\", "\\\\").replace("\n", "\\n").replace('"', '\\"')
        return f'"{s}"'

    if "default_connection_name" in data:
        lines.append(f'default_connection_name = {dump_value(data["default_connection_name"])})')

    if "connections" in data and isinstance(data["connections"], dict):
        lines.append("")
        lines.append("[connections]")
        for name, cfg in data["connections"].items():
            lines.append("")
            lines.append(f"[connections.{name}]")
            for k, v in cfg.items():
                lines.append(f"{k} = {dump_value(v)}")
    else:
        # Flat mapping (VS Code extension style)
        for name, cfg in data.items():
            lines.append("")
            lines.append(f"[{name}]")
            for k, v in cfg.items():
                lines.append(f"{k} = {dump_value(v)}")

    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text("\n".join(lines) + "\n", encoding="utf-8")
    tmp.replace(path)


def merge():
    cli = read_toml(CLI_PATH)
    vsc = read_toml(VSC_PATH)

    cli_conns = dict(cli.get("connections", {}))
    vsc_conns = dict(vsc)

    # Build merged CLI: include all CLI + any VSC entries missing
    merged_cli = {k: v for k, v in cli.items() if k != "connections"}
    merged_cli_conns = dict(cli_conns)
    for name, cfg in vsc_conns.items():
        if name in merged_cli_conns:
            continue
        c = {}
        for key in ("account", "user", "password", "role", "warehouse", "database", "schema", "authenticator"):
            if key in cfg:
                c[key] = cfg[key]
        if c:
            merged_cli_conns[name] = c
    merged_cli["connections"] = merged_cli_conns

    # Build merged VSC: include all VSC + any CLI entries missing
    merged_vsc = dict(vsc_conns)
    for name, cfg in cli_conns.items():
        if name in merged_vsc:
            continue
        c = {}
        for key in ("account", "user", "password", "authenticator"):
            if key in cfg:
                c[key] = cfg[key]
        if "authenticator" not in c:
            c["authenticator"] = "snowflake"
        if c:
            merged_vsc[name] = c

    # Backups
    if CLI_PATH.exists():
        shutil.copy(CLI_PATH, CLI_PATH.with_suffix(".bak"))
    if VSC_PATH.exists():
        shutil.copy(VSC_PATH, VSC_PATH.with_suffix(".bak"))

    # Write
    write_toml(CLI_PATH, merged_cli)
    write_toml(VSC_PATH, merged_vsc)

    print("Merged connections written.")


if __name__ == "__main__":
    merge()


