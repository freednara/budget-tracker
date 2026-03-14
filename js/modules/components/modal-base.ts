/**
 * Modal Base Component
 *
 * Reusable modal templates for consistent modal rendering.
 * Works with existing openModal/closeModal functions from ui.ts.
 *
 * @module components/modal-base
 */
'use strict';

import { html, nothing, type TemplateResult } from '../core/lit-helpers.js';

// ==========================================
// TYPE DEFINITIONS
// ==========================================

export type ModalSize = 'sm' | 'md' | 'lg' | 'xl';

export interface ModalOptions {
  /** Unique modal ID (used by openModal/closeModal) */
  id: string;
  /** Modal title displayed in header */
  title: string;
  /** Modal body content */
  content: TemplateResult | typeof nothing;
  /** Optional footer actions (buttons) */
  actions?: TemplateResult | typeof nothing;
  /** Modal size variant */
  size?: ModalSize;
  /** Whether modal content should scroll */
  scrollable?: boolean;
  /** Custom background class (e.g., 'savings-card-bg') */
  bgClass?: string;
  /** Optional title icon/emoji */
  icon?: string;
}

// ==========================================
// SIZE CONFIGURATION
// ==========================================

const SIZE_CLASSES: Record<ModalSize, string> = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
  xl: 'max-w-2xl'
};

// ==========================================
// MODAL TEMPLATES
// ==========================================

/**
 * Render a modal with standard structure
 *
 * @example
 * ```typescript
 * renderModal({
 *   id: 'delete-modal',
 *   title: 'Delete Transaction?',
 *   content: html`<p>This cannot be undone.</p>`,
 *   actions: html`
 *     <button class="btn-secondary" @click=${() => closeModal('delete-modal')}>Cancel</button>
 *     <button class="btn-danger" @click=${handleDelete}>Delete</button>
 *   `,
 *   size: 'sm'
 * })
 * ```
 */
export function renderModal(options: ModalOptions): TemplateResult {
  const {
    id,
    title,
    content,
    actions = nothing,
    size = 'md',
    scrollable = false,
    bgClass,
    icon
  } = options;

  const titleId = `${id}-title`;
  const sizeClass = SIZE_CLASSES[size];

  const contentStyles = scrollable
    ? 'max-height: 85vh; overflow-y: auto;'
    : '';

  const bgStyles = bgClass
    ? ''
    : 'background: var(--bg-card-section); border: 1px solid var(--border-section);';

  return html`
    <div id="${id}"
         class="modal-overlay"
         role="dialog"
         aria-modal="true"
         aria-labelledby="${titleId}">
      <div class="rounded-2xl p-6 ${sizeClass} w-full card-shadow ${bgClass || ''}"
           style="${bgStyles} ${contentStyles}">
        <h3 id="${titleId}"
            class="text-xl font-black mb-4"
            style="color: var(--text-primary);">
          ${icon ? html`${icon} ` : nothing}${title}
        </h3>
        ${content}
        ${actions !== nothing ? html`
          <div class="modal-actions flex gap-2 mt-4 justify-end">
            ${actions}
          </div>
        ` : nothing}
      </div>
    </div>
  `;
}

/**
 * Render a confirmation modal (delete, warning, etc.)
 *
 * @example
 * ```typescript
 * renderConfirmModal({
 *   id: 'delete-modal',
 *   title: 'Delete Transaction?',
 *   message: 'This action cannot be undone.',
 *   confirmText: 'Delete',
 *   confirmClass: 'btn-danger',
 *   onConfirm: handleDelete,
 *   onCancel: () => closeModal('delete-modal')
 * })
 * ```
 */
export interface ConfirmModalOptions {
  id: string;
  title: string;
  message: string | TemplateResult;
  confirmText?: string;
  cancelText?: string;
  confirmClass?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function renderConfirmModal(options: ConfirmModalOptions): TemplateResult {
  const {
    id,
    title,
    message,
    confirmText = 'Confirm',
    cancelText = 'Cancel',
    confirmClass = 'btn-primary',
    onConfirm,
    onCancel
  } = options;

  return renderModal({
    id,
    title,
    size: 'sm',
    content: html`
      <p class="text-sm mb-4" style="color: var(--text-secondary);">
        ${message}
      </p>
    `,
    actions: html`
      <button class="btn-secondary flex-1 py-2 rounded-lg font-semibold"
              @click=${onCancel}>
        ${cancelText}
      </button>
      <button class="${confirmClass} flex-1 py-2 rounded-lg font-semibold"
              @click=${onConfirm}>
        ${confirmText}
      </button>
    `
  });
}

/**
 * Render a form modal with standard layout
 *
 * @example
 * ```typescript
 * renderFormModal({
 *   id: 'debt-modal',
 *   title: 'Add Debt',
 *   icon: '💳',
 *   fields: html`
 *     <div class="mb-3">
 *       <label>Name</label>
 *       <input id="debt-name" type="text" />
 *     </div>
 *   `,
 *   submitText: 'Save Debt',
 *   onSubmit: handleSubmit,
 *   onCancel: () => closeModal('debt-modal')
 * })
 * ```
 */
export interface FormModalOptions {
  id: string;
  title: string;
  icon?: string;
  fields: TemplateResult;
  submitText?: string;
  cancelText?: string;
  onSubmit: (e: Event) => void;
  onCancel: () => void;
  size?: ModalSize;
  scrollable?: boolean;
  bgClass?: string;
}

export function renderFormModal(options: FormModalOptions): TemplateResult {
  const {
    id,
    title,
    icon,
    fields,
    submitText = 'Save',
    cancelText = 'Cancel',
    onSubmit,
    onCancel,
    size = 'sm',
    scrollable = false,
    bgClass
  } = options;

  const handleSubmit = (e: Event): void => {
    e.preventDefault();
    onSubmit(e);
  };

  return renderModal({
    id,
    title,
    icon,
    size,
    scrollable,
    bgClass,
    content: html`
      <form @submit=${handleSubmit}>
        ${fields}
        <div class="flex gap-2 mt-4">
          <button type="button"
                  class="btn-secondary flex-1 py-2 rounded-lg font-semibold"
                  @click=${onCancel}>
            ${cancelText}
          </button>
          <button type="submit"
                  class="btn-primary flex-1 py-2 rounded-lg font-semibold">
            ${submitText}
          </button>
        </div>
      </form>
    `
  });
}

// ==========================================
// FIELD TEMPLATES
// ==========================================

/**
 * Render a form field with label
 */
export interface FieldOptions {
  id: string;
  label: string;
  type?: 'text' | 'number' | 'date' | 'email' | 'tel' | 'select' | 'textarea';
  placeholder?: string;
  required?: boolean;
  value?: string | number;
  min?: number;
  max?: number;
  step?: number | string;
  rows?: number;
  options?: Array<{ value: string; label: string }>;
}

export function renderField(options: FieldOptions): TemplateResult {
  const {
    id,
    label,
    type = 'text',
    placeholder,
    required = false,
    value,
    min,
    max,
    step,
    rows = 3,
    options: selectOptions
  } = options;

  const labelTemplate = html`
    <label for="${id}"
           class="block text-xs font-semibold mb-1"
           style="color: var(--text-secondary);">
      ${label}${required ? html`<span style="color: var(--color-expense);"> *</span>` : nothing}
    </label>
  `;

  const inputClass = 'w-full px-3 py-2 rounded-lg text-sm';
  const inputStyle = 'background: var(--bg-input); border: 1px solid var(--border-input); color: var(--text-primary);';

  if (type === 'select' && selectOptions) {
    return html`
      <div class="mb-3">
        ${labelTemplate}
        <select id="${id}"
                class="${inputClass}"
                style="${inputStyle}"
                ?required=${required}>
          ${selectOptions.map(opt => html`
            <option value="${opt.value}" ?selected=${opt.value === value}>${opt.label}</option>
          `)}
        </select>
      </div>
    `;
  }

  if (type === 'textarea') {
    return html`
      <div class="mb-3">
        ${labelTemplate}
        <textarea id="${id}"
                  class="${inputClass}"
                  style="${inputStyle}"
                  placeholder="${placeholder || ''}"
                  rows="${rows}"
                  ?required=${required}>${value || ''}</textarea>
      </div>
    `;
  }

  return html`
    <div class="mb-3">
      ${labelTemplate}
      <input id="${id}"
             type="${type}"
             class="${inputClass}"
             style="${inputStyle}"
             placeholder="${placeholder || ''}"
             .value="${value ?? ''}"
             min="${min ?? ''}"
             max="${max ?? ''}"
             step="${step ?? ''}"
             ?required=${required} />
    </div>
  `;
}

/**
 * Render a row of fields (horizontal layout)
 */
export function renderFieldRow(...fields: TemplateResult[]): TemplateResult {
  return html`
    <div class="flex gap-3">
      ${fields.map(field => html`<div class="flex-1">${field}</div>`)}
    </div>
  `;
}
