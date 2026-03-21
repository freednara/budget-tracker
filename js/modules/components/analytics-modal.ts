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
      <div class="rounded-2xl p-6 max-w-2xl w-full card-shadow" style="background: var(--bg-card-section); border: 1px solid var(--border-section); max-height: 90vh; overflow-y: auto;">
        <div class="flex justify-between items-center mb-4">
          <h3 id="analytics-modal-title" class="text-xl font-black text-primary">📈 Analytics</h3>
          <button id="close-analytics" class="w-8 h-8 flex items-center justify-center rounded-lg text-lg" style="background: var(--bg-input); color: var(--text-secondary);" aria-label="Close analytics">✕</button>
        </div>

        <!-- Year Tabs -->
        <div id="analytics-period-tabs" class="flex gap-2 mb-5 p-1 rounded-xl overflow-x-auto" style="background: var(--bg-tab);"></div>

        <!-- Year Summary Card -->
        <div id="analytics-year-summary" class="mb-5 p-4 rounded-xl" style="background: var(--bg-card); border: 1px solid var(--border-card);">
          <h4 class="text-sm font-bold mb-3 text-secondary">💰 YEAR SUMMARY</h4>
          <div id="year-summary-content" class="space-y-3">
            <!-- Populated by JS -->
          </div>
        </div>

        <!-- 12-Month Trend Chart -->
        <div id="analytics-trend-section" class="mb-5 p-4 rounded-xl" style="background: var(--bg-card); border: 1px solid var(--border-card);">
          <h4 id="analytics-trend-title" class="text-sm font-bold mb-3 text-secondary">📊 12-MONTH TREND</h4>
          <div id="analytics-trend-chart" class="w-full" style="min-height: 200px;">
            <!-- Populated by JS -->
          </div>
        </div>

        <!-- Year-over-Year Comparison -->
        <div id="analytics-yoy-section" class="mb-5 p-4 rounded-xl" style="background: var(--bg-card); border: 1px solid var(--border-card);">
          <div class="flex items-center justify-between mb-3">
            <h4 class="text-sm font-bold text-secondary">⚖️ YEAR-OVER-YEAR COMPARISON</h4>
            <div class="flex gap-2 items-center">
              <select id="yoy-year1" class="px-2 py-1 rounded text-xs" style="background: var(--bg-input); color: var(--text-primary); border: 1px solid var(--border-input);"></select>
              <span class="text-tertiary">vs</span>
              <select id="yoy-year2" class="px-2 py-1 rounded text-xs" style="background: var(--bg-input); color: var(--text-primary); border: 1px solid var(--border-input);"></select>
            </div>
          </div>
          <div id="yoy-comparison-chart" class="w-full" style="min-height: 280px;"></div>
          <div id="yoy-comparison-content" class="mt-4 pt-3 space-y-3" style="border-top: 1px solid var(--border-card);">
            <!-- Populated by JS -->
          </div>
        </div>

        <!-- Seasonal Patterns -->
        <div id="analytics-seasonal-section" class="mb-5 p-4 rounded-xl" style="background: var(--bg-card); border: 1px solid var(--border-card);">
          <h4 id="analytics-seasonal-title" class="text-sm font-bold mb-3 text-secondary">📅 SEASONAL SPENDING PATTERNS</h4>
          <div id="seasonal-pattern-chart" class="w-full" style="min-height: 260px;"></div>
          <div id="seasonal-insights" class="mt-4 space-y-2"></div>
        </div>

        <!-- Category Trends -->
        <div id="analytics-category-trends" class="mb-5 p-4 rounded-xl" style="background: var(--bg-card); border: 1px solid var(--border-card);">
          <div class="flex items-center justify-between mb-3">
            <h4 id="analytics-category-title" class="text-sm font-bold text-secondary">📈 CATEGORY SPENDING TRENDS</h4>
            <select id="trend-period-select" class="px-2 py-1 rounded text-xs" style="background: var(--bg-input); color: var(--text-primary); border: 1px solid var(--border-input);">
              <option value="6">6 months</option>
              <option value="12" selected>12 months</option>
              <option value="24">24 months</option>
            </select>
          </div>
          <div id="category-trends-chart" class="w-full" style="min-height: 280px;"></div>
          <div class="grid grid-cols-2 gap-3 mt-4">
            <div class="p-3 rounded-lg" style="background: color-mix(in srgb, var(--color-expense) 10%, transparent);">
              <p class="text-xs font-bold mb-2 text-expense">📈 GROWING</p>
              <div id="growing-categories" class="space-y-1"></div>
            </div>
            <div class="p-3 rounded-lg" style="background: color-mix(in srgb, var(--color-income) 10%, transparent);">
              <p class="text-xs font-bold mb-2 text-income">📉 SHRINKING</p>
              <div id="shrinking-categories" class="space-y-1"></div>
            </div>
          </div>
        </div>

        <!-- All-Time Stats -->
        <div id="analytics-alltime-section" class="p-4 rounded-xl" style="background: var(--bg-card); border: 1px solid var(--border-card);">
          <h4 class="text-sm font-bold mb-3 text-secondary">🏆 ALL-TIME STATS</h4>
          <div id="alltime-stats-content" class="space-y-2">
            <!-- Populated by JS -->
          </div>
        </div>
      </div>
    </div>
  `;
}
