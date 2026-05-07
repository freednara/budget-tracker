import { describe, expect, it } from 'vitest';
import { countActiveFilters, filterStateToWorkerFilters } from '../js/modules/core/filter-utils.js';
import type { FilterState } from '../js/modules/core/signals.js';

/**
 * Build a FilterState with sensible defaults, overriding only the fields under test.
 */
function makeFilters(overrides: Partial<FilterState> = {}): FilterState {
  return {
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
    sortBy: 'date-desc',
    ...overrides
  };
}

// ==========================================================================
// countActiveFilters
// ==========================================================================

describe('countActiveFilters', () => {
  it('returns 0 when every filter is at its default', () => {
    expect(countActiveFilters(makeFilters())).toBe(0);
  });

  it('counts searchText as 1', () => {
    expect(countActiveFilters(makeFilters({ searchText: 'coffee' }))).toBe(1);
  });

  it('counts non-"all" type as 1', () => {
    expect(countActiveFilters(makeFilters({ type: 'expense' }))).toBe(1);
  });

  it('counts category as 1', () => {
    expect(countActiveFilters(makeFilters({ category: 'food' }))).toBe(1);
  });

  it('counts tags as 1', () => {
    expect(countActiveFilters(makeFilters({ tags: 'groceries' }))).toBe(1);
  });

  it('counts dateFrom alone as 1 (date range filter)', () => {
    expect(countActiveFilters(makeFilters({ dateFrom: '2026-01-01' }))).toBe(1);
  });

  it('counts dateTo alone as 1 (date range filter)', () => {
    expect(countActiveFilters(makeFilters({ dateTo: '2026-12-31' }))).toBe(1);
  });

  it('counts dateFrom + dateTo together as 1 (single date-range filter)', () => {
    expect(countActiveFilters(makeFilters({ dateFrom: '2026-01-01', dateTo: '2026-12-31' }))).toBe(1);
  });

  it('counts minAmount alone as 1 (amount range filter)', () => {
    expect(countActiveFilters(makeFilters({ minAmount: '10' }))).toBe(1);
  });

  it('counts maxAmount alone as 1 (amount range filter)', () => {
    expect(countActiveFilters(makeFilters({ maxAmount: '500' }))).toBe(1);
  });

  it('counts minAmount + maxAmount together as 1 (single amount-range filter)', () => {
    expect(countActiveFilters(makeFilters({ minAmount: '10', maxAmount: '500' }))).toBe(1);
  });

  it('counts reconciled !== "all" as 1', () => {
    expect(countActiveFilters(makeFilters({ reconciled: 'yes' }))).toBe(1);
    expect(countActiveFilters(makeFilters({ reconciled: 'no' }))).toBe(1);
  });

  it('counts recurring as 1', () => {
    expect(countActiveFilters(makeFilters({ recurring: true }))).toBe(1);
  });

  it('counts showAllMonths as 1', () => {
    expect(countActiveFilters(makeFilters({ showAllMonths: true }))).toBe(1);
  });

  it('counts all filters active simultaneously', () => {
    const all = makeFilters({
      searchText: 'rent',
      type: 'expense',
      category: 'housing',
      tags: 'monthly',
      dateFrom: '2026-01-01',
      dateTo: '2026-12-31',
      minAmount: '500',
      maxAmount: '2000',
      reconciled: 'yes',
      recurring: true,
      showAllMonths: true
    });
    expect(countActiveFilters(all)).toBe(9);
  });

  it('does not count empty strings as active', () => {
    expect(countActiveFilters(makeFilters({ searchText: '', category: '', tags: '' }))).toBe(0);
  });
});

// ==========================================================================
// filterStateToWorkerFilters
// ==========================================================================

describe('filterStateToWorkerFilters', () => {
  it('maps monthKey through directly', () => {
    const result = filterStateToWorkerFilters(makeFilters(), '2026-04');
    expect(result.monthKey).toBe('2026-04');
  });

  it('maps showAllMonths through', () => {
    const result = filterStateToWorkerFilters(makeFilters({ showAllMonths: true }), '2026-04');
    expect(result.showAllMonths).toBe(true);
  });

  it('maps type through', () => {
    const result = filterStateToWorkerFilters(makeFilters({ type: 'income' }), '2026-04');
    expect(result.type).toBe('income');
  });

  it('defaults category to "all" when empty', () => {
    const result = filterStateToWorkerFilters(makeFilters({ category: '' }), '2026-04');
    expect(result.category).toBe('all');
  });

  it('passes through a non-empty category', () => {
    const result = filterStateToWorkerFilters(makeFilters({ category: 'food' }), '2026-04');
    expect(result.category).toBe('food');
  });

  it('defaults searchQuery to empty string when searchText is empty', () => {
    const result = filterStateToWorkerFilters(makeFilters({ searchText: '' }), '2026-04');
    expect(result.searchQuery).toBe('');
  });

  it('passes through searchText as searchQuery', () => {
    const result = filterStateToWorkerFilters(makeFilters({ searchText: 'coffee' }), '2026-04');
    expect(result.searchQuery).toBe('coffee');
  });

  it('defaults tagsFilter to empty string when tags is empty', () => {
    const result = filterStateToWorkerFilters(makeFilters({ tags: '' }), '2026-04');
    expect(result.tagsFilter).toBe('');
  });

  it('passes through tags as tagsFilter', () => {
    const result = filterStateToWorkerFilters(makeFilters({ tags: 'groceries' }), '2026-04');
    expect(result.tagsFilter).toBe('groceries');
  });

  it('maps date range fields directly', () => {
    const result = filterStateToWorkerFilters(
      makeFilters({ dateFrom: '2026-01-01', dateTo: '2026-06-30' }),
      '2026-04'
    );
    expect(result.dateFrom).toBe('2026-01-01');
    expect(result.dateTo).toBe('2026-06-30');
  });

  it('maps amount range fields directly', () => {
    const result = filterStateToWorkerFilters(
      makeFilters({ minAmount: '10', maxAmount: '999' }),
      '2026-04'
    );
    expect(result.minAmount).toBe('10');
    expect(result.maxAmount).toBe('999');
  });

  it('maps recurring as recurringOnly', () => {
    const result = filterStateToWorkerFilters(makeFilters({ recurring: true }), '2026-04');
    expect(result.recurringOnly).toBe(true);
  });

  it('maps reconciled through directly', () => {
    const result = filterStateToWorkerFilters(makeFilters({ reconciled: 'no' }), '2026-04');
    expect(result.reconciled).toBe('no');
  });

  it('produces a complete object with all expected keys', () => {
    const result = filterStateToWorkerFilters(makeFilters(), '2026-04');
    expect(Object.keys(result).sort()).toEqual([
      'category', 'dateFrom', 'dateTo', 'maxAmount', 'minAmount',
      'monthKey', 'reconciled', 'recurringOnly', 'searchQuery',
      'showAllMonths', 'tagsFilter', 'type'
    ]);
  });
});
