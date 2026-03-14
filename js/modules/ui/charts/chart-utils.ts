/**
 * Chart Utilities Module
 *
 * Shared utilities for chart rendering: tooltips and event cleanup.
 *
 * @module chart-utils
 */
'use strict';

import DOM from '../../core/dom-cache.js';
import type { ChartElementWithHandlers, ChartHandlerRecord } from '../../../types/index.js';

// ==========================================
// EVENT LISTENER CLEANUP
// ==========================================

/**
 * Clean up all chart event listeners to prevent memory leaks
 * Handles two patterns:
 * - Pattern 1: Individual handler functions (donut chart)
 * - Pattern 2: Array of {element, type, handler} objects (bar, trend charts)
 */
export function cleanupChartListeners(el: HTMLElement | null): void {
  if (!el) return;

  // Use type assertion with indexed access for dynamic property access
  const chartEl = el as unknown as Record<string, unknown>;

  // Pattern 1: Individual handler functions (donut chart style)
  const singleHandlerKeys = ['_chartHandler', '_chartMoveHandler', '_chartLeaveHandler', '_chartClickHandler'];
  singleHandlerKeys.forEach(key => {
    const handler = chartEl[key];
    if (handler && typeof handler === 'function') {
      el.removeEventListener('mouseenter', handler as EventListener, true);
      el.removeEventListener('mousemove', handler as EventListener, true);
      el.removeEventListener('mouseleave', handler as EventListener, true);
      el.removeEventListener('click', handler as EventListener, true);
      chartEl[key] = null;
    }
  });

  // Pattern 2: Array of {element, type, handler} objects (bar, trend, weekly rollup charts)
  const arrayHandlerKeys = ['_barChartHandlers', '_trendChartHandlers', '_weeklyRollupHandlers'];
  arrayHandlerKeys.forEach(key => {
    const handlers = chartEl[key] as ChartHandlerRecord[] | null | undefined;
    if (handlers && Array.isArray(handlers)) {
      handlers.forEach(({ element, type, handler }) => {
        if (element && handler) {
          element.removeEventListener(type, handler);
        }
      });
      chartEl[key] = null;
    }
  });
}

// ==========================================
// TOOLTIP FUNCTIONS
// ==========================================

/**
 * Show tooltip at cursor position
 */
export function showChartTooltip(e: MouseEvent, text: string): void {
  let tooltip = DOM.get('chart-tooltip') as HTMLElement | null;
  if (!tooltip) {
    tooltip = document.createElement('div');
    tooltip.id = 'chart-tooltip';
    tooltip.className = 'chart-tooltip';
    document.body.appendChild(tooltip);
  }
  tooltip.textContent = text;
  tooltip.style.display = 'block';
  tooltip.style.left = `${e.pageX + 10}px`;
  tooltip.style.top = `${e.pageY - 30}px`;
}

/**
 * Hide the chart tooltip
 */
export function hideChartTooltip(): void {
  const tooltip = DOM.get('chart-tooltip') as HTMLElement | null;
  if (tooltip) tooltip.style.display = 'none';
}
