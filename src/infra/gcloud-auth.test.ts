import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildGarRegistryEnv, resolveGarAuthToken, resolveGceProjectId } from "./gcloud-auth.js";

const runCommandWithTimeoutMock = vi.fn();

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: (...args: unknown[]) => runCommandWithTimeoutMock(...args),
}));

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
});

function mockMetadataTokenResponse(token: string) {
  fetchMock.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ access_token: token, expires_in: 3600, token_type: "Bearer" }),
  });
}

function mockMetadataFetchError() {
  fetchMock.mockRejectedValueOnce(new Error("ENOTFOUND metadata.google.internal"));
}

function mockMetadataNotOk() {
  fetchMock.mockResolvedValueOnce({ ok: false, status: 404 });
}

function mockGcloudCliToken(token: string) {
  runCommandWithTimeoutMock.mockResolvedValueOnce({
    code: 0,
    stdout: `${token}\n`,
    stderr: "",
    signal: null,
    killed: false,
  });
}

function mockGcloudCliFail() {
  runCommandWithTimeoutMock.mockResolvedValueOnce({
    code: 1,
    stdout: "",
    stderr: "ERROR: gcloud not found",
    signal: null,
    killed: false,
  });
}

describe("resolveGarAuthToken", () => {
  it("returns token from GCE metadata server on success", async () => {
    mockMetadataTokenResponse("ya29.metadata-token");

    const token = await resolveGarAuthToken();

    expect(token).toBe("ya29.metadata-token");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(runCommandWithTimeoutMock).not.toHaveBeenCalled();
  });

  it("sends Metadata-Flavor: Google header to metadata server", async () => {
    mockMetadataTokenResponse("ya29.test");

    await resolveGarAuthToken();

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("metadata.google.internal"),
      expect.objectContaining({
        headers: { "Metadata-Flavor": "Google" },
      }),
    );
  });

  it("falls back to gcloud CLI when metadata server is unavailable", async () => {
    mockMetadataFetchError();
    mockGcloudCliToken("ya29.cli-token");

    const token = await resolveGarAuthToken();

    expect(token).toBe("ya29.cli-token");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(runCommandWithTimeoutMock).toHaveBeenCalledWith(
      ["gcloud", "auth", "print-access-token"],
      expect.objectContaining({ timeoutMs: 10_000 }),
    );
  });

  it("returns null when both strategies fail", async () => {
    mockMetadataFetchError();
    mockGcloudCliFail();

    const token = await resolveGarAuthToken();

    expect(token).toBeNull();
  });

  it("falls back to CLI when metadata server returns non-200", async () => {
    mockMetadataNotOk();
    mockGcloudCliToken("ya29.fallback");

    const token = await resolveGarAuthToken();

    expect(token).toBe("ya29.fallback");
  });
});

describe("resolveGceProjectId", () => {
  it("returns project ID from metadata server", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () => "my-project-123",
    });

    const projectId = await resolveGceProjectId();

    expect(projectId).toBe("my-project-123");
  });

  it("returns null on fetch error", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network error"));

    const projectId = await resolveGceProjectId();

    expect(projectId).toBeNull();
  });

  it("returns null on non-200 response", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 403 });

    const projectId = await resolveGceProjectId();

    expect(projectId).toBeNull();
  });

  it("returns null for empty response body", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () => "  ",
    });

    const projectId = await resolveGceProjectId();

    expect(projectId).toBeNull();
  });
});

describe("buildGarRegistryEnv", () => {
  it("generates env vars from a GAR registry URL", async () => {
    const env = buildGarRegistryEnv({
      registryUrl: "https://us-central1-npm.pkg.dev/my-project/simpleclaw-npm",
      token: "ya29.test-token",
    });

    // Should have the auth token env var
    const keys = Object.keys(env);
    expect(keys.length).toBe(2);

    // Should have NPM_CONFIG__AUTH base64 fallback
    expect(env.NPM_CONFIG__AUTH).toBe(Buffer.from("_:ya29.test-token").toString("base64"));

    // The other key should contain the token
    const authKey = keys.find((k) => k !== "NPM_CONFIG__AUTH")!;
    expect(env[authKey]).toBe("ya29.test-token");
  });

  it("handles trailing slash in registry URL", async () => {
    const env = buildGarRegistryEnv({
      registryUrl: "https://us-central1-npm.pkg.dev/project/repo/",
      token: "tok",
    });

    const keys = Object.keys(env);
    expect(keys.length).toBe(2);
    expect(env.NPM_CONFIG__AUTH).toBeDefined();
  });

  it("handles invalid URL by falling back to string stripping", async () => {
    const env = buildGarRegistryEnv({
      registryUrl: "not-a-url",
      token: "tok",
    });

    const keys = Object.keys(env);
    expect(keys.length).toBe(2);
    const authKey = keys.find((k) => k !== "NPM_CONFIG__AUTH")!;
    expect(env[authKey]).toBe("tok");
  });
});
