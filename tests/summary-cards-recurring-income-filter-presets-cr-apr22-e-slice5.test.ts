import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as signals from '../js/modules/core/signals.js';
import { saveFilterPreset, deleteFilterPreset } from '../js/modules/ui/widgets/filters.js';
import { mountSummaryCards } from '../js/modules/components/summary-cards.js';
import { data } from '../js/modules/core/state-actions.js';
import { invalidateAllCache } from '../js/modules/core/monthly-totals-cache.js';
import type { Transaction } from '../js/types/index.js';

/**
 * CR-Apr22-E slice 5 coverage — two P3 cleanups bundled together:
 *
 * (a) `summary-cards.ts` incomeTrend no-op helper removal (finding:
 *     `getRecurringIncome()` returned `getEffectiveIncome(mk) -
 *     currentMonthTotals.income`, and `getEffectiveIncome(mk)` is
 *     literally `sumByType(getMonthTx(mk), 'income')` — i.e. the same
 *     sum that defines `currentMonthTotals.income`). The delta was
 *     structurally 0. Post-fix: `incomeTrend` reads
 *     `currentMonthTotals.value.income` directly.
 *
 * (b) `filters.ts:saveFilterPreset` id collision (finding: preset id
 *     was `preset_${Date.now()}`, which collides when two presets save
 *     in the same millisecond — `Date.now()` is millisecond-quantized
 *     and the call site is synchronous). Post-fix: `preset_${generateId()}`
 *     uses the canonical UUID helper from `utils-pure.ts`.
 *
 * These tests lock the post-fix contracts.
 */

// ============================================================
// Test A: Summary-cards incomeTrend no-double-count regression
// ============================================================

function seedSummaryDom(): void {
  document.body.innerHTML = `
    <span id="total-income"></span>
    <span id="total-expenses"></span>
    <span id="income-trend"></span>
    <span id="expense-trend"></span>
    <span id="total-balance"></span>
  `;
}

function makeTx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    __backendId: `tx_${Math.random().toString(36).slice(2, 10)}`,
    type: 'expense',
    category: 'food',
    amount: 10,
    description: 'x',
    date: '2026-04-15',
    currency: 'USD',
    tags: '',
    recurring: false,
    ...overrides
  } as Transaction;
}

describe('CR-Apr22-E slice 5 (a) — summary-cards incomeTrend no-op helper removal', () => {
  const originalTx = signals.transactions.value;
  const originalMonth = signals.currentMonth.value;
  let cleanup: (() => void) | null = null;

  beforeEach(() => {
    seedSummaryDom();
    // monthly-totals-cache is a module-level Map — clear it between
    // tests so prev-month data from a prior `it` block doesn't leak
    // into the `prevMonthData` computed through the cache.
    invalidateAllCache();
    signals.replaceTransactionLedger([]);
    signals.currentMonth.value = '2026-04';
  });

  afterEach(() => {
    if (cleanup) {
      try { cleanup(); } catch { /* swallow */ }
      cleanup = null;
    }
    signals.replaceTransactionLedger(originalTx);
    signals.currentMonth.value = originalMonth;
    document.body.innerHTML = '';
  });

  it('renders income-trend from currentMonthTotals.income (no double-count regression)', () => {
    // Prior month: $1000 income. Current month: $1500 income. Expected: +50%.
    // If the old buggy code had ever added a non-zero
    // getRecurringIncome() delta, the visible percentage would shift.
    signals.replaceTransactionLedger([
      makeTx({ type: 'income', category: 'salary', amount: 1000, date: '2026-03-15' }),
      makeTx({ type: 'income', category: 'salary', amount: 1500, date: '2026-04-15' })
    ]);

    cleanup = mountSummaryCards();

    const trendEl = document.getElementById('income-trend');
    expect(trendEl).not.toBeNull();
    const trendText = trendEl?.textContent ?? '';
    // +50% change rendered as "↑ 50% vs last month"
    expect(trendText).toContain('50%');
    expect(trendText).toContain('↑');
    expect(trendText).toContain('vs last month');
    expect(trendEl?.classList.contains('hidden')).toBe(false);
  });

  it('hides trend when previous month has no income (baseline=no-data)', () => {
    // No March income ⇒ baseline 'no-data' ⇒ trend collapses to hidden.
    signals.replaceTransactionLedger([
      makeTx({ type: 'income', category: 'salary', amount: 1500, date: '2026-04-15' })
    ]);

    cleanup = mountSummaryCards();

    const trendEl = document.getElementById('income-trend');
    expect(trendEl?.classList.contains('hidden')).toBe(true);
  });

  it('renders a DOWN trend when current income drops vs previous', () => {
    // March $2000, April $1500 ⇒ -25% ⇒ "↓ 25%" (not-isGood because income down)
    signals.replaceTransactionLedger([
      makeTx({ type: 'income', category: 'salary', amount: 2000, date: '2026-03-15' }),
      makeTx({ type: 'income', category: 'salary', amount: 1500, date: '2026-04-15' })
    ]);

    cleanup = mountSummaryCards();

    const trendEl = document.getElementById('income-trend');
    const trendText = trendEl?.textContent ?? '';
    expect(trendText).toContain('25%');
    expect(trendText).toContain('↓');
    expect(trendEl?.classList.contains('hidden')).toBe(false);
  });

  it('income trend matches direct (currentMonthTotals - prev) math without helper intermediation', () => {
    // This is the structural regression lock: we seed known values
    // and assert the percentage is computed strictly from
    // currentMonthTotals.income (which mirrors sumByType(tx,'income')).
    // If anyone re-introduces a `+ getRecurringIncome()`-style term
    // that returns non-zero for any reason, the assertion shifts.
    signals.replaceTransactionLedger([
      makeTx({ type: 'income', category: 'salary', amount: 1000, date: '2026-03-15' }),
      makeTx({ type: 'income', category: 'salary', amount: 1100, date: '2026-04-15' })
    ]);

    cleanup = mountSummaryCards();

    // +10% exactly.
    const trendEl = document.getElementById('income-trend');
    const trendText = trendEl?.textContent ?? '';
    expect(trendText).toContain('10%');
    expect(trendText).not.toContain('11%');
    expect(trendText).not.toContain('12%');
  });
});

// ============================================================
// Test B: Filter preset id collision fix
// ============================================================

describe('CR-Apr22-E slice 5 (b) — saveFilterPreset id uses UUID, not Date.now()', () => {
  const originalPresets = signals.filterPresets.value;
  let showToastContainer: HTMLElement;

  beforeEach(() => {
    // saveFilterPreset calls showToast and renderFilterPresets, which
    // touch the DOM. Seed a container so neither explodes on null refs.
    document.body.innerHTML = `
      <div id="toast-container"></div>
      <div id="saved-presets-list"></div>
    `;
    showToastContainer = document.getElementById('toast-container') as HTMLElement;
    void showToastContainer; // silence unused
    data.setFilterPresets([]);
  });

  afterEach(() => {
    data.setFilterPresets(originalPresets);
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('produces distinct ids when two presets are saved in the same millisecond', () => {
    // Pin Date.now() to a fixed value. Under the old scheme this
    // guaranteed collision; under the new scheme `generateId()` yields
    // a fresh UUID regardless of clock, so ids diverge.
    const frozen = 1745000000000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(frozen);

    saveFilterPreset('Alpha');
    saveFilterPreset('Beta');

    const presets = signals.filterPresets.value;
    expect(presets).toHaveLength(2);
    expect(presets[0]!.id).not.toBe(presets[1]!.id);

    // Both start with the `preset_` namespace (contract preserved).
    expect(presets[0]!.id.startsWith('preset_')).toBe(true);
    expect(presets[1]!.id.startsWith('preset_')).toBe(true);

    // And neither is literally `preset_${Date.now()}` — pre-fix
    // canary: the old code would have produced exactly this string.
    expect(presets[0]!.id).not.toBe(`preset_${frozen}`);
    expect(presets[1]!.id).not.toBe(`preset_${frozen}`);

    nowSpy.mockRestore();
  });

  it('saves five rapid presets with five unique ids', () => {
    // Birthday-paradox smoke: even 5 saves in the same ms would
    // collide under Date.now(). UUID generation is collision-free in
    // practice.
    const frozen = 1745000000000;
    vi.spyOn(Date, 'now').mockReturnValue(frozen);

    saveFilterPreset('A');
    saveFilterPreset('B');
    saveFilterPreset('C');
    saveFilterPreset('D');
    saveFilterPreset('E');

    const presets = signals.filterPresets.value;
    expect(presets).toHaveLength(5);

    const ids = presets.map(p => p.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(5);
  });

  it('id format follows `preset_<uuid-like>` shape', () => {
    saveFilterPreset('FormatCheck');

    const presets = signals.filterPresets.value;
    expect(presets).toHaveLength(1);
    const id = presets[0]!.id;

    // Shape: preset_ + UUID (hex groups separated by hyphens).
    // generateId() produces an RFC-4122-shaped v4 UUID string.
    expect(id).toMatch(/^preset_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('deletion by id still works after the id-scheme change', () => {
    saveFilterPreset('Keep');
    saveFilterPreset('Remove');

    const [keep, remove] = signals.filterPresets.value;
    expect(keep).toBeDefined();
    expect(remove).toBeDefined();
    if (!keep || !remove) return;

    deleteFilterPreset(remove.id);

    const after = signals.filterPresets.value;
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(keep.id);
    expect(after[0]!.name).toBe('Keep');
  });

  it('rapid saves followed by delete-by-id correctly targets ONE preset', () => {
    // Pre-fix failure mode: two presets saved in the same ms would
    // share an id; deleteFilterPreset(collidingId) would delete BOTH.
    // Post-fix: unique ids ensure single-row delete.
    const frozen = 1745000000000;
    vi.spyOn(Date, 'now').mockReturnValue(frozen);

    saveFilterPreset('First');
    saveFilterPreset('Second');
    saveFilterPreset('Third');

    expect(signals.filterPresets.value).toHaveLength(3);

    const second = signals.filterPresets.value[1]!;
    deleteFilterPreset(second.id);

    const after = signals.filterPresets.value;
    expect(after).toHaveLength(2);
    expect(after.map(p => p.name)).toEqual(['First', 'Third']);
  });
});
