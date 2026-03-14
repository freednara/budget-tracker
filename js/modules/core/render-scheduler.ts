/**
 * Render Scheduler Module
 * Batches multiple render calls into single requestAnimationFrame
 *
 * This prevents redundant renders when multiple state changes occur
 * in quick succession, improving performance.
 *
 * @module render-scheduler
 */
'use strict';

// ==========================================
// TYPES
// ==========================================

export interface RenderScheduler {
  register: (name: string, fn: () => void) => void;
  schedule: (...names: string[]) => void;
  flush: () => void;
}

// ==========================================
// FACTORY FUNCTION
// ==========================================

/**
 * Create a new render scheduler instance
 * @returns RenderScheduler instance with register, schedule, and flush methods
 */
export function createRenderScheduler(): RenderScheduler {
  let pendingRenders = new Set<string>();
  let rafId: number | null = null;

  // Map of render function names to actual functions
  const renderFnMap = new Map<string, () => void>();

  /**
   * Register a render function with a name
   * @param name - Unique identifier for the render function
   * @param fn - The render function to execute
   */
  function register(name: string, fn: () => void): void {
    renderFnMap.set(name, fn);
  }

  /**
   * Schedule one or more renders to execute on next animation frame
   * Multiple schedules within the same frame are batched together
   * @param names - Names of render functions to schedule
   */
  function schedule(...names: string[]): void {
    names.forEach(name => pendingRenders.add(name));

    if (rafId === null) {
      rafId = requestAnimationFrame(flush);
    }
  }

  /**
   * Immediately execute all pending renders
   * Called automatically by requestAnimationFrame, but can be called manually
   */
  function flush(): void {
    rafId = null;
    const toRender = Array.from(pendingRenders);
    pendingRenders.clear();

    toRender.forEach(name => {
      const fn = renderFnMap.get(name);
      if (fn) {
        try {
          fn();
        } catch (e) {
          console.error(`renderScheduler: ${name} failed`, e);
        }
      }
    });
  }

  return { register, schedule, flush };
}

// ==========================================
// SINGLETON INSTANCE
// ==========================================

/**
 * Default render scheduler instance for app-wide use
 */
export const renderScheduler = createRenderScheduler();
