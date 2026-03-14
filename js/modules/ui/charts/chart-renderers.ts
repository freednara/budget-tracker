/**
 * Chart Renderers Module
 *
 * SVG chart rendering functions for donut, bar, trend, and breakdown charts.
 * All charts use shared utilities from chart-utils.js.
 *
 * @module chart-renderers
 */
'use strict';

import * as signals from '../../core/signals.js';
import { navigation } from '../../core/state-actions.js';
import { getMonthTx, getEffectiveIncome, getMonthExpByCat } from '../../features/financial/calculations.js';
import { getMonthKey, parseMonthKey, toCents, toDollars, sumByType } from '../../core/utils.js';
import { html, render, unsafeHTML, unsafeSVG } from '../../core/lit-helpers.js';
import { getCatInfo } from '../../core/categories.js';
import { getMonthBadge } from '../widgets/calendar.js';
import { emit, Events } from '../../core/event-bus.js';
import { showToast } from '../core/ui.js';
import { cleanupChartListeners } from './chart-utils.js';
import DOM from '../../core/dom-cache.js';
import type {
  Transaction,
  CurrencyFormatter,
  MonthLabelFormatter,
  VelocityCalculator,
  ChartRendererCallbacks,
  DonutChartData,
  BarChartDataset,
  CategoryTrendChange,
  VelocityData,
  CategoryChild,
  ChartHandlerRecord
} from '../../../types/index.js';

// ==========================================
// CONFIGURABLE CALLBACKS
// ==========================================

// Configurable callbacks (set by app.js)
let fmtCur: CurrencyFormatter = (v: number): string => '$' + v.toFixed(2);
let monthLabelFn: MonthLabelFormatter = (mk: string): string => mk;
let calcVelocityFn: VelocityCalculator | null = null;

// Track current trend chart range (module-level state)
let trendChartMonths: number = 6;

/**
 * Initialize chart renderers with callback functions
 */
export function initChartRenderers(callbacks: ChartRendererCallbacks): void {
  if (callbacks.fmtCur) fmtCur = callbacks.fmtCur;
  if (callbacks.monthLabel) monthLabelFn = callbacks.monthLabel;
  if (callbacks.calcVelocity) calcVelocityFn = callbacks.calcVelocity;
}

/**
 * Set trend chart month count
 */
export function setTrendChartMonths(months: number): void {
  trendChartMonths = months;
}

/**
 * Get current trend chart month count
 */
export function getTrendChartMonths(): number {
  return trendChartMonths;
}

/**
 * Short currency formatter for chart labels
 */
export function fmtShort(v: number): string {
  const sign = v < 0 ? '-' : '';
  const abs = Math.abs(v);
  const symbol = signals.currency.value.symbol;
  if (abs >= 1000) return sign + symbol + (abs/1000).toFixed(abs >= 10000 ? 0 : 1) + 'k';
  return sign + symbol + (abs % 1 === 0 ? abs : abs.toFixed(0));
}

// ==========================================
// CHART ELEMENT TYPE EXTENSION
// ==========================================

interface ChartElement extends HTMLElement {
  _chartHandler?: ((e: Event) => void) | null;
  _chartMoveHandler?: ((e: Event) => void) | null;
  _chartLeaveHandler?: ((e: Event) => void) | null;
  _chartClickHandler?: ((e: Event) => void) | null;
  _barChartHandlers?: ChartHandlerRecord[] | null;
  _trendChartHandlers?: ChartHandlerRecord[] | null;
}

// ==========================================
// DONUT CHART
// ==========================================

/**
 * Render donut chart showing category breakdown
 */
export function renderDonutChart(containerId: string, data: DonutChartData[], trends: Record<string, CategoryTrendChange> = {}): void {
  const el = DOM.get(containerId) as ChartElement | null;
  if (!el) return;
  const noDataTemplate = html`<p class="text-xs text-center py-8" style="color: var(--text-tertiary);">No expense data yet</p>`;
  if (!data.length) {
    render(noDataTemplate, el);
    return;
  }
  const total = data.reduce((s, d) => s + d.value, 0);
  // Guard against all-zero datasets (division by zero)
  if (total === 0) {
    render(noDataTemplate, el);
    return;
  }
  const cx = 90, cy = 90, r = 70, ir = 42;
  let angle = -Math.PI / 2;
  let paths = '';

  data.forEach((d, idx) => {
    const pct = d.value / total;
    const pctStr = (pct * 100).toFixed(1);
    const dataAttrs = `data-idx="${idx}" data-label="${d.label}" data-value="${d.value}" data-pct="${pctStr}" data-cat="${d.catId || ''}" style="cursor:pointer;transition:opacity 0.15s;"`;
    if (pct >= 0.9999) {
      paths += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${d.color}" stroke-width="${r-ir}" opacity="0.85" ${dataAttrs}/>`;
      angle += pct * 2 * Math.PI;
      return;
    }
    const a1 = angle, a2 = angle + pct * 2 * Math.PI;
    const large = pct > 0.5 ? 1 : 0;
    const x1o = cx + r * Math.cos(a1), y1o = cy + r * Math.sin(a1);
    const x2o = cx + r * Math.cos(a2), y2o = cy + r * Math.sin(a2);
    const x1i = cx + ir * Math.cos(a2), y1i = cy + ir * Math.sin(a2);
    const x2i = cx + ir * Math.cos(a1), y2i = cy + ir * Math.sin(a1);
    paths += `<path d="M${x1o},${y1o} A${r},${r} 0 ${large},1 ${x2o},${y2o} L${x1i},${y1i} A${ir},${ir} 0 ${large},0 ${x2i},${y2i} Z" fill="${d.color}" opacity="0.85" ${dataAttrs}/>`;
    angle = a2;
  });

  // Build full SVG string
  const svgContent = `<svg viewBox="0 0 180 180" class="shrink-0" style="width:140px;height:140px;" role="img" aria-label="Expense breakdown by category"><title>Category Breakdown</title><desc>Donut chart showing ${data.length} expense categories totaling ${fmtCur(total)}</desc>${paths}<text x="${cx}" y="${cy-4}" text-anchor="middle" fill="var(--text-tertiary)" font-size="10">Total</text><text x="${cx}" y="${cy+12}" text-anchor="middle" fill="var(--text-primary)" font-size="15" font-weight="800">${fmtCur(total)}</text></svg>`;

  render(html`
    <div class="flex items-start gap-4">
      ${unsafeHTML(svgContent)}
      <div class="flex-1 space-y-2 pt-1">
        ${data.map(d => {
          const pct = (d.value / total * 100).toFixed(0);
          const trend = d.catId && trends[d.catId];
          let trendArrow = '';
          let trendColor = 'var(--text-tertiary)';
          if (trend) {
            trendArrow = trend.direction === 'up' ? '↑' : trend.direction === 'down' ? '↓' : '';
            trendColor = trend.direction === 'up' ? 'var(--color-expense)' : trend.direction === 'down' ? 'var(--color-income)' : 'var(--text-tertiary)';
          }
          return html`
            <div class="flex items-center gap-2 text-xs">
              <span class="w-3 h-3 rounded-full shrink-0" style="background:${d.color};"></span>
              <span class="flex-1" style="color:var(--text-secondary);">${d.label}</span>
              <span class="font-bold text-right" style="color:var(--text-primary); min-width: 70px;">${fmtCur(d.value)}</span>
              <span class="text-right" style="color:var(--text-tertiary); min-width: 32px;">${pct}%</span>
              <span class="text-right" style="min-width: 42px;">
                ${trend && trendArrow ? html`<span style="color:${trendColor};" title="vs last month">${trendArrow}${Math.abs(trend.change)}%</span>` : ''}
              </span>
            </div>
          `;
        })}
      </div>
    </div>
  `, el);

  // Add tooltip and click interactions via event delegation on container
  const tooltip = DOM.get('chart-tooltip') as HTMLElement | null;
  if (tooltip) {
    // Remove old handlers before adding new ones
    cleanupChartListeners(el);

    el._chartHandler = (e: Event) => {
      const target = e.target as Element;
      const segment = target.closest('path[data-idx], circle[data-idx]') as HTMLElement | null;
      if (!segment) return;
      (segment as HTMLElement).style.opacity = '1';
      render(html`
        <div class="font-bold" style="color:var(--text-primary);">${segment.dataset.label || ''}</div>
        <div style="color:var(--text-secondary);">${fmtCur(parseFloat(segment.dataset.value || '0'))} (${segment.dataset.pct || ''}%)</div>
      `, tooltip);
      tooltip.classList.remove('hidden');
    };

    el._chartMoveHandler = (e: Event) => {
      const target = e.target as Element;
      const segment = target.closest('path[data-idx], circle[data-idx]');
      if (!segment) return;
      const mouseEvent = e as MouseEvent;
      tooltip.style.left = (mouseEvent.clientX + 12) + 'px';
      tooltip.style.top = (mouseEvent.clientY - 10) + 'px';
    };

    el._chartLeaveHandler = (e: Event) => {
      const target = e.target as Element;
      const segment = target.closest('path[data-idx], circle[data-idx]') as HTMLElement | null;
      if (!segment) return;
      segment.style.opacity = '0.85';
      tooltip.classList.add('hidden');
    };

    el._chartClickHandler = (e: Event) => {
      const target = e.target as Element;
      const segment = target.closest('path[data-idx], circle[data-idx]') as HTMLElement | null;
      if (!segment || !segment.dataset.cat) return;
      const catId = segment.dataset.cat;
      const catInfo = getCatInfo('expense', catId) as CategoryChild;
      const catName = catInfo ? catInfo.name : catId;
      const catColor = catInfo ? catInfo.color : 'var(--color-accent)';
      renderCategoryTrendChart(catId, catName, catColor);
    };

    el.addEventListener('mouseenter', el._chartHandler, true);
    el.addEventListener('mousemove', el._chartMoveHandler, true);
    el.addEventListener('mouseleave', el._chartLeaveHandler, true);
    el.addEventListener('click', el._chartClickHandler, true);
  }
}

// ==========================================
// BAR CHART
// ==========================================

/**
 * Render bar chart comparing budget vs actual
 */
export function renderBarChart(containerId: string, labels: string[], datasets: BarChartDataset[]): void {
  const el = DOM.get(containerId) as ChartElement | null;
  if (!el) return;
  const maxVal = Math.max(...datasets.flatMap(ds => ds.data), 1);
  const w = 500, h = 250, padL = 55, padB = 80, padT = 25, padR = 15;
  const chartW = w - padL - padR, chartH = h - padT - padB;
  const groupW = chartW / labels.length;
  const barW = Math.min(24, (groupW - 8) / datasets.length);

  let svg = `<svg viewBox="0 0 ${w} ${h}" class="w-full" role="img" aria-label="Budget vs actual spending comparison">`;
  svg += `<title>Budget vs Actual</title>`;
  svg += `<desc>Bar chart comparing budgeted amounts to actual spending across ${labels.length} categories</desc>`;

  // Y-axis gridlines and labels
  const steps = 4;
  for (let i = 0; i <= steps; i++) {
    const val = (maxVal / steps) * i;
    const y = padT + chartH - (i / steps) * chartH;
    svg += `<line x1="${padL}" y1="${y}" x2="${w-padR}" y2="${y}" stroke="var(--border-input)" stroke-width="0.5" opacity="0.5"/>`;
    svg += `<text x="${padL-6}" y="${y+3}" text-anchor="end" fill="var(--text-tertiary)" font-size="9">${fmtShort(val)}</text>`;
  }

  // Bars with value labels
  labels.forEach((label, i) => {
    const gx = padL + i * groupW + (groupW - barW * datasets.length - (datasets.length-1)*3) / 2;
    datasets.forEach((ds, di) => {
      const val = ds.data[i];
      const bh = Math.max((val / maxVal) * chartH, val > 0 ? 2 : 0);
      const bx = gx + di * (barW + 3);
      const by = padT + chartH - bh;
      svg += `<rect x="${bx}" y="${by}" width="${barW}" height="${bh}" rx="3" fill="${ds.color}" opacity="0.85" data-label="${ds.label}" data-month="${label}" data-value="${val}" style="cursor:pointer;transition:opacity 0.15s;"/>`;
      if (val > 0) svg += `<text x="${bx + barW/2}" y="${by - 4}" text-anchor="middle" fill="${ds.color}" font-size="8" font-weight="700">${fmtShort(val)}</text>`;
    });
    const lx = padL + i * groupW + groupW/2, ly = padT + chartH + 14;
    svg += `<text x="${lx}" y="${ly}" text-anchor="end" transform="rotate(-45 ${lx} ${ly})" fill="var(--text-secondary)" font-size="10">${label}</text>`;
  });

  svg += '</svg>';

  render(html`
    ${unsafeSVG(svg)}
    ${datasets.length > 1 ? html`
      <div class="flex gap-4 justify-center mt-1">
        ${datasets.map(ds => html`
          <div class="flex items-center gap-1 text-xs">
            <span class="w-3 h-3 rounded-sm" style="background:${ds.color};opacity:0.85;"></span>
            <span style="color:var(--text-secondary);">${ds.label}</span>
          </div>
        `)}
      </div>
    ` : ''}
  `, el);

  // Add tooltip interactions to bars with proper cleanup
  const tooltip = DOM.get('chart-tooltip') as HTMLElement | null;
  const svgEl = el.querySelector('svg');
  if (svgEl && tooltip) {
    // Remove old event listeners before adding new ones
    cleanupChartListeners(el);
    el._barChartHandlers = [];

    svgEl.querySelectorAll<HTMLElement>('rect[data-value]').forEach(bar => {
      const enterHandler = () => {
        bar.style.opacity = '1';
        render(html`
          <div class="font-bold" style="color:var(--text-primary);">${bar.dataset.label || ''}</div>
          <div style="color:var(--text-secondary);">${bar.dataset.month || ''}: ${fmtCur(parseFloat(bar.dataset.value || '0'))}</div>
        `, tooltip);
        tooltip.classList.remove('hidden');
      };
      const moveHandler = (e: Event) => {
        const mouseEvent = e as MouseEvent;
        tooltip.style.left = (mouseEvent.clientX + 12) + 'px';
        tooltip.style.top = (mouseEvent.clientY - 10) + 'px';
      };
      const leaveHandler = () => {
        bar.style.opacity = '0.85';
        tooltip.classList.add('hidden');
      };

      bar.addEventListener('mouseenter', enterHandler);
      bar.addEventListener('mousemove', moveHandler);
      bar.addEventListener('mouseleave', leaveHandler);

      // Store handlers for cleanup
      el._barChartHandlers!.push(
        { element: bar, type: 'mouseenter', handler: enterHandler },
        { element: bar, type: 'mousemove', handler: moveHandler },
        { element: bar, type: 'mouseleave', handler: leaveHandler }
      );
    });
  }
}

// ==========================================
// TREND CHART
// ==========================================

/**
 * Render trend line chart showing income vs expenses over time
 */
export function renderTrendChart(containerId: string, monthCount: number = trendChartMonths): void {
  const el = DOM.get(containerId) as ChartElement | null;
  if (!el) return;
  const now = new Date();
  const months: string[] = [];
  for (let i = monthCount - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(getMonthKey(d));
  }
  const incVals = months.map(mk => getEffectiveIncome(mk));
  const expVals = months.map(mk => sumByType(getMonthTx(mk), 'expense'));
  const maxVal = Math.max(...incVals, ...expVals, 1);
  const w = 500, h = 220, padL = 55, padB = 45, padT = 20, padR = 15;
  const chartW = w - padL - padR, chartH = h - padT - padB;
  const step = chartW / (months.length - 1 || 1);
  const labels = months.map(mk => { const d = parseMonthKey(mk); return d.toLocaleDateString('en-US', { month: 'short' }); });

  const toPoints = (vals: number[]): string[] => vals.map((v, i) => {
    const x = padL + i * step;
    const y = padT + chartH - (v / maxVal) * chartH;
    return `${x},${y}`;
  });
  const incPts = toPoints(incVals);
  const expPts = toPoints(expVals);

  let svg = `<svg viewBox="0 0 ${w} ${h}" class="w-full" role="img" aria-label="Income and expense trends over time">`;
  svg += `<title>Trend Chart</title>`;
  svg += `<desc>Line chart showing ${monthCount}-month trend of income and expenses</desc>`;
  svg += `<defs><linearGradient id="tg-inc" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="var(--color-income)" stop-opacity="0.15"/><stop offset="100%" stop-color="var(--color-income)" stop-opacity="0"/></linearGradient>`;
  svg += `<linearGradient id="tg-exp" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="var(--color-expense)" stop-opacity="0.15"/><stop offset="100%" stop-color="var(--color-expense)" stop-opacity="0"/></linearGradient></defs>`;

  // Y-axis gridlines and labels
  const steps = 4;
  for (let i = 0; i <= steps; i++) {
    const val = (maxVal / steps) * i;
    const y = padT + chartH - (i / steps) * chartH;
    svg += `<line x1="${padL}" y1="${y}" x2="${w-padR}" y2="${y}" stroke="var(--border-input)" stroke-width="0.5" opacity="0.4"/>`;
    svg += `<text x="${padL-6}" y="${y+3}" text-anchor="end" fill="var(--text-tertiary)" font-size="9">${fmtShort(val)}</text>`;
  }

  // Area fills
  const baseY = padT + chartH;
  svg += `<polygon points="${incPts.join(' ')} ${padL+(months.length-1)*step},${baseY} ${padL},${baseY}" fill="url(#tg-inc)"/>`;
  svg += `<polygon points="${expPts.join(' ')} ${padL+(months.length-1)*step},${baseY} ${padL},${baseY}" fill="url(#tg-exp)"/>`;

  // Lines
  svg += `<polyline points="${incPts.join(' ')}" fill="none" stroke="var(--color-income)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`;
  svg += `<polyline points="${expPts.join(' ')}" fill="none" stroke="var(--color-expense)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`;

  // Forecast projection for current month (if mid-month)
  const currentMonthKey = getMonthKey(now);
  const lastMonthIdx = months.indexOf(currentMonthKey);
  if (lastMonthIdx >= 0 && now.getDate() < 28 && calcVelocityFn) {
    const velocity = calcVelocityFn() as VelocityData;
    const projectedExp = velocity.projected;
    const actualExp = expVals[lastMonthIdx];

    if (projectedExp > actualExp * 1.05) { // Only show if projection differs by >5%
      const [lastX, lastY] = expPts[lastMonthIdx].split(',').map(parseFloat);
      const projY = padT + chartH - (Math.min(projectedExp, maxVal * 1.2) / maxVal) * chartH;

      // Dotted projection line
      svg += `<line x1="${lastX}" y1="${lastY}" x2="${lastX + step * 0.4}" y2="${projY}" stroke="var(--color-warning)" stroke-width="2" stroke-dasharray="4,3" opacity="0.8"/>`;

      // Projection point
      svg += `<circle cx="${lastX + step * 0.4}" cy="${projY}" r="3" fill="var(--color-warning)" stroke="var(--bg-primary)" stroke-width="1"/>`;

      // Projection label
      svg += `<text x="${lastX + step * 0.4 + 4}" y="${projY + 3}" text-anchor="start" fill="var(--color-warning)" font-size="8" font-weight="600">→${fmtShort(projectedExp)}</text>`;
    }
  }

  // Data points with values (interactive)
  incVals.forEach((v, i) => {
    const [x, y] = incPts[i].split(',');
    // Visible data point
    svg += `<circle cx="${x}" cy="${y}" r="3.5" fill="var(--color-income)" stroke="var(--bg-primary)" stroke-width="1.5"/>`;
    if (v > 0) svg += `<text x="${x}" y="${parseFloat(y)-8}" text-anchor="middle" fill="var(--color-income)" font-size="8" font-weight="700">${fmtShort(v)}</text>`;
    // Larger invisible hitbox for interaction
    svg += `<circle class="trend-point" cx="${x}" cy="${y}" r="12" fill="transparent" style="cursor:pointer;" data-month="${months[i]}" data-income="${v}" data-expense="${expVals[i]}" data-label="${labels[i]}"/>`;
  });
  expVals.forEach((v, i) => {
    const [x, y] = expPts[i].split(',');
    svg += `<circle cx="${x}" cy="${y}" r="3.5" fill="var(--color-expense)" stroke="var(--bg-primary)" stroke-width="1.5"/>`;
    if (v > 0) svg += `<text x="${x}" y="${parseFloat(y)+14}" text-anchor="middle" fill="var(--color-expense)" font-size="8" font-weight="700">${fmtShort(v)}</text>`;
    // Larger invisible hitbox for interaction
    svg += `<circle class="trend-point" cx="${x}" cy="${y}" r="12" fill="transparent" style="cursor:pointer;" data-month="${months[i]}" data-income="${incVals[i]}" data-expense="${v}" data-label="${labels[i]}"/>`;
  });

  // X-axis month labels
  labels.forEach((lbl, i) => {
    svg += `<text x="${padL + i*step}" y="${baseY + 14}" text-anchor="middle" fill="var(--text-secondary)" font-size="10">${lbl}</text>`;
  });
  svg += '</svg>';

  render(html`
    ${unsafeSVG(svg)}
    <div class="flex gap-4 justify-center mt-1">
      <div class="flex items-center gap-1 text-xs">
        <span class="w-3 h-3 rounded-full" style="background:var(--color-income);"></span>
        <span style="color:var(--text-secondary);">Income</span>
      </div>
      <div class="flex items-center gap-1 text-xs">
        <span class="w-3 h-3 rounded-full" style="background:var(--color-expense);"></span>
        <span style="color:var(--text-secondary);">Expenses</span>
      </div>
    </div>
  `, el);

  // Add interactivity after rendering with proper cleanup
  const tooltip = DOM.get('chart-tooltip') as HTMLElement | null;
  if (tooltip) {
    // Remove old event listeners before adding new ones
    cleanupChartListeners(el);
    el._trendChartHandlers = [];

    el.querySelectorAll<SVGElement>('.trend-point').forEach(pt => {
      const enterHandler = (e: Event) => {
        const target = e.target as SVGElement;
        const { label, income, expense } = target.dataset;
        render(html`
          <div class="font-bold" style="color:var(--text-primary);">${label || ''}</div>
          <div style="color:var(--color-income);">Income: ${fmtCur(parseFloat(income || '0'))}</div>
          <div style="color:var(--color-expense);">Expenses: ${fmtCur(parseFloat(expense || '0'))}</div>
          <div class="text-xs mt-1" style="color:var(--text-tertiary);">Click to view month</div>
        `, tooltip);
        const mouseEvent = e as MouseEvent;
        tooltip.style.left = mouseEvent.pageX + 10 + 'px';
        tooltip.style.top = mouseEvent.pageY - 10 + 'px';
        tooltip.classList.remove('hidden');
      };
      const leaveHandler = () => {
        tooltip.classList.add('hidden');
      };
      const clickHandler = (e: Event) => {
        const target = e.target as SVGElement;
        const month = target.dataset.month;
        if (month && month !== signals.currentMonth.value) {
          navigation.setCurrentMonth(month);
          showToast(`Viewing ${monthLabelFn(month)}`);
        }
        tooltip.classList.add('hidden');
      };

      pt.addEventListener('mouseenter', enterHandler as EventListener);
      pt.addEventListener('mouseleave', leaveHandler);
      pt.addEventListener('click', clickHandler as EventListener);

      // Store handlers for cleanup
      el._trendChartHandlers!.push(
        { element: pt as unknown as HTMLElement, type: 'mouseenter', handler: enterHandler as EventListener },
        { element: pt as unknown as HTMLElement, type: 'mouseleave', handler: leaveHandler },
        { element: pt as unknown as HTMLElement, type: 'click', handler: clickHandler as EventListener }
      );
    });
  }
}

// ==========================================
// CATEGORY TREND CHART
// ==========================================

/**
 * Render mini trend chart for a specific category
 */
export function renderCategoryTrendChart(categoryId: string, categoryName: string, categoryColor: string): void {
  const section = DOM.get('category-trend-section') as HTMLElement | null;
  const titleEl = DOM.get('category-trend-title') as HTMLElement | null;
  const chartEl = DOM.get('category-trend-chart') as HTMLElement | null;
  if (!section || !chartEl) return;

  // Collect 6 months of data for this category
  const now = new Date();
  const months: string[] = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(getMonthKey(d));
  }
  const vals = months.map(mk => getMonthExpByCat(categoryId, mk));
  const maxVal = Math.max(...vals, 1);
  const labels = months.map(mk => { const d = parseMonthKey(mk); return d.toLocaleDateString('en-US', { month: 'short' }); });

  // Build SVG mini-chart
  const w = 280, h = 120, padL = 40, padB = 25, padT = 15, padR = 10;
  const chartW = w - padL - padR, chartH = h - padT - padB;
  const step = chartW / (months.length - 1 || 1);

  const toPoints = (v: number, i: number): string => {
    const x = padL + i * step;
    const y = padT + chartH - (v / maxVal) * chartH;
    return `${x},${y}`;
  };
  const pts = vals.map(toPoints);

  let svg = `<svg viewBox="0 0 ${w} ${h}" class="w-full" role="img" aria-label="6-month spending trend for ${categoryName}">`;
  svg += `<title>${categoryName} Trend</title>`;
  svg += `<desc>Line chart showing spending in ${categoryName} over the last 6 months</desc>`;
  // Area fill
  const baseY = padT + chartH;
  svg += `<defs><linearGradient id="cat-grad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${categoryColor}" stop-opacity="0.25"/><stop offset="100%" stop-color="${categoryColor}" stop-opacity="0"/></linearGradient></defs>`;
  svg += `<polygon points="${pts.join(' ')} ${padL+(months.length-1)*step},${baseY} ${padL},${baseY}" fill="url(#cat-grad)"/>`;
  // Line
  svg += `<polyline points="${pts.join(' ')}" fill="none" stroke="${categoryColor}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
  // Data points
  vals.forEach((v, i) => {
    const [x, y] = pts[i].split(',');
    svg += `<circle cx="${x}" cy="${y}" r="3" fill="${categoryColor}" stroke="var(--bg-primary)" stroke-width="1"/>`;
    if (v > 0) svg += `<text x="${x}" y="${parseFloat(y)-6}" text-anchor="middle" fill="${categoryColor}" font-size="8" font-weight="600">${fmtShort(v)}</text>`;
  });
  // X-axis labels
  labels.forEach((lbl, i) => {
    svg += `<text x="${padL + i*step}" y="${baseY + 12}" text-anchor="middle" fill="var(--text-tertiary)" font-size="8">${lbl}</text>`;
  });
  svg += '</svg>';

  // Calculate trend
  const first = vals[0], last = vals[vals.length - 1];
  let trendText = '';
  if (first > 0 && last > 0) {
    const change = Math.round(((last - first) / first) * 100);
    trendText = change > 0 ? `↑ ${change}% from 6 months ago` : change < 0 ? `↓ ${Math.abs(change)}% from 6 months ago` : 'Stable over 6 months';
  }

  if (titleEl) render(html`📈 ${categoryName} <span class="font-normal" style="color:var(--text-tertiary);">${trendText}</span>`, titleEl);
  render(unsafeSVG(svg), chartEl);
  section.classList.remove('hidden');
}

/**
 * Hide the category trend chart section
 */
export function hideCategoryTrendChart(): void {
  const section = DOM.get('category-trend-section') as HTMLElement | null;
  if (section) section.classList.add('hidden');
}

// ==========================================
// RECURRING BREAKDOWN CHART
// ==========================================

/**
 * Render recurring vs variable expense breakdown
 */
export function renderRecurringBreakdown(): void {
  const el = DOM.get('recurring-breakdown-chart') as HTMLElement | null;
  if (!el) return;
  const badgeEl = DOM.get('recurring-breakdown-badge');
  if (badgeEl) render(unsafeHTML(getMonthBadge()), badgeEl);

  const monthTx = getMonthTx() as Transaction[];
  const expenses = monthTx.filter(t => t.type === 'expense');

  // Split into recurring and variable
  const recurring = expenses.filter(t => t.recurring === true);
  const variable = expenses.filter(t => !t.recurring);

  // Use integer math (cents) to avoid floating-point errors
  const recurringTotalCents = recurring.reduce((s, t) => s + toCents(t.amount), 0);
  const variableTotalCents = variable.reduce((s, t) => s + toCents(t.amount), 0);
  const recurringTotal = toDollars(recurringTotalCents);
  const variableTotal = toDollars(variableTotalCents);
  const total = toDollars(recurringTotalCents + variableTotalCents);

  if (total === 0) {
    render(html`<p class="text-center py-4 text-sm" style="color: var(--text-tertiary);">No expenses this month</p>`, el);
    return;
  }

  const recurringPct = Math.round((recurringTotal / total) * 100);
  const variablePct = 100 - recurringPct;

  // Calculate income percentage locked in recurring
  const income = getEffectiveIncome(signals.currentMonth.value);
  const lockedPct = income > 0 ? Math.round((recurringTotal / income) * 100) : 0;
  const lockedColor = lockedPct > 50 ? 'var(--color-expense)' : lockedPct > 30 ? 'var(--color-warning)' : 'var(--color-income)';

  render(html`
    <div class="mb-4" role="img" aria-label="Spending breakdown: ${recurringPct}% recurring, ${variablePct}% variable">
      <div class="flex h-6 rounded-lg overflow-hidden" style="background: var(--bg-input);">
        <div style="width: ${recurringPct}%; background: var(--color-purple);" class="flex items-center justify-center text-xs font-bold text-white" aria-hidden="true">${recurringPct > 10 ? recurringPct + '%' : ''}</div>
        <div style="width: ${variablePct}%; background: var(--color-accent2);" class="flex items-center justify-center text-xs font-bold text-white" aria-hidden="true">${variablePct > 10 ? variablePct + '%' : ''}</div>
      </div>
    </div>
    <div class="grid grid-cols-2 gap-4">
      <div class="p-3 rounded-lg" style="background: color-mix(in srgb, var(--color-purple) 15%, transparent);">
        <div class="flex items-center gap-2 mb-1">
          <span class="w-3 h-3 rounded-full" style="background: var(--color-purple);"></span>
          <span class="text-xs font-bold" style="color: var(--text-secondary);">RECURRING</span>
        </div>
        <p class="text-lg font-black" style="color: var(--color-purple);">${fmtCur(recurringTotal)}</p>
        <p class="text-xs" style="color: var(--text-tertiary);">${recurring.length} transaction${recurring.length !== 1 ? 's' : ''}</p>
      </div>
      <div class="p-3 rounded-lg" style="background: color-mix(in srgb, var(--color-accent2) 15%, transparent);">
        <div class="flex items-center gap-2 mb-1">
          <span class="w-3 h-3 rounded-full" style="background: var(--color-accent2);"></span>
          <span class="text-xs font-bold" style="color: var(--text-secondary);">VARIABLE</span>
        </div>
        <p class="text-lg font-black" style="color: var(--color-accent2);">${fmtCur(variableTotal)}</p>
        <p class="text-xs" style="color: var(--text-tertiary);">${variable.length} transaction${variable.length !== 1 ? 's' : ''}</p>
      </div>
    </div>
    ${income > 0 && recurringTotal > 0 ? html`
      <div class="mt-4 p-3 rounded-lg text-center" style="background: var(--bg-input);">
        <p class="text-xs" style="color: var(--text-secondary);">Income locked in recurring expenses</p>
        <p class="text-xl font-black" style="color: ${lockedColor};">${lockedPct}%</p>
      </div>
    ` : ''}
  `, el);
}
