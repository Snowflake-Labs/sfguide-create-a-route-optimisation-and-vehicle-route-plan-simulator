## Rule: Set up a SnowCLI test connection (username/password)

Purpose: Create a SnowCLI connection profile using values from `dataops/event/variables.yml`.

Inputs required from user:
- Account identifier or host (e.g., `myaccount-xy12345` or `myaccount-xy12345.snowflakecomputing.com`).

Values sourced from repo:
- Warehouse: the value of `variables:variables:EVENT_WAREHOUSE` in `dataops/event/variables.yml`.
- Database: the value of `variables:variables:EVENT_DATABASE`.
- Schema: the value of `variables:variables:EVENT_SCHEMA`.
- Role: the value of `variables:variables:EVENT_ATTENDEE_ROLE`.
- Username: the value of `variables:variables:EVENT_USER_NAME`.
- Password: the value of `variables:variables:EVENT_USER_PASSWORD`.

Steps:
1) Read values from YAML:
   - `EVENT_WAREHOUSE`
   - `EVENT_DATABASE`
   - `EVENT_SCHEMA`
   - `EVENT_ATTENDEE_ROLE`
   - `EVENT_USER_NAME`
   - `EVENT_USER_PASSWORD`

2) Prompt only for the account (or full host). Credentials are sourced from YAML.

3) Build and run the SnowCLI command (Snowflake CLI v3+):

```bash
snow connection add \
  --connection-name fleet_test \
  --account "$ACCOUNT" \
  --host "${ACCOUNT_HOST:-$ACCOUNT}.snowflakecomputing.com" \
  --user "$EVENT_USER_NAME" \
  --password "$EVENT_USER_PASSWORD" \
  --role "$EVENT_ATTENDEE_ROLE" \
  --warehouse "$EVENT_WAREHOUSE" \
  --database "$EVENT_DATABASE" \
  --schema "$EVENT_SCHEMA" \
  --no-interactive
```

Note: If the user provided a full host, set `ACCOUNT_HOST` equal to it and set `ACCOUNT` to the account identifier.

4) Verify connection context:

```bash
snow sql -c fleet_test -q "select current_account(), current_role(), current_warehouse(), current_database(), current_schema();"
```

5) Optionally set as default:

```bash
snow connection set-default fleet_test
```

Helper script (preferred):
- `scripts/setup_snowcli_connection.sh` automates parsing YAML and adding the connection.
- Examples:
```bash
scripts/setup_snowcli_connection.sh -a myaccount-xy12345
scripts/setup_snowcli_connection.sh -a myaccount-xy12345.snowflakecomputing.com -n fleet_test --default
```

Security note: For production, avoid passing passwords via CLI flags; prefer EXTERNALBROWSER or key-pair auth.


