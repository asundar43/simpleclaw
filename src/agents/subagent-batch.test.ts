import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentRunOutcome } from "./subagent-announce.js";
import {
  addRunToBatch,
  createBatch,
  formatBatchResults,
  getBatch,
  getBatchIdForRun,
  isBatchComplete,
  listBatches,
  recordBatchRunCompletion,
  removeBatch,
  resetBatchesForTests,
} from "./subagent-batch.js";

beforeEach(() => {
  vi.clearAllMocks();
  resetBatchesForTests();
});

afterEach(() => {
  resetBatchesForTests();
});

describe("createBatch", () => {
  it("creates a batch and returns a UUID-like batchId", () => {
    const batchId = createBatch({
      requesterSessionKey: "agent:main:main",
    });
    expect(batchId).toBeTruthy();
    expect(typeof batchId).toBe("string");
    // UUID v4 format
    expect(batchId).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i);
  });

  it("sets default autoAggregate to true", () => {
    const batchId = createBatch({
      requesterSessionKey: "agent:main:main",
    });
    const batch = getBatch(batchId);
    expect(batch?.autoAggregate).toBe(true);
  });

  it("respects autoAggregate=false", () => {
    const batchId = createBatch({
      requesterSessionKey: "agent:main:main",
      autoAggregate: false,
    });
    const batch = getBatch(batchId);
    expect(batch?.autoAggregate).toBe(false);
  });

  it("stores label and requesterSessionKey", () => {
    const batchId = createBatch({
      requesterSessionKey: "agent:main:main",
      label: "research tasks",
    });
    const batch = getBatch(batchId);
    expect(batch?.label).toBe("research tasks");
    expect(batch?.requesterSessionKey).toBe("agent:main:main");
  });
});

describe("addRunToBatch", () => {
  it("adds a run to an existing batch", () => {
    const batchId = createBatch({ requesterSessionKey: "agent:main:main" });
    const added = addRunToBatch(batchId, "run-1");
    expect(added).toBe(true);
    const batch = getBatch(batchId);
    expect(batch?.runIds.has("run-1")).toBe(true);
  });

  it("returns false for non-existent batch", () => {
    const added = addRunToBatch("nonexistent-batch", "run-1");
    expect(added).toBe(false);
  });

  it("sets up reverse lookup", () => {
    const batchId = createBatch({ requesterSessionKey: "agent:main:main" });
    addRunToBatch(batchId, "run-1");
    expect(getBatchIdForRun("run-1")).toBe(batchId);
  });
});

describe("recordBatchRunCompletion", () => {
  const okOutcome: SubagentRunOutcome = { status: "ok" };
  const errorOutcome: SubagentRunOutcome = { status: "error", error: "something failed" };

  it("returns null for non-batched run", () => {
    const result = recordBatchRunCompletion({
      runId: "orphan-run",
      outcome: okOutcome,
    });
    expect(result).toBeNull();
  });

  it("returns complete=false when more runs are pending", () => {
    const batchId = createBatch({ requesterSessionKey: "agent:main:main" });
    addRunToBatch(batchId, "run-1");
    addRunToBatch(batchId, "run-2");
    addRunToBatch(batchId, "run-3");

    const result = recordBatchRunCompletion({
      runId: "run-1",
      outcome: okOutcome,
      findings: "found 3 results",
    });
    expect(result).toEqual({ batchId, complete: false });
  });

  it("returns complete=true when last run completes", () => {
    const batchId = createBatch({ requesterSessionKey: "agent:main:main" });
    addRunToBatch(batchId, "run-1");
    addRunToBatch(batchId, "run-2");

    recordBatchRunCompletion({ runId: "run-1", outcome: okOutcome, findings: "done" });
    const result = recordBatchRunCompletion({
      runId: "run-2",
      outcome: okOutcome,
      findings: "also done",
    });
    expect(result).toEqual({ batchId, complete: true });
  });

  it("handles mixed outcomes (success + error)", () => {
    const batchId = createBatch({ requesterSessionKey: "agent:main:main" });
    addRunToBatch(batchId, "run-1");
    addRunToBatch(batchId, "run-2");

    recordBatchRunCompletion({ runId: "run-1", outcome: okOutcome, findings: "success" });
    const result = recordBatchRunCompletion({
      runId: "run-2",
      outcome: errorOutcome,
      findings: "error details",
    });
    expect(result).toEqual({ batchId, complete: true });
  });

  it("stores label in results", () => {
    const batchId = createBatch({ requesterSessionKey: "agent:main:main" });
    addRunToBatch(batchId, "run-1");

    recordBatchRunCompletion({
      runId: "run-1",
      outcome: okOutcome,
      findings: "done",
      label: "researcher",
    });
    const batch = getBatch(batchId);
    expect(batch?.completedResults.get("run-1")?.label).toBe("researcher");
  });
});

describe("isBatchComplete", () => {
  it("returns true for removed batches", () => {
    expect(isBatchComplete("nonexistent")).toBe(true);
  });

  it("returns false for incomplete batch", () => {
    const batchId = createBatch({ requesterSessionKey: "agent:main:main" });
    addRunToBatch(batchId, "run-1");
    expect(isBatchComplete(batchId)).toBe(false);
  });

  it("returns true when all runs are recorded", () => {
    const batchId = createBatch({ requesterSessionKey: "agent:main:main" });
    addRunToBatch(batchId, "run-1");
    recordBatchRunCompletion({ runId: "run-1", outcome: { status: "ok" } });
    expect(isBatchComplete(batchId)).toBe(true);
  });
});

describe("formatBatchResults", () => {
  it("returns not found for missing batch", () => {
    expect(formatBatchResults("nonexistent")).toBe("(batch not found)");
  });

  it("formats completed results with status tags", () => {
    const batchId = createBatch({
      requesterSessionKey: "agent:main:main",
      label: "research",
    });
    addRunToBatch(batchId, "run-1");
    addRunToBatch(batchId, "run-2");
    addRunToBatch(batchId, "run-3");

    recordBatchRunCompletion({
      runId: "run-1",
      outcome: { status: "ok" },
      findings: "Found 5 results",
      label: "web search",
    });
    recordBatchRunCompletion({
      runId: "run-2",
      outcome: { status: "error", error: "timeout" },
      findings: "Connection failed",
      label: "api call",
    });
    recordBatchRunCompletion({
      runId: "run-3",
      outcome: { status: "timeout" },
      findings: "Took too long",
      label: "deep analysis",
    });

    const formatted = formatBatchResults(batchId);
    expect(formatted).toContain('Batch "research" completed (3/3 runs):');
    expect(formatted).toContain("[SUCCESS] web search: Found 5 results");
    expect(formatted).toContain("[FAILED] api call: Connection failed");
    expect(formatted).toContain("[TIMEOUT] deep analysis: Took too long");
  });

  it("shows PENDING for runs not yet completed", () => {
    const batchId = createBatch({ requesterSessionKey: "agent:main:main" });
    addRunToBatch(batchId, "run-1");
    addRunToBatch(batchId, "run-2");

    recordBatchRunCompletion({
      runId: "run-1",
      outcome: { status: "ok" },
      findings: "done",
      label: "task-a",
    });

    const formatted = formatBatchResults(batchId);
    expect(formatted).toContain("[SUCCESS] task-a: done");
    expect(formatted).toContain("[PENDING]");
  });
});

describe("listBatches", () => {
  it("returns empty array when no batches", () => {
    expect(listBatches("agent:main:main")).toEqual([]);
  });

  it("returns only batches for the given requester", () => {
    createBatch({ requesterSessionKey: "agent:main:main", label: "mine" });
    createBatch({ requesterSessionKey: "agent:other:main", label: "theirs" });

    const mine = listBatches("agent:main:main");
    expect(mine).toHaveLength(1);
    expect(mine[0].label).toBe("mine");
  });

  it("returns snapshot with correct pending count", () => {
    const batchId = createBatch({ requesterSessionKey: "agent:main:main" });
    addRunToBatch(batchId, "run-1");
    addRunToBatch(batchId, "run-2");
    addRunToBatch(batchId, "run-3");
    recordBatchRunCompletion({ runId: "run-1", outcome: { status: "ok" } });

    const batches = listBatches("agent:main:main");
    expect(batches).toHaveLength(1);
    expect(batches[0].pendingCount).toBe(2);
    expect(batches[0].runIds).toHaveLength(3);
    expect(batches[0].completedRunIds).toHaveLength(1);
  });
});

describe("removeBatch", () => {
  it("removes batch and cleans up reverse lookups", () => {
    const batchId = createBatch({ requesterSessionKey: "agent:main:main" });
    addRunToBatch(batchId, "run-1");
    addRunToBatch(batchId, "run-2");

    expect(getBatchIdForRun("run-1")).toBe(batchId);
    const removed = removeBatch(batchId);
    expect(removed).toBe(true);
    expect(getBatch(batchId)).toBeUndefined();
    expect(getBatchIdForRun("run-1")).toBeUndefined();
    expect(getBatchIdForRun("run-2")).toBeUndefined();
  });

  it("returns false for non-existent batch", () => {
    expect(removeBatch("nonexistent")).toBe(false);
  });
});

describe("batch timeout", () => {
  it("force-completes batch after timeout", async () => {
    vi.useFakeTimers();
    try {
      const batchId = createBatch({
        requesterSessionKey: "agent:main:main",
        timeoutMs: 1000,
      });
      addRunToBatch(batchId, "run-1");
      addRunToBatch(batchId, "run-2");

      // Only complete one run.
      recordBatchRunCompletion({ runId: "run-1", outcome: { status: "ok" }, findings: "done" });
      expect(isBatchComplete(batchId)).toBe(false);

      // Advance time past timeout.
      vi.advanceTimersByTime(1100);

      // Batch should be force-completed.
      expect(isBatchComplete(batchId)).toBe(true);

      // Unfinished run should have timeout outcome.
      const batch = getBatch(batchId);
      const run2Result = batch?.completedResults.get("run-2");
      expect(run2Result?.outcome.status).toBe("timeout");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("single-run batch", () => {
  it("completes immediately on first run completion", () => {
    const batchId = createBatch({ requesterSessionKey: "agent:main:main" });
    addRunToBatch(batchId, "run-1");

    const result = recordBatchRunCompletion({
      runId: "run-1",
      outcome: { status: "ok" },
      findings: "done",
    });
    expect(result).toEqual({ batchId, complete: true });
  });
});

describe("empty batch", () => {
  it("is immediately complete", () => {
    const batchId = createBatch({ requesterSessionKey: "agent:main:main" });
    // No runs added — completedResults.size (0) >= runIds.size (0)
    expect(isBatchComplete(batchId)).toBe(true);
  });
});
