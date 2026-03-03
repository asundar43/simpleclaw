import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { SimpleClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions/types.js";
import {
  resolveProactiveSummaryConfig,
  shouldRunProactiveSummary,
  runProactiveSummary,
} from "./proactive-summary.js";

vi.mock("./compaction.js", () => ({
  estimateMessagesTokens: vi.fn(() => 5000),
  resolveContextWindowTokens: vi.fn(() => 128_000),
  SUMMARIZATION_OVERHEAD_TOKENS: 1000,
  summarizeInStages: vi.fn(async () => "This is a test summary of recent events."),
}));

vi.mock("./session-transcript-repair.js", () => ({
  stripToolResultDetails: vi.fn((msgs: unknown[]) => msgs),
}));

vi.mock("node:fs/promises", () => ({
  default: {
    mkdir: vi.fn(async () => undefined),
    writeFile: vi.fn(async () => undefined),
  },
}));

function makeMessages(count: number): AgentMessage[] {
  const msgs: AgentMessage[] = [];
  for (let i = 0; i < count; i++) {
    msgs.push({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Message ${i}`,
    } as AgentMessage);
  }
  return msgs;
}

describe("resolveProactiveSummaryConfig", () => {
  it("returns undefined when not configured", () => {
    expect(resolveProactiveSummaryConfig(undefined)).toBeUndefined();
    expect(resolveProactiveSummaryConfig({} as SimpleClawConfig)).toBeUndefined();
  });

  it("returns undefined when disabled", () => {
    const cfg = {
      agents: { defaults: { proactiveSummary: { enabled: false } } },
    } as SimpleClawConfig;
    expect(resolveProactiveSummaryConfig(cfg)).toBeUndefined();
  });

  it("returns config when enabled", () => {
    const cfg = {
      agents: {
        defaults: {
          proactiveSummary: {
            enabled: true,
            messageThreshold: 50,
          },
        },
      },
    } as SimpleClawConfig;
    const result = resolveProactiveSummaryConfig(cfg);
    expect(result).toBeDefined();
    expect(result!.messageThreshold).toBe(50);
  });
});

describe("shouldRunProactiveSummary", () => {
  it("returns false with zero messages", () => {
    const result = shouldRunProactiveSummary(undefined, [], { enabled: true });
    expect(result).toBe(false);
  });

  it("returns true when message delta exceeds threshold", () => {
    const messages = makeMessages(120);
    const result = shouldRunProactiveSummary(undefined, messages, {
      enabled: true,
      messageThreshold: 100,
    });
    expect(result).toBe(true);
  });

  it("returns false when delta is below threshold", () => {
    const messages = makeMessages(50);
    const result = shouldRunProactiveSummary(undefined, messages, {
      enabled: true,
      messageThreshold: 100,
    });
    expect(result).toBe(false);
  });

  it("accounts for lastProactiveSummaryMessageCount", () => {
    const messages = makeMessages(150);
    const entry = {
      lastProactiveSummaryMessageCount: 100,
    } as SessionEntry;
    // delta = 150 - 100 = 50, threshold = 100
    const result = shouldRunProactiveSummary(entry, messages, {
      enabled: true,
      messageThreshold: 100,
    });
    expect(result).toBe(false);
  });

  it("uses default threshold of 100", () => {
    const messages = makeMessages(100);
    const result = shouldRunProactiveSummary(undefined, messages, { enabled: true });
    expect(result).toBe(true);
  });

  it("returns false when threshold is 0", () => {
    const messages = makeMessages(200);
    const result = shouldRunProactiveSummary(undefined, messages, {
      enabled: true,
      messageThreshold: 0,
    });
    expect(result).toBe(false);
  });
});

describe("runProactiveSummary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns success false for empty messages", async () => {
    const result = await runProactiveSummary({
      sessionKey: "test-session",
      agentId: "main",
      workspaceDir: "/tmp/test-workspace",
      messages: [],
      config: { enabled: true },
      model: { id: "test-model" } as never,
      apiKey: "test-key",
      signal: AbortSignal.timeout(10_000),
    });
    expect(result.success).toBe(false);
    expect(result.messagesSummarized).toBe(0);
  });

  it("writes summary to the correct directory path", async () => {
    const fsMock = await import("node:fs/promises");
    const messages = makeMessages(120);

    const result = await runProactiveSummary({
      sessionKey: "agent:main:telegram:12345",
      agentId: "main",
      workspaceDir: "/tmp/test-workspace",
      messages,
      config: { enabled: true, maxSummaryTokens: 2048 },
      model: { id: "test-model" } as never,
      apiKey: "test-key",
      signal: AbortSignal.timeout(10_000),
    });

    expect(result.success).toBe(true);
    expect(result.messagesSummarized).toBe(120);
    expect(result.summaryPath).toContain("/memory/summaries/");
    expect(fsMock.default.mkdir).toHaveBeenCalled();
    expect(fsMock.default.writeFile).toHaveBeenCalled();

    // Check the content includes metadata
    const writeCall = vi.mocked(fsMock.default.writeFile).mock.calls[0];
    const content = writeCall[1] as string;
    expect(content).toContain("# Session Summary");
    expect(content).toContain("agent:main:telegram:12345");
  });

  it("includes temporal anchoring in summary prompt", async () => {
    const compaction = await import("./compaction.js");
    const messages = makeMessages(120);

    await runProactiveSummary({
      sessionKey: "test-session",
      agentId: "main",
      workspaceDir: "/tmp/test-workspace",
      messages,
      config: { enabled: true, temporalAnchoring: true },
      model: { id: "test-model" } as never,
      apiKey: "test-key",
      signal: AbortSignal.timeout(10_000),
    });

    const summarizeCall = vi.mocked(compaction.summarizeInStages).mock.calls[0];
    const instructions = (summarizeCall[0] as Record<string, unknown>).customInstructions as string;
    expect(instructions).toContain("Anchor events in time");
    expect(instructions).toContain("relative markers");
  });
});
