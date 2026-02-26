import { runCommandWithTimeout } from "../process/exec.js";

const GCE_METADATA_BASE = "http://metadata.google.internal/computeMetadata/v1";
const METADATA_TOKEN_PATH = "/instance/service-accounts/default/token";
const METADATA_PROJECT_PATH = "/project/project-id";
const METADATA_TIMEOUT_MS = 3_000;

type GceTokenResponse = {
  access_token: string;
  expires_in: number;
  token_type: string;
};

/**
 * Resolve an access token for Google Artifact Registry authentication.
 *
 * Strategy 1: GCE metadata server (works on any GCE VM automatically).
 * Strategy 2: `gcloud auth print-access-token` CLI fallback.
 */
export async function resolveGarAuthToken(): Promise<string | null> {
  // Strategy 1: GCE metadata server — zero-config on GCE VMs.
  const metadataToken = await fetchMetadataToken();
  if (metadataToken) {
    return metadataToken;
  }

  // Strategy 2: gcloud CLI fallback for local dev.
  const cliToken = await fetchGcloudCliToken();
  if (cliToken) {
    return cliToken;
  }

  return null;
}

/**
 * Resolve the GCP project ID from the GCE metadata server.
 */
export async function resolveGceProjectId(): Promise<string | null> {
  try {
    const res = await fetch(`${GCE_METADATA_BASE}${METADATA_PROJECT_PATH}`, {
      headers: { "Metadata-Flavor": "Google" },
      signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
    });
    if (!res.ok) {
      return null;
    }
    const text = await res.text();
    return text.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Build environment variables that let `npm pack` / `npm publish`
 * authenticate against a Google Artifact Registry npm repository.
 */
export function buildGarRegistryEnv(params: {
  registryUrl: string;
  token: string;
}): Record<string, string> {
  // npm reads auth from env vars in the form:
  //   NPM_CONFIG_//host/path/:_authToken=TOKEN
  // We need to extract the host+path portion from the registry URL.
  let registryPath: string;
  try {
    const url = new URL(params.registryUrl);
    // npm expects the path without the protocol, with trailing slash
    registryPath = `//${url.host}${url.pathname}`.replace(/\/$/, "/");
  } catch {
    // Fallback: use the URL as-is with protocol stripped
    registryPath = params.registryUrl.replace(/^https?:/, "");
    if (!registryPath.endsWith("/")) {
      registryPath += "/";
    }
  }

  // npm config env var key format: replace special chars with underscores
  const envKey = `npm_config_${registryPath}:_authToken`.replaceAll("/", "_").replaceAll(":", "_");

  return {
    [envKey]: params.token,
    // Also set the standard auth token env var as a fallback
    NPM_CONFIG__AUTH: Buffer.from(`_:${params.token}`).toString("base64"),
  };
}

async function fetchMetadataToken(): Promise<string | null> {
  try {
    const res = await fetch(`${GCE_METADATA_BASE}${METADATA_TOKEN_PATH}`, {
      headers: { "Metadata-Flavor": "Google" },
      signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
    });
    if (!res.ok) {
      return null;
    }
    const body = (await res.json()) as GceTokenResponse;
    return body.access_token || null;
  } catch {
    // Not running on GCE or metadata server unavailable.
    return null;
  }
}

async function fetchGcloudCliToken(): Promise<string | null> {
  try {
    const result = await runCommandWithTimeout(["gcloud", "auth", "print-access-token"], {
      timeoutMs: 10_000,
    });
    if (result.code !== 0) {
      return null;
    }
    const token = result.stdout.trim();
    return token || null;
  } catch {
    return null;
  }
}
