/**
 * Async Modal Service
 * 
 * Non-blocking modal dialogs that replace synchronous confirm() and alert() calls.
 * Prevents browser thread blocking during import operations.
 */

import { openModal, closeModal } from '../core/ui.js';
import { trackError } from '../../core/error-tracker.js';
import { activateFocusTrap } from './focus-trap.js';

// ==========================================
// MODAL QUEUE — prevents cross-resolution
// ==========================================
//
// Singleton modals are reused across calls. If two asyncConfirm() calls
// fire nearly simultaneously, the second would overwrite the first's DOM
// content and both Confirm handlers would resolve on a single click.
// The queue ensures only one modal of each type is active at a time;
// subsequent requests wait until the previous one settles.

type QueuedModal<T> = {
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};

const modalQueues: Record<string, QueuedModal<unknown>[]> = {};
const activeModals: Record<string, boolean> = {};

function enqueueModal<T>(type: string, run: () => Promise<T>): Promise<T> {
  if (!modalQueues[type]) modalQueues[type] = [];

  // If no modal of this type is active, run immediately
  if (!activeModals[type]) {
    activeModals[type] = true;
    return run().finally(() => {
      activeModals[type] = false;
      drainQueue(type);
    });
  }

  // Otherwise queue it
  return new Promise<T>((resolve, reject) => {
    (modalQueues[type] as QueuedModal<T>[]).push({ run, resolve, reject });
  });
}

function drainQueue(type: string): void {
  const queue = modalQueues[type];
  if (!queue || queue.length === 0) return;

  const next = queue.shift()!;
  activeModals[type] = true;
  next.run()
    .then(next.resolve as (v: unknown) => void)
    .catch(next.reject)
    .finally(() => {
      activeModals[type] = false;
      drainQueue(type);
    });
}

// Phase 6 Slice 1e (Inline-Behavior-Review rev 12, L14): helper that
// wraps the `openModal(...)` call inside each async-modal Promise body.
// If openModal() throws synchronously (DOM torn down, swipe-manager
// state corrupt, etc.) the already-attached listeners would leak and
// the caller would hang on a never-resolving promise. This helper
// routes the failure through the shared cleanup() so the dialog's
// listeners drop, then surfaces the incident to trackError so the
// monitoring dashboard captures it, then rejects the caller so they
// can recover instead of awaiting forever.
function openModalOrReject(
  id: string,
  cleanup: () => void,
  reject: (reason: Error) => void,
  action: 'asyncConfirm' | 'asyncAlert' | 'asyncPrompt'
): boolean {
  try {
    openModal(id);
    return true;
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    try {
      cleanup();
    } catch {
      // Swallow cleanup errors — we're already in a failure path and
      // the goal is to fire reject() + trackError no matter what.
    }
    trackError(
      `async-modal: openModal('${id}') threw; aborting dialog (${err.message})`,
      { module: 'async-modal', action: `${action}_openModal_threw` },
      'error'
    );
    reject(err);
    return false;
  }
}

/** Element augmented with backdrop-listener tracking flag */
interface ModalElement extends HTMLElement {
  _hasBackdropListener?: boolean;
}

// ==========================================
// TYPE DEFINITIONS
// ==========================================

// Phase 6 Slice 1j (rev 12 L6): optional fields widened for
// `exactOptionalPropertyTypes` — `confirmDanger(message, details?)` and
// `confirmDataOperation(message, details?)` forward `details` as
// `string | undefined` into the confirm payload.
export interface ConfirmOptions {
  title?: string | undefined;
  message: string;
  confirmText?: string | undefined;
  cancelText?: string | undefined;
  type?: 'info' | 'warning' | 'danger' | undefined;
  details?: string | undefined;
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
 * CR-Apr24-I finding 137: previously the rAF-deferred focus restore
 * could steal focus from a modal that opened between the close and the
 * next animation frame. Now checks that no `.modal-overlay.active`
 * exists when the rAF fires, so focus is only restored when no modal
 * is on screen.
 */
function getFocusRestorer(): () => void {
  const previousFocus = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null;

  return () => {
    if (!previousFocus || !document.contains(previousFocus)) {
      return;
    }

    requestAnimationFrame(() => {
      // CR-Apr24-I finding 137: if another modal opened in the meantime,
      // don't yank focus out of it.
      if (document.querySelector('.modal-overlay.active')) return;
      previousFocus.focus();
    });
  };
}

/**
 * Create async confirmation modal in DOM if it doesn't exist
 */
function ensureConfirmModal(): void {
  if (document.getElementById('async-confirm-modal')) return;

  const modalHTML = `
    <div id="async-confirm-modal" class="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-message confirm-details">
      <div class="modal-content confirm-modal">
        <div class="modal-header">
          <h3 id="confirm-title">Confirm Action</h3>
        </div>
        <div class="modal-body">
          <div id="confirm-icon" class="confirm-icon"></div>
          <div id="confirm-message" class="confirm-message"></div>
          <div id="confirm-details" class="confirm-details hidden"></div>
        </div>
        <div class="modal-actions">
          <button id="confirm-cancel" class="btn btn-secondary">Cancel</button>
          <button id="confirm-ok" class="btn btn-primary">Confirm</button>
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
    <div id="async-alert-modal" class="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="alert-title" aria-describedby="alert-message">
      <div class="modal-content alert-modal">
        <div class="modal-header">
          <h3 id="alert-title">Information</h3>
        </div>
        <div class="modal-body">
          <div id="alert-icon" class="alert-icon"></div>
          <div id="alert-message" class="alert-message"></div>
        </div>
        <div class="modal-actions">
          <button id="alert-ok" class="btn btn-primary">Got it</button>
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

  // Design-Review-Apr21 P2: the input previously had no programmatic
  // accessible name — only the surrounding dialog had aria-labelledby,
  // which announces on dialog open but leaves the focused edit field
  // unlabelled. Point the input's aria-labelledby at the title + message
  // ids so AT users hear the purpose + specific prompt when focus lands.
  // Paired with an inline `#prompt-input-error` region (role=alert +
  // hidden-by-default) so empty submissions surface an announced reason
  // instead of the bare re-focus no-op.
  const modalHTML = `
    <div id="async-prompt-modal" class="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="prompt-title" aria-describedby="prompt-message">
      <div class="modal-content prompt-modal">
        <div class="modal-header">
          <h3 id="prompt-title">Enter Value</h3>
        </div>
        <div class="modal-body">
          <div id="prompt-message" class="confirm-message"></div>
          <input
            id="prompt-input"
            type="text"
            class="w-full px-4 py-3 rounded-lg text-sm form-input"
            autocomplete="off"
            aria-labelledby="prompt-title prompt-message"
            aria-describedby="prompt-input-error"
            aria-required="true"
          />
          <div id="prompt-input-error" role="alert" class="text-xs font-bold mt-1 hidden text-warning"></div>
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
  return enqueueModal<boolean>('confirm', () => new Promise((resolve, reject) => {
    ensureConfirmModal();
    const restoreFocus = getFocusRestorer();

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
        detailsEl.classList.remove('hidden');
      } else {
        detailsEl.classList.add('hidden');
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
      okBtn.textContent = options.confirmText || 'Confirm';
      okBtn.className = `btn ${options.type === 'danger' ? 'btn-danger' : 'btn-primary'}`;
    }

    // Design-Review-Apr21 P2 (batch 6 follow-up): hoisted above the
    // keydown handler so Enter-routing can honor the same "safe
    // default" tier that focus landing uses. See the focus block
    // below openModalOrReject for the full rationale.
    const focusCancelByDefault = options.type === 'danger' || options.type === 'warning';

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
        // Design-Review-Apr21 P2 (batch 6 follow-up): the previous
        // handler always routed Enter to `handleConfirm`, so even
        // when the dialog deliberately focused Cancel for a
        // destructive/warning prompt, pressing Enter still
        // accepted the action — defeating the safety value of the
        // focus-heuristic fix above. Route Enter to whichever
        // button currently has focus (matching native button
        // semantics). If focus has drifted outside both buttons,
        // fall back to Confirm for benign `info` prompts and
        // Cancel for the elevated-risk (`danger`/`warning`) tier
        // so the fallback still respects the "safe default"
        // principle applied everywhere else in this batch.
        e.preventDefault();
        e.stopPropagation();
        const active = document.activeElement;
        if (active === cancelBtn) {
          handleCancel();
        } else if (active === okBtn) {
          handleConfirm();
        } else if (focusCancelByDefault) {
          handleCancel();
        } else {
          handleConfirm();
        }
      }
    };

    // Handle backdrop click (clicking the overlay outside the modal content)
    const handleBackdropClick = (e: MouseEvent) => {
      const modal = document.getElementById('async-confirm-modal');
      if (e.target === modal) {
        handleCancel();
      }
    };

    let deactivateTrap: (() => void) | null = null;

    const cleanup = () => {
      deactivateTrap?.();
      closeModal('async-confirm-modal');
      cancelBtn?.removeEventListener('click', handleCancel);
      okBtn?.removeEventListener('click', handleConfirm);
      document.removeEventListener('keydown', handleKeydown);
      const modal = document.getElementById('async-confirm-modal');
      modal?.removeEventListener('click', handleBackdropClick);
      restoreFocus();
    };

    // Attach event listeners
    cancelBtn?.addEventListener('click', handleCancel);
    okBtn?.addEventListener('click', handleConfirm);
    document.addEventListener('keydown', handleKeydown);

    // Mark the modal so openModal() skips its own backdrop handler (we manage dismiss ourselves)
    const modalEl = document.getElementById('async-confirm-modal');
    if (modalEl) (modalEl as ModalElement)._hasBackdropListener = true;
    modalEl?.addEventListener('click', handleBackdropClick);

    // Show modal (won't add duplicate backdrop handler due to _hasBackdropListener)
    // Phase 6 Slice 1e (L14): if openModal throws, cleanup(), route
    // trackError, reject, and skip the focus calls below.
    if (!openModalOrReject('async-confirm-modal', cleanup, reject, 'asyncConfirm')) {
      return;
    }

    // UI/UX Review Expanded: activate focus trap so Tab/Shift+Tab cycles
    // within the modal content, preventing keyboard users from escaping.
    const confirmContent = modalEl?.querySelector<HTMLElement>('.modal-content');
    if (confirmContent) deactivateTrap = activateFocusTrap(confirmContent);

    // Design-Review-Apr21 P2 (batch 6 follow-up): group `warning` with
    // `danger` for focus purposes. Previously only `danger` dialogs
    // landed focus on Cancel; every `warning` confirmation (backup
    // restore, demo-data load, preset/template replacement, import
    // duplicate handling, etc.) opened focused on the affirmative
    // action — one Space/Enter keypress away from proceeding with a
    // cautionary operation. Both elevated-risk tiers now default to
    // Cancel. Only the benign `info` confirm keeps its affirmative
    // default (no data at risk, faster tap-through for the common
    // case). The Enter-key handler above reads the same
    // `focusCancelByDefault` flag, so keyboard behavior stays
    // consistent with focus landing. Matches the "initial focus must
    // be safe" pattern applied to import-options, reset-app-data, and
    // sync-conflict dialogs in this batch.
    if (focusCancelByDefault) {
      cancelBtn?.focus();
    } else {
      okBtn?.focus();
    }
  }));
}

/**
 * Show async alert dialog
 * @param options - Alert options
 * @returns Promise that resolves when dismissed
 */
export function asyncAlert(options: AlertOptions): Promise<void> {
  return enqueueModal<void>('alert', () => new Promise((resolve, reject) => {
    ensureAlertModal();
    const restoreFocus = getFocusRestorer();

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
      okBtn.textContent = options.buttonText || 'Got it';
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

    let deactivateTrap: (() => void) | null = null;

    const cleanup = () => {
      deactivateTrap?.();
      closeModal('async-alert-modal');
      okBtn?.removeEventListener('click', handleOk);
      document.removeEventListener('keydown', handleKeydown);
      const modal = document.getElementById('async-alert-modal');
      modal?.removeEventListener('click', handleBackdropClick);
      restoreFocus();
    };

    // Attach event listeners
    okBtn?.addEventListener('click', handleOk);
    document.addEventListener('keydown', handleKeydown);

    // Mark the modal so openModal() skips its own backdrop handler
    const alertModalEl = document.getElementById('async-alert-modal');
    if (alertModalEl) (alertModalEl as ModalElement)._hasBackdropListener = true;
    alertModalEl?.addEventListener('click', handleBackdropClick);

    // Show modal — Phase 6 Slice 1e (L14): fail-safe wrapper.
    if (!openModalOrReject('async-alert-modal', cleanup, reject, 'asyncAlert')) {
      return;
    }

    // UI/UX Review Expanded: activate focus trap
    const alertContent = alertModalEl?.querySelector<HTMLElement>('.modal-content');
    if (alertContent) deactivateTrap = activateFocusTrap(alertContent);
    okBtn?.focus();
  }));
}

/**
 * Show async prompt dialog
 * @param options - Prompt options
 * @returns Promise resolving to trimmed input text or null if cancelled
 */
export function asyncPrompt(options: PromptOptions): Promise<string | null> {
  return enqueueModal<string | null>('prompt', () => new Promise((resolve, reject) => {
    ensurePromptModal();
    const restoreFocus = getFocusRestorer();

    const titleEl = document.getElementById('prompt-title');
    const messageEl = document.getElementById('prompt-message');
    const inputEl = document.getElementById('prompt-input') as HTMLInputElement | null;
    const cancelBtn = document.getElementById('prompt-cancel');
    const okBtn = document.getElementById('prompt-ok');

    const errorEl = document.getElementById('prompt-input-error');

    if (titleEl) titleEl.textContent = options.title || 'Enter Value';
    if (messageEl) messageEl.textContent = options.message;
    if (inputEl) {
      inputEl.placeholder = options.placeholder || '';
      inputEl.value = options.defaultValue || '';
      // Design-Review-Apr21 P2: reset any error state left over from a prior
      // prompt cycle (`ensurePromptModal()` only creates the DOM once).
      inputEl.setAttribute('aria-invalid', 'false');
    }
    if (errorEl) {
      errorEl.textContent = '';
      errorEl.classList.add('hidden');
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

    const clearPromptError = (): void => {
      if (errorEl) {
        errorEl.textContent = '';
        errorEl.classList.add('hidden');
      }
      inputEl?.setAttribute('aria-invalid', 'false');
    };

    // Design-Review-Apr21 P2: empty Save used to silently refocus the input
    // with no inline error, no announced status, no aria-invalid — every
    // caller (Save Filter Preset, Save Transaction Template, category
    // creation, etc.) felt like the primary action was broken. Surface an
    // announced `role="alert"` message + aria-invalid so SR / sighted /
    // keyboard users all get a reason for the rejection.
    const handleConfirm = () => {
      const value = inputEl?.value.trim() || '';
      if (!value) {
        if (errorEl) {
          errorEl.textContent = 'Please enter a value to continue.';
          errorEl.classList.remove('hidden');
        }
        inputEl?.setAttribute('aria-invalid', 'true');
        inputEl?.focus();
        return;
      }
      clearPromptError();
      finish(value);
    };

    const handleInput = (): void => {
      // Clear the error as soon as the user types so the field can return
      // to a neutral state without requiring another submit attempt.
      if (errorEl && !errorEl.classList.contains('hidden')) {
        clearPromptError();
      }
    };

    const handleKeydown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        // Design-Review-Apr21 P2 (batch 6 follow-up wave J): previously
        // Escape dropped straight to handleCancel() — discarding any
        // partially-typed preset/template/category name with no
        // warning. Mirror the backdrop dirty-check: when the input is
        // dirty, Escape becomes a no-op so a reflexive keypress can't
        // destroy in-progress work. Empty-state Escape still dismisses
        // because there's no value to protect, preserving the "bail
        // out of an unused prompt" gesture. Keeps Escape + backdrop
        // symmetric, so the dirty-state protection is consistent no
        // matter which dismiss affordance the user reaches for.
        const hasDirtyInput = (inputEl?.value.trim().length ?? 0) > 0;
        if (hasDirtyInput) return;
        handleCancel();
      } else if (e.key === 'Enter') {
        // Design-Review-Apr21 P2 (batch 6 follow-up): previously Enter
        // always routed to `handleConfirm`, so after a user tabbed
        // from the text field to Cancel, pressing Enter still saved
        // the prompt instead of activating the focused button —
        // defeating the "back out with Enter" muscle memory and
        // breaking native button semantics. Route Enter to whichever
        // control currently has focus. If focus is still in the
        // input (the default after open), Enter submits as before
        // (matches the implicit-submit convention for single-field
        // prompts). Matches the Enter-routing fix in asyncConfirm
        // above, so both dialogs respect focus consistently.
        e.preventDefault();
        e.stopPropagation();
        const active = document.activeElement;
        if (active === cancelBtn) {
          handleCancel();
        } else {
          handleConfirm();
        }
      }
    };

    // Design-Review-Apr21 P2 (batch 6 follow-up): previously a backdrop
    // click resolved the prompt with `null` unconditionally, discarding
    // any text the user had typed into `inputEl` — even after 15+
    // characters of a preset/template/category name. That inconsistency
    // is especially jarring because the main data-entry modal layer in
    // ui.ts was already hardened against accidental backdrop dismissal
    // (see `isDataEntryModal` branch). Align this prompt with that
    // contract: when the input is dirty (non-empty after trim), treat
    // backdrop as a no-op so the typed value is preserved. When the
    // input is empty there's no work to lose, so a backdrop tap still
    // dismisses — keeps the "click outside a trivial confirm to bail"
    // gesture for the empty-state case.
    const handleBackdropClick = (e: MouseEvent) => {
      const modal = document.getElementById('async-prompt-modal');
      if (e.target !== modal) return;
      const hasDirtyInput = (inputEl?.value.trim().length ?? 0) > 0;
      if (hasDirtyInput) return;
      handleCancel();
    };

    let deactivateTrap: (() => void) | null = null;

    const cleanup = () => {
      deactivateTrap?.();
      closeModal('async-prompt-modal');
      cancelBtn?.removeEventListener('click', handleCancel);
      okBtn?.removeEventListener('click', handleConfirm);
      inputEl?.removeEventListener('keydown', handleKeydown);
      inputEl?.removeEventListener('input', handleInput);
      document.removeEventListener('keydown', handleKeydown);
      const modal = document.getElementById('async-prompt-modal');
      modal?.removeEventListener('click', handleBackdropClick);
      restoreFocus();
    };

    cancelBtn?.addEventListener('click', handleCancel);
    okBtn?.addEventListener('click', handleConfirm);
    inputEl?.addEventListener('keydown', handleKeydown);
    inputEl?.addEventListener('input', handleInput);
    document.addEventListener('keydown', handleKeydown);

    const promptModalEl = document.getElementById('async-prompt-modal');
    if (promptModalEl) (promptModalEl as ModalElement)._hasBackdropListener = true;
    promptModalEl?.addEventListener('click', handleBackdropClick);

    // Phase 6 Slice 1e (L14): fail-safe wrapper.
    if (!openModalOrReject('async-prompt-modal', cleanup, reject, 'asyncPrompt')) {
      return;
    }

    // UI/UX Review Expanded: activate focus trap
    const promptContent = promptModalEl?.querySelector<HTMLElement>('.modal-content');
    if (promptContent) deactivateTrap = activateFocusTrap(promptContent);

    // CR-Apr24-I finding 138: guard the deferred focus — bail if the
    // prompt modal was dismissed before the rAF fires.
    requestAnimationFrame(() => {
      const modal = document.getElementById('async-prompt-modal');
      if (!modal?.classList.contains('active')) return;
      inputEl?.focus();
      inputEl?.select();
    });
  }));
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
