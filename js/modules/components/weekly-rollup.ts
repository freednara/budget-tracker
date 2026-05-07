/**
 * Weekly Rollup Component
 *
 * Reactive component that renders weekly spending breakdown with SVG bar chart.
 * Automatically updates when transaction data or month changes.
 *
 * @module components/weekly-rollup
 */
'use strict';

import { effect, computed } from '@preact/signals-core';
import * as signals from '../core/signals.js';
import { html, render, unsafeSVG } from '../core/lit-helpers.js';
import { fmtCur, fmtShort } from '../core/utils-pure.js';
import { formatViewedMonthPhrase } from '../core/locale-service.js';
// Phase 5g-1 (Inline-Behavior-Review rev 12, L16): dropped
// `HTMLElement` — the interface only carried a dead
// `_weeklyRollupHandlers` slot. Chart host element is a plain HTMLElement.
import {
  generateWeeklyData,
  getMonthBadge,
  WeekData
} from '../features/financial/weekly-rollup.js';
import DOM from '../core/dom-cache.js';

// ==========================================
// COMPUTED WEEKLY DATA
// ==========================================

/**
 * Computed weekly rollup data that auto-updates
 */
const weeklyRollupData = computed(() => {
  const currentMonth = signals.currentMonth.value;
  void signals.transactionsByMonth.value.get(currentMonth);

  return generateWeeklyData();
});

// ==========================================
// CHART RENDERING
// ==========================================

/**
 * Render SVG chart for weekly data
 */
// Store cleanup function for interactivity listeners
let interactivityCleanup: (() => void) | null = null;

function renderWeeklyChart(el: HTMLElement, weeks: WeekData[]): void {
  // Clean up previous interactivity listeners before re-rendering
  if (interactivityCleanup) {
    interactivityCleanup();
    interactivityCleanup = null;
  }

  // Design-Review-Apr21 P3 (batch 6 follow-up wave L): "this month" used
  // to be hardcoded into the empty state + average-week caption below,
  // but this widget is reactive to `signals.currentMonth` — when a user
  // navigated to a past/future month the copy no longer matched the
  // period on screen. `formatViewedMonthPhrase` returns "this month"
  // at current-view default and "in April 2026"-style labels when
  // navigated elsewhere, keeping both cases grammatical.
  const monthPhrase = formatViewedMonthPhrase(signals.currentMonth.value);

  if (weeks.length === 0) {
    render(html`<div class="text-center py-4 text-tertiary">No transactions recorded ${monthPhrase}. Add one to see your weekly breakdown.</div>`, el);
    return;
  }

  const { svg, setupInteractivity } = generateWeeklySVG(weeks);
  const maxWeek = weeks.reduce((best: WeekData | null, week: WeekData) => {
    if (!best || week.total > best.total) return week;
    return best;
  }, null as WeekData | null);
  const average = weeks.reduce((sum: number, week: WeekData) => sum + week.total, 0) / weeks.length;

  render(html`
    <div class="budget-stat-grid">
      <div class="budget-stat-card">
        <p class="text-xs font-bold text-secondary mb-2">BIGGEST WEEK</p>
        <p class="text-2xl font-black text-primary">${maxWeek ? fmtCur(maxWeek.total) : fmtCur(0)}</p>
        <p class="text-xs text-tertiary mt-2">${maxWeek ? `Week ${weeks.indexOf(maxWeek) + 1}` : 'No weekly data'}</p>
      </div>
      <div class="budget-stat-card">
        <p class="text-xs font-bold text-secondary mb-2">AVERAGE WEEK</p>
        <p class="text-2xl font-black text-primary">${fmtCur(average)}</p>
        <p class="text-xs text-tertiary mt-2">${weeks.length} week${weeks.length === 1 ? '' : 's'} ${monthPhrase}</p>
      </div>
    </div>
    <div class="budget-meter">
      ${unsafeSVG(svg)}
    </div>
  `, el);

  // Set up interactive tooltips and filters, store cleanup
  interactivityCleanup = setupInteractivity(el) || null;
}

/**
 * Generate SVG chart markup (extracted from original)
 */
function generateWeeklySVG(weeks: WeekData[]): { svg: string; setupInteractivity: (el: HTMLElement) => (() => void) | void } {
  // Chart dimensions
  const w = 520;
  const h = 200;
  const padT = 28;
  const padB = 38;
  const padL = 18;
  const padR = 18;
  const chartW = w - padL - padR;
  const chartH = h - padT - padB;
  const barGap = 12;
  const barWidth = (chartW - (weeks.length - 1) * barGap) / weeks.length;
  const barRadius = Math.min(barWidth * 0.15, 6);

  // Calculate scale
  const maxSpend = Math.max(...weeks.map(w => w.total));
  const scale = maxSpend > 0 ? chartH / maxSpend : 1;

  // Generate SVG.
  // Design-Review-Apr21 P2: outer SVG carries focusable `role="button"` week
  // hit-targets (the .wr-hover rects below). `role="img"` would flatten those
  // into a static image for AT; `role="figure"` keeps the labelled-region
  // semantics while leaving the interactive descendants exposed.
  let svg = `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" class="weekly-rollup-chart" role="figure" aria-label="Weekly spending breakdown chart"><title>Weekly spending breakdown</title>`;

  // Defs: gradients + glow filter
  svg += `<defs>`;
  // Bar gradient for each spending level
  svg += `<linearGradient id="wr-grad-low" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="var(--color-income)" stop-opacity="1"/>
    <stop offset="100%" stop-color="var(--color-income)" stop-opacity="0.6"/>
  </linearGradient>`;
  svg += `<linearGradient id="wr-grad-mid" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="var(--color-warning)" stop-opacity="1"/>
    <stop offset="100%" stop-color="var(--color-warning)" stop-opacity="0.6"/>
  </linearGradient>`;
  svg += `<linearGradient id="wr-grad-high" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="var(--color-expense)" stop-opacity="1"/>
    <stop offset="100%" stop-color="var(--color-expense)" stop-opacity="0.6"/>
  </linearGradient>`;
  // Glow filter
  svg += `<filter id="wr-glow" x="-20%" y="-20%" width="140%" height="140%">
    <feGaussianBlur in="SourceGraphic" stdDeviation="3" result="blur"/>
    <feComposite in="SourceGraphic" in2="blur" operator="over"/>
  </filter>`;
  svg += `</defs>`;

  // Horizontal grid lines (subtle)
  const gridLines = 3;
  for (let g = 0; g <= gridLines; g++) {
    const gy = padT + (chartH / gridLines) * g;
    svg += `<line x1="${padL}" y1="${gy}" x2="${w - padR}" y2="${gy}" stroke="var(--border-input)" stroke-opacity="0.3" stroke-dasharray="4 4"/>`;
  }

  // Week bars
  weeks.forEach((week, i) => {
    const x = padL + i * (barWidth + barGap);
    const barH = Math.max(week.total * scale, 2); // minimum 2px so empty weeks show a sliver
    const y = padT + chartH - barH;

    const level = week.total > maxSpend * 0.8 ? 'high' :
                  week.total > maxSpend * 0.5 ? 'mid' : 'low';
    const gradId = `wr-grad-${level}`;
    // Route total through locale-aware fmtCur so screen readers hear the
    // amount in the user's configured currency/locale (was hardcoded '$' +
    // en-US fractional format).
    const totalLabel = fmtCur(week.total);
    const txCountLabel = `${week.txCount} transaction${week.txCount === 1 ? '' : 's'}`;
    const ariaLabel = `Filter to week ${i + 1}, ${txCountLabel}, total ${totalLabel}`;

    // Shadow bar (subtle depth)
    svg += `<rect x="${x + 2}" y="${y + 2}" width="${barWidth}" height="${barH}" rx="${barRadius}" fill="color-mix(in srgb, var(--text-primary) 18%, transparent)"/>`;

    // Main bar with gradient and rounded top corners
    svg += `<rect x="${x}" y="${y}" width="${barWidth}" height="${barH}" rx="${barRadius}" fill="url(#${gradId})" filter="url(#wr-glow)" class="wr-bar" data-idx="${i}"/>`;

    // Value label above bar (only if enough room). `fmtShort` reads the
    // currency symbol from the signal, so the label matches the rest of
    // the UI (was hardcoded '$' + hand-rolled k-suffix).
    if (week.total > 0 && barH > 14) {
      svg += `<text x="${x + barWidth/2}" y="${y - 6}" text-anchor="middle" font-size="10" font-weight="700" fill="var(--text-secondary)" opacity="0.85">${fmtShort(week.total)}</text>`;
    }

    // Week label
    svg += `<text x="${x + barWidth/2}" y="${h - 8}" text-anchor="middle" font-size="11" font-weight="600" fill="var(--text-secondary)">W${i + 1}</text>`;

    // Hover area for interactivity
    svg += `<rect x="${x}" y="${padT}" width="${barWidth}" height="${chartH + 10}" fill="transparent"
            class="wr-hover"
            data-week="${i + 1}"
            data-start="${week.start}"
            data-end="${week.end}"
            data-total="${week.total}"
            data-count="${week.txCount}"
            role="button"
            tabindex="0"
            focusable="true"
            aria-label="${ariaLabel}"/>`;
  });

  svg += `</svg>`;
  
  // Setup interactivity function - returns cleanup function to remove listeners
  const setupInteractivity = (element: HTMLElement): (() => void) => {
    const listeners: Array<{ el: Element; type: string; handler: (e: Event) => void }> = [];

    element.querySelectorAll('.wr-hover').forEach(rect => {
      // CR-Apr24-I finding 62: the old code dispatched a bare
      // `CustomEvent('weekly-filter')` that was never handled anywhere,
      // so clicking a weekly bar did nothing. Route through the canonical
      // filter-actions module so clicking a bar filters the transaction
      // list to that week's date range.
      const dispatchWeeklyFilter = (target: HTMLElement): void => {
        const start = target.getAttribute('data-start');
        const end = target.getAttribute('data-end');
        if (!start || !end) return;

        void import('../core/actions/filters-actions.js').then(({ filters: filterActions }) => {
          filterActions.updateFilters({ dateFrom: start, dateTo: end });
        });
      };

      const clickHandler = (event: Event): void => {
        dispatchWeeklyFilter(event.currentTarget as HTMLElement);
      };

      const keydownHandler = (event: Event): void => {
        const keyboardEvent = event as KeyboardEvent;
        if (keyboardEvent.key !== 'Enter' && keyboardEvent.key !== ' ') return;
        keyboardEvent.preventDefault();
        dispatchWeeklyFilter(keyboardEvent.currentTarget as HTMLElement);
      };

      rect.addEventListener('click', clickHandler);
      rect.addEventListener('keydown', keydownHandler);
      listeners.push({ el: rect, type: 'click', handler: clickHandler });
      listeners.push({ el: rect, type: 'keydown', handler: keydownHandler });
    });

    return () => {
      listeners.forEach(({ el, type, handler }) => el.removeEventListener(type, handler));
    };
  };
  
  return { svg, setupInteractivity };
}

// ==========================================
// COMPONENT MOUNTING
// ==========================================

/**
 * Mount the reactive weekly rollup component
 * Returns cleanup function to dispose effects
 */
export function mountWeeklyRollup(): () => void {
  const section = DOM.get('weekly-rollup-section');
  const chartEl = DOM.get('weekly-rollup-chart');
  const badgeEl = DOM.get('weekly-rollup-badge');
  
  if (!section || !chartEl) {
    return () => {};
  }
  
  // Effect for chart rendering
  const chartCleanup = effect(() => {
    const data = weeklyRollupData.value;
    // CR-Apr22-G slice 1 (P2): renderWeeklyChart calls fmtCur + fmtShort,
    // both of which read module-level formatter state (synced externally
    // by syncCurrencyFormat), not the currency signal. Without an explicit
    // read here the effect doesn't re-run on currency change, so the
    // "BIGGEST WEEK" + "AVERAGE WEEK" stat cards and SVG bar labels stay
    // stale with the prior currency symbol/decimals until transaction data
    // or the viewed month changes.
    void signals.currency.value;

    if (!data.hasData) {
      section.classList.add('hidden');
      return;
    }

    section.classList.remove('hidden');
    renderWeeklyChart(chartEl, data.weeks);
  });
  
  // Effect for badge rendering
  let badgeCleanup = () => {};
  if (badgeEl) {
    badgeCleanup = effect(() => {
      const data = weeklyRollupData.value;
      if (data.hasData) {
        render(html`<span class="time-badge">${getMonthBadge(signals.currentMonth.value)}</span>`, badgeEl);
      }
    });
  }
  
  // Return combined cleanup function
  return () => {
    chartCleanup();
    badgeCleanup();
    if (interactivityCleanup) {
      interactivityCleanup();
      interactivityCleanup = null;
    }
  };
}
