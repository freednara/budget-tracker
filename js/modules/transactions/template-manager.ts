/**
 * Template Manager
 *
 * Manages transaction templates - save, apply, delete, and render.
 * Templates allow users to quickly reuse common transaction patterns.
 *
 * @module transactions/template-manager
 */
'use strict';

import { SK, persist } from '../core/state.js';
import * as signals from '../core/signals.js';
import { form, data, navigation } from '../core/state-actions.js';
import { getCatInfo } from '../core/categories.js';
import { showToast } from '../ui/core/ui.js';
import DOM from '../core/dom-cache.js';
import { html, render } from '../core/lit-helpers.js';
import type { TxTemplate, TransactionType } from '../../types/index.js';

// ==========================================
// TYPES
// ==========================================

export type CurrencyFormatter = (value: number) => string;
export type RenderCategoriesCallback = () => void;

// ==========================================
// CALLBACKS
// ==========================================

// Callback for currency formatting
let fmtCurFn: CurrencyFormatter = (v: number): string => '$' + Math.abs(v).toFixed(2);

// Callback for rendering categories (used by applyTemplate)
let renderCategoriesFn: RenderCategoriesCallback | null = null;

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

// ==========================================
// TEMPLATE FUNCTIONS
// ==========================================

/**
 * Save current form state as a reusable template
 */
export function saveAsTemplate(name: string): void {
  const amountEl = DOM.get('amount') as HTMLInputElement | null;
  const descEl = DOM.get('description') as HTMLInputElement | null;
  const tagsEl = DOM.get('tags') as HTMLInputElement | null;
  const recurringEl = DOM.get('recurring-toggle') as HTMLInputElement | null;
  const recurringTypeEl = DOM.get('recurring-type') as HTMLSelectElement | null;
  const recurringEndEl = DOM.get('recurring-end') as HTMLInputElement | null;

  const template: TxTemplate = {
    id: `tmpl_${Date.now()}`,
    name,
    type: signals.currentType.value as TransactionType,
    category: signals.selectedCategory.value,
    amount: parseFloat(amountEl?.value || '0') || undefined,
    description: descEl?.value.trim() || undefined
  };

  // Store additional template data as extended properties
  const extendedTemplate = {
    ...template,
    tags: tagsEl?.value.trim() || '',
    recurring: recurringEl?.checked || false,
    recurringType: recurringTypeEl?.value || 'monthly',
    recurringEnd: recurringEndEl?.value || ''
  };

  data.setTxTemplates([...signals.txTemplates.value, extendedTemplate as TxTemplate]);
  persist(SK.TX_TEMPLATES, signals.txTemplates.value);
  renderTemplates();
  showToast(`Template "${name}" saved`, 'success');
}

/**
 * Apply a saved template to the transaction form
 */
export function applyTemplate(templateId: string): void {
  const tmpl = signals.txTemplates.value.find(t => t.id === templateId);
  if (!tmpl) return;

  // Set transaction type
  navigation.setCurrentTab(tmpl.type);
  if (tmpl.type === 'expense') {
    DOM.get('tab-expense')?.click();
  } else {
    DOM.get('tab-income')?.click();
  }

  // Set category
  setTimeout(() => {
    form.setSelectedCategory(tmpl.category);
    if (renderCategoriesFn) renderCategoriesFn();
  }, 50);

  const amountEl = DOM.get('amount') as HTMLInputElement | null;
  const descEl = DOM.get('description') as HTMLInputElement | null;
  const tagsEl = DOM.get('tags') as HTMLInputElement | null;
  const recurringEl = DOM.get('recurring-toggle') as HTMLInputElement | null;
  const recurringSection = DOM.get('recurring-section');
  const recurringTypeEl = DOM.get('recurring-type') as HTMLSelectElement | null;
  const recurringEndEl = DOM.get('recurring-end') as HTMLInputElement | null;

  // Set amount (always set, clear if not specified)
  if (amountEl) amountEl.value = tmpl.amount ? String(tmpl.amount) : '';

  // Set description
  if (descEl) descEl.value = tmpl.description || '';

  // Extended template properties
  const extTmpl = tmpl as TxTemplate & { tags?: string; recurring?: boolean; recurringType?: string; recurringEnd?: string };

  // Set tags
  if (tagsEl) tagsEl.value = extTmpl.tags || '';

  // Set recurring
  if (recurringEl) recurringEl.checked = extTmpl.recurring || false;
  if (recurringSection) recurringSection.classList.toggle('hidden', !extTmpl.recurring);
  if (recurringTypeEl) recurringTypeEl.value = (extTmpl.recurring && extTmpl.recurringType) ? extTmpl.recurringType : 'monthly';
  if (recurringEndEl) recurringEndEl.value = extTmpl.recurringEnd || '';

  // Focus amount field
  amountEl?.focus();
  showToast(`Template "${tmpl.name}" applied`, 'info');
}

/**
 * Delete a saved template
 */
export function deleteTemplate(templateId: string): void {
  data.removeTxTemplate(templateId);
  persist(SK.TX_TEMPLATES, signals.txTemplates.value);
  renderTemplates();
  showToast('Template deleted', 'info');
}

/**
 * Render the list of saved templates
 */
export function renderTemplates(): void {
  const container = DOM.get('templates-list');
  if (!container) return;

  const templates = signals.txTemplates.value;
  if (!templates.length) {
    render(html`<p class="text-xs" style="color: var(--text-tertiary);">No templates yet</p>`, container);
    return;
  }

  const handleTemplateClick = (e: Event, templateId: string) => {
    if ((e.target as HTMLElement).closest('.delete-template-btn')) return;
    applyTemplate(templateId);
  };

  const handleTemplateKeydown = (e: KeyboardEvent, templateId: string) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      applyTemplate(templateId);
    }
  };

  const handleDeleteClick = (e: Event, templateId: string) => {
    e.stopPropagation();
    deleteTemplate(templateId);
  };

  render(html`
    ${templates.map(t => {
      const cat = getCatInfo(t.type, t.category);
      return html`
        <div class="template-btn flex items-center gap-2 px-3 py-2 rounded-lg text-left w-full transition-all cursor-pointer"
          data-template-id=${t.id} role="button" tabindex="0"
          style="background: var(--bg-input); border: 1px solid var(--border-input);"
          @click=${(e: Event) => handleTemplateClick(e, t.id)}
          @keydown=${(e: KeyboardEvent) => handleTemplateKeydown(e, t.id)}>
          <span class="text-lg">${cat.emoji}</span>
          <div class="flex-1 min-w-0">
            <p class="text-xs font-bold truncate" style="color: var(--text-primary);">${t.name}</p>
            <p class="text-xs truncate" style="color: var(--text-tertiary);">${cat.name}${t.amount ? ' · ' + fmtCurFn(t.amount) : ''}</p>
          </div>
          <button type="button" class="delete-template-btn p-1 rounded hover:opacity-70"
            @click=${(e: Event) => handleDeleteClick(e, t.id)}
            style="color: var(--color-expense);" title="Delete template">✕</button>
        </div>
      `;
    })}
  `, container);
}
