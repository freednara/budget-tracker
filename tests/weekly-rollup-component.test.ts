import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import DOM from '../js/modules/core/dom-cache.js';
import * as signals from '../js/modules/core/signals.js';
import { mountWeeklyRollup } from '../js/modules/components/weekly-rollup.js';
import { generateWeeklyData } from '../js/modules/features/financial/weekly-rollup.js';
import { settings as settingsActions } from '../js/modules/core/actions/data-actions.js';
import type { Transaction } from '../js/types/index.js';

function tx(overrides: Partial<Transaction> & {
  __backendId: string;
  amount: number;
  date: string;
  category: string;
}): Transaction {
  return {
    ...overrides,
    __backendId: overrides.__backendId,
    type: 'expense',
    amount: overrides.amount,
    description: 'Test transaction',
    date: overrides.date,
    category: overrides.category,
    currency: 'USD',
    recurring: false
  };
}

describe('weekly rollup component', () => {
  const originalMonth = signals.currentMonth.value;
  const originalTransactions = [...signals.transactions.value];
  const originalCurrency = { ...signals.currency.value };
  let cleanup = (): void => {};

  beforeEach(() => {
    DOM.clearAll();
    document.body.innerHTML = `
      <section id="weekly-rollup-section" class="hidden"></section>
      <div id="weekly-rollup-chart"></div>
      <div id="weekly-rollup-badge"></div>
    `;
    signals.currentMonth.value = '2026-03';
    settingsActions.setCurrency('USD', '$');
  });

  afterEach(() => {
    cleanup();
    cleanup = (): void => {};
    signals.replaceTransactionLedger(originalTransactions);
    signals.currentMonth.value = originalMonth;
    settingsActions.setCurrency(originalCurrency.home, originalCurrency.symbol);
    DOM.clearAll();
    document.body.innerHTML = '';
  });

  it('rerenders when weekly distribution changes without changing total spend or transaction count', () => {
    signals.replaceTransactionLedger([
      tx({ __backendId: 'w1', amount: 10, date: '2026-03-02', category: 'food' }),
      tx({ __backendId: 'w2', amount: 50, date: '2026-03-25', category: 'food' })
    ]);

    cleanup = mountWeeklyRollup();

    const chart = document.getElementById('weekly-rollup-chart');
    expect(chart?.textContent).toContain('Week 5');

    signals.replaceTransactionLedger([
      tx({ __backendId: 'w1', amount: 10, date: '2026-03-02', category: 'food' }),
      tx({ __backendId: 'w2', amount: 50, date: '2026-03-09', category: 'food' })
    ]);

    expect(chart?.textContent).toContain('Week 3');
    expect(chart?.textContent).not.toContain('Week 5');
  });

  it('includes partial weeks that overlap the start of the month', () => {
    signals.replaceTransactionLedger([
      tx({ __backendId: 'edge-1', amount: 20, date: '2026-03-01', category: 'food' }),
      tx({ __backendId: 'edge-2', amount: 45, date: '2026-03-25', category: 'food' })
    ]);

    const data = generateWeeklyData();

    expect(data.hasData).toBe(true);
    expect(data.weeks).toHaveLength(6);
    expect(data.weeks[0]?.startDate?.toISOString().slice(0, 10)).toBe('2026-02-23');
    expect(data.weeks[0]?.txCount).toBe(1);
    expect(data.weeks[4]?.txCount).toBe(1);
  });

  // ==========================================
  // CR-Apr22-G slice 1 — Currency-change reactivity
  // ==========================================
  it('re-renders the stat cards with the new symbol when currency changes', () => {
    signals.replaceTransactionLedger([
      tx({ __backendId: 'cur-1', amount: 123.45, date: '2026-03-05', category: 'food' })
    ]);

    cleanup = mountWeeklyRollup();

    const chart = document.getElementById('weekly-rollup-chart');
    expect(chart?.textContent).toContain('$123.45');
    expect(chart?.textContent).not.toContain('€');

    settingsActions.setCurrency('EUR', '€');

    expect(chart?.textContent).toContain('€123.45');
    expect(chart?.textContent).not.toContain('$123.45');
  });

  it('re-renders SVG bar labels with the new symbol when currency changes', () => {
    // fmtShort renders values >= 1000 as compact "$1.5k" / "€1.5k" form above
    // each bar when there is room. Amount 2500 produces the short form.
    signals.replaceTransactionLedger([
      tx({ __backendId: 'big', amount: 2500, date: '2026-03-10', category: 'food' })
    ]);

    cleanup = mountWeeklyRollup();

    const chart = document.getElementById('weekly-rollup-chart');
    expect(chart?.innerHTML).toContain('$2.5k');

    settingsActions.setCurrency('GBP', '£');

    expect(chart?.innerHTML).toContain('£2.5k');
    expect(chart?.innerHTML).not.toContain('$2.5k');
  });
});
