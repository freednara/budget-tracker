/**
 * Multi-Tab Sync Conflict Resolution
 * 
 * Handles conflict detection and resolution for multi-tab synchronization.
 * Extracted from multi-tab-sync.ts to improve modularity.
 * 
 * @module multi-tab-sync-conflicts
 */

import { lsSet, lsGet } from './state.js';
import { emit, Events } from './event-bus.js';
import { trackError } from './error-tracker.js';
import type { Transaction } from '../../types/index.js';

// ==========================================
// TYPE DEFINITIONS
// ==========================================

export interface ConflictResolution {
  strategy: 'local' | 'remote' | 'merge' | 'manual';
  resolved: boolean;
  mergedValue?: unknown;
}

// Phase 6 Slice 1j (rev 12 L6): `activeField` widened so callers can
// assign explicit `undefined` (e.g. `markUserStoppedTyping()` clearing
// the field) under `exactOptionalPropertyTypes`.
export interface UserActivityState {
  isTyping: boolean;
  activeField?: string | undefined;
  lastActivity: number;
  unsavedChanges: boolean;
}

export interface ConflictData {
  key: string;
  localValue: unknown;
  remoteValue: unknown;
  timestamp: number;
  userActivity?: UserActivityState;
}

// ==========================================
// CONFLICT DETECTION
// ==========================================

/**
 * Check if there's an active user interaction that could conflict
 */
export function hasActiveUserInteraction(userActivity?: UserActivityState): boolean {
  if (!userActivity) return false;
  
  const now = Date.now();
  const ACTIVITY_THRESHOLD = 5000; // 5 seconds
  
  return (
    userActivity.isTyping ||
    userActivity.unsavedChanges ||
    (now - userActivity.lastActivity) < ACTIVITY_THRESHOLD
  );
}

/**
 * Detect if values have conflicting changes
 */
export function detectConflict(localValue: unknown, remoteValue: unknown): boolean {
  // No conflict if values are the same
  if (JSON.stringify(localValue) === JSON.stringify(remoteValue)) {
    return false;
  }
  
  // Arrays with different content are always a conflict (stringify already proved they differ)
  if (Array.isArray(localValue) && Array.isArray(remoteValue)) {
    return true;
  }
  
  // If we reach here, stringify already proved the values differ — that's a conflict
  return true;
}

// ==========================================
// CONFLICT RESOLUTION STRATEGIES
// ==========================================

/**
 * Resolve conflict using the specified strategy.
 *
 * Every branch MUST be commutative w.r.t. the (local, remote) pair:
 * Tab A evaluates (A, B) and Tab B evaluates (B, A) for the same
 * conflict. If the two calls pick different values, the tabs swap
 * state and silently diverge. See Inline-Behavior-Review rev 12 C9.
 *
 * The ConflictData contract here does not carry logical clocks or
 * tab IDs, so we can't apply the full (logicalClock, timestamp, tabId)
 * comparator used in state-revision.ts. The commutative fallback is a
 * deterministic comparator over the *values themselves* — both tabs
 * compute the same answer regardless of which side is "local".
 */
export function resolveConflict(conflict: ConflictData): ConflictResolution {
  const { key, localValue, remoteValue, userActivity } = conflict;

  // Active-user bias: if a user is actively editing on this tab, prefer
  // local. Note this is *not* fully commutative when both tabs are
  // actively editing at the same instant — each tab picks its own value
  // and they diverge. That split-brain is accepted here because the
  // caller is expected to promote simultaneous-edit cases to
  // merge_required / manual resolution upstream. For the common case
  // (exactly one tab is actively editing), this behaves correctly.
  if (hasActiveUserInteraction(userActivity)) {
    return {
      strategy: 'local',
      resolved: true,
      mergedValue: localValue
    };
  }

  // For transactions, try to merge. `mergeTransactions` unions by
  // __backendId so it's commutative on the pair.
  if (key.includes('transaction')) {
    const merged = mergeTransactions(
      localValue as Transaction[],
      remoteValue as Transaction[]
    );
    if (merged) {
      return {
        strategy: 'merge',
        resolved: true,
        mergedValue: merged
      };
    }
  }

  // Deterministic fallback: pick whichever value sorts lexicographically
  // smaller by JSON representation. This is *commutative by construction*
  // — (A, B) and (B, A) both return the min of {A, B}. The choice isn't
  // semantically motivated (smaller vs. larger), but it converges, which
  // matters more than the arbitrary winner when there's no richer signal
  // to break the tie.
  //
  // Previous behavior:
  //   - Numeric branch used Math.max, which silently reverted any decrease
  //     (goal balance correction, allocation reduction, debt paydown).
  //   - Default branch returned `remote`, which from each tab's perspective
  //     meant "keep the other tab's value" — a deterministic swap.
  // Fixes C9 (Inline-Behavior-Review rev 12). C10 (Math.max semantics) is
  // collaterally fixed by the same change.
  const localKey = stableStringify(localValue);
  const remoteKey = stableStringify(remoteValue);
  if (localKey <= remoteKey) {
    return {
      strategy: 'local',
      resolved: true,
      mergedValue: localValue
    };
  }
  return {
    strategy: 'remote',
    resolved: true,
    mergedValue: remoteValue
  };
}

/**
 * JSON.stringify produces different output for the same object depending
 * on key insertion order, which would break the commutativity of the
 * comparator. Stable stringify sorts object keys recursively so the same
 * logical value always produces the same key.
 */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v).sort()) {
        sorted[k] = (v as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return v;
  });
}

/**
 * Merge transaction arrays intelligently
 */
export function mergeTransactions(
  local: Transaction[],
  remote: Transaction[]
): Transaction[] | null {
  try {
    const merged = new Map<string, Transaction>();
    
    // Add all remote transactions
    remote.forEach(tx => {
      if (tx.__backendId) {
        merged.set(tx.__backendId, tx);
      }
    });
    
    // Overlay local transactions (prefer local for conflicts)
    local.forEach(tx => {
      if (tx.__backendId) {
        const remoteTx = merged.get(tx.__backendId);
        if (remoteTx) {
          // Local tab always wins on conflict (tx.date is YYYY-MM-DD, not a proper timestamp)
          merged.set(tx.__backendId, tx);
        } else {
          merged.set(tx.__backendId, tx);
        }
      }
    });
    
    return Array.from(merged.values());
  } catch (error) {
    if (import.meta.env.DEV) console.error('Failed to merge transactions:', error);
    return null;
  }
}

// ==========================================
// CONFLICT RESOLUTION UI
// ==========================================

/**
 * Show conflict resolution UI to the user
 */
export function showConflictUI(conflicts: ConflictData[]): Promise<ConflictResolution[]> {
  return new Promise((resolve) => {
    // For now, auto-resolve with notification
    const resolutions = conflicts.map(conflict => {
      const resolution = resolveConflict(conflict);
      
      if (resolution.strategy === 'merge') {
        emit(Events.SHOW_TOAST, { message: 'Changes from another tab have been merged.', type: 'info' });
      } else if (resolution.strategy === 'local') {
        emit(Events.SHOW_TOAST, { message: 'Your changes were kept. The other tab\u2019s changes were skipped.', type: 'info' });
      }
      
      return resolution;
    });
    
    resolve(resolutions);
  });
}

/**
 * Apply conflict resolutions
 */
export function applyResolutions(
  conflicts: ConflictData[],
  resolutions: ConflictResolution[]
): void {
  conflicts.forEach((conflict, index) => {
    // Phase 6 Slice 1i (rev 12 L6): `resolutions[index]` is
    // `ConflictResolution | undefined` under
    // `noUncheckedIndexedAccess`. Callers are expected to pass
    // 1:1 aligned arrays; skip defensively on any gap rather than
    // crash mid-apply.
    const resolution = resolutions[index];
    if (resolution && resolution.resolved && resolution.mergedValue !== undefined) {
      // STATE-04: Re-validate that local state hasn't changed since the
      // conflict was captured. If another tab updated this key while the
      // user was deciding, the conflict is stale and applying the old
      // resolution could overwrite newer data.
      const currentValue = lsGet(conflict.key, undefined);
      const currentJson = JSON.stringify(currentValue);
      const capturedJson = JSON.stringify(conflict.localValue);
      if (currentJson !== capturedJson) {
        trackError(
          `Stale conflict resolution skipped for ${conflict.key}: local value changed since conflict was detected`,
          { module: 'multi-tab-sync-conflicts', action: 'stale_conflict_skip' },
          'validationError'
        );
        emit('conflict:stale', { key: conflict.key, strategy: resolution.strategy });
        return; // Skip this resolution — the conflict should be re-detected
      }

      // Apply the resolved value
      lsSet(conflict.key, resolution.mergedValue);

      // Emit update event
      emit('conflict:resolved', {
        key: conflict.key,
        strategy: resolution.strategy,
        value: resolution.mergedValue
      });
    }
  });
}

// ==========================================
// CONFLICT PREVENTION
// ==========================================

/**
 * Lock a resource to prevent conflicts
 */
export class ResourceLock {
  private locks = new Map<string, { tabId: string; timestamp: number }>();
  private readonly LOCK_TIMEOUT = 30000; // 30 seconds
  
  acquire(resource: string, tabId: string): boolean {
    const now = Date.now();
    const existingLock = this.locks.get(resource);
    
    // Check if existing lock is expired
    if (existingLock && (now - existingLock.timestamp) < this.LOCK_TIMEOUT) {
      return existingLock.tabId === tabId;
    }
    
    // Acquire lock
    this.locks.set(resource, { tabId, timestamp: now });
    return true;
  }
  
  release(resource: string, tabId: string): void {
    const lock = this.locks.get(resource);
    if (lock && lock.tabId === tabId) {
      this.locks.delete(resource);
    }
  }
  
  isLocked(resource: string): boolean {
    const lock = this.locks.get(resource);
    if (!lock) return false;
    
    const now = Date.now();
    return (now - lock.timestamp) < this.LOCK_TIMEOUT;
  }
  
  cleanup(): void {
    const now = Date.now();
    for (const [resource, lock] of this.locks.entries()) {
      if ((now - lock.timestamp) >= this.LOCK_TIMEOUT) {
        this.locks.delete(resource);
      }
    }
  }
}

// Export a singleton instance
export const resourceLock = new ResourceLock();