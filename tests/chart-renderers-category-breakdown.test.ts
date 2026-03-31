import { describe, expect, it } from 'vitest';

import { getDashboardCategoryBreakdownStatus } from '../js/modules/ui/charts/chart-renderers.js';
import type { CategoryTrendChange } from '../js/types/index.js';

describe('dashboard category breakdown status cues', () => {
  const trend = (direction: CategoryTrendChange['direction'], change: number): CategoryTrendChange => ({
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
    expect(getDashboardCategoryBreakdownStatus(18, trend('new', 100))).toBeNull();
  });
});
