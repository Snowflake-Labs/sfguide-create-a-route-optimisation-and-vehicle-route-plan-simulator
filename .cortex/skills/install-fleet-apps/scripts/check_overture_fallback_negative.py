#!/usr/bin/env python3
"""Prove the Overture tests reject unsafe resolver/contract mutations in memory."""
import contextlib
import io
import pathlib
import unittest
from unittest.mock import patch

import overture_contract as contract
import prepare_overture as loader
import test_prepare_overture as tests

SPEC = pathlib.Path(__file__).parent / "overture_places_semantic_view.yaml"
AGENT_SPEC = pathlib.Path(__file__).resolve().parents[1] / "fleet_sa_app" / "app" / "agent-spec.json"
ORIGINAL_FLEET = loader.Preparer.ensure_fleet_semantic_view
# The vendor's unrepaired expressions, which no longer resolve on the share.
VENDOR_BROKEN = {
    "CAST(TAXONOMY:primary AS TEXT)": "CAST(GET_PATH(categories, 'primary') AS TEXT)",
    "CAST(ADDRESSES[0]:country AS TEXT)": "CAST(GET_PATH(ADDRESSES, 'list[0].element.country') AS TEXT)",
    "primary_category ILIKE '%restaurant%'": "primary_category_name ILIKE '%restaurant%'",
    "expr: TAXONOMY\n": "expr: CATEGORIES\n",
}


def survives(patches):
    output = io.StringIO()
    with contextlib.ExitStack() as stack, contextlib.redirect_stdout(output):
        for target, name, value in patches:
            stack.enter_context(patch.object(target, name, value))
        suite = unittest.defaultTestLoader.loadTestsFromModule(tests)
        return unittest.TextTestRunner(stream=output).run(suite).wasSuccessful()


def main():
    original = SPEC.read_text()
    mutations = [
        ("imported share treated as local", [(loader, "imported", lambda value: False)]),
        ("schema validation disabled", [(contract, "schema_errors", lambda *a, **k: [])]),
        ("strict geometry drops invalid shapes",
         [(contract, "projection", lambda *a: "TRY_TO_GEOGRAPHY($1:geometry::BINARY)")]),
        ("foreign source treated as owned", [(loader, "owned", lambda value: True)]),
        ("semantic view step removed", [(loader.Preparer, "ensure_semantic_views", lambda self, theme: None)]),
        ("semantic view registry emptied", [(loader, "SEMANTIC_VIEWS", {})]),
        ("fleet view skipped for imported/local sources",
         [(loader.Preparer, "ensure_fleet_semantic_view",
           lambda self, theme: None if self.session.sql and not any("BEGIN" == s for s in self.session.sql)
           else ORIGINAL_FLEET(self, theme))]),
        ("fleet view registry emptied", [(loader, "FLEET_SEMANTIC_VIEWS", {})]),
        ("fleet view keeps vendor name",
         [(loader, "FLEET_SEMANTIC_VIEWS", {"places": ("FLEET_INTELLIGENCE.SEMANTIC", "OVERTUREMAPS_PLACES_SEMANTIC_VIEW",
                                                     "overture_places_semantic_view.yaml")})]),
        ("fleet view failure made fatal",
         [(loader.Preparer, "prepare",
           lambda self, theme, existing, listing: (self.resolve(theme, existing, listing),
                                                   self.ensure_fleet_semantic_view(theme))[0])]),
    ]
    failed = 0
    for label, patches in mutations:
        if survives(patches):
            print(f"FAIL: mutation survived: {label}"); failed += 1
        else:
            print(f"PASS: mutation rejected: {label}")
    # One file-level mutation per vendor defect: each must be caught on its own.
    for good, bad in VENDOR_BROKEN.items():
        if good not in original:
            print(f"FAIL: anchor not found in spec: {good!r}"); failed += 1; continue
        try:
            SPEC.write_text(original.replace(good, bad, 1))
            label = f"vendor expression restored: {bad.strip()[:60]}"
            if survives([]):
                print(f"FAIL: mutation survived: {label}"); failed += 1
            else:
                print(f"PASS: mutation rejected: {label}")
        finally:
            SPEC.write_text(original)
    # The agent must not be pointed back at the broken vendor view.
    spec_text = AGENT_SPEC.read_text()
    try:
        AGENT_SPEC.write_text(spec_text.replace(
            "FLEET_INTELLIGENCE.SEMANTIC.SV_OVERTURE_PLACES",
            "OVERTURE_MAPS__PLACES.CARTO.OVERTUREMAPS_PLACES_SEMANTIC_VIEW", 1))
        if survives([]):
            print("FAIL: mutation survived: agent spec reverted to vendor view"); failed += 1
        else:
            print("PASS: mutation rejected: agent spec reverted to vendor view")
    finally:
        AGENT_SPEC.write_text(spec_text)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
