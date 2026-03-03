import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GenUiComponentDef } from "../../config/types.agent-defaults.js";
import { GenUiRegistry } from "./genui-registry.js";

describe("GenUiRegistry", () => {
  let registry: GenUiRegistry;

  beforeEach(() => {
    vi.clearAllMocks();
    registry = new GenUiRegistry();
  });

  describe("loadFromConfig", () => {
    it("loads components from static config", () => {
      const config: Record<string, GenUiComponentDef> = {
        calendar: {
          componentId: "calendar-event-card",
          toolMappings: ["add_calendar_event", "update_calendar_event"],
          requiredParams: ["title", "date"],
          optionalParams: ["time", "location"],
        },
        payment: {
          componentId: "payment-form",
          toolMappings: ["send_payment"],
          requiredParams: ["recipient", "amount"],
        },
      };

      registry.loadFromConfig(config);
      expect(registry.listComponents()).toHaveLength(2);
    });

    it("indexes components by tool name", () => {
      registry.loadFromConfig({
        cal: {
          componentId: "calendar-card",
          toolMappings: ["add_calendar_event", "update_calendar_event"],
          requiredParams: ["title"],
        },
      });

      expect(registry.lookupByTool("add_calendar_event")).toHaveLength(1);
      expect(registry.lookupByTool("update_calendar_event")).toHaveLength(1);
      expect(registry.lookupByTool("delete_calendar_event")).toHaveLength(0);
    });

    it("indexes components by ID", () => {
      registry.loadFromConfig({
        cal: {
          componentId: "calendar-card",
          toolMappings: ["add_calendar_event"],
          requiredParams: ["title"],
        },
      });

      expect(registry.lookupById("calendar-card")).toBeDefined();
      expect(registry.lookupById("nonexistent")).toBeUndefined();
    });

    it("supports multiple components for the same tool", () => {
      registry.loadFromConfig({
        simple: {
          componentId: "simple-calendar",
          toolMappings: ["add_calendar_event"],
          requiredParams: ["title"],
        },
        detailed: {
          componentId: "detailed-calendar",
          toolMappings: ["add_calendar_event"],
          requiredParams: ["title", "date", "time"],
        },
      });

      expect(registry.lookupByTool("add_calendar_event")).toHaveLength(2);
    });

    it("skips invalid component definitions", () => {
      registry.loadFromConfig({
        valid: {
          componentId: "valid-component",
          toolMappings: ["some_tool"],
          requiredParams: ["param1"],
        },
        // Missing componentId
        invalid1: {
          toolMappings: ["other_tool"],
          requiredParams: [],
        } as unknown as GenUiComponentDef,
        // toolMappings not an array
        invalid2: {
          componentId: "bad",
          toolMappings: "not-array",
          requiredParams: [],
        } as unknown as GenUiComponentDef,
      });

      expect(registry.listComponents()).toHaveLength(1);
    });

    it("clears previous entries on reload", () => {
      registry.loadFromConfig({
        a: { componentId: "a", toolMappings: ["tool_a"], requiredParams: [] },
      });
      expect(registry.listComponents()).toHaveLength(1);

      registry.loadFromConfig({
        b: { componentId: "b", toolMappings: ["tool_b"], requiredParams: [] },
        c: { componentId: "c", toolMappings: ["tool_c"], requiredParams: [] },
      });
      expect(registry.listComponents()).toHaveLength(2);
      expect(registry.lookupByTool("tool_a")).toHaveLength(0);
    });
  });

  describe("validateParams", () => {
    const def: GenUiComponentDef = {
      componentId: "test-component",
      toolMappings: ["test_tool"],
      requiredParams: ["name", "email", "age"],
    };

    it("returns valid when all required params present", () => {
      const result = registry.validateParams(def, { name: "Alice", email: "a@b.com", age: 30 });
      expect(result.valid).toBe(true);
      expect(result.missing).toEqual([]);
    });

    it("returns invalid with missing params listed", () => {
      const result = registry.validateParams(def, { name: "Alice" });
      expect(result.valid).toBe(false);
      expect(result.missing).toEqual(["email", "age"]);
    });

    it("treats null and empty string as missing", () => {
      const result = registry.validateParams(def, { name: "Alice", email: null, age: "" });
      expect(result.valid).toBe(false);
      expect(result.missing).toEqual(["email", "age"]);
    });

    it("treats undefined as missing", () => {
      const result = registry.validateParams(def, { name: "Alice", email: undefined, age: 30 });
      expect(result.valid).toBe(false);
      expect(result.missing).toEqual(["email"]);
    });

    it("accepts zero and false as valid values", () => {
      const result = registry.validateParams(def, { name: "Alice", email: false, age: 0 });
      expect(result.valid).toBe(true);
    });

    it("returns valid when no required params", () => {
      const noDef: GenUiComponentDef = {
        componentId: "no-req",
        toolMappings: ["tool"],
        requiredParams: [],
      };
      const result = registry.validateParams(noDef, {});
      expect(result.valid).toBe(true);
    });
  });

  describe("Firebase subscription", () => {
    it("fetches initial data from Firebase RTDB", async () => {
      const mockData = {
        comp1: {
          componentId: "firebase-calendar",
          toolMappings: ["add_event"],
          requiredParams: ["title"],
        },
      };

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockData),
      });
      vi.stubGlobal("fetch", fetchMock);

      await registry.subscribeFirebase({
        url: "https://test-project.firebaseio.com",
        collection: "genui-components",
      });

      expect(fetchMock).toHaveBeenCalledWith(
        "https://test-project.firebaseio.com/genui-components.json",
      );
      expect(registry.lookupByTool("add_event")).toHaveLength(1);
      expect(registry.lookupById("firebase-calendar")).toBeDefined();

      registry.dispose();
    });

    it("handles Firebase fetch failure gracefully", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        statusText: "Forbidden",
      });
      vi.stubGlobal("fetch", fetchMock);

      await registry.subscribeFirebase({
        url: "https://test-project.firebaseio.com",
      });

      expect(registry.listComponents()).toHaveLength(0);
      registry.dispose();
    });

    it("handles network errors gracefully", async () => {
      const fetchMock = vi.fn().mockRejectedValue(new Error("Network error"));
      vi.stubGlobal("fetch", fetchMock);

      await registry.subscribeFirebase({
        url: "https://test-project.firebaseio.com",
      });

      expect(registry.listComponents()).toHaveLength(0);
      registry.dispose();
    });

    it("uses default collection name when not specified", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(null),
      });
      vi.stubGlobal("fetch", fetchMock);

      await registry.subscribeFirebase({ url: "https://test.firebaseio.com" });

      expect(fetchMock).toHaveBeenCalledWith("https://test.firebaseio.com/genui-components.json");
      registry.dispose();
    });
  });

  describe("initialize", () => {
    it("loads from static config when no Firebase configured", async () => {
      await registry.initialize({
        enabled: true,
        registry: {
          cal: {
            componentId: "calendar",
            toolMappings: ["add_event"],
            requiredParams: ["title"],
          },
        },
      });

      expect(registry.lookupByTool("add_event")).toHaveLength(1);
    });

    it("merges static config with Firebase data", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            fb_comp: {
              componentId: "firebase-comp",
              toolMappings: ["fb_tool"],
              requiredParams: [],
            },
          }),
      });
      vi.stubGlobal("fetch", fetchMock);

      await registry.initialize({
        enabled: true,
        firebase: { url: "https://test.firebaseio.com" },
        registry: {
          static_comp: {
            componentId: "static-comp",
            toolMappings: ["static_tool"],
            requiredParams: [],
          },
        },
      });

      // Firebase loaded first, static fills gaps
      expect(registry.lookupByTool("fb_tool")).toHaveLength(1);
      expect(registry.lookupByTool("static_tool")).toHaveLength(1);
      expect(registry.listComponents()).toHaveLength(2);

      registry.dispose();
    });
  });

  describe("dispose", () => {
    it("cleans up Firebase subscription", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
      });
      vi.stubGlobal("fetch", fetchMock);

      await registry.subscribeFirebase({ url: "https://test.firebaseio.com" });
      // Should not throw
      registry.dispose();
      registry.dispose(); // Double dispose is safe
    });
  });
});
