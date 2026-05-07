/**
 * Analytics Modal Component
 *
 * Lit template for the analytics dashboard modal.
 * Maintains existing element IDs for backward compatibility.
 *
 * @module components/analytics-modal
 */
'use strict';

import { html, type TemplateResult } from '../core/lit-helpers.js';

// ==========================================
// ANALYTICS MODAL
// ==========================================

/**
 * Render the analytics modal
 */
export function renderAnalyticsModal(): TemplateResult {
  return html`
    <div id="analytics-modal" class="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="analytics-modal-title">
      <div class="rounded-2xl p-6 w-full card-shadow analytics-modal-shell modal-panel modal-panel--scroll" style="max-height: 90vh;">
        <div class="flex justify-between items-center mb-4">
          <!--
            Design-Review-Apr21 P3 (batch 6 follow-up wave O): initial
            focus used to land on the close button (the close-analytics
            button carried data-modal-initial-focus). For a read-heavy
            dashboard modal that is dominated by charts and KPI tiles
            rather than a primary action, focusing the dismiss
            affordance means keyboard users have to tab away from it
            just to reach the period tabs or the first analytic card.
            WAI-ARIA APG dialog pattern recommends focusing the
            dialog labelling element for read-first dialogs so the
            title is announced and focus sits on content, not a
            dismiss control. Marked the h3 title as the initial-focus
            target with tabindex set to minus-one (programmatically
            focusable but removed from the tab sequence so repeat
            Tab presses go forward through the content). The close
            button keeps its accessible name and remains one
            Tab/Shift-Tab away.
          -->
          <h3 id="analytics-modal-title" tabindex="-1" data-modal-initial-focus="true" class="text-xl font-black text-primary">📈 Analytics</h3>
          <button id="close-analytics" class="w-8 h-8 flex items-center justify-center rounded-lg text-lg form-input-secondary" aria-label="Close analytics">✕</button>
        </div>

        <!-- Year Tabs -->
        <div id="analytics-period-tabs" class="flex gap-2 mb-5 rounded-xl overflow-x-auto analytics-tabs-bar"></div>

        <!-- Year Summary Card -->
        <div id="analytics-year-summary" class="mb-5 p-4 rounded-xl analytics-card">
          <h4 class="text-sm font-bold mb-3 text-secondary">💰 YEAR SUMMARY</h4>
          <div id="year-summary-content" class="space-y-3">
            <!-- Populated by JS -->
          </div>
        </div>

        <!-- 12-Month Trend Chart -->
        <div id="analytics-trend-section" class="mb-5 p-4 rounded-xl analytics-card">
          <h4 id="analytics-trend-title" class="text-sm font-bold mb-3 text-secondary">📊 12-MONTH TREND</h4>
          <div id="analytics-trend-chart" class="w-full analytics-chart-min">
            <!-- Populated by JS -->
          </div>
        </div>

        <!-- Year-over-Year Comparison -->
        <div id="analytics-yoy-section" class="mb-5 p-4 rounded-xl analytics-card">
          <div class="flex items-center justify-between mb-3">
            <h4 class="text-sm font-bold text-secondary">⚖️ YEAR-OVER-YEAR COMPARISON</h4>
            <div class="flex gap-2 items-center">
              <select id="yoy-year1" class="px-2 py-1 rounded text-xs form-input" aria-label="First comparison year"></select>
              <span class="text-tertiary">vs</span>
              <select id="yoy-year2" class="px-2 py-1 rounded text-xs form-input" aria-label="Second comparison year"></select>
            </div>
          </div>
          <div id="yoy-comparison-chart" class="w-full analytics-chart-min--xl"></div>
          <div id="yoy-comparison-content" class="mt-4 pt-3 space-y-3 analytics-card__divider">
            <!-- Populated by JS -->
          </div>
        </div>

        <!-- Seasonal Patterns -->
        <div id="analytics-seasonal-section" class="mb-5 p-4 rounded-xl analytics-card">
          <h4 id="analytics-seasonal-title" class="text-sm font-bold mb-3 text-secondary">📅 SEASONAL SPENDING PATTERNS</h4>
          <div id="seasonal-pattern-chart" class="w-full analytics-chart-min--tall"></div>
          <div id="seasonal-insights" class="mt-4 space-y-2"></div>
        </div>

        <!-- Category Trends -->
        <div id="analytics-category-trends" class="mb-5 p-4 rounded-xl analytics-card">
          <div class="flex items-center justify-between mb-3">
            <h4 id="analytics-category-title" class="text-sm font-bold text-secondary">📈 CATEGORY SPENDING TRENDS</h4>
            <select id="trend-period-select" class="px-2 py-1 rounded text-xs form-input" aria-label="Trend period">
              <option value="6">6 months</option>
              <option value="12" selected>12 months</option>
              <option value="24">24 months</option>
            </select>
          </div>
          <div id="category-trends-chart" class="w-full analytics-chart-min--xl"></div>
          <div class="grid grid-cols-2 gap-3 mt-4">
            <div class="p-3 rounded-lg analytics-tint--expense">
              <p class="text-xs font-bold mb-2 text-expense">📈 GROWING</p>
              <div id="growing-categories" class="space-y-1"></div>
            </div>
            <div class="p-3 rounded-lg analytics-tint--income">
              <p class="text-xs font-bold mb-2 text-income">📉 SHRINKING</p>
              <div id="shrinking-categories" class="space-y-1"></div>
            </div>
          </div>
        </div>

        <!--
          Design-Review-Apr21 P2 (batch 6 follow-up wave N): dropped the
          static "Current Month" time-badge on both this section and the
          Budget-vs-Actual section. The comparison and budget-vs-actual
          logic are both driven off the currentMonth signal, and
          analytics-ui.ts already injects a dynamic month badge into the
          month-comparison-badge and budget-actual-badge spans. A second,
          static "Current Month" badge contradicted the reactive badge
          whenever the user navigated to a past/future month — the
          dynamic "vs March 2026" badge would sit alongside a static
          "Current Month" label, forcing the reader to reconcile two
          inconsistent period labels. The description copy was also
          rewritten away from "Current-month comparison" / "active
          budget month" (both assumed the real current month) to
          period-neutral phrasing that works in any viewed month.
        -->
        <div id="analytics-month-comparison-section" class="mb-5 p-4 rounded-xl analytics-detail-section card">
          <div class="flex items-center justify-between mb-3">
            <div>
              <h4 class="text-sm font-bold text-secondary">📈 MONTH VS LAST MONTH<span id="month-comparison-badge"></span></h4>
              <p class="analytics-description">Month-over-month comparison for income, expenses, and biggest movers.</p>
            </div>
          </div>
          <div id="month-comparison"></div>
        </div>

        <!-- Budget vs Actual -->
        <div id="budget-vs-actual-section" class="mb-5 p-4 rounded-xl analytics-detail-section hidden card">
          <div class="flex items-center justify-between mb-3">
            <div>
              <h4 class="text-sm font-bold text-secondary">📊 BUDGET VS ACTUAL<span id="budget-actual-badge"></span></h4>
              <p class="analytics-description">Assigned versus spent for the selected budget month.</p>
            </div>
          </div>
          <div id="budget-actual-chart" class="w-full analytics-chart-min--tall"></div>
        </div>

        <!-- All-Time Stats -->
        <div id="analytics-alltime-section" class="p-4 rounded-xl analytics-card">
          <h4 class="text-sm font-bold mb-3 text-secondary">🏆 ALL-TIME STATS</h4>
          <div id="alltime-stats-content" class="space-y-2">
            <!-- Populated by JS -->
          </div>
        </div>
      </div>
    </div>
  `;
}
