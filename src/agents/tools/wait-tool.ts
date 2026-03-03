import { Type } from "@sinclair/typebox";
import { stringEnum } from "../schema/typebox.js";
import {
  collectResults,
  formatHeldResults,
  holdResults,
  releaseHold,
} from "../subagent-hold-buffer.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

const WaitToolSchema = Type.Object({
  action: Type.Optional(
    stringEnum(["wait", "hold", "collect", "release"], {
      description:
        'Action to perform. "wait" (default): suppress output, no-op. ' +
        '"hold": start buffering sub-agent results instead of auto-announcing them. ' +
        '"collect": return all buffered sub-agent results without releasing hold. ' +
        '"release": stop buffering and return any remaining results.',
      default: "wait",
    }),
  ),
  reason: Type.Optional(Type.String()),
});

type WaitToolContext = {
  agentSessionKey?: string;
  holdTimeoutMs?: number;
};

/**
 * Explicit "wait / no-op" tool for orchestrators, extended with hold/collect/release
 * for UX curation of sub-agent results.
 *
 * Actions:
 * - "wait": Original behavior — suppress output, signal intentional waiting.
 * - "hold": Start buffering sub-agent results (they won't be auto-announced).
 * - "collect": Return all buffered results so far for synthesis.
 * - "release": Stop buffering and return any remaining results.
 */
export function createWaitTool(ctx?: WaitToolContext): AnyAgentTool {
  return {
    label: "Wait",
    name: "wait",
    description:
      "Control how sub-agent results are delivered. " +
      'Actions: "wait" (default) suppresses output — use when waiting for more results. ' +
      '"hold" starts buffering sub-agent completions instead of auto-announcing them. ' +
      '"collect" returns all buffered results for you to synthesize into a single response. ' +
      '"release" stops buffering and returns remaining results.',
    parameters: WaitToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action")?.trim() || "wait";
      const reason = typeof params.reason === "string" ? params.reason.trim() : undefined;
      const sessionKey = ctx?.agentSessionKey;

      switch (action) {
        case "hold": {
          if (!sessionKey) {
            return jsonResult({ status: "error", message: "No session context for hold mode." });
          }
          holdResults(sessionKey, ctx?.holdTimeoutMs);
          return jsonResult({
            status: "holding",
            message:
              "Hold mode activated. Sub-agent results will be buffered. " +
              'Use action "collect" to retrieve them, or "release" to stop buffering.',
          });
        }

        case "collect": {
          if (!sessionKey) {
            return jsonResult({ status: "error", message: "No session context for collect." });
          }
          const results = collectResults(sessionKey);
          const formatted = formatHeldResults(results);
          return jsonResult({
            status: "collected",
            count: results.length,
            results: formatted,
          });
        }

        case "release": {
          if (!sessionKey) {
            return jsonResult({ status: "error", message: "No session context for release." });
          }
          const remaining = releaseHold(sessionKey);
          const formatted = formatHeldResults(remaining);
          return jsonResult({
            status: "released",
            count: remaining.length,
            results: remaining.length > 0 ? formatted : undefined,
            message: "Hold mode deactivated. Future sub-agent results will be announced normally.",
          });
        }

        case "wait":
        default: {
          return jsonResult({
            status: "waiting",
            suppressOutput: true,
            ...(reason ? { reason } : {}),
          });
        }
      }
    },
  };
}
