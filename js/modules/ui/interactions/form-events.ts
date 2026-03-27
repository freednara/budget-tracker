/**
 * Form Events Module
 *
 * Handles transaction form submission and real-time validation using reactive signals.
 *
 * @module form-events
 */
'use strict';

import { SK } from '../../core/state.js';
import * as signals from '../../core/signals.js';
import { batch } from '@preact/signals-core';
import { actions, batchUpdates } from '../../core/state-actions.js';
import { parseAmount, getTodayStr, parseLocalDate } from '../../core/utils.js';
import { showToast } from '../core/ui.js';
import { dataSdk } from '../../data/data-manager.js';
import { createRecurringTemplate } from '../../data/recurring-templates.js';
import { emit, Events, createListenerGroup, destroyListenerGroup } from '../../core/event-bus.js';
import { validator } from '../../core/validator.js';
import { checkAchievements } from '../../core/feature-event-interface.js';
import { handleError } from '../../core/global-error-handler.js';
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

type CurrencyFormatter = (value: number) => string;

interface FormEventCallbacks {
  fmtCur?: CurrencyFormatter;
  cancelEditing?: () => void;
  renderCategories?: () => void;
}

interface ValidationErrors {
  errors: Record<string, string>;
  firstErrorField?: string;
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
    errorEl.textContent = message;
    errorEl.classList.remove('hidden');
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
    return errors[fields[0]] || `Please fix the ${FIELD_LABELS[fields[0]] || fields[0]} field`;
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

let cancelEditingFn: (() => void) | null = null;
let renderCategoriesFn: (() => void) | null = null;

// Form state
let isSubmitting = false;
let eventGroupId: string | null = null;
let formBinderInstance: FormBinder | null = null;
let boundFormElement: HTMLFormElement | null = null;
let boundCancelEditButton: HTMLElement | null = null;

const handleCancelEditClick = (): void => {
  if (cancelEditingFn) cancelEditingFn();
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
}

/**
 * Clean up reactive form bindings
 */
export function cleanupReactiveForm(): void {
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
    boundFormElement.removeEventListener('submit', handleFormSubmit);
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

  boundFormElement = DOM.get('transaction-form') as HTMLFormElement | null;
  if (boundFormElement) {
    boundFormElement.addEventListener('submit', handleFormSubmit);
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
  sb.textContent = 'SAVING...';

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
    handleError('Transaction submit error', err, { module: 'form-events' });
    showToast('Failed to save transaction', 'error');
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
      (DOM.query('.category-chip') as HTMLElement | null)?.focus();
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
      showToast('Transaction added', 'success');
    } else {
      showToast(result.error || 'Failed to add transaction', 'error');
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

  const updatedTx: Partial<Transaction> = {
    type: signals.currentType.value as 'expense' | 'income',
    amount: data.amount,
    description: data.description,
    category: signals.selectedCategory.value,
    date: data.date,
    tags: data.tags,
    notes: data.notes
  };

  const result = await dataSdk.update({ __backendId: editId, ...updatedTx } as Transaction);
  if (!result.isOk) {
    showToast(result.error || 'Failed to update transaction', 'error');
    return;
  }
  showToast('Transaction updated', 'success');

  actions.form.setEditingId(null);
  if (cancelEditingFn) cancelEditingFn();
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
    recurringType: data.recurring_type as any
  });

  showToast('Recurring series created', 'success');
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
  if (renderCategoriesFn) renderCategoriesFn();
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
