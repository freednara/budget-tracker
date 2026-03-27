import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRenderTransactionsList } = vi.hoisted(() => ({
  mockRenderTransactionsList: vi.fn(async () => {})
}));

vi.mock('../js/modules/data/transaction-renderer.js', () => ({
  renderTransactionsList: mockRenderTransactionsList
}));

import * as signals from '../js/modules/core/signals.js';
import {
  applyTransactionFilters,
  clearTransactionFilters,
  refreshTransactionsSurface,
  replaceTransactionFilters
} from '../js/modules/data/transaction-surface-coordinator.js';

describe('transaction surface coordinator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    signals.pagination.value = { page: 3, totalItems: 10, totalPages: 4 };
    signals.filters.value = {
      searchText: 'coffee',
      type: 'expense',
      category: '',
      tags: '',
      dateFrom: '',
      dateTo: '',
      minAmount: '',
      maxAmount: '',
      reconciled: 'all',
      recurring: false,
      showAllMonths: false,
      sortBy: 'date-desc'
    };
  });

  afterEach(() => {
    signals.pagination.value = { page: 0, totalItems: 0, totalPages: 0 };
    signals.filters.value = {
      searchText: '',
      type: 'all',
      category: '',
      tags: '',
      dateFrom: '',
      dateTo: '',
      minAmount: '',
      maxAmount: '',
      reconciled: 'all',
      recurring: false,
      showAllMonths: false,
      sortBy: 'date-desc'
    };
  });

  it('refreshes the ledger through one coordinator entrypoint', async () => {
    await refreshTransactionsSurface({ resetPage: true });

    expect(signals.pagination.value.page).toBe(0);
    expect(mockRenderTransactionsList).toHaveBeenCalledWith(false);
  });

  it('updates filters and rerenders through the coordinator', async () => {
    await applyTransactionFilters({ category: 'food', showAllMonths: true });

    expect(signals.filters.value.category).toBe('food');
    expect(signals.filters.value.showAllMonths).toBe(true);
    expect(signals.pagination.value.page).toBe(0);
    expect(mockRenderTransactionsList).toHaveBeenCalledTimes(1);
  });

  it('can replace and clear filters without importing the renderer directly', async () => {
    await replaceTransactionFilters({
      searchText: '',
      type: 'all',
      category: 'transport',
      tags: 'commute',
      dateFrom: '2026-03-01',
      dateTo: '2026-03-31',
      minAmount: '5',
      maxAmount: '50',
      reconciled: 'no',
      recurring: true,
      showAllMonths: true,
      sortBy: 'amount-desc'
    });

    expect(signals.filters.value.category).toBe('transport');

    await clearTransactionFilters();

    expect(signals.filters.value).toEqual({
      searchText: '',
      type: 'all',
      category: '',
      tags: '',
      dateFrom: '',
      dateTo: '',
      minAmount: '',
      maxAmount: '',
      reconciled: 'all',
      recurring: false,
      showAllMonths: false,
      sortBy: 'date-desc'
    });
    expect(mockRenderTransactionsList).toHaveBeenCalledTimes(2);
  });
});
