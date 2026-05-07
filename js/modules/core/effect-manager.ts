/**
 * Effect Lifecycle Manager
 *
 * Centralized management of signal effects to prevent memory leaks.
 * Components register effects by ID, and cleanup is guaranteed on unmount or app shutdown.
 */

import { trackError } from './error-tracker.js';

const activeEffects = new Map<string, Array<() => void>>();

/**
 * Mount a set of effects for a component. Automatically cleans up any previous effects
 * for the same componentId before registering new ones.
 */
/**
 * CR-Apr24-I finding 326: previously, a failing factory left already-collected
 * disposers live with no rollback — the component ended up with an arbitrary
 * subset of its effects active. Now the function rolls back all collected
 * disposers on the first failure and rethrows so the caller knows the mount
 * did not succeed.
 */
export function mountEffects(componentId: string, effectFactories: Array<() => (() => void)>): void {
  unmountEffects(componentId); // cleanup previous
  const disposers: Array<() => void> = [];
  for (const factory of effectFactories) {
    try {
      const disposer = factory();
      if (typeof disposer === 'function') {
        disposers.push(disposer);
      }
    } catch (e) {
      // CR-Apr24-I finding 326: roll back already-mounted effects on failure
      for (const dispose of disposers) {
        try { dispose(); } catch { /* ignore cleanup errors */ }
      }
      // CR-Apr24-I finding 327: surface telemetry in production too,
      // not just DEV console noise.
      const err = e instanceof Error ? e : new Error(String(e));
      trackError(err, { module: 'EffectManager', action: `mount_failed_${componentId}` });
      if (import.meta.env.DEV) console.error(`Effect mount failed for ${componentId}, rolled back ${disposers.length} effect(s):`, e);
      throw e;
    }
  }
  if (disposers.length > 0) {
    activeEffects.set(componentId, disposers);
  }
}

/**
 * Unmount all effects for a component.
 */
export function unmountEffects(componentId: string): void {
  const disposers = activeEffects.get(componentId);
  if (disposers) {
    for (const dispose of disposers) {
      try { dispose(); } catch { /* ignore cleanup errors */ }
    }
    activeEffects.delete(componentId);
  }
}

/**
 * Unmount all effects across all components (app shutdown).
 */
export function unmountAll(): void {
  for (const [id] of activeEffects) {
    unmountEffects(id);
  }
}

/**
 * Get the count of active effect groups (for debugging).
 */
export function getActiveEffectCount(): number {
  return activeEffects.size;
}

/**
 * Get IDs of all components with active effects (for debugging).
 */
export function getActiveComponentIds(): string[] {
  return Array.from(activeEffects.keys());
}
