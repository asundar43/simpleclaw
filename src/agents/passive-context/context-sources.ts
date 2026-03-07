import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { consumeBudget, type ContextBudget, truncateToTokenBudget } from "./context-budget.js";
import { buildSearchQueries, type ExtractedEntity } from "./entity-extractor.js";

const log = createSubsystemLogger("passive-context");
const execFileAsync = promisify(execFile);

export type ContextSnippet = {
  source: string;
  text: string;
  tokens: number;
};

/**
 * Query Gmail for recent emails matching the extracted entities.
 * Uses the `gwsc` CLI tool (same infrastructure as the Gmail hook system).
 */
export async function queryGmailContext(params: {
  entities: ExtractedEntity[];
  maxTokens: number;
  lookbackDays: number;
  budget: ContextBudget;
}): Promise<ContextSnippet | undefined> {
  const { entities, maxTokens, lookbackDays, budget } = params;

  if (entities.length === 0 || budget.remaining <= 0) {
    return undefined;
  }

  const queries = buildSearchQueries(entities).slice(0, 3); // Max 3 queries
  const snippets: string[] = [];

  for (const query of queries) {
    if (budget.remaining <= 0) {
      break;
    }

    try {
      const { stdout } = await execFileAsync(
        "gwsc",
        [
          "gmail",
          "users",
          "messages",
          "list",
          "--params",
          JSON.stringify({
            userId: "me",
            q: `${query} newer_than:${lookbackDays}d`,
            maxResults: 5,
          }),
        ],
        { timeout: 10_000 },
      );

      if (stdout.trim()) {
        snippets.push(stdout.trim());
      }
    } catch (err) {
      log.debug(`gmail query failed for ${query}: ${String(err)}`);
    }
  }

  if (snippets.length === 0) {
    return undefined;
  }

  const combined = snippets.join("\n\n");
  const { text, tokens } = truncateToTokenBudget(combined, Math.min(maxTokens, budget.remaining));
  consumeBudget(budget, tokens);

  return {
    source: "gmail",
    text: `## Recent Email Context\n\n${text}`,
    tokens,
  };
}

/**
 * Extract context from recent channel message history.
 * Uses the InboundHistory already available in the message context.
 */
export function buildChannelHistoryContext(params: {
  inboundHistory?: Array<{ sender?: string; body?: string; timestamp?: number }>;
  entities: ExtractedEntity[];
  maxTokens: number;
  budget: ContextBudget;
}): ContextSnippet | undefined {
  const { inboundHistory, entities, maxTokens, budget } = params;

  if (!inboundHistory?.length || entities.length === 0 || budget.remaining <= 0) {
    return undefined;
  }

  // Filter history entries that mention any of our entities
  const entityValues = new Set(entities.map((e) => e.value.toLowerCase()));
  const relevant = inboundHistory.filter((entry) => {
    const body = (entry.body ?? "").toLowerCase();
    const sender = (entry.sender ?? "").toLowerCase();
    return [...entityValues].some((v) => body.includes(v) || sender.includes(v));
  });

  if (relevant.length === 0) {
    return undefined;
  }

  const lines = relevant.slice(-10).map((entry) => {
    const ts = entry.timestamp ? new Date(entry.timestamp).toISOString().slice(0, 16) : "";
    const sender = entry.sender ?? "unknown";
    const body = (entry.body ?? "").slice(0, 200);
    return `[${ts}] ${sender}: ${body}`;
  });

  const combined = lines.join("\n");
  const { text, tokens } = truncateToTokenBudget(combined, Math.min(maxTokens, budget.remaining));
  consumeBudget(budget, tokens);

  return {
    source: "channel-history",
    text: `## Recent Channel Context\n\n${text}`,
    tokens,
  };
}
