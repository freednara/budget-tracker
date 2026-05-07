/**
 * Storage Events Module
 *
 * Multi-tab synchronization via localStorage storage events.
 * Extracted from app.ts to reduce file size and improve maintainability.
 *
 * @module storage-events
 */
'use strict';

import { SK, lsGet, normalizeAlertPrefs, BACKUP_REMINDER_TX_COUNT_KEY } from '../../core/state.js';
import { syncState } from '../../core/state-actions.js';
import { shouldShowPinLock, showPinLock, hidePinLock, updateClearPinVisibility } from '../widgets/pin-ui-handlers.js';
import { startAutoLockIfNeeded, stopAutoLockIfActive } from '../../features/security/auto-lock.js';
import { loadRecurringTemplates } from '../../data/recurring-templates.js';
import * as signals from '../../core/signals.js';
import { trackError } from '../../core/error-tracker.js';
import type { Theme, CurrencySettings, RolloverSettings, StreakData, SavingsGoal, SavingsContribution, FilterPreset, TxTemplate, InsightPersonality, SectionsConfig } from '../../../types/index.js';

// ==========================================
// TYPE DEFINITIONS
// ==========================================

type VoidCallback = () => void;

type OnboardingState = typeof signals.onboarding.value;

interface StorageEventCallbacks {
  refreshAll: VoidCallback;
  updateSummary: VoidCallback;
  renderSavingsGoals: VoidCallback;
  checkAlerts: VoidCallback;
  updateInsights: VoidCallback;
  renderBadges: VoidCallback;
  renderStreak: VoidCallback;
  renderFilterPresets: VoidCallback;
  renderTemplates: VoidCallback;
}

// ==========================================
// MODULE STATE
// ==========================================

// Phase 6 cleanup: removed the module-level `callbacks` slot. It was
// written on init and cleared on cleanup but never read. The callback
// object flows through the storage-event closure directly.

// Store previous handler for cleanup on re-init
let _storageHandler: ((e: StorageEvent) => void) | null = null;

const SUPPORTED_INSIGHT_PERSONALITIES = new Set<InsightPersonality>([
  'serious',
  'friendly',
  'roast',
  'casual',
  'motivating'
]);

const DEFAULT_ONBOARDING_STATE: OnboardingState = {
  active: false,
  step: 0,
  completed: false
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function isOnboardingState(value: unknown): value is OnboardingState {
  if (!isPlainObject(value)) return false;
  return (
    typeof value.active === 'boolean' &&
    typeof value.completed === 'boolean' &&
    typeof value.step === 'number' &&
    Number.isInteger(value.step) &&
    value.step >= 0
  );
}

function trackInvalidStoragePayload(key: string): void {
  try {
    trackError(new Error(`storage-events payload validation failed for '${key}'`), {
      module: 'storage-events',
      action: `invalid:${key}`
    });
  } catch {
    // Telemetry failure must never break sync handling.
  }
}

function normalizeInsightPersonality(value: unknown): InsightPersonality {
  if (typeof value === 'string' && SUPPORTED_INSIGHT_PERSONALITIES.has(value as InsightPersonality)) {
    return value as InsightPersonality;
  }
  return 'serious';
}

export function cleanupStorageEvents(): void {
  if (_storageHandler) {
    window.removeEventListener('storage', _storageHandler);
    _storageHandler = null;
  }
}

// ==========================================
// PUBLIC API
// ==========================================

/**
 * Initializes storage event listener for multi-tab synchronization.
 */
export function initStorageEvents(cb: StorageEventCallbacks): void {
  // Fixes L35 (Inline-Behavior-Review rev 12): the original code did
  // `callbacks = cb` here, then `cleanupStorageEvents()` (which nulls
  // callbacks), then `callbacks = cb` again — a redundant assignment that
  // was a magnet for "why is this set twice?" reviewer time. Cleanup
  // must run before we re-register so that the previous tab-sync
  // listener is detached.
  cleanupStorageEvents();

  _storageHandler = (e: StorageEvent) => {
    // CR-Apr24-I finding 194: also admit BACKUP_REMINDER_TX_COUNT_KEY
    // which lives outside the SK enum but is a first-class persisted key.
    if (!e.key || (!Object.values(SK).includes(e.key) && e.key !== BACKUP_REMINDER_TX_COUNT_KEY)) return;

    switch (e.key) {
      case SK.THEME:
        // Fixes L35 (Inline-Behavior-Review rev 12, second half): theme
        // updates from another tab used to call `setTheme(...)` directly,
        // bypassing syncState.applyKeyUpdate. That meant THEME (which IS
        // in the ADR-001 SYNC_ALLOWED_KEYS allowlist) skipped revision
        // counting + isTheme() validation and silently accepted any
        // string. Routing through applyKeyUpdate now matches every other
        // SK.* case in this switch.
        syncState.applyKeyUpdate(SK.THEME, lsGet(SK.THEME, 'dark') as Theme);
        break;

      case SK.PIN: {
        // If PIN changed in another tab, re-check lock status.
        try {
          syncState.applyKeyUpdate(SK.PIN, JSON.parse(e.newValue || '""') || '');
        } catch {
          syncState.applyKeyUpdate(SK.PIN, e.newValue || '');
        }

        // CR-Apr24-D1 [P2/P3] findings 150, 151, 155, 163: handle BOTH
        // directions of the PIN-change cross-tab message and keep the
        // local app state coherent.
        //
        //   PIN added remotely  → start local auto-lock so coverage matches
        //                         (151) AND refresh Settings visibility (163).
        //                         Lock overlay is NOT shown — current tab is
        //                         already in active use; auto-lock kicks in
        //                         after the configured inactivity timeout.
        //   PIN cleared remotely → tear down auto-lock (155), hide overlay
        //                          if currently locked (150), refresh
        //                          Settings visibility (163).
        //   shouldShowPinLock() (legacy positive branch from Apr-21):
        //     tab was unlocked when remote ADDED a PIN — the original
        //     code locked the tab in this case. We preserve that as
        //     defense-in-depth: the active user just had a PIN imposed
        //     from somewhere else, so locking is the safest default.
        const pinNowSet = !!signals.pin.value;

        if (pinNowSet) {
          // Start auto-lock if not already running. Idempotent — repeated
          // remote pin-set events don't stack listeners.
          startAutoLockIfNeeded(() => {
            showPinLock();
          });
          if (shouldShowPinLock()) {
            showPinLock();
          }
        } else {
          // Remote clear: tear down auto-lock + hide any active lock
          // overlay so this tab isn't stuck behind a PIN that no longer
          // exists at the storage layer.
          stopAutoLockIfActive();
          hidePinLock();
        }

        // Keep the Settings "Turn Off PIN" button in lockstep regardless
        // of direction (idempotent DOM read + flag set).
        updateClearPinVisibility();
        break;
      }

      case SK.ALLOC:
        syncState.applyKeyUpdate(SK.ALLOC, lsGet(SK.ALLOC, {}) as Record<string, Record<string, number>>);
        break;

      case SK.SAVINGS:
        syncState.applyKeyUpdate(SK.SAVINGS, lsGet(SK.SAVINGS, {}) as Record<string, SavingsGoal>);
        break;

      case SK.USER_CATS:
        // Fixes H8 (Inline-Behavior-Review rev 12): dropped the double-cast.
        // applyKeyUpdate runs isUserCategoryConfig() structural validation
        // (per C6) and now routes rejections through trackError (per H8), so
        // a corrupted localStorage payload lands as a telemetry'd no-op
        // instead of poisoning the category store.
        syncState.applyKeyUpdate(SK.USER_CATS, lsGet(SK.USER_CATS, null));
        break;

      case SK.DEBTS:
        syncState.applyKeyUpdate(SK.DEBTS, lsGet(SK.DEBTS, []) as unknown[]);
        cb.refreshAll();
        break;

      case SK.CURRENCY:
        const nextCurrency = lsGet(SK.CURRENCY, { home: 'USD', symbol: '$' }) as CurrencySettings;
        syncState.applyKeyUpdate(SK.CURRENCY, nextCurrency);
        cb.refreshAll();
        break;

      case SK.SAVINGS_CONTRIB:
        syncState.applyKeyUpdate(SK.SAVINGS_CONTRIB, lsGet(SK.SAVINGS_CONTRIB, []) as SavingsContribution[]);
        cb.updateSummary();
        cb.renderSavingsGoals();
        break;

      case SK.ROLLOVER_SETTINGS:
        syncState.applyKeyUpdate(
          SK.ROLLOVER_SETTINGS,
          lsGet(SK.ROLLOVER_SETTINGS, { enabled: false, mode: 'all', categories: [], maxRollover: null, negativeHandling: 'zero' }) as RolloverSettings
        );
        cb.refreshAll();
        break;

      case SK.SECTIONS:
        // CR-Apr24-I finding 195: fallback shape must include both fields
        // required by SectionsConfig, otherwise applyKeyUpdate rejects it.
        syncState.applyKeyUpdate(SK.SECTIONS, lsGet(SK.SECTIONS, { envelope: true, transactionsTemplates: false }) as SectionsConfig);
        cb.refreshAll();
        break;

      case SK.ALERTS:
        syncState.applyKeyUpdate(SK.ALERTS, normalizeAlertPrefs(lsGet(SK.ALERTS, null)));
        cb.checkAlerts();
        break;

      case SK.INSIGHT_PERS:
        syncState.applyKeyUpdate(SK.INSIGHT_PERS, normalizeInsightPersonality(lsGet(SK.INSIGHT_PERS, 'serious')));
        cb.updateInsights();
        break;

      case SK.ACHIEVE:
        // CR-Apr24-E [P2] finding 218: drop the legacy
        // `Record<string, boolean>` cast. The runtime persists
        // `Record<string, EarnedAchievement>` ({earned, date}); the
        // sync-state validator (CR-Apr24-E finding 217) now rejects
        // boolean-shaped payloads, so feeding them in here would
        // turn this whole branch into a silent no-op (legitimate
        // remote awards rejected at the gate). Pass the raw value;
        // the validator does the structural check.
        syncState.applyKeyUpdate(SK.ACHIEVE, lsGet(SK.ACHIEVE, {}));
        cb.renderBadges();
        break;

      case SK.STREAK:
        syncState.applyKeyUpdate(SK.STREAK, lsGet(SK.STREAK, { current: 0, longest: 0, lastDate: '' }) as StreakData);
        cb.renderStreak();
        break;

      case SK.FILTER_PRESETS:
        syncState.applyKeyUpdate(SK.FILTER_PRESETS, lsGet(SK.FILTER_PRESETS, []) as FilterPreset[]);
        cb.renderFilterPresets();
        break;

      case SK.TX_TEMPLATES:
        syncState.applyKeyUpdate(SK.TX_TEMPLATES, lsGet(SK.TX_TEMPLATES, []) as TxTemplate[]);
        cb.renderTemplates();
        break;

      // CR-Apr24-I finding 194: sync backup-reminder state across tabs
      // so sibling tabs don't keep stale "last backup" age baselines.
      case SK.LAST_BACKUP: {
        const lastBackup = lsGet(SK.LAST_BACKUP, 0);
        const normalized = typeof lastBackup === 'number' && Number.isFinite(lastBackup) ? lastBackup : 0;
        signals.lastBackup.value = normalized;
        break;
      }

      // CR-Apr24-I finding 203: sync recurring-template changes across
      // tabs. The in-memory Map is only loaded on module init, so a tab
      // that adds/edits/deletes a recurring series leaves sibling tabs
      // stale until reload. Re-loading from storage fixes this.
      case SK.RECURRING:
        loadRecurringTemplates();
        break;

      // CR-Apr24-I finding 199: sync onboarding state across tabs so a
      // tab that starts/completes onboarding doesn't leave siblings stale.
      case SK.ONBOARD: {
        const nextOnboarding = lsGet(SK.ONBOARD, DEFAULT_ONBOARDING_STATE);
        if (isOnboardingState(nextOnboarding)) {
          signals.onboarding.value = { ...nextOnboarding };
        } else {
          trackInvalidStoragePayload(SK.ONBOARD);
        }
        break;
      }

      // CR-Apr24-I finding 200: sync filter-panel expansion across tabs.
      case SK.FILTER_EXPANDED: {
        const nextExpanded = lsGet(SK.FILTER_EXPANDED, false);
        if (typeof nextExpanded === 'boolean') {
          signals.filtersExpanded.value = nextExpanded;
        } else {
          trackInvalidStoragePayload(SK.FILTER_EXPANDED);
        }
        break;
      }

      // CR-Apr24-I finding 204: warn on admitted-but-unhandled keys in
      // dev mode so new SK entries don't silently drop cross-tab sync.
      default:
        if (import.meta.env?.DEV) {
          console.warn(`[storage-events] Admitted SK key has no handler: ${e.key}`);
        }
        break;
    }

    // CR-Apr24-I finding 194 (continued): BACKUP_REMINDER_TX_COUNT_KEY
    // is outside the SK enum so it doesn't match any switch case above.
    // Handle it after the switch.
    if (e.key === BACKUP_REMINDER_TX_COUNT_KEY) {
      const raw = lsGet(BACKUP_REMINDER_TX_COUNT_KEY, 0);
      const n = typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 0;
      signals.lastBackupTxCount.value = n;
    }
  };

  window.addEventListener('storage', _storageHandler);
}
