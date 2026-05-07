/**
 * Analytics Section Titles — Period/Scope Coherence
 *
 * Regression tests for 7a (Inline-Behavior-Review): the analytics-modal
 * section headings (trend / seasonal / category) must reflect the current
 * period AND the trend-period-select state consistently.
 *
 * Pre-fix the all-time view hardcoded "RECENT 12-MONTH TREND" regardless of
 * whether the user had narrowed the 3 / 6 / 12 selector — the chart
 * underneath updated, but the heading lied. This test locks in the
 * thread-through: heading, subtitle and chart all read the same period.
 *
 * The `buildAnalyticsSectionTitles` helper was extracted from
 * `syncPeriodScopedSectionChrome` for exactly this kind of surgical test —
 * no DOM setup, no signal wiring, no modal rendering.
 */
import { describe, expect, it, vi } from 'vitest';

// The analytics-ui module transitively imports many DOM/signal/chart
// modules, but the extracted `buildAnalyticsSectionTitles` helper is pure.
// We only need to stub the side-effect-heavy transitive imports so the
// module loads cleanly in jsdom; once loaded, the helper runs without
// touching any of them.
vi.mock('../js/modules/core/signals.js', () => ({
  transactions: { value: [] },
  transactionsByMonth: { value: new Map() },
}));

vi.mock('../js/modules/core/dom-cache.js', () => ({
  __esModule: true,
  default: { get: () => null, clearAll: () => {} },
}));

vi.mock('../js/modules/ui/charts/chart-renderers.js', () => ({
  renderBarChart: vi.fn(),
  renderLineChart: vi.fn(),
  renderPieChart: vi.fn(),
  renderStackedBarChart: vi.fn(),
  renderSparkline: vi.fn(),
  renderTrendIndicator: vi.fn(),
  renderProgressRing: vi.fn(),
  renderDonut: vi.fn(),
  renderHeatmap: vi.fn(),
}));

vi.mock('../js/modules/core/event-bus.js', () => ({
  on: vi.fn(),
  emit: vi.fn(),
  createListenerGroup: vi.fn(() => 'mock-group'),
  destroyListenerGroup: vi.fn(),
}));

import { buildAnalyticsSectionTitles } from '../js/modules/features/analytics/analytics-ui.js';

describe('buildAnalyticsSectionTitles (7a period/scope coherence)', () => {
  it('year-scoped: titles use the year tag, selector falls through to 12', () => {
    const titles = buildAnalyticsSectionTitles('2025', '6');
    expect(titles.trend).toBe('📊 2025 MONTHLY TREND');
    expect(titles.seasonal).toBe('📅 2025 SEASONAL SPENDING PATTERNS');
    expect(titles.category).toBe('📈 2025 CATEGORY SPENDING TRENDS');
    // Year view ignores the selector value (the select is disabled in
    // that branch); selectedTrendMonths falls through to 12 so any
    // incidental consumer gets a stable number.
    expect(titles.selectedTrendMonths).toBe(12);
  });

  it('all-time + 12-month selector: preserves the pre-fix "RECENT 12-MONTH TREND" copy', () => {
    const titles = buildAnalyticsSectionTitles('all-time', '12');
    expect(titles.trend).toBe('📊 RECENT 12-MONTH TREND');
    expect(titles.category).toBe('📈 12-MONTH CATEGORY SPENDING TRENDS');
    expect(titles.selectedTrendMonths).toBe(12);
  });

  it('all-time + 6-month selector: heading reads "6-MONTH" (was stuck at "12-MONTH" pre-fix)', () => {
    const titles = buildAnalyticsSectionTitles('all-time', '6');
    expect(titles.trend).toBe('📊 RECENT 6-MONTH TREND');
    expect(titles.category).toBe('📈 6-MONTH CATEGORY SPENDING TRENDS');
    expect(titles.selectedTrendMonths).toBe(6);
  });

  it('all-time + 3-month selector: heading reads "3-MONTH" (was stuck at "12-MONTH" pre-fix)', () => {
    const titles = buildAnalyticsSectionTitles('all-time', '3');
    expect(titles.trend).toBe('📊 RECENT 3-MONTH TREND');
    expect(titles.category).toBe('📈 3-MONTH CATEGORY SPENDING TRENDS');
    expect(titles.selectedTrendMonths).toBe(3);
  });

  it('all-time + missing/empty selector value: falls back to 12 rather than "NaN-MONTH"', () => {
    // Simulates a race where the select has been removed/re-rendered and
    // `.value` is empty. Must not produce "NaN-MONTH TREND" in the label.
    const titlesEmpty = buildAnalyticsSectionTitles('all-time', '');
    expect(titlesEmpty.trend).toBe('📊 RECENT 12-MONTH TREND');
    expect(titlesEmpty.selectedTrendMonths).toBe(12);

    const titlesUndef = buildAnalyticsSectionTitles('all-time', undefined);
    expect(titlesUndef.trend).toBe('📊 RECENT 12-MONTH TREND');
    expect(titlesUndef.selectedTrendMonths).toBe(12);
  });

  it('all-time + non-numeric selector value: falls back to 12 rather than crashing', () => {
    const titles = buildAnalyticsSectionTitles('all-time', 'abc');
    expect(titles.trend).toBe('📊 RECENT 12-MONTH TREND');
    expect(titles.selectedTrendMonths).toBe(12);
  });

  it('seasonal title is period-qualified for year view, fixed copy for all-time', () => {
    // Seasonal uses the full tracked range by design, so the title isn't
    // period-numeric; just confirms the branch.
    expect(buildAnalyticsSectionTitles('2024', '12').seasonal).toBe('📅 2024 SEASONAL SPENDING PATTERNS');
    expect(buildAnalyticsSectionTitles('all-time', '6').seasonal).toBe('📅 ALL-TIME SEASONAL SPENDING PATTERNS');
  });
});
