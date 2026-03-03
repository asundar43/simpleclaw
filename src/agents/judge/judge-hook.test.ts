import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBroadcastFn } from "../../gateway/server-broadcast.js";
import type { PluginRegistry } from "../../plugins/registry.js";
import type {
  PluginHookBeforeToolCallEvent,
  PluginHookBeforeToolCallResult,
  PluginHookAfterToolCallEvent,
  PluginHookRegistration,
  PluginHookToolContext,
} from "../../plugins/types.js";
import { resetGlobalGenUiBroadcast, setGlobalGenUiBroadcast } from "./genui-broadcast.js";
import { registerJudgeHook } from "./judge-hook.js";

type BeforeToolHandler = (
  event: PluginHookBeforeToolCallEvent,
  ctx: PluginHookToolContext,
) => Promise<PluginHookBeforeToolCallResult | void>;

type AfterToolHandler = (
  event: PluginHookAfterToolCallEvent,
  ctx: PluginHookToolContext,
) => Promise<void>;

// Mock the genui-registry module
vi.mock("./genui-registry.js", () => {
  const GenUiRegistry = vi.fn();
  GenUiRegistry.prototype.initialize = vi.fn();
  GenUiRegistry.prototype.lookupByTool = vi.fn().mockReturnValue([]);
  GenUiRegistry.prototype.validateParams = vi.fn().mockReturnValue({ valid: true, missing: [] });
  GenUiRegistry.prototype.dispose = vi.fn();
  return { GenUiRegistry };
});

function createMockRegistry(): PluginRegistry {
  return {
    plugins: [],
    hooks: [],
    typedHooks: [],
    diagnostics: [],
    commands: [],
  } as unknown as PluginRegistry;
}

describe("registerJudgeHook", () => {
  let broadcastMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetGlobalGenUiBroadcast();
    broadcastMock = vi.fn() as unknown as ReturnType<typeof vi.fn> & GatewayBroadcastFn;
    setGlobalGenUiBroadcast(broadcastMock as GatewayBroadcastFn);
  });

  it("does not register hooks when judge is disabled", async () => {
    const registry = createMockRegistry();
    const result = await registerJudgeHook(registry, {
      agents: { defaults: { judge: { enabled: false } } },
    } as never);
    expect(result).toBeUndefined();
    expect(registry.typedHooks).toHaveLength(0);
  });

  it("does not register hooks when judge config is missing", async () => {
    const registry = createMockRegistry();
    const result = await registerJudgeHook(registry, {} as never);
    expect(result).toBeUndefined();
    expect(registry.typedHooks).toHaveLength(0);
  });

  it("registers before_tool_call and after_tool_call hooks when enabled", async () => {
    const registry = createMockRegistry();
    const result = await registerJudgeHook(registry, {
      agents: { defaults: { judge: { enabled: true } } },
    } as never);

    expect(result).toBeDefined();
    expect(registry.typedHooks).toHaveLength(2);

    const hookNames = registry.typedHooks.map((h: PluginHookRegistration) => h.hookName);
    expect(hookNames).toContain("before_tool_call");
    expect(hookNames).toContain("after_tool_call");
  });

  it("registers hooks with builtin:judge plugin ID", async () => {
    const registry = createMockRegistry();
    await registerJudgeHook(registry, {
      agents: { defaults: { judge: { enabled: true } } },
    } as never);

    for (const hook of registry.typedHooks) {
      expect(hook.pluginId).toBe("builtin:judge");
    }
  });

  describe("before_tool_call handler", () => {
    it("passes through when tool is not in GenUI registry", async () => {
      const registry = createMockRegistry();
      await registerJudgeHook(registry, {
        agents: { defaults: { judge: { enabled: true } } },
      } as never);

      const beforeHook = registry.typedHooks.find(
        (h: PluginHookRegistration) => h.hookName === "before_tool_call",
      );
      expect(beforeHook).toBeDefined();

      const result = await ((beforeHook as PluginHookRegistration).handler as BeforeToolHandler)(
        { toolName: "unknown_tool", params: {} },
        { toolName: "unknown_tool", agentId: "main", sessionKey: "test:main:user" },
      );

      expect(result).toBeUndefined();
      expect(broadcastMock).not.toHaveBeenCalled();
    });

    it("blocks when required params are missing", async () => {
      const { GenUiRegistry } = await import("./genui-registry.js");
      const mockLookup = vi.fn().mockReturnValue([
        {
          componentId: "calendar-card",
          toolMappings: ["add_calendar_event"],
          requiredParams: ["title", "date"],
        },
      ]);
      const mockValidate = vi.fn().mockReturnValue({ valid: false, missing: ["date"] });
      GenUiRegistry.prototype.lookupByTool = mockLookup;
      GenUiRegistry.prototype.validateParams = mockValidate;

      const registry = createMockRegistry();
      await registerJudgeHook(registry, {
        agents: { defaults: { judge: { enabled: true } } },
      } as never);

      const beforeHook = registry.typedHooks.find(
        (h: PluginHookRegistration) => h.hookName === "before_tool_call",
      );

      const result = await ((beforeHook as PluginHookRegistration).handler as BeforeToolHandler)(
        { toolName: "add_calendar_event", params: { title: "Meeting" } },
        { toolName: "add_calendar_event", agentId: "main", sessionKey: "test:main:user" },
      );

      expect(result).toEqual({
        block: true,
        blockReason: expect.stringContaining("date"),
      });
      expect(broadcastMock).not.toHaveBeenCalled();
    });

    it("broadcasts genui.render when params are complete", async () => {
      const { GenUiRegistry } = await import("./genui-registry.js");
      GenUiRegistry.prototype.lookupByTool = vi.fn().mockReturnValue([
        {
          componentId: "calendar-card",
          toolMappings: ["add_calendar_event"],
          requiredParams: ["title", "date"],
          schema: { type: "object" },
        },
      ]);
      GenUiRegistry.prototype.validateParams = vi
        .fn()
        .mockReturnValue({ valid: true, missing: [] });

      const registry = createMockRegistry();
      await registerJudgeHook(registry, {
        agents: { defaults: { judge: { enabled: true } } },
      } as never);

      const beforeHook = registry.typedHooks.find(
        (h: PluginHookRegistration) => h.hookName === "before_tool_call",
      );

      const result = await ((beforeHook as PluginHookRegistration).handler as BeforeToolHandler)(
        { toolName: "add_calendar_event", params: { title: "Meeting", date: "2026-03-15" } },
        { toolName: "add_calendar_event", agentId: "main", sessionKey: "test:main:user" },
      );

      // Should not block — tool proceeds normally
      expect(result).toBeUndefined();

      // Should broadcast genui.render
      expect(broadcastMock).toHaveBeenCalledTimes(1);
      expect(broadcastMock).toHaveBeenCalledWith(
        "genui.render",
        expect.objectContaining({
          componentId: "calendar-card",
          toolName: "add_calendar_event",
          params: { title: "Meeting", date: "2026-03-15" },
          schema: { type: "object" },
          sessionKey: "test:main:user",
        }),
        { dropIfSlow: true },
      );
    });
  });

  describe("after_tool_call handler", () => {
    it("broadcasts genui.update for matching tool call", async () => {
      const { GenUiRegistry } = await import("./genui-registry.js");
      GenUiRegistry.prototype.lookupByTool = vi.fn().mockReturnValue([
        {
          componentId: "calendar-card",
          toolMappings: ["add_calendar_event"],
          requiredParams: ["title"],
        },
      ]);
      GenUiRegistry.prototype.validateParams = vi
        .fn()
        .mockReturnValue({ valid: true, missing: [] });

      const registry = createMockRegistry();
      await registerJudgeHook(registry, {
        agents: { defaults: { judge: { enabled: true } } },
      } as never);

      const beforeHook = registry.typedHooks.find(
        (h: PluginHookRegistration) => h.hookName === "before_tool_call",
      );
      const afterHook = registry.typedHooks.find(
        (h: PluginHookRegistration) => h.hookName === "after_tool_call",
      );

      const ctx = { toolName: "add_calendar_event", agentId: "main", sessionKey: "test:main:user" };

      // Trigger before_tool_call to create pending render
      await ((beforeHook as PluginHookRegistration).handler as BeforeToolHandler)(
        { toolName: "add_calendar_event", params: { title: "Meeting" } },
        ctx,
      );

      broadcastMock.mockClear();

      // Trigger after_tool_call
      await ((afterHook as PluginHookRegistration).handler as AfterToolHandler)(
        {
          toolName: "add_calendar_event",
          params: { title: "Meeting" },
          result: { success: true, eventId: "evt-123" },
        },
        ctx,
      );

      expect(broadcastMock).toHaveBeenCalledTimes(1);
      expect(broadcastMock).toHaveBeenCalledWith(
        "genui.update",
        expect.objectContaining({
          toolResult: { success: true, eventId: "evt-123" },
        }),
        { dropIfSlow: true },
      );
    });

    it("does nothing when no pending render exists", async () => {
      const registry = createMockRegistry();
      await registerJudgeHook(registry, {
        agents: { defaults: { judge: { enabled: true } } },
      } as never);

      const afterHook = registry.typedHooks.find(
        (h: PluginHookRegistration) => h.hookName === "after_tool_call",
      );

      await ((afterHook as PluginHookRegistration).handler as AfterToolHandler)(
        { toolName: "unrelated_tool", params: {}, result: {} },
        { toolName: "unrelated_tool", agentId: "main", sessionKey: "test:main:user" },
      );

      expect(broadcastMock).not.toHaveBeenCalled();
    });
  });
});
