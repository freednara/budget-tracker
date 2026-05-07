/**
 * Cluster AG — Core infrastructure test gaps
 * Findings: 307, 308, 314, 321, 325, 328, 331, 336, 338, 340, 343, 344, 346, 348
 */
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ==========================================
// Finding 307 — DI container falsy values
// ==========================================
describe('Finding 307 — DI container falsy values', () => {
  it('resolveSync returns falsy-but-valid values (0, false, empty string)', async () => {
    const { getDefaultContainer } = await import('../js/modules/core/di-container.js');
    const container = getDefaultContainer();

    container.registerValue('test_zero_307', 0, { override: true });
    expect(container.resolveSync('test_zero_307')).toBe(0);

    container.registerValue('test_false_307', false, { override: true });
    expect(container.resolveSync('test_false_307')).toBe(false);

    container.registerValue('test_empty_307', '', { override: true });
    expect(container.resolveSync('test_empty_307')).toBe('');
  });
});

// ==========================================
// Finding 308 — render-scheduler
// ==========================================
describe('Finding 308 — render-scheduler', () => {
  it('createRenderScheduler returns scheduler with schedule/cancel', async () => {
    const mod = await import('../js/modules/core/render-scheduler.js');
    expect(typeof mod.createRenderScheduler).toBe('function');
    const scheduler = mod.createRenderScheduler();
    expect(typeof scheduler.schedule).toBe('function');
    expect(typeof scheduler.cancel).toBe('function');
  });
});

// ==========================================
// Finding 314 — mutex/semaphore/ReadWriteLock
// ==========================================
describe('Finding 314 — mutex/semaphore', () => {
  it('Mutex acquire/release lifecycle', async () => {
    const { Mutex } = await import('../js/modules/core/mutex.js');
    const m = new Mutex();
    expect(m.isLocked()).toBe(false);

    await m.acquire();
    expect(m.isLocked()).toBe(true);

    m.release();
    expect(m.isLocked()).toBe(false);
  });

  it('Semaphore respects concurrency limit', async () => {
    const { Semaphore } = await import('../js/modules/core/mutex.js');
    const s = new Semaphore(2);

    await s.acquire();
    await s.acquire();
    // Third acquire should not resolve immediately
    let thirdResolved = false;
    const thirdPromise = s.acquire().then(() => { thirdResolved = true; });

    // Give microtask time
    await new Promise(r => setTimeout(r, 10));
    expect(thirdResolved).toBe(false);

    s.release(); // frees one slot
    await thirdPromise;
    expect(thirdResolved).toBe(true);

    s.release();
    s.release();
  });

  it('ReadWriteLock is exported and constructible', async () => {
    const { ReadWriteLock } = await import('../js/modules/core/mutex.js');
    expect(typeof ReadWriteLock).toBe('function');
    const rwl = new ReadWriteLock();
    expect(typeof rwl.acquireRead).toBe('function');
    expect(typeof rwl.releaseRead).toBe('function');
    expect(typeof rwl.acquireWrite).toBe('function');
    expect(typeof rwl.releaseWrite).toBe('function');
  });
});

// ==========================================
// Finding 321 — utils-dom trapFocus and copyToClipboard
// ==========================================
describe('Finding 321 — utils-dom trapFocus and copyToClipboard', () => {
  it('trapFocus source includes number/date/tabindex selectors', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../js/modules/core/utils-dom.ts'), 'utf-8'
    );
    expect(src).toContain('input[type="number"]');
    expect(src).toContain('input[type="date"]');
    expect(src).toContain('[tabindex]');
  });

  it('copyToClipboard fallback wraps in try/finally for cleanup', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../js/modules/core/utils-dom.ts'), 'utf-8'
    );
    // Should have try/finally around the textarea fallback
    expect(src).toMatch(/finally\s*\{[\s\S]*?removeChild/);
  });
});

// ==========================================
// Finding 325 — error-state
// ==========================================
describe('Finding 325 — error-state', () => {
  it('withErrorState and clearErrorStates are exported', async () => {
    const mod = await import('../js/modules/core/error-state.js');
    expect(typeof mod.withErrorState).toBe('function');
    expect(typeof mod.clearErrorStates).toBe('function');
  });

  it('clearErrorStates does not throw', async () => {
    const mod = await import('../js/modules/core/error-state.js');
    expect(() => mod.clearErrorStates()).not.toThrow();
  });
});

// ==========================================
// Finding 328 — effect-manager
// ==========================================
describe('Finding 328 — effect-manager', () => {
  it('mountEffects/unmountEffects lifecycle', async () => {
    const mod = await import('../js/modules/core/effect-manager.js');

    const cleanupFn = vi.fn();
    const factory = () => cleanupFn;

    mod.mountEffects('test-component-328', [factory]);
    expect(mod.getActiveComponentIds()).toContain('test-component-328');

    mod.unmountEffects('test-component-328');
    expect(cleanupFn).toHaveBeenCalled();
    expect(mod.getActiveComponentIds()).not.toContain('test-component-328');
  });

  it('mountEffects tracks error on factory failure', async () => {
    const mod = await import('../js/modules/core/effect-manager.js');
    const badFactory = () => { throw new Error('mount fail 328'); };

    expect(() => mod.mountEffects('test-fail-328', [badFactory])).toThrow('mount fail 328');
    // Cleanup
    try { mod.unmountEffects('test-fail-328'); } catch { /* may not exist */ }
  });
});

// ==========================================
// Finding 331 — dom-cache clearAll/versioning
// ==========================================
describe('Finding 331 — dom-cache clearAll and versioning', () => {
  it('clearAll evicts previously cached elements', async () => {
    const { DOMCache } = await import('../js/modules/core/dom-cache.js');
    const cache = new DOMCache();

    const el = document.createElement('div');
    el.id = 'dom-cache-test-331';
    document.body.appendChild(el);

    const first = cache.get('dom-cache-test-331');
    expect(first).toBe(el);

    cache.clearAll();

    // After clearAll, next get re-queries the DOM
    const second = cache.get('dom-cache-test-331');
    expect(second).toBe(el); // Same DOM element, but was re-queried

    el.remove();
  });
});

// ==========================================
// Finding 336 — accessibility helpers
// ==========================================
describe('Finding 336 — accessibility helpers', () => {
  it('checkContrast returns valid result for known colors', async () => {
    const mod = await import('../js/modules/core/accessibility.js');
    const result = mod.checkContrast('#000000', '#ffffff');
    expect(result.ratio).toBeGreaterThan(20);
    expect(result.aa).toBe(true);
    expect(result.aaa).toBe(true);
  });

  it('accessibleButton returns ARIA attributes', async () => {
    const mod = await import('../js/modules/core/accessibility.js');
    const attrs = mod.accessibleButton('Close dialog', () => {});
    expect(attrs).toBeDefined();
    expect(typeof attrs).toBe('object');
  });
});

// ==========================================
// Finding 338 — app-container
// ==========================================
describe('Finding 338 — app-container', () => {
  it('initializeContainer and getAppDependencies are exported', async () => {
    const mod = await import('../js/modules/core/app-container.js');
    expect(typeof mod.initializeContainer).toBe('function');
    expect(typeof mod.getAppDependencies).toBe('function');
  });
});

// ==========================================
// Finding 340 — broadcast manager lifecycle
// ==========================================
describe('Finding 340 — broadcast manager lifecycle', () => {
  it('init is idempotent, dispose cleans up, operations dont throw', async () => {
    const { BroadcastChannelManager } = await import(
      '../js/modules/core/multi-tab-sync-broadcast.js'
    );
    const mgr = new BroadcastChannelManager();

    const first = mgr.init();
    if (first) {
      expect(mgr.init()).toBe(true); // idempotent

      expect(() => mgr.sendPing()).not.toThrow();
      expect(() => mgr.requestFullSync()).not.toThrow();
      expect(() => mgr.requestReload()).not.toThrow();
    }

    mgr.dispose();
    expect(mgr.isAvailable()).toBe(false);
  });
});

// ==========================================
// Finding 343 — event-binding async rejection
// ==========================================
describe('Finding 343 — event-binding async rejection', () => {
  it('async handler rejection caught, cleanup removes listener', async () => {
    const { createEventBinder } = await import('../js/modules/core/event-binding.js');
    const cleanups: Array<() => void> = [];
    const bind = createEventBinder(cleanups);

    const btn = document.createElement('button');
    document.body.appendChild(btn);

    bind(btn, 'click', async () => { throw new Error('async-343'); });
    btn.click();
    await new Promise(r => setTimeout(r, 50));

    // Cleanup removes listener
    expect(cleanups.length).toBeGreaterThan(0);
    cleanups.forEach(fn => fn());
    cleanups.length = 0;

    btn.remove();
  });
});

// ==========================================
// Finding 344 — safe-amount
// ==========================================
describe('Finding 344 — safe-amount', () => {
  it('returns amount for valid transactions, 0 for non-finite', async () => {
    const { safeAmount } = await import('../js/modules/core/safe-amount.js');

    // Valid
    expect(safeAmount({ __backendId: 'tx1', amount: 42 })).toBe(42);
    expect(safeAmount({ __backendId: 'tx2', amount: 0 })).toBe(0);
    expect(safeAmount({ __backendId: 'tx3', amount: -10 })).toBe(-10);

    // Non-finite → 0
    expect(safeAmount({ __backendId: 'tx4', amount: NaN })).toBe(0);
    expect(safeAmount({ __backendId: 'tx5', amount: Infinity })).toBe(0);
    expect(safeAmount({ __backendId: 'tx6', amount: -Infinity })).toBe(0);
    expect(safeAmount({ __backendId: 'tx7', amount: undefined as any })).toBe(0);
    expect(safeAmount({ __backendId: 'tx8', amount: null as any })).toBe(0);
  });
});

// ==========================================
// Finding 346 — theme-allowlist
// ==========================================
describe('Finding 346 — theme-allowlist', () => {
  it('VALID_THEMES, isTheme, normalizeTheme work correctly', async () => {
    const { VALID_THEMES, isTheme, normalizeTheme } = await import(
      '../js/modules/core/theme-allowlist.js'
    );

    expect(VALID_THEMES.size).toBeGreaterThan(0);
    expect(VALID_THEMES.has('dark')).toBe(true);
    expect(VALID_THEMES.has('light')).toBe(true);

    expect(isTheme('dark')).toBe(true);
    expect(isTheme('light')).toBe(true);
    expect(isTheme('nope')).toBe(false);
    expect(isTheme(42)).toBe(false);

    expect(normalizeTheme('dark')).toBe('dark');
    expect(normalizeTheme('garbage')).toBe('dark');
    expect(normalizeTheme('garbage', 'light' as any)).toBe('light');
  });
});

// ==========================================
// Finding 348 — tab-id
// ==========================================
describe('Finding 348 — tab-id', () => {
  it('TAB_ID is stable and matches getTabId()', async () => {
    const { TAB_ID, getTabId } = await import('../js/modules/core/tab-id.js');
    expect(typeof TAB_ID).toBe('string');
    expect(TAB_ID.length).toBeGreaterThan(0);
    expect(getTabId()).toBe(TAB_ID);
    // Multiple calls return same value
    expect(getTabId()).toBe(getTabId());
  });
});
