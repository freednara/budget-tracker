/**
 * Analytics UI Module
 * 
 * Handles populating the rich analytics modal dashboard with data-driven views and charts.
 * 
 * @module features/analytics/analytics-ui
 */

import * as signals from '../../core/signals.js';
import { html, render, nothing, unsafeSVG, styleMap, type LitTemplate } from '../../core/lit-helpers.js';
import { getDefaultContainer, Services } from '../../core/di-container.js';
import { getCatInfo } from '../../core/categories.js';
import { calculateMonthlyTotalsWithCacheSync } from '../../core/monthly-totals-cache.js';
import { analyzeSeasonalPatterns } from './seasonal-analysis.js';
import { calculateCategoryTrends, getTrendingCategories, analyzeSpendingVelocity } from './trend-analysis.js';
import { 
  getYearStats,
  getAllTimeStats,
  compareYearsMonthly,
  getDetailedYearStats
} from '../financial/calculations.js';
import DOM from '../../core/dom-cache.js';
import { renderTrendChart, renderBarChart } from '../../ui/charts/chart-renderers.js';
import { renderMonthComparison as renderMonthComparisonSection } from '../../ui/charts/analytics-ui.js';
import type {
  Transaction,
  CurrencyFormatter,
  AllTimeStats,
  YearStats
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
    // Fallback if container not initialized
    return (v: number): string => (signals.currency.value.symbol || '$') + Math.abs(v).toFixed(2);
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

  render(html`
    <button
      class="analytics-tab ${analyticsCurrentPeriod === 'all-time' ? 'btn-primary' : 'btn-secondary'} flex-shrink-0 py-2 px-4 rounded-lg text-sm font-bold transition-all"
      data-period="all-time"
    >
      All-Time
    </button>
    ${years.map(year => html`
      <button
        class="analytics-tab ${analyticsCurrentPeriod === year ? 'btn-primary' : 'btn-secondary'} flex-shrink-0 py-2 px-4 rounded-lg text-sm font-bold transition-all"
        data-period="${year}"
      >
        ${year}
      </button>
    `)}
  `, tabsContainer);
}

function syncPeriodScopedSectionChrome(): void {
  const trendTitle = DOM.get('analytics-trend-title');
  const seasonalTitle = DOM.get('analytics-seasonal-title');
  const categoryTitle = DOM.get('analytics-category-title');
  const allTimeSection = DOM.get('analytics-alltime-section');
  const trendPeriodSelect = DOM.get('trend-period-select') as HTMLSelectElement | null;
  const yearScoped = isYearPeriod(analyticsCurrentPeriod);

  if (trendTitle) {
    trendTitle.textContent = yearScoped
      ? `📊 ${analyticsCurrentPeriod} MONTHLY TREND`
      : '📊 RECENT 12-MONTH TREND';
  }

  if (seasonalTitle) {
    seasonalTitle.textContent = yearScoped
      ? `📅 ${analyticsCurrentPeriod} SEASONAL SPENDING PATTERNS`
      : '📅 ALL-TIME SEASONAL SPENDING PATTERNS';
  }

  if (categoryTitle) {
    categoryTitle.textContent = yearScoped
      ? `📈 ${analyticsCurrentPeriod} CATEGORY SPENDING TRENDS`
      : '📈 CATEGORY SPENDING TRENDS';
  }

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

/**
 * Format number in short form (e.g., 1.2k)
 */
function fmtShort(v: number): string {
  const sign = v < 0 ? '-' : '';
  const abs = Math.abs(v);
  const symbol = signals.currency.value.symbol;
  if (abs >= 1000) return sign + symbol + (abs/1000).toFixed(abs >= 10000 ? 0 : 1) + 'k';
  return sign + symbol + (abs % 1 === 0 ? abs : abs.toFixed(0));
}

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
      render(html`<p class="text-center py-4 text-xs" style="color: var(--text-tertiary);">No transaction data yet</p>`, container);
      return;
    }
    render(html`
      <div class="grid grid-cols-3 gap-2">
        <div class="text-center">
          <p class="text-[10px] font-bold uppercase" style="color: var(--text-tertiary);">Total Income</p>
          <p class="text-sm font-black" style="color: var(--color-income);">${fmtCur(allTime.totalIncome)}</p>
        </div>
        <div class="text-center">
          <p class="text-[10px] font-bold uppercase" style="color: var(--text-tertiary);">Total Expenses</p>
          <p class="text-sm font-black" style="color: var(--color-expense);">${fmtCur(allTime.totalExpenses)}</p>
        </div>
        <div class="text-center">
          <p class="text-[10px] font-bold uppercase" style="color: var(--text-tertiary);">Avg/Month</p>
          <p class="text-sm font-black" style="color: var(--text-primary);">${fmtCur(allTime.avgMonthlySpend)}/mo</p>
        </div>
      </div>
    `, container);
    return;
  }

  const stats = getYearStats(analyticsCurrentPeriod);

  if (!stats || (stats.income === 0 && stats.expenses === 0)) {
    render(html`<p class="text-center py-4 text-xs" style="color: var(--text-tertiary);">No data for ${analyticsCurrentPeriod}</p>`, container);
    return;
  }

  render(html`
    <div class="grid grid-cols-3 gap-2">
      <div class="text-center">
        <p class="text-[10px] font-bold uppercase" style="color: var(--text-tertiary);">Income</p>
        <p class="text-sm font-black" style="color: var(--color-income);">${fmtCur(stats.income)}</p>
      </div>
      <div class="text-center">
        <p class="text-[10px] font-bold uppercase" style="color: var(--text-tertiary);">Expenses</p>
        <p class="text-sm font-black" style="color: var(--color-expense);">${fmtCur(stats.expenses)}</p>
      </div>
      <div class="text-center">
        <p class="text-[10px] font-bold uppercase" style="color: var(--text-tertiary);">Average</p>
        <p class="text-sm font-black" style="color: var(--text-primary);">${fmtCur(stats.avgMonthlyExpenses)}/mo</p>
      </div>
    </div>
  `, container);
}

/**
 * Populate the 12-Month Trend Chart (Placeholder for now)
 */
function populateTrendChart(): void {
  const container = DOM.get('analytics-trend-chart');
  if (!container) return;

  if (!isYearPeriod(analyticsCurrentPeriod)) {
    renderTrendChart('analytics-trend-chart', 12);
    return;
  }

  const monthlyStats = getDetailedYearStats(analyticsCurrentPeriod);
  const monthKeys = Object.keys(monthlyStats).sort();

  renderBarChart(
    'analytics-trend-chart',
    monthKeys.map(monthKey => new Date(`${monthKey}-01`).toLocaleDateString('en-US', { month: 'short' })),
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
    ]
  );
}

/**
 * Populate the Year-over-Year Comparison section
 */
function populateYoYSection(): void {
  const container = DOM.get('yoy-comparison-content');
  const year1Select = DOM.get('yoy-year1') as HTMLSelectElement | null;
  const year2Select = DOM.get('yoy-year2') as HTMLSelectElement | null;
  
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
    if (year1Select) {
      year1Select.value = yearOptions.includes(previousYear1) ? previousYear1 : yearOptions[0];
    }
    if (year2Select) {
      const fallbackYear2 = yearOptions.find(year => year !== year1Select?.value) || yearOptions[0];
      year2Select.value = yearOptions.includes(previousYear2) && previousYear2 !== year1Select?.value
        ? previousYear2
        : fallbackYear2;
    }
  } else if (yearOptions.length === 1) {
    if (year1Select) year1Select.value = yearOptions[0];
    if (year2Select) year2Select.value = yearOptions[0];
  }

  const y1 = year1Select?.value || String(new Date().getFullYear());
  const y2 = year2Select?.value || String(new Date().getFullYear() - 1);

  // Render YoY bar chart comparing monthly expenses
  const comparison = compareYearsMonthly(y1, y2);
  const monthLabels = comparison.map(c => c.monthLabel);
  renderBarChart('yoy-comparison-chart', monthLabels, [
    { label: y1, data: comparison.map(c => c.year1.expenses), color: 'var(--color-expense)' },
    { label: y2, data: comparison.map(c => c.year2.expenses), color: 'var(--color-accent)' }
  ]);

  const stats1 = getYearStats(y1);
  const stats2 = getYearStats(y2);
  const diff = stats2.expenses > 0 ? ((stats1.expenses - stats2.expenses) / stats2.expenses * 100) : 0;

  const fmtCur = getFmtCur();

  render(html`
    <div class="flex justify-between items-center text-xs">
      <span class="text-secondary font-bold">${y1} vs ${y2} Total</span>
      <span class="font-black ${diff >= 0 ? 'text-expense' : 'text-income'}">
        ${diff >= 0 ? '+' : ''}${diff.toFixed(1)}%
      </span>
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
    render(html`<p class="text-center py-4 text-xs" style="color: var(--text-tertiary);">No seasonal data for this period</p>`, chartContainer);
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
  const periodSelect = DOM.get('trend-period-select') as HTMLSelectElement | null;

  if (!growingEl || !shrinkingEl || !chartEl) return;

  const months = isYearPeriod(analyticsCurrentPeriod) ? 12 : parseInt(periodSelect?.value || '12', 10);
  const scopedYear = isYearPeriod(analyticsCurrentPeriod) ? analyticsCurrentPeriod : undefined;
  const trends = calculateCategoryTrends(months, scopedYear);
  const trending = getTrendingCategories(3, scopedYear);

  // Render category trends bar chart showing top 8 categories by total spend
  const topTrends = [...trends.trends]
    .sort((a, b) => b.totalSpend - a.totalSpend)
    .slice(0, 8);
  if (topTrends.length > 0) {
    renderBarChart('category-trends-chart',
      topTrends.map(t => t.category?.name || 'Unknown'),
      [{
        label: scopedYear ? `Top Categories (${scopedYear})` : `Top Categories (${months}mo)`,
        data: topTrends.map(t => t.totalSpend || 0),
        color: 'var(--color-accent)'
      }]
    );
  } else {
    render(html`<p class="text-center py-4 text-xs" style="color: var(--text-tertiary);">No category trend data for this period</p>`, chartEl);
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

  const allocations = signals.monthlyAlloc.value[currentMonth] || {};
  const categories = Object.keys(allocations);

  if (categories.length === 0) {
    section.classList.add('hidden');
    return;
  }

  const totals = calculateMonthlyTotalsWithCacheSync(currentMonth);
  const labels = categories.map((categoryId: string) => {
    const info = getCatInfo('expense', categoryId);
    return `${info.emoji} ${info.name.split(' ')[0]}`;
  });
  const budgetValues = categories.map((categoryId: string) => allocations[categoryId]);
  const actualValues = categories.map((categoryId: string) => (totals.categoryTotals || {})[categoryId] || 0);

  section.classList.remove('hidden');
  renderBarChart('budget-actual-chart', labels, [
    { label: 'Budget', data: budgetValues, color: 'var(--color-accent)' },
    { label: 'Actual', data: actualValues, color: 'var(--color-expense)' }
  ]);

  const badge = DOM.get('budget-actual-badge');
  if (badge) {
    badge.innerHTML = `<span class="time-badge">${currentMonth}</span>`;
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
        ${(() => {
          if (!stats.firstDate || !stats.lastDate) return '0';
          const d1 = new Date(stats.firstDate);
          const d2 = new Date(stats.lastDate);
          return (d2.getFullYear() - d1.getFullYear()) * 12 + (d2.getMonth() - d1.getMonth()) + 1;
        })()}
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
function attachAnalyticsEventListeners(): void {
  // Period Tabs
  const tabButtons = DOM.queryAll('.analytics-tab');
  tabButtons.forEach(button => {
    // Remove existing listener to prevent duplicates
    const btn = button as HTMLElement;
    const newBtn = btn.cloneNode(true) as HTMLElement;
    btn.parentNode?.replaceChild(newBtn, btn);
    
    newBtn.addEventListener('click', (e) => {
      const target = e.currentTarget as HTMLButtonElement;
      const period = target.dataset.period;
      if (period) {
        setAnalyticsCurrentPeriod(period);
        renderAnalyticsModal();
      }
    });
  });

  // YoY Selectors
  const y1 = DOM.get('yoy-year1');
  const y2 = DOM.get('yoy-year2');
  [y1, y2].forEach(el => {
    if (el) {
      el.removeEventListener('change', renderAnalyticsModal);
      el.addEventListener('change', renderAnalyticsModal);
    }
  });

  // Trend Period Selector
  const trendPeriod = DOM.get('trend-period-select');
  if (trendPeriod) {
    trendPeriod.removeEventListener('change', renderAnalyticsModal);
    trendPeriod.addEventListener('change', renderAnalyticsModal);
  }
}
