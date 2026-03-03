/**
 * Simple entity extraction from message text.
 * Pattern-based — extracts names, email addresses, and @mentions.
 */

export type ExtractedEntity = {
  type: "email" | "mention" | "name";
  value: string;
};

const EMAIL_PATTERN = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const MENTION_PATTERN = /@([\w.-]+)/g;
// Capitalized multi-word names (e.g., "Alice Smith", "John")
const NAME_PATTERN = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b/g;

// Common words that look like names but aren't
const NAME_STOPWORDS = new Set([
  "The",
  "This",
  "That",
  "These",
  "Those",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
  "Today",
  "Tomorrow",
  "Yesterday",
  "Hello",
  "Please",
  "Thanks",
  "Sorry",
  "Sure",
  "Great",
  "Good",
  "Bad",
]);

/**
 * Extract entities (emails, mentions, names) from a message string.
 * Returns deduplicated entities ordered by type priority (email > mention > name).
 */
export function extractEntities(text: string): ExtractedEntity[] {
  const seen = new Set<string>();
  const entities: ExtractedEntity[] = [];

  // Extract emails
  for (const match of text.matchAll(EMAIL_PATTERN)) {
    const email = match[0].toLowerCase();
    if (!seen.has(email)) {
      seen.add(email);
      entities.push({ type: "email", value: email });
    }
  }

  // Extract @mentions
  for (const match of text.matchAll(MENTION_PATTERN)) {
    const mention = match[1].toLowerCase();
    if (!seen.has(mention)) {
      seen.add(mention);
      entities.push({ type: "mention", value: mention });
    }
  }

  // Extract capitalized names (simple heuristic)
  for (const match of text.matchAll(NAME_PATTERN)) {
    const name = match[1];
    if (!NAME_STOPWORDS.has(name) && !seen.has(name.toLowerCase())) {
      seen.add(name.toLowerCase());
      entities.push({ type: "name", value: name });
    }
  }

  return entities;
}

/**
 * Build search query strings from extracted entities for service lookups.
 */
export function buildSearchQueries(entities: ExtractedEntity[]): string[] {
  return entities.map((e) => {
    if (e.type === "email") {
      return `from:${e.value} OR to:${e.value}`;
    }
    return e.value;
  });
}
