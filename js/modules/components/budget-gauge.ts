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
import { html, render, unsafeSVG } from '../core/lit-helpers.js';
import { fmtCur } from '../core/utils.js';
import DOM from '../core/dom-cache.js';

// ==========================================
// SVG HELPERS
// ==========================================

/**
 * Helper function to describe SVG arc path
 */
function describeArc(cx: number, cy: number, r: number, startAngle: number, endAngle: number): string {
  const x1 = cx + r * Math.cos(startAngle);
  const y1 = cy - r * Math.sin(startAngle);
  const x2 = cx + r * Math.cos(endAngle);
  const y2 = cy - r * Math.sin(endAngle);
  const largeArc = Math.abs(endAngle - startAngle) > Math.PI ? 1 : 0;
  const sweep = startAngle > endAngle ? 1 : 0;
  return `M ${x1} ${y1} A ${r} ${r} 0 ${largeArc} ${sweep} ${x2} ${y2}`;
}

// ==========================================
// COMPUTED SIGNALS
// ==========================================

/**
 * Budget gauge display data
 */
interface GaugeData {
  hasBudget: boolean;
  usedPercent: number;
  displayPercent: number;
  gaugeColor: string;
  statusText: string;
  totalExpenses: number;
  totalBudget: number;
}

const gaugeData = computed((): GaugeData => {
  const totalBudget = signals.totalBudget.value;
  const totalExpenses = signals.currentMonthTotals.value.expenses;

  if (totalBudget === 0) {
    return {
      hasBudget: false,
      usedPercent: 0,
      displayPercent: 0,
      gaugeColor: 'var(--color-income)',
      statusText: 'No Budget',
      totalExpenses: 0,
      totalBudget: 0
    };
  }

  const usedPercent = Math.min(150, Math.round((totalExpenses / totalBudget) * 100));
  const displayPercent = Math.min(usedPercent, 100);

  let gaugeColor = 'var(--color-income)'; // Green: <80%
  let statusText = 'Healthy';
  if (usedPercent >= 100) {
    gaugeColor = 'var(--color-expense)'; // Red: Over budget
    statusText = 'Over Budget';
  } else if (usedPercent >= 80) {
    gaugeColor = 'var(--color-warning)'; // Yellow: 80-100%
    statusText = 'Caution';
  }

  return {
    hasBudget: true,
    usedPercent,
    displayPercent,
    gaugeColor,
    statusText,
    totalExpenses,
    totalBudget
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
    if (!data.hasBudget) {
      section.classList.add('hidden');
      return;
    }
    section.classList.remove('hidden');

    // Calculate fill arc
    const fillAngle = startAngle - (startAngle - endAngle) * (data.displayPercent / 100);
    const fillArc = describeArc(cx, cy, r, startAngle, fillAngle);

    // Build SVG content
    const svgContent = `
      <path d="${bgArc}" fill="none" stroke="var(--bg-input)" stroke-width="14" stroke-linecap="round"/>
      <path d="${fillArc}" fill="none" stroke="${data.gaugeColor}" stroke-width="14" stroke-linecap="round"/>
      <text x="${cx}" y="${cy - 25}" text-anchor="middle" font-size="28" font-weight="800" fill="${data.gaugeColor}">${data.usedPercent}%</text>
      <text x="${cx}" y="${cy - 5}" text-anchor="middle" font-size="10" fill="var(--text-secondary)">${data.statusText}</text>
    `;

    render(html`
      <svg viewBox="0 0 ${w} ${h}" class="w-48" role="img" aria-label="Budget health gauge showing ${data.usedPercent}% used">
        <title>Budget Health</title>
        <desc>Semi-circular gauge indicating ${data.statusText} status with ${data.usedPercent}% of budget used</desc>
        ${unsafeSVG(svgContent)}
      </svg>
      <div class="text-center mt-2">
        <p class="text-xs" style="color: var(--text-tertiary);">
          ${fmtCur(data.totalExpenses)} of ${fmtCur(data.totalBudget)} budget used
        </p>
      </div>
    `, container);
  });

  // Return cleanup function
  return cleanup;
}
