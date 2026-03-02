import crypto from "node:crypto";
import type { SubagentRunOutcome } from "./subagent-announce.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BatchRunResult = {
  runId: string;
  label?: string;
  outcome: SubagentRunOutcome;
  findings?: string;
  endedAt: number;
};

export type BatchState = {
  batchId: string;
  requesterSessionKey: string;
  label?: string;
  runIds: Set<string>;
  completedResults: Map<string, BatchRunResult>;
  createdAt: number;
  /** Timeout in ms after which incomplete batches force-aggregate. */
  timeoutMs?: number;
  /** When true, suppress per-run announces and aggregate on batch completion. */
  autoAggregate: boolean;
};

/** Serializable snapshot of a batch (for persistence and tool output). */
export type BatchSnapshot = {
  batchId: string;
  requesterSessionKey: string;
  label?: string;
  runIds: string[];
  completedRunIds: string[];
  pendingCount: number;
  createdAt: number;
  timeoutMs?: number;
  autoAggregate: boolean;
};

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

const batches = new Map<string, BatchState>();
/** Reverse lookup: runId → batchId for fast completion recording. */
const runToBatch = new Map<string, string>();
/** Timeout handles for batch force-expiry. */
const batchTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

// ---------------------------------------------------------------------------
// Core API
// ---------------------------------------------------------------------------

/**
 * Create a new batch. Returns the generated batch ID.
 * Spawns in the same interaction turn should share a single batchId.
 */
export function createBatch(params: {
  requesterSessionKey: string;
  label?: string;
  autoAggregate?: boolean;
  timeoutMs?: number;
}): string {
  const batchId = crypto.randomUUID();
  const state: BatchState = {
    batchId,
    requesterSessionKey: params.requesterSessionKey,
    label: params.label,
    runIds: new Set(),
    completedResults: new Map(),
    createdAt: Date.now(),
    timeoutMs: params.timeoutMs,
    autoAggregate: params.autoAggregate !== false,
  };
  batches.set(batchId, state);

  // Start force-expiry timer if configured.
  if (typeof params.timeoutMs === "number" && params.timeoutMs > 0) {
    const timer = setTimeout(() => {
      forceCompleteBatch(batchId);
    }, params.timeoutMs);
    timer.unref?.();
    batchTimeouts.set(batchId, timer);
  }

  return batchId;
}

/**
 * Register a subagent run as part of a batch.
 * Returns false if the batchId doesn't exist.
 */
export function addRunToBatch(batchId: string, runId: string): boolean {
  const state = batches.get(batchId);
  if (!state) {
    return false;
  }
  state.runIds.add(runId);
  runToBatch.set(runId, batchId);
  return true;
}

/**
 * Record that a subagent run within a batch has completed.
 * Returns `{ batchId, complete: true }` when this was the final run,
 * `{ batchId, complete: false }` when more runs are pending,
 * or `null` if the run is not part of any batch.
 */
export function recordBatchRunCompletion(params: {
  runId: string;
  outcome: SubagentRunOutcome;
  findings?: string;
  label?: string;
  endedAt?: number;
}): { batchId: string; complete: boolean } | null {
  const batchId = runToBatch.get(params.runId);
  if (!batchId) {
    return null;
  }
  const state = batches.get(batchId);
  if (!state) {
    // Batch was already removed (force-completed or cleaned up).
    runToBatch.delete(params.runId);
    return null;
  }

  state.completedResults.set(params.runId, {
    runId: params.runId,
    label: params.label,
    outcome: params.outcome,
    findings: params.findings,
    endedAt: params.endedAt ?? Date.now(),
  });

  const complete = state.completedResults.size >= state.runIds.size;
  return { batchId, complete };
}

/** Check whether all runs in a batch have reported completion. */
export function isBatchComplete(batchId: string): boolean {
  const state = batches.get(batchId);
  if (!state) {
    return true; // Removed batches are considered done.
  }
  return state.completedResults.size >= state.runIds.size;
}

/** Return the batchId for a given runId, or undefined. */
export function getBatchIdForRun(runId: string): string | undefined {
  return runToBatch.get(runId);
}

/** Return the batch state for a given batchId, or undefined. */
export function getBatch(batchId: string): BatchState | undefined {
  return batches.get(batchId);
}

/**
 * Format completed batch results into an aggregated announce message.
 * Each completed run is rendered as a status line followed by its findings.
 */
export function formatBatchResults(batchId: string): string {
  const state = batches.get(batchId);
  if (!state) {
    return "(batch not found)";
  }
  const entries: string[] = [];
  // Iterate in insertion order (runIds preserves spawn order).
  for (const runId of state.runIds) {
    const result = state.completedResults.get(runId);
    if (!result) {
      entries.push(`[PENDING] ${runId}: (no result yet)`);
      continue;
    }
    const statusTag = resolveStatusTag(result.outcome);
    const label = result.label || runId.slice(0, 8);
    const findings = result.findings?.trim() || "(no output)";
    entries.push(`[${statusTag}] ${label}: ${findings}`);
  }
  const header = state.label
    ? `Batch "${state.label}" completed (${state.completedResults.size}/${state.runIds.size} runs):`
    : `Batch completed (${state.completedResults.size}/${state.runIds.size} runs):`;
  return [header, "", ...entries].join("\n");
}

/**
 * List all active batches for a given requester session.
 */
export function listBatches(requesterSessionKey: string): BatchSnapshot[] {
  const results: BatchSnapshot[] = [];
  for (const state of batches.values()) {
    if (state.requesterSessionKey !== requesterSessionKey) {
      continue;
    }
    results.push(toBatchSnapshot(state));
  }
  return results;
}

/**
 * Remove a batch and clean up its reverse-lookup entries.
 * Returns false if the batch didn't exist.
 */
export function removeBatch(batchId: string): boolean {
  const state = batches.get(batchId);
  if (!state) {
    return false;
  }
  for (const runId of state.runIds) {
    runToBatch.delete(runId);
  }
  batches.delete(batchId);
  const timer = batchTimeouts.get(batchId);
  if (timer) {
    clearTimeout(timer);
    batchTimeouts.delete(batchId);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function resolveStatusTag(outcome: SubagentRunOutcome): string {
  switch (outcome.status) {
    case "ok":
      return "SUCCESS";
    case "error":
      return "FAILED";
    case "timeout":
      return "TIMEOUT";
    default:
      return "UNKNOWN";
  }
}

function toBatchSnapshot(state: BatchState): BatchSnapshot {
  return {
    batchId: state.batchId,
    requesterSessionKey: state.requesterSessionKey,
    label: state.label,
    runIds: [...state.runIds],
    completedRunIds: [...state.completedResults.keys()],
    pendingCount: Math.max(0, state.runIds.size - state.completedResults.size),
    createdAt: state.createdAt,
    timeoutMs: state.timeoutMs,
    autoAggregate: state.autoAggregate,
  };
}

/**
 * Force-complete a batch that has timed out.
 * Marks any non-completed runs as timed out in the results.
 */
function forceCompleteBatch(batchId: string) {
  const state = batches.get(batchId);
  if (!state) {
    return;
  }
  const now = Date.now();
  for (const runId of state.runIds) {
    if (!state.completedResults.has(runId)) {
      state.completedResults.set(runId, {
        runId,
        outcome: { status: "timeout" },
        findings: "(batch timeout — run did not complete in time)",
        endedAt: now,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

export function resetBatchesForTests() {
  batches.clear();
  runToBatch.clear();
  for (const timer of batchTimeouts.values()) {
    clearTimeout(timer);
  }
  batchTimeouts.clear();
}
