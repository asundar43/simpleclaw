import { describe, expect, it } from "vitest";
import { resolveSimpleClawMetadata } from "./frontmatter.js";

function buildFrontmatter(metadataObj: Record<string, unknown>): Record<string, string> {
  return { metadata: JSON.stringify({ openclaw: metadataObj }) };
}

describe("skill watch frontmatter parsing", () => {
  it("parses a valid watch entry", () => {
    const fm = buildFrontmatter({
      watch: [
        {
          id: "gws-gmail",
          command: ["gws", "gmail", "+watch"],
          hookPath: "gws-gmail",
          name: "Gmail",
          messageTemplate: "New email from {{from}}",
          sessionKey: "hook:gws-gmail:{{messageId}}",
        },
      ],
    });
    const meta = resolveSimpleClawMetadata(fm);
    expect(meta?.watch).toHaveLength(1);
    expect(meta!.watch![0]).toEqual({
      id: "gws-gmail",
      command: ["gws", "gmail", "+watch"],
      hookPath: "gws-gmail",
      name: "Gmail",
      messageTemplate: "New email from {{from}}",
      sessionKey: "hook:gws-gmail:{{messageId}}",
    });
  });

  it("parses multiple watch entries", () => {
    const fm = buildFrontmatter({
      watch: [
        { id: "w1", command: ["cmd1"], hookPath: "path1", name: "W1" },
        { id: "w2", command: ["cmd2"], hookPath: "path2", name: "W2" },
      ],
    });
    const meta = resolveSimpleClawMetadata(fm);
    expect(meta?.watch).toHaveLength(2);
    expect(meta!.watch![0].id).toBe("w1");
    expect(meta!.watch![1].id).toBe("w2");
  });

  it("parses a single watch entry (not in an array)", () => {
    const fm = buildFrontmatter({
      watch: { id: "single", command: ["cmd"], hookPath: "hook", name: "Single" },
    });
    const meta = resolveSimpleClawMetadata(fm);
    expect(meta?.watch).toHaveLength(1);
    expect(meta!.watch![0].id).toBe("single");
  });

  it("rejects watch entry without id", () => {
    const fm = buildFrontmatter({
      watch: [{ command: ["cmd"], hookPath: "hook", name: "NoId" }],
    });
    const meta = resolveSimpleClawMetadata(fm);
    expect(meta?.watch).toBeUndefined();
  });

  it("rejects watch entry without command", () => {
    const fm = buildFrontmatter({
      watch: [{ id: "x", hookPath: "hook", name: "NoCmd" }],
    });
    const meta = resolveSimpleClawMetadata(fm);
    expect(meta?.watch).toBeUndefined();
  });

  it("rejects watch entry without hookPath", () => {
    const fm = buildFrontmatter({
      watch: [{ id: "x", command: ["cmd"], name: "NoPath" }],
    });
    const meta = resolveSimpleClawMetadata(fm);
    expect(meta?.watch).toBeUndefined();
  });

  it("rejects watch entry without name", () => {
    const fm = buildFrontmatter({
      watch: [{ id: "x", command: ["cmd"], hookPath: "hook" }],
    });
    const meta = resolveSimpleClawMetadata(fm);
    expect(meta?.watch).toBeUndefined();
  });

  it("rejects hookPath with path traversal", () => {
    const fm = buildFrontmatter({
      watch: [{ id: "x", command: ["cmd"], hookPath: "../escape", name: "Bad" }],
    });
    const meta = resolveSimpleClawMetadata(fm);
    expect(meta?.watch).toBeUndefined();
  });

  it("rejects hookPath with slashes", () => {
    const fm = buildFrontmatter({
      watch: [{ id: "x", command: ["cmd"], hookPath: "a/b/c", name: "Bad" }],
    });
    const meta = resolveSimpleClawMetadata(fm);
    expect(meta?.watch).toBeUndefined();
  });

  it("parses env vars", () => {
    const fm = buildFrontmatter({
      watch: [
        {
          id: "x",
          command: ["cmd"],
          hookPath: "hook",
          name: "WithEnv",
          env: { FOO: "bar", BAZ: "qux" },
        },
      ],
    });
    const meta = resolveSimpleClawMetadata(fm);
    expect(meta!.watch![0].env).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("ignores non-string env values", () => {
    const fm = buildFrontmatter({
      watch: [
        {
          id: "x",
          command: ["cmd"],
          hookPath: "hook",
          name: "BadEnv",
          env: { FOO: "bar", NUM: 123 },
        },
      ],
    });
    const meta = resolveSimpleClawMetadata(fm);
    expect(meta!.watch![0].env).toEqual({ FOO: "bar" });
  });

  it("filters out invalid entries and keeps valid ones", () => {
    const fm = buildFrontmatter({
      watch: [
        { id: "good", command: ["cmd"], hookPath: "hook", name: "Good" },
        { id: "bad" }, // missing required fields
      ],
    });
    const meta = resolveSimpleClawMetadata(fm);
    expect(meta?.watch).toHaveLength(1);
    expect(meta!.watch![0].id).toBe("good");
  });

  it("returns undefined watch when no watch entries provided", () => {
    const fm = buildFrontmatter({ emoji: "test" });
    const meta = resolveSimpleClawMetadata(fm);
    expect(meta?.watch).toBeUndefined();
  });
});
