/**
 * Analytics Module
 *
 * Analytics rendering, trend charts, year comparisons, and seasonal patterns.
 * Handles all analytics modal views and chart generation.
 *
 * @module analytics
 */
'use strict';

import * as signals from './core/signals.js';
import { parseLocalDate, getMonthKey, getPrevMonthKey, toCents } from './core/utils.js';
import { html, render, nothing, unsafeSVG, styleMap, type LitTemplate } from './core/lit-helpers.js';
import { getCatInfo } from './core/categories.js';
import {
  getMonthTx,
  getYearStats,
  getAllTimeStats,
  getMonthExpByCat,
  formatMonthDisplay,
  compareYearsMonthly
} from './features/financial/calculations.js';
import DOM from './core/dom-cache.js';
import type {
  Transaction,
  CurrencyFormatter,
  CategoryChild,
  SeasonalPattern,
  SeasonalInsight,
  SeasonalPatternData,
  CategoryMonthData,
  CategoryTrendData,
  CategoryTrendsResult,
  TrendingCategoriesResult,
  CategoryTrendChange,
  AllTimeStats,
  YearStats
} from '../types/index.js';

// ==========================================
// CALLBACKS (set by app.js to avoid circular deps)
// ==========================================

// Callback for currency formatting
let fmtCurFn: CurrencyFormatter = (v: number): string => '$' + Math.abs(v).toFixed(2);

/**
 * Set the currency formatting function
 */
export function setAnalyticsFmtCurFn(fn: CurrencyFormatter): void {
  fmtCurFn = fn;
}

// ==========================================
// MODULE STATE
// ==========================================

let analyticsCurrentPeriod: string = 'all-time';

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
// SEASONAL PATTERN ANALYSIS
// ==========================================

/**
 * Generate insights from seasonal patterns
 */
function generateSeasonalInsights(patterns: SeasonalPattern[], _yearlyAvg: number): SeasonalInsight[] {
  const insights: SeasonalInsight[] = [];
  patterns.forEach(p => {
    if (p.deviationPct >= 30) {
      insights.push({ type: 'high', month: p.monthLabel, message: `${p.monthLabel} spending is typically ${p.deviationPct}% higher than average` });
    } else if (p.deviationPct <= -20) {
      insights.push({ type: 'low', month: p.monthLabel, message: `${p.monthLabel} spending is typically ${Math.abs(p.deviationPct)}% lower than average` });
    }
  });
  return insights;
}

/**
 * Get seasonal spending patterns across all months
 */
export function getSeasonalPatterns(): SeasonalPatternData | null {
  const allTx = (signals.transactions.value as Transaction[]).filter(tx => tx.date && tx.type === 'expense');
  if (allTx.length === 0) return null;

  const monthlyData: Record<number, { yearMonth: string; total: number }[]> = {};
  for (let m = 1; m <= 12; m++) monthlyData[m] = [];

  allTx.forEach(tx => {
    const date = parseLocalDate(tx.date);
    const month = date.getMonth() + 1;
    const yearMonth = getMonthKey(tx.date);
    const amount = parseFloat(String(tx.amount)) || 0;
    const existingIdx = monthlyData[month].findIndex(d => d.yearMonth === yearMonth);
    if (existingIdx >= 0) {
      monthlyData[month][existingIdx].total += amount;
    } else {
      monthlyData[month].push({ yearMonth, total: amount });
    }
  });

  const patterns: SeasonalPattern[] = [];
  let yearlyAvg = 0, totalMonths = 0;

  for (let m = 1; m <= 12; m++) {
    const data = monthlyData[m];
    if (data.length === 0) continue;
    const avg = data.reduce((s, d) => s + d.total, 0) / data.length;
    const min = Math.min(...data.map(d => d.total));
    const max = Math.max(...data.map(d => d.total));
    yearlyAvg += avg;
    totalMonths++;
    patterns.push({
      month: m,
      monthLabel: new Date(2000, m - 1, 1).toLocaleDateString('en-US', { month: 'long' }),
      monthShort: new Date(2000, m - 1, 1).toLocaleDateString('en-US', { month: 'short' }),
      average: avg,
      min,
      max,
      dataPoints: data.length,
      variance: data.length > 1 ? Math.sqrt(data.reduce((s, d) => s + Math.pow(d.total - avg, 2), 0) / data.length) : 0,
      deviationPct: 0 // Will be calculated below
    });
  }

  yearlyAvg = totalMonths > 0 ? yearlyAvg / totalMonths : 0;
  patterns.forEach(p => {
    p.deviationPct = yearlyAvg > 0 ? Math.round(((p.average - yearlyAvg) / yearlyAvg) * 100) : 0;
  });

  const sortedBySpend = [...patterns].sort((a, b) => b.average - a.average);
  return {
    patterns,
    yearlyAverage: yearlyAvg,
    highSpendingMonths: sortedBySpend.slice(0, 3).filter(p => p.deviationPct > 10),
    lowSpendingMonths: sortedBySpend.slice(-3).filter(p => p.deviationPct < -10),
    insights: generateSeasonalInsights(patterns, yearlyAvg)
  };
}

/**
 * Get category spending trends over time
 */
export function getCategoryTrends(monthsBack: number = 12): CategoryTrendsResult {
  const now = new Date();
  const months: string[] = [];
  for (let i = monthsBack - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(getMonthKey(d));
  }

  const allCats = new Set<string>();
  (signals.transactions.value as Transaction[]).filter(t => t.type === 'expense' && t.date).forEach(t => allCats.add(t.category));

  const categoryTrends: Record<string, CategoryTrendData> = {};

  allCats.forEach(catId => {
    const catInfo = getCatInfo('expense', catId) as CategoryChild;
    const monthlyData: CategoryMonthData[] = months.map(mk => ({ month: mk, amount: getMonthExpByCat(catId, mk) }));
    const rollingAvg: number[] = monthlyData.map((d, i) => {
      if (i < 2) return d.amount;
      return (monthlyData[i].amount + monthlyData[i-1].amount + monthlyData[i-2].amount) / 3;
    });

    const halfIdx = Math.floor(monthlyData.length / 2);
    const firstHalf = monthlyData.slice(0, halfIdx);
    const secondHalf = monthlyData.slice(halfIdx);
    const firstAvg = firstHalf.reduce((s, d) => s + d.amount, 0) / (firstHalf.length || 1);
    const secondAvg = secondHalf.reduce((s, d) => s + d.amount, 0) / (secondHalf.length || 1);
    const trendPct = firstAvg > 0 ? Math.round(((secondAvg - firstAvg) / firstAvg) * 100) : (secondAvg > 0 ? 100 : 0);
    const totalSpend = monthlyData.reduce((s, d) => s + d.amount, 0);

    categoryTrends[catId] = {
      ...catInfo,
      monthlyData,
      rollingAvg,
      totalSpend,
      avgMonthly: totalSpend / months.length,
      trendPct,
      trendDirection: trendPct > 10 ? 'growing' : trendPct < -10 ? 'shrinking' : 'stable'
    };
  });

  return {
    months,
    categories: categoryTrends,
    sorted: Object.values(categoryTrends).sort((a, b) => b.totalSpend - a.totalSpend)
  };
}

/**
 * Get trending categories (growing and shrinking)
 */
export function getTrendingCategories(monthsBack: number = 12): TrendingCategoriesResult {
  const trends = getCategoryTrends(monthsBack);
  const cats = trends.sorted.filter(c => c.totalSpend > 50);
  return {
    growing: cats.filter(c => c.trendPct > 15).sort((a, b) => b.trendPct - a.trendPct).slice(0, 3),
    shrinking: cats.filter(c => c.trendPct < -15).sort((a, b) => a.trendPct - b.trendPct).slice(0, 3),
    stable: cats.filter(c => Math.abs(c.trendPct) <= 15)
  };
}

/**
 * Calculate category trends between current and previous month
 */
export function calcCategoryTrends(): Record<string, CategoryTrendChange> {
  const curMk = signals.currentMonth.value as string;
  const prevMk = getPrevMonthKey(curMk);
  const curTx = getMonthTx(curMk).filter(t => t.type === 'expense');
  const prevTx = getMonthTx(prevMk).filter(t => t.type === 'expense');
  const curByCat: Record<string, number> = {};
  const prevByCat: Record<string, number> = {};

  // Use integer math for precision
  curTx.forEach(t => {
    const amtCents = toCents(t.amount);
    curByCat[t.category] = (curByCat[t.category] || 0) + (amtCents / 100);
  });
  prevTx.forEach(t => {
    const amtCents = toCents(t.amount);
    prevByCat[t.category] = (prevByCat[t.category] || 0) + (amtCents / 100);
  });

  const trends: Record<string, CategoryTrendChange> = {};
  Object.keys({ ...curByCat, ...prevByCat }).forEach(catId => {
    const cur = curByCat[catId] || 0;
    const prev = prevByCat[catId] || 0;
    if (prev > 0) {
      const change = Math.round(((cur - prev) / prev) * 100);
      trends[catId] = { change, direction: change > 0 ? 'up' : change < 0 ? 'down' : 'flat' };
    } else if (cur > 0) {
      trends[catId] = { change: 100, direction: 'new' };
    }
  });
  return trends;
}

// ==========================================
// MAIN ANALYTICS RENDERING
// ==========================================

/**
 * Main entry point for rendering analytics
 */
export function renderAnalytics(): void {
  const period = analyticsCurrentPeriod;
  const allTimeStats = getAllTimeStats() as AllTimeStats | null;

  if (!allTimeStats) {
    // No data
    const yearSummary = DOM.get('year-summary-content');
    const trendChart = DOM.get('analytics-trend-chart');
    const yoyContent = DOM.get('yoy-comparison-content');
    const alltimeContent = DOM.get('alltime-stats-content');
    const noDataMsg = html`<p class="text-sm" style="color: var(--text-tertiary);">No data to display</p>`;
    if (yearSummary) render(html`<p class="text-sm" style="color: var(--text-tertiary);">No transaction data yet</p>`, yearSummary);
    if (trendChart) render(noDataMsg, trendChart);
    if (yoyContent) render(noDataMsg, yoyContent);
    if (alltimeContent) render(noDataMsg, alltimeContent);
    return;
  }

  // Update year tabs with available years
  updateAnalyticsTabs(allTimeStats.years);

  if (period === 'all-time') {
    renderAllTimeView(allTimeStats);
  } else {
    renderYearView(period, allTimeStats);
  }
}

/**
 * Update analytics tab buttons
 */
export function updateAnalyticsTabs(years: string[]): void {
  const tabContainer = document.querySelector('#analytics-modal .flex.gap-2.mb-5') as HTMLElement | null;
  if (!tabContainer) return;

  const handleTabClick = (period: string) => {
    analyticsCurrentPeriod = period;
    renderAnalytics();
  };

  const getTabStyle = (isActive: boolean) => styleMap({
    background: isActive ? 'var(--color-accent)' : 'transparent',
    color: isActive ? 'white' : 'var(--text-secondary)'
  });

  render(html`
    <button class="analytics-tab flex-shrink-0 py-2 px-4 rounded-lg text-sm font-bold transition-all"
            data-period="all-time"
            style=${getTabStyle(analyticsCurrentPeriod === 'all-time')}
            @click=${() => handleTabClick('all-time')}>All-Time</button>
    ${years.map(year => html`
      <button class="analytics-tab flex-shrink-0 py-2 px-4 rounded-lg text-sm font-bold transition-all"
              data-period=${year}
              style=${getTabStyle(analyticsCurrentPeriod === year)}
              @click=${() => handleTabClick(year)}>${year}</button>
    `)}
  `, tabContainer);
}

/**
 * Render year-specific analytics view
 */
export function renderYearView(year: string, allTimeStats: AllTimeStats): void {
  const stats = getYearStats(year) as YearStats;

  // Year Summary Card
  const summaryEl = DOM.get('year-summary-content');
  if (summaryEl) {
    const getSavingsRateColor = () => {
      if (stats.savingsRate >= 20) return 'var(--color-income)';
      if (stats.savingsRate >= 0) return 'var(--color-warning)';
      return 'var(--color-expense)';
    };

    render(html`
      <div class="grid grid-cols-2 gap-3">
        <div>
          <p class="text-xs" style="color: var(--text-tertiary);">Income</p>
          <p class="text-lg font-bold" style="color: var(--color-income);">${fmtCurFn(stats.income)}</p>
        </div>
        <div>
          <p class="text-xs" style="color: var(--text-tertiary);">Expenses</p>
          <p class="text-lg font-bold" style="color: var(--color-expense);">${fmtCurFn(stats.expenses)}</p>
        </div>
        <div>
          <p class="text-xs" style="color: var(--text-tertiary);">Net Savings</p>
          <p class="text-lg font-bold" style=${styleMap({ color: stats.net >= 0 ? 'var(--color-income)' : 'var(--color-expense)' })}>${stats.net >= 0 ? '+' : ''}${fmtCurFn(stats.net)}</p>
        </div>
        <div>
          <p class="text-xs" style="color: var(--text-tertiary);">Savings Rate</p>
          <p class="text-lg font-bold" style=${styleMap({ color: getSavingsRateColor() })}>${stats.savingsRate.toFixed(1)}%</p>
        </div>
      </div>
      <div class="mt-4 pt-3" style="border-top: 1px solid var(--border-card);">
        <p class="text-xs font-bold mb-2" style="color: var(--text-secondary);">TOP CATEGORIES</p>
        <div class="space-y-2">
          ${stats.topCategories.map(cat => html`
            <div class="flex justify-between items-center">
              <span class="text-sm" style="color: var(--text-primary);">${cat.emoji} ${cat.name}</span>
              <span class="text-sm font-medium" style="color: var(--text-secondary);">${fmtCurFn(cat.amount)}</span>
            </div>
          `)}
        </div>
      </div>
      <div class="mt-3 pt-3 flex gap-4 text-xs" style="border-top: 1px solid var(--border-card); color: var(--text-tertiary);">
        <span>Avg/mo Income: ${fmtCurFn(stats.avgMonthlyIncome)}</span>
        <span>Avg/mo Expenses: ${fmtCurFn(stats.avgMonthlyExpenses)}</span>
      </div>
    `, summaryEl);
  }

  // 12-Month Trend Chart
  render12MonthTrendChart(year, stats.monthlyData);

  // Year-over-Year Comparison with selectable years
  const prevYear = String(parseInt(year, 10) - 1);
  if (allTimeStats.years.length >= 2) {
    populateYearSelectors(allTimeStats.years);
    const y1 = DOM.get('yoy-year1') as HTMLSelectElement | null;
    const y2 = DOM.get('yoy-year2') as HTMLSelectElement | null;
    if (y1 && y2) {
      y1.value = year;
      y2.value = allTimeStats.years.includes(prevYear) ? prevYear : allTimeStats.years.find(y => y !== year) || year;
      renderYearComparisonChart('yoy-comparison-chart', y1.value, y2.value);
      renderYearOverYearComparison(y1.value, y2.value);
    }
    DOM.get('analytics-yoy-section')?.classList.remove('hidden');
  } else {
    DOM.get('analytics-yoy-section')?.classList.add('hidden');
  }

  // Hide seasonal and category trends (only shown in all-time view)
  DOM.get('analytics-seasonal-section')?.classList.add('hidden');
  DOM.get('analytics-category-trends')?.classList.add('hidden');

  // All-time stats (always show)
  renderAllTimeStatsSection(allTimeStats);
}

/**
 * Render all-time analytics view
 */
export function renderAllTimeView(allTimeStats: AllTimeStats): void {
  // Summary for all-time
  const summaryEl = DOM.get('year-summary-content');
  if (summaryEl) {
    const getSavingsRateColor = () => {
      if (allTimeStats.savingsRate >= 20) return 'var(--color-income)';
      if (allTimeStats.savingsRate >= 0) return 'var(--color-warning)';
      return 'var(--color-expense)';
    };

    render(html`
      <div class="grid grid-cols-2 gap-3">
        <div>
          <p class="text-xs" style="color: var(--text-tertiary);">Lifetime Income</p>
          <p class="text-lg font-bold" style="color: var(--color-income);">${fmtCurFn(allTimeStats.totalIncome)}</p>
        </div>
        <div>
          <p class="text-xs" style="color: var(--text-tertiary);">Lifetime Expenses</p>
          <p class="text-lg font-bold" style="color: var(--color-expense);">${fmtCurFn(allTimeStats.totalExpenses)}</p>
        </div>
        <div>
          <p class="text-xs" style="color: var(--text-tertiary);">Net Savings</p>
          <p class="text-lg font-bold" style=${styleMap({ color: allTimeStats.netSavings >= 0 ? 'var(--color-income)' : 'var(--color-expense)' })}>${allTimeStats.netSavings >= 0 ? '+' : ''}${fmtCurFn(allTimeStats.netSavings)}</p>
        </div>
        <div>
          <p class="text-xs" style="color: var(--text-tertiary);">Savings Rate</p>
          <p class="text-lg font-bold" style=${styleMap({ color: getSavingsRateColor() })}>${allTimeStats.savingsRate.toFixed(1)}%</p>
        </div>
      </div>
    `, summaryEl);
  }

  // Combined trend chart for all years
  renderAllTimeTrendChart(allTimeStats);

  // Year-over-Year with selectable years
  if (allTimeStats.years.length >= 2) {
    populateYearSelectors(allTimeStats.years);
    DOM.get('analytics-yoy-section')?.classList.remove('hidden');
  } else {
    DOM.get('analytics-yoy-section')?.classList.add('hidden');
  }

  // Seasonal patterns (all-time view only)
  renderSeasonalPatternChart('seasonal-pattern-chart');
  renderSeasonalInsights('seasonal-insights');
  DOM.get('analytics-seasonal-section')?.classList.remove('hidden');

  // Category trends (all-time view only)
  const trendPeriodEl = DOM.get('trend-period-select') as HTMLSelectElement | null;
  const trendPeriod = parseInt(trendPeriodEl?.value || '12');
  renderCategoryTrendsChart('category-trends-chart', trendPeriod);
  updateTrendingSummary('category-trends-chart', trendPeriod);
  DOM.get('analytics-category-trends')?.classList.remove('hidden');

  // All-time stats section
  renderAllTimeStatsSection(allTimeStats);
}

// ==========================================
// CHART RENDERING FUNCTIONS
// ==========================================

interface TrendMonth {
  mk: string;
  income: number;
  expenses: number;
  net: number;
}

/**
 * Render 12-month trend bar chart
 */
export function render12MonthTrendChart(year: string, monthlyData: Record<string, { income: number; expenses: number }>): void {
  const el = DOM.get('analytics-trend-chart');
  if (!el) return;

  // Generate all 12 months for the year
  const months: TrendMonth[] = [];
  for (let m = 1; m <= 12; m++) {
    const mk = `${year}-${String(m).padStart(2, '0')}`;
    const data = monthlyData[mk] || { income: 0, expenses: 0 };
    months.push({ mk, ...data, net: data.income - data.expenses });
  }

  const maxVal = Math.max(...months.map(m => Math.max(m.income, m.expenses)), 1);
  const w = el.clientWidth || 500;
  const h = 200;
  const padL = 50, padR = 15, padT = 20, padB = 35;
  const chartW = w - padL - padR, chartH = h - padT - padB;
  const barGroupWidth = chartW / 12;
  const barWidth = (barGroupWidth - 8) / 2;

  let svg = `<svg viewBox="0 0 ${w} ${h}" class="w-full" role="img" aria-label="12-month income and expense trend">`;
  svg += `<title>12-Month Trend for ${year}</title>`;

  // Grid lines
  for (let i = 0; i <= 4; i++) {
    const y = padT + (chartH / 4) * i;
    svg += `<line x1="${padL}" y1="${y}" x2="${w - padR}" y2="${y}" stroke="var(--border-card)" stroke-width="1" opacity="0.5"/>`;
    const val = maxVal - (maxVal / 4) * i;
    svg += `<text x="${padL - 8}" y="${y + 4}" text-anchor="end" fill="var(--text-tertiary)" font-size="9">${fmtShort(val)}</text>`;
  }

  // Bars for each month
  months.forEach((m, i) => {
    const x = padL + i * barGroupWidth + 4;
    const monthLabel = new Date(parseInt(year), i, 1).toLocaleDateString('en-US', { month: 'short' });

    // Income bar
    if (m.income > 0) {
      const h1 = (m.income / maxVal) * chartH;
      svg += `<rect x="${x}" y="${padT + chartH - h1}" width="${barWidth}" height="${h1}" fill="var(--color-income)" rx="2"/>`;
    }

    // Expense bar
    if (m.expenses > 0) {
      const h2 = (m.expenses / maxVal) * chartH;
      svg += `<rect x="${x + barWidth + 2}" y="${padT + chartH - h2}" width="${barWidth}" height="${h2}" fill="var(--color-expense)" rx="2"/>`;
    }

    // Month label
    svg += `<text x="${x + barGroupWidth / 2 - 2}" y="${h - 10}" text-anchor="middle" fill="var(--text-tertiary)" font-size="9">${monthLabel}</text>`;
  });

  svg += '</svg>';

  render(html`
    ${unsafeSVG(svg)}
    <div class="flex justify-center gap-4 mt-2 text-xs" style="color: var(--text-tertiary);">
      <span><span style="color: var(--color-income);">■</span> Income</span>
      <span><span style="color: var(--color-expense);">■</span> Expenses</span>
    </div>
  `, el);
}

/**
 * Render all-time trend line chart
 */
export function renderAllTimeTrendChart(allTimeStats: AllTimeStats): void {
  const el = DOM.get('analytics-trend-chart');
  if (!el) return;

  // Get monthly data across all time
  const allTx = (signals.transactions.value as Transaction[]).filter(tx => tx.date);
  const monthlyData: Record<string, { income: number; expenses: number }> = {};
  allTx.forEach(t => {
    const mk = getMonthKey(t.date);
    if (!monthlyData[mk]) monthlyData[mk] = { income: 0, expenses: 0 };
    const amtCents = toCents(t.amount);
    if (t.type === 'income') monthlyData[mk].income += amtCents / 100;
    else monthlyData[mk].expenses += amtCents / 100;
  });

  // Sort months chronologically
  const months = Object.entries(monthlyData)
    .map(([mk, data]) => ({ mk, ...data, net: data.income - data.expenses }))
    .sort((a, b) => a.mk.localeCompare(b.mk));

  if (months.length === 0) {
    render(html`<p class="text-sm text-center py-4" style="color: var(--text-tertiary);">No data to display</p>`, el);
    return;
  }

  // Limit to last 24 months for readability
  const displayMonths = months.slice(-24);

  const maxVal = Math.max(...displayMonths.map(m => Math.max(m.income, m.expenses)), 1);
  const w = el.clientWidth || 500;
  const h = 200;
  const padL = 50, padR = 15, padT = 20, padB = 35;
  const chartW = w - padL - padR, chartH = h - padT - padB;
  const pointGap = chartW / Math.max(displayMonths.length - 1, 1);

  let svg = `<svg viewBox="0 0 ${w} ${h}" class="w-full" role="img" aria-label="All-time income and expense trend">`;
  svg += `<title>All-Time Trend (Last ${displayMonths.length} months)</title>`;

  // Grid lines
  for (let i = 0; i <= 4; i++) {
    const y = padT + (chartH / 4) * i;
    svg += `<line x1="${padL}" y1="${y}" x2="${w - padR}" y2="${y}" stroke="var(--border-card)" stroke-width="1" opacity="0.5"/>`;
    const val = maxVal - (maxVal / 4) * i;
    svg += `<text x="${padL - 8}" y="${y + 4}" text-anchor="end" fill="var(--text-tertiary)" font-size="9">${fmtShort(val)}</text>`;
  }

  // Income line
  let incomePath = '';
  displayMonths.forEach((m, i) => {
    const x = padL + i * pointGap;
    const y = padT + chartH - (m.income / maxVal) * chartH;
    incomePath += i === 0 ? `M${x},${y}` : ` L${x},${y}`;
  });
  svg += `<path d="${incomePath}" fill="none" stroke="var(--color-income)" stroke-width="2" opacity="0.85"/>`;

  // Expense line
  let expensePath = '';
  displayMonths.forEach((m, i) => {
    const x = padL + i * pointGap;
    const y = padT + chartH - (m.expenses / maxVal) * chartH;
    expensePath += i === 0 ? `M${x},${y}` : ` L${x},${y}`;
  });
  svg += `<path d="${expensePath}" fill="none" stroke="var(--color-expense)" stroke-width="2" opacity="0.85"/>`;

  // Month labels (show every few months to avoid crowding)
  const labelInterval = Math.ceil(displayMonths.length / 8);
  displayMonths.forEach((m, i) => {
    if (i % labelInterval === 0 || i === displayMonths.length - 1) {
      const x = padL + i * pointGap;
      const shortLabel = m.mk.substring(2).replace('-', '/'); // "26/01"
      svg += `<text x="${x}" y="${h - 8}" text-anchor="middle" fill="var(--text-tertiary)" font-size="9">${shortLabel}</text>`;
    }
  });

  svg += '</svg>';

  render(html`
    ${unsafeSVG(svg)}
    <div class="flex justify-center gap-4 mt-2 text-xs" style="color: var(--text-tertiary);">
      <span><span style="color: var(--color-income);">─</span> Income</span>
      <span><span style="color: var(--color-expense);">─</span> Expenses</span>
    </div>
  `, el);
}

/**
 * Render year-over-year comparison details
 */
export function renderYearOverYearComparison(year1: string, year2: string): void {
  const stats1 = getYearStats(year1) as YearStats;
  const stats2 = getYearStats(year2) as YearStats;

  const calcChange = (current: number, previous: number): number => {
    if (previous === 0) return current > 0 ? 100 : 0;
    return ((current - previous) / previous * 100);
  };

  const renderIncomeChange = (change: number) => {
    const arrow = change > 0 ? '↑' : change < 0 ? '↓' : '→';
    const color = change > 0 ? 'var(--color-income)' : change < 0 ? 'var(--color-expense)' : 'var(--text-tertiary)';
    return html`<span style=${styleMap({ color })}>${arrow} ${Math.abs(change).toFixed(1)}%</span>`;
  };

  const renderExpenseChange = (change: number) => {
    const arrow = change > 0 ? '↑' : change < 0 ? '↓' : '→';
    const color = change > 0 ? 'var(--color-expense)' : change < 0 ? 'var(--color-income)' : 'var(--text-tertiary)';
    return html`<span style=${styleMap({ color })}>${arrow} ${Math.abs(change).toFixed(1)}%</span>`;
  };

  const incomeChange = calcChange(stats1.income, stats2.income);
  const expenseChange = calcChange(stats1.expenses, stats2.expenses);
  const savingsChange = calcChange(stats1.savingsRate, stats2.savingsRate);

  // Build category comparison data
  let categoryComparisonTemplate: LitTemplate = nothing;
  if (stats1.topCategories.length > 0 || stats2.topCategories.length > 0) {
    const allCats = new Set([
      ...stats1.topCategories.map(c => c.id),
      ...stats2.topCategories.map(c => c.id)
    ]);

    const catComparison: { catId: string; amount1: number; amount2: number; total: number }[] = [];
    allCats.forEach(catId => {
      const cat1 = stats1.topCategories.find(c => c.id === catId);
      const cat2 = stats2.topCategories.find(c => c.id === catId);
      const amount1 = cat1?.amount || 0;
      const amount2 = cat2?.amount || 0;
      catComparison.push({ catId, amount1, amount2, total: amount1 + amount2 });
    });

    catComparison.sort((a, b) => b.total - a.total);
    const top5 = catComparison.slice(0, 5);

    categoryComparisonTemplate = html`
      <div class="mt-4 pt-3" style="border-top: 1px solid var(--border-card);">
        <p class="text-xs font-bold mb-2" style="color: var(--text-secondary);">CATEGORY COMPARISON</p>
        ${top5.map(comp => {
          const catInfo = getCatInfo('expense', comp.catId) as CategoryChild;
          const change = calcChange(comp.amount1, comp.amount2);
          const maxAmount = Math.max(comp.amount1, comp.amount2);
          const bar1Width = maxAmount > 0 ? (comp.amount1 / maxAmount) * 100 : 0;
          const bar2Width = maxAmount > 0 ? (comp.amount2 / maxAmount) * 100 : 0;

          return html`
            <div class="mb-2">
              <div class="flex justify-between text-xs mb-1">
                <span style="color: var(--text-primary);">${catInfo.emoji} ${catInfo.name}</span>
                <span>${renderExpenseChange(change)}</span>
              </div>
              <div class="flex gap-1 h-3">
                <div class="rounded" style=${styleMap({ width: `${bar1Width}%`, background: 'var(--color-accent)' })}></div>
                <div class="rounded" style=${styleMap({ width: `${bar2Width}%`, background: 'var(--color-accent)', opacity: '0.4' })}></div>
              </div>
              <div class="flex justify-between text-xs mt-1" style="color: var(--text-tertiary);">
                <span>${fmtCurFn(comp.amount1)}</span>
                <span>${fmtCurFn(comp.amount2)}</span>
              </div>
            </div>
          `;
        })}
      </div>
    `;
  }

  const contentEl = DOM.get('yoy-comparison-content');
  if (contentEl) {
    render(html`
      <div class="text-center mb-3">
        <span class="text-lg font-bold" style="color: var(--text-primary);">${year1}</span>
        <span class="mx-2" style="color: var(--text-tertiary);">vs</span>
        <span class="text-lg font-bold" style="color: var(--text-secondary);">${year2}</span>
      </div>
      <div class="space-y-3">
        <div class="flex justify-between items-center p-2 rounded-lg" style="background: var(--bg-input);">
          <span class="text-sm" style="color: var(--text-secondary);">Income</span>
          <div class="text-right">
            <span class="text-sm font-medium" style="color: var(--text-primary);">${fmtCurFn(stats1.income)}</span>
            <span class="text-xs ml-2">${renderIncomeChange(incomeChange)}</span>
          </div>
        </div>
        <div class="flex justify-between items-center p-2 rounded-lg" style="background: var(--bg-input);">
          <span class="text-sm" style="color: var(--text-secondary);">Expenses</span>
          <div class="text-right">
            <span class="text-sm font-medium" style="color: var(--text-primary);">${fmtCurFn(stats1.expenses)}</span>
            <span class="text-xs ml-2">${renderExpenseChange(expenseChange)}</span>
          </div>
        </div>
        <div class="flex justify-between items-center p-2 rounded-lg" style="background: var(--bg-input);">
          <span class="text-sm" style="color: var(--text-secondary);">Savings Rate</span>
          <div class="text-right">
            <span class="text-sm font-medium" style="color: var(--text-primary);">${stats1.savingsRate.toFixed(1)}%</span>
            <span class="text-xs ml-2">${renderIncomeChange(savingsChange)}</span>
          </div>
        </div>
      </div>
      ${categoryComparisonTemplate}
    `, contentEl);
  }
}

/**
 * Render year comparison bar chart
 */
export function renderYearComparisonChart(containerId: string, year1: string, year2: string): void {
  const el = DOM.get(containerId);
  if (!el) return;
  const comparison = compareYearsMonthly(year1, year2);
  const maxVal = Math.max(...comparison.flatMap(m => [m.year1.expenses, m.year2.expenses]), 1);
  const w = el.clientWidth || 600;
  const h = 280;
  const padL = 55, padR = 20, padT = 30, padB = 50;
  const chartW = w - padL - padR, chartH = h - padT - padB;
  const groupW = chartW / 12;
  const barW = (groupW - 12) / 2;

  let svg = `<svg viewBox="0 0 ${w} ${h}" class="w-full" role="img" aria-label="Year-over-year monthly expense comparison">`;
  svg += `<title>${year1} vs ${year2} Monthly Expenses</title>`;

  for (let i = 0; i <= 4; i++) {
    const y = padT + (chartH / 4) * i;
    svg += `<line x1="${padL}" y1="${y}" x2="${w - padR}" y2="${y}" stroke="var(--border-card)" stroke-width="1" opacity="0.5"/>`;
    const val = maxVal - (maxVal / 4) * i;
    svg += `<text x="${padL - 8}" y="${y + 4}" text-anchor="end" fill="var(--text-tertiary)" font-size="9">${fmtShort(val)}</text>`;
  }

  comparison.forEach((m, i) => {
    const x = padL + i * groupW + 6;
    const h1 = m.year1.expenses > 0 ? (m.year1.expenses / maxVal) * chartH : 0;
    if (h1 > 0) {
      svg += `<rect x="${x}" y="${padT + chartH - h1}" width="${barW}" height="${h1}" fill="var(--color-expense)" rx="2" opacity="1"/>`;
    }
    const h2 = m.year2.expenses > 0 ? (m.year2.expenses / maxVal) * chartH : 0;
    if (h2 > 0) {
      svg += `<rect x="${x + barW + 2}" y="${padT + chartH - h2}" width="${barW}" height="${h2}" fill="var(--color-expense)" rx="2" opacity="0.4"/>`;
    }
    svg += `<text x="${x + groupW / 2 - 3}" y="${h - 25}" text-anchor="middle" fill="var(--text-tertiary)" font-size="10">${m.monthLabel}</text>`;
    if (m.year2.expenses > 0) {
      const changeColor = m.expenseChange > 0 ? 'var(--color-expense)' : 'var(--color-income)';
      const changeText = `${m.expenseChange > 0 ? '+' : ''}${Math.round(m.expenseChange)}%`;
      svg += `<text x="${x + groupW / 2 - 3}" y="${h - 8}" text-anchor="middle" fill="${changeColor}" font-size="8" font-weight="bold">${changeText}</text>`;
    }
  });
  svg += '</svg>';

  render(html`
    ${unsafeSVG(svg)}
    <div class="flex justify-center gap-4 mt-2 text-xs" style="color: var(--text-tertiary);">
      <span><span style="color: var(--color-expense);">■</span> ${year1}</span>
      <span><span style="color: var(--color-expense); opacity: 0.4;">■</span> ${year2}</span>
    </div>
  `, el);
}

/**
 * Render seasonal pattern bar chart
 */
export function renderSeasonalPatternChart(containerId: string): void {
  const el = DOM.get(containerId);
  if (!el) return;
  const data = getSeasonalPatterns();
  if (!data || data.patterns.length === 0) {
    render(html`<p class="text-sm text-center py-4" style="color: var(--text-tertiary);">Need more data to analyze seasonal patterns</p>`, el);
    return;
  }
  const patterns = data.patterns;
  const avgLine = data.yearlyAverage;
  const maxVal = Math.max(...patterns.map(p => p.max || p.average), avgLine * 1.5, 1);
  const w = el.clientWidth || 600;
  const h = 260;
  const padL = 55, padR = 20, padT = 30, padB = 45;
  const chartW = w - padL - padR, chartH = h - padT - padB;
  const barW = (chartW / 12) - 8;

  let svg = `<svg viewBox="0 0 ${w} ${h}" class="w-full" role="img" aria-label="Seasonal spending pattern analysis">`;
  svg += `<title>Monthly Spending Patterns</title>`;

  for (let i = 0; i <= 4; i++) {
    const y = padT + (chartH / 4) * i;
    svg += `<line x1="${padL}" y1="${y}" x2="${w - padR}" y2="${y}" stroke="var(--border-card)" stroke-width="1" opacity="0.5"/>`;
    const val = maxVal - (maxVal / 4) * i;
    svg += `<text x="${padL - 8}" y="${y + 4}" text-anchor="end" fill="var(--text-tertiary)" font-size="9">${fmtShort(val)}</text>`;
  }

  const avgY = padT + chartH - (avgLine / maxVal) * chartH;
  svg += `<line x1="${padL}" y1="${avgY}" x2="${w - padR}" y2="${avgY}" stroke="var(--color-accent)" stroke-width="2" stroke-dasharray="5,5" opacity="0.7"/>`;
  svg += `<text x="${w - padR + 5}" y="${avgY + 4}" fill="var(--color-accent)" font-size="9">Avg</text>`;

  patterns.forEach((p, i) => {
    const x = padL + i * (chartW / 12) + 4;
    const barH = p.average > 0 ? (p.average / maxVal) * chartH : 0;
    const y = padT + chartH - barH;
    let color: string;
    if (p.deviationPct > 20) color = 'var(--color-expense)';
    else if (p.deviationPct < -15) color = 'var(--color-income)';
    else color = 'var(--color-accent)';
    if (barH > 0) {
      svg += `<rect x="${x}" y="${y}" width="${barW}" height="${barH}" fill="${color}" rx="3" opacity="0.8"/>`;
    }
    if (p.dataPoints > 1 && p.max !== p.min) {
      const minY = padT + chartH - (p.min / maxVal) * chartH;
      const maxY = padT + chartH - (p.max / maxVal) * chartH;
      const midX = x + barW / 2;
      svg += `<line x1="${midX}" y1="${minY}" x2="${midX}" y2="${maxY}" stroke="${color}" stroke-width="1" opacity="0.5"/>`;
      svg += `<line x1="${midX - 3}" y1="${minY}" x2="${midX + 3}" y2="${minY}" stroke="${color}" stroke-width="1" opacity="0.5"/>`;
      svg += `<line x1="${midX - 3}" y1="${maxY}" x2="${midX + 3}" y2="${maxY}" stroke="${color}" stroke-width="1" opacity="0.5"/>`;
    }
    svg += `<text x="${x + barW / 2}" y="${h - 25}" text-anchor="middle" fill="var(--text-tertiary)" font-size="10">${p.monthShort}</text>`;
    if (Math.abs(p.deviationPct) >= 10) {
      const devColor = p.deviationPct > 0 ? 'var(--color-expense)' : 'var(--color-income)';
      svg += `<text x="${x + barW / 2}" y="${h - 8}" text-anchor="middle" fill="${devColor}" font-size="8" font-weight="bold">${p.deviationPct > 0 ? '+' : ''}${p.deviationPct}%</text>`;
    }
  });
  svg += '</svg>';

  render(html`
    ${unsafeSVG(svg)}
    <div class="flex justify-center gap-4 mt-2 text-xs" style="color: var(--text-tertiary);">
      <span><span style="color: var(--color-expense);">■</span> High</span>
      <span><span style="color: var(--color-accent);">■</span> Average</span>
      <span><span style="color: var(--color-income);">■</span> Low</span>
      <span><span style="color: var(--color-accent);">- -</span> Yearly avg</span>
    </div>
  `, el);
}

/**
 * Render category trends line chart
 */
export function renderCategoryTrendsChart(containerId: string, monthsBack: number = 12): void {
  const el = DOM.get(containerId);
  if (!el) return;
  const trends = getCategoryTrends(monthsBack);
  const catsToShow = trends.sorted.filter(c => c.totalSpend > 0).slice(0, 5);
  if (catsToShow.length === 0) {
    render(html`<p class="text-sm text-center py-4" style="color: var(--text-tertiary);">No category data to display</p>`, el);
    return;
  }
  const months = trends.months;
  const maxVal = Math.max(...catsToShow.flatMap(c => c.rollingAvg), 1);
  const w = el.clientWidth || 600;
  const h = 280;
  const padL = 55, padR = 100, padT = 20, padB = 40;
  const chartW = w - padL - padR, chartH = h - padT - padB;
  const step = chartW / (months.length - 1 || 1);

  let svg = `<svg viewBox="0 0 ${w} ${h}" class="w-full" role="img" aria-label="Category spending trends over ${monthsBack} months">`;
  svg += `<title>Category Spending Trends</title>`;

  for (let i = 0; i <= 4; i++) {
    const y = padT + (chartH / 4) * i;
    svg += `<line x1="${padL}" y1="${y}" x2="${padL + chartW}" y2="${y}" stroke="var(--border-card)" stroke-width="1" opacity="0.5"/>`;
    const val = maxVal - (maxVal / 4) * i;
    svg += `<text x="${padL - 8}" y="${y + 4}" text-anchor="end" fill="var(--text-tertiary)" font-size="9">${fmtShort(val)}</text>`;
  }

  catsToShow.forEach((cat) => {
    let path = '';
    cat.rollingAvg.forEach((val, i) => {
      const x = padL + i * step;
      const y = padT + chartH - (val / maxVal) * chartH;
      path += i === 0 ? `M${x},${y}` : ` L${x},${y}`;
    });
    svg += `<path d="${path}" fill="none" stroke="${cat.color}" stroke-width="2.5" opacity="0.9"/>`;
    cat.monthlyData.forEach((d, i) => {
      const x = padL + i * step;
      const y = padT + chartH - (d.amount / maxVal) * chartH;
      svg += `<circle cx="${x}" cy="${y}" r="3" fill="${cat.color}" opacity="0.3"/>`;
    });
    const lastY = padT + chartH - (cat.rollingAvg[cat.rollingAvg.length - 1] / maxVal) * chartH;
    svg += `<text x="${padL + chartW + 8}" y="${lastY + 4}" fill="${cat.color}" font-size="10" font-weight="bold">${cat.emoji}</text>`;
    if (cat.trendDirection === 'growing') {
      svg += `<text x="${padL + chartW + 22}" y="${lastY + 4}" fill="var(--color-expense)" font-size="10">↑</text>`;
    } else if (cat.trendDirection === 'shrinking') {
      svg += `<text x="${padL + chartW + 22}" y="${lastY + 4}" fill="var(--color-income)" font-size="10">↓</text>`;
    }
  });

  const labelInterval = Math.ceil(months.length / 6);
  months.forEach((mk, i) => {
    if (i % labelInterval === 0 || i === months.length - 1) {
      const x = padL + i * step;
      const label = mk.substring(2).replace('-', '/');
      svg += `<text x="${x}" y="${h - 15}" text-anchor="middle" fill="var(--text-tertiary)" font-size="9">${label}</text>`;
    }
  });
  svg += '</svg>';

  render(html`
    ${unsafeSVG(svg)}
    <div class="flex flex-wrap justify-center gap-3 mt-2 text-xs">
      ${catsToShow.map(cat => {
        const trendIcon = cat.trendDirection === 'growing' ? '↑' : cat.trendDirection === 'shrinking' ? '↓' : '→';
        const trendColor = cat.trendDirection === 'growing' ? 'var(--color-expense)' : cat.trendDirection === 'shrinking' ? 'var(--color-income)' : 'var(--text-tertiary)';
        return html`<span style="color: var(--text-secondary);"><span style=${styleMap({ color: cat.color })}>●</span> ${cat.name} <span style=${styleMap({ color: trendColor })}>${trendIcon}${Math.abs(cat.trendPct)}%</span></span>`;
      })}
    </div>
  `, el);
}

/**
 * Render seasonal insights text
 */
export function renderSeasonalInsights(containerId: string): void {
  const el = DOM.get(containerId);
  if (!el) return;
  const data = getSeasonalPatterns();
  if (!data || data.insights.length === 0) {
    render(html`<p class="text-xs" style="color: var(--text-tertiary);">Not enough data for insights</p>`, el);
    return;
  }
  render(html`
    ${data.insights.map(i => html`
      <div class="flex items-center gap-2 p-2 rounded-lg" style=${styleMap({ background: `color-mix(in srgb, ${i.type === 'high' ? 'var(--color-expense)' : 'var(--color-income)'} 10%, transparent)` })}>
        <span class="text-lg">${i.type === 'high' ? '📈' : '📉'}</span>
        <span class="text-xs" style="color: var(--text-primary);">${i.message}</span>
      </div>
    `)}
  `, el);
}

/**
 * Update trending categories summary
 */
export function updateTrendingSummary(_containerId: string, monthsBack: number = 12): void {
  const trending = getTrendingCategories(monthsBack);
  const growingEl = DOM.get('growing-categories');
  const shrinkingEl = DOM.get('shrinking-categories');
  if (growingEl) {
    render(trending.growing.length
      ? html`${trending.growing.map(c => html`
          <div class="flex justify-between text-xs">
            <span style="color: var(--text-primary);">${c.emoji} ${c.name}</span>
            <span style="color: var(--color-expense);">+${c.trendPct}%</span>
          </div>
        `)}`
      : html`<p class="text-xs" style="color: var(--text-tertiary);">None</p>`
    , growingEl);
  }
  if (shrinkingEl) {
    render(trending.shrinking.length
      ? html`${trending.shrinking.map(c => html`
          <div class="flex justify-between text-xs">
            <span style="color: var(--text-primary);">${c.emoji} ${c.name}</span>
            <span style="color: var(--color-income);">${c.trendPct}%</span>
          </div>
        `)}`
      : html`<p class="text-xs" style="color: var(--text-tertiary);">None</p>`
    , shrinkingEl);
  }
}

/**
 * Populate year selector dropdowns
 */
export function populateYearSelectors(years: string[]): void {
  const y1 = DOM.get('yoy-year1') as HTMLSelectElement | null;
  const y2 = DOM.get('yoy-year2') as HTMLSelectElement | null;
  if (!y1 || !y2) return;
  const optTemplate = html`${years.map(y => html`<option value=${y}>${y}</option>`)}`;
  render(optTemplate, y1);
  render(optTemplate, y2);
  if (years.length >= 2) {
    y1.value = years[0];
    y2.value = years[1];
    renderYearComparisonChart('yoy-comparison-chart', years[0], years[1]);
  } else if (years.length === 1) {
    y1.value = years[0];
    y2.value = years[0];
  }
}

/**
 * Render all-time statistics section
 */
export function renderAllTimeStatsSection(allTimeStats: AllTimeStats): void {
  const firstDateFormatted = allTimeStats.firstDate ? new Date(allTimeStats.firstDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'N/A';

  const contentEl = DOM.get('alltime-stats-content');
  if (!contentEl) return;

  render(html`
    <div class="grid grid-cols-2 gap-3 text-sm">
      <div>
        <p class="text-xs" style="color: var(--text-tertiary);">Since</p>
        <p class="font-medium" style="color: var(--text-primary);">${firstDateFormatted}</p>
      </div>
      <div>
        <p class="text-xs" style="color: var(--text-tertiary);">Total Transactions</p>
        <p class="font-medium" style="color: var(--text-primary);">${allTimeStats.txCount.toLocaleString()}</p>
      </div>
      <div>
        <p class="text-xs" style="color: var(--text-tertiary);">Avg Monthly Spend</p>
        <p class="font-medium" style="color: var(--text-primary);">${fmtCurFn(allTimeStats.avgMonthlySpend)}</p>
      </div>
      <div>
        <p class="text-xs" style="color: var(--text-tertiary);">Lifetime Savings Rate</p>
        <p class="font-medium" style=${styleMap({ color: allTimeStats.savingsRate >= 20 ? 'var(--color-income)' : 'var(--text-primary)' })}>${allTimeStats.savingsRate.toFixed(1)}%</p>
      </div>
    </div>
    ${allTimeStats.bestMonth ? html`
      <div class="mt-3 pt-3 grid grid-cols-2 gap-3" style="border-top: 1px solid var(--border-card);">
        <div>
          <p class="text-xs" style="color: var(--text-tertiary);">Best Month (Savings)</p>
          <p class="font-medium" style="color: var(--color-income);">${formatMonthDisplay(allTimeStats.bestMonth.month)}</p>
          <p class="text-xs" style="color: var(--text-tertiary);">+${fmtCurFn(allTimeStats.bestMonth.net)}</p>
        </div>
        <div>
          <p class="text-xs" style="color: var(--text-tertiary);">Highest Spend Month</p>
          <p class="font-medium" style="color: var(--color-expense);">${formatMonthDisplay(allTimeStats.worstMonth!.month)}</p>
          <p class="text-xs" style="color: var(--text-tertiary);">${fmtCurFn(allTimeStats.worstMonth!.expenses)}</p>
        </div>
      </div>
    ` : nothing}
  `, contentEl);
}
