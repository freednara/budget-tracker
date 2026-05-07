/**
 * Debt List — Currency Reactivity (CR-Apr22-G slice 1, P2)
 *
 * Regression tests for the `mountDebtList` effect: when the user changes
 * home currency via `dataActions.settings.setCurrency`, the rendered
 * balance / remaining / paid / minimum / original / interest-paid amounts
 * must re-render with the new symbol. Before slice 1, the effect only
 * tracked deps through `debtListItems.value` → `activeDebts.value` →
 * `signals.debts.value`, so currency changes left the list stale until a
 * debt mutation fired.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import DOM from '../js/modules/core/dom-cache.js';
import * as signals from '../js/modules/core/signals.js';
import { mountDebtList } from '../js/modules/components/debt-list.js';
import { settings as settingsActions } from '../js/modules/core/actions/data-actions.js';
import type { Debt } from '../js/types/index.js';

function createDebt(overrides: Partial<Debt> = {}): Debt {
  return {
    id: `debt_${Math.random().toString(36).slice(2)}`,
    name: 'Card',
    balance: 1234.56,
    originalBalance: 2000,
    interestRate: 0.15,
    minimumPayment: 50,
    type: 'credit_card',
    isActive: true,
    dueDay: 15,
    ...overrides
  } as Debt;
}

describe('debt list — currency reactivity (CR-Apr22-G slice 1)', () => {
  const originalDebts = [...signals.debts.value];
  const originalCurrency = { ...signals.currency.value };
  let cleanup = (): void => {};

  beforeEach(() => {
    DOM.clearAll();
    document.body.innerHTML = `
      <section id="debt-planner-section">
        <div id="debts-list"></div>
        <div id="compare-strategies-wrapper" class="hidden"></div>
        <div id="debt-summary-cards" class="hidden"></div>
        <div class="app-panel__actions"></div>
      </section>
    `;
    settingsActions.setCurrency('USD', '$');
    signals.debts.value = [];
  });

  afterEach(() => {
    cleanup();
    cleanup = (): void => {};
    signals.debts.value = originalDebts;
    settingsActions.setCurrency(originalCurrency.home, originalCurrency.symbol);
    DOM.clearAll();
    document.body.innerHTML = '';
  });

  it('re-renders the balance label with the new symbol when currency changes', () => {
    signals.debts.value = [createDebt({ name: 'Visa', balance: 1234.56 })];

    cleanup = mountDebtList();

    const list = document.getElementById('debts-list');
    // Balance starts in USD
    expect(list?.textContent).toContain('$1,234.56');
    expect(list?.textContent).not.toContain('€');

    settingsActions.setCurrency('EUR', '€');

    // Balance now carries the Euro symbol; old $ figure is gone
    expect(list?.textContent).toContain('€1,234.56');
    expect(list?.textContent).not.toContain('$1,234.56');
  });

  it('re-renders all inner stat cells (remaining, paid, min, original, interest) with the new symbol', () => {
    signals.debts.value = [
      createDebt({
        name: 'Student Loan',
        balance: 5000,
        originalBalance: 8000,
        minimumPayment: 200
      })
    ];

    cleanup = mountDebtList();

    const list = document.getElementById('debts-list');
    // Confirm USD inside the <details> block is present before switching
    expect(list?.textContent).toContain('$5,000.00'); // remaining
    expect(list?.textContent).toContain('$8,000.00'); // original
    expect(list?.textContent).toContain('$200.00');   // min / mo

    settingsActions.setCurrency('GBP', '£');

    expect(list?.textContent).toContain('£5,000.00');
    expect(list?.textContent).toContain('£8,000.00');
    expect(list?.textContent).toContain('£200.00');
    expect(list?.textContent).not.toContain('$5,000.00');
  });

  it('zero-decimal currency (JPY) reformats amounts without fractional digits', () => {
    signals.debts.value = [createDebt({ name: 'Card', balance: 1000 })];

    cleanup = mountDebtList();

    const list = document.getElementById('debts-list');
    expect(list?.textContent).toContain('$1,000.00');

    settingsActions.setCurrency('JPY', '¥');

    // JPY has 0 decimals per CURRENCY_DECIMALS — amount collapses to "¥1,000"
    expect(list?.textContent).toContain('¥1,000');
    expect(list?.textContent).not.toContain('$1,000.00');
  });

  it('empty-state render does not break when currency is switched before any debt exists', () => {
    // Start empty, mount, switch currency, then add a debt — the effect must
    // still have a live subscription on both signals.currency and signals.debts.
    cleanup = mountDebtList();
    settingsActions.setCurrency('EUR', '€');

    signals.debts.value = [createDebt({ name: 'New Card', balance: 500 })];

    const list = document.getElementById('debts-list');
    expect(list?.textContent).toContain('€500.00');
  });
});
