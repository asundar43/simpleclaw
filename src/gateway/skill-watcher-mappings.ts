/**
 * Builds hook mappings from skill watch entries so that NDJSON events
 * from skill watchers are automatically routed to agents.
 */

import type { SkillWatchEntry } from "../agents/skills/types.js";
import type { HookMappingResolved } from "./hooks-mapping.js";

/**
 * Convert skill watch entries into hook mappings.
 * Each watch entry with a messageTemplate becomes a mapping that matches
 * on the entry's hookPath and dispatches an agent turn with the template.
 */
export function buildSkillWatchMappings(entries: SkillWatchEntry[]): HookMappingResolved[] {
  return entries
    .filter((entry) => Boolean(entry.messageTemplate))
    .map((entry) => ({
      id: `skill-watch:${entry.id}`,
      matchPath: entry.hookPath,
      action: "agent" as const,
      wakeMode: "now" as const,
      name: entry.name,
      sessionKey: entry.sessionKey,
      messageTemplate: entry.messageTemplate,
      deliver: undefined,
      allowUnsafeExternalContent: undefined,
      channel: "last" as const,
      to: undefined,
      model: undefined,
      thinking: undefined,
      timeoutSeconds: undefined,
      transform: undefined,
    }));
}
