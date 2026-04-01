import { describe, expect, it } from 'vitest';
import { getEmptyCalendarActionDate } from '../js/modules/ui/widgets/calendar.js';

describe('calendar empty-state action date', () => {
  it('preserves a valid selected day in the viewed month', () => {
    expect(getEmptyCalendarActionDate('2026-03', 31)).toBe('2026-03-31');
  });

  it('falls back to the first day when the selected day is invalid for the month', () => {
    expect(getEmptyCalendarActionDate('2026-04', 31)).toBe('2026-04-01');
  });

  it('falls back to the first day when there is no selected day', () => {
    expect(getEmptyCalendarActionDate('2026-04', null)).toBe('2026-04-01');
  });
});
