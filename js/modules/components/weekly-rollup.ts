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
import { html, render, unsafeHTML } from '../core/lit-helpers.js';
import { 
  generateWeeklyData, 
  getMonthBadge, 
  WeeklyRollupElement,
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
  // Track via month + totals (not full array reference which causes cascade on every signal batch)
  const _currentMonth = signals.currentMonth.value;
  const _txLen = signals.transactions.value.length;
  const _txHash = signals.currentMonthTotals.value.expenses;

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

function renderWeeklyChart(el: WeeklyRollupElement, weeks: WeekData[]): void {
  // Clean up previous interactivity listeners before re-rendering
  if (interactivityCleanup) {
    interactivityCleanup();
    interactivityCleanup = null;
  }

  if (weeks.length === 0) {
    el.innerHTML = '<div class="text-center py-4" style="color: var(--text-tertiary);">No data for this month</div>';
    return;
  }

  const { svg, setupInteractivity } = generateWeeklySVG(weeks);
  const maxWeek = weeks.reduce((best: WeekData | null, week: WeekData) => {
    if (!best || week.total > best.total) return week;
    return best;
  }, null as WeekData | null);
  const average = weeks.reduce((sum: number, week: WeekData) => sum + week.total, 0) / weeks.length;

  el.innerHTML = `
    <div class="budget-stat-grid">
      <div class="budget-stat-card">
        <p class="text-xs font-bold text-secondary mb-2">BIGGEST WEEK</p>
        <p class="text-2xl font-black text-primary">${maxWeek ? `$${maxWeek.total.toFixed(2)}` : '$0.00'}</p>
        <p class="text-xs text-tertiary mt-2">${maxWeek ? `Week ${weeks.indexOf(maxWeek) + 1}` : 'No weekly data'}</p>
      </div>
      <div class="budget-stat-card">
        <p class="text-xs font-bold text-secondary mb-2">AVERAGE WEEK</p>
        <p class="text-2xl font-black text-primary">$${average.toFixed(2)}</p>
        <p class="text-xs text-tertiary mt-2">${weeks.length} week${weeks.length === 1 ? '' : 's'} this month</p>
      </div>
    </div>
    <div class="budget-meter">
      ${svg}
    </div>
  `;

  // Set up interactive tooltips and filters, store cleanup
  interactivityCleanup = setupInteractivity(el) || null;
}

/**
 * Generate SVG chart markup (extracted from original)
 */
function generateWeeklySVG(weeks: WeekData[]): { svg: string; setupInteractivity: (el: HTMLElement) => (() => void) | void } {
  // Chart dimensions
  const w = 520;
  const h = 180;
  const padT = 14;
  const padB = 38;
  const padL = 18;
  const padR = 18;
  const chartW = w - padL - padR;
  const chartH = h - padT - padB;
  const barGap = 8;
  const barWidth = (chartW - (weeks.length - 1) * barGap) / weeks.length;
  
  // Calculate scale
  const maxSpend = Math.max(...weeks.map(w => w.total));
  const scale = maxSpend > 0 ? chartH / maxSpend : 1;
  
  // Generate SVG
  let svg = `<svg width="${w}" height="${h}" class="weekly-rollup-chart">`;
  
  // Week bars
  weeks.forEach((week, i) => {
    const x = padL + i * (barWidth + barGap);
    const barH = week.total * scale;
    const y = padT + chartH - barH;
    
    const weekColor = week.total > maxSpend * 0.8 ? 'var(--color-expense)' :
                      week.total > maxSpend * 0.6 ? 'var(--color-warning)' : 'var(--color-income)';
    
    svg += `<rect x="${x}" y="${y}" width="${barWidth}" height="${barH}" fill="${weekColor}" rx="2"/>`;
    
    // Week label
    svg += `<text x="${x + barWidth/2}" y="${h - 8}" text-anchor="middle" font-size="11" fill="var(--text-secondary)">W${i + 1}</text>`;
    
    // Hover area for interactivity
    svg += `<rect x="${x}" y="${padT}" width="${barWidth}" height="${chartH}" fill="transparent" 
            class="wr-hover" style="cursor:pointer" 
            data-week="${i + 1}" 
            data-start="${week.start}" 
            data-end="${week.end}" 
            data-total="${week.total}" 
            data-count="${week.txCount}"/>`;
  });
  
  svg += `</svg>`;
  
  // Setup interactivity function - returns cleanup function to remove listeners
  const setupInteractivity = (element: HTMLElement): (() => void) => {
    const listeners: Array<{ el: Element; handler: (e: Event) => void }> = [];

    element.querySelectorAll('.wr-hover').forEach(rect => {
      const handler = (e: Event) => {
        const target = e.target as HTMLElement;
        const week = target.getAttribute('data-week');
        const start = target.getAttribute('data-start');
        const end = target.getAttribute('data-end');

        // Emit event for date filtering
        const event = new CustomEvent('weekly-filter', {
          detail: { week, start, end }
        });
        document.dispatchEvent(event);
      };
      rect.addEventListener('click', handler);
      listeners.push({ el: rect, handler });
    });

    return () => {
      listeners.forEach(({ el, handler }) => el.removeEventListener('click', handler));
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
  const section = DOM.get('weekly-rollup-section') as HTMLElement | null;
  const chartEl = DOM.get('weekly-rollup-chart') as WeeklyRollupElement | null;
  const badgeEl = DOM.get('weekly-rollup-badge');
  
  if (!section || !chartEl) {
    return () => {};
  }
  
  // Effect for chart rendering
  const chartCleanup = effect(() => {
    const data = weeklyRollupData.value;
    
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
        render(unsafeHTML(getMonthBadge(signals.currentMonth.value)), badgeEl);
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
