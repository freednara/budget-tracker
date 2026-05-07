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

import { trackError } from './error-tracker.js';

const DEV = import.meta.env.DEV;

// ==========================================
// TYPES
// ==========================================

export type RenderPriority = 'immediate' | 'user-blocking' | 'normal' | 'low' | 'idle';

export interface RenderTask {
  name: string;
  // Render tasks may be sync or async. Async suppliers (dynamic imports
  // in `app-events.ts`) fire-and-forget; errors should surface via the
  // trackError catch in processQueue below. Accepting Promise<void>
  // here lets callers pass async functions without wrapping.
  fn: () => void | Promise<void>;
  priority: RenderPriority;
}

export interface RenderScheduler {
  register: (name: string, fn: () => void | Promise<void>, priority?: RenderPriority) => void;
  schedule: (...names: string[]) => void;
  scheduleWithPriority: (name: string, priority: RenderPriority) => void;
  cancel: (name: string) => void;
  // Phase 5g-1 (Inline-Behavior-Review rev 12, L49): removed `flush()`.
  // Grep for `renderScheduler.flush|scheduler.flush` across js/ returned
  // zero callers — the method was labeled `Legacy flush method` in its own
  // docstring and existed only as an unreferenced synchronous drain. Pulling
  // it off the interface means any future accidental re-introduction is a
  // tsc error rather than a silently-dead surface.
}

// ==========================================
// FACTORY FUNCTION
// ==========================================

/**
 * Create a new render scheduler instance with priority-based time slicing
 * @returns RenderScheduler instance with register, schedule, and flush methods
 */
export function createRenderScheduler(): RenderScheduler {
  // Priority queues for different render priorities
  const taskQueues = {
    immediate: new Set<string>(),
    'user-blocking': new Set<string>(),
    normal: new Set<string>(),
    low: new Set<string>(),
    idle: new Set<string>()
  };
  
  let rafId: number | null = null;
  let idleCallbackId: number | null = null;
  
  // Task registry with priority information
  const taskRegistry = new Map<string, RenderTask>();
  
  // Time budget per frame (target 60fps = 16ms, leave 6ms for browser)
  const FRAME_BUDGET = 10; // milliseconds
  
  // Cycle detection
  const MAX_RENDER_PASSES = 10;
  const currentFrameRenderCount = new Map<string, number>();
  /**
   * CR-Apr24-I finding 306: the previous 100ms wall-clock window could
   * accumulate counts across multiple real frames, triggering false
   * render-loop reports on high-refresh displays. Now we use a monotonic
   * frame ID bumped inside the rAF callback (flushHighPriority), so
   * counts are scoped to a single animation frame.
   */
  let currentFrameId = 0;
  let counterFrameId = -1;

  /**
   * Register a render function with a name and priority
   * @param name - Unique identifier for the render function
   * @param fn - The render function to execute
   * @param priority - Render priority (defaults to 'normal')
   */
  function register(name: string, fn: () => void | Promise<void>, priority: RenderPriority = 'normal'): void {
    taskRegistry.set(name, { name, fn, priority });
  }

  /**
   * Schedule one or more renders with default priority
   * @param names - Names of render functions to schedule
   */
  function schedule(...names: string[]): void {
    // CR-Apr24-I finding 306: reset counters on new animation frame
    if (counterFrameId !== currentFrameId) {
      currentFrameRenderCount.clear();
      counterFrameId = currentFrameId;
    }
    
    names.forEach(name => {
      // CR-Apr24-I finding 310: verify the task exists before counting,
      // so an unregistered name cannot trip the render-loop detector.
      const task = taskRegistry.get(name);
      if (!task) {
        if (DEV) console.warn(`[RenderScheduler] Unknown task name: "${name}"`);
        return;
      }

      // Check for render loop
      const renderCount = (currentFrameRenderCount.get(name) || 0) + 1;
      currentFrameRenderCount.set(name, renderCount);

      if (renderCount > MAX_RENDER_PASSES) {
        if (DEV) console.error(`Render loop detected for "${name}": rendered ${renderCount} times in one frame`);
        if (renderCount === MAX_RENDER_PASSES + 1) {
          trackError(
            new Error(`Render loop detected for "${name}" (>${MAX_RENDER_PASSES} schedules in one frame)`),
            { module: 'RenderScheduler', action: `schedule_render_loop_${name}` }
          );
        }
        return;
      }

      taskQueues[task.priority].add(name);
    });
    
    scheduleNextFrame();
  }
  
  /**
   * Schedule a render with specific priority
   * @param name - Name of render function to schedule
   * @param priority - Override priority for this execution
   */
  function scheduleWithPriority(name: string, priority: RenderPriority): void {
    // CR-Apr24-I finding 306: reset counters on new animation frame
    if (counterFrameId !== currentFrameId) {
      currentFrameRenderCount.clear();
      counterFrameId = currentFrameId;
    }
    
    const renderCount = (currentFrameRenderCount.get(name) || 0) + 1;
    currentFrameRenderCount.set(name, renderCount);

    if (renderCount > MAX_RENDER_PASSES) {
      if (DEV) console.error(`Render loop detected for "${name}": rendered ${renderCount} times in one frame`);
      // rev 12 M30 (#32 observability): boundary-only trackError — see
      // matching comment in schedule() above.
      if (renderCount === MAX_RENDER_PASSES + 1) {
        trackError(
          new Error(`Render loop detected for "${name}" (>${MAX_RENDER_PASSES} schedules in one frame)`),
          { module: 'RenderScheduler', action: `scheduleWithPriority_render_loop_${name}` }
        );
      }
      return;
    }

    taskQueues[priority].add(name);
    scheduleNextFrame();
  }
  
  /**
   * Cancel a scheduled render
   * @param name - Name of the render task to cancel
   */
  function cancel(name: string): void {
    Object.values(taskQueues).forEach(queue => queue.delete(name));
  }

  /**
   * Schedule the next animation frame or idle callback
   */
  function scheduleNextFrame(): void {
    // Schedule immediate and user-blocking tasks with RAF
    if ((taskQueues.immediate.size > 0 || taskQueues['user-blocking'].size > 0 || 
         taskQueues.normal.size > 0) && rafId === null) {
      rafId = requestAnimationFrame(() => flushHighPriority());
    }
    
    // Schedule low priority and idle tasks with requestIdleCallback
    if ((taskQueues.low.size > 0 || taskQueues.idle.size > 0) && 
        idleCallbackId === null) {
      if (typeof window.requestIdleCallback === 'function') {
        idleCallbackId = window.requestIdleCallback(() => flushLowPriority());
      } else {
        // Fallback for browsers without requestIdleCallback
        // setTimeout in browsers returns `number`. The cast through globalThis
        // (instead of bare setTimeout) preserves the older fallback shape used
        // before requestIdleCallback shipped — no `any` escape needed.
        idleCallbackId = (globalThis as typeof window).setTimeout(() => flushLowPriority(), 50);
      }
    }
  }

  /**
   * Flush high-priority renders with time slicing
   */
  function flushHighPriority(): void {
    rafId = null;
    // CR-Apr24-I finding 306: advance frame ID so cycle-detection counters
    // are scoped to this actual animation frame, not a wall-clock window.
    currentFrameId++;
    const startTime = performance.now();
    
    // Process tasks by priority with time slicing
    processQueue('immediate', startTime, FRAME_BUDGET);
    
    if (performance.now() - startTime < FRAME_BUDGET) {
      processQueue('user-blocking', startTime, FRAME_BUDGET);
    }
    
    if (performance.now() - startTime < FRAME_BUDGET) {
      processQueue('normal', startTime, FRAME_BUDGET);
    }
    
    // If we still have high-priority tasks, schedule another frame
    if (taskQueues.immediate.size > 0 || taskQueues['user-blocking'].size > 0 || 
        taskQueues.normal.size > 0) {
      rafId = requestAnimationFrame(() => flushHighPriority());
    }
  }
  
  /**
   * Flush low-priority renders during idle time
   */
  function flushLowPriority(): void {
    idleCallbackId = null;
    const startTime = performance.now();
    
    processQueue('low', startTime, 50); // More time for low priority
    processQueue('idle', startTime, 50);
    
    // If we still have low-priority tasks, schedule another idle callback
    if (taskQueues.low.size > 0 || taskQueues.idle.size > 0) {
      if (typeof window.requestIdleCallback === 'function') {
        idleCallbackId = window.requestIdleCallback(() => flushLowPriority());
      } else {
        // setTimeout in browsers returns `number`. The cast through globalThis
        // (instead of bare setTimeout) preserves the older fallback shape used
        // before requestIdleCallback shipped — no `any` escape needed.
        idleCallbackId = (globalThis as typeof window).setTimeout(() => flushLowPriority(), 50);
      }
    }
  }
  
  /**
   * Process a specific priority queue with time budget
   */
  function processQueue(priority: RenderPriority, startTime: number, budget: number): void {
    const queue = taskQueues[priority];
    const tasks = Array.from(queue);
    queue.clear();
    
    for (const name of tasks) {
      // Check time budget
      if (performance.now() - startTime >= budget) {
        // Out of time, re-queue remaining tasks
        tasks.slice(tasks.indexOf(name)).forEach(n => queue.add(n));
        break;
      }
      
      const task = taskRegistry.get(name);
      if (task?.fn) {
        try {
          // Check current count (already incremented in schedule()) — don't double-count
          const count = currentFrameRenderCount.get(name) || 0;

          if (count > MAX_RENDER_PASSES) {
            if (DEV) console.warn(`Render loop detected for "${name}": rendered ${count} times in one frame. Breaking loop.`);
            // No trackError here — schedule() / scheduleWithPriority() already
            // emitted at the boundary; processQueue runs later in the same
            // frame on the same name and would double-fire.
            continue;
          }

          const result = task.fn();
          // Async render task: attach the same trackError routing we use
          // for sync throws so promise rejections don't become silent
          // unhandled rejections.
          if (result && typeof (result as Promise<void>).then === 'function') {
            (result as Promise<void>).catch((asyncErr: unknown) => {
              trackError(asyncErr instanceof Error ? asyncErr : new Error(String(asyncErr)), {
                module: 'RenderScheduler',
                action: `processQueue_task_rejected_${name}`,
              });
            });
          }
        } catch (e) {
          // rev 12 M30 (#32 observability): render-task exceptions were
          // DEV-only-logged then silently dropped — meaning a thrown
          // render in prod produces *no signal at all* even though it
          // visibly breaks the UI. trackError lets these surface in
          // telemetry; we still swallow to keep the queue draining (one
          // bad render mustn't take down the whole frame).
          trackError(e instanceof Error ? e : new Error(String(e)), {
            module: 'RenderScheduler',
            action: `processQueue_task_threw_${name}`,
          });
        }
      }
    }
  }

  // Phase 5g-1 (Inline-Behavior-Review rev 12, L49): removed the legacy
  // `flush()` method (34 LOC). It processed all queues synchronously and
  // cancelled pending rAF/idleCallback handles, but had zero callers —
  // scheduling and cancellation already happen naturally via `schedule` /
  // `cancel`. The interface entry was also removed so no caller can
  // silently re-surface the method.

  return { register, schedule, scheduleWithPriority, cancel };
}

// ==========================================
// SINGLETON INSTANCE
// ==========================================

/**
 * Default render scheduler instance for app-wide use
 */
export const renderScheduler = createRenderScheduler();
