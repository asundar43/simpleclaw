import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatCliCommand } from "./command-format.js";
import { applyCliProfileEnv, parseCliProfileArgs } from "./profile.js";

describe("parseCliProfileArgs", () => {
  it("leaves gateway --dev for subcommands", () => {
    const res = parseCliProfileArgs([
      "node",
      "simpleclaw",
      "gateway",
      "--dev",
      "--allow-unconfigured",
    ]);
    if (!res.ok) {
      throw new Error(res.error);
    }
    expect(res.profile).toBeNull();
    expect(res.argv).toEqual(["node", "simpleclaw", "gateway", "--dev", "--allow-unconfigured"]);
  });

  it("still accepts global --dev before subcommand", () => {
    const res = parseCliProfileArgs(["node", "simpleclaw", "--dev", "gateway"]);
    if (!res.ok) {
      throw new Error(res.error);
    }
    expect(res.profile).toBe("dev");
    expect(res.argv).toEqual(["node", "simpleclaw", "gateway"]);
  });

  it("parses --profile value and strips it", () => {
    const res = parseCliProfileArgs(["node", "simpleclaw", "--profile", "work", "status"]);
    if (!res.ok) {
      throw new Error(res.error);
    }
    expect(res.profile).toBe("work");
    expect(res.argv).toEqual(["node", "simpleclaw", "status"]);
  });

  it("rejects missing profile value", () => {
    const res = parseCliProfileArgs(["node", "simpleclaw", "--profile"]);
    expect(res.ok).toBe(false);
  });

  it.each([
    ["--dev first", ["node", "simpleclaw", "--dev", "--profile", "work", "status"]],
    ["--profile first", ["node", "simpleclaw", "--profile", "work", "--dev", "status"]],
  ])("rejects combining --dev with --profile (%s)", (_name, argv) => {
    const res = parseCliProfileArgs(argv);
    expect(res.ok).toBe(false);
  });
});

describe("applyCliProfileEnv", () => {
  it("fills env defaults for dev profile", () => {
    const env: Record<string, string | undefined> = {};
    applyCliProfileEnv({
      profile: "dev",
      env,
      homedir: () => "/home/peter",
    });
    const expectedStateDir = path.join(path.resolve("/home/peter"), ".simpleclaw-dev");
    expect(env.SIMPLECLAW_PROFILE).toBe("dev");
    expect(env.SIMPLECLAW_STATE_DIR).toBe(expectedStateDir);
    expect(env.SIMPLECLAW_CONFIG_PATH).toBe(path.join(expectedStateDir, "simpleclaw.json"));
    expect(env.SIMPLECLAW_GATEWAY_PORT).toBe("19001");
  });

  it("does not override explicit env values", () => {
    const env: Record<string, string | undefined> = {
      SIMPLECLAW_STATE_DIR: "/custom",
      SIMPLECLAW_GATEWAY_PORT: "19099",
    };
    applyCliProfileEnv({
      profile: "dev",
      env,
      homedir: () => "/home/peter",
    });
    expect(env.SIMPLECLAW_STATE_DIR).toBe("/custom");
    expect(env.SIMPLECLAW_GATEWAY_PORT).toBe("19099");
    expect(env.SIMPLECLAW_CONFIG_PATH).toBe(path.join("/custom", "simpleclaw.json"));
  });

  it("uses SIMPLECLAW_HOME when deriving profile state dir", () => {
    const env: Record<string, string | undefined> = {
      SIMPLECLAW_HOME: "/srv/simpleclaw-home",
      HOME: "/home/other",
    };
    applyCliProfileEnv({
      profile: "work",
      env,
      homedir: () => "/home/fallback",
    });

    const resolvedHome = path.resolve("/srv/simpleclaw-home");
    expect(env.SIMPLECLAW_STATE_DIR).toBe(path.join(resolvedHome, ".simpleclaw-work"));
    expect(env.SIMPLECLAW_CONFIG_PATH).toBe(
      path.join(resolvedHome, ".simpleclaw-work", "simpleclaw.json"),
    );
  });
});

describe("formatCliCommand", () => {
  it.each([
    {
      name: "no profile is set",
      cmd: "simpleclaw doctor --fix",
      env: {},
      expected: "simpleclaw doctor --fix",
    },
    {
      name: "profile is default",
      cmd: "simpleclaw doctor --fix",
      env: { SIMPLECLAW_PROFILE: "default" },
      expected: "simpleclaw doctor --fix",
    },
    {
      name: "profile is Default (case-insensitive)",
      cmd: "simpleclaw doctor --fix",
      env: { SIMPLECLAW_PROFILE: "Default" },
      expected: "simpleclaw doctor --fix",
    },
    {
      name: "profile is invalid",
      cmd: "simpleclaw doctor --fix",
      env: { SIMPLECLAW_PROFILE: "bad profile" },
      expected: "simpleclaw doctor --fix",
    },
    {
      name: "--profile is already present",
      cmd: "simpleclaw --profile work doctor --fix",
      env: { SIMPLECLAW_PROFILE: "work" },
      expected: "simpleclaw --profile work doctor --fix",
    },
    {
      name: "--dev is already present",
      cmd: "simpleclaw --dev doctor",
      env: { SIMPLECLAW_PROFILE: "dev" },
      expected: "simpleclaw --dev doctor",
    },
  ])("returns command unchanged when $name", ({ cmd, env, expected }) => {
    expect(formatCliCommand(cmd, env)).toBe(expected);
  });

  it("inserts --profile flag when profile is set", () => {
    expect(formatCliCommand("simpleclaw doctor --fix", { SIMPLECLAW_PROFILE: "work" })).toBe(
      "simpleclaw --profile work doctor --fix",
    );
  });

  it("trims whitespace from profile", () => {
    expect(
      formatCliCommand("simpleclaw doctor --fix", { SIMPLECLAW_PROFILE: "  jbsimpleclaw  " }),
    ).toBe("simpleclaw --profile jbsimpleclaw doctor --fix");
  });

  it("handles command with no args after simpleclaw", () => {
    expect(formatCliCommand("simpleclaw", { SIMPLECLAW_PROFILE: "test" })).toBe(
      "simpleclaw --profile test",
    );
  });

  it("handles pnpm wrapper", () => {
    expect(formatCliCommand("pnpm simpleclaw doctor", { SIMPLECLAW_PROFILE: "work" })).toBe(
      "pnpm simpleclaw --profile work doctor",
    );
  });
});
