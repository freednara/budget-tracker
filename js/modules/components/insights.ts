/**
 * Insights Component
 *
 * Reactive component that renders financial insights using computed signals.
 * Automatically updates when transaction data or settings change.
 *
 * @module components/insights
 */
'use strict';

import { effect } from '@preact/signals-core';
import * as signals from '../core/signals.js';
import { html, render, nothing } from '../core/lit-helpers.js';
import { mountEffects, unmountEffects } from '../core/effect-manager.js';
import { handleInsightAction as handleInsightActionImpl } from '../ui/core/ui-render.js';
import DOM from '../core/dom-cache.js';
import type {
  InsightResult,
  InsightActionData,
  InsightAction
} from '../../types/index.js';

// ==========================================
// COMPUTED INSIGHTS DATA
// ==========================================
//
// Reads directly from `signals.currentInsights`, which is the single
// source of truth for both success and error paths (contract unified
// 2026-04-20 — see signals.ts P1 #1 fix). We no longer fall back to
// invoking `generateInsights()` directly when the shape "looks wrong":
// that fallback re-executed the failing code outside the signal's
// try/catch and crashed the dashboard.

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

const DEFAULT_INSIGHT_ACTIONS: Record<'insight1' | 'insight2' | 'insight3', InsightAction> = {
  insight1: { type: 'goto-transactions', label: 'View trend' },
  insight2: { type: 'goto-budget', label: 'View forecast' },
  insight3: { type: 'goto-transactions', label: 'View category' }
};

function renderInsightAction(action: InsightAction) {
  return html`
    <button
      type="button"
      class="insight-action-btn"
      @click=${() => handleInsightAction({ actionType: action.type, data: action.category })}
    >
      ${action.label} →
    </button>
  `;
}

/**
 * Render a single insight result.
 * When `suppressAction` is true (used by the error path), we render the
 * copy without any action button so a dashboard error doesn't advertise
 * a misleading CTA.
 */
function renderInsight(
  result: InsightResult | null,
  fallbackAction: InsightAction,
  suppressAction = false
) {
  if (result === null) return nothing;

  if (typeof result === 'string') {
    return html`
      <div class="dashboard-insight-copy">
        <p class="dashboard-insight-text">${result}</p>
        ${suppressAction ? nothing : renderInsightAction(fallbackAction)}
      </div>
    `;
  }

  // Result is an object with text and optional action
  const resultObj = result;
  const action = resultObj.action ?? fallbackAction;
  return html`
    <div class="dashboard-insight-copy">
      <p class="dashboard-insight-text">${resultObj.text}</p>
      ${suppressAction ? nothing : renderInsightAction(action)}
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
  // (avoids 3 independent effect executions when currentInsights changes).
  // Error-path rendering: when `_error` is true, suppress action buttons on
  // all three slots so the "temporarily unavailable" copy stands on its own.
  mountEffects('insights', [
    () => effect(() => {
      const insights = signals.currentInsights.value;
      const suppressAction = insights._error === true;

      if (insight1) {
        render(
          renderInsight(insights.insight1, DEFAULT_INSIGHT_ACTIONS.insight1, suppressAction),
          insight1
        );
      }
      if (insight2) {
        render(
          renderInsight(insights.insight2, DEFAULT_INSIGHT_ACTIONS.insight2, suppressAction),
          insight2
        );
      }
      if (insight3) {
        render(
          renderInsight(insights.insight3, DEFAULT_INSIGHT_ACTIONS.insight3, suppressAction),
          insight3
        );
      }
    }),
  ]);

  return () => unmountEffects('insights');
}
