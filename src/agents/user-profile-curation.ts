import fs from "node:fs/promises";
import path from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { SimpleClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { AgentUserProfileCurationConfig } from "../config/types.agent-defaults.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  estimateMessagesTokens,
  resolveContextWindowTokens,
  SUMMARIZATION_OVERHEAD_TOKENS,
  summarizeInStages,
} from "./compaction.js";
import { stripToolResultDetails } from "./session-transcript-repair.js";

const log = createSubsystemLogger("user-profile-curation");

const DEFAULT_MESSAGE_THRESHOLD = 100;
const DEFAULT_MAX_CONVERSATION_TOKENS = 8000;
const MIN_TOKENS_FOR_CURATION = 200;

const DEFAULT_USER_MD_TEMPLATE = `# About the User

## Identity
_(Name, pronouns, timezone, location, languages)_

## Preferences & Style
_(Communication preferences, tool/tech preferences, how they like to be helped)_

## People & Relationships
_(Key people mentioned: family, colleagues, friends -- who they are and context)_

## Work & Projects
_(Professional context, current projects, tech stack, goals)_

## Routines & Patterns
_(Regular habits, schedules, recurring tasks, standing orders)_

## Personal Context
_(Hobbies, interests, things that matter to them)_

---
_Last updated: (auto-curated)_
`;

const CURATION_INSTRUCTIONS = [
  "You are a personal profile curator. You are reading a conversation between an assistant and their human.",
  "Your job is to update the human's profile (provided as the previous summary) with anything new learned from this conversation.",
  "",
  "Rules:",
  "1. MERGE, don't replace. Preserve everything in the existing profile. Add new facts; update changed ones; never remove information unless clearly outdated or contradicted.",
  "2. Be factual and concise. Write in bullet points, not prose.",
  "3. Capture specifics: names, dates, preferences, relationships, project names, tech stacks, communication quirks.",
  "4. Only include information about the human, not the assistant.",
  "5. Do NOT fabricate or infer beyond what is directly stated or strongly implied.",
  "6. If the conversation reveals nothing new about the human, return the existing profile unchanged.",
  "7. Maintain the exact section headers (Identity, Preferences & Style, People & Relationships, Work & Projects, Routines & Patterns, Personal Context).",
  "8. Update the 'Last updated' timestamp at the bottom to today's date.",
  "",
  "Output ONLY the complete updated profile content starting with '# About the User'. No preamble, no explanation.",
].join("\n");

export type UserProfileCurationResult = {
  success: boolean;
  userMdPath?: string;
  messagesCurated: number;
  profileUpdated: boolean;
};

export type UserProfileCurationParams = {
  sessionKey: string;
  agentId: string;
  workspaceDir: string;
  messages: AgentMessage[];
  config: AgentUserProfileCurationConfig;
  model: NonNullable<ExtensionContext["model"]>;
  apiKey: string;
  signal: AbortSignal;
};

/**
 * Resolve user profile curation config from agent defaults.
 */
export function resolveUserProfileCurationConfig(
  cfg?: SimpleClawConfig,
): AgentUserProfileCurationConfig | undefined {
  const raw = cfg?.agents?.defaults?.userProfileCuration;
  if (!raw?.enabled) {
    return undefined;
  }
  return raw;
}

/**
 * Check if user profile curation should run based on message count threshold.
 */
export function shouldRunUserProfileCuration(
  entry: SessionEntry | undefined,
  messages: AgentMessage[],
  config: AgentUserProfileCurationConfig,
): boolean {
  const threshold = config.messageThreshold ?? DEFAULT_MESSAGE_THRESHOLD;
  if (threshold <= 0) {
    return false;
  }

  const lastCount = entry?.lastUserProfileCurationMessageCount ?? 0;
  const delta = messages.length - lastCount;

  return delta >= threshold;
}

/**
 * Run user profile curation: extract user facts from conversation and update USER.md.
 */
export async function runUserProfileCuration(
  params: UserProfileCurationParams,
): Promise<UserProfileCurationResult> {
  const { messages, workspaceDir, model, apiKey, signal, config } = params;

  if (messages.length === 0) {
    return { success: false, messagesCurated: 0, profileUpdated: false };
  }

  // Read existing USER.md or use default template
  const userMdPath = path.join(workspaceDir, "USER.md");
  let currentProfile: string;
  try {
    currentProfile = await fs.readFile(userMdPath, "utf-8");
  } catch {
    currentProfile = DEFAULT_USER_MD_TEMPLATE;
  }

  const safeMessages = stripToolResultDetails(messages);

  // Limit to the most recent messages within the token budget
  const maxTokens = config.maxConversationTokens ?? DEFAULT_MAX_CONVERSATION_TOKENS;
  const trimmedMessages = trimToTokenBudget(safeMessages, maxTokens);

  const totalTokens = estimateMessagesTokens(trimmedMessages);
  if (totalTokens < MIN_TOKENS_FOR_CURATION) {
    log.debug(`skipping user profile curation: too few tokens (${totalTokens})`);
    return { success: false, messagesCurated: 0, profileUpdated: false };
  }

  const contextWindow = resolveContextWindowTokens(model);
  const maxChunkTokens = Math.floor((contextWindow - SUMMARIZATION_OVERHEAD_TOKENS) * 0.4);

  try {
    const updatedProfile = await summarizeInStages({
      messages: trimmedMessages,
      model,
      apiKey,
      signal,
      reserveTokens: SUMMARIZATION_OVERHEAD_TOKENS,
      maxChunkTokens: Math.max(maxChunkTokens, 2000),
      contextWindow,
      customInstructions: CURATION_INSTRUCTIONS,
      previousSummary: currentProfile,
    });

    if (!updatedProfile || updatedProfile === currentProfile) {
      log.debug("user profile curation: no changes detected");
      return { success: true, messagesCurated: messages.length, profileUpdated: false };
    }

    // Write atomically: temp file + rename
    const tmpPath = `${userMdPath}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(tmpPath, updatedProfile, "utf-8");
    await fs.rename(tmpPath, userMdPath);

    log.info(`user profile updated: ${userMdPath} (${messages.length} messages curated)`);

    return {
      success: true,
      userMdPath,
      messagesCurated: messages.length,
      profileUpdated: true,
    };
  } catch (err) {
    log.warn(`user profile curation failed: ${String(err)}`);
    return { success: false, messagesCurated: 0, profileUpdated: false };
  }
}

/**
 * Trim messages to fit within a token budget, keeping the most recent messages.
 */
function trimToTokenBudget(messages: AgentMessage[], maxTokens: number): AgentMessage[] {
  if (messages.length === 0) {
    return [];
  }

  const totalTokens = estimateMessagesTokens(messages);
  if (totalTokens <= maxTokens) {
    return messages;
  }

  // Walk backwards from the end, accumulating messages until we hit the budget
  const result: AgentMessage[] = [];
  let tokens = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msgTokens = estimateMessagesTokens([messages[i]]);
    if (tokens + msgTokens > maxTokens && result.length > 0) {
      break;
    }
    tokens += msgTokens;
    result.unshift(messages[i]);
  }

  return result;
}
