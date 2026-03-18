## Rule: Verify SnowCLI test connection exists

Purpose: Ensure the designated SnowCLI testing connection exists locally, based on a name stored at the repo root.

Config file:
- `snowcli_testing.yml`
```yaml
testing:
  connection_name: connection_name_testing_purposes
```

Manual check:
```bash
NAME=$(python3 - <<'PY'
import yaml, sys
print(yaml.safe_load(open('snowcli_testing.yml'))['testing']['connection_name'])
PY
)

snow connection list | grep -E "^\|\s*${NAME}\s*\|" || echo "Connection '${NAME}' not found"
```

Scripted check (recommended):
```bash
python3 scripts/check_snowcli_test_connection.py
```

If missing:
- Create it using the helper: `scripts/setup_snowcli_connection.sh -a <account_or_host> -n "$NAME" --default`
- Or run the `snow connection add ...` command with values from `dataops/event/variables.yml`.


