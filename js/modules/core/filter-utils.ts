/**
 * Shared Filter Utilities
 *
 * Extracted from transaction-renderer and import-export-events to eliminate
 * duplication of filter counting and filter-to-worker-filters mapping.
 *
 * @module filter-utils
 */

import type { FilterState } from './signals.js';
import type { WorkerTransactionFilters } from '../../types/index.js';

/**
 * Count how many filters are currently active.
 */
export function countActiveFilters(f: FilterState): number {
  let count = 0;
  if (f.searchText) count++;
  if (f.type !== 'all') count++;
  if (f.category) count++;
  if (f.tags) count++;
  if (f.dateFrom || f.dateTo) count++;
  if (f.minAmount || f.maxAmount) count++;
  if (f.reconciled !== 'all') count++;
  if (f.recurring) count++;
  if (f.showAllMonths) count++;
  return count;
}

/**
 * Map the reactive FilterState signal value to the flat WorkerTransactionFilters
 * object that the filter worker (and filterTransactionsSync) expect.
 */
export function filterStateToWorkerFilters(
  f: FilterState,
  monthKey: string
): WorkerTransactionFilters {
  return {
    monthKey,
    showAllMonths: f.showAllMonths,
    type: f.type,
    category: f.category || 'all',
    searchQuery: f.searchText || '',
    tagsFilter: f.tags || '',
    dateFrom: f.dateFrom,
    dateTo: f.dateTo,
    minAmount: f.minAmount,
    maxAmount: f.maxAmount,
    recurringOnly: f.recurring,
    reconciled: f.reconciled
  };
}
