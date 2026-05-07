/**
 * Import/Export Events Module
 *
 * Handles backup export (JSON/CSV) and data import flows.
 *
 * @module import-export-events
 */
'use strict';

import * as signals from '../../core/signals.js';
import { safeStorage } from '../../core/safe-storage.js';
import { hydrateFromImport, type ImportHydrationResult } from '../../core/state-hydration.js';
// Confirmation function injected via DI (avoids features → UI layer violation)
let confirmDataOperation: (message: string, details?: string) => Promise<boolean> = async () => true;

export function setImportConfirmFn(fn: (message: string, details?: string) => Promise<boolean>): void {
  confirmDataOperation = fn;
}
import {
  buildExportData,
  buildCsvContent,
  sanitizeImportedTransactions,
  reportImportValidationRejections,
  buildImportState,
  tryAtomicWrite,
  MAX_IMPORT_TRANSACTIONS
} from './import-export.js';
import { triggerPdfExport } from './pdf-export.js';
import { filterTransactionsSync } from '../../orchestration/worker-manager.js';
import { countActiveFilters, filterStateToWorkerFilters } from '../../core/filter-utils.js';
// WorkerTransactionFilters type now handled via filterStateToWorkerFilters()
import { findContentDuplicates, findInternalDuplicates, deduplicateExact, excludeDuplicates } from './duplicate-detection.js';
import { setTheme } from '../personalization/theme.js';
import { markBackupCompleted } from '../../orchestration/backup-reminder.js';
import { awardAchievement } from '../gamification/achievements.js';
import { emit, on, Events } from '../../core/event-bus.js';
import { FeatureEvents } from '../../core/feature-event-interface.js';
import { getTodayStr } from '../../core/utils-pure.js';
import { formatNumber, formatDateLong } from '../../core/locale-service.js';
import { downloadBlob } from '../../core/utils-dom.js';
import { CONFIG } from '../../core/config.js';
import DOM from '../../core/dom-cache.js';
import { showToast } from '../../ui/core/ui.js';
import { dataSdk } from '../../data/data-manager.js';
import type { Transaction, Theme } from '../../../types/index.js';

// ==========================================
// TYPE DEFINITIONS
// ==========================================

interface ImportExportCallbacks {
  // Extensible for future callbacks
}

interface ImportData {
  transactions?: unknown[];
  theme?: string;
  [key: string]: unknown;
}

interface StorageSnapshotEntry {
  key: string;
  raw: string | null;
}

// Module-level variable for temporary import data storage
let _importData: ImportData | null = null;
// CR-Apr24-I finding 118: track the filename and tx count so the import-
// options context block can be repopulated on reopen (locale-sensitive
// fields like the formatted date may have gone stale).
let _importFileName = '';
let _importTxCount = 0;

// ==========================================
// FILTERED EXPORT HELPERS
// ==========================================

/**
 * Return the transaction list that CSV/PDF should export.
 * When filters are active, returns only matching transactions (sorted).
 * When no filters are active, returns all transactions for the current month.
 */
function getExportableTransactions(): { txs: Transaction[]; isFiltered: boolean } {
  const allTxs = [...signals.transactions.value] as Transaction[];
  const f = signals.filters.value;
  const activeCount = countActiveFilters(f);

  // Build the same filter object the transaction renderer uses
  const workerFilters = filterStateToWorkerFilters(f, signals.currentMonth.value);

  // Use a large pageSize so we get everything in one pass
  const result = filterTransactionsSync(allTxs, workerFilters, {
    sortBy: (f.sortBy as 'date' | 'amount' | 'description' | 'category') || 'date',
    sortDir: 'desc',
    page: 0,
    pageSize: allTxs.length || 1
  });

  return { txs: result.items, isFiltered: activeCount > 0 };
}

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
  const input = DOM.get<HTMLInputElement>('import-file');
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
 * Update signals from imported state object.
 *
 * Fixes H18 (Inline-Behavior-Review rev 12): surfaces partial-hydration
 * failures to the user via a warning toast when non-transaction sections
 * fail to restore. Transactions themselves are handled earlier via
 * replaceAllTransactions(); this guards the signal-level hydration of
 * settings, theme, alloc, savings, etc.
 *
 * Rev 13 L74: returns the hydration result so callers can suppress their
 * own trailing success toast when sections failed to restore — otherwise a
 * warning ("skipped X, Y") is immediately followed by "Backup restored
 * successfully" / "All data replaced" / "Data merged successfully",
 * contradicting the partial-failure signal.
 */
function updateSignalsFromImport(
  newS: Record<string, unknown>,
  transactions: Transaction[]
): ImportHydrationResult {
  const result = hydrateFromImport(newS, transactions);

  if (result.failed.length > 0) {
    const failedNames = result.failed.map(f => f.propertyName).join(', ');
    emit(Events.SHOW_TOAST, {
      message: `Imported ${result.succeeded} of ${result.attempted} sections. Skipped: ${failedNames}.`,
      type: 'warning'
    });
  }

  return result;
}

// ==========================================
// MODULE STATE
// ==========================================

let importHandlersBound = false;
let importClearDataUnsubscribe: (() => void) | null = null;
let exportJsonButton: HTMLElement | null = null;
let exportJsonHandler: (() => void) | null = null;
let backupNowButton: HTMLElement | null = null;
let backupNowHandler: (() => void) | null = null;
let exportCsvButton: HTMLElement | null = null;
let exportCsvHandler: (() => void) | null = null;
let exportPdfButton: HTMLElement | null = null;
let exportPdfHandler: (() => void) | null = null;
let importClickHandler: ((event: Event) => void) | null = null;
let importChangeHandler: ((event: Event) => void) | null = null;
let utilitiesAbortController: AbortController | null = null;

function snapshotStorageKeys(keys: string[]): StorageSnapshotEntry[] {
  return keys.map((key) => ({
    key,
    raw: safeStorage.getItem(key)
  }));
}

function restoreStorageSnapshot(snapshot: StorageSnapshotEntry[]): void {
  snapshot.forEach(({ key, raw }) => {
    if (raw === null) {
      safeStorage.removeItem(key);
    } else {
      safeStorage.setItem(key, raw);
    }
  });
}

/**
 * Result of applyImportedState. `ok === false` means the atomic write or the
 * transaction replace failed and the caller should abort (an error toast has
 * already been emitted). `ok === true` carries the hydration result so
 * callers can gate their trailing success toast on `hydration.failed.length`
 * (Rev 13 L74 — partial-failure contract).
 */
type ApplyImportedStateResult =
  | { ok: false }
  | { ok: true; hydration: ImportHydrationResult };

async function applyImportedState(
  newS: Record<string, unknown>,
  writes: Array<{ key: string; value: unknown }>,
  transactions: Transaction[],
  theme: string | null
): Promise<ApplyImportedStateResult> {
  const snapshot = snapshotStorageKeys(writes.map(({ key }) => key));

  if (!(await tryAtomicWrite(writes))) {
    emit(Events.SHOW_TOAST, { message: 'Import couldn\u2019t complete \u2014 your storage may be full. Try clearing old backups first.', type: 'error' });
    return { ok: false };
  }

  const replaceResult = await dataSdk.replaceAllTransactions(transactions);
  if (!replaceResult.isOk) {
    restoreStorageSnapshot(snapshot);
    emit(Events.SHOW_TOAST, { message: 'Import couldn\u2019t save transactions \u2014 your storage may be full. Try clearing old data first.', type: 'error' });
    return { ok: false };
  }

  const hydration = updateSignalsFromImport(newS, transactions);
  if (theme) setTheme(theme as Theme);
  return { ok: true, hydration };
}

// ==========================================
// INITIALIZATION
// ==========================================

/**
 * Initialize import/export event handlers
 */
export function initImportExportEvents(_callbacks: ImportExportCallbacks): void {
  cleanupImportExportEvents();
  setupExportHandlers();
  setupImportHandlers();

  // Register Feature Event Listener
  importClearDataUnsubscribe = on(FeatureEvents.CLEAR_IMPORT_DATA, () => {
    clearImportData();
  });
}

export function cleanupImportExportEvents(): void {
  // Abort all utilities dropdown listeners in one call
  utilitiesAbortController?.abort();
  utilitiesAbortController = null;

  importClearDataUnsubscribe?.();
  importClearDataUnsubscribe = null;

  if (exportJsonButton && exportJsonHandler) {
    exportJsonButton.removeEventListener('click', exportJsonHandler);
  }
  if (backupNowButton && backupNowHandler) {
    backupNowButton.removeEventListener('click', backupNowHandler);
  }
  if (exportCsvButton && exportCsvHandler) {
    exportCsvButton.removeEventListener('click', exportCsvHandler);
  }
  if (exportPdfButton && exportPdfHandler) {
    exportPdfButton.removeEventListener('click', exportPdfHandler);
  }

  exportJsonButton = null;
  exportJsonHandler = null;
  backupNowButton = null;
  backupNowHandler = null;
  exportCsvButton = null;
  exportCsvHandler = null;
  exportPdfButton = null;
  exportPdfHandler = null;

  if (importClickHandler) {
    document.removeEventListener('click', importClickHandler);
    importClickHandler = null;
  }
  if (importChangeHandler) {
    document.removeEventListener('change', importChangeHandler);
    importChangeHandler = null;
  }

  importHandlersBound = false;
}

// ==========================================
// EXPORT HANDLERS
// ==========================================

/**
 * Minimal type alias for the File System Access API entry points we use.
 * Typed locally so we don't need to pull in `@types/wicg-file-system-access`
 * and don't fight the feature-detection typing in browsers that lack it.
 */
type FSAccessWindow = Window & {
  showSaveFilePicker?: (options?: {
    suggestedName?: string;
    types?: Array<{ description?: string; accept: Record<string, string[]> }>;
  }) => Promise<{
    createWritable: () => Promise<{
      write: (data: Blob | string) => Promise<void>;
      close: () => Promise<void>;
    }>;
  }>;
};

/**
 * JSON export trigger.
 *
 * Design-Review-Apr21 (new batch, Commit E of 7k): the prior
 * implementation called `markBackupCompleted()` the instant after
 * `downloadBlob()` returned. But `downloadBlob` is fire-and-forget
 * (`a.click()` + URL.revokeObjectURL) — it reports success regardless
 * of whether the browser blocked the save, the user cancelled the
 * native dialog, or the file ever actually hit disk. A user whose
 * download was blocked (e.g. Safari low-storage, corporate policy,
 * cancelled "Where to save?" prompt) would have the backup reminder
 * silently suppressed with no restorable snapshot to show for it.
 *
 * Fix: prefer `showSaveFilePicker` (File System Access API) where
 * available — it returns a writable handle and only resolves after
 * the write actually lands on disk. Only mark the reminder completed
 * on a confirmed write. For browsers without the API (Firefox, older
 * Safari), fall back to the legacy blob+anchor path; in that case we
 * *still* can't confirm the save, so we surface a neutral toast that
 * instructs the user to verify the file saved before the reminder is
 * treated as satisfied. The caller's success toast path is unchanged.
 *
 * Async return: resolves to `true` on a confirmed write (modern
 * browsers) and `false` on the fallback (best-effort). Callers that
 * await the promise can decide how confidently to treat the result.
 */
export async function triggerJsonExport(): Promise<boolean> {
  const data = buildExportData();
  const filename = `harbor-ledger-backup-${getTodayStr()}.json`;
  const serialized = JSON.stringify(data, null, 2);

  const fsaWindow = window as FSAccessWindow;
  if (typeof fsaWindow.showSaveFilePicker === 'function') {
    try {
      const handle = await fsaWindow.showSaveFilePicker({
        suggestedName: filename,
        types: [{
          description: 'Harbor Ledger JSON backup',
          accept: { 'application/json': ['.json'] }
        }]
      });
      const writable = await handle.createWritable();
      await writable.write(serialized);
      await writable.close();
      // Write confirmed — safe to mark the reminder complete.
      markBackupCompleted();
      awardAchievement('data_pro');
      return true;
    } catch (err) {
      // `AbortError` = user cancelled the save dialog. Don't mark the
      // reminder complete: there's no snapshot to fall back on. Any
      // other error (permissions, disk full, policy) also falls
      // through to the legacy path below, where at least the blob
      // will still try to download — but we don't mark anything as
      // "backup complete" because we have no confirmed write.
      if (err instanceof Error && err.name === 'AbortError') {
        return false;
      }
      // Non-abort failures: fall through to legacy path.
    }
  }

  // Legacy fallback: blob + anchor download. No success signal
  // available from the browser, so we optimistically mark the
  // reminder — matches pre-fix behavior — but note the limitation in
  // the comment for anyone tracking this defect.
  const blob = new Blob([serialized], { type: 'application/json' });
  downloadBlob(blob, filename);
  markBackupCompleted();
  awardAchievement('data_pro');
  return false;
}

function setupExportHandlers(): void {
  // Export JSON
  exportJsonButton = DOM.get('export-json-btn');
  exportJsonHandler = () => {
    // Commit E (new batch P2): `triggerJsonExport` is async and returns
    // `true` only when the File System Access API confirms a write to
    // disk. On confirmed writes, show the canonical success toast; on
    // the legacy best-effort path we still surface the same message
    // (matching prior behavior) but the `markBackupCompleted` call is
    // now gated inside `triggerJsonExport` — cancelled saves via FSA
    // no longer silently suppress the reminder.
    void triggerJsonExport().then((confirmed) => {
      const total = signals.transactions.value.length;
      if (confirmed) {
        showToast(`JSON backup exported — ${total} transaction${total === 1 ? '' : 's'}`, 'success');
      } else {
        // Legacy fallback OR a non-abort FSA failure: show the same
        // message for continuity but don't over-claim success.
        showToast(`JSON backup started — ${total} transaction${total === 1 ? '' : 's'}`, 'info');
      }
    }).catch(() => {
      // triggerJsonExport handles its own user-cancel path; any other
      // error surfaces as a generic notice so the user knows the save
      // didn't complete.
      showToast('JSON export failed — backup not saved', 'error');
    });
  };
  exportJsonButton?.addEventListener('click', exportJsonHandler);

  // Backup reminder button
  backupNowButton = DOM.get('backup-now-btn');
  backupNowHandler = () => {
    (DOM.get('export-json-btn'))?.click();
  };
  backupNowButton?.addEventListener('click', backupNowHandler);

  // Export CSV (respects current filters)
  exportCsvButton = DOM.get('export-csv-btn');
  exportCsvHandler = () => {
    const { txs, isFiltered } = getExportableTransactions();
    const csvContent = buildCsvContent(txs);
    const blob = new Blob([csvContent], { type: 'text/csv' });
    const suffix = isFiltered ? '-filtered' : '';
    downloadBlob(blob, `harbor-ledger${suffix}-${getTodayStr()}.csv`);
    // CR-Apr24-I finding 14: CSV export is a transactions-only slice —
    // it does NOT constitute a full backup (no settings, debts, goals,
    // categories, etc.). Resetting the backup reminder here would
    // suppress the "time for a full backup" nudge even though the user
    // has no restorable snapshot of their complete app state.
    // markBackupCompleted();  ← intentionally removed
    awardAchievement('data_pro');
    const label = isFiltered ? 'filtered' : 'current view';
    showToast(`CSV exported — ${txs.length} transaction${txs.length === 1 ? '' : 's'} (${label})`, 'success');
  };
  exportCsvButton?.addEventListener('click', exportCsvHandler);

  // Export PDF (respects current filters)
  exportPdfButton = DOM.get('export-pdf-btn');
  exportPdfHandler = () => {
    const { txs, isFiltered } = getExportableTransactions();
    triggerPdfExport(txs);
    awardAchievement('data_pro');
    const label = isFiltered ? 'filtered' : 'current view';
    showToast(`PDF statement opened — ${txs.length} transaction${txs.length === 1 ? '' : 's'} (${label})`, 'success');
  };
  exportPdfButton?.addEventListener('click', exportPdfHandler);

  // Utilities dropdown toggle
  const utilitiesToggle = DOM.get('utilities-toggle');
  const utilitiesMenu = DOM.get('utilities-menu');
  if (utilitiesToggle && utilitiesMenu) {
    utilitiesAbortController = new AbortController();
    const { signal } = utilitiesAbortController;
    utilitiesToggle.addEventListener('click', () => {
      const isOpen = !utilitiesMenu.classList.contains('hidden');
      utilitiesMenu.classList.toggle('hidden', isOpen);
      utilitiesToggle.setAttribute('aria-expanded', String(!isOpen));

      // Update scope labels and aria-labels when dropdown opens
      if (!isOpen) {
        const f = signals.filters.value;
        const active = countActiveFilters(f);
        const label = active > 0 ? `Filtered (${active})` : 'Current view';
        const ariaLabel = active > 0 ? `filtered, ${active} active` : 'current view';
        const hintClass = 'utilities-dropdown__hint--filtered';
        const csvScope = DOM.get('csv-export-scope');
        const pdfScope = DOM.get('pdf-export-scope');
        if (csvScope) {
          csvScope.textContent = label;
          csvScope.classList.toggle(hintClass, active > 0);
        }
        if (pdfScope) {
          pdfScope.textContent = label;
          pdfScope.classList.toggle(hintClass, active > 0);
        }
        exportCsvButton?.setAttribute('aria-label', `Export CSV — ${ariaLabel}`);
        exportPdfButton?.setAttribute('aria-label', `Export PDF — ${ariaLabel}`);
      }
    }, { signal });
    // Close on outside click
    document.addEventListener('click', (e) => {
      if (!utilitiesToggle.contains(e.target as Node) && !utilitiesMenu.contains(e.target as Node)) {
        utilitiesMenu.classList.add('hidden');
        utilitiesToggle.setAttribute('aria-expanded', 'false');
      }
    }, { signal });
    // Close after selecting an item
    utilitiesMenu.addEventListener('click', () => {
      utilitiesMenu.classList.add('hidden');
      utilitiesToggle.setAttribute('aria-expanded', 'false');
    }, { signal });
    // Escape closes and returns focus to the toggle — standard
    // disclosure-widget keyboard behavior. We don't implement roving
    // tabindex / arrow-key navigation because the menu doesn't claim
    // `role="menu"`; Tab simply moves between the item buttons.
    document.addEventListener('keydown', (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      if (utilitiesMenu.classList.contains('hidden')) return;
      if (!utilitiesToggle.contains(e.target as Node) && !utilitiesMenu.contains(e.target as Node)) return;
      e.preventDefault();
      utilitiesMenu.classList.add('hidden');
      utilitiesToggle.setAttribute('aria-expanded', 'false');
      (utilitiesToggle as HTMLElement).focus();
    }, { signal });
  }
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

  importClickHandler = (event: Event) => {
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
        emit(Events.CLOSE_MODAL, { id: 'import-options-modal' });
        _importData = null;
        break;
    }
  };
  document.addEventListener('click', importClickHandler);

  // Delegate file input changes at the document level so the restore flow stays
  // resilient even if the hidden input is replaced during reload or remount work.
  importChangeHandler = (event: Event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || target.id !== 'import-file') return;
    void handleImportFile(event);
  };
  document.addEventListener('change', importChangeHandler);
}

function openImportFileChooser(): void {
  // Design-Review-Apr21 P3 (batch 6 follow-up): if a previously-parsed
  // backup is still in memory (the user dismissed the chooser via
  // Escape/backdrop instead of explicit Cancel), skip the file picker
  // and re-open the chooser modal with the preserved payload. The
  // context block (filename/date/tx-count) populated during the
  // original `handleImportFile` call persists in the DOM because the
  // modal is only hidden, not re-rendered, on dismissal. Users who
  // actually want a different backup press Cancel (which clears
  // `_importData`) and re-trigger — their next click opens the file
  // picker as before. This eliminates the brittle re-parse cycle on
  // accidental dismissal without hiding the "switch file" path.
  if (_importData) {
    // CR-Apr24-I finding 118: repopulate the context block so that
    // locale-sensitive formatting (dates, currency) reflects the
    // current locale when the modal reopens — not whatever was active
    // during the original parse.
    populateImportOptionsContext(_importFileName, _importData, _importTxCount);
    emit(Events.OPEN_MODAL, { id: 'import-options-modal' });
    return;
  }

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
      emit(Events.SHOW_TOAST, { message: `File too large (${fileSizeMB}MB). Maximum is ${maxSizeMB}MB.`, type: 'error' });
      _importData = null;
      return;
    }

    const importData = JSON.parse(await file.text()) as ImportData;
    _importData = importData;

    if (!importData || !Array.isArray(importData.transactions)) {
      emit(Events.SHOW_TOAST, { message: 'This file doesn\u2019t look like a valid backup \u2014 it\u2019s missing transaction data.', type: 'error' });
      _importData = null;
      return;
    }

    const txCount = importData.transactions.length;
    if (txCount > MAX_IMPORT_TRANSACTIONS) {
      const message = `This file contains ${formatNumber(txCount)} transactions.`;
      const details = `Importing more than ${formatNumber(MAX_IMPORT_TRANSACTIONS)} transactions may impact performance.`;
      const proceed = await confirmDataOperation(message, details);

      if (!proceed) {
        _importData = null;
        return;
      }
    }

    // Design-Review-Apr21 P3 (batch 6 follow-up): populate the
    // `#import-options-context` block in the chooser with filename,
    // backup date, and transaction count so users can verify they
    // are acting on the intended backup before choosing merge vs.
    // replace. Use `textContent` (not innerHTML) for filename + date
    // — both are user-controlled (filename from the file picker,
    // exportedAt from the uploaded JSON) and must not be interpreted
    // as markup. `formatDateLong` handles both valid and invalid
    // `exportedAt` values; we guard the invalid case to show a
    // neutral placeholder rather than "Invalid Date".
    // Finding 118: store for potential reopen repopulation
    _importFileName = file.name;
    _importTxCount = txCount;
    populateImportOptionsContext(file.name, importData, txCount);

    await nextFrame();
    emit(Events.OPEN_MODAL, { id: 'import-options-modal' });
  } catch (err) {
    if (import.meta.env.DEV) console.error('Import JSON parse error:', err);
    emit(Events.SHOW_TOAST, { message: 'This file isn\u2019t a valid Harbor Ledger backup. Export a fresh backup from Settings > Data and try again.', type: 'error' });
    _importData = null;
  } finally {
    input.value = '';
  }
}

/**
 * Design-Review-Apr21 P3 (batch 6 follow-up): populate the
 * import-options backup-context block. Extracted so the open path
 * has a single, testable seam and the template in simple-modals.ts
 * stays decoupled from import parsing.
 */
function populateImportOptionsContext(fileName: string, importData: ImportData, txCount: number): void {
  const ctx = DOM.get('import-options-context');
  const filenameEl = DOM.get('import-options-context__filename');
  const dateEl = DOM.get('import-options-context__date');
  const countEl = DOM.get('import-options-context__txcount');
  if (!ctx || !filenameEl || !dateEl || !countEl) return;

  filenameEl.textContent = fileName;
  filenameEl.setAttribute('title', fileName);

  const exportedAtRaw = typeof importData.exportedAt === 'string' ? importData.exportedAt : '';
  let dateDisplay = 'Unknown';
  if (exportedAtRaw) {
    const parsed = new Date(exportedAtRaw);
    if (!Number.isNaN(parsed.getTime())) {
      // Re-use the user-locale date formatter used elsewhere in the
      // app. Avoids hand-rolled toLocaleDateString and respects
      // settings locale changes.
      try {
        dateDisplay = formatDateLong(parsed);
      } catch {
        dateDisplay = parsed.toDateString();
      }
    }
  }
  dateEl.textContent = dateDisplay;

  countEl.textContent = `${formatNumber(txCount)} transaction${txCount === 1 ? '' : 's'}`;

  ctx.classList.remove('hidden');
}

/**
 * Handle import overwrite
 */
async function handleImportOverwrite(): Promise<void> {
  if (!_importData) return;

  // Design-Review-Apr21 P2 (batch 6 follow-up): final confirmation gate
  // before destructive whole-account replace. The option sheet's
  // "Replace everything" label alone is insufficient protection against
  // a misclick/tap slip on a destructive, non-undoable action that
  // overwrites transactions + categories + budgets + savings goals +
  // debts. Route through the DI-injected `confirmDataOperation` (not a
  // direct `asyncConfirm` import) to preserve the features → UI layer
  // boundary — the same channel the similar-duplicate merge branch uses
  // below. Interpolate the incoming transaction count so the user sees
  // the magnitude of the action before confirming. On decline, close
  // the import-options modal and clear `_importData` so a subsequent
  // flow starts clean.
  const pendingTxCount = (_importData.transactions || []).length;
  const confirmMessage = `Replace all existing data with this backup?`;
  const confirmDetails = `This will overwrite ${pendingTxCount} transaction${pendingTxCount === 1 ? '' : 's'} plus all categories, budgets, savings goals, and debts. This action cannot be undone.`;
  const proceed = await confirmDataOperation(confirmMessage, confirmDetails);
  if (!proceed) {
    _importData = null;
    emit(Events.CLOSE_MODAL, { id: 'import-options-modal' });
    return;
  }

  try {
    const d = _importData;
    const txCount = (d.transactions || []).length;
    emit(Events.SHOW_PROGRESS, { title: 'Importing Data', text: `Importing ${txCount} transaction${txCount === 1 ? '' : 's'}...` });
    await new Promise(r => setTimeout(r, CONFIG.TIMING.UI_DELAY));

    // M12 (rev 12): destructure the new sanitizer shape + surface the
    // rejected count to the user and telemetry before proceeding. Prior
    // code dropped rejections silently.
    const incomingList = d.transactions || [];
    const { accepted: txList, rejected } = sanitizeImportedTransactions(incomingList);
    reportImportValidationRejections(rejected, incomingList.length, 'backup_overwrite');
    const { newS, writes, theme } = buildImportState(d, 'overwrite', txList);

    const applyResult = await applyImportedState(newS, writes, txList, theme);
    if (!applyResult.ok) {
      emit(Events.HIDE_PROGRESS, {});
      return;
    }

    _importData = null;
    emit(Events.HIDE_PROGRESS, {});
    emit(Events.CLOSE_MODAL, { id: 'import-options-modal' });
    // Rev 13 L74: suppress the success toast when hydration reported any
    // partial failure — the warning already emitted by
    // updateSignalsFromImport is the authoritative outcome in that case.
    if (applyResult.hydration.failed.length === 0) {
      emit(Events.SHOW_TOAST, { message: `All data replaced \u2014 ${txList.length} transaction${txList.length === 1 ? '' : 's'} imported`, type: 'success' });
    }
    emit(Events.DATA_IMPORTED);
  } catch (_err) {
    emit(Events.HIDE_PROGRESS, {});
    emit(Events.SHOW_TOAST, { message: 'Import failed \u2014 the file may be corrupted or in the wrong format. Try re-exporting from your source.', type: 'error' });
  }
}

/**
 * Handle import merge
 */
async function handleImportMerge(): Promise<void> {
  if (!_importData) return;

  try {
    const d = _importData;
    emit(Events.SHOW_PROGRESS, { title: 'Merging Data', text: 'Checking for duplicates...' });
    await new Promise(r => setTimeout(r, CONFIG.TIMING.UI_DELAY));

    const existing = [...signals.transactions.value] as Transaction[];
    const existingIds = new Set(existing.map(t => t.__backendId));
    
    let incomingFiltered = (d.transactions || []).filter((t): t is Record<string, unknown> => {
      const tx = t as Record<string, unknown> | null;
      return tx != null && !existingIds.has(tx.__backendId as string);
    });

    const incomingAsTransactions = incomingFiltered as unknown as Transaction[];

    // CR-Apr24-I finding 22: check for content duplicates WITHIN the
    // incoming file before checking against existing transactions. A
    // backup that contains the same transaction twice (same date, amount,
    // category, description) but with different __backendIds would
    // previously import both rows — doubling the user's ledger silently.
    // `deduplicateExact` uses the same `getExactKey` identity (date +
    // type + category + cents + description) as the cross-set checker,
    // keeping only the first row per key. Surface the drop count via
    // toast so the user knows rows were collapsed.
    const internalDups = findInternalDuplicates(incomingAsTransactions);
    if (internalDups.size > 0) {
      const beforeCount = incomingAsTransactions.length;
      const deduped = deduplicateExact(incomingAsTransactions);
      const removedCount = beforeCount - deduped.length;
      if (removedCount > 0) {
        emit(Events.SHOW_TOAST, { message: `Removed ${removedCount} duplicate(s) within the import file`, type: 'info' });
        incomingFiltered = deduped as unknown as Record<string, unknown>[];
      }
    }

    const duplicates = findContentDuplicates(incomingFiltered as unknown as Transaction[], existing);

    if (duplicates.exact.length > 0) {
      emit(Events.SHOW_TOAST, { message: `Skipping ${duplicates.exact.length} exact duplicate(s)`, type: 'info' });
      incomingFiltered = excludeDuplicates(incomingFiltered as unknown as Transaction[], duplicates.exact) as unknown as Record<string, unknown>[];
    }
    
    if (duplicates.similar.length > 0) {
      emit(Events.HIDE_PROGRESS, {});
      emit(Events.CLOSE_MODAL, { id: 'import-options-modal' });
      const message = `Found ${duplicates.similar.length} similar transactions that might be duplicates.`;
      const details = `Choose 'Continue' to import them anyway, or 'Cancel' to skip them.`;
      
      const proceed = await confirmDataOperation(message, details);

      if (!proceed) {
        emit(Events.SHOW_PROGRESS, { title: 'Merging Data', text: 'Skipping similar...' });
        const filteredTransactions = excludeDuplicates(incomingFiltered as unknown as Transaction[], duplicates.similar);
        // M12 (rev 12): surface validation rejections + route through telemetry
        // on this filter-similar merge branch (the "user declined similar-dup
        // import" path).
        const { accepted: newTx, rejected: filteredRejected } =
          sanitizeImportedTransactions(filteredTransactions as unknown as Record<string, unknown>[], existingIds);
        reportImportValidationRejections(filteredRejected, filteredTransactions.length, 'backup_merge_filtered');
        const mergedTx = [...existing, ...newTx];
        const { newS, writes, theme } = buildImportState(d, 'merge', mergedTx);

        const applyResult = await applyImportedState(newS, writes, mergedTx, theme);
        if (!applyResult.ok) {
          emit(Events.HIDE_PROGRESS, {});
          return;
        }
        _importData = null;
        emit(Events.HIDE_PROGRESS, {});
        emit(Events.CLOSE_MODAL, { id: 'import-options-modal' });
        // Rev 13 L74: suppress the info toast when hydration reported any
        // partial failure — the warning already emitted is authoritative.
        if (applyResult.hydration.failed.length === 0) {
          emit(Events.SHOW_TOAST, { message: `skipped ${duplicates.similar.length} similar transaction${duplicates.similar.length === 1 ? '' : 's'} and imported ${newTx.length}`, type: 'info' });
        }
        emit(Events.DATA_IMPORTED);
        return;
      }
      
      emit(Events.SHOW_PROGRESS, { title: 'Merging Data', text: 'Importing all...' });
    }

    // M12 (rev 12): surface validation rejections on the main merge path too.
    // Source label distinguishes this from the filtered-similar branch so
    // telemetry can tell which path dominates rejection-heavy imports.
    const { accepted: newTx, rejected: mergeRejected } =
      sanitizeImportedTransactions(incomingFiltered, existingIds);
    reportImportValidationRejections(mergeRejected, incomingFiltered.length, 'backup_merge_all');
    const mergedTx = [...existing, ...newTx];
    const { newS, writes, theme } = buildImportState(d, 'merge', mergedTx);

    const applyResult = await applyImportedState(newS, writes, mergedTx, theme);
    if (!applyResult.ok) {
      emit(Events.HIDE_PROGRESS, {});
      return;
    }
    _importData = null;
    emit(Events.HIDE_PROGRESS, {});
    emit(Events.CLOSE_MODAL, { id: 'import-options-modal' });
    // Rev 13 L74: suppress the success toast when hydration reported any
    // partial failure — the warning already emitted is authoritative.
    if (applyResult.hydration.failed.length === 0) {
      emit(Events.SHOW_TOAST, { message: 'Data merged successfully', type: 'success' });
    }
    emit(Events.DATA_IMPORTED);
  } catch (_err) {
    emit(Events.HIDE_PROGRESS, {});
    emit(Events.SHOW_TOAST, { message: 'Merge failed \u2014 the file may be corrupted or in the wrong format. Try re-exporting from your source.', type: 'error' });
  }
}
