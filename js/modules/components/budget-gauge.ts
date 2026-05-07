/**
 * Budget Gauge Component
 *
 * Reactive component that renders a modern ring-style SVG gauge
 * showing budget health. Automatically updates when budget
 * allocations or transactions change.
 *
 * @module components/budget-gauge
 */
'use strict';

import { effect, computed } from '@preact/signals-core';
import * as signals from '../core/signals.js';
import { html, svg, render } from '../core/lit-helpers.js';
import { fmtCur } from '../core/utils-pure.js';
import { calculateEffectiveMonthBudgetTotal } from '../core/effective-budget.js';
import DOM from '../core/dom-cache.js';
import { describeArc } from '../core/dashboard-svg-helpers.js';

// ==========================================
// COMPUTED SIGNALS
// ==========================================

/**
 * Budget gauge display data
 */
interface GaugeData {
  hasBudget: boolean;
  shouldShow: boolean;
  usedPercent: number;
  displayPercent: number;
  gaugeColor: string;
  glowColor: string;
  statusText: string;
  totalExpenses: number;
  totalBudget: number;
  remaining: number;
  note: string;
}

const gaugeData = computed((): GaugeData => {
  const mk = signals.currentMonth.value;
  const totalBudget = calculateEffectiveMonthBudgetTotal(mk);
  const totalExpenses = signals.currentMonthTotals.value.expenses;

  if (totalBudget === 0) {
    return {
      hasBudget: false,
      shouldShow: true,
      usedPercent: 0,
      displayPercent: 0,
      gaugeColor: 'var(--color-accent)',
      glowColor: 'var(--color-accent)',
      statusText: 'New',
      totalExpenses: 0,
      totalBudget: 0,
      remaining: 0,
      note: 'Set category budgets to start tracking pressure against plan.'
    };
  }

  const usedPercent = Math.min(150, Math.round((totalExpenses / totalBudget) * 100));
  const displayPercent = Math.min(usedPercent, 100);
  const remaining = totalBudget - totalExpenses;

  let gaugeColor = 'var(--color-income)'; // Green: <80%
  let glowColor = 'var(--color-income)';
  let statusText = 'Healthy';
  let note = 'Spending is comfortably inside the plan.';
  if (usedPercent >= 100) {
    gaugeColor = 'var(--color-expense)'; // Red: Over budget
    glowColor = 'var(--color-expense)';
    statusText = 'Over';
    note = 'Spending is past plan. Rebalance budget or cut back.';
  } else if (usedPercent >= 80) {
    gaugeColor = 'var(--color-warning)'; // Yellow: 80-100%
    glowColor = 'var(--color-warning)';
    statusText = 'Caution';
    note = 'You are close to the ceiling. Watch the categories driving the last stretch.';
  } else if (totalExpenses === 0) {
    note = 'No spending recorded yet.';
  }

  return {
    hasBudget: true,
    shouldShow: true,
    usedPercent,
    displayPercent,
    gaugeColor,
    glowColor,
    statusText,
    totalExpenses,
    totalBudget,
    remaining,
    note
  };
});

// ==========================================
// COMPONENT MOUNTING
// ==========================================

/**
 * Mount the reactive budget gauge component
 * Returns cleanup function to dispose effects
 */
export function mountBudgetGauge(): () => void {
  const section = DOM.get('budget-gauge-section');
  const container = DOM.get('budget-gauge-container');

  if (!section || !container) {
    return () => {}; // No cleanup needed
  }

  // SVG dimensions — taller to give the ring room to breathe
  const w = 220, h = 140;
  const cx = w / 2, cy = h - 8;
  const r = 80;
  const strokeW = 18;
  const startAngle = Math.PI; // 180 degrees (left)
  const endAngle = 0; // 0 degrees (right)

  // Background arc (constant)
  const bgArc = describeArc(cx, cy, r, startAngle, endAngle);

  // Unique ID for gradient/filter (avoid collisions if multiple gauges)
  const uid = 'bg-' + Math.random().toString(36).slice(2, 8);

  // Effect for gauge rendering (re-runs on currency change for formatting)
  const cleanup = effect(() => {
    const _cur = signals.currency.value;  // subscribe to currency changes
    const data = gaugeData.value;

    // Toggle section visibility based on budget existence
    if (!data.shouldShow) {
      section.classList.add('hidden');
      return;
    }
    section.classList.remove('hidden');

    if (!data.hasBudget) {
      render(html`
        <div class="budget-health-empty">
          <div class="budget-health-empty__summary">
            <span class="budget-health-status" style=${`--budget-health-tone: ${data.gaugeColor};`}>${data.statusText}</span>
            <p class="budget-health-amount">No budget set yet</p>
            <p class="budget-health-note">${data.note}</p>
          </div>
        </div>
      `, container);
      return;
    }

    // Calculate fill arc
    const fillAngle = startAngle - (startAngle - endAngle) * (data.displayPercent / 100);
    const fillArc = describeArc(cx, cy, r, startAngle, fillAngle);

    // Remaining text
    const remainingText = data.remaining >= 0
      ? `${fmtCur(data.remaining)} left`
      : `${fmtCur(Math.abs(data.remaining))} over`;

    render(html`
      <div class="budget-health-layout">
        <div class="budget-health-gauge-wrap">
          <svg viewBox="0 0 ${w} ${h}" class="budget-health-gauge" role="img" aria-label="Budget health gauge showing ${data.usedPercent}% used">
            <title>Budget Health</title>
            <desc>Ring gauge indicating ${data.statusText} status with ${data.usedPercent}% of budget used</desc>
            ${svg`
              <defs>
                <linearGradient id="${uid}-grad" x1="0" y1="0" x2="1" y2="0">
                  <stop offset="0%" stop-color="${data.glowColor}" stop-opacity="0.7"/>
                  <stop offset="100%" stop-color="${data.glowColor}"/>
                </linearGradient>
                <filter id="${uid}-glow" x="-20%" y="-20%" width="140%" height="140%">
                  <feGaussianBlur in="SourceGraphic" stdDeviation="3" result="blur"/>
                  <feMerge>
                    <feMergeNode in="blur"/>
                    <feMergeNode in="SourceGraphic"/>
                  </feMerge>
                </filter>
              </defs>

              <!-- Track -->
              <path d="${bgArc}" fill="none" stroke="var(--bg-input)" stroke-width="${strokeW}" stroke-linecap="round" opacity="0.5"/>

              <!-- Tick marks at 0%, 50%, 100% -->
              <line x1="${cx - r}" y1="${cy}" x2="${cx - r}" y2="${cy + 6}" stroke="var(--text-tertiary)" stroke-width="1" opacity="0.4"/>
              <line x1="${cx}" y1="${cy - r}" x2="${cx}" y2="${cy - r - 6}" stroke="var(--text-tertiary)" stroke-width="1" opacity="0.4"/>
              <line x1="${cx + r}" y1="${cy}" x2="${cx + r}" y2="${cy + 6}" stroke="var(--text-tertiary)" stroke-width="1" opacity="0.4"/>

              <!-- Fill arc with gradient and glow -->
              ${data.displayPercent > 0 ? svg`
                <path d="${fillArc}" fill="none" stroke="url(#${uid}-grad)" stroke-width="${strokeW}" stroke-linecap="round" filter="url(#${uid}-glow)"/>
              ` : ''}

              <!-- Center text -->
              <text x="${cx}" y="${cy - 32}" text-anchor="middle" font-size="36" font-weight="800" fill="${data.gaugeColor}" class="budget-gauge-percent">${data.usedPercent}%</text>
              <text x="${cx}" y="${cy - 12}" text-anchor="middle" font-size="11" font-weight="600" fill="var(--text-secondary)" letter-spacing="0.04em">${data.statusText.toUpperCase()}</text>
            `}
          </svg>
        </div>
        <div class="budget-health-summary">
          <span class="budget-health-status" style=${`--budget-health-tone: ${data.gaugeColor};`}>${data.statusText}</span>
          <p class="budget-health-amount">${fmtCur(data.totalExpenses)} <span class="budget-health-amount__of">of ${fmtCur(data.totalBudget)}</span></p>
          <p class="budget-health-remaining" style=${`color: ${data.gaugeColor};`}>${remainingText}</p>
          <p class="budget-health-note">${data.note}</p>
        </div>
      </div>
    `, container);
  });

  // Return cleanup function
  return cleanup;
}
