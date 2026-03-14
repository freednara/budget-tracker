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
import { clearImportData } from '../../features/import-export/import-export-events.js';
import { getAllCats } from '../../core/categories.js';
import { CONFIG } from '../../core/config.js';
import DOM from '../../core/dom-cache.js';
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

// ==========================================
// INITIALIZATION
// ==========================================

/**
 * Initialize keyboard event handlers
 */
export function initKeyboardEvents(callbacks: KeyboardCallbacks): void {
  if (callbacks.switchMainTab) switchMainTabFn = callbacks.switchMainTab;
  if (callbacks.switchTab) switchTabFn = callbacks.switchTab;
  if (callbacks.cancelEditing) cancelEditingFn = callbacks.cancelEditing;
  if (callbacks.openSettingsModal) openSettingsModalFn = callbacks.openSettingsModal;
  if (callbacks.renderCategories) renderCategoriesFn = callbacks.renderCategories;

  setupKeyboardShortcuts();
  setupClearValidationOnInput();
}

// ==========================================
// KEYBOARD SHORTCUTS
// ==========================================

/**
 * Set up global keyboard shortcuts
 */
function setupKeyboardShortcuts(): void {
  document.addEventListener('keydown', (e: KeyboardEvent) => {
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA') return;

    // Block all shortcuts when PIN overlay is active
    if (document.querySelector('.pin-overlay.active')) {
      if (e.key === 'Escape') e.preventDefault();
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
  });
}

// ==========================================
// VALIDATION CLEANUP
// ==========================================

/**
 * Set up validation error clearing on input
 */
function setupClearValidationOnInput(): void {
  DOM.get('amount')?.addEventListener('input', () => {
    const amtEl = DOM.get('amount') as HTMLInputElement | null;
    const amtErr = DOM.get('amount-error');
    if (amtEl) {
      amtEl.style.borderColor = '';
      amtEl.removeAttribute('aria-invalid');
    }
    if (amtErr) amtErr.classList.add('hidden');
  });

  DOM.get('date')?.addEventListener('change', () => {
    const dateEl = DOM.get('date') as HTMLInputElement | null;
    const dateErr = DOM.get('date-error');
    if (dateEl) {
      dateEl.style.borderColor = '';
      dateEl.removeAttribute('aria-invalid');
    }
    if (dateErr) dateErr.classList.add('hidden');
  });
}
