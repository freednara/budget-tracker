/**
 * Keyboard Events Module
 *
 * Global keyboard shortcuts and validation cleanup handlers.
 *
 * @module keyboard-events
 */
'use strict';

import * as signals from '../../core/signals.js';
import { modal, form } from '../../core/state-actions.js';
import { closeModal } from '../core/ui.js';
import { clearImportData } from '../../core/feature-event-interface.js';
import { getAllCats } from '../../core/categories.js';
import { CONFIG } from '../../core/config.js';
import DOM from '../../core/dom-cache.js';
import { clearFieldError } from '../../core/validator.js';
import type { FlattenedCategory } from '../../../types/index.js';

// ==========================================
// TYPE DEFINITIONS
// ==========================================

interface KeyboardCallbacks {
  switchMainTab?: (tabName: string) => void;
  switchTab?: (type: 'expense' | 'income') => void;
  cancelEditing?: () => void;
  openSettingsModal?: () => void;
  renderCategories?: () => void;
}

// ==========================================
// MODULE STATE
// ==========================================

// Configurable callbacks
let switchMainTabFn: ((tabName: string) => void) | null = null;
let switchTabFn: ((type: 'expense' | 'income') => void) | null = null;
let cancelEditingFn: (() => void) | null = null;
let openSettingsModalFn: (() => void) | null = null;
let renderCategoriesFn: (() => void) | null = null;

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
    if (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA') return;

    // Block all shortcuts when PIN overlay is active
    if (document.querySelector('.pin-overlay.active')) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    // Handle modal escape
    if (document.querySelector('.modal-overlay.active')) {
      if (e.key === 'Escape') {
        const activeModals = Array.from(document.querySelectorAll('.modal-overlay.active'));
        const active = activeModals[activeModals.length - 1] as HTMLElement | undefined;
        if (active) {
          if (active.id === 'settings-modal') {
            DOM.get('cancel-settings')?.click();
          } else {
            closeModal(active.id);
          }
          if (active.id === 'split-modal') modal.clearSplitTxId();
          if (active.id === 'add-savings-modal') modal.clearAddSavingsGoalId();
          if (active.id === 'delete-modal') modal.clearDeleteTargetId();
          if (active.id === 'edit-recurring-modal') modal.clearPendingEditTx();
          if (active.id === 'import-options-modal') clearImportData();
        }
      }
      return;
    }

    // Main keyboard shortcuts
    switch (e.key === '?' ? '?' : e.key.toLowerCase()) {
      case 'd': switchMainTabFn?.('dashboard'); break;
      case 'n':
        switchMainTabFn?.('transactions');
        setTimeout(() => {
          const amountEl = DOM.get('amount') as HTMLInputElement | null;
          amountEl?.focus();
        }, CONFIG.TIMING.FOCUS_DELAY);
        break;
      case 'b': switchMainTabFn?.('budget'); break;
      case 'e': if (!e.ctrlKey && !e.metaKey) switchTabFn?.('expense'); break;
      case 'i': switchTabFn?.('income'); break;
      case '1': case '2': case '3': case '4': case '5': case '6': case '7': case '8': {
        const currentType = signals.currentType.value;
        const cats = getAllCats(currentType) as FlattenedCategory[];
        const idx = parseInt(e.key) - 1;
        if (cats[idx]) {
          form.setSelectedCategory(cats[idx].id);
          renderCategoriesFn?.();
        }
        break;
      }
      case 'escape': cancelEditingFn?.(); break;
      case '?': openSettingsModalFn?.(); break;
    }

    // Ctrl/Cmd shortcuts
    if (e.ctrlKey || e.metaKey) {
      if (e.key === 'e') {
        e.preventDefault();
        DOM.get('export-json-btn')?.click();
      }
      if (e.key === 'f') {
        e.preventDefault();
        switchMainTabFn?.('transactions');
        setTimeout(() => {
          const searchEl = DOM.get('search-text') as HTMLInputElement | null;
          searchEl?.focus();
        }, CONFIG.TIMING.FOCUS_DELAY);
      }
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
  _amountInputHandler = () => clearFieldError('amount');
  _dateInputHandler = () => clearFieldError('date');

  _amountInput?.addEventListener('input', _amountInputHandler);
  _dateInput?.addEventListener('change', _dateInputHandler);
}
