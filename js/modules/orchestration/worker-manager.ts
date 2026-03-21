/**
 * Worker Manager - Manages Web Worker for large dataset operations
 *
 * Uses a 5,000+ transaction threshold to decide when to offload
 * filtering/aggregation to a background thread.
 */
'use strict';

import { isTrackedExpenseTransaction } from '../core/transaction-classification.js';
import type { Transaction, TransactionFilters } from '../../types/index.js';

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
  type: 'filter' | 'aggregate' | 'search';
  payload: unknown;
  requestId: number;
}

interface WorkerResponse {
  requestId: number;
  success: boolean;
  result?: unknown;
  error?: string;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
  abortController?: AbortController;
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
const ALWAYS_USE_WORKER_FOR = ['aggregate', 'yearStats', 'allTimeStats']; // Expensive operations

// ==========================================
// MODULE STATE
// ==========================================

// Worker instance (lazy-loaded)
let workerInstance: Worker | null = null;
let requestIdCounter = 0;
const pendingRequests = new Map<number, PendingRequest>();
let isDatasetInitialized = false;

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

    const requestId = ++requestIdCounter;

    // Handle external cancellation
    if (abortController?.signal.aborted) {
      reject(new Error('Request aborted'));
      return;
    }

    const timeoutId = setTimeout(() => {
      pendingRequests.delete(requestId);
      // Send abort message to worker so it can cancel in-progress work
      try { worker.postMessage({ type: 'abort', requestId }); } catch (_) { /* worker may be terminated */ }
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
      reject(new Error('Request aborted'));
    }, { once: true });

    worker.postMessage({ type, payload, requestId });
  });
}

/**
 * Explicitly update the worker's in-memory dataset
 * This reduces data transfer for subsequent filter/aggregate calls
 */
export async function syncWorkerDataset(
  transactions: Transaction[], 
  categories?: Record<string, any>
): Promise<void> {
  if (!isWorkerSupported()) return;
  
  try {
    await sendWorkerRequest('update', { transactions, categories });
    isDatasetInitialized = true;
  } catch (err) {
    if (import.meta.env.DEV) console.error('Failed to sync worker dataset:', err);
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

  return sendWorkerRequest<FilterResult>('filter', {
    transactions, // Worker will use in-memory if null
    filters,
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
  return sendWorkerRequest<Transaction[]>('search', { transactions, query, limit }, abortController);
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
  let filtered = transactions.filter(tx => {
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

    // Amount range
    if (minAmount !== undefined && minAmount !== '' && tx.amount < parseFloat(String(minAmount))) return false;
    if (maxAmount !== undefined && maxAmount !== '' && tx.amount > parseFloat(String(maxAmount))) return false;

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
  const aggregations = filtered.reduce<WorkerAggregations>((acc, tx) => {
    const amt = parseFloat(String(tx.amount)) || 0;
    if (tx.type === 'income') {
      acc.totalIncome += amt;
      acc.incomeCount++;
    } else if (isTrackedExpenseTransaction(tx)) {
      acc.totalExpenses += amt;
      acc.expenseCount++;
      acc.categoryTotals[tx.category] = (acc.categoryTotals[tx.category] || 0) + amt;
    }
    return acc;
  }, {
    totalIncome: 0,
    totalExpenses: 0,
    incomeCount: 0,
    expenseCount: 0,
    categoryTotals: {},
    balance: 0,
    totalCount: 0
  });

  aggregations.balance = aggregations.totalIncome - aggregations.totalExpenses;
  aggregations.totalCount = filtered.length;

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
