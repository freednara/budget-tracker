/**
 * Insights Component
 *
 * Reactive component that renders financial insights using computed signals.
 * Automatically updates when transaction data or settings change.
 *
 * @module components/insights
 */
'use strict';

import { effect, computed } from '@preact/signals-core';
import * as signals from '../core/signals.js';
import { html, render, nothing } from '../core/lit-helpers.js';
import { mountEffects, unmountEffects } from '../core/effect-manager.js';
import { generateInsights } from '../features/personalization/insights.js';
import { handleInsightAction as handleInsightActionImpl } from '../ui/core/ui-render.js';
import DOM from '../core/dom-cache.js';
import type { 
  InsightResult, 
  InsightResultWithAction, 
  InsightActionData 
} from '../../types/index.js';

// ==========================================
// COMPUTED INSIGHTS DATA
// ==========================================

/**
 * Computed insights that auto-update when data changes
 * FIXED: Now uses the centralized memoized signal to avoid duplicate logic
 */
const insightsData = computed(() => {
  // Prefer the memoized signal only when it matches the current object-shaped contract.
  const memoizedInsights = signals.currentInsights?.value as unknown;
  if (
    memoizedInsights &&
    !Array.isArray(memoizedInsights) &&
    typeof memoizedInsights === 'object' &&
    'insight1' in memoizedInsights &&
    'insight2' in memoizedInsights &&
    'insight3' in memoizedInsights
  ) {
    return memoizedInsights as {
      insight1: InsightResult | string;
      insight2: InsightResult | string;
      insight3: InsightResult | string;
    };
  }
  
  // Fallback to direct generation (for backwards compatibility)
  const _transactions = signals.transactions.value.length;
  const _currentMonth = signals.currentMonth.value;
  const _insightPersonality = signals.insightPers.value;
  
  return generateInsights();
});

// ==========================================
// HELPER FUNCTIONS
// ==========================================

/**
 * Handle insight action button clicks
 */
function handleInsightAction(actionData: InsightActionData): void {
  const { actionType, data } = actionData;
  const normalizedType = actionType === 'view-budget' ? 'goto-budget' : actionType;
  handleInsightActionImpl(normalizedType, { category: typeof data === 'string' ? data : undefined });
}

/**
 * Render a single insight result
 */
function renderInsight(result: InsightResult | null) {
  if (result === null) return nothing;
  
  if (typeof result === 'string') {
    return html`<div class="dashboard-insight-copy"><p class="dashboard-insight-text">${result}</p></div>`;
  }
  
  // Result is an object with text and optional action
  const resultObj = result as InsightResultWithAction;
  return html`
    <div class="dashboard-insight-copy">
      <p class="dashboard-insight-text">${resultObj.text}</p>
    ${resultObj.action ? html`
      <button type="button" class="insight-action-btn"
        @click=${() => handleInsightAction({ actionType: resultObj.action!.type, data: resultObj.action!.category })}
        style="background: var(--color-accent); color: white;">
        ${resultObj.action.label} →
      </button>
    ` : nothing}
    </div>
  `;
}

// ==========================================
// COMPONENT MOUNTING
// ==========================================

/**
 * Mount the reactive insights component
 * Returns cleanup function to dispose effects
 */
export function mountInsights(): () => void {
  const insight1 = DOM.get('insight-1');
  const insight2 = DOM.get('insight-2');
  const insight3 = DOM.get('insight-3');

  // Single effect that renders all 3 insight containers in one pass
  // (avoids 3 independent effect executions when insightsData changes)
  mountEffects('insights', [
    () => effect(() => {
      const insights = insightsData.value;

      if (insight1 && 'insight1' in insights) {
        render(renderInsight(insights.insight1), insight1);
      }
      if (insight2 && 'insight2' in insights) {
        render(renderInsight(insights.insight2), insight2);
      }
      if (insight3 && 'insight3' in insights) {
        render(renderInsight(insights.insight3), insight3);
      }
    }),
  ]);

  return () => unmountEffects('insights');
}
