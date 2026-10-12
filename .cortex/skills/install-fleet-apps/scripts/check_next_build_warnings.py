#!/usr/bin/env python3
"""Guard: `next build` for the SA and admin apps must not report "Compiled with
warnings".

What happened (wgb26798, fresh-machine install on dev): both production builds
printed " ⚠ Compiled with warnings" into /tmp/fleet_{sa,admin}_build.log while
the deploy step reported OK:
  - SA:    vega-canvas (via vega) does `try { require('canvas') } catch {}`; the
           package is not installed, so webpack printed "Module not found: Can't
           resolve 'canvas'" for the server bundle
  - admin: autoprefixer flagged `align-items: end` in globals.css ("end value
           has mixed support, consider using flex-end"), and webpack then logged
           two `<w> ... Skipped not serializable cache item` lines for it
A real `next build` costs a minute per app, too slow for a gate with mutations,
so this reproduces each warning's actual source instead.

Rules:
  A  Next's own PostCSS pipeline (next/dist/compiled postcss-flexbugs-fixes +
     postcss-preset-env with the options and browser targets
     next/dist/build/webpack/config/blocks/css/plugins.js uses when an app has no
     postcss config) reports no warning for any .css file under the app's src/.
     An app that adds a postcss config is refused rather than guessed at.
  B  an app whose node_modules has vega-canvas either has `canvas` installed or
     aliases `canvas: false` in next.config's webpack resolve.alias (comments
     stripped, so a comment naming the alias does not count)

Needs each app's node_modules (gates.yaml declares npm-ci for both).

Usage:  python3 .cortex/skills/install-fleet-apps/scripts/check_next_build_warnings.py
Exit:   0 clean, 1 violation
"""
from __future__ import annotations

import json
import os
import pathlib
import re
import subprocess
import sys

REPO = pathlib.Path(os.environ.get("GATE_REPO") or pathlib.Path(__file__).resolve().parents[4])
APPS = [REPO / ".cortex/skills/install-fleet-apps/fleet_sa_app/ui",
        REPO / ".cortex/skills/install-fleet-apps/fleet_admin_app/ui"]

# Mirrors getDefaultPlugins() in next/dist/build/webpack/config/blocks/css/plugins.js
# and MODERN_BROWSERSLIST_TARGET (the default when package.json has no browserslist).
POSTCSS_JS = r"""
const { createRequire } = require('module');
const path = require('path'), fs = require('fs');
const app = process.argv[1];
const req = createRequire(path.join(app, 'package.json'));
const postcss = req('postcss');
const pkg = JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8'));
const browsers = pkg.browserslist || req('next/dist/shared/lib/modern-browserslist-target');
const plugins = [
  req('next/dist/compiled/postcss-flexbugs-fixes'),
  req('next/dist/compiled/postcss-preset-env')({
    browsers, autoprefixer: { flexbox: 'no-2009' }, stage: 3,
    features: { 'custom-properties': false } }),
];
const out = [];
(async () => {
  for (const f of process.argv.slice(2)) {
    const r = await postcss(plugins).process(fs.readFileSync(f, 'utf8'), { from: f });
    for (const w of r.warnings()) out.push({ file: f, line: w.line, column: w.column, text: w.text });
  }
  console.log(JSON.stringify(out));
})().catch((e) => { console.error(String(e && e.stack || e)); process.exit(2); });
"""

failures: list[str] = []


def code(p: pathlib.Path) -> str:
    text = p.read_text()
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    return re.sub(r"(?<![:'\"\\])//[^\n]*", "", text)


def rule_a(app: pathlib.Path) -> int:
    rel = app.relative_to(REPO)
    if any(app.glob("postcss.config.*")) or any(app.glob(".postcssrc*")):
        failures.append(f"A {rel}: has its own PostCSS config - this gate mirrors Next's default "
                        "pipeline only; extend it before relying on it")
        return 0
    css = sorted(str(p) for p in (app / "src").rglob("*.css"))
    if not css:
        failures.append(f"A {rel}: no .css under src/ - the scan found nothing to check")
        return 0
    p = subprocess.run(["node", "-e", POSTCSS_JS, str(app), *css], capture_output=True, text=True)
    if p.returncode != 0:
        failures.append(f"A {rel}: could not run Next's PostCSS pipeline (npm ci?): "
                        f"{(p.stderr or p.stdout).strip()[-400:]}")
        return 0
    for w in json.loads(p.stdout or "[]"):
        f = pathlib.Path(w["file"]).relative_to(REPO)
        failures.append(f"A {f}:{w['line']}:{w['column']}: {w['text']} - `next build` reports "
                        "this as \"Compiled with warnings\"")
    return len(css)


def rule_b(app: pathlib.Path) -> None:
    rel = app.relative_to(REPO)
    if not (app / "node_modules/vega-canvas").is_dir() or (app / "node_modules/canvas").is_dir():
        return
    cfg = next(iter(sorted(app.glob("next.config.*"))), None)
    alias = cfg and re.search(r"resolve\.alias\s*=\s*\{(.*?)\n\s*\};", code(cfg), re.S)
    if not (alias and re.search(r"(?m)^\s*['\"]?canvas['\"]?\s*:\s*false\b", alias.group(1))):
        failures.append(f"B {rel}: vega-canvas is installed but `canvas` is neither installed nor "
                        "aliased to false in next.config resolve.alias - the server bundle prints "
                        "\"Module not found: Can't resolve 'canvas'\"")


def main() -> int:
    files = 0
    for app in APPS:
        if not (app / "node_modules").is_dir():
            failures.append(f"{app.relative_to(REPO)}: node_modules missing - run npm ci first")
            continue
        files += rule_a(app)
        rule_b(app)
    if failures:
        print("FAILED: next build would report warnings")
        for f in failures:
            print("  - " + f)
        return 1
    print(f"PASSED: {files} CSS file(s) across {len(APPS)} apps raise no PostCSS warning, and "
          "optional native requires are aliased.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
