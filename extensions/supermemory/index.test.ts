import { describe, test, expect, beforeEach } from "vitest";
import { supermemoryConfigSchema } from "./config.js";
import { resolveContainerTag } from "./index.js";

// ============================================================================
// Config Schema Tests
// ============================================================================

describe("supermemory config schema", () => {
  test("parses valid config with defaults", () => {
    const config = supermemoryConfigSchema.parse({
      apiKey: "sm_test_key",
    });

    expect(config.apiKey).toBe("sm_test_key");
    expect(config.autoRecall).toBe(true);
    expect(config.autoCapture).toBe(true);
    expect(config.filterPrompt).toBeUndefined();
    expect(config.containerTagPrefix).toBeUndefined();
    expect(config.entityContext).toBeUndefined();
  });

  test("parses full config", () => {
    const config = supermemoryConfigSchema.parse({
      apiKey: "sm_full_key",
      autoRecall: false,
      autoCapture: false,
      filterPrompt: "Prioritize user preferences and habits.",
      containerTagPrefix: "myapp",
      entityContext: "Personal AI assistant context",
    });

    expect(config.apiKey).toBe("sm_full_key");
    expect(config.autoRecall).toBe(false);
    expect(config.autoCapture).toBe(false);
    expect(config.filterPrompt).toBe("Prioritize user preferences and habits.");
    expect(config.containerTagPrefix).toBe("myapp");
    expect(config.entityContext).toBe("Personal AI assistant context");
  });

  test("resolves env vars in apiKey", () => {
    process.env.TEST_SUPERMEMORY_KEY = "sm_env_resolved";

    const config = supermemoryConfigSchema.parse({
      apiKey: "${TEST_SUPERMEMORY_KEY}",
    });

    expect(config.apiKey).toBe("sm_env_resolved");
    delete process.env.TEST_SUPERMEMORY_KEY;
  });

  test("throws on missing env var", () => {
    delete process.env.NONEXISTENT_KEY;
    expect(() => {
      supermemoryConfigSchema.parse({
        apiKey: "${NONEXISTENT_KEY}",
      });
    }).toThrow("Environment variable NONEXISTENT_KEY is not set");
  });

  test("accepts missing apiKey (resolved later from env/gcloud)", () => {
    const config = supermemoryConfigSchema.parse({});
    expect(config.apiKey).toBe("");
  });

  test("accepts empty apiKey (resolved later from env/gcloud)", () => {
    const config = supermemoryConfigSchema.parse({ apiKey: "   " });
    expect(config.apiKey).toBe("");
  });

  test("returns defaults for undefined/null config", () => {
    const fromUndefined = supermemoryConfigSchema.parse(undefined);
    expect(fromUndefined.apiKey).toBe("");
    expect(fromUndefined.autoRecall).toBe(true);
    expect(fromUndefined.autoCapture).toBe(true);

    const fromNull = supermemoryConfigSchema.parse(null);
    expect(fromNull.apiKey).toBe("");
    expect(fromNull.autoRecall).toBe(true);
    expect(fromNull.autoCapture).toBe(true);
  });

  test("rejects non-object config", () => {
    expect(() => supermemoryConfigSchema.parse("string")).toThrow(
      "supermemory config must be an object",
    );
    expect(() => supermemoryConfigSchema.parse([1, 2])).toThrow(
      "supermemory config must be an object",
    );
  });

  test("rejects unknown keys", () => {
    expect(() => {
      supermemoryConfigSchema.parse({
        apiKey: "sm_test",
        unknownField: true,
      });
    }).toThrow("unknown keys: unknownField");
  });

  test("trims whitespace from string fields", () => {
    const config = supermemoryConfigSchema.parse({
      apiKey: "sm_test",
      filterPrompt: "  some prompt  ",
      containerTagPrefix: "  prefix  ",
      entityContext: "  context  ",
    });

    expect(config.filterPrompt).toBe("some prompt");
    expect(config.containerTagPrefix).toBe("prefix");
    expect(config.entityContext).toBe("context");
  });

  test("uiHints are defined", () => {
    expect(supermemoryConfigSchema.uiHints).toBeDefined();
    expect(supermemoryConfigSchema.uiHints.apiKey).toBeDefined();
    expect(supermemoryConfigSchema.uiHints.apiKey.sensitive).toBe(true);
    expect(supermemoryConfigSchema.uiHints.autoRecall).toBeDefined();
    expect(supermemoryConfigSchema.uiHints.autoCapture).toBeDefined();
  });
});

// ============================================================================
// Container Tag Resolution Tests
// ============================================================================

describe("resolveContainerTag", () => {
  test("resolves standard session key", () => {
    const tag = resolveContainerTag("agent:main:telegram:direct:12345");
    expect(tag).toBe("main_telegram_direct_12345");
  });

  test("resolves session key with prefix", () => {
    const tag = resolveContainerTag("agent:main:telegram:direct:12345", "myapp");
    expect(tag).toBe("myapp_main_telegram_direct_12345");
  });

  test("resolves group session key", () => {
    const tag = resolveContainerTag("agent:main:discord:group:98765");
    expect(tag).toBe("main_discord_group_98765");
  });

  test("resolves simple session key", () => {
    const tag = resolveContainerTag("agent:main:direct");
    expect(tag).toBe("main_direct");
  });

  test("returns null for undefined session key", () => {
    expect(resolveContainerTag(undefined)).toBeNull();
  });

  test("returns null for malformed session key (no agent prefix)", () => {
    expect(resolveContainerTag("main:telegram:direct:12345")).toBeNull();
  });

  test("returns null for too-short session key", () => {
    expect(resolveContainerTag("agent:x")).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(resolveContainerTag("")).toBeNull();
  });

  test("uses peerId to build per-user tag even when session key is dmScope=main", () => {
    // dmScope=main collapses all DMs to agent:main:main — peer info overrides this
    const tag = resolveContainerTag("agent:main:main", undefined, {
      peerId: "+15551234567",
      peerChannel: "telegram",
      agentId: "main",
    });
    expect(tag).toBe("main_telegram_direct_15551234567");
  });

  test("uses peerId with prefix", () => {
    const tag = resolveContainerTag("agent:main:main", "myapp", {
      peerId: "user123",
      peerChannel: "discord",
      agentId: "main",
    });
    expect(tag).toBe("myapp_main_discord_direct_user123");
  });

  test("lowercases peerId in per-user tag", () => {
    const tag = resolveContainerTag("agent:main:main", undefined, {
      peerId: "USER123",
      peerChannel: "telegram",
    });
    expect(tag).toBe("main_telegram_direct_user123");
  });

  test("falls back to session key when peerId is missing", () => {
    const tag = resolveContainerTag("agent:main:telegram:direct:12345", undefined, {
      peerChannel: "telegram",
    });
    expect(tag).toBe("main_telegram_direct_12345");
  });

  test("derives agentId from session key when not in peerInfo", () => {
    const tag = resolveContainerTag("agent:support:main", undefined, {
      peerId: "user456",
      peerChannel: "slack",
    });
    expect(tag).toBe("support_slack_direct_user456");
  });

  test("defaults peerChannel to unknown when missing", () => {
    const tag = resolveContainerTag("agent:main:main", undefined, {
      peerId: "user789",
    });
    expect(tag).toBe("main_unknown_direct_user789");
  });

  test("different peers get different container tags even with same session key", () => {
    const sessionKey = "agent:main:main"; // dmScope=main — same for all DMs
    const tagA = resolveContainerTag(sessionKey, undefined, {
      peerId: "alice",
      peerChannel: "telegram",
    });
    const tagB = resolveContainerTag(sessionKey, undefined, {
      peerId: "bob",
      peerChannel: "telegram",
    });
    expect(tagA).not.toBe(tagB);
    expect(tagA).toBe("main_telegram_direct_alice");
    expect(tagB).toBe("main_telegram_direct_bob");
  });
});

// ============================================================================
// Plugin Registration Tests
// ============================================================================

describe("supermemory plugin registration", () => {
  // oxlint-disable-next-line typescript/no-explicit-any
  let registeredTools: Array<{ tool: any; opts: any }>;
  // oxlint-disable-next-line typescript/no-explicit-any
  let registeredHooks: Record<string, any[]>;
  // oxlint-disable-next-line typescript/no-explicit-any
  let registeredServices: any[];
  let logs: string[];

  // oxlint-disable-next-line typescript/no-explicit-any
  function createMockApi(pluginConfig: Record<string, unknown>): any {
    registeredTools = [];
    registeredHooks = {};
    registeredServices = [];
    logs = [];

    return {
      id: "supermemory",
      name: "Supermemory",
      source: "test",
      config: {},
      pluginConfig,
      runtime: {},
      logger: {
        info: (msg: string) => logs.push(`[info] ${msg}`),
        warn: (msg: string) => logs.push(`[warn] ${msg}`),
        error: (msg: string) => logs.push(`[error] ${msg}`),
        debug: (msg: string) => logs.push(`[debug] ${msg}`),
      },
      // oxlint-disable-next-line typescript/no-explicit-any
      registerTool: (tool: any, opts: any) => {
        registeredTools.push({ tool, opts });
      },
      // oxlint-disable-next-line typescript/no-explicit-any
      registerService: (service: any) => {
        registeredServices.push(service);
      },
      // oxlint-disable-next-line typescript/no-explicit-any
      on: (hookName: string, handler: any) => {
        if (!registeredHooks[hookName]) {
          registeredHooks[hookName] = [];
        }
        registeredHooks[hookName].push(handler);
      },
      resolvePath: (p: string) => p,
      registerCli: () => {},
    };
  }

  beforeEach(() => {
    registeredTools = [];
    registeredHooks = {};
    registeredServices = [];
    logs = [];
  });

  test("plugin exports correct metadata", async () => {
    const { default: plugin } = await import("./index.js");

    expect(plugin.id).toBe("supermemory");
    expect(plugin.name).toBe("Supermemory");
    expect(plugin.kind).toBe("memory");
    expect(plugin.configSchema).toBeDefined();
    // oxlint-disable-next-line typescript/unbound-method
    expect(plugin.register).toBeInstanceOf(Function);
  });

  test("registers 4 tools with correct names", async () => {
    const { default: plugin } = await import("./index.js");

    const mockApi = createMockApi({ apiKey: "sm_test_key" });
    await plugin.register(mockApi);

    const toolNames = registeredTools.map((t) => t.opts?.name);
    expect(toolNames).toContain("supermemory_remember");
    expect(toolNames).toContain("supermemory_recall");
    expect(toolNames).toContain("supermemory_search");
    expect(toolNames).toContain("supermemory_forget");
    expect(registeredTools.length).toBe(4);
  });

  test("registers before_prompt_build hook when autoRecall is true", async () => {
    const { default: plugin } = await import("./index.js");

    const mockApi = createMockApi({ apiKey: "sm_test_key", autoRecall: true });
    await plugin.register(mockApi);

    expect(registeredHooks["before_prompt_build"]).toBeDefined();
    expect(registeredHooks["before_prompt_build"].length).toBe(1);
  });

  test("skips before_prompt_build hook when autoRecall is false", async () => {
    const { default: plugin } = await import("./index.js");

    const mockApi = createMockApi({ apiKey: "sm_test_key", autoRecall: false });
    await plugin.register(mockApi);

    expect(registeredHooks["before_prompt_build"]).toBeUndefined();
  });

  test("registers agent_end hook when autoCapture is true", async () => {
    const { default: plugin } = await import("./index.js");

    const mockApi = createMockApi({ apiKey: "sm_test_key", autoCapture: true });
    await plugin.register(mockApi);

    expect(registeredHooks["agent_end"]).toBeDefined();
    expect(registeredHooks["agent_end"].length).toBe(1);
  });

  test("skips agent_end hook when autoCapture is false", async () => {
    const { default: plugin } = await import("./index.js");

    const mockApi = createMockApi({ apiKey: "sm_test_key", autoCapture: false });
    await plugin.register(mockApi);

    expect(registeredHooks["agent_end"]).toBeUndefined();
  });

  test("registers service", async () => {
    const { default: plugin } = await import("./index.js");

    const mockApi = createMockApi({ apiKey: "sm_test_key" });
    await plugin.register(mockApi);

    expect(registeredServices.length).toBe(1);
    expect(registeredServices[0].id).toBe("supermemory");
  });

  test("registers all components when pluginConfig is undefined (no user config)", async () => {
    const { default: plugin } = await import("./index.js");

    // Simulate no user config — pluginConfig is undefined
    const mockApi = createMockApi(undefined as unknown as Record<string, unknown>);
    plugin.register(mockApi);

    // All 4 tools should still be registered
    expect(registeredTools.length).toBe(4);
    // Both hooks registered (autoRecall + autoCapture default to true)
    expect(registeredHooks["before_prompt_build"]).toBeDefined();
    expect(registeredHooks["agent_end"]).toBeDefined();
    // Service registered
    expect(registeredServices.length).toBe(1);
  });

  test("tool factories return null when session key has no container tag", async () => {
    const { default: plugin } = await import("./index.js");

    const mockApi = createMockApi({ apiKey: "sm_test_key" });
    await plugin.register(mockApi);

    // Call tool factories with no session key — should return null
    for (const { tool } of registeredTools) {
      if (typeof tool === "function") {
        const result = tool({ sessionKey: undefined });
        expect(result).toBeNull();
      }
    }
  });

  test("tool factories return tools when session key is valid", async () => {
    const { default: plugin } = await import("./index.js");

    const mockApi = createMockApi({ apiKey: "sm_test_key" });
    await plugin.register(mockApi);

    for (const { tool, opts } of registeredTools) {
      if (typeof tool === "function") {
        const result = tool({ sessionKey: "agent:main:telegram:direct:12345" });
        expect(result).not.toBeNull();
        expect(result.name).toBe(opts.name);
      }
    }
  });
});
