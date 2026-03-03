import fs from "node:fs/promises";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { resolveSimpleClawAgentDir } from "../../agents/agent-paths.js";
import { getApiKeyForModel } from "../../agents/model-auth.js";
import { resolveModel } from "../../agents/pi-embedded-runner/model.js";
import {
  resolveProactiveSummaryConfig,
  runProactiveSummary,
  shouldRunProactiveSummary,
} from "../../agents/proactive-summary.js";
import type { SimpleClawConfig } from "../../config/config.js";
import { type SessionEntry, updateSessionStoreEntry } from "../../config/sessions.js";
import { logVerbose } from "../../globals.js";

/**
 * Fire-and-forget proactive summary after a successful agent run.
 * Parses the session JSONL to count messages, resolves auth, then generates a
 * temporal-anchored summary written to the workspace memory directory.
 */
export function maybeRunProactiveSummary(params: {
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

  const config = resolveProactiveSummaryConfig(cfg);
  if (!config) {
    return;
  }

  void runInBackground(params as Required<typeof params>, config).catch((err) => {
    logVerbose(`proactive summary background error: ${String(err)}`);
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
  config: NonNullable<ReturnType<typeof resolveProactiveSummaryConfig>>,
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

  if (!shouldRunProactiveSummary(sessionEntry, messages, config)) {
    return;
  }

  // Resolve model SDK object and API key for the summarization call
  const agentDir = resolveSimpleClawAgentDir();
  const { model, error } = resolveModel(params.providerUsed, params.modelUsed, agentDir, cfg);
  if (!model || error) {
    logVerbose(`proactive summary: model resolution failed: ${error ?? "unknown"}`);
    return;
  }

  const apiKeyInfo = await getApiKeyForModel({ model, cfg, agentDir });
  if (!apiKeyInfo.apiKey && apiKeyInfo.mode !== "aws-sdk") {
    logVerbose(`proactive summary: no API key for provider "${model.provider}"`);
    return;
  }

  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), 120_000);

  try {
    const result = await runProactiveSummary({
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
          lastProactiveSummaryAt: Date.now(),
          lastProactiveSummaryMessageCount: messages.length,
        }),
      });
    }
  } finally {
    clearTimeout(timeout);
  }
}
