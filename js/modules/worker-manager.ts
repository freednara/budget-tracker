/**
 * Worker Manager - Manages Web Worker for large dataset operations
 *
 * Uses a 5,000+ transaction threshold to decide when to offload
 * filtering/aggregation to a background thread.
 */
'use strict';

import type { Transaction, TransactionFilters } from '../types/index.js';

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

const WORKER_THRESHOLD = 5000; // Use worker when transactions exceed this count
const REQUEST_TIMEOUT = 30000; // 30 second timeout for worker requests

// ==========================================
// MODULE STATE
// ==========================================

// Worker instance (lazy-loaded)
let workerInstance: Worker | null = null;
let requestIdCounter = 0;
const pendingRequests = new Map<number, PendingRequest>();

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

// ==========================================
// WORKER LIFECYCLE
// ==========================================

/**
 * Get or create the worker instance
 */
function getWorker(): Worker | null {
  if (!workerInstance && isWorkerSupported()) {
    try {
      workerInstance = new Worker(
        new URL('../workers/filter-worker.ts', import.meta.url),
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
        console.error('Worker error:', e.message);
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
      console.warn('Failed to create worker:', err);
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
  pendingRequests.clear();
}

// ==========================================
// WORKER COMMUNICATION
// ==========================================

/**
 * Send a request to the worker
 */
function sendWorkerRequest<T>(type: WorkerMessage['type'], payload: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const worker = getWorker();

    if (!worker) {
      reject(new Error('Worker not available'));
      return;
    }

    const requestId = ++requestIdCounter;
    const timeoutId = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error('Worker request timeout'));
    }, REQUEST_TIMEOUT);

    pendingRequests.set(requestId, {
      resolve: resolve as (value: unknown) => void,
      reject,
      timeoutId
    });

    worker.postMessage({ type, payload, requestId });
  });
}

// ==========================================
// ASYNC WORKER OPERATIONS
// ==========================================

/**
 * Filter transactions using worker (async)
 */
export async function filterTransactionsAsync(
  transactions: Transaction[],
  filters: TransactionFilters,
  options: FilterOptions = {}
): Promise<FilterResult> {
  const { sortBy = 'date', sortDir = 'desc', page = 0, pageSize = 50 } = options;

  return sendWorkerRequest<FilterResult>('filter', {
    transactions,
    filters,
    sortBy,
    sortDir,
    page,
    pageSize
  });
}

/**
 * Calculate aggregations using worker (async)
 */
export async function aggregateTransactionsAsync(
  transactions: Transaction[],
  filters: TransactionFilters = {}
): Promise<WorkerAggregations> {
  return sendWorkerRequest<WorkerAggregations>('aggregate', { transactions, filters });
}

/**
 * Search transactions using worker (async)
 */
export async function searchTransactionsAsync(
  transactions: Transaction[],
  query: string,
  limit: number = 50
): Promise<Transaction[]> {
  return sendWorkerRequest<Transaction[]>('search', { transactions, query, limit });
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

  // Apply filters
  let filtered = transactions.filter(tx => {
    const {
      monthKey,
      showAllMonths,
      type,
      category,
      searchQuery,
      dateFrom,
      dateTo,
      minAmount,
      maxAmount,
      recurringOnly,
      reconciled
    } = filters;

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
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      const desc = (tx.description || '').toLowerCase();
      const notes = (tx.notes || '').toLowerCase();
      // Handle tags as either array or string
      const tags = Array.isArray(tx.tags)
        ? tx.tags.join(' ').toLowerCase()
        : (typeof tx.tags === 'string' ? tx.tags.toLowerCase() : '');
      if (!desc.includes(query) && !notes.includes(query) && !tags.includes(query)) {
        return false;
      }
    }

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
    } else if (tx.type === 'expense') {
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
  options: FilterOptions = {}
): Promise<FilterResult> {
  if (shouldUseWorker(transactions.length)) {
    try {
      return await filterTransactionsAsync(transactions, filters, options);
    } catch (err) {
      console.warn('Worker filtering failed, falling back to sync:', err);
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
