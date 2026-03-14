/**
 * Edit Mode
 *
 * Handles transaction editing - start editing, cancel, and recurring preview.
 *
 * @module transactions/edit-mode
 */
'use strict';

import * as signals from '../core/signals.js';
import { form, navigation } from '../core/state-actions.js';
import DOM from '../core/dom-cache.js';
import { html, render } from '../core/lit-helpers.js';
import type { Transaction, TransactionType } from '../../types/index.js';

// ==========================================
// TYPES
// ==========================================

export type SwitchTabCallback = (type: TransactionType) => void;
export type GetTodayStrCallback = () => string;
export type RenderCategoriesCallback = () => void;

export interface EditModeConfig {
  RECURRING_MAX_ENTRIES: number;
}

// ==========================================
// CALLBACKS AND CONFIG
// ==========================================

// Callback for switchTab function
let switchTabFn: SwitchTabCallback | null = null;

// Callback for getTodayStr function
let getTodayStrFn: GetTodayStrCallback = (): string => new Date().toISOString().split('T')[0];

// Callback for rendering categories
let renderCategoriesFn: RenderCategoriesCallback | null = null;

// Configuration
let editConfig: EditModeConfig = {
  RECURRING_MAX_ENTRIES: 365
};

/**
 * Set the switchTab callback
 */
export function setSwitchTabFn(fn: SwitchTabCallback): void {
  switchTabFn = fn;
}

/**
 * Set the getTodayStr callback
 */
export function setGetTodayStrFn(fn: GetTodayStrCallback): void {
  getTodayStrFn = fn;
}

/**
 * Set the renderCategories callback
 */
export function setEditRenderCategoriesFn(fn: RenderCategoriesCallback): void {
  renderCategoriesFn = fn;
}

/**
 * Set edit mode configuration
 */
export function setEditConfig(config: Partial<EditModeConfig>): void {
  if (config.RECURRING_MAX_ENTRIES !== undefined) {
    editConfig.RECURRING_MAX_ENTRIES = config.RECURRING_MAX_ENTRIES;
  }
}

// ==========================================
// EDIT MODE FUNCTIONS
// ==========================================

/**
 * Start editing a transaction
 */
export function startEditing(tx: Transaction): void {
  form.setEditingId(tx.__backendId);

  const amountEl = DOM.get('amount') as HTMLInputElement | null;
  const descEl = DOM.get('description') as HTMLInputElement | null;
  const dateEl = DOM.get('date') as HTMLInputElement | null;
  const tagsEl = DOM.get('tags') as HTMLInputElement | null;
  const notesEl = DOM.get('tx-notes') as HTMLTextAreaElement | null;
  const recurringToggle = DOM.get('recurring-toggle') as HTMLInputElement | null;
  const recurringSection = DOM.get('recurring-section');
  const recurringTypeEl = DOM.get('recurring-type') as HTMLSelectElement | null;
  const recurringEndEl = DOM.get('recurring-end') as HTMLInputElement | null;
  const formTitle = DOM.get('form-title');
  const submitBtn = DOM.get('submit-btn') as HTMLButtonElement | null;
  const cancelBtn = DOM.get('cancel-edit-btn');
  const formSection = DOM.get('form-section');

  if (amountEl) amountEl.value = String(tx.amount);
  if (descEl) descEl.value = tx.description || '';
  if (dateEl) dateEl.value = tx.date;
  if (tagsEl) tagsEl.value = tx.tags || '';
  if (notesEl) notesEl.value = tx.notes || '';
  form.setSelectedCategory(tx.category);
  // Set recurring toggle based on transaction
  if (recurringToggle) recurringToggle.checked = tx.recurring === true;
  if (recurringSection) recurringSection.classList.toggle('hidden', !tx.recurring);
  if (switchTabFn) switchTabFn(tx.type);
  navigation.setCurrentTab(tx.type);
  form.setSelectedCategory(tx.category);
  if (renderCategoriesFn) renderCategoriesFn();
  if (tx.recurring) {
    if (recurringTypeEl) recurringTypeEl.value = tx.recurring_type || 'monthly';
    if (recurringEndEl) recurringEndEl.value = tx.recurring_end || '';
  }
  if (formTitle) formTitle.textContent = '✏️ Edit Transaction';
  if (submitBtn) {
    submitBtn.textContent = 'UPDATE TRANSACTION';
    submitBtn.style.background = 'linear-gradient(135deg, var(--color-accent), #1e40af)';
  }
  if (cancelBtn) cancelBtn.removeAttribute('hidden');
  formSection?.scrollIntoView({ behavior: 'smooth' });
}

/**
 * Cancel editing and reset the form
 */
export function cancelEditing(): void {
  form.clearEditingId();

  const formTitle = DOM.get('form-title');
  const submitBtn = DOM.get('submit-btn') as HTMLButtonElement | null;
  const cancelBtn = DOM.get('cancel-edit-btn');
  const amountEl = DOM.get('amount') as HTMLInputElement | null;
  const descEl = DOM.get('description') as HTMLInputElement | null;
  const dateEl = DOM.get('date') as HTMLInputElement | null;
  const tagsEl = DOM.get('tags') as HTMLInputElement | null;
  const notesEl = DOM.get('tx-notes') as HTMLTextAreaElement | null;
  const recurringTypeEl = DOM.get('recurring-type') as HTMLSelectElement | null;
  const recurringEndEl = DOM.get('recurring-end') as HTMLInputElement | null;
  const recurringToggle = DOM.get('recurring-toggle') as HTMLInputElement | null;
  const recurringSection = DOM.get('recurring-section');

  if (formTitle) formTitle.textContent = '➕ Add Transaction';
  if (submitBtn) {
    submitBtn.textContent = 'ADD TRANSACTION';
    submitBtn.style.background = 'linear-gradient(135deg, var(--color-income), var(--color-income-dark))';
  }
  if (cancelBtn) cancelBtn.setAttribute('hidden', '');
  if (amountEl) amountEl.value = '';
  if (descEl) descEl.value = '';
  if (dateEl) dateEl.value = getTodayStrFn();
  if (tagsEl) tagsEl.value = '';
  if (notesEl) notesEl.value = '';
  if (recurringTypeEl) recurringTypeEl.value = 'monthly';
  if (recurringEndEl) recurringEndEl.value = '';
  if (recurringToggle) recurringToggle.checked = false;
  if (recurringSection) recurringSection.classList.add('hidden');
  form.clearSelectedCategory();
  if (switchTabFn) switchTabFn((signals.currentType.value || 'expense') as TransactionType);
}

/**
 * Update the recurring transaction preview
 */
export function updateRecurringPreview(): void {
  const preview = DOM.get('recurring-preview');
  const previewText = DOM.get('recurring-preview-text');
  const previewWarning = DOM.get('recurring-preview-warning');
  const dateEl = DOM.get('date') as HTMLInputElement | null;
  const recurringEndEl = DOM.get('recurring-end') as HTMLInputElement | null;
  const recurringTypeEl = DOM.get('recurring-type') as HTMLSelectElement | null;

  if (!preview || !previewText) return;

  const startDate = dateEl?.value || '';
  const endDate = recurringEndEl?.value || '';
  const recurringType = recurringTypeEl?.value || 'monthly';

  if (!startDate || !endDate) {
    preview.classList.add('hidden');
    return;
  }

  const start = new Date(startDate);
  const end = new Date(endDate);
  if (end < start) {
    previewText.textContent = 'End date cannot be before start date';
    previewWarning?.classList.add('hidden');
    preview.classList.remove('hidden');
    return;
  }

  // Calculate number of occurrences
  let count = 0;
  const cur = new Date(start);
  while (cur <= end && count < editConfig.RECURRING_MAX_ENTRIES) {
    count++;
    switch (recurringType) {
      case 'daily': cur.setDate(cur.getDate() + 1); break;
      case 'weekly': cur.setDate(cur.getDate() + 7); break;
      case 'biweekly': cur.setDate(cur.getDate() + 14); break;
      case 'monthly': cur.setMonth(cur.getMonth() + 1); break;
      case 'quarterly': cur.setMonth(cur.getMonth() + 3); break;
      case 'yearly': cur.setFullYear(cur.getFullYear() + 1); break;
    }
  }

  const startStr = start.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const endStr = end.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  render(html`<strong>${count}</strong> transactions will be created<br>From ${startStr} to ${endStr}`, previewText);

  if (count >= editConfig.RECURRING_MAX_ENTRIES) {
    if (previewWarning) {
      previewWarning.textContent = `⚠️ Capped at ${editConfig.RECURRING_MAX_ENTRIES} transactions`;
      previewWarning.classList.remove('hidden');
    }
  } else {
    previewWarning?.classList.add('hidden');
  }

  preview.classList.remove('hidden');
}
