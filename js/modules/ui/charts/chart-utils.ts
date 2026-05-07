/**
 * Chart Utilities Module
 *
 * Shared utilities for chart rendering: tooltips.
 *
 * Phase 5g-1 (Inline-Behavior-Review rev 12, L16): removed
 * `cleanupChartListeners` and the seven handler-storage property slots it
 * iterated (`_chartHandler`, `_chartMoveHandler`, `_chartLeaveHandler`,
 * `_chartClickHandler`, `_barChartHandlers`, `_trendChartHandlers`,
 * `_weeklyRollupHandlers`). Grep across js/ confirmed:
 *   - zero callers of `cleanupChartListeners(` (the only `cleanupChartListeners`
 *     reference outside the old definition was an unused import in
 *     `chart-renderers.ts`, also deleted);
 *   - zero assignments to any of the `_chart*Handler*` slots — chart
 *     renderers attach listeners via Lit-html's `@event=${handler}` binding
 *     syntax, which teardown automatically on template re-render or host
 *     removal. The manual cleanup infrastructure was left over from an
 *     earlier non-Lit implementation.
 * Paired with the `ChartElementWithHandlers` / `ChartHandlerRecord` type
 * definitions in `js/types/index.ts` (deleted) and the inline `ChartElement`
 * / `WeeklyRollupElement` extensions (replaced with plain `HTMLElement`).
 *
 * @module chart-utils
 */
'use strict';

import DOM from '../../core/dom-cache.js';

// ==========================================
// TOOLTIP FUNCTIONS
// ==========================================

/**
 * Show tooltip at cursor position
 */
export function showChartTooltip(e: MouseEvent, text: string): void {
  let tooltip = DOM.get('chart-tooltip');
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
  const tooltip = DOM.get('chart-tooltip');
  if (tooltip) tooltip.style.display = 'none';
}
