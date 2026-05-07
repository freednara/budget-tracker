/**
 * Optimized Filter Worker - High-performance transaction filtering
 * 
 * FIXED: Addresses all performance bottlenecks from Part 6 review:
 * 1. Pre-indexed month keys to avoid redundant date parsing
 * 2. Integer timestamps for proper date sorting
 * 3. In-memory dataset to avoid data transfer overhead
 * 4. Shared money conversion functions for consistency
 */
'use strict';

import type {
  Transaction,
  WorkerMessage,
  WorkerFilterPayload,
  WorkerAggregatePayload,
  WorkerSearchPayload,
  WorkerTransactionFilters,
  WorkerAggregations,
  WorkerPaginatedResult,
  WorkerFilterResult,
  WorkerResponse,
  WorkerSortField,
  WorkerSortDirection,
  WorkerUpdatePayload,
  WorkerAbortPayload
} from '../types/index.js';

// Import shared money functions for consistency
// FIXED: Using exact same functions as main thread
// rev 12 / #41: parseLocalDate imported from shared helper to eliminate drift
// between worker and main thread. Worker-local cache-wrapper below preserves
// batch-processing perf characteristic unique to the worker.
import { toCents, toDollars, parseLocalDate as parseLocalDateShared } from '../modules/core/utils-pure.js';
import { isTrackedExpenseTransaction } from '../modules/core/transaction-classification.js';

// Worker global scope types
interface WorkerGlobalScope {
  onmessage: ((e: MessageEvent<WorkerMessage>) => void) | null;
  postMessage(message: WorkerResponse): void;
}

declare const self: WorkerGlobalScope;

// ==========================================
// OPTIMIZED DATA STRUCTURES
// ==========================================

/**
 * Pre-indexed transaction for fast filtering
 * FIXED: Avoids redundant date parsing
 */
interface IndexedTransaction extends Transaction {
  // Pre-computed indexes
  _monthKey: string;        // YYYY-MM for O(1) month filtering
  _timestamp: number;        // Unix timestamp for proper sorting
  _searchText: string;       // Concatenated lowercase search fields
  _tagsText: string;         // Lowercase tags-only text for dedicated tag filters
  _amountCents: number;      // Pre-converted to cents
}

// ==========================================
// WORKER STATE (In-Memory Dataset)
// ==========================================

// CRITICAL FIX: Persistent in-memory dataset to avoid 10k+ transaction transfers
let transactionDataset: IndexedTransaction[] = [];
let lastUpdateTimestamp = 0;
let lastDatasetHash = '';
let datasetInitialized = false;
// Vite exposes `import.meta.env` at build time; in TS without the Vite client
// typings it's untyped, so we narrow the lookup manually rather than reaching
// through `any`.
const DEV = typeof import.meta !== 'undefined'
  && typeof (import.meta as { env?: { DEV?: boolean } }).env?.DEV === 'boolean'
  && (import.meta as { env?: { DEV?: boolean } }).env!.DEV === true;

// Performance tracking
const operationStats = {
  filterOperations: 0,
  aggregateOperations: 0,
  searchOperations: 0,
  datasetUpdates: 0,
  averageFilterTime: 0,
  averageSearchTime: 0
};

/**
 * Fixes H15 (Inline-Behavior-Review rev 12): request IDs the main thread
 * has told us to abandon. The worker checks this set at cancellation
 * checkpoints (start of each filter/search/aggregate branch and right
 * before `postMessage`) so an abort arrives before the result does, the
 * result is dropped instead of racing back.
 *
 * Kept bounded by `MAX_CANCELLED_IDS`: we only need to remember an ID
 * until its in-flight operation would have responded, and the main thread
 * has already forgotten the request (either by timeout reject or
 * AbortController reject) — so purging in FIFO order by count is safe.
 */
const cancelledRequestIds = new Set<number>();
const cancelledOrder: number[] = [];
const MAX_CANCELLED_IDS = 256;

function markCancelled(requestId: number): void {
  if (cancelledRequestIds.has(requestId)) return;
  cancelledRequestIds.add(requestId);
  cancelledOrder.push(requestId);
  while (cancelledOrder.length > MAX_CANCELLED_IDS) {
    const evicted = cancelledOrder.shift();
    if (evicted !== undefined) cancelledRequestIds.delete(evicted);
  }
}

function isCancelled(requestId: number): boolean {
  return cancelledRequestIds.has(requestId);
}

// ==========================================
// DATA INDEXING
// ==========================================

/**
 * Parse date once and create indexed transaction
 * FIXED: Pre-compute all derived fields
 */
function indexTransaction(tx: Transaction): IndexedTransaction {
  // Parse date once
  const dateObj = parseLocalDate(tx.date);
  const timestamp = dateObj.getTime();
  
  // Pre-compute month key
  const monthKey = dateObj.getFullYear() + '-' + 
    String(dateObj.getMonth() + 1).padStart(2, '0');
  
  // Pre-build search text (lowercase for case-insensitive search)
  const tagsText = Array.isArray(tx.tags) ? tx.tags.join(' ') : (tx.tags || '');
  const searchText = [
    tx.description || '',
    tx.notes || '',
    tagsText,
    tx.category || ''
  ].join(' ').toLowerCase();
  
  // Pre-convert amount to cents using shared function
  const amountCents = toCents(tx.amount);
  
  return {
    ...tx,
    _monthKey: monthKey,
    _timestamp: timestamp,
    _searchText: searchText,
    _tagsText: tagsText.toLowerCase(),
    _amountCents: amountCents
  };
}

// ==========================================
// OPTIMIZED FILTERING
// ==========================================

/**
 * Filter transactions using pre-indexed fields
 * FIXED: O(1) month comparison instead of O(N) date parsing
 */
function filterTransactionsOptimized(
  filters: WorkerTransactionFilters
): IndexedTransaction[] {
  const {
    monthKey,
    showAllMonths,
    type,
    category,
    searchQuery,
    search,
    tagsFilter,
    dateFrom,
    dateTo,
    minAmount,
    maxAmount,
    recurringOnly,
    reconciled
  } = filters as WorkerTransactionFilters & { search?: string };

  // Pre-process filters for efficiency
  // Support both deprecated `searchQuery` and new `search` fields
  // CR-Apr24-I finding 246: add .trim() to match the sync fallback path,
  // so leading/trailing whitespace in queries behaves identically.
  const query = (searchQuery || search)?.toLowerCase().trim() || undefined;
  const tagsQuery = tagsFilter?.toLowerCase().trim() || undefined;
  
  // Convert date strings to timestamps once
  const dateFromTs = dateFrom ? parseLocalDate(dateFrom).getTime() : null;
  const dateToTs = dateTo ? parseLocalDate(dateTo).getTime() : null;
  
  // Convert amounts to cents once
  const minCents = minAmount !== undefined && minAmount !== '' 
    ? toCents(typeof minAmount === 'number' ? minAmount : parseFloat(minAmount))
    : null;
  const maxCents = maxAmount !== undefined && maxAmount !== '' 
    ? toCents(typeof maxAmount === 'number' ? maxAmount : parseFloat(maxAmount))
    : null;

  return transactionDataset.filter(tx => {
    // FIXED: Use pre-indexed month key (O(1) string comparison)
    if (!showAllMonths && monthKey && tx._monthKey !== monthKey) {
      return false;
    }

    // Type filter
    if (type && type !== 'all' && tx.type !== type) return false;

    // Category filter
    if (category && category !== 'all') {
      if (tx.category !== category) {
        return false;
      }
    }

    // FIXED: Use pre-built search text (no string operations per transaction)
    if (query && !tx._searchText.includes(query)) {
      return false;
    }

    // Tags filter
    if (tagsQuery && !tx._tagsText.includes(tagsQuery)) {
      return false;
    }

    // FIXED: Use pre-computed timestamps for date comparison
    if (dateFromTs && tx._timestamp < dateFromTs) return false;
    if (dateToTs && tx._timestamp > dateToTs) return false;

    // FIXED: Use pre-computed cents for amount comparison
    if (minCents !== null && tx._amountCents < minCents) return false;
    if (maxCents !== null && tx._amountCents > maxCents) return false;

    // Recurring filter
    if (recurringOnly && !tx.recurring) return false;

    // Reconciled filter
    if (reconciled !== undefined && reconciled !== 'all') {
      const isReconciled = !!tx.reconciled;
      const wantReconciled = reconciled === 'yes' || reconciled === true;
      if (isReconciled !== wantReconciled) return false;
    }

    return true;
  });
}

// ==========================================
// OPTIMIZED SORTING
// ==========================================

/**
 * Sort transactions using proper data types
 * FIXED: Uses timestamps for dates, ensuring correct order
 */
function sortTransactionsOptimized(
  transactions: IndexedTransaction[],
  sortBy: WorkerSortField,
  sortDir: WorkerSortDirection
): IndexedTransaction[] {
  const sorted = [...transactions];
  const multiplier = sortDir === 'asc' ? 1 : -1;

  sorted.sort((a, b) => {
    let comparison = 0;

    switch (sortBy) {
      case 'date':
        // FIXED: Use timestamp for proper date sorting
        comparison = (a._timestamp || 0) - (b._timestamp || 0);
        break;
      case 'amount':
        // FIXED: Use pre-computed cents for accurate sorting
        comparison = a._amountCents - b._amountCents;
        break;
      case 'description':
        comparison = (a.description || '').localeCompare(b.description || '');
        break;
      case 'category':
        comparison = (a.category || '').localeCompare(b.category || '');
        break;
      default:
        comparison = (a._timestamp || 0) - (b._timestamp || 0);
    }

    return comparison * multiplier;
  });

  return sorted;
}

// ==========================================
// OPTIMIZED AGGREGATION
// ==========================================

/**
 * Calculate aggregations using pre-computed values
 * FIXED: Uses shared toCents/toDollars functions
 */
function calculateAggregationsOptimized(transactions: IndexedTransaction[]): WorkerAggregations {
  interface AggregationAccumulator {
    totalIncomeCents: number;
    totalExpensesCents: number;
    incomeCount: number;
    expenseCount: number;
    categoryTotals: Record<string, number>;
  }

  const seed: AggregationAccumulator = {
    totalIncomeCents: 0,
    totalExpensesCents: 0,
    incomeCount: 0,
    expenseCount: 0,
    categoryTotals: {}
  };

  const result = transactions.reduce<AggregationAccumulator>(
    (acc, tx) => {
      // FIXED: Use pre-computed cents value
      const amtCents = tx._amountCents;

      if (tx.type === 'income') {
        acc.totalIncomeCents += amtCents;
        acc.incomeCount++;
      } else if (isTrackedExpenseTransaction(tx)) {
        // CR-Apr24-F finding 231: use isTrackedExpenseTransaction to
        // exclude savings-transfer expenses, matching the sync fallback
        // in worker-manager.ts and the rest of Harbor Ledger.
        acc.totalExpensesCents += amtCents;
        acc.expenseCount++;
        acc.categoryTotals[tx.category] = (acc.categoryTotals[tx.category] || 0) + amtCents;
      }

      return acc;
    },
    seed
  );

  // FIXED: Use shared toDollars function for consistency
  return {
    totalIncome: toDollars(result.totalIncomeCents),
    totalExpenses: toDollars(result.totalExpensesCents),
    balance: toDollars(result.totalIncomeCents - result.totalExpensesCents),
    incomeCount: result.incomeCount,
    expenseCount: result.expenseCount,
    totalCount: transactions.length,
    categoryTotals: Object.fromEntries(
      Object.entries(result.categoryTotals).map(([cat, cents]) => [cat, toDollars(cents)])
    )
  };
}

// ==========================================
// UTILITY FUNCTIONS
// ==========================================

/**
 * Parse date string to Date object (cached version)
 *
 * rev 12 / #41: Parse logic now delegates to the shared main-thread helper
 * (`parseLocalDateShared` from `modules/core/utils-pure.js`) so the worker and
 * main thread can never drift on date-string interpretation (e.g. DST handling
 * via noon anchor). The worker retains a local Map-based cache with the
 * existing size-1000-clear-all eviction policy because batch transaction
 * processing here benefits from memoization that the main thread does not need.
 */
const dateCache = new Map<string, Date>();
function parseLocalDate(dateStr: string | Date): Date {
  if (dateStr instanceof Date) return dateStr;

  // Cache-wrapper: only strings are cacheable (Dates short-circuit above).
  if (typeof dateStr === 'string') {
    const cached = dateCache.get(dateStr);
    if (cached) return cached;

    const date = parseLocalDateShared(dateStr);

    // Cache for reuse (limit cache size — clear-all on overflow preserves
    // existing LRU-ish semantics without adding eviction overhead).
    if (dateCache.size > 1000) {
      dateCache.clear();
    }
    dateCache.set(dateStr, date);
    return date;
  }

  // Defensive: non-string, non-Date input falls through to shared helper.
  return parseLocalDateShared(dateStr);
}

/**
 * Paginate results
 */
function paginateResults<T>(
  items: T[],
  page: number,
  pageSize: number
): WorkerPaginatedResult<T> {
  const start = page * pageSize;
  const end = start + pageSize;
  return {
    items: items.slice(start, end),
    totalPages: Math.ceil(items.length / pageSize),
    currentPage: page,
    totalItems: items.length,
    hasMore: end < items.length
  };
}

// ==========================================
// ENHANCED DATASET MANAGEMENT
// ==========================================

/**
 * CRITICAL FIX: Enhanced dataset management to avoid 10k+ transaction transfers
 * Uses sync XXHash for lightweight change detection.
 */
function updateDataset(transactions: Transaction[], _categoryMapData?: Record<string, unknown>): void {
  const startTime = performance.now();

  // Generate dataset hash for change detection (sync — PERF-01)
  const datasetHash = generateDatasetHash(transactions);

  // Only update if data actually changed
  if (datasetHash === lastDatasetHash && transactionDataset.length === transactions.length) {
    if (DEV) console.debug('Worker dataset unchanged, skipping full sync');
    return;
  }

  if (DEV) console.debug(`Worker full dataset sync: ${transactions.length} transactions`);

  // Clear existing dataset
  transactionDataset = [];

  // Index new transactions in batches for better performance
  const batchSize = 1000;
  for (let i = 0; i < transactions.length; i += batchSize) {
    const batch = transactions.slice(i, i + batchSize);
    const indexedBatch = batch.map(indexTransaction);
    transactionDataset.push(...indexedBatch);
  }

  // Update metadata
  lastDatasetHash = datasetHash;
  lastUpdateTimestamp = Date.now();
  operationStats.datasetUpdates++;
  datasetInitialized = true;
  
  const updateTime = performance.now() - startTime;
  if (DEV) console.debug(`Worker dataset updated in ${updateTime.toFixed(2)}ms`);
}

/**
 * Generate dataset hash for change detection.
 *
 * PERF-01: Switched from async SHA-256 (crypto.subtle.digest) to sync
 * XXHash. This hash is used purely for *same-vs-different* detection when
 * deciding whether to re-index the worker's in-memory dataset — it is not
 * a security boundary. The async SubtleCrypto round-trip added ~1-2ms of
 * microtask latency on every filter path, which is avoidable overhead for
 * a non-cryptographic purpose.
 */
function generateDatasetHash(transactions: Transaction[]): string {
  // CR-Apr24-F finding 249: strengthened fingerprint. The prior v2 hash
  // sampled only first/mid/last rows + total amount sum, so interior edits
  // to description/tags/category/reconciled could collide as long as the
  // sampled rows and total stayed the same. v3 adds:
  // - a rolling description-length sum (catches description edits)
  // - per-tx category/reconciled XOR (catches category reassignment)
  // - 8 evenly-spaced samples instead of 3 (covers interior edits)
  // Still O(N) only on the light accumulator walk, not full-string-concat.
  const n = transactions.length;

  // Build sample indices: up to 8 evenly spaced
  const sampleCount = Math.min(8, n);
  const sampleIndices: number[] = [];
  for (let s = 0; s < sampleCount; s++) {
    sampleIndices.push(Math.floor(s * (n - 1) / Math.max(1, sampleCount - 1)));
  }
  const sample = sampleIndices
    .map(i => transactions[i])
    .filter((tx): tx is Transaction & object => Boolean(tx));

  // Rolling accumulators (O(N) but lightweight per-tx)
  let amountSum = 0;
  let descLenSum = 0;
  let categoryHash = 0;
  for (const tx of transactions) {
    amountSum += tx?.amount ?? 0;
    descLenSum += (tx?.description || '').length;
    // Simple category/reconciled accumulator — order-sensitive enough to
    // detect category reassignment even when amounts don't change.
    categoryHash = (categoryHash * 31 + (tx?.category || '').length + (tx?.reconciled ? 1 : 0)) >>> 0;
  }

  const hashData = `v3:${n}:${amountSum.toFixed(2)}:${descLenSum}:${categoryHash}:` +
    sample.map(tx => `${tx.__backendId}-${tx.amount}-${tx.date}-${tx.category}-${tx.type}-${tx.reconciled}-${(tx.description || '').length}`).join('|');

  // PERF-01: use sync XXHash — no need for async SubtleCrypto for change detection.
  return generateXXHashFallback(hashData);
}

/**
 * Fallback: XXHash32-like algorithm for environments without SubtleCrypto
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

/**
 * CRITICAL FIX: Incremental dataset updates for better performance
 */
function updateDatasetIncremental(
  type: 'add' | 'update' | 'delete',
  transaction: Transaction,
  index?: number
): void {
  switch (type) {
    case 'add':
      const indexedTx = indexTransaction(transaction);
      transactionDataset.push(indexedTx);
      break;
      
    case 'update':
      if (index !== undefined && index < transactionDataset.length) {
        transactionDataset[index] = indexTransaction(transaction);
      } else {
        // Fallback: find by ID and update
        const existingIndex = transactionDataset.findIndex(tx => tx.__backendId === transaction.__backendId);
        if (existingIndex >= 0) {
          transactionDataset[existingIndex] = indexTransaction(transaction);
        }
      }
      break;
      
    case 'delete':
      if (index !== undefined && index < transactionDataset.length) {
        transactionDataset.splice(index, 1);
      } else {
        // Fallback: find by ID and remove
        const existingIndex = transactionDataset.findIndex(tx => tx.__backendId === transaction.__backendId);
        if (existingIndex >= 0) {
          transactionDataset.splice(existingIndex, 1);
        }
      }
      break;
  }

  lastUpdateTimestamp = Date.now();
}

// ==========================================
// MESSAGE HANDLER
// ==========================================

/**
 * Optimized message handler
 * FIXED: Handles data updates separately from filtering
 * PERF-01: dataset hashing is now sync (XXHash), so only the
 * message-handler wrapper remains async for consistency with the
 * onmessage signature.
 *
 * Phase 6 Slice 1b (L5 #181): extracted the async body into
 * `handleWorkerMessage` and wrapped the `self.onmessage` assignment in a
 * sync `(e) => { void handleWorkerMessage(e); }`. Worker-scope onmessage
 * is typed as `(ev) => any`, but no-misused-promises flags a Promise-
 * returning handler. The catch block in handleWorkerMessage already
 * funnels errors into a worker-response envelope, so the `void` discard
 * is safe — there's no path that leaves a rejection unhandled.
 */
async function handleWorkerMessage(e: MessageEvent<WorkerMessage>): Promise<void> {
  const { type, payload, requestId } = e.data;

  // Fixes H15 (Inline-Behavior-Review rev 12): `abort` is a fire-and-forget
  // control message, not a request. Handle it before the try/postMessage
  // machinery so we never reply with a response envelope (which would
  // confuse the main thread into treating it as a completed request).
  if (type === 'abort') {
    const { abortRequestId } = payload as WorkerAbortPayload;
    if (typeof abortRequestId === 'number') {
      markCancelled(abortRequestId);
    }
    return;
  }

  // Guard: if an abort for THIS request arrived before we started, bail.
  // The main-thread pendingRequests entry is already gone by this point,
  // so any response we send would be dropped anyway.
  if (isCancelled(requestId)) {
    return;
  }

  try {
    let result: unknown;

    switch (type) {
      case 'init':
      case 'update': {
        const { transactions, categories, change } = payload as WorkerUpdatePayload;
        if (change) {
          if (!datasetInitialized) {
            throw new Error('Worker dataset must be initialized before applying deltas');
          }
          switch (change.type) {
            case 'add':
              if (change.item) updateDatasetIncremental('add', change.item);
              break;
            case 'update':
              if (change.item) updateDatasetIncremental('update', change.item);
              break;
            case 'delete':
              if (change.item) updateDatasetIncremental('delete', change.item);
              else if (change.id) {
                const stub = { __backendId: change.id };
                updateDatasetIncremental('delete', stub as Transaction);
              }
              break;
            case 'batch-add':
              (change.items || []).forEach((transaction: Transaction) => updateDatasetIncremental('add', transaction));
              break;
            case 'batch-delete':
              (change.ids || []).forEach((id: string) => {
                const stub = { __backendId: id };
                updateDatasetIncremental('delete', stub as Transaction);
              });
              break;
            case 'split':
              if (change.id) {
                const stub = { __backendId: change.id };
                updateDatasetIncremental('delete', stub as Transaction);
              }
              (change.items || []).forEach((transaction: Transaction) => updateDatasetIncremental('add', transaction));
              break;
          }
        } else if (transactions !== undefined) {
          updateDataset(transactions, categories);
        }
        result = { 
          success: true, 
          datasetSize: transactionDataset.length,
          lastUpdate: lastUpdateTimestamp 
        };
        break;
      }

      case 'filter': {
        const filterPayload = payload as WorkerFilterPayload;
        const { filters, sortBy, sortDir, page, pageSize } = filterPayload;
        
        // Check if we need to update dataset
        if (filterPayload.transactions) {
          updateDataset(filterPayload.transactions, filters.categoryMap);
        }

        // FIXED: Filter using in-memory indexed data
        let filtered = filterTransactionsOptimized(filters);

        // Sort
        filtered = sortTransactionsOptimized(filtered, sortBy || 'date', sortDir || 'desc');

        // Calculate aggregations
        const aggregations = calculateAggregationsOptimized(filtered);

        // Paginate
        const paginated = paginateResults(filtered, page || 0, pageSize || 50);

        const filterResult: WorkerFilterResult = {
          ...paginated,
          aggregations
        };
        result = filterResult;
        break;
      }

      case 'search': {
        const searchPayload = payload as WorkerSearchPayload;
        const { query } = searchPayload;

        // CR-Apr24-F finding 239: refresh dataset from payload if provided,
        // matching the filter and aggregate branches. Previously the search
        // branch always searched stale transactionDataset.
        if (searchPayload.transactions) {
          updateDataset(searchPayload.transactions);
        }

        // Quick search using pre-indexed search text
        const matches = transactionDataset.filter(tx =>
          tx._searchText.includes(query.toLowerCase().trim())
        );
        
        const sorted = sortTransactionsOptimized(matches, 'date', 'desc');
        const paginated = paginateResults(sorted, 0, searchPayload.limit || 50);
        
        result = paginated;
        break;
      }

      case 'aggregate': {
        const aggregatePayload = payload as WorkerAggregatePayload;

        // Update dataset if provided
        if (aggregatePayload.transactions) {
          updateDataset(aggregatePayload.transactions);
        }

        // CR-Apr24-F finding 232: apply filters before aggregating.
        // Previously the worker aggregated the entire dataset wholesale,
        // ignoring the filters payload that aggregateTransactionsAsync
        // forwards from the main thread.
        const dataToAggregate = aggregatePayload.filters
          ? filterTransactionsOptimized(aggregatePayload.filters)
          : transactionDataset;
        const aggregations = calculateAggregationsOptimized(dataToAggregate);
        result = aggregations;
        break;
      }

      default:
        throw new Error(`Unknown message type: ${type}`);
    }

    // Fixes H15 (Inline-Behavior-Review rev 12): final pre-reply cancellation
    // checkpoint. If an abort raced in while we were computing, drop the
    // result on the floor — the main thread already rejected this promise
    // with "Request aborted" or "Worker request timeout" and doesn't want a
    // late "success: true" envelope muddying its state.
    if (isCancelled(requestId)) {
      return;
    }

    const response: WorkerResponse = {
      requestId,
      success: true,
      result
    };
    self.postMessage(response);

  } catch (error) {
    // Don't emit a failure envelope for an already-abandoned request either;
    // it only generates noise on the main thread's onmessage handler.
    if (isCancelled(requestId)) {
      return;
    }
    const response: WorkerResponse = {
      requestId,
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
    self.postMessage(response);
  }
}

self.onmessage = (e: MessageEvent<WorkerMessage>): void => {
  void handleWorkerMessage(e);
};
