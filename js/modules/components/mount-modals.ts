/**
 * Mount Modals Component
 *
 * Orchestrates rendering of all modal components into a container.
 * Replaces static modal HTML in index.html with dynamic Lit templates.
 *
 * @module components/mount-modals
 */
'use strict';

import { html, render, type TemplateResult } from '../core/lit-helpers.js';

// Import modal templates
import { renderSimpleModals } from './simple-modals.js';
import { renderFormModals } from './form-modals.js';
import { renderSettingsModal } from './settings-modal.js';
import { renderAnalyticsModal } from './analytics-modal.js';

// ==========================================
// ALL MODALS TEMPLATE
// ==========================================

/**
 * Render all modals at once
 */
export function renderAllModals(): TemplateResult {
  return html`
    ${renderSimpleModals()}
    ${renderFormModals()}
    ${renderSettingsModal()}
    ${renderAnalyticsModal()}
  `;
}

// ==========================================
// MOUNT FUNCTION
// ==========================================

/**
 * Mount all modals into the specified container
 * Returns cleanup function that clears the container
 *
 * @param container - The container element to render modals into
 * @returns Cleanup function to unmount modals
 *
 * @example
 * ```typescript
 * const container = document.getElementById('modal-container')!;
 * const cleanup = mountModals(container);
 *
 * // Later, to unmount:
 * cleanup();
 * ```
 */
export function mountModals(container: HTMLElement): () => void {
  if (!container) {
    console.warn('mountModals: No container provided');
    return () => {};
  }

  // Render all modals into the container
  render(renderAllModals(), container);

  // Return cleanup function
  return () => {
    render(html``, container);
  };
}

// ==========================================
// INDIVIDUAL MODAL EXPORTS
// ==========================================

// Re-export individual modal templates for use elsewhere
export {
  renderSimpleModals,
  renderFormModals,
  renderSettingsModal,
  renderAnalyticsModal
};

// Re-export specific modals from simple-modals
export {
  renderDeleteModal,
  renderEditRecurringModal,
  renderImportModal,
  renderAddSavingsModal,
  renderSavingsGoalModal
} from './simple-modals.js';

// Re-export specific modals from form-modals
export {
  renderDebtModal,
  renderDebtPaymentModal,
  renderDebtStrategyModal,
  renderPlanBudgetModal,
  renderCategoryModal,
  renderSplitModal
} from './form-modals.js';
