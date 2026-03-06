import fs from "node:fs/promises";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { resolveSimpleClawAgentDir } from "../../agents/agent-paths.js";
import { getApiKeyForModel } from "../../agents/model-auth.js";
import { resolveModel } from "../../agents/pi-embedded-runner/model.js";
import {
  resolveUserProfileCurationConfig,
  runUserProfileCuration,
  shouldRunUserProfileCuration,
} from "../../agents/user-profile-curation.js";
import type { SimpleClawConfig } from "../../config/config.js";
import { type SessionEntry, updateSessionStoreEntry } from "../../config/sessions.js";
import { logVerbose } from "../../globals.js";

/**
 * Fire-and-forget user profile curation after a successful agent run.
 * Parses the session JSONL to count messages, resolves auth, then curates
 * USER.md in the workspace with structured user facts.
 */
export function maybeRunUserProfileCuration(params: {
  cfg: SimpleClawConfig;
  sessionKey?: string;
  storePath?: string;
  sessionFile?: string;
  sessionEntry?: SessionEntry;
  workspaceDir: string;
  agentId: string;
  modelUsed: string;
  providerUsed: string;
  isHeartbeat: boolean;
}): void {
  const { cfg, sessionKey, sessionFile, isHeartbeat } = params;

  if (isHeartbeat) {
    return;
  }
  if (!sessionKey || !params.storePath || !sessionFile) {
    return;
  }

  const config = resolveUserProfileCurationConfig(cfg);
  if (!config) {
    return;
  }

  void runInBackground(params as Required<typeof params>, config).catch((err) => {
    logVerbose(`user profile curation background error: ${String(err)}`);
  });
}

async function runInBackground(
  params: {
    cfg: SimpleClawConfig;
    sessionKey: string;
    storePath: string;
    sessionFile: string;
    sessionEntry?: SessionEntry;
    workspaceDir: string;
    agentId: string;
    modelUsed: string;
    providerUsed: string;
  },
  config: NonNullable<ReturnType<typeof resolveUserProfileCurationConfig>>,
): Promise<void> {
  const { cfg, sessionKey, storePath, sessionFile, sessionEntry, workspaceDir, agentId } = params;

  // Parse JSONL to extract messages with a role field
  let messages: AgentMessage[];
  try {
    const content = await fs.readFile(sessionFile, "utf-8");
    messages = [];
    for (const line of content.split("\n")) {
      if (!line.trim()) {
        continue;
      }
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (typeof parsed.role === "string") {
          messages.push(parsed as unknown as AgentMessage);
        }
      } catch {
        // Skip unparseable lines (session header, etc.)
      }
    }
  } catch {
    return;
  }

  if (!shouldRunUserProfileCuration(sessionEntry, messages, config)) {
    return;
  }

  // Resolve model SDK object and API key for the curation call
  const agentDir = resolveSimpleClawAgentDir();
  const { model, error } = resolveModel(params.providerUsed, params.modelUsed, agentDir, cfg);
  if (!model || error) {
    logVerbose(`user profile curation: model resolution failed: ${error ?? "unknown"}`);
    return;
  }

  const apiKeyInfo = await getApiKeyForModel({ model, cfg, agentDir });
  if (!apiKeyInfo.apiKey && apiKeyInfo.mode !== "aws-sdk") {
    logVerbose(`user profile curation: no API key for provider "${model.provider}"`);
    return;
  }

  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), 120_000);

  try {
    const result = await runUserProfileCuration({
      sessionKey,
      agentId,
      workspaceDir,
      messages,
      config,
      model,
      apiKey: apiKeyInfo.apiKey ?? "",
      signal: ac.signal,
    });

    if (result.success) {
      await updateSessionStoreEntry({
        storePath,
        sessionKey,
        update: async () => ({
          lastUserProfileCurationAt: Date.now(),
          lastUserProfileCurationMessageCount: messages.length,
        }),
      });
    }
  } finally {
    clearTimeout(timeout);
  }
}
