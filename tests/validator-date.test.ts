import { describe, expect, it } from 'vitest';
import { validateDate } from '../js/modules/core/validator.js';

/**
 * C12 regression: `new Date("2024-02-30T00:00:00")` silently overflows to
 * Mar 1 without producing NaN, so `isNaN(date.getTime())` alone is not
 * sufficient to reject impossible calendar dates. The round-trip YMD
 * comparison added in rev 12 closes this gap.
 */
describe('validator.validateDate — calendar integrity (C12)', () => {
  describe('rejects impossible calendar dates (round-trip check)', () => {
    it('rejects Feb 30', () => {
      const result = validateDate('2024-02-30');
      expect(result.valid).toBe(false);
    });

    it('rejects Feb 29 in non-leap years', () => {
      const result = validateDate('2023-02-29');
      expect(result.valid).toBe(false);
    });

    it('rejects Apr 31', () => {
      const result = validateDate('2026-04-31');
      expect(result.valid).toBe(false);
    });

    it('rejects Jun 31', () => {
      const result = validateDate('2026-06-31');
      expect(result.valid).toBe(false);
    });

    it('rejects Sep 31', () => {
      const result = validateDate('2026-09-31');
      expect(result.valid).toBe(false);
    });

    it('rejects Nov 31', () => {
      const result = validateDate('2026-11-31');
      expect(result.valid).toBe(false);
    });

    it('rejects month 00', () => {
      const result = validateDate('2026-00-15');
      expect(result.valid).toBe(false);
    });

    it('rejects month 13', () => {
      const result = validateDate('2026-13-15');
      expect(result.valid).toBe(false);
    });

    it('rejects day 00', () => {
      const result = validateDate('2026-04-00');
      expect(result.valid).toBe(false);
    });
  });

  describe('accepts valid calendar dates', () => {
    it('accepts Feb 29 in leap years', () => {
      const result = validateDate('2024-02-29');
      expect(result.valid).toBe(true);
      if (result.valid) expect(result.value).toBe('2024-02-29');
    });

    it('accepts Feb 29 in year-2000 leap year', () => {
      const result = validateDate('2000-02-29');
      expect(result.valid).toBe(true);
    });

    it('accepts last day of each 31-day month', () => {
      for (const month of [1, 3, 5, 7, 8, 10, 12]) {
        const mm = String(month).padStart(2, '0');
        const result = validateDate(`2026-${mm}-31`);
        expect(result.valid).toBe(true);
      }
    });

    it('accepts Apr 30', () => {
      const result = validateDate('2026-04-30');
      expect(result.valid).toBe(true);
    });

    it('accepts today-like dates', () => {
      const result = validateDate('2026-04-18');
      expect(result.valid).toBe(true);
      if (result.valid) expect(result.value).toBe('2026-04-18');
    });
  });

  describe('format + boundary', () => {
    it('rejects empty string', () => {
      const result = validateDate('');
      expect(result.valid).toBe(false);
    });

    it('rejects non-YYYY-MM-DD format', () => {
      expect(validateDate('04/18/2026').valid).toBe(false);
      expect(validateDate('2026-4-18').valid).toBe(false);
    });

    it('rejects dates before 1900-01-01', () => {
      const result = validateDate('1899-12-31');
      expect(result.valid).toBe(false);
    });

    it('rejects dates after 2100-12-31', () => {
      const result = validateDate('2101-01-01');
      expect(result.valid).toBe(false);
    });

    it('accepts dates well within the 1900-2100 range', () => {
      expect(validateDate('1950-06-15').valid).toBe(true);
      expect(validateDate('2050-03-10').valid).toBe(true);
    });
  });
});
