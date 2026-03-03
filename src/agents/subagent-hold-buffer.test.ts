import { describe, expect, it, beforeEach, vi, afterEach } from "vitest";
import {
  holdResults,
  isHolding,
  bufferResult,
  collectResults,
  releaseHold,
  cleanupStaleHolds,
  formatHeldResults,
  type HeldResult,
} from "./subagent-hold-buffer.js";

const SESSION = "test:session:key";

function makeResult(overrides?: Partial<HeldResult>): HeldResult {
  return {
    runId: "run-1",
    task: "Research topic X",
    findings: "Found interesting results about X.",
    status: "ok",
    endedAt: Date.now(),
    ...overrides,
  };
}

describe("subagent-hold-buffer", () => {
  beforeEach(() => {
    // Release any leftover holds between tests
    releaseHold(SESSION);
    releaseHold("other-session");
  });

  describe("holdResults / isHolding", () => {
    it("activates hold mode", () => {
      expect(isHolding(SESSION)).toBe(false);
      holdResults(SESSION);
      expect(isHolding(SESSION)).toBe(true);
    });

    it("refreshes timeout on re-hold", () => {
      holdResults(SESSION, 1000);
      holdResults(SESSION, 5000);
      // Should still be holding
      expect(isHolding(SESSION)).toBe(true);
    });

    it("returns false for unknown sessions", () => {
      expect(isHolding("nonexistent")).toBe(false);
    });
  });

  describe("bufferResult / collectResults", () => {
    it("buffers and collects results", () => {
      holdResults(SESSION);
      const r1 = makeResult({ runId: "run-1" });
      const r2 = makeResult({ runId: "run-2", label: "research" });
      bufferResult(SESSION, r1);
      bufferResult(SESSION, r2);

      const results = collectResults(SESSION);
      expect(results).toHaveLength(2);
      expect(results[0].runId).toBe("run-1");
      expect(results[1].runId).toBe("run-2");
    });

    it("returns empty array when not holding", () => {
      expect(collectResults(SESSION)).toEqual([]);
    });

    it("collectResults does not clear the buffer", () => {
      holdResults(SESSION);
      bufferResult(SESSION, makeResult());
      collectResults(SESSION);
      // Still there
      expect(collectResults(SESSION)).toHaveLength(1);
    });
  });

  describe("releaseHold", () => {
    it("returns buffered results and deactivates hold", () => {
      holdResults(SESSION);
      bufferResult(SESSION, makeResult({ runId: "r1" }));
      bufferResult(SESSION, makeResult({ runId: "r2" }));

      const released = releaseHold(SESSION);
      expect(released).toHaveLength(2);
      expect(isHolding(SESSION)).toBe(false);
    });

    it("returns empty array when not holding", () => {
      expect(releaseHold(SESSION)).toEqual([]);
    });
  });

  describe("cleanupStaleHolds", () => {
    it("removes expired holds", () => {
      holdResults(SESSION, 1); // 1ms timeout
      // Wait for expiry
      vi.useFakeTimers();
      vi.advanceTimersByTime(100);

      const cleaned = cleanupStaleHolds();
      expect(cleaned).toBe(1);
      expect(isHolding(SESSION)).toBe(false);

      vi.useRealTimers();
    });

    it("keeps non-expired holds", () => {
      holdResults(SESSION, 60_000);
      const cleaned = cleanupStaleHolds();
      expect(cleaned).toBe(0);
      expect(isHolding(SESSION)).toBe(true);
    });
  });

  describe("auto-expire in isHolding", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("auto-expires stale holds on check", () => {
      holdResults(SESSION, 50);
      expect(isHolding(SESSION)).toBe(true);

      vi.useFakeTimers();
      vi.advanceTimersByTime(100);
      expect(isHolding(SESSION)).toBe(false);
    });
  });

  describe("formatHeldResults", () => {
    it("formats empty results", () => {
      expect(formatHeldResults([])).toBe("No results buffered.");
    });

    it("formats success results", () => {
      const output = formatHeldResults([
        makeResult({ status: "ok", task: "Analyze data", findings: "Data looks good." }),
      ]);
      expect(output).toContain("[SUCCESS]");
      expect(output).toContain("Analyze data");
      expect(output).toContain("Data looks good.");
    });

    it("formats error results", () => {
      const output = formatHeldResults([
        makeResult({ status: "error", task: "Fetch API", findings: "Connection refused." }),
      ]);
      expect(output).toContain("[FAILED]");
    });

    it("formats timeout results", () => {
      const output = formatHeldResults([
        makeResult({ status: "timeout", task: "Long task", findings: "Timed out." }),
      ]);
      expect(output).toContain("[TIMEOUT]");
    });

    it("includes labels when present", () => {
      const output = formatHeldResults([
        makeResult({ label: "researcher", task: "Research", findings: "Done." }),
      ]);
      expect(output).toContain("(researcher)");
    });

    it("separates multiple results with blank lines", () => {
      const output = formatHeldResults([
        makeResult({ runId: "r1", task: "Task A", findings: "Result A" }),
        makeResult({ runId: "r2", task: "Task B", findings: "Result B" }),
      ]);
      expect(output).toContain("Task A");
      expect(output).toContain("Task B");
      expect(output.split("\n\n")).toHaveLength(2);
    });
  });
});
