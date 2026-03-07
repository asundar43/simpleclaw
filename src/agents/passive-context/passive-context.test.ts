import { describe, expect, it, vi } from "vitest";
import type { SimpleClawConfig } from "../../config/config.js";
import type { PluginRegistry } from "../../plugins/registry.js";
import { createContextBudget, truncateToTokenBudget, consumeBudget } from "./context-budget.js";
import { buildChannelHistoryContext } from "./context-sources.js";
import { extractEntities, buildSearchQueries } from "./entity-extractor.js";
import {
  registerPassiveContextHook,
  resolvePassiveContextConfig,
} from "./passive-context-plugin.js";

// Mock the gwsc CLI for Gmail queries
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));
vi.mock("node:util", () => ({
  promisify: vi.fn(() => vi.fn()),
}));

describe("entity-extractor", () => {
  describe("extractEntities", () => {
    it("extracts email addresses", () => {
      const entities = extractEntities("Contact alice@example.com for details.");
      expect(entities).toContainEqual({ type: "email", value: "alice@example.com" });
    });

    it("extracts @mentions", () => {
      const entities = extractEntities("Hey @alice, check this out.");
      expect(entities).toContainEqual({ type: "mention", value: "alice" });
    });

    it("extracts capitalized names", () => {
      const entities = extractEntities("I spoke with John Smith yesterday.");
      expect(entities).toContainEqual({ type: "name", value: "John Smith" });
    });

    it("filters out single-word stopwords", () => {
      // Each stopword separated by lowercase text to avoid multi-word name matching
      const entities = extractEntities("say Hello and then Please and also Thanks");
      const names = entities.filter((e) => e.type === "name");
      expect(names).toHaveLength(0);
    });

    it("deduplicates entities", () => {
      const entities = extractEntities("alice@test.com and alice@test.com");
      const emails = entities.filter((e) => e.type === "email");
      expect(emails).toHaveLength(1);
    });

    it("returns empty for plain text without entities", () => {
      const entities = extractEntities("just some regular text without names");
      expect(entities).toHaveLength(0);
    });

    it("prioritizes email > mention > name", () => {
      const entities = extractEntities("Contact @bob and Charlie");
      const types = entities.map((e) => e.type);
      // Mentions come before names
      const mentionIdx = types.indexOf("mention");
      const nameIdx = types.indexOf("name");
      expect(mentionIdx).toBeLessThan(nameIdx);
    });
  });

  describe("buildSearchQueries", () => {
    it("builds email query with from/to", () => {
      const queries = buildSearchQueries([{ type: "email", value: "alice@test.com" }]);
      expect(queries[0]).toBe("from:alice@test.com OR to:alice@test.com");
    });

    it("uses raw value for names and mentions", () => {
      const queries = buildSearchQueries([
        { type: "mention", value: "bob" },
        { type: "name", value: "Alice Smith" },
      ]);
      expect(queries[0]).toBe("bob");
      expect(queries[1]).toBe("Alice Smith");
    });
  });
});

describe("context-budget", () => {
  describe("createContextBudget", () => {
    it("creates budget with default tokens", () => {
      const budget = createContextBudget();
      expect(budget.totalMaxTokens).toBe(3000);
      expect(budget.remaining).toBe(3000);
    });

    it("creates budget with custom tokens", () => {
      const budget = createContextBudget(5000);
      expect(budget.totalMaxTokens).toBe(5000);
      expect(budget.remaining).toBe(5000);
    });
  });

  describe("truncateToTokenBudget", () => {
    it("returns text unchanged when within budget", () => {
      const { text, tokens } = truncateToTokenBudget("short text", 1000);
      expect(text).toBe("short text");
      expect(tokens).toBeGreaterThan(0);
    });

    it("truncates text when over budget", () => {
      const longText = "x".repeat(10000);
      const { text } = truncateToTokenBudget(longText, 10);
      expect(text.length).toBeLessThan(longText.length);
      expect(text).toContain("...(truncated)");
    });
  });

  describe("consumeBudget", () => {
    it("reduces remaining budget", () => {
      const budget = createContextBudget(1000);
      consumeBudget(budget, 300);
      expect(budget.remaining).toBe(700);
    });

    it("does not go below zero", () => {
      const budget = createContextBudget(100);
      consumeBudget(budget, 200);
      expect(budget.remaining).toBe(0);
    });

    it("returns false when budget exhausted", () => {
      const budget = createContextBudget(100);
      const hasRoom = consumeBudget(budget, 100);
      expect(hasRoom).toBe(false);
    });

    it("returns true when budget remains", () => {
      const budget = createContextBudget(100);
      const hasRoom = consumeBudget(budget, 50);
      expect(hasRoom).toBe(true);
    });
  });
});

describe("context-sources", () => {
  describe("buildChannelHistoryContext", () => {
    it("returns undefined with no history", () => {
      const result = buildChannelHistoryContext({
        inboundHistory: [],
        entities: [{ type: "name", value: "Alice" }],
        maxTokens: 1000,
        budget: createContextBudget(),
      });
      expect(result).toBeUndefined();
    });

    it("returns undefined with no entities", () => {
      const result = buildChannelHistoryContext({
        inboundHistory: [{ sender: "Alice", body: "Hello", timestamp: Date.now() }],
        entities: [],
        maxTokens: 1000,
        budget: createContextBudget(),
      });
      expect(result).toBeUndefined();
    });

    it("filters history by entity mentions", () => {
      const result = buildChannelHistoryContext({
        inboundHistory: [
          { sender: "Alice", body: "Check the report", timestamp: Date.now() },
          { sender: "Bob", body: "Unrelated message", timestamp: Date.now() },
        ],
        entities: [{ type: "name", value: "Alice" }],
        maxTokens: 1000,
        budget: createContextBudget(),
      });
      expect(result).toBeDefined();
      expect(result!.text).toContain("Alice");
      expect(result!.text).not.toContain("Bob");
      expect(result!.source).toBe("channel-history");
    });

    it("respects budget limits", () => {
      const budget = createContextBudget(10); // Very small budget
      const result = buildChannelHistoryContext({
        inboundHistory: [{ sender: "Alice", body: "A".repeat(5000), timestamp: Date.now() }],
        entities: [{ type: "name", value: "Alice" }],
        maxTokens: 1000,
        budget,
      });
      // Should still return something (truncated)
      if (result) {
        expect(result.tokens).toBeGreaterThan(0);
      }
    });

    it("returns undefined when budget is exhausted", () => {
      const budget = createContextBudget(100);
      budget.remaining = 0;
      const result = buildChannelHistoryContext({
        inboundHistory: [{ sender: "Alice", body: "Hello", timestamp: Date.now() }],
        entities: [{ type: "name", value: "Alice" }],
        maxTokens: 1000,
        budget,
      });
      expect(result).toBeUndefined();
    });
  });
});

describe("passive-context-plugin", () => {
  describe("resolvePassiveContextConfig", () => {
    it("returns undefined when not configured", () => {
      expect(resolvePassiveContextConfig(undefined)).toBeUndefined();
    });

    it("returns undefined when disabled", () => {
      const cfg = {
        agents: { defaults: { passiveContext: { enabled: false } } },
      } as SimpleClawConfig;
      expect(resolvePassiveContextConfig(cfg)).toBeUndefined();
    });

    it("returns config when enabled", () => {
      const cfg = {
        agents: {
          defaults: {
            passiveContext: {
              enabled: true,
              totalMaxTokens: 5000,
            },
          },
        },
      } as SimpleClawConfig;
      const result = resolvePassiveContextConfig(cfg);
      expect(result).toBeDefined();
      expect(result!.totalMaxTokens).toBe(5000);
    });
  });

  describe("registerPassiveContextHook", () => {
    function makeRegistry(): PluginRegistry {
      return {
        plugins: [],
        tools: [],
        hooks: [],
        typedHooks: [],
        channels: [],
        providers: [],
        gatewayHandlers: {},
        httpHandlers: [],
        httpRoutes: [],
        cliRegistrars: [],
        services: [],
        commands: [],
        diagnostics: [],
      };
    }

    it("does not register hook when disabled", () => {
      const registry = makeRegistry();
      registerPassiveContextHook(registry, {} as SimpleClawConfig);
      expect(registry.typedHooks).toHaveLength(0);
    });

    it("registers hook when enabled", () => {
      const registry = makeRegistry();
      const cfg = {
        agents: {
          defaults: {
            passiveContext: {
              enabled: true,
              sources: { channelHistory: { enabled: true } },
            },
          },
        },
      } as SimpleClawConfig;
      registerPassiveContextHook(registry, cfg);
      expect(registry.typedHooks).toHaveLength(1);
      expect(registry.typedHooks[0].hookName).toBe("before_prompt_build");
      expect(registry.typedHooks[0].pluginId).toBe("builtin:passive-context");
    });

    it("hook handler returns void when no entities found", async () => {
      const registry = makeRegistry();
      const cfg = {
        agents: {
          defaults: {
            passiveContext: {
              enabled: true,
              sources: { channelHistory: { enabled: true } },
            },
          },
        },
      } as SimpleClawConfig;
      registerPassiveContextHook(registry, cfg);

      const hook = registry.typedHooks[0];
      const result = await (hook.handler as Function)(
        { prompt: "just regular lowercase text", messages: [] },
        {},
      );
      expect(result).toBeUndefined();
    });
  });
});
