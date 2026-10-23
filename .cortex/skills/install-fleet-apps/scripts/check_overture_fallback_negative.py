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
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
