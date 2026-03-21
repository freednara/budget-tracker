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
import { getMonthTx, getEffectiveIncome } from '../../features/financial/calculations.js';
import { getMonthKey, parseMonthKey, toCents, toDollars, sumByType, esc, escAttr } from '../../core/utils.js';
import { html, render, svg, repeat } from '../../core/lit-helpers.js';
import { getCatInfo } from '../../core/categories.js';
import { isTrackedExpenseTransaction } from '../../core/transaction-classification.js';
import { getMonthBadge } from '../widgets/calendar.js';
// Event-bus no longer needed here: navigation.goToMonth handles event emission
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
 * Pre-calculate chart data with percentages to optimize rendering
 */
interface ProcessedDonutData extends DonutChartData {
  percentage: number;
  percentageStr: string;
  startAngle: number;
  endAngle: number;
}

/**
 * Process donut chart data to fix floating-point precision issues
 */
function processDonutData(data: DonutChartData[], total: number): ProcessedDonutData[] {
  const processed: ProcessedDonutData[] = [];
  let currentAngle = -Math.PI / 2; // Start at top
  
  data.forEach((d, idx) => {
    const percentage = d.value / total;
    const percentageStr = (percentage * 100).toFixed(1);
    const startAngle = currentAngle;
    // For last segment, ensure it connects perfectly to start
    const endAngle = idx === data.length - 1 
      ? -Math.PI / 2 + Math.PI * 2 
      : currentAngle + percentage * 2 * Math.PI;
    
    processed.push({
      ...d,
      percentage,
      percentageStr,
      startAngle,
      endAngle
    });
    
    currentAngle = endAngle; // Use exact end angle for next segment
  });
  
  return processed;
}

/**
 * Render donut chart segment using secure SVG template
 */
function renderDonutSegment(
  d: ProcessedDonutData, 
  idx: number, 
  cx: number, 
  cy: number, 
  r: number, 
  ir: number,
  onEnter: (e: Event) => void,
  onMove: (e: Event) => void,
  onLeave: (e: Event) => void,
  onClick: (e: Event) => void
) {
  // Handle full circle (single category with 100%)
  if (d.percentage >= 0.9999) {
    return svg`
      <g role="img" tabindex="0" 
        aria-label="${d.label}: ${fmtCur(d.value)} (${d.percentageStr}%)"
        @mouseenter=${onEnter}
        @mousemove=${onMove}
        @mouseleave=${onLeave}
        @click=${onClick}
        @keydown=${(e: KeyboardEvent) => e.key === 'Enter' && onClick(e)}
        data-idx="${idx}" 
        data-label="${d.label}" 
        data-value="${d.value}" 
        data-pct="${d.percentageStr}" 
        data-cat="${d.catId || ''}"
        style="cursor: pointer; outline: none;">
        <circle
          cx="${cx}"
          cy="${cy}"
          r="${(r + ir) / 2}"
          fill="none"
          stroke="${d.color}"
          stroke-width="${r - ir}"
          opacity="0.85"
          style="transition: opacity 0.15s;"
        />
      </g>
    `;
  }
  
  // Calculate path points using exact angles
  const large = d.percentage > 0.5 ? 1 : 0;
  const x1o = cx + r * Math.cos(d.startAngle);
  const y1o = cy + r * Math.sin(d.startAngle);
  const x2o = cx + r * Math.cos(d.endAngle);
  const y2o = cy + r * Math.sin(d.endAngle);
  const x1i = cx + ir * Math.cos(d.endAngle);
  const y1i = cy + ir * Math.sin(d.endAngle);
  const x2i = cx + ir * Math.cos(d.startAngle);
  const y2i = cy + ir * Math.sin(d.startAngle);
  
  return svg`
    <g role="img" tabindex="0" 
      aria-label="${d.label}: ${fmtCur(d.value)} (${d.percentageStr}%)"
      @mouseenter=${onEnter}
      @mousemove=${onMove}
      @mouseleave=${onLeave}
      @click=${onClick}
      @keydown=${(e: KeyboardEvent) => e.key === 'Enter' && onClick(e)}
      data-idx="${idx}" 
      data-label="${d.label}" 
      data-value="${d.value}" 
      data-pct="${d.percentageStr}" 
      data-cat="${d.catId || ''}"
      style="cursor: pointer; outline: none;">
      <path 
        d="M${x1o},${y1o} A${r},${r} 0 ${large},1 ${x2o},${y2o} L${x1i},${y1i} A${ir},${ir} 0 ${large},0 ${x2i},${y2i} Z" 
        fill="${d.color}" 
        opacity="0.85"
        style="transition: opacity 0.15s;"
      />
    </g>
  `;
}

/**
 * Render donut chart showing category breakdown
 */
export function renderDonutChart(containerId: string, data: DonutChartData[], trends: Record<string, CategoryTrendChange> = {}): void {
  const el = DOM.get(containerId) as ChartElement | null;
  if (!el) return;
  
  const noDataTemplate = html`
    <p class="text-xs text-center py-8" style="color: var(--text-tertiary);">
      No expense data yet
    </p>
  `;
  
  if (!data.length) {
    render(noDataTemplate, el);
    return;
  }
  
  const total = data.reduce((s, d) => s + d.value, 0);
  if (total === 0) {
    render(noDataTemplate, el);
    return;
  }
  
  const cx = 90, cy = 90, r = 70, ir = 42;
  const processedData = processDonutData(data, total);
  const tooltip = DOM.get('chart-tooltip') as HTMLElement | null;
  
  // Event handlers for segments
  const handleSegmentEnter = (d: ProcessedDonutData) => (e: Event) => {
    const target = e.currentTarget as SVGGElement;
    const path = target.querySelector('path, circle') as SVGElement;
    if (path) path.style.opacity = '1';
    
    if (tooltip) {
      render(html`
        <div class="font-bold" style="color:var(--text-primary);">${d.label}</div>
        <div style="color:var(--text-secondary);">
          ${fmtCur(d.value)} (${d.percentageStr}%)
        </div>
      `, tooltip);
      tooltip.classList.remove('hidden');
    }
  };
  
  const handleSegmentMove = (e: Event) => {
    if (tooltip) {
      const mouseEvent = e as MouseEvent;
      const x = mouseEvent.clientX;
      const y = mouseEvent.clientY;
      requestAnimationFrame(() => {
        tooltip.style.left = (x + 12) + 'px';
        tooltip.style.top = (y - 10) + 'px';
      });
    }
  };
  
  const handleSegmentLeave = (e: Event) => {
    const target = e.currentTarget as SVGGElement;
    const path = target.querySelector('path, circle') as SVGElement;
    if (path) path.style.opacity = '0.85';
    if (tooltip) tooltip.classList.add('hidden');
  };
  
  const handleSegmentClick = (d: ProcessedDonutData) => (e: Event) => {
    if (!d.catId) return;
    const catInfo = getCatInfo('expense', d.catId) as CategoryChild;
    const catName = catInfo ? catInfo.name : d.catId;
    const catColor = catInfo ? catInfo.color : 'var(--color-accent)';
    renderCategoryTrendChart(d.catId, catName, catColor);
  };
  
  render(html`
    <div class="flex items-start gap-4">
      <svg viewBox="0 0 180 180" class="shrink-0" style="width:140px;height:140px;" 
        role="img" aria-label="Expense breakdown by category">
        <title>Category Breakdown</title>
        <desc>Donut chart showing ${data.length} expense categories totaling ${fmtCur(total)}</desc>
        ${repeat(
          processedData,
          d => d.catId || d.label,
          (d, idx) => renderDonutSegment(
            d, idx, cx, cy, r, ir,
            handleSegmentEnter(d),
            handleSegmentMove,
            handleSegmentLeave,
            handleSegmentClick(d)
          )
        )}
        <text x="${cx}" y="${cy - 4}" text-anchor="middle" fill="var(--text-tertiary)" font-size="10">
          Total
        </text>
        <text x="${cx}" y="${cy + 12}" text-anchor="middle" fill="var(--text-primary)" 
          font-size="15" font-weight="800">
          ${fmtCur(total)}
        </text>
      </svg>
      
      <div class="flex-1 space-y-2 pt-1">
        ${data.map(d => {
          const pct = (d.value / total * 100).toFixed(0);
          const trend = d.catId && trends[d.catId];
          let trendArrow = '';
          let trendColor = 'var(--text-tertiary)';
          if (trend) {
            trendArrow = trend.direction === 'up' ? '↑' : trend.direction === 'down' ? '↓' : '';
            trendColor = trend.direction === 'up' ? 'var(--color-expense)' : 
                        trend.direction === 'down' ? 'var(--color-income)' : 'var(--text-tertiary)';
          }
          return html`
            <div class="flex items-center gap-2 text-xs">
              <span class="w-3 h-3 rounded-full shrink-0" style="background:${d.color};"></span>
              <span class="flex-1" style="color:var(--text-secondary);">${d.label}</span>
              <span class="font-bold text-right" style="color:var(--text-primary); min-width: 70px;">
                ${fmtCur(d.value)}
              </span>
              <span class="text-right" style="color:var(--text-tertiary); min-width: 32px;">
                ${pct}%
              </span>
              <span class="text-right" style="min-width: 42px;">
                ${trend && trendArrow ? html`
                  <span style="color:${trendColor};" title="vs last month">
                    ${trendArrow}${Math.abs(trend.change)}%
                  </span>
                ` : ''}
              </span>
            </div>
          `;
        })}
      </div>
    </div>
  `, el);
}

// ==========================================
// BAR CHART
// ==========================================

/**
 * Render bar chart comparing budget vs actual using secure SVG templates
 */
export function renderBarChart(containerId: string, labels: string[], datasets: BarChartDataset[]): void {
  const el = DOM.get(containerId) as ChartElement | null;
  if (!el) return;
  
  const maxVal = Math.max(...datasets.flatMap(ds => ds.data), 1);
  const w = 500, h = 250, padL = 55, padB = 80, padT = 25, padR = 15;
  const chartW = w - padL - padR, chartH = h - padT - padB;
  const groupW = chartW / labels.length;
  const barW = Math.min(24, (groupW - 8) / datasets.length);
  const tooltip = DOM.get('chart-tooltip') as HTMLElement | null;
  
  // Event handlers for bars
  const handleBarEnter = (ds: BarChartDataset, label: string, value: number) => (e: Event) => {
    const target = e.currentTarget as SVGRectElement;
    target.style.opacity = '1';
    
    if (tooltip) {
      render(html`
        <div class="font-bold" style="color:var(--text-primary);">${ds.label}</div>
        <div style="color:var(--text-secondary);">${label}: ${fmtCur(value)}</div>
      `, tooltip);
      tooltip.classList.remove('hidden');
    }
  };
  
  const handleBarMove = (e: Event) => {
    if (tooltip) {
      const mouseEvent = e as MouseEvent;
      const x = mouseEvent.clientX;
      const y = mouseEvent.clientY;
      requestAnimationFrame(() => {
        tooltip.style.left = (x + 12) + 'px';
        tooltip.style.top = (y - 10) + 'px';
      });
    }
  };
  
  const handleBarLeave = (e: Event) => {
    const target = e.currentTarget as SVGRectElement;
    target.style.opacity = '0.85';
    if (tooltip) tooltip.classList.add('hidden');
  };
  
  render(html`
    <svg viewBox="0 0 ${w} ${h}" class="w-full" 
      role="img" aria-label="Budget vs actual spending comparison">
      <title>Budget vs Actual</title>
      <desc>Bar chart comparing budgeted amounts to actual spending across ${labels.length} categories</desc>
      
      <!-- Y-axis gridlines and labels -->
      ${(() => {
        const steps = 4;
        const lines = [];
        for (let i = 0; i <= steps; i++) {
          const val = (maxVal / steps) * i;
          const y = padT + chartH - (i / steps) * chartH;
          lines.push(svg`
            <line x1="${padL}" y1="${y}" x2="${w - padR}" y2="${y}" 
              stroke="var(--border-input)" stroke-width="0.5" opacity="0.5"/>
            <text x="${padL - 6}" y="${y + 3}" text-anchor="end" 
              fill="var(--text-tertiary)" font-size="9">
              ${fmtShort(val)}
            </text>
          `);
        }
        return lines;
      })()}
      
      <!-- Bars with value labels -->
      ${labels.map((label, i) => {
        const gx = padL + i * groupW + (groupW - barW * datasets.length - (datasets.length - 1) * 3) / 2;
        return svg`
          <g>
            ${datasets.map((ds, di) => {
              const val = ds.data[i];
              const bh = Math.max((val / maxVal) * chartH, val > 0 ? 2 : 0);
              const bx = gx + di * (barW + 3);
              const by = padT + chartH - bh;
              
              return svg`
                <g role="img" tabindex="0"
                  aria-label="${ds.label} for ${label}: ${fmtCur(val)}">
                  <rect 
                    x="${bx}" 
                    y="${by}" 
                    width="${barW}" 
                    height="${bh}" 
                    rx="3" 
                    fill="${ds.color}" 
                    opacity="0.85"
                    style="cursor:pointer;transition:opacity 0.15s;"
                    @mouseenter=${handleBarEnter(ds, label, val)}
                    @mousemove=${handleBarMove}
                    @mouseleave=${handleBarLeave}
                    @keydown=${(e: KeyboardEvent) => {
                      if (e.key === 'Enter') handleBarEnter(ds, label, val)(e);
                    }}
                  />
                  ${val > 0 ? svg`
                    <text x="${bx + barW/2}" y="${by - 4}" text-anchor="middle" 
                      fill="${ds.color}" font-size="8" font-weight="700">
                      ${fmtShort(val)}
                    </text>
                  ` : ''}
                </g>
              `;
            })}
            
            <!-- X-axis label -->
            <text 
              x="${padL + i * groupW + groupW/2}" 
              y="${padT + chartH + 14}" 
              text-anchor="end" 
              transform="rotate(-45 ${padL + i * groupW + groupW/2} ${padT + chartH + 14})" 
              fill="var(--text-secondary)" 
              font-size="10">
              ${label}
            </text>
          </g>
        `;
      })}
    </svg>
    
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
}

// ==========================================
// TREND CHART
// ==========================================

/**
 * Render trend line chart showing income vs expenses over time using secure SVG templates
 */
export async function renderTrendChart(containerId: string, monthCount: number = trendChartMonths): Promise<void> {
  const el = DOM.get(containerId) as ChartElement | null;
  if (!el) return;

  const now = new Date();
  const months: string[] = [];
  for (let i = monthCount - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(getMonthKey(d));
  }

  const incVals = months.map(mk => getEffectiveIncome(mk));
  const monthTxArrays = months.map(mk => getMonthTx(mk));
  const expVals = monthTxArrays.map(txArr => toDollars(
    (txArr || []).reduce((sum: number, tx: Transaction) => (
      isTrackedExpenseTransaction(tx) ? sum + toCents(tx.amount) : sum
    ), 0)
  ));
  const maxVal = Math.max(...incVals, ...expVals, 1);
  const w = 500, h = 220, padL = 55, padB = 45, padT = 20, padR = 15;
  const chartW = w - padL - padR, chartH = h - padT - padB;
  const step = chartW / (months.length - 1 || 1);
  const labels = months.map(mk => { 
    const d = parseMonthKey(mk); 
    return d.toLocaleDateString('en-US', { month: 'short' }); 
  });
  const tooltip = DOM.get('chart-tooltip') as HTMLElement | null;
  
  const toPoints = (vals: number[]): string[] => vals.map((v, i) => {
    const x = padL + i * step;
    const y = padT + chartH - (v / maxVal) * chartH;
    return `${x},${y}`;
  });
  
  const incPts = toPoints(incVals);
  const expPts = toPoints(expVals);
  const baseY = padT + chartH;
  
  // Event handlers for trend points
  const handlePointEnter = (monthKey: string, income: number, expense: number, label: string) => (e: Event) => {
    if (tooltip) {
      const savings = income - expense;
      const savingsColor = savings >= 0 ? 'var(--color-income)' : 'var(--color-expense)';
      
      render(html`
        <div class="font-bold" style="color:var(--text-primary);">${label}</div>
        <div style="color:var(--text-secondary);">Income: ${fmtCur(income)}</div>
        <div style="color:var(--text-secondary);">Expenses: ${fmtCur(expense)}</div>
        <div style="color:${savingsColor};">
          ${savings >= 0 ? 'Saved' : 'Over'}: ${fmtCur(Math.abs(savings))}
        </div>
      `, tooltip);
      tooltip.classList.remove('hidden');
    }
  };
  
  const handlePointMove = (e: Event) => {
    if (tooltip) {
      const mouseEvent = e as MouseEvent;
      const x = mouseEvent.clientX;
      const y = mouseEvent.clientY;
      requestAnimationFrame(() => {
        tooltip.style.left = (x + 12) + 'px';
        tooltip.style.top = (y - 10) + 'px';
      });
    }
  };
  
  const handlePointLeave = () => {
    if (tooltip) tooltip.classList.add('hidden');
  };
  
  const handlePointClick = (monthKey: string) => (e: Event) => {
    // goToMonth -> setCurrentMonth already emits MONTH_CHANGED
    navigation.goToMonth(monthKey);
  };
  
  render(html`
    <svg viewBox="0 0 ${w} ${h}" class="w-full" 
      role="img" aria-label="Income and expense trends over time">
      <title>Trend Chart</title>
      <desc>Line chart showing ${monthCount}-month trend of income and expenses</desc>
      
      <defs>
        <linearGradient id="tg-inc" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--color-income)" stop-opacity="0.15"/>
          <stop offset="100%" stop-color="var(--color-income)" stop-opacity="0"/>
        </linearGradient>
        <linearGradient id="tg-exp" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--color-expense)" stop-opacity="0.15"/>
          <stop offset="100%" stop-color="var(--color-expense)" stop-opacity="0"/>
        </linearGradient>
      </defs>
      
      <!-- Y-axis gridlines and labels -->
      ${(() => {
        const steps = 4;
        const lines = [];
        for (let i = 0; i <= steps; i++) {
          const val = (maxVal / steps) * i;
          const y = padT + chartH - (i / steps) * chartH;
          lines.push(svg`
            <line x1="${padL}" y1="${y}" x2="${w - padR}" y2="${y}" 
              stroke="var(--border-input)" stroke-width="0.5" opacity="0.4"/>
            <text x="${padL - 6}" y="${y + 3}" text-anchor="end" 
              fill="var(--text-tertiary)" font-size="9">
              ${fmtShort(val)}
            </text>
          `);
        }
        return lines;
      })()}
      
      <!-- Area fills -->
      <polygon 
        points="${incPts.join(' ')} ${padL + (months.length - 1) * step},${baseY} ${padL},${baseY}" 
        fill="url(#tg-inc)"/>
      <polygon 
        points="${expPts.join(' ')} ${padL + (months.length - 1) * step},${baseY} ${padL},${baseY}" 
        fill="url(#tg-exp)"/>
      
      <!-- Lines -->
      <polyline 
        points="${incPts.join(' ')}" 
        fill="none" 
        stroke="var(--color-income)" 
        stroke-width="2.5" 
        stroke-linecap="round" 
        stroke-linejoin="round"/>
      <polyline 
        points="${expPts.join(' ')}" 
        fill="none" 
        stroke="var(--color-expense)" 
        stroke-width="2.5" 
        stroke-linecap="round" 
        stroke-linejoin="round"/>
      
      <!-- Forecast projection for current month -->
      ${(() => {
        const currentMonthKey = getMonthKey(now);
        const lastMonthIdx = months.indexOf(currentMonthKey);
        if (lastMonthIdx >= 0 && now.getDate() < 28 && calcVelocityFn) {
          const velocity = calcVelocityFn() as VelocityData;
          const projectedExp = velocity.projected;
          const actualExp = expVals[lastMonthIdx];
          
          if (projectedExp > actualExp * 1.05) {
            const [lastX, lastY] = expPts[lastMonthIdx].split(',').map(parseFloat);
            const projY = padT + chartH - (Math.min(projectedExp, maxVal * 1.2) / maxVal) * chartH;
            
            return svg`
              <g>
                <line 
                  x1="${lastX}" 
                  y1="${lastY}" 
                  x2="${lastX + step * 0.4}" 
                  y2="${projY}" 
                  stroke="var(--color-warning)" 
                  stroke-width="2" 
                  stroke-dasharray="4,3" 
                  opacity="0.8"/>
                <circle 
                  cx="${lastX + step * 0.4}" 
                  cy="${projY}" 
                  r="3" 
                  fill="var(--color-warning)" 
                  stroke="var(--bg-primary)" 
                  stroke-width="1"/>
                <text 
                  x="${lastX + step * 0.4 + 4}" 
                  y="${projY + 3}" 
                  text-anchor="start" 
                  fill="var(--color-warning)" 
                  font-size="8" 
                  font-weight="600">
                  →${fmtShort(projectedExp)}
                </text>
              </g>
            `;
          }
        }
        return '';
      })()}
      
      <!-- Data points with interactive areas -->
      ${months.map((monthKey, i) => {
        const [incX, incY] = incPts[i].split(',').map(parseFloat);
        const [expX, expY] = expPts[i].split(',').map(parseFloat);
        const income = incVals[i];
        const expense = expVals[i];
        const label = labels[i];
        
        return svg`
          <g>
            <!-- Income point -->
            <circle cx="${incX}" cy="${incY}" r="3.5" 
              fill="var(--color-income)" 
              stroke="var(--bg-primary)" 
              stroke-width="1.5"/>
            ${income > 0 ? svg`
              <text x="${incX}" y="${incY - 8}" text-anchor="middle" 
                fill="var(--color-income)" font-size="8" font-weight="700">
                ${fmtShort(income)}
              </text>
            ` : ''}
            
            <!-- Expense point -->
            <circle cx="${expX}" cy="${expY}" r="3.5" 
              fill="var(--color-expense)" 
              stroke="var(--bg-primary)" 
              stroke-width="1.5"/>
            ${expense > 0 ? svg`
              <text x="${expX}" y="${expY + 14}" text-anchor="middle" 
                fill="var(--color-expense)" font-size="8" font-weight="700">
                ${fmtShort(expense)}
              </text>
            ` : ''}
            
            <!-- Interactive hitbox (covers both points) -->
            <rect 
              x="${incX - 12}" 
              y="${Math.min(incY, expY) - 12}" 
              width="24" 
              height="${Math.abs(incY - expY) + 24}" 
              fill="transparent"
              style="cursor:pointer;"
              role="button"
              tabindex="0"
              aria-label="${label}: Income ${fmtCur(income)}, Expenses ${fmtCur(expense)}"
              @mouseenter=${handlePointEnter(monthKey, income, expense, label)}
              @mousemove=${handlePointMove}
              @mouseleave=${handlePointLeave}
              @click=${handlePointClick(monthKey)}
              @keydown=${(e: KeyboardEvent) => {
                if (e.key === 'Enter') handlePointClick(monthKey)(e);
              }}
            />
          </g>
        `;
      })}
      
      <!-- X-axis month labels -->
      ${labels.map((lbl, i) => svg`
        <text 
          x="${padL + i * step}" 
          y="${baseY + 14}" 
          text-anchor="middle" 
          fill="var(--text-secondary)" 
          font-size="10">
          ${lbl}
        </text>
      `)}
    </svg>
    
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
}

// ==========================================
// CATEGORY TREND CHART
// ==========================================

/**
 * Render category trend chart showing spending over time
 */
export function renderCategoryTrendChart(catId: string, catName: string, catColor: string): void {
  const section = DOM.get('category-trend-section');
  const el = DOM.get('category-trend-chart');
  const titleEl = DOM.get('category-trend-title');
  const closeBtn = DOM.get('close-category-trend');

  if (!section || !el) return;

  // Unhide the section
  section.classList.remove('hidden');

  if (titleEl) {
    titleEl.textContent = `📈 6-Month Trend: ${catName}`;
  }

  // Set up close button
  if (closeBtn) {
    // Clone to remove old listeners
    const newCloseBtn = closeBtn.cloneNode(true);
    closeBtn.parentNode?.replaceChild(newCloseBtn, closeBtn);
    newCloseBtn.addEventListener('click', () => {
      section.classList.add('hidden');
    });
  }

  // Get data for the last 6 months
  const months = 6;
  import('../../features/analytics/trend-analysis.js').then(({ calculateCategoryTrends }) => {
    const trendsResult = calculateCategoryTrends(months);

    const categoryData = trendsResult.trends.find((t: any) => (t.category?.id || t.categoryId) === catId);
    const dataPoints = categoryData ? categoryData.monthlyData : [];

    if (dataPoints.length === 0) {
      render(html`
        <div class="text-center py-6">
          <p class="text-sm text-tertiary">Not enough data to show a trend.</p>
        </div>
      `, el);
      return;
    }

    // Draw simple SVG bar chart
    const maxVal = Math.max(...dataPoints.map((d: any) => d.amount), 1);
    const barWidth = 100 / Math.max(dataPoints.length, 1);
    const padding = 2;

    render(html`
      <div class="w-full h-32 relative mt-2">
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" class="w-full h-full overflow-visible">
          ${dataPoints.map((d: any, i: number) => {
            const barH = (d.amount / maxVal) * 90; // max 90% height
            const x = i * barWidth + padding;
            const w = barWidth - padding * 2;
            const y = 100 - barH;

            return svg`
              <g class="group">
                <rect
                  x="${x}%" y="${y}%"
                  width="${w}%" height="${barH}%"
                  fill="${catColor}"
                  rx="2"
                  class="transition-all duration-300 opacity-80 group-hover:opacity-100 cursor-pointer"
                />
                <text
                  x="${x + w/2}%" y="${100}%"
                  dy="12"
                  text-anchor="middle"
                  fill="var(--text-tertiary)"
                  font-size="8"
                  class="opacity-0 group-hover:opacity-100 transition-opacity">
                  ${fmtShort(d.amount)}
                </text>
              </g>
            `;
          })}
        </svg>
      </div>
    `, el);
  });
  }// ==========================================
// BREAKDOWN CHART
// ==========================================

/**
 * Render breakdown chart showing subcategory details
 */
export function renderBreakdownChart(containerId: string, parentCategory: string, data: DonutChartData[]): void {
  // Delegate to donut chart with subcategory data
  renderDonutChart(containerId, data);
}

// ==========================================
// EXPORT
// ==========================================

export default {
  initChartRenderers,
  renderDonutChart,
  renderBarChart,
  renderTrendChart,
  renderCategoryTrendChart,
  renderBreakdownChart,
  setTrendChartMonths,
  getTrendChartMonths,
  fmtShort
};
