import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { loadJsonFile, saveJsonFile } from "../infra/json-file.js";
import type { RosterEntry } from "./subagent-roster.js";

type PersistedRoster = {
  version: 1;
  entries: Record<string, RosterEntry>;
};

function resolveRosterStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.SIMPLECLAW_STATE_DIR?.trim();
  if (explicit) {
    return resolveStateDir(env);
  }
  if (env.VITEST || env.NODE_ENV === "test") {
    return path.join(os.tmpdir(), "simpleclaw-test-state", String(process.pid));
  }
  return resolveStateDir(env);
}

export function resolveRosterPath(): string {
  return path.join(resolveRosterStateDir(process.env), "subagents", "roster.json");
}

export function loadRosterFromDisk(): Map<string, RosterEntry> {
  const pathname = resolveRosterPath();
  const raw = loadJsonFile(pathname);
  if (!raw || typeof raw !== "object") {
    return new Map();
  }
  const record = raw as Partial<PersistedRoster>;
  if (record.version !== 1) {
    return new Map();
  }
  const entriesRaw = record.entries;
  if (!entriesRaw || typeof entriesRaw !== "object") {
    return new Map();
  }
  const out = new Map<string, RosterEntry>();
  for (const [key, entry] of Object.entries(entriesRaw)) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    if (typeof entry.name !== "string" || typeof entry.sessionKey !== "string") {
      continue;
    }
    out.set(key, entry);
  }
  return out;
}

export function saveRosterToDisk(entries: Map<string, RosterEntry>) {
  const pathname = resolveRosterPath();
  const serialized: Record<string, RosterEntry> = {};
  for (const [key, entry] of entries.entries()) {
    serialized[key] = entry;
  }
  const out: PersistedRoster = {
    version: 1,
    entries: serialized,
  };
  saveJsonFile(pathname, out);
}
