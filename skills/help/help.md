---
name: help
description: "Get help finding the right skill. Use when: confused about which skill to use, need guidance, first time using the solution. Triggers: help, what can you do, list skills, guide me."
---

# Skill Guide

This solution has two labs with different purposes. This guide helps you find the right skill.

## Lab Overview

| Lab | Purpose | Folder |
|-----|---------|--------|
| **OpenRouteService** | Install and configure the routing engine | `oss-install-openrouteservice-native-app/` |
| **Demo** | Deploy the demo simulator and notebooks | `oss-deploy-route-optimization-demo/` |

## Common Tasks

### "I want to install the routing solution"

```
use the local skill from oss-install-openrouteservice-native-app/skills/deploy-route-optimizer
```

### "I want to deploy the demo"

```
use the local skill from oss-deploy-route-optimization-demo/skills/deploy-demo
```

### "I want to change the map location"

```
use the local skill from oss-install-openrouteservice-native-app/skills/customizations/location
```

### "I want to change vehicle profiles"

```
use the local skill from oss-install-openrouteservice-native-app/skills/customizations/vehicles
```

### "I want to change the demo industries"

```
use the local skill from oss-deploy-route-optimization-demo/skills/customizations/industries
```

### "I want to uninstall the demo"

```
use the local skill from oss-deploy-route-optimization-demo/skills/uninstall-demo
```

### "I want to uninstall everything"

```
use the local skill from oss-install-openrouteservice-native-app/skills/uninstall-route-optimizer
```

## All Available Skills

### OpenRouteService Lab

| Skill | Command |
|-------|---------|
| Check Prerequisites | `use the local skill from oss-install-openrouteservice-native-app/skills/check-prerequisites` |
| Deploy Route Optimizer | `use the local skill from oss-install-openrouteservice-native-app/skills/deploy-route-optimizer` |
| Change Location | `use the local skill from oss-install-openrouteservice-native-app/skills/customizations/location` |
| Change Vehicles | `use the local skill from oss-install-openrouteservice-native-app/skills/customizations/vehicles` |
| Uninstall ORS | `use the local skill from oss-install-openrouteservice-native-app/skills/uninstall-route-optimizer` |

### Demo Lab

| Skill | Command |
|-------|---------|
| Check ORS Prerequisite | `use the local skill from oss-deploy-route-optimization-demo/skills/check-ors-prerequisite` |
| Deploy Demo | `use the local skill from oss-deploy-route-optimization-demo/skills/deploy-demo` |
| Change Industries | `use the local skill from oss-deploy-route-optimization-demo/skills/customizations/industries` |
| Update Streamlits | `use the local skill from oss-deploy-route-optimization-demo/skills/customizations/streamlits` |
| Update AISQL Notebook | `use the local skill from oss-deploy-route-optimization-demo/skills/customizations/aisql-notebook` |
| Update Carto Notebook | `use the local skill from oss-deploy-route-optimization-demo/skills/customizations/carto-notebook` |
| Uninstall Demo | `use the local skill from oss-deploy-route-optimization-demo/skills/uninstall-demo` |

## Quick Tips

- **Changing location?** → Use ORS lab's `location` skill (downloads map, rebuilds graphs)
- **Changing vehicles?** → Use ORS lab's `vehicles` skill (rebuilds graphs)
- **Changing industries?** → Use Demo lab's `industries` skill (no graph rebuild needed)
- **Just updating coordinates?** → Use Demo lab's `streamlits` skill (but only after location change)
