import { resolveGarAuthToken } from "../infra/gcloud-auth.js";

// ── Catalog types ──────────────────────────────────────────────

export type MarketplaceCatalog = {
  version: number;
  updatedAt: string;
  /** Default npm registry URL for packages in this catalog. */
  registry: string;
  plugins: MarketplacePluginEntry[];
  skills: MarketplaceSkillEntry[];
};

export type MarketplacePluginEntry = {
  id: string;
  name: string;
  description: string;
  npmSpec: string;
  version: string;
  kind: "channel" | "tool" | "memory" | "provider";
  tags?: string[];
};

export type MarketplaceSkillEntry = {
  name: string;
  description: string;
  /** GCS URL or HTTPS URL to the skill archive (.tar.gz). */
  archiveUrl: string;
  version: string;
  tags?: string[];
};

// ── Catalog fetching ───────────────────────────────────────────

const FETCH_TIMEOUT_MS = 15_000;

/**
 * Fetch and parse a marketplace catalog from a URL.
 *
 * Supports:
 * - HTTPS URLs (direct fetch)
 * - GCS URLs (gs://bucket/path → converted to public HTTPS)
 *
 * For authenticated GCS access, pass an auth token or rely on
 * the URL being publicly accessible.
 */
export async function fetchCatalog(params: {
  catalogUrl: string;
  authToken?: string;
}): Promise<MarketplaceCatalog> {
  const url = resolveGcsUrl(params.catalogUrl);

  const headers: Record<string, string> = {};
  if (params.authToken) {
    headers.Authorization = `Bearer ${params.authToken}`;
  }

  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch catalog from ${url}: ${res.status} ${res.statusText}`);
  }

  const body = (await res.json()) as MarketplaceCatalog;
  validateCatalog(body);
  return body;
}

/**
 * Fetch the catalog using the configured catalog URL, resolving auth automatically.
 */
export async function fetchCatalogWithAuth(params: {
  catalogUrl: string;
  authMethod?: string;
  authToken?: string;
}): Promise<MarketplaceCatalog> {
  let token = params.authToken;

  if (!token && params.authMethod === "gcloud-adc") {
    token = (await resolveGarAuthToken()) ?? undefined;
  }

  return fetchCatalog({ catalogUrl: params.catalogUrl, authToken: token });
}

/**
 * Search the catalog for plugins and skills matching a query string.
 */
export function searchCatalog(
  catalog: MarketplaceCatalog,
  query: string,
): { plugins: MarketplacePluginEntry[]; skills: MarketplaceSkillEntry[] } {
  const q = query.toLowerCase();

  const plugins = catalog.plugins.filter(
    (p) =>
      p.id.toLowerCase().includes(q) ||
      p.name.toLowerCase().includes(q) ||
      p.description.toLowerCase().includes(q) ||
      p.tags?.some((t) => t.toLowerCase().includes(q)),
  );

  const skills = catalog.skills.filter(
    (s) =>
      s.name.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q) ||
      s.tags?.some((t) => t.toLowerCase().includes(q)),
  );

  return { plugins, skills };
}

// ── Helpers ────────────────────────────────────────────────────

/** Convert gs:// URLs to GCS JSON API HTTPS URLs for direct fetch. */
function resolveGcsUrl(url: string): string {
  if (!url.startsWith("gs://")) {
    return url;
  }
  // gs://bucket/path → https://storage.googleapis.com/bucket/path
  const withoutScheme = url.slice("gs://".length);
  return `https://storage.googleapis.com/${withoutScheme}`;
}

function validateCatalog(body: unknown): asserts body is MarketplaceCatalog {
  if (!body || typeof body !== "object") {
    throw new Error("Invalid catalog: expected an object");
  }
  const catalog = body as Record<string, unknown>;
  if (typeof catalog.version !== "number") {
    throw new Error("Invalid catalog: missing 'version' field");
  }
  if (!Array.isArray(catalog.plugins)) {
    throw new Error("Invalid catalog: missing 'plugins' array");
  }
  if (!Array.isArray(catalog.skills)) {
    throw new Error("Invalid catalog: missing 'skills' array");
  }
}
