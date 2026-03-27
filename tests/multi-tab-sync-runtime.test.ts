import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  requestDataReloadMock,
  requestDataApplyDeltaMock,
  stateRevisionMock,
  broadcastManagerMock
} = vi.hoisted(() => {
  const onMock = vi.fn((_: string, handler: (msg: unknown) => void) => {
    return () => {
      void handler;
    };
  });

  return {
    requestDataReloadMock: vi.fn(),
    requestDataApplyDeltaMock: vi.fn(),
    stateRevisionMock: {
      init: vi.fn(),
      needsFullSync: vi.fn(() => false),
      getKeysNeedingSync: vi.fn<() => string[]>(() => []),
      getKeyRevision: vi.fn(() => null),
      getTransactionDeltaReplay: vi.fn(() => null),
      markKeySynced: vi.fn()
    },
    broadcastManagerMock: {
      init: vi.fn(),
      on: onMock,
      dispose: vi.fn(),
      sendConflictWarning: vi.fn(),
      sendStateUpdate: vi.fn(),
      getTabId: vi.fn(() => 'tab-test')
    }
  };
});

vi.mock('../js/modules/core/state.js', async () => {
  const actual = await vi.importActual('../js/modules/core/state.js');
  return {
    ...actual,
    lsGet: vi.fn((_: string, fallback: unknown) => fallback),
    lsSet: vi.fn(() => true)
  };
});

vi.mock('../js/modules/core/signals.js', () => ({
  replaceTransactionLedger: vi.fn()
}));

vi.mock('../js/modules/core/state-actions.js', () => ({
  syncState: {
    applyKeyUpdate: vi.fn()
  }
}));

vi.mock('../js/modules/core/data-sync-interface.js', () => ({
  DataSyncEvents: {
    REQUEST_RELOAD: 'data:request:reload',
    REQUEST_APPLY_DELTA: 'data:request:apply_delta',
    REQUEST_SYNC: 'data:request:sync',
    SYNC_COMPLETE: 'data:sync:complete',
    SYNC_ERROR: 'data:sync:error',
    TRANSACTION_UPDATED: 'data:transaction:updated',
    TRANSACTION_DELTA_APPLIED: 'data:transaction:delta_applied',
    BULK_UPDATE: 'data:bulk:update'
  },
  requestDataReload: requestDataReloadMock,
  requestDataApplyDelta: requestDataApplyDeltaMock
}));

vi.mock('../js/modules/core/multi-tab-sync-broadcast.js', () => ({
  broadcastManager: broadcastManagerMock
}));

vi.mock('../js/modules/core/multi-tab-sync-conflicts.js', () => ({
  hasActiveUserInteraction: vi.fn(() => false)
}));

vi.mock('../js/modules/core/multi-tab-sync-activity.js', () => ({
  getUserActivity: vi.fn(() => ({ activeField: null })),
  isUserActive: vi.fn(() => false)
}));

vi.mock('../js/modules/ui/core/ui.js', () => ({
  openModal: vi.fn(),
  showToast: vi.fn()
}));

vi.mock('../js/modules/core/dom-cache.js', () => ({
  default: {
    get: vi.fn(() => null)
  }
}));

vi.mock('../js/modules/core/state-revision.js', () => ({
  default: stateRevisionMock
}));

import { clearAll, emit, Events } from '../js/modules/core/event-bus.js';
import { SK } from '../js/modules/core/state.js';
import { cleanup, initMultiTabSync } from '../js/modules/core/multi-tab-sync.js';

describe('multi-tab-sync runtime integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearAll();
    stateRevisionMock.needsFullSync.mockReturnValue(false);
    stateRevisionMock.getKeysNeedingSync.mockReturnValue([] as string[]);
  });

  afterEach(() => {
    cleanup();
    clearAll();
  });

  it('performs an initial full sync when revision state is behind', () => {
    stateRevisionMock.needsFullSync.mockReturnValue(true);
    stateRevisionMock.getKeysNeedingSync.mockReturnValue([SK.TX] as string[]);

    initMultiTabSync();

    expect(requestDataReloadMock).toHaveBeenCalledWith('multi-tab-sync');
  });

  it('reloads transactions from STORAGE_SYNC fallback messages', () => {
    initMultiTabSync();

    emit(Events.STORAGE_SYNC, {
      type: 'update',
      store: 'transactions',
      data: { key: 'tx_1' },
      timestamp: Date.now()
    });

    expect(requestDataReloadMock).toHaveBeenCalledWith('multi-tab-sync');
  });

  it('propagates destructive clear events from STORAGE_SYNC', () => {
    initMultiTabSync();

    emit(Events.STORAGE_SYNC, {
      type: 'clear',
      store: 'all',
      data: null,
      timestamp: Date.now()
    });

    expect(requestDataReloadMock).toHaveBeenCalledWith('multi-tab-sync');
  });

  it('does not duplicate listeners across cleanup and re-init', () => {
    initMultiTabSync();
    cleanup();
    requestDataReloadMock.mockClear();

    initMultiTabSync();
    emit(Events.STORAGE_SYNC, {
      type: 'update',
      store: 'transactions',
      data: {},
      timestamp: Date.now()
    });

    expect(requestDataReloadMock).toHaveBeenCalledTimes(1);
  });
});
