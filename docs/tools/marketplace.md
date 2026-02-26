---
summary: "Private marketplace: browse, install, sync, and uninstall vetted skills and plugins from your private catalog"
read_when:
  - You want to install skills or plugins from the private marketplace
  - You want to sync or update marketplace-installed skills
  - You want to configure the private registry and catalog
title: "Marketplace"
---

# Marketplace

The **marketplace** is SimpleClaw's private skill and plugin store. It connects to a catalog hosted on GCS and a private npm registry on Google Artifact Registry (GAR). Skills and plugins in the marketplace are vetted and built for best integration with SimpleClaw.

Related:

- Skills system: [Skills](/tools/skills)
- Skills config: [Skills config](/tools/skills-config)
- Public registry: [ClawHub](/tools/clawhub)
- Plugin system: [Plugins](/tools/plugin)
- CLI reference: [plugins CLI](/cli/plugins)

## How it works

1. A catalog file (`catalog.json`) lists available plugins and skills with versions and download URLs.
2. The catalog is hosted on GCS (`gs://simpleclaw-marketplace/catalog.json`).
3. Plugins are npm packages hosted on GAR.
4. Skills are `.tar.gz` archives hosted on GCS.
5. Authentication uses Google Cloud ADC (Application Default Credentials).

Marketplace-installed skills land in `~/.simpleclaw/skills/` (the managed skills directory), which has **higher precedence** than bundled skills. This means a marketplace skill with the same name as a bundled skill automatically takes priority.

## Prerequisites

1. Google Cloud SDK installed and authenticated (`gcloud auth login`).
2. Access to the GCP project (`jarvis-486806`).
3. Private registry configured in your SimpleClaw config (see [Configuration](#configuration) below).

## Configuration

Add the private registry settings to your SimpleClaw config (`~/.simpleclaw/config.json`):

```json
{
  "plugins": {
    "registry": {
      "npmRegistry": "https://us-central1-npm.pkg.dev/jarvis-486806/simpleclaw-npm",
      "catalogUrl": "gs://simpleclaw-marketplace/catalog.json",
      "authMethod": "gcloud-adc"
    }
  }
}
```

| Field         | Description                                                    |
| ------------- | -------------------------------------------------------------- |
| `npmRegistry` | GAR npm registry URL (for plugin installs)                     |
| `catalogUrl`  | GCS or HTTPS URL to the catalog JSON file                      |
| `authMethod`  | `"gcloud-adc"` (recommended), `"token"`, or `"npmrc"`          |
| `authToken`   | Static bearer token (only needed if `authMethod` is `"token"`) |

## CLI commands

### Browse the catalog

```bash
simpleclaw marketplace list                  # List all plugins and skills
simpleclaw marketplace list --skills-only    # Skills only
simpleclaw marketplace list --plugins-only   # Plugins only
simpleclaw marketplace list --json           # Raw JSON output
```

### Search

```bash
simpleclaw marketplace search <query>
```

Searches plugin and skill names, descriptions, and tags.

### Install

```bash
simpleclaw marketplace install <id>
```

Installs a plugin or skill from the catalog. The command checks both plugins and skills:

- **Skills**: Downloads the archive, extracts to `~/.simpleclaw/skills/<name>/`, and records the install in config. Available immediately (no restart needed).
- **Plugins**: Installs via npm from the private registry, enables in config. Requires a gateway restart.

For plugins, use `--pin` to record the exact resolved version:

```bash
simpleclaw marketplace install my-plugin --pin
```

### Sync (update all)

```bash
simpleclaw marketplace sync               # Update all installed plugins and skills
simpleclaw marketplace sync --dry-run     # Preview what would change
```

Compares installed versions with the catalog and re-downloads anything newer. Handles both plugins (via npm) and skills (via archive re-download).

### Uninstall

```bash
simpleclaw marketplace uninstall <name>
```

Removes a marketplace-installed skill (deletes the directory and config record).

### Publish

```bash
simpleclaw marketplace publish <dir>
```

Publishes a local plugin to the private npm registry.

## Skill precedence

Skills from the marketplace take priority over bundled skills because they install to the managed skills directory. The full precedence chain (highest to lowest):

1. **Workspace** skills (`<workspace>/skills/`)
2. **Project agent** skills (`<workspace>/.agents/skills/`)
3. **Personal agent** skills (`~/.agents/skills/`)
4. **Managed** skills (`~/.simpleclaw/skills/`) -- marketplace skills land here
5. **Bundled** skills (shipped with SimpleClaw)
6. **Extra dirs** (`skills.load.extraDirs` config)

## Install records

Installed skills are tracked in config under `skills.installs`:

```json
{
  "skills": {
    "installs": {
      "my-skill": {
        "source": "marketplace",
        "version": "2026.2.25",
        "archiveUrl": "gs://simpleclaw-marketplace/skills/my-skill-2026.2.25.tar.gz",
        "installedAt": "2026-02-26T00:00:00.000Z"
      }
    }
  }
}
```

## Publishing workflow (maintainer)

### Package skills

```bash
scripts/package-skills.sh                    # Package all skills to dist/skills/
scripts/package-skills.sh --upload           # Package and upload to GCS
scripts/package-skills.sh --filter my-skill  # Package a specific skill
```

### Generate catalog

```bash
bun scripts/generate-catalog.ts \
  --registry https://us-central1-npm.pkg.dev/jarvis-486806/simpleclaw-npm \
  --gcs-bucket simpleclaw-marketplace \
  --output catalog.json
```

This scans `extensions/` for plugins and `skills/` for standalone skills, generating a catalog with proper archive URLs.

### Upload catalog

```bash
gsutil cp catalog.json gs://simpleclaw-marketplace/catalog.json
```

### Full release flow

```bash
# 1. Package and upload skill archives
scripts/package-skills.sh --upload

# 2. Publish plugins to GAR (also generates and uploads catalog)
GAR_PROJECT=jarvis-486806 scripts/publish-to-gar.sh --catalog

# 3. Verify
simpleclaw marketplace list
```

## Marketplace vs ClawHub

|                   | Marketplace            | ClawHub                     |
| ----------------- | ---------------------- | --------------------------- |
| **Scope**         | Private, vetted skills | Public, community skills    |
| **Auth**          | GCP credentials        | GitHub account              |
| **Skills format** | `.tar.gz` on GCS       | `.tar.gz` via ClawHub API   |
| **Plugins**       | npm packages on GAR    | Not supported               |
| **Discovery**     | Catalog-based          | Vector search               |
| **Priority**      | Higher (managed dir)   | Depends on install location |

Both can coexist. Marketplace skills take priority when names overlap with ClawHub-installed skills in the workspace.
