## SQL Templates and Data Standards

### SQL Templates (Jinja2)
- Use `{{ env.VARIABLE_NAME }}` for variables
- Include `IF NOT EXISTS` guards for idempotency
- Add descriptive comments with origin tags
- Use UPPERCASE for SQL keywords

### Dataset Handling Standards
#### Separation of Concerns
- Table creation/modification in internal marketplace account
- View creation/read in lab instance account

#### Required Variables (from variables.yml)
- `{{ env.EVENT_DATABASE }}`
- `{{ env.EVENT_SCHEMA }}`
- `{{ env.EVENT_ATTENDEE_ROLE }}`
- `{{ env.EVENT_WAREHOUSE }}`
- `{{ env.CI_PROJECT_DIR }}`

### Common Patterns & Utilities
- Use `get_active_session()` in Streamlit
- Helper functions for coordinate transforms
- Reusable map components and consistent styling


