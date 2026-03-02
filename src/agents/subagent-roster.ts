/**
 * Named Agent Roster — maps human-readable names to persistent subagent sessions.
 *
 * Same name + same requester = same session key = conversation continuity.
 * Roster entries survive gateway restarts via disk persistence.
 */

import { loadRosterFromDisk, saveRosterToDisk } from "./subagent-roster-store.js";

export type RosterEntry = {
  /** Human-readable name, unique per requester. */
  name: string;
  /** Target agent ID (e.g. "main"). */
  agentId: string;
  /** Persistent child session key (reused across spawns). */
  sessionKey: string;
  /** Requester session key that owns this roster entry. */
  requesterSessionKey: string;
  /** Model override applied at spawn time. */
  model?: string;
  /** When the entry was first created. */
  createdAt: number;
  /** Last time a run was started on this named agent. */
  lastActiveAt: number;
  /** Current lifecycle status. */
  status: "idle" | "running";
  /** Run ID of the currently active run (when status === "running"). */
  currentRunId?: string;
};

export type RosterSnapshot = {
  name: string;
  agentId: string;
  sessionKey: string;
  status: "idle" | "running";
  model?: string;
  currentRunId?: string;
  createdAt: number;
  lastActiveAt: number;
};

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

/** Keyed by `${requesterSessionKey}\0${normalizedName}`. */
let roster = new Map<string, RosterEntry>();
let loaded = false;

function rosterKey(requesterSessionKey: string, name: string): string {
  return `${requesterSessionKey}\0${name.trim().toLowerCase()}`;
}

function ensureLoaded() {
  if (!loaded) {
    roster = loadRosterFromDisk();
    loaded = true;
  }
}

function persist() {
  try {
    saveRosterToDisk(roster);
  } catch {
    // Best-effort persistence; in-memory state is canonical at runtime.
  }
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/**
 * Register or return an existing named agent for a requester.
 * Returns the roster entry (existing or newly created).
 */
export function registerNamedAgent(params: {
  name: string;
  agentId: string;
  sessionKey: string;
  requesterSessionKey: string;
  model?: string;
  runId: string;
}): RosterEntry {
  ensureLoaded();
  const key = rosterKey(params.requesterSessionKey, params.name);
  const now = Date.now();
  const entry: RosterEntry = {
    name: params.name.trim(),
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    requesterSessionKey: params.requesterSessionKey,
    model: params.model,
    createdAt: now,
    lastActiveAt: now,
    status: "running",
    currentRunId: params.runId,
  };
  roster.set(key, entry);
  persist();
  return entry;
}

/** Look up an existing roster entry by name for a given requester. */
export function lookupNamedAgent(
  requesterSessionKey: string,
  name: string,
): RosterEntry | undefined {
  ensureLoaded();
  return roster.get(rosterKey(requesterSessionKey, name));
}

/** Mark a named agent as running with a new run ID. */
export function markNamedAgentRunning(
  requesterSessionKey: string,
  name: string,
  runId: string,
): boolean {
  ensureLoaded();
  const key = rosterKey(requesterSessionKey, name);
  const entry = roster.get(key);
  if (!entry) {
    return false;
  }
  entry.status = "running";
  entry.currentRunId = runId;
  entry.lastActiveAt = Date.now();
  persist();
  return true;
}

/** Mark a named agent as idle (run completed). */
export function markNamedAgentIdle(requesterSessionKey: string, name: string): boolean {
  ensureLoaded();
  const key = rosterKey(requesterSessionKey, name);
  const entry = roster.get(key);
  if (!entry) {
    return false;
  }
  entry.status = "idle";
  entry.currentRunId = undefined;
  persist();
  return true;
}

/**
 * Mark a named agent idle by its session key (used when a run completes
 * and we only know the childSessionKey, not the roster name directly).
 */
export function markNamedAgentIdleBySessionKey(childSessionKey: string): boolean {
  ensureLoaded();
  for (const entry of roster.values()) {
    if (entry.sessionKey === childSessionKey && entry.status === "running") {
      entry.status = "idle";
      entry.currentRunId = undefined;
      persist();
      return true;
    }
  }
  return false;
}

/** Remove a named agent from the roster. */
export function retireNamedAgent(requesterSessionKey: string, name: string): boolean {
  ensureLoaded();
  const key = rosterKey(requesterSessionKey, name);
  if (!roster.has(key)) {
    return false;
  }
  roster.delete(key);
  persist();
  return true;
}

/** List all roster entries for a requester. */
export function listRoster(requesterSessionKey: string): RosterSnapshot[] {
  ensureLoaded();
  const results: RosterSnapshot[] = [];
  for (const entry of roster.values()) {
    if (entry.requesterSessionKey === requesterSessionKey) {
      results.push({
        name: entry.name,
        agentId: entry.agentId,
        sessionKey: entry.sessionKey,
        status: entry.status,
        model: entry.model,
        currentRunId: entry.currentRunId,
        createdAt: entry.createdAt,
        lastActiveAt: entry.lastActiveAt,
      });
    }
  }
  return results.toSorted((a, b) => a.name.localeCompare(b.name));
}

/** Count roster entries for a requester. */
export function countRosterEntries(requesterSessionKey: string): number {
  ensureLoaded();
  let count = 0;
  for (const entry of roster.values()) {
    if (entry.requesterSessionKey === requesterSessionKey) {
      count++;
    }
  }
  return count;
}

/** Look up the roster name for a given child session key (reverse lookup). */
export function getRosterNameForSession(childSessionKey: string): string | undefined {
  ensureLoaded();
  for (const entry of roster.values()) {
    if (entry.sessionKey === childSessionKey) {
      return entry.name;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

export function resetRosterForTests() {
  roster = new Map();
  loaded = true; // prevent disk load in tests
}
