import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SimpleClawConfig } from "../config/config.js";
import type { SkillInstallRecord } from "../config/types.skills.js";
import { extractArchive } from "../infra/archive.js";
import { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
import { CONFIG_DIR, ensureDir } from "../utils.js";

// ── Types ────────────────────────────────────────────────────

export type SkillInstallLogger = {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
};

export type SkillInstallSuccess = {
  ok: true;
  skillName: string;
  targetDir: string;
};

export type SkillInstallFailure = {
  ok: false;
  error: string;
};

export type SkillInstallResult = SkillInstallSuccess | SkillInstallFailure;

// ── Helpers ──────────────────────────────────────────────────

const DOWNLOAD_TIMEOUT_MS = 60_000;
const EXTRACT_TIMEOUT_MS = 30_000;

/** Convert gs:// URLs to GCS HTTPS URLs for direct fetch. */
function resolveGcsUrl(url: string): string {
  if (!url.startsWith("gs://")) {
    return url;
  }
  const withoutScheme = url.slice("gs://".length);
  return `https://storage.googleapis.com/${withoutScheme}`;
}

/** Validate skill name to prevent path traversal. */
function validateSkillName(name: string): void {
  if (!name || name.includes("/") || name.includes("\\") || name === "." || name === "..") {
    throw new Error(`Invalid skill name: "${name}"`);
  }
  if (name.startsWith(".")) {
    throw new Error(`Skill name cannot start with a dot: "${name}"`);
  }
}

// ── Core install function ────────────────────────────────────

/**
 * Download a skill archive from a URL (GCS or HTTPS) and extract to the
 * managed skills directory (~/.simpleclaw/skills/<name>/).
 */
export async function installSkillFromArchiveUrl(params: {
  name: string;
  archiveUrl: string;
  managedSkillsDir?: string;
  authToken?: string;
  logger?: SkillInstallLogger;
}): Promise<SkillInstallResult> {
  const { name, archiveUrl, logger } = params;

  try {
    validateSkillName(name);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const managedSkillsDir = params.managedSkillsDir ?? path.join(CONFIG_DIR, "skills");
  const targetDir = path.join(managedSkillsDir, name);
  const url = resolveGcsUrl(archiveUrl);

  // Create a temp directory for download + extraction
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `simpleclaw-skill-${name}-`));

  try {
    // Download the archive
    logger?.info?.(`Downloading ${url}…`);
    const archivePath = path.join(tmpDir, `${name}.tar.gz`);
    const init: RequestInit = {};
    if (params.authToken) {
      init.headers = { Authorization: `Bearer ${params.authToken}` };
    }

    const { response, release } = await fetchWithSsrFGuard({
      url,
      init,
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
    });

    try {
      if (!response.ok) {
        return {
          ok: false,
          error: `Download failed: ${response.status} ${response.statusText}`,
        };
      }

      const arrayBuffer = await response.arrayBuffer();
      await fs.writeFile(archivePath, Buffer.from(arrayBuffer));
    } finally {
      await release();
    }

    // Extract to a staging directory
    const extractDir = path.join(tmpDir, "extracted");
    await ensureDir(extractDir);

    logger?.info?.("Extracting…");
    await extractArchive({
      archivePath,
      destDir: extractDir,
      timeoutMs: EXTRACT_TIMEOUT_MS,
      kind: "tar",
      tarGzip: true,
      stripComponents: 1,
    });

    // Validate that SKILL.md exists
    const skillMdPath = path.join(extractDir, "SKILL.md");
    try {
      await fs.stat(skillMdPath);
    } catch {
      return {
        ok: false,
        error: `Archive does not contain a SKILL.md file. Not a valid skill package.`,
      };
    }

    // Move to target (remove existing first)
    await fs.rm(targetDir, { recursive: true, force: true });
    await ensureDir(managedSkillsDir);
    await fs.cp(extractDir, targetDir, { recursive: true });

    return { ok: true, skillName: name, targetDir };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  } finally {
    // Clean up temp directory
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ── Config helpers ───────────────────────────────────────────

/**
 * Record a skill install in the config (immutable update).
 */
export function recordSkillInstall(
  cfg: SimpleClawConfig,
  params: { skillName: string } & SkillInstallRecord,
): SimpleClawConfig {
  const { skillName, ...record } = params;
  return {
    ...cfg,
    skills: {
      ...cfg.skills,
      installs: {
        ...cfg.skills?.installs,
        [skillName]: {
          ...record,
          installedAt: record.installedAt ?? new Date().toISOString(),
        },
      },
    },
  };
}

/**
 * Remove a skill install record from the config (immutable update).
 */
export function removeSkillInstall(cfg: SimpleClawConfig, skillName: string): SimpleClawConfig {
  const installs = { ...cfg.skills?.installs };
  delete installs[skillName];
  return {
    ...cfg,
    skills: {
      ...cfg.skills,
      installs: Object.keys(installs).length > 0 ? installs : undefined,
    },
  };
}
