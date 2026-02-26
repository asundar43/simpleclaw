import type { SimpleClawConfig } from "../config/config.js";
import type { HookInstallRecord } from "../config/types.hooks.js";

export type HookInstallUpdate = HookInstallRecord & { hookId: string };

export function recordHookInstall(
  cfg: SimpleClawConfig,
  update: HookInstallUpdate,
): SimpleClawConfig {
  const { hookId, ...record } = update;
  const installs = {
    ...cfg.hooks?.internal?.installs,
    [hookId]: {
      ...cfg.hooks?.internal?.installs?.[hookId],
      ...record,
      installedAt: record.installedAt ?? new Date().toISOString(),
    },
  };

  return {
    ...cfg,
    hooks: {
      ...cfg.hooks,
      internal: {
        ...cfg.hooks?.internal,
        installs: {
          ...installs,
          [hookId]: installs[hookId],
        },
      },
    },
  };
}
