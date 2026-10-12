#!/usr/bin/env python3
"""Negative tests for check_no_brands.py - each case authors a forbidden name the
way a real leak looked, and the gate must name it.

The names are taken from the gate's own term lists rather than written here:
this file is scanned like any other, so a literal would make the repo red, and
widening the gate's skip list to exempt its own test would be the slow leak the
gate warns about."""
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from check_no_brands import ACRONYM_TERMS, CONTEXTUAL, TERMS  # noqa: E402
from negtest import Harness  # noqa: E402

VENDOR = next(t for t in TERMS if t.isalpha() and t[0].isupper() and len(t) > 5)
TWO_WORD = next(t for t in TERMS if " " in t)
ACRONYM = ACRONYM_TERMS[0]
LOAD_BOARD = next(t for t in TERMS if t.isalpha() and t not in (VENDOR,) and len(t) > 6)
PERSON = TERMS[-1]
# a term the first contextual pattern accepts after "DAT / "
BOARD_AFTER_DAT = next(t for t in TERMS if re.search(CONTEXTUAL[0][0], f"DAT / {t}", re.I))

h = Harness("check_no_brands.py")
SA = ".cortex/skills/install-fleet-apps/fleet_sa_app/app"
h.add("docs/negtest_brand.md", f"Offers are imported from {VENDOR.lower()} nightly.\n",
      expect=VENDOR, name="vendor name in a doc (case-insensitive)")
h.add(".cortex/skills/install-fleet-apps/scripts/negtest_acronym.py",
      f'{ACRONYM} = "delivery_sync_layer.sql"\n', expect=ACRONYM,
      name="case-sensitive acronym used as an identifier")
h.add(f"{SA}/negtest_offers.sql", f"INSERT INTO OFFERS (SOURCE) VALUES ('{TWO_WORD}');\n",
      expect=TWO_WORD, name="brand written into data as a SQL literal")
h.add("docs/negtest_dat.md", f"Compare against DAT / {BOARD_AFTER_DAT} rates.\n",
      expect="DAT", name="DAT as a load-board name (contextual)")
h.replace(".cortex/skills/install-fleet-apps/fleet_admin_app/ui/src/app/api/matrix/build/route.ts",
          "import ", f"// rates copied from {LOAD_BOARD}\nimport ", expect=LOAD_BOARD,
          name="brand in tracked source under a dir named build/")
h.add("docs/negtest_person.md", f"Reviewed with {PERSON}.\n", expect=PERSON,
      name="named individual")
sys.exit(h.finish())
