/**
 * GenUI Tool
 *
 * Allows the LLM to proactively render generative UI components on
 * connected frontends, even when not triggered by another tool call.
 *
 * Example: user asks "show me my schedule" → LLM calls genui tool
 * with action="render", componentId="calendar-view", and relevant params.
 */

import crypto from "node:crypto";
import { Type } from "@sinclair/typebox";
import type { SimpleClawConfig } from "../../config/config.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getGlobalGenUiBroadcast } from "../judge/genui-broadcast.js";
import type { GenUiRenderPayload, GenUiUpdatePayload } from "../judge/judge-hook.js";
import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult } from "./common.js";

const log = createSubsystemLogger("tools/genui");

const GENUI_ACTIONS = ["render", "update", "dismiss"] as const;

const GenUiToolSchema = Type.Object({
  action: stringEnum(GENUI_ACTIONS, {
    description:
      "render: show a new UI component. update: update an existing component's data. dismiss: hide a component.",
  }),
  componentId: Type.String({
    description: "The GenUI component to render (e.g. 'calendar-view', 'task-list', 'chart').",
  }),
  params: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description: "Data to pass to the component for rendering.",
    }),
  ),
  renderId: Type.Optional(
    Type.String({
      description:
        "Required for update/dismiss: the render ID returned by a previous render action.",
    }),
  ),
});

export function createGenUiTool(options?: {
  config?: SimpleClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool {
  return {
    label: "GenUI",
    name: "genui",
    description:
      "Render generative UI components on connected frontends for rich visualization. " +
      "Use render to show a new component, update to change its data, dismiss to hide it.",
    parameters: GenUiToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = params.action as string;
      const componentId = params.componentId as string;

      const broadcast = getGlobalGenUiBroadcast();
      if (!broadcast) {
        return jsonResult({ ok: false, error: "No frontend connected for GenUI rendering." });
      }

      switch (action) {
        case "render": {
          const renderId = crypto.randomUUID();
          const payload: GenUiRenderPayload = {
            id: renderId,
            sessionKey: options?.agentSessionKey,
            componentId,
            params: (params.params as Record<string, unknown>) ?? {},
            toolName: "genui",
            ts: Date.now(),
          };
          broadcast("genui.render", payload, { dropIfSlow: true });
          log.debug(`genui render: ${componentId} (${renderId})`);
          return jsonResult({ ok: true, renderId, componentId });
        }

        case "update": {
          const renderId = params.renderId as string | undefined;
          if (!renderId) {
            return jsonResult({ ok: false, error: "renderId is required for update action." });
          }
          const payload: GenUiUpdatePayload = {
            id: renderId,
            toolResult: params.params ?? {},
            ts: Date.now(),
          };
          broadcast("genui.update", payload, { dropIfSlow: true });
          log.debug(`genui update: ${componentId} (${renderId})`);
          return jsonResult({ ok: true, renderId });
        }

        case "dismiss": {
          const renderId = params.renderId as string | undefined;
          if (!renderId) {
            return jsonResult({ ok: false, error: "renderId is required for dismiss action." });
          }
          broadcast(
            "genui.update",
            { id: renderId, toolResult: null, dismissed: true, ts: Date.now() },
            { dropIfSlow: true },
          );
          log.debug(`genui dismiss: ${componentId} (${renderId})`);
          return jsonResult({ ok: true, renderId, dismissed: true });
        }

        default:
          return jsonResult({ ok: false, error: `Unknown action: ${action}` });
      }
    },
  };
}
