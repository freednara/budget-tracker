import { describe, expect, it } from 'vitest';
import { formatCategoryChartLabel } from '../js/modules/core/utils-pure.js';

/**
 * CR-Apr22-D slice 5 coverage — Dashboard + analytics budget-vs-actual
 * x-axis label truncation (finding 63 [P3]).
 *
 * Before this slice, both `ui-render.ts:updateBudgetVsActualChart` and
 * `analytics-ui.ts:updateBudgetVsActualChart` built the bar-chart
 * x-axis labels as:
 *
 *     `${info.emoji} ${info.name.split(' ')[0]}`
 *
 * Taking only the first whitespace-separated token collapsed any pair
 * (or N-tuple) of categories that shared a first word into a single
 * label. Concretely, a user with "Car Insurance", "Car Payment", and
 * "Car Loan" saw three adjacent bars all labeled "🚗 Car" — the chart
 * legend (dataset label: Budget/Actual) still disambiguated the two
 * stacks, but there was no way to tell which bar pair was which
 * category.
 *
 * The fix adds `formatCategoryChartLabel(info, maxNameChars?)` to
 * `utils-pure.ts` and rewires both callsites. The helper keeps the
 * full name when it fits inside `maxNameChars` (default 14, chosen to
 * cover every default preset name — "Entertainment" = 13,
 * "Car Insurance" = 13, "Home & Garden" = 13 — and the vast majority
 * of custom names), and otherwise truncates with a trailing ellipsis
 * (U+2026) so the visible label is exactly `maxNameChars` characters
 * and preserves uniqueness where the names diverge before the cut.
 *
 * These tests are a pure-helper regression lock: fast (no DOM, no
 * signals, no module-init side effects), and cover the failure mode
 * from the review finding plus the full matrix of edge cases the
 * callsites care about (emoji presence, empty name, partial info
 * shape, whitespace trimming before the ellipsis, and the clamp on
 * pathologically small `maxNameChars` values).
 */

describe('formatCategoryChartLabel — CR-Apr22-D slice 5', () => {
  describe('regression lock for finding 63 (shared first word)', () => {
    it('preserves distinct names that share a first word — the core fix', () => {
      // The three labels in the review finding. Under the legacy
      // `split(' ')[0]` pattern these all collapsed to "🚗 Car".
      const insurance = formatCategoryChartLabel({ emoji: '🚗', name: 'Car Insurance' });
      const payment = formatCategoryChartLabel({ emoji: '🚗', name: 'Car Payment' });
      const loan = formatCategoryChartLabel({ emoji: '🚗', name: 'Car Loan' });

      expect(insurance).toBe('🚗 Car Insurance');
      expect(payment).toBe('🚗 Car Payment');
      expect(loan).toBe('🚗 Car Loan');

      // All three must be pairwise distinct — the load-bearing
      // property the fix restores.
      const unique = new Set([insurance, payment, loan]);
      expect(unique.size).toBe(3);
    });

    it('preserves distinct names that share a first token even when one truncates', () => {
      // Slightly longer sibling names with a shared prefix: the
      // ellipsis falls AFTER the divergence point, so uniqueness is
      // preserved even when the full names exceed the budget.
      // "Household Repairs" = 17 chars → "Household Repa…" (15 chars)
      // "Household Cleaning" = 18 chars → "Household Clea…" (15 chars)
      const repairs = formatCategoryChartLabel(
        { emoji: '🏠', name: 'Household Repairs' },
        15
      );
      const cleaning = formatCategoryChartLabel(
        { emoji: '🏠', name: 'Household Cleaning' },
        15
      );
      expect(repairs).toBe('🏠 Household Repa…');
      expect(cleaning).toBe('🏠 Household Clea…');
      expect(repairs).not.toBe(cleaning);
    });
  });

  describe('name length handling', () => {
    it('returns the full name when it is shorter than the budget', () => {
      expect(formatCategoryChartLabel({ emoji: '🍔', name: 'Food' })).toBe('🍔 Food');
    });

    it('returns the full name when it is exactly the budget length', () => {
      // "Entertainment" is 13 chars — default budget is 14 → untouched.
      expect(formatCategoryChartLabel({ emoji: '🎬', name: 'Entertainment' })).toBe(
        '🎬 Entertainment'
      );

      // "Fourteen Chars" is exactly 14 chars → untouched at default budget.
      expect(formatCategoryChartLabel({ emoji: '📏', name: 'Fourteen Chars' })).toBe(
        '📏 Fourteen Chars'
      );
    });

    it('truncates names longer than the budget with a U+2026 ellipsis', () => {
      // "Emergency Savings Fund" = 22 chars → truncate to 13 chars + ellipsis = 14.
      const result = formatCategoryChartLabel({
        emoji: '🚨',
        name: 'Emergency Savings Fund'
      });
      expect(result).toBe('🚨 Emergency Sav…');
      // Name portion is 14 visible chars (13 + ellipsis).
      const namePortion = result.slice(result.indexOf(' ') + 1);
      expect(namePortion.length).toBe(14);
      expect(namePortion.endsWith('…')).toBe(true);
    });

    it('respects a custom maxNameChars budget', () => {
      const result = formatCategoryChartLabel(
        { emoji: '📚', name: 'Education and Training' },
        10
      );
      // 10-char name budget → "Education…" (9 chars + ellipsis = 10).
      expect(result).toBe('📚 Education…');
    });
  });

  describe('whitespace handling at the truncation boundary', () => {
    it('trims trailing whitespace before appending the ellipsis', () => {
      // "Car Insurance Premium" = 21 chars; with budget 5 we'd
      // otherwise produce "Car …" (4 chars + space + ellipsis) which
      // reads as two separate tokens. trimEnd prevents that: "Car…".
      const result = formatCategoryChartLabel(
        { emoji: '🚗', name: 'Car Insurance Premium' },
        5
      );
      expect(result).toBe('🚗 Car…');
      // Confirm no double-space artifact.
      expect(result.includes('  ')).toBe(false);
    });
  });

  describe('input robustness (partial info shapes)', () => {
    it('handles missing emoji gracefully (no leading space artifact)', () => {
      expect(formatCategoryChartLabel({ name: 'Food' })).toBe('Food');
    });

    it('handles missing name as empty string', () => {
      expect(formatCategoryChartLabel({ emoji: '🍔' })).toBe('🍔 ');
    });

    it('handles empty object (both fields missing)', () => {
      expect(formatCategoryChartLabel({})).toBe('');
    });

    it('handles non-string emoji/name defensively (typed input only reaches here via getCatInfo, but belt-and-suspenders)', () => {
      // Cast-through-unknown: simulates a corrupted info object from an
      // unexpected caller. The helper should not throw.
      const bogus = { emoji: 42 as unknown as string, name: null as unknown as string };
      expect(() => formatCategoryChartLabel(bogus)).not.toThrow();
      expect(formatCategoryChartLabel(bogus)).toBe('');
    });
  });

  describe('maxNameChars clamp', () => {
    it('clamps pathologically small budgets to a minimum of 2', () => {
      // Budget 1 would produce `slice(0, 0) + '…'` → just "…" — a
      // pure-noise label. The helper clamps to 2 so there's always at
      // least one original character to anchor the viewer.
      const result = formatCategoryChartLabel(
        { emoji: '🍔', name: 'Foodstuffs' },
        1
      );
      expect(result).toBe('🍔 F…');
    });

    it('clamps zero and negative budgets to 2 as well', () => {
      expect(
        formatCategoryChartLabel({ emoji: '🍔', name: 'Foodstuffs' }, 0)
      ).toBe('🍔 F…');
      expect(
        formatCategoryChartLabel({ emoji: '🍔', name: 'Foodstuffs' }, -5)
      ).toBe('🍔 F…');
    });
  });

  describe('dashboard-parity snapshots (the two callsites that matter)', () => {
    it('produces the same label for the same info in every caller', () => {
      // Both `ui-render.ts:updateBudgetVsActualChart` and
      // `analytics-ui.ts:updateBudgetVsActualChart` resolve category
      // info via `getCatInfo('expense', id)` and then pass it to this
      // helper. Anchor a representative set here so any future change
      // to the label format shows up as a single-source failure.
      expect(formatCategoryChartLabel({ emoji: '🍔', name: 'Groceries' })).toBe(
        '🍔 Groceries'
      );
      expect(formatCategoryChartLabel({ emoji: '🏠', name: 'Home & Garden' })).toBe(
        '🏠 Home & Garden'
      );
      expect(formatCategoryChartLabel({ emoji: '🚗', name: 'Transportation' })).toBe(
        '🚗 Transportation'
      );
      expect(
        formatCategoryChartLabel({ emoji: '🏥', name: 'Medical & Dental' })
      ).toBe('🏥 Medical & Den…');
    });
  });
});
