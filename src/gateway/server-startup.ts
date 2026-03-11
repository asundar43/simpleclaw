import { resolveAgentSessionDirs } from "../agents/session-dirs.js";
import { cleanStaleLockFiles } from "../agents/session-write-lock.js";
import { shouldIncludeSkill } from "../agents/skills/config.js";
import { loadWorkspaceSkillEntries } from "../agents/skills/workspace.js";
import type { CliDeps } from "../cli/deps.js";
import type { loadConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import {
  clearInternalHooks,
  createInternalHookEvent,
  triggerInternalHook,
} from "../hooks/internal-hooks.js";
import { loadInternalHooks } from "../hooks/loader.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { getSkillEligibilityContext } from "../infra/skills-remote.js";
import type { loadSimpleClawPlugins } from "../plugins/loader.js";
import { type PluginServicesHandle, startPluginServices } from "../plugins/services.js";
import type { HookMappingResolved } from "./hooks-mapping.js";
import { startBrowserControlServerIfEnabled } from "./server-browser.js";
import {
  scheduleRestartSentinelWake,
  shouldWakeFromRestartSentinel,
} from "./server-restart-sentinel.js";
import { startGatewayMemoryBackend } from "./server-startup-memory.js";
import { buildSkillWatchMappings } from "./skill-watcher-mappings.js";
import { type SkillWatcherHookConfig, startSkillWatcher } from "./skill-watcher.js";

const SESSION_LOCK_STALE_MS = 30 * 60 * 1000;

export async function startGatewaySidecars(params: {
  cfg: ReturnType<typeof loadConfig>;
  pluginRegistry: ReturnType<typeof loadSimpleClawPlugins>;
  defaultWorkspaceDir: string;
  deps: CliDeps;
  startChannels: () => Promise<void>;
  /** Hook endpoint config for skill watchers (omit to skip skill watchers). */
  skillWatcherHookConfig?: SkillWatcherHookConfig;
  log: { warn: (msg: string) => void };
  logHooks: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
  logChannels: { info: (msg: string) => void; error: (msg: string) => void };
  logBrowser: { error: (msg: string) => void };
}) {
  try {
    const stateDir = resolveStateDir(process.env);
    const sessionDirs = await resolveAgentSessionDirs(stateDir);
    for (const sessionsDir of sessionDirs) {
      await cleanStaleLockFiles({
        sessionsDir,
        staleMs: SESSION_LOCK_STALE_MS,
        removeStale: true,
        log: { warn: (message) => params.log.warn(message) },
      });
    }
  } catch (err) {
    params.log.warn(`session lock cleanup failed on startup: ${String(err)}`);
  }

  // Start SimpleClaw browser control server (unless disabled via config).
  let browserControl: Awaited<ReturnType<typeof startBrowserControlServerIfEnabled>> = null;
  try {
    browserControl = await startBrowserControlServerIfEnabled();
  } catch (err) {
    params.logBrowser.error(`server failed to start: ${String(err)}`);
  }

  // Load internal hook handlers from configuration and directory discovery.
  try {
    // Clear any previously registered hooks to ensure fresh loading
    clearInternalHooks();
    const loadedCount = await loadInternalHooks(params.cfg, params.defaultWorkspaceDir);
    if (loadedCount > 0) {
      params.logHooks.info(
        `loaded ${loadedCount} internal hook handler${loadedCount > 1 ? "s" : ""}`,
      );
    }
  } catch (err) {
    params.logHooks.error(`failed to load hooks: ${String(err)}`);
  }

  // Launch configured channels so gateway replies via the surface the message came from.
  // Tests can opt out via SIMPLECLAW_SKIP_CHANNELS (or legacy SIMPLECLAW_SKIP_PROVIDERS).
  const skipChannels =
    isTruthyEnvValue(process.env.SIMPLECLAW_SKIP_CHANNELS) ||
    isTruthyEnvValue(process.env.SIMPLECLAW_SKIP_PROVIDERS);
  if (!skipChannels) {
    try {
      await params.startChannels();
    } catch (err) {
      params.logChannels.error(`channel startup failed: ${String(err)}`);
    }
  } else {
    params.logChannels.info(
      "skipping channel start (SIMPLECLAW_SKIP_CHANNELS=1 or SIMPLECLAW_SKIP_PROVIDERS=1)",
    );
  }

  if (params.cfg.hooks?.internal?.enabled) {
    setTimeout(() => {
      const hookEvent = createInternalHookEvent("gateway", "startup", "gateway:startup", {
        cfg: params.cfg,
        deps: params.deps,
        workspaceDir: params.defaultWorkspaceDir,
      });
      void triggerInternalHook(hookEvent);
    }, 250);
  }

  let pluginServices: PluginServicesHandle | null = null;
  try {
    pluginServices = await startPluginServices({
      registry: params.pluginRegistry,
      config: params.cfg,
      workspaceDir: params.defaultWorkspaceDir,
    });
  } catch (err) {
    params.log.warn(`plugin services failed to start: ${String(err)}`);
  }

  void startGatewayMemoryBackend({ cfg: params.cfg, log: params.log }).catch((err) => {
    params.log.warn(`qmd memory startup initialization failed: ${String(err)}`);
  });

  if (shouldWakeFromRestartSentinel()) {
    setTimeout(() => {
      void scheduleRestartSentinelWake({ deps: params.deps });
    }, 750);
  }

  // Start skill watchers for skills with watch entries.
  let skillWatchMappings: HookMappingResolved[] = [];
  if (params.skillWatcherHookConfig) {
    try {
      const skillEntries = loadWorkspaceSkillEntries(params.defaultWorkspaceDir, {
        config: params.cfg,
      });
      const eligibility = getSkillEligibilityContext();
      const eligibleEntries = skillEntries.filter((entry) => {
        if (!entry.metadata?.watch?.length) {
          return false;
        }
        const eligible = shouldIncludeSkill({ entry, config: params.cfg, eligibility });
        if (!eligible) {
          params.log.warn(
            `skipping watchers for skill "${entry.skill.name}": requirements not met (check connections/config)`,
          );
        }
        return eligible;
      });
      const allWatchEntries = eligibleEntries.flatMap((entry) => entry.metadata?.watch ?? []);
      if (allWatchEntries.length > 0) {
        skillWatchMappings = buildSkillWatchMappings(allWatchEntries);
        for (const watchEntry of allWatchEntries) {
          startSkillWatcher(watchEntry, params.skillWatcherHookConfig);
        }
        params.logHooks.info(
          `started ${allWatchEntries.length} skill watcher${allWatchEntries.length > 1 ? "s" : ""}`,
        );
      }
    } catch (err) {
      params.log.warn(`skill watcher startup failed: ${String(err)}`);
    }
  }

  return { browserControl, pluginServices, skillWatchMappings };
}
