import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { syncState } from '../js/modules/core/state-actions.js';
import { SK } from '../js/modules/core/state.js';
import * as signals from '../js/modules/core/signals.js';

/**
 * CR-Apr24-E [P2×5 + P3×1] — Cross-tab sync validator depth
 * (Code-Review-Report findings 217, 218, 221, 222, 223, 224).
 *
 * Pre-fix the `applyKeyUpdate` validators were too shallow — malformed
 * remote payloads passed the gate and downstream consumers crashed or
 * silently produced wrong results when they tried to use the missing
 * fields. The fix tightens each validator to the actual required
 * surface that downstream code reads.
 *
 * Tests verify each rejection: a malformed payload doesn't change the
 * relevant signal value (the validator returned false → applyKeyUpdate
 * returned false → no setter was called).
 */

function snapshotAchievements() {
  return JSON.parse(JSON.stringify(signals.achievements.value));
}
function snapshotMonthlyAlloc() {
  return JSON.parse(JSON.stringify(signals.monthlyAlloc.value));
}
function snapshotDebts() {
  return JSON.parse(JSON.stringify(signals.debts.value));
}
function snapshotFilterPresets() {
  return JSON.parse(JSON.stringify(signals.filterPresets.value));
}
function snapshotTxTemplates() {
  return JSON.parse(JSON.stringify(signals.txTemplates.value));
}

describe('CR-Apr24-E — Sync validator depth', () => {
  let achievementsBefore: Record<string, unknown>;
  let allocBefore: Record<string, Record<string, number>>;
  let debtsBefore: unknown;
  let presetsBefore: unknown;
  let templatesBefore: unknown;

  beforeEach(() => {
    achievementsBefore = snapshotAchievements();
    allocBefore = snapshotMonthlyAlloc();
    debtsBefore = snapshotDebts();
    presetsBefore = snapshotFilterPresets();
    templatesBefore = snapshotTxTemplates();
  });

  afterEach(() => {
    // Restore in case any test mutated state (the rejections below
    // SHOULD leave state unchanged, but defense-in-depth).
    signals.achievements.value = { ...achievementsBefore };
    signals.monthlyAlloc.value = { ...allocBefore };
    signals.debts.value = (debtsBefore as typeof signals.debts.value);
    signals.filterPresets.value = (presetsBefore as typeof signals.filterPresets.value);
    signals.txTemplates.value = (templatesBefore as typeof signals.txTemplates.value);
  });

  // ============================================================
  // Finding 217 — achievements validator now requires EarnedAchievement shape
  // ============================================================

  describe('finding 217 — isAchievementsRecord requires {earned, date}', () => {
    it('rejects legacy boolean-shaped payload', () => {
      const before = snapshotAchievements();
      const result = syncState.applyKeyUpdate(SK.ACHIEVE, { 'first_tx': true, 'budget_boss': false });
      expect(result).toBe(false);
      expect(signals.achievements.value).toEqual(before);
    });

    it('accepts modern EarnedAchievement payload', () => {
      const result = syncState.applyKeyUpdate(SK.ACHIEVE, {
        'first_tx': { earned: true, date: '2026-04-01' }
      });
      expect(result).toBe(true);
    });

    it('rejects mixed-shape payload (one good, one bad)', () => {
      const before = snapshotAchievements();
      const result = syncState.applyKeyUpdate(SK.ACHIEVE, {
        'first_tx': { earned: true, date: '2026-04-01' },
        'budget_boss': true // legacy boolean — rejects whole payload
      });
      expect(result).toBe(false);
      expect(signals.achievements.value).toEqual(before);
    });

    it('accepts empty object (initial state)', () => {
      const result = syncState.applyKeyUpdate(SK.ACHIEVE, {});
      expect(result).toBe(true);
    });
  });

  // ============================================================
  // Finding 221 — isMonthlyAllocationMap depth-validates amounts
  // ============================================================

  describe('finding 221 — isMonthlyAllocationMap requires finite numeric amounts', () => {
    it('rejects non-numeric category amount (string)', () => {
      const before = snapshotMonthlyAlloc();
      const result = syncState.applyKeyUpdate(SK.ALLOC, {
        '2026-04': { food: 'fifty', rent: 1500 }
      });
      expect(result).toBe(false);
      expect(signals.monthlyAlloc.value).toEqual(before);
    });

    it('rejects non-numeric category amount (object)', () => {
      const before = snapshotMonthlyAlloc();
      const result = syncState.applyKeyUpdate(SK.ALLOC, {
        '2026-04': { food: {}, rent: 1500 }
      });
      expect(result).toBe(false);
      expect(signals.monthlyAlloc.value).toEqual(before);
    });

    it('rejects NaN amount', () => {
      const before = snapshotMonthlyAlloc();
      const result = syncState.applyKeyUpdate(SK.ALLOC, {
        '2026-04': { food: NaN }
      });
      expect(result).toBe(false);
      expect(signals.monthlyAlloc.value).toEqual(before);
    });

    it('rejects Infinity amount', () => {
      const before = snapshotMonthlyAlloc();
      const result = syncState.applyKeyUpdate(SK.ALLOC, {
        '2026-04': { food: Infinity }
      });
      expect(result).toBe(false);
      expect(signals.monthlyAlloc.value).toEqual(before);
    });

    it('accepts well-formed allocation payload', () => {
      const result = syncState.applyKeyUpdate(SK.ALLOC, {
        '2026-04': { food: 500, rent: 1500 },
        '2026-05': { food: 600 }
      });
      expect(result).toBe(true);
    });

    it('accepts empty per-month allocation (no categories yet)', () => {
      const result = syncState.applyKeyUpdate(SK.ALLOC, {
        '2026-04': {}
      });
      expect(result).toBe(true);
    });
  });

  // ============================================================
  // Finding 222 — isDebt requires planner-critical fields
  // ============================================================

  describe('finding 222 — isDebt requires full planner surface', () => {
    it('rejects debt with only id/name/balance', () => {
      const before = snapshotDebts();
      const result = syncState.applyKeyUpdate(SK.DEBTS, [
        { id: 'd1', name: 'Test', balance: 1000 }
      ]);
      expect(result).toBe(false);
      expect(signals.debts.value).toEqual(before);
    });

    it('rejects debt missing interestRate', () => {
      const before = snapshotDebts();
      const result = syncState.applyKeyUpdate(SK.DEBTS, [{
        id: 'd1', name: 'Test', balance: 1000,
        type: 'credit_card', originalBalance: 1500,
        // interestRate missing
        minimumPayment: 50, dueDay: 15, createdAt: '2026-01-01',
        payments: [], isActive: true
      }]);
      expect(result).toBe(false);
      expect(signals.debts.value).toEqual(before);
    });

    it('rejects debt with non-array payments', () => {
      const before = snapshotDebts();
      const result = syncState.applyKeyUpdate(SK.DEBTS, [{
        id: 'd1', name: 'Test', balance: 1000,
        type: 'credit_card', originalBalance: 1500,
        interestRate: 0.12, minimumPayment: 50, dueDay: 15,
        createdAt: '2026-01-01',
        payments: null, // BAD
        isActive: true
      }]);
      expect(result).toBe(false);
      expect(signals.debts.value).toEqual(before);
    });

    it('accepts well-formed debt with empty payments array', () => {
      const result = syncState.applyKeyUpdate(SK.DEBTS, [{
        id: 'd1', name: 'Test', balance: 1000,
        type: 'credit_card', originalBalance: 1500,
        interestRate: 0.12, minimumPayment: 50, dueDay: 15,
        createdAt: '2026-01-01', payments: [], isActive: true
      }]);
      expect(result).toBe(true);
    });
  });

  // ============================================================
  // Finding 223 — isTxTemplate requires id/name/type/category
  // ============================================================

  describe('finding 223 — isTxTemplate requires required fields', () => {
    it('rejects template with only id', () => {
      const before = snapshotTxTemplates();
      const result = syncState.applyKeyUpdate(SK.TX_TEMPLATES, [{ id: 't1' }]);
      expect(result).toBe(false);
      expect(signals.txTemplates.value).toEqual(before);
    });

    it('rejects template missing type', () => {
      const before = snapshotTxTemplates();
      const result = syncState.applyKeyUpdate(SK.TX_TEMPLATES, [{
        id: 't1', name: 'Coffee', category: 'food'
        // type missing
      }]);
      expect(result).toBe(false);
      expect(signals.txTemplates.value).toEqual(before);
    });

    it('rejects template with bad type value', () => {
      const before = snapshotTxTemplates();
      const result = syncState.applyKeyUpdate(SK.TX_TEMPLATES, [{
        id: 't1', name: 'Coffee', type: 'transfer', category: 'food'
      }]);
      expect(result).toBe(false);
      expect(signals.txTemplates.value).toEqual(before);
    });

    it('accepts well-formed expense template', () => {
      const result = syncState.applyKeyUpdate(SK.TX_TEMPLATES, [{
        id: 't1', name: 'Coffee', type: 'expense', category: 'food'
      }]);
      expect(result).toBe(true);
    });

    it('accepts well-formed income template', () => {
      const result = syncState.applyKeyUpdate(SK.TX_TEMPLATES, [{
        id: 't2', name: 'Salary', type: 'income', category: 'salary'
      }]);
      expect(result).toBe(true);
    });
  });

  // ============================================================
  // Finding 224 — isFilterPreset requires filters payload
  // ============================================================

  describe('finding 224 — isFilterPreset requires filters payload', () => {
    it('rejects preset missing filters', () => {
      const before = snapshotFilterPresets();
      const result = syncState.applyKeyUpdate(SK.FILTER_PRESETS, [
        { id: 'p1', name: 'My filter' }
      ]);
      expect(result).toBe(false);
      expect(signals.filterPresets.value).toEqual(before);
    });

    it('rejects preset with non-object filters', () => {
      const before = snapshotFilterPresets();
      const result = syncState.applyKeyUpdate(SK.FILTER_PRESETS, [
        { id: 'p1', name: 'My filter', filters: 'all-expenses' }
      ]);
      expect(result).toBe(false);
      expect(signals.filterPresets.value).toEqual(before);
    });

    it('accepts preset with empty filters object (reset-all preset)', () => {
      const result = syncState.applyKeyUpdate(SK.FILTER_PRESETS, [
        { id: 'p1', name: 'Reset', filters: {} }
      ]);
      expect(result).toBe(true);
    });

    it('accepts well-formed preset with populated filters', () => {
      const result = syncState.applyKeyUpdate(SK.FILTER_PRESETS, [
        { id: 'p1', name: 'Q1 expenses', filters: { dateFrom: '2026-01-01', dateTo: '2026-03-31', category: 'food' } }
      ]);
      expect(result).toBe(true);
    });
  });
});
