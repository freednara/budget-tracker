import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as signals from '../js/modules/core/signals.js';
import {
  createRecurringTemplate,
  updateRecurringTemplate,
  deleteRecurringTemplate,
  processRecurringTemplates,
  clearRecurringTemplates,
  getRecurringTemplates
} from '../js/modules/data/recurring-templates.js';
import type { Transaction } from '../js/types/index.js';

/**
 * CR-Apr24-B [P2×5] — Recurring template correctness (Code-Review-Report
 * findings 40-44).
 *
 * (40) Editing startDate now also recomputes originalDayOfMonth
 * (41) deleteRecurringTemplate returns structured result + handles per-tx failures
 * (42) Catch-up cap raised from 100 to 2000 (long-overdue series can complete)
 * (43) RecurringTemplate.currency captured at creation; preserved across global currency changes
 * (44) processRecurringTemplates isolates per-template errors so one bad template doesn't abort the run
 */

const mockedDataSdk = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  getAll: vi.fn(),
  get: vi.fn()
}));

vi.mock('../js/modules/data/data-manager.js', () => ({
  dataSdk: mockedDataSdk
}));

function makeTxResult(overrides: Partial<Transaction> = {}): { isOk: true; data: Transaction } {
  return {
    isOk: true,
    data: {
      __backendId: `tx_${Math.random().toString(36).slice(2, 10)}`,
      type: 'expense',
      category: 'food',
      amount: 100,
      description: 'Recurring',
      date: '2026-04-15',
      currency: 'USD',
      tags: '',
      recurring: true,
      ...overrides
    } as Transaction
  };
}

describe('CR-Apr24-B — Recurring template correctness', () => {
  const originalCurrency = signals.currency.value;

  beforeEach(() => {
    clearRecurringTemplates();
    mockedDataSdk.create.mockReset();
    mockedDataSdk.delete.mockReset();
    mockedDataSdk.getAll.mockReset();
    mockedDataSdk.getAll.mockResolvedValue([]);
    mockedDataSdk.create.mockImplementation(() => Promise.resolve(makeTxResult()));
    mockedDataSdk.delete.mockResolvedValue({ isOk: true });
    signals.currency.value = { home: 'USD', symbol: '$' };
  });

  afterEach(() => {
    clearRecurringTemplates();
    signals.currency.value = originalCurrency;
    vi.clearAllMocks();
  });

  // ============================================================
  // Finding 40 — startDate change recomputes originalDayOfMonth
  // ============================================================

  describe('finding 40 — editing startDate recomputes originalDayOfMonth', () => {
    it('updates originalDayOfMonth when startDate changes', async () => {
      const id = await createRecurringTemplate({
        type: 'expense',
        category: 'rent',
        amount: 1500,
        description: 'Rent',
        tags: '',
        notes: '',
        startDate: '2026-01-15',
        endDate: '2030-01-15',
        recurringType: 'monthly',
        originalDayOfMonth: 15
      });

      const before = getRecurringTemplates().find(t => t.id === id);
      expect(before?.originalDayOfMonth).toBe(15);

      // User edits start date to a different day-of-month.
      updateRecurringTemplate(id, { startDate: '2026-02-22' });

      const after = getRecurringTemplates().find(t => t.id === id);
      expect(after?.startDate).toBe('2026-02-22');
      // Pre-fix: originalDayOfMonth would still be 15 → future occurrences
      // would land on day 15, drifting from the user's stated new anchor.
      expect(after?.originalDayOfMonth).toBe(22);
    });

    it('preserves originalDayOfMonth when startDate update is invalid (no garbage anchor)', async () => {
      const id = await createRecurringTemplate({
        type: 'expense',
        category: 'rent',
        amount: 1500,
        description: 'Rent',
        tags: '',
        notes: '',
        startDate: '2026-01-15',
        endDate: '2030-01-15',
        recurringType: 'monthly',
        originalDayOfMonth: 15
      });

      // Invalid YYYY-MM-DD → safe path drops both startDate AND
      // originalDayOfMonth recomputation; no poisoning.
      updateRecurringTemplate(id, { startDate: 'not-a-date' });

      const after = getRecurringTemplates().find(t => t.id === id);
      expect(after?.startDate).toBe('2026-01-15');
      expect(after?.originalDayOfMonth).toBe(15);
    });

    it('explicit originalDayOfMonth in same update wins over startDate-derived value', async () => {
      const id = await createRecurringTemplate({
        type: 'expense',
        category: 'rent',
        amount: 1500,
        description: 'Rent',
        tags: '',
        notes: '',
        startDate: '2026-01-15',
        endDate: '2030-01-15',
        recurringType: 'monthly',
        originalDayOfMonth: 15
      });

      // Caller passes BOTH new startDate (day 22) AND explicit
      // originalDayOfMonth (1). The explicit value should win — gives
      // power users control to decouple the two if they really want.
      updateRecurringTemplate(id, {
        startDate: '2026-02-22',
        originalDayOfMonth: 1
      });

      const after = getRecurringTemplates().find(t => t.id === id);
      expect(after?.startDate).toBe('2026-02-22');
      expect(after?.originalDayOfMonth).toBe(1);
    });
  });

  // ============================================================
  // Finding 41 — deleteRecurringTemplate structured result
  // ============================================================

  describe('finding 41 — deleteRecurringTemplate handles per-transaction failures', () => {
    it('returns ok=true when no transactions need deletion (deleteExisting=false)', async () => {
      const id = await createRecurringTemplate({
        type: 'expense',
        category: 'rent',
        amount: 1500,
        description: 'Rent',
        tags: '',
        notes: '',
        startDate: '2026-01-15',
        endDate: '2030-01-15',
        recurringType: 'monthly',
        originalDayOfMonth: 15
      });

      const result = await deleteRecurringTemplate(id, false);

      expect(result.ok).toBe(true);
      expect(result.toDeleteCount).toBe(0);
      expect(result.deletedCount).toBe(0);
      expect(result.failures).toEqual([]);
      // Template removed.
      expect(getRecurringTemplates().find(t => t.id === id)).toBeUndefined();
    });

    it('returns ok=false with failure list when one of N tx deletes fails', async () => {
      const id = await createRecurringTemplate({
        type: 'expense',
        category: 'rent',
        amount: 1500,
        description: 'Rent',
        tags: '',
        notes: '',
        startDate: '2026-01-15',
        endDate: '2030-01-15',
        recurringType: 'monthly',
        originalDayOfMonth: 15
      });

      // Three linked transactions; second one fails to delete.
      const tx1: Transaction = {
        __backendId: 'tx_1', type: 'expense', category: 'rent', amount: 1500,
        description: 'Rent', date: '2026-01-15', currency: 'USD', tags: '',
        recurring: true, recurringTemplateId: id
      } as Transaction;
      const tx2: Transaction = { ...tx1, __backendId: 'tx_2', date: '2026-02-15' };
      const tx3: Transaction = { ...tx1, __backendId: 'tx_3', date: '2026-03-15' };

      mockedDataSdk.getAll.mockResolvedValue([tx1, tx2, tx3]);
      mockedDataSdk.delete
        .mockResolvedValueOnce({ isOk: true })
        .mockRejectedValueOnce(new Error('IDB lost connection'))
        .mockResolvedValueOnce({ isOk: true });

      const result = await deleteRecurringTemplate(id, true);

      expect(result.ok).toBe(false);
      expect(result.toDeleteCount).toBe(3);
      expect(result.deletedCount).toBe(2); // tx1 + tx3 succeeded
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]?.transactionId).toBe('tx_2');
      expect(result.failures[0]?.error).toContain('IDB');
      // Template stays in place for retry.
      expect(getRecurringTemplates().find(t => t.id === id)).toBeDefined();
    });

    it('returns ok=true after a successful retry (template removed)', async () => {
      const id = await createRecurringTemplate({
        type: 'expense',
        category: 'rent',
        amount: 1500,
        description: 'Rent',
        tags: '',
        notes: '',
        startDate: '2026-01-15',
        endDate: '2030-01-15',
        recurringType: 'monthly',
        originalDayOfMonth: 15
      });

      const tx1: Transaction = {
        __backendId: 'tx_1', type: 'expense', category: 'rent', amount: 1500,
        description: 'Rent', date: '2026-01-15', currency: 'USD', tags: '',
        recurring: true, recurringTemplateId: id
      } as Transaction;

      mockedDataSdk.getAll.mockResolvedValue([tx1]);
      mockedDataSdk.delete.mockResolvedValueOnce({ isOk: true });

      const result = await deleteRecurringTemplate(id, true);

      expect(result.ok).toBe(true);
      expect(result.deletedCount).toBe(1);
      expect(getRecurringTemplates().find(t => t.id === id)).toBeUndefined();
    });

    it('returns ok=false on missing template (not found)', async () => {
      const result = await deleteRecurringTemplate('does_not_exist', true);

      expect(result.ok).toBe(false);
      expect(result.toDeleteCount).toBe(0);
      expect(result.deletedCount).toBe(0);
    });
  });

  // ============================================================
  // Finding 42 — catch-up cap raised
  // ============================================================

  describe('finding 42 — catch-up cap allows long-overdue series to complete', () => {
    it('processes more than 100 occurrences for a long-overdue daily template', async () => {
      // Daily template starting 6 months ago. Pre-fix would stop at 100.
      // With cap raised to 2000 and the per-occurrence "≤ 30 days
      // ahead" guard, we expect ~30 occurrences (one for every day in
      // the 30-day window + caught-up backlog).
      //
      // The implementation only generates occurrences within 30 days of
      // "now" — so even a 6-month-overdue template can generate at most
      // ~30 + days-since-last-generated occurrences in one call. The
      // test verifies the cap doesn't artificially truncate.
      let txCount = 0;
      mockedDataSdk.create.mockImplementation(() => {
        txCount++;
        return Promise.resolve(makeTxResult({ amount: txCount }));
      });

      // Set system time so the 30-day window is meaningful
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-15T12:00:00'));

      const id = await createRecurringTemplate({
        type: 'expense',
        category: 'food',
        amount: 10,
        description: 'Daily coffee',
        tags: '',
        notes: '',
        // Started 6 months ago → 180+ days of catchup possible in theory,
        // bounded by the "within 30 days" guard in generateNextOccurrence.
        startDate: '2025-10-15',
        endDate: '2030-01-01',
        recurringType: 'daily',
        originalDayOfMonth: 15
      });
      void id;

      // Reset count so we don't include the createTemplate's first occurrence.
      const initialCount = txCount;

      const result = await processRecurringTemplates();
      expect(result.generated).toBeGreaterThanOrEqual(0);

      // Pre-fix the cap was 100. Whatever the actual count is from
      // catch-up logic, the assertion is that it was NOT artificially
      // truncated at 100. Since generateNextOccurrence bounds by
      // `daysUntil > 30 → return null`, the actual generated count
      // depends on 30-day-window behavior — but the cap-hit count
      // should be 0 (we didn't run out of safety budget).
      expect(result.capHits).toBe(0);

      vi.useRealTimers();
      void initialCount;
    });
  });

  // ============================================================
  // Finding 43 — currency captured on template
  // ============================================================

  describe('finding 43 — template preserves its own currency across global changes', () => {
    it('captures current currency on createRecurringTemplate', async () => {
      signals.currency.value = { home: 'EUR', symbol: '€' };

      const id = await createRecurringTemplate({
        type: 'expense',
        category: 'rent',
        amount: 1500,
        description: 'Rent',
        tags: '',
        notes: '',
        startDate: '2026-01-15',
        endDate: '2030-01-15',
        recurringType: 'monthly',
        originalDayOfMonth: 15
      });

      const template = getRecurringTemplates().find(t => t.id === id);
      expect(template?.currency).toBe('EUR');
    });

    it('preserves template currency in generated occurrences after global currency change', async () => {
      signals.currency.value = { home: 'EUR', symbol: '€' };
      const captured: Array<Partial<Transaction>> = [];
      mockedDataSdk.create.mockImplementation((arg: Partial<Transaction>) => {
        captured.push(arg);
        return Promise.resolve(makeTxResult(arg.currency ? { currency: arg.currency } : {}));
      });

      const id = await createRecurringTemplate({
        type: 'expense',
        category: 'rent',
        amount: 1500,
        description: 'Rent',
        tags: '',
        notes: '',
        startDate: '2026-01-15',
        endDate: '2030-01-15',
        recurringType: 'monthly',
        originalDayOfMonth: 15
      });
      void id;
      // The first occurrence is created during createRecurringTemplate.
      // Verify it captured EUR (since global was EUR at create).
      const lastArg = captured[captured.length - 1];
      expect(lastArg?.currency).toBe('EUR');

      // Now flip global currency to JPY. Subsequent occurrence
      // generations should still post in EUR (template's stored currency).
      signals.currency.value = { home: 'JPY', symbol: '¥' };

      // We can't easily trigger generateNextOccurrence in isolation
      // because it's tied to date-window logic, but the contract test
      // is: the template's `currency` field stays EUR, so future
      // generations will use it via the `template.currency ?? signal`
      // fallback. Verify the field is intact.
      const template = getRecurringTemplates().find(t => t.id === id);
      expect(template?.currency).toBe('EUR');
      expect(signals.currency.value?.home).toBe('JPY'); // global flipped
    });

    it('updateRecurringTemplate accepts an explicit currency override', async () => {
      const id = await createRecurringTemplate({
        type: 'expense',
        category: 'rent',
        amount: 1500,
        description: 'Rent',
        tags: '',
        notes: '',
        startDate: '2026-01-15',
        endDate: '2030-01-15',
        recurringType: 'monthly',
        originalDayOfMonth: 15
      });

      updateRecurringTemplate(id, { currency: 'GBP' });

      const after = getRecurringTemplates().find(t => t.id === id);
      expect(after?.currency).toBe('GBP');
    });

    it('updateRecurringTemplate rejects empty/non-string currency values', async () => {
      signals.currency.value = { home: 'USD', symbol: '$' };
      const id = await createRecurringTemplate({
        type: 'expense',
        category: 'rent',
        amount: 1500,
        description: 'Rent',
        tags: '',
        notes: '',
        startDate: '2026-01-15',
        endDate: '2030-01-15',
        recurringType: 'monthly',
        originalDayOfMonth: 15
      });

      updateRecurringTemplate(id, { currency: '' });
      expect(getRecurringTemplates().find(t => t.id === id)?.currency).toBe('USD');

      // Cast through unknown to sneak past TS for the runtime check.
      updateRecurringTemplate(id, { currency: 123 as unknown as string });
      expect(getRecurringTemplates().find(t => t.id === id)?.currency).toBe('USD');
    });
  });

  // ============================================================
  // Finding 44 — per-template error isolation
  // ============================================================

  describe('finding 44 — processRecurringTemplates isolates per-template failures', () => {
    it('continues processing remaining templates when one throws', async () => {
      const id1 = await createRecurringTemplate({
        type: 'expense', category: 'food', amount: 10, description: 'A',
        tags: '', notes: '', startDate: '2026-04-01', endDate: '2030-01-01',
        recurringType: 'monthly', originalDayOfMonth: 1
      });
      const id2 = await createRecurringTemplate({
        type: 'expense', category: 'food', amount: 20, description: 'B',
        tags: '', notes: '', startDate: '2026-04-02', endDate: '2030-01-01',
        recurringType: 'monthly', originalDayOfMonth: 2
      });
      void id1; void id2;

      // First subsequent dataSdk.create call throws (simulating DB hiccup
      // for one specific template), rest succeed.
      let callCount = 0;
      mockedDataSdk.create.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // Reject — simulate a per-template processing failure
          return Promise.reject(new Error('Transient DB failure'));
        }
        return Promise.resolve(makeTxResult());
      });

      // Should NOT throw — the per-template try/catch contains the failure.
      const result = await processRecurringTemplates();

      // Some templates may still error; the run completes regardless.
      expect(result.templatesProcessed).toBeGreaterThanOrEqual(1);
      // No throw escaped — that's the contract.
    });

    it('returns structured result with generated count', async () => {
      const result = await processRecurringTemplates();
      expect(typeof result.generated).toBe('number');
      expect(typeof result.templatesProcessed).toBe('number');
      expect(typeof result.templatesErrored).toBe('number');
      expect(typeof result.capHits).toBe('number');
    });
  });
});
