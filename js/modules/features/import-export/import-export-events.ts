/**
 * Import/Export Events Module
 *
 * Handles backup export (JSON/CSV) and data import flows.
 *
 * @module import-export-events
 */
'use strict';

import { SK } from '../../core/state.js';
import * as signals from '../../core/signals.js';
import { hydrateFromImport } from '../../core/state-hydration.js';
import { showToast, showProgress, hideProgress, openModal, closeModal } from '../../ui/core/ui.js';
// Confirmation function injected via DI (avoids features → UI layer violation)
let confirmDataOperation: (message: string, details?: string) => Promise<boolean> = async () => true;

export function setImportConfirmFn(fn: (message: string, details?: string) => Promise<boolean>): void {
  confirmDataOperation = fn;
}
import {
  buildExportData,
  buildCsvContent,
  sanitizeImportedTransactions,
  buildImportState,
  tryAtomicWrite,
  MAX_IMPORT_TRANSACTIONS
} from './import-export.js';
import { findContentDuplicates, formatDuplicateSummary, excludeDuplicates } from './duplicate-detection.js';
import { setTheme } from '../personalization/theme.js';
import { markBackupCompleted } from '../../orchestration/backup-reminder.js';
import { awardAchievement } from '../gamification/achievements.js';
import { emit, on, Events } from '../../core/event-bus.js';
import { FeatureEvents } from '../../core/feature-event-interface.js';
import { getTodayStr, esc, downloadBlob } from '../../core/utils.js';
import { CONFIG } from '../../core/config.js';
import DOM from '../../core/dom-cache.js';
import type { Transaction, Theme } from '../../../types/index.js';

// ==========================================
// TYPE DEFINITIONS
// ==========================================

interface ImportExportCallbacks {
  fmtCur?: (value: number) => string;
}

interface ImportData {
  transactions?: unknown[];
  theme?: string;
  [key: string]: unknown;
}

// Module-level variable for temporary import data storage
let _importData: ImportData | null = null;

// Enhanced import size limits based on storage capacity
const getMaxImportSize = (): number => {
  return 25 * 1024 * 1024; // Default to 25MB
};

const MAX_IMPORT_SIZE = getMaxImportSize();

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

function ensureGlobalImportInput(): HTMLInputElement | null {
  const input = DOM.get('import-file') as HTMLInputElement | null;
  if (!input) return null;

  // Keep the hidden file input out of the transactions view so tab/layout churn
  // cannot interfere with the chooser or detach the active input mid-restore.
  if (input.parentElement !== document.body) {
    input.value = '';
    input.style.display = 'none';
    document.body.appendChild(input);
  }

  return input;
}

/**
 * Clear pending import data (called when import modal is dismissed)
 */
export function clearImportData(): void {
  _importData = null;
}

/**
 * Update signals from imported state object
 */
function updateSignalsFromImport(newS: Record<string, unknown>): void {
  hydrateFromImport(newS);
  updateCurrencyDisplay();
}

/**
 * Update currency display in UI
 */
function updateCurrencyDisplay(): void {
  const currencyDisplay = DOM.get('currency-display');
  if (currencyDisplay && signals.currency.value) {
    currencyDisplay.textContent = signals.currency.value.symbol;
  }
}

// ==========================================
// MODULE STATE
// ==========================================

// Configurable callbacks
let fmtCurFn: (v: number) => string = (v) => '$' + v.toFixed(2);
let importHandlersBound = false;

// ==========================================
// INITIALIZATION
// ==========================================

/**
 * Initialize import/export event handlers
 */
export function initImportExportEvents(callbacks: ImportExportCallbacks): void {
  if (callbacks.fmtCur) fmtCurFn = callbacks.fmtCur;

  setupExportHandlers();
  setupImportHandlers();

  // Register Feature Event Listener
  on(FeatureEvents.CLEAR_IMPORT_DATA, () => {
    clearImportData();
  });
}

// ==========================================
// EXPORT HANDLERS
// ==========================================

/**
 * Set up export button handlers
 */
function setupExportHandlers(): void {
  // Export JSON
  DOM.get('export-json-btn')?.addEventListener('click', () => {
    const data = buildExportData();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    downloadBlob(blob, `budget-tracker-backup-${getTodayStr()}.json`);
    markBackupCompleted();
    awardAchievement('data_pro');
  });

  // Backup reminder button
  DOM.get('backup-now-btn')?.addEventListener('click', () => {
    (DOM.get('export-json-btn') as HTMLButtonElement | null)?.click();
  });

  // Export CSV
  DOM.get('export-csv-btn')?.addEventListener('click', () => {
    const txs = [...signals.transactions.value] as Transaction[];
    const csvContent = buildCsvContent(txs);
    const blob = new Blob([csvContent], { type: 'text/csv' });
    downloadBlob(blob, `budget-tracker-${getTodayStr()}.csv`);
    markBackupCompleted();
    awardAchievement('data_pro');
  });
}

// ==========================================
// IMPORT HANDLERS
// ==========================================

/**
 * Set up import button and modal handlers
 */
function setupImportHandlers(): void {
  if (importHandlersBound) return;
  importHandlersBound = true;
  ensureGlobalImportInput();

  document.addEventListener('click', (event: Event) => {
    const target = event.target as HTMLElement | null;
    const button = target?.closest<HTMLElement>('#import-data-btn, #import-overwrite, #import-merge, #cancel-import');
    if (!button) return;

    switch (button.id) {
      case 'import-data-btn':
        openImportFileChooser();
        break;
      case 'import-overwrite':
        void handleImportOverwrite();
        break;
      case 'import-merge':
        void handleImportMerge();
        break;
      case 'cancel-import':
        closeModal('import-options-modal');
        _importData = null;
        break;
    }
  });

  // Delegate file input changes at the document level so the restore flow stays
  // resilient even if the hidden input is replaced during reload or remount work.
  document.addEventListener('change', (event: Event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || target.id !== 'import-file') return;
    void handleImportFile(event);
  });
}

function openImportFileChooser(): void {
  const input = ensureGlobalImportInput();
  if (!input) return;

  // Reset the chooser so selecting the same backup twice still emits `change`.
  input.value = '';
  input.click();
}

/**
 * Handle file selection for import
 */
async function handleImportFile(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;

  try {
    if (file.size > MAX_IMPORT_SIZE) {
      const fileSizeMB = (file.size / 1024 / 1024).toFixed(1);
      const maxSizeMB = (MAX_IMPORT_SIZE / 1024 / 1024).toFixed(0);
      showToast(`File too large (${fileSizeMB}MB). Maximum is ${maxSizeMB}MB.`, 'error');
      _importData = null;
      return;
    }

    const importData = JSON.parse(await file.text()) as ImportData;
    _importData = importData;

    if (!importData || !Array.isArray(importData.transactions)) {
      showToast('Invalid backup file: missing transactions array', 'error');
      _importData = null;
      return;
    }

    const txCount = importData.transactions.length;
    if (txCount > MAX_IMPORT_TRANSACTIONS) {
      const message = `This file contains ${txCount.toLocaleString()} transactions.`;
      const details = `Importing more than ${MAX_IMPORT_TRANSACTIONS.toLocaleString()} transactions may impact performance.`;
      const proceed = await confirmDataOperation(message, details);

      if (!proceed) {
        _importData = null;
        return;
      }
    }

    await nextFrame();
    openModal('import-options-modal');
  } catch (err) {
    if (import.meta.env.DEV) console.error('Import JSON parse error:', err);
    showToast('Invalid backup file format', 'error');
    _importData = null;
  } finally {
    input.value = '';
  }
}

/**
 * Handle import overwrite
 */
async function handleImportOverwrite(): Promise<void> {
  if (!_importData) return;

  try {
    const d = _importData;
    showProgress('Importing Data', 'Processing...');
    await new Promise(r => setTimeout(r, CONFIG.TIMING.UI_DELAY));

    const txList = sanitizeImportedTransactions(d.transactions || []);
    const { newS, writes, theme } = buildImportState(d, 'overwrite', txList);

    if (!(await tryAtomicWrite(writes))) {
      hideProgress();
      showToast('Import failed: storage error', 'error');
      return;
    }

    updateSignalsFromImport(newS);
    if (theme) setTheme(theme as Theme);
    _importData = null;
    hideProgress();
    closeModal('import-options-modal');
    showToast('Data replaced successfully', 'success');
    emit(Events.DATA_IMPORTED);
  } catch (err) {
    hideProgress();
    showToast('Import failed: ' + (err instanceof Error ? err.message : 'unknown error'), 'error');
  }
}

/**
 * Handle import merge
 */
async function handleImportMerge(): Promise<void> {
  if (!_importData) return;

  try {
    const d = _importData;
    showProgress('Merging Data', 'Processing...');
    await new Promise(r => setTimeout(r, CONFIG.TIMING.UI_DELAY));

    const existing = [...signals.transactions.value] as Transaction[];
    const existingIds = new Set(existing.map(t => t.__backendId));
    
    let incomingFiltered = (d.transactions || []).filter((t): t is Record<string, unknown> => {
      const tx = t as Record<string, unknown> | null;
      return tx != null && !existingIds.has(tx.__backendId as string);
    });

    const incomingAsTransactions = incomingFiltered as unknown as Transaction[];
    const duplicates = findContentDuplicates(incomingAsTransactions, existing);

    if (duplicates.exact.length > 0) {
      showToast(`Skipping ${duplicates.exact.length} exact duplicate(s)`, 'info');
      incomingFiltered = excludeDuplicates(incomingFiltered as unknown as Transaction[], duplicates.exact) as unknown as Record<string, unknown>[];
    }
    
    if (duplicates.similar.length > 0) {
      hideProgress();
      closeModal('import-options-modal');
      const message = `Found ${duplicates.similar.length} similar transactions that might be duplicates.`;
      const details = `Choose 'Continue' to import them anyway, or 'Cancel' to skip them.`;
      
      const proceed = await confirmDataOperation(message, details);

      if (!proceed) {
        showProgress('Merging Data', 'Skipping similar...');
        const filteredTransactions = excludeDuplicates(incomingFiltered as unknown as Transaction[], duplicates.similar);
        const newTx = sanitizeImportedTransactions(filteredTransactions as unknown as Record<string, unknown>[], existingIds);
        const mergedTx = [...existing, ...newTx];
        const { newS, writes, theme } = buildImportState(d, 'merge', mergedTx);
        
        if (!(await tryAtomicWrite(writes))) {
          hideProgress();
          showToast('Import failed: storage error', 'error');
          return;
        }
        
        updateSignalsFromImport(newS);
        if (theme) setTheme(theme as Theme);
        _importData = null;
        hideProgress();
        closeModal('import-options-modal');
        showToast(`skipped ${duplicates.similar.length} similar transaction${duplicates.similar.length === 1 ? '' : 's'} and imported ${newTx.length}`, 'info');
        emit(Events.DATA_IMPORTED);
        return;
      }
      
      showProgress('Merging Data', 'Importing all...');
    }

    const newTx = sanitizeImportedTransactions(incomingFiltered, existingIds);
    const mergedTx = [...existing, ...newTx];
    const { newS, writes, theme } = buildImportState(d, 'merge', mergedTx);
    
    if (!(await tryAtomicWrite(writes))) {
      hideProgress();
      showToast('Import failed: storage error', 'error');
      return;
    }
    updateSignalsFromImport(newS);
    if (theme) setTheme(theme as Theme);
    _importData = null;
    hideProgress();
    closeModal('import-options-modal');
    showToast('Data merged successfully', 'success');
    emit(Events.DATA_IMPORTED);
  } catch (err) {
    hideProgress();
    showToast('Import failed: ' + (err instanceof Error ? err.message : 'unknown error'), 'error');
  }
}
