/**
 * Gmail Watcher Service
 *
 * Automatically starts `gwsc gmail +watch` when the gateway starts,
 * if hooks.gmail is configured with an account.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { hasBinary } from "../agents/skills.js";
import type { SimpleClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { ensureTailscaleEndpoint } from "./gmail-setup-utils.js";
import {
  buildGwscWatchArgs,
  type GmailHookRuntimeConfig,
  resolveGmailHookRuntimeConfig,
} from "./gmail.js";

const log = createSubsystemLogger("gmail-watcher");

const ADDRESS_IN_USE_RE = /address already in use|EADDRINUSE/i;

export function isAddressInUseError(line: string): boolean {
  return ADDRESS_IN_USE_RE.test(line);
}

let watcherProcess: ChildProcess | null = null;
let renewInterval: ReturnType<typeof setInterval> | null = null;
let shuttingDown = false;
let currentConfig: GmailHookRuntimeConfig | null = null;

/**
 * Check if gwsc binary is available
 */
function isGwscAvailable(): boolean {
  return hasBinary("gwsc");
}

/**
 * Spawn the gwsc gmail +watch process
 */
function spawnGwscWatch(cfg: GmailHookRuntimeConfig): ChildProcess {
  const args = buildGwscWatchArgs(cfg);
  log.info(`starting gwsc ${args.join(" ")}`);
  let addressInUse = false;

  const child = spawn("gwsc", args, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });

  child.stdout?.on("data", (data: Buffer) => {
    const line = data.toString().trim();
    if (line) {
      log.info(`[gwsc] ${line}`);
    }
  });

  child.stderr?.on("data", (data: Buffer) => {
    const line = data.toString().trim();
    if (!line) {
      return;
    }
    if (isAddressInUseError(line)) {
      addressInUse = true;
    }
    log.warn(`[gwsc] ${line}`);
  });

  child.on("error", (err) => {
    log.error(`gwsc process error: ${String(err)}`);
  });

  child.on("exit", (code, signal) => {
    if (shuttingDown) {
      return;
    }
    if (addressInUse) {
      log.warn(
        "gwsc watch failed to bind (address already in use); stopping restarts. " +
          "Another watcher is likely running. Set SIMPLECLAW_SKIP_GMAIL_WATCHER=1 or stop the other process.",
      );
      watcherProcess = null;
      return;
    }
    log.warn(`gwsc exited (code=${code}, signal=${signal}); restarting in 5s`);
    watcherProcess = null;
    setTimeout(() => {
      if (shuttingDown || !currentConfig) {
        return;
      }
      watcherProcess = spawnGwscWatch(currentConfig);
    }, 5000);
  });

  return child;
}

export type GmailWatcherStartResult = {
  started: boolean;
  reason?: string;
};

/**
 * Start the Gmail watcher service.
 * Called automatically by the gateway if hooks.gmail is configured.
 */
export async function startGmailWatcher(cfg: SimpleClawConfig): Promise<GmailWatcherStartResult> {
  // Check if gmail hooks are configured
  if (!cfg.hooks?.enabled) {
    return { started: false, reason: "hooks not enabled" };
  }

  if (!cfg.hooks?.gmail?.account) {
    return { started: false, reason: "no gmail account configured" };
  }

  // Check if gwsc is available
  const gwscAvailable = isGwscAvailable();
  if (!gwscAvailable) {
    return {
      started: false,
      reason: "gwsc not found; run: simpleclaw marketplace install google-workspace",
    };
  }

  // Resolve the full runtime config
  const resolved = resolveGmailHookRuntimeConfig(cfg, {});
  if (!resolved.ok) {
    return { started: false, reason: resolved.error };
  }

  const runtimeConfig = resolved.value;
  currentConfig = runtimeConfig;

  // Set up Tailscale endpoint if needed
  if (runtimeConfig.tailscale.mode !== "off") {
    try {
      await ensureTailscaleEndpoint({
        mode: runtimeConfig.tailscale.mode,
        path: runtimeConfig.tailscale.path,
        port: runtimeConfig.serve.port,
        target: runtimeConfig.tailscale.target,
      });
      log.info(
        `tailscale ${runtimeConfig.tailscale.mode} configured for port ${runtimeConfig.serve.port}`,
      );
    } catch (err) {
      log.error(`tailscale setup failed: ${String(err)}`);
      return {
        started: false,
        reason: `tailscale setup failed: ${String(err)}`,
      };
    }
  }

  // Spawn the gwsc +watch process (handles registration + listening)
  shuttingDown = false;
  watcherProcess = spawnGwscWatch(runtimeConfig);

  // Set up renewal interval — restart the +watch process to re-register
  const renewMs = runtimeConfig.renewEveryMinutes * 60_000;
  renewInterval = setInterval(() => {
    if (shuttingDown || !watcherProcess) {
      return;
    }
    log.info("renewing gmail watch (restarting gwsc)");
    watcherProcess.kill("SIGTERM");
    // The 'exit' handler will respawn
  }, renewMs);

  log.info(
    `gmail watcher started for ${runtimeConfig.account} (renew every ${runtimeConfig.renewEveryMinutes}m)`,
  );

  return { started: true };
}

/**
 * Stop the Gmail watcher service.
 */
export async function stopGmailWatcher(): Promise<void> {
  shuttingDown = true;

  if (renewInterval) {
    clearInterval(renewInterval);
    renewInterval = null;
  }

  if (watcherProcess) {
    log.info("stopping gmail watcher");
    watcherProcess.kill("SIGTERM");

    // Wait a bit for graceful shutdown
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (watcherProcess) {
          watcherProcess.kill("SIGKILL");
        }
        resolve();
      }, 3000);

      watcherProcess?.on("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    watcherProcess = null;
  }

  currentConfig = null;
  log.info("gmail watcher stopped");
}

/**
 * Check if the Gmail watcher is running.
 */
export function isGmailWatcherRunning(): boolean {
  return watcherProcess !== null && !shuttingDown;
}
