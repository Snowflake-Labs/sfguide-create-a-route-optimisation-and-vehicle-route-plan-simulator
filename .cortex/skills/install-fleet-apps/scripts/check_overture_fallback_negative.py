#!/usr/bin/env python3
"""Prove the Overture tests reject unsafe resolver/contract mutations in memory."""
import contextlib
import io
import unittest
from unittest.mock import patch

import overture_contract as contract
import prepare_overture as loader
import test_prepare_overture as tests


def main():
    mutations = [
        (loader, "imported", lambda value: False),
        (contract, "schema_errors", lambda *args, **kwargs: []),
        (contract, "projection", lambda *args: "TO_GEOGRAPHY($1:geometry::BINARY, TRUE)"),
        (loader, "owned", lambda value: True),
    ]
    for module, name, replacement in mutations:
        output = io.StringIO()
        with patch.object(module, name, replacement), contextlib.redirect_stdout(output):
            suite = unittest.defaultTestLoader.loadTestsFromModule(tests)
            result = unittest.TextTestRunner(stream=output).run(suite)
        if result.wasSuccessful():
            print(f"FAIL: mutation {module.__name__}.{name} survived")
            return 1
        print(f"PASS: mutation {module.__name__}.{name} rejected")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
