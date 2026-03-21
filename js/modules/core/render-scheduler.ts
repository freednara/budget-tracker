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

const DEV = import.meta.env.DEV;

// ==========================================
// TYPES
// ==========================================

export type RenderPriority = 'immediate' | 'user-blocking' | 'normal' | 'low' | 'idle';

export interface RenderTask {
  name: string;
  fn: () => void;
  priority: RenderPriority;
}

export interface RenderScheduler {
  register: (name: string, fn: () => void, priority?: RenderPriority) => void;
  schedule: (...names: string[]) => void;
  scheduleWithPriority: (name: string, priority: RenderPriority) => void;
  cancel: (name: string) => void;
  flush: () => void;
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
  let currentFrameRenderCount = new Map<string, number>();
  let frameStartTime = 0;

  /**
   * Register a render function with a name and priority
   * @param name - Unique identifier for the render function
   * @param fn - The render function to execute
   * @param priority - Render priority (defaults to 'normal')
   */
  function register(name: string, fn: () => void, priority: RenderPriority = 'normal'): void {
    taskRegistry.set(name, { name, fn, priority });
  }

  /**
   * Schedule one or more renders with default priority
   * @param names - Names of render functions to schedule
   */
  function schedule(...names: string[]): void {
    // Check for render loops
    const currentTime = performance.now();
    if (currentTime - frameStartTime > 100) {
      // New frame, reset counters
      currentFrameRenderCount.clear();
      frameStartTime = currentTime;
    }
    
    names.forEach(name => {
      // Check for render loop
      const renderCount = (currentFrameRenderCount.get(name) || 0) + 1;
      currentFrameRenderCount.set(name, renderCount);
      
      if (renderCount > MAX_RENDER_PASSES) {
        if (DEV) console.error(`Render loop detected for "${name}": rendered ${renderCount} times in one frame`);
        // Break the loop by not scheduling this render
        return;
      }
      
      const task = taskRegistry.get(name);
      if (task) {
        taskQueues[task.priority].add(name);
      }
    });
    
    scheduleNextFrame();
  }
  
  /**
   * Schedule a render with specific priority
   * @param name - Name of render function to schedule
   * @param priority - Override priority for this execution
   */
  function scheduleWithPriority(name: string, priority: RenderPriority): void {
    // Check for render loops
    const currentTime = performance.now();
    if (currentTime - frameStartTime > 100) {
      // New frame, reset counters
      currentFrameRenderCount.clear();
      frameStartTime = currentTime;
    }
    
    const renderCount = (currentFrameRenderCount.get(name) || 0) + 1;
    currentFrameRenderCount.set(name, renderCount);
    
    if (renderCount > MAX_RENDER_PASSES) {
      if (DEV) console.error(`Render loop detected for "${name}": rendered ${renderCount} times in one frame`);
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
      if ('requestIdleCallback' in window) {
        idleCallbackId = (window as any).requestIdleCallback(() => flushLowPriority());
      } else {
        // Fallback for browsers without requestIdleCallback
        idleCallbackId = (globalThis as any).setTimeout(() => flushLowPriority(), 50);
      }
    }
  }

  /**
   * Flush high-priority renders with time slicing
   */
  function flushHighPriority(): void {
    rafId = null;
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
      if ('requestIdleCallback' in window) {
        idleCallbackId = (window as any).requestIdleCallback(() => flushLowPriority());
      } else {
        idleCallbackId = (globalThis as any).setTimeout(() => flushLowPriority(), 50);
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
            continue;
          }

          task.fn();
        } catch (e) {
          if (DEV) console.error(`renderScheduler: ${name} failed`, e);
        }
      }
    }
  }

  /**
   * Legacy flush method - processes all queues immediately
   */
  function flush(): void {
    const priorities: RenderPriority[] = ['immediate', 'user-blocking', 'normal', 'low', 'idle'];
    
    for (const priority of priorities) {
      const queue = taskQueues[priority];
      const tasks = Array.from(queue);
      queue.clear();
      
      tasks.forEach(name => {
        const task = taskRegistry.get(name);
        if (task?.fn) {
          try {
            task.fn();
          } catch (e) {
            if (DEV) console.error(`renderScheduler: ${name} failed`, e);
          }
        }
      });
    }
    
    // Cancel scheduled frames
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    if (idleCallbackId !== null) {
      if ('requestIdleCallback' in window) {
        (window as any).cancelIdleCallback(idleCallbackId);
      } else {
        (globalThis as any).clearTimeout(idleCallbackId);
      }
      idleCallbackId = null;
    }
  }

  return { register, schedule, scheduleWithPriority, cancel, flush };
}

// ==========================================
// SINGLETON INSTANCE
// ==========================================

/**
 * Default render scheduler instance for app-wide use
 */
export const renderScheduler = createRenderScheduler();
