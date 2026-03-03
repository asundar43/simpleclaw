import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("subagent-hold");

const DEFAULT_HOLD_TIMEOUT_MS = 300_000; // 5 minutes

export type HeldResult = {
  runId: string;
  label?: string;
  task: string;
  findings: string;
  status: "ok" | "error" | "timeout";
  endedAt: number;
};

type HoldEntry = {
  results: HeldResult[];
  heldAt: number;
  timeoutMs: number;
};

// In-memory hold buffer keyed by requester session key
const holds = new Map<string, HoldEntry>();

/**
 * Activate hold mode for a requester session.
 * Sub-agent results will be buffered instead of auto-announced.
 */
export function holdResults(sessionKey: string, timeoutMs?: number): void {
  const existing = holds.get(sessionKey);
  if (existing) {
    // Already holding — keep existing buffered results, refresh timeout
    existing.heldAt = Date.now();
    existing.timeoutMs = timeoutMs ?? existing.timeoutMs;
    return;
  }
  holds.set(sessionKey, {
    results: [],
    heldAt: Date.now(),
    timeoutMs: timeoutMs ?? DEFAULT_HOLD_TIMEOUT_MS,
  });
  log.info(`hold activated for session ${sessionKey}`);
}

/**
 * Check if a requester session is currently in hold mode.
 * Also checks for stale holds and auto-expires them.
 */
export function isHolding(sessionKey: string): boolean {
  const entry = holds.get(sessionKey);
  if (!entry) {
    return false;
  }

  // Auto-expire stale holds
  if (Date.now() - entry.heldAt > entry.timeoutMs) {
    log.warn(`hold expired for session ${sessionKey} after ${entry.timeoutMs}ms`);
    holds.delete(sessionKey);
    return false;
  }

  return true;
}

/**
 * Buffer a sub-agent result for a session in hold mode.
 */
export function bufferResult(sessionKey: string, result: HeldResult): void {
  const entry = holds.get(sessionKey);
  if (!entry) {
    log.warn(`bufferResult called but session ${sessionKey} is not holding`);
    return;
  }
  entry.results.push(result);
  log.debug(
    `buffered result for session ${sessionKey}: runId=${result.runId} status=${result.status}`,
  );
}

/**
 * Return all buffered results without releasing hold mode.
 */
export function collectResults(sessionKey: string): HeldResult[] {
  const entry = holds.get(sessionKey);
  if (!entry) {
    return [];
  }
  return [...entry.results];
}

/**
 * Deactivate hold mode and return any remaining buffered results.
 */
export function releaseHold(sessionKey: string): HeldResult[] {
  const entry = holds.get(sessionKey);
  if (!entry) {
    return [];
  }
  const results = [...entry.results];
  holds.delete(sessionKey);
  log.info(`hold released for session ${sessionKey} (${results.length} buffered results)`);
  return results;
}

/**
 * Clean up all stale holds across all sessions (call periodically).
 */
export function cleanupStaleHolds(): number {
  const now = Date.now();
  let cleaned = 0;
  for (const [key, entry] of holds) {
    if (now - entry.heldAt > entry.timeoutMs) {
      holds.delete(key);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    log.info(`cleaned up ${cleaned} stale holds`);
  }
  return cleaned;
}

/**
 * Format held results as a readable text block for the orchestrator.
 */
export function formatHeldResults(results: HeldResult[]): string {
  if (results.length === 0) {
    return "No results buffered.";
  }

  return results
    .map((r) => {
      const tag = r.status === "ok" ? "[SUCCESS]" : r.status === "error" ? "[FAILED]" : "[TIMEOUT]";
      const label = r.label ? ` (${r.label})` : "";
      return `${tag}${label} ${r.task}\n${r.findings}`;
    })
    .join("\n\n");
}
