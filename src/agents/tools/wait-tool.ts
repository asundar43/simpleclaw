import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";

const WaitToolSchema = Type.Object({
  reason: Type.Optional(Type.String()),
});

/**
 * Explicit "wait / no-op" tool for orchestrators.
 *
 * When an agent needs to acknowledge receipt of an intermediate result (e.g. one
 * subagent in a batch completing while others are still running) without producing
 * user-visible output, it can call `wait` instead of replying.  The tool result
 * carries `suppressOutput: true` so the delivery pipeline skips this turn.
 */
export function createWaitTool(): AnyAgentTool {
  return {
    label: "Wait",
    name: "wait",
    description:
      "Signal that you are intentionally waiting and have nothing to say right now. " +
      "Use this when you receive an intermediate result (e.g. a partial batch completion) " +
      "and want to wait for more results before responding. The output of this tool is " +
      "suppressed — no message will be sent to the user.",
    parameters: WaitToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const reason = typeof params.reason === "string" ? params.reason.trim() : undefined;
      return jsonResult({
        status: "waiting",
        suppressOutput: true,
        ...(reason ? { reason } : {}),
      });
    },
  };
}
