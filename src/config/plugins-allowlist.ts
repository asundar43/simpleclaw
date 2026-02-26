import type { SimpleClawConfig } from "./config.js";

export function ensurePluginAllowlisted(cfg: SimpleClawConfig, pluginId: string): SimpleClawConfig {
  const allow = cfg.plugins?.allow;
  if (!Array.isArray(allow) || allow.includes(pluginId)) {
    return cfg;
  }
  return {
    ...cfg,
    plugins: {
      ...cfg.plugins,
      allow: [...allow, pluginId],
    },
  };
}
