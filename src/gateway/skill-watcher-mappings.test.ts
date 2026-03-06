import { describe, expect, it } from "vitest";
import type { SkillWatchEntry } from "../agents/skills/types.js";
import { buildSkillWatchMappings } from "./skill-watcher-mappings.js";

describe("buildSkillWatchMappings", () => {
  it("creates a mapping for an entry with a messageTemplate", () => {
    const entries: SkillWatchEntry[] = [
      {
        id: "gws-gmail",
        command: ["gws", "gmail", "+watch"],
        hookPath: "gws-gmail",
        name: "Gmail",
        messageTemplate: "New email from {{from}}",
        sessionKey: "hook:gws-gmail:{{messageId}}",
      },
    ];
    const mappings = buildSkillWatchMappings(entries);
    expect(mappings).toHaveLength(1);
    expect(mappings[0]).toMatchObject({
      id: "skill-watch:gws-gmail",
      matchPath: "gws-gmail",
      action: "agent",
      wakeMode: "now",
      name: "Gmail",
      messageTemplate: "New email from {{from}}",
      sessionKey: "hook:gws-gmail:{{messageId}}",
      channel: "last",
    });
  });

  it("skips entries without messageTemplate", () => {
    const entries: SkillWatchEntry[] = [
      {
        id: "no-template",
        command: ["cmd"],
        hookPath: "hook",
        name: "NoTemplate",
      },
    ];
    const mappings = buildSkillWatchMappings(entries);
    expect(mappings).toHaveLength(0);
  });

  it("handles multiple entries", () => {
    const entries: SkillWatchEntry[] = [
      {
        id: "gmail",
        command: ["gws", "gmail", "+watch"],
        hookPath: "gws-gmail",
        name: "Gmail",
        messageTemplate: "Email: {{subject}}",
      },
      {
        id: "events",
        command: ["gws", "events", "+subscribe"],
        hookPath: "gws-events",
        name: "Events",
        messageTemplate: "Event: {{type}}",
      },
    ];
    const mappings = buildSkillWatchMappings(entries);
    expect(mappings).toHaveLength(2);
    expect(mappings[0].matchPath).toBe("gws-gmail");
    expect(mappings[1].matchPath).toBe("gws-events");
  });

  it("returns empty array for empty input", () => {
    expect(buildSkillWatchMappings([])).toEqual([]);
  });
});
