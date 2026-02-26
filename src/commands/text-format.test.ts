import { describe, expect, it } from "vitest";
import { shortenText } from "./text-format.js";

describe("shortenText", () => {
  it("returns original text when it fits", () => {
    expect(shortenText("simpleclaw", 16)).toBe("simpleclaw");
  });

  it("truncates and appends ellipsis when over limit", () => {
    expect(shortenText("simpleclaw-status-output", 10)).toBe("simplecla…");
  });

  it("counts multi-byte characters correctly", () => {
    expect(shortenText("hello🙂world", 7)).toBe("hello🙂…");
  });
});
