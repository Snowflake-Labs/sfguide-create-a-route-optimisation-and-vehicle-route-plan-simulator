# Plan: Move Code Into Skill Folder

## Problem
The `build-routing-solution` skill lives at `.cortex/skills/build-routing-solution/SKILL.md` and uses relative paths like `Native_app/deploy.sh`, but the actual code lives at `build-routing-solution/` in the repo root. During execution, the skill looks in the wrong directory and fails to find files like `ors-config.yml` and `SanFrancisco.osm.pbf`.

## Solution
Move the entire `build-routing-solution/` directory contents into `.cortex/skills/build-routing-solution/` so all relative paths in SKILL.md resolve correctly.

## Current Structure
```
repo-root/
├── .cortex/skills/build-routing-solution/
│   ├── SKILL.md                    # skill definition (references Native_app/)
│   └── references/                 # troubleshooting docs
├── build-routing-solution/         # actual code
│   ├── Native_app/
│   │   ├── app/
│   │   ├── services/
│   │   ├── deploy.sh
│   │   ├── snowflake.yml
│   │   └── ...
│   └── (other files?)
```

## Target Structure
```
repo-root/
├── .cortex/skills/build-routing-solution/
│   ├── SKILL.md
│   ├── references/
│   ├── Native_app/                 # MOVED here
│   │   ├── app/
│   │   ├── services/
│   │   ├── deploy.sh
│   │   ├── snowflake.yml
│   │   └── ...
│   └── (other moved files)
```

## Steps

### 1. Inventory both directories
List what's in `build-routing-solution/` (the source) and `.cortex/skills/build-routing-solution/` (the destination) to understand what needs to move and avoid conflicts.

### 2. Move code into skill folder
Move `build-routing-solution/Native_app/` and any other non-skill files from `build-routing-solution/` into `.cortex/skills/build-routing-solution/`. Preserve the `SKILL.md` and `references/` that are already there.

### 3. Remove old directory
After confirming the move, remove the now-empty `build-routing-solution/` directory from the repo root.

### 4. Verify SKILL.md paths
Read SKILL.md and confirm that all relative path references (like `Native_app/`, `provider_setup/staged_files/`) now resolve correctly from the skill folder.

### 5. Update any hardcoded paths
Check for any scripts or configs that reference the old `build-routing-solution/` repo-root path and update them.

### 6. Verify deploy still works
Run a dry-run or sanity check to ensure `snow app run` and Docker builds still function from the new location (the `snowflake.yml` paths may need updating).

## Risks
- `snowflake.yml` inside `Native_app/` may reference paths relative to the repo root — needs verification
- Docker build contexts may change — need to test
- The `deploy.sh` scripts use `SCRIPT_DIR` (self-referencing), so they should be portable
- If there are other tools or scripts outside the skill that reference `build-routing-solution/`, they'll break
