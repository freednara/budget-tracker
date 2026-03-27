import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../js/modules/ui/core/ui-navigation.js', async () => {
  const actual = await vi.importActual<typeof import('../js/modules/ui/core/ui-navigation.js')>(
    '../js/modules/ui/core/ui-navigation.js'
  );
  return {
    ...actual,
    switchMainTab: vi.fn(),
    revealTransactionsForm: vi.fn()
  };
});

vi.mock('../js/modules/data/transaction-renderer.js', () => ({
  renderTransactionsList: vi.fn(async () => {})
}));

vi.mock('../js/modules/ui/core/ui.js', async () => {
  const actual = await vi.importActual<typeof import('../js/modules/ui/core/ui.js')>(
    '../js/modules/ui/core/ui.js'
  );
  return {
    ...actual,
    showToast: vi.fn(),
    openModal: vi.fn()
  };
});

import * as signals from '../js/modules/core/signals.js';
import { pagination } from '../js/modules/core/state-actions.js';
import { handleInsightAction } from '../js/modules/ui/core/ui-render.js';
import { renderTransactionsList } from '../js/modules/data/transaction-renderer.js';
import { switchMainTab } from '../js/modules/ui/core/ui-navigation.js';

describe('insight action handlers', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <select id="filter-category"></select>
      <section id="envelope-section"></section>
      <button id="open-plan-budget"></button>
      <section id="savings-goals-section"></section>
      <button id="add-savings-goal-btn"></button>
    `;

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
      showAllMonths: true,
      sortBy: 'date-desc'
    };

    vi.clearAllMocks();
    vi.spyOn(pagination, 'resetPage').mockImplementation(() => true);
  });

  it('routes filter-category insights through transactions filtering without DI init', async () => {
    handleInsightAction('filter-category', { category: 'transport' });

    expect(switchMainTab).toHaveBeenCalledWith('transactions');
    expect(signals.filters.value.category).toBe('transport');
    expect(signals.filters.value.showAllMonths).toBe(false);
    expect(renderTransactionsList).toHaveBeenCalled();
  });

  it('routes goto-budget insights directly to the budget tab', () => {
    handleInsightAction('goto-budget', {});

    expect(switchMainTab).toHaveBeenCalledWith('budget');
  });
});
