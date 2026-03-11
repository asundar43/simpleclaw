/**
 * Migration from local memory-core data to supermemory.
 *
 * Reads session transcripts (*.jsonl) and memory files (MEMORY.md, memory/*.md)
 * and sends them to supermemory via client.add() for automatic memory extraction.
 */

import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import Supermemory from "supermemory";
import { resolveContainerTag } from "./index.js";

export type MigrateOptions = {
  agentId?: string;
  dryRun: boolean;
  verbose: boolean;
  batchSize: number;
  delayMs: number;
};

export type MigrateProgress = {
  sessionsProcessed: number;
  sessionsTotal: number;
  memoryFilesProcessed: number;
  memoryFilesTotal: number;
  apiCalls: number;
  errors: string[];
  skipped: number;
};

type SessionIndexEntry = {
  sessionId?: string;
  sessionFile?: string;
  updatedAt?: number;
};

type SessionIndex = Record<string, SessionIndexEntry>;

const BATCH_DELAY_MS = 1500;
const DEFAULT_BATCH_SIZE = 3;
const MIN_CONTENT_LENGTH = 20;

/**
 * Read a JSONL session file and extract conversation text.
 * Streams line-by-line to handle large files.
 */
export async function extractConversationFromJsonl(filePath: string): Promise<string> {
  const parts: string[] = [];
  const rl = readline.createInterface({
    input: createReadStream(filePath, { encoding: "utf-8" }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") {
      continue;
    }
    const entry = parsed as Record<string, unknown>;
    if (entry.type !== "message") {
      continue;
    }
    const msg = entry.message as Record<string, unknown> | undefined;
    if (!msg) {
      continue;
    }
    const role = msg.role as string;
    if (role !== "user" && role !== "assistant") {
      continue;
    }
    const content = msg.content;
    if (typeof content === "string" && content.trim()) {
      parts.push(`${role}: ${content.trim()}`);
      continue;
    }
    if (Array.isArray(content)) {
      for (const block of content) {
        if (
          block &&
          typeof block === "object" &&
          "type" in block &&
          (block as Record<string, unknown>).type === "text" &&
          "text" in block &&
          typeof (block as Record<string, unknown>).text === "string"
        ) {
          const text = ((block as Record<string, unknown>).text as string).trim();
          if (text) {
            parts.push(`${role}: ${text}`);
          }
        }
      }
    }
  }
  return parts.join("\n");
}

/**
 * List memory markdown files in the agent workspace.
 */
async function listMemoryFiles(workspaceDir: string): Promise<string[]> {
  const files: string[] = [];

  // Check MEMORY.md and memory.md (deduplicate on case-insensitive filesystems)
  const seenInodes = new Set<number>();
  for (const name of ["MEMORY.md", "memory.md"]) {
    const filePath = path.join(workspaceDir, name);
    try {
      const stat = await fs.stat(filePath);
      if (stat.isFile() && !seenInodes.has(stat.ino)) {
        seenInodes.add(stat.ino);
        files.push(filePath);
      }
    } catch {
      // File doesn't exist
    }
  }

  // Check memory/*.md directory
  const memoryDir = path.join(workspaceDir, "memory");
  try {
    const entries = await fs.readdir(memoryDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push(path.join(memoryDir, entry.name));
      }
    }
  } catch {
    // Directory doesn't exist
  }

  return files;
}

/**
 * Load the sessions.json index for an agent.
 */
async function loadSessionIndex(sessionsDir: string): Promise<SessionIndex> {
  const indexPath = path.join(sessionsDir, "sessions.json");
  try {
    const raw = await fs.readFile(indexPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed as SessionIndex;
  } catch {
    return {};
  }
}

/**
 * Process items in batches with delay between batches.
 */
async function processBatches<T>(
  items: T[],
  batchSize: number,
  delayMs: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    await Promise.all(batch.map(fn));
    if (i + batchSize < items.length) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

export type MigrateAgentParams = {
  client: Supermemory;
  agentId: string;
  sessionsDir: string;
  workspaceDir: string;
  containerTagPrefix?: string;
  entityContext?: string;
  options: MigrateOptions;
  log: (msg: string) => void;
};

/**
 * Migrate a single agent's data to supermemory.
 */
export async function migrateAgent(params: MigrateAgentParams): Promise<MigrateProgress> {
  const { client, agentId, sessionsDir, workspaceDir, options, log } = params;
  const progress: MigrateProgress = {
    sessionsProcessed: 0,
    sessionsTotal: 0,
    memoryFilesProcessed: 0,
    memoryFilesTotal: 0,
    apiCalls: 0,
    errors: [],
    skipped: 0,
  };

  const batchSize = options.batchSize || DEFAULT_BATCH_SIZE;
  const delayMs = options.delayMs || BATCH_DELAY_MS;

  // ========================================================================
  // Phase 1: Session transcripts
  // ========================================================================

  const sessionIndex = await loadSessionIndex(sessionsDir);
  const sessionEntries = Object.entries(sessionIndex);
  progress.sessionsTotal = sessionEntries.length;

  if (sessionEntries.length > 0) {
    log(`Found ${sessionEntries.length} sessions to migrate`);
  }

  type SessionJob = {
    sessionKey: string;
    entry: SessionIndexEntry;
    filePath: string;
    containerTag: string;
  };

  const sessionJobs: SessionJob[] = [];
  for (const [sessionKey, entry] of sessionEntries) {
    if (!entry.sessionId) {
      progress.skipped++;
      continue;
    }
    const containerTag = resolveContainerTag(sessionKey, params.containerTagPrefix);
    if (!containerTag) {
      if (options.verbose) {
        log(`  skip ${sessionKey} (no container tag)`);
      }
      progress.skipped++;
      continue;
    }
    const fileName = entry.sessionFile || `${entry.sessionId}.jsonl`;
    const filePath = path.join(sessionsDir, fileName);
    sessionJobs.push({ sessionKey, entry, filePath, containerTag });
  }

  await processBatches(sessionJobs, batchSize, delayMs, async (job) => {
    try {
      await fs.access(job.filePath);
    } catch {
      if (options.verbose) {
        log(`  skip ${job.entry.sessionId} (file missing)`);
      }
      progress.skipped++;
      return;
    }

    const conversationText = await extractConversationFromJsonl(job.filePath);
    if (conversationText.length < MIN_CONTENT_LENGTH) {
      if (options.verbose) {
        log(`  skip ${job.entry.sessionId} (too short: ${conversationText.length} chars)`);
      }
      progress.skipped++;
      return;
    }

    if (options.dryRun) {
      log(
        `  [dry-run] session ${job.entry.sessionId} → ${job.containerTag} (${conversationText.length} chars)`,
      );
      progress.sessionsProcessed++;
      return;
    }

    try {
      await client.add({
        content: conversationText,
        containerTag: job.containerTag,
        customId: `migrate_session_${job.entry.sessionId}`,
        ...(params.entityContext ? { entityContext: params.entityContext } : {}),
        metadata: {
          source: "migration",
          ...(job.entry.sessionId ? { sessionId: job.entry.sessionId } : {}),
        },
      });
      progress.apiCalls++;
      progress.sessionsProcessed++;
      if (options.verbose) {
        log(`  migrated session ${job.entry.sessionId} → ${job.containerTag}`);
      }
    } catch (err) {
      const msg = `session ${job.entry.sessionId}: ${err instanceof Error ? err.message : String(err)}`;
      progress.errors.push(msg);
      if (options.verbose) {
        log(`  error: ${msg}`);
      }
    }
  });

  // ========================================================================
  // Phase 2: Memory files (MEMORY.md, memory/*.md)
  // ========================================================================

  const memoryFiles = await listMemoryFiles(workspaceDir);
  progress.memoryFilesTotal = memoryFiles.length;

  if (memoryFiles.length > 0) {
    log(`Found ${memoryFiles.length} memory files to migrate`);
  }

  const globalTag = `${agentId}_global`;

  await processBatches(memoryFiles, batchSize, delayMs, async (filePath) => {
    const content = await fs.readFile(filePath, "utf-8");
    if (content.trim().length < MIN_CONTENT_LENGTH) {
      if (options.verbose) {
        log(`  skip ${path.basename(filePath)} (too short)`);
      }
      progress.skipped++;
      return;
    }

    const filename = path.basename(filePath);

    if (options.dryRun) {
      log(`  [dry-run] ${filename} → ${globalTag} (${content.length} chars)`);
      progress.memoryFilesProcessed++;
      return;
    }

    try {
      await client.add({
        content,
        containerTag: globalTag,
        customId: `migrate_memory_${agentId}_${filename}`,
        ...(params.entityContext ? { entityContext: params.entityContext } : {}),
        metadata: {
          source: "migration",
          file: filename,
        },
      });
      progress.apiCalls++;
      progress.memoryFilesProcessed++;
      if (options.verbose) {
        log(`  migrated ${filename} → ${globalTag}`);
      }
    } catch (err) {
      const msg = `${filename}: ${err instanceof Error ? err.message : String(err)}`;
      progress.errors.push(msg);
      if (options.verbose) {
        log(`  error: ${msg}`);
      }
    }
  });

  return progress;
}
