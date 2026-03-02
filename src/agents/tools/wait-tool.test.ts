import { describe, expect, it } from "vitest";
import { createWaitTool } from "./wait-tool.js";

describe("wait tool", () => {
  const tool = createWaitTool();

  it("has the correct name and label", () => {
    expect(tool.name).toBe("wait");
    expect(tool.label).toBe("Wait");
  });

  it("returns suppressOutput: true with no reason", async () => {
    const result = await tool.execute("call-1", {});
    expect(result.content).toHaveLength(1);
    const payload = JSON.parse((result.content[0] as { text: string }).text);
    expect(payload.status).toBe("waiting");
    expect(payload.suppressOutput).toBe(true);
    expect(payload.reason).toBeUndefined();
  });

  it("includes reason when provided", async () => {
    const result = await tool.execute("call-2", { reason: "waiting for batch" });
    const payload = JSON.parse((result.content[0] as { text: string }).text);
    expect(payload.status).toBe("waiting");
    expect(payload.suppressOutput).toBe(true);
    expect(payload.reason).toBe("waiting for batch");
  });

  it("trims whitespace from reason", async () => {
    const result = await tool.execute("call-3", { reason: "  spaced  " });
    const payload = JSON.parse((result.content[0] as { text: string }).text);
    expect(payload.reason).toBe("spaced");
  });

  it("omits reason when empty string", async () => {
    const result = await tool.execute("call-4", { reason: "" });
    const payload = JSON.parse((result.content[0] as { text: string }).text);
    expect(payload.reason).toBeUndefined();
  });

  it("omits reason when only whitespace", async () => {
    const result = await tool.execute("call-5", { reason: "   " });
    const payload = JSON.parse((result.content[0] as { text: string }).text);
    expect(payload.reason).toBeUndefined();
  });
});
