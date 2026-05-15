# Two-Clone Dev/Test Setup

This repo uses a two-branch / two-clone workflow per user, with each clone bound to a different Snowflake account. This guide covers the one-time setup.

See [`AGENTS.md`](../../AGENTS.md) for the day-to-day rules (commit discipline, sync operations, PR rules).

## Why two clones

- **No branch switching.** Each clone is permanently checked out on one branch.
- **Account isolation.** The dev clone targets one Snowflake account; the test clone targets another. Verification happens against an account that is closer to what reviewers will see.
- **Parallel chats.** Two SnowWork IDE instances (one per clone) work without contending for the same git index or working tree.

## Branch and clone layout

| Branch | Role | Clone directory | Snowflake account |
|---|---|---|---|
| `feat/<GITHUB_LOGIN>-feat` | Dev (rapid iteration) | `<repo>/` | dev account |
| `feat/<GITHUB_LOGIN>-test` | Test (verification, PR source) | `<repo>-test/` | test account |

PRs into `dev` originate **only** from the test branch.

## One-time setup

### 1. Detect your GitHub login

```bash
GITHUB_LOGIN=$(gh api user --jq .login)
echo "Login: $GITHUB_LOGIN"
```

If `gh` is not authenticated, run `gh auth login` first.

### 2. Create the test branch from the dev tip

From inside the existing dev clone:

```bash
DEV_BRANCH="feat/${GITHUB_LOGIN}-feat"
TEST_BRANCH="feat/${GITHUB_LOGIN}-test"

git fetch origin
# Make sure dev is up to date with origin
git rev-list --count HEAD..origin/$DEV_BRANCH   # should print 0

# Create local test branch pointing at dev tip
git branch "$TEST_BRANCH" "$DEV_BRANCH"

# Push test branch (uses the working push method)
GIT_CONFIG_GLOBAL=/dev/null \
  git -c "http.https://github.com/.extraheader=Authorization: Bearer $(gh auth token)" \
  push origin "$TEST_BRANCH"
```

### 3. Clone the test directory

```bash
DEV_DIR="/path/to/<repo>"
TEST_DIR="${DEV_DIR}-test"

git clone "$(git -C "$DEV_DIR" remote get-url origin)" "$TEST_DIR"
git -C "$TEST_DIR" checkout "$TEST_BRANCH"
```

### 4. Define Snowflake connections (manual)

Edit `~/.snowflake/connections.toml` and add (or rename) entries for each account. Example:

```toml
[connections.dev_<account-locator>]
account = "<dev-account-locator>"
user = "<your-user>"
authenticator = "..."

[connections.test_<account-locator>]
account = "<test-account-locator>"
user = "<your-user>"
authenticator = "..."
```

The agent will not touch this file. Naming is up to you, but stable names make the per-clone `.env` files self-explanatory.

### 5. Create per-clone `.env` files

These files are gitignored and pin each clone to its connection.

```bash
# Dev clone
cat > "$DEV_DIR/.env" <<EOF
SNOWFLAKE_CONNECTION_NAME=dev_<account-locator>
CORTEX_BRANCH_ROLE=dev
EOF

# Test clone
cat > "$TEST_DIR/.env" <<EOF
SNOWFLAKE_CONNECTION_NAME=test_<account-locator>
CORTEX_BRANCH_ROLE=test
EOF
```

Verify `.env` is in `.gitignore` (it already is in this repo).

### 6. Open each clone in its own SnowWork IDE

One IDE per clone. Don't open both clones in the same IDE — that defeats the purpose.

## Day-to-day operations

See [`AGENTS.md`](../../AGENTS.md) `### Sync Between Branches` for the five named on-demand sync operations:

1. Promote dev -> test (full merge)
2. Promote test -> dev (full merge)
3. Cherry-pick dev -> test (selective)
4. Cherry-pick test -> dev (selective)
5. Status check (no changes)

The agent never initiates sync on its own — only when you ask explicitly.

## Pull request flow

```
feat/<login>-feat (dev clone)  --[promote or cherry-pick]-->  feat/<login>-test (test clone)
                                                                       |
                                                                       | gh pr create --base dev
                                                                       v
                                                                      dev (integration)
                                                                       |
                                                                       | human-only PR
                                                                       v
                                                                      main (release)
```
