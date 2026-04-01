import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import DOM from '../js/modules/core/dom-cache.js';
import * as signals from '../js/modules/core/signals.js';
import { mountWeeklyRollup } from '../js/modules/components/weekly-rollup.js';
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
  let cleanup = (): void => {};

  beforeEach(() => {
    DOM.clearAll();
    document.body.innerHTML = `
      <section id="weekly-rollup-section" class="hidden"></section>
      <div id="weekly-rollup-chart"></div>
      <div id="weekly-rollup-badge"></div>
    `;
    signals.currentMonth.value = '2026-03';
  });

  afterEach(() => {
    cleanup();
    cleanup = (): void => {};
    signals.replaceTransactionLedger(originalTransactions);
    signals.currentMonth.value = originalMonth;
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
});
