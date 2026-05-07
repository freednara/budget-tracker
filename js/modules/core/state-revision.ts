/**
 * State Revision Tracking Module
 * 
 * Implements revision-based state synchronization to optimize multi-tab sync
 * and prevent unnecessary full syncs on tab visibility changes.
 */

import { SK, lsSet } from './state.js';
import { safeStorage } from './safe-storage.js';
import { trackError } from './error-tracker.js';
import type { TransactionDataChange } from '../../types/index.js';

const DEV = import.meta.env.DEV;

// ==========================================
// TYPES
// ==========================================

// Phase 6 cleanup (no-explicit-any sweep): exported so multi-tab-sync.ts
// can type the buildRemoteRevision return value directly instead of using
// `as any` casts at the markKeySynced call sites.
export interface StateRevision {
  revision: number;
  timestamp: number;
  logicalClock: number;  // Lamport clock for causality
  vectorClock?: Record<string, number>;  // Optional vector clock for complex scenarios
  tabId: string;
  key: string;
  checksum?: string | undefined;
  atomicGroup?: string; // For tracking coupled state updates
  lastModifier?: string; // Tab that made the last change
}

// STATE-03: Schema version for the revision manifest. Bump when the
// manifest shape changes so loadManifest() can detect stale formats
// and migrate them forward instead of silently misinterpreting fields.
const MANIFEST_SCHEMA_VERSION = 2; // v2: added schema_version, checksum algorithm prefix (STATE-06)

interface RevisionManifest {
  schema_version?: number; // STATE-03: absent in v1 manifests, present (≥2) going forward
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

const REVISION_KEY = 'harbor_state_revision';
const CHECKSUM_KEYS = [SK.TX]; // Keys requiring checksum validation
const TRANSACTION_DELTA_LOG_KEY = 'harbor_tx_delta_log';
const MAX_TRANSACTION_DELTA_LOG_ENTRIES = 64;

// ==========================================
// MODULE STATE
// ==========================================

let currentRevision = 0;
let logicalClock = 0;
// Phase 6 Slice 1d (Inline-Behavior-Review rev 12, L10): once-per-session
// latch for the SubtleCrypto -> XXHash32 fallback telemetry. SHA-256 gives
// 256 bits of collision resistance; xxHash32 gives ~77k revisions before
// a ~1% birthday-bound collision risk, which is a real concern over a
// multi-year app lifetime. Without telemetry the downgrade is silent —
// the dashboard cannot distinguish "crypto.subtle works everywhere" from
// "30% of installs are running on a 32-bit hash". First-fire-per-session
// pattern mirrors getMonthAlloc (rev 12 / #39 M4): the downgrade reason
// is platform-stable across a session, so reporting once is sufficient.
let hasReportedXxHashFallback = false;
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
  CATEGORY_CORE: [SK.USER_CATS, SK.TX]
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
    schema_version: MANIFEST_SCHEMA_VERSION,
    global_revision: 0,
    logical_clock: 0,
    key_revisions: {},
    last_sync: Date.now(),
    atomic_groups: {}
  });

  // STATE-03: Migrate v1 manifests (missing schema_version) to v2.
  // v2 added algorithm-prefixed checksums (STATE-06); existing v1
  // checksums are bare hex strings that won't match the new format,
  // so strip them — they'll be recomputed on the next write.
  if (!stored.schema_version || stored.schema_version < MANIFEST_SCHEMA_VERSION) {
    for (const rev of Object.values(stored.key_revisions)) {
      if (rev.checksum && !rev.checksum.includes(':')) {
        rev.checksum = undefined;
      }
    }
    stored.schema_version = MANIFEST_SCHEMA_VERSION;
  }

  localManifest = stored;
  currentRevision = stored.global_revision;
  logicalClock = stored.logical_clock || 0;
}

/**
 * Save revision manifest to storage
 */
function saveManifest(): void {
  localManifest.last_sync = Date.now();
  localManifest.schema_version = MANIFEST_SCHEMA_VERSION;
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
    // STATE-06: Prefix with algorithm so cross-device comparison can detect
    // mismatched hash algorithms (SHA-256 vs xxHash32 fallback).
    return `sha256:${hashHex}`;
  } catch (error) {
    if (DEV) console.error('Failed to calculate SHA-256 checksum:', error);
    // Phase 6 Slice 1d (Inline-Behavior-Review rev 12, L10): surface the
    // entropy downgrade to monitoring. SubtleCrypto is unavailable in a
    // handful of WebView / Capacitor / legacy-browser contexts, and
    // before this telemetry the fallback fired silently in production —
    // we had no way to know whether any install was actually using it.
    // Fire once per session; the condition is platform-stable within a
    // running JS context so subsequent misses carry no new information.
    if (!hasReportedXxHashFallback) {
      hasReportedXxHashFallback = true;
      trackError(
        'calculateChecksum: SubtleCrypto unavailable; falling back to xxHash32 (checksum entropy downgraded from 256 bits to 32 bits)',
        { module: 'state-revision', action: 'xxhash_fallback_engaged' },
        'validationError'
      );
    }
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
  
  // STATE-06: Prefix with algorithm identifier
  return `xxh32:${h32.toString(16).padStart(8, '0')}`;
}

// ==========================================
// STATE CHANGE TRACKING
// ==========================================

/**
 * Record a state change with revision tracking
 */
/**
 * CR-Apr24-I finding 211: lightweight per-key cache of the last value
 * JSON. `recordStateChange` compares incoming values against this cache
 * and short-circuits when nothing changed, preventing phantom revision
 * bumps on no-op writes (e.g. a signal batcher flush after a reload
 * where every value is still identical to storage). The cache is keyed
 * by storage key and stores the JSON string; for large payloads like
 * SK.TX this is bounded by the stringify cost which we're already paying
 * for the checksum path.
 */
const lastValueJsonCache = new Map<string, string>();

export async function recordStateChange(
  key: string,
  value: unknown,
  tabId: string,
  options: { skipChecksum?: boolean; remoteClock?: number } = {}
): Promise<StateRevision> {
  // CR-Apr24-I finding 211: skip no-op writes that would mint a fresh
  // revision for an unchanged value. Compare via JSON string — cheap
  // enough for settings keys (small payloads), and bounded by the
  // stringify cost we'd hit anyway for checksum computation on TX keys.
  const valueJson = JSON.stringify(value);
  const lastJson = lastValueJsonCache.get(key);
  if (lastJson !== undefined && lastJson === valueJson) {
    // Return the existing revision without incrementing
    const existing = localManifest.key_revisions[key];
    if (existing) return existing;
  }
  lastValueJsonCache.set(key, valueJson);

  const revision = nextRevision();
  const timestamp = Date.now();
  
  // Update logical clock.
  //
  // Use `!== undefined` rather than a truthy check: a peer's very first
  // event legitimately carries `logicalClock: 0`, and a truthy check would
  // treat that as "no remote clock supplied" and fall through to a local
  // increment — violating the Lamport invariant `max(local, remote) + 1`.
  // Latent today (no caller passes remoteClock), but lands before the
  // Firestore Phase 3 integration that would surface the bug.
  // Fixes L9 (Inline-Behavior-Review rev 12).
  const clock = options.remoteClock !== undefined
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
    // Phase 6 Slice 1i (rev 12 L6): `entries[i]` is `T | undefined`
    // under `noUncheckedIndexedAccess`; the `i < entries.length` bound
    // guarantees presence, but a local narrow avoids a non-null
    // assertion and returns `null` on any gap (same as a bad revision).
    const entry = entries[i];
    if (!entry || entry.revision !== fromRevisionExclusive + i + 1) {
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
    
    // STATE-06: Checksum validation for critical data.
    // Only compare when both sides have checksums AND use the same algorithm
    // (prefix before ':'). Mismatched algorithms (e.g. sha256 vs xxh32 across
    // devices with different SubtleCrypto support) are not comparable and
    // should not trigger a false-positive conflict.
    if (storedRev.checksum && localRev.checksum) {
      const storedAlgo = storedRev.checksum.split(':')[0];
      const localAlgo = localRev.checksum.split(':')[0];
      if (storedAlgo === localAlgo && storedRev.checksum !== localRev.checksum) {
        if (DEV) console.warn(`Checksum mismatch detected for ${key}`);
        return true;
      }
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
 * Round 7 fix: advance the local global_revision to match the stored
 * manifest after a full sync completes.
 *
 * Without this, `needsFullSync()` perpetually returns `true` on every
 * visibility change because `performFullSync()` only calls
 * `markKeySynced()` on individual keys — it never advances
 * `localManifest.global_revision`. The stored manifest (written by
 * whichever tab last modified state) has a higher `global_revision`,
 * so the comparison `stored.global_revision > localManifest.global_revision`
 * fires on every tab-switch, hammering localStorage with redundant
 * reads and signal replays.
 */
export function advanceGlobalRevisionAfterSync(): void {
  const stored = safeStorage.getJSON<RevisionManifest>(REVISION_KEY, {
    global_revision: 0,
    logical_clock: 0,
    key_revisions: {},
    last_sync: Date.now(),
    atomic_groups: {}
  });

  if (stored.global_revision > localManifest.global_revision) {
    localManifest.global_revision = stored.global_revision;
    currentRevision = Math.max(currentRevision, stored.global_revision);
  }
  if (stored.logical_clock > localManifest.logical_clock) {
    localManifest.logical_clock = stored.logical_clock;
    logicalClock = Math.max(logicalClock, stored.logical_clock);
  }
  localManifest.last_sync = Date.now();
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
  
  // Same timestamp — commutative tiebreaker: both tabs must compute the
  // same answer for this conflict pair or state silently diverges. The
  // previous check `localRev.tabId === getTabId()` was evaluated from each
  // tab's own perspective, so Tab A resolved to 'local' (A wins) and Tab B
  // also resolved to 'local' (B wins) for the same conflict. Lexicographic
  // comparison of the two tab IDs is a pure function of the pair, so both
  // tabs converge on the same winner. Fixes C9 (Inline-Behavior-Review rev 12).
  return localRev.tabId < remoteRev.tabId ? 'local' : 'remote';
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
  const pendingUpdates = new Map<string, unknown>();
  
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
        void recordStateChange(key, value, tabId);
      }
    }, delay);
  };
}

/**
 * STATE-02: Compare-And-Swap write — only persists if the key's current
 * revision matches `expectedRevision`. Returns true if the write succeeded,
 * false if a concurrent modification was detected (caller should re-read
 * and retry or surface a conflict).
 *
 * This is the building block for safe multi-tab writes; callers that
 * can tolerate last-writer-wins semantics can continue using lsSet directly.
 */
export function casWrite(
  key: string,
  value: unknown,
  expectedRevision: number,
  tabId: string
): boolean {
  if (detectConcurrentModification(key, expectedRevision)) {
    trackError(
      `CAS write rejected for ${key}: expected revision ${expectedRevision}, current is higher`,
      { module: 'state-revision', action: 'cas_write_rejected' },
      'validationError'
    );
    return false;
  }
  lsSet(key, value);
  void recordStateChange(key, value, tabId);
  return true;
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
      const keyName = update.key;
      checksumPromises.push(
        calculateChecksum(update.value).then(checksum => {
          stateRevision.checksum = checksum;
        }).catch((err: unknown) => {
          // STATE-05: Checksum computation failed. Set checksum to
          // undefined so drift detection treats this key as "no checksum
          // available" rather than storing a sentinel string that could
          // false-positive against a real hash on the other side of a
          // comparison. The error is still tracked below for visibility.
          //
          // Fixes C2 (Inline-Behavior-Review rev 12): previously the
          // .catch() swallowed the error silently.
          stateRevision.checksum = undefined;
          trackError(err instanceof Error ? err : new Error(String(err)), {
            module: 'state-revision',
            action: `checksum:${keyName}@group:${groupId}`
          });
        })
      );
    }
  }

  // Await all checksums in parallel, then save manifest once.
  //
  // Fixes C3 (Inline-Behavior-Review rev 12): the Promise.all result was
  // unawaited and un-.catch()-ed, so even though individual checksum
  // promises have their own .catch() above, any synchronous throw inside
  // saveManifest() would produce an unhandled-rejection. Attach a final
  // .catch() to route those failures through trackError instead of the
  // global rejection handler.
  if (checksumPromises.length > 0) {
    Promise.all(checksumPromises).then(() => {
      saveManifest(); // Single re-save with all checksums
    }).catch((err: unknown) => {
      trackError(err instanceof Error ? err : new Error(String(err)), {
        module: 'state-revision',
        action: `finalizeChecksums@group:${groupId}`
      });
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
      if ((groupKeys).includes(key)) {
        groups.add(groupName);
      }
    }
    return groups;
  });

  // Check if there's any group that all keys share.
  // Phase 6 Slice 1i (rev 12 L6): `groupSets[0]` is `Set<string> | undefined`
  // under `noUncheckedIndexedAccess`; guard and bail out when empty.
  const firstGroups = groupSets[0];
  if (!firstGroups) return false;
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
  advanceGlobalRevisionAfterSync,
  detectConcurrentModification,
  casWrite,
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
