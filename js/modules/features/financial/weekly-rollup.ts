/**
 * Weekly Rollup Chart Module
 *
 * Renders weekly spending breakdown with SVG bar chart.
 * Shows spending by week with trend arrows, category breakdown,
 * and budget line comparison.
 *
 * @module weekly-rollup
 */
'use strict';

import * as signals from '../../core/signals.js';
import { getMonthTx } from './calculations.js';
import { parseMonthKey, getMonthKey, parseLocalDate, toCents, toDollars } from '../../core/utils.js';
import { getCatInfo } from '../../core/categories.js';
import { getMonthBadge } from '../../ui/widgets/calendar.js';
import { cleanupChartListeners, showChartTooltip, hideChartTooltip } from '../../ui/charts/chart-utils.js';
import DOM from '../../core/dom-cache.js';
import { html, render, unsafeHTML, unsafeSVG } from '../../core/lit-helpers.js';
import type {
  Transaction,
  CurrencyFormatter,
  ShortCurrencyFormatter,
  MainTab,
  WeeklyRollupCallbacks,
  WeekData,
  ChartHandlerRecord,
  CategoryChild
} from '../../../types/index.js';

// ==========================================
// CONFIGURABLE CALLBACKS
// ==========================================

// Configurable callbacks (set by app.js)
let fmtCur: CurrencyFormatter = (v: number): string => '$' + v.toFixed(2);
let fmtShort: ShortCurrencyFormatter = (v: number): string => '$' + v.toFixed(0);
let switchMainTabFn: ((tab: MainTab) => void) | null = null;
let renderTransactionsFn: (() => void) | null = null;

/**
 * Initialize weekly rollup with callback functions
 */
export function initWeeklyRollup(callbacks: WeeklyRollupCallbacks): void {
  if (callbacks.fmtCur) fmtCur = callbacks.fmtCur;
  if (callbacks.fmtShort) fmtShort = callbacks.fmtShort;
  if (callbacks.switchMainTab) switchMainTabFn = callbacks.switchMainTab;
  if (callbacks.renderTransactions) renderTransactionsFn = callbacks.renderTransactions;
}

// ==========================================
// CHART ELEMENT TYPE EXTENSION
// ==========================================

interface WeeklyRollupElement extends HTMLElement {
  _weeklyRollupHandlers?: ChartHandlerRecord[] | null;
}

// ==========================================
// MAIN RENDER FUNCTION
// ==========================================

/**
 * Render weekly spending rollup chart
 * Shows bar chart with weekly totals, trend arrows, and interactive tooltips
 */
export function renderWeeklyRollup(): void {
  const section = DOM.get('weekly-rollup-section') as HTMLElement | null;
  const el = DOM.get('weekly-rollup-chart') as WeeklyRollupElement | null;
  if (!section || !el) return;

  const monthTx = (getMonthTx() as Transaction[]).filter(tx => tx.type === 'expense');
  if (monthTx.length === 0) {
    section.classList.add('hidden');
    return;
  }
  section.classList.remove('hidden');
  const badgeEl = DOM.get('weekly-rollup-badge');
  if (badgeEl) render(unsafeHTML(getMonthBadge()), badgeEl);

  // Get month info
  const viewDate = parseMonthKey(signals.currentMonth.value as string);
  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const now = new Date();
  const isCurrentMonth = getMonthKey(now) === signals.currentMonth.value;
  const todayDay = isCurrentMonth ? now.getDate() : daysInMonth;

  // Calculate week boundaries (week 1 = days 1-7, week 2 = 8-14, etc.)
  const weeks: WeekData[] = [];
  let weekStart = 1;
  while (weekStart <= daysInMonth) {
    const weekEnd = Math.min(weekStart + 6, daysInMonth);
    weeks.push({ start: weekStart, end: weekEnd, total: 0, txCount: 0, categories: {} });
    weekStart = weekEnd + 1;
  }

  // Sum expenses into weeks with category tracking
  monthTx.forEach(tx => {
    const day = parseLocalDate(tx.date).getDate();
    const weekIdx = Math.floor((day - 1) / 7);
    if (weekIdx < weeks.length) {
      const amt = parseFloat(String(tx.amount)) || 0;
      weeks[weekIdx].total += amt;
      weeks[weekIdx].txCount++;
      weeks[weekIdx].categories[tx.category] = (weeks[weekIdx].categories[tx.category] || 0) + amt;
    }
  });

  // Calculate top 3 categories per week
  weeks.forEach(week => {
    const sorted = Object.entries(week.categories).sort((a, b) => b[1] - a[1]).slice(0, 3);
    week.topCategories = sorted.map(([cat, amt]) => ({ cat, amt }));
  });

  // Calculate stats
  const maxWeekTotal = Math.max(...weeks.map(w => w.total), 1);
  const avgWeekTotal = weeks.reduce((s, w) => s + w.total, 0) / weeks.length;

  // Responsive SVG dimensions based on container
  const containerWidth = el.clientWidth || 500;
  const isMobile = containerWidth < 400;
  const w = Math.max(280, Math.min(containerWidth, 600));
  const h = Math.max(140, Math.round(w * 0.32));
  const padL = isMobile ? 38 : 50;
  const padB = isMobile ? 35 : 40;
  const padT = isMobile ? 18 : 20;
  const padR = isMobile ? 10 : 15;
  const fontSize = isMobile ? 10 : 9;
  const labelSize = isMobile ? 8 : 7;
  const chartW = w - padL - padR, chartH = h - padT - padB;
  const barGap = isMobile ? 8 : 12;
  const barWidth = (chartW - barGap * (weeks.length - 1)) / weeks.length;

  let svg = `<svg viewBox="0 0 ${w} ${h}" class="w-full" role="img" aria-label="Weekly spending breakdown chart">`;
  svg += `<title>Weekly Spending Rollup</title>`;
  svg += `<desc>Bar chart showing spending by week for the current month</desc>`;

  // Gradient definitions for bars (use style attribute for CSS variable support)
  svg += `<defs>`;
  svg += `<linearGradient id="wrGradGreen" x1="0" y1="0" x2="0" y2="1">`;
  svg += `<stop offset="0%" style="stop-color: var(--color-income); stop-opacity: 1"/>`;
  svg += `<stop offset="100%" style="stop-color: var(--color-income); stop-opacity: 0.4"/>`;
  svg += `</linearGradient>`;
  svg += `<linearGradient id="wrGradOrange" x1="0" y1="0" x2="0" y2="1">`;
  svg += `<stop offset="0%" style="stop-color: var(--color-warning); stop-opacity: 1"/>`;
  svg += `<stop offset="100%" style="stop-color: var(--color-warning); stop-opacity: 0.4"/>`;
  svg += `</linearGradient>`;
  svg += `<linearGradient id="wrGradRed" x1="0" y1="0" x2="0" y2="1">`;
  svg += `<stop offset="0%" style="stop-color: var(--color-expense); stop-opacity: 1"/>`;
  svg += `<stop offset="100%" style="stop-color: var(--color-expense); stop-opacity: 0.4"/>`;
  svg += `</linearGradient>`;
  svg += `</defs>`;

  // Average line
  const avgY = padT + chartH - (avgWeekTotal / maxWeekTotal) * chartH;
  svg += `<line x1="${padL}" y1="${avgY}" x2="${w - padR}" y2="${avgY}" stroke="var(--color-warning)" stroke-width="1" stroke-dasharray="4,3" opacity="0.7"/>`;
  svg += `<text x="${w - padR + 4}" y="${avgY + 3}" fill="var(--color-warning)" font-size="${labelSize + 1}" font-weight="600">avg</text>`;

  // Budget line (if envelope budgeting is enabled)
  if (signals.sections.value.envelope) {
    const alloc = signals.monthlyAlloc.value[signals.currentMonth.value as string] || {};
    const monthlyBudgetCents = Object.values(alloc).reduce((sum: number, amt: unknown) => sum + toCents(amt as number), 0);
    const monthlyBudget = toDollars(monthlyBudgetCents);
    if (monthlyBudget > 0) {
      const weeklyBudget = monthlyBudget / weeks.length;
      // Only show if budget line would be visible on chart
      if (weeklyBudget <= maxWeekTotal * 1.5) {
        const budgetY = padT + chartH - Math.min((weeklyBudget / maxWeekTotal) * chartH, chartH);
        svg += `<line x1="${padL}" y1="${budgetY}" x2="${w - padR}" y2="${budgetY}" stroke="var(--color-purple)" stroke-width="1.5" stroke-dasharray="6,4" opacity="0.8"/>`;
        svg += `<text x="${padL - 6}" y="${budgetY + 3}" text-anchor="end" fill="var(--color-purple)" font-size="${labelSize}" font-weight="600">${isMobile ? 'bgt' : 'budget'}</text>`;
      }
    }
  }

  // Bars
  weeks.forEach((week, i) => {
    const x = padL + i * (barWidth + barGap);
    const barH = week.total > 0 ? (week.total / maxWeekTotal) * chartH : 0;
    const y = padT + chartH - barH;

    // Determine bar color/gradient based on comparison to average
    let barFill = 'url(#wrGradRed)';
    let barTextColor = 'var(--color-expense)';
    let barOpacity = '1';
    const isFuture = isCurrentMonth && week.start > todayDay;

    if (isFuture) {
      barFill = 'var(--text-tertiary)';
      barTextColor = 'var(--text-tertiary)';
      barOpacity = '0.3';
    } else if (week.total < avgWeekTotal * 0.7) {
      barFill = 'url(#wrGradGreen)'; // Good - below avg
      barTextColor = 'var(--color-income)';
    } else if (week.total > avgWeekTotal * 1.3) {
      barFill = 'url(#wrGradRed)'; // High spending
      barTextColor = 'var(--color-expense)';
    } else {
      barFill = 'url(#wrGradOrange)'; // Normal
      barTextColor = 'var(--color-warning)';
    }

    // Bar with rounded top, gradient fill, and staggered animation
    if (barH > 0) {
      const radius = Math.min(4, barWidth / 4);
      const animDelay = i * 0.08; // Stagger animation
      svg += `<rect id="wr-bar-${i}" x="${x}" y="${y}" width="${barWidth}" height="${barH}" rx="${radius}" ry="${radius}" fill="${barFill}" opacity="${barOpacity}" class="wr-bar" style="transition: filter 0.15s ease; animation-delay: ${animDelay}s;"/>`;

      // Value label on top
      if (week.total > maxWeekTotal * 0.1) {
        svg += `<text x="${x + barWidth / 2}" y="${y - 4}" text-anchor="middle" fill="${barTextColor}" font-size="${fontSize}" font-weight="600">${fmtShort(week.total)}</text>`;
      }
    }

    // Week-over-week trend arrow (only for weeks 2+, not future, and with meaningful change)
    if (i > 0 && !isFuture && weeks[i-1].total > 0) {
      const prevWeekFuture = isCurrentMonth && weeks[i-1].start > todayDay;
      if (!prevWeekFuture) {
        const change = ((week.total - weeks[i-1].total) / weeks[i-1].total * 100);
        if (Math.abs(change) > 10) {
          const arrow = change > 0 ? '↑' : '↓';
          const arrowColor = change > 0 ? 'var(--color-expense)' : 'var(--color-income)';
          const changeText = `${change > 0 ? '+' : ''}${Math.round(change)}%`;
          svg += `<text x="${x + barWidth / 2}" y="${h - 22}" text-anchor="middle" fill="${arrowColor}" font-size="${fontSize}" font-weight="600">${arrow}</text>`;
          svg += `<text x="${x + barWidth / 2}" y="${h - 12}" text-anchor="middle" fill="${arrowColor}" font-size="${labelSize}">${changeText}</text>`;
        }
      }
    }

    // Week label (Week 1, Week 2, etc.)
    svg += `<text x="${x + barWidth / 2}" y="${h - 2}" text-anchor="middle" fill="var(--text-tertiary)" font-size="${fontSize}">W${i + 1}</text>`;

    // Invisible hover area for tooltips and clicks
    const startDate = `${year}-${String(month + 1).padStart(2, '0')}-${String(week.start).padStart(2, '0')}`;
    const endDate = `${year}-${String(month + 1).padStart(2, '0')}-${String(week.end).padStart(2, '0')}`;
    const vsAvg = avgWeekTotal > 0 ? Math.round((week.total / avgWeekTotal - 1) * 100) : 0;
    const topCatsData = (week.topCategories || []).map(c => `${c.cat}:${c.amt.toFixed(2)}`).join('|');
    svg += `<rect x="${x}" y="${padT}" width="${barWidth}" height="${chartH}" fill="transparent" class="wr-hover" style="cursor:pointer" data-week="${i + 1}" data-start="${startDate}" data-end="${endDate}" data-total="${fmtCur(week.total)}" data-count="${week.txCount}" data-vsavg="${vsAvg >= 0 ? '+' : ''}${vsAvg}%" data-barid="wr-bar-${i}" data-topcats="${topCatsData}"/>`;
  });

  // Find min/max weeks (excluding future and zero-value weeks)
  const validWeeks = weeks.map((w, i) => ({ ...w, idx: i })).filter(w => {
    const isFuture = isCurrentMonth && w.start > todayDay;
    return !isFuture && w.total > 0;
  });

  if (validWeeks.length > 1) {
    const maxWeek = validWeeks.reduce((m, w) => w.total > m.total ? w : m, validWeeks[0]);
    const minWeek = validWeeks.reduce((m, w) => w.total < m.total ? w : m, validWeeks[0]);

    // Only show markers if min and max are different weeks
    if (maxWeek.idx !== minWeek.idx) {
      // Peak marker
      const maxX = padL + maxWeek.idx * (barWidth + barGap) + barWidth / 2;
      const maxBarH = (maxWeek.total / maxWeekTotal) * chartH;
      const maxY = padT + chartH - maxBarH;
      const markerR = isMobile ? 3 : 4;
      svg += `<circle cx="${maxX}" cy="${maxY - 14}" r="${markerR}" fill="var(--color-expense)" stroke="white" stroke-width="1.5"/>`;
      svg += `<text x="${maxX}" y="${maxY - 22}" text-anchor="middle" fill="var(--color-expense)" font-size="${labelSize}" font-weight="600">${isMobile ? 'Hi' : 'Peak'}</text>`;

      // Low marker
      const minX = padL + minWeek.idx * (barWidth + barGap) + barWidth / 2;
      const minBarH = (minWeek.total / maxWeekTotal) * chartH;
      const minY = padT + chartH - minBarH;
      svg += `<circle cx="${minX}" cy="${minY - 14}" r="${markerR}" fill="var(--color-income)" stroke="white" stroke-width="1.5"/>`;
      svg += `<text x="${minX}" y="${minY - 22}" text-anchor="middle" fill="var(--color-income)" font-size="${labelSize}" font-weight="600">${isMobile ? 'Lo' : 'Low'}</text>`;
    }
  }

  // Y-axis labels
  svg += `<text x="${padL - 6}" y="${padT + 10}" text-anchor="end" fill="var(--text-tertiary)" font-size="${fontSize}">${fmtShort(maxWeekTotal)}</text>`;
  svg += `<text x="${padL - 6}" y="${padT + chartH}" text-anchor="end" fill="var(--text-tertiary)" font-size="${fontSize}">$0</text>`;

  svg += '</svg>';

  // Summary row with Peak and Low
  const summaryValidWeeks = weeks.map((w, i) => ({ ...w, idx: i })).filter(w => {
    const isFuture = isCurrentMonth && w.start > todayDay;
    return !isFuture && w.total > 0;
  });

  // Calculate best/worst weeks for legend
  let bestWorstText = '';
  if (summaryValidWeeks.length > 0) {
    const highestWeek = summaryValidWeeks.reduce((m, w) => w.total > m.total ? w : m, summaryValidWeeks[0]);
    const lowestWeek = summaryValidWeeks.reduce((m, w) => w.total < m.total ? w : m, summaryValidWeeks[0]);
    bestWorstText = `Best: W${lowestWeek.idx + 1} · Worst: W${highestWeek.idx + 1}`;
  }

  // Render using lit-html
  render(html`
    ${unsafeSVG(svg)}
    <div class="flex flex-wrap justify-between items-center gap-2 mt-2 text-xs" style="color: var(--text-tertiary);">
      <div class="flex flex-wrap gap-2">
        <span><span style="color: var(--color-income);">■</span> Low</span>
        <span><span style="color: var(--color-warning);">■</span> Normal</span>
        <span><span style="color: var(--color-expense);">■</span> High</span>
      </div>
      ${bestWorstText ? html`<span style="color: var(--text-secondary);">${bestWorstText}</span>` : ''}
    </div>
  `, el);

  // Add tooltip, click, and hover highlight handlers with proper cleanup
  cleanupChartListeners(el);
  el._weeklyRollupHandlers = [];

  el.querySelectorAll<SVGElement>('.wr-hover').forEach(hover => {
    const barId = hover.dataset.barid;
    const bar = barId ? document.getElementById(barId) as HTMLElement | null : null;

    const enterHandler = (e: Event) => {
      if (bar) bar.style.filter = 'brightness(1.2)';

      // Tooltip with category breakdown
      const week = hover.dataset.week || '';
      const total = hover.dataset.total || '';
      const count = hover.dataset.count || '';
      const vsAvg = hover.dataset.vsavg || '';
      const topCatsRaw = hover.dataset.topcats || '';

      let tooltipText = `Week ${week}\nSpent: ${total}\n${count} transaction${count !== '1' ? 's' : ''}\nvs avg: ${vsAvg}`;

      // Add category breakdown if available
      if (topCatsRaw) {
        const cats = topCatsRaw.split('|').filter(c => c);
        if (cats.length > 0) {
          tooltipText += '\n─────────';
          cats.forEach(catData => {
            const [cat, amt] = catData.split(':');
            // Weekly rollup shows expense categories only
            const catInfo = getCatInfo('expense', cat) as CategoryChild;
            tooltipText += `\n${catInfo.emoji} ${fmtCur(parseFloat(amt))}`;
          });
        }
      }

      showChartTooltip(e as MouseEvent, tooltipText);
    };

    const leaveHandler = () => {
      if (bar) bar.style.filter = '';
      hideChartTooltip();
    };

    const clickHandler = () => {
      const startDate = hover.dataset.start || '';
      const endDate = hover.dataset.end || '';
      const filterFrom = DOM.get('filter-from') as HTMLInputElement | null;
      const filterTo = DOM.get('filter-to') as HTMLInputElement | null;
      if (filterFrom) filterFrom.value = startDate;
      if (filterTo) filterTo.value = endDate;
      if (switchMainTabFn) switchMainTabFn('transactions');
      if (renderTransactionsFn) renderTransactionsFn();
    };

    hover.addEventListener('mouseenter', enterHandler as EventListener);
    hover.addEventListener('mouseleave', leaveHandler);
    hover.addEventListener('click', clickHandler);

    // Store handlers for cleanup
    el._weeklyRollupHandlers!.push(
      { element: hover as unknown as HTMLElement, type: 'mouseenter', handler: enterHandler as EventListener },
      { element: hover as unknown as HTMLElement, type: 'mouseleave', handler: leaveHandler },
      { element: hover as unknown as HTMLElement, type: 'click', handler: clickHandler }
    );
  });
}
