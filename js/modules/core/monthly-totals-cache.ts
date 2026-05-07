/**
 * Monthly Totals Cache Module
 *
 * Memoizes per-month income / expense / per-category totals to keep
 * hot-path widgets (summary cards, analytics, achievements) off the
 * O(N) transaction scan on every read.
 *
 * Cache invalidation is coordinated through transaction-write hooks in
 * `data-actions.ts`, not through timestamp diffing. Every destructive
 * or mutating transaction operation calls `invalidateMonthCache(month)`
 * (or `invalidateAllCache()` for multi-month rewrites like imports).
 *
 * M33 (Inline-Behavior-Review rev 12, Phase 5f): the module used to
 * compute and store a SHA-256 checksum on every cache write via the
 * Web Crypto SubtleCrypto API, with an XXHash32 fallback for
 * environments where SubtleCrypto was unavailable. The checksum was
 * never read on any cache lookup — `getCachedMonthlyTotals` returned
 * `memoryEntry.data.totals` with no checksum validation — so the
 * infrastructure existed solely as dead crypto on every write, which
 * (a) forced the entire module's async surface (`setCachedMonthlyTotals`,
 * `calculateMonthlyTotalsWithCache`, `preloadMonthlyTotalsCache` and
 * every downstream `Promise<Totals>` signature), (b) required twin
 * `...Sync` variants for the UI hot-path callers that can't await, and
 * (c) forced a rev-12 L62 trackError wrapper around the fire-and-forget
 * `.catch()` pattern at the sync-variant's tail. Deleting the checksum
 * infrastructure collapses all three: the API is now sync throughout,
 * no twin variants exist, and the L62 failure mode (SubtleCrypto
 * rejection → silent cache starvation) is eliminated at the source.
 *
 * @module monthly-totals-cache
 */

import * as signals from './signals.js';
import { toCents, toDollars } from './utils-pure.js';
import { isTrackedExpenseTransaction } from './transaction-classification.js';
import { CONFIG } from './config.js';
import type { Transaction, Totals } from '../../types/index.js';

const DEV = import.meta.env.DEV;

function isCacheDebugEnabled(): boolean {
  return DEV && typeof window !== 'undefined' && window.__APP_DEBUG_CACHE__ === true;
}

// ==========================================
// TYPES
// ==========================================

/**
 * M33: `checksum: string` removed. It was computed via SubtleCrypto
 * SHA-256 on every write and never read on any downstream access.
 * `transactionCount` + `lastTransactionId` remain because they're
 * useful debug/diagnostic metadata surfaced by `debugCache()`.
 */
interface CachedTotals {
  totals: Totals;
  transactionCount: number;
  // Phase 6 Slice 1j (rev 12 L6): widen to allow explicit `undefined`
  // under `exactOptionalPropertyTypes` — callers pull the id from a
  // `?.` chain, which returns `string | undefined`.
  lastTransactionId?: string | undefined;
  timestamp: number;
  monthKey: string;
}

interface TotalsCacheEntry {
  data: CachedTotals;
  expiresAt: number;
  version: number;
  revision: number; // Round 7 fix: invalidation revision tracker for cross-tab sync safety
}

interface CacheStats {
  hits: number;
  misses: number;
  invalidations: number;
  size: number;
  oldestEntry: number;
  newestEntry: number;
}

// ==========================================
// CONFIGURATION
// ==========================================

const CACHE_VERSION = 1;
const CACHE_KEY_PREFIX = 'monthly_totals_cache';
const CACHE_EXPIRY_MS = 60 * 60 * 1000; // 60 minutes (cache is properly invalidated on transaction changes)
const MAX_CACHE_ENTRIES = 50; // Limit memory usage

// ==========================================
// MODULE STATE
// ==========================================

// In-memory cache for fastest access
const memoryCache = new Map<string, TotalsCacheEntry>();

// Round 7 fix: module-level revision counter to prevent stale data repopulation
// during cross-tab sync. Invalidation bumps this; lookup rejects mismatched revisions.
let currentCacheRevision = 0;

// Cache statistics
const cacheStats: CacheStats = {
  hits: 0,
  misses: 0,
  invalidations: 0,
  size: 0,
  oldestEntry: Date.now(),
  newestEntry: Date.now()
};

// Periodic cleanup interval ID
let cleanupIntervalId: number | null = null;

// ==========================================
// CACHE KEY GENERATION
// ==========================================

/**
 * Generate cache key for a month.
 *
 * The `monthly_totals_cache` prefix is a cache-internal key namespace
 * for the in-memory `Map` — it is NOT a localStorage key. The prefix
 * was removed from `APP_LOCAL_STORAGE_PREFIXES` in Phase 5e (#13b /
 * storage-registry) because nothing in this module ever writes to
 * `localStorage`; the wipe list was asserting a no-op.
 */
function getCacheKey(monthKey: string): string {
  return `${CACHE_KEY_PREFIX}_${monthKey}`;
}

// ==========================================
// CACHE OPERATIONS
// ==========================================

/**
 * Get cached monthly totals. Returns null on miss or expiry.
 * Round 7 fix: reject entries with stale revisions to prevent repopulation
 * of stale data during concurrent cross-tab sync operations.
 */
export function getCachedMonthlyTotals(monthKey: string): Totals | null {
  const cacheKey = getCacheKey(monthKey);
  const memoryEntry = memoryCache.get(cacheKey);

  if (memoryEntry) {
    // Round 7 fix: verify not expired AND revision matches current invalidation epoch
    if (memoryEntry.expiresAt > Date.now() && memoryEntry.revision === currentCacheRevision) {
      cacheStats.hits++;
      return memoryEntry.data.totals;
    }
    // CR-Apr24-I finding 281: evict the expired entry immediately instead
    // of leaving it in memoryCache until the next periodic sweep.
    memoryCache.delete(cacheKey);
    cacheStats.size = memoryCache.size;
  }

  cacheStats.misses++;
  return null;
}

/**
 * Cache monthly totals.
 *
 * M33 (Phase 5f): converted from async → sync. The prior async signature
 * existed only to await `generateChecksum(transactions)` (SubtleCrypto
 * SHA-256) whose output was never read on any downstream access.
 * Removing that await removes every failure mode the rev-12 L62
 * `.catch() → trackError` wrapper was protecting against — a pure
 * `Map.set()` plus `cleanupCache()` has no failable await path.
 */
export function setCachedMonthlyTotals(monthKey: string, totals: Totals): void {
  const currentTransactions = getTransactionsForMonth(monthKey);
  const timestamp = Date.now();

  const cachedData: CachedTotals = {
    totals,
    transactionCount: currentTransactions.length,
    lastTransactionId: currentTransactions[currentTransactions.length - 1]?.__backendId,
    timestamp,
    monthKey
  };

  const cacheEntry: TotalsCacheEntry = {
    data: cachedData,
    expiresAt: timestamp + CACHE_EXPIRY_MS,
    version: CACHE_VERSION,
    revision: currentCacheRevision // Round 7 fix: tag entry with current revision
  };

  // Store in memory cache
  memoryCache.set(getCacheKey(monthKey), cacheEntry);

  // Update cache statistics
  cacheStats.size = memoryCache.size;
  cacheStats.newestEntry = timestamp;

  // Cleanup old entries
  cleanupCache();

  // Cache writes are useful for targeted debugging but too noisy for normal dev use.
  if (isCacheDebugEnabled()) console.debug(`Cache: ${monthKey}`, totals);
}

/**
 * Get transactions for a specific month (optimized).
 */
function getTransactionsForMonth(monthKey: string): Transaction[] {
  return signals.transactionsByMonth.value.get(monthKey) || [];
}

/**
 * Invalidate cache when transactions in a given month change.
 * Round 7 fix: bump revision counter to mark all cached entries for this month stale.
 */
export function invalidateMonthCache(monthKey: string): void {
  const cacheKey = getCacheKey(monthKey);

  // Remove from memory cache
  memoryCache.delete(cacheKey);

  // Round 7 fix: increment revision to invalidate all concurrent-in-flight entries
  currentCacheRevision++;

  cacheStats.invalidations++;
  cacheStats.size = memoryCache.size;

  if (isCacheDebugEnabled()) console.debug(`Invalidated cache for ${monthKey}`);
}

/**
 * Invalidate all cached monthly totals. Called by import paths and
 * any operation that rewrites the transaction ledger wholesale.
 * Round 7 fix: bump revision counter to mark all cached entries stale.
 */
export function invalidateAllCache(): void {
  if (isCacheDebugEnabled()) console.debug('Invalidating all monthly totals cache');

  // Clear memory cache
  memoryCache.clear();

  // Round 7 fix: increment revision to invalidate all concurrent-in-flight entries
  currentCacheRevision++;

  cacheStats.invalidations++;
  cacheStats.size = 0;
  // CR-Apr24-I finding 282: reset age diagnostics so getCacheStats()
  // doesn't report timestamps from entries that no longer exist.
  const now = Date.now();
  cacheStats.oldestEntry = now;
  cacheStats.newestEntry = now;
}

/**
 * Clean up old cache entries: drop expired, then cap at MAX_CACHE_ENTRIES
 * by evicting oldest.
 */
function cleanupCache(): void {
  const now = Date.now();
  const entriesToRemove: string[] = [];

  // Remove expired entries
  for (const [key, entry] of memoryCache.entries()) {
    if (entry.expiresAt <= now) {
      entriesToRemove.push(key);
    }
  }

  // Remove from memory
  entriesToRemove.forEach(key => {
    memoryCache.delete(key);
  });

  // If cache is still too large, remove oldest entries
  if (memoryCache.size > MAX_CACHE_ENTRIES) {
    const entries = Array.from(memoryCache.entries());
    entries.sort((a, b) => a[1].data.timestamp - b[1].data.timestamp);

    const toRemove = entries.slice(0, memoryCache.size - MAX_CACHE_ENTRIES);
    toRemove.forEach(([key]) => {
      memoryCache.delete(key);
    });
  }

  // Update oldest entry timestamp
  if (memoryCache.size > 0) {
    const timestamps = Array.from(memoryCache.values()).map(entry => entry.data.timestamp);
    cacheStats.oldestEntry = Math.min(...timestamps);
  }

  cacheStats.size = memoryCache.size;
}

// ==========================================
// MEMOIZED CALCULATION FUNCTIONS
// ==========================================

/**
 * Memoized monthly totals calculation.
 *
 * M33 (Phase 5f): merged the prior async `calculateMonthlyTotalsWithCache`
 * and sync `calculateMonthlyTotalsWithCacheSync` variants into a single
 * sync function. The only reason the async variant existed was to await
 * `setCachedMonthlyTotals` (which was async only to await
 * `generateChecksum`). With the dead checksum infrastructure gone, the
 * cache write is pure in-memory work — no await, no twin API.
 *
 * The ten callers that previously imported `...Sync` now import this
 * name. Zero external callers of the async variant existed (confirmed
 * by rev-12 grep); it was only reached from the now-deleted preload
 * async wrapper.
 */
export function calculateMonthlyTotalsWithCache(monthKey: string): Totals {
  // Try cache first
  const cached = getCachedMonthlyTotals(monthKey);
  if (cached) {
    return cached;
  }

  // Calculate fresh totals
  const transactions = getTransactionsForMonth(monthKey);
  const totals = calculateTotalsFromTransactions(transactions);

  // Cache the result. M33: now a sync call — the prior
  // `setCachedMonthlyTotals(monthKey, totals).catch(err => trackError(...))`
  // fire-and-forget pattern (rev 12 L62) was protecting against
  // SubtleCrypto rejections inside `generateChecksum`. With the
  // checksum machinery deleted, no await and no failure mode remain.
  setCachedMonthlyTotals(monthKey, totals);

  return totals;
}

/**
 * Pure calculation function (no caching).
 */
function calculateTotalsFromTransactions(transactions: Transaction[]): Totals {
  let incomeCents = 0;
  let expensesCents = 0;
  const catCents: Record<string, number> = {};

  for (const tx of transactions) {
    const amtCents = toCents(tx.amount);
    if (tx.type === 'income') {
      incomeCents += amtCents;
    } else if (isTrackedExpenseTransaction(tx)) {
      expensesCents += amtCents;
      catCents[tx.category] = (catCents[tx.category] || 0) + amtCents;
    }
  }

  const income = toDollars(incomeCents);
  const expenses = toDollars(expensesCents);
  const balance = toDollars(incomeCents - expensesCents);

  // Convert category totals to dollars
  const categoryTotals: Record<string, number> = {};
  for (const [cat, cents] of Object.entries(catCents)) {
    categoryTotals[cat] = toDollars(cents);
  }

  return { income, expenses, balance, categoryTotals };
}

/**
 * Preload cache for commonly accessed months.
 *
 * M33 (Phase 5f): converted from async `Promise<void>` to sync `void`.
 * The old async variant parallelized `calculateMonthlyTotalsWithCache`
 * calls via `Promise.all`, but the only reason those were async was
 * the (now-deleted) checksum computation. Synchronous preload is
 * strictly faster here — zero promise/microtask overhead, and the
 * computation itself is trivially parallel-unnecessary (one month's
 * totals do not depend on another's).
 */
export function preloadMonthlyTotalsCache(monthKeys: string[]): void {
  if (DEV) console.log(`Preloading cache for ${monthKeys.length} months`);

  const startTime = performance.now();

  monthKeys.forEach(monthKey => {
    const cached = getCachedMonthlyTotals(monthKey);
    if (!cached) {
      calculateMonthlyTotalsWithCache(monthKey);
    }
  });

  const endTime = performance.now();
  if (DEV) console.log(`Cache preload completed in ${(endTime - startTime).toFixed(2)}ms`);
}

// ==========================================
// STATISTICS AND DEBUGGING
// ==========================================

/**
 * Get cache performance statistics.
 */
export function getCacheStats(): CacheStats & {
  hitRate: number;
  totalRequests: number;
} {
  const totalRequests = cacheStats.hits + cacheStats.misses;
  const hitRate = totalRequests > 0 ? (cacheStats.hits / totalRequests) * 100 : 0;

  return {
    ...cacheStats,
    hitRate: Math.round(hitRate * 100) / 100,
    totalRequests
  };
}

/**
 * Debug cache contents (DEV only).
 */
export function debugCache(): void {
  if (!DEV) return;
  console.group('Monthly Totals Cache Debug');
  console.log('Memory cache size:', memoryCache.size);
  console.log('Cache statistics:', getCacheStats());

  // Show cache contents
  const cacheContents = Array.from(memoryCache.entries()).map(([, entry]) => ({
    monthKey: entry.data.monthKey,
    transactionCount: entry.data.transactionCount,
    expiresIn: Math.max(0, entry.expiresAt - Date.now()),
    totals: entry.data.totals
  }));

  console.table(cacheContents);
  console.groupEnd();
}

/**
 * Reset cache statistics.
 */
export function resetCacheStats(): void {
  cacheStats.hits = 0;
  cacheStats.misses = 0;
  cacheStats.invalidations = 0;
  cacheStats.oldestEntry = Date.now();
  cacheStats.newestEntry = Date.now();
}

// ==========================================
// INITIALIZATION
// ==========================================

/**
 * Initialize cache system. Sets up periodic cleanup (every minute).
 */
export function initMonthlyTotalsCache(): void {
  // Clean up any stale cache entries
  cleanupCache();

  // Set up periodic cleanup (clear previous interval to prevent orphaned timers)
  if (cleanupIntervalId) clearInterval(cleanupIntervalId);
  cleanupIntervalId = window.setInterval(cleanupCache, CONFIG.TIMING.PERIODIC_CLEANUP_INTERVAL);

  if (DEV) console.log('Monthly totals cache initialized');
}

/**
 * Clean up cache system (stop periodic cleanup timer).
 */
export function destroyMonthlyTotalsCache(): void {
  if (cleanupIntervalId) {
    clearInterval(cleanupIntervalId);
    cleanupIntervalId = null;
  }
  memoryCache.clear();
  // CR-Apr24-I finding 280: reset cacheStats so getCacheStats() doesn't
  // report stale size/timestamps from a destroyed cache.
  cacheStats.size = 0;
  const now = Date.now();
  cacheStats.oldestEntry = now;
  cacheStats.newestEntry = now;
}

// ==========================================
// EXPORTS
// ==========================================

/**
 * M33 (Phase 5f): removed `calculateSync` and `preloadSync` aliases.
 * Callers that previously imported `calculateMonthlyTotalsWithCacheSync`
 * / `preloadMonthlyTotalsCacheSync` now import the un-suffixed names.
 */
export default {
  init: initMonthlyTotalsCache,
  destroy: destroyMonthlyTotalsCache,
  getCached: getCachedMonthlyTotals,
  setCached: setCachedMonthlyTotals,
  calculate: calculateMonthlyTotalsWithCache,
  invalidateMonth: invalidateMonthCache,
  invalidateAll: invalidateAllCache,
  preload: preloadMonthlyTotalsCache,
  getStats: getCacheStats,
  debug: debugCache,
  resetStats: resetCacheStats
};
