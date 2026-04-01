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
import { showToast } from '../ui/core/ui.js';
import { asyncConfirm } from '../ui/components/async-modal.js';
import { fmtCur, getTodayStr } from '../core/utils.js';
import DOM from '../core/dom-cache.js';
import { html, render } from '../core/lit-helpers.js';
import { emptyState } from '../ui/core/empty-state.js';
import { emit, Events } from '../core/event-bus.js';
import type { TxTemplate, TransactionType } from '../../types/index.js';

// ==========================================
// TYPES
// ==========================================

export type CurrencyFormatter = (value: number) => string;
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

// Callback for currency formatting
let fmtCurFn: CurrencyFormatter = fmtCur;

// Callback for rendering categories (used by applyTemplate)
let renderCategoriesFn: RenderCategoriesCallback | null = null;
let switchTabFn: SwitchTabCallback | null = null;
let templateManagerInitialized = false;
let templatesCollapsedOnPhone = false;
let templatesMediaQuery: MediaQueryList | null = null;
let templatesMediaQueryHandler: ((event: MediaQueryListEvent) => void) | null = null;
let toggleTemplatesButton: HTMLButtonElement | null = null;
let toggleTemplatesButtonHandler: (() => void) | null = null;
const templateManagerEffectCleanups: Array<() => void> = [];

function isPhoneTemplatesLayout(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches;
}

function updateTemplatesCollapseUi(templateCount: number): void {
  const toggle = DOM.get('toggle-templates-mobile') as HTMLButtonElement | null;
  const panel = document.querySelector('.transactions-templates-panel') as HTMLElement | null;
  if (!toggle || !panel) return;

  const showToggle = isPhoneTemplatesLayout() && templateCount > 0;
  toggle.hidden = !showToggle;
  panel.classList.toggle('transactions-templates-panel--collapsed', showToggle && templatesCollapsedOnPhone);

  if (!showToggle) {
    toggle.setAttribute('aria-expanded', 'true');
    toggle.textContent = 'Hide';
    return;
  }

  toggle.setAttribute('aria-expanded', String(!templatesCollapsedOnPhone));
  toggle.textContent = templatesCollapsedOnPhone ? `Show (${templateCount})` : 'Hide';
}

/**
 * Set the currency formatting function
 */
export function setTemplateFmtCurFn(fn: CurrencyFormatter): void {
  fmtCurFn = fn;
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
  const amountEl = DOM.get('amount') as HTMLInputElement | null;
  const descEl = DOM.get('description') as HTMLInputElement | null;
  const dateEl = DOM.get('date') as HTMLInputElement | null;
  const tagsEl = DOM.get('tags') as HTMLInputElement | null;
  const notesEl = DOM.get('tx-notes') as HTMLTextAreaElement | null;
  const recurringEl = DOM.get('recurring-toggle') as HTMLInputElement | null;
  const recurringSection = DOM.get('recurring-section');
  const recurringTypeEl = DOM.get('recurring-type') as HTMLSelectElement | null;
  const recurringEndEl = DOM.get('recurring-end') as HTMLInputElement | null;

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
  const amountEl = DOM.get('amount') as HTMLInputElement | null;
  const descEl = DOM.get('description') as HTMLInputElement | null;
  const dateEl = DOM.get('date') as HTMLInputElement | null;
  const tagsEl = DOM.get('tags') as HTMLInputElement | null;
  const notesEl = DOM.get('tx-notes') as HTMLTextAreaElement | null;
  const recurringEl = DOM.get('recurring-toggle') as HTMLInputElement | null;
  const recurringTypeEl = DOM.get('recurring-type') as HTMLSelectElement | null;
  const recurringEndEl = DOM.get('recurring-end') as HTMLInputElement | null;

  // Update signals from DOM
  formAmount.value = amountEl?.value || '';
  formDescription.value = descEl?.value.trim() || '';
  formDate.value = dateEl?.value || new Date().toISOString().split('T')[0];
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
  // First sync signals with current DOM state
  readFormIntoSignals();

  const template: TxTemplate = {
    id: `tmpl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name,
    type: signals.currentType.value as TransactionType,
    category: signals.selectedCategory.value,
    amount: formAmount.value ? parseFloat(formAmount.value) : undefined,
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
  showToast(`Template "${name}" saved`, 'success');
}

/**
 * Apply a saved template to the transaction form
 * Updates signals which trigger reactive UI updates
 */
export async function applyTemplate(templateId: string): Promise<void> {
  const tmpl = signals.txTemplates.value.find(t => t.id === templateId);
  if (!tmpl) {
    showToast('Template not found', 'error');
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
  const amountEl = DOM.get('amount') as HTMLInputElement | null;
  amountEl?.focus();
  
  showToast(`Template "${tmpl.name}" applied`, 'info');
}

/**
 * Delete a saved template
 */
export function deleteTemplate(templateId: string): void {
  const template = signals.txTemplates.value.find(t => t.id === templateId);
  if (!template) {
    showToast('Template not found', 'error');
    return;
  }

  data.removeTxTemplate(templateId);
  persist(SK.TX_TEMPLATES, signals.txTemplates.value);
  renderTemplates();
  showToast(`Template "${template.name}" deleted`, 'info');
}

/**
 * Render the list of saved templates with improved error handling
 */
export function renderTemplates(): void {
  const container = DOM.get('templates-list');
  if (!container) return;

  const templates = signals.txTemplates.value;
  updateTemplatesCollapseUi(templates.length);

  if (!templates.length) {
    render(emptyState(
      '↻',
      'No templates yet',
      'Save a transaction pattern to reuse amount, category, and recurring details faster.'
    ), container);
    return;
  }

  if (isPhoneTemplatesLayout() && templatesCollapsedOnPhone) {
    render(html`
      <div class="template-collapsed-summary" role="status" aria-live="polite">
        <p class="template-collapsed-summary__title">${templates.length} template${templates.length === 1 ? '' : 's'} ready</p>
        <p class="template-collapsed-summary__body">
          Expand this section to reuse saved transaction patterns without adding more scroll by default.
        </p>
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
    
    // Confirm deletion for safety
    const confirmed = await asyncConfirm({
      title: 'Delete Template',
      message: 'Delete this transaction template?',
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
      
      return html`
        <div class="template-btn flex items-center gap-2 px-3 py-2 rounded-lg text-left w-full transition-all cursor-pointer"
          data-template-id=${t.id} 
          role="button" 
          tabindex="0"
          style="background: var(--bg-input); border: 1px solid var(--border-input); ${!isValidCategory ? 'opacity: 0.8;' : ''}"
          @click=${(e: Event) => handleTemplateClick(e, t.id)}
          @keydown=${(e: KeyboardEvent) => handleTemplateKeydown(e, t.id)}
          title="${!isValidCategory ? 'Category may be missing' : ''}">
          <span class="text-lg">${cat.emoji}</span>
          <div class="flex-1 min-w-0">
            <p class="text-xs font-bold truncate" style="color: var(--text-primary);">
              ${t.name}
            </p>
            <p class="text-xs truncate" style="color: var(--text-tertiary);">
              ${cat.name}${t.amount ? ' · ' + fmtCurFn(t.amount) : ''}
              ${t.recurring ? ' · 🔁' : ''}
              ${!isValidCategory ? ' ⚠️' : ''}
            </p>
          </div>
          <button type="button" 
            class="delete-template-btn p-1 rounded hover:opacity-70"
            @click=${(e: Event) => handleDeleteClick(e, t.id)}
            style="color: var(--color-expense);" 
            title="Delete template"
            aria-label="Delete template ${t.name}">
            ✕
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

  templatesCollapsedOnPhone = isPhoneTemplatesLayout();
  templatesMediaQuery = window.matchMedia('(max-width: 767px)');
  const syncTemplatesForViewport = (matches: boolean): void => {
    templatesCollapsedOnPhone = matches;
    renderTemplates();
  };
  templatesMediaQueryHandler = (event: MediaQueryListEvent) => {
    syncTemplatesForViewport(event.matches);
  };
  templatesMediaQuery.addEventListener('change', templatesMediaQueryHandler);

  toggleTemplatesButton = DOM.get('toggle-templates-mobile') as HTMLButtonElement | null;
  toggleTemplatesButtonHandler = () => {
    if (!isPhoneTemplatesLayout()) return;
    templatesCollapsedOnPhone = !templatesCollapsedOnPhone;
    renderTemplates();
  };
  toggleTemplatesButton?.addEventListener('click', toggleTemplatesButtonHandler);

  // Set up signal effects to sync with DOM
  templateManagerEffectCleanups.push(effect(() => {
    const amountEl = DOM.get('amount') as HTMLInputElement | null;
    if (amountEl && amountEl.value !== formAmount.value) {
      amountEl.value = formAmount.value;
    }
  }));

  templateManagerEffectCleanups.push(effect(() => {
    const descEl = DOM.get('description') as HTMLInputElement | null;
    if (descEl && descEl.value !== formDescription.value) {
      descEl.value = formDescription.value;
    }
  }));

  templateManagerEffectCleanups.push(effect(() => {
    const dateEl = DOM.get('date') as HTMLInputElement | null;
    if (dateEl && dateEl.value !== formDate.value) {
      dateEl.value = formDate.value;
    }
  }));

  templateManagerEffectCleanups.push(effect(() => {
    const tagsEl = DOM.get('tags') as HTMLInputElement | null;
    if (tagsEl && tagsEl.value !== formTags.value) {
      tagsEl.value = formTags.value;
    }
  }));

  templateManagerEffectCleanups.push(effect(() => {
    const notesEl = DOM.get('tx-notes') as HTMLTextAreaElement | null;
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
    const detailsEl = DOM.get('transaction-details') as HTMLDetailsElement | null;
    if (!detailsEl) return;

    const shouldOpen = formRecurring.value || !!formTags.value || !!formNotes.value || signals.isEditing.value;
    detailsEl.open = shouldOpen;
  }));
}

export function cleanupTemplateManager(): void {
  templateManagerEffectCleanups.splice(0, templateManagerEffectCleanups.length).forEach((cleanup) => cleanup());
  if (templatesMediaQuery && templatesMediaQueryHandler) {
    templatesMediaQuery.removeEventListener('change', templatesMediaQueryHandler);
  }
  templatesMediaQueryHandler = null;
  templatesMediaQuery = null;

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
  setTemplateFmtCurFn,
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
