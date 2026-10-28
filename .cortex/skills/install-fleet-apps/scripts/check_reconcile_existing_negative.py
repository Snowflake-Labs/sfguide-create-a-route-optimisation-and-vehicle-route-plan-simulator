#!/usr/bin/env python3
"""Negative for test_reconcile_existing: each mutation of reconcile_existing.py
must make the suite fail. Mutants are loaded in-process; the file is untouched."""
import importlib.util
import io
import pathlib
import sys
import unittest

HERE = pathlib.Path(__file__).resolve().parent
SRC = (HERE / "reconcile_existing.py").read_text()

MUTATIONS = [
    ("stale seed columns are not added",
     'if column not in have and ctype:', 'if False:'),
    ("several columns per statement",
     'f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS {column} {ctype}"',
     'f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS {column} {ctype} DEFAULT NULL"'),
    ("AUTO_RESUME left off",
     'not in ("true", "yes", "1"):', 'not in ("true", "yes", "1", "false"):'),
    ("pool resized",
     'if min_nodes > default_min:',
     'if min_nodes > default_min:\n                self.act("resize", f"ALTER COMPUTE POOL {pool} SET MIN_NODES = 1")\n            if False:'),
    ("conflicting table dropped instead of renamed",
     'f"ALTER {kind} {fqn} RENAME TO {db}.{schema}.{legacy}"', 'f"DROP {kind} {fqn}"'),
    ("dynamic tables ignored",
     'tables | dynamic', 'tables'),
]


def suite_fails(source):
    spec = importlib.util.spec_from_loader("reconcile_existing", loader=None)
    module = importlib.util.module_from_spec(spec)
    module.__file__ = str(HERE / "reconcile_existing.py")
    exec(compile(source, module.__file__, "exec"), module.__dict__)
    sys.modules["reconcile_existing"] = module
    sys.modules.pop("test_reconcile_existing", None)
    import test_reconcile_existing
    result = unittest.TextTestRunner(stream=io.StringIO()).run(
        unittest.defaultTestLoader.loadTestsFromModule(test_reconcile_existing))
    return not result.wasSuccessful()


sys.path.insert(0, str(HERE))
ok = True
for label, old, new in MUTATIONS:
    if SRC.count(old) != 1:
        print(f"FAIL: mutation anchor not found once: {label}")
        ok = False
        continue
    convicted = suite_fails(SRC.replace(old, new))
    print(("PASS" if convicted else "FAIL") + f": {label}")
    ok &= convicted
sys.modules.pop("reconcile_existing", None)
sys.exit(0 if ok else 1)
