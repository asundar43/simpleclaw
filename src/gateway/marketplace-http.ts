import fs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { buildNpmInstallRecordFields } from "../cli/npm-resolution.js";
import { loadConfig, writeConfigFile } from "../config/config.js";
import { resolveGarAuthToken } from "../infra/gcloud-auth.js";
import { enablePluginInConfig } from "../plugins/enable.js";
import { installPluginFromNpmSpec } from "../plugins/install.js";
import { recordPluginInstall } from "../plugins/installs.js";
import { clearPluginManifestRegistryCache } from "../plugins/manifest-registry.js";
import { fetchCatalogWithAuth } from "../plugins/marketplace.js";
import { resolveRegistryAuth } from "../plugins/registry-auth.js";
import {
  installSkillFromArchiveUrl,
  recordSkillInstall,
  removeSkillInstall,
} from "../plugins/skill-install.js";
import { applyExclusiveSlotSelection } from "../plugins/slots.js";
import { buildPluginStatusReport } from "../plugins/status.js";
import { uninstallPlugin } from "../plugins/uninstall.js";
import { updateNpmInstalledPlugins } from "../plugins/update.js";
import { CONFIG_DIR } from "../utils.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import { authorizeHttpGatewayConnect, type ResolvedGatewayAuth } from "./auth.js";
import {
  readJsonBodyOrError,
  sendGatewayAuthFailure,
  sendInvalidRequest,
  sendJson,
  sendMethodNotAllowed,
} from "./http-common.js";
import { getBearerToken } from "./http-utils.js";

const MARKETPLACE_PREFIX = "/api/marketplace";
const MAX_BODY_BYTES = 64 * 1024;

export async function handleMarketplaceHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: {
    auth: ResolvedGatewayAuth;
    trustedProxies?: string[];
    allowRealIpFallback?: boolean;
    rateLimiter?: AuthRateLimiter;
  },
): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (!url.pathname.startsWith(MARKETPLACE_PREFIX)) {
    return false;
  }

  const cfg = loadConfig();
  const token = getBearerToken(req);
  const authResult = await authorizeHttpGatewayConnect({
    auth: opts.auth,
    connectAuth: token ? { token, password: token } : null,
    req,
    trustedProxies: opts.trustedProxies ?? cfg.gateway?.trustedProxies,
    allowRealIpFallback: opts.allowRealIpFallback ?? cfg.gateway?.allowRealIpFallback,
    rateLimiter: opts.rateLimiter,
  });
  if (!authResult.ok) {
    sendGatewayAuthFailure(res, authResult);
    return true;
  }

  const subPath = url.pathname.slice(MARKETPLACE_PREFIX.length);

  switch (subPath) {
    case "/installed":
      return handleInstalled(req, res);
    case "/install":
      return await handleInstall(req, res);
    case "/uninstall":
      return await handleUninstall(req, res);
    case "/sync":
      return await handleSync(req, res);
    default:
      return false;
  }
}

// ── GET /api/marketplace/installed ──────────────────────────

function handleInstalled(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method !== "GET") {
    sendMethodNotAllowed(res, "GET");
    return true;
  }

  const cfg = loadConfig();

  const plugins = Object.entries(cfg.plugins?.installs ?? {}).map(([id, record]) => ({
    id,
    type: "plugin" as const,
    source: record.source,
    version: record.resolvedVersion ?? record.version,
    spec: record.spec,
    installedAt: record.installedAt,
  }));

  const skills = Object.entries(cfg.skills?.installs ?? {}).map(([name, record]) => ({
    name,
    type: "skill" as const,
    source: record.source,
    version: record.version,
    installedAt: record.installedAt,
  }));

  sendJson(res, 200, { plugins, skills });
  return true;
}

// ── POST /api/marketplace/install ───────────────────────────

type InstallBody = {
  id?: unknown;
  type?: unknown;
};

async function handleInstall(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (req.method !== "POST") {
    sendMethodNotAllowed(res, "POST");
    return true;
  }

  const bodyUnknown = await readJsonBodyOrError(req, res, MAX_BODY_BYTES);
  if (bodyUnknown === undefined) {
    return true;
  }
  const body = (bodyUnknown ?? {}) as InstallBody;

  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!id) {
    sendInvalidRequest(res, "Missing 'id' in request body");
    return true;
  }

  const typeHint = typeof body.type === "string" ? body.type : undefined;

  const cfg = loadConfig();
  const registry = cfg.plugins?.registry;
  if (!registry?.catalogUrl) {
    sendJson(res, 500, { ok: false, error: "No marketplace catalog configured" });
    return true;
  }

  let catalog;
  try {
    catalog = await fetchCatalogWithAuth({
      catalogUrl: registry.catalogUrl,
      authMethod: registry.authMethod,
      authToken: registry.authToken,
    });
  } catch (err) {
    sendJson(res, 502, { ok: false, error: `Failed to fetch catalog: ${String(err)}` });
    return true;
  }

  const skillEntry = catalog.skills.find((s) => s.name === id);
  const pluginEntry = catalog.plugins.find((p) => p.id === id || p.npmSpec === id);

  if (typeHint === "skill" && skillEntry) {
    return await doInstallSkill(res, cfg, skillEntry);
  }
  if (typeHint === "plugin" && pluginEntry) {
    return await doInstallPlugin(res, cfg, catalog.registry, pluginEntry);
  }
  if (pluginEntry) {
    return await doInstallPlugin(res, cfg, catalog.registry, pluginEntry);
  }
  if (skillEntry) {
    return await doInstallSkill(res, cfg, skillEntry);
  }

  sendJson(res, 404, { ok: false, error: `"${id}" not found in catalog` });
  return true;
}

async function doInstallSkill(
  res: ServerResponse,
  cfg: ReturnType<typeof loadConfig>,
  entry: { name: string; archiveUrl: string; version: string },
): Promise<boolean> {
  if (!entry.archiveUrl) {
    sendJson(res, 400, { ok: false, error: `Skill "${entry.name}" has no archive URL` });
    return true;
  }

  const authToken = await resolveMarketplaceAuthToken(cfg);

  const result = await installSkillFromArchiveUrl({
    name: entry.name,
    archiveUrl: entry.archiveUrl,
    authToken: authToken ?? undefined,
  });

  if (!result.ok) {
    sendJson(res, 500, { ok: false, error: result.error });
    return true;
  }

  const next = recordSkillInstall(cfg, {
    skillName: entry.name,
    source: "marketplace",
    version: entry.version,
    archiveUrl: entry.archiveUrl,
  });
  await writeConfigFile(next);

  sendJson(res, 200, {
    ok: true,
    id: entry.name,
    type: "skill",
    version: entry.version,
  });
  return true;
}

async function doInstallPlugin(
  res: ServerResponse,
  cfg: ReturnType<typeof loadConfig>,
  catalogRegistry: string,
  entry: { id: string; name: string; npmSpec: string; version: string },
): Promise<boolean> {
  const registryAuth = await resolveRegistryAuth(cfg.plugins?.registry);
  const registryUrl = registryAuth?.registryUrl ?? catalogRegistry;

  const result = await installPluginFromNpmSpec({
    spec: entry.npmSpec,
    registryUrl,
    registryEnv: registryAuth?.registryEnv,
  });

  if (!result.ok) {
    sendJson(res, 500, { ok: false, error: result.error });
    return true;
  }

  clearPluginManifestRegistryCache();

  let next = enablePluginInConfig(cfg, result.pluginId).config;
  const installRecord = buildNpmInstallRecordFields({
    spec: entry.npmSpec,
    installPath: result.targetDir,
    version: result.version,
    resolution: result.npmResolution,
  });
  next = recordPluginInstall(next, { pluginId: result.pluginId, ...installRecord });

  const report = buildPluginStatusReport({ config: next });
  const plugin = report.plugins.find((p) => p.id === result.pluginId);
  if (plugin) {
    const slotResult = applyExclusiveSlotSelection({
      config: next,
      selectedId: plugin.id,
      selectedKind: plugin.kind,
      registry: report,
    });
    next = slotResult.config;
  }

  await writeConfigFile(next);

  sendJson(res, 200, {
    ok: true,
    id: result.pluginId,
    type: "plugin",
    version: result.version,
    restartRequired: true,
  });
  return true;
}

// ── POST /api/marketplace/uninstall ─────────────────────────

type UninstallBody = {
  id?: unknown;
  type?: unknown;
};

async function handleUninstall(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (req.method !== "POST") {
    sendMethodNotAllowed(res, "POST");
    return true;
  }

  const bodyUnknown = await readJsonBodyOrError(req, res, MAX_BODY_BYTES);
  if (bodyUnknown === undefined) {
    return true;
  }
  const body = (bodyUnknown ?? {}) as UninstallBody;

  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!id) {
    sendInvalidRequest(res, "Missing 'id' in request body");
    return true;
  }

  const type = typeof body.type === "string" ? body.type : undefined;
  if (type !== "plugin" && type !== "skill") {
    sendInvalidRequest(res, "Missing or invalid 'type' (must be 'plugin' or 'skill')");
    return true;
  }

  const cfg = loadConfig();

  if (type === "skill") {
    const record = cfg.skills?.installs?.[id];
    if (!record) {
      sendJson(res, 404, { ok: false, error: `Skill "${id}" is not installed` });
      return true;
    }

    const managedSkillsDir = path.join(CONFIG_DIR, "skills");
    await fs.rm(path.join(managedSkillsDir, id), { recursive: true, force: true });
    const next = removeSkillInstall(cfg, id);
    await writeConfigFile(next);

    sendJson(res, 200, { ok: true, id, type: "skill" });
    return true;
  }

  // Plugin uninstall
  const result = await uninstallPlugin({ config: cfg, pluginId: id });
  if (!result.ok) {
    sendJson(res, 404, { ok: false, error: result.error });
    return true;
  }

  await writeConfigFile(result.config);

  sendJson(res, 200, {
    ok: true,
    id,
    type: "plugin",
    restartRequired: true,
    warnings: result.warnings.length > 0 ? result.warnings : undefined,
  });
  return true;
}

// ── POST /api/marketplace/sync ──────────────────────────────

async function handleSync(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (req.method !== "POST") {
    sendMethodNotAllowed(res, "POST");
    return true;
  }

  const cfg = loadConfig();
  const registryAuth = await resolveRegistryAuth(cfg.plugins?.registry);
  const results: Array<{
    id: string;
    type: string;
    status: string;
    from?: string;
    to?: string;
    version?: string;
    error?: string;
  }> = [];

  // Plugin sync
  const pluginResult = await updateNpmInstalledPlugins({
    config: cfg,
    registryUrl: registryAuth?.registryUrl,
    registryEnv: registryAuth?.registryEnv,
  });

  for (const outcome of pluginResult.outcomes) {
    results.push({
      id: outcome.pluginId ?? "unknown",
      type: "plugin",
      status: outcome.status,
      from: outcome.currentVersion,
      to: outcome.nextVersion,
      error: outcome.status === "error" ? outcome.message : undefined,
    });
  }

  let next = pluginResult.config;
  let changed = pluginResult.changed;

  // Skill sync
  const skillInstalls = cfg.skills?.installs ?? {};
  const marketplaceSkills = Object.entries(skillInstalls).filter(
    ([, record]) => record.source === "marketplace",
  );

  if (marketplaceSkills.length > 0) {
    const registry = cfg.plugins?.registry;
    if (registry?.catalogUrl) {
      try {
        const catalog = await fetchCatalogWithAuth({
          catalogUrl: registry.catalogUrl,
          authMethod: registry.authMethod,
          authToken: registry.authToken,
        });
        const authToken = await resolveMarketplaceAuthToken(cfg);

        for (const [skillName, record] of marketplaceSkills) {
          const catalogEntry = catalog.skills.find((s) => s.name === skillName);
          if (!catalogEntry) {
            results.push({
              id: skillName,
              type: "skill",
              status: "skipped",
              version: record.version,
              error: "No longer in catalog",
            });
            continue;
          }

          if (record.version === catalogEntry.version) {
            results.push({
              id: skillName,
              type: "skill",
              status: "unchanged",
              version: record.version,
            });
            continue;
          }

          if (!catalogEntry.archiveUrl) {
            results.push({
              id: skillName,
              type: "skill",
              status: "skipped",
              version: record.version,
              error: "No archive URL",
            });
            continue;
          }

          const installResult = await installSkillFromArchiveUrl({
            name: skillName,
            archiveUrl: catalogEntry.archiveUrl,
            authToken: authToken ?? undefined,
          });

          if (!installResult.ok) {
            results.push({
              id: skillName,
              type: "skill",
              status: "error",
              from: record.version,
              error: installResult.error,
            });
            continue;
          }

          next = recordSkillInstall(next, {
            skillName,
            source: "marketplace",
            version: catalogEntry.version,
            archiveUrl: catalogEntry.archiveUrl,
          });
          changed = true;
          results.push({
            id: skillName,
            type: "skill",
            status: "updated",
            from: record.version,
            to: catalogEntry.version,
          });
        }
      } catch (err) {
        results.push({
          id: "*",
          type: "skill",
          status: "error",
          error: `Failed to fetch catalog: ${String(err)}`,
        });
      }
    }
  }

  if (changed) {
    await writeConfigFile(next);
  }

  sendJson(res, 200, {
    ok: true,
    changed,
    results,
  });
  return true;
}

// ── Helpers ─────────────────────────────────────────────────

async function resolveMarketplaceAuthToken(
  cfg: ReturnType<typeof loadConfig>,
): Promise<string | null> {
  const registry = cfg.plugins?.registry;
  if (registry?.authMethod === "gcloud-adc") {
    return await resolveGarAuthToken();
  }
  if (registry?.authMethod === "token" && registry.authToken) {
    return registry.authToken;
  }
  return null;
}
