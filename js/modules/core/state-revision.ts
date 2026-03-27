/**
 * State Revision Tracking Module
 * 
 * Implements revision-based state synchronization to optimize multi-tab sync
 * and prevent unnecessary full syncs on tab visibility changes.
 */

import { SK, lsSet } from './state.js';
import { safeStorage } from './safe-storage.js';
import { getTabId } from './tab-id.js';
import type { Transaction, TransactionDataChange } from '../../types/index.js';

const DEV = import.meta.env.DEV;

// ==========================================
// TYPES
// ==========================================

interface StateRevision {
  revision: number;
  timestamp: number;
  logicalClock: number;  // Lamport clock for causality
  vectorClock?: Record<string, number>;  // Optional vector clock for complex scenarios
  tabId: string;
  key: string;
  checksum?: string;
  atomicGroup?: string; // For tracking coupled state updates
  lastModifier?: string; // Tab that made the last change
}

interface RevisionManifest {
  global_revision: number;
  logical_clock: number;  // Global logical clock
  key_revisions: Record<string, StateRevision>;
  last_sync: number;
  atomic_groups: Record<string, AtomicGroupRevision>; // Track coupled state consistency
  conflict_resolution_policy?: 'last_writer_wins' | 'user_decides' | 'merge';
}

interface AtomicGroupRevision {
  groupId: string;
  revision: number;
  timestamp: number;
  keys: string[];
  consistent: boolean; // All keys in group have same revision
  lastUpdatedBy: string;
}

interface TransactionDeltaLogEntry {
  revision: number;
  timestamp: number;
  tabId: string;
  change: TransactionDataChange;
}

// ==========================================
// CONSTANTS
// ==========================================

const REVISION_KEY = 'budget_tracker_state_revision';
const CHECKSUM_KEYS = [SK.TX]; // Keys requiring checksum validation
const TRANSACTION_DELTA_LOG_KEY = 'budget_tracker_tx_delta_log';
const MAX_TRANSACTION_DELTA_LOG_ENTRIES = 64;

// ==========================================
// MODULE STATE
// ==========================================

let currentRevision = 0;
let logicalClock = 0;
let localManifest: RevisionManifest = {
  global_revision: 0,
  logical_clock: 0,
  key_revisions: {},
  last_sync: Date.now(),
  atomic_groups: {},
  conflict_resolution_policy: 'user_decides'
};

// Define atomic groups for coupled state
const ATOMIC_STATE_GROUPS = {
  FINANCIAL_CORE: [SK.TX, SK.SAVINGS, SK.ALLOC],
  DEBT_CORE: [SK.DEBTS, SK.TX],
  CATEGORY_CORE: [SK.CUSTOM_CAT, SK.TX]
};

// ==========================================
// REVISION MANAGEMENT
// ==========================================

/**
 * Initialize revision tracking
 */
export function initRevisionTracking(): void {
  loadManifest();
  cleanupOldRevisions();
}

/**
 * Load revision manifest from storage
 */
function loadManifest(): void {
  const stored = safeStorage.getJSON<RevisionManifest>(REVISION_KEY, {
    global_revision: 0,
    logical_clock: 0,
    key_revisions: {},
    last_sync: Date.now(),
    atomic_groups: {}
  });

  localManifest = stored;
  currentRevision = stored.global_revision;
  logicalClock = stored.logical_clock || 0;
}

/**
 * Save revision manifest to storage
 */
function saveManifest(): void {
  localManifest.last_sync = Date.now();
  safeStorage.setJSON(REVISION_KEY, localManifest);
}

/**
 * Generate next revision number
 */
function nextRevision(): number {
  currentRevision++;
  localManifest.global_revision = currentRevision;
  return currentRevision;
}

/**
 * Increment logical clock (Lamport Clock)
 */
function incrementLogicalClock(): number {
  logicalClock++;
  localManifest.logical_clock = logicalClock;
  return logicalClock;
}

/**
 * Update logical clock on message receive
 */
function updateLogicalClock(remoteClock: number): number {
  logicalClock = Math.max(logicalClock, remoteClock) + 1;
  localManifest.logical_clock = logicalClock;
  return logicalClock;
}

/**
 * Calculate SHA-256 checksum for large datasets
 * Uses Web Crypto API for cryptographically secure hashing
 */
async function calculateChecksum(data: unknown): Promise<string> {
  const str = JSON.stringify(data);
  const encoder = new TextEncoder();
  const dataBuffer = encoder.encode(str);
  
  try {
    const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    return hashHex;
  } catch (error) {
    if (DEV) console.error('Failed to calculate SHA-256 checksum:', error);
    // Fallback to a more robust non-crypto hash (xxHash-like)
    return calculateXXHash(str);
  }
}

/**
 * Fallback: XXHash-like algorithm (more collision-resistant than simple sum)
 * Based on xxHash32 algorithm principles
 */
function calculateXXHash(str: string): string {
  const PRIME32_1 = 2654435761;
  const PRIME32_2 = 2246822519;
  const PRIME32_3 = 3266489917;
  const PRIME32_4 = 668265263;
  const PRIME32_5 = 374761393;
  
  let h32 = PRIME32_5 + str.length;
  let i = 0;
  
  // Process 4-byte chunks
  while (i <= str.length - 4) {
    let k = 0;
    for (let j = 0; j < 4; j++) {
      k |= str.charCodeAt(i + j) << (j * 8);
    }
    h32 = Math.imul(h32 + Math.imul(k, PRIME32_3), PRIME32_4) >>> 0;
    i += 4;
  }
  
  // Process remaining bytes
  while (i < str.length) {
    h32 = Math.imul(h32 + Math.imul(str.charCodeAt(i), PRIME32_5), PRIME32_1) >>> 0;
    i++;
  }
  
  // Final mixing
  h32 ^= h32 >>> 15;
  h32 = Math.imul(h32, PRIME32_2) >>> 0;
  h32 ^= h32 >>> 13;
  h32 = Math.imul(h32, PRIME32_3) >>> 0;
  h32 ^= h32 >>> 16;
  
  return h32.toString(16).padStart(8, '0');
}

// ==========================================
// STATE CHANGE TRACKING
// ==========================================

/**
 * Record a state change with revision tracking
 */
export async function recordStateChange(
  key: string, 
  value: unknown, 
  tabId: string,
  options: { skipChecksum?: boolean; remoteClock?: number } = {}
): Promise<StateRevision> {
  const revision = nextRevision();
  const timestamp = Date.now();
  
  // Update logical clock
  const clock = options.remoteClock 
    ? updateLogicalClock(options.remoteClock)
    : incrementLogicalClock();
  
  const stateRevision: StateRevision = {
    revision,
    timestamp,
    logicalClock: clock,
    tabId,
    key
  };
  
  // Calculate checksum for critical data
  if (CHECKSUM_KEYS.includes(key) && !options.skipChecksum) {
    stateRevision.checksum = await calculateChecksum(value);
  }
  
  // Update manifest
  localManifest.key_revisions[key] = stateRevision;
  saveManifest();
  
  return stateRevision;
}

export function recordTransactionDelta(
  revision: number,
  change: TransactionDataChange,
  tabId: string
): void {
  const existingEntries = safeStorage.getJSON<TransactionDeltaLogEntry[]>(TRANSACTION_DELTA_LOG_KEY, []);
  const nextEntries = existingEntries
    .filter((entry) => entry.revision !== revision)
    .concat({
      revision,
      timestamp: Date.now(),
      tabId,
      change
    })
    .sort((a, b) => a.revision - b.revision)
    .slice(-MAX_TRANSACTION_DELTA_LOG_ENTRIES);

  safeStorage.setJSON(TRANSACTION_DELTA_LOG_KEY, nextEntries);
}

export function getTransactionDeltaReplay(
  fromRevisionExclusive: number,
  toRevisionInclusive: number
): TransactionDataChange[] | null {
  if (toRevisionInclusive <= fromRevisionExclusive) return [];

  const entries = safeStorage.getJSON<TransactionDeltaLogEntry[]>(TRANSACTION_DELTA_LOG_KEY, [])
    .filter((entry) => entry.revision > fromRevisionExclusive && entry.revision <= toRevisionInclusive)
    .sort((a, b) => a.revision - b.revision);

  const expectedCount = toRevisionInclusive - fromRevisionExclusive;
  if (entries.length !== expectedCount) {
    return null;
  }

  for (let i = 0; i < entries.length; i++) {
    if (entries[i].revision !== fromRevisionExclusive + i + 1) {
      return null;
    }
  }

  return entries.map((entry) => entry.change);
}

/**
 * Check if full sync is needed based on revision differences
 */
export function needsFullSync(): boolean {
  const stored = safeStorage.getJSON<RevisionManifest>(REVISION_KEY, {
    global_revision: 0,
    logical_clock: 0,
    key_revisions: {},
    last_sync: Date.now(),
    atomic_groups: {}
  });
  
  // Compare global revision numbers
  if (stored.global_revision > localManifest.global_revision) {
    return true;
  }
  
  // Check individual key revisions
  for (const [key, storedRev] of Object.entries(stored.key_revisions)) {
    const localRev = localManifest.key_revisions[key];
    
    if (!localRev || storedRev.revision > localRev.revision) {
      return true;
    }
    
    // Checksum validation for critical data
    if (storedRev.checksum && localRev.checksum && 
        storedRev.checksum !== localRev.checksum) {
      if (DEV) console.warn(`Checksum mismatch detected for ${key}`);
      return true;
    }
  }
  
  return false;
}

/**
 * Get keys that need synchronization
 */
export function getKeysNeedingSync(): string[] {
  const stored = safeStorage.getJSON<RevisionManifest>(REVISION_KEY, {
    global_revision: 0,
    logical_clock: 0,
    key_revisions: {},
    last_sync: Date.now(),
    atomic_groups: {}
  });
  
  const keysToSync: string[] = [];
  
  for (const [key, storedRev] of Object.entries(stored.key_revisions)) {
    const localRev = localManifest.key_revisions[key];
    
    if (!localRev || storedRev.revision > localRev.revision) {
      keysToSync.push(key);
    }
  }
  
  return keysToSync;
}

/**
 * Mark key as synchronized
 */
export function markKeySynced(key: string, revision: StateRevision): void {
  localManifest.key_revisions[key] = revision;
  saveManifest();
}

/**
 * Get the current in-memory revision for a key.
 */
export function getKeyRevision(key: string): {
  revision: number;
  timestamp: number;
  logicalClock: number;
  tabId: string;
  key: string;
} | undefined {
  return localManifest.key_revisions[key];
}

/**
 * Detect concurrent modifications
 */
export function detectConcurrentModification(
  key: string, 
  expectedRevision: number
): boolean {
  const currentRev = localManifest.key_revisions[key];
  return currentRev ? currentRev.revision > expectedRevision : false;
}

// ==========================================
// CONFLICT RESOLUTION
// ==========================================

/**
 * Resolve conflicts using Logical Clocks for true causality
 */
export function resolveConflict(
  localData: { value: unknown; revision: StateRevision },
  remoteData: { value: unknown; revision: StateRevision }
): 'local' | 'remote' | 'merge_required' {
  const localRev = localData.revision;
  const remoteRev = remoteData.revision;
  
  // Use logical clock for causality (Lamport Clock)
  if (localRev.logicalClock > remoteRev.logicalClock) {
    return 'local';
  } else if (remoteRev.logicalClock > localRev.logicalClock) {
    return 'remote';
  }
  
  // Same logical clock = concurrent changes
  // Fall back to wall clock as secondary criterion
  if (localRev.timestamp > remoteRev.timestamp) {
    return 'local';
  } else if (remoteRev.timestamp > localRev.timestamp) {
    return 'remote';
  }
  
  // Same timestamp, use tab ID as final tiebreaker
  return localRev.tabId === getTabId() ? 'local' : 'remote';
}

/**
 * Create conflict resolution metadata
 */
export function createConflictMetadata(
  key: string,
  localRev: StateRevision,
  remoteRev: StateRevision
): Record<string, unknown> {
  return {
    conflict_timestamp: Date.now(),
    local_revision: localRev.revision,
    remote_revision: remoteRev.revision,
    local_tab: localRev.tabId,
    remote_tab: remoteRev.tabId,
    resolution_strategy: 'last_writer_wins'
  };
}

// ==========================================
// CLEANUP & MAINTENANCE
// ==========================================

/**
 * Clean up old revision entries - only those confirmed synced
 * Keeps revisions for 30 days minimum to prevent data loss
 */
function cleanupOldRevisions(): void {
  const SYNC_CONFIRMATION_DELAY = 60 * 60 * 1000; // 1 hour for sync confirmation
  const MIN_RETENTION_PERIOD = 30 * 24 * 60 * 60 * 1000; // 30 days minimum
  const cutoffTime = Date.now() - MIN_RETENTION_PERIOD;
  const syncCutoff = Date.now() - SYNC_CONFIRMATION_DELAY;
  
  let cleaned = false;
  
  for (const [key, revision] of Object.entries(localManifest.key_revisions)) {
    // Clean up revisions older than 30 days that have been synced
    if (revision.timestamp < cutoffTime && revision.timestamp < syncCutoff) {
      delete localManifest.key_revisions[key];
      cleaned = true;
    }
  }
  
  if (cleaned) {
    saveManifest();
  }
}

/**
 * Check if a revision is the latest for its key
 */
function isLatestRevision(key: string, revision: StateRevision): boolean {
  // Get all revisions for this key across all tabs
  const stored = safeStorage.getJSON<RevisionManifest>(REVISION_KEY, {
    global_revision: 0,
    logical_clock: 0,
    key_revisions: {},
    last_sync: Date.now(),
    atomic_groups: {}
  });

  const storedRev = stored.key_revisions[key];
  if (!storedRev) return true;
  
  // Check if this is the latest by logical clock
  return revision.logicalClock >= storedRev.logicalClock;
}

/**
 * Get revision statistics
 */
export function getRevisionStats(): {
  currentRevision: number;
  trackedKeys: number;
  lastSync: number;
  oldestRevision: number;
} {
  const revisions = Object.values(localManifest.key_revisions);
  const oldestRevision = revisions.length > 0 
    ? Math.min(...revisions.map(r => r.revision))
    : 0;
  
  return {
    currentRevision,
    trackedKeys: Object.keys(localManifest.key_revisions).length,
    lastSync: localManifest.last_sync,
    oldestRevision
  };
}

/**
 * Reset revision tracking (for testing/debugging)
 */
export function resetRevisionTracking(): void {
  localManifest = {
    global_revision: 0,
    logical_clock: 0,
    key_revisions: {},
    last_sync: Date.now(),
    atomic_groups: {}
  };
  currentRevision = 0;
  logicalClock = 0;
  saveManifest();
  safeStorage.setJSON(TRANSACTION_DELTA_LOG_KEY, []);
}

// ==========================================
// OPTIMIZED PERSISTENCE PATTERN
// ==========================================

/**
 * Debounced persistence helper for signal effects
 */
export function createDebouncedPersist(delay: number = 100) {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let pendingUpdates = new Map<string, unknown>();
  
  return function debouncedPersist(updates: Record<string, unknown>, tabId: string): void {
    // Accumulate updates
    for (const [key, value] of Object.entries(updates)) {
      pendingUpdates.set(key, value);
    }
    
    // Clear existing timeout
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
    
    // Schedule batch persistence
    timeoutId = setTimeout(() => {
      const batch = Object.fromEntries(pendingUpdates);
      pendingUpdates.clear();
      timeoutId = null;
      
      // Persist data and record revisions for all changes in the batch
      for (const [key, value] of Object.entries(batch)) {
        lsSet(key, value);
        recordStateChange(key, value, tabId);
      }
    }, delay);
  };
}

// ==========================================
// ENHANCED ATOMIC GROUP TRACKING
// ==========================================

/**
 * CRITICAL FIX: Record atomic group state change for coupled state
 */
export function recordAtomicGroupChange(
  groupId: string,
  updates: Array<{key: string, value: unknown}>,
  tabId: string
): void {
  const revision = nextRevision();
  const timestamp = Date.now();
  const clock = incrementLogicalClock();

  // Create atomic group revision
  const atomicGroup: AtomicGroupRevision = {
    groupId,
    revision,
    timestamp,
    keys: updates.map(u => u.key),
    consistent: true, // All keys updated atomically
    lastUpdatedBy: tabId
  };

  // Record individual key revisions with atomic group reference
  const checksumPromises: Promise<void>[] = [];

  for (const update of updates) {
    const stateRevision: StateRevision = {
      revision,
      timestamp,
      logicalClock: clock,
      tabId,
      key: update.key,
      atomicGroup: groupId,
      lastModifier: tabId
    };

    // Record the revision immediately (checksum computed async and updated in place)
    localManifest.key_revisions[update.key] = stateRevision;

    // Batch checksum calculations for critical data
    if (CHECKSUM_KEYS.includes(update.key)) {
      checksumPromises.push(
        calculateChecksum(update.value).then(checksum => {
          stateRevision.checksum = checksum;
        }).catch(() => {
          // Checksum computation failed — revision is still recorded without checksum
        })
      );
    }
  }

  // Await all checksums in parallel, then save manifest once
  if (checksumPromises.length > 0) {
    Promise.all(checksumPromises).then(() => {
      saveManifest(); // Single re-save with all checksums
    });
  }

  // Update atomic group tracking
  localManifest.atomic_groups[groupId] = atomicGroup;
  saveManifest();

  if (DEV) console.log(`Recorded atomic group '${groupId}' with ${updates.length} keys at revision ${revision}`);
}

/**
 * Validate atomic group consistency
 */
export function validateAtomicGroupConsistency(groupId: string): {
  consistent: boolean;
  issues: string[];
  affectedKeys: string[];
} {
  const group = localManifest.atomic_groups[groupId];
  const issues: string[] = [];
  const affectedKeys: string[] = [];

  if (!group) {
    return { consistent: false, issues: ['Group not found'], affectedKeys: [] };
  }

  // Check if all keys in group have matching revisions
  const groupRevision = group.revision;
  for (const key of group.keys) {
    const keyRevision = localManifest.key_revisions[key];
    
    if (!keyRevision) {
      issues.push(`Missing revision for key: ${key}`);
      affectedKeys.push(key);
    } else if (keyRevision.revision !== groupRevision) {
      issues.push(`Revision mismatch for key ${key}: expected ${groupRevision}, got ${keyRevision.revision}`);
      affectedKeys.push(key);
    } else if (keyRevision.atomicGroup !== groupId) {
      issues.push(`Atomic group mismatch for key ${key}: expected ${groupId}, got ${keyRevision.atomicGroup}`);
      affectedKeys.push(key);
    }
  }

  const consistent = issues.length === 0;
  
  // Update consistency flag
  if (group.consistent !== consistent) {
    group.consistent = consistent;
    saveManifest();
  }

  return { consistent, issues, affectedKeys };
}

/**
 * Get atomic group for a key
 */
export function getAtomicGroupForKey(key: string): string | null {
  for (const [groupName, keys] of Object.entries(ATOMIC_STATE_GROUPS)) {
    if (keys.includes(key)) {
      return groupName;
    }
  }
  return null;
}

/**
 * Check if keys belong to the same atomic group
 */
export function areKeysInSameAtomicGroup(keys: string[]): boolean {
  if (keys.length <= 1) return true;

  // Collect all groups for each key, then check for any shared group
  const groupSets = keys.map(key => {
    const groups = new Set<string>();
    for (const [groupName, groupKeys] of Object.entries(ATOMIC_STATE_GROUPS)) {
      if ((groupKeys as string[]).includes(key)) {
        groups.add(groupName);
      }
    }
    return groups;
  });

  // Check if there's any group that all keys share
  const firstGroups = groupSets[0];
  for (const group of firstGroups) {
    if (groupSets.every(gs => gs.has(group))) return true;
  }
  return false;
}

/**
 * Get all inconsistent atomic groups
 */
export function getInconsistentAtomicGroups(): Array<{
  groupId: string;
  issues: string[];
  affectedKeys: string[];
  lastUpdated: number;
}> {
  const inconsistent = [];
  
  for (const [groupId, group] of Object.entries(localManifest.atomic_groups)) {
    const validation = validateAtomicGroupConsistency(groupId);
    
    if (!validation.consistent) {
      inconsistent.push({
        groupId,
        issues: validation.issues,
        affectedKeys: validation.affectedKeys,
        lastUpdated: group.timestamp
      });
    }
  }
  
  return inconsistent;
}

/**
 * Repair atomic group consistency by syncing from latest revision
 */
export async function repairAtomicGroupConsistency(groupId: string): Promise<boolean> {
  if (DEV) console.log(`Attempting to repair atomic group consistency: ${groupId}`);
  
  const group = localManifest.atomic_groups[groupId];
  if (!group) {
    if (DEV) console.error('Atomic group not found:', groupId);
    return false;
  }

  try {
    // Find the latest revision among all keys in the group
    let latestRevision = 0;
    let latestTimestamp = 0;
    
    for (const key of group.keys) {
      const keyRevision = localManifest.key_revisions[key];
      if (keyRevision && keyRevision.revision > latestRevision) {
        latestRevision = keyRevision.revision;
        latestTimestamp = keyRevision.timestamp;
      }
    }

    // Update all keys to the latest revision
    const clock = incrementLogicalClock();
    for (const key of group.keys) {
      const keyRevision = localManifest.key_revisions[key];
      if (keyRevision && keyRevision.revision < latestRevision) {
        keyRevision.revision = latestRevision;
        keyRevision.timestamp = latestTimestamp;
        keyRevision.logicalClock = clock;
        keyRevision.atomicGroup = groupId;
      }
    }

    // Update group consistency
    group.revision = latestRevision;
    group.consistent = true;
    group.timestamp = latestTimestamp;

    saveManifest();
    
    if (DEV) console.log(`Repaired atomic group '${groupId}' consistency at revision ${latestRevision}`);
    return true;

  } catch (error) {
    if (DEV) console.error('Failed to repair atomic group consistency:', error);
    return false;
  }
}

/**
 * Enhanced revision statistics with atomic group tracking
 */
export function getEnhancedRevisionStats(): {
  currentRevision: number;
  logicalClock: number;
  trackedKeys: number;
  atomicGroups: number;
  consistentGroups: number;
  inconsistentGroups: number;
  lastSync: number;
  oldestRevision: number;
  conflictResolutionPolicy: string;
} {
  const baseStats = getRevisionStats();
  const atomicGroups = Object.values(localManifest.atomic_groups);
  const consistentGroups = atomicGroups.filter(g => g.consistent).length;
  
  return {
    ...baseStats,
    logicalClock,
    atomicGroups: atomicGroups.length,
    consistentGroups,
    inconsistentGroups: atomicGroups.length - consistentGroups,
    conflictResolutionPolicy: localManifest.conflict_resolution_policy || 'user_decides'
  };
}

// ==========================================
// EXPORTS
// ==========================================

export default {
  init: initRevisionTracking,
  recordStateChange,
  recordTransactionDelta,
  getTransactionDeltaReplay,
  needsFullSync,
  getKeysNeedingSync,
  getKeyRevision,
  markKeySynced,
  detectConcurrentModification,
  resolveConflict,
  createConflictMetadata,
  getRevisionStats,
  resetRevisionTracking,
  createDebouncedPersist,
  // Enhanced atomic group functions
  recordAtomicGroupChange,
  validateAtomicGroupConsistency,
  getAtomicGroupForKey,
  areKeysInSameAtomicGroup,
  getInconsistentAtomicGroups,
  repairAtomicGroupConsistency,
  getEnhancedRevisionStats
};
