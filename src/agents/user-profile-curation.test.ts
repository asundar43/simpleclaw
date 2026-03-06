import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { SimpleClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions/types.js";
import {
  resolveUserProfileCurationConfig,
  shouldRunUserProfileCuration,
  runUserProfileCuration,
} from "./user-profile-curation.js";

vi.mock("./compaction.js", () => ({
  estimateMessagesTokens: vi.fn(() => 5000),
  resolveContextWindowTokens: vi.fn(() => 128_000),
  SUMMARIZATION_OVERHEAD_TOKENS: 1000,
  summarizeInStages: vi.fn(async () => "# About the User\n\n## Identity\n- **Name:** Alice\n"),
}));

vi.mock("./session-transcript-repair.js", () => ({
  stripToolResultDetails: vi.fn((msgs: unknown[]) => msgs),
}));

vi.mock("node:fs/promises", () => ({
  default: {
    readFile: vi.fn(async () => {
      throw new Error("ENOENT");
    }),
    writeFile: vi.fn(async () => undefined),
    rename: vi.fn(async () => undefined),
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

describe("resolveUserProfileCurationConfig", () => {
  it("returns undefined when not configured", () => {
    expect(resolveUserProfileCurationConfig(undefined)).toBeUndefined();
    expect(resolveUserProfileCurationConfig({} as SimpleClawConfig)).toBeUndefined();
  });

  it("returns undefined when disabled", () => {
    const cfg = {
      agents: { defaults: { userProfileCuration: { enabled: false } } },
    } as SimpleClawConfig;
    expect(resolveUserProfileCurationConfig(cfg)).toBeUndefined();
  });

  it("returns config when enabled", () => {
    const cfg = {
      agents: {
        defaults: {
          userProfileCuration: {
            enabled: true,
            messageThreshold: 50,
          },
        },
      },
    } as SimpleClawConfig;
    const result = resolveUserProfileCurationConfig(cfg);
    expect(result).toBeDefined();
    expect(result!.messageThreshold).toBe(50);
  });
});

describe("shouldRunUserProfileCuration", () => {
  it("returns false with zero messages", () => {
    const result = shouldRunUserProfileCuration(undefined, [], { enabled: true });
    expect(result).toBe(false);
  });

  it("returns true when message delta exceeds threshold", () => {
    const messages = makeMessages(120);
    const result = shouldRunUserProfileCuration(undefined, messages, {
      enabled: true,
      messageThreshold: 100,
    });
    expect(result).toBe(true);
  });

  it("returns false when delta is below threshold", () => {
    const messages = makeMessages(50);
    const result = shouldRunUserProfileCuration(undefined, messages, {
      enabled: true,
      messageThreshold: 100,
    });
    expect(result).toBe(false);
  });

  it("accounts for lastUserProfileCurationMessageCount", () => {
    const messages = makeMessages(150);
    const entry = {
      lastUserProfileCurationMessageCount: 100,
    } as SessionEntry;
    // delta = 150 - 100 = 50, threshold = 100
    const result = shouldRunUserProfileCuration(entry, messages, {
      enabled: true,
      messageThreshold: 100,
    });
    expect(result).toBe(false);
  });

  it("uses default threshold of 100", () => {
    const messages = makeMessages(100);
    const result = shouldRunUserProfileCuration(undefined, messages, { enabled: true });
    expect(result).toBe(true);
  });

  it("returns false when threshold is 0", () => {
    const messages = makeMessages(200);
    const result = shouldRunUserProfileCuration(undefined, messages, {
      enabled: true,
      messageThreshold: 0,
    });
    expect(result).toBe(false);
  });
});

describe("runUserProfileCuration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns success false for empty messages", async () => {
    const result = await runUserProfileCuration({
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
    expect(result.messagesCurated).toBe(0);
    expect(result.profileUpdated).toBe(false);
  });

  it("writes updated USER.md when profile changes are detected", async () => {
    const fsMock = await import("node:fs/promises");
    const messages = makeMessages(120);

    const result = await runUserProfileCuration({
      sessionKey: "agent:main:telegram:12345",
      agentId: "main",
      workspaceDir: "/tmp/test-workspace",
      messages,
      config: { enabled: true },
      model: { id: "test-model" } as never,
      apiKey: "test-key",
      signal: AbortSignal.timeout(10_000),
    });

    expect(result.success).toBe(true);
    expect(result.profileUpdated).toBe(true);
    expect(result.messagesCurated).toBe(120);
    expect(result.userMdPath).toContain("USER.md");
    // Atomic write: writeFile to tmp, then rename
    expect(fsMock.default.writeFile).toHaveBeenCalled();
    expect(fsMock.default.rename).toHaveBeenCalled();
  });

  it("uses existing USER.md as previous summary input", async () => {
    const fsMock = await import("node:fs/promises");
    const compaction = await import("./compaction.js");
    const existingProfile = "# About the User\n\n## Identity\n- **Name:** Bob\n";
    vi.mocked(fsMock.default.readFile).mockResolvedValueOnce(existingProfile);

    const messages = makeMessages(120);

    await runUserProfileCuration({
      sessionKey: "test-session",
      agentId: "main",
      workspaceDir: "/tmp/test-workspace",
      messages,
      config: { enabled: true },
      model: { id: "test-model" } as never,
      apiKey: "test-key",
      signal: AbortSignal.timeout(10_000),
    });

    const summarizeCall = vi.mocked(compaction.summarizeInStages).mock.calls[0];
    const params = summarizeCall[0] as Record<string, unknown>;
    expect(params.previousSummary).toBe(existingProfile);
  });

  it("uses default template when no USER.md exists", async () => {
    const compaction = await import("./compaction.js");
    const messages = makeMessages(120);

    await runUserProfileCuration({
      sessionKey: "test-session",
      agentId: "main",
      workspaceDir: "/tmp/test-workspace",
      messages,
      config: { enabled: true },
      model: { id: "test-model" } as never,
      apiKey: "test-key",
      signal: AbortSignal.timeout(10_000),
    });

    const summarizeCall = vi.mocked(compaction.summarizeInStages).mock.calls[0];
    const params = summarizeCall[0] as Record<string, unknown>;
    expect(params.previousSummary).toContain("# About the User");
    expect(params.previousSummary).toContain("## Identity");
  });

  it("passes curation instructions as customInstructions", async () => {
    const compaction = await import("./compaction.js");
    const messages = makeMessages(120);

    await runUserProfileCuration({
      sessionKey: "test-session",
      agentId: "main",
      workspaceDir: "/tmp/test-workspace",
      messages,
      config: { enabled: true },
      model: { id: "test-model" } as never,
      apiKey: "test-key",
      signal: AbortSignal.timeout(10_000),
    });

    const summarizeCall = vi.mocked(compaction.summarizeInStages).mock.calls[0];
    const params = summarizeCall[0] as Record<string, unknown>;
    const instructions = params.customInstructions as string;
    expect(instructions).toContain("personal profile curator");
    expect(instructions).toContain("MERGE, don't replace");
    expect(instructions).toContain("section headers");
  });

  it("skips write when profile is unchanged", async () => {
    const fsMock = await import("node:fs/promises");
    const compaction = await import("./compaction.js");
    const existingProfile = "# About the User\n\n## Identity\n- **Name:** Alice\n";
    vi.mocked(fsMock.default.readFile).mockResolvedValueOnce(existingProfile);
    vi.mocked(compaction.summarizeInStages).mockResolvedValueOnce(existingProfile);

    const messages = makeMessages(120);

    const result = await runUserProfileCuration({
      sessionKey: "test-session",
      agentId: "main",
      workspaceDir: "/tmp/test-workspace",
      messages,
      config: { enabled: true },
      model: { id: "test-model" } as never,
      apiKey: "test-key",
      signal: AbortSignal.timeout(10_000),
    });

    expect(result.success).toBe(true);
    expect(result.profileUpdated).toBe(false);
    expect(fsMock.default.writeFile).not.toHaveBeenCalled();
    expect(fsMock.default.rename).not.toHaveBeenCalled();
  });
});
