/**
 * Effect Lifecycle Manager
 *
 * Centralized management of signal effects to prevent memory leaks.
 * Components register effects by ID, and cleanup is guaranteed on unmount or app shutdown.
 */

const activeEffects = new Map<string, Array<() => void>>();

/**
 * Mount a set of effects for a component. Automatically cleans up any previous effects
 * for the same componentId before registering new ones.
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
      if (import.meta.env.DEV) console.error(`Effect mount failed for ${componentId}:`, e);
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
