import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrivateRegistryConfig } from "../config/types.plugins.js";
import { resolveRegistryAuth } from "./registry-auth.js";

const resolveGarAuthTokenMock = vi.fn();
const buildGarRegistryEnvMock = vi.fn();

vi.mock("../infra/gcloud-auth.js", () => ({
  resolveGarAuthToken: (...args: unknown[]) => resolveGarAuthTokenMock(...args),
  buildGarRegistryEnv: (...args: unknown[]) => buildGarRegistryEnvMock(...args),
}));

beforeEach(() => {
  vi.clearAllMocks();
  buildGarRegistryEnvMock.mockImplementation((params: { registryUrl: string; token: string }) => ({
    NPM_AUTH_TOKEN: params.token,
  }));
});

describe("resolveRegistryAuth", () => {
  it("returns null when no registry config provided", async () => {
    const result = await resolveRegistryAuth(undefined);
    expect(result).toBeNull();
  });

  it("returns null when npmRegistry is not set", async () => {
    const result = await resolveRegistryAuth({ catalogUrl: "https://example.com" });
    expect(result).toBeNull();
  });

  it("resolves gcloud-adc auth and returns registryUrl + registryEnv", async () => {
    resolveGarAuthTokenMock.mockResolvedValueOnce("ya29.adc-token");

    const config: PrivateRegistryConfig = {
      npmRegistry: "https://us-central1-npm.pkg.dev/project/repo",
      authMethod: "gcloud-adc",
    };

    const result = await resolveRegistryAuth(config);

    expect(result).not.toBeNull();
    expect(result!.registryUrl).toBe("https://us-central1-npm.pkg.dev/project/repo");
    expect(resolveGarAuthTokenMock).toHaveBeenCalled();
    expect(buildGarRegistryEnvMock).toHaveBeenCalledWith({
      registryUrl: "https://us-central1-npm.pkg.dev/project/repo",
      token: "ya29.adc-token",
    });
    expect(result!.registryEnv).toEqual({ NPM_AUTH_TOKEN: "ya29.adc-token" });
  });

  it("returns empty registryEnv when gcloud-adc token resolution fails", async () => {
    resolveGarAuthTokenMock.mockResolvedValueOnce(null);

    const config: PrivateRegistryConfig = {
      npmRegistry: "https://us-central1-npm.pkg.dev/project/repo",
      authMethod: "gcloud-adc",
    };

    const result = await resolveRegistryAuth(config);

    expect(result).not.toBeNull();
    expect(result!.registryUrl).toBe("https://us-central1-npm.pkg.dev/project/repo");
    expect(result!.registryEnv).toEqual({});
  });

  it("uses static authToken directly for token auth method", async () => {
    const config: PrivateRegistryConfig = {
      npmRegistry: "https://registry.example.com",
      authMethod: "token",
      authToken: "static-secret-token",
    };

    const result = await resolveRegistryAuth(config);

    expect(result).not.toBeNull();
    expect(resolveGarAuthTokenMock).not.toHaveBeenCalled();
    expect(buildGarRegistryEnvMock).toHaveBeenCalledWith({
      registryUrl: "https://registry.example.com",
      token: "static-secret-token",
    });
  });

  it("returns empty registryEnv for npmrc auth method", async () => {
    const config: PrivateRegistryConfig = {
      npmRegistry: "https://registry.example.com",
      authMethod: "npmrc",
    };

    const result = await resolveRegistryAuth(config);

    expect(result).not.toBeNull();
    expect(result!.registryUrl).toBe("https://registry.example.com");
    expect(result!.registryEnv).toEqual({});
    expect(resolveGarAuthTokenMock).not.toHaveBeenCalled();
    expect(buildGarRegistryEnvMock).not.toHaveBeenCalled();
  });

  it("returns empty registryEnv when authMethod is undefined (defaults to npmrc)", async () => {
    const config: PrivateRegistryConfig = {
      npmRegistry: "https://registry.example.com",
    };

    const result = await resolveRegistryAuth(config);

    expect(result).not.toBeNull();
    expect(result!.registryUrl).toBe("https://registry.example.com");
    expect(result!.registryEnv).toEqual({});
  });

  it("does not set registryEnv when token auth method has no authToken", async () => {
    const config: PrivateRegistryConfig = {
      npmRegistry: "https://registry.example.com",
      authMethod: "token",
    };

    const result = await resolveRegistryAuth(config);

    expect(result).not.toBeNull();
    expect(result!.registryEnv).toEqual({});
    expect(buildGarRegistryEnvMock).not.toHaveBeenCalled();
  });
});
