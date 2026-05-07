/**
 * Analytics UI Module
 * 
 * Handles populating the rich analytics modal dashboard with data-driven views and charts.
 * 
 * @module features/analytics/analytics-ui
 */

import * as signals from '../../core/signals.js';
import { getMonthAlloc } from '../../core/month-alloc.js';
import { html, render, nothing } from '../../core/lit-helpers.js';
import { getDefaultContainer, Services } from '../../core/di-container.js';
import { getCatInfo } from '../../core/categories.js';
import { computeBaselineDelta } from '../../core/baseline.js';
// M33 (Phase 5f): `...Sync` suffix dropped — monthly-totals-cache is now sync-only.
import { calculateMonthlyTotalsWithCache } from '../../core/monthly-totals-cache.js';
import { analyzeSeasonalPatterns } from './seasonal-analysis.js';
import { calculateCategoryTrends, getTrendingCategories } from './trend-analysis.js';
import {
  getYearStats,
  getAllTimeStats,
  compareYearsMonthly,
  getDetailedYearStats
} from '../financial/calculations.js';
import DOM from '../../core/dom-cache.js';
import { renderTrendChart, renderBarChart } from '../../ui/charts/chart-renderers.js';
import { renderMonthComparison as renderMonthComparisonSection } from '../../ui/charts/analytics-ui.js';
import { formatMonthShort } from '../../core/locale-service.js';
import { formatCategoryChartLabel } from '../../core/utils-pure.js';
import type {
  CurrencyFormatter
} from '../../../types/index.js';

// ==========================================
// DEPENDENCY INJECTION
// ==========================================

/**
 * Get currency formatter from DI container
 */
function getFmtCur(): CurrencyFormatter {
  try {
    return getDefaultContainer().resolveSync<CurrencyFormatter>(Services.CURRENCY_FORMATTER);
  } catch {
    // CR-Apr24-I finding 89: fallback uses Intl.NumberFormat with the
    // user's currency code so symbol placement, grouping, and decimals
    // respect the locale instead of hardcoding "$" + Math.abs.
    const code = signals.currency.value.home || 'USD';
    const fmt = new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: code,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
    return (v: number): string => fmt.format(v);
  }
}

// ==========================================
// MODULE STATE
// ==========================================

let analyticsCurrentPeriod: string = 'all-time';
function isYearPeriod(period: string): boolean {
  return /^\d{4}$/.test(period);
}

function getAnalyticsYears(): string[] {
  const years = new Set<string>();
  for (const tx of signals.transactions.value) {
    const year = tx.date?.substring(0, 4);
    if (year && /^\d{4}$/.test(year)) years.add(year);
  }
  return Array.from(years).sort((a, b) => parseInt(b, 10) - parseInt(a, 10));
}

function renderAnalyticsPeriodTabs(): void {
  const tabsContainer = DOM.get('analytics-period-tabs');
  if (!tabsContainer) return;

  const years = getAnalyticsYears();
  const hasCurrentPeriod = analyticsCurrentPeriod === 'all-time' || years.includes(analyticsCurrentPeriod);
  if (!hasCurrentPeriod) {
    analyticsCurrentPeriod = years[0] || 'all-time';
  }

  // Design-Review-Apr21 P2 (batch 6 follow-up wave P): the period
  // switcher rendered as a row of plain buttons with visual
  // active/inactive styling (btn-primary vs btn-secondary), but no
  // programmatic selected state. Screen-reader and voice-control
  // users could activate a year but weren't told which period was
  // in effect until they inferred it from downstream chart
  // changes. Added `aria-pressed` on each button (true for the
  // active period, false otherwise) so AT announces pressed/not
  // pressed alongside the label. Labelled the container as a
  // group so the overall affordance is named. `aria-pressed` is a
  // cleaner fit than `role="tablist"` for this mutually-exclusive
  // toggle-button row because the buttons already style as
  // buttons (not tabs) and we don't want to wire tab-role
  // expectations like arrow-key navigation, aria-controls, and
  // tabpanel pairing.
  tabsContainer.setAttribute('role', 'group');
  tabsContainer.setAttribute('aria-label', 'Analytics time period');

  render(html`
    <button
      class="analytics-tab ${analyticsCurrentPeriod === 'all-time' ? 'btn-primary' : 'btn-secondary'} flex-shrink-0 py-2 px-4 rounded-lg text-sm font-bold transition-all"
      data-period="all-time"
      aria-pressed="${analyticsCurrentPeriod === 'all-time' ? 'true' : 'false'}"
    >
      All-Time
    </button>
    ${years.map(year => html`
      <button
        class="analytics-tab ${analyticsCurrentPeriod === year ? 'btn-primary' : 'btn-secondary'} flex-shrink-0 py-2 px-4 rounded-lg text-sm font-bold transition-all"
        data-period="${year}"
        aria-pressed="${analyticsCurrentPeriod === year ? 'true' : 'false'}"
      >
        ${year}
      </button>
    `)}
  `, tabsContainer);
}

/**
 * Pure label-builder for the period-scoped analytics section titles.
 *
 * 7a (Inline-Behavior-Review, Period/scope coherence): extracted from
 * `syncPeriodScopedSectionChrome` so the label logic is testable without
 * DOM stand-in — and so the trend-period-select value threads through the
 * titles consistently. Pre-fix the all-time view hardcoded "RECENT
 * 12-MONTH TREND" regardless of the 3/6/12 selector state; the chart data
 * updated but the heading lied to the user whenever they narrowed the
 * window. This helper is the single source of truth for heading copy; its
 * output is assigned to the DOM by the effectful wrapper below.
 *
 * `rawSelectValue` is the raw string from `<select>.value`. An errant
 * empty string during re-render races falls back to `12` (the shipped
 * default option) rather than poisoning the label with `NaN-MONTH`.
 */
export interface AnalyticsSectionTitles {
  trend: string;
  seasonal: string;
  category: string;
  selectedTrendMonths: number;
}

/**
 * 7a (Inline-Behavior-Review, Period/scope coherence): single source of
 * truth for "what's the active trend window in months?". Used by:
 *   - `buildAnalyticsSectionTitles` (heading copy: "RECENT 6-MONTH TREND")
 *   - `populateTrendChart` (all-time trend chart `monthCount` argument)
 *   - `populateCategoryTrendsSection` (category-trend `months` window)
 *
 * Pre-7a, each call site did its own `parseInt(periodSelect?.value || '12')`
 * — and the trend chart didn't read the selector at all (always rendered
 * 12 months). The section-titles slice exposed the desync: the heading
 * said "RECENT 6-MONTH TREND" while the chart underneath stayed 12 months
 * wide. Routing every consumer through this helper guarantees the
 * heading, the chart's data window, and the category-trend window all
 * agree on the same number for any period/selector combination.
 *
 * Year-scoped periods always resolve to 12 (the year-specific paths
 * render full Jan-Dec from `getDetailedYearStats`, and the selector is
 * disabled in that branch). All-time periods take the selector value;
 * empty / non-numeric / non-positive values fall back to 12 — the shipped
 * default option — so a re-render race or a poisoned DOM doesn't
 * propagate `NaN-MONTH` into headings or `for (let i = NaN; ...)` into
 * chart loops.
 */
export function resolveTrendMonths(period: string, rawSelectValue: string | undefined): number {
  if (isYearPeriod(period)) return 12;
  const parsed = parseInt(rawSelectValue || '12', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 12;
}

export function buildAnalyticsSectionTitles(
  period: string,
  rawSelectValue: string | undefined
): AnalyticsSectionTitles {
  const yearScoped = isYearPeriod(period);
  const selectedTrendMonths = resolveTrendMonths(period, rawSelectValue);

  return {
    trend: yearScoped
      ? `📊 ${period} MONTHLY TREND`
      : `📊 RECENT ${selectedTrendMonths}-MONTH TREND`,
    seasonal: yearScoped
      ? `📅 ${period} SEASONAL SPENDING PATTERNS`
      : '📅 ALL-TIME SEASONAL SPENDING PATTERNS',
    category: yearScoped
      ? `📈 ${period} CATEGORY SPENDING TRENDS`
      : `📈 ${selectedTrendMonths}-MONTH CATEGORY SPENDING TRENDS`,
    selectedTrendMonths
  };
}

function syncPeriodScopedSectionChrome(): void {
  const trendTitle = DOM.get('analytics-trend-title');
  const seasonalTitle = DOM.get('analytics-seasonal-title');
  const categoryTitle = DOM.get('analytics-category-title');
  const allTimeSection = DOM.get('analytics-alltime-section');
  const trendPeriodSelect = DOM.get<HTMLSelectElement>('trend-period-select');
  const yearScoped = isYearPeriod(analyticsCurrentPeriod);

  const titles = buildAnalyticsSectionTitles(analyticsCurrentPeriod, trendPeriodSelect?.value);

  if (trendTitle) trendTitle.textContent = titles.trend;
  if (seasonalTitle) seasonalTitle.textContent = titles.seasonal;
  if (categoryTitle) categoryTitle.textContent = titles.category;

  if (trendPeriodSelect) {
    trendPeriodSelect.disabled = yearScoped;
    trendPeriodSelect.value = yearScoped ? '12' : trendPeriodSelect.value || '12';
    trendPeriodSelect.title = yearScoped ? 'Year view uses the full selected year' : '';
  }

  if (allTimeSection) {
    allTimeSection.style.display = yearScoped ? 'none' : '';
  }
}

/**
 * Get the current analytics period
 */
export function getAnalyticsCurrentPeriod(): string {
  return analyticsCurrentPeriod;
}

/**
 * Set the current analytics period
 */
export function setAnalyticsCurrentPeriod(period: string): void {
  analyticsCurrentPeriod = period;
}

// ==========================================
// HELPER FUNCTIONS
// ==========================================

// ==========================================
// ANALYTICS DASHBOARD POPULATION
// ==========================================

/**
 * Populate the entire analytics modal with data
 * RESTORES the rich "Elite" dashboard feel
 */
export function renderAnalyticsModal(): void {
  const container = DOM.get('analytics-modal');
  if (!container) return;

  // 1. Update period tabs and section chrome
  renderAnalyticsPeriodTabs();
  syncPeriodScopedSectionChrome();

  // 2. Populate Year Summary
  populateYearSummary();

  // 3. Populate 12-Month Trend
  populateTrendChart();

  // 4. Populate Year-over-Year
  populateYoYSection();

  // 5. Populate Seasonal
  populateSeasonalSection();

  // 6. Populate Category Trends
  populateCategoryTrendsSection();

  // 7. Populate moved dashboard detail sections
  populateMovedDashboardSections();

  // 8. Populate All-Time Stats
  populateAllTimeStats();

  // 9. Attach event listeners
  attachAnalyticsEventListeners();
}

function populateMovedDashboardSections(): void {
  renderMonthComparisonSection();
  populateBudgetVsActualSection();
}

/**
 * Populate the Year Summary card
 */
function populateYearSummary(): void {
  const container = DOM.get('year-summary-content');
  if (!container) return;

  const fmtCur = getFmtCur();

  if (analyticsCurrentPeriod === 'all-time') {
    // Show aggregate all-time stats
    const allTime = getAllTimeStats();
    if (!allTime || (allTime.totalIncome === 0 && allTime.totalExpenses === 0)) {
      render(html`<p class="text-center py-4 text-xs text-tertiary">No transaction data yet</p>`, container);
      return;
    }
    render(html`
      <div class="grid grid-cols-3 gap-2">
        <div class="text-center">
          <p class="analytics-stat-label text-tertiary">Total Income</p>
          <p class="text-sm font-black text-income">${fmtCur(allTime.totalIncome)}</p>
        </div>
        <div class="text-center">
          <p class="analytics-stat-label text-tertiary">Total Expenses</p>
          <p class="text-sm font-black text-expense">${fmtCur(allTime.totalExpenses)}</p>
        </div>
        <div class="text-center">
          <p class="analytics-stat-label text-tertiary">Avg/Month</p>
          <p class="text-sm font-black text-primary">${fmtCur(allTime.avgMonthlySpend)}/mo</p>
        </div>
      </div>
    `, container);
    return;
  }

  const stats = getYearStats(analyticsCurrentPeriod);

  if (!stats || (stats.income === 0 && stats.expenses === 0)) {
    render(html`<p class="text-center py-4 text-xs text-tertiary">No data for ${analyticsCurrentPeriod}</p>`, container);
    return;
  }

  render(html`
    <div class="grid grid-cols-3 gap-2">
      <div class="text-center">
        <p class="analytics-stat-label text-tertiary">Income</p>
        <p class="text-sm font-black text-income">${fmtCur(stats.income)}</p>
      </div>
      <div class="text-center">
        <p class="analytics-stat-label text-tertiary">Expenses</p>
        <p class="text-sm font-black text-expense">${fmtCur(stats.expenses)}</p>
      </div>
      <div class="text-center">
        <p class="analytics-stat-label text-tertiary">Average</p>
        <p class="text-sm font-black text-primary">${fmtCur(stats.avgMonthlyExpenses)}/mo</p>
      </div>
    </div>
  `, container);
}

/**
 * Populate the all-time / year-scoped Trend Chart at the top of the
 * analytics modal.
 *
 * Exported for 7a regression coverage (Inline-Behavior-Review,
 * Period/scope coherence): the all-time branch must thread the
 * trend-period selector value through to `renderTrendChart`'s
 * `monthCount` argument so the chart agrees with the section heading.
 */
export function populateTrendChart(): void {
  const container = DOM.get('analytics-trend-chart');
  if (!container) return;

  if (!isYearPeriod(analyticsCurrentPeriod)) {
    // 7a (Inline-Behavior-Review, Period/scope coherence): thread the
    // trend-period selector value into the chart's `monthCount` so the
    // chart agrees with the section heading. Pre-7a this was hardcoded
    // `12` and only the heading reflected the 3/6/12 selector — the
    // user could see "RECENT 6-MONTH TREND" with a 12-month chart
    // underneath. `resolveTrendMonths` is the shared helper that keeps
    // heading + chart + category-trends window in agreement.
    const trendPeriodSelect = DOM.get<HTMLSelectElement>('trend-period-select');
    const months = resolveTrendMonths(analyticsCurrentPeriod, trendPeriodSelect?.value);
    // REND-04: catch async errors from trend chart render
    void renderTrendChart('analytics-trend-chart', months).catch((e) => { if (import.meta.env.DEV) console.error('[analytics] trend chart render failed:', e); });
    return;
  }

  const monthlyStats = getDetailedYearStats(analyticsCurrentPeriod);
  const monthKeys = Object.keys(monthlyStats).sort();

  // CR-Apr22-C slice 1 [P2]: pass year-trend-specific accessible metadata;
  // `renderBarChart` defaults to the budget-vs-actual copy, which is
  // wrong for this context.
  renderBarChart(
    'analytics-trend-chart',
    // Route through canonical helper so year-trend axis labels respect
    // the app's configured locale (was hardcoded 'en-US').
    monthKeys.map(monthKey => formatMonthShort(monthKey)),
    [
      {
        label: `${analyticsCurrentPeriod} Income`,
        data: monthKeys.map(monthKey => monthlyStats[monthKey]?.income || 0),
        color: 'var(--color-income)'
      },
      {
        label: `${analyticsCurrentPeriod} Expenses`,
        data: monthKeys.map(monthKey => monthlyStats[monthKey]?.expenses || 0),
        color: 'var(--color-expense)'
      }
    ],
    {
      ariaLabel: `Monthly income and expenses for ${analyticsCurrentPeriod}`,
      title: `${analyticsCurrentPeriod} Year Trend`,
      desc: `Bar chart showing monthly income and expenses across ${monthKeys.length} months of ${analyticsCurrentPeriod}`
    }
  );
}

/**
 * Populate the Year-over-Year Comparison section
 *
 * Exported for 7a regression coverage (Inline-Behavior-Review,
 * Period/scope coherence): the single-year-corpus branch must early-return
 * instead of inviting `compareYearsMonthly(soleYear, soleYear)` to render a
 * degenerate "year vs itself" view under the availability hint. Keeping it
 * exported lets `tests/analytics-yoy-single-year.test.ts` drive it directly
 * without spinning up the whole analytics modal.
 */
export function populateYoYSection(): void {
  const container = DOM.get('yoy-comparison-content');
  const year1Select = DOM.get<HTMLSelectElement>('yoy-year1');
  const year2Select = DOM.get<HTMLSelectElement>('yoy-year2');
  
  if (!container) return;

  const transactions = signals.transactions.value;
  // Single-pass year extraction to avoid intermediate array allocations
  const yearsSet = new Set<number>();
  for (const t of transactions) {
    const y = parseInt(t.date?.substring(0, 4) || '0', 10);
    if (y > 0) yearsSet.add(y);
  }
  const years = Array.from(yearsSet).sort((a, b) => b - a);
  const previousYear1 = year1Select?.value || '';
  const previousYear2 = year2Select?.value || '';

  const yearOptions = years.map(String);
  if (year1Select) {
    year1Select.replaceChildren();
    yearOptions.forEach(year => {
      const opt = document.createElement('option');
      opt.value = year;
      opt.textContent = year;
      year1Select.appendChild(opt);
    });
  }
  if (year2Select) {
    year2Select.replaceChildren();
    yearOptions.forEach(year => {
      const opt = document.createElement('option');
      opt.value = year;
      opt.textContent = year;
      year2Select.appendChild(opt);
    });
  }

  if (yearOptions.length >= 2) {
    // Phase 6 Slice 1i (rev 12 L6): `yearOptions[0]` is now
    // `string | undefined` under `noUncheckedIndexedAccess`. The
    // length check above guarantees presence; `?? ''` keeps the
    // select value a concrete string in every branch.
    const firstYear = yearOptions[0] ?? '';
    if (year1Select) {
      year1Select.value = yearOptions.includes(previousYear1) ? previousYear1 : firstYear;
    }
    if (year2Select) {
      const fallbackYear2 = yearOptions.find(year => year !== year1Select?.value) ?? firstYear;
      year2Select.value = yearOptions.includes(previousYear2) && previousYear2 !== year1Select?.value
        ? previousYear2
        : fallbackYear2;
    }
  } else if (yearOptions.length === 1) {
    const soleYear = yearOptions[0] ?? '';
    if (year1Select) year1Select.value = soleYear;
    if (year2Select) year2Select.value = soleYear;
  }

  // 7a (Inline-Behavior-Review, Period/scope coherence): when only one
  // year of data exists, YoY comparison is **disabled** — not degraded.
  //
  // Pre-fix: `compareYearsMonthly(soleYear, soleYear)` ran with both
  // selectors forced to the same year, `getYearStats(y1)` / `getYearStats(y2)`
  // were identical, and the chart / chip rendered a "year vs itself" view
  // with every bar pair identical and a `+0.0%` delta. The hint copy
  // ("Add transactions in a second year…") displayed alongside, so the
  // user saw BOTH a degenerate comparison AND a message explaining why
  // it was unavailable. Contradictory and misleading.
  //
  // Fix: render the hint, clear the chart + stats surfaces, disable the
  // year selectors (they have no meaningful action in the single-year
  // case), and early-return. The section wrapper stays visible so the
  // hint is legible; the chart / chip / avg-monthly line are gone rather
  // than misleading. Selectors re-enable automatically on the next
  // render once a second year of data exists (the enable-branch runs
  // unconditionally in the `length >= 2` path below).
  if (yearOptions.length < 2 && container) {
    const hint = container.querySelector('.yoy-hint') || document.createElement('p');
    hint.className = 'yoy-hint text-xs text-tertiary italic py-2';
    hint.textContent = 'Add transactions in a second year to unlock year-over-year comparison.';
    if (!container.querySelector('.yoy-hint')) container.prepend(hint);

    // Clear the chart + chip area so no stale bars / deltas linger
    // across corpus changes. The hint stays prepended on `container`;
    // clearing via `render(nothing, ...)` removes all lit-html nodes
    // OUTSIDE the prepended hint element because lit-html's root is a
    // part-tree it owns, not the entire container — the hint we
    // manually `prepend`-ed is sibling to the lit-html root.
    const chartEl = DOM.get('yoy-comparison-chart');
    if (chartEl) render(nothing, chartEl);
    // Remove the stats/chip block (everything except the hint).
    Array.from(container.childNodes).forEach(node => {
      if (node instanceof Element && !node.classList.contains('yoy-hint')) {
        node.remove();
      }
    });

    if (year1Select) year1Select.disabled = true;
    if (year2Select) year2Select.disabled = true;
    return;
  }

  // Two+ years available — full YoY render. Clear any prior hint and
  // re-enable the selectors (covers the case where the user added a
  // second year during the session).
  container?.querySelector('.yoy-hint')?.remove();
  if (year1Select) year1Select.disabled = false;
  if (year2Select) year2Select.disabled = false;

  const y1 = year1Select?.value || String(new Date().getFullYear());
  const y2 = year2Select?.value || String(new Date().getFullYear() - 1);

  // Render YoY bar chart comparing monthly expenses
  const comparison = compareYearsMonthly(y1, y2);
  const monthLabels = comparison.map(c => c.monthLabel);
  // CR-Apr22-C slice 1 [P2]: YoY-specific accessible metadata.
  renderBarChart(
    'yoy-comparison-chart',
    monthLabels,
    [
      { label: y1, data: comparison.map(c => c.year1.expenses), color: 'var(--color-expense)' },
      { label: y2, data: comparison.map(c => c.year2.expenses), color: 'var(--color-accent)' }
    ],
    {
      ariaLabel: `Year-over-year expense comparison: ${y1} versus ${y2}`,
      title: `YoY Comparison: ${y1} vs ${y2}`,
      desc: `Bar chart comparing monthly expenses for ${y1} and ${y2} across ${monthLabels.length} months`
    }
  );

  const stats1 = getYearStats(y1);
  const stats2 = getYearStats(y2);

  // Design-Review-Apr21 batch 7 (7a): YoY expense comparison used to
  // fabricate "+0.0%" when the baseline year had no recorded expenses, which
  // was indistinguishable from a year that truly held flat. Routing through
  // `computeBaselineDelta` surfaces the three cases explicitly:
  //   - comparable → signed percent (e.g. "+12.3%", "-4.7%")
  //   - new        → "New" (prior year empty but current year has spend)
  //   - no-data    → "—" (both years empty; YoY is meaningless)
  const yoyDelta = computeBaselineDelta(stats1.expenses, stats2.expenses);

  const fmtCur = getFmtCur();

  // Build the YoY chip template based on the classified status so the copy
  // never misleads the user with a fabricated percent.
  let yoyChip;
  if (yoyDelta.status === 'no-data') {
    yoyChip = html`<span class="font-black text-tertiary">—</span>`;
  } else if (yoyDelta.status === 'new') {
    yoyChip = html`<span class="font-black text-tertiary">New</span>`;
  } else {
    const pct = yoyDelta.percent ?? 0;
    const cls = pct >= 0 ? 'text-expense' : 'text-income';
    const sign = pct >= 0 ? '+' : '';
    yoyChip = html`<span class="font-black ${cls}">${sign}${pct.toFixed(1)}%</span>`;
  }

  render(html`
    <div class="flex justify-between items-center text-xs">
      <span class="text-secondary font-bold">${y1} vs ${y2} Total</span>
      ${yoyChip}
    </div>
    <div class="text-[10px] text-tertiary italic">
      Avg monthly: ${fmtCur(stats1.avgMonthlyExpenses)} (${y1}) vs ${fmtCur(stats2.avgMonthlyExpenses)} (${y2})
    </div>
  `, container);
}

/**
 * Populate the Seasonal Patterns section
 */
function populateSeasonalSection(): void {
  const chartContainer = DOM.get('seasonal-pattern-chart');
  const insightsContainer = DOM.get('seasonal-insights');
  
  if (!chartContainer || !insightsContainer) return;

  const seasonalData = analyzeSeasonalPatterns(analyticsCurrentPeriod);
  const fmtCur = getFmtCur();

  if (seasonalData.patterns.every(pattern => pattern.transactionCount === 0)) {
    render(html`<p class="text-center py-4 text-xs text-tertiary">No seasonal data for this period</p>`, chartContainer);
    render(html`<p class="text-[10px] text-tertiary">Add more spending history to unlock seasonal patterns.</p>`, insightsContainer);
    return;
  }

  // Populate insights
  render(html`
    ${seasonalData.insights.map(insight => html`
      <div class="flex items-start gap-2 p-2 rounded bg-black/10">
        <span class="text-sm">💡</span>
        <div class="flex-1">
          <p class="text-[11px] font-bold text-primary leading-tight">${insight.message}</p>
          <p class="text-[10px] text-tertiary mt-0.5">Amount: ${fmtCur(insight.amount)}</p>
        </div>
      </div>
    `)}
  `, insightsContainer);

  // Populate simple seasonal breakdown
  render(html`
    <div class="grid grid-cols-2 gap-2 mt-2">
      ${seasonalData.patterns.map(p => html`
        <div class="p-2 rounded bg-black/5 border border-white/5">
          <p class="text-[10px] font-bold uppercase text-tertiary">${p.season}</p>
          <p class="text-xs font-black text-primary">${fmtCur(p.totalSpent)}</p>
          <p class="text-[9px] text-tertiary italic">${p.transactionCount} txs</p>
        </div>
      `)}
    </div>
  `, chartContainer);
}

/**
 * Populate the Category Trends section
 */
function populateCategoryTrendsSection(): void {
  const growingEl = DOM.get('growing-categories');
  const shrinkingEl = DOM.get('shrinking-categories');
  const chartEl = DOM.get('category-trends-chart');
  const periodSelect = DOM.get<HTMLSelectElement>('trend-period-select');

  if (!growingEl || !shrinkingEl || !chartEl) return;

  // 7a (Inline-Behavior-Review, Period/scope coherence): route through
  // `resolveTrendMonths` instead of inline `parseInt(... || '12', 10)`.
  // The shared helper guards against the NaN-on-poisoned-DOM case the
  // bare parseInt didn't, and keeps this window in lock-step with the
  // section heading + the 12-month trend chart at the top of the modal.
  const months = resolveTrendMonths(analyticsCurrentPeriod, periodSelect?.value);
  const scopedYear = isYearPeriod(analyticsCurrentPeriod) ? analyticsCurrentPeriod : undefined;
  const trends = calculateCategoryTrends(months, scopedYear);
  const trending = getTrendingCategories(3, scopedYear);

  // Render category trends bar chart showing top 8 categories by total spend
  const topTrends = [...trends.trends]
    .sort((a, b) => b.totalSpend - a.totalSpend)
    .slice(0, 8);
  if (topTrends.length > 0) {
    // CR-Apr22-C slice 1 [P2]: category-trends-specific accessible metadata
    // describes top-N spending by category across the selected period.
    const scopeCopy = scopedYear ? `${scopedYear}` : `last ${months} months`;
    renderBarChart(
      'category-trends-chart',
      topTrends.map(t => t.category?.name || 'Unknown'),
      [{
        label: scopedYear ? `Top Categories (${scopedYear})` : `Top Categories (${months}mo)`,
        data: topTrends.map(t => t.totalSpend || 0),
        color: 'var(--color-accent)'
      }],
      {
        ariaLabel: `Top spending categories for ${scopeCopy}`,
        title: `Top Categories: ${scopeCopy}`,
        desc: `Bar chart showing the ${topTrends.length} highest-spending categories over ${scopeCopy}, sorted by total spend`
      }
    );
  } else {
    render(html`<p class="text-center py-4 text-xs text-tertiary">No category trend data for this period</p>`, chartEl);
  }

  render(html`
    ${trending.increasing.map(t => html`
      <div class="flex justify-between items-center text-[11px]">
        <span class="text-primary truncate mr-1">${t.category.emoji} ${t.category.name}</span>
        <span class="text-expense font-bold">+${t.percentageChange.toFixed(0)}%</span>
      </div>
    `)}
    ${trending.increasing.length === 0 ? html`<p class="text-[10px] text-tertiary">None detected</p>` : nothing}
  `, growingEl);

  render(html`
    ${trending.decreasing.map(t => html`
      <div class="flex justify-between items-center text-[11px]">
        <span class="text-primary truncate mr-1">${t.category.emoji} ${t.category.name}</span>
        <span class="text-income font-bold">${t.percentageChange.toFixed(0)}%</span>
      </div>
    `)}
    ${trending.decreasing.length === 0 ? html`<p class="text-[10px] text-tertiary">None detected</p>` : nothing}
  `, shrinkingEl);
}

function populateBudgetVsActualSection(): void {
  const currentMonth = signals.currentMonth.value;
  const section = DOM.get('budget-vs-actual-section');
  if (!(section instanceof HTMLElement)) return;

  // Rev 12 / #39 M4 (Inline-Behavior-Review): getMonthAlloc replaces the
  // legacy `signals.monthlyAlloc.value[mk] || {}` pattern — emits a
  // once-per-session trackError on a genuine miss (map non-empty but the
  // requested month is missing), which is the data-loss signal the review
  // targets. Shape is identical on the hit path.
  const allocations = getMonthAlloc(currentMonth, signals.monthlyAlloc.value);
  const categories = Object.keys(allocations);

  if (categories.length === 0) {
    section.classList.add('hidden');
    return;
  }

  const totals = calculateMonthlyTotalsWithCache(currentMonth);
  // CR-Apr22-D slice 5 (finding 63): shared fix with the dashboard BvA
  // chart at `ui-render.ts:updateBudgetVsActualChart`. The legacy
  // `info.name.split(' ')[0]` label collapsed multi-word names sharing
  // a first token into one indistinguishable label. Route through the
  // shared `formatCategoryChartLabel` helper so analytics + dashboard
  // speak the same x-axis vocabulary and so future label-strategy
  // tweaks (max-char budget, ellipsis char, trimming rules) land once.
  const labels = categories.map((categoryId: string) => {
    const info = getCatInfo('expense', categoryId);
    return formatCategoryChartLabel(info);
  });
  // Phase 6 Slice 1i (rev 12 L6): `allocations[categoryId]` is
  // `number | undefined` under `noUncheckedIndexedAccess` — render
  // missing allocations as 0 so the budget bar simply zeros out.
  const budgetValues = categories.map((categoryId: string) => allocations[categoryId] ?? 0);
  const actualValues = categories.map((categoryId: string) => (totals.categoryTotals || {})[categoryId] || 0);

  section.classList.remove('hidden');
  renderBarChart('budget-actual-chart', labels, [
    { label: 'Budget', data: budgetValues, color: 'var(--color-accent)' },
    { label: 'Actual', data: actualValues, color: 'var(--color-expense)' }
  ]);

  const badge = DOM.get('budget-actual-badge');
  if (badge) {
    render(html`<span class="time-badge">${currentMonth}</span>`, badge);
  }
}

/**
 * Populate the All-Time Stats section
 */
function populateAllTimeStats(): void {
  const container = DOM.get('alltime-stats-content');
  if (!container) return;

  const stats = getAllTimeStats();
  const fmtCur = getFmtCur();

  if (!stats) return;

  render(html`
    <div class="flex justify-between py-1 border-b border-white/5">
      <span class="text-[11px] text-secondary font-bold uppercase">Net Savings</span>
      <span class="text-sm font-black ${stats.netSavings >= 0 ? 'text-income' : 'text-expense'}">${fmtCur(stats.netSavings)}</span>
    </div>
    <div class="flex justify-between py-1 border-b border-white/5">
      <span class="text-[11px] text-secondary font-bold uppercase">Total Income</span>
      <span class="text-xs font-bold text-income">${fmtCur(stats.totalIncome)}</span>
    </div>
    <div class="flex justify-between py-1 border-b border-white/5">
      <span class="text-[11px] text-secondary font-bold uppercase">Total Expenses</span>
      <span class="text-xs font-bold text-expense">${fmtCur(stats.totalExpenses)}</span>
    </div>
    <div class="flex justify-between py-1">
      <span class="text-[11px] text-secondary font-bold uppercase">Months Tracked</span>
      <span class="text-xs font-bold text-primary">
        ${/* 7a (Inline-Behavior-Review, Period/scope coherence): consume
             the canonical `monthsTracked` from `getAllTimeStats` rather
             than recomputing from firstDate/lastDate. The inline version
             (a) duplicated span math, (b) used a narrower `lastDate`
             endpoint that didn't extend to the current month — so a user
             who hadn't logged anything for 3 months would see the count
             frozen at their last-logged month — and (c) could silently
             diverge from the denominator behind the "Avg/Month"
             readouts in the same section. Using `stats.monthsTracked`
             keeps the display and the divisor in lockstep. */ ''}
        ${stats.monthsTracked}
      </span>
    </div>
  `, container);
}

// ==========================================
// EVENT HANDLING
// ==========================================

/**
 * Attach event listeners for analytics modal
 */
/** Single delegated handler for period-tab clicks (attached once) */
let tabsDelegateAttached = false;

/**
 * 7a (Inline-Behavior-Review, Period/scope coherence): scoped re-render
 * for YoY selector changes. Pre-7a, both YoY year selectors fired the
 * full `renderAnalyticsModal()` on every `change` event — re-running all
 * 8 sections (period tabs, year summary, trend chart, YoY, seasonal,
 * category trends, moved-dashboard sections, all-time stats) and
 * re-attaching every listener under the bottom of the modal. The user's
 * single "swap the comparison year" action triggered a full SVG re-paint
 * across every chart in the modal. Routing the `change` event to
 * `populateYoYSection()` only matches the surface the user actually
 * interacted with.
 *
 * Function declarations are at module scope (rather than inline closures
 * inside `attachAnalyticsEventListeners`) so `removeEventListener` reaches
 * the same reference as `addEventListener` — listener-attachment is
 * idempotent across modal re-opens.
 */
function handleYoYChange(): void {
  populateYoYSection();
}

/**
 * 7a (Inline-Behavior-Review, Period/scope coherence): scoped re-render
 * for trend-period selector changes. Pre-7a, this also fired the full
 * `renderAnalyticsModal()`. The selector only affects three surfaces:
 * the section heading copy (via `syncPeriodScopedSectionChrome`), the
 * top trend chart's `monthCount`, and the category-trends window — all
 * three flow through the shared `resolveTrendMonths` helper, so calling
 * the three populate fns in sequence keeps them in lock-step without
 * dragging the rest of the modal along.
 */
function handleTrendPeriodChange(): void {
  syncPeriodScopedSectionChrome();
  populateTrendChart();
  populateCategoryTrendsSection();
}

/**
 * CR-Apr24-I finding 71: refresh all analytics content if the modal is
 * currently visible. External callers (multi-tab sync, currency change,
 * category rename, budget update) can call this after mutating data to
 * keep the analytics modal in sync without needing their own targeted
 * population calls. No-ops cheaply when the modal is closed.
 */
export function refreshAnalyticsIfOpen(): void {
  const modal = DOM.get('analytics-modal');
  if (!modal || !modal.classList.contains('active')) return;
  renderAnalyticsModal();
}

function attachAnalyticsEventListeners(): void {
  // Period Tabs — use event delegation on the container so handlers
  // survive lit re-renders without cloneNode hacks
  const tabsContainer = DOM.get('analytics-period-tabs');
  if (tabsContainer && !tabsDelegateAttached) {
    tabsContainer.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('.analytics-tab');
      if (!btn) return;
      const period = btn.dataset.period;
      if (period) {
        setAnalyticsCurrentPeriod(period);
        renderAnalyticsModal();
      }
    });
    tabsDelegateAttached = true;
  }

  // YoY Selectors — scoped re-render (7a)
  const y1 = DOM.get('yoy-year1');
  const y2 = DOM.get('yoy-year2');
  [y1, y2].forEach(el => {
    if (el) {
      el.removeEventListener('change', handleYoYChange);
      el.addEventListener('change', handleYoYChange);
    }
  });

  // Trend Period Selector — scoped re-render (7a)
  const trendPeriod = DOM.get('trend-period-select');
  if (trendPeriod) {
    trendPeriod.removeEventListener('change', handleTrendPeriodChange);
    trendPeriod.addEventListener('change', handleTrendPeriodChange);
  }
}
