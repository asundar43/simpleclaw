#!/usr/bin/env bun
/**
 * Generate a marketplace catalog.json from the extensions/ and skills/ directories.
 *
 * Usage:
 *   bun scripts/generate-catalog.ts                                       # print to stdout
 *   bun scripts/generate-catalog.ts --output catalog.json                 # write to file
 *   bun scripts/generate-catalog.ts --registry <gar-url>                  # set registry URL
 *   bun scripts/generate-catalog.ts --skills-dir skills                   # scan standalone skills
 *   bun scripts/generate-catalog.ts --gcs-bucket simpleclaw-marketplace   # generate GCS archive URLs
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
  let skillsDir: string | undefined;
  let gcsBucket: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--output" && args[i + 1]) {
      output = args[++i];
    } else if (args[i] === "--registry" && args[i + 1]) {
      registry = args[++i]!;
    } else if (args[i] === "--skills-dir" && args[i + 1]) {
      skillsDir = args[++i];
    } else if (args[i] === "--gcs-bucket" && args[i + 1]) {
      gcsBucket = args[++i];
    }
  }

  return { output, registry, skillsDir, gcsBucket };
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

/**
 * Parse the description from a SKILL.md file.
 * Tries YAML frontmatter `description:` first, then falls back to the first
 * non-heading, non-empty line after the frontmatter.
 */
function parseSkillDescription(filePath: string): string | null {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n");

    // Check for YAML frontmatter
    if (lines[0]?.trim() === "---") {
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim() === "---") {
          break;
        }
        const match = line.match(/^description:\s*(.+)/);
        if (match?.[1]) {
          return match[1].trim().replace(/^["']|["']$/g, "");
        }
      }
    }

    return null;
  } catch {
    return null;
  }
}

function main() {
  const { output, registry, skillsDir, gcsBucket } = parseArgs();
  const rootPkg = readJson<PackageJson>(path.join(ROOT, "package.json"));
  const rootVersion = rootPkg?.version ?? "0.0.0";

  const extensionDirs = fs
    .readdirSync(EXTENSIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted();

  const plugins: CatalogPlugin[] = [];
  const skills: CatalogSkill[] = [];
  const seenSkillNames = new Set<string>();

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
            if (entry.isDirectory() && !seenSkillNames.has(entry.name)) {
              seenSkillNames.add(entry.name);
              const description =
                parseSkillDescription(path.join(skillDir, entry.name, "SKILL.md")) ??
                `Skill from ${pluginId}`;
              const archiveUrl = gcsBucket
                ? `gs://${gcsBucket}/skills/${entry.name}-${pkg.version}.tar.gz`
                : "";
              skills.push({
                name: entry.name,
                description,
                archiveUrl,
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

  // Scan standalone skills directory
  const resolvedSkillsDir = skillsDir ? path.resolve(skillsDir) : path.join(ROOT, "skills");

  if (fs.existsSync(resolvedSkillsDir)) {
    const skillDirs = fs
      .readdirSync(resolvedSkillsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .toSorted();

    for (const name of skillDirs) {
      if (seenSkillNames.has(name)) {
        continue;
      }
      const skillMdPath = path.join(resolvedSkillsDir, name, "SKILL.md");
      if (!fs.existsSync(skillMdPath)) {
        continue;
      }

      seenSkillNames.add(name);
      const description = parseSkillDescription(skillMdPath) ?? `Bundled skill: ${name}`;
      const archiveUrl = gcsBucket ? `gs://${gcsBucket}/skills/${name}-${rootVersion}.tar.gz` : "";

      skills.push({
        name,
        description,
        archiveUrl,
        version: rootVersion,
        tags: ["bundled"],
      });
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
