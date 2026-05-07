/**
 * Phase 6 Slice 1f (Inline-Behavior-Review rev 12, L27)
 *
 * Verifies that `advanceRecurringPreviewDate()` clamps the day-of-month
 * when stepping across years, so Feb 29 starts no longer silently roll
 * to Mar 1 on non-leap years. Prior behavior: the yearly case was a
 * single-line `cur.setFullYear(cur.getFullYear() + 1)`, which for a
 * Feb 29 2024 start walked through Mar 1 2025 / Mar 1 2026 / Mar 1 2027 /
 * Feb 29 2028 — silently shifting the user's intended recurrence.
 *
 * The L27 fix mirrors the monthly/quarterly clamp: compute the maxDay
 * of the target month and use `Math.min(originalDay, maxDay)` so the
 * 29th is preserved on leap years and pulled to Feb 28 otherwise. The
 * authoritative generator in `data/recurring-templates.ts` already did
 * this — L27 brings the preview loop into line with it.
 */

import { describe, expect, it } from 'vitest';
import { advanceRecurringPreviewDate } from '../js/modules/transactions/edit-mode.js';

describe('advanceRecurringPreviewDate (L27)', () => {
  describe('yearly frequency — leap-year clamp', () => {
    it('walks Feb 29 2024 → Feb 28 2025 / Feb 28 2026 / Feb 28 2027 / Feb 29 2028', () => {
      const originalDay = 29;
      let cur = new Date(2024, 1, 29); // Feb 29, 2024 (leap year)

      cur = advanceRecurringPreviewDate(cur, 'yearly', originalDay);
      expect(cur.getFullYear()).toBe(2025);
      expect(cur.getMonth()).toBe(1); // February
      expect(cur.getDate()).toBe(28);

      cur = advanceRecurringPreviewDate(cur, 'yearly', originalDay);
      expect(cur.getFullYear()).toBe(2026);
      expect(cur.getMonth()).toBe(1);
      expect(cur.getDate()).toBe(28);

      cur = advanceRecurringPreviewDate(cur, 'yearly', originalDay);
      expect(cur.getFullYear()).toBe(2027);
      expect(cur.getMonth()).toBe(1);
      expect(cur.getDate()).toBe(28);

      // Leap year — original Feb 29 is preserved, not stuck at Feb 28.
      cur = advanceRecurringPreviewDate(cur, 'yearly', originalDay);
      expect(cur.getFullYear()).toBe(2028);
      expect(cur.getMonth()).toBe(1);
      expect(cur.getDate()).toBe(29);
    });

    it('never drifts to March on a Feb 29 yearly start', () => {
      const originalDay = 29;
      let cur = new Date(2024, 1, 29);
      for (let i = 0; i < 10; i++) {
        cur = advanceRecurringPreviewDate(cur, 'yearly', originalDay);
        expect(cur.getMonth()).toBe(1); // Must stay in February
      }
    });

    it('preserves Mar 31 yearly (all years have March 31)', () => {
      const originalDay = 31;
      let cur = new Date(2024, 2, 31); // Mar 31, 2024
      cur = advanceRecurringPreviewDate(cur, 'yearly', originalDay);
      expect(cur.getFullYear()).toBe(2025);
      expect(cur.getMonth()).toBe(2);
      expect(cur.getDate()).toBe(31);
    });
  });

  describe('monthly / quarterly remain unchanged', () => {
    it('monthly Jan 31 → Feb 28 (non-leap) / Feb 29 (leap)', () => {
      const originalDay = 31;

      let cur = new Date(2025, 0, 31); // Jan 31, 2025 (non-leap)
      cur = advanceRecurringPreviewDate(cur, 'monthly', originalDay);
      expect(cur.getMonth()).toBe(1);
      expect(cur.getDate()).toBe(28);

      cur = new Date(2024, 0, 31); // Jan 31, 2024 (leap)
      cur = advanceRecurringPreviewDate(cur, 'monthly', originalDay);
      expect(cur.getMonth()).toBe(1);
      expect(cur.getDate()).toBe(29);
    });

    it('quarterly Nov 30 → Feb (day-of-month clamp wraps year)', () => {
      const originalDay = 30;
      const cur = new Date(2024, 10, 30); // Nov 30, 2024
      const next = advanceRecurringPreviewDate(cur, 'quarterly', originalDay);
      expect(next.getFullYear()).toBe(2025);
      expect(next.getMonth()).toBe(1); // Feb
      expect(next.getDate()).toBe(28); // Feb 2025 has 28 days
    });
  });

  describe('daily / weekly / biweekly — simple step semantics', () => {
    it('daily adds 1 day', () => {
      const cur = new Date(2026, 3, 20);
      const next = advanceRecurringPreviewDate(cur, 'daily', 20);
      expect(next.getDate()).toBe(21);
    });

    it('weekly adds 7 days', () => {
      const cur = new Date(2026, 3, 20);
      const next = advanceRecurringPreviewDate(cur, 'weekly', 20);
      expect(next.getDate()).toBe(27);
    });

    it('biweekly adds 14 days', () => {
      const cur = new Date(2026, 3, 1);
      const next = advanceRecurringPreviewDate(cur, 'biweekly', 1);
      expect(next.getDate()).toBe(15);
    });
  });

  describe('pure-function contract', () => {
    it('does not mutate the input date', () => {
      const cur = new Date(2024, 1, 29);
      const curIso = cur.toISOString();
      advanceRecurringPreviewDate(cur, 'yearly', 29);
      expect(cur.toISOString()).toBe(curIso);
    });

    it('returns a copy of the input for unknown frequencies', () => {
      const cur = new Date(2026, 3, 20);
      const next = advanceRecurringPreviewDate(cur, 'someday-never', 20);
      expect(next.getTime()).toBe(cur.getTime());
      expect(next).not.toBe(cur);
    });
  });
});
