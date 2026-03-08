export type SupermemoryConfig = {
  apiKey: string;
  autoRecall: boolean;
  autoCapture: boolean;
  filterPrompt?: string;
  containerTagPrefix?: string;
  entityContext?: string;
  gcpProject?: string;
  gcpSecretName?: string;
};

const ALLOWED_KEYS = [
  "apiKey",
  "autoRecall",
  "autoCapture",
  "filterPrompt",
  "containerTagPrefix",
  "entityContext",
  "gcpProject",
  "gcpSecretName",
];

function assertAllowedKeys(value: Record<string, unknown>, allowed: string[], label: string) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length === 0) {
    return;
  }
  throw new Error(`${label} has unknown keys: ${unknown.join(", ")}`);
}

function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, envVar) => {
    const envValue = process.env[envVar];
    if (!envValue) {
      throw new Error(`Environment variable ${envVar} is not set`);
    }
    return envValue;
  });
}

export const supermemoryConfigSchema = {
  parse(value: unknown): SupermemoryConfig {
    if (value === undefined || value === null) {
      // No config provided — return defaults (apiKey resolved later from env/GCloud)
      return {
        apiKey: "",
        autoRecall: true,
        autoCapture: true,
      };
    }
    if (typeof value !== "object" || Array.isArray(value)) {
      throw new Error("supermemory config must be an object");
    }
    const cfg = value as Record<string, unknown>;
    assertAllowedKeys(cfg, ALLOWED_KEYS, "supermemory config");

    // apiKey is optional — resolved later from env var or GCloud Secret Manager
    const rawKey = typeof cfg.apiKey === "string" ? cfg.apiKey.trim() : "";
    const apiKey = rawKey ? resolveEnvVars(rawKey) : "";

    return {
      apiKey,
      autoRecall: cfg.autoRecall !== false,
      autoCapture: cfg.autoCapture !== false,
      filterPrompt: typeof cfg.filterPrompt === "string" ? cfg.filterPrompt.trim() : undefined,
      containerTagPrefix:
        typeof cfg.containerTagPrefix === "string" ? cfg.containerTagPrefix.trim() : undefined,
      entityContext: typeof cfg.entityContext === "string" ? cfg.entityContext.trim() : undefined,
      gcpProject: typeof cfg.gcpProject === "string" ? cfg.gcpProject.trim() : undefined,
      gcpSecretName: typeof cfg.gcpSecretName === "string" ? cfg.gcpSecretName.trim() : undefined,
    };
  },
  uiHints: {
    apiKey: {
      label: "Supermemory API Key",
      sensitive: true,
      placeholder: "sm_...",
      help: "API key from console.supermemory.ai. Optional — auto-resolves from SUPERMEMORY_API_KEY env var or GCloud Secret Manager",
    },
    autoRecall: {
      label: "Auto-Recall",
      help: "Automatically inject user profile and relevant memories into agent context before each run",
    },
    autoCapture: {
      label: "Auto-Capture",
      help: "Automatically store conversation transcripts after each agent run for memory extraction",
    },
    filterPrompt: {
      label: "Filter Prompt",
      help: "Guidance for supermemory's memory extraction (what to prioritize/skip)",
      advanced: true,
    },
    containerTagPrefix: {
      label: "Container Tag Prefix",
      placeholder: "myapp",
      help: "Optional prefix for container tags (multi-tenant isolation)",
      advanced: true,
    },
    entityContext: {
      label: "Entity Context",
      help: "Per-user context string to guide memory extraction quality (max 1500 chars)",
      advanced: true,
    },
  },
};
