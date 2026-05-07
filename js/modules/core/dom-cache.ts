/**
 * DOM Cache Module
 * 
 * High-performance, lightweight caching for frequently accessed DOM elements.
 * Uses WeakRef to prevent memory leaks while avoiding redundant getElementById calls.
 * 
 * @module dom-cache
 */

// ==========================================
// TYPE DEFINITIONS
// ==========================================
// Phase 5g-1 (Inline-Behavior-Review rev 12, L47): fixed the `// = :====`
// typo divider. Pairs with the same correction in backup-reminder.ts:41
// (L55). The source of the typo family is a search-replace gone wrong
// during the original .js → .ts migration; task #147 sweeps any
// remaining instances.

// Phase 5g-2 (Inline-Behavior-Review rev 12, M31): deleted the entire
// `SAFE_MOCK` singleton, `getSafe()` method, and the `SafeMockElement`
// import (+ interface in js/types/index.ts). The finding flagged a
// correctness bug — the mock's `value`/`checked`/`textContent`/`innerHTML`
// were plain properties, so writes from one caller bled into the shared
// singleton and poisoned the read for the next caller. The review
// recommended making the mock per-call, but grep across js/ + tests/
// confirms zero callers of `DOM.getSafe(`, `.getSafe<`, `SAFE_MOCK`, or
// `SafeMockElement`. With no callers, deletion is strictly better than
// per-call allocation: it removes a latent footgun API that encouraged
// silently swallowing missing-element bugs, and eliminates the need to
// maintain a DEV-only miss-warning debouncer. The AGENTS.MD doc example
// that referenced `DOM.getSafe('maybe-missing')` was removed in the
// same pass.

type ElementCache = Map<string, WeakRef<HTMLElement>>;

/**
 * Known static element IDs that persist for the app's entire lifetime.
 *
 * These bypass WeakRef overhead and use a direct-reference fast path
 * in {@link DOMCache#get}. Every id in this list MUST exist in
 * `index.html` at app boot — if one is renamed or removed without
 * updating this list, the fast path silently falls through to the
 * slow WeakRef path (or returns null) with no warning. The contract
 * test at `tests/dom-cache-static-ids.test.ts` (rev 12 L46) enforces
 * the invariant by parsing `index.html` and asserting each id exists.
 *
 * Phase 6 Slice 1g (rev 12 L46): the original list contained 17 ids
 * of which 12 had been silently lost via renames over time; they were
 * pruned here once the contract test revealed them. If you need to
 * add a new long-lived shell element to the fast path, add its id to
 * this constant AND add a matching `id="..."` attribute to
 * `index.html` so the contract test stays green.
 */
export const STATIC_ELEMENT_IDS = [
  'app',
  'main-content',
  'total-income',
  'total-expenses',
  'total-balance'
] as const;

// ==========================================
// DOM CACHE CLASS
// ==========================================

/**
 * WeakRef-backed DOM element cache.
 *
 * Frequently accessed elements are looked up once and cached, eliminating
 * repeated `getElementById` / `querySelector` calls. Static app-shell
 * elements use a direct-reference fast path; all others are wrapped in
 * `WeakRef` so they can be garbage-collected if removed from the DOM.
 */
export class DOMCache {
  private cache: ElementCache = new Map();
  private registry: FinalizationRegistry<{ id: string; version: number }>;
  private registered: WeakSet<HTMLElement> = new WeakSet();

  /**
   * Fast-path cache for known static elements that never leave the DOM.
   * These bypass WeakRef overhead and store direct references.
   */
  private staticCache: Map<string, HTMLElement> = new Map();
  private staticIds: Set<string>;

  // CR-Apr24-I finding 329: monotonic version counter prevents stale
  // finalizer callbacks from evicting newer entries with the same id.
  // Round 7 fix: cacheVersion map is cleaned up via FinalizationRegistry callback
  // (line 98) which automatically removes entries when the element is GC'd.
  // This prevents unbounded growth of the version map over time.
  private cacheVersion = new Map<string, number>();
  private nextVersion = 0;

  /** Initialises the WeakRef cache, FinalizationRegistry, and static element ID set. */
  constructor() {
    this.registry = new FinalizationRegistry((heldValue: { id: string; version: number }) => {
      // Only delete if the version still matches — a newer cache.set
      // for the same id will have bumped the version.
      if (this.cacheVersion.get(heldValue.id) === heldValue.version) {
        this.cache.delete(heldValue.id);
        this.cacheVersion.delete(heldValue.id);
      }
    });

    // Known static element IDs that persist for the app lifetime.
    // See the STATIC_ELEMENT_IDS module-level constant above for the
    // rationale, invariants, and the contract test that enforces them.
    this.staticIds = new Set(STATIC_ELEMENT_IDS);
  }

  /**
   * Get an element by ID, using cache if available.
   * Static elements use a direct-reference fast path (no WeakRef overhead).
   */
  get<T extends HTMLElement = HTMLElement>(id: string): T | null {
    // Fast path for known static elements
    if (this.staticIds.has(id)) {
      const cached = this.staticCache.get(id);
      if (cached?.isConnected) return cached as T;
      if (cached) this.staticCache.delete(id);

      const element = document.getElementById(id);
      if (element) {
        this.staticCache.set(id, element);
        return element as T;
      }
      return null;
    }

    // Standard WeakRef path for dynamic elements
    const ref = this.cache.get(id);

    if (ref) {
      const element = ref.deref();
      if (element?.isConnected) return element as T;
      this.cache.delete(id);
    }

    // Not in cache or stale, query and store
    const element = document.getElementById(id);
    if (element) {
      const version = ++this.nextVersion;
      this.cache.set(id, new WeakRef(element));
      this.cacheVersion.set(id, version);
      // CR-Apr24-I finding 329: register with versioned held value so
      // stale finalizer for a replaced element won't evict the new entry.
      if (!this.registered.has(element)) {
        this.registry.register(element, { id, version });
        this.registered.add(element);
      }
      return element as T;
    }

    return null;
  }

  // Phase 5g-2 (Inline-Behavior-Review rev 12, M31): deleted the
  // `getSafe()` method (see the file-level deletion note at the top
  // of this module for rationale). Callers that need null-safe lookup
  // should use `DOM.get(id)` and guard with `if (!el) return;` — the
  // explicit guard surfaces missing-element bugs instead of silently
  // routing writes into a shared stub.

  /**
   * Direct wrapper for querySelector (uncached)
   */
  query<T extends HTMLElement = HTMLElement>(selector: string): T | null {
    return document.querySelector<T>(selector);
  }

  /**
   * Direct wrapper for querySelectorAll (uncached)
   */
  queryAll<T extends HTMLElement = HTMLElement>(selector: string): NodeListOf<T> {
    return document.querySelectorAll<T>(selector);
  }

  /**
   * Clear an entry from the cache
   */
  clear(id: string): void {
    this.cache.delete(id);
    this.staticCache.delete(id);
  }

  /**
   * Clear all entries from the cache
   */
  clearAll(): void {
    this.cache.clear();
    this.staticCache.clear();
    // CR-Apr24-I finding 330: clear version map so pending finalizer
    // callbacks from pre-clear entries can no longer match any version
    // and thus cannot evict freshly recached entries post-clear.
    this.cacheVersion.clear();
  }

  // Phase 5g-1 (Inline-Behavior-Review rev 12, L47): deleted three
  // `@deprecated` no-op/alias methods (`init()`, `refresh()`,
  // `refreshAll()`). Grep across js/ + tests/ confirms zero callers of
  // `DOM.init(`, `DOM.refresh(`, `DOM.refreshAll(` or any `DOMCache.`
  // equivalents. `clearAll()` is the sole cache-reset entry point and
  // remains in place.
}

// ==========================================
// SINGLETON INSTANCE
// ==========================================

/** Application-wide singleton DOM cache instance. Import this, not the class. */
export const DOM = new DOMCache();
export default DOM;
