import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchCatalog, fetchCatalogWithAuth, searchCatalog } from "./marketplace.js";

const resolveGarAuthTokenMock = vi.fn();

vi.mock("../infra/gcloud-auth.js", () => ({
  resolveGarAuthToken: (...args: unknown[]) => resolveGarAuthTokenMock(...args),
}));

const fetchMock = vi.fn();

const MOCK_CATALOG = {
  version: 1,
  updatedAt: "2026-02-25T00:00:00Z",
  registry: "https://us-central1-npm.pkg.dev/project/repo",
  plugins: [
    {
      id: "discord",
      name: "Discord",
      description: "Discord channel plugin",
      npmSpec: "@simpleclaw/discord",
      version: "1.0.0",
      kind: "channel" as const,
      tags: ["chat", "messaging"],
    },
    {
      id: "memory-core",
      name: "Memory Core",
      description: "Core memory search plugin",
      npmSpec: "@simpleclaw/memory-core",
      version: "1.0.0",
      kind: "memory" as const,
    },
  ],
  skills: [
    {
      name: "runbook",
      description: "Internal runbook automation",
      archiveUrl: "gs://bucket/runbook.tar.gz",
      version: "1.0.0",
      tags: ["ops", "automation"],
    },
  ],
};

function mockFetchCatalog(catalog = MOCK_CATALOG) {
  fetchMock.mockResolvedValueOnce({
    ok: true,
    json: async () => catalog,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
});

describe("fetchCatalog", () => {
  it("fetches and parses a valid catalog from HTTPS URL", async () => {
    mockFetchCatalog();

    const catalog = await fetchCatalog({
      catalogUrl: "https://storage.googleapis.com/bucket/catalog.json",
    });

    expect(catalog.version).toBe(1);
    expect(catalog.plugins).toHaveLength(2);
    expect(catalog.skills).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://storage.googleapis.com/bucket/catalog.json",
      expect.any(Object),
    );
  });

  it("converts gs:// URLs to https://storage.googleapis.com/ URLs", async () => {
    mockFetchCatalog();

    await fetchCatalog({ catalogUrl: "gs://my-bucket/path/catalog.json" });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://storage.googleapis.com/my-bucket/path/catalog.json",
      expect.any(Object),
    );
  });

  it("sends Authorization header when authToken is provided", async () => {
    mockFetchCatalog();

    await fetchCatalog({
      catalogUrl: "https://example.com/catalog.json",
      authToken: "ya29.test",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/catalog.json",
      expect.objectContaining({
        headers: { Authorization: "Bearer ya29.test" },
      }),
    );
  });

  it("does not send Authorization header when authToken is not provided", async () => {
    mockFetchCatalog();

    await fetchCatalog({ catalogUrl: "https://example.com/catalog.json" });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/catalog.json",
      expect.objectContaining({
        headers: {},
      }),
    );
  });

  it("throws on non-200 response", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 403,
      statusText: "Forbidden",
    });

    await expect(fetchCatalog({ catalogUrl: "https://example.com/catalog.json" })).rejects.toThrow(
      "403 Forbidden",
    );
  });

  it("throws on invalid catalog missing version", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ plugins: [], skills: [] }),
    });

    await expect(fetchCatalog({ catalogUrl: "https://example.com/catalog.json" })).rejects.toThrow(
      "missing 'version'",
    );
  });

  it("throws on invalid catalog missing plugins array", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ version: 1, skills: [] }),
    });

    await expect(fetchCatalog({ catalogUrl: "https://example.com/catalog.json" })).rejects.toThrow(
      "missing 'plugins'",
    );
  });
});

describe("fetchCatalogWithAuth", () => {
  it("resolves token via gcloud-adc when authMethod is gcloud-adc", async () => {
    resolveGarAuthTokenMock.mockResolvedValueOnce("ya29.adc-token");
    mockFetchCatalog();

    await fetchCatalogWithAuth({
      catalogUrl: "https://example.com/catalog.json",
      authMethod: "gcloud-adc",
    });

    expect(resolveGarAuthTokenMock).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: { Authorization: "Bearer ya29.adc-token" },
      }),
    );
  });

  it("uses provided authToken directly", async () => {
    mockFetchCatalog();

    await fetchCatalogWithAuth({
      catalogUrl: "https://example.com/catalog.json",
      authToken: "ya29.direct",
    });

    expect(resolveGarAuthTokenMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: { Authorization: "Bearer ya29.direct" },
      }),
    );
  });

  it("works without auth when authMethod is undefined", async () => {
    mockFetchCatalog();

    await fetchCatalogWithAuth({
      catalogUrl: "https://example.com/catalog.json",
    });

    expect(resolveGarAuthTokenMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: {},
      }),
    );
  });
});

describe("searchCatalog", () => {
  it("finds plugins by id", () => {
    const results = searchCatalog(MOCK_CATALOG, "discord");
    expect(results.plugins).toHaveLength(1);
    expect(results.plugins[0].id).toBe("discord");
  });

  it("finds plugins by name (case-insensitive)", () => {
    const results = searchCatalog(MOCK_CATALOG, "MEMORY");
    expect(results.plugins).toHaveLength(1);
    expect(results.plugins[0].id).toBe("memory-core");
  });

  it("finds plugins by description", () => {
    const results = searchCatalog(MOCK_CATALOG, "channel plugin");
    expect(results.plugins).toHaveLength(1);
    expect(results.plugins[0].id).toBe("discord");
  });

  it("finds plugins by tag", () => {
    const results = searchCatalog(MOCK_CATALOG, "messaging");
    expect(results.plugins).toHaveLength(1);
    expect(results.plugins[0].id).toBe("discord");
  });

  it("finds skills by name", () => {
    const results = searchCatalog(MOCK_CATALOG, "runbook");
    expect(results.skills).toHaveLength(1);
    expect(results.skills[0].name).toBe("runbook");
  });

  it("finds skills by tag", () => {
    const results = searchCatalog(MOCK_CATALOG, "automation");
    expect(results.skills).toHaveLength(1);
    expect(results.skills[0].name).toBe("runbook");
  });

  it("returns empty results for no match", () => {
    const results = searchCatalog(MOCK_CATALOG, "nonexistent-xyz");
    expect(results.plugins).toHaveLength(0);
    expect(results.skills).toHaveLength(0);
  });
});
