/**
 * Filter Worker - Handles transaction filtering for large datasets
 *
 * Offloads CPU-intensive filtering and aggregation to a background thread
 * to keep the main thread responsive.
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
  WorkerSortDirection
} from '../types/index.js';

// Worker global scope types
interface WorkerGlobalScope {
  onmessage: ((e: MessageEvent<WorkerMessage>) => void) | null;
  postMessage(message: WorkerResponse): void;
}

// Declare self with worker types
declare const self: WorkerGlobalScope;

// ==========================================
// UTILITY FUNCTIONS (duplicated for worker isolation)
// ==========================================

/**
 * Parse a date string to a Date object (simplified version for worker)
 * Uses noon to avoid DST edge cases
 */
function parseLocalDate(dateStr: string | Date): Date {
  if (dateStr instanceof Date) return dateStr;
  if (typeof dateStr === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    const [y, m, d] = dateStr.split('-').map(Number);
    return new Date(y, m - 1, d, 12, 0, 0);
  }
  return new Date(dateStr);
}

/**
 * Get month key (YYYY-MM) from a date
 */
function getMonthKey(dateInput: string | Date): string {
  const d = typeof dateInput === 'string' ? parseLocalDate(dateInput) : dateInput;
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

// ==========================================
// CORE FILTERING FUNCTIONS
// ==========================================

/**
 * Filter transactions based on criteria
 */
function filterTransactions(
  transactions: Transaction[],
  filters: WorkerTransactionFilters
): Transaction[] {
  const {
    monthKey,
    showAllMonths,
    type,
    category,
    childCatIds,
    categoryMap,
    searchQuery,
    tagsFilter,
    dateFrom,
    dateTo,
    minAmount,
    maxAmount,
    recurringOnly,
    reconciled
  } = filters;

  // Pre-build child category Set for efficient lookup
  const childSet = childCatIds ? new Set(childCatIds) : null;

  return transactions.filter(tx => {
    // Month filter (unless showing all months)
    if (!showAllMonths && monthKey) {
      if (!tx.date || getMonthKey(tx.date) !== monthKey) return false;
    }

    // Type filter
    if (type && type !== 'all' && tx.type !== type) return false;

    // Category filter (supports parent/child hierarchy)
    if (category && category !== 'all') {
      // Match if exact category OR is a child of selected parent
      if (tx.category !== category && (!childSet || !childSet.has(tx.category))) {
        return false;
      }
    }

    // Search query (description, notes, tags, category name)
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      const desc = (tx.description || '').toLowerCase();
      const notes = (tx.notes || '').toLowerCase();
      // Handle tags as either array or string (legacy data may have string format)
      const tags = Array.isArray(tx.tags)
        ? tx.tags.join(' ').toLowerCase()
        : (typeof tx.tags === 'string' ? tx.tags.toLowerCase() : '');
      // Include category name in search if categoryMap is provided
      const catName = (categoryMap && categoryMap[tx.category]?.name || '').toLowerCase();
      if (!desc.includes(query) && !notes.includes(query) && !tags.includes(query) && !catName.includes(query)) {
        return false;
      }
    }

    // Dedicated tags filter (separate from general search)
    if (tagsFilter) {
      const txTags = Array.isArray(tx.tags)
        ? tx.tags.join(' ').toLowerCase()
        : (typeof tx.tags === 'string' ? tx.tags.toLowerCase() : '');
      if (!txTags.includes(tagsFilter)) {
        return false;
      }
    }

    // Date range filters
    if (dateFrom && tx.date < dateFrom) return false;
    if (dateTo && tx.date > dateTo) return false;

    // Amount range filters
    if (minAmount !== undefined && minAmount !== '') {
      const min = typeof minAmount === 'number' ? minAmount : parseFloat(minAmount);
      if (tx.amount < min) return false;
    }
    if (maxAmount !== undefined && maxAmount !== '') {
      const max = typeof maxAmount === 'number' ? maxAmount : parseFloat(maxAmount);
      if (tx.amount > max) return false;
    }

    // Recurring filter
    if (recurringOnly && !tx.recurring) return false;

    // Reconciled filter
    if (reconciled !== undefined && reconciled !== 'all') {
      if (reconciled === 'yes' && !tx.reconciled) return false;
      if (reconciled === 'no' && tx.reconciled) return false;
      if (reconciled === true && !tx.reconciled) return false;
      if (reconciled === false && tx.reconciled) return false;
    }

    return true;
  });
}

/**
 * Sort transactions
 */
function sortTransactions(
  transactions: Transaction[],
  sortBy: WorkerSortField,
  sortDir: WorkerSortDirection
): Transaction[] {
  const sorted = [...transactions];

  sorted.sort((a, b) => {
    let comparison = 0;

    switch (sortBy) {
      case 'date':
        comparison = (a.date || '').localeCompare(b.date || '');
        break;
      case 'amount':
        comparison = (a.amount || 0) - (b.amount || 0);
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

  return sorted;
}

// ==========================================
// AGGREGATION FUNCTIONS
// ==========================================

/**
 * Calculate aggregations for filtered transactions
 */
function calculateAggregations(transactions: Transaction[]): WorkerAggregations {
  const result = transactions.reduce(
    (acc, tx) => {
      const amtCents = Math.round((tx.amount || 0) * 100);

      if (tx.type === 'income') {
        acc.totalIncomeCents += amtCents;
        acc.incomeCount++;
      } else if (tx.type === 'expense') {
        acc.totalExpensesCents += amtCents;
        acc.expenseCount++;
        // Track category totals
        acc.categoryTotals[tx.category] = (acc.categoryTotals[tx.category] || 0) + amtCents;
      }

      return acc;
    },
    {
      totalIncomeCents: 0,
      totalExpensesCents: 0,
      incomeCount: 0,
      expenseCount: 0,
      categoryTotals: {} as Record<string, number>
    }
  );

  // Convert cents to dollars
  return {
    totalIncome: result.totalIncomeCents / 100,
    totalExpenses: result.totalExpensesCents / 100,
    balance: (result.totalIncomeCents - result.totalExpensesCents) / 100,
    incomeCount: result.incomeCount,
    expenseCount: result.expenseCount,
    totalCount: transactions.length,
    categoryTotals: Object.fromEntries(
      Object.entries(result.categoryTotals).map(([cat, cents]) => [cat, cents / 100])
    )
  };
}

// ==========================================
// PAGINATION FUNCTIONS
// ==========================================

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
// MESSAGE HANDLER
// ==========================================

/**
 * Main message handler
 */
self.onmessage = function(e: MessageEvent<WorkerMessage>): void {
  const { type, payload, requestId } = e.data;

  try {
    let result: unknown;

    switch (type) {
      case 'filter': {
        const filterPayload = payload as WorkerFilterPayload;
        const { transactions, filters, sortBy, sortDir, page, pageSize } = filterPayload;

        // Apply filters
        let filtered = filterTransactions(transactions, filters);

        // Sort
        filtered = sortTransactions(filtered, sortBy || 'date', sortDir || 'desc');

        // Calculate aggregations
        const aggregations = calculateAggregations(filtered);

        // Paginate
        const paginated = paginateResults(filtered, page || 0, pageSize || 50);

        const filterResult: WorkerFilterResult = {
          ...paginated,
          aggregations
        };
        result = filterResult;
        break;
      }

      case 'aggregate': {
        const aggPayload = payload as WorkerAggregatePayload;
        const { transactions, filters } = aggPayload;
        const filtered = filterTransactions(transactions, filters);
        result = calculateAggregations(filtered);
        break;
      }

      case 'search': {
        const searchPayload = payload as WorkerSearchPayload;
        const { transactions, query, limit = 50 } = searchPayload;
        const lowerQuery = query.toLowerCase();

        result = transactions
          .filter(tx => {
            const desc = (tx.description || '').toLowerCase();
            const notes = (tx.notes || '').toLowerCase();
            // Handle tags as either array or string (legacy data may have string format)
            const tags = Array.isArray(tx.tags)
              ? tx.tags.join(' ').toLowerCase()
              : (typeof tx.tags === 'string' ? tx.tags.toLowerCase() : '');
            return desc.includes(lowerQuery) || notes.includes(lowerQuery) || tags.includes(lowerQuery);
          })
          .slice(0, limit);
        break;
      }

      default:
        throw new Error(`Unknown message type: ${type}`);
    }

    const response: WorkerResponse = { requestId, success: true, result };
    self.postMessage(response);

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const response: WorkerResponse = { requestId, success: false, error: errorMessage };
    self.postMessage(response);
  }
};
