import { beforeEach, describe, expect, it } from "vitest";
import type { SimpleClawConfig } from "../config/config.js";
import {
  buildOrchestratorSystemPromptSection,
  resolveAgentRole,
  resolveRoleToolPolicy,
} from "./orchestrator-role.js";
import { createBatch, resetBatchesForTests } from "./subagent-batch.js";
import { markNamedAgentIdle, registerNamedAgent, resetRosterForTests } from "./subagent-roster.js";

beforeEach(() => {
  resetRosterForTests();
  resetBatchesForTests();
});

function makeConfig(agents: SimpleClawConfig["agents"]): SimpleClawConfig {
  return { agents } as SimpleClawConfig;
}

describe("resolveAgentRole", () => {
  it("returns undefined when no agents configured", () => {
    expect(resolveAgentRole({} as SimpleClawConfig, "main")).toBeUndefined();
  });

  it("returns undefined when agent has no role", () => {
    const cfg = makeConfig({ list: [{ id: "main" }] });
    expect(resolveAgentRole(cfg, "main")).toBeUndefined();
  });

  it('returns "orchestrator" for orchestrator role', () => {
    const cfg = makeConfig({
      list: [{ id: "coordinator", role: "orchestrator" }],
    });
    expect(resolveAgentRole(cfg, "coordinator")).toBe("orchestrator");
  });

  it('returns "worker" for worker role', () => {
    const cfg = makeConfig({
      list: [{ id: "researcher", role: "worker" }],
    });
    expect(resolveAgentRole(cfg, "researcher")).toBe("worker");
  });

  it("returns undefined for unknown role value", () => {
    const cfg = makeConfig({
      list: [{ id: "main", role: "manager" as "orchestrator" }],
    });
    expect(resolveAgentRole(cfg, "main")).toBeUndefined();
  });

  it("is case-sensitive for role values", () => {
    const cfg = makeConfig({
      list: [{ id: "main", role: "Orchestrator" as "orchestrator" }],
    });
    expect(resolveAgentRole(cfg, "main")).toBeUndefined();
  });
});

describe("resolveRoleToolPolicy", () => {
  it("returns undefined for no role", () => {
    expect(resolveRoleToolPolicy(undefined)).toBeUndefined();
  });

  it("returns undefined for orchestrator role (no restrictions)", () => {
    expect(resolveRoleToolPolicy("orchestrator")).toBeUndefined();
  });

  it("returns deny list for worker role", () => {
    const policy = resolveRoleToolPolicy("worker");
    expect(policy).toBeDefined();
    expect(policy!.deny).toContain("sessions_spawn");
    expect(policy!.deny).toContain("subagents");
    expect(policy!.deny).toContain("wait");
    expect(policy!.allow).toBeUndefined();
  });
});

describe("buildOrchestratorSystemPromptSection", () => {
  it("returns empty string for no role", () => {
    const result = buildOrchestratorSystemPromptSection({
      role: undefined,
      requesterSessionKey: "agent:main:main",
    });
    expect(result).toBe("");
  });

  it("returns empty string for worker role", () => {
    const result = buildOrchestratorSystemPromptSection({
      role: "worker",
      requesterSessionKey: "agent:main:main",
    });
    expect(result).toBe("");
  });

  it("returns orchestrator section for orchestrator role", () => {
    const result = buildOrchestratorSystemPromptSection({
      role: "orchestrator",
      requesterSessionKey: "agent:main:main",
    });
    expect(result).toContain("## Orchestrator Role");
    expect(result).toContain("orchestrator agent");
    expect(result).toContain("`wait` tool");
  });

  it("includes roster entries when present", () => {
    registerNamedAgent({
      name: "researcher",
      agentId: "main",
      sessionKey: "agent:main:subagent:uuid-1",
      requesterSessionKey: "agent:main:main",
      runId: "run-1",
    });
    registerNamedAgent({
      name: "coder",
      agentId: "main",
      sessionKey: "agent:main:subagent:uuid-2",
      requesterSessionKey: "agent:main:main",
      runId: "run-2",
    });

    const result = buildOrchestratorSystemPromptSection({
      role: "orchestrator",
      requesterSessionKey: "agent:main:main",
    });
    expect(result).toContain("### Named Agents (Roster)");
    expect(result).toContain("researcher");
    expect(result).toContain("coder");
    expect(result).toContain("[RUNNING]");
  });

  it("shows idle status for idle agents", () => {
    registerNamedAgent({
      name: "worker",
      agentId: "main",
      sessionKey: "agent:main:subagent:uuid-1",
      requesterSessionKey: "agent:main:main",
      runId: "run-1",
    });
    markNamedAgentIdle("agent:main:main", "worker");

    const result = buildOrchestratorSystemPromptSection({
      role: "orchestrator",
      requesterSessionKey: "agent:main:main",
    });
    expect(result).toContain("[idle]");
  });

  it("includes batch entries when present", () => {
    createBatch({
      requesterSessionKey: "agent:main:main",
      label: "research-batch",
    });

    const result = buildOrchestratorSystemPromptSection({
      role: "orchestrator",
      requesterSessionKey: "agent:main:main",
    });
    expect(result).toContain("### Active Batches");
    expect(result).toContain("research-batch");
  });

  it("does not include roster or batch sections when empty", () => {
    const result = buildOrchestratorSystemPromptSection({
      role: "orchestrator",
      requesterSessionKey: "agent:main:main",
    });
    expect(result).not.toContain("### Named Agents");
    expect(result).not.toContain("### Active Batches");
  });

  it("scopes roster to requester session key", () => {
    registerNamedAgent({
      name: "mine",
      agentId: "main",
      sessionKey: "agent:main:subagent:uuid-1",
      requesterSessionKey: "agent:main:main",
      runId: "run-1",
    });
    registerNamedAgent({
      name: "theirs",
      agentId: "main",
      sessionKey: "agent:main:subagent:uuid-2",
      requesterSessionKey: "agent:other:main",
      runId: "run-2",
    });

    const result = buildOrchestratorSystemPromptSection({
      role: "orchestrator",
      requesterSessionKey: "agent:main:main",
    });
    expect(result).toContain("mine");
    expect(result).not.toContain("theirs");
  });
});
