# Documentation

## Structure

| Directory | Purpose |
|-----------|---------|
| `guides/` | User-facing tutorials, how-tos, and walkthroughs |
| `dev/` | Developer/architecture notes |

## Guides

- [Quickstart](guides/QUICKSTART.md) - Deploy the full stack (two apps, agents, MCP, engine) in a few steps
- [Tracking Tags](tracking-tags.md) - Object and session tracking tag conventions

## Architecture

- [Architecture reference](ARCHITECTURE.md) - Databases, star schema, neutral contracts, the two apps, and the agentic layer
- [Architecture tenets](../TENETS.md) - Load-bearing invariants (swappable seams, role isolation, audited envelope, live routing)

## Developer notes

- [Server architecture](dev/server-architecture.md) - Map of the fleet app server modules and where to add things
- [Page layout](dev/page-layout.md) - View/page layout conventions for the apps
- [Data Studio universal generation](dev/data-studio-universal-generation.md) - Single Overture + Marketplace synthetic data generator
- [Catchment rename migration](dev/catchment-rename-migration.md) - Neutralized catchment/delivery/network naming runbook
- [Overture seed classification](dev/overture-seed-classification.md) - which static seeds are Overture-replaceable (and which are not)

## See Also

- [AGENTS.md](../AGENTS.md) - Project-level guidance for AI coding assistants (skill conventions, structure, evals)
