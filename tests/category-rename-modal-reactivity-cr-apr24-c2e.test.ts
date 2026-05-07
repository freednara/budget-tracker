/**
 * Category-Rename Modal Reactivity (CR-Apr24-C2e, findings 99 + 101)
 *
 * Regression tests confirming that category renames/recolors refresh
 * open modals:
 *
 * - Finding 99: split-transaction modal category labels refresh on rename
 * - Finding 101: Plan Budget modal rows refresh on category rename/recolor
 *
 * Key setup detail: `userCategoryConfig` starts null (default preset).
 * Category renames go through `updateCategory()` which requires non-null
 * config (see `updateConfig()` guard). These tests first establish a
 * non-null config from the current defaults, then rename within it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import DOM from '../js/modules/core/dom-cache.js';
import * as signals from '../js/modules/core/signals.js';
import { settings as settingsActions } from '../js/modules/core/actions/data-actions.js';
import { userCategoryConfig, expenseCategories } from '../js/modules/core/category-store.js';
import type { Transaction, UserCategoryConfig } from '../js/types/index.js';

// ==========================================
// HELPERS
// ==========================================

function makeTransaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    __backendId: `tx_${Math.random().toString(36).slice(2)}`,
    date: '2026-04-25',
    amount: 100,
    description: 'Test Transaction',
    category: 'food',
    type: 'expense',
    currency: 'USD',
    recurring: false,
    ...overrides
  } as Transaction;
}

/**
 * Bootstrap a non-null userCategoryConfig from the current defaults.
 * Required because `updateCategory()` / `updateConfig()` bail when
 * userCategoryConfig is null.
 */
function ensureEditableConfig(): UserCategoryConfig {
  const cats = expenseCategories.value;
  const config: UserCategoryConfig = {
    presetId: 'test',
    version: 1,
    expense: cats.map((c, i) => ({
      id: c.id, name: c.name, emoji: c.emoji, color: c.color,
      type: 'expense' as const, hidden: false, order: i
    })),
    income: []
  };
  userCategoryConfig.value = config;
  return config;
}

// ==========================================
// FINDING 99: Split modal category labels
// ==========================================

describe('finding 99 — split modal refreshes category labels on rename', () => {
  const originalConfig = userCategoryConfig.peek();
  const originalTxs = [...signals.transactions.value];
  const originalCurrency = { ...signals.currency.value };
  let cleanup = (): void => {};

  beforeEach(() => {
    DOM.clearAll();
    document.body.innerHTML = `
      <div id="split-modal" class="modal-overlay" role="dialog"></div>
    `;
    settingsActions.setCurrency('USD', '$');
    signals.splitTxId.value = null;
    signals.splitRows.value = [];
  });

  afterEach(() => {
    cleanup();
    cleanup = (): void => {};
    signals.splitTxId.value = null;
    signals.splitRows.value = [];
    signals.transactions.value = originalTxs;
    userCategoryConfig.value = originalConfig;
    settingsActions.setCurrency(originalCurrency.home, originalCurrency.symbol);
    DOM.clearAll();
    document.body.innerHTML = '';
  });

  it('re-renders category option labels when a category is renamed', async () => {
    const { mountSplitModal } = await import('../js/modules/features/financial/split-transactions.js');

    // Establish editable config from defaults
    const config = ensureEditableConfig();
    const targetCat = expenseCategories.value[0]!;
    expect(targetCat).toBeDefined();
    const originalName = targetCat.name;

    const tx = makeTransaction({ __backendId: 'tx_split_1', amount: 200 });
    signals.transactions.value = [tx];

    cleanup = mountSplitModal();

    // Open the split modal
    signals.splitTxId.value = 'tx_split_1';
    signals.splitRows.value = [
      { id: 'row_1', categoryId: targetCat.id, amount: 100 },
      { id: 'row_2', categoryId: targetCat.id, amount: 100 }
    ];

    // Verify the original category name is rendered
    const modal = document.getElementById('split-modal');
    expect(modal?.textContent).toContain(originalName);

    // Rename the category
    userCategoryConfig.value = {
      ...config,
      expense: config.expense.map(c =>
        c.id === targetCat.id ? { ...c, name: 'RENAMED_CATEGORY_99' } : c
      )
    };

    // The split modal should now show the renamed category
    expect(modal?.textContent).toContain('RENAMED_CATEGORY_99');
  });
});

// ==========================================
// FINDING 101: Plan Budget grid category labels
// ==========================================

describe('finding 101 — plan budget grid refreshes on category rename', () => {
  const originalConfig = userCategoryConfig.peek();
  const originalCurrency = { ...signals.currency.value };
  let cleanupList: Array<() => void> = [];

  beforeEach(() => {
    DOM.clearAll();
    document.body.innerHTML = `
      <div id="plan-budget-modal" class="modal-overlay active" role="dialog">
        <div id="plan-budget-grid"></div>
        <span id="plan-monthly-income">$0</span>
        <span id="plan-remaining">$0</span>
      </div>
    `;
    settingsActions.setCurrency('USD', '$');
  });

  afterEach(() => {
    cleanupList.forEach(fn => fn());
    cleanupList = [];
    userCategoryConfig.value = originalConfig;
    settingsActions.setCurrency(originalCurrency.home, originalCurrency.symbol);
    DOM.clearAll();
    document.body.innerHTML = '';
  });

  it('re-renders category names in the budget grid when a category is renamed', async () => {
    const { initBudgetPlannerHandlers, cleanupBudgetPlannerHandlers } =
      await import('../js/modules/features/financial/budget-planner-ui.js');

    // Establish editable config
    const config = ensureEditableConfig();
    const targetCat = expenseCategories.value[0]!;
    expect(targetCat).toBeDefined();

    initBudgetPlannerHandlers();
    cleanupList.push(cleanupBudgetPlannerHandlers);

    const grid = document.getElementById('plan-budget-grid');
    // Grid should contain the original name (modal is active, effect fires)
    expect(grid?.textContent).toContain(targetCat.name);

    // Rename the category
    userCategoryConfig.value = {
      ...config,
      expense: config.expense.map(c =>
        c.id === targetCat.id ? { ...c, name: 'RENAMED_CATEGORY_101' } : c
      )
    };

    // Grid should now contain the renamed category
    expect(grid?.textContent).toContain('RENAMED_CATEGORY_101');
  });

  it('re-renders category emoji in the budget grid when a category emoji changes', async () => {
    const { initBudgetPlannerHandlers, cleanupBudgetPlannerHandlers } =
      await import('../js/modules/features/financial/budget-planner-ui.js');

    const config = ensureEditableConfig();
    const targetCat = expenseCategories.value[0]!;
    expect(targetCat).toBeDefined();

    initBudgetPlannerHandlers();
    cleanupList.push(cleanupBudgetPlannerHandlers);

    const grid = document.getElementById('plan-budget-grid');
    expect(grid?.textContent).toContain(targetCat.emoji);

    // Change the emoji
    userCategoryConfig.value = {
      ...config,
      expense: config.expense.map(c =>
        c.id === targetCat.id ? { ...c, emoji: '🦄' } : c
      )
    };

    expect(grid?.textContent).toContain('🦄');
  });
});
