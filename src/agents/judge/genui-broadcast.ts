/**
 * GenUI Broadcast Global
 *
 * Singleton broadcast function set by the gateway during startup.
 * Used by the judge hook to push genui.render events to connected frontends.
 * Follows the same pattern as getGlobalHookRunner() / initializeGlobalHookRunner().
 */

import type { GatewayBroadcastFn } from "../../gateway/server-broadcast.js";

let globalGenUiBroadcast: GatewayBroadcastFn | null = null;

/**
 * Set the global GenUI broadcast function.
 * Called once during gateway startup after the broadcaster is created.
 */
export function setGlobalGenUiBroadcast(fn: GatewayBroadcastFn): void {
  globalGenUiBroadcast = fn;
}

/**
 * Get the global GenUI broadcast function.
 * Returns null if the gateway hasn't initialized yet.
 */
export function getGlobalGenUiBroadcast(): GatewayBroadcastFn | null {
  return globalGenUiBroadcast;
}

/**
 * Reset (for testing).
 */
export function resetGlobalGenUiBroadcast(): void {
  globalGenUiBroadcast = null;
}
