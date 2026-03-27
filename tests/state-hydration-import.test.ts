import { beforeEach, describe, expect, it } from 'vitest';

import { SK } from '../js/modules/core/state.js';
import * as signals from '../js/modules/core/signals.js';
import { hydrateFromImport } from '../js/modules/core/state-hydration.js';

describe('hydrateFromImport', () => {
  beforeEach(() => {
    localStorage.clear();
    signals.replaceTransactionLedger([]);
  });

  it('keeps the authoritative imported ledger instead of rereading stale localStorage', () => {
    const staleTransactions = [
      {
        __backendId: 'stale_tx',
        type: 'expense' as const,
        amount: 10,
        description: 'Stale',
        date: '2026-03-01',
        category: 'food',
        currency: 'USD',
        recurring: false
      }
    ];
    const importedTransactions = [
      {
        __backendId: 'fresh_tx',
        type: 'income' as const,
        amount: 250,
        description: 'Fresh',
        date: '2026-03-02',
        category: 'salary',
        currency: 'USD',
        recurring: false
      }
    ];

    localStorage.setItem(SK.TX, JSON.stringify(staleTransactions));

    hydrateFromImport({ currency: { home: 'USD', symbol: '$' } }, importedTransactions);

    expect(signals.transactions.value).toEqual(importedTransactions);
  });
});
