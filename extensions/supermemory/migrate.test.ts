import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { extractConversationFromJsonl, migrateAgent } from "./migrate.js";
import type { MigrateAgentParams } from "./migrate.js";

// ============================================================================
// extractConversationFromJsonl
// ============================================================================

describe("extractConversationFromJsonl", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "supermemory-migrate-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("extracts user and assistant messages from JSONL", async () => {
    const lines = [
      JSON.stringify({ type: "session", version: 4, id: "abc" }),
      JSON.stringify({ type: "message", message: { role: "user", content: "Hello there" } }),
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: "Hi! How can I help?" },
      }),
      JSON.stringify({ type: "message", message: { role: "user", content: "Tell me a joke" } }),
    ];
    const filePath = path.join(tmpDir, "test.jsonl");
    await fs.writeFile(filePath, lines.join("\n"));

    const result = await extractConversationFromJsonl(filePath);
    expect(result).toBe("user: Hello there\nassistant: Hi! How can I help?\nuser: Tell me a joke");
  });

  test("handles array content blocks", async () => {
    const lines = [
      JSON.stringify({
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: "Array content" }],
        },
      }),
    ];
    const filePath = path.join(tmpDir, "array.jsonl");
    await fs.writeFile(filePath, lines.join("\n"));

    const result = await extractConversationFromJsonl(filePath);
    expect(result).toBe("user: Array content");
  });

  test("skips non-message lines", async () => {
    const lines = [
      JSON.stringify({ type: "session", version: 4 }),
      JSON.stringify({ type: "compaction", data: "something" }),
      JSON.stringify({ type: "message", message: { role: "system", content: "System msg" } }),
      JSON.stringify({ type: "message", message: { role: "user", content: "Real message" } }),
    ];
    const filePath = path.join(tmpDir, "mixed.jsonl");
    await fs.writeFile(filePath, lines.join("\n"));

    const result = await extractConversationFromJsonl(filePath);
    expect(result).toBe("user: Real message");
  });

  test("handles empty file", async () => {
    const filePath = path.join(tmpDir, "empty.jsonl");
    await fs.writeFile(filePath, "");

    const result = await extractConversationFromJsonl(filePath);
    expect(result).toBe("");
  });

  test("handles malformed JSON lines gracefully", async () => {
    const lines = [
      "not valid json",
      JSON.stringify({ type: "message", message: { role: "user", content: "Valid" } }),
      "{ broken",
    ];
    const filePath = path.join(tmpDir, "broken.jsonl");
    await fs.writeFile(filePath, lines.join("\n"));

    const result = await extractConversationFromJsonl(filePath);
    expect(result).toBe("user: Valid");
  });
});

// ============================================================================
// migrateAgent
// ============================================================================

describe("migrateAgent", () => {
  let tmpDir: string;
  let sessionsDir: string;
  let workspaceDir: string;
  // oxlint-disable-next-line typescript/no-explicit-any
  let addMock: ReturnType<typeof vi.fn<any>>;
  // oxlint-disable-next-line typescript/no-explicit-any
  let mockClient: any;
  let logs: string[];

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "supermemory-migrate-test-"));
    sessionsDir = path.join(tmpDir, "sessions");
    workspaceDir = path.join(tmpDir, "workspace");
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.mkdir(workspaceDir, { recursive: true });

    addMock = vi.fn().mockResolvedValue({ id: "doc-1" });
    mockClient = { add: addMock };
    logs = [];
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function createParams(overrides?: Partial<MigrateAgentParams>): MigrateAgentParams {
    return {
      client: mockClient,
      agentId: "main",
      sessionsDir,
      workspaceDir,
      options: {
        dryRun: false,
        verbose: false,
        batchSize: 3,
        delayMs: 0,
      },
      log: (msg) => logs.push(msg),
      ...overrides,
    };
  }

  async function writeSessionIndex(index: Record<string, unknown>) {
    await fs.writeFile(path.join(sessionsDir, "sessions.json"), JSON.stringify(index));
  }

  async function writeSessionFile(
    filename: string,
    messages: Array<{ role: string; content: string }>,
  ) {
    const lines = messages.map((msg) =>
      JSON.stringify({ type: "message", message: { role: msg.role, content: msg.content } }),
    );
    await fs.writeFile(path.join(sessionsDir, filename), lines.join("\n"));
  }

  test("migrates session transcripts with correct container tags", async () => {
    await writeSessionIndex({
      "agent:main:telegram:direct:12345": {
        sessionId: "sess-001",
        updatedAt: Date.now(),
      },
    });
    await writeSessionFile("sess-001.jsonl", [
      { role: "user", content: "I prefer dark mode" },
      { role: "assistant", content: "Noted, I'll remember that preference." },
    ]);

    const result = await migrateAgent(createParams());

    expect(result.sessionsProcessed).toBe(1);
    expect(result.sessionsTotal).toBe(1);
    expect(result.apiCalls).toBe(1);
    expect(addMock).toHaveBeenCalledWith(
      expect.objectContaining({
        containerTag: "main_telegram_direct_12345",
        customId: "migrate_session_sess-001",
        metadata: expect.objectContaining({ source: "migration" }),
      }),
    );
  });

  test("skips sessions with missing JSONL files", async () => {
    await writeSessionIndex({
      "agent:main:telegram:direct:99999": {
        sessionId: "missing-session",
        updatedAt: Date.now(),
      },
    });

    const result = await migrateAgent(
      createParams({ options: { dryRun: false, verbose: true, batchSize: 3, delayMs: 0 } }),
    );

    expect(result.sessionsProcessed).toBe(0);
    expect(result.skipped).toBe(1);
    expect(addMock).not.toHaveBeenCalled();
  });

  test("skips sessions with too-short content", async () => {
    await writeSessionIndex({
      "agent:main:telegram:direct:12345": {
        sessionId: "short-sess",
        updatedAt: Date.now(),
      },
    });
    await writeSessionFile("short-sess.jsonl", [{ role: "user", content: "hi" }]);

    const result = await migrateAgent(createParams());

    expect(result.sessionsProcessed).toBe(0);
    expect(result.skipped).toBe(1);
    expect(addMock).not.toHaveBeenCalled();
  });

  test("skips sessions with invalid session keys (no container tag)", async () => {
    await writeSessionIndex({
      "main:telegram:direct:12345": {
        sessionId: "no-prefix",
        updatedAt: Date.now(),
      },
    });

    const result = await migrateAgent(createParams());

    expect(result.sessionsProcessed).toBe(0);
    expect(result.skipped).toBe(1);
  });

  test("migrates MEMORY.md files", async () => {
    await fs.writeFile(
      path.join(workspaceDir, "MEMORY.md"),
      "# User Preferences\n\n- Prefers dark mode\n- Timezone: PST\n- Favorite color: blue",
    );

    // No sessions
    await writeSessionIndex({});

    const result = await migrateAgent(createParams());

    expect(result.memoryFilesProcessed).toBe(1);
    expect(result.memoryFilesTotal).toBe(1);
    expect(addMock).toHaveBeenCalledWith(
      expect.objectContaining({
        containerTag: "main_global",
        customId: "migrate_memory_main_MEMORY.md",
        metadata: expect.objectContaining({ source: "migration", file: "MEMORY.md" }),
      }),
    );
  });

  test("migrates memory/*.md files", async () => {
    const memDir = path.join(workspaceDir, "memory");
    await fs.mkdir(memDir, { recursive: true });
    await fs.writeFile(
      path.join(memDir, "notes.md"),
      "# Notes\n\nUser mentioned they work at Acme Corp as a senior engineer.",
    );

    await writeSessionIndex({});

    const result = await migrateAgent(createParams());

    expect(result.memoryFilesProcessed).toBe(1);
    expect(addMock).toHaveBeenCalledWith(
      expect.objectContaining({
        containerTag: "main_global",
        customId: "migrate_memory_main_notes.md",
      }),
    );
  });

  test("dry-run mode skips API calls", async () => {
    await writeSessionIndex({
      "agent:main:telegram:direct:12345": {
        sessionId: "sess-dry",
        updatedAt: Date.now(),
      },
    });
    await writeSessionFile("sess-dry.jsonl", [
      { role: "user", content: "This is a test message for dry run" },
    ]);
    await fs.writeFile(
      path.join(workspaceDir, "MEMORY.md"),
      "# Memory\n\nSome important facts about the user.",
    );

    const result = await migrateAgent(
      createParams({
        options: { dryRun: true, verbose: false, batchSize: 3, delayMs: 0 },
      }),
    );

    expect(result.sessionsProcessed).toBe(1);
    expect(result.memoryFilesProcessed).toBe(1);
    expect(result.apiCalls).toBe(0);
    expect(addMock).not.toHaveBeenCalled();
  });

  test("handles API errors gracefully", async () => {
    addMock.mockRejectedValueOnce(new Error("Rate limited"));

    await writeSessionIndex({
      "agent:main:telegram:direct:12345": {
        sessionId: "sess-err",
        updatedAt: Date.now(),
      },
    });
    await writeSessionFile("sess-err.jsonl", [
      { role: "user", content: "This message will trigger an API error" },
    ]);

    const result = await migrateAgent(createParams());

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("Rate limited");
    expect(result.sessionsProcessed).toBe(0);
  });

  test("uses customId for deduplication", async () => {
    await writeSessionIndex({
      "agent:main:telegram:direct:12345": {
        sessionId: "sess-dedup",
        updatedAt: Date.now(),
      },
    });
    await writeSessionFile("sess-dedup.jsonl", [
      { role: "user", content: "First run of migration for this session" },
    ]);

    // Run migration twice
    await migrateAgent(createParams());
    await migrateAgent(createParams());

    // Both calls should use the same customId for dedup
    const calls = addMock.mock.calls as Array<Array<Record<string, unknown>>>;
    expect(calls[0][0].customId).toBe("migrate_session_sess-dedup");
    expect(calls[1][0].customId).toBe("migrate_session_sess-dedup");
  });

  test("uses sessionFile field when available", async () => {
    await writeSessionIndex({
      "agent:main:discord:direct:abc": {
        sessionId: "sess-custom-file",
        sessionFile: "custom-path.jsonl",
        updatedAt: Date.now(),
      },
    });
    await writeSessionFile("custom-path.jsonl", [
      { role: "user", content: "This session uses a custom file path" },
    ]);

    const result = await migrateAgent(createParams());

    expect(result.sessionsProcessed).toBe(1);
    expect(addMock).toHaveBeenCalledWith(
      expect.objectContaining({
        containerTag: "main_discord_direct_abc",
      }),
    );
  });

  test("applies containerTagPrefix when configured", async () => {
    await writeSessionIndex({
      "agent:main:telegram:direct:12345": {
        sessionId: "sess-prefix",
        updatedAt: Date.now(),
      },
    });
    await writeSessionFile("sess-prefix.jsonl", [
      { role: "user", content: "Test with container tag prefix applied" },
    ]);

    const result = await migrateAgent(createParams({ containerTagPrefix: "myapp" }));

    expect(result.sessionsProcessed).toBe(1);
    expect(addMock).toHaveBeenCalledWith(
      expect.objectContaining({
        containerTag: "myapp_main_telegram_direct_12345",
      }),
    );
  });

  test("handles empty sessions.json gracefully", async () => {
    // No sessions.json file at all

    const result = await migrateAgent(createParams());

    expect(result.sessionsTotal).toBe(0);
    expect(result.sessionsProcessed).toBe(0);
    expect(addMock).not.toHaveBeenCalled();
  });

  test("handles no memory files gracefully", async () => {
    await writeSessionIndex({});

    const result = await migrateAgent(createParams());

    expect(result.memoryFilesTotal).toBe(0);
    expect(result.memoryFilesProcessed).toBe(0);
  });

  test("passes entityContext when configured", async () => {
    await writeSessionIndex({
      "agent:main:telegram:direct:12345": {
        sessionId: "sess-ctx",
        updatedAt: Date.now(),
      },
    });
    await writeSessionFile("sess-ctx.jsonl", [
      { role: "user", content: "Message with entity context configured" },
    ]);

    await migrateAgent(createParams({ entityContext: "Personal AI assistant for daily tasks" }));

    expect(addMock).toHaveBeenCalledWith(
      expect.objectContaining({
        entityContext: "Personal AI assistant for daily tasks",
      }),
    );
  });
});
