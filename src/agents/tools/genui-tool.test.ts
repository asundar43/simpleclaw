import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBroadcastFn } from "../../gateway/server-broadcast.js";
import { resetGlobalGenUiBroadcast, setGlobalGenUiBroadcast } from "../judge/genui-broadcast.js";
import { createGenUiTool } from "./genui-tool.js";

type ToolResult = { content: Array<{ type: string; text: string }>; details: unknown };

function parseResult(result: unknown): Record<string, unknown> {
  const r = result as ToolResult;
  return JSON.parse(r.content[0].text);
}

describe("GenUI Tool", () => {
  let broadcastMock: ReturnType<typeof vi.fn>;
  let tool: ReturnType<typeof createGenUiTool>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetGlobalGenUiBroadcast();
    broadcastMock = vi.fn();
    setGlobalGenUiBroadcast(broadcastMock as unknown as GatewayBroadcastFn);
    tool = createGenUiTool({ agentSessionKey: "test:main:user" });
  });

  it("has correct name and label", () => {
    expect(tool.name).toBe("genui");
    expect(tool.label).toBe("GenUI");
  });

  describe("render action", () => {
    it("broadcasts genui.render event and returns renderId", async () => {
      const result = await tool.execute("tc-1", {
        action: "render",
        componentId: "calendar-view",
        params: { date: "2026-03-15", events: [] },
      });

      expect(broadcastMock).toHaveBeenCalledTimes(1);
      expect(broadcastMock).toHaveBeenCalledWith(
        "genui.render",
        expect.objectContaining({
          componentId: "calendar-view",
          params: { date: "2026-03-15", events: [] },
          toolName: "genui",
          sessionKey: "test:main:user",
        }),
        { dropIfSlow: true },
      );

      const parsed = parseResult(result);
      expect(parsed.ok).toBe(true);
      expect(parsed.renderId).toBeDefined();
      expect(parsed.componentId).toBe("calendar-view");
    });

    it("works without params", async () => {
      const result = await tool.execute("tc-2", {
        action: "render",
        componentId: "empty-component",
      });

      expect(broadcastMock).toHaveBeenCalledTimes(1);
      const parsed = parseResult(result);
      expect(parsed.ok).toBe(true);
    });
  });

  describe("update action", () => {
    it("broadcasts genui.update event", async () => {
      const result = await tool.execute("tc-3", {
        action: "update",
        componentId: "calendar-view",
        renderId: "render-123",
        params: { events: [{ title: "Meeting" }] },
      });

      expect(broadcastMock).toHaveBeenCalledTimes(1);
      expect(broadcastMock).toHaveBeenCalledWith(
        "genui.update",
        expect.objectContaining({
          id: "render-123",
          toolResult: { events: [{ title: "Meeting" }] },
        }),
        { dropIfSlow: true },
      );

      const parsed = parseResult(result);
      expect(parsed.ok).toBe(true);
    });

    it("returns error when renderId is missing", async () => {
      const result = await tool.execute("tc-4", {
        action: "update",
        componentId: "calendar-view",
      });

      const parsed = parseResult(result);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("renderId");
      expect(broadcastMock).not.toHaveBeenCalled();
    });
  });

  describe("dismiss action", () => {
    it("broadcasts dismiss event", async () => {
      const result = await tool.execute("tc-5", {
        action: "dismiss",
        componentId: "calendar-view",
        renderId: "render-456",
      });

      expect(broadcastMock).toHaveBeenCalledTimes(1);
      expect(broadcastMock).toHaveBeenCalledWith(
        "genui.update",
        expect.objectContaining({
          id: "render-456",
          dismissed: true,
        }),
        { dropIfSlow: true },
      );

      const parsed = parseResult(result);
      expect(parsed.ok).toBe(true);
      expect(parsed.dismissed).toBe(true);
    });

    it("returns error when renderId is missing", async () => {
      const result = await tool.execute("tc-6", {
        action: "dismiss",
        componentId: "calendar-view",
      });

      const parsed = parseResult(result);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("renderId");
    });
  });

  describe("no broadcast available", () => {
    it("returns error when no frontend is connected", async () => {
      resetGlobalGenUiBroadcast();

      const result = await tool.execute("tc-7", {
        action: "render",
        componentId: "calendar-view",
      });

      const parsed = parseResult(result);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("No frontend connected");
    });
  });
});
