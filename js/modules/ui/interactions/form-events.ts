/**
 * Form Events Module
 *
 * Handles transaction form submission and real-time validation.
 *
 * @module form-events
 */
'use strict';

import { persist, SK } from '../../core/state.js';
import * as signals from '../../core/signals.js';
import { form, navigation } from '../../core/state-actions.js';
import { parseAmount, parseLocalDate, getMonthKey, getTodayStr } from '../../core/utils.js';
import { showToast, showProgress, hideProgress, updateProgress, showUndoToast } from '../core/ui.js';
import { dataSdk } from '../../data/data-manager.js';
import { emit, Events } from '../../core/event-bus.js';
import { validator } from '../../core/validator.js';
import { awardAchievement, checkAchievements } from '../../features/gamification/achievements.js';
import { checkStreak } from '../../features/gamification/streak-tracker.js';
import { CONFIG } from '../../core/config.js';
import DOM from '../../core/dom-cache.js';
import type { Transaction } from '../../../types/index.js';

// ==========================================
// TYPE DEFINITIONS
// ==========================================

type CurrencyFormatter = (value: number) => string;
type RecurringType = 'daily' | 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'yearly';

interface FormEventCallbacks {
  fmtCur?: CurrencyFormatter;
  cancelEditing?: () => void;
  renderCategories?: () => void;
}

interface ValidationErrors {
  isAmountInvalid: boolean;
  isAmountTooLarge: boolean;
  amount: number;
  date: string;
  isDateOutOfRange: boolean;
  isDescTooLong: boolean;
  isNotesTooLong: boolean;
}

interface TransactionData {
  sb: HTMLButtonElement;
  amount: number;
  description: string;
  date: string;
  tags: string;
  notes: string;
  isRecurring: boolean;
  recurringType: string;
  recurringEnd: string;
}

interface SeriesEditData {
  editedTx: Transaction;
  txBackup: Transaction | null;
  amount: number;
  description: string;
  tags: string;
  notes: string;
  isRecurring: boolean;
  recurringType: string;
  recurringEnd: string;
}

interface RecurringBatchData {
  date: string;
  recurringEnd: string;
  recurringType: string;
  amount: number;
  description: string;
  tags: string;
  notes: string;
  sb: HTMLButtonElement;
}

// ==========================================
// MODULE STATE
// ==========================================

// Configurable callbacks
let fmtCurFn: CurrencyFormatter = (v) => '$' + v.toFixed(2);
let cancelEditingFn: (() => void) | null = null;
let renderCategoriesFn: (() => void) | null = null;

// ==========================================
// INITIALIZATION
// ==========================================

/**
 * Initialize form event handlers
 */
export function initFormEvents(callbacks: FormEventCallbacks): void {
  if (callbacks.fmtCur) fmtCurFn = callbacks.fmtCur;
  if (callbacks.cancelEditing) cancelEditingFn = callbacks.cancelEditing;
  if (callbacks.renderCategories) renderCategoriesFn = callbacks.renderCategories;

  // Set up form submit handler
  DOM.get('transaction-form')?.addEventListener('submit', handleFormSubmit);

  // Real-time validation
  setupRealtimeValidation();
}

// ==========================================
// FORM SUBMISSION
// ==========================================

/**
 * Clear field error styling
 */
function clearFieldError(el: HTMLElement, errEl: HTMLElement | null): void {
  (el as HTMLInputElement).style.borderColor = 'var(--border-input)';
  el.removeAttribute('aria-invalid');
  if (errEl) errEl.classList.add('hidden');
}

/**
 * Handle form submission
 */
async function handleFormSubmit(e: Event): Promise<void> {
  e.preventDefault();
  e.stopPropagation();
  const sb = DOM.get('submit-btn') as HTMLButtonElement | null;
  // Prevent double submission - disable immediately
  if (!sb || sb.disabled) return;
  sb.disabled = true;

  try {
    const amountEl = DOM.get('amount') as HTMLInputElement | null;
    const descEl = DOM.get('description') as HTMLInputElement | null;
    const dateEl = DOM.get('date') as HTMLInputElement | null;
    const tagsEl = DOM.get('tags') as HTMLInputElement | null;
    const notesEl = DOM.get('tx-notes') as HTMLTextAreaElement | null;
    const recurringToggle = DOM.get('recurring-toggle') as HTMLInputElement | null;
    const recurringTypeEl = DOM.get('recurring-type') as HTMLSelectElement | null;
    const recurringEndEl = DOM.get('recurring-end') as HTMLInputElement | null;

    const amount = parseAmount(amountEl?.value || '');
    const descRaw = descEl?.value.trim() || '';
    const date = dateEl?.value || '';
    const tagsRaw = tagsEl?.value.trim() || '';
    const notesRaw = notesEl?.value.trim() || '';

    // Sanitize text inputs using validator
    const descResult = validator.validateText(descRaw, 'description');
    const tagsResult = validator.validateText(tagsRaw, 'tags');
    const notesResult = validator.validateText(notesRaw, 'notes');
    const description = descResult.valid ? descResult.value : descRaw;
    const tags = tagsResult.valid ? tagsResult.value : tagsRaw;
    const notes = notesResult.valid ? notesResult.value : notesRaw;
    const isRecurring = recurringToggle?.checked || false;
    const recurringType = recurringTypeEl?.value || '';
    const recurringEnd = recurringEndEl?.value || '';
    const isAmountInvalid = amount <= 0;
    const isAmountTooLarge = amount > CONFIG.MAX_AMOUNT;
    const isDescTooLong = description.length > CONFIG.MAX_DESCRIPTION_LENGTH;
    const isNotesTooLong = notes.length > CONFIG.MAX_NOTES_LENGTH;

    // Date range validation
    let isDateOutOfRange = false;
    if (date) {
      const txDate = parseLocalDate(date);
      const now = new Date();
      const minDate = new Date(now.getFullYear() - CONFIG.MAX_DATE_YEARS, now.getMonth(), now.getDate());
      const maxDate = new Date(now.getFullYear() + CONFIG.MAX_DATE_YEARS, now.getMonth(), now.getDate());
      isDateOutOfRange = txDate < minDate || txDate > maxDate;
    }

    if (isAmountInvalid || isAmountTooLarge || !signals.selectedCategory.value || !date || isDateOutOfRange || isDescTooLong || isNotesTooLong) {
      handleValidationErrors({
        isAmountInvalid,
        isAmountTooLarge,
        amount,
        date,
        isDateOutOfRange,
        isDescTooLong,
        isNotesTooLong
      });
      sb.disabled = false;
      return;
    }

    if (signals.editingId.value) {
      await handleEditTransaction({
        sb, amount, description, date, tags, notes,
        isRecurring, recurringType, recurringEnd
      });
    } else {
      await handleNewTransaction({
        sb, amount, description, date, tags, notes,
        isRecurring, recurringType, recurringEnd
      });
    }

    sb.textContent = 'ADD TRANSACTION';
    sb.disabled = false;

    // Time-based achievements
    const hour = new Date().getHours();
    if (hour < 9) awardAchievement('early_bird');
    if (hour >= 22) awardAchievement('night_owl');
    checkAchievements();
  } catch (err) {
    console.error('Transaction submit error:', err);
    if (sb) {
      sb.textContent = 'ADD TRANSACTION';
      sb.disabled = false;
    }
  }
}

// ==========================================
// VALIDATION
// ==========================================

/**
 * Handle validation errors
 */
function handleValidationErrors({ isAmountInvalid, isAmountTooLarge, amount, date, isDateOutOfRange, isDescTooLong, isNotesTooLong }: ValidationErrors): void {
  const errorMessages: string[] = [];
  let firstErrorEl: HTMLElement | null = null;

  if (!signals.selectedCategory.value) {
    const chips = DOM.get('category-chips');
    const catErr = DOM.get('category-error');
    if (chips) {
      chips.style.outline = '2px solid var(--color-expense)';
      chips.style.outlineOffset = '4px';
      chips.style.borderRadius = '8px';
      chips.setAttribute('aria-invalid', 'true');
    }
    if (catErr) catErr.classList.remove('hidden');
    errorMessages.push('Select a category');
    if (!firstErrorEl) firstErrorEl = chips;
  }

  if (isAmountInvalid || isAmountTooLarge) {
    const amtEl = DOM.get('amount') as HTMLInputElement | null;
    const amtErr = DOM.get('amount-error');
    if (amtEl) {
      amtEl.style.borderColor = 'var(--color-expense)';
      amtEl.setAttribute('aria-invalid', 'true');
    }
    let amtMsg = 'Enter a valid amount';
    if (isAmountTooLarge) amtMsg = `Amount cannot exceed ${fmtCurFn(CONFIG.MAX_AMOUNT)}`;
    else if (amount === 0) amtMsg = 'Amount must be greater than zero';
    if (amtErr) {
      amtErr.textContent = amtMsg;
      amtErr.classList.remove('hidden');
    }
    errorMessages.push(amtMsg);
    if (!firstErrorEl) firstErrorEl = amtEl;
  }

  if (!date || isDateOutOfRange) {
    const dateEl = DOM.get('date') as HTMLInputElement | null;
    const dateErr = DOM.get('date-error');
    if (dateEl) {
      dateEl.style.borderColor = 'var(--color-expense)';
      dateEl.setAttribute('aria-invalid', 'true');
    }
    const dateMsg = isDateOutOfRange ? `Date must be within ${CONFIG.MAX_DATE_YEARS} years` : 'Select a date';
    if (dateErr) {
      dateErr.textContent = dateMsg;
      dateErr.classList.remove('hidden');
    }
    errorMessages.push(dateMsg);
    if (!firstErrorEl) firstErrorEl = dateEl;
  }

  if (isDescTooLong) {
    const descEl = DOM.get('description') as HTMLInputElement | null;
    const descErr = DOM.get('description-error');
    if (descEl) {
      descEl.style.borderColor = 'var(--color-expense)';
      descEl.setAttribute('aria-invalid', 'true');
    }
    if (descErr) descErr.classList.remove('hidden');
    errorMessages.push(`Description too long (max ${CONFIG.MAX_DESCRIPTION_LENGTH} chars)`);
    if (!firstErrorEl) firstErrorEl = descEl;
  }

  if (isNotesTooLong) {
    const notesEl = DOM.get('tx-notes') as HTMLTextAreaElement | null;
    const notesErr = DOM.get('notes-error');
    if (notesEl) {
      notesEl.style.borderColor = 'var(--color-expense)';
      notesEl.setAttribute('aria-invalid', 'true');
    }
    if (notesErr) notesErr.classList.remove('hidden');
    errorMessages.push(`Notes too long (max ${CONFIG.MAX_NOTES_LENGTH} chars)`);
    if (!firstErrorEl) firstErrorEl = notesEl;
  }

  // Scroll to and focus first error
  if (firstErrorEl) {
    firstErrorEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if ('focus' in firstErrorEl) (firstErrorEl as HTMLElement).focus();
  }

  // Show toast with specific errors (up to 2)
  const toastMsg = errorMessages.length === 1
    ? errorMessages[0]
    : `${errorMessages.slice(0, 2).join(' • ')}${errorMessages.length > 2 ? ` (+${errorMessages.length - 2} more)` : ''}`;
  showToast(toastMsg, 'error');
}

// ==========================================
// EDIT TRANSACTION
// ==========================================

/**
 * Handle editing an existing transaction
 */
async function handleEditTransaction({ sb, amount, description, date, tags, notes, isRecurring, recurringType, recurringEnd }: TransactionData): Promise<void> {
  sb.textContent = 'UPDATING...';
  const transactions = signals.transactions.value;
  const editingId = signals.editingId.value;
  const editedTx = transactions.find(t => t.__backendId === editingId);
  // Store backup before update for undo
  const txBackup = editedTx ? { ...editedTx } : null;
  const result = await dataSdk.update({
    __backendId: editingId as string,
    type: signals.currentType.value as 'expense' | 'income',
    category: signals.selectedCategory.value as string,
    amount,
    description,
    date,
    tags,
    notes,
    recurring: isRecurring,
    recurring_type: recurringType as RecurringType,
    recurring_end: recurringEnd
  } as unknown as Transaction);

  if (!result.isOk) {
    showToast('Failed to save changes. Storage may be full.', 'error');
    sb.textContent = 'UPDATE TRANSACTION';
    sb.disabled = false;
    return;
  }

  // If editing series, update all future occurrences
  if (signals.editSeriesMode.value && editedTx && editedTx.recurring) {
    await handleEditSeries({
      editedTx, txBackup, amount, description, tags, notes,
      isRecurring, recurringType, recurringEnd
    });
  } else if (txBackup) {
    // Show undo for single transaction edit
    showUndoToast('Transaction updated', async () => {
      await dataSdk.update(txBackup);
    });
  }

  form.setEditSeriesMode(false);
  cancelEditingFn?.();
}

/**
 * Handle editing a recurring series
 */
async function handleEditSeries({ editedTx, txBackup, amount, description, tags, notes, isRecurring, recurringType, recurringEnd }: SeriesEditData): Promise<void> {
  const transactions = signals.transactions.value;
  const editingId = signals.editingId.value;
  const editedDate = parseLocalDate(editedTx.date);
  const relatedTx = transactions.filter(t =>
    t.__backendId !== editingId &&
    t.recurring === true &&
    t.recurring_type === editedTx.recurring_type &&
    t.category === editedTx.category &&
    Math.abs(t.amount - editedTx.amount) < 0.01 &&
    parseLocalDate(t.date) > editedDate
  );

  // Store backups for series undo and rollback
  const seriesBackups = relatedTx.map(t => ({ ...t }));

  if (relatedTx.length > 0) {
    showProgress('Updating Series', `Updating ${relatedTx.length + 1} transactions...`, true);
    updateProgress(1, relatedTx.length + 1);
    await new Promise(r => setTimeout(r, CONFIG.TIMING.UI_DELAY));
  }

  let updateCount = 1;
  const successfulUpdates: string[] = [];
  let updateFailed = false;

  for (const tx of relatedTx) {
    const updateResult = await dataSdk.update({
      __backendId: tx.__backendId,
      type: signals.currentType.value as 'expense' | 'income',
      category: signals.selectedCategory.value as string,
      amount,
      date: tx.date,
      description,
      tags,
      notes,
      recurring: isRecurring,
      recurring_type: recurringType as RecurringType,
      recurring_end: recurringEnd
    } as unknown as Transaction);

    if (!updateResult.isOk) {
      updateFailed = true;
      // Rollback: restore the primary transaction and all successful updates
      hideProgress();
      showProgress('Rolling Back', 'Reverting changes...');
      await new Promise(r => setTimeout(r, CONFIG.TIMING.UI_DELAY));
      let rollbackFailed = false;
      if (txBackup) {
        const r = await dataSdk.update(txBackup);
        if (!r.isOk) rollbackFailed = true;
      }
      for (const backupId of successfulUpdates) {
        const backup = seriesBackups.find(b => b.__backendId === backupId);
        if (backup) {
          const r = await dataSdk.update(backup);
          if (!r.isOk) rollbackFailed = true;
        }
      }
      hideProgress();
      if (rollbackFailed) {
        showToast(`Series update failed. Some changes could not be reverted - please check your data.`, 'error');
      } else {
        showToast(`Series update failed after ${updateCount} of ${relatedTx.length + 1}. Changes reverted.`, 'error');
      }
      break;
    }

    successfulUpdates.push(tx.__backendId);
    updateCount++;
    updateProgress(updateCount, relatedTx.length + 1);
  }

  if (!updateFailed && relatedTx.length > 0) {
    hideProgress();
    // Show undo for series edit
    showUndoToast(`Updated ${relatedTx.length + 1} transactions`, async () => {
      if (txBackup) await dataSdk.update(txBackup);
      for (const backup of seriesBackups) {
        await dataSdk.update(backup);
      }
    });
  }
}

// ==========================================
// NEW TRANSACTION
// ==========================================

/**
 * Handle creating a new transaction
 */
async function handleNewTransaction({ sb, amount, description, date, tags, notes, isRecurring, recurringType, recurringEnd }: TransactionData): Promise<void> {
  sb.textContent = 'ADDING...';

  if (isRecurring && !recurringEnd) {
    showToast('Please set an end date for the recurring transaction', 'error');
    sb.textContent = 'ADD TRANSACTION';
    sb.disabled = false;
    return;
  }

  if (isRecurring && recurringEnd) {
    if (parseLocalDate(recurringEnd) < parseLocalDate(date)) {
      showToast('End date must be on or after the start date', 'error');
      sb.textContent = 'ADD TRANSACTION';
      sb.disabled = false;
      return;
    }
    const success = await createRecurringBatch({ date, recurringEnd, recurringType, amount, description, tags, notes, sb });
    if (!success) return;  // Don't show success toast or reset form if batch failed
  } else {
    const result = await dataSdk.create({
      type: signals.currentType.value as 'expense' | 'income',
      category: signals.selectedCategory.value as string,
      amount,
      description,
      date,
      tags,
      notes,
      recurring: isRecurring,
      recurring_type: recurringType as RecurringType,
      recurring_end: recurringEnd,
      reconciled: true
    });

    if (!result.isOk) {
      sb.textContent = 'ADD TRANSACTION';
      sb.disabled = false;
      return;
    }

    // Show undo for single transaction creation
    if (result.data) {
      const createdTx = result.data as Transaction;
      showUndoToast('Transaction added', async () => {
        await dataSdk.delete(createdTx);
      });
    }
  }

  // Switch month view if transaction date is in a different month
  const txMonth = getMonthKey(date);
  if (txMonth !== signals.currentMonth.value) {
    navigation.setCurrentMonth(txMonth);
  }

  // Reset form
  const amountEl = DOM.get('amount') as HTMLInputElement | null;
  const descEl = DOM.get('description') as HTMLInputElement | null;
  const dateEl = DOM.get('date') as HTMLInputElement | null;
  const tagsEl = DOM.get('tags') as HTMLInputElement | null;
  const notesEl = DOM.get('tx-notes') as HTMLTextAreaElement | null;
  const recurringToggle = DOM.get('recurring-toggle') as HTMLInputElement | null;
  const recurringSection = DOM.get('recurring-section');

  if (amountEl) amountEl.value = '';
  if (descEl) descEl.value = '';
  if (dateEl) dateEl.value = getTodayStr();
  if (tagsEl) tagsEl.value = '';
  if (notesEl) notesEl.value = '';
  if (recurringToggle) recurringToggle.checked = false;
  if (recurringSection) recurringSection.classList.add('hidden');
  form.clearSelectedCategory();
  renderCategoriesFn?.();

  checkStreak(date);
  if (isRecurring) showToast('Recurring transactions added');
}

// ==========================================
// RECURRING BATCH CREATION
// ==========================================

/**
 * Create recurring transaction batch
 */
async function createRecurringBatch({ date, recurringEnd, recurringType, amount, description, tags, notes, sb }: RecurringBatchData): Promise<boolean> {
  const startDate = parseLocalDate(date);
  const endDate = parseLocalDate(recurringEnd);
  const origDay = startDate.getDate();
  let cur = new Date(startDate);
  let count = 0;
  const batch: Partial<Transaction>[] = [];

  while (cur <= endDate && count < CONFIG.RECURRING_MAX_ENTRIES) {
    batch.push({
      type: signals.currentType.value as 'expense' | 'income',
      category: signals.selectedCategory.value as string,
      amount,
      description,
      tags,
      notes,
      date: `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}-${String(cur.getDate()).padStart(2, '0')}`,
      recurring: true,
      recurring_type: recurringType as RecurringType,
      recurring_end: recurringEnd,
      reconciled: false
    });
    count++;

    switch (recurringType) {
      case 'daily':
        cur.setDate(cur.getDate() + 1);
        break;
      case 'weekly':
        cur.setDate(cur.getDate() + 7);
        break;
      case 'biweekly':
        cur.setDate(cur.getDate() + 14);
        break;
      case 'monthly': {
        const nextM = cur.getMonth() + 1;
        const nextY = cur.getFullYear() + (nextM > 11 ? 1 : 0);
        const nextMonth = nextM % 12;
        const maxDay = new Date(nextY, nextMonth + 1, 0).getDate();
        cur = new Date(nextY, nextMonth, Math.min(origDay, maxDay));
        break;
      }
      case 'quarterly': {
        const nextM = cur.getMonth() + 3;
        const nextY = cur.getFullYear() + Math.floor(nextM / 12);
        const nextMonth = nextM % 12;
        const maxDay = new Date(nextY, nextMonth + 1, 0).getDate();
        cur = new Date(nextY, nextMonth, Math.min(origDay, maxDay));
        break;
      }
      case 'yearly': {
        const ny = cur.getFullYear() + 1;
        const maxD = new Date(ny, cur.getMonth() + 1, 0).getDate();
        cur = new Date(ny, cur.getMonth(), Math.min(origDay, maxD));
        break;
      }
    }
  }

  // Show progress for batch creation
  showProgress('Creating Recurring Transactions', `Saving ${batch.length} transactions...`, true);
  updateProgress(0, batch.length);
  await new Promise(r => setTimeout(r, CONFIG.TIMING.UI_DELAY));

  const batchResult = await dataSdk.createBatch(batch);
  hideProgress();

  if (!batchResult.isOk) {
    sb.textContent = 'ADD TRANSACTION';
    sb.disabled = false;
    return false;
  }

  updateProgress(batch.length, batch.length);

  if (count >= CONFIG.RECURRING_MAX_ENTRIES && cur <= endDate) {
    showToast(`Recurring transactions capped at ${CONFIG.RECURRING_MAX_ENTRIES}. Only the first ${CONFIG.RECURRING_MAX_ENTRIES} were saved.`, 'info');
  }
  return true;
}

// ==========================================
// REALTIME VALIDATION
// ==========================================

/**
 * Set up real-time form validation
 */
function setupRealtimeValidation(): void {
  DOM.get('amount')?.addEventListener('input', function(this: HTMLInputElement) {
    const val = parseAmount(this.value);
    const amtErr = DOM.get('amount-error');
    if (val > CONFIG.MAX_AMOUNT) {
      this.style.borderColor = 'var(--color-expense)';
      this.setAttribute('aria-invalid', 'true');
      if (amtErr) {
        amtErr.textContent = `Amount cannot exceed ${fmtCurFn(CONFIG.MAX_AMOUNT)}`;
        amtErr.classList.remove('hidden');
      }
    } else if (val > 0) {
      clearFieldError(this, amtErr);
    }
  });

  DOM.get('description')?.addEventListener('input', function(this: HTMLInputElement) {
    const charCount = DOM.get('desc-char-count');
    const descErr = DOM.get('description-error');
    const len = this.value.length;
    if (len > 0) {
      if (charCount) {
        charCount.textContent = `(${len}/${CONFIG.MAX_DESCRIPTION_LENGTH})`;
        charCount.style.color = len > CONFIG.MAX_DESCRIPTION_LENGTH * 0.9 ? 'var(--color-warning)' : 'var(--text-tertiary)';
      }
    } else {
      if (charCount) charCount.textContent = '';
    }
    if (len <= CONFIG.MAX_DESCRIPTION_LENGTH) {
      clearFieldError(this, descErr);
    }
  });

  DOM.get('tx-notes')?.addEventListener('input', function(this: HTMLTextAreaElement) {
    const charCount = DOM.get('notes-char-count');
    const notesErr = DOM.get('notes-error');
    const len = this.value.length;
    if (len > 0) {
      if (charCount) {
        charCount.textContent = `(${len}/${CONFIG.MAX_NOTES_LENGTH})`;
        charCount.style.color = len > CONFIG.MAX_NOTES_LENGTH * 0.9 ? 'var(--color-warning)' : 'var(--text-tertiary)';
      }
    } else {
      if (charCount) charCount.textContent = '';
    }
    if (len <= CONFIG.MAX_NOTES_LENGTH) {
      clearFieldError(this, notesErr);
    }
  });

  DOM.get('date')?.addEventListener('change', function(this: HTMLInputElement) {
    const dateErr = DOM.get('date-error');
    if (this.value) {
      const txDate = parseLocalDate(this.value);
      const now = new Date();
      const minDate = new Date(now.getFullYear() - CONFIG.MAX_DATE_YEARS, now.getMonth(), now.getDate());
      const maxDate = new Date(now.getFullYear() + CONFIG.MAX_DATE_YEARS, now.getMonth(), now.getDate());
      if (txDate < minDate || txDate > maxDate) {
        this.style.borderColor = 'var(--color-expense)';
        this.setAttribute('aria-invalid', 'true');
        if (dateErr) {
          dateErr.textContent = `Date must be within ${CONFIG.MAX_DATE_YEARS} years`;
          dateErr.classList.remove('hidden');
        }
      } else {
        clearFieldError(this, dateErr);
      }
    }
  });
}
