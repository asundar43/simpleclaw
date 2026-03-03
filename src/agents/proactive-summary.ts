import fs from "node:fs/promises";
import path from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { SimpleClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { AgentProactiveSummaryConfig } from "../config/types.agent-defaults.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  estimateMessagesTokens,
  resolveContextWindowTokens,
  SUMMARIZATION_OVERHEAD_TOKENS,
  summarizeInStages,
} from "./compaction.js";
import { stripToolResultDetails } from "./session-transcript-repair.js";

const log = createSubsystemLogger("proactive-summary");

const DEFAULT_MESSAGE_THRESHOLD = 100;
const MIN_TOKENS_FOR_SUMMARY = 500;

export type ProactiveSummaryResult = {
  success: boolean;
  summaryPath?: string;
  summaryTokens?: number;
  messagesSummarized: number;
};

export type ProactiveSummaryParams = {
  sessionKey: string;
  agentId: string;
  workspaceDir: string;
  messages: AgentMessage[];
  config: AgentProactiveSummaryConfig;
  model: NonNullable<ExtensionContext["model"]>;
  apiKey: string;
  signal: AbortSignal;
};

/**
 * Resolve proactive summary config from the agent defaults.
 */
export function resolveProactiveSummaryConfig(
  cfg?: SimpleClawConfig,
): AgentProactiveSummaryConfig | undefined {
  const raw = cfg?.agents?.defaults?.proactiveSummary;
  if (!raw?.enabled) {
    return undefined;
  }
  return raw;
}

/**
 * Check if a proactive summary should be generated based on message count threshold.
 */
export function shouldRunProactiveSummary(
  entry: SessionEntry | undefined,
  messages: AgentMessage[],
  config: AgentProactiveSummaryConfig,
): boolean {
  const threshold = config.messageThreshold ?? DEFAULT_MESSAGE_THRESHOLD;
  if (threshold <= 0) {
    return false;
  }

  const lastCount = entry?.lastProactiveSummaryMessageCount ?? 0;
  const delta = messages.length - lastCount;

  return delta >= threshold;
}

/**
 * Count user-role messages (a better proxy for conversation "turns").
 */
function countUserMessages(messages: AgentMessage[]): number {
  return messages.filter((m) => m.role === "user").length;
}

/**
 * Build a summarization prompt with optional temporal anchoring.
 */
function buildSummarizationPrompt(temporalAnchoring: boolean, now: Date): string {
  const base =
    "Summarize this conversation concisely. Preserve: decisions made, TODOs and action items, " +
    "open questions, relationship context (who is involved and their roles), and recurring topics.";

  if (!temporalAnchoring) {
    return base;
  }

  const dateStr = now.toISOString().slice(0, 10);
  return (
    `${base}\n\n` +
    `Today's date is ${dateStr}. Anchor events in time using relative markers ` +
    `(e.g., "3 days ago", "last Tuesday", "earlier today") so the summary remains ` +
    `useful for future reference. Include absolute dates for important milestones.`
  );
}

/**
 * Generate a filesystem-safe summary file path under workspace/memory/summaries/.
 */
function buildSummaryFilePath(workspaceDir: string, sessionKey: string, timestamp: number): string {
  const safeKey = sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
  const dateStr = new Date(timestamp).toISOString().replace(/[:.]/g, "-");
  return path.join(workspaceDir, "memory", "summaries", `${safeKey}-${dateStr}.md`);
}

/**
 * Run proactive summarization on the session history and persist as a markdown file
 * in the workspace memory directory (auto-indexed by memory_search).
 */
export async function runProactiveSummary(
  params: ProactiveSummaryParams,
): Promise<ProactiveSummaryResult> {
  const { sessionKey, messages, config, workspaceDir, model, apiKey, signal } = params;

  const temporalAnchoring = config.temporalAnchoring !== false;
  const now = Date.now();

  if (messages.length === 0) {
    return { success: false, messagesSummarized: 0 };
  }

  const safeMessages = stripToolResultDetails(messages);
  const totalTokens = estimateMessagesTokens(safeMessages);

  if (totalTokens < MIN_TOKENS_FOR_SUMMARY) {
    log.debug(`skipping proactive summary: too few tokens (${totalTokens})`);
    return { success: false, messagesSummarized: 0 };
  }

  const contextWindow = resolveContextWindowTokens(model);
  const maxChunkTokens = Math.floor((contextWindow - SUMMARIZATION_OVERHEAD_TOKENS) * 0.4);
  const prompt = buildSummarizationPrompt(temporalAnchoring, new Date(now));

  try {
    const summary = await summarizeInStages({
      messages: safeMessages,
      model,
      apiKey,
      signal,
      reserveTokens: SUMMARIZATION_OVERHEAD_TOKENS,
      maxChunkTokens: Math.max(maxChunkTokens, 2000),
      contextWindow,
      customInstructions: prompt,
    });

    if (!summary || summary === "No prior history.") {
      log.debug("proactive summary returned empty result");
      return { success: false, messagesSummarized: messages.length };
    }

    // Build markdown with metadata header
    const userCount = countUserMessages(messages);
    const content = [
      `# Session Summary`,
      ``,
      `- **Session**: \`${sessionKey}\``,
      `- **Generated**: ${new Date(now).toISOString()}`,
      `- **Messages**: ${messages.length} (${userCount} user turns)`,
      ``,
      `---`,
      ``,
      summary,
      ``,
    ].join("\n");

    // Write to workspace/memory/summaries/ (auto-indexed by memory_search)
    const summaryPath = buildSummaryFilePath(workspaceDir, sessionKey, now);
    await fs.mkdir(path.dirname(summaryPath), { recursive: true });
    await fs.writeFile(summaryPath, content, "utf-8");

    // Rough token estimate: ~4 chars per token
    const summaryTokens = Math.ceil(summary.length / 4);
    log.info(
      `proactive summary written: ${summaryPath} (${summaryTokens} tokens, ${messages.length} messages)`,
    );

    return {
      success: true,
      summaryPath,
      summaryTokens,
      messagesSummarized: messages.length,
    };
  } catch (err) {
    log.warn(`proactive summary generation failed: ${String(err)}`);
    return { success: false, messagesSummarized: 0 };
  }
}
