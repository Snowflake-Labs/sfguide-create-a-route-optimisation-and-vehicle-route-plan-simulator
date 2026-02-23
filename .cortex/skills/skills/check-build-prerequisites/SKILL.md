---
name: check-build-prerequisites
description: "Check and install build prerequisites for the Route Optimizer project. Use when: setting up environment, verifying dependencies, troubleshooting installation issues. Triggers: check build prerequisites, verify setup, install dependencies, setup build environment."
---

# Check Prerequisites

Verify all required tools are installed and guide installation of missing dependencies.

## Prerequisites

None - this skill helps you install prerequisites!

## Workflow

### Step 1: Check All Prerequisites

**Goal:** Identify which tools are installed and which are missing

**Actions:**

1. **Run** the following checks in parallel and record results:

   ```bash
   # Check VS Code
   code --version 2>/dev/null && echo "VS Code: INSTALLED" || echo "VS Code: NOT FOUND"
   
   # Check Cortex Code CLI
   cortex --version 2>/dev/null && echo "Cortex Code: INSTALLED" || echo "Cortex Code: NOT FOUND"
   
   # Check Podman
   podman --version 2>/dev/null && echo "Podman: INSTALLED" || echo "Podman: NOT FOUND"
   
   # Check Docker (optional if Podman is installed)
   docker --version 2>/dev/null && echo "Docker: INSTALLED" || echo "Docker: NOT FOUND"
   
   # Check container runtime is running (Podman or Docker)
   podman info >/dev/null 2>&1 && echo "Podman Daemon: RUNNING" || docker info >/dev/null 2>&1 && echo "Docker Daemon: RUNNING" || echo "Container Runtime: NOT RUNNING"
   
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
   | VS Code | ✅/❌ | Yes |
   | Cortex Code CLI | ✅/❌ | Yes |
   | Podman | ✅/❌ | Yes (or Docker) |
   | Docker | ✅/❌ | Yes (or Podman) |
   | Container Runtime | ✅/❌ | Yes |
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

#### VS Code Installation
- **macOS:** 
  ```bash
  brew install --cask visual-studio-code
  ```
  Or download from: https://code.visualstudio.com/download
  
- **Windows:** Download from https://code.visualstudio.com/download

- **Linux:**
  ```bash
  sudo snap install code --classic
  ```

- **Verify:** `code --version`

#### Cortex Code CLI Installation
- **Installation:** See [Cortex Code documentation](https://docs.snowflake.com/en/user-guide/cortex-code/cortex-code-cli)
- **Verify:** `cortex --version`

#### Container Runtime Installation (Podman or Docker)

**Podman** (recommended - no daemon required):
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

**Docker** (alternative if Podman is not available):
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
   - Inform them they can now run: `use the local skill from skills/deploy-route-optimizer`

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
code --version          # VS Code
cortex --version        # Cortex Code CLI  
podman --version        # Podman (or docker --version for Docker)
podman info             # Podman running (or docker info for Docker)
snow --version          # Snowflake CLI
snow connection list    # At least one connection configured
git --version           # Git
```

**Note:** Either Podman or Docker is required - you don't need both.

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

**Issue:** Snowflake connection fails
- **Solution:** Verify account identifier format (e.g., `ACCOUNT.REGION` or `ORG-ACCOUNT`)

## Output

All prerequisites verified and installed. Environment ready for deploying Route Optimizer.
