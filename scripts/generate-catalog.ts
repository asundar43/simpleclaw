#!/usr/bin/env bun
/**
 * Generate a marketplace catalog.json from the extensions/ directory.
 *
 * Usage:
 *   bun scripts/generate-catalog.ts                            # print to stdout
 *   bun scripts/generate-catalog.ts --output catalog.json      # write to file
 *   bun scripts/generate-catalog.ts --registry <gar-url>       # set registry URL
 *
 * The output can be uploaded to GCS:
 *   gsutil cp catalog.json gs://simpleclaw-marketplace/catalog.json
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const EXTENSIONS_DIR = path.join(ROOT, "extensions");

type PluginManifest = {
  id: string;
  kind?: string;
  channels?: string[];
  skills?: string[];
};

type PackageJson = {
  name?: string;
  version?: string;
  description?: string;
  private?: boolean;
  simpleclaw?: {
    extensions?: string[];
    channel?: {
      id?: string;
      label?: string;
    };
    install?: {
      npmSpec?: string;
    };
  };
};

type CatalogPlugin = {
  id: string;
  name: string;
  description: string;
  npmSpec: string;
  version: string;
  kind: string;
  tags: string[];
};

type CatalogSkill = {
  name: string;
  description: string;
  archiveUrl: string;
  version: string;
  tags: string[];
};

function parseArgs() {
  const args = process.argv.slice(2);
  let output: string | undefined;
  let registry = "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--output" && args[i + 1]) {
      output = args[++i];
    } else if (args[i] === "--registry" && args[i + 1]) {
      registry = args[++i]!;
    }
  }

  return { output, registry };
}

function readJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch {
    return null;
  }
}

function inferKind(manifest: PluginManifest | null, _pkg: PackageJson): string {
  if (manifest?.kind) {
    return manifest.kind;
  }
  if (manifest?.channels && manifest.channels.length > 0) {
    return "channel";
  }
  return "tool";
}

function main() {
  const { output, registry } = parseArgs();

  const extensionDirs = fs
    .readdirSync(EXTENSIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted();

  const plugins: CatalogPlugin[] = [];
  const skills: CatalogSkill[] = [];

  for (const dirName of extensionDirs) {
    const extDir = path.join(EXTENSIONS_DIR, dirName);
    const pkg = readJson<PackageJson>(path.join(extDir, "package.json"));
    if (!pkg?.name || !pkg.version) {
      continue;
    }

    const manifest = readJson<PluginManifest>(path.join(extDir, "simpleclaw.plugin.json"));
    const pluginId = manifest?.id ?? dirName;
    const kind = inferKind(manifest, pkg);
    const npmSpec = pkg.simpleclaw?.install?.npmSpec ?? pkg.name;

    const tags: string[] = [];
    if (kind === "channel" && manifest?.channels) {
      tags.push(...manifest.channels);
    }

    plugins.push({
      id: pluginId,
      name: pkg.simpleclaw?.channel?.label ?? pkg.name.replace(/^@simpleclaw\//, ""),
      description: pkg.description ?? "",
      npmSpec,
      version: pkg.version,
      kind,
      tags,
    });

    // Check for skills in the plugin manifest
    if (manifest?.skills) {
      for (const skillPath of manifest.skills) {
        const skillDir = path.join(extDir, skillPath);
        if (!fs.existsSync(skillDir)) {
          continue;
        }
        // Each subdirectory in the skills dir is a skill
        try {
          const entries = fs.readdirSync(skillDir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isDirectory()) {
              skills.push({
                name: entry.name,
                description: `Skill from ${pluginId}`,
                archiveUrl: "",
                version: pkg.version,
                tags: [pluginId],
              });
            }
          }
        } catch {
          // Skip if skills dir can't be read
        }
      }
    }
  }

  const catalog = {
    version: 1,
    updatedAt: new Date().toISOString(),
    registry,
    plugins,
    skills,
  };

  const json = JSON.stringify(catalog, null, 2);

  if (output) {
    fs.writeFileSync(output, json + "\n");
    console.error(
      `Wrote catalog to ${output} (${plugins.length} plugins, ${skills.length} skills)`,
    );
  } else {
    process.stdout.write(json + "\n");
  }
}

main();
