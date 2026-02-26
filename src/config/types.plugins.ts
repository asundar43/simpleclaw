export type PluginEntryConfig = {
  enabled?: boolean;
  config?: Record<string, unknown>;
};

export type PluginSlotsConfig = {
  /** Select which plugin owns the memory slot ("none" disables memory plugins). */
  memory?: string;
};

export type PluginsLoadConfig = {
  /** Additional plugin/extension paths to load. */
  paths?: string[];
};

export type PluginInstallRecord = InstallRecordBase;

export type PrivateRegistryConfig = {
  /** Private npm registry URL (e.g. Google Artifact Registry endpoint). */
  npmRegistry?: string;
  /** Private Docker registry URL. */
  dockerRegistry?: string;
  /** Marketplace catalog URL (GCS or HTTPS endpoint to catalog.json). */
  catalogUrl?: string;
  /** Auth method for the private registry. */
  authMethod?: "gcloud-adc" | "token" | "npmrc";
  /** Static auth token (used when authMethod is "token"). */
  authToken?: string;
};

export type PluginsConfig = {
  /** Enable or disable plugin loading. */
  enabled?: boolean;
  /** Optional plugin allowlist (plugin ids). */
  allow?: string[];
  /** Optional plugin denylist (plugin ids). */
  deny?: string[];
  load?: PluginsLoadConfig;
  slots?: PluginSlotsConfig;
  entries?: Record<string, PluginEntryConfig>;
  installs?: Record<string, PluginInstallRecord>;
  /** Private registry configuration for plugin distribution. */
  registry?: PrivateRegistryConfig;
};
import type { InstallRecordBase } from "./types.installs.js";
