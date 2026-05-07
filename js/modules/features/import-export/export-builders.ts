/**
 * Export Builders Module
 *
 * Constructs export data payloads for manual JSON export and CSV export.
 * Reads live signal state and recurring template storage for full-fidelity backups.
 *
 * @module export-builders
 */
'use strict';

import { SK } from '../../core/state.js';
import { safeStorage } from '../../core/safe-storage.js';
import { cloneStorageDefault, readOptionalSignalValue } from './import-helpers.js';
import {
  type RecurringTemplate
} from '../../data/recurring-templates.js';
import * as signals from '../../core/signals.js';
import { userCategoryConfig } from '../../core/category-store.js';
import type {
  Transaction,
  SavingsGoal,
  SavingsContribution,
  Debt,
  CurrencySettings,
  StreakData,
  AlertPrefs,
  RolloverSettings,
  FilterPreset,
  TxTemplate,
  UserCategoryConfig,
} from '../../../types/index.js';

// ==========================================
// TYPE DEFINITIONS
// ==========================================

export interface ExportData {
  transactions: Transaction[];
  savingsGoals: Record<string, SavingsGoal>;
  savingsContributions: SavingsContribution[];
  monthlyAllocations: Record<string, Record<string, number>>;
  userCategories: UserCategoryConfig | null;
  currency: CurrencySettings;
  achievements: Record<string, unknown>;
  streak: StreakData;
  sections: { envelope: boolean };
  theme: string;
  alertPrefs: AlertPrefs;
  insightPersonality: string;
  debts: Debt[];
  rolloverSettings: RolloverSettings | null;
  filterPresets: FilterPreset[];
  txTemplates: TxTemplate[];
  /**
   * CR-Apr22-F slice 1: SK.RECURRING template set. Before this field
   * existed in the export, a manual JSON export/import round-trip
   * dropped recurring-template definitions — the restored device kept
   * the already-materialized historical transactions but the series
   * behind them silently stopped generating new occurrences. Serialized
   * in the storage-shape (object keyed by template id) so the restore
   * path can write SK.RECURRING and `loadRecurringTemplates()` to
   * rebuild the in-memory Map.
   */
  recurringTemplates: Record<string, RecurringTemplate>;
  exportedAt: string;
  version: string;
  /**
   * L79: canonical numeric ms-since-epoch (matches `signal<number>` in
   * signals.ts:215). `0` when no prior backup; `null` kept as a
   * belt-and-braces for legacy consumers that check for falsy.
   */
  lastBackup: number | null;
  /**
   * L89: transaction count at the time of the last backup (matches
   * `signal<number>` at signals.ts:222). Written so a manual JSON
   * export → import round-trip preserves the "add N tx since last
   * backup" reminder state — before this field, importing an export
   * reset `lastBackupTxCount` to 0 and the reminder fired immediately
   * even though the user had just imported a fresh backup. `null` on
   * cold boot (no backup ever taken), otherwise the signal's raw value.
   */
  lastBackupTxCount: number | null;
  // CR-Apr24-I finding 182: persisted UI state for full round-trip fidelity.
  onboarding: { active: boolean; step: number; completed: boolean };
  filterExpanded: boolean;
}

// DRY-01: cloneStorageDefault and readOptionalSignalValue imported from
// import-helpers.ts (shared with import-export.ts).

// ==========================================
// EXPORT BUILDERS
// ==========================================

/**
 * Build export JSON data object
 * FIXED: Uses live signals for IndexedDB-backed data and includes all relevant state for a complete backup
 */
export function buildExportData(): ExportData {
  const onboarding = readOptionalSignalValue<ExportData['onboarding']>(
    'onboarding',
    cloneStorageDefault<ExportData['onboarding']>(SK.ONBOARD)
  );
  const filterExpanded = readOptionalSignalValue<ExportData['filterExpanded']>(
    'filtersExpanded',
    cloneStorageDefault<ExportData['filterExpanded']>(SK.FILTER_EXPANDED)
  );

  return {
    transactions: [...signals.transactions.value],
    savingsGoals: signals.savingsGoals.value as unknown as Record<string, SavingsGoal>,
    savingsContributions: signals.savingsContribs.value,
    monthlyAllocations: signals.monthlyAlloc.value as Record<string, Record<string, number>>,
    userCategories: userCategoryConfig.value,
    currency: signals.currency.value,
    achievements: signals.achievements.value,
    streak: signals.streak.value,
    sections: signals.sections.value as { envelope: boolean },
    // L81: read theme from the live signal, not `safeStorage.getItem(SK.THEME)`.
    // Theme persists through the debounced signal batcher (signals.ts:1098),
    // so a theme change that has not yet flushed leaves localStorage stale
    // — a manual export fired in that window would snapshot the previous
    // theme even though the UI and in-memory state already reflect the new
    // one. The signal is always authoritative.
    theme: signals.theme.value || 'dark',
    alertPrefs: signals.alerts.value,
    insightPersonality: signals.insightPers.value as string,
    // rev 12 / #39 M2: `(signals.debts.value || []) as Debt[]` dead guard
    // removed — `signals.debts` is `signal<Debt[]>(...)` at `signals.ts:139`.
    debts: signals.debts.value,
    rolloverSettings: (signals.rolloverSettings.value || null) as RolloverSettings | null,
    filterPresets: (signals.filterPresets.value || []),
    txTemplates: (signals.txTemplates.value || []),
    // L79: write the canonical numeric ms-since-epoch directly. Prior
    // `String(signals.lastBackup.value)` coerced the numeric signal to
    // a string on export, which round-tripped back through import as a
    // string and violated the `signal<number>` contract at the restore
    // boundary. `normalizeLastBackup` in `buildImportState` still
    // handles legacy string payloads for backward compat.
    lastBackup: signals.lastBackup.value || null,
    // L89: preserve the "add N tx since last backup" reminder counter
    // through a manual JSON export/import round-trip. Without this
    // field, importing an export dropped `lastBackupTxCount` back to
    // 0 — the reminder then fired immediately even though the user
    // had just restored a fresh backup. Mirrors the `lastBackup`
    // falsy-to-null convention so cold-boot exports (never backed up)
    // emit `null` rather than `0` for legacy consumers.
    lastBackupTxCount: signals.lastBackupTxCount.value || null,
    // CR-Apr24-I finding 177: persist onboarding and filter-panel state
    // so a JSON export/import round-trip reproduces the full UI context.
    onboarding,
    filterExpanded,
    // CR-Apr22-F slice 1: snapshot the SK.RECURRING template set directly
    // from storage. The recurring-templates module keeps its in-memory
    // `Map<string, RecurringTemplate>` in lock-step with SK.RECURRING via
    // synchronous `safeStorage.setJSON(...)` writes (no debounced batcher
    // like the four signals covered by L83 in auto-backup.ts), so storage
    // is the authoritative, consistent snapshot at export time. An empty
    // `{}` is a legitimate "no recurring series" value and round-trips
    // cleanly through the import-path writer below.
    recurringTemplates: safeStorage.getJSON<Record<string, RecurringTemplate>>(SK.RECURRING, {}),
    exportedAt: new Date().toISOString(),
    version: '2.6'
  };
}

/**
 * Build CSV content from transactions
 */
export function buildCsvContent(txs: Transaction[]): string {
  const header = 'Date,Type,Category,Amount,Description,Tags,Notes,Recurring\n';
  const csvEsc = (s: unknown): string => {
    const str = String(s || '');
    // Round 7: Enhanced OWASP formula injection defense to handle %, tab, and multi-line fields
    // Prefix with single-quote to neutralize formulas starting with =, +, -, @, |, % or \t.
    // Single-quote is the universal formula escape in Excel, Google Sheets, and LibreOffice Calc.
    // Check trimmed value (whitespace could hide formula chars), but prefix original.
    const hasFormulaStart = /^[=+\-@|%\t]/.test(str.trim());
    const safe = hasFormulaStart ? "'" + str : str;
    // Escape double-quotes and wrap in quotes (also ensures multi-line fields are RFC 4180 compliant)
    return `"${safe.replace(/"/g, '""')}"`;
  };
  const rows = txs.map(t =>
    [t.date, t.type, t.category, t.amount, t.description, t.tags, t.notes, t.recurring ? t.recurring_type : '']
    .map(csvEsc).join(',')
  ).join('\n');
  return header + rows;
}
