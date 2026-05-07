/**
 * Automatic Backup Module
 * 
 * Implements automatic scheduled backups with versioning,
 * compression, and cloud storage support.
 */

import { SK, lsGet, lsSet, BACKUP_REMINDER_TX_COUNT_KEY } from '../../core/state.js';
import * as signals from '../../core/signals.js';
import { downloadBlob } from '../../core/utils-dom.js';
import { emit, Events } from '../../core/event-bus.js';
import { generateId, getTodayStr } from '../../core/utils-pure.js';
import { trackError } from '../../core/error-tracker.js';
import { safeStorage } from '../../core/safe-storage.js';
import { isTheme } from '../../core/theme-allowlist.js';
import { hydrateFromImport } from '../../core/state-hydration.js';
import {
  buildImportState,
  tryAtomicWrite,
  sanitizeImportedTransactions,
  reportImportValidationRejections
} from '../import-export/import-export.js';
import { setTheme } from '../personalization/theme.js';
import { dataSdk } from '../../data/data-manager.js';
import {
  storeBackup,
  getAllBackups as getIndexedDbBackups,
  getBackup as getIndexedDbBackup,
  deleteBackup as deleteIndexedDbBackup
} from './indexeddb-backup-store.js';
import { userCategoryConfig } from '../../core/category-store.js';
// CR-Apr22-F slice 1: auto-backups previously omitted SK.RECURRING
// entirely; restoring from one recovered historical transactions but
// not the series that should keep generating new occurrences. Source
// the snapshot directly from the same `RecurringTemplate` record the
// recurring-templates module writes via synchronous `safeStorage.setJSON`.
import type { RecurringTemplate } from '../../data/recurring-templates.js';
import type {
  Transaction,
  SavingsGoal,
  SavingsContribution,
  UserCategoryConfig,
  Theme,
  CurrencySettings,
  RolloverSettings,
  SectionsConfig,
  StreakData,
  AlertPrefs,
  InsightPersonality,
  FilterPreset,
  TxTemplate,
  Debt,
  MonthlyAllocation
} from '../../../types/index.js';

// ==========================================
// TYPES
// ==========================================

// Phase 5g-1 (Inline-Behavior-Review rev 12, L18): dropped the `compressed`
// boolean. The backup pipeline never persisted compressed output — the old
// `compressData`/`decompressData` helpers were advisory placeholders that were
// never wired into `storeBackup`, and the flag was a stuck `false`.
// Grep across js/ confirms zero readers outside the old structural gate
// removed below.
interface BackupMetadata {
  id: string;
  timestamp: number;
  version: string;
  deviceId: string;
  transactionCount: number;
  checksum?: string;
  size: number;
}

/**
 * Settings sub-payload nested inside a backup file.
 *
 * Fixes M20 (Inline-Behavior-Review rev 12): the previous shape was
 * `settings: any`, which let any JSON pass through to consumers like
 * `setTheme(backup.data.settings.theme as Theme)` and the restore-time
 * `normalizeBackupForImport()` (which spreads `settings.*` into `newS`).
 * A corrupted backup with `settings.theme = 42` would call
 * `setTheme(42)` unchecked. Defining a concrete shape gives the compiler
 * a chance to catch consumer-side misuse and lets `normalizeBackupSettings`
 * (below) act as the validator-at-boundary, mirroring `normalizeAlertPrefs`.
 *
 * Every field is optional because legacy backups predating each individual
 * field exist in the wild. The runtime restore path supplies safe defaults.
 */
export interface BackupSettings {
  theme?: Theme;
  currency?: CurrencySettings;
  rolloverSettings?: RolloverSettings;
  // The runtime achievements signal is typed as a generic Record so
  // legacy backups with non-boolean payloads still load. The downstream
  // consumer (settings.setAchievements) is the one that enforces shape.
  achievements?: Record<string, unknown>;
  streak?: StreakData;
  sections?: SectionsConfig;
  insightPersonality?: InsightPersonality;
  // Alerts in older backups predate several required AlertPrefs fields
  // (e.g. `lastNotifiedAlertKeys`); normalizeAlertPrefs at the consumer
  // side fills defaults, so accept Partial<AlertPrefs> here.
  alerts?: Partial<AlertPrefs>;
  lastBackup?: number | null;
  lastBackupTxCount?: number;
  // CR-Apr24-I finding 183: persisted UI state for full round-trip fidelity.
  onboarding?: { active: boolean; step: number; completed: boolean };
  filterExpanded?: boolean;
}

export interface BackupData {
  metadata: BackupMetadata;
  data: {
    transactions: Transaction[];
    savingsGoals: Record<string, SavingsGoal>;
    savingsContributions?: SavingsContribution[];
    monthlyAllocations: Record<string, MonthlyAllocation>;
    userCategories: UserCategoryConfig | null;
    /**
     * Legacy-shape compat (rev 13 L71 / Inline-Behavior-Review): pre-v2.x
     * backups stored user-defined cats as `CustomCategory[]` under this
     * field. `normalizeBackupForImport` forwards it so the import path's
     * `buildImportState` legacy branch can convert it to a modern
     * `UserCategoryConfig`. Newer backups populate `userCategories`
     * directly; when both are present the modern field wins.
     */
    customCategories?: unknown;
    debts: Debt[];
    filterPresets?: FilterPreset[];
    txTemplates?: TxTemplate[];
    /**
     * CR-Apr22-F slice 1: SK.RECURRING template set. Optional for legacy-
     * backup back-compat: backups from pre-slice-1 builds did not carry
     * this field, so `normalizeBackupForImport` must tolerate absence.
     * Storage shape (object keyed by template id), matching what
     * `recurring-templates.ts` writes via `saveRecurringTemplates()`.
     * When missing, the restore path treats it as "no recurring series"
     * — matching the pre-fix behavior so a pre-fix backup restores to
     * the same post-condition it would have before. Newer backups
     * carry the field unconditionally (see `createBackup` below), so
     * round-tripping a modern backup never loses series definitions.
     */
    recurringTemplates?: Record<string, RecurringTemplate>;
    // Same Partial<> rationale as BackupSettings.alerts above.
    alerts?: Partial<AlertPrefs>;
    settings: BackupSettings;
    // Index signature kept (typed) so unknown legacy keys don't trip
    // the consumer reads in normalizeBackupForImport, but narrowed away
    // from `any` so per-field reads must declare intent.
    [key: string]: unknown;
  };
}

/**
 * Validator-at-boundary for the BackupSettings sub-payload.
 *
 * Modeled on `normalizeAlertPrefs` (state.ts) — a failed field falls back to
 * a safe default rather than throwing, so a single bad field doesn't tank an
 * otherwise-valid restore. The Theme normalizer matches the L37 fix in
 * state-hydration.ts: only the declared `'dark' | 'light' | 'system'` union
 * passes through; everything else collapses to `'dark'`.
 *
 * Fixes M3 (Inline-Behavior-Review rev 12): the local `SUPPORTED_BACKUP_THEMES`
 * set was a third copy of the theme allowlist. Replaced with the shared
 * `isTheme` guard from `core/theme-allowlist.ts`. The `undefined`-on-null
 * return is preserved here intentionally — restoreBackup at line 506 uses
 * that sentinel to decide whether to call `setTheme(...)` at all (a backup
 * with no theme field shouldn't reset the user's current theme).
 */
function normalizeBackupTheme(raw: unknown): Theme | undefined {
  if (raw == null) return undefined;
  return isTheme(raw) ? raw : 'dark';
}

export function normalizeBackupSettings(raw: unknown): BackupSettings {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const out: BackupSettings = {};

  const theme = normalizeBackupTheme(r.theme);
  if (theme !== undefined) out.theme = theme;
  if (r.currency && typeof r.currency === 'object') out.currency = r.currency as CurrencySettings;
  if (r.rolloverSettings && typeof r.rolloverSettings === 'object') out.rolloverSettings = r.rolloverSettings as RolloverSettings;
  if (r.achievements && typeof r.achievements === 'object') out.achievements = r.achievements as Record<string, unknown>;
  if (r.streak && typeof r.streak === 'object') out.streak = r.streak as StreakData;
  if (r.sections && typeof r.sections === 'object') out.sections = r.sections as SectionsConfig;
  if (typeof r.insightPersonality === 'string') out.insightPersonality = r.insightPersonality as InsightPersonality;
  if (r.alerts && typeof r.alerts === 'object') out.alerts = r.alerts as Partial<AlertPrefs>;
  if (r.lastBackup === null || (typeof r.lastBackup === 'number' && Number.isFinite(r.lastBackup))) {
    out.lastBackup = r.lastBackup;
  }
  // CR-Apr24-I finding 187: clamp to non-negative integer, matching
  // the stricter contract the manual import path enforces via
  // normalizeLastBackupTxCount.
  if (typeof r.lastBackupTxCount === 'number' && Number.isFinite(r.lastBackupTxCount)) {
    out.lastBackupTxCount = Math.max(0, Math.round(r.lastBackupTxCount));
  }
  return out;
}

interface BackupSchedule {
  enabled: boolean;
  frequency: 'daily' | 'weekly' | 'monthly';
  time: string; // HH:MM format
  lastBackup?: number;
  nextBackup?: number;
  retainCount: number; // Number of backups to retain
}

// Phase 6 Slice 1j (rev 12 L6): optional fields widened for
// `exactOptionalPropertyTypes` — `inProgressStartedAt = undefined` is
// used at three clearance sites to reset alongside `inProgress = false`.
interface BackupStatus {
  inProgress: boolean;
  /**
   * Wall-clock timestamp (ms) of when `inProgress` flipped true. Paired with
   * MAX_BACKUP_DURATION_MS so `recoverStaleInProgress()` can detect and clear
   * a flag that survived a tab/OS crash. Cleared alongside `inProgress`.
   * Fixes H17 (Inline-Behavior-Review rev 12).
   */
  inProgressStartedAt?: number | undefined;
  lastSuccess?: number | undefined;
  lastError?: string | undefined;
  totalBackups: number;
  totalSize: number;
}

// ==========================================
// CONSTANTS
// ==========================================

const BACKUP_SCHEDULE_KEY = 'harbor_backup_schedule';
const BACKUP_STATUS_KEY = 'harbor_backup_status';
const BACKUP_VERSION = '2.0';
const DEVICE_ID = getOrCreateDeviceId();
const MAX_BACKUP_IMPORT_BYTES = 25 * 1024 * 1024;
const MAX_TIMEOUT_MS = 2_147_483_647;
// Fixes H17 (Inline-Behavior-Review rev 12): upper bound on how long a
// legitimate backup can take. If `inProgress` has been true longer than
// this, treat it as the aftermath of a tab/OS crash and self-heal.
// 5 minutes is deliberately generous — even a slow mobile IDB write
// compressing 10k+ tx should finish well inside this window.
const MAX_BACKUP_DURATION_MS = 5 * 60 * 1000;

// ==========================================
// MODULE STATE
// ==========================================

let backupSchedule: BackupSchedule = getBackupSchedule();
let backupStatus: BackupStatus = getBackupStatus();
let scheduledBackupTimer: number | null = null;

// ==========================================
// BACKUP CREATION
// ==========================================

/**
 * Fixes H17 (Inline-Behavior-Review rev 12): if the previous session set
 * `inProgress=true` and never cleared it (tab/OS crash, OOM kill, laptop
 * closed mid-write), the persisted flag survives into the next boot and
 * every future createBackup() call silently no-ops — backups stay disabled
 * forever with no signal. Check age-against-wall-clock and self-heal.
 *
 * Returns true when a stale flag was cleared (caller can log/metric),
 * false when state was already consistent.
 */
function recoverStaleInProgress(): boolean {
  if (!backupStatus.inProgress) return false;
  const startedAt = backupStatus.inProgressStartedAt;
  // Missing timestamp => legacy flag from before H17 landed. Treat as stale
  // so users who crashed on an old build self-heal on first boot of new build.
  const age = startedAt ? Date.now() - startedAt : Infinity;
  if (age <= MAX_BACKUP_DURATION_MS) return false;

  trackError(new Error('Backup inProgress flag was stuck; clearing'), {
    module: 'backup',
    action: 'create_backup.stale_flag_recovery'
  });
  backupStatus.inProgress = false;
  backupStatus.inProgressStartedAt = undefined;
  saveBackupStatus();
  return true;
}

/**
 * Create a backup of all data
 *
 * @param manual - true when invoked by a user-driven control (exports,
 *   restore-safety). Gates the success toast and telemetry action.
 * @param retainOverride - optional retention-count override for this
 *   single write. Defaults to `backupSchedule.retainCount`. The
 *   restoreBackup safety-backup path passes a bumped value (current
 *   count + 1) so the source backup being restored from can't be
 *   evicted by its own safety snapshot when retention is set low
 *   (prior-batch P2: "restoreBackup evicts itself on low retention").
 */
export async function createBackup(
  manual: boolean = false,
  retainOverride?: number
): Promise<BackupData | null> {
  // Fixes H17: self-heal a stuck flag before the guard fires, so a crash
  // followed by an immediate retry doesn't leave the user permanently disabled.
  recoverStaleInProgress();
  if (backupStatus.inProgress) return null;

  try {
    // Update status
    backupStatus.inProgress = true;
    backupStatus.inProgressStartedAt = Date.now();
    saveBackupStatus();

    // New-batch P2: compute `now` and `currentTxCount` BEFORE building
    // the payload so the `settings.lastBackup` / `lastBackupTxCount`
    // fields below describe THIS backup, not the previous one. The
    // earlier ordering snapshotted `signals.lastBackup.value` /
    // `signals.lastBackupTxCount.value` into the payload before the
    // post-success block at lines 369-371 had a chance to update them,
    // so the payload encoded the pointer to the PRIOR backup. On
    // restore (line 613-615), the reminder banner then resurrected
    // that stale baseline instead of pointing at the backup the user
    // just restored from. Stamping the current backup's own metadata
    // into its settings block makes restore self-consistent: after a
    // restore, the reminder state says "your last backup is the one
    // you just loaded", which is the only truthful answer.
    const now = Date.now();
    const currentTxCount = signals.transactions.value.length;

    // Collect all data
    const backupData: BackupData = {
      metadata: {
        id: generateId(),
        timestamp: now,
        version: BACKUP_VERSION,
        deviceId: DEVICE_ID,
        transactionCount: currentTxCount,
        size: 0
      },
      data: {
        transactions: signals.transactions.value,
        savingsGoals: signals.savingsGoals.value,
        monthlyAllocations: signals.monthlyAlloc.value,
        userCategories: userCategoryConfig.value,
        debts: signals.debts.value,
        settings: {
          currency: signals.currency.value,
          rolloverSettings: signals.rolloverSettings.value,
          achievements: signals.achievements.value,
          streak: signals.streak.value,
          theme: signals.theme.value,
          sections: signals.sections.value,
          insightPersonality: signals.insightPers.value,
          lastBackup: now,
          lastBackupTxCount: currentTxCount,
          // CR-Apr24-I finding 178: persist onboarding and filter-panel
          // state so a backup restore reproduces the full UI context.
          onboarding: signals.onboarding.value,
          filterExpanded: signals.filtersExpanded.value
        },
        // L83 (post-rev-13): snapshot from live signals, not `lsGet(...)`.
        // These four keys are registered with the debounced signal batcher
        // at signals.ts:1098, so a user change takes ~150ms to hit
        // localStorage. Reading via `lsGet` during that window captures
        // stale bytes even though the UI and in-memory state already
        // reflect the change — the rest of this payload (lines 283-297)
        // uses live signals, so without this fix `createBackup` had an
        // inconsistent snapshot boundary with itself AND with the manual
        // JSON export path in `buildExportData`.
        filterPresets: signals.filterPresets.value,
        txTemplates: signals.txTemplates.value,
        savingsContributions: signals.savingsContribs.value,
        alerts: signals.alerts.value,
        // CR-Apr22-F slice 1: snapshot SK.RECURRING directly from storage.
        // `saveRecurringTemplates()` writes through `safeStorage.setJSON`
        // synchronously (no debounced batcher), so storage is authoritative
        // at this moment — identical rationale to the L83 block above for
        // the four debounced-signal-backed keys, but via "read from
        // storage" instead of "read from signal" because recurring has no
        // signal. A restore that doesn't see this field (legacy backup)
        // falls back to the `normalizeBackupForImport` branch below which
        // omits `recurringTemplates` from the import payload, preserving
        // pre-fix behavior.
        recurringTemplates: safeStorage.getJSON<Record<string, RecurringTemplate>>(SK.RECURRING, {})
      }
    };
    
    // New-batch P3: the previous ordering computed `size` from a
    // stringify with `size: 0` in the metadata, then stored that
    // length on the object — but once `size` was assigned, the final
    // serialized bytes differed from the reported length by the
    // digit-count of the number itself. The checksum then ran over
    // the corrected bytes, but consumers reading `metadata.size` saw
    // the wrong number (and on boundary crossings — e.g. 9999→10000 —
    // the drift could be several bytes). Converge both fields on the
    // true final serialized length by iterating until size is a
    // fixed point. Bounded iterations defend against any pathological
    // oscillation at a power-of-ten boundary.
    let sizeStr = JSON.stringify(backupData);
    backupData.metadata.size = sizeStr.length;
    for (let iter = 0; iter < 8; iter++) {
      const nextStr = JSON.stringify(backupData);
      if (nextStr.length === backupData.metadata.size) {
        sizeStr = nextStr;
        break;
      }
      backupData.metadata.size = nextStr.length;
      sizeStr = nextStr;
    }
    // sizeStr now reflects the fixed-point serialization. Compute
    // checksum on that same bytestream (still checksum-free).
    backupData.metadata.checksum = await generateChecksum(sizeStr);

    // Phase 5g-1 (L18): removed the stale "compression is not currently used"
    // note — the compressData/decompressData helpers were deleted below. The
    // backup pipeline stores raw JSON, which is what `storeBackup` has always
    // persisted.

    // Store backup locally (retention follows user-configured schedule.retainCount; M16 fix).
    // Prior-batch P2: callers may override retention for this single write
    // — used by the restore-safety path to keep the source backup alive.
    const effectiveRetain = typeof retainOverride === 'number' && retainOverride > 0
      ? retainOverride
      : backupSchedule.retainCount;
    await storeBackup(backupData, effectiveRetain);

    // Update status
    backupStatus.inProgress = false;
    // Fixes H17: clear the TTL timestamp alongside inProgress so it
    // never outlives its paired flag.
    backupStatus.inProgressStartedAt = undefined;
    backupStatus.lastSuccess = Date.now();
    backupStatus.totalBackups++;
    backupStatus.totalSize += backupData.metadata.size;
    saveBackupStatus();
    
    // New-batch P2: update the backup-reminder signals whenever a
    // backup is successfully stored — not just on the manual export
    // path. Previously the auto-backup flow persisted a fresh snapshot
    // to IndexedDB but left `signals.lastBackup` and
    // `signals.lastBackupTxCount` untouched, so the reactive reminder
    // banner continued firing even though the user's data was safe.
    // Keeps the in-signal state synchronized with the actual backup
    // store. We reuse the same `now` / `currentTxCount` that were
    // stamped into the payload above, so the payload-on-restore and
    // the live reminder state agree byte-for-byte.
    signals.lastBackup.value = now;
    signals.lastBackupTxCount.value = currentTxCount;
    safeStorage.setJSON(BACKUP_REMINDER_TX_COUNT_KEY, currentTxCount);

    // Update last backup time. New-batch P3: the manual branch
    // previously skipped scheduleNextBackup, which meant a manual
    // backup right before a scheduled one would let the scheduled
    // timer fire immediately after — duplicating work and sometimes
    // racing on the backup-in-progress flag. Bump `lastBackup` and
    // reschedule on both paths so the scheduler honors the just-
    // completed work.
    backupSchedule.lastBackup = now;
    scheduleNextBackup();

    // Notify user if manual
    if (manual) {
      emit(Events.SHOW_TOAST, { message: `Backup saved \u2014 ${currentTxCount} transaction${currentTxCount === 1 ? '' : 's'}`, type: 'success' });
    }

    return backupData;
    
  } catch (error) {
    backupStatus.inProgress = false;
    // Fixes H17: clear the TTL timestamp on the error path too.
    backupStatus.inProgressStartedAt = undefined;
    backupStatus.lastError = error instanceof Error ? error.message : 'Unknown error';
    saveBackupStatus();

    trackError(error as Error, {
      module: 'backup',
      action: 'create_backup'
    });
    
    if (manual) {
      emit(Events.SHOW_TOAST, { message: 'Backup couldn\u2019t complete \u2014 check your storage space and try again.', type: 'error' });
    }
    
    return null;
  }
}

function snapshotStorageKeys(keys: string[]): Array<{ key: string; raw: string | null }> {
  return keys.map((key) => ({
    key,
    raw: safeStorage.getItem(key)
  }));
}

function restoreStorageSnapshot(snapshot: Array<{ key: string; raw: string | null }>): void {
  snapshot.forEach(({ key, raw }) => {
    if (raw === null) {
      safeStorage.removeItem(key);
    } else {
      safeStorage.setItem(key, raw);
    }
  });
}

function normalizeBackupForImport(backup: BackupData): Record<string, unknown> {
  const settings = backup.data.settings || {};

  // Rev 13 L71 (Inline-Behavior-Review):
  //
  // 1. Legacy `customCategories` forwarding. `buildImportState` has a compat
  //    branch that converts a legacy `CustomCategory[]` into a modern
  //    `UserCategoryConfig`, but the prior version of this function only
  //    passed `userCategories` through. Older auto-backups that still carry
  //    their cats under `customCategories` therefore fell through to
  //    `SK.USER_CATS = null` on overwrite restore, wiping the user's
  //    category config. Forwarding the field here delegates the legacy-
  //    shape decoding to the single compat branch in buildImportState.
  //
  // 2. `settings.alerts` fallback. `BackupSettings.alerts` is declared in the
  //    shape and `normalizeBackupSettings` preserves it, but the prior
  //    version of this function only read `backup.data.alerts` — so any
  //    backup variant that nested alert prefs under `settings.alerts`
  //    silently had them reset to defaults while every other setting
  //    restored cleanly. Fall back explicitly when the top-level field is
  //    absent.
  const alertPrefs = backup.data.alerts !== undefined
    ? backup.data.alerts
    : settings.alerts !== undefined
      ? settings.alerts
      : {};

  return {
    transactions: backup.data.transactions || [],
    savingsGoals: backup.data.savingsGoals || {},
    savingsContributions: backup.data.savingsContributions || [],
    monthlyAllocations: backup.data.monthlyAllocations || {},
    // Rev 13 L71: `userCategories` stays `undefined` when the field is
    // absent in the backup so `buildImportState` can fall through to the
    // `customCategories` legacy branch. Prior code coerced absent to
    // `null`, which made `importedUserCategories !== undefined` true in
    // the modern branch and forcibly skipped the compat path.
    userCategories: backup.data.userCategories,
    customCategories: backup.data.customCategories,
    debts: backup.data.debts || [],
    currency: settings.currency,
    rolloverSettings: settings.rolloverSettings,
    achievements: settings.achievements,
    streak: settings.streak,
    sections: settings.sections,
    theme: settings.theme,
    insightPersonality: settings.insightPersonality,
    filterPresets: backup.data.filterPresets || [],
    txTemplates: backup.data.txTemplates || [],
    // CR-Apr22-F slice 1 (+ slice-1 addendum for Finding #10): forward
    // SK.RECURRING through the import pipeline so `buildImportState`'s
    // recurringTemplates handler writes storage and `hydrateFromImport`
    // rebuilds the scheduler's in-memory Map.
    //
    // Coerce absent → `{}` here — this is the backup-restore branch,
    // which has FULL-SNAPSHOT semantics (unlike JSON import, which is
    // partial-import-friendly and preserves on absent). A legacy backup
    // predates recurring-template tracking entirely, so at the moment
    // that backup was captured the persisted recurring-template set
    // was effectively empty. Restoring it must therefore leave the
    // device with NO templates, not the user's current interim set —
    // otherwise the rest of the account overwrites to the old snapshot
    // while stale local templates survive and now reference categories
    // or series the restored ledger no longer knows about.
    //
    // The tri-state preserve-on-absent contract in `buildImportState`
    // is still correct for JSON imports (where a user may paste a
    // transactions-only slice). It does NOT belong on the backup
    // restore path, which is what this normalizer serves exclusively
    // (`restoreBackup` + `importBackup` are its only callers).
    recurringTemplates: backup.data.recurringTemplates ?? {},
    alertPrefs,
    lastBackup: settings.lastBackup ?? null,
    // CR-Apr24-I finding 188: route lastBackupTxCount through the atomic
    // import pipeline instead of writing it as a side-effect in restoreBackup.
    lastBackupTxCount: settings.lastBackupTxCount ?? null,
    // CR-Apr24-I finding 178: persist onboarding and filter-panel state
    // through the import pipeline for full round-trip fidelity.
    onboarding: settings.onboarding,
    filterExpanded: settings.filterExpanded
  };
}

/**
 * Validate that an unknown value has the shape of a BackupData payload.
 *
 * Prior-batch P2: the prior version only checked `Array.isArray(transactions)`
 * — an array of garbage (nulls, numbers, objects with no fields) would
 * pass the gate and reach `replaceAllTransactions` downstream, where
 * failures were harder to surface and often silent. The import and
 * restore paths now both route accepted backups through
 * `sanitizeImportedTransactions`, but this guard stays as the first
 * line of defense: a backup whose transaction array is 100% garbage
 * should be rejected as "invalid backup" before anyone commits to
 * importing or restoring it. We therefore require at least one row
 * that looks structurally like a transaction (object with a few
 * required string/number fields) to pass. Fully empty transaction
 * arrays still pass — that's a legitimate "fresh install" backup.
 */
function hasValidBackupShape(backup: unknown): backup is BackupData {
  if (!backup || typeof backup !== 'object') return false;

  const candidate = backup as Partial<BackupData>;
  const metadata = candidate.metadata as Partial<BackupMetadata> | undefined;
  const data = candidate.data;

  const metadataOk = !!(
    metadata &&
    typeof metadata.id === 'string' &&
    typeof metadata.timestamp === 'number' &&
    typeof metadata.version === 'string' &&
    typeof metadata.deviceId === 'string' &&
    typeof metadata.transactionCount === 'number' &&
    typeof metadata.size === 'number'
  );
  if (!metadataOk) return false;
  if (!data || !Array.isArray(data.transactions)) return false;

  // Per-item gate: if the array has rows, at least one must look like
  // a transaction. Empty arrays (legitimate for a newly-created
  // account) pass.
  if (data.transactions.length > 0) {
    const anyValidRow = data.transactions.some(row => {
      if (!row || typeof row !== 'object') return false;
      const r = row as unknown as Record<string, unknown>;
      // Minimum fields the sanitizer's validator will look for:
      // amount (number), date (string), type (string), and at least
      // one of category/description for user-visible context. Accept
      // rows with a stable id field too (__backendId or id).
      const hasAmount = typeof r.amount === 'number' && Number.isFinite(r.amount);
      const hasDate = typeof r.date === 'string' && r.date.length > 0;
      const hasType = typeof r.type === 'string' && r.type.length > 0;
      return hasAmount && hasDate && hasType;
    });
    if (!anyValidRow) return false;
  }

  return true;
}

/**
 * L85 (post-rev-13) — normalization split out of `hasValidBackupShape`.
 *
 * The original M20 fix normalised `data.settings` inside the validator,
 * but that mutated the parsed payload *before* `verifyBackupChecksum`
 * saw it. The checksum was computed over the original file contents,
 * so any backup whose settings required normalisation (legacy theme
 * tokens, missing `alertPrefs` fields, etc.) failed integrity
 * verification even though the signed file was intact — turning a
 * valid import into "Backup integrity check failed".
 *
 * Callers now verify the checksum against the *original* parsed payload
 * first, then call this to normalise settings before downstream reads.
 * Keeps the M20 protection (downstream consumers still see a well-typed
 * `BackupSettings`) without violating the "don't mutate a signed
 * payload before verification" rule.
 */
function applyBackupNormalization(backup: BackupData): void {
  backup.data.settings = normalizeBackupSettings((backup.data as { settings?: unknown }).settings);
}

async function verifyBackupChecksum(backup: BackupData): Promise<boolean> {
  // Security: a missing checksum field must be treated as a verification
  // failure. Returning true here would allow corrupted or malicious backup
  // files to bypass integrity validation simply by omitting the field.
  if (!backup.metadata.checksum) return false;

  const savedChecksum = backup.metadata.checksum;
  const verifyClone = JSON.parse(JSON.stringify(backup)) as BackupData;
  delete verifyClone.metadata.checksum;
  const checksum = await generateChecksum(JSON.stringify(verifyClone));
  return checksum === savedChecksum;
}

function scheduleBackupTimer(targetTime: number): void {
  const remainingMs = targetTime - Date.now();
  if (remainingMs <= 0) {
    scheduledBackupTimer = window.setTimeout(() => {
      void performScheduledBackup();
    }, 0);
    return;
  }

  const nextDelay = Math.min(remainingMs, MAX_TIMEOUT_MS);
  scheduledBackupTimer = window.setTimeout(() => {
    if (remainingMs > MAX_TIMEOUT_MS) {
      scheduleBackupTimer(targetTime);
      return;
    }
    void performScheduledBackup();
  }, nextDelay);
}

// ==========================================
// BACKUP RESTORATION
// ==========================================

/**
 * Restore from a backup
 */
// CR-Apr24-I finding 198: `suppressToast` lets callers like importBackup
// suppress the internal success toast to avoid duplicate confirmations.
export async function restoreBackup(
  backupId: string,
  options?: { suppressToast?: boolean }
): Promise<boolean> {
  try {
    const backup = await getIndexedDbBackup(backupId);
    
    if (!backup) {
      throw new Error('Backup not found');
    }
    
    // Verify checksum if present
    if (!(await verifyBackupChecksum(backup))) {
      throw new Error('Backup integrity check failed');
    }
    
    // Prior-batch P2: the safety backup must not evict the source
    // backup. When `backupSchedule.retainCount` is low (e.g. 1) and
    // the user has exactly one existing backup — the one they're
    // restoring from — `storeBackup` trims the oldest on write, which
    // is the source backup itself. The in-memory `backup` object above
    // is already safely captured, so the restore itself succeeds; the
    // damage is to the user-visible backup list after a successful
    // restore. Bumping retention by 1 for the safety write keeps both
    // backups (source + safety) present; the next regular scheduled
    // backup trims back down per the user's configured retention.
    // Defensive: if the count read fails (broken IDB), fall back to
    // the configured retention so we don't block the restore entirely.
    let existingCount = 0;
    try {
      const existingBackups = await getIndexedDbBackups();
      if (Array.isArray(existingBackups)) {
        existingCount = existingBackups.length;
      }
    } catch {
      existingCount = 0;
    }
    const safetyRetain = Math.max(backupSchedule.retainCount, existingCount + 1);
    const safetyBackup = await createBackup(true, safetyRetain);
    if (!safetyBackup) {
      throw new Error('Failed to create safety backup before restore');
    }

    const importData = normalizeBackupForImport(backup);
    const rawTransactions = Array.isArray(importData.transactions)
      ? (importData.transactions as unknown[])
      : [];
    // Prior-batch P2: restore path bypassed the sanitizer. The IDB
    // payload passed `hasValidBackupShape`, but that gate is shallow
    // (array check only) — corrupted rows would reach
    // `replaceAllTransactions` and either crash downstream hydration
    // or silently propagate bad state. Route through the same
    // `sanitizeImportedTransactions` + `reportImportValidationRejections`
    // pipeline the JSON import path uses, so partial corruption
    // surfaces a warning toast + telemetry instead of silently failing.
    const sanitizeResult = sanitizeImportedTransactions(rawTransactions);
    const transactions = sanitizeResult.accepted;
    reportImportValidationRejections(
      sanitizeResult.rejected,
      rawTransactions.length,
      'backup_restore'
    );
    const { newS, writes, theme } = buildImportState(importData, 'overwrite', transactions);
    const snapshot = snapshotStorageKeys(writes.map(({ key }) => key));

    if (!(await tryAtomicWrite(writes))) {
      throw new Error('Storage write failed');
    }

    const replaceResult = await dataSdk.replaceAllTransactions(transactions);
    if (!replaceResult.isOk) {
      restoreStorageSnapshot(snapshot);
      throw new Error(replaceResult.error || 'Storage write failed');
    }

    // Fixes H18: surface partial-hydration failures from the auto-backup
    // restore path too. Transactions went through replaceAllTransactions()
    // above; this guards the settings/theme/alloc/savings/etc. signal hydrate.
    const hydrationResult = hydrateFromImport(newS, transactions);
    const hadPartialFailure = hydrationResult.failed.length > 0;
    if (hadPartialFailure) {
      const failedNames = hydrationResult.failed.map(f => f.propertyName).join(', ');
      emit(Events.SHOW_TOAST, {
        message: `Restored ${hydrationResult.succeeded} of ${hydrationResult.attempted} sections. Skipped: ${failedNames}.`,
        type: 'warning'
      });
    }
    // M20: run returned theme through the same validator as
    // normalizeBackupSettings so a corrupted backup that squeaked past
    // the settings normalizer (e.g. `d.theme` at the top level of the
    // import shape) still can't feed a bogus string into setTheme.
    const validatedTheme = normalizeBackupTheme(theme);
    if (validatedTheme) {
      setTheme(validatedTheme);
    }

    const restoredBackupTxCount = Number(backup.data.settings?.lastBackupTxCount ?? 0) || 0;
    signals.lastBackupTxCount.value = restoredBackupTxCount;
    safeStorage.setJSON(BACKUP_REMINDER_TX_COUNT_KEY, restoredBackupTxCount);

    emit(Events.DATA_IMPORTED);
    // Rev 13 L74 (Inline-Behavior-Review): only claim "restored
    // successfully" when the hydration hit 100%. A partial failure
    // already surfaced a warning toast above; trailing a success
    // message after it flatly contradicts the warning and lulls
    // users into believing the settings they see are the ones they
    // saved. When some sections are skipped, the warning is the
    // final word.
    if (!hadPartialFailure && !options?.suppressToast) {
      emit(Events.SHOW_TOAST, { message: 'Backup restored successfully', type: 'success' });
    }

    return true;
    
  } catch (error) {
    trackError(error as Error, {
      module: 'backup',
      action: 'restore_backup'
    });
    
    emit(Events.SHOW_TOAST, { message: 'Restore couldn\u2019t complete \u2014 the backup file may be damaged. Try a different backup.', type: 'error' });
    return false;
  }
}

// ==========================================
// BACKUP SCHEDULING
// ==========================================

/**
 * Enable automatic backups
 */
export function enableAutoBackup(
  frequency: BackupSchedule['frequency'] = 'daily',
  time: string = '02:00'
): void {
  backupSchedule = {
    enabled: true,
    frequency,
    time,
    retainCount: 7
  };
  
  saveBackupSchedule();
  scheduleNextBackup();
  
  emit(Events.SHOW_TOAST, { message: 'Automatic backups enabled', type: 'success' });
}

/**
 * Disable automatic backups
 */
export function disableAutoBackup(): void {
  backupSchedule.enabled = false;
  saveBackupSchedule();
  
  if (scheduledBackupTimer) {
    clearTimeout(scheduledBackupTimer);
    scheduledBackupTimer = null;
  }
  
  emit(Events.SHOW_TOAST, { message: 'Automatic backups disabled', type: 'info' });
}

/**
 * Schedule the next backup
 */
function scheduleNextBackup(): void {
  if (!backupSchedule.enabled) return;
  
  // Clear existing timer
  if (scheduledBackupTimer) {
    clearTimeout(scheduledBackupTimer);
  }
  
  // Calculate next backup time.
  // Phase 6 Slice 1i (rev 12 L6): split components are `number | undefined`
  // under `noUncheckedIndexedAccess`; defaults to 0 (midnight) keep
  // `setHours` argument well-typed for malformed inputs.
  const now = new Date();
  const [hours = 0, minutes = 0] = backupSchedule.time.split(':').map(Number);
  const nextBackup = new Date();
  nextBackup.setHours(hours, minutes, 0, 0);
  
  // If time has passed today, schedule for tomorrow
  if (nextBackup.getTime() <= now.getTime()) {
    nextBackup.setDate(nextBackup.getDate() + 1);
  }
  
  // Adjust based on frequency
  if (backupSchedule.frequency === 'weekly') {
    // Schedule for next Sunday
    const daysUntilSunday = (7 - nextBackup.getDay()) % 7;
    if (daysUntilSunday > 0) {
      nextBackup.setDate(nextBackup.getDate() + daysUntilSunday);
    }
  } else if (backupSchedule.frequency === 'monthly') {
    // Schedule for first of next month
    nextBackup.setDate(1);
    if (nextBackup.getTime() <= now.getTime()) {
      nextBackup.setMonth(nextBackup.getMonth() + 1);
    }
  }
  
  backupSchedule.nextBackup = nextBackup.getTime();
  saveBackupSchedule();
  
  // Browsers clamp long delays, so chunk monthly schedules safely.
  scheduleBackupTimer(nextBackup.getTime());
}

/**
 * Perform a scheduled backup.
 *
 * Re-checks `backupSchedule.enabled` at fire time so a timer queued under the
 * old schedule doesn't execute after the user disables auto-backup mid-interval
 * (disable/timer-fire race). Fixes L19 (Inline-Behavior-Review rev 12).
 */
async function performScheduledBackup(): Promise<void> {
  if (!backupSchedule.enabled) return;
  await createBackup(false);
  scheduleNextBackup();
}

// ==========================================
// BACKUP EXPORT/IMPORT
// ==========================================

/**
 * Export backup to file
 */
export async function exportBackup(backupId?: string): Promise<void> {
  try {
    let backup: BackupData | null;
    
    if (backupId) {
      backup = await getIndexedDbBackup(backupId);
    } else {
      // Create new backup
      backup = await createBackup(true);
    }
    
    if (!backup) {
      throw new Error('No backup available');
    }
    
    const dataStr = JSON.stringify(backup, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const filename = `budget-backup-${getTodayStr()}-${backup.metadata.id.slice(0, 8)}.json`;

    // New-batch P2: claiming "exported successfully" before the user
    // has confirmed the browser download is a false signal — the user
    // may have cancelled the native save dialog. `downloadBlob` uses
    // an anchor-click fallback that has no confirmation hook, so the
    // best honest phrasing is "download ready" (which describes what
    // actually happened). A richer confirmation would require routing
    // through the File System Access API path (see `triggerJsonExport`
    // in import-export-events.ts for the confirmed-write pattern);
    // until that's wired here too, don't overclaim.
    downloadBlob(blob, filename);
    emit(Events.SHOW_TOAST, { message: 'Backup download started', type: 'success' });

  } catch (error) {
    trackError(error as Error, {
      module: 'backup',
      action: 'export_backup'
    });
    
    emit(Events.SHOW_TOAST, { message: 'Export couldn\u2019t complete \u2014 check your storage space and try again.', type: 'error' });
  }
}

/**
 * Import backup from file
 */
export async function importBackup(file: File): Promise<boolean> {
  try {
    if (file.size > MAX_BACKUP_IMPORT_BYTES) {
      throw new Error('Backup file is too large');
    }

    const text = await file.text();
    const parsed = JSON.parse(text) as unknown;
    if (!hasValidBackupShape(parsed)) {
      throw new Error('Invalid backup file');
    }

    const backup = parsed;
    // L85: checksum verification MUST run against the original parsed
    // payload, before any normalisation mutates it. Swapping this order
    // with `applyBackupNormalization` below would cause every legacy
    // backup whose settings need normalisation to fail integrity.
    if (!(await verifyBackupChecksum(backup))) {
      throw new Error('Backup integrity check failed');
    }

    // Normalise settings only AFTER the signed payload has been verified.
    // Preserves the M20 "downstream consumers see well-typed settings"
    // guarantee without breaking checksum-based integrity.
    applyBackupNormalization(backup);

    // Recompute the checksum so the stored (normalised) payload remains
    // self-consistent for the later `restoreBackup` verify pass. Without
    // this step, the IndexedDB copy would carry the ORIGINAL checksum
    // against NORMALISED bytes — reintroducing the same mismatch on the
    // restore side. Only regenerate when the original backup was signed;
    // unsigned backups stay unsigned.
    if (backup.metadata.checksum) {
      const verifyClone = JSON.parse(JSON.stringify(backup)) as BackupData;
      delete verifyClone.metadata.checksum;
      backup.metadata.checksum = await generateChecksum(JSON.stringify(verifyClone));
    }

    // Prior-batch P2: prompt BEFORE storing. The earlier ordering
    // persisted the imported backup to IDB immediately (evicting the
    // user's oldest existing backup under tight retention) and THEN
    // asked whether to restore — so a user who cancelled the restore
    // had already lost one of their existing backups in exchange for
    // a file they never committed to keeping. Now the import is
    // treated as two distinct intents: (1) "do you want to bring this
    // backup into your local storage, committing to a restore right
    // after?" — prompted first; (2) the actual storage + restore —
    // only when the user confirms. If the user cancels, the file is
    // unchanged on disk and the user can re-import.
    //
    // Design-Review-Apr21 P2 (batch 6 follow-up): the prior copy
    // described the replacement scope (transactions, categories,
    // budgets, savings goals, debts, settings) in `details`. That copy
    // is preserved here; the only line removed is the now-false claim
    // that the backup is "already saved locally" — it isn't until the
    // user confirms.
    const { asyncConfirm } = await import('../../ui/components/async-modal.js');
    const shouldRestore = await asyncConfirm({
      title: 'Restore Imported Backup',
      message: 'Restore this backup now? This will replace all of your current data.',
      details: 'Restoring will overwrite your current transactions, categories, budgets, savings goals, debts, and settings with this backup\u2019s contents.',
      type: 'warning',
      confirmText: 'Replace & Restore',
      cancelText: 'Cancel'
    });
    if (!shouldRestore) {
      emit(Events.SHOW_TOAST, { message: 'Import cancelled', type: 'info' });
      return true;
    }

    // CR-Apr24-I finding 192: ensure the freshly imported backup isn't
    // evicted by its own storeBackup trim. Use existingCount + 1 so the
    // imported record survives for the immediately following restore.
    let existingImportCount = 0;
    try {
      const existing = await getIndexedDbBackups();
      if (Array.isArray(existing)) existingImportCount = existing.length;
    } catch { /* fall through — 0 is safe */ }
    const importRetain = Math.max(backupSchedule.retainCount, existingImportCount + 1);
    await storeBackup(backup, importRetain);

    // CR-Apr24-I finding 193: defer success toast until restore actually
    // completes. The old ordering emitted "imported successfully" before
    // restoreBackup, producing a contradictory success→error sequence
    // when the restore failed.
    // CR-Apr24-I finding 198: pass suppressToast to avoid the duplicate
    // "Backup restored successfully" toast — importBackup emits its own.
    const restored = await restoreBackup(backup.metadata.id, { suppressToast: true });
    if (restored) {
      emit(Events.SHOW_TOAST, { message: 'Backup imported successfully', type: 'success' });
    }
    return restored;
    
  } catch (error) {
    trackError(error as Error, {
      module: 'backup',
      action: 'import_backup'
    });
    
    emit(Events.SHOW_TOAST, { message: 'Import couldn\u2019t complete \u2014 make sure the file is a valid Harbor Ledger backup.', type: 'error' });
    return false;
  }
}

// ==========================================
// UTILITIES
// ==========================================

/**
 * Get or create device ID
 */
function getOrCreateDeviceId(): string {
  const stored = localStorage.getItem('harbor_device_id');
  if (stored) return stored;
  
  const id = generateId();
  localStorage.setItem('harbor_device_id', id);
  return id;
}

/**
 * Generate checksum for data
 */
async function generateChecksum(data: string): Promise<string> {
  if (crypto.subtle) {
    const encoder = new TextEncoder();
    const dataBuffer = encoder.encode(data);
    const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }
  
  // Fallback to simple checksum
  let hash = 0;
  for (let i = 0; i < data.length; i++) {
    const char = data.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16);
}

// Phase 5g-1 (Inline-Behavior-Review rev 12, L18): deleted `compressData`
// (~80 LOC, CompressionStream + dictionary-LZ fallback) and `decompressData`
// (~55 LOC, DecompressionStream + dictionary decode). Grep across js/
// confirms zero callers: the writer path (`performScheduledBackup`) passed
// raw JSON straight to `storeBackup`, and the reader path
// (`restoreFromBackup`) consumed `backupData.data` directly from IndexedDB
// without ever running decompression. The H3 fix (trackError on gzip
// failure) that this version added is preserved in spirit — it was correct
// for the code that existed, but since that code is gone, there is no gzip
// branch left to track. If compression is revisited, bring it back
// deliberately with a persistence wire-up; don't resurrect this.

/**
 * Get backup schedule
 */
function getBackupSchedule(): BackupSchedule {
  return lsGet<BackupSchedule>(BACKUP_SCHEDULE_KEY, {
    enabled: false,
    frequency: 'daily',
    time: '02:00',
    retainCount: 7
  });
}

/**
 * Save backup schedule
 */
function saveBackupSchedule(): void {
  lsSet(BACKUP_SCHEDULE_KEY, backupSchedule);
}

/**
 * Get backup status
 */
function getBackupStatus(): BackupStatus {
  return lsGet<BackupStatus>(BACKUP_STATUS_KEY, {
    inProgress: false,
    totalBackups: 0,
    totalSize: 0
  });
}

/**
 * Save backup status
 */
function saveBackupStatus(): void {
  lsSet(BACKUP_STATUS_KEY, backupStatus);
}

/**
 * Get all backups
 */
export async function getAllBackups(): Promise<BackupData[]> {
  return getIndexedDbBackups();
}

/**
 * Delete a backup
 */
export async function deleteBackup(backupId: string): Promise<boolean> {
  try {
    const deleted = await deleteIndexedDbBackup(backupId);
    if (!deleted) return false;
    
    emit(Events.SHOW_TOAST, { message: 'Backup deleted', type: 'info' });
    return true;
    
  } catch (error) {
    trackError(error as Error, {
      module: 'backup',
      action: 'delete_backup'
    });
    return false;
  }
}

// ==========================================
// INITIALIZATION
// ==========================================

/**
 * Initialize automatic backup system
 */
export function initializeAutoBackup(): void {
  // Load saved schedule
  backupSchedule = getBackupSchedule();
  backupStatus = getBackupStatus();

  // Fixes H17 (Inline-Behavior-Review rev 12): boot-time sweep so a stuck
  // inProgress flag (tab/OS crash, laptop closed mid-backup) is cleared on
  // the very next session boot rather than waiting for the user to trigger
  // a backup manually. Without this sweep the scheduled-backup timer fires,
  // hits the inProgress guard, silently no-ops, and the user notices nothing.
  recoverStaleInProgress();

  // Schedule next backup if enabled
  if (backupSchedule.enabled) {
    scheduleNextBackup();
  }
  
  // Listen for manual backup requests
  window.addEventListener('request-backup', () => {
    void createBackup(true);
  });

  // Listen for restore requests
  window.addEventListener('restore-backup', ((event: CustomEvent) => {
    if (event.detail?.backupId) {
      void restoreBackup(event.detail.backupId);
    }
  }) as EventListener);
}
