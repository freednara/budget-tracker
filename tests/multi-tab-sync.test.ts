/**
 * Multi-Tab Synchronization Tests
 * 
 * Tests the multi-tab sync infrastructure including conflict resolution,
 * revision tracking, and concurrent modification scenarios.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import stateRevision from '../js/modules/core/state-revision.js';
import { SK } from '../js/modules/core/state.js';
import type { Transaction } from '../js/types/index.js';

// ==========================================
// MOCK SETUP
// ==========================================

// Mock localStorage -- use vi.hoisted() so the map is available inside hoisted vi.mock() factories
const { mockStorage } = vi.hoisted(() => ({
  mockStorage: new Map<string, string>()
}));

vi.mock('../js/modules/core/safe-storage.js', () => ({
  safeStorage: {
    getJSON: vi.fn((key: string, fallback: any) => {
      const stored = mockStorage.get(key);
      if (stored === undefined) return fallback;
      try { return JSON.parse(stored); } catch { return fallback; }
    }),
    setJSON: vi.fn((key: string, value: any) => {
      mockStorage.set(key, JSON.stringify(value));
      return true;
    })
  }
}));

vi.mock('../js/modules/core/tab-id.js', () => ({
  getTabId: vi.fn(() => 'test-tab-id')
}));

vi.mock('../js/modules/core/locale-service.js', () => ({
  localeService: {
    formatCurrency: vi.fn((v: number) => `$${v.toFixed(2)}`),
    formatNumber: vi.fn((v: number) => String(v)),
    formatDate: vi.fn(() => '1/1/2026'),
    formatMonth: vi.fn(() => 'January 2026'),
    formatPercent: vi.fn((v: number) => `${v}%`),
    parseCurrency: vi.fn((s: string) => parseFloat(s) || 0),
    parseNumber: vi.fn((s: string) => parseFloat(s) || 0),
    getFirstDayOfWeek: vi.fn(() => 0),
    getDateFormat: vi.fn(() => 'MM/DD/YYYY'),
  }
}));

vi.mock('../js/modules/core/state.js', async () => {
  const actual = await vi.importActual('../js/modules/core/state.js');
  return {
    ...actual,
    lsGet: vi.fn((key: string, fallback: any) => {
      const stored = mockStorage.get(key);
      return stored ? JSON.parse(stored) : fallback;
    }),
    lsSet: vi.fn((key: string, value: any) => {
      mockStorage.set(key, JSON.stringify(value));
      return true;
    })
  };
});

// Mock BroadcastChannel
class MockBroadcastChannel {
  private listeners: Array<(event: MessageEvent) => void> = [];
  private static instances: MockBroadcastChannel[] = [];
  
  constructor(public name: string) {
    MockBroadcastChannel.instances.push(this);
  }
  
  postMessage(data: any): void {
    // Simulate broadcasting to other instances
    MockBroadcastChannel.instances.forEach(instance => {
      if (instance !== this && instance.name === this.name) {
        instance.listeners.forEach(listener => {
          listener(new MessageEvent('message', { data }));
        });
      }
    });
  }
  
  set onmessage(handler: (event: MessageEvent) => void) {
    this.listeners = [handler];
  }
  
  close(): void {
    const index = MockBroadcastChannel.instances.indexOf(this);
    if (index > -1) {
      MockBroadcastChannel.instances.splice(index, 1);
    }
  }
  
  static clearAll(): void {
    this.instances = [];
  }
}

(global as any).BroadcastChannel = MockBroadcastChannel;

// ==========================================
// TEST UTILITIES
// ==========================================

/**
 * Simulate multiple tabs
 */
class TabSimulator {
  private tabs: Array<{
    id: string;
    revisionModule: typeof stateRevision;
    channel: MockBroadcastChannel;
  }> = [];

  createTab(id: string) {
    const channel = new MockBroadcastChannel('test_sync');
    const tab = {
      id,
      revisionModule: stateRevision,
      channel
    };
    
    this.tabs.push(tab);
    return tab;
  }

  async simulateStateChange(tabId: string, key: string, value: any) {
    const tab = this.tabs.find(t => t.id === tabId);
    if (tab) {
      return await tab.revisionModule.recordStateChange(key, value, tabId);
    }
    throw new Error(`Tab ${tabId} not found`);
  }

  getTab(id: string) {
    return this.tabs.find(t => t.id === id);
  }

  cleanup() {
    this.tabs.forEach(tab => tab.channel.close());
    this.tabs = [];
    MockBroadcastChannel.clearAll();
  }
}

/**
 * Create test transaction
 */
function createTestTransaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    __backendId: `tx_${Date.now()}_${Math.random()}`,
    type: 'expense',
    amount: 50.00,
    category: 'food',
    description: 'Test transaction',
    date: '2026-03-15',
    currency: 'USD',
    recurring: false,
    reconciled: true,
    splits: false,
    ...overrides
  };
}

// ==========================================
// REVISION TRACKING TESTS
// ==========================================

describe('State Revision Tracking', () => {
  beforeEach(() => {
    mockStorage.clear();
    stateRevision.resetRevisionTracking();
    stateRevision.init();
  });

  afterEach(() => {
    mockStorage.clear();
  });

  describe('Revision Management', () => {
    it('should track state changes with revisions', async () => {
      const tabId = 'tab1';
      const testData = { test: 'value' };

      const revision = await stateRevision.recordStateChange(SK.TX, testData, tabId);

      expect(revision.revision).toBe(1);
      expect(revision.tabId).toBe(tabId);
      expect(revision.key).toBe(SK.TX);
    });

    it('should increment revisions for multiple changes', async () => {
      const tabId = 'tab1';

      const rev1 = await stateRevision.recordStateChange(SK.TX, [1], tabId);
      const rev2 = await stateRevision.recordStateChange(SK.SAVINGS, {}, tabId);

      expect(rev1.revision).toBe(1);
      expect(rev2.revision).toBe(2);
    });

    it('should detect when full sync is needed', () => {
      // Start clean
      expect(stateRevision.needsFullSync()).toBe(false);
      
      // Simulate another tab making changes
      mockStorage.set('budget_tracker_state_revision', JSON.stringify({
        global_revision: 5,
        key_revisions: {
          [SK.TX]: { revision: 5, timestamp: Date.now(), tabId: 'other_tab', key: SK.TX }
        },
        last_sync: Date.now()
      }));
      
      expect(stateRevision.needsFullSync()).toBe(true);
    });

    it('should identify specific keys needing sync', async () => {
      // Record local changes
      await stateRevision.recordStateChange(SK.TX, [], 'tab1');
      await stateRevision.recordStateChange(SK.SAVINGS, {}, 'tab1');
      
      // Simulate remote changes
      mockStorage.set('budget_tracker_state_revision', JSON.stringify({
        global_revision: 5,
        key_revisions: {
          [SK.TX]: { revision: 3, timestamp: Date.now(), tabId: 'other_tab', key: SK.TX },
          [SK.ALLOC]: { revision: 5, timestamp: Date.now(), tabId: 'other_tab', key: SK.ALLOC }
        },
        last_sync: Date.now()
      }));
      
      const keysNeedingSync = stateRevision.getKeysNeedingSync();
      expect(keysNeedingSync).toContain(SK.TX);
      expect(keysNeedingSync).toContain(SK.ALLOC);
      expect(keysNeedingSync).not.toContain(SK.SAVINGS);
    });
  });

  describe('Checksum Validation', () => {
    it('should generate checksums for critical data', async () => {
      const transactions = [createTestTransaction(), createTestTransaction()];

      const revision = await stateRevision.recordStateChange(SK.TX, transactions, 'tab1');

      expect(revision.checksum).toBeDefined();
      expect(typeof revision.checksum).toBe('string');
    });

    it('should detect checksum mismatches', async () => {
      const transactions1 = [createTestTransaction({ amount: 100 })];

      // Record a state change so localManifest has a checksum for SK.TX
      const rev1 = await stateRevision.recordStateChange(SK.TX, transactions1, 'tab1');

      // Simulate remote state with same revision but different checksum
      mockStorage.set('budget_tracker_state_revision', JSON.stringify({
        global_revision: 1,
        key_revisions: {
          [SK.TX]: {
            ...rev1,
            checksum: 'different_checksum'
          }
        },
        last_sync: Date.now()
      }));

      expect(stateRevision.needsFullSync()).toBe(true);
    });
  });
});

// ==========================================
// CONFLICT RESOLUTION TESTS
// ==========================================

describe('Conflict Resolution', () => {
  beforeEach(() => {
    mockStorage.clear();
    stateRevision.resetRevisionTracking();
    stateRevision.init();
  });

  describe('Last-Writer-Wins Strategy', () => {
    it('should resolve conflicts based on timestamp', () => {
      const baseTime = Date.now();
      
      const localData = {
        value: [createTestTransaction({ description: 'Local change' })],
        revision: {
          revision: 1,
          timestamp: baseTime,
          logicalClock: 1,
          tabId: 'local_tab',
          key: SK.TX
        }
      };

      const remoteData = {
        value: [createTestTransaction({ description: 'Remote change' })],
        revision: {
          revision: 2,
          timestamp: baseTime + 1000, // Later timestamp
          logicalClock: 2, // Higher logical clock
          tabId: 'remote_tab',
          key: SK.TX
        }
      };

      const resolution = stateRevision.resolveConflict(localData, remoteData);
      expect(resolution).toBe('remote'); // Remote wins due to higher logical clock
    });

    it('should use tab ID as tiebreaker for same timestamps', () => {
      const timestamp = Date.now();
      
      const localData = {
        value: 'local',
        revision: {
          revision: 1,
          timestamp,
          logicalClock: 5, // Same logical clock
          tabId: 'test-tab-id', // Matches getTabId() mock — this tab wins ties
          key: SK.TX
        }
      };

      const remoteData = {
        value: 'remote',
        revision: {
          revision: 2,
          timestamp,
          logicalClock: 5, // Same logical clock
          tabId: 'other-tab', // Different tab
          key: SK.TX
        }
      };

      const resolution = stateRevision.resolveConflict(localData, remoteData);
      expect(resolution).toBe('local'); // Local wins because localRev.tabId === getTabId()
    });
  });

  describe('Concurrent Modification Detection', () => {
    it('should detect concurrent modifications', async () => {
      const tabId = 'tab1';

      // Initial state
      const rev1 = await stateRevision.recordStateChange(SK.TX, [], tabId);

      // Simulate concurrent modification
      const hasConcurrentMod = stateRevision.detectConcurrentModification(SK.TX, 0);

      expect(hasConcurrentMod).toBe(true); // Revision 1 > expected revision 0
    });

    it('should create conflict metadata', () => {
      const localRev = {
        revision: 1,
        timestamp: Date.now(),
        logicalClock: 1,
        tabId: 'local_tab',
        key: SK.TX
      };

      const remoteRev = {
        revision: 2,
        timestamp: Date.now() + 1000,
        logicalClock: 2,
        tabId: 'remote_tab',
        key: SK.TX
      };
      
      const metadata = stateRevision.createConflictMetadata(SK.TX, localRev, remoteRev);
      
      expect(metadata.local_revision).toBe(1);
      expect(metadata.remote_revision).toBe(2);
      expect(metadata.resolution_strategy).toBe('last_writer_wins');
    });
  });
});

// ==========================================
// MULTI-TAB SIMULATION TESTS
// ==========================================

describe('Multi-Tab Scenarios', () => {
  let tabSim: TabSimulator;

  beforeEach(() => {
    mockStorage.clear();
    stateRevision.resetRevisionTracking();
    stateRevision.init();
    tabSim = new TabSimulator();
  });

  afterEach(() => {
    tabSim.cleanup();
  });

  describe('Basic Multi-Tab Operations', () => {
    it('should handle state changes from multiple tabs', async () => {
      const tab1 = tabSim.createTab('tab1');
      const tab2 = tabSim.createTab('tab2');

      // Tab 1 makes a change
      const rev1 = await tabSim.simulateStateChange('tab1', SK.TX, [createTestTransaction()]);
      expect(rev1.revision).toBe(1);

      // Tab 2 makes a change
      const rev2 = await tabSim.simulateStateChange('tab2', SK.SAVINGS, { goal1: { amount: 1000 } });
      expect(rev2.revision).toBe(2);

      // Verify both changes are tracked
      const stats = stateRevision.getRevisionStats();
      expect(stats.currentRevision).toBe(2);
      expect(stats.trackedKeys).toBe(2);
    });

    it('should handle rapid sequential changes', async () => {
      const tab1 = tabSim.createTab('tab1');
      const tab2 = tabSim.createTab('tab2');

      // Simulate rapid changes from both tabs
      const changes = [];
      for (let i = 0; i < 10; i++) {
        const tabId = i % 2 === 0 ? 'tab1' : 'tab2';
        const result = await tabSim.simulateStateChange(tabId, SK.TX, [
          createTestTransaction({ description: `Change ${i}` })
        ]);
        changes.push(result);
      }

      expect(changes).toHaveLength(10);
      expect(changes[changes.length - 1].revision).toBe(10);
    });
  });

  describe('Debounced Persistence', () => {
    it('should batch multiple rapid changes', async () => {
      const debouncedPersist = stateRevision.createDebouncedPersist(50);
      let persistCallCount = 0;
      
      // Mock the actual persistence to count calls
      const originalRecordStateChange = stateRevision.recordStateChange;
      vi.spyOn(stateRevision, 'recordStateChange').mockImplementation((...args) => {
        persistCallCount++;
        return originalRecordStateChange.apply(stateRevision, args);
      });
      
      // Rapid state changes
      const updates = {
        [SK.TX]: [createTestTransaction()],
        [SK.SAVINGS]: { goal: 100 },
        [SK.ALLOC]: { food: 200 }
      };
      
      // Trigger multiple rapid updates
      for (let i = 0; i < 5; i++) {
        debouncedPersist(updates, 'tab1');
      }
      
      // Wait for debounce to complete
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Should have batched the calls
      expect(persistCallCount).toBeLessThan(15); // Much less than 5 * 3 = 15
    });
  });

  describe('Race Condition Handling', () => {
    it('should handle overlapping debounce windows', async () => {
      const debouncedPersist = stateRevision.createDebouncedPersist(100);
      
      const updates1 = { [SK.TX]: [createTestTransaction({ description: 'First' })] };
      const updates2 = { [SK.TX]: [createTestTransaction({ description: 'Second' })] };
      
      // Start first update
      debouncedPersist(updates1, 'tab1');
      
      // After 50ms, start second update (should cancel first)
      setTimeout(() => {
        debouncedPersist(updates2, 'tab1');
      }, 50);
      
      // Wait for all operations to complete
      await new Promise(resolve => setTimeout(resolve, 200));
      
      // Should have the latest state
      const stats = stateRevision.getRevisionStats();
      expect(stats.currentRevision).toBeGreaterThan(0);
    });

    it('should handle concurrent changes from different tabs', async () => {
      const tab1 = tabSim.createTab('tab1');
      const tab2 = tabSim.createTab('tab2');

      // Simultaneous changes to same key
      const tx1 = createTestTransaction({ description: 'Tab 1 change' });
      const tx2 = createTestTransaction({ description: 'Tab 2 change' });

      const rev1 = await tabSim.simulateStateChange('tab1', SK.TX, [tx1]);
      const rev2 = await tabSim.simulateStateChange('tab2', SK.TX, [tx2]);

      // Both should be recorded with different revisions
      expect(rev1.revision).not.toBe(rev2.revision);
      expect(rev1.tabId).toBe('tab1');
      expect(rev2.tabId).toBe('tab2');

      // Later revision should win in conflict resolution
      const localData = { value: [tx1], revision: rev1 };
      const remoteData = { value: [tx2], revision: rev2 };

      const resolution = stateRevision.resolveConflict(localData, remoteData);
      expect(resolution).toBe(rev2.logicalClock > rev1.logicalClock ? 'remote' : 'local');
    });
  });
});

// ==========================================
// PERFORMANCE TESTS
// ==========================================

describe('Multi-Tab Performance', () => {
  beforeEach(() => {
    mockStorage.clear();
    stateRevision.resetRevisionTracking();
    stateRevision.init();
  });

  it('should handle large revision histories efficiently', async () => {
    const tabId = 'perf_tab';
    const startTime = performance.now();

    // Create many revisions
    for (let i = 0; i < 1000; i++) {
      await stateRevision.recordStateChange(
        SK.TX,
        [createTestTransaction({ description: `Rev ${i}` })],
        tabId,
        { skipChecksum: true }
      );
    }

    const endTime = performance.now();
    const stats = stateRevision.getRevisionStats();

    expect(stats.currentRevision).toBe(1000);
    expect(endTime - startTime).toBeLessThan(5000); // Should complete within 5 seconds (async overhead)
  });

  it('should efficiently detect sync requirements', async () => {
    // Populate with many keys
    for (let i = 0; i < 100; i++) {
      await stateRevision.recordStateChange(`key_${i}`, { value: i }, 'tab1');
    }
    
    // Simulate remote changes to some keys
    const remoteRevisions: Record<string, any> = {};
    for (let i = 0; i < 10; i++) {
      remoteRevisions[`key_${i}`] = {
        revision: 200 + i,
        timestamp: Date.now(),
        tabId: 'remote_tab',
        key: `key_${i}`
      };
    }
    
    mockStorage.set('budget_tracker_state_revision', JSON.stringify({
      global_revision: 210,
      key_revisions: remoteRevisions,
      last_sync: Date.now()
    }));
    
    const startTime = performance.now();
    const needsSync = stateRevision.needsFullSync();
    const keysNeedingSync = stateRevision.getKeysNeedingSync();
    const endTime = performance.now();
    
    expect(needsSync).toBe(true);
    expect(keysNeedingSync).toHaveLength(10);
    expect(endTime - startTime).toBeLessThan(100); // Should be very fast
  });
});
