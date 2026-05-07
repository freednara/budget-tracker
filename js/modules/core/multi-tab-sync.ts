/**
 * Multi-Tab Synchronization Module
 * 
 * Handles synchronization of state across multiple browser tabs/windows.
 * Delegates responsibility to specialized sub-modules for broadcast, 
 * conflict resolution, and activity tracking.
 * 
 * @module multi-tab-sync
 */

import { SK, lsGet, lsSet } from './state.js';
import * as signals from './signals.js';
import { syncState } from './state-actions.js';
import { debounce } from './utils-pure.js';
import { DataSyncEvents, requestDataApplyDelta, requestDataReload, type TransactionDataDelta } from './data-sync-interface.js';
import { broadcastManager, type AtomicSyncBundle } from './multi-tab-sync-broadcast.js';
import { on, emit, Events } from './event-bus.js';
import {
  hasActiveUserInteraction
} from './multi-tab-sync-conflicts.js';
import {
  getUserActivity,
  isUserActive
} from './multi-tab-sync-activity.js';
import DOM from './dom-cache.js';
import stateRevision, { type StateRevision } from './state-revision.js';
import type { Transaction } from '../../types/index.js';

// ==========================================
// MODULE STATE
// ==========================================

let syncEnabled = true;
const debouncedSyncHandlers = new Map<string, Function>();
const atomicBundleTimeout = 5000;
const eventUnsubscribers: Array<() => void> = [];
const broadcastUnsubscribers: Array<() => void> = [];
let pendingConflictResolutionHandler: ((event: Event) => void) | null = null;

const COUPLED_STATE_GROUPS = {
  FINANCIAL_CORE: [SK.TX, SK.SAVINGS, SK.ALLOC],
  DEBT_CORE: [SK.DEBTS, SK.TX],
  CATEGORY_CORE: [SK.USER_CATS, SK.TX]
};

// ==========================================
// BROADCAST HANDLERS
// ==========================================

/**
 * Initialize all broadcast message handlers
 */
function setupBroadcastHandlers(): void {
  broadcastUnsubscribers.forEach((unsubscribe) => unsubscribe());
  broadcastUnsubscribers.length = 0;

  broadcastUnsubscribers.push(broadcastManager.on('state_update', (msg) => {
    if (msg.key) {
      handleRemoteStateUpdate(msg.key, msg.value, {
        revision: msg.revision,
        changedIds: msg.changedIds,
        changeType: msg.changeType,
        tabId: msg.tabId,
        timestamp: msg.timestamp
      });
    }
  }));

  broadcastUnsubscribers.push(broadcastManager.on('atomic_sync', (msg) => {
    if (msg.atomicBundle) {
      handleAtomicSync(msg.atomicBundle);
    }
  }));

  broadcastUnsubscribers.push(broadcastManager.on('full_sync', () => {
    if (!isUserActive()) {
      performFullSync();
    } else {
      broadcastManager.sendConflictWarning('full_sync', getUserActivity());
    }
  }));

  broadcastUnsubscribers.push(broadcastManager.on('conflict_warning', (msg) => {
    // userActivity is typed `unknown` on the broadcast payload — narrow
    // with a shape guard before reading the isTyping flag.
    const activity = msg.userActivity;
    const isTyping =
      !!activity &&
      typeof activity === 'object' &&
      (activity as { isTyping?: unknown }).isTyping === true;
    if (isTyping) {
      emit(Events.SHOW_TOAST, { message: `Someone\u2019s editing in another tab \u2014 your changes will sync automatically.`, type: 'warning' });
    }
  }));
}

/**
 * Handle atomic sync bundles for coupled state.
 *
 * CR-Apr24-I finding 214: added `skipConflictCheck` so the conflict-
 * resolution handler can re-enter without bouncing back into the
 * modal.  Previously, "Accept" re-called this function which re-tested
 * `hasActiveUserInteraction` — if the user was still marked active
 * from the edit that triggered the conflict, the modal would reopen.
 */
function handleAtomicSync(
  bundle: AtomicSyncBundle,
  { skipConflictCheck = false }: { skipConflictCheck?: boolean } = {}
): void {
  if (!skipConflictCheck && hasActiveUserInteraction(getUserActivity())) {
    showConflictModal(bundle);
    return;
  }

  const prevSyncState = syncEnabled;
  syncEnabled = false;

  try {
    // Validate bundle age
    if (Date.now() - bundle.bundleTimestamp > atomicBundleTimeout) return;

    // Apply all updates atomically
    for (const update of bundle.atomicUpdates) {
      updateLocalState(update.key, update.value);
    }

    emit(Events.SHOW_TOAST, { message: 'Updated from another tab', type: 'info' });
  } catch (error) {
    if (import.meta.env.DEV) console.error('Failed to apply atomic sync:', error);
    performFullSync();
  } finally {
    syncEnabled = prevSyncState;
  }
}

// ==========================================
// SYNC LOGIC
// ==========================================

// Phase 6 Slice 1j (rev 12 L6): optional fields widened to `field?: T | undefined`
// so sync-handler callers can pass metadata fields straight from
// `BroadcastMessage` (where each is already `| undefined`) without
// tripping `exactOptionalPropertyTypes`.
interface RemoteSyncPayload {
  value: unknown;
  revision?: number | undefined;
  changedIds?: string[] | undefined;
  changeType?: string | undefined;
  tabId?: string | undefined;
  timestamp?: number | undefined;
}

const latestSyncValues = new Map<string, RemoteSyncPayload>();

function handleRemoteStateUpdate(
  key: string,
  value: unknown,
  metadata: {
    revision?: number | undefined;
    changedIds?: string[] | undefined;
    changeType?: string | undefined;
    tabId?: string | undefined;
    timestamp?: number | undefined;
  } = {}
): void {
  latestSyncValues.set(key, {
    value,
    revision: metadata.revision,
    changedIds: metadata.changedIds,
    changeType: metadata.changeType,
    tabId: metadata.tabId,
    timestamp: metadata.timestamp
  });
  if (!debouncedSyncHandlers.has(key)) {
    debouncedSyncHandlers.set(key, debounce(() => {
      const latestValue = latestSyncValues.get(key);
      if (latestValue) {
        latestSyncValues.delete(key);
        try {
          updateLocalState(key, latestValue.value, latestValue);
        } catch (err) {
          if (import.meta.env.DEV) console.error(`[multi-tab-sync] updateLocalState failed for key "${key}":`, err);
        }
      }
    }, 100));
  }
  debouncedSyncHandlers.get(key)!();
}

/**
 * CR-Apr24-I finding 207: expanded switch to cover all 17 keys that
 * `syncState.applyKeyUpdate()` supports.  Previously only TX, SAVINGS,
 * ALLOC, USER_CATS, DEBTS, and ROLLOVER_SETTINGS were handled, so
 * BroadcastChannel `state_update` messages for theme, PIN, currency,
 * sections, alerts, insight-personality, achievements, streak, filter
 * presets, savings contributions, and transaction templates were silently
 * dropped.
 *
 * CR-Apr24-I finding 208: non-TX branches now call
 * `stateRevision.markKeySynced()` after a successful apply so the local
 * revision manifest stays current.  Previously only the TX event-bus
 * listeners called markKeySynced, so settings/savings keys were
 * perpetually "behind" and re-triggered full-sync on every visibility
 * change.
 */
function updateLocalState(
  key: string,
  value: unknown,
  metadata?: {
    revision?: number | undefined;
    changedIds?: string[] | undefined;
    changeType?: string | undefined;
    tabId?: string | undefined;
    timestamp?: number | undefined;
  }
): void {
  const prevSyncState = syncEnabled;
  syncEnabled = false;

  try {
    if (key === SK.TX) {
      // Transaction path — delta / replay / full-reload logic
      const remoteRevision = metadata?.revision;
      const localRevision = stateRevision.getKeyRevision(SK.TX);

      if (remoteRevision && localRevision && remoteRevision <= localRevision.revision) {
        return;
      }

      const canApplyDelta = isTransactionDelta(value)
        && typeof remoteRevision === 'number'
        && !!localRevision
        && remoteRevision === localRevision.revision + 1;

      if (canApplyDelta) {
        requestDataApplyDelta(value, 'multi-tab-sync', {
          revision: remoteRevision,
          tabId: metadata?.tabId,
          timestamp: metadata?.timestamp
        });
      } else if (
        isTransactionDelta(value)
        && typeof remoteRevision === 'number'
        && localRevision
        && remoteRevision > localRevision.revision + 1
      ) {
        const replay = stateRevision.getTransactionDeltaReplay(localRevision.revision, remoteRevision);
        if (replay && replay.length > 0) {
          replay.forEach((change, index) => {
            requestDataApplyDelta(change, 'multi-tab-sync', {
              revision: localRevision.revision + index + 1,
              tabId: metadata?.tabId,
              timestamp: metadata?.timestamp
            });
          });
        } else {
          requestDataReload('multi-tab-sync', {
            revision: remoteRevision,
            tabId: metadata?.tabId,
            timestamp: metadata?.timestamp
          });
        }
      } else {
        requestDataReload('multi-tab-sync', {
          revision: remoteRevision,
          tabId: metadata?.tabId,
          timestamp: metadata?.timestamp
        });
      }
    } else {
      // Non-TX path — delegate to syncState which validates & dispatches
      const applied = syncState.applyKeyUpdate(key, value);

      // Finding 208: advance the local revision manifest so this key is
      // no longer flagged as "needs sync" on the next visibility change.
      if (applied) {
        const remoteRev = buildRemoteRevision(key, metadata);
        if (remoteRev) {
          stateRevision.markKeySynced(key, remoteRev);
        }
      }
    }
  } finally {
    syncEnabled = prevSyncState;
  }
}

function isTransactionDelta(value: unknown): value is TransactionDataDelta {
  if (!value || typeof value !== 'object') return false;
  const type = (value as { type?: string }).type;
  return ['add', 'update', 'delete', 'batch-add', 'batch-delete', 'split'].includes(type || '');
}

function buildRemoteRevision(
  key: string,
  metadata?: { revision?: number | undefined; tabId?: string | undefined; timestamp?: number | undefined }
): StateRevision | null {
  if (!metadata?.revision) return null;
  return {
    revision: metadata.revision,
    timestamp: metadata.timestamp || Date.now(),
    logicalClock: metadata.revision,
    tabId: metadata.tabId || 'remote-tab',
    key
  };
}

/**
 * Broadcast state change to other tabs.
 *
 * CR-Apr24-I finding 212: when the changed key belongs to a coupled-state
 * group (e.g. TX + SAVINGS + ALLOC), we now build and send an actual
 * `AtomicSyncBundle` so the receiving tab can apply all coupled keys in
 * one pass.  Previously the coupled-group branch fell through to a plain
 * single-key `sendStateUpdate`, which meant cross-key consistency was
 * never enforced.
 */
export function broadcastStateChange(key: string, value: unknown): void {
  if (!syncEnabled) return;

  const coupledGroup = getCoupledStateGroup(key);
  if (coupledGroup) {
    // Gather current values for every key in the coupled group and send
    // as an atomic bundle so the receiver applies them together.
    const atomicUpdates = coupledGroup.map(coupledKey => ({
      key: coupledKey,
      value: coupledKey === key ? value : lsGet(coupledKey, null)
    }));

    broadcastManager.sendAtomicSync({
      bundleId: `${key}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      bundleTimestamp: Date.now(),
      atomicUpdates,
      coupledKeys: coupledGroup
    });
  } else {
    broadcastManager.sendStateUpdate(key, value);
  }

  // Also update localStorage for non-BroadcastChannel tabs
  lsSet(key, value);
}

function getCoupledStateGroup(key: string): string[] | null {
  for (const keys of Object.values(COUPLED_STATE_GROUPS)) {
    if (keys.includes(key)) return keys;
  }
  return null;
}

/**
 * CR-Apr24-I finding 226: the original guard `if (val !== null)` skipped
 * keys that another tab had removed (or reset to their default / absent
 * state).  The late-arriving tab therefore kept stale in-memory values
 * instead of converging.  Now, `null` results are forwarded through
 * `syncState.applyKeyUpdate` which applies the schema-aware default for
 * that key, achieving convergence.
 */
/**
 * Round 7 fix: after syncing individual keys, advance the local
 * `global_revision` to match the stored manifest. Without this,
 * `needsFullSync()` perpetually returns `true` on every visibility
 * change because it compares `stored.global_revision >
 * localManifest.global_revision` — and `markKeySynced` only updates
 * per-key entries, never the global counter. The result was an
 * infinite sync/pull loop that hammered localStorage on every
 * tab-switch.
 */
function performFullSync(): void {
  if (!stateRevision.needsFullSync()) return;

  const prevSyncState = syncEnabled;
  syncEnabled = false;

  try {
    const keys = stateRevision.getKeysNeedingSync();
    keys.forEach(key => {
      if (key === SK.TX) {
        requestDataReload('multi-tab-sync');
        return;
      }
      const val = lsGet(key, null);
      // Finding 226: apply even when val is null so that remote key
      // removals converge to the default state.  syncState.applyKeyUpdate
      // will reject the null through its validator — but that's correct:
      // a rejected null means "no canonical value exists", which is
      // equivalent to keeping the current in-memory default.  When a
      // valid value exists, it's applied and markKeySynced below
      // updates the manifest.
      updateLocalState(key, val);
    });

    // Round 7 fix: advance the global revision so needsFullSync()
    // returns false on subsequent visibility changes. This closes the
    // infinite sync loop caused by stale global_revision.
    stateRevision.advanceGlobalRevisionAfterSync();
  } finally {
    syncEnabled = prevSyncState;
  }
}

// ==========================================
// CONFLICT RESOLUTION UI
// ==========================================

function showConflictModal(bundle: AtomicSyncBundle): void {
  const remoteInfo = bundle.coupledKeys.join(', ');
  const localInfo = getUserActivity().activeField || 'Unsaved edits';

  const remoteEl = DOM.get('sync-remote-details');
  const localEl = DOM.get('sync-local-details');
  
  if (remoteEl) remoteEl.textContent = `Updates to: ${remoteInfo}`;
  if (localEl) localEl.textContent = `Your edits in: ${localInfo}`;

  // Listen for resolution event from modal-events.ts
  if (pendingConflictResolutionHandler) {
    window.removeEventListener('sync-conflict-resolution', pendingConflictResolutionHandler);
  }

  pendingConflictResolutionHandler = (event: Event) => {
    const customEvent = event as CustomEvent<{ action?: string }>;
    const action = customEvent.detail?.action;
    if (pendingConflictResolutionHandler) {
      window.removeEventListener('sync-conflict-resolution', pendingConflictResolutionHandler);
      pendingConflictResolutionHandler = null;
    }

    if (action === 'accept') {
      // CR-Apr24-I finding 214: pass `skipConflictCheck` so re-entering
      // handleAtomicSync doesn't bounce back into the modal when the
      // user is still marked "active" from the edit that caused the
      // conflict.
      handleAtomicSync(bundle, { skipConflictCheck: true });
      emit(Events.SHOW_TOAST, { message: 'Updates applied', type: 'success' });
    } else if (action === 'merge') {
      // CR-Apr24-I finding 213: "Merge" now performs a full sync reload
      // from localStorage (which both tabs have written to) instead of
      // blindly applying the remote bundle wholesale.  This converges
      // to the canonical persisted state rather than discarding local
      // edits.
      // Finding 214: also skip the conflict check for the same reason.
      handleAtomicSync(bundle, { skipConflictCheck: true });
      performFullSync();
      emit(Events.SHOW_TOAST, { message: 'Changes merged', type: 'success' });
    } else {
      emit(Events.SHOW_TOAST, { message: 'Kept your local changes', type: 'info' });
    }
  };

  window.addEventListener('sync-conflict-resolution', pendingConflictResolutionHandler);
  // Guard: if another modal is open, queue this modal to show after it closes
  const activeModals = document.querySelectorAll('.modal-overlay.active');
  if (activeModals.length > 0) {
    // Queue the conflict modal to show after current modal closes
    const showConflictAfterDelay = () => {
      if (document.querySelectorAll('.modal-overlay.active').length === 0) {
        emit(Events.OPEN_MODAL, { id: 'sync-conflict-modal' });
      } else {
        setTimeout(showConflictAfterDelay, 100);
      }
    };
    setTimeout(showConflictAfterDelay, 100);
  } else {
    emit(Events.OPEN_MODAL, { id: 'sync-conflict-modal' });
  }
}

// ==========================================
// LIFECYCLE
// ==========================================

export function initMultiTabSync(): void {
  cleanup();
  stateRevision.init();
  broadcastManager.init();
  setupBroadcastHandlers();

  eventUnsubscribers.forEach(unsub => unsub());
  eventUnsubscribers.length = 0;
  eventUnsubscribers.push(
    on(DataSyncEvents.TRANSACTION_UPDATED, (payload: {
      transactions?: Transaction[];
      source?: string;
      revision?: number;
      tabId?: string;
      timestamp?: number;
    }) => {
      if (!payload.transactions) return;

      const prevSyncState = syncEnabled;
      syncEnabled = false;

      try {
        signals.replaceTransactionLedger(payload.transactions);
        if (payload.source === 'multi-tab-sync') {
          const remoteRevision = buildRemoteRevision(SK.TX, payload);
          if (remoteRevision) stateRevision.markKeySynced(SK.TX, remoteRevision);
        }
      } finally {
        syncEnabled = prevSyncState;
      }
    })
  );
  eventUnsubscribers.push(
    on(DataSyncEvents.TRANSACTION_DELTA_APPLIED, (payload: {
      source?: string;
      revision?: number;
      tabId?: string;
      timestamp?: number;
    }) => {
      if (payload.source !== 'multi-tab-sync') return;
      const remoteRevision = buildRemoteRevision(SK.TX, payload);
      if (remoteRevision) stateRevision.markKeySynced(SK.TX, remoteRevision);
    })
  );
  eventUnsubscribers.push(
    on(Events.STORAGE_SYNC, (payload: {
      type?: string;
      store?: string;
    }) => {
      if (!payload?.store) return;
      if (payload.store !== 'transactions' && payload.store !== 'all') return;
      if (payload.type === 'clear' && payload.store === 'all') {
        requestDataReload('multi-tab-sync');
        return;
      }
      requestDataReload('multi-tab-sync');
    })
  );
  
  // Store handler references for cleanup
  storageHandler = (e: StorageEvent) => {
    if (syncEnabled && e.key && Object.values(SK).includes(e.key) && e.newValue) {
      try {
        handleRemoteStateUpdate(e.key, JSON.parse(e.newValue));
      } catch (err) {
        if (import.meta.env.DEV) console.error('Multi-tab sync: failed to handle remote state update for key:', e.key, err);
      }
    }
  };
  window.addEventListener('storage', storageHandler);

  visibilityHandler = () => {
    if (!document.hidden) performFullSync();
  };
  document.addEventListener('visibilitychange', visibilityHandler);

  performFullSync();
}

let storageHandler: ((e: StorageEvent) => void) | null = null;
let visibilityHandler: (() => void) | null = null;

export function cleanup(): void {
  if (pendingConflictResolutionHandler) {
    window.removeEventListener('sync-conflict-resolution', pendingConflictResolutionHandler);
    pendingConflictResolutionHandler = null;
  }
  broadcastUnsubscribers.forEach((unsubscribe) => unsubscribe());
  broadcastUnsubscribers.length = 0;
  broadcastManager.dispose();
  debouncedSyncHandlers.clear();
  latestSyncValues.clear();
  eventUnsubscribers.forEach(unsub => unsub());
  eventUnsubscribers.length = 0;
  // Remove event listeners to prevent leaks
  if (storageHandler) {
    window.removeEventListener('storage', storageHandler);
    storageHandler = null;
  }
  if (visibilityHandler) {
    document.removeEventListener('visibilitychange', visibilityHandler);
    visibilityHandler = null;
  }
}

export default {
  init: initMultiTabSync,
  cleanup,
  broadcastStateChange,
  getTabId: () => broadcastManager.getTabId()
};
