#!/usr/bin/env python3
import sys
import pandas as pd

if len(sys.argv) < 3:
    print("Usage: ods_to_csv.py <input.ods> <output.csv> [sheet_name_or_index]", file=sys.stderr)
    sys.exit(2)

inp = sys.argv[1]
out = sys.argv[2]

sheet_arg = None
if len(sys.argv) > 3:
    try:
        sheet_arg = int(sys.argv[3])
    except ValueError:
        sheet_arg = sys.argv[3]

try:
    if sheet_arg is None:
        # Default to first sheet
        x = pd.read_excel(inp, engine="odf", sheet_name=None)
        if isinstance(x, dict) and x:
            # Take the first sheet by order
            df = next(iter(x.values()))
        else:
            df = x
    else:
        df = pd.read_excel(inp, engine="odf", sheet_name=sheet_arg)
except Exception as e:
    print(f"Failed to read ODS: {e}", file=sys.stderr)
    sys.exit(1)

if isinstance(df, dict):
    # Fallback: if somehow still dict, take first
    df = next(iter(df.values()))

# Drop completely empty columns
df = df.dropna(axis=1, how='all')
# Write CSV with UTF-8 and quoted fields
df.to_csv(out, index=False)
print(f"Wrote {out} with {len(df)} rows and {len(df.columns)} columns")
