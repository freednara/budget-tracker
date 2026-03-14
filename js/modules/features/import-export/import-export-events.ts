/**
 * Import/Export Events Module
 *
 * Handles backup export (JSON/CSV) and data import flows.
 *
 * @module import-export-events
 */
'use strict';

import { SK, lsSet, lsGet } from '../../core/state.js';
import * as signals from '../../core/signals.js';
import { showToast, showProgress, hideProgress, openModal, closeModal } from '../../ui/core/ui.js';
import {
  buildExportData,
  buildCsvContent,
  sanitizeImportedTransactions,
  buildImportState,
  tryAtomicWrite,
  findContentDuplicates,
  MAX_IMPORT_SIZE,
  MAX_IMPORT_TRANSACTIONS
} from './import-export.js';
import { setTheme } from '../personalization/theme.js';
import { hideBackupReminder } from '../../orchestration/backup-reminder.js';
import { awardAchievement } from '../gamification/achievements.js';
import { emit, Events } from '../../core/event-bus.js';
import { getTodayStr, esc, parseAmount, downloadBlob } from '../../core/utils.js';
import { getCatInfo } from '../../core/categories.js';
import { CONFIG } from '../../core/config.js';
import DOM from '../../core/dom-cache.js';
import type { Transaction, CurrencySettings, Theme } from '../../../types/index.js';

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

/**
 * Clear pending import data (called when import modal is dismissed)
 */
export function clearImportData(): void {
  _importData = null;
}

/**
 * Update signals from imported state object
 * Called after buildImportState returns the new state values
 */
function updateSignalsFromImport(newS: Record<string, unknown>): void {
  if (newS.savingsGoals !== undefined) {
    signals.savingsGoals.value = newS.savingsGoals as typeof signals.savingsGoals.value;
  }
  if (newS.savingsContribs !== undefined) {
    signals.savingsContribs.value = newS.savingsContribs as typeof signals.savingsContribs.value;
  }
  if (newS.currency !== undefined) {
    signals.currency.value = newS.currency as typeof signals.currency.value;
  }
  if (newS.customCats !== undefined) {
    signals.customCats.value = newS.customCats as typeof signals.customCats.value;
  }
  if (newS.monthlyAlloc !== undefined) {
    signals.monthlyAlloc.value = newS.monthlyAlloc as typeof signals.monthlyAlloc.value;
  }
  if (newS.debts !== undefined) {
    signals.debts.value = newS.debts as typeof signals.debts.value;
  }
  if (newS.rolloverSettings !== undefined) {
    signals.rolloverSettings.value = newS.rolloverSettings as typeof signals.rolloverSettings.value;
  }
  if (newS.alerts !== undefined) {
    signals.alerts.value = newS.alerts as typeof signals.alerts.value;
  }
  if (newS.achievements !== undefined) {
    signals.achievements.value = newS.achievements as typeof signals.achievements.value;
  }
  if (newS.streak !== undefined) {
    signals.streak.value = newS.streak as typeof signals.streak.value;
  }
  if (newS.insightPers !== undefined) {
    signals.insightPers.value = newS.insightPers as typeof signals.insightPers.value;
  }
  if (newS.filterPresets !== undefined) {
    signals.filterPresets.value = newS.filterPresets as typeof signals.filterPresets.value;
  }
  if (newS.txTemplates !== undefined) {
    signals.txTemplates.value = newS.txTemplates as typeof signals.txTemplates.value;
  }
  if (newS.sections !== undefined) {
    signals.sections.value = newS.sections as typeof signals.sections.value;
  }
  // Load transactions from localStorage (already written by tryAtomicWrite)
  signals.transactions.value = lsGet(SK.TX, []) as Transaction[];
}

// ==========================================
// MODULE STATE
// ==========================================

// Configurable callbacks
let fmtCurFn: (v: number) => string = (v) => '$' + v.toFixed(2);

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
    lsSet(SK.LAST_BACKUP, Date.now());
    hideBackupReminder();
    awardAchievement('data_pro');
  });

  // Backup reminder button
  DOM.get('backup-now-btn')?.addEventListener('click', () => {
    (DOM.get('export-json-btn') as HTMLButtonElement | null)?.click();
  });

  // Export CSV
  DOM.get('export-csv-btn')?.addEventListener('click', () => {
    const txs = lsGet(SK.TX, []) as Transaction[];
    const csvContent = buildCsvContent(txs);
    const blob = new Blob([csvContent], { type: 'text/csv' });
    downloadBlob(blob, `budget-tracker-${getTodayStr()}.csv`);
    lsSet(SK.LAST_BACKUP, Date.now());
    hideBackupReminder();
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
  DOM.get('import-data-btn')?.addEventListener('click', () => {
    (DOM.get('import-file') as HTMLInputElement | null)?.click();
  });

  DOM.get('import-file')?.addEventListener('change', handleImportFile);
  DOM.get('import-overwrite')?.addEventListener('click', handleImportOverwrite);
  DOM.get('import-merge')?.addEventListener('click', handleImportMerge);
  DOM.get('cancel-import')?.addEventListener('click', () => {
    closeModal('import-options-modal');
    _importData = null;
  });
}

/**
 * Handle file selection for import
 */
function handleImportFile(e: Event): void {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;

  // File size validation
  if (file.size > MAX_IMPORT_SIZE) {
    showToast(`File too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Maximum is 5MB.`, 'error');
    input.value = '';
    return;
  }

  const reader = new FileReader();
  reader.onload = (evt) => {
    try {
      const result = evt.target?.result;
      if (typeof result !== 'string') return;

      const importData = JSON.parse(result) as ImportData;
      _importData = importData;

      if (!importData || !Array.isArray(importData.transactions)) {
        showToast('Invalid backup file: missing transactions array', 'error');
        _importData = null;
        return;
      }

      // Transaction count validation
      const txCount = importData.transactions.length;
      if (txCount > MAX_IMPORT_TRANSACTIONS) {
        const proceed = confirm(`This file contains ${txCount.toLocaleString()} transactions. Importing more than ${MAX_IMPORT_TRANSACTIONS.toLocaleString()} may slow down the app. Continue anyway?`);
        if (!proceed) {
          _importData = null;
          return;
        }
      }
      openModal('import-options-modal');
    } catch (err) {
      console.error('Import JSON parse error:', err);
      const errMsg = err instanceof SyntaxError
        ? `Invalid JSON: ${esc(err.message.slice(0, 50))}`
        : 'Invalid backup file format';
      showToast(errMsg, 'error');
      _importData = null;
    }
  };
  reader.readAsText(file);
  input.value = '';
}

/**
 * Handle import overwrite - replaces all existing data
 */
async function handleImportOverwrite(): Promise<void> {
  if (!_importData) return;

  try {
    const d = _importData;
    const txCount = (d.transactions || []).length;
    showProgress('Importing Data', `Processing ${txCount} transactions...`);
    await new Promise(r => setTimeout(r, CONFIG.TIMING.UI_DELAY));

    const txList = sanitizeImportedTransactions(d.transactions || []);
    const { newS, writes, theme } = buildImportState(d, 'overwrite', txList);

    if (!tryAtomicWrite(writes)) {
      hideProgress();
      showToast('Import failed: storage is full. No data changed.', 'error');
      return;
    }

    updateSignalsFromImport(newS);
    if (theme) setTheme(theme as Theme);
    // Update currency display after import
    const currencyDisplay = DOM.get('currency-display');
    if (currencyDisplay && signals.currency.value) {
      currencyDisplay.textContent = signals.currency.value.symbol;
    }
    _importData = null;
    hideProgress();
    closeModal('import-options-modal');
    showToast('Data replaced successfully', 'success');
    emit(Events.DATA_IMPORTED);
  } catch (err) {
    hideProgress();
    console.error('Import failed:', err);
    showToast('Import failed: backup data is malformed', 'error');
  }
}

/**
 * Handle import merge - adds new transactions to existing data
 */
async function handleImportMerge(): Promise<void> {
  if (!_importData) return;

  try {
    const d = _importData;
    const txCount = (d.transactions || []).length;
    showProgress('Merging Data', `Processing ${txCount} transactions...`);
    await new Promise(r => setTimeout(r, CONFIG.TIMING.UI_DELAY));

    const existing = lsGet(SK.TX, []) as Transaction[];
    const existingIds = new Set(existing.map(t => t.__backendId));
    // Null-guard t before dereferencing __backendId
    const incomingFiltered = (d.transactions || []).filter((t): t is Record<string, unknown> => {
      const tx = t as Record<string, unknown> | null;
      return tx != null && !existingIds.has(tx.__backendId as string);
    });

    // Check for content duplicates - cast to Transaction[] for the comparison
    const incomingAsTransactions = incomingFiltered as unknown as Transaction[];
    const contentDupes = findContentDuplicates(incomingAsTransactions, existing);

    if (contentDupes.length > 0) {
      hideProgress(); // Hide before showing confirm dialog
      const sampleDupes = contentDupes.slice(0, 3).map(t => {
        const cat = getCatInfo(t.type, t.category);
        return `• ${t.date}: ${cat?.name || t.category} - ${fmtCurFn(parseFloat(String(t.amount)))}${t.description ? ` (${t.description.slice(0, 20)}...)` : ''}`;
      }).join('\n');
      const moreText = contentDupes.length > 3 ? `\n...and ${contentDupes.length - 3} more` : '';
      const proceed = confirm(`Found ${contentDupes.length} potential duplicate(s):\n\n${sampleDupes}${moreText}\n\nClick OK to import anyway, or Cancel to skip duplicates.`);

      if (!proceed) {
        showProgress('Merging Data', 'Importing (skipping duplicates)...');
        await new Promise(r => setTimeout(r, CONFIG.TIMING.UI_DELAY));
        // Filter out content duplicates
        const dupeKeys = new Set(contentDupes.map(t =>
          `${t.date}|${t.type}|${t.category}|${parseFloat(String(t.amount)).toFixed(2)}|${(t.description || '').toLowerCase().trim()}`
        ));
        const filtered = incomingFiltered.filter(t => {
          const tx = t as Record<string, unknown>;
          const key = `${tx.date}|${tx.type}|${tx.category}|${parseFloat(String(tx.amount)).toFixed(2)}|${(String(tx.description || '')).toLowerCase().trim()}`;
          return !dupeKeys.has(key);
        });
        const newTx = sanitizeImportedTransactions(filtered, existingIds);
        const mergedTx = [...existing, ...newTx];
        const { newS, writes, theme } = buildImportState(d, 'merge', mergedTx);
        if (!tryAtomicWrite(writes)) {
          hideProgress();
          showToast('Import failed: storage is full', 'error');
          return;
        }
        updateSignalsFromImport(newS);
        if (theme) setTheme(theme as Theme);
        // Update currency display after import
        const currencyDisplay = DOM.get('currency-display');
        if (currencyDisplay && signals.currency.value) {
          currencyDisplay.textContent = signals.currency.value.symbol;
        }
        _importData = null;
        hideProgress();
        closeModal('import-options-modal');
        showToast(`Imported ${newTx.length} transactions (${contentDupes.length} duplicates skipped)`, 'success');
        emit(Events.DATA_IMPORTED);
        return;
      }
      showProgress('Merging Data', 'Importing (including duplicates)...');
      await new Promise(r => setTimeout(r, CONFIG.TIMING.UI_DELAY));
    }

    const newTx = sanitizeImportedTransactions(incomingFiltered, existingIds);
    const mergedTx = [...existing, ...newTx];
    const { newS, writes, theme } = buildImportState(d, 'merge', mergedTx);
    if (!tryAtomicWrite(writes)) {
      hideProgress();
      showToast('Import failed: storage is full. No data changed.', 'error');
      return;
    }
    updateSignalsFromImport(newS);
    if (theme) setTheme(theme as Theme);
    // Update currency display after import
    const currencyDisplay = DOM.get('currency-display');
    if (currencyDisplay && signals.currency.value) {
      currencyDisplay.textContent = signals.currency.value.symbol;
    }
    _importData = null;
    hideProgress();
    closeModal('import-options-modal');
    showToast('Data merged successfully', 'success');
    emit(Events.DATA_IMPORTED);
  } catch (err) {
    hideProgress();
    console.error('Import failed:', err);
    showToast('Import failed: backup data is malformed', 'error');
  }
}
