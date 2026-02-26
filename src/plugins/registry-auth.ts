import type { PrivateRegistryConfig } from "../config/types.plugins.js";
import { buildGarRegistryEnv, resolveGarAuthToken } from "../infra/gcloud-auth.js";

export type ResolvedRegistryAuth = {
  registryUrl: string;
  registryEnv: Record<string, string>;
};

/**
 * Resolve private registry URL and auth environment variables
 * from the SimpleClaw plugins.registry config.
 *
 * Returns null if no private registry is configured.
 */
export async function resolveRegistryAuth(
  registry: PrivateRegistryConfig | undefined,
): Promise<ResolvedRegistryAuth | null> {
  if (!registry?.npmRegistry) {
    return null;
  }

  const registryUrl = registry.npmRegistry;
  let registryEnv: Record<string, string> = {};

  switch (registry.authMethod) {
    case "gcloud-adc": {
      const token = await resolveGarAuthToken();
      if (token) {
        registryEnv = buildGarRegistryEnv({ registryUrl, token });
      }
      break;
    }
    case "token": {
      if (registry.authToken) {
        registryEnv = buildGarRegistryEnv({ registryUrl, token: registry.authToken });
      }
      break;
    }
    case "npmrc":
    default:
      // Auth handled by user's .npmrc; no extra env needed.
      break;
  }

  return { registryUrl, registryEnv };
}
