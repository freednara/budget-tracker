/**
 * Async Modal Service
 * 
 * Non-blocking modal dialogs that replace synchronous confirm() and alert() calls.
 * Prevents browser thread blocking during import operations.
 */

import { openModal, closeModal } from '../core/ui.js';
import DOM from '../../core/dom-cache.js';
import { esc } from '../../core/utils.js';

// ==========================================
// TYPE DEFINITIONS
// ==========================================

export interface ConfirmOptions {
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  type?: 'info' | 'warning' | 'danger';
  details?: string;
}

export interface AlertOptions {
  title?: string;
  message: string;
  type?: 'info' | 'success' | 'warning' | 'error';
  buttonText?: string;
}

export interface PromptOptions {
  title?: string;
  message: string;
  placeholder?: string;
  defaultValue?: string;
  confirmText?: string;
  cancelText?: string;
  type?: 'info' | 'warning';
}

// ==========================================
// MODAL CREATION
// ==========================================

/**
 * Create async confirmation modal in DOM if it doesn't exist
 */
function ensureConfirmModal(): void {
  if (document.getElementById('async-confirm-modal')) return;

  const modalHTML = `
    <div id="async-confirm-modal" class="modal-overlay" role="dialog" aria-modal="true">
      <div class="modal-content confirm-modal">
        <div class="modal-header">
          <h3 id="confirm-title">Confirm Action</h3>
        </div>
        <div class="modal-body">
          <div id="confirm-icon" class="confirm-icon"></div>
          <div id="confirm-message" class="confirm-message"></div>
          <div id="confirm-details" class="confirm-details" style="display: none;"></div>
        </div>
        <div class="modal-actions">
          <button id="confirm-cancel" class="btn btn-secondary">Cancel</button>
          <button id="confirm-ok" class="btn btn-primary">OK</button>
        </div>
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML('beforeend', modalHTML);
}

/**
 * Create async alert modal in DOM if it doesn't exist
 */
function ensureAlertModal(): void {
  if (document.getElementById('async-alert-modal')) return;

  const modalHTML = `
    <div id="async-alert-modal" class="modal-overlay" role="dialog" aria-modal="true">
      <div class="modal-content alert-modal">
        <div class="modal-header">
          <h3 id="alert-title">Information</h3>
        </div>
        <div class="modal-body">
          <div id="alert-icon" class="alert-icon"></div>
          <div id="alert-message" class="alert-message"></div>
        </div>
        <div class="modal-actions">
          <button id="alert-ok" class="btn btn-primary">OK</button>
        </div>
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML('beforeend', modalHTML);
}

/**
 * Create async prompt modal in DOM if it doesn't exist
 */
function ensurePromptModal(): void {
  if (document.getElementById('async-prompt-modal')) return;

  const modalHTML = `
    <div id="async-prompt-modal" class="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="prompt-title">
      <div class="modal-content prompt-modal">
        <div class="modal-header">
          <h3 id="prompt-title">Enter Value</h3>
        </div>
        <div class="modal-body">
          <div id="prompt-message" class="confirm-message"></div>
          <input
            id="prompt-input"
            type="text"
            class="w-full px-4 py-3 rounded-lg text-sm"
            style="background: var(--bg-input); color: var(--text-primary); border: 1px solid var(--border-input);"
            autocomplete="off"
          />
        </div>
        <div class="modal-actions">
          <button id="prompt-cancel" class="btn btn-secondary">Cancel</button>
          <button id="prompt-ok" class="btn btn-primary">Save</button>
        </div>
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML('beforeend', modalHTML);
}

// ==========================================
// ASYNC MODAL FUNCTIONS
// ==========================================

/**
 * Show async confirmation dialog
 * @param options - Confirmation options
 * @returns Promise that resolves to true if confirmed, false if cancelled
 */
export function asyncConfirm(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    ensureConfirmModal();

    // Set modal content
    const titleEl = document.getElementById('confirm-title');
    const messageEl = document.getElementById('confirm-message');
    const detailsEl = document.getElementById('confirm-details');
    const iconEl = document.getElementById('confirm-icon');
    const cancelBtn = document.getElementById('confirm-cancel');
    const okBtn = document.getElementById('confirm-ok');

    if (titleEl) titleEl.textContent = options.title || 'Confirm Action';
    if (messageEl) messageEl.textContent = options.message;
    
    if (detailsEl) {
      if (options.details) {
        detailsEl.textContent = options.details;
        detailsEl.style.display = 'block';
      } else {
        detailsEl.style.display = 'none';
      }
    }

    if (iconEl) {
      const icons = {
        info: '📄',
        warning: '⚠️',
        danger: '🚨'
      };
      iconEl.textContent = icons[options.type || 'info'];
    }

    if (cancelBtn) {
      cancelBtn.textContent = options.cancelText || 'Cancel';
    }
    
    if (okBtn) {
      okBtn.textContent = options.confirmText || 'OK';
      okBtn.className = `btn ${options.type === 'danger' ? 'btn-danger' : 'btn-primary'}`;
    }

    // Set up event handlers
    const handleCancel = () => {
      cleanup();
      resolve(false);
    };

    const handleConfirm = () => {
      cleanup();
      resolve(true);
    };

    const handleKeydown = (e: KeyboardEvent) => {
      // Don't capture Enter when focus is in an input/textarea/select
      const tag = (e.target as HTMLElement)?.tagName;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        handleCancel();
      } else if (e.key === 'Enter' && tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') {
        e.preventDefault();
        e.stopPropagation();
        handleConfirm();
      }
    };

    // Handle backdrop click (clicking the overlay outside the modal content)
    const handleBackdropClick = (e: MouseEvent) => {
      const modal = document.getElementById('async-confirm-modal');
      if (e.target === modal) {
        handleCancel();
      }
    };

    const cleanup = () => {
      closeModal('async-confirm-modal');
      cancelBtn?.removeEventListener('click', handleCancel);
      okBtn?.removeEventListener('click', handleConfirm);
      document.removeEventListener('keydown', handleKeydown);
      const modal = document.getElementById('async-confirm-modal');
      modal?.removeEventListener('click', handleBackdropClick);
    };

    // Attach event listeners
    cancelBtn?.addEventListener('click', handleCancel);
    okBtn?.addEventListener('click', handleConfirm);
    document.addEventListener('keydown', handleKeydown);

    // Mark the modal so openModal() skips its own backdrop handler (we manage dismiss ourselves)
    const modalEl = document.getElementById('async-confirm-modal');
    if (modalEl) (modalEl as any)._hasBackdropListener = true;
    modalEl?.addEventListener('click', handleBackdropClick);

    // Show modal (won't add duplicate backdrop handler due to _hasBackdropListener)
    openModal('async-confirm-modal');
    
    // Focus the appropriate button
    if (options.type === 'danger') {
      cancelBtn?.focus();
    } else {
      okBtn?.focus();
    }
  });
}

/**
 * Show async alert dialog
 * @param options - Alert options
 * @returns Promise that resolves when dismissed
 */
export function asyncAlert(options: AlertOptions): Promise<void> {
  return new Promise((resolve) => {
    ensureAlertModal();

    // Set modal content
    const titleEl = document.getElementById('alert-title');
    const messageEl = document.getElementById('alert-message');
    const iconEl = document.getElementById('alert-icon');
    const okBtn = document.getElementById('alert-ok');

    if (titleEl) {
      const titles = {
        info: 'Information',
        success: 'Success',
        warning: 'Warning',
        error: 'Error'
      };
      titleEl.textContent = options.title || titles[options.type || 'info'];
    }
    
    if (messageEl) messageEl.textContent = options.message;

    if (iconEl) {
      const icons = {
        info: 'ℹ️',
        success: '✅',
        warning: '⚠️',
        error: '❌'
      };
      iconEl.textContent = icons[options.type || 'info'];
    }

    if (okBtn) {
      okBtn.textContent = options.buttonText || 'OK';
    }

    // Set up event handlers
    const handleOk = () => {
      cleanup();
      resolve();
    };

    const handleKeydown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Enter') {
        e.preventDefault();
        handleOk();
      }
    };

    // Handle backdrop click
    const handleBackdropClick = (e: MouseEvent) => {
      const modal = document.getElementById('async-alert-modal');
      if (e.target === modal) {
        handleOk();
      }
    };

    const cleanup = () => {
      closeModal('async-alert-modal');
      okBtn?.removeEventListener('click', handleOk);
      document.removeEventListener('keydown', handleKeydown);
      const modal = document.getElementById('async-alert-modal');
      modal?.removeEventListener('click', handleBackdropClick);
    };

    // Attach event listeners
    okBtn?.addEventListener('click', handleOk);
    document.addEventListener('keydown', handleKeydown);

    // Mark the modal so openModal() skips its own backdrop handler
    const alertModalEl = document.getElementById('async-alert-modal');
    if (alertModalEl) (alertModalEl as any)._hasBackdropListener = true;
    alertModalEl?.addEventListener('click', handleBackdropClick);

    // Show modal
    openModal('async-alert-modal');
    okBtn?.focus();
  });
}

/**
 * Show async prompt dialog
 * @param options - Prompt options
 * @returns Promise resolving to trimmed input text or null if cancelled
 */
export function asyncPrompt(options: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => {
    ensurePromptModal();

    const titleEl = document.getElementById('prompt-title');
    const messageEl = document.getElementById('prompt-message');
    const inputEl = document.getElementById('prompt-input') as HTMLInputElement | null;
    const cancelBtn = document.getElementById('prompt-cancel');
    const okBtn = document.getElementById('prompt-ok');

    if (titleEl) titleEl.textContent = options.title || 'Enter Value';
    if (messageEl) messageEl.textContent = options.message;
    if (inputEl) {
      inputEl.placeholder = options.placeholder || '';
      inputEl.value = options.defaultValue || '';
    }
    if (cancelBtn) cancelBtn.textContent = options.cancelText || 'Cancel';
    if (okBtn) {
      okBtn.textContent = options.confirmText || 'Save';
      okBtn.className = `btn ${options.type === 'warning' ? 'btn-danger' : 'btn-primary'}`;
    }

    const finish = (value: string | null) => {
      cleanup();
      resolve(value);
    };

    const handleCancel = () => finish(null);

    const handleConfirm = () => {
      const value = inputEl?.value.trim() || '';
      if (!value) {
        inputEl?.focus();
        return;
      }
      finish(value);
    };

    const handleKeydown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        handleCancel();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        handleConfirm();
      }
    };

    const handleBackdropClick = (e: MouseEvent) => {
      const modal = document.getElementById('async-prompt-modal');
      if (e.target === modal) {
        handleCancel();
      }
    };

    const cleanup = () => {
      closeModal('async-prompt-modal');
      cancelBtn?.removeEventListener('click', handleCancel);
      okBtn?.removeEventListener('click', handleConfirm);
      inputEl?.removeEventListener('keydown', handleKeydown);
      document.removeEventListener('keydown', handleKeydown);
      const modal = document.getElementById('async-prompt-modal');
      modal?.removeEventListener('click', handleBackdropClick);
    };

    cancelBtn?.addEventListener('click', handleCancel);
    okBtn?.addEventListener('click', handleConfirm);
    inputEl?.addEventListener('keydown', handleKeydown);
    document.addEventListener('keydown', handleKeydown);

    const promptModalEl = document.getElementById('async-prompt-modal');
    if (promptModalEl) (promptModalEl as any)._hasBackdropListener = true;
    promptModalEl?.addEventListener('click', handleBackdropClick);

    openModal('async-prompt-modal');

    requestAnimationFrame(() => {
      inputEl?.focus();
      inputEl?.select();
    });
  });
}

// ==========================================
// CONVENIENCE FUNCTIONS
// ==========================================

/**
 * Quick confirmation for dangerous actions
 */
export function confirmDanger(message: string, details?: string): Promise<boolean> {
  return asyncConfirm({
    title: 'Confirm Dangerous Action',
    message,
    details,
    type: 'danger',
    confirmText: 'Yes, Proceed',
    cancelText: 'Cancel'
  });
}

/**
 * Quick confirmation for data operations
 */
export function confirmDataOperation(message: string, details?: string): Promise<boolean> {
  return asyncConfirm({
    title: 'Confirm Data Operation',
    message,
    details,
    type: 'warning',
    confirmText: 'Continue',
    cancelText: 'Cancel'
  });
}

/**
 * Quick text prompt for named entities like templates and presets.
 */
export function promptTextInput(message: string, title = 'Enter Name', defaultValue = '', placeholder = ''): Promise<string | null> {
  return asyncPrompt({
    title,
    message,
    defaultValue,
    placeholder,
    confirmText: 'Save',
    cancelText: 'Cancel'
  });
}

/**
 * Quick success notification
 */
export function alertSuccess(message: string): Promise<void> {
  return asyncAlert({
    message,
    type: 'success'
  });
}

/**
 * Quick error notification
 */
export function alertError(message: string): Promise<void> {
  return asyncAlert({
    message,
    type: 'error',
    title: 'Error'
  });
}

// ==========================================
// INITIALIZATION
// ==========================================

/**
 * Initialize async modal system
 */
export function initAsyncModals(): void {
  // Create modals in DOM
  ensureConfirmModal();
  ensureAlertModal();
  ensurePromptModal();
}

export default {
  asyncConfirm,
  asyncAlert,
  asyncPrompt,
  confirmDanger,
  confirmDataOperation,
  promptTextInput,
  alertSuccess,
  alertError,
  initAsyncModals
};
