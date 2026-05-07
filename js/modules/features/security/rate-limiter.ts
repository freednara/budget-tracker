/**
 * Rate Limiter Module - Brute-force protection for PIN entry (and related paths)
 *
 * Tracks failed attempts per-namespace and enforces exponential lockout.
 * State is persisted per-namespace in localStorage so lockouts survive page refreshes.
 * Cross-tab synchronization via BroadcastChannel prevents parallel attacks.
 *
 * NAMESPACES:
 * - 'pin' (default): PIN-entry attempts. Storage keys are unchanged from the
 *   pre-namespace implementation for backward compatibility with persisted
 *   lockouts on upgraded installs.
 * - 'pin_recovery_phrase': Recovery-phrase submission attempts. Fixes M27 —
 *   closes the defense-in-depth gap where the PIN-reset path via recovery
 *   phrase could be brute-forced with no throttling. Namespaced separately
 *   so legitimate recovery-phrase typos don't tangle with the PIN-entry
 *   counter, and exhausting one namespace does not block the other.
 *
 * @module rate-limiter
 */
'use strict';

import { CONFIG } from '../../core/config.js';

// ==========================================
// TYPES
// ==========================================

interface RateLimitState {
  attempts: number;
  lockoutCount: number;
  lockedUntil: number; // epoch ms, 0 = not locked
}

export interface RateLimitCheck {
  allowed: boolean;
  waitMs: number;
  attemptsRemaining: number;
}

/**
 * Rate-limit namespace identifier. See module header for the taxonomy.
 * Defaults to 'pin' on all public entry points to preserve backward
 * compatibility with pre-namespace callers.
 */
export type RateLimitNamespace = 'pin' | 'pin_recovery_phrase';

interface NamespaceContext {
  namespace: RateLimitNamespace;
  storageKey: string;
  sessionKey: string;
  idbKey: string;
  broadcastName: string;
  syncChannel: BroadcastChannel | null;
  inMemoryState: RateLimitState | null;
}

// ==========================================
// CONSTANTS
// ==========================================

const IDB_STORE_NAME = 'rate_limit';
const IDB_DB_NAME = '_pin_rate_limit_idb';
const MAX_ATTEMPTS = CONFIG.RATE_LIMIT.MAX_ATTEMPTS;
const BASE_LOCKOUT_MS = CONFIG.RATE_LIMIT.BASE_LOCKOUT_MS;
/** Cap lockout at 1 hour to prevent overflow from exponential growth */
const MAX_LOCKOUT_MS = 3_600_000;

// ==========================================
// NAMESPACE CONTEXT REGISTRY
// ==========================================

const namespaceContexts = new Map<RateLimitNamespace, NamespaceContext>();

function getContext(namespace: RateLimitNamespace): NamespaceContext {
  const existing = namespaceContexts.get(namespace);
  if (existing) return existing;

  const ctx: NamespaceContext = {
    namespace,
    storageKey: namespace === 'pin' ? '_pin_rate_limit' : `_rate_limit:${namespace}`,
    sessionKey: namespace === 'pin' ? '_pin_rate_limit_session' : `_rate_limit:${namespace}_session`,
    // Single IndexedDB database shared across namespaces, keyed per-namespace.
    // 'pin' keeps the historical 'state' key for backward compatibility.
    idbKey: namespace === 'pin' ? 'state' : namespace,
    broadcastName: namespace === 'pin' ? 'pin_rate_limit_sync' : `pin_rate_limit_sync:${namespace}`,
    syncChannel: null,
    inMemoryState: null
  };
  initSyncChannel(ctx);
  namespaceContexts.set(namespace, ctx);
  return ctx;
}

// ==========================================
// CROSS-TAB SYNC
// ==========================================

function initSyncChannel(ctx: NamespaceContext): void {
  if (ctx.syncChannel) return;
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      ctx.syncChannel = new BroadcastChannel(ctx.broadcastName);
      ctx.syncChannel.onmessage = (event: MessageEvent) => {
        // Phase 6 cleanup (no-explicit-any sweep): MessageEvent.data is
        // typed `any` in lib.dom — narrow through `unknown` with an
        // indexed-shape probe before the RateLimitState cast.
        const raw: unknown = event.data;
        const data = (raw ?? {}) as Record<string, unknown>;
        const incoming = (
          raw &&
          typeof data.attempts === 'number' &&
          typeof data.lockoutCount === 'number' &&
          typeof data.lockedUntil === 'number' &&
          Number.isFinite(data.attempts) &&
          Number.isFinite(data.lockoutCount) &&
          Number.isFinite(data.lockedUntil) &&
          data.attempts >= 0 &&
          data.lockoutCount >= 0 &&
          data.lockedUntil >= 0 &&
          data.attempts <= MAX_ATTEMPTS &&
          data.lockoutCount <= 100
        ) ? data as unknown as RateLimitState : null;
        if (!incoming) return;
        // Accept the stricter (higher attempts / later lockout) state
        const current = ctx.inMemoryState || getDefaultState();
        if (incoming.attempts > current.attempts ||
            incoming.lockedUntil > current.lockedUntil ||
            incoming.lockoutCount > current.lockoutCount) {
          ctx.inMemoryState = incoming;
        }
      };
    }
  } catch (e) {
    // BroadcastChannel not available; cross-tab sync disabled
    if (import.meta.env.DEV) console.debug('[rate-limiter] BroadcastChannel init failed for', ctx.namespace, e);
  }
}

function broadcastState(ctx: NamespaceContext, state: RateLimitState): void {
  try {
    ctx.syncChannel?.postMessage(state);
  } catch (e) {
    if (import.meta.env.DEV) console.debug('[rate-limiter] Broadcast failed for', ctx.namespace, e);
  }
}

// Eagerly initialize the default 'pin' namespace at module load so incoming
// broadcasts from other tabs are received from page-load time (preserves the
// pre-namespace behavior where `initSyncChannel()` ran at import).
getContext('pin');

// ==========================================
// INDEXEDDB BACKUP (harder for users to clear)
// ==========================================

function openIDB(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(IDB_DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE_NAME)) {
          db.createObjectStore(IDB_STORE_NAME);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function saveStateToIDB(ctx: NamespaceContext, state: RateLimitState): Promise<void> {
  const db = await openIDB();
  if (!db) return;
  try {
    const tx = db.transaction(IDB_STORE_NAME, 'readwrite');
    const req = tx.objectStore(IDB_STORE_NAME).put(state, ctx.idbKey);
    // Round 7 fix: Await transaction completion before closing to prevent IDB connection exhaustion.
    // Previously close() was called immediately after put(), which could close the connection
    // before the transaction actually committed, causing connection pool exhaustion.
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Silently ignore IDB write failures
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

async function loadStateFromIDB(ctx: NamespaceContext): Promise<RateLimitState | null> {
  const db = await openIDB();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE_NAME, 'readonly');
      const req = tx.objectStore(IDB_STORE_NAME).get(ctx.idbKey);
      req.onsuccess = () => {
        // IDBRequest.result is typed `any`; narrow through unknown first.
        const raw: unknown = req.result;
        try { db.close(); } catch { /* ignore */ }
        const val = (raw ?? {}) as Record<string, unknown>;
        // Validate IDB state the same way as parseState
        const valid = raw &&
          typeof val.attempts === 'number' && Number.isFinite(val.attempts) && val.attempts >= 0 &&
          typeof val.lockoutCount === 'number' && Number.isFinite(val.lockoutCount) && val.lockoutCount >= 0 &&
          typeof val.lockedUntil === 'number' && Number.isFinite(val.lockedUntil) && val.lockedUntil >= 0;
        resolve(valid ? val as unknown as RateLimitState : null);
      };
      req.onerror = () => {
        try { db.close(); } catch { /* ignore */ }
        resolve(null);
      };
    } catch {
      try { db.close(); } catch { /* ignore */ }
      resolve(null);
    }
  });
}

// ==========================================
// STATE HELPERS
// ==========================================

function parseState(raw: string | null): RateLimitState | null {
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as RateLimitState;
    // Upper bound for lockedUntil: now + MAX_LOCKOUT_MS + small slack. A
    // malicious extension, XSS on a co-tenant origin, or physical-access
    // devtools could otherwise persist lockedUntil = Number.MAX_SAFE_INTEGER
    // and permanently lock the legitimate user out of their own ledger.
    // A legitimate lockout can't exceed MAX_LOCKOUT_MS from the moment it
    // was set; we allow a 1-minute tolerance for clock skew and latency.
    // Fixes L17 (Inline-Behavior-Review rev 12).
    const maxLockoutHorizon = Date.now() + MAX_LOCKOUT_MS + 60_000;
    if (
      typeof parsed.attempts === 'number' &&
      typeof parsed.lockoutCount === 'number' &&
      typeof parsed.lockedUntil === 'number' &&
      Number.isFinite(parsed.attempts) &&
      Number.isFinite(parsed.lockoutCount) &&
      Number.isFinite(parsed.lockedUntil) &&
      parsed.attempts >= 0 &&
      parsed.lockoutCount >= 0 &&
      parsed.lockedUntil >= 0 &&
      parsed.lockedUntil <= maxLockoutHorizon &&
      parsed.attempts <= MAX_ATTEMPTS &&
      parsed.lockoutCount <= 100
    ) {
      return parsed;
    }
  } catch {
    // Ignore malformed persisted data and fall through to other storage tiers.
  }

  return null;
}

function getDefaultState(): RateLimitState {
  return { attempts: 0, lockoutCount: 0, lockedUntil: 0 };
}

/**
 * Pick the stricter of two states (more attempts, later lockout, higher escalation).
 */
function mergeStrictest(a: RateLimitState, b: RateLimitState): RateLimitState {
  return {
    attempts: Math.max(a.attempts, b.attempts),
    lockoutCount: Math.max(a.lockoutCount, b.lockoutCount),
    lockedUntil: Math.max(a.lockedUntil, b.lockedUntil)
  };
}

function loadStateInternal(ctx: NamespaceContext): RateLimitState {
  const localState = parseState(readStorage(() => localStorage.getItem(ctx.storageKey)));
  const sessionState = parseState(readStorage(() => sessionStorage.getItem(ctx.sessionKey)));

  // Merge all available sources, keeping the strictest values
  let best = ctx.inMemoryState ? { ...ctx.inMemoryState } : getDefaultState();
  if (localState) best = mergeStrictest(best, localState);
  if (sessionState) best = mergeStrictest(best, sessionState);

  ctx.inMemoryState = best;
  return best;
}

/**
 * Async load that also checks IndexedDB backup (call on init and after storage clears).
 */
export async function loadStateWithIDBFallback(
  namespace: RateLimitNamespace = 'pin'
): Promise<RateLimitState> {
  const ctx = getContext(namespace);
  const state = loadStateInternal(ctx);
  const idbState = await loadStateFromIDB(ctx);
  if (idbState) {
    const merged = mergeStrictest(state, idbState);
    // Round 7 fix: After merging, if the IDB state is stricter, persist and broadcast the merged state.
    // This prevents cross-tab evasion where one tab's lockout is not visible to other tabs.
    if (merged.attempts > state.attempts ||
        merged.lockedUntil > state.lockedUntil ||
        merged.lockoutCount > state.lockoutCount) {
      saveStateInternal(ctx, merged);
    }
    ctx.inMemoryState = merged;
    return merged;
  }
  return state;
}

function saveStateInternal(ctx: NamespaceContext, state: RateLimitState): void {
  const serialized = JSON.stringify(state);
  ctx.inMemoryState = { ...state };

  const savedToLocal = writeStorage(() => localStorage.setItem(ctx.storageKey, serialized));
  if (savedToLocal) {
    void writeStorage(() => sessionStorage.removeItem(ctx.sessionKey));
  } else {
    void writeStorage(() => sessionStorage.setItem(ctx.sessionKey, serialized));
  }

  // Also persist to IndexedDB as a backup that survives localStorage clearing
  void saveStateToIDB(ctx, state);

  // Broadcast to other tabs (per-namespace channel)
  broadcastState(ctx, state);
}

function readStorage(read: () => string | null): string | null {
  try {
    return read();
  } catch {
    return null;
  }
}

function writeStorage(write: () => void): boolean {
  try {
    write();
    return true;
  } catch {
    return false;
  }
}

// ==========================================
// PUBLIC API
// ==========================================

/**
 * Check whether an attempt is currently allowed for the given namespace.
 * Defaults to the 'pin' namespace for backward compatibility.
 */
export function checkRateLimit(namespace: RateLimitNamespace = 'pin'): RateLimitCheck {
  const ctx = getContext(namespace);
  const state = loadStateInternal(ctx);
  const now = Date.now();

  // Currently in lockout?
  if (state.lockedUntil > now) {
    return {
      allowed: false,
      waitMs: state.lockedUntil - now,
      attemptsRemaining: 0
    };
  }

  // Lockout has expired — clear it but keep lockoutCount for escalation
  if (state.lockedUntil > 0 && state.lockedUntil <= now) {
    state.attempts = 0;
    state.lockedUntil = 0;
    saveStateInternal(ctx, state);
  }

  const remaining = MAX_ATTEMPTS - state.attempts;
  return {
    allowed: remaining > 0,
    waitMs: 0,
    attemptsRemaining: remaining
  };
}

/**
 * Record an attempt result for the given namespace.
 * On success: resets all rate-limit state for that namespace only.
 * On failure: increments counter and may trigger lockout.
 */
export function recordAttempt(
  success: boolean,
  namespace: RateLimitNamespace = 'pin'
): void {
  if (success) {
    resetRateLimit(namespace);
    return;
  }

  const ctx = getContext(namespace);
  const state = loadStateInternal(ctx);
  state.attempts += 1;

  if (state.attempts >= MAX_ATTEMPTS) {
    // Exponential lockout: base * 2^lockoutCount, capped at MAX_LOCKOUT_MS
    const lockoutMs = Math.min(
      BASE_LOCKOUT_MS * Math.pow(2, state.lockoutCount),
      MAX_LOCKOUT_MS
    );
    state.lockedUntil = Date.now() + lockoutMs;
    state.lockoutCount = Math.min(state.lockoutCount + 1, 100);
    // Keep attempts at max so checkRateLimit stays locked until expiry
  }

  saveStateInternal(ctx, state);
}

/**
 * Fully reset rate-limit state for the given namespace (e.g. after a
 * successful PIN entry, a successful recovery-phrase submission, or PIN
 * removal). Scoped to the namespace — does not touch other namespaces.
 */
export function resetRateLimit(namespace: RateLimitNamespace = 'pin'): void {
  const ctx = getContext(namespace);
  ctx.inMemoryState = null;
  void writeStorage(() => localStorage.removeItem(ctx.storageKey));
  void writeStorage(() => sessionStorage.removeItem(ctx.sessionKey));
  // Also clear the IndexedDB backup (write a default record — keeps the
  // namespace key present rather than deleting it, matching pre-namespace
  // behavior for the 'pin' namespace)
  void saveStateToIDB(ctx, getDefaultState());
  // Broadcast reset to other tabs
  broadcastState(ctx, getDefaultState());
}

// ==========================================
// FORMATTING HELPER
// ==========================================

/**
 * Format a lockout duration in milliseconds to a human-readable string.
 * Examples: "5 seconds", "1 minute", "2 minutes 30 seconds"
 */
export function formatLockoutTime(ms: number): string {
  if (ms <= 0) return '0 seconds';

  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  const parts: string[] = [];
  if (minutes > 0) {
    parts.push(`${minutes} minute${minutes === 1 ? '' : 's'}`);
  }
  if (seconds > 0 || parts.length === 0) {
    parts.push(`${seconds} second${seconds === 1 ? '' : 's'}`);
  }

  return parts.join(' ');
}
