import { describe, expect, it } from 'vitest';
import { filterTransactionsSync } from '../js/modules/orchestration/worker-manager.js';
import {
  createExpenseTransaction,
  createIncomeTransaction,
  createRecurringTransaction
} from './test-data-factory.js';
import type { Transaction, TransactionFilters } from '../js/types/index.js';

const transactions: Transaction[] = [
  createIncomeTransaction({
    __backendId: 'income-1',
    amount: 3000,
    category: 'salary',
    description: 'Monthly paycheck',
    date: '2026-03-01',
    reconciled: true
  }),
  createExpenseTransaction({
    __backendId: 'expense-1',
    amount: 45.5,
    category: 'food',
    description: 'Groceries',
    date: '2026-03-02',
    tags: 'essentials,food',
    reconciled: false
  }),
  createRecurringTransaction({
    __backendId: 'expense-2',
    amount: 1200,
    category: 'bills',
    description: 'March rent',
    date: '2026-03-03',
    reconciled: true
  }),
  createRecurringTransaction({
    __backendId: 'expense-3',
    amount: 30,
    category: 'health',
    description: 'Gym membership',
    date: '2026-03-10',
    notes: 'fitness reimbursement pending',
    reconciled: false
  }),
  createExpenseTransaction({
    __backendId: 'expense-4',
    amount: 8,
    category: 'food',
    description: 'Coffee',
    date: '2026-02-28',
    tags: 'snack',
    reconciled: false
  })
];

function runFilter(filters: TransactionFilters) {
  return filterTransactionsSync(transactions, filters, {
    page: 0,
    pageSize: 50,
    sortBy: 'date',
    sortDir: 'asc'
  });
}

describe('filterTransactionsSync', () => {
  it('filters by search query across description, notes, and tags', () => {
    expect(runFilter({ searchQuery: 'groc', showAllMonths: true }).items.map(tx => tx.__backendId)).toEqual(['expense-1']);
    expect(runFilter({ searchQuery: 'fitness', showAllMonths: true }).items.map(tx => tx.__backendId)).toEqual(['expense-3']);
    expect(runFilter({ searchQuery: 'snack', showAllMonths: true }).items.map(tx => tx.__backendId)).toEqual(['expense-4']);
    expect(runFilter({ searchQuery: 'bills', showAllMonths: true }).items.map(tx => tx.__backendId)).toEqual(['expense-2']);
  });

  it('filters by type and category', () => {
    expect(runFilter({ type: 'income', showAllMonths: true }).items.map(tx => tx.__backendId)).toEqual(['income-1']);
    expect(runFilter({ type: 'expense', category: 'bills', showAllMonths: true }).items.map(tx => tx.__backendId)).toEqual(['expense-2']);
  });

  it('filters by month unless showAllMonths is enabled', () => {
    expect(runFilter({ monthKey: '2026-03', showAllMonths: false }).totalItems).toBe(4);
    expect(runFilter({ monthKey: '2026-03', showAllMonths: true }).totalItems).toBe(5);
  });

  it('filters by date range and amount range', () => {
    expect(
      runFilter({
        type: 'expense',
        dateFrom: '2026-03-03',
        dateTo: '2026-03-10',
        showAllMonths: true
      }).items.map(tx => tx.__backendId)
    ).toEqual(['expense-2', 'expense-3']);

    expect(
      runFilter({
        type: 'expense',
        minAmount: 40,
        maxAmount: 100,
        showAllMonths: true
      }).items.map(tx => tx.__backendId)
    ).toEqual(['expense-1']);
  });

  it('filters recurring transactions only', () => {
    expect(
      runFilter({
        recurringOnly: true,
        showAllMonths: true
      }).items.map(tx => tx.__backendId)
    ).toEqual(['expense-2', 'expense-3']);
  });

  it('filters by tags without matching description or category text', () => {
    expect(
      runFilter({
        tagsFilter: 'essentials',
        showAllMonths: true
      } as TransactionFilters).items.map(tx => tx.__backendId)
    ).toEqual(['expense-1']);

    expect(
      runFilter({
        tagsFilter: 'bills',
        showAllMonths: true
      } as TransactionFilters).items
    ).toEqual([]);
  });

  it('filters unreconciled transactions when reconciled is no', () => {
    expect(
      runFilter({
        reconciled: 'no',
        monthKey: '2026-03',
        showAllMonths: false
      }).items.map(tx => tx.__backendId)
    ).toEqual(['expense-1', 'expense-3']);
  });
});
