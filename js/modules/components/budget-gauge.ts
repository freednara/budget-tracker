/**
 * Budget Gauge Component
 *
 * Reactive component that renders a semi-circular SVG gauge
 * showing budget health. Automatically updates when budget
 * allocations or transactions change.
 *
 * @module components/budget-gauge
 */
'use strict';

import { effect, computed } from '@preact/signals-core';
import * as signals from '../core/signals.js';
import { html, svg, render } from '../core/lit-helpers.js';
import { fmtCur } from '../core/utils.js';
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
  statusText: string;
  totalExpenses: number;
  totalBudget: number;
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
      statusText: 'New',
      totalExpenses: 0,
      totalBudget: 0,
      note: 'Set category budgets to start tracking pressure against plan.'
    };
  }

  const usedPercent = Math.min(150, Math.round((totalExpenses / totalBudget) * 100));
  const displayPercent = Math.min(usedPercent, 100);

  let gaugeColor = 'var(--color-income)'; // Green: <80%
  let statusText = 'Healthy';
  let note = 'Spending is comfortably inside the plan.';
  if (usedPercent >= 100) {
    gaugeColor = 'var(--color-expense)'; // Red: Over budget
    statusText = 'Over';
    note = 'Spending is past plan. Rebalance budget or cut back.';
  } else if (usedPercent >= 80) {
    gaugeColor = 'var(--color-warning)'; // Yellow: 80-100%
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
    statusText,
    totalExpenses,
    totalBudget,
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

  // SVG dimensions
  const w = 200, h = 120;
  const cx = w / 2, cy = h - 10;
  const r = 70;
  const startAngle = Math.PI; // 180 degrees (left)
  const endAngle = 0; // 0 degrees (right)

  // Background arc (constant)
  const bgArc = describeArc(cx, cy, r, startAngle, endAngle);

  // Effect for gauge rendering
  const cleanup = effect(() => {
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

    render(html`
      <div class="budget-health-layout">
        <div class="budget-health-gauge-wrap">
          <svg viewBox="0 0 ${w} ${h}" class="budget-health-gauge" role="img" aria-label="Budget health gauge showing ${data.usedPercent}% used">
            <title>Budget Health</title>
            <desc>Semi-circular gauge indicating ${data.statusText} status with ${data.usedPercent}% of budget used</desc>
            ${svg`
              <path d="${bgArc}" fill="none" stroke="var(--bg-input)" stroke-width="14" stroke-linecap="round"/>
              <path d="${fillArc}" fill="none" stroke="${data.gaugeColor}" stroke-width="14" stroke-linecap="round"/>
              <text x="${cx}" y="${cy - 25}" text-anchor="middle" font-size="28" font-weight="800" fill="${data.gaugeColor}">${data.usedPercent}%</text>
              <text x="${cx}" y="${cy - 5}" text-anchor="middle" font-size="10" fill="var(--text-secondary)">${data.statusText}</text>
            `}
          </svg>
        </div>
        <div class="budget-health-summary">
          <span class="budget-health-status" style=${`--budget-health-tone: ${data.gaugeColor};`}>${data.statusText}</span>
          <p class="budget-health-amount">${fmtCur(data.totalExpenses)} of ${fmtCur(data.totalBudget)} used</p>
          <p class="budget-health-note">${data.note}</p>
        </div>
      </div>
    `, container);
  });

  // Return cleanup function
  return cleanup;
}
