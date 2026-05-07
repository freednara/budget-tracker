/**
 * Form Events Module
 *
 * Handles transaction form submission and real-time validation using reactive signals.
 *
 * @module form-events
 */
'use strict';

import * as signals from '../../core/signals.js';
import { batch, effect } from '@preact/signals-core';
import { actions, batchUpdates } from '../../core/state-actions.js';
import { parseAmount, getTodayStr, parseLocalDate } from '../../core/utils-pure.js';
import { showToast } from '../core/ui.js';
import { dataSdk } from '../../data/data-manager.js';
import { createRecurringTemplate } from '../../data/recurring-templates.js';
import { emit, Events, createListenerGroup, destroyListenerGroup } from '../../core/event-bus.js';
import { validator } from '../../core/validator.js';
import { checkAchievements } from '../../core/feature-event-interface.js';
import { handleError } from '../../core/global-error-handler.js';
import { localeService } from '../../core/locale-service.js';
import DOM from '../../core/dom-cache.js';
import { FormBinder } from '../../core/form-binder.js';
import type { Transaction, TransactionValidationResult } from '../../../types/index.js';

// Import form signals from template manager
import {
  formAmount,
  formDescription,
  formTags,
  formDate,
  formNotes,
  formRecurring,
  formRecurringType,
  formRecurringEnd,
  syncFormWithSignals,
  readFormIntoSignals
} from '../../transactions/template-manager.js';

// ==========================================
// TYPE DEFINITIONS
// ==========================================

interface FormEventCallbacks {
  // Accept sync or async callers: `cancelEditing` is often a thin async
  // wrapper around a dynamic `import('../transactions/edit-mode.js')`.
  // The form never awaits these — fire-and-forget — so async variants
  // must handle their own errors (trackError) if needed.
  cancelEditing?: () => void | Promise<void>;
  renderCategories?: () => void | Promise<void>;
}

interface ValidationErrors {
  errors: Record<string, string>;
  // Phase 6 Slice 1j (rev 12 L6): widen to allow explicit `undefined`
  // under `exactOptionalPropertyTypes` — callers often pull this from
  // `Object.keys(errors)[0]` which is `string | undefined`.
  firstErrorField?: string | undefined;
}

const FIELD_LABELS: Record<string, string> = {
  amount: 'amount',
  category: 'category',
  date: 'date',
  description: 'description',
  notes: 'notes',
  tags: 'tags'
};

function getFieldElement(field: string): HTMLElement | null {
  if (field === 'category') {
    return DOM.get('category-chips');
  }
  if (field === 'notes') {
    return DOM.get('tx-notes');
  }
  return DOM.get(field);
}

function showCategoryError(message: string): void {
  const chips = DOM.get('category-chips');
  const errorEl = DOM.get('category-error');

  if (chips) {
    chips.style.outline = '2px solid var(--color-expense)';
    chips.style.outlineOffset = '4px';
    chips.setAttribute('aria-invalid', 'true');
  }
  if (errorEl) {
    errorEl.classList.remove('hidden');
    // Clear then set text so screen readers re-announce via role="alert"
    errorEl.textContent = '';
    requestAnimationFrame(() => { errorEl.textContent = message; });
  }
}

function clearCategoryError(): void {
  const chips = DOM.get('category-chips');
  const errorEl = DOM.get('category-error');

  if (chips) {
    chips.style.outline = '';
    chips.style.outlineOffset = '';
    chips.removeAttribute('aria-invalid');
  }
  if (errorEl) {
    errorEl.textContent = 'Please select a category';
    errorEl.classList.add('hidden');
  }
}

function summarizeValidationErrors(errors: Record<string, string>): string {
  const fields = Object.keys(errors);
  if (fields.length === 0) return 'Please fix the highlighted fields';

  if (fields.length === 1) {
    // Phase 6 Slice 1i (rev 12 L6): `fields[0]` is `string | undefined`
    // under `noUncheckedIndexedAccess`; the `length === 1` guard above
    // guarantees presence, but a local narrow keeps index-access typed.
    const field = fields[0] ?? '';
    return errors[field] || `Please fix the ${FIELD_LABELS[field] || field} field`;
  }

  const labels = fields.map((field) => FIELD_LABELS[field] || field);
  return `Please complete: ${labels.join(', ')}`;
}

/** Form-specific subset of Transaction fields collected from user input */
interface TransactionFormData {
  amount: number;
  description: string;
  date: string;
  tags: string;
  notes: string;
  recurring: boolean;
  recurring_type: string;
  recurring_end: string;
}

// ==========================================
// MODULE STATE
// ==========================================

// Module-level callback slots. Widened to `void | Promise<void>` so that
// async suppliers (e.g. `cancelEditing` in app-init-di.ts — a dynamic
// `await import()` wrapper) can be stored and invoked without
// no-misused-promises errors at the assignment site.
let cancelEditingFn: (() => void | Promise<void>) | null = null;
let renderCategoriesFn: (() => void | Promise<void>) | null = null;

// Form state
let isSubmitting = false;
let eventGroupId: string | null = null;
let formBinderInstance: FormBinder | null = null;
let boundFormElement: HTMLFormElement | null = null;
let boundCancelEditButton: HTMLElement | null = null;
let disposeCurrencyDisplay: (() => void) | null = null;

const handleCancelEditClick = (): void => {
  // `void` discard: cancelEditingFn slot is widened to
  // `() => void | Promise<void>` (supplier is a dynamic-import wrapper).
  // Rejections surface via the supplier's own trackError routing.
  if (cancelEditingFn) void cancelEditingFn();
};

// Phase 6 Slice 1b (L5 no-escape-hatch, #181): sync wrapper for the async
// `handleFormSubmit`. addEventListener's EventListener type expects a
// `void` return, and no-misused-promises forbids passing a Promise-
// returning function directly. Using the same bound reference here lets
// `addEventListener` and `removeEventListener` match; errors thrown
// inside handleFormSubmit are already routed through its own
// try/catch -> `handleError`, so the `void` discard here is safe.
const handleFormSubmitBound = (e: Event): void => {
  void handleFormSubmit(e);
};

// ==========================================
// REACTIVE FORM BINDING
// ==========================================

/**
 * Set up reactive two-way data binding between DOM and signals
 */
export function initReactiveForm(): void {
  eventGroupId = createListenerGroup('form-events');
  formBinderInstance = new FormBinder();

  // Bind all form fields to their signals (fully reactive)
  formBinderInstance.bind('amount', formAmount);
  formBinderInstance.bind('description', formDescription);
  formBinderInstance.bind('date', formDate, { event: 'change' });
  formBinderInstance.bind('tags', formTags);
  formBinderInstance.bind('tx-notes', formNotes);
  formBinderInstance.bind('recurring-toggle', formRecurring, { event: 'change' });
  formBinderInstance.bind('recurring-type', formRecurringType, { event: 'change' });
  formBinderInstance.bind('recurring-end', formRecurringEnd);

  // Keep the currency-display prefix in sync with the active currency
  const currencyDisplayEl = DOM.get('currency-display');
  if (currencyDisplayEl) {
    disposeCurrencyDisplay = effect(() => {
      currencyDisplayEl.textContent = signals.currency.value.symbol;
    });
  }
}

/**
 * Clean up reactive form bindings
 */
export function cleanupReactiveForm(): void {
  if (disposeCurrencyDisplay) {
    disposeCurrencyDisplay();
    disposeCurrencyDisplay = null;
  }

  if (formBinderInstance) {
    formBinderInstance.clear();
    formBinderInstance = null;
  }

  if (eventGroupId) {
    destroyListenerGroup(eventGroupId);
    eventGroupId = null;
  }
}

export function cleanupFormEvents(): void {
  if (boundFormElement) {
    boundFormElement.removeEventListener('submit', handleFormSubmitBound);
    boundFormElement = null;
  }

  if (boundCancelEditButton) {
    boundCancelEditButton.removeEventListener('click', handleCancelEditClick);
    boundCancelEditButton = null;
  }

  cleanupReactiveForm();
}

/**
 * Reactive form validation using current signal values
 */
function validateFormReactive(): TransactionValidationResult {
  const data = getTransactionFormDataFromSignals();

  // Use validator.ts for comprehensive validation
  const transactionData = {
    type: signals.currentType.value,
    amount: data.amount,
    description: data.description,
    category: signals.selectedCategory.value,
    date: data.date,
    notes: data.notes,
    tags: data.tags
  };

  const result = validator.validateTransaction(transactionData);
  
  if (!result.valid) {
    emit(Events.FORM_VALIDATED, { 
      valid: false, 
      errors: result.errors,
      firstErrorField: Object.keys(result.errors)[0]
    });
  } else {
    emit(Events.FORM_VALIDATED, { valid: true });
  }

  return result;
}

// ==========================================
// INITIALIZATION
// ==========================================

/**
 * Initialize form event handlers with callbacks
 */
export function initFormEvents(callbacks: FormEventCallbacks): void {
  if (callbacks.cancelEditing) cancelEditingFn = callbacks.cancelEditing;
  if (callbacks.renderCategories) renderCategoriesFn = callbacks.renderCategories;

  cleanupFormEvents();
  initReactiveForm();

  boundFormElement = DOM.get('transaction-form');
  if (boundFormElement) {
    boundFormElement.addEventListener('submit', handleFormSubmitBound);
  }

  boundCancelEditButton = DOM.get('cancel-edit-btn');
  boundCancelEditButton?.addEventListener('click', handleCancelEditClick);
}

// ==========================================
// FORM SUBMISSION
// ==========================================

/**
 * Handle form submission
 */
export async function handleFormSubmit(e?: Event): Promise<void> {
  if (e) e.preventDefault();

  const sb = DOM.get('submit-btn') as HTMLButtonElement;
  if (!sb || sb.disabled || isSubmitting) return;
  
  isSubmitting = true;
  sb.disabled = true;
  const originalText = sb.textContent;
  sb.textContent = 'Saving…';

  try {
    // 1. Sync any remaining DOM state
    readFormIntoSignals();

    // 2. Validate
    const validationResult = validateFormReactive();

    if (!validationResult.valid) {
      handleValidationErrors({
        errors: validationResult.errors,
        firstErrorField: Object.keys(validationResult.errors)[0]
      });
      return;
    }

    // 3. Process
    const formData = getTransactionFormDataFromSignals();
    if (signals.editingId.value) {
      await handleEditTransaction(formData);
    } else {
      await handleNewTransaction(formData);
    }

    emit(Events.FORM_SUBMITTED, { 
      type: signals.currentType.value,
      amount: formData.amount 
    });

    checkAchievements();

  } catch (err) {
    // Phase 5g-2 (Inline-Behavior-Review rev 12, L34): narrow on
    // `err.name === 'QuotaExceededError'` before asserting storage is
    // full. The original catch assumed every submit failure was a quota
    // hit and surfaced a misleading "delete old transactions" toast for
    // unrelated faults (network errors in the Firestore write path,
    // synchronous validator throws, etc.), which trained users to delete
    // data for bugs that had nothing to do with storage pressure. The
    // narrow check matches the simple `.name` probe used in
    // `safe-storage.ts:46` and `error-boundary.ts:276,298`; we don't
    // need `storage-manager.isQuotaExceeded`'s 4-condition sweep here
    // because the submit path funnels through `dataSdk.create/update`
    // which either returns a Result (handled in the success branch
    // above) or throws a proper DOMException. `trackError` routing is
    // preserved via `handleError` — it fires regardless of the narrow.
    handleError('Transaction submit error', err, { module: 'form-events' });
    const isQuota =
      (err as { name?: string } | null | undefined)?.name === 'QuotaExceededError';
    if (isQuota) {
      showToast(
        'Storage full \u2014 delete old transactions or export a backup to free space.',
        'error'
      );
    } else {
      showToast(
        'Couldn\u2019t save transaction \u2014 please try again.',
        'error'
      );
    }
  } finally {
    isSubmitting = false;
    if (sb) {
      sb.textContent = originalText;
      sb.disabled = false;
    }
  }
}

/**
 * Get transaction data from current signal values
 */
function getTransactionFormDataFromSignals(): TransactionFormData {
  return {
    amount: parseAmount(formAmount.value),
    description: formDescription.value,
    date: formDate.value || getTodayStr(),
    tags: formTags.value,
    notes: formNotes.value,
    recurring: formRecurring.value,
    recurring_type: formRecurringType.value,
    recurring_end: formRecurringEnd.value
  };
}

/**
 * Handle validation errors
 */
function handleValidationErrors(validationErrors: ValidationErrors): void {
  const { errors, firstErrorField } = validationErrors;
  
  Object.entries(errors).forEach(([field, message]) => {
    if (field === 'category') {
      showCategoryError(message);
      return;
    }
    validator.showFieldError(getFieldElement(field), message);
  });

  if (firstErrorField) {
    if (firstErrorField === 'category') {
      (DOM.query('.category-chip'))?.focus();
    } else {
      getFieldElement(firstErrorField)?.focus();
    }
  }

  showToast(summarizeValidationErrors(errors), 'error');
}

/**
 * Handle new transaction submission
 */
async function handleNewTransaction(data: TransactionFormData): Promise<void> {
  const newTx: Partial<Transaction> = {
    type: signals.currentType.value as 'expense' | 'income',
    amount: data.amount,
    description: data.description,
    category: signals.selectedCategory.value,
    date: data.date,
    tags: data.tags,
    notes: data.notes
  };

  if (data.recurring) {
    await handleRecurringTransaction(newTx, data);
  } else {
    const result = await dataSdk.create(newTx);
    if (result.isOk) {
      batchUpdates(() => {
        actions.pagination.resetPage();
      });
      // Phase 5g-2 (Inline-Behavior-Review rev 12, L34 bonus): route through
      // `localeService.formatCurrency` so non-USD users see their currency
      // symbol/placement/separators. Previously hardcoded `$` + `.toFixed(2)`
      // showed "$1234.56" to EUR/GBP/JPY users regardless of their settings.
      showToast(`${localeService.formatCurrency(data.amount)} ${signals.currentType.value} added to ${signals.selectedCategory.value}`, 'success');
    } else {
      showToast(result.error || 'Couldn\u2019t save \u2014 check connection and storage, then try again.', 'error');
    }
  }

  clearForm();
}

/**
 * Handle edit transaction submission
 */
async function handleEditTransaction(data: TransactionFormData): Promise<void> {
  const editId = signals.editingId.value;
  if (!editId) return;

  // 7b (Inline-Behavior-Review P2, Transaction edit partial-payload field strip):
  // `dataSdk.update` is replace-semantics — it writes the payload verbatim into
  // the row (`newData[idx] = updatedTx` at `data-manager.ts:714`). Building a
  // 7-field partial payload and casting to `Transaction` silently strips every
  // field the form doesn't touch: `currency`, `recurring`, `recurring_type`,
  // `recurring_end`, `reconciled`, `splits`, `parentTxId`, `debtId`,
  // `recurringTemplateId`. Two of those (`currency`, `recurring`) are
  // *required* fields on the `Transaction` interface — the cast was hiding a
  // type lie. Real-world impact: editing a recurring transaction unlinked it
  // from its template (`recurringTemplateId` → undefined) so the template
  // module could no longer delete the row on parent removal; editing a debt
  // payment dropped `debtId` so the transaction stopped appearing in the
  // debt drill-down; editing a non-USD row dropped `currency` so the stored
  // ISO code became `undefined`.
  //
  // Fix: fetch the original row and merge the form's field set on top, the
  // same shape `UpdateTransactionOperation.execute` uses at
  // `transaction-operations.ts:82-85` (the atomic-ops path already does this
  // correctly — the ad-hoc direct-update path here was the outlier).
  const originalTx = await dataSdk.get(editId);
  if (!originalTx) {
    // The row was deleted between the edit-mode open and the form submit
    // (another tab, a rollback, an import-replace). Surface an actionable
    // error and abort — replacing an undefined original with the form's
    // partial would materialize a phantom row with every absent field
    // stripped.
    showToast('This transaction no longer exists \u2014 it may have been deleted in another tab. Refresh and try again.', 'error');
    actions.form.setEditingId(null);
    if (cancelEditingFn) void cancelEditingFn();
    clearForm();
    return;
  }

  // Round 7 fix: Re-fetch the latest version just before save to catch concurrent edits from other tabs
  const latestTx = await dataSdk.get(editId);
  if (!latestTx) {
    showToast('This transaction was deleted while you were editing. Refresh and try again.', 'error');
    actions.form.setEditingId(null);
    if (cancelEditingFn) void cancelEditingFn();
    clearForm();
    return;
  }

  const txPayload: Transaction = {
    ...latestTx,
    type: signals.currentType.value as 'expense' | 'income',
    amount: data.amount,
    description: data.description,
    category: signals.selectedCategory.value,
    date: data.date,
    tags: data.tags,
    notes: data.notes,
    __backendId: editId
  };
  const result = await dataSdk.update(txPayload);
  if (!result.isOk) {
    showToast(result.error || 'Update failed \u2014 check amounts and dates are valid, then resubmit.', 'error');
    return;
  }

  // CR-Apr24-C3 [P2] finding 143: read `editSeriesMode` to honor the
  // user's "All future occurrences" choice from the recurring-edit
  // chooser modal. Pre-fix the form-actions writer set the flag but
  // this submit handler never read it — "Edit future series" silently
  // behaved identically to "Edit this occurrence." Post-fix, when
  // `editSeriesMode === true` AND the original transaction has a
  // recurring template link, propagate the editable form fields to
  // the template so future occurrences inherit the new values.
  // Past occurrences (and other already-materialized future
  // occurrences) are intentionally NOT mutated — that's the standard
  // calendar-app semantics for "this and all future" edits.
  if (signals.editSeriesMode.value && originalTx.recurringTemplateId) {
    try {
      const { updateRecurringTemplate } = await import('../../data/recurring-templates.js');
      updateRecurringTemplate(originalTx.recurringTemplateId, {
        type: signals.currentType.value as 'expense' | 'income',
        amount: data.amount,
        description: data.description,
        category: signals.selectedCategory.value,
        tags: data.tags,
        notes: data.notes
      });
    } catch (err) {
      // Template-update failure shouldn't block the per-occurrence
      // success message above (the row already saved), but DEV log so
      // the divergence is investigable.
      if (import.meta.env.DEV) {
        console.error('[form-events] Failed to propagate edit to recurring template:', err);
      }
    }
  }

  // Always reset editSeriesMode after consuming it so a follow-up
  // edit on a non-recurring tx doesn't accidentally inherit the flag.
  if (signals.editSeriesMode.value) {
    actions.form.setEditSeriesMode(false);
  }

  // Phase 5g-2 (Inline-Behavior-Review rev 12, L34 bonus): see
  // `handleNewTransaction` above — same currency-hardcoding fix.
  showToast(`Transaction updated \u2014 ${localeService.formatCurrency(data.amount)} ${signals.selectedCategory.value}`, 'success');

  actions.form.setEditingId(null);
  if (cancelEditingFn) void cancelEditingFn();
  clearForm();
}

/**
 * Handle recurring transaction creation
 */
async function handleRecurringTransaction(baseTx: Partial<Transaction>, data: TransactionFormData): Promise<void> {
  await createRecurringTemplate({
    type: baseTx.type as 'expense' | 'income',
    category: baseTx.category!,
    amount: baseTx.amount!,
    description: baseTx.description!,
    tags: baseTx.tags || '',
    notes: baseTx.notes || '',
    startDate: baseTx.date!,
    originalDayOfMonth: parseLocalDate(baseTx.date!).getDate(),
    endDate: data.recurring_end || '',
    // Form select is restricted to these values at the markup level; the
    // `TransactionFormData` field is typed as `string` only because the
    // underlying signal (`formRecurringType`) is a generic `signal<string>`.
    recurringType: data.recurring_type as 'daily' | 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'yearly'
  });

  const freqLabel = data.recurring_type.charAt(0).toUpperCase() + data.recurring_type.slice(1);
  showToast(`${freqLabel} recurring ${baseTx.type} created \u2014 ${localeService.formatCurrency(baseTx.amount ?? 0)} ${baseTx.category}`, 'success');
}

/**
 * Clear form fields and reset signals
 */
function clearForm(): void {
  batch(() => {
    formAmount.value = '';
    formDescription.value = '';
    formTags.value = '';
    formDate.value = getTodayStr();
    formNotes.value = '';
    formRecurring.value = false;
    formRecurringType.value = 'monthly';
    formRecurringEnd.value = '';
    actions.form.setSelectedCategory('');
  });

  clearCategoryError();
  syncFormWithSignals();
  if (renderCategoriesFn) void renderCategoriesFn();
}

/**
 * Reset form to initial state
 */
export function resetForm(): void {
  clearForm();
  ['amount', 'description', 'date', 'tags', 'tx-notes'].forEach(f => validator.clearFieldError(DOM.get(f) as HTMLElement));
  clearCategoryError();
}

export default {
  initFormEvents,
  handleFormSubmit,
  resetForm,
  initReactiveForm,
  cleanupFormEvents,
  cleanupReactiveForm,
  validateFormReactive
};
