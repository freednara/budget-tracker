/**
 * Multi-Tab Sync User Activity Tracking
 * 
 * Tracks user interactions to prevent sync conflicts during active editing.
 * Extracted from multi-tab-sync.ts for better modularity.
 * 
 * @module multi-tab-sync-activity
 */

import { debounce } from './utils.js';
import type { UserActivityState } from './multi-tab-sync-conflicts.js';

// ==========================================
// ACTIVITY TRACKING STATE
// ==========================================

let currentActivity: UserActivityState = {
  isTyping: false,
  activeField: undefined,
  lastActivity: Date.now(),
  unsavedChanges: false
};

const ACTIVITY_TIMEOUT = 3000; // 3 seconds of inactivity
let activityTimer: number | null = null;
let trackingInitialized = false;
let activityIntervalId: ReturnType<typeof setInterval> | null = null;
let beforeUnloadRegistered = false;

const trackInput = debounce((event: Event) => {
  const target = event.target as HTMLElement | null;
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
    markUserTyping(target.id);
  }
}, 100);

const trackFocus = (event: Event): void => {
  const target = event.target as HTMLElement | null;
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
    updateUserActivity({
      activeField: target.id
    });
  }
};

const trackBlur = debounce(() => {
  if (!document.activeElement ||
      (document.activeElement.tagName !== 'INPUT' &&
       document.activeElement.tagName !== 'TEXTAREA')) {
    markUserStoppedTyping();
  }
}, 500);

const trackActivity = debounce(() => {
  updateUserActivity({});
}, 1000);

const trackFormChange = (event: Event): void => {
  const target = event.target as HTMLElement | null;
  if (target && target.closest('form')) {
    markUnsavedChanges(true);
  }
};

const handleSubmit = (): void => {
  markUnsavedChanges(false);
};

// ==========================================
// ACTIVITY TRACKING FUNCTIONS
// ==========================================

/**
 * Get current user activity state
 */
export function getUserActivity(): UserActivityState {
  return { ...currentActivity };
}

/**
 * Update user activity state
 */
export function updateUserActivity(updates: Partial<UserActivityState>): void {
  currentActivity = {
    ...currentActivity,
    ...updates,
    lastActivity: Date.now()
  };
  
  // Reset inactivity timer
  if (activityTimer) {
    clearTimeout(activityTimer);
  }
  
  activityTimer = window.setTimeout(() => {
    currentActivity.isTyping = false;
    currentActivity.activeField = undefined;
  }, ACTIVITY_TIMEOUT);
}

/**
 * Mark that user is typing
 */
export function markUserTyping(fieldId?: string): void {
  updateUserActivity({
    isTyping: true,
    activeField: fieldId
  });
}

/**
 * Mark that user has stopped typing
 */
export function markUserStoppedTyping(): void {
  updateUserActivity({
    isTyping: false,
    activeField: undefined
  });
}

/**
 * Mark unsaved changes
 */
export function markUnsavedChanges(hasChanges: boolean): void {
  updateUserActivity({
    unsavedChanges: hasChanges
  });
}

/**
 * Check if user is currently active
 */
export function isUserActive(): boolean {
  const now = Date.now();
  return (
    currentActivity.isTyping ||
    currentActivity.unsavedChanges ||
    (now - currentActivity.lastActivity) < ACTIVITY_TIMEOUT
  );
}

// ==========================================
// DOM EVENT LISTENERS
// ==========================================

/**
 * Set up activity tracking listeners
 */
export function initActivityTracking(): void {
  if (typeof document === 'undefined') {
    return;
  }

  if (trackingInitialized) {
    return;
  }

  // Add listeners
  document.addEventListener('input', trackInput);
  document.addEventListener('focus', trackFocus, true);
  document.addEventListener('blur', trackBlur, true);
  document.addEventListener('click', trackActivity);
  document.addEventListener('keydown', trackActivity);
  document.addEventListener('change', trackFormChange);
  document.addEventListener('submit', handleSubmit);

  if (!activityIntervalId) {
    activityIntervalId = setInterval(saveActivityState, 10000);
  }

  if (typeof window !== 'undefined' && !beforeUnloadRegistered) {
    window.addEventListener('beforeunload', saveActivityState);
    beforeUnloadRegistered = true;
  }

  trackingInitialized = true;
}

// ==========================================
// ACTIVITY MONITORING
// ==========================================

/**
 * Monitor for idle state
 */
export function monitorIdleState(callback: (isIdle: boolean) => void): () => void {
  let idleTimer: number | null = null;
  const IDLE_TIMEOUT = 60000; // 1 minute
  
  const checkIdle = () => {
    const now = Date.now();
    const timeSinceActivity = now - currentActivity.lastActivity;
    const isIdle = timeSinceActivity > IDLE_TIMEOUT && !currentActivity.unsavedChanges;
    
    callback(isIdle);
    
    // Schedule next check
    idleTimer = window.setTimeout(checkIdle, IDLE_TIMEOUT / 2);
  };
  
  // Start monitoring
  checkIdle();
  
  // Return cleanup function
  return () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
    }
  };
}

// ==========================================
// ACTIVITY PERSISTENCE
// ==========================================

/**
 * Save activity state for recovery
 */
export function saveActivityState(): void {
  try {
    sessionStorage.setItem('userActivity', JSON.stringify(currentActivity));
  } catch (e) {
    // Ignore quota errors
  }
}

/**
 * Restore activity state
 */
export function restoreActivityState(): void {
  try {
    const saved = sessionStorage.getItem('userActivity');
    if (saved) {
      const parsed = JSON.parse(saved);
      const now = Date.now();
      
      // Only restore if recent (within 5 minutes)
      if (now - parsed.lastActivity < 300000) {
        currentActivity = parsed;
      }
    }
  } catch (e) {
    // Ignore parse errors
  }
}

// ==========================================
// INITIALIZATION
// ==========================================

if (typeof window !== 'undefined') {
  initActivityTracking();
  restoreActivityState();
}

export function cleanupActivityTracking(): void {
  if (trackingInitialized) {
    document.removeEventListener('input', trackInput);
    document.removeEventListener('focus', trackFocus, true);
    document.removeEventListener('blur', trackBlur, true);
    document.removeEventListener('click', trackActivity);
    document.removeEventListener('keydown', trackActivity);
    document.removeEventListener('change', trackFormChange);
    document.removeEventListener('submit', handleSubmit);
    trackingInitialized = false;
  }

  if (activityIntervalId) {
    clearInterval(activityIntervalId);
    activityIntervalId = null;
  }

  if (activityTimer !== null) {
    clearTimeout(activityTimer);
    activityTimer = null;
  }

  if (typeof window !== 'undefined') {
    window.removeEventListener('beforeunload', saveActivityState);
    beforeUnloadRegistered = false;
  }
}
