const DEFAULT_TOTAL_MAX_TOKENS = 3000;

export type ContextBudget = {
  totalMaxTokens: number;
  remaining: number;
};

/**
 * Create a context budget tracker.
 */
export function createContextBudget(totalMaxTokens?: number): ContextBudget {
  const max = totalMaxTokens ?? DEFAULT_TOTAL_MAX_TOKENS;
  return { totalMaxTokens: max, remaining: max };
}

/**
 * Estimate the token count of a text string (~4 chars per token).
 */
export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Truncate text to fit within a token budget, returning the truncated text
 * and the number of tokens consumed.
 */
export function truncateToTokenBudget(
  text: string,
  maxTokens: number,
): { text: string; tokens: number } {
  const tokens = estimateTextTokens(text);
  if (tokens <= maxTokens) {
    return { text, tokens };
  }

  // Rough char-based truncation (~4 chars per token)
  const charLimit = Math.floor(maxTokens * 4 * 0.9);
  const truncated = text.slice(0, charLimit) + "\n...(truncated)";
  return { text: truncated, tokens: estimateTextTokens(truncated) };
}

/**
 * Consume from budget and return whether there's still room.
 */
export function consumeBudget(budget: ContextBudget, tokens: number): boolean {
  budget.remaining = Math.max(0, budget.remaining - tokens);
  return budget.remaining > 0;
}
