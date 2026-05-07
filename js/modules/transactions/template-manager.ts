/**
 * Template Manager
 *
 * Manages transaction templates - save, apply, delete, and render.
 * Templates allow users to quickly reuse common transaction patterns.
 * 
 * Key improvements:
 * - Uses Signals for form state instead of direct DOM manipulation
 * - Validates category existence when applying templates
 * - Properly typed template fields
 * - Async navigation without brittle timeouts
 *
 * @module transactions/template-manager
 */
'use strict';

import { SK, persist } from '../core/state.js';
import { signal, effect } from '@preact/signals-core';
import * as signals from '../core/signals.js';
import { form, data, navigation } from '../core/state-actions.js';
import { getCatInfo } from '../core/categories.js';
import { emit, on, off, Events } from '../core/event-bus.js';
import { asyncConfirm } from '../ui/components/async-modal.js';
import { fmtCur, getTodayStr, parseAmount } from '../core/utils-pure.js';
import DOM from '../core/dom-cache.js';
import { html, render } from '../core/lit-helpers.js';
import { emptyState } from '../ui/core/empty-state.js';
import type { TxTemplate, TransactionType } from '../../types/index.js';

// ==========================================
// TYPES
// ==========================================

export type RenderCategoriesCallback = () => void;
export type SwitchTabCallback = (type: TransactionType) => void;

// ==========================================
// FORM STATE SIGNALS
// ==========================================

// Form field signals for reactive updates
export const formAmount = signal<string>('');
export const formDescription = signal<string>('');
export const formTags = signal<string>('');
export const formDate = signal<string>(getTodayStr());
export const formNotes = signal<string>('');
export const formRecurring = signal<boolean>(false);
export const formRecurringType = signal<string>('monthly');
export const formRecurringEnd = signal<string>('');

// ==========================================
// CALLBACKS
// ==========================================

// Callback for rendering categories (used by applyTemplate)
let renderCategoriesFn: RenderCategoriesCallback | null = null;
let switchTabFn: SwitchTabCallback | null = null;
let templateManagerInitialized = false;
let templatesCollapsed = true;
let toggleTemplatesButton: HTMLButtonElement | null = null;
let toggleTemplatesButtonHandler: (() => void) | null = null;
const templateManagerEffectCleanups: Array<() => void> = [];

function updateTemplatesCollapseUi(templateCount: number): void {
  const toggle = DOM.get('toggle-templates-mobile');
  const panel = document.querySelector('.transactions-templates-panel');
  if (!toggle || !panel) return;

  toggle.hidden = false;
  panel.classList.toggle('transactions-templates-panel--collapsed', templatesCollapsed);

  toggle.setAttribute('aria-expanded', String(!templatesCollapsed));
  if (templatesCollapsed) {
    toggle.textContent = templateCount > 0 ? `Show (${templateCount})` : 'Show';
  } else {
    toggle.textContent = 'Hide';
  }
}

/**
 * Set the renderCategories callback
 */
export function setTemplateRenderCategoriesFn(fn: RenderCategoriesCallback): void {
  renderCategoriesFn = fn;
}

/**
 * Set the transaction type switch callback.
 * This lets templates reuse the same tab/quick-add update path as normal UI navigation.
 */
export function setTemplateSwitchTabFn(fn: SwitchTabCallback): void {
  switchTabFn = fn;
}

// ==========================================
// SIGNAL SYNC FUNCTIONS
// ==========================================

/**
 * Sync form signals with DOM elements
 * This ensures DOM reflects signal state reactively
 */
export function syncFormWithSignals(): void {
  const amountEl = DOM.get<HTMLInputElement>('amount');
  const descEl = DOM.get<HTMLInputElement>('description');
  const dateEl = DOM.get<HTMLInputElement>('date');
  const tagsEl = DOM.get<HTMLInputElement>('tags');
  const notesEl = DOM.get<HTMLTextAreaElement>('tx-notes');
  const recurringEl = DOM.get<HTMLInputElement>('recurring-toggle');
  const recurringSection = DOM.get('recurring-section');
  const recurringTypeEl = DOM.get<HTMLSelectElement>('recurring-type');
  const recurringEndEl = DOM.get<HTMLInputElement>('recurring-end');

  // Update DOM based on signals
  if (amountEl) amountEl.value = formAmount.value;
  if (descEl) descEl.value = formDescription.value;
  if (dateEl) dateEl.value = formDate.value;
  if (tagsEl) tagsEl.value = formTags.value;
  if (notesEl) notesEl.value = formNotes.value;
  if (recurringEl) recurringEl.checked = formRecurring.value;
  if (recurringSection) recurringSection.classList.toggle('hidden', !formRecurring.value);
  if (recurringTypeEl) recurringTypeEl.value = formRecurringType.value;
  if (recurringEndEl) recurringEndEl.value = formRecurringEnd.value;
}

/**
 * Read current form state from DOM into signals
 */
export function readFormIntoSignals(): void {
  const amountEl = DOM.get<HTMLInputElement>('amount');
  const descEl = DOM.get<HTMLInputElement>('description');
  const dateEl = DOM.get<HTMLInputElement>('date');
  const tagsEl = DOM.get<HTMLInputElement>('tags');
  const notesEl = DOM.get<HTMLTextAreaElement>('tx-notes');
  const recurringEl = DOM.get<HTMLInputElement>('recurring-toggle');
  const recurringTypeEl = DOM.get<HTMLSelectElement>('recurring-type');
  const recurringEndEl = DOM.get<HTMLInputElement>('recurring-end');

  // Update signals from DOM
  formAmount.value = amountEl?.value || '';
  formDescription.value = descEl?.value.trim() || '';
  // Use local-time getTodayStr, not UTC toISOString — otherwise users on the
  // west coast of the US (or anywhere UTC-negative) would see tomorrow's date
  // stamped on late-evening entries. See ADR-001 §9.5 Step 8.
  formDate.value = dateEl?.value || getTodayStr();
  formTags.value = tagsEl?.value.trim() || '';
  formNotes.value = notesEl?.value.trim() || '';
  formRecurring.value = recurringEl?.checked || false;
  formRecurringType.value = recurringTypeEl?.value || 'monthly';
  formRecurringEnd.value = recurringEndEl?.value || '';
}

// ==========================================
// CATEGORY VALIDATION
// ==========================================

/**
 * Validate that a category exists for the given type
 * Falls back to 'other' if category doesn't exist
 */
function validateCategory(type: TransactionType, categoryId: string): string {
  const catInfo = getCatInfo(type, categoryId);
  
  // If category doesn't exist (getCatInfo returns fallback with emoji '❓'), fall back to 'other'
  if (!catInfo || catInfo.emoji === '❓') {
    if (import.meta.env.DEV) console.warn(`Template category "${categoryId}" not found, falling back to "other"`);
    return 'other';
  }
  
  return categoryId;
}

// ==========================================
// TEMPLATE FUNCTIONS
// ==========================================

/**
 * Save current form state as a reusable template
 * Reads from signals, not directly from DOM
 */
export function saveAsTemplate(name: string): void {
  // Design-Review-Apr21 P2 (batch 6 follow-up): same duplicate-name
  // disambiguation gap as categories + filter presets — the templates
  // panel renders `t.name` verbatim as the button label and the
  // delete-button aria-label, so two templates with identical visible
  // names are indistinguishable at apply + delete time. Reject before
  // write with the same case-insensitive + trimmed comparison used in
  // category-manager's `findDuplicateCategoryName` and filters.ts's
  // `saveFilterPreset`. Empty-name guard added for parity (the caller
  // in filter-events.ts already bails on empty `name`, but the public
  // export is reachable from other entry points and should self-
  // protect). Error surfaced via the existing `Events.SHOW_TOAST`
  // channel so the user gets immediate feedback instead of a silent
  // duplicate being written to storage.
  const trimmed = name.trim();
  const needle = trimmed.toLowerCase();
  if (!trimmed) {
    emit(Events.SHOW_TOAST, { message: 'Template name cannot be empty', type: 'error' });
    return;
  }
  const collision = signals.txTemplates.value.find(
    t => t.name.trim().toLowerCase() === needle
  );
  if (collision) {
    emit(Events.SHOW_TOAST, {
      message: `A template named "${collision.name}" already exists`,
      type: 'error'
    });
    return;
  }

  // First sync signals with current DOM state
  readFormIntoSignals();

  const template: TxTemplate = {
    id: `tmpl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: trimmed,
    type: signals.currentType.value,
    category: signals.selectedCategory.value,
    // M9 (Inline-Behavior-Review rev 12): route through locale-aware
    // `parseAmount` instead of raw `parseFloat` so a de-DE user who types
    // "1,50" gets 1.50 (not 1, which is what `parseFloat` returns by
    // stopping at the comma). Without this, a template saved in a non-
    // en-US locale encodes a 50-cent error that repeats every time the
    // template is applied. `parseAmount` returns 0 on NaN/negative —
    // encode that as "no amount saved" so the apply path doesn't paste a
    // mysterious 0 into the form. Keeps the `undefined`-when-empty
    // semantics of the prior ternary.
    amount: formAmount.value
      ? (parseAmount(formAmount.value) || undefined)
      : undefined,
    description: formDescription.value || undefined,
    tags: formTags.value || undefined,
    recurring: formRecurring.value || undefined,
    recurringType: formRecurringType.value as TxTemplate['recurringType'] || undefined,
    recurringEnd: formRecurringEnd.value || undefined
  };

  // Remove undefined fields for cleaner storage
  Object.keys(template).forEach(key => {
    if (template[key as keyof TxTemplate] === undefined) {
      delete template[key as keyof TxTemplate];
    }
  });

  data.setTxTemplates([...signals.txTemplates.value, template]);
  persist(SK.TX_TEMPLATES, signals.txTemplates.value);
  renderTemplates();
  emit(Events.SHOW_TOAST, { message: `Saved as template \u2014 use it next time from the Templates menu.`, type: 'success' });
}

/**
 * Apply a saved template to the transaction form
 * Updates signals which trigger reactive UI updates
 */
export async function applyTemplate(templateId: string): Promise<void> {
  const tmpl = signals.txTemplates.value.find(t => t.id === templateId);
  if (!tmpl) {
    emit(Events.SHOW_TOAST, { message: 'This template was removed. Save a new one to get started.', type: 'error' });
    return;
  }

  // Validate and fix category if needed
  const validatedCategory = validateCategory(tmpl.type, tmpl.category);

  // Switch transaction type through the shared UI navigation path when available.
  // Fall back to navigation state only if startup wiring has not completed yet.
  if (switchTabFn) {
    switchTabFn(tmpl.type);
  } else {
    navigation.setCurrentTab(tmpl.type);
  }
  
  // Update form signals
  form.setSelectedCategory(validatedCategory);
  formAmount.value = tmpl.amount ? String(tmpl.amount) : '';
  formDescription.value = tmpl.description || '';
  formTags.value = tmpl.tags || '';
  formRecurring.value = tmpl.recurring || false;
  formRecurringType.value = tmpl.recurringType || 'monthly';
  formRecurringEnd.value = tmpl.recurringEnd || '';

  // Sync signals to DOM
  syncFormWithSignals();

  // Trigger UI updates
  if (renderCategoriesFn) {
    renderCategoriesFn();
  }

  // Emit event for other components to react
  emit(Events.TEMPLATE_APPLIED, { templateId, template: tmpl });

  // Focus amount field for immediate input
  const amountEl = DOM.get('amount');
  amountEl?.focus();
  
  emit(Events.SHOW_TOAST, { message: `Template "${tmpl.name}" applied`, type: 'info' });
}

/**
 * Delete a saved template
 */
export function deleteTemplate(templateId: string): void {
  const template = signals.txTemplates.value.find(t => t.id === templateId);
  if (!template) {
    emit(Events.SHOW_TOAST, { message: 'This template was removed. Save a new one to get started.', type: 'error' });
    return;
  }

  data.removeTxTemplate(templateId);
  persist(SK.TX_TEMPLATES, signals.txTemplates.value);
  renderTemplates();
  emit(Events.SHOW_TOAST, { message: `Template "${template.name}" deleted`, type: 'info' });
}

/**
 * Render the list of saved templates with improved error handling
 */
export function renderTemplates(): void {
  const container = DOM.get('templates-list');
  if (!container) return;

  const templates = signals.txTemplates.value;
  updateTemplatesCollapseUi(templates.length);

  if (templatesCollapsed) {
    render(html``, container);
    return;
  }

  if (!templates.length) {
    // Design-Review-Apr21 P3 (batch 6 follow-up wave O): dropped
    // `role="status" aria-live="polite"` from the empty-state
    // wrapper. The templates panel renders as part of routine
    // navigation (collapse/expand, switching sections, a template
    // being deleted down to zero), so an aria-live region forced a
    // screen-reader announcement whenever that path ran — noise
    // rather than signal. WAI-ARIA APG guidance reserves live
    // regions for status messages the user needs immediate
    // awareness of without scanning the page. A routine empty
    // panel is visible content under a clear heading; users who
    // want to read it navigate to it. The global `#sr-status`
    // region already exists for deliberate announcements.
    render(html`
      <div class="template-empty-state">
        ${emptyState(
          '↻',
          'No templates yet',
          'Save a transaction pattern to reuse amount, category, and recurring details faster.'
        )}
      </div>
    `, container);
    return;
  }

  const handleTemplateClick = async (e: Event, templateId: string) => {
    if ((e.target as HTMLElement).closest('.delete-template-btn')) return;
    await applyTemplate(templateId);
  };

  const handleTemplateKeydown = async (e: KeyboardEvent, templateId: string) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      await applyTemplate(templateId);
    }
  };

  const handleDeleteClick = async (e: Event, templateId: string): Promise<void> => {
    e.stopPropagation();

    // Design-Review-Apr21 P3 (batch 6 follow-up): the confirmation
    // dialog previously asked "Delete this transaction template?" with
    // no template name anywhere in the copy. With the duplicate-name
    // uniqueness check now in place (`saveAsTemplate` rejects
    // collisions), two templates still can differ only by trim or
    // casing ambiguity for edge cases — and even without duplicates,
    // destructive-UX best practice is to restate the target verbatim
    // so the user confirms against a specific name, not an abstract
    // "this template". Resolved via `signals.txTemplates.value.find`
    // at confirm-time. Falls back to generic copy if lookup fails
    // (defensive — shouldn't happen since the click came from a
    // rendered row) so the dialog still renders coherently.
    const target = signals.txTemplates.value.find(t => t.id === templateId);
    const templateName = target?.name?.trim() || '';
    const message = templateName
      ? `Delete template "${templateName}"?`
      : 'Delete this transaction template?';

    const confirmed = await asyncConfirm({
      title: 'Delete Template',
      message,
      details: 'This removes the saved template only. It will not delete any existing transactions created from it.',
      type: 'warning',
      confirmText: 'Delete Template',
      cancelText: 'Cancel'
    });
    if (confirmed) {
      deleteTemplate(templateId);
    }
  };

  render(html`
    ${templates.map(t => {
      // Validate category exists, show warning if not
      const cat = getCatInfo(t.type, t.category);
      const isValidCategory = cat.emoji !== '❓';
      
      // Flatten the nested interactive structure. Previously the outer
      // element had `role="button"` and contained a real <button> for
      // delete — that's an a11y antipattern (no nested interactive
      // controls in ARIA; screen readers can't reliably reach the inner
      // button, and Tab-nav collapses). Split into two sibling buttons
      // in a flex container: the main "Apply" button covers the card
      // content, the delete button sits alongside it.
      return html`
        <div class="template-btn template-btn--group flex items-stretch rounded-lg w-full transition-all"
          data-template-id=${t.id}
          style="background: var(--bg-input); border: 1px solid var(--border-input); ${!isValidCategory ? 'opacity: 0.8;' : ''}">
          <button type="button"
            class="template-btn__apply flex items-center gap-2 px-3 py-2 text-left flex-1 min-w-0 cursor-pointer rounded-l-lg"
            @click=${(e: Event) => handleTemplateClick(e, t.id)}
            @keydown=${(e: KeyboardEvent) => handleTemplateKeydown(e, t.id)}
            aria-label="Apply template ${t.name}"
            title="${!isValidCategory ? 'Category may be missing' : `Apply template ${t.name}`}">
            <span class="text-lg">${cat.emoji}</span>
            <span class="flex-1 min-w-0 block">
              <span class="text-xs font-bold truncate block" style="color: var(--text-primary);">
                ${t.name}
              </span>
              <span class="text-xs truncate block" style="color: var(--text-tertiary);">
                ${cat.name}${t.amount ? ' · ' + fmtCur(t.amount) : ''}
                ${t.recurring ? ' · 🔁' : ''}
                ${!isValidCategory ? ' ⚠️' : ''}
              </span>
            </span>
          </button>
          <button type="button"
            class="delete-template-btn p-1.5 rounded-r-lg hover:opacity-70"
            @click=${(e: Event) => handleDeleteClick(e, t.id)}
            style="color: var(--color-expense); font-size: 0.9rem;"
            title="Delete template"
            aria-label="Delete template ${t.name}">
            🗑️
          </button>
        </div>
      `;
    })}
  `, container);
}

// ==========================================
// INITIALIZATION
// ==========================================

/**
 * Initialize template manager with DOM event listeners
 * Should be called once when the app loads
 */
export function initTemplateManager(): void {
  if (templateManagerInitialized) return;
  templateManagerInitialized = true;

  templatesCollapsed = true;

  toggleTemplatesButton = DOM.get('toggle-templates-mobile');
  toggleTemplatesButtonHandler = () => {
    templatesCollapsed = !templatesCollapsed;
    renderTemplates();
  };
  toggleTemplatesButton?.addEventListener('click', toggleTemplatesButtonHandler);

  // Set up signal effects to sync with DOM
  templateManagerEffectCleanups.push(effect(() => {
    const isVisible = signals.sections.value.transactionsTemplates;
    const panel = document.querySelector('.transactions-templates-panel');
    if (panel) {
      panel.classList.toggle('hidden', !isVisible);
    }
  }));

  templateManagerEffectCleanups.push(effect(() => {
    const amountEl = DOM.get<HTMLInputElement>('amount');    if (amountEl && amountEl.value !== formAmount.value) {
      amountEl.value = formAmount.value;
    }
  }));

  templateManagerEffectCleanups.push(effect(() => {
    const descEl = DOM.get<HTMLInputElement>('description');
    if (descEl && descEl.value !== formDescription.value) {
      descEl.value = formDescription.value;
    }
  }));

  templateManagerEffectCleanups.push(effect(() => {
    const dateEl = DOM.get<HTMLInputElement>('date');
    if (dateEl && dateEl.value !== formDate.value) {
      dateEl.value = formDate.value;
    }
  }));

  templateManagerEffectCleanups.push(effect(() => {
    const tagsEl = DOM.get<HTMLInputElement>('tags');
    if (tagsEl && tagsEl.value !== formTags.value) {
      tagsEl.value = formTags.value;
    }
  }));

  templateManagerEffectCleanups.push(effect(() => {
    const notesEl = DOM.get<HTMLTextAreaElement>('tx-notes');
    if (notesEl && notesEl.value !== formNotes.value) {
      notesEl.value = formNotes.value;
    }
  }));

  templateManagerEffectCleanups.push(effect(() => {
    const recurringSection = DOM.get('recurring-section');
    if (recurringSection) {
      recurringSection.classList.toggle('hidden', !formRecurring.value);
    }
  }));

  templateManagerEffectCleanups.push(effect(() => {
    const detailsEl = DOM.get<HTMLDetailsElement>('transaction-details');
    if (!detailsEl) return;

    const shouldOpen = formRecurring.value || !!formTags.value || !!formNotes.value || signals.isEditing.value;
    detailsEl.open = shouldOpen;
  }));

  // CR-Apr24-I finding 98: re-render template list when currency changes so
  // the fmtCur()-formatted amounts update to the new currency symbol/format.
  on(Events.CURRENCY_CHANGED, renderTemplates);
  // CR-Apr24-I finding 97: re-render template list when categories change so
  // renamed/recolored category names and emojis update in the template panel.
  on(Events.CATEGORY_UPDATED, renderTemplates);
}

export function cleanupTemplateManager(): void {
  templateManagerEffectCleanups.splice(0, templateManagerEffectCleanups.length).forEach((cleanup) => cleanup());

  // CR-Apr24-I findings 97, 98: unsubscribe currency + category listeners
  off(Events.CURRENCY_CHANGED, renderTemplates);
  off(Events.CATEGORY_UPDATED, renderTemplates);

  if (toggleTemplatesButton && toggleTemplatesButtonHandler) {
    toggleTemplatesButton.removeEventListener('click', toggleTemplatesButtonHandler);
  }
  toggleTemplatesButton = null;
  toggleTemplatesButtonHandler = null;
  templateManagerInitialized = false;
}

// ==========================================
// EXPORTS
// ==========================================

export default {
  saveAsTemplate,
  applyTemplate,
  deleteTemplate,
  renderTemplates,
  setTemplateRenderCategoriesFn,
  setTemplateSwitchTabFn,
  initTemplateManager,
  cleanupTemplateManager,
  syncFormWithSignals,
  readFormIntoSignals,
  // Export form signals for external access
  formAmount,
  formDescription,
  formTags,
  formDate,
  formNotes,
  formRecurring,
  formRecurringType,
  formRecurringEnd
};
