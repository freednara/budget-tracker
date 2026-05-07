/**
 * Worker Manager - Manages Web Worker for large dataset operations
 *
 * Uses a 5,000+ transaction threshold to decide when to offload
 * filtering/aggregation to a background thread.
 */
'use strict';

import { isTrackedExpenseTransaction } from '../core/transaction-classification.js';
import { toCents, toDollars, parseAmount } from '../core/utils-pure.js';
import { trackError } from '../core/error-tracker.js';
import type {
  Transaction,
  TransactionFilters,
  WorkerUpdatePayload
} from '../../types/index.js';

// ==========================================
// TYPE DEFINITIONS
// ==========================================

interface FilterOptions {
  sortBy?: 'date' | 'amount' | 'description' | 'category';
  sortDir?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

interface WorkerAggregations {
  totalIncome: number;
  totalExpenses: number;
  incomeCount: number;
  expenseCount: number;
  categoryTotals: Record<string, number>;
  balance: number;
  totalCount: number;
}

interface FilterResult {
  items: Transaction[];
  totalPages: number;
  currentPage: number;
  totalItems: number;
  hasMore: boolean;
  aggregations: WorkerAggregations;
}

interface WorkerMessage {
  type: 'filter' | 'aggregate' | 'search' | 'update';
  payload: unknown;
  requestId: number;
}

export interface WorkerDatasetDelta {
  type: 'add' | 'update' | 'delete' | 'batch-add' | 'batch-delete' | 'split';
  // Phase 6 Slice 1j (rev 12 L6): widened optional fields to allow
  // explicit `undefined` under `exactOptionalPropertyTypes`, matching
  // the shared `TransactionDataChange` contract so `app-init-di.ts`
  // can forward a `change` directly without copying field-by-field.
  item?: Transaction | undefined;
  items?: Transaction[] | undefined;
  id?: string | undefined;
  ids?: string[] | undefined;
  previousItem?: Transaction | undefined;
}

interface WorkerResponse {
  requestId: number;
  success: boolean;
  result?: unknown;
  error?: string;
}

// Phase 6 Slice 1j (rev 12 L6): `abortController` widened for
// `exactOptionalPropertyTypes` — the constructor at line 261 passes the
// parameter (typed `AbortController | undefined`) directly through.
interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
  abortController?: AbortController | undefined;
}

interface WorkerStatus {
  supported: boolean;
  active: boolean;
  pendingRequests: number;
  threshold: number;
}

// ==========================================
// CONFIGURATION
// ==========================================

const WORKER_THRESHOLD = 1000; // FIXED: Lowered from 5000 to prevent mobile stuttering
const REQUEST_TIMEOUT = 8000; // 8 second timeout for worker requests (faster fallback to sync)
const MAX_PENDING_REQUESTS = 100; // Reject new requests if queue exceeds this size

// ==========================================
// MODULE STATE
// ==========================================

// Worker instance (lazy-loaded)
let workerInstance: Worker | null = null;
let requestIdCounter = 0;
const pendingRequests = new Map<number, PendingRequest>();
let isDatasetInitialized = false;
// Round 7 fix: Track dataset revision for delta sync validation
let dataRevision = 0;

// Round 7 fix: Reset requestIdCounter when it exceeds 1 million to prevent overflow
function getNextRequestId(): number {
  if (++requestIdCounter > 1_000_000) {
    requestIdCounter = 1;
  }
  return requestIdCounter;
}

// ==========================================
// WORKER SUPPORT
// ==========================================

/**
 * Check if Web Workers are supported
 */
export function isWorkerSupported(): boolean {
  return typeof Worker !== 'undefined';
}

/**
 * Check if we should use the worker based on dataset size
 */
export function shouldUseWorker(transactionCount: number): boolean {
  return isWorkerSupported() && transactionCount >= WORKER_THRESHOLD;
}

/**
 * Check if the worker dataset is initialized
 */
export function isWorkerReady(): boolean {
  return workerInstance !== null && isDatasetInitialized;
}

// ==========================================
// WORKER LIFECYCLE
// ==========================================

/**
 * Get or create the worker instance
 */
function getWorker(): Worker | null {
  if (!workerInstance && isWorkerSupported()) {
    try {
      // Use optimized filter worker for better performance
      workerInstance = new Worker(
        new URL('../../workers/filter-worker-optimized.ts', import.meta.url),
        { type: 'module' }
      );

      workerInstance.onmessage = (e: MessageEvent<WorkerResponse>) => {
        const { requestId, success, result, error } = e.data;
        const pending = pendingRequests.get(requestId);

        if (pending) {
          clearTimeout(pending.timeoutId);
          pendingRequests.delete(requestId);

          if (success) {
            pending.resolve(result);
          } else {
            pending.reject(new Error(error));
          }
        }
      };

      workerInstance.onerror = (e: ErrorEvent) => {
        if (import.meta.env.DEV) console.error('Worker error:', e.message);
        // Fixes H15 (Inline-Behavior-Review rev 12): previously this path
        // was DEV-only logged while every pending request got rejected
        // with a generic "Worker error" — prod had no telemetry when the
        // worker thread died. Route through trackError so we can see how
        // often and why this happens (quota, script error, OOM). The
        // worker is still terminated + all pending rejected because
        // onerror at the worker-scope is unrecoverable.
        trackError(new Error(`Worker error: ${e.message}`), {
          module: 'worker-manager',
          action: 'workerInstance.onerror'
        });
        // Reject all pending requests
        pendingRequests.forEach((pending) => {
          clearTimeout(pending.timeoutId);
          pending.reject(new Error('Worker error: ' + e.message));
        });
        pendingRequests.clear();
        // Terminate and reset worker
        terminateWorker();
      };

    } catch (err) {
      if (import.meta.env.DEV) console.warn('Failed to create worker:', err);
      workerInstance = null;
    }
  }

  return workerInstance;
}

/**
 * Terminate the worker instance
 */
export function terminateWorker(): void {
  if (workerInstance) {
    workerInstance.terminate();
    workerInstance = null;
  }
  isDatasetInitialized = false;
  // Reject all pending requests and clear their timeouts before clearing the map
  pendingRequests.forEach((pending) => {
    clearTimeout(pending.timeoutId);
    pending.reject(new Error('Worker terminated'));
  });
  pendingRequests.clear();
}

// ==========================================
// WORKER COMMUNICATION
// ==========================================

/**
 * Send a request to the worker with optional cancellation
 */
function sendWorkerRequest<T>(
  type: WorkerMessage['type'] | 'update', 
  payload: unknown,
  abortController?: AbortController
): Promise<T> {
  return new Promise((resolve, reject) => {
    const worker = getWorker();

    if (!worker) {
      reject(new Error('Worker not available'));
      return;
    }

    // Reject if too many pending requests to prevent unbounded queue growth
    if (pendingRequests.size >= MAX_PENDING_REQUESTS) {
      reject(new Error(`Worker queue full (${pendingRequests.size} pending requests)`));
      return;
    }

    const requestId = getNextRequestId();

    // Handle external cancellation
    if (abortController?.signal.aborted) {
      reject(new Error('Request aborted'));
      return;
    }

    const timeoutId = setTimeout(() => {
      pendingRequests.delete(requestId);
      // Fixes H15 (Inline-Behavior-Review rev 12): the worker now has an
      // explicit `'abort'` switch arm — previously this postMessage hit
      // the default: branch and threw "Unknown message type: abort",
      // firing onerror and poisoning every *other* in-flight request.
      // Pass abortRequestId as payload so the worker knows which request
      // to cancel (requestId on the envelope is this abort message's own
      // correlation ID and unrelated to the in-flight op).
      try {
        worker.postMessage({
          type: 'abort',
          payload: { abortRequestId: requestId },
          requestId
        });
      } catch (_) { /* worker may be terminated */ }
      reject(new Error('Worker request timeout'));
    }, REQUEST_TIMEOUT);

    const pending: PendingRequest = {
      resolve: resolve as (value: unknown) => void,
      reject,
      timeoutId,
      abortController
    };

    pendingRequests.set(requestId, pending);

    // Register abort listener
    abortController?.signal.addEventListener('abort', () => {
      clearTimeout(timeoutId);
      pendingRequests.delete(requestId);
      // Fixes H15 (Inline-Behavior-Review rev 12): the AbortController path
      // previously only cleaned main-thread state — the worker kept
      // computing and its eventual result was silently dropped, wasting the
      // worker thread on abandoned work. Unify cancellation with the
      // timeout path by telling the worker to cancel too.
      try {
        worker.postMessage({
          type: 'abort',
          payload: { abortRequestId: requestId },
          requestId
        });
      } catch (_) { /* worker may be terminated */ }
      reject(new Error('Request aborted'));
    }, { once: true });

    worker.postMessage({ type, payload, requestId });
  });
}

/**
 * Round 7 fix: Retry mechanism for crashed worker - attempt to reinitialize and resync
 */
async function retryWorkerAfterCrash(
  originalTx: Transaction[],
  retryPayload: unknown,
  retryType: WorkerMessage['type'] | 'update'
): Promise<unknown> {
  if (!isWorkerSupported()) throw new Error('Worker not supported');

  // Reset state so worker can be reinitialized
  isDatasetInitialized = false;

  // Reinitialize with fresh worker instance
  await syncWorkerDataset(originalTx);

  // Retry the original request
  return sendWorkerRequest(retryType, retryPayload);
}

/**
 * Explicitly update the worker's in-memory dataset
 * This reduces data transfer for subsequent filter/aggregate calls
 */
export async function syncWorkerDataset(
  transactions: Transaction[], 
  categories?: Record<string, unknown>
): Promise<void> {
  if (!isWorkerSupported()) return;
  
  try {
    const payload: WorkerUpdatePayload = { transactions, categories };
    await sendWorkerRequest('update', payload);
    isDatasetInitialized = true;
  } catch (err) {
    if (import.meta.env.DEV) console.error('Failed to sync worker dataset:', err);
    isDatasetInitialized = false;
    throw err;
  }
}

/**
 * Apply an incremental change to the worker dataset after the initial sync.
 */
export async function syncWorkerDatasetDelta(
  change: WorkerDatasetDelta,
  categories?: Record<string, unknown>
): Promise<void> {
  if (!isWorkerSupported()) return;
  if (!isDatasetInitialized) {
    throw new Error('Worker dataset is not initialized');
  }

  try {
    const payload: WorkerUpdatePayload = { change, categories };
    await sendWorkerRequest('update', payload);
  } catch (err) {
    if (import.meta.env.DEV) console.error('Failed to apply worker dataset delta:', err);
    isDatasetInitialized = false;
    throw err;
  }
}

// ==========================================
// ASYNC WORKER OPERATIONS
// ==========================================

/**
 * Filter transactions using worker (async)
 */
export async function filterTransactionsAsync(
  transactions: Transaction[] | null, // Pass null if already synced
  filters: TransactionFilters,
  options: FilterOptions = {},
  abortController?: AbortController
): Promise<FilterResult> {
  const { sortBy = 'date', sortDir = 'desc', page = 0, pageSize = 50 } = options;

  // CR-Apr24-F finding 230: pre-parse amount-range strings locale-awarely
  // on the main thread before forwarding to the worker. The worker runs
  // without `window` so `parseAmount` falls back to raw `parseFloat`,
  // which misparses locale-formatted amounts like "1.234,56".
  const workerFilters = { ...filters };
  if (workerFilters.minAmount !== undefined && workerFilters.minAmount !== '') {
    workerFilters.minAmount = parseAmount(String(workerFilters.minAmount));
  }
  if (workerFilters.maxAmount !== undefined && workerFilters.maxAmount !== '') {
    workerFilters.maxAmount = parseAmount(String(workerFilters.maxAmount));
  }

  return sendWorkerRequest<FilterResult>('filter', {
    transactions, // Worker will use in-memory if null
    filters: workerFilters,
    sortBy,
    sortDir,
    page,
    pageSize
  }, abortController);
}

/**
 * Calculate aggregations using worker (async)
 * FIXED: Always use worker for aggregations regardless of count
 */
export async function aggregateTransactionsAsync(
  transactions: Transaction[] | null,
  filters: TransactionFilters = {},
  abortController?: AbortController
): Promise<WorkerAggregations> {
  // Always use worker for expensive aggregations
  return sendWorkerRequest<WorkerAggregations>('aggregate', { 
    transactions, 
    filters 
  }, abortController);
}

/**
 * Search transactions using worker (async)
 */
export async function searchTransactionsAsync(
  transactions: Transaction[] | null,
  query: string,
  limit: number = 50,
  abortController?: AbortController
): Promise<Transaction[]> {
  // CR-Apr24-F finding 240: the worker resolves the 'search' request with
  // a paginated wrapper object ({ items, totalPages, ... }), not a raw
  // Transaction[]. Extract .items so the public API contract holds.
  interface PaginatedSearchResult {
    items: Transaction[];
    totalPages: number;
    currentPage: number;
    totalItems: number;
    hasMore: boolean;
  }
  const result = await sendWorkerRequest<PaginatedSearchResult | Transaction[]>(
    'search', { transactions, query, limit }, abortController
  );
  // Guard: if the worker ever returns a raw array (future change), handle both.
  if (Array.isArray(result)) return result;
  return (result as PaginatedSearchResult).items;
}

// ==========================================
// SYNC FALLBACK
// ==========================================

/**
 * Synchronous filter fallback (for small datasets or when worker unavailable)
 */
export function filterTransactionsSync(
  transactions: Transaction[],
  filters: TransactionFilters,
  options: FilterOptions = {}
): FilterResult {
  const { sortBy = 'date', sortDir = 'desc', page = 0, pageSize = 50 } = options;
  const normalizedFilters = filters as TransactionFilters & { search?: string; tagsFilter?: string };

  // Apply filters
  const filtered = transactions.filter(tx => {
    const {
      monthKey,
      showAllMonths,
      type,
      category,
      searchQuery,
      search,
      tags,
      tagsFilter,
      dateFrom,
      dateTo,
      minAmount,
      maxAmount,
      recurringOnly,
      reconciled
    } = normalizedFilters;
    const query = (searchQuery || search)?.toLowerCase().trim();
    const tagsQuery = (
      tagsFilter ||
      (Array.isArray(tags) ? tags.join(' ') : typeof tags === 'string' ? tags : '')
    )?.toLowerCase().trim();
    const tagsText = Array.isArray(tx.tags)
      ? tx.tags.join(' ').toLowerCase()
      : (typeof tx.tags === 'string' ? tx.tags.toLowerCase() : '');

    // Month filter
    if (!showAllMonths && monthKey) {
      if (!tx.date) return false;
      const txMonth = tx.date.substring(0, 7); // YYYY-MM
      if (txMonth !== monthKey) return false;
    }

    // Type filter
    if (type && type !== 'all' && tx.type !== type) return false;

    // Category filter
    if (category && category !== 'all' && tx.category !== category) return false;

    // Search query
    if (query) {
      const desc = (tx.description || '').toLowerCase();
      const notes = (tx.notes || '').toLowerCase();
      const categoryText = (tx.category || '').toLowerCase();
      if (!desc.includes(query) && !notes.includes(query) && !tagsText.includes(query) && !categoryText.includes(query)) {
        return false;
      }
    }

    // Tags filter
    if (tagsQuery && !tagsText.includes(tagsQuery)) return false;

    // Date range
    if (dateFrom && tx.date < dateFrom) return false;
    if (dateTo && tx.date > dateTo) return false;

    // Amount range — locale-aware parse (M9, Inline-Behavior-Review rev 12).
    // Filter inputs come from the amount-range UI, which a non-en-US user
    // types in their locale's format ("1.000,00"); raw `parseFloat` silently
    // returned 1 for that input and filtered out every transaction ≥ 1.
    // `parseAmount` routes through `localeService.parseCurrency` and returns
    // 0 on NaN so an unparseable filter value is equivalent to "no bound"
    // (same end-user observation as the prior empty-string branch).
    if (minAmount !== undefined && minAmount !== '' && tx.amount < parseAmount(String(minAmount))) return false;
    if (maxAmount !== undefined && maxAmount !== '' && tx.amount > parseAmount(String(maxAmount))) return false;

    // Recurring filter
    if (recurringOnly && !tx.recurring) return false;

    // Reconciled filter
    if (reconciled !== undefined && reconciled !== 'all') {
      if (reconciled === 'yes' && !tx.reconciled) return false;
      if (reconciled === 'no' && tx.reconciled) return false;
    }

    return true;
  });

  // Sort
  filtered.sort((a, b) => {
    let comparison = 0;
    switch (sortBy) {
      case 'date':
        comparison = (a.date || '').localeCompare(b.date || '');
        break;
      case 'amount':
        comparison = (parseFloat(String(a.amount)) || 0) - (parseFloat(String(b.amount)) || 0);
        break;
      case 'description':
        comparison = (a.description || '').localeCompare(b.description || '');
        break;
      case 'category':
        comparison = (a.category || '').localeCompare(b.category || '');
        break;
      default:
        comparison = (a.date || '').localeCompare(b.date || '');
    }
    return sortDir === 'asc' ? comparison : -comparison;
  });

  // Calculate aggregations
  // Fixes H12 (Inline-Behavior-Review rev 12): mirror the worker's cents-math
  // invariant in this main-thread fallback. Previously the reducer summed
  // floats directly, so datasets that crossed the 5k-tx worker threshold got
  // integer cents (via the worker) while smaller datasets or worker-failure
  // retries silently accumulated FP error. Accumulating in cents via toCents
  // and exposing dollars via toDollars keeps both paths numerically identical.
  const aggregationCents = filtered.reduce<{
    totalIncomeCents: number;
    totalExpensesCents: number;
    incomeCount: number;
    expenseCount: number;
    categoryTotalsCents: Record<string, number>;
  }>((acc, tx) => {
    const amtCents = toCents(parseFloat(String(tx.amount)) || 0);
    if (tx.type === 'income') {
      acc.totalIncomeCents += amtCents;
      acc.incomeCount++;
    } else if (isTrackedExpenseTransaction(tx)) {
      acc.totalExpensesCents += amtCents;
      acc.expenseCount++;
      acc.categoryTotalsCents[tx.category] = (acc.categoryTotalsCents[tx.category] || 0) + amtCents;
    }
    return acc;
  }, {
    totalIncomeCents: 0,
    totalExpensesCents: 0,
    incomeCount: 0,
    expenseCount: 0,
    categoryTotalsCents: {}
  });

  const categoryTotals: Record<string, number> = {};
  for (const [cat, cents] of Object.entries(aggregationCents.categoryTotalsCents)) {
    categoryTotals[cat] = toDollars(cents);
  }

  const aggregations: WorkerAggregations = {
    totalIncome: toDollars(aggregationCents.totalIncomeCents),
    totalExpenses: toDollars(aggregationCents.totalExpensesCents),
    incomeCount: aggregationCents.incomeCount,
    expenseCount: aggregationCents.expenseCount,
    categoryTotals,
    balance: toDollars(aggregationCents.totalIncomeCents - aggregationCents.totalExpensesCents),
    totalCount: filtered.length
  };

  // Paginate
  const start = page * pageSize;
  const end = start + pageSize;

  return {
    items: filtered.slice(start, end),
    totalPages: Math.ceil(filtered.length / pageSize),
    currentPage: page,
    totalItems: filtered.length,
    hasMore: end < filtered.length,
    aggregations
  };
}

// ==========================================
// SMART FILTER
// ==========================================

/**
 * Smart filter - automatically chooses sync or async based on dataset size
 */
export async function filterTransactions(
  transactions: Transaction[],
  filters: TransactionFilters,
  options: FilterOptions = {},
  abortController?: AbortController
): Promise<FilterResult> {
  if (shouldUseWorker(transactions.length)) {
    try {
      // If worker is already ready, we can skip sending the full array
      const txToPass = isWorkerReady() ? null : transactions;
      return await filterTransactionsAsync(txToPass, filters, options, abortController);
    } catch (err) {
      if (err instanceof Error && err.message === 'Request aborted') {
        throw err; // Re-throw aborts
      }
      if (import.meta.env.DEV) console.warn('Worker filtering failed, falling back to sync:', err);
      return filterTransactionsSync(transactions, filters, options);
    }
  }

  return filterTransactionsSync(transactions, filters, options);
}

// ==========================================
// DIAGNOSTICS
// ==========================================

/**
 * Get worker status for diagnostics
 */
export function getWorkerStatus(): WorkerStatus {
  return {
    supported: isWorkerSupported(),
    active: workerInstance !== null,
    pendingRequests: pendingRequests.size,
    threshold: WORKER_THRESHOLD
  };
}
