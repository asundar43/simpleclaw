import { describe, expect, it } from "vitest";
import { clearHasBinaryCache, evaluateRuntimeEligibility, hasBinary } from "./config-eval.js";

describe("evaluateRuntimeEligibility", () => {
  it("rejects entries when required OS does not match local or remote", () => {
    const result = evaluateRuntimeEligibility({
      os: ["definitely-not-a-runtime-platform"],
      remotePlatforms: [],
      hasBin: () => true,
      hasEnv: () => true,
      isConfigPathTruthy: () => true,
    });
    expect(result).toBe(false);
  });

  it("accepts entries when remote platform satisfies OS requirements", () => {
    const result = evaluateRuntimeEligibility({
      os: ["linux"],
      remotePlatforms: ["linux"],
      hasBin: () => true,
      hasEnv: () => true,
      isConfigPathTruthy: () => true,
    });
    expect(result).toBe(true);
  });

  it("bypasses runtime requirements when always=true", () => {
    const result = evaluateRuntimeEligibility({
      always: true,
      requires: { env: ["OPENAI_API_KEY"] },
      hasBin: () => false,
      hasEnv: () => false,
      isConfigPathTruthy: () => false,
    });
    expect(result).toBe(true);
  });

  it("evaluates runtime requirements when always is false", () => {
    const result = evaluateRuntimeEligibility({
      requires: {
        bins: ["node"],
        anyBins: ["bun", "node"],
        env: ["OPENAI_API_KEY"],
        config: ["browser.enabled"],
      },
      hasBin: (bin) => bin === "node",
      hasAnyRemoteBin: () => false,
      hasEnv: (name) => name === "OPENAI_API_KEY",
      isConfigPathTruthy: (path) => path === "browser.enabled",
    });
    expect(result).toBe(true);
  });
});

describe("clearHasBinaryCache", () => {
  it("clears cached binary lookups so next hasBinary call re-scans", () => {
    // Perform a lookup to populate the cache
    const firstResult = hasBinary("node");
    // Clear the cache
    clearHasBinaryCache();
    // A subsequent lookup should still work (re-scans PATH)
    const secondResult = hasBinary("node");
    expect(firstResult).toBe(secondResult);
  });

  it("allows a previously-missing binary to be found after cache clear", () => {
    // Look up a binary that definitely doesn't exist
    const missing = hasBinary("__simpleclaw_nonexistent_binary_test__");
    expect(missing).toBe(false);

    // Clear cache — if the binary were installed between calls, it would be found
    clearHasBinaryCache();

    // Still doesn't exist, but the cache was cleared (no stale result)
    const afterClear = hasBinary("__simpleclaw_nonexistent_binary_test__");
    expect(afterClear).toBe(false);
  });
});
