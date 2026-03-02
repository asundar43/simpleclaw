/**
 * Orchestrator / Worker agent role system.
 *
 * - `orchestrator`: auto-allows delegation tools, system prompt includes roster & batch status.
 * - `worker`: auto-denies delegation tools (sessions_spawn, subagents, wait).
 * - No role (undefined): current default behavior, no changes.
 */

import type { SimpleClawConfig } from "../config/config.js";
import { resolveAgentConfig } from "./agent-scope.js";
import { listBatches } from "./subagent-batch.js";
import { listRoster } from "./subagent-roster.js";

export type AgentRole = "orchestrator" | "worker";

/** Delegation tools that orchestrators auto-allow and workers auto-deny. */
const DELEGATION_TOOLS = ["sessions_spawn", "subagents", "wait"];

/**
 * Resolve the explicit role for an agent from config.
 * Returns undefined if no role is configured (default behavior).
 */
export function resolveAgentRole(cfg: SimpleClawConfig, agentId: string): AgentRole | undefined {
  const entry = resolveAgentConfig(cfg, agentId);
  if (entry?.role === "orchestrator" || entry?.role === "worker") {
    return entry.role;
  }
  return undefined;
}

/**
 * Build a tool policy override based on the agent's role.
 * Returns undefined if no role-based policy is needed.
 */
export function resolveRoleToolPolicy(
  role: AgentRole | undefined,
): { allow?: string[]; deny?: string[] } | undefined {
  if (!role) {
    return undefined;
  }
  if (role === "worker") {
    return { deny: [...DELEGATION_TOOLS] };
  }
  // Orchestrator: ensure delegation tools are available (no deny).
  // The actual allow/deny is handled by the profile + agent policy;
  // we just make sure delegation tools aren't accidentally denied.
  return undefined;
}

/**
 * Build the orchestrator system prompt section with live roster and batch status.
 * Returns empty string for non-orchestrators.
 */
export function buildOrchestratorSystemPromptSection(params: {
  role: AgentRole | undefined;
  requesterSessionKey: string;
}): string {
  if (params.role !== "orchestrator") {
    return "";
  }

  const lines: string[] = [];
  lines.push("## Orchestrator Role");
  lines.push(
    "You are configured as an orchestrator agent. You can spawn and manage named sub-agents, " +
      "coordinate parallel work using batches, and use the `wait` tool to hold for pending results.",
  );

  // Roster status
  const roster = listRoster(params.requesterSessionKey);
  if (roster.length > 0) {
    lines.push("");
    lines.push("### Named Agents (Roster)");
    for (const entry of roster) {
      const status = entry.status === "running" ? "RUNNING" : "idle";
      lines.push(`- ${entry.name} (${entry.agentId}) [${status}]`);
    }
  }

  // Active batches
  const batches = listBatches(params.requesterSessionKey);
  if (batches.length > 0) {
    lines.push("");
    lines.push("### Active Batches");
    for (const batch of batches) {
      const label = batch.label || batch.batchId.slice(0, 8);
      lines.push(
        `- ${label}: ${batch.completedRunIds.length}/${batch.runIds.length} complete, ${batch.pendingCount} pending`,
      );
    }
  }

  return lines.join("\n");
}
