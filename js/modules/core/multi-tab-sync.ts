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
import { debounce } from './utils.js';
import { DataSyncEvents, requestDataReload, requestDataSync } from './data-sync-interface.js';
import { broadcastManager, type AtomicSyncBundle } from './multi-tab-sync-broadcast.js';
import { on } from './event-bus.js';
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
  broadcastManager.on('state_update', (msg) => {
    if (msg.key && msg.value !== undefined) {
      handleRemoteStateUpdate(msg.key, msg.value);
    }
  });

  broadcastManager.on('atomic_sync', (msg) => {
    if (msg.atomicBundle) {
      handleAtomicSync(msg.atomicBundle);
    }
  });

  broadcastManager.on('full_sync', () => {
    if (!isUserActive()) {
      performFullSync();
    } else {
      broadcastManager.sendConflictWarning('full_sync', getUserActivity());
    }
  });

  broadcastManager.on('conflict_warning', (msg) => {
    if (msg.userActivity?.isTyping) {
      showToast(`Another tab is editing ${msg.userActivity.activeField || 'data'}.`, 'warning');
    }
  });
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

const latestSyncValues = new Map<string, unknown>();

function handleRemoteStateUpdate(key: string, value: unknown): void {
  latestSyncValues.set(key, value);
  if (!debouncedSyncHandlers.has(key)) {
    debouncedSyncHandlers.set(key, debounce(() => {
      const latestValue = latestSyncValues.get(key);
      if (latestValue !== undefined) {
        updateLocalState(key, latestValue);
        latestSyncValues.delete(key);
      }
    }, 100));
  }
  debouncedSyncHandlers.get(key)!();
}

function updateLocalState(key: string, value: unknown): void {
  const prevSyncState = syncEnabled;
  syncEnabled = false;

  try {
    switch (key) {
      case SK.TX:
        signals.transactions.value = value as Transaction[];
        requestDataSync(value as Transaction[], 'multi-tab-sync');
        break;
      case SK.SAVINGS:
        signals.savingsGoals.value = value as Record<string, SavingsGoal>;
        break;
      case SK.ALLOC:
        signals.monthlyAlloc.value = value as Record<string, MonthlyAllocation>;
        break;
      case SK.CUSTOM_CAT:
        signals.customCats.value = value as CustomCategory[];
        break;
      case SK.DEBTS:
        signals.debts.value = value as Debt[];
        break;
      case SK.ROLLOVER_SETTINGS:
        signals.rolloverSettings.value = value as any;
        break;
    }
  } finally {
    syncEnabled = prevSyncState;
  }
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
  stateRevision.init();
  broadcastManager.init();
  setupBroadcastHandlers();

  eventUnsubscribers.forEach(unsub => unsub());
  eventUnsubscribers.length = 0;
  eventUnsubscribers.push(
    on(DataSyncEvents.TRANSACTION_UPDATED, (payload: { transactions?: Transaction[] }) => {
      if (!payload.transactions) return;

      const prevSyncState = syncEnabled;
      syncEnabled = false;

      try {
        signals.transactions.value = payload.transactions;
      } finally {
        syncEnabled = prevSyncState;
      }
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
}

let storageHandler: ((e: StorageEvent) => void) | null = null;
let visibilityHandler: (() => void) | null = null;

export function cleanup(): void {
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
