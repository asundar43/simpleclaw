/**
 * Judge Hook
 *
 * Registers `before_tool_call` and `after_tool_call` hooks that intercept
 * tool execution to trigger generative UI rendering on connected frontends.
 *
 * Flow:
 * 1. before_tool_call: Look up tool in GenUI registry → validate params →
 *    broadcast genui.render event (or block if params missing)
 * 2. after_tool_call: Broadcast genui.update event with tool result
 */

import crypto from "node:crypto";
import type { SimpleClawConfig } from "../../config/config.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { PluginRegistry } from "../../plugins/registry.js";
import type {
  PluginHookAfterToolCallEvent,
  PluginHookBeforeToolCallEvent,
  PluginHookBeforeToolCallResult,
  PluginHookRegistration,
  PluginHookToolContext,
} from "../../plugins/types.js";
import { getGlobalGenUiBroadcast } from "./genui-broadcast.js";
import { GenUiRegistry } from "./genui-registry.js";
import { resolveJudgeConfig } from "./judge-config.js";

const log = createSubsystemLogger("judge");

/** Tracks pending genui renders keyed by toolCallId for after_tool_call pairing */
const pendingRenders = new Map<string, { renderId: string; componentId: string }>();
const MAX_PENDING_RENDERS = 256;

export type GenUiRenderPayload = {
  id: string;
  sessionKey?: string;
  componentId: string;
  params: Record<string, unknown>;
  schema?: Record<string, unknown>;
  toolName: string;
  ts: number;
};

export type GenUiUpdatePayload = {
  id: string;
  toolResult: unknown;
  isError?: boolean;
  ts: number;
};

/**
 * Register the judge hooks on the given plugin registry.
 * Called once during plugin loading.
 *
 * Returns the GenUiRegistry instance so it can be disposed of later.
 */
export async function registerJudgeHook(
  registry: PluginRegistry,
  config?: SimpleClawConfig,
): Promise<GenUiRegistry | undefined> {
  const judgeConfig = resolveJudgeConfig(config);
  if (!judgeConfig) {
    log.debug("judge disabled or not configured");
    return undefined;
  }

  log.info("registering judge before_tool_call + after_tool_call hooks");

  // Initialize the GenUI registry
  const genUiRegistry = new GenUiRegistry();
  await genUiRegistry.initialize(judgeConfig);

  // before_tool_call: intercept, validate, broadcast genui.render
  const beforeHandler = async (
    event: PluginHookBeforeToolCallEvent,
    ctx: PluginHookToolContext,
  ): Promise<PluginHookBeforeToolCallResult | void> => {
    const components = genUiRegistry.lookupByTool(event.toolName);
    if (components.length === 0) {
      return; // Not a GenUI tool, pass through
    }

    // Pick the first matching component (single match is the common case).
    // TODO: LLM fallback for ambiguous multi-component mappings
    const component = components[0];

    const validation = genUiRegistry.validateParams(component, event.params);
    if (!validation.valid) {
      log.debug(
        `blocking ${event.toolName}: missing params [${validation.missing.join(", ")}] for ${component.componentId}`,
      );
      return {
        block: true,
        blockReason:
          `Cannot render rich UI — missing required information. ` +
          `Ask the user for: ${validation.missing.join(", ")}. ` +
          `Then try this tool call again with all parameters.`,
      };
    }

    // Params complete — broadcast genui.render
    const renderId = crypto.randomUUID();
    const broadcast = getGlobalGenUiBroadcast();
    if (broadcast) {
      const payload: GenUiRenderPayload = {
        id: renderId,
        sessionKey: ctx.sessionKey,
        componentId: component.componentId,
        params: event.params,
        schema: component.schema,
        toolName: event.toolName,
        ts: Date.now(),
      };
      broadcast("genui.render", payload, { dropIfSlow: true });
      log.debug(`broadcast genui.render: ${component.componentId} (${renderId})`);
    } else {
      log.warn("no global GenUI broadcast available — genui.render event not sent");
    }

    // Track the render for after_tool_call pairing
    // Use a composite key since toolCallId may not be unique across sessions
    const trackingKey = `${ctx.sessionKey ?? ""}:${event.toolName}:${Date.now()}`;
    pendingRenders.set(trackingKey, { renderId, componentId: component.componentId });
    if (pendingRenders.size > MAX_PENDING_RENDERS) {
      const oldest = pendingRenders.keys().next().value;
      if (oldest) {
        pendingRenders.delete(oldest);
      }
    }

    // Don't block — let the tool execute normally
    return;
  };

  // after_tool_call: broadcast genui.update with tool result
  const afterHandler = async (
    event: PluginHookAfterToolCallEvent,
    ctx: PluginHookToolContext,
  ): Promise<void> => {
    // Find matching pending render
    let matchedKey: string | undefined;
    let matchedRender: { renderId: string; componentId: string } | undefined;

    for (const [key, render] of pendingRenders) {
      if (key.startsWith(`${ctx.sessionKey ?? ""}:${event.toolName}:`)) {
        matchedKey = key;
        matchedRender = render;
        break;
      }
    }

    if (!matchedKey || !matchedRender) {
      return; // No pending GenUI render for this tool call
    }

    pendingRenders.delete(matchedKey);

    const broadcast = getGlobalGenUiBroadcast();
    if (broadcast) {
      const payload: GenUiUpdatePayload = {
        id: matchedRender.renderId,
        toolResult: event.result,
        isError: Boolean(event.error),
        ts: Date.now(),
      };
      broadcast("genui.update", payload, { dropIfSlow: true });
      log.debug(`broadcast genui.update: ${matchedRender.componentId} (${matchedRender.renderId})`);
    }
  };

  registry.typedHooks.push({
    pluginId: "builtin:judge",
    hookName: "before_tool_call",
    handler: beforeHandler,
    priority: 100, // High priority — run before other before_tool_call hooks
    source: "builtin",
  } as PluginHookRegistration);

  registry.typedHooks.push({
    pluginId: "builtin:judge",
    hookName: "after_tool_call",
    handler: afterHandler,
    priority: 100,
    source: "builtin",
  } as PluginHookRegistration);

  return genUiRegistry;
}
