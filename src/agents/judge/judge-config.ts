/**
 * Judge Config
 *
 * Resolves the judge configuration from the global agent defaults.
 */

import type { SimpleClawConfig } from "../../config/config.js";
import type { AgentJudgeConfig } from "../../config/types.agent-defaults.js";

/**
 * Resolve judge config from the global agent defaults.
 * Returns undefined if judge is disabled or not configured.
 */
export function resolveJudgeConfig(config?: SimpleClawConfig): AgentJudgeConfig | undefined {
  const judge = config?.agents?.defaults?.judge;
  if (!judge?.enabled) {
    return undefined;
  }
  return judge;
}
