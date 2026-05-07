/**
 * Edit Mode Module
 * 
 * Reactive transaction editing logic using signals.
 * Handles starting edits, canceling, and recurring transaction previews.
 */
'use strict';

import * as signals from '../core/signals.js';
import { form, navigation } from '../core/state-actions.js';
import {
  syncFormWithSignals,
  formAmount, formDescription, formDate, formTags,
  formNotes, formRecurring, formRecurringType, formRecurringEnd
} from './template-manager.js';
import { getTodayStr, parseLocalDate } from '../core/utils-pure.js';
import { formatDateShort } from '../core/locale-service.js';
import DOM from '../core/dom-cache.js';
import { html, render } from '../core/lit-helpers.js';
import { effect } from '@preact/signals-core';
import { renderCategories } from '../ui/core/ui-render.js';
import type { Transaction } from '../../types/index.js';
import { revealTransactionsForm } from '../ui/core/ui-navigation.js';

// ==========================================
// ACTIONS
// ==========================================

/**
 * Start editing a transaction
 */
export function startEditing(tx: Transaction): void {
  // 1. Update signals (Single Source of Truth)
  signals.isEditing.value = true;
  signals.editingId.value = tx.__backendId;
  signals.formTitle.value = '✏️ Edit Transaction';
  signals.submitButtonText.value = 'UPDATE TRANSACTION';
  
  // 2. Map transaction data to form signals
  formAmount.value = String(tx.amount);
  formDescription.value = tx.description || '';
  formDate.value = tx.date;
  formTags.value = tx.tags || '';
  formNotes.value = tx.notes || '';
  form.setSelectedCategory(tx.category);
  
  formRecurring.value = !!tx.recurring;
  if (tx.recurring) {
    formRecurringType.value = tx.recurring_type || 'monthly';
    formRecurringEnd.value = tx.recurring_end || '';
  }

  // 3. Update UI state
  navigation.setCurrentTab(tx.type);
  
  // 4. Finalize
  syncFormWithSignals();
  renderCategories();
  revealTransactionsForm('amount', true);
}

/**
 * Cancel editing and reset the form
 */
export function cancelEditing(): void {
  // 1. Reset edit signals
  signals.isEditing.value = false;
  signals.editingId.value = null;
  signals.formTitle.value = '➕ Add Transaction';
  signals.submitButtonText.value = 'ADD TRANSACTION';

  // 2. Reset form signals
  formAmount.value = '';
  formDescription.value = '';
  formDate.value = getTodayStr();
  formTags.value = '';
  formNotes.value = '';
  formRecurring.value = false;
  formRecurringType.value = 'monthly';
  formRecurringEnd.value = '';
  
  form.setSelectedCategory('');

  // 3. Finalize
  syncFormWithSignals();
  renderCategories();
}

/**
 * Advance a date by one step of the given recurring frequency, clamping the
 * day-of-month to preserve the caller's original day when the target month
 * is shorter (e.g. Jan 31 → Feb 28, Feb 29 → Feb 28 on non-leap years).
 *
 * Exported for direct unit testing — the preview loop below is the only
 * in-app caller, but the same leap-year / month-length invariants also
 * hold for every recurring-generator downstream, so isolating the math in
 * a pure function guards against drift across the codebase.
 *
 * rev 12 L27: yearly case added so Feb 29 starts no longer silently roll
 * to Mar 1 of the following year. Matches the same clamping pattern used
 * by monthly and quarterly cases, and aligns with the authoritative
 * generator in `data/recurring-templates.ts`.
 */
export function advanceRecurringPreviewDate(
  cur: Date,
  type: string,
  originalDay: number
): Date {
  switch (type) {
    case 'daily': {
      const next = new Date(cur);
      next.setDate(next.getDate() + 1);
      return next;
    }
    case 'weekly': {
      const next = new Date(cur);
      next.setDate(next.getDate() + 7);
      return next;
    }
    case 'biweekly': {
      const next = new Date(cur);
      next.setDate(next.getDate() + 14);
      return next;
    }
    case 'monthly': {
      // Prevent day-of-month drift (e.g. Jan 31 → Mar 3)
      const nextMonth = cur.getMonth() + 1;
      const nextYear = cur.getFullYear() + (nextMonth > 11 ? 1 : 0);
      const actualMonth = nextMonth % 12;
      const maxDay = new Date(nextYear, actualMonth + 1, 0).getDate();
      return new Date(nextYear, actualMonth, Math.min(originalDay, maxDay));
    }
    case 'quarterly': {
      const nextMonth = cur.getMonth() + 3;
      const nextYear = cur.getFullYear() + Math.floor(nextMonth / 12);
      const actualMonth = nextMonth % 12;
      const maxDay = new Date(nextYear, actualMonth + 1, 0).getDate();
      return new Date(nextYear, actualMonth, Math.min(originalDay, maxDay));
    }
    case 'yearly': {
      // Prevent Feb 29 → Mar 1 drift on non-leap years (and preserve
      // the Feb 29 start when the next year happens to be a leap year)
      const nextYear = cur.getFullYear() + 1;
      const actualMonth = cur.getMonth();
      const maxDay = new Date(nextYear, actualMonth + 1, 0).getDate();
      return new Date(nextYear, actualMonth, Math.min(originalDay, maxDay));
    }
    default:
      return new Date(cur);
  }
}

/**
 * Update the recurring transaction preview
 * WATCHES: formDate, formRecurringEnd, formRecurringType, formRecurring
 */
export function mountRecurringPreview(): () => void {
  const container = DOM.get('recurring-preview');
  if (!container) return () => {};

  const cleanup = effect(() => {
    const show = formRecurring.value;
    const start = formDate.value;
    const end = formRecurringEnd.value;
    const type = formRecurringType.value;

    if (!show || !start || !end) {
      render(html``, container);
      return;
    }

    // Calculate occurrences
    const startDate = parseLocalDate(start);
    const endDate = parseLocalDate(end);
    let count = 0;
    const MAX = 365;

    if (endDate < startDate) {
      render(html`
        <div class="p-3 rounded-xl bg-expense/10 text-expense text-xs font-bold border border-expense/20">
          ⚠️ End date cannot be before start date
        </div>
      `, container);
      return;
    }

    let cur = new Date(startDate);
    const originalDay = cur.getDate();
    while (cur <= endDate && count < MAX) {
      count++;
      cur = advanceRecurringPreviewDate(cur, type, originalDay);
    }

    render(html`
      <div class="p-4 rounded-xl bg-income/10 border border-income/20">
        <p class="text-xs font-bold text-primary mb-1">
          <strong>${count}</strong> transactions will be created
        </p>
        <p class="text-[10px] text-tertiary">
          From ${formatDateShort(startDate)} to ${formatDateShort(endDate)}
        </p>
        ${count >= MAX ? html`
          <p class="text-[10px] text-expense font-black uppercase tracking-widest mt-2">
            ⚠️ Capped at 365 entries
          </p>
        ` : ''}
      </div>
    `, container);
  });

  return cleanup;
}

// ==========================================
// RENDERERS
// ==========================================

/**
 * Mount all edit-mode UI elements
 */
export function mountEditUI(): () => void {
  const titleEl = DOM.get('form-title');
  const submitBtn = DOM.get('submit-btn');
  const cancelBtn = DOM.get('cancel-edit-btn');

  const cleanup = effect(() => {
    const isEditing = signals.isEditing.value;
    const title = signals.formTitle.value;
    const btnText = signals.submitButtonText.value;

    if (titleEl) titleEl.textContent = title;
    if (submitBtn) {
      submitBtn.textContent = btnText;
      if (isEditing) {
        submitBtn.style.background = 'linear-gradient(135deg, var(--color-accent), var(--color-accent-btn))';
      } else {
        submitBtn.style.background = 'linear-gradient(135deg, var(--color-income), var(--color-income-dark))';
      }
    }
    if (cancelBtn) {
      if (isEditing) cancelBtn.removeAttribute('hidden');
      else cancelBtn.setAttribute('hidden', '');
    }
  });

  const previewCleanup = mountRecurringPreview();

  return () => {
    cleanup();
    previewCleanup();
  };
}
