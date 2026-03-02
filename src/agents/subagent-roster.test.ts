import { beforeEach, describe, expect, it } from "vitest";
import {
  countRosterEntries,
  getRosterNameForSession,
  listRoster,
  lookupNamedAgent,
  markNamedAgentIdle,
  markNamedAgentIdleBySessionKey,
  markNamedAgentRunning,
  registerNamedAgent,
  resetRosterForTests,
  retireNamedAgent,
} from "./subagent-roster.js";

beforeEach(() => {
  resetRosterForTests();
});

describe("registerNamedAgent", () => {
  it("creates a new roster entry", () => {
    const entry = registerNamedAgent({
      name: "researcher",
      agentId: "main",
      sessionKey: "agent:main:subagent:uuid-1",
      requesterSessionKey: "agent:main:main",
      runId: "run-1",
    });
    expect(entry.name).toBe("researcher");
    expect(entry.agentId).toBe("main");
    expect(entry.sessionKey).toBe("agent:main:subagent:uuid-1");
    expect(entry.status).toBe("running");
    expect(entry.currentRunId).toBe("run-1");
  });

  it("stores model when provided", () => {
    const entry = registerNamedAgent({
      name: "coder",
      agentId: "main",
      sessionKey: "agent:main:subagent:uuid-2",
      requesterSessionKey: "agent:main:main",
      model: "anthropic/claude-3-sonnet",
      runId: "run-2",
    });
    expect(entry.model).toBe("anthropic/claude-3-sonnet");
  });
});

describe("lookupNamedAgent", () => {
  it("returns undefined for non-existent name", () => {
    expect(lookupNamedAgent("agent:main:main", "unknown")).toBeUndefined();
  });

  it("finds existing entry by name", () => {
    registerNamedAgent({
      name: "researcher",
      agentId: "main",
      sessionKey: "agent:main:subagent:uuid-1",
      requesterSessionKey: "agent:main:main",
      runId: "run-1",
    });
    const entry = lookupNamedAgent("agent:main:main", "researcher");
    expect(entry?.name).toBe("researcher");
    expect(entry?.sessionKey).toBe("agent:main:subagent:uuid-1");
  });

  it("is case-insensitive", () => {
    registerNamedAgent({
      name: "Researcher",
      agentId: "main",
      sessionKey: "agent:main:subagent:uuid-1",
      requesterSessionKey: "agent:main:main",
      runId: "run-1",
    });
    const entry = lookupNamedAgent("agent:main:main", "researcher");
    expect(entry?.name).toBe("Researcher");
  });

  it("scopes entries by requester", () => {
    registerNamedAgent({
      name: "researcher",
      agentId: "main",
      sessionKey: "agent:main:subagent:uuid-1",
      requesterSessionKey: "agent:main:main",
      runId: "run-1",
    });
    expect(lookupNamedAgent("agent:other:main", "researcher")).toBeUndefined();
  });
});

describe("markNamedAgentRunning", () => {
  it("updates status and runId", () => {
    registerNamedAgent({
      name: "worker",
      agentId: "main",
      sessionKey: "agent:main:subagent:uuid-1",
      requesterSessionKey: "agent:main:main",
      runId: "run-1",
    });
    markNamedAgentIdle("agent:main:main", "worker");
    const updated = markNamedAgentRunning("agent:main:main", "worker", "run-2");
    expect(updated).toBe(true);
    const entry = lookupNamedAgent("agent:main:main", "worker");
    expect(entry?.status).toBe("running");
    expect(entry?.currentRunId).toBe("run-2");
  });

  it("returns false for non-existent entry", () => {
    expect(markNamedAgentRunning("agent:main:main", "ghost", "run-1")).toBe(false);
  });
});

describe("markNamedAgentIdle", () => {
  it("transitions running → idle", () => {
    registerNamedAgent({
      name: "worker",
      agentId: "main",
      sessionKey: "agent:main:subagent:uuid-1",
      requesterSessionKey: "agent:main:main",
      runId: "run-1",
    });
    expect(markNamedAgentIdle("agent:main:main", "worker")).toBe(true);
    const entry = lookupNamedAgent("agent:main:main", "worker");
    expect(entry?.status).toBe("idle");
    expect(entry?.currentRunId).toBeUndefined();
  });

  it("returns false for non-existent entry", () => {
    expect(markNamedAgentIdle("agent:main:main", "ghost")).toBe(false);
  });
});

describe("markNamedAgentIdleBySessionKey", () => {
  it("finds and idles the entry by session key", () => {
    registerNamedAgent({
      name: "worker",
      agentId: "main",
      sessionKey: "agent:main:subagent:uuid-1",
      requesterSessionKey: "agent:main:main",
      runId: "run-1",
    });
    expect(markNamedAgentIdleBySessionKey("agent:main:subagent:uuid-1")).toBe(true);
    const entry = lookupNamedAgent("agent:main:main", "worker");
    expect(entry?.status).toBe("idle");
  });

  it("returns false if session key not in roster", () => {
    expect(markNamedAgentIdleBySessionKey("agent:main:subagent:unknown")).toBe(false);
  });

  it("returns false if already idle", () => {
    registerNamedAgent({
      name: "worker",
      agentId: "main",
      sessionKey: "agent:main:subagent:uuid-1",
      requesterSessionKey: "agent:main:main",
      runId: "run-1",
    });
    markNamedAgentIdleBySessionKey("agent:main:subagent:uuid-1");
    // Second call returns false because already idle
    expect(markNamedAgentIdleBySessionKey("agent:main:subagent:uuid-1")).toBe(false);
  });
});

describe("retireNamedAgent", () => {
  it("removes entry from roster", () => {
    registerNamedAgent({
      name: "worker",
      agentId: "main",
      sessionKey: "agent:main:subagent:uuid-1",
      requesterSessionKey: "agent:main:main",
      runId: "run-1",
    });
    expect(retireNamedAgent("agent:main:main", "worker")).toBe(true);
    expect(lookupNamedAgent("agent:main:main", "worker")).toBeUndefined();
  });

  it("returns false for non-existent entry", () => {
    expect(retireNamedAgent("agent:main:main", "ghost")).toBe(false);
  });
});

describe("listRoster", () => {
  it("returns empty array when no entries", () => {
    expect(listRoster("agent:main:main")).toEqual([]);
  });

  it("returns entries sorted by name", () => {
    registerNamedAgent({
      name: "zebra",
      agentId: "main",
      sessionKey: "agent:main:subagent:uuid-z",
      requesterSessionKey: "agent:main:main",
      runId: "run-z",
    });
    registerNamedAgent({
      name: "alpha",
      agentId: "main",
      sessionKey: "agent:main:subagent:uuid-a",
      requesterSessionKey: "agent:main:main",
      runId: "run-a",
    });
    const list = listRoster("agent:main:main");
    expect(list).toHaveLength(2);
    expect(list[0].name).toBe("alpha");
    expect(list[1].name).toBe("zebra");
  });

  it("only returns entries for the given requester", () => {
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
    const list = listRoster("agent:main:main");
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("mine");
  });
});

describe("countRosterEntries", () => {
  it("returns 0 when empty", () => {
    expect(countRosterEntries("agent:main:main")).toBe(0);
  });

  it("counts only entries for the given requester", () => {
    registerNamedAgent({
      name: "a",
      agentId: "main",
      sessionKey: "agent:main:subagent:uuid-a",
      requesterSessionKey: "agent:main:main",
      runId: "run-a",
    });
    registerNamedAgent({
      name: "b",
      agentId: "main",
      sessionKey: "agent:main:subagent:uuid-b",
      requesterSessionKey: "agent:main:main",
      runId: "run-b",
    });
    registerNamedAgent({
      name: "other",
      agentId: "main",
      sessionKey: "agent:main:subagent:uuid-c",
      requesterSessionKey: "agent:other:main",
      runId: "run-c",
    });
    expect(countRosterEntries("agent:main:main")).toBe(2);
  });
});

describe("getRosterNameForSession", () => {
  it("returns undefined for unknown session", () => {
    expect(getRosterNameForSession("agent:main:subagent:unknown")).toBeUndefined();
  });

  it("returns the roster name for a known session key", () => {
    registerNamedAgent({
      name: "researcher",
      agentId: "main",
      sessionKey: "agent:main:subagent:uuid-1",
      requesterSessionKey: "agent:main:main",
      runId: "run-1",
    });
    expect(getRosterNameForSession("agent:main:subagent:uuid-1")).toBe("researcher");
  });
});

describe("lifecycle: register → idle → reuse → idle", () => {
  it("supports full named agent lifecycle", () => {
    // First spawn: register
    registerNamedAgent({
      name: "researcher",
      agentId: "main",
      sessionKey: "agent:main:subagent:uuid-1",
      requesterSessionKey: "agent:main:main",
      runId: "run-1",
    });
    let entry = lookupNamedAgent("agent:main:main", "researcher");
    expect(entry?.status).toBe("running");
    expect(entry?.currentRunId).toBe("run-1");

    // Run completes → idle
    markNamedAgentIdle("agent:main:main", "researcher");
    entry = lookupNamedAgent("agent:main:main", "researcher");
    expect(entry?.status).toBe("idle");
    expect(entry?.currentRunId).toBeUndefined();

    // Second spawn: reuse session
    markNamedAgentRunning("agent:main:main", "researcher", "run-2");
    entry = lookupNamedAgent("agent:main:main", "researcher");
    expect(entry?.status).toBe("running");
    expect(entry?.currentRunId).toBe("run-2");
    // Session key stays the same
    expect(entry?.sessionKey).toBe("agent:main:subagent:uuid-1");

    // Second run completes → idle again
    markNamedAgentIdle("agent:main:main", "researcher");
    entry = lookupNamedAgent("agent:main:main", "researcher");
    expect(entry?.status).toBe("idle");
  });
});
