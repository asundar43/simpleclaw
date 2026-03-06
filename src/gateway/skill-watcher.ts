/**
 * Skill Watcher Service
 *
 * Spawns long-running watch commands declared in skill frontmatter,
 * reads NDJSON events from stdout, and POSTs them to the local hook
 * endpoint for dispatch to agents.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { SkillWatchEntry } from "../agents/skills/types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("skill-watcher");

const RESTART_DELAY_MS = 5_000;

export type SkillWatcherHookConfig = {
  port: number;
  hooksBasePath: string;
  token: string;
  bindHost?: string;
};

type WatcherState = {
  entry: SkillWatchEntry;
  hookConfig: SkillWatcherHookConfig;
  process: ChildProcess | null;
  shuttingDown: boolean;
  restartTimer: ReturnType<typeof setTimeout> | null;
};

const watchers = new Map<string, WatcherState>();

function buildHookUrl(cfg: SkillWatcherHookConfig, hookPath: string): string {
  const host = cfg.bindHost || "127.0.0.1";
  const base = cfg.hooksBasePath.replace(/\/+$/, "");
  return `http://${host}:${cfg.port}${base}/${hookPath}`;
}

function spawnWatchProcess(state: WatcherState): ChildProcess {
  const { entry, hookConfig } = state;
  const [cmd, ...args] = entry.command;
  const url = buildHookUrl(hookConfig, entry.hookPath);

  log.info(`[${entry.id}] starting: ${entry.command.join(" ")}`);

  const env = entry.env ? { ...process.env, ...entry.env } : undefined;
  const child = spawn(cmd, args, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
    env,
  });

  // Read NDJSON lines from stdout
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(trimmed);
    } catch {
      log.debug(`[${entry.id}] non-JSON stdout: ${trimmed.slice(0, 200)}`);
      return;
    }

    // Fire-and-forget POST to the local hook endpoint
    void postToHook(url, hookConfig.token, payload as Record<string, unknown>, entry.id);
  });

  child.stderr?.on("data", (data: Buffer) => {
    const line = data.toString().trim();
    if (line) {
      log.warn(`[${entry.id}] ${line}`);
    }
  });

  child.on("error", (err) => {
    log.error(`[${entry.id}] process error: ${String(err)}`);
  });

  child.on("exit", (code, signal) => {
    if (state.shuttingDown) {
      return;
    }
    log.warn(
      `[${entry.id}] exited (code=${code}, signal=${signal}); restarting in ${RESTART_DELAY_MS}ms`,
    );
    state.process = null;
    state.restartTimer = setTimeout(() => {
      state.restartTimer = null;
      if (state.shuttingDown) {
        return;
      }
      state.process = spawnWatchProcess(state);
    }, RESTART_DELAY_MS);
  });

  return child;
}

async function postToHook(
  url: string,
  token: string,
  payload: Record<string, unknown>,
  watcherId: string,
): Promise<void> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      log.warn(
        `[${watcherId}] hook POST ${response.status}: ${await response.text().catch(() => "")}`,
      );
    }
  } catch (err) {
    log.warn(`[${watcherId}] hook POST failed: ${String(err)}`);
  }
}

/**
 * Start a skill watcher for a single watch entry.
 */
export function startSkillWatcher(
  entry: SkillWatchEntry,
  hookConfig: SkillWatcherHookConfig,
): void {
  if (watchers.has(entry.id)) {
    log.warn(`[${entry.id}] watcher already running, skipping`);
    return;
  }

  const state: WatcherState = {
    entry,
    hookConfig,
    process: null,
    shuttingDown: false,
    restartTimer: null,
  };

  state.process = spawnWatchProcess(state);
  watchers.set(entry.id, state);
  log.info(`[${entry.id}] watcher started (hook: ${entry.hookPath})`);
}

/**
 * Stop a specific skill watcher by ID.
 */
export async function stopSkillWatcher(id: string): Promise<void> {
  const state = watchers.get(id);
  if (!state) {
    return;
  }

  state.shuttingDown = true;
  if (state.restartTimer) {
    clearTimeout(state.restartTimer);
    state.restartTimer = null;
  }

  if (state.process) {
    log.info(`[${id}] stopping watcher`);
    state.process.kill("SIGTERM");

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (state.process) {
          state.process.kill("SIGKILL");
        }
        resolve();
      }, 3000);

      state.process?.on("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    state.process = null;
  }

  watchers.delete(id);
  log.info(`[${id}] watcher stopped`);
}

/**
 * Stop all running skill watchers.
 */
export async function stopAllSkillWatchers(): Promise<void> {
  const ids = Array.from(watchers.keys());
  await Promise.all(ids.map((id) => stopSkillWatcher(id)));
}

/**
 * Check if a specific skill watcher is running.
 */
export function isSkillWatcherRunning(id: string): boolean {
  const state = watchers.get(id);
  return state !== null && state !== undefined && !state.shuttingDown && state.process !== null;
}

/**
 * Get the IDs of all running skill watchers.
 */
export function getRunningSkillWatcherIds(): string[] {
  return Array.from(watchers.entries())
    .filter(([, state]) => !state.shuttingDown && state.process !== null)
    .map(([id]) => id);
}
