import { beforeEach, describe, expect, it, vi } from 'vitest';

// CR-Apr22-F slice 1: spy on `loadRecurringTemplates` so the reload-
// trigger tests can assert hydrateFromImport routes through it whenever
// the import payload touched SK.RECURRING. Spread vi.importActual so
// the rest of the module (saveRecurringTemplates, validator helpers,
// etc.) keeps its real implementation — see memory feedback_test_mock_drift
// for why hand-copied factories go stale.
const mockLoadRecurringTemplates = vi.fn();
vi.mock('../js/modules/data/recurring-templates.js', async () => {
  const actual = await vi.importActual<typeof import('../js/modules/data/recurring-templates.js')>(
    '../js/modules/data/recurring-templates.js'
  );
  return {
    ...actual,
    loadRecurringTemplates: () => {
      mockLoadRecurringTemplates();
      actual.loadRecurringTemplates();
    }
  };
});

import { SK } from '../js/modules/core/state.js';
import * as signals from '../js/modules/core/signals.js';
import { hydrateFromImport } from '../js/modules/core/state-hydration.js';
import { userCategoryConfig } from '../js/modules/core/category-store.js';

describe('hydrateFromImport', () => {
  beforeEach(() => {
    localStorage.clear();
    signals.replaceTransactionLedger([]);
    userCategoryConfig.value = null;
    mockLoadRecurringTemplates.mockClear();
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

  it('hydrates the user-owned category configuration from import payloads', () => {
    const importedCategories = {
      presetId: 'minimal',
      version: 1,
      expense: [],
      income: []
    };

    hydrateFromImport({ userCategories: importedCategories });

    expect(userCategoryConfig.value).toEqual(importedCategories);
  });

  it('hydrates onboarding and advanced-filter state into live signals during import', () => {
    signals.onboarding.value = { active: false, step: 0, completed: false };
    signals.filtersExpanded.value = false;

    const result = hydrateFromImport({
      onboarding: { active: true, step: 2, completed: false },
      filtersExpanded: true
    });

    expect(result.failed).toEqual([]);
    expect(signals.onboarding.value).toEqual({ active: true, step: 2, completed: false });
    expect(signals.filtersExpanded.value).toBe(true);
  });

  // CR-Apr22-F slice 1: SK.RECURRING has no signal — its in-memory
  // `Map<string, RecurringTemplate>` is rebuilt by
  // `loadRecurringTemplates()`, which we spy on above. The hydrate path
  // MUST call it whenever the import payload carried a recurringTemplates
  // key (including an explicit `{}` wipe), and MUST NOT call it when the
  // key is absent — that distinction keeps merge-mode no-ops from
  // spuriously churning the scheduler Map.
  describe('recurring-templates reload trigger (CR-Apr22-F slice 1)', () => {
    it('rebuilds the in-memory recurring-templates Map when the payload included recurringTemplates', () => {
      const payload = {
        recurringTemplates: {
          r1: {
            id: 'r1',
            type: 'expense' as const,
            category: 'food',
            amount: 20,
            description: '',
            tags: '',
            notes: '',
            startDate: '2026-01-01',
            endDate: '2099-12-31',
            recurringType: 'monthly' as const,
            originalDayOfMonth: 1,
            active: true
          }
        }
      };

      hydrateFromImport(payload);

      expect(mockLoadRecurringTemplates).toHaveBeenCalledTimes(1);
    });

    it('rebuilds the Map even when the payload explicitly clears SK.RECURRING via {}', () => {
      // An overwrite-wipe scenario must still trigger the reload so the
      // scheduler's in-memory Map drops any lingering entries.
      hydrateFromImport({ recurringTemplates: {} });
      expect(mockLoadRecurringTemplates).toHaveBeenCalledTimes(1);
    });

    it('does NOT rebuild the Map when recurringTemplates is absent from the payload', () => {
      hydrateFromImport({ currency: { home: 'USD', symbol: '$' } });
      expect(mockLoadRecurringTemplates).not.toHaveBeenCalled();
    });
  });
});
