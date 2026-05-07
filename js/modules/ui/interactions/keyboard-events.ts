/**
 * Keyboard Events Module
 *
 * Global keyboard shortcuts and validation cleanup handlers.
 *
 * @module keyboard-events
 */
'use strict';

import * as signals from '../../core/signals.js';
import { form, cleanupModalState } from '../../core/state-actions.js';
import { closeModal } from '../core/ui.js';
// Design-Review-Apr21 P3 (batch 6 follow-up): `clearImportData` import
// removed — Escape dismissal of the import-options modal now preserves
// `_importData` so accidental Escapes don't force a re-parse of the
// selected backup file.
import { getAllCats } from '../../core/categories.js';
import { CONFIG } from '../../core/config.js';
import DOM from '../../core/dom-cache.js';
// Phase 5g-1 (Inline-Behavior-Review rev 12, L52): migrated from the
// deleted standalone `clearFieldError(fieldName)` helper to the element-
// based `validator.clearFieldError(element)` — one canonical API.
import { validator } from '../../core/validator.js';
import { toggleShortcutsOverlay, isShortcutsOverlayOpen, hideShortcutsOverlay } from '../../components/keyboard-shortcuts-overlay.js';

// ==========================================
// TYPE DEFINITIONS
// ==========================================

interface KeyboardCallbacks {
  // Accept sync or async callers. `cancelEditing` and `openSettingsModal`
  // are commonly thin async wrappers around dynamic `import()` calls —
  // typing them as strictly sync forces callers to wrap in a void IIFE.
  // Fire-and-forget: the keyboard layer never awaits these.
  switchMainTab?: (tabName: string) => void;
  switchTab?: (type: 'expense' | 'income') => void;
  cancelEditing?: () => void | Promise<void>;
  openSettingsModal?: () => void | Promise<void>;
  renderCategories?: () => void | Promise<void>;
}

// ==========================================
// MODULE STATE
// ==========================================

// Configurable callbacks. Async slots (cancelEditing / openSettingsModal /
// renderCategories) are widened to `() => void | Promise<void>` so dynamic-
// import wrappers in app-init-di.ts can be stored without no-misused-
// promises errors at the assignment site. Call sites use `void …()` to
// explicitly discard the returned Promise.
let switchMainTabFn: ((tabName: string) => void) | null = null;
let switchTabFn: ((type: 'expense' | 'income') => void) | null = null;
let cancelEditingFn: (() => void | Promise<void>) | null = null;
let openSettingsModalFn: (() => void | Promise<void>) | null = null;
let renderCategoriesFn: (() => void | Promise<void>) | null = null;

// Store previous keyboard handler for cleanup
let _keydownHandler: ((e: KeyboardEvent) => void) | null = null;
let _amountInput: HTMLElement | null = null;
let _dateInput: HTMLElement | null = null;
let _amountInputHandler: (() => void) | null = null;
let _dateInputHandler: (() => void) | null = null;

function cleanupKeyboardListeners(): void {
  if (_keydownHandler) {
    document.removeEventListener('keydown', _keydownHandler);
    _keydownHandler = null;
  }

  if (_amountInput && _amountInputHandler) {
    _amountInput.removeEventListener('input', _amountInputHandler);
  }
  if (_dateInput && _dateInputHandler) {
    _dateInput.removeEventListener('change', _dateInputHandler);
  }

  _amountInput = null;
  _dateInput = null;
  _amountInputHandler = null;
  _dateInputHandler = null;
}

// ==========================================
// INITIALIZATION
// ==========================================

/**
 * Initialize keyboard event handlers.
 * Returns a cleanup function that removes the global keydown listener.
 */
export function initKeyboardEvents(callbacks: KeyboardCallbacks): () => void {
  if (callbacks.switchMainTab) switchMainTabFn = callbacks.switchMainTab;
  if (callbacks.switchTab) switchTabFn = callbacks.switchTab;
  if (callbacks.cancelEditing) cancelEditingFn = callbacks.cancelEditing;
  if (callbacks.openSettingsModal) openSettingsModalFn = callbacks.openSettingsModal;
  if (callbacks.renderCategories) renderCategoriesFn = callbacks.renderCategories;

  cleanupKeyboardListeners();
  setupKeyboardShortcuts();
  setupClearValidationOnInput();

  return cleanupKeyboardListeners;
}

// ==========================================
// KEYBOARD SHORTCUTS
// ==========================================

/**
 * Set up global keyboard shortcuts
 */
function setupKeyboardShortcuts(): void {
  // Remove previous handler to prevent accumulation on re-init
  if (_keydownHandler) {
    document.removeEventListener('keydown', _keydownHandler);
  }

  _keydownHandler = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement;
    const inFormControl = target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA';
    // Design-Review-Apr21 P2: the early return used to bail on *any* key
    // when focus was in a form control, which correctly suppressed the
    // single-letter app shortcuts (D/B/N/I/…) below but also silenced
    // Escape — so modals with form inputs (savings goals, add-savings,
    // debt edit, category create, etc.) could not be dismissed with
    // Escape while the user was typing, exactly the moment users reach
    // for it. Permit Escape to fall through to the modal-close branch;
    // everything else still defers to the form field.
    if (inFormControl && e.key !== 'Escape') return;

    // Block all shortcuts when PIN overlay is active
    if (DOM.query('.pin-overlay.active')) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    // Handle shortcuts overlay escape
    if (e.key === 'Escape' && isShortcutsOverlayOpen()) {
      hideShortcutsOverlay();
      return;
    }

    // Handle modal escape
    if (DOM.query('.modal-overlay.active')) {
      if (e.key === 'Escape') {
        const activeModals = Array.from(DOM.queryAll('.modal-overlay.active'));
        const active = activeModals[activeModals.length - 1] as HTMLElement | undefined;
        if (active) {
          if (active.id === 'settings-modal') {
            DOM.get('cancel-settings')?.click();
          } else if (active.id === 'sync-conflict-modal') {
            // Design-Review-Apr21 P2 (batch 6 follow-up): conflict-
            // resolution dialogs must not treat Escape as a
            // decision. Previously pressing Esc programmatically
            // clicked `#sync-keep-local`, silently committing the
            // local side of a data conflict from a reflexive key
            // press. Swallow Escape here so the only way to
            // resolve the dialog is an explicit "Keep Local" /
            // "Use Cloud" click. The backdrop-click path in
            // ui.ts is symmetrically hardened.
            return;
          } else {
            closeModal(active.id);
          }
          cleanupModalState(active.id);
          // Design-Review-Apr21 P3 (batch 6 follow-up): removed the
          // `clearImportData()` call that ran on Escape dismissal of
          // the import-options chooser. Accidental Escape/taps were
          // discarding the parsed backup payload and forcing users
          // to reopen the file picker and re-parse from scratch —
          // especially punishing on touch devices and large backup
          // files. We now preserve `_importData` across accidental
          // dismissals; the explicit Cancel button path in
          // import-export-events.ts still clears, and
          // `openImportFileChooser` short-circuits back to the
          // chooser modal when a parsed payload is already
          // preserved. The symmetric ui.ts backdrop path is
          // updated the same way.
        }
      }
      return;
    }

    // Phase 5g-2 (Inline-Behavior-Review rev 12, L32): handle the
    // deliberate Ctrl/Cmd shortcuts FIRST, then a single hoisted
    // modifier-key guard, then the single-letter switch. Previously the
    // single-letter switch ran first and fired for Cmd+D, Cmd+B, Cmd+N,
    // Alt+I, etc. — stealing browser/OS shortcuts (Cmd+D = bookmark,
    // Cmd+B = browser bookmarks bar, Cmd+N = new window) and forcing a
    // per-case `!e.ctrlKey && !e.metaKey` check that only `case 'e'`
    // remembered to apply. The hoisted guard makes the rule uniform: any
    // single-letter app hotkey defers to the OS/browser when a modifier
    // is held. Shift is intentionally NOT in the guard because `?` (the
    // help/settings shortcut) requires Shift on US keyboards.
    if (e.ctrlKey || e.metaKey) {
      if (e.key === 'e') {
        e.preventDefault();
        DOM.get('export-json-btn')?.click();
      }
      if (e.key === 'f') {
        e.preventDefault();
        switchMainTabFn?.('transactions');
        // CR-Apr24-I finding 123: guard deferred focus — bail if the user
        // navigated away from the transactions tab before the timer fires.
        setTimeout(() => {
          if (signals.activeMainTab.value !== 'transactions') return;
          const searchEl = DOM.get('search-text');
          searchEl?.focus();
        }, CONFIG.TIMING.FOCUS_DELAY);
      }
    }

    // Single-letter shortcut guard — bail if any non-Shift modifier is
    // held so we don't shadow OS/browser shortcuts.
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    // Main keyboard shortcuts (no modifier — Shift allowed for '?')
    switch (e.key === '?' ? '?' : e.key.toLowerCase()) {
      case 'd': switchMainTabFn?.('dashboard'); break;
      case 'n':
        switchMainTabFn?.('transactions');
        // CR-Apr24-I finding 123: guard deferred focus — bail if the user
        // navigated away from the transactions tab before the timer fires.
        setTimeout(() => {
          if (signals.activeMainTab.value !== 'transactions') return;
          const amountEl = DOM.get('amount');
          amountEl?.focus();
        }, CONFIG.TIMING.FOCUS_DELAY);
        break;
      case 'b': switchMainTabFn?.('budget'); break;
      case 'e': switchTabFn?.('expense'); break;
      case 'i': switchTabFn?.('income'); break;
      case '1': case '2': case '3': case '4': case '5': case '6': case '7': case '8': {
        const currentType = signals.currentType.value;
        const cats = getAllCats(currentType);
        const idx = parseInt(e.key) - 1;
        if (cats[idx]) {
          form.setSelectedCategory(cats[idx].id);
          // `void` discards: slots are `() => void | Promise<void>` so
          // async dynamic-import wrappers can be stored. Fire-and-forget
          // — rejections surface via the supplier's own trackError.
          void renderCategoriesFn?.();
        }
        break;
      }
      case 'escape': void cancelEditingFn?.(); break;
      case ',': void openSettingsModalFn?.(); break;
      case '?': toggleShortcutsOverlay(); break;
    }
  };

  document.addEventListener('keydown', _keydownHandler);
}

// ==========================================
// VALIDATION CLEANUP
// ==========================================

/**
 * Set up validation error clearing on input.
 * Delegates to the shared clearFieldError utility from validator.ts.
 */
function setupClearValidationOnInput(): void {
  _amountInput = DOM.get('amount');
  _dateInput = DOM.get('date');
  _amountInputHandler = () => validator.clearFieldError(_amountInput);
  _dateInputHandler = () => validator.clearFieldError(_dateInput);

  _amountInput?.addEventListener('input', _amountInputHandler);
  _dateInput?.addEventListener('change', _dateInputHandler);
}
