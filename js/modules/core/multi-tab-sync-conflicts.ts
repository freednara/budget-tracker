/**
 * Multi-Tab Sync Conflict Resolution
 * 
 * Handles conflict detection and resolution for multi-tab synchronization.
 * Extracted from multi-tab-sync.ts to improve modularity.
 * 
 * @module multi-tab-sync-conflicts
 */

import { lsGet, lsSet } from './state.js';
import { showToast } from '../ui/core/ui.js';
import { emit } from './event-bus.js';
import type { Transaction, SavingsGoal } from '../../types/index.js';

// ==========================================
// TYPE DEFINITIONS
// ==========================================

export interface ConflictResolution {
  strategy: 'local' | 'remote' | 'merge' | 'manual';
  resolved: boolean;
  mergedValue?: unknown;
}

export interface UserActivityState {
  isTyping: boolean;
  activeField?: string;
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
 * Resolve conflict using the specified strategy
 */
export function resolveConflict(conflict: ConflictData): ConflictResolution {
  const { key, localValue, remoteValue, userActivity } = conflict;
  
  // If user is actively editing, prefer local
  if (hasActiveUserInteraction(userActivity)) {
    return {
      strategy: 'local',
      resolved: true,
      mergedValue: localValue
    };
  }
  
  // For transactions, try to merge
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
  
  // For numeric values, use the larger (more recent activity)
  if (typeof localValue === 'number' && typeof remoteValue === 'number') {
    return {
      strategy: 'remote',
      resolved: true,
      mergedValue: Math.max(localValue, remoteValue)
    };
  }
  
  // Default to remote (most recent)
  return {
    strategy: 'remote',
    resolved: true,
    mergedValue: remoteValue
  };
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
        showToast('Data synchronized and merged from another tab', 'info');
      } else if (resolution.strategy === 'local') {
        showToast('Kept your local changes during sync', 'info');
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
    const resolution = resolutions[index];
    if (resolution.resolved && resolution.mergedValue !== undefined) {
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