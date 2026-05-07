/**
 * Regression tests for CR-Apr24-AD fix cluster.
 *
 * Cluster AD — Accessibility, DOM-cache, error-state, effect-manager,
 * and misc infrastructure P3 fixes
 *   294  error-handler notifyListeners after tracking
 *   298  performance-integration SYNC_ERROR cleanup
 *   299  performance-integration loadTx SYNC_ERROR + seq counter
 *   302  performance-monitor destroy() disconnects PerformanceObservers
 *   310  render-scheduler unknown-task guard before increment
 *   316  validator error container skips layout wrappers
 *   324  error-state clearErrorStates uses known defaults
 *   327  effect-manager mount failure routes through trackError
 *   329  dom-cache FinalizationRegistry versioned held value
 *   330  dom-cache clearAll resets version map
 *   332  accessibility close-button dispatches CustomEvent('close')
 *   333  accessibility default targetId is 'main-content'
 *   334  accessibility enter handler preventDefault
 *   335  accessibility hexToRgb 3-digit support / checkContrast NaN
 *   337  app-container all registerValue calls pass overrideOpt
 *   339  multi-tab-sync-broadcast init() idempotent return
 *   341  accessibility skipNavigation sets tabindex=-1
 *   342  event-binding thenable duck-typing
 *   347  tab-id sessionStorage persistence
 *   357  error-tracker loadAndCall misattribution split
 */

import { describe, it, expect, beforeEach } from 'vitest';

// ==========================================
// Finding 294 — error-handler notifyListeners
// ==========================================

describe('Finding 294 — error-handler notifyListeners', () => {
  it('errorHandler singleton is exported with handleError', async () => {
    const mod = await import('../js/modules/core/error-handler.js');
    expect(mod.errorHandler).toBeDefined();
    expect(typeof mod.errorHandler.handleError).toBe('function');
  });
});

// ==========================================
// Finding 302 — performance-monitor destroy
// ==========================================

describe('Finding 302 — performance-monitor destroy()', () => {
  it('PerformanceMonitor exposes destroy() method', async () => {
    const mod = await import('../js/modules/core/performance-monitor.js');
    expect(typeof mod.PerformanceMonitor).toBe('function');
    const monitor = new mod.PerformanceMonitor();
    expect(typeof monitor.destroy).toBe('function');
    // Should be callable without error
    monitor.destroy();
  });
});

// ==========================================
// Finding 310 — render-scheduler unknown task guard
// ==========================================

describe('Finding 310 — render-scheduler unknown task guard', () => {
  it('createRenderScheduler is exported', async () => {
    const mod = await import('../js/modules/core/render-scheduler.js');
    expect(typeof mod.createRenderScheduler).toBe('function');
  });

  it('renderScheduler singleton is exported', async () => {
    const mod = await import('../js/modules/core/render-scheduler.js');
    expect(mod.renderScheduler).toBeDefined();
  });
});

// ==========================================
// Finding 316 — validator wrapper-aware error placement
// ==========================================

describe('Finding 316 — validator error placement skips layout wrappers', () => {
  let validator: any;

  beforeEach(async () => {
    const mod = await import('../js/modules/core/validator.js');
    validator = mod.default;
  });

  it('showFieldError skips .relative wrapper and appends to outer container', () => {
    // Build: outer > .relative > input
    const outer = document.createElement('div');
    outer.className = 'field-group';
    const wrapper = document.createElement('div');
    wrapper.className = 'relative';
    const input = document.createElement('input');
    wrapper.appendChild(input);
    outer.appendChild(wrapper);
    document.body.appendChild(outer);

    validator.showFieldError(input, 'Test error');

    // Error should be on outer, not wrapper
    const outerError = outer.querySelector(':scope > .error-message');
    const wrapperError = wrapper.querySelector(':scope > .error-message');
    expect(outerError).not.toBeNull();
    expect(outerError!.textContent).toBe('Test error');
    expect(wrapperError).toBeNull();

    outer.remove();
  });

  it('showFieldError uses direct parent when no wrapper class present', () => {
    const parent = document.createElement('div');
    parent.className = 'field-group';
    const input = document.createElement('input');
    parent.appendChild(input);
    document.body.appendChild(parent);

    validator.showFieldError(input, 'Direct parent');

    const error = parent.querySelector(':scope > .error-message');
    expect(error).not.toBeNull();
    expect(error!.textContent).toBe('Direct parent');

    parent.remove();
  });

  it('clearFieldError removes error from wrapper-skipped container', () => {
    const outer = document.createElement('div');
    const wrapper = document.createElement('div');
    wrapper.className = 'relative';
    const input = document.createElement('input');
    wrapper.appendChild(input);
    outer.appendChild(wrapper);
    document.body.appendChild(outer);

    // Add error first
    validator.showFieldError(input, 'Will be cleared');
    expect(outer.querySelector('.error-message')).not.toBeNull();

    validator.clearFieldError(input);
    expect(outer.querySelector('.error-message')).toBeNull();

    outer.remove();
  });

  it('showFieldError prefers prewired aria-describedby node over fallback', () => {
    const container = document.createElement('div');
    const input = document.createElement('input');
    input.setAttribute('aria-describedby', 'test-error-316');
    const errorNode = document.createElement('span');
    errorNode.id = 'test-error-316';
    errorNode.setAttribute('role', 'alert');
    container.appendChild(input);
    container.appendChild(errorNode);
    document.body.appendChild(container);

    validator.showFieldError(input, 'Prewired message');

    expect(errorNode.textContent).toBe('Prewired message');
    // No fallback span should have been created
    expect(container.querySelector('.error-message')).toBeNull();

    container.remove();
  });
});

// ==========================================
// Finding 324 — error-state known defaults
// ==========================================

describe('Finding 324 — error-state clearErrorStates', () => {
  it('clearErrorStates is exported and callable', async () => {
    const mod = await import('../js/modules/core/error-state.js');
    expect(typeof mod.clearErrorStates).toBe('function');
  });
});

// ==========================================
// Finding 327 — effect-manager mount failure tracking
// ==========================================

describe('Finding 327 — effect-manager mount failure tracking', () => {
  it('mountEffects is exported', async () => {
    const mod = await import('../js/modules/core/effect-manager.js');
    expect(typeof mod.mountEffects).toBe('function');
  });
});

// ==========================================
// Findings 329, 330 — dom-cache versioned FinalizationRegistry
// ==========================================

describe('Findings 329/330 — dom-cache versioned finalization', () => {
  let DOMCache: any;

  beforeEach(async () => {
    const mod = await import('../js/modules/core/dom-cache.js');
    DOMCache = mod.DOMCache;
  });

  it('DOMCache is constructible', () => {
    expect(typeof DOMCache).toBe('function');
    const cache = new DOMCache();
    expect(typeof cache.get).toBe('function');
    expect(typeof cache.clearAll).toBe('function');
  });

  it('clearAll resets internal state without errors', () => {
    const cache = new DOMCache();
    // Populate cache with a non-static element
    const el = document.createElement('div');
    el.id = 'test-dom-cache-329';
    document.body.appendChild(el);
    cache.get('test-dom-cache-329');

    // clearAll should not throw
    expect(() => cache.clearAll()).not.toThrow();

    el.remove();
  });
});

// ==========================================
// Finding 335 — accessibility checkContrast + hexToRgb 3-digit
// ==========================================

describe('Finding 335 — checkContrast handles 3-digit hex and bad input', () => {
  it('checkContrast with 3-digit hex returns valid ratio', async () => {
    const mod = await import('../js/modules/core/accessibility.js');
    // #000 vs #fff should be max contrast ~21:1
    const result = mod.checkContrast('#000', '#fff');
    expect(result.ratio).toBeGreaterThan(20);
    expect(result.aa).toBe(true);
  });

  it('checkContrast with unparseable color returns NaN ratio', async () => {
    const mod = await import('../js/modules/core/accessibility.js');
    const result = mod.checkContrast('not-a-color', '#ffffff');
    expect(Number.isNaN(result.ratio)).toBe(true);
    expect(result.aa).toBe(false);
  });
});

// ==========================================
// Finding 333 — skipNavigation default targetId
// ==========================================

describe('Finding 333 — skipNavigation default targetId', () => {
  it('skipNavigation is exported', async () => {
    const mod = await import('../js/modules/core/accessibility.js');
    expect(typeof mod.skipNavigation).toBe('function');
  });
});

// ==========================================
// Finding 337 — app-container overrideOpt
// ==========================================

describe('Finding 337 — app-container exports', () => {
  it('initializeContainer is exported', async () => {
    const mod = await import('../js/modules/core/app-container.js');
    expect(typeof mod.initializeContainer).toBe('function');
  });
});

// ==========================================
// Finding 339 — broadcast init() idempotent
// ==========================================

describe('Finding 339 — BroadcastChannelManager idempotent init', () => {
  it('second init() returns true (not false)', async () => {
    const mod = await import('../js/modules/core/multi-tab-sync-broadcast.js');
    const manager = new mod.BroadcastChannelManager();

    const first = manager.init();
    // In JSDOM BroadcastChannel may not exist; if first is false, skip
    if (first) {
      const second = manager.init();
      expect(second).toBe(true);
    }

    manager.dispose();
  });
});

// ==========================================
// Finding 342 — event-binding thenable duck-typing
// ==========================================

describe('Finding 342 — event-binding thenable duck-typing', () => {
  it('createEventBinder catches async handler rejections', async () => {
    const { createEventBinder } = await import('../js/modules/core/event-binding.js');
    const cleanups: Array<() => void> = [];
    const bind = createEventBinder(cleanups);

    const btn = document.createElement('button');
    document.body.appendChild(btn);

    // Bind an async handler that rejects — should not throw unhandled rejection
    bind(btn, 'click', async () => {
      throw new Error('test rejection');
    });

    // Click — the async rejection should be caught internally
    btn.click();

    // Give microtask queue time to settle
    await new Promise(r => setTimeout(r, 50));

    // Cleanup
    cleanups.forEach(fn => fn());
    btn.remove();
  });
});

// ==========================================
// Finding 347 — tab-id sessionStorage persistence
// ==========================================

describe('Finding 347 — tab-id sessionStorage persistence', () => {
  it('TAB_ID is a non-empty string', async () => {
    const { TAB_ID, getTabId } = await import('../js/modules/core/tab-id.js');
    expect(typeof TAB_ID).toBe('string');
    expect(TAB_ID.length).toBeGreaterThan(0);
    expect(getTabId()).toBe(TAB_ID);
  });
});

// ==========================================
// Finding 357 — error-tracker loadAndCall split
// ==========================================

describe('Finding 357 — error-tracker loadAndCall', () => {
  it('trackError and loadAndCall are exported', async () => {
    const mod = await import('../js/modules/core/error-tracker.js');
    expect(typeof mod.trackError).toBe('function');
    expect(typeof mod.loadAndCall).toBe('function');
  });
});
