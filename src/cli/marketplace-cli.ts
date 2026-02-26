import type { Command } from "commander";
import { loadConfig, writeConfigFile } from "../config/config.js";
import { enablePluginInConfig } from "../plugins/enable.js";
import { installPluginFromNpmSpec } from "../plugins/install.js";
import { recordPluginInstall } from "../plugins/installs.js";
import { clearPluginManifestRegistryCache } from "../plugins/manifest-registry.js";
import {
  type MarketplacePluginEntry,
  type MarketplaceSkillEntry,
  fetchCatalogWithAuth,
  searchCatalog,
} from "../plugins/marketplace.js";
import { resolveRegistryAuth } from "../plugins/registry-auth.js";
import { applyExclusiveSlotSelection } from "../plugins/slots.js";
import { buildPluginStatusReport } from "../plugins/status.js";
import { updateNpmInstalledPlugins } from "../plugins/update.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { defaultRuntime } from "../runtime.js";
import { renderTable } from "../terminal/table.js";
import { theme } from "../terminal/theme.js";
import { resolvePinnedNpmInstallRecordForCli } from "./npm-resolution.js";

function formatPluginKind(kind: string): string {
  switch (kind) {
    case "channel":
      return theme.success(kind);
    case "tool":
      return theme.command(kind);
    case "memory":
      return theme.warn(kind);
    case "provider":
      return theme.muted(kind);
    default:
      return kind;
  }
}

async function loadCatalog() {
  const cfg = loadConfig();
  const registry = cfg.plugins?.registry;
  if (!registry?.catalogUrl) {
    defaultRuntime.error(
      "No marketplace catalog configured. Set plugins.registry.catalogUrl in your SimpleClaw config.",
    );
    process.exit(1);
  }
  return await fetchCatalogWithAuth({
    catalogUrl: registry.catalogUrl,
    authMethod: registry.authMethod,
    authToken: registry.authToken,
  });
}

export function registerMarketplaceCli(program: Command) {
  const marketplace = program
    .command("marketplace")
    .description("Browse and install plugins from the private marketplace catalog");

  // ── list ────────────────────────────────────────────────────

  marketplace
    .command("list")
    .description("List all available plugins and skills in the catalog")
    .option("--json", "Print raw JSON catalog")
    .option("--plugins-only", "Show only plugins", false)
    .option("--skills-only", "Show only skills", false)
    .action(async (opts: { json?: boolean; pluginsOnly?: boolean; skillsOnly?: boolean }) => {
      const catalog = await loadCatalog();

      if (opts.json) {
        defaultRuntime.log(JSON.stringify(catalog, null, 2));
        return;
      }

      defaultRuntime.log(
        `${theme.heading("Marketplace Catalog")} ${theme.muted(`(updated ${catalog.updatedAt})`)}`,
      );
      defaultRuntime.log("");

      if (!opts.skillsOnly && catalog.plugins.length > 0) {
        printPluginTable(catalog.plugins);
      }

      if (!opts.pluginsOnly && catalog.skills.length > 0) {
        if (!opts.skillsOnly) {
          defaultRuntime.log("");
        }
        printSkillTable(catalog.skills);
      }

      if (catalog.plugins.length === 0 && catalog.skills.length === 0) {
        defaultRuntime.log(theme.muted("Catalog is empty."));
      }
    });

  // ── search ──────────────────────────────────────────────────

  marketplace
    .command("search")
    .description("Search the catalog for plugins and skills")
    .argument("<query>", "Search term")
    .action(async (query: string) => {
      const catalog = await loadCatalog();
      const results = searchCatalog(catalog, query);

      if (results.plugins.length === 0 && results.skills.length === 0) {
        defaultRuntime.log(theme.muted(`No results for "${query}".`));
        return;
      }

      if (results.plugins.length > 0) {
        defaultRuntime.log(theme.heading("Plugins"));
        printPluginTable(results.plugins);
      }
      if (results.skills.length > 0) {
        if (results.plugins.length > 0) {
          defaultRuntime.log("");
        }
        defaultRuntime.log(theme.heading("Skills"));
        printSkillTable(results.skills);
      }
    });

  // ── install ─────────────────────────────────────────────────

  marketplace
    .command("install")
    .description("Install a plugin from the marketplace catalog")
    .argument("<id>", "Plugin ID from the catalog")
    .option("--pin", "Record install as exact resolved version", false)
    .action(async (id: string, opts: { pin?: boolean }) => {
      const catalog = await loadCatalog();
      const entry = catalog.plugins.find((p) => p.id === id || p.npmSpec === id);
      if (!entry) {
        defaultRuntime.error(`Plugin "${id}" not found in the catalog.`);
        process.exit(1);
      }

      const cfg = loadConfig();
      const registryAuth = await resolveRegistryAuth(cfg.plugins?.registry);
      // Use the catalog's registry if no per-config registry is set
      const registryUrl = registryAuth?.registryUrl ?? catalog.registry;

      defaultRuntime.log(`Installing ${theme.command(entry.name)} (${entry.npmSpec})…`);

      const result = await installPluginFromNpmSpec({
        spec: entry.npmSpec,
        logger: {
          info: (msg) => defaultRuntime.log(msg),
          warn: (msg) => defaultRuntime.log(theme.warn(msg)),
        },
        registryUrl,
        registryEnv: registryAuth?.registryEnv,
      });

      if (!result.ok) {
        defaultRuntime.error(result.error);
        process.exit(1);
      }

      clearPluginManifestRegistryCache();

      let next = enablePluginInConfig(cfg, result.pluginId).config;
      const installRecord = resolvePinnedNpmInstallRecordForCli(
        entry.npmSpec,
        Boolean(opts.pin),
        result.targetDir,
        result.version,
        result.npmResolution,
        defaultRuntime.log,
        theme.warn,
      );
      next = recordPluginInstall(next, {
        pluginId: result.pluginId,
        ...installRecord,
      });

      // Handle exclusive slots (e.g., memory plugins)
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
        for (const w of slotResult.warnings) {
          defaultRuntime.log(theme.warn(w));
        }
      }

      await writeConfigFile(next);
      defaultRuntime.log(`Installed plugin: ${result.pluginId}`);
      defaultRuntime.log("Restart the gateway to load plugins.");
    });

  // ── sync ────────────────────────────────────────────────────

  marketplace
    .command("sync")
    .description("Update all installed plugins to the latest catalog versions")
    .option("--dry-run", "Show what would change without writing", false)
    .action(async (opts: { dryRun?: boolean }) => {
      const cfg = loadConfig();
      const registryAuth = await resolveRegistryAuth(cfg.plugins?.registry);

      const result = await updateNpmInstalledPlugins({
        config: cfg,
        dryRun: opts.dryRun,
        registryUrl: registryAuth?.registryUrl,
        registryEnv: registryAuth?.registryEnv,
        logger: {
          info: (msg) => defaultRuntime.log(msg),
          warn: (msg) => defaultRuntime.log(theme.warn(msg)),
        },
      });

      for (const outcome of result.outcomes) {
        if (outcome.status === "error") {
          defaultRuntime.log(theme.error(outcome.message));
          continue;
        }
        if (outcome.status === "skipped") {
          defaultRuntime.log(theme.warn(outcome.message));
          continue;
        }
        defaultRuntime.log(outcome.message);
      }

      if (!opts.dryRun && result.changed) {
        await writeConfigFile(result.config);
        defaultRuntime.log("Restart the gateway to load plugins.");
      }
    });

  // ── publish ─────────────────────────────────────────────────

  marketplace
    .command("publish")
    .description("Publish a local plugin to the private registry")
    .argument("<dir>", "Path to the plugin directory")
    .action(async (dir: string) => {
      const cfg = loadConfig();
      const registry = cfg.plugins?.registry;
      if (!registry?.npmRegistry) {
        defaultRuntime.error(
          "No private registry configured. Set plugins.registry.npmRegistry in your SimpleClaw config.",
        );
        process.exit(1);
      }

      defaultRuntime.log(`Publishing from ${dir} to ${registry.npmRegistry}…`);

      const result = await runCommandWithTimeout(
        ["npm", "publish", "--registry", registry.npmRegistry, "--access", "public"],
        { timeoutMs: 120_000, cwd: dir },
      );

      if (result.code !== 0) {
        defaultRuntime.error(`npm publish failed:\n${result.stderr || result.stdout}`);
        process.exit(1);
      }

      defaultRuntime.log(theme.success("Published successfully."));
      if (result.stdout.trim()) {
        defaultRuntime.log(result.stdout.trim());
      }
    });
}

// ── Display helpers ──────────────────────────────────────────

function printPluginTable(plugins: MarketplacePluginEntry[]) {
  const tableWidth = Math.max(60, (process.stdout.columns ?? 120) - 1);
  const rows = plugins.map((p) => ({
    ID: p.id,
    Name: p.name,
    Version: p.version,
    Kind: formatPluginKind(p.kind),
    Description: theme.muted(p.description),
  }));

  defaultRuntime.log(`${theme.heading("Plugins")} ${theme.muted(`(${plugins.length})`)}`);
  defaultRuntime.log(
    renderTable({
      width: tableWidth,
      columns: [
        { key: "ID", header: "ID", minWidth: 14, flex: true },
        { key: "Name", header: "Name", minWidth: 14, flex: true },
        { key: "Version", header: "Ver", minWidth: 8 },
        { key: "Kind", header: "Kind", minWidth: 8 },
        { key: "Description", header: "Description", minWidth: 20, flex: true },
      ],
      rows,
    }).trimEnd(),
  );
}

function printSkillTable(skills: MarketplaceSkillEntry[]) {
  const tableWidth = Math.max(60, (process.stdout.columns ?? 120) - 1);
  const rows = skills.map((s) => ({
    Name: s.name,
    Version: s.version,
    Description: theme.muted(s.description),
  }));

  defaultRuntime.log(`${theme.heading("Skills")} ${theme.muted(`(${skills.length})`)}`);
  defaultRuntime.log(
    renderTable({
      width: tableWidth,
      columns: [
        { key: "Name", header: "Name", minWidth: 14, flex: true },
        { key: "Version", header: "Ver", minWidth: 8 },
        { key: "Description", header: "Description", minWidth: 30, flex: true },
      ],
      rows,
    }).trimEnd(),
  );
}
