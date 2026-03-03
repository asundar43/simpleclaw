/**
 * GenUI Component Registry
 *
 * Maintains a mapping of tool names → GenUI component definitions.
 * Supports two sources:
 * 1. Firebase RTDB (dynamic, real-time updates from frontend)
 * 2. Static config (fallback from agents.defaults.judge.registry)
 */

import type {
  AgentJudgeConfig,
  AgentJudgeFirebaseConfig,
  GenUiComponentDef,
} from "../../config/types.agent-defaults.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("judge/genui-registry");

export type ParamValidationResult = {
  valid: boolean;
  missing: string[];
};

export class GenUiRegistry {
  /** tool name → component definitions (a tool can map to multiple components) */
  private byTool = new Map<string, GenUiComponentDef[]>();
  /** component id → component definition */
  private byId = new Map<string, GenUiComponentDef>();
  private firebaseUnsubscribe: (() => void) | null = null;

  /**
   * Load components from static config (agents.defaults.judge.registry).
   */
  loadFromConfig(registry: Record<string, GenUiComponentDef>): void {
    this.byTool.clear();
    this.byId.clear();

    for (const [_key, def] of Object.entries(registry)) {
      this.addComponent(def);
    }

    log.info(`loaded ${this.byId.size} GenUI components from config`);
  }

  /**
   * Subscribe to Firebase RTDB for live component updates.
   * Falls back to static config if Firebase is unavailable.
   */
  async subscribeFirebase(firebaseConfig: AgentJudgeFirebaseConfig): Promise<void> {
    const collection = firebaseConfig.collection ?? "genui-components";
    const url = `${firebaseConfig.url.replace(/\/$/, "")}/${collection}.json`;

    try {
      // Initial fetch
      const response = await fetch(url);
      if (!response.ok) {
        log.warn(`Firebase RTDB fetch failed: ${response.status} ${response.statusText}`);
        return;
      }

      const data = (await response.json()) as Record<string, GenUiComponentDef> | null;
      if (data) {
        this.byTool.clear();
        this.byId.clear();
        for (const def of Object.values(data)) {
          this.addComponent(def);
        }
        log.info(`loaded ${this.byId.size} GenUI components from Firebase RTDB`);
      }

      // SSE subscription for real-time updates
      this.subscribeFirebaseSSE(url);
    } catch (err) {
      log.warn(`Firebase RTDB subscription failed: ${String(err)}`);
    }
  }

  /**
   * Subscribe to Firebase SSE stream for real-time updates.
   */
  private subscribeFirebaseSSE(url: string): void {
    const sseUrl = url.includes("?") ? `${url}&` : `${url}?`;
    const eventSourceUrl = `${sseUrl}orderBy="$key"`;

    // Use a polling approach since EventSource may not be available in Node
    const pollInterval = setInterval(async () => {
      try {
        const response = await fetch(url);
        if (response.ok) {
          const data = (await response.json()) as Record<string, GenUiComponentDef> | null;
          if (data) {
            this.byTool.clear();
            this.byId.clear();
            for (const def of Object.values(data)) {
              this.addComponent(def);
            }
          }
        }
      } catch {
        // Silently retry on next poll
      }
    }, 30_000); // Poll every 30 seconds

    this.firebaseUnsubscribe = () => clearInterval(pollInterval);
    log.debug(`Firebase RTDB polling started (${eventSourceUrl})`);
  }

  /**
   * Initialize registry from judge config.
   * Tries Firebase first, falls back to static config.
   */
  async initialize(config: AgentJudgeConfig): Promise<void> {
    if (config.firebase?.url) {
      await this.subscribeFirebase(config.firebase);
    }

    // Load static registry as fallback or supplement
    if (config.registry) {
      // Only load static config if Firebase didn't load anything
      if (this.byId.size === 0) {
        this.loadFromConfig(config.registry);
      } else {
        // Merge: static entries fill gaps not covered by Firebase
        for (const [_key, def] of Object.entries(config.registry)) {
          if (!this.byId.has(def.componentId)) {
            this.addComponent(def);
          }
        }
      }
    }
  }

  /**
   * Look up GenUI components for a given tool name.
   */
  lookupByTool(toolName: string): GenUiComponentDef[] {
    return this.byTool.get(toolName) ?? [];
  }

  /**
   * Look up a GenUI component by its ID.
   */
  lookupById(componentId: string): GenUiComponentDef | undefined {
    return this.byId.get(componentId);
  }

  /**
   * Validate that all required params are present in the given params object.
   */
  validateParams(def: GenUiComponentDef, params: Record<string, unknown>): ParamValidationResult {
    const missing: string[] = [];
    for (const req of def.requiredParams) {
      if (params[req] === undefined || params[req] === null || params[req] === "") {
        missing.push(req);
      }
    }
    return { valid: missing.length === 0, missing };
  }

  /**
   * Get all registered components.
   */
  listComponents(): GenUiComponentDef[] {
    return Array.from(this.byId.values());
  }

  /**
   * Clean up subscriptions.
   */
  dispose(): void {
    if (this.firebaseUnsubscribe) {
      this.firebaseUnsubscribe();
      this.firebaseUnsubscribe = null;
    }
  }

  private addComponent(def: GenUiComponentDef): void {
    if (!def.componentId || !Array.isArray(def.toolMappings)) {
      log.warn(`skipping invalid GenUI component definition: ${JSON.stringify(def)}`);
      return;
    }

    this.byId.set(def.componentId, def);
    for (const toolName of def.toolMappings) {
      const existing = this.byTool.get(toolName) ?? [];
      existing.push(def);
      this.byTool.set(toolName, existing);
    }
  }
}
