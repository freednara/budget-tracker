import { describe, expect, it } from 'vitest';

import { getDashboardCategoryBreakdownStatus } from '../js/modules/ui/charts/chart-renderers.js';
import type { CategoryTrendChange } from '../js/types/index.js';

describe('dashboard category breakdown status cues', () => {
  // 7a (Inline-Behavior-Review, CategoryTrendChange nullable widening):
  // `change` is `number | null` — the producer emits `null` for 'new' and
  // 'no-data' baseline statuses. Widen the helper signature so tests can
  // exercise both the numeric path (up/down/flat) and the null path
  // without resorting to `as any` casts.
  const trend = (direction: CategoryTrendChange['direction'], change: number | null): CategoryTrendChange => ({
    direction,
    change
  });

  it('marks high-share categories as caution even without trend data', () => {
    expect(getDashboardCategoryBreakdownStatus(41, undefined)).toEqual({
      label: 'Caution',
      tone: 'warning'
    });
  });

  it('marks large positive month-over-month changes as caution', () => {
    expect(getDashboardCategoryBreakdownStatus(14, trend('up', 15))).toEqual({
      label: 'Caution',
      tone: 'warning'
    });
  });

  it('marks medium-share categories with positive growth as caution', () => {
    expect(getDashboardCategoryBreakdownStatus(26, trend('up', 6))).toEqual({
      label: 'Caution',
      tone: 'warning'
    });
  });

  it('marks stable or declining lower-share categories as healthy', () => {
    expect(getDashboardCategoryBreakdownStatus(24, trend('down', 8))).toEqual({
      label: 'Healthy',
      tone: 'positive'
    });
    expect(getDashboardCategoryBreakdownStatus(18, trend('flat', 0))).toEqual({
      label: 'Healthy',
      tone: 'positive'
    });
  });

  it('does not assign misleading status to new categories below the concentration threshold', () => {
    // 7a: producer now emits `change: null` for 'new' — the status helper
    // short-circuits on direction 'new' before reading change, so this
    // still resolves to null (no misleading Caution/Healthy badge).
    expect(getDashboardCategoryBreakdownStatus(18, trend('new', null))).toBeNull();
  });

  // 7a (Inline-Behavior-Review, lock-in regression): pre-fix, the producer
  // fabricated `change: 100` for 'new' and `change: 0` for 'no-data'. A
  // future contributor could route those sentinels past the
  // direction-short-circuit in `getDashboardCategoryBreakdownStatus` and
  // get a real Caution/Healthy badge on synthetic data. Lock in the
  // null-channel behavior here so any attempt to regress to the sentinel
  // producer fails this test under the widened type system.
  it('handles null change on up/down/flat without synthesizing a status', () => {
    // An 'up' with null change should not trip the >=15 or >0 gates —
    // those gates now null-guard explicitly.
    expect(getDashboardCategoryBreakdownStatus(24, trend('up', null))).toBeNull();
    // A 'flat' with null change below 40% share is still Healthy (the
    // healthy check depends on direction + share, not on change).
    expect(getDashboardCategoryBreakdownStatus(18, trend('flat', null))).toEqual({
      label: 'Healthy',
      tone: 'positive'
    });
    // A 'down' with null change below 40% is still Healthy for the same
    // reason — the helper uses direction for the classification, change
    // only gates the up-side caution escalations.
    expect(getDashboardCategoryBreakdownStatus(24, trend('down', null))).toEqual({
      label: 'Healthy',
      tone: 'positive'
    });
  });
});
