# Subskill Architecture: upload-map-files

## Design Decision: Why a Subskill?

The map file upload workflow was extracted into a dedicated subskill for the following architectural reasons:

### 1. **Complexity Isolation**
- **Multiple execution paths:** CLI vs Workspace require fundamentally different approaches
- **Error handling:** 5+ failure modes with specific recovery procedures
- **State management:** Config must stay synchronized with file paths

### 2. **Reusability**
This subskill can be invoked by:
- `build-routing-solution` (initial deployment)
- `routing-customization/location` (region changes)
- Manual map updates (user-initiated)

### 3. **Testability**
- Isolated workflow can be tested independently
- Clear inputs and outputs for validation
- Verification steps built into the subskill

### 4. **Maintainability**
- Single source of truth for map upload logic
- Changes don't affect parent skill's readability
- Environment-specific code is contained

### 5. **Best Practice Adherence**
Per Anthropic's "Complete Guide to Building Skills for Claude" (Jan 2026):
- ✅ Subskills handle "discrete, reusable workflows"
- ✅ Parent skill acts as router/orchestrator
- ✅ Clear boundaries between subskill responsibilities
- ✅ Under 5,000 word limit for each skill

---

## Architecture Pattern

```
build-routing-solution/             (Parent Skill - Orchestrator)
├── SKILL.md                         Main deployment workflow
├── references/                      Detailed technical docs
│   ├── build-images.md
│   ├── troubleshooting.md
│   └── ...
└── upload-map-files/                (Subskill - Specialist)
    └── SKILL.md                     Map upload workflow
```

**Parent Skill Role:**
- High-level deployment orchestration
- Routes Step 4b to upload-map-files subskill
- Provides context and configuration
- Handles pre/post-upload steps

**Subskill Role:**
- Environment detection
- File upload execution (CLI or Workspace)
- Nested path workaround
- Config synchronization
- Verification and service restart

---

## Workflow Integration

### Parent Skill (build-routing-solution)

**Step 4b: Upload ORS Configuration and Map Files**

```markdown
> **Read and follow:** `.cortex/skills/build-routing-solution/upload-map-files/SKILL.md`

The subskill handles:
- ✅ Environment detection (CLI vs Workspace)
- ✅ Workspace nested path workaround
- ✅ Config-path synchronization
- ✅ Service restart and graph building
```

### Invocation Pattern

```
User: "Deploy build-routing-solution"
  ↓
Agent reads parent SKILL.md
  ↓
Executes Steps 1-4a
  ↓
Step 4b: Routes to subskill
  ↓
Agent reads upload-map-files/SKILL.md
  ↓
Executes subskill workflow (Steps 1-5)
  ↓
Returns to parent skill
  ↓
Continues with parent Steps 4c-9
```

---

## Technical Implementation

### Environment Detection (Step 1)

**Workspace Indicators:**
- `activeFile` in system context
- `snow://workspace/` stage URIs
- `COPY FILES` as only upload method

**CLI Indicators:**
- `snow stage copy` command available
- Local file system access
- Docker/Podman available

### Workspace Nested Path Workaround (Step 2b)

**Root Cause:**
Snowflake `COPY FILES` command preserves source directory structure when copying from `snow://workspace/` URIs. This is **by design** and cannot be disabled.

**Attempted Workarounds (Failed):**
- ❌ Using `PATTERN` with regex to flatten paths
- ❌ Copying to intermediate workspace location first
- ❌ Using `GET` + `PUT` (not available in workspace)
- ❌ Manual path rewriting in COPY statement

**Working Solution:**
1. Upload files with nested paths (unavoidable)
2. Update `ors-config.yml` to reference the actual nested path
3. ORS service reads config and finds file at nested location

**Example:**
```yaml
# Before (expected flat path)
source_file: /home/ors/files/SanFrancisco.osm.pbf

# After (actual nested path)
source_file: /home/ors/files/.cortex/skills/build-routing-solution/openrouteservice_app/staged_files/SanFrancisco.osm.pbf
```

### Config-Path Synchronization (Step 2b.3)

**Critical:** The config file's `source_file` path must match the actual stage path structure.

**Verification:**
```sql
-- List stage to get actual path
LIST @ORS_SPCS_STAGE/SanFrancisco/;

-- Extract path from results
-- Update config to match
-- Re-upload config
```

---

## Verification Framework (Step 3)

### Mandatory Checks

| Check | Pass Criteria | Failure Action |
|-------|---------------|----------------|
| OSM file exists | Size > 20 MB | Log error, STOP |
| Config file exists | Size > 1 KB | Log error, STOP |
| Config path matches stage | Paths align | Update config, retry |
| Profiles enabled | ≥ 2 profiles | Update config, retry |

### Verification SQL

```sql
-- File existence and size
LIST @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/SanFrancisco/;

-- Config content
SELECT $1 FROM @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/SanFrancisco/ors-config.yml
(FILE_FORMAT => (TYPE = 'CSV' FIELD_DELIMITER = NONE RECORD_DELIMITER = NONE SKIP_HEADER = 0));
```

---

## Error Recovery

### Common Errors

1. **Nested paths created (workspace)**
   - Expected behavior
   - Auto-fix: Update config to match
   - No user action required

2. **OSM file too large (>100MB)**
   - Use temp stage intermediary
   - Implemented in Step 2b.2

3. **Config path mismatch**
   - Service logs: "File not found"
   - Fix: Re-run Step 2b.3
   - Auto-detectable from logs

4. **Service won't restart**
   - Check compute pool status
   - Verify service spec valid
   - Check warehouse running

### Logging

All errors logged to: `logs/upload-map-files_<timestamp>.md`

Format:
```markdown
# Upload Map Files Error Log
**Timestamp:** 2026-05-08 21:30:00
**Environment:** workspace
**Step Failed:** 2b.2 - OSM file upload

## Error
OSM file not found at nested path

## Recovery Action
Re-uploaded using temp stage intermediary

## Final Status
✅ Success after retry
```

---

## Benefits Realized

### Before (Monolithic)
- ❌ 150+ lines of conditional logic in parent skill
- ❌ Difficult to test workspace vs CLI paths
- ❌ Error handling interleaved with deployment flow
- ❌ Hard to reuse for region changes

### After (Subskill)
- ✅ Parent skill: 10 lines routing to subskill
- ✅ Subskill: Self-contained, testable workflow
- ✅ Clear error boundaries and recovery procedures
- ✅ Reusable across multiple parent skills
- ✅ Easier to update when Snowflake behavior changes

---

## Future Enhancements

### Potential Improvements

1. **Automatic path flattening** (if Snowflake adds support)
   - Update Step 2b to use native flattening
   - Remove config synchronization workaround

2. **Parallel region uploads** (multiple maps)
   - Extend subskill to handle array of regions
   - Upload multiple maps concurrently

3. **Progress tracking** (graph building)
   - Add Step 6: Monitor graph building progress
   - Return estimated completion time

4. **Validation hooks** (pre-upload checks)
   - Verify map file integrity (PBF format)
   - Validate config YAML syntax before upload

5. **Rollback capability** (backup/restore)
   - Auto-backup current config before changes
   - One-command rollback on failure

---

## Testing Checklist

### Manual Testing

- [ ] CLI upload (local environment)
- [ ] Workspace upload (Snowsight)
- [ ] Nested path detection and config update
- [ ] Service restart triggers graph building
- [ ] Verification catches missing files
- [ ] Error recovery from failed uploads

### Integration Testing

- [ ] Called from build-routing-solution Step 4b
- [ ] Called from routing-customization/location
- [ ] Returns structured JSON output to parent
- [ ] Logs errors to correct location

### Edge Cases

- [ ] Empty map file (0 bytes)
- [ ] Corrupted OSM file
- [ ] Missing config template
- [ ] Service already suspended
- [ ] Stage path doesn't exist
- [ ] Insufficient privileges

---

## Documentation Links

- **Parent Skill:** `.cortex/skills/build-routing-solution/SKILL.md`
- **Subskill:** `.cortex/skills/build-routing-solution/upload-map-files/SKILL.md`
- **Conventions:** `AGENTS.md` > Skill Conventions
- **Troubleshooting:** `.cortex/skills/build-routing-solution/references/troubleshooting.md`

---

## Conclusion

The `upload-map-files` subskill exemplifies best practices for complex workflow decomposition:

1. **Single Responsibility:** Handles only map upload, not entire deployment
2. **Clear Interface:** Well-defined inputs, outputs, and error states
3. **Environment Agnostic:** Works in CLI and Workspace with appropriate branching
4. **Robust Error Handling:** Multiple verification steps and recovery procedures
5. **Maintainable:** Changes isolated to subskill, doesn't affect parent

This architecture makes the routing solution deployment **more reliable, testable, and maintainable** while keeping the parent skill focused on high-level orchestration.
