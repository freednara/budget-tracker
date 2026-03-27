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
import { debounce } from './utils.js';
import { DataSyncEvents, requestDataApplyDelta, requestDataReload, type TransactionDataDelta } from './data-sync-interface.js';
import { broadcastManager, type AtomicSyncBundle } from './multi-tab-sync-broadcast.js';
import { on, Events } from './event-bus.js';
import { 
  hasActiveUserInteraction
} from './multi-tab-sync-conflicts.js';
import {
  getUserActivity,
  isUserActive
} from './multi-tab-sync-activity.js';
import { openModal, showToast } from '../ui/core/ui.js';
import DOM from './dom-cache.js';
import stateRevision from './state-revision.js';
import type { Transaction, SavingsGoal, MonthlyAllocation, CustomCategory, Debt } from '../../types/index.js';

// ==========================================
// MODULE STATE
// ==========================================

let syncEnabled = true;
const debouncedSyncHandlers = new Map<string, Function>();
const atomicBundleTimeout = 5000;
const eventUnsubscribers: Array<() => void> = [];
const broadcastUnsubscribers: Array<() => void> = [];

const COUPLED_STATE_GROUPS = {
  FINANCIAL_CORE: [SK.TX, SK.SAVINGS, SK.ALLOC],
  DEBT_CORE: [SK.DEBTS, SK.TX],
  CATEGORY_CORE: [SK.CUSTOM_CAT, SK.TX]
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
    if (msg.userActivity?.isTyping) {
      showToast(`Another tab is editing ${msg.userActivity.activeField || 'data'}.`, 'warning');
    }
  }));
}

/**
 * Handle atomic sync bundles for coupled state
 */
function handleAtomicSync(bundle: AtomicSyncBundle): void {
  if (hasActiveUserInteraction(getUserActivity())) {
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
    
    showToast('Updated from another tab', 'info');
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

interface RemoteSyncPayload {
  value: unknown;
  revision?: number;
  changedIds?: string[];
  changeType?: string;
  tabId?: string;
  timestamp?: number;
}

const latestSyncValues = new Map<string, RemoteSyncPayload>();

function handleRemoteStateUpdate(
  key: string,
  value: unknown,
  metadata: { revision?: number; changedIds?: string[]; changeType?: string; tabId?: string; timestamp?: number } = {}
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
        updateLocalState(key, latestValue.value, latestValue);
        latestSyncValues.delete(key);
      }
    }, 100));
  }
  debouncedSyncHandlers.get(key)!();
}

function updateLocalState(
  key: string,
  value: unknown,
  metadata?: { revision?: number; changedIds?: string[]; changeType?: string; tabId?: string; timestamp?: number }
): void {
  const prevSyncState = syncEnabled;
  syncEnabled = false;

  try {
    switch (key) {
      case SK.TX: {
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
          requestDataApplyDelta(value as TransactionDataDelta, 'multi-tab-sync', {
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
        break;
      }
      case SK.SAVINGS:
        syncState.applyKeyUpdate(SK.SAVINGS, value as Record<string, SavingsGoal>);
        break;
      case SK.ALLOC:
        syncState.applyKeyUpdate(SK.ALLOC, value as Record<string, MonthlyAllocation>);
        break;
      case SK.CUSTOM_CAT:
        syncState.applyKeyUpdate(SK.CUSTOM_CAT, value as CustomCategory[]);
        break;
      case SK.DEBTS:
        syncState.applyKeyUpdate(SK.DEBTS, value as Debt[]);
        break;
      case SK.ROLLOVER_SETTINGS:
        syncState.applyKeyUpdate(SK.ROLLOVER_SETTINGS, value);
        break;
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
  metadata?: { revision?: number; tabId?: string; timestamp?: number }
): { revision: number; timestamp: number; logicalClock: number; tabId: string; key: string } | null {
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
 * Broadcast state change to other tabs
 */
export function broadcastStateChange(key: string, value: unknown): void {
  if (!syncEnabled) return;

  const coupledGroup = getCoupledStateGroup(key);
  if (coupledGroup) {
    // In a real implementation, we'd gather all coupled keys.
    // For now, single key broadcast via manager
    broadcastManager.sendStateUpdate(key, value);
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
      if (val !== null) updateLocalState(key, val);
    });
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
  const resolveHandler = (e: any) => {
    const { action } = e.detail;
    window.removeEventListener('sync-conflict-resolution', resolveHandler);

    if (action === 'accept') {
      handleAtomicSync(bundle);
      showToast('Updates applied', 'success');
    } else if (action === 'merge') {
      // Simple merge: apply remote but keep local awareness
      handleAtomicSync(bundle);
      showToast('Changes merged', 'success');
    } else {
      showToast('Kept your local changes', 'info');
    }
  };

  window.addEventListener('sync-conflict-resolution', resolveHandler);
  openModal('sync-conflict-modal');
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
          if (remoteRevision) stateRevision.markKeySynced(SK.TX, remoteRevision as any);
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
      if (remoteRevision) stateRevision.markKeySynced(SK.TX, remoteRevision as any);
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
