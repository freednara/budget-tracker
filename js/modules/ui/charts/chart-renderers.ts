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
import { getMonthKey, fmtCur, fmtShort } from '../../core/utils-pure.js';
import { html, render, svg, repeat } from '../../core/lit-helpers.js';
import { getCatInfo } from '../../core/categories.js';
import { formatMonthShort, formatViewedMonthLabel } from '../../core/locale-service.js';
// Phase 5g-1 (Inline-Behavior-Review rev 12, L16): removed
// `cleanupChartListeners` import — the function was dead (zero callers) and
// has been deleted from chart-utils.ts. Lit-html manages listener cleanup
// automatically when the template re-renders or the host element unmounts.
import DOM from '../../core/dom-cache.js';
// M6 (Inline-Behavior-Review rev 12): `loadAndCall` wraps lazy-chart dynamic
// imports so a failed `trend-analysis.js` chunk load surfaces in telemetry
// instead of leaving the trend panel blank forever.
import { loadAndCall } from '../../core/error-tracker.js';
import type {
  VelocityCalculator,
  ChartRendererCallbacks,
  DonutChartData,
  BarChartDataset,
  CategoryTrendChange,
  CategoryTrendData,
  CategoryMonthData
} from '../../../types/index.js';

// ==========================================
// CONFIGURABLE CALLBACKS
// ==========================================

// Configurable callbacks (set by app.js)
let calcVelocityFn: VelocityCalculator | null = null;

// Track current trend chart range (module-level state)
let trendChartMonths: number = 6;

// UI/UX Review Expanded: interactive legend toggle — hidden dataset labels
// per chart container. Keyed by containerId so independent charts maintain
// separate visibility state.
const _hiddenDatasets: Map<string, Set<string>> = new Map();

// REND-02: Guard against re-entrant renderBarChart calls from rapid legend clicks
const _renderPending: Set<string> = new Set();

/**
 * Initialize chart renderers with callback functions
 *
 * Note: the legacy `monthLabel` callback is no longer consumed by chart-renderers —
 * month labeling has been internalized via `formatMonthShort` from locale-service.
 * The slot remains in `ChartRendererCallbacks` for backwards compatibility with
 * callers that still pass it, but we intentionally ignore it here.
 */
export function initChartRenderers(callbacks: ChartRendererCallbacks): void {
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

// `fmtShort` is re-exported from `core/utils-pure.ts` so components (e.g.
// `weekly-rollup.ts`) can import it without crossing the components → ui
// architecture boundary. Keep exporting it here for backward compatibility
// with existing chart-layer imports.
export { fmtShort };

// Phase 5g-1 (Inline-Behavior-Review rev 12, L16): removed the local
// `ChartElement` interface. All seven handler-storage slots it declared
// had zero assignments in the codebase — listener wiring is handled by
// Lit's `@event=${...}` template bindings, which auto-detach on
// re-render/unmount. The three `as ChartElement | null` type casts below
// (donut, bar, trend) were replaced with plain `as HTMLElement | null`.

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

interface DashboardCategoryBreakdownStatus {
  label: 'Healthy' | 'Caution';
  tone: 'positive' | 'warning';
}

export function getDashboardCategoryBreakdownStatus(
  sharePercent: number,
  trend?: CategoryTrendChange | null
): DashboardCategoryBreakdownStatus | null {
  if (sharePercent >= 40) {
    return { label: 'Caution', tone: 'warning' };
  }

  if (!trend || trend.direction === 'new') {
    return null;
  }

  if (trend.direction === 'up') {
    // 7a (Inline-Behavior-Review, CategoryTrendChange nullable widening):
    // `trend.change` is now `number | null` after the producer was routed
    // through `computeBaselineDelta` — 'new' and 'no-data' baseline statuses
    // emit `change: null` rather than the fabricated `change: 100` /
    // `change: 0` sentinels. The 'new' case is short-circuited above at the
    // `trend.direction === 'new'` guard, but under strict null checks we
    // still need an explicit guard here because TS cannot narrow across
    // the discriminated-union boundary. A null `change` with direction
    // 'up' shouldn't occur in practice (producer guarantees non-null for
    // 'up'/'down'/'flat'), so null collapses to "no status signal".
    if (trend.change != null && trend.change >= 15) {
      return { label: 'Caution', tone: 'warning' };
    }

    if (sharePercent >= 25 && trend.change != null && trend.change > 0) {
      return { label: 'Caution', tone: 'warning' };
    }

    return null;
  }

  if ((trend.direction === 'down' || trend.direction === 'flat') && sharePercent < 40) {
    return { label: 'Healthy', tone: 'positive' };
  }

  return null;
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
 * Render donut chart segment using secure SVG template.
 *
 * Design-Review-Apr21 P2 (batch 6 follow-up wave P): the `isInteractive`
 * flag gates button semantics. In the full analytics donut, clicking a
 * segment opens that category's trend chart — legitimate button behavior.
 * In the dashboard snapshot (`#donut-chart-container`) the click handler
 * short-circuits with `if (isDashboardSnapshot) return`, so the segment
 * advertises a press target that does nothing. Keyboard + AT users
 * previously encountered a row of focusable "buttons" that announced
 * names, took focus, but fired no action on Enter/Space.
 *
 * When `isInteractive === false` we render `role="img"` with the same
 * aria-label (so the segment is still identifiable by screen readers
 * when users explore the SVG), and drop tabindex, @click, and @keydown.
 * Mouse handlers are retained so sighted users still get the tooltip on
 * hover. The cursor is set to `default` to remove the misleading
 * pointer.
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
  onClick: (e: Event) => void,
  isInteractive: boolean
) {
  const groupRole = isInteractive ? 'button' : 'img';
  const groupCursor = isInteractive ? 'pointer' : 'default';

  // Handle full circle (single category with 100%)
  if (d.percentage >= 0.9999) {
    return isInteractive
      ? svg`
        <g role="${groupRole}" tabindex="0"
          aria-label="${d.label}: ${fmtCur(d.value)} (${d.percentageStr}%)"
          @mouseenter=${onEnter}
          @mousemove=${onMove}
          @mouseleave=${onLeave}
          @click=${onClick}
          @keydown=${(e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(e); } }}
          data-idx="${idx}"
          data-label="${d.label}"
          data-value="${d.value}"
          data-pct="${d.percentageStr}"
          data-cat="${d.catId || ''}"
          style="cursor: ${groupCursor};">
          <circle
            cx="${cx}"
            cy="${cy}"
            r="${(r + ir) / 2}"
            fill="none"
            stroke="${d.color}"
            stroke-width="${r - ir}"
            opacity="0.92"
            filter="url(#donut-glow)"
            style="transition: opacity 0.15s;"
          />
        </g>
      `
      : svg`
        <g role="${groupRole}"
          aria-label="${d.label}: ${fmtCur(d.value)} (${d.percentageStr}%)"
          @mouseenter=${onEnter}
          @mousemove=${onMove}
          @mouseleave=${onLeave}
          data-idx="${idx}"
          data-label="${d.label}"
          data-value="${d.value}"
          data-pct="${d.percentageStr}"
          data-cat="${d.catId || ''}"
          style="cursor: ${groupCursor};">
          <circle
            cx="${cx}"
            cy="${cy}"
            r="${(r + ir) / 2}"
            fill="none"
            stroke="${d.color}"
            stroke-width="${r - ir}"
            opacity="0.92"
            filter="url(#donut-glow)"
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

  return isInteractive
    ? svg`
      <g role="${groupRole}" tabindex="0"
        aria-label="${d.label}: ${fmtCur(d.value)} (${d.percentageStr}%)"
        @mouseenter=${onEnter}
        @mousemove=${onMove}
        @mouseleave=${onLeave}
        @click=${onClick}
        @keydown=${(e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(e); } }}
        data-idx="${idx}"
        data-label="${d.label}"
        data-value="${d.value}"
        data-pct="${d.percentageStr}"
        data-cat="${d.catId || ''}"
        style="cursor: ${groupCursor};">
        <path
          d="M${x1o},${y1o} A${r},${r} 0 ${large},1 ${x2o},${y2o} L${x1i},${y1i} A${ir},${ir} 0 ${large},0 ${x2i},${y2i} Z"
          fill="${d.color}"
          opacity="0.92"
          filter="url(#donut-glow)"
          style="transition: opacity 0.15s;"
        />
      </g>
    `
    : svg`
      <g role="${groupRole}"
        aria-label="${d.label}: ${fmtCur(d.value)} (${d.percentageStr}%)"
        @mouseenter=${onEnter}
        @mousemove=${onMove}
        @mouseleave=${onLeave}
        data-idx="${idx}"
        data-label="${d.label}"
        data-value="${d.value}"
        data-pct="${d.percentageStr}"
        data-cat="${d.catId || ''}"
        style="cursor: ${groupCursor};">
        <path
          d="M${x1o},${y1o} A${r},${r} 0 ${large},1 ${x2o},${y2o} L${x1i},${y1i} A${ir},${ir} 0 ${large},0 ${x2i},${y2i} Z"
          fill="${d.color}"
          opacity="0.92"
          filter="url(#donut-glow)"
          style="transition: opacity 0.15s;"
        />
      </g>
    `;
}

/**
 * Render donut chart showing category breakdown
 */

/**
 * Round SVG path coordinates to 2 decimal places.
 * Round 7 fix: prevents floating-point jitter in donut segment paths.
 */
function roundSvgCoord(value: number): number {
  return Math.round(value * 100) / 100;
}

export function renderDonutChart(containerId: string, data: DonutChartData[], trends: Record<string, CategoryTrendChange> = {}): void {
  const el = DOM.get(containerId);
  if (!el) return;
  const isDashboardSnapshot = containerId === 'donut-chart-container';
  const categoryTrendSection = DOM.get('category-trend-section');

  if (isDashboardSnapshot && categoryTrendSection) {
    categoryTrendSection.classList.add('hidden');
  }
  
  const noDataTemplate = html`
    <p class="text-xs text-center py-8" style="color: var(--text-tertiary);">
      Add expense activity to show category pressure.
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
  
  const cx = 90;
  const cy = 90;
  const r = isDashboardSnapshot ? 52 : 70;
  const ir = isDashboardSnapshot ? 34 : 42;
  const processedData = processDonutData(data, total);
  const tooltip = DOM.get('chart-tooltip');
  const legendItems = isDashboardSnapshot ? data.slice(0, 4) : data;
  
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
    if (path) path.style.opacity = '0.92';
    if (tooltip) tooltip.classList.add('hidden');
  };
  
  const handleSegmentClick = (d: ProcessedDonutData) => (_e: Event) => {
    if (isDashboardSnapshot) return;
    if (!d.catId) return;
    const catInfo = getCatInfo('expense', d.catId);
    const catName = catInfo ? catInfo.name : d.catId;
    const catColor = catInfo ? catInfo.color : 'var(--color-accent)';
    renderCategoryTrendChart(d.catId, catName, catColor);
  };
  
  render(html`
    <div class="flex items-start gap-${isDashboardSnapshot ? '2' : '4'} dashboard-category-breakdown">
      <svg viewBox="0 0 180 180" class="shrink-0" style="width:${isDashboardSnapshot ? '104px' : '148px'};height:${isDashboardSnapshot ? '104px' : '148px'};filter:drop-shadow(0 2px 6px color-mix(in srgb, var(--text-primary) 20%, transparent));"
        role="figure" aria-label="Expense breakdown by category">
        <title>Category Breakdown</title>
        <desc>Donut chart showing ${data.length} expense categories totaling ${fmtCur(total)}</desc>
        <defs>
          <filter id="donut-glow" x="-10%" y="-10%" width="120%" height="120%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="1.5" result="blur"/>
            <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
          </filter>
        </defs>
        ${repeat(
          processedData,
          d => d.catId || d.label,
          (d, idx) => renderDonutSegment(
            d, idx, cx, cy, r, ir,
            handleSegmentEnter(d),
            handleSegmentMove,
            handleSegmentLeave,
            handleSegmentClick(d),
            !isDashboardSnapshot
          )
        )}
        <text x="${cx}" y="${cy - 6}" text-anchor="middle" fill="var(--text-tertiary)" font-size="${isDashboardSnapshot ? '9' : '10'}" font-weight="700" letter-spacing="0.05em">
          Total
        </text>
        <text x="${cx}" y="${cy + 12}" text-anchor="middle" fill="var(--text-primary)"
          font-size="${isDashboardSnapshot ? '14' : '16'}" font-weight="900">
          ${fmtCur(total)}
        </text>
      </svg>
      
      <div class="flex-1 dashboard-category-breakdown__legend pt-${isDashboardSnapshot ? '0.5' : '1'}">
        ${legendItems.map(d => {
          const sharePercent = total === 0 ? 0 : (d.value / total) * 100;
          const pct = sharePercent.toFixed(0);
          const trend = d.catId ? trends[d.catId] : undefined;
          const status = getDashboardCategoryBreakdownStatus(sharePercent, trend);
          let trendArrow = '';
          let trendColor = 'var(--text-tertiary)';
          let trendAriaLabel = 'No prior month comparison available';
          if (trend) {
            trendArrow = trend.direction === 'up' ? '↑' : trend.direction === 'down' ? '↓' : '';
            trendColor = trend.direction === 'up' ? 'var(--color-expense)' :
                        trend.direction === 'down' ? 'var(--color-income)' : 'var(--text-tertiary)';
            // Design-Review-Apr21 P3 (batch 6 follow-up wave O):
            // "New category this month" hardcoded the real current
            // month as the announcement period, but donut trends
            // key off `signals.currentMonth` — a historical or
            // future view announced "New category this month" for
            // a category that was new in the *viewed* month, not
            // the real current one. Route through
            // `formatViewedMonthLabel` so the aria-label names the
            // period the chart is actually plotting ("New category
            // this month" for current, "New category in April
            // 2026" for other views).
            const viewedLabel = formatViewedMonthLabel(signals.currentMonth.value);
            const isCurrentView = viewedLabel === 'this month';
            // 7a (Inline-Behavior-Review, CategoryTrendChange nullable widening):
            // `trend.change` is `number | null` — the producer emits `null`
            // only for 'new' and 'no-data' statuses; 'up'/'down'/'flat'
            // always carry a numeric delta. The `?? 0` coalesce is a
            // belt-and-suspenders guard so the aria-label never contains
            // the literal string "NaN" if the invariant ever breaks.
            trendAriaLabel = trend.direction === 'up'
              ? `Up ${Math.abs(trend.change ?? 0)} percent vs last month`
              : trend.direction === 'down'
                ? `Down ${Math.abs(trend.change ?? 0)} percent vs last month`
                : trend.direction === 'new'
                  ? (isCurrentView ? 'New category this month' : `New category in ${viewedLabel}`)
                  : 'No month-over-month change';
          }
          return html`
            <div class="dashboard-category-breakdown__row text-xs">
              <span class="w-3 h-3 rounded-full shrink-0" style="background:${d.color};" aria-hidden="true"></span>
              <span class="donut-legend-emoji" aria-hidden="true">${d.catId ? getCatInfo('expense', d.catId).emoji : ''}</span>
              <span class="truncate text-secondary">${d.label}</span>
              <span class="font-bold text-right text-primary">
                ${fmtCur(d.value)}
              </span>
              <span
                class="text-right text-tertiary dashboard-category-breakdown__share"
                aria-label="Share of spend ${pct} percent"
              >
                ${pct}%
              </span>
              <span
                class="text-right dashboard-category-breakdown__mom"
                aria-label=${trendAriaLabel}
              >
                ${trend && trendArrow ? html`
                  <span style="color:${trendColor};">
                    ${trendArrow}${Math.abs(trend.change ?? 0)}%
                  </span>
                ` : ''}
              </span>
              <span class="dashboard-category-breakdown__status-cell">
                ${status ? html`
                  <span
                    class="dashboard-category-breakdown__status dashboard-category-breakdown__status--${status.tone}"
                    aria-label=${`Status ${status.label}`}
                  >
                    ${status.label}
                  </span>
                ` : ''}
              </span>
            </div>
          `;
        })}
        ${isDashboardSnapshot && data.length > legendItems.length ? html`
          <p class="text-[10px] text-tertiary" style="grid-column: 1 / -1;">+${data.length - legendItems.length} more categories in Analytics</p>
        ` : ''}
      </div>
    </div>
  `, el);
}

// ==========================================
// BAR CHART
// ==========================================

/**
 * Accessible metadata for a bar chart render.
 *
 * CR-Apr22-C slice 1 [P2]: `renderBarChart` is reused across budget-vs-actual,
 * year-trend (analytics), YoY comparison, and category-trends charts, but
 * the SVG's `role="figure"`, `<title>`, and `<desc>` were hardcoded to the
 * budget-vs-actual copy. Screen-reader users on the analytics page heard
 * "Budget vs actual spending comparison" regardless of which chart they
 * focused. Each caller now supplies context-appropriate metadata. Default
 * copy preserves backward compatibility for the budget-vs-actual path.
 */
export interface BarChartAccessibility {
  ariaLabel: string;
  title: string;
  desc: string;
}

/**
 * Render bar chart using secure SVG templates.
 *
 * @param containerId - DOM id of the SVG container element
 * @param labels - Per-group x-axis labels (one per bar group)
 * @param datasets - One or more datasets to stack/group per label
 * @param a11y - Optional accessibility metadata; defaults to the budget-vs-actual copy
 */
export function renderBarChart(
  containerId: string,
  labels: string[],
  datasets: BarChartDataset[],
  a11y: BarChartAccessibility = {
    ariaLabel: 'Budget vs actual spending comparison',
    title: 'Budget vs Actual',
    desc: `Bar chart comparing budgeted amounts to actual spending across ${labels.length} categories`
  }
): void {
  const el = DOM.get(containerId);
  if (!el) return;

  // UI/UX Review Expanded: filter out hidden datasets for bar rendering
  // while keeping the full list for the legend toggle.
  const hiddenSet = _hiddenDatasets.get(containerId);
  const visibleDatasets = hiddenSet?.size
    ? datasets.filter(ds => !hiddenSet.has(ds.label))
    : datasets;

  const maxVal = Math.max(...visibleDatasets.flatMap(ds => ds.data), 1);
  const w = 500, h = 250, padL = 55, padB = 80, padT = 25, padR = 15;
  const chartW = w - padL - padR, chartH = h - padT - padB;
  const groupW = chartW / labels.length;
  const barW = Math.min(24, (groupW - 8) / visibleDatasets.length);
  const tooltip = DOM.get('chart-tooltip');
  
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
    <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" class="w-full"
      role="figure" aria-label="${a11y.ariaLabel}">
      <title>${a11y.title}</title>
      <desc>${a11y.desc}</desc>
      
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
        const gx = padL + i * groupW + (groupW - barW * visibleDatasets.length - (visibleDatasets.length - 1) * 3) / 2;
        return svg`
          <g>
            ${visibleDatasets.map((ds, di) => {
              // Phase 6 Slice 1i (rev 12 L6): `ds.data[i]` is now typed
              // `number | undefined` under `noUncheckedIndexedAccess`.
              // Treat missing datapoints as 0 so the bar is omitted
              // rather than rendering a NaN-height rectangle.
              const val = ds.data[i] ?? 0;
              const bh = Math.max((val / maxVal) * chartH, val > 0 ? 2 : 0);
              const bx = gx + di * (barW + 3);
              const by = padT + chartH - bh;

              // Design-Review-Apr21 P2 (batch 6 follow-up wave P):
              // bars are informational, not actionable. The prior
              // role="button" + tabindex=0 + Enter/Space/Escape
              // keydown wiring only toggled a tooltip — there was
              // no action behind the button promise. WAI-ARIA's
              // button role implies activation produces a
              // state-changing effect elsewhere in the app
              // (navigation, submit, toggle). A tooltip reveal is
              // not that; it's incidental UI that accompanies
              // focus/hover. Exposing this as a button created a
              // misleading contract for keyboard/AT users.
              //
              // Correct pattern: role="img" with aria-label. The
              // bar is a graphic whose label conveys all its
              // information. Sighted mouse users still see the
              // hover tooltip; screen-reader users hear the
              // aria-label without being promised a button press.
              // We drop tabindex, @keydown, @focus, @blur — the
              // SVG group is no longer a focus target, so the
              // keyboard handlers couldn't fire anyway. The
              // <rect>'s hover handlers are unchanged.
              return svg`
                <g role="img"
                  aria-label="${ds.label} for ${label}: ${fmtCur(val)}">
                  <rect
                    x="${bx}"
                    y="${by}"
                    width="${barW}"
                    height="${bh}"
                    rx="3"
                    fill="${ds.color}"
                    opacity="0.85"
                    style="cursor:default;transition:opacity 0.15s;"
                    @mouseenter=${handleBarEnter(ds, label, val)}
                    @mousemove=${handleBarMove}
                    @mouseleave=${handleBarLeave}
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
        ${datasets.map(ds => {
          const hidden = _hiddenDatasets.get(containerId);
          const isHidden = hidden?.has(ds.label) ?? false;
          const handleLegendClick = () => {
            // REND-02: Debounce rapid clicks — skip if a render is already queued
            if (_renderPending.has(containerId)) return;
            if (!_hiddenDatasets.has(containerId)) {
              _hiddenDatasets.set(containerId, new Set());
            }
            const set = _hiddenDatasets.get(containerId)!;
            // Don't allow hiding ALL datasets — at least one must remain visible
            if (!isHidden && set.size >= datasets.length - 1) return;
            if (isHidden) {
              set.delete(ds.label);
            } else {
              set.add(ds.label);
            }
            // Re-render on next microtask to coalesce rapid clicks
            _renderPending.add(containerId);
            queueMicrotask(() => {
              _renderPending.delete(containerId);
              renderBarChart(containerId, labels, datasets, a11y);
            });
          };
          return html`
            <button class="flex items-center gap-1 text-xs chart-legend-item"
              @click=${handleLegendClick}
              style="opacity:${isHidden ? '0.35' : '1'}; cursor:pointer; background:none; border:none; padding:2px 4px; border-radius:4px; transition:opacity 0.15s;"
              aria-pressed=${isHidden ? 'false' : 'true'}
              aria-label=${`${isHidden ? 'Show' : 'Hide'} ${ds.label}`}
              title=${`Click to ${isHidden ? 'show' : 'hide'} ${ds.label}`}>
              <span class="w-3 h-3 rounded-sm" style="background:${ds.color};${isHidden ? 'opacity:0.35;' : 'opacity:0.85;'}"></span>
              <span style="color:var(--text-secondary);${isHidden ? 'text-decoration:line-through;' : ''}">${ds.label}</span>
            </button>
          `;
        })}
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
  const el = DOM.get(containerId);
  if (!el) return;
  const isDashboardSnapshot = containerId === 'trend-chart-container';

  const now = new Date();
  const months: string[] = [];
  for (let i = monthCount - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(getMonthKey(d));
  }

  const summaries = signals.monthSummaries.value;
  const monthTotals = months.map((monthKey) => summaries[monthKey] || signals.EMPTY_MONTH_SUMMARY);
  const incVals = monthTotals.map((totals) => totals.income);
  const expVals = monthTotals.map((totals) => totals.expenses);
  // Phase 6 Slice 1i (rev 12 L6): `incVals[idx]`/`expVals[idx]` are
  // `number | undefined` under `noUncheckedIndexedAccess`. Treat
  // missing indexes as 0 — the arrays are month-aligned so any gap
  // is a zero-activity month.
  const activeMonths = months.filter((_, idx) => (incVals[idx] ?? 0) > 0 || (expVals[idx] ?? 0) > 0);
  if (activeMonths.length < 2) {
    render(html`<p class="text-xs text-center py-8" style="color: var(--text-tertiary);">Need at least two months of activity to chart a trend.</p>`, el);
    return;
  }
  const activeIndexes = months.reduce<number[]>((indexes: number[], _month: string, idx: number) => {
    if ((incVals[idx] ?? 0) > 0 || (expVals[idx] ?? 0) > 0) indexes.push(idx);
    return indexes;
  }, []);
  const activeCount = Math.max(activeIndexes.length, 1);
  const avgIncome = activeIndexes.reduce((sum: number, idx: number) => sum + (incVals[idx] ?? 0), 0) / activeCount;
  const avgExpenses = activeIndexes.reduce((sum: number, idx: number) => sum + (expVals[idx] ?? 0), 0) / activeCount;
  const netAverage = avgIncome - avgExpenses;
  const maxVal = Math.max(...incVals, ...expVals, 1);
  const w = 500;
  const h = isDashboardSnapshot ? 148 : 220;
  const padL = isDashboardSnapshot ? 40 : 55;
  const padB = isDashboardSnapshot ? 28 : 45;
  const padT = isDashboardSnapshot ? 14 : 20;
  const padR = 15;
  const chartW = w - padL - padR, chartH = h - padT - padB;
  const step = chartW / (months.length - 1 || 1);
  // Route through locale-service so the trend chart x-axis respects the
  // app's configured locale (was hardcoded 'en-US'). formatMonthShort
  // accepts the YYYY-MM key directly and anchors at local noon internally.
  const labels = months.map(mk => formatMonthShort(mk));
  const tooltip = DOM.get('chart-tooltip');
  
  const toPoints = (vals: number[]): string[] => vals.map((v, i) => {
    const x = padL + i * step;
    const y = padT + chartH - (v / maxVal) * chartH;
    return `${x},${y}`;
  });
  
  const incPts = toPoints(incVals);
  const expPts = toPoints(expVals);
  const baseY = padT + chartH;
  
  // Event handlers for trend points
  const handlePointEnter = (monthKey: string, income: number, expense: number, label: string) => (_e: Event) => {
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
  
  const handlePointClick = (monthKey: string) => (_e: Event) => {
    // goToMonth -> setCurrentMonth already emits MONTH_CHANGED
    navigation.goToMonth(monthKey);
  };
  
  render(html`
    ${isDashboardSnapshot ? html`
      <div class="dashboard-trend-summary" aria-label="Trend summary">
        <div class="dashboard-trend-metric">
          <span class="dashboard-trend-metric__label">Avg Income</span>
          <span class="dashboard-trend-metric__value" style="color: var(--color-income);">${fmtCur(avgIncome)}</span>
        </div>
        <div class="dashboard-trend-metric">
          <span class="dashboard-trend-metric__label">Avg Expenses</span>
          <span class="dashboard-trend-metric__value" style="color: var(--color-expense);">${fmtCur(avgExpenses)}</span>
        </div>
        <div class="dashboard-trend-metric">
          <span class="dashboard-trend-metric__label">Net Avg</span>
          <span class="dashboard-trend-metric__value" style="color: ${netAverage >= 0 ? 'var(--color-income)' : 'var(--color-expense)'};">
            ${netAverage >= 0 ? '+' : '-'}${fmtCur(Math.abs(netAverage))}
          </span>
        </div>
      </div>
    ` : ''}
    <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" class="w-full ${isDashboardSnapshot ? 'dashboard-trend-svg' : ''}"
      role="figure" aria-label="Income and expense trends over time">
      <title>Trend Chart</title>
      <desc>Line chart showing ${monthCount}-month trend of income and expenses</desc>
      
      <defs>
        <linearGradient id="tg-inc" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--color-income)" stop-opacity="0.35"/>
          <stop offset="60%" stop-color="var(--color-income)" stop-opacity="0.10"/>
          <stop offset="100%" stop-color="var(--color-income)" stop-opacity="0"/>
        </linearGradient>
        <linearGradient id="tg-exp" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--color-expense)" stop-opacity="0.30"/>
          <stop offset="60%" stop-color="var(--color-expense)" stop-opacity="0.08"/>
          <stop offset="100%" stop-color="var(--color-expense)" stop-opacity="0"/>
        </linearGradient>
        <filter id="tg-glow-inc" x="-10%" y="-10%" width="120%" height="120%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="2.5" result="blur"/>
          <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
        <filter id="tg-glow-exp" x="-10%" y="-10%" width="120%" height="120%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="2.5" result="blur"/>
          <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
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
      
      <!-- Lines with glow -->
      <polyline
        points="${incPts.join(' ')}"
        fill="none"
        stroke="var(--color-income)"
        stroke-width="3"
        stroke-linecap="round"
        stroke-linejoin="round"
        filter="url(#tg-glow-inc)"/>
      <polyline
        points="${expPts.join(' ')}"
        fill="none"
        stroke="var(--color-expense)"
        stroke-width="3"
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-dasharray="8,4"
        filter="url(#tg-glow-exp)"/>
      
      <!-- Forecast projection for current month -->
      ${(() => {
        const currentMonthKey = getMonthKey(now);
        const lastMonthIdx = months.indexOf(currentMonthKey);
        if (lastMonthIdx >= 0 && now.getDate() < 28 && calcVelocityFn) {
          const velocity = calcVelocityFn();
          const projectedExp = velocity.projected;
          // Phase 6 Slice 1i (rev 12 L6): index access returns `T | undefined`
          // — fall back to 0 for missing month totals and to origin
          // coords (`0,0`) for missing point strings so math/parseFloat
          // stay numeric.
          const actualExp = expVals[lastMonthIdx] ?? 0;

          if (projectedExp > actualExp * 1.05) {
            const [lastX = 0, lastY = 0] = (expPts[lastMonthIdx] ?? '0,0').split(',').map(parseFloat);
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
        // Phase 6 Slice 1i (rev 12 L6): index access returns `T | undefined`
        // — fall back to origin coords and zero values so the SVG
        // still renders valid geometry for any gap month.
        const [incX = 0, incY = 0] = (incPts[i] ?? '0,0').split(',').map(parseFloat);
        const [expX = 0, expY = 0] = (expPts[i] ?? '0,0').split(',').map(parseFloat);
        const income = incVals[i] ?? 0;
        const expense = expVals[i] ?? 0;
        const label = labels[i] ?? '';
        
        return svg`
          <g>
            <!-- Income point -->
            <circle cx="${incX}" cy="${incY}" r="4"
              fill="var(--color-income)"
              stroke="var(--bg-primary)"
              stroke-width="2"/>
            ${income > 0 ? svg`
              ${!isDashboardSnapshot ? svg`
                <text x="${incX}" y="${incY - 8}" text-anchor="middle" 
                  fill="var(--color-income)" font-size="8" font-weight="700">
                  ${fmtShort(income)}
                </text>
              ` : ''}
            ` : ''}
            
            <!-- Expense point (diamond marker for colorblind accessibility) -->
            <rect x="${expX - 3.5}" y="${expY - 3.5}" width="7" height="7"
              transform="rotate(45 ${expX} ${expY})"
              fill="var(--color-expense)"
              stroke="var(--bg-primary)"
              stroke-width="2"/>
            ${expense > 0 ? svg`
              ${!isDashboardSnapshot ? svg`
                <text x="${expX}" y="${expY + 14}" text-anchor="middle" 
                  fill="var(--color-expense)" font-size="8" font-weight="700">
                  ${fmtShort(expense)}
                </text>
              ` : ''}
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
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handlePointClick(monthKey)(e); }
              }}
            />
          </g>
        `;
      })}
      
      <!-- X-axis month labels -->
      ${labels.map((lbl, i) => svg`
        <text 
          x="${padL + i * step}" 
          y="${baseY + (isDashboardSnapshot ? 12 : 14)}" 
          text-anchor="middle" 
          fill="var(--text-secondary)" 
          font-size="${isDashboardSnapshot ? '9' : '10'}">
          ${lbl}
        </text>
      `)}
    </svg>
    
      <div class="${isDashboardSnapshot ? 'dashboard-trend-legend' : 'flex gap-4 justify-center mt-1'}">
      <div class="flex items-center gap-1.5 text-xs">
        <svg width="18" height="12" viewBox="0 0 18 12" aria-hidden="true">
          <line x1="0" y1="6" x2="14" y2="6" stroke="var(--color-income)" stroke-width="2.5"/>
          <circle cx="14" cy="6" r="3" fill="var(--color-income)"/>
        </svg>
        <span style="color:var(--text-secondary);">Income</span>
      </div>
      <div class="flex items-center gap-1.5 text-xs">
        <svg width="18" height="12" viewBox="0 0 18 12" aria-hidden="true">
          <line x1="0" y1="6" x2="14" y2="6" stroke="var(--color-expense)" stroke-width="2.5" stroke-dasharray="4,2"/>
          <rect x="11" y="3" width="6" height="6" transform="rotate(45 14 6)" fill="var(--color-expense)"/>
        </svg>
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
  // M6 (Inline-Behavior-Review rev 12): the prior `import().then()` shape
  // left the trend panel blank with zero telemetry on a failed chunk
  // load (network blip, broken chunk after mid-session deploy). Routing
  // through `loadAndCall` captures the loader error and tags it with
  // the chart context so oncall can correlate blank-panel reports with
  // a specific lazy-module failure.
  loadAndCall(
    () => import('../../features/analytics/trend-analysis.js'),
    ({ calculateCategoryTrends }) => {
      const trendsResult = calculateCategoryTrends(months);

      const categoryData = trendsResult.trends.find((t: CategoryTrendData) => t.category?.id === catId);
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
      const maxVal = Math.max(...dataPoints.map((d: CategoryMonthData) => d.amount), 1);
      const barWidth = 100 / Math.max(dataPoints.length, 1);
      const padding = 2;

      render(html`
        <div class="w-full h-32 relative mt-2">
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" class="w-full h-full overflow-visible" role="img" aria-label="Category spending trend over 6 months">
            ${dataPoints.map((d: CategoryMonthData, i: number) => {
              const barH = (d.amount / maxVal) * 90; // max 90 units height
              const x = i * barWidth + padding;
              const w = barWidth - padding * 2;
              const y = 100 - barH;

              // BUG-02: Use plain viewBox units (0-100), not percentage suffixes.
              // In a 100×100 viewBox the numeric values already map 1:1, but %
              // units cause inconsistent scaling with preserveAspectRatio="none".
              return svg`
                <g class="group">
                  <rect
                    x="${x}" y="${y}"
                    width="${w}" height="${barH}"
                    fill="${catColor}"
                    rx="1.5"
                    class="transition-all duration-300 opacity-80 group-hover:opacity-100 cursor-pointer"
                  />
                  <text
                    x="${x + w/2}" y="100"
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
    },
    { module: 'ChartRenderers', action: 'render_category_trend_chart' }
  );
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
