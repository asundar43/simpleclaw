/**
 * Passive Context Plugin
 *
 * Registers a `before_prompt_build` hook that injects ambient context
 * (recent emails, channel history) into the agent's prompt based on
 * entity mentions in the current message.
 */

import type { SimpleClawConfig } from "../../config/config.js";
import type { AgentPassiveContextConfig } from "../../config/types.agent-defaults.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { PluginRegistry } from "../../plugins/registry.js";
import type {
  PluginHookAgentContext,
  PluginHookBeforePromptBuildEvent,
  PluginHookBeforePromptBuildResult,
  PluginHookRegistration,
} from "../../plugins/types.js";
import { createContextBudget } from "./context-budget.js";
import { buildChannelHistoryContext, queryGmailContext } from "./context-sources.js";
import { extractEntities } from "./entity-extractor.js";

const log = createSubsystemLogger("passive-context");

/**
 * Resolve passive context config from the global agent defaults.
 */
export function resolvePassiveContextConfig(
  config?: SimpleClawConfig,
): AgentPassiveContextConfig | undefined {
  const pc = config?.agents?.defaults?.passiveContext;
  if (!pc?.enabled) {
    return undefined;
  }
  return pc;
}

/**
 * Register the passive context `before_prompt_build` hook on the given plugin registry.
 * Called once during plugin loading.
 */
export function registerPassiveContextHook(
  registry: PluginRegistry,
  config?: SimpleClawConfig,
): void {
  const pcConfig = resolvePassiveContextConfig(config);
  if (!pcConfig) {
    log.debug("passive context disabled or not configured");
    return;
  }

  log.info("registering passive context before_prompt_build hook");

  const handler = async (
    event: PluginHookBeforePromptBuildEvent,
    _ctx: PluginHookAgentContext,
  ): Promise<PluginHookBeforePromptBuildResult | void> => {
    try {
      const entities = extractEntities(event.prompt);
      if (entities.length === 0) {
        return;
      }

      const budget = createContextBudget(pcConfig.totalMaxTokens);
      const snippets: string[] = [];

      // Query Gmail if enabled
      if (pcConfig.sources?.gmail?.enabled) {
        const gmailResult = await queryGmailContext({
          entities,
          maxTokens: pcConfig.sources.gmail.maxTokens ?? 2000,
          lookbackDays: pcConfig.sources.gmail.lookbackDays ?? 30,
          budget,
        });
        if (gmailResult) {
          snippets.push(gmailResult.text);
        }
      }

      // Build channel history context if enabled
      if (pcConfig.sources?.channelHistory?.enabled) {
        // Channel history from session messages (extract from event.messages)
        const history = extractInboundHistory(event.messages);
        const channelResult = buildChannelHistoryContext({
          inboundHistory: history,
          entities,
          maxTokens: pcConfig.sources.channelHistory.maxTokens ?? 1000,
          budget,
        });
        if (channelResult) {
          snippets.push(channelResult.text);
        }
      }

      if (snippets.length === 0) {
        return;
      }

      const prependContext = snippets.join("\n\n");
      log.debug(`injecting passive context (${prependContext.length} chars)`);

      return { prependContext };
    } catch (err) {
      log.warn(`passive context hook failed: ${String(err)}`);
      return;
    }
  };

  registry.typedHooks.push({
    pluginId: "builtin:passive-context",
    hookName: "before_prompt_build",
    handler,
    priority: -10, // Low priority — run after other hooks
    source: "builtin",
  } as PluginHookRegistration);
}

/**
 * Extract inbound history entries from session messages.
 * Looks for messages with role "user" that have sender/body metadata.
 */
function extractInboundHistory(
  messages: unknown[],
): Array<{ sender?: string; body?: string; timestamp?: number }> {
  const history: Array<{ sender?: string; body?: string; timestamp?: number }> = [];

  for (const msg of messages) {
    if (typeof msg !== "object" || msg === null) {
      continue;
    }
    const m = msg as Record<string, unknown>;
    if (m.role !== "user") {
      continue;
    }

    const content = typeof m.content === "string" ? m.content : "";
    const sender = typeof m.sender === "string" ? m.sender : undefined;
    const timestamp = typeof m.timestamp === "number" ? m.timestamp : undefined;

    if (content) {
      history.push({ sender, body: content, timestamp });
    }
  }

  return history;
}
