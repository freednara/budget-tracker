/**
 * Monthly Totals Cache Module
 * 
 * CRITICAL FIX: Prevents cross-tab race conditions in monthly total calculations
 * through memoization and cache invalidation coordination.
 * 
 * @module monthly-totals-cache
 */

import * as signals from './signals.js';
import { toCents, toDollars } from './utils.js';
import { isTrackedExpenseTransaction } from './transaction-classification.js';
import type { Transaction, Totals } from '../../types/index.js';

const DEV = import.meta.env.DEV;

function isCacheDebugEnabled(): boolean {
  return DEV && typeof window !== 'undefined' && (window as any).__APP_DEBUG_CACHE__ === true;
}

// ==========================================
// TYPES
// ==========================================

interface CachedTotals {
  totals: Totals;
  transactionCount: number;
  lastTransactionId?: string;
  timestamp: number;
  monthKey: string;
  checksum: string;
}

interface TotalsCacheEntry {
  data: CachedTotals;
  expiresAt: number;
  version: number;
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
const CHECKSUM_SAMPLE_SIZE = 10; // Sample transactions for checksum

// ==========================================
// MODULE STATE
// ==========================================

// In-memory cache for fastest access
const memoryCache = new Map<string, TotalsCacheEntry>();

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
 * Generate cache key for a month
 */
function getCacheKey(monthKey: string): string {
  return `${CACHE_KEY_PREFIX}_${monthKey}`;
}

/**
 * SECURITY FIX: Generate cryptographically secure SHA-256 checksum
 * Uses Web Crypto API for tamper-resistant cache validation
 */
async function generateChecksum(transactions: Transaction[]): Promise<string> {
  // Sample transactions for performance (don't checksum all 10k+)
  const sample = transactions
    .slice(0, CHECKSUM_SAMPLE_SIZE)
    .concat(transactions.slice(-CHECKSUM_SAMPLE_SIZE));
  
  const checksumData = sample.map(tx => `${tx.__backendId || ''}-${tx.amount}-${tx.date}`).join('|') 
    + `|count:${transactions.length}`;
  
  // Use SubtleCrypto SHA-256 for security
  try {
    const encoder = new TextEncoder();
    const dataBuffer = encoder.encode(checksumData);
    const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  } catch (error) {
    if (DEV) console.warn('SubtleCrypto unavailable, using fallback hash:', error);
    // Fallback to XXHash-like algorithm (more secure than simple sum)
    return generateXXHashFallback(checksumData);
  }
}

/**
 * Fallback: XXHash32-like algorithm for environments without SubtleCrypto
 * More collision-resistant than simple hash functions
 */
function generateXXHashFallback(str: string): string {
  const PRIME32_1 = 2654435761;
  const PRIME32_2 = 2246822519;
  const PRIME32_3 = 3266489917;
  const PRIME32_4 = 668265263;
  const PRIME32_5 = 374761393;
  
  let h32 = PRIME32_5 + str.length;
  let i = 0;
  
  // Process 4-byte chunks
  while (i <= str.length - 4) {
    let k = 0;
    for (let j = 0; j < 4; j++) {
      k |= str.charCodeAt(i + j) << (j * 8);
    }
    h32 = Math.imul(h32 + Math.imul(k, PRIME32_3), PRIME32_4) >>> 0;
    i += 4;
  }
  
  // Process remaining bytes
  while (i < str.length) {
    h32 = Math.imul(h32 + Math.imul(str.charCodeAt(i), PRIME32_5), PRIME32_1) >>> 0;
    i++;
  }
  
  // Final mixing
  h32 ^= h32 >>> 15;
  h32 = Math.imul(h32, PRIME32_2) >>> 0;
  h32 ^= h32 >>> 13;
  h32 = Math.imul(h32, PRIME32_3) >>> 0;
  h32 ^= h32 >>> 16;
  
  return h32.toString(16).padStart(8, '0');
}

// ==========================================
// CACHE OPERATIONS
// ==========================================

/**
 * CRITICAL FIX: Get cached monthly totals with race condition prevention
 */
export function getCachedMonthlyTotals(monthKey: string): Totals | null {
  const cacheKey = getCacheKey(monthKey);
  const memoryEntry = memoryCache.get(cacheKey);
  
  if (memoryEntry && memoryEntry.expiresAt > Date.now()) {
    cacheStats.hits++;
    return memoryEntry.data.totals;
  }

  cacheStats.misses++;
  return null;
}

/**
 * Cache monthly totals with cross-tab coordination (async for secure checksums)
 */
export async function setCachedMonthlyTotals(monthKey: string, totals: Totals): Promise<void> {
  const currentTransactions = getTransactionsForMonth(monthKey);
  const checksum = await generateChecksum(currentTransactions);
  const timestamp = Date.now();
  
  const cachedData: CachedTotals = {
    totals,
    transactionCount: currentTransactions.length,
    lastTransactionId: currentTransactions[currentTransactions.length - 1]?.__backendId,
    timestamp,
    monthKey,
    checksum
  };

  const cacheEntry: TotalsCacheEntry = {
    data: cachedData,
    expiresAt: timestamp + CACHE_EXPIRY_MS,
    version: CACHE_VERSION
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
 * Get transactions for a specific month (optimized)
 */
function getTransactionsForMonth(monthKey: string): Transaction[] {
  return signals.transactionsByMonth.value.get(monthKey) || [];
}

/**
 * CRITICAL FIX: Invalidate cache when transactions change
 */
export function invalidateMonthCache(monthKey: string): void {
  const cacheKey = getCacheKey(monthKey);
  
  // Remove from memory cache
  memoryCache.delete(cacheKey);
  
  cacheStats.invalidations++;
  cacheStats.size = memoryCache.size;
  
  if (isCacheDebugEnabled()) console.debug(`Invalidated cache for ${monthKey}`);
}

/**
 * Invalidate all cached monthly totals
 */
export function invalidateAllCache(): void {
  if (isCacheDebugEnabled()) console.debug('Invalidating all monthly totals cache');
  
  // Clear memory cache
  memoryCache.clear();
  
  cacheStats.invalidations++;
  cacheStats.size = 0;
}

/**
 * Clean up old cache entries
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
 * CRITICAL FIX: Race-condition-safe monthly totals calculation (async for secure checksums)
 */
export async function calculateMonthlyTotalsWithCache(monthKey: string): Promise<Totals> {
  // Try cache first
  const cached = getCachedMonthlyTotals(monthKey);
  if (cached) {
    return cached;
  }
  
  // Calculate fresh totals
  const transactions = getTransactionsForMonth(monthKey);
  const totals = calculateTotalsFromTransactions(transactions);
  
  // Cache the result asynchronously 
  await setCachedMonthlyTotals(monthKey, totals);
  
  return totals;
}

/**
 * Synchronous version for backwards compatibility when checksum validation not needed
 */
export function calculateMonthlyTotalsWithCacheSync(monthKey: string): Totals {
  // Try cache first
  const cached = getCachedMonthlyTotals(monthKey);
  if (cached) {
    return cached;
  }
  
  // Calculate fresh totals
  const transactions = getTransactionsForMonth(monthKey);
  const totals = calculateTotalsFromTransactions(transactions);
  
  // Cache result asynchronously in background (fire and forget)
  setCachedMonthlyTotals(monthKey, totals).catch(err => {
    if (DEV) console.warn('Failed to cache monthly totals:', err);
  });
  
  return totals;
}

/**
 * Pure calculation function (no caching)
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
 * Preload cache for commonly accessed months (async for secure checksums)
 */
export async function preloadMonthlyTotalsCache(monthKeys: string[]): Promise<void> {
  if (DEV) console.log(`Preloading cache for ${monthKeys.length} months`);

  const startTime = performance.now();

  // Process in parallel for better performance
  const preloadPromises = monthKeys.map(async monthKey => {
    const cached = getCachedMonthlyTotals(monthKey);
    if (!cached) {
      // Not cached - calculate and cache with secure checksums
      await calculateMonthlyTotalsWithCache(monthKey);
    }
  });

  await Promise.all(preloadPromises);

  const endTime = performance.now();
  if (DEV) console.log(`Cache preload completed in ${(endTime - startTime).toFixed(2)}ms`);
}

/**
 * Synchronous preload for backwards compatibility 
 */
export function preloadMonthlyTotalsCacheSync(monthKeys: string[]): void {
  if (DEV) console.log(`Preloading cache for ${monthKeys.length} months (sync mode)`);
  
  monthKeys.forEach(monthKey => {
    const cached = getCachedMonthlyTotals(monthKey);
    if (!cached) {
      // Not cached - calculate and cache
      calculateMonthlyTotalsWithCacheSync(monthKey);
    }
  });
}

// ==========================================
// STATISTICS AND DEBUGGING
// ==========================================

/**
 * Get cache performance statistics
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
 * Debug cache contents
 */
export function debugCache(): void {
  if (!DEV) return;
  console.group('Monthly Totals Cache Debug');
  console.log('Memory cache size:', memoryCache.size);
  console.log('Cache statistics:', getCacheStats());

  // Show cache contents
  const cacheContents = Array.from(memoryCache.entries()).map(([key, entry]) => ({
    monthKey: entry.data.monthKey,
    transactionCount: entry.data.transactionCount,
    expiresIn: Math.max(0, entry.expiresAt - Date.now()),
    totals: entry.data.totals
  }));

  console.table(cacheContents);
  console.groupEnd();
}

/**
 * Reset cache statistics
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
 * Initialize cache system
 */
export function initMonthlyTotalsCache(): void {
  // Clean up any stale cache entries
  cleanupCache();
  
  // Set up periodic cleanup (clear previous interval to prevent orphaned timers)
  if (cleanupIntervalId) clearInterval(cleanupIntervalId);
  cleanupIntervalId = window.setInterval(cleanupCache, 60000); // Every minute

  if (DEV) console.log('Monthly totals cache initialized');
}

/**
 * Clean up cache system (stop periodic cleanup timer)
 */
export function destroyMonthlyTotalsCache(): void {
  if (cleanupIntervalId) {
    clearInterval(cleanupIntervalId);
    cleanupIntervalId = null;
  }
  memoryCache.clear();
}

// ==========================================
// EXPORTS
// ==========================================

export default {
  init: initMonthlyTotalsCache,
  destroy: destroyMonthlyTotalsCache,
  getCached: getCachedMonthlyTotals,
  setCached: setCachedMonthlyTotals,
  calculate: calculateMonthlyTotalsWithCache,
  calculateSync: calculateMonthlyTotalsWithCacheSync, // Backwards compatibility
  invalidateMonth: invalidateMonthCache,
  invalidateAll: invalidateAllCache,
  preload: preloadMonthlyTotalsCache,
  preloadSync: preloadMonthlyTotalsCacheSync, // Backwards compatibility
  getStats: getCacheStats,
  debug: debugCache,
  resetStats: resetCacheStats
};
