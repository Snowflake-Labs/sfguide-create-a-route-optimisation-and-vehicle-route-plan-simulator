---
name: routing-prerequisites
description: "Check and install build prerequisites for the Routing Solution project. Use when: verifying environment setup before building, checking if Docker/Podman/snow CLI/Node.js/Python packages/crane are installed, confirming readiness to build. Do NOT use for: building the routing solution itself (use install-fleet-apps), deploying demos, or changing ORS configuration. Triggers: check prerequisites, check build prerequisites, am I ready to build, what do I need installed, verify environment setup, Docker installed, Podman installed, snow CLI installed, Node installed."
metadata:
  author: Snowflake SIT-IS
  version: 1.0.0
  category: infrastructure
---

# Check Prerequisites

Verify all required tools are installed and guide installation of missing dependencies.

The checks below are the COMPLETE set of commands `install-fleet-apps` calls. A tool the
installer needs and this skill does not check is a defect here, because the installer then
fails partway through a long run instead of before it starts. The two easy ones to miss:
the installer's own preflight and both app image builds call `docker` directly, so Podman
alone is NOT sufficient; and three Python packages are imported by install steps, so
`python3` being present is not enough either.

## Prerequisites

None - this skill helps you install prerequisites!

## Error Logging

> Follow the Error Logging convention in AGENTS.md. Log file prefix: `routing-prerequisites`.

## Workflow

### Step 1: Check All Prerequisites

**Goal:** Identify which tools are installed and which are missing

**Actions:**

1. **Check** the tools the installer calls:

   ```bash
   # Check Cortex Code CLI
   cortex --version 2>/dev/null && echo "Cortex Code: INSTALLED" || echo "Cortex Code: NOT FOUND"
   
   # Check Docker (REQUIRED: install_fleet_apps.sh preflight and both app image builds call `docker`)
   docker --version 2>/dev/null && echo "Docker: INSTALLED" || echo "Docker: NOT FOUND"
   docker info >/dev/null 2>&1 && echo "Docker Daemon: RUNNING" || echo "Docker Daemon: NOT RUNNING"
   
   # Check Podman (optional: only usable for the ENGINE image build via CONTAINER_CMD=podman)
   podman --version 2>/dev/null && echo "Podman: INSTALLED" || echo "Podman: NOT FOUND (optional)"
   
   # Check crane (recommended: avoids the SPCS registry push hang on the manifest commit)
   crane version 2>/dev/null && echo "crane: INSTALLED" || echo "crane: NOT FOUND (recommended)"
   
   # Check Node.js >= 20 and npm (synapse tool bundles + both app builds)
   node -e 'process.exit(+process.versions.node.split(".")[0] >= 20 ? 0 : 1)' 2>/dev/null \
     && echo "Node.js: $(node --version) OK" || echo "Node.js: NOT FOUND or < 20"
   npm --version 2>/dev/null && echo "npm: INSTALLED" || echo "npm: NOT FOUND"
   
   # Check Python 3 and the three packages install steps import
   #   PyYAML                      -> pack install (step 4) hard-fails without it
   #   snowflake-connector-python  -> view verification (step 9) is SKIPPED without it
   #   requests                    -> engine map download helper
   python3 --version 2>/dev/null && echo "Python 3: INSTALLED" || echo "Python 3: NOT FOUND"
   python3 -c 'import yaml, snowflake.connector, requests' 2>/dev/null \
     && echo "Python packages: INSTALLED" || echo "Python packages: MISSING (PyYAML / snowflake-connector-python / requests)"
   
   # Check Snowflake CLI
   snow --version 2>/dev/null && echo "Snowflake CLI: INSTALLED" || echo "Snowflake CLI: NOT FOUND"
   
   # Check Git
   git --version 2>/dev/null && echo "Git: INSTALLED" || echo "Git: NOT FOUND"
   
   # Check GitHub CLI (optional)
   gh --version 2>/dev/null && echo "GitHub CLI: INSTALLED" || echo "GitHub CLI: NOT FOUND (optional)"
   ```

2. **Check** Snowflake CLI connections:
   ```bash
   snow connection list 2>/dev/null || echo "No Snowflake connections configured"
   ```

3. **Present** results to user in a summary table:

   | Prerequisite | Status | Required |
   |--------------|--------|----------|
   | Cortex Code CLI | ✅/❌ | Yes |
   | Docker (CLI + running daemon) | ✅/❌ | Yes |
   | Podman | ✅/❌ | No (optional, engine build only) |
   | crane | ✅/❌ | Recommended |
   | Node.js >= 20 + npm | ✅/❌ | Yes |
   | Python 3 | ✅/❌ | Yes |
   | PyYAML, snowflake-connector-python, requests | ✅/❌ | Yes |
   | Snowflake CLI | ✅/❌ | Yes |
   | Snowflake Connection | ✅/❌ | Yes |
   | Git | ✅/❌ | Yes |
   | GitHub CLI | ✅/❌ | No (optional) |

4. **If all required prerequisites are installed:** Inform user they are ready to proceed and skip to Verification section.

5. **If any required prerequisites are missing:** Proceed to Step 2.

**Output:** Prerequisites status summary

### Step 2: Installation Wizard

**Goal:** Guide user through installing missing prerequisites

**Actions:**

1. **Ask user** which missing prerequisites they want to install now.

2. **For each selected prerequisite, provide installation guidance:**

#### Cortex Code CLI Installation
- **Installation:** See [Cortex Code documentation](https://docs.snowflake.com/en/user-guide/cortex-code/cortex-code-cli)
- **Verify:** `cortex --version`

#### Container Runtime Installation (Docker required, Podman optional)

Docker is required: `install_fleet_apps.sh` refuses to start without the `docker` command,
and both app images are built with `docker build`. Podman is an optional extra for the
engine image build only (`CONTAINER_CMD=podman`); it does not replace Docker. Note the
engine build auto-detects docker first because a default 2 GB podman machine OOMs on the
ORS image.

**Podman** (optional, engine image build only):
- **macOS:**
  ```bash
  brew install podman
  podman machine init
  podman machine start
  ```

- **Windows:** Download Podman Desktop: https://podman-desktop.io/downloads

- **Linux:**
  ```bash
  # Ubuntu/Debian
  sudo apt-get update
  sudo apt-get install podman
  
  # RHEL/CentOS/Fedora
  sudo dnf install podman
  ```

- **Verify:** `podman --version && podman info`

**Docker** (required):
- **macOS:**
  ```bash
  brew install --cask docker
  ```
  Or download Docker Desktop: https://docs.docker.com/desktop/install/mac-install/
  
- **Windows:** Download Docker Desktop: https://docs.docker.com/desktop/install/windows-install/

- **Linux:**
  ```bash
  # Ubuntu/Debian
  sudo apt-get update
  sudo apt-get install docker.io
  sudo systemctl start docker
  sudo systemctl enable docker
  ```

- **Post-install:** Start Docker Desktop (macOS/Windows) or the daemon (Linux)
- **Verify:** `docker --version && docker info`

#### crane Installation (recommended)
- **macOS:** `brew install crane`
- **Linux:** download a release from https://github.com/google/go-containerregistry/releases
- **Why:** `docker push` to the SPCS registry intermittently hangs on the final manifest commit; the installer pushes with crane when it is present.
- **Verify:** `crane version`

#### Node.js Installation (>= 20, includes npm)
- **macOS:** `brew install node` (or `nvm install 22`)
- **Windows / Linux:** https://nodejs.org/en/download
- **Verify:** `node --version && npm --version`

#### Python 3 + Packages Installation
- **Python 3:** `brew install python` (macOS) or https://www.python.org/downloads/
- **Packages:**
  ```bash
  python3 -m pip install pyyaml snowflake-connector-python requests
  ```
- **Verify:** `python3 -c 'import yaml, snowflake.connector, requests'`

#### Snowflake CLI Installation
- **All platforms:**
  ```bash
  pip install snowflake-cli-labs
  ```
  
- **Configure connection:**
  ```bash
  snow connection add
  ```
  Follow prompts to enter:
  - Connection name (e.g., `my-snowflake`)
  - Account identifier
  - Username
  - Authentication method (password, SSO, key-pair)

- **Verify:** `snow --version && snow connection list`

#### Git Installation
- **macOS:**
  ```bash
  brew install git
  ```
  Or install Xcode Command Line Tools: `xcode-select --install`

- **Windows:** Download from https://git-scm.com/download/win

- **Linux:**
  ```bash
  # Ubuntu/Debian
  sudo apt-get install git
  
  # RHEL/CentOS
  sudo yum install git
  ```

- **Configure:**
  ```bash
  git config --global user.name "Your Name"
  git config --global user.email "your.email@example.com"
  ```

- **Verify:** `git --version`

#### GitHub CLI Installation (Optional)
- **macOS:**
  ```bash
  brew install gh
  ```

- **Windows:**
  ```bash
  winget install --id GitHub.cli
  ```

- **Linux:**
  ```bash
  # Ubuntu/Debian
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null
  sudo apt update
  sudo apt install gh
  ```

- **Authenticate:**
  ```bash
  gh auth login
  ```

- **Verify:** `gh --version`

**Output:** Installation commands executed or provided

### Step 3: Verify Installation

**Goal:** Confirm all prerequisites are now installed correctly

**Actions:**

1. **Re-run** the checks from Step 1

2. **If all required prerequisites pass:** 
   - Congratulate user
   - Inform them they can now run: `build routing solution`

3. **If any required prerequisites still missing:**
   - List the remaining missing items
   - Offer to retry installation or provide manual installation links

**Output:** Final verification status

## Stopping Points

- ✋ After Step 1: Review which prerequisites need to be installed
- ✋ After Step 2: Confirm installations completed without errors

## Verification

After completion, all these commands should succeed:

```bash
cortex --version        # Cortex Code CLI  
docker --version        # Docker CLI
docker info             # Docker daemon running
node --version          # Node.js >= 20
npm --version           # npm
python3 -c 'import yaml, snowflake.connector, requests'   # Python 3 + packages
snow --version          # Snowflake CLI
snow connection list    # At least one connection configured
git --version           # Git
crane version           # crane (recommended)
```

**Note:** Docker is required. Podman is optional and only used for the engine image build when `CONTAINER_CMD=podman` is set.

## Common Issues

**Issue:** `brew` command not found (macOS)
- **Solution:** Install Homebrew: `/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"`

**Issue:** Docker daemon not running
- **Solution:** 
  - macOS/Windows: Open Docker Desktop application
  - Linux: `sudo systemctl start docker`

**Issue:** Permission denied for Docker
- **Solution:** Add user to docker group: `sudo usermod -aG docker $USER` then log out and back in

**Issue:** `pip` command not found
- **Solution:** Install Python first, or use `pip3` instead

**Issue:** `snow` CLI prints version update warnings
- **Solution:** Set `export SNOWFLAKE_CLI_NO_UPDATE_CHECK=1` in your shell profile to suppress update check noise during builds

**Issue:** Snowflake connection fails
- **Solution:** Verify account identifier format (e.g., `ACCOUNT.REGION` or `ORG-ACCOUNT`)

## Output

All prerequisites verified and installed. Environment ready for deploying Route Optimizer.
