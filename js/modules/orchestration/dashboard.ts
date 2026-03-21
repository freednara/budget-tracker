/**
 * Dashboard Module
 *
 * Previously contained summary cards, budget gauge, and daily allowance logic.
 * All UI update functions have been migrated to reactive components in components/.
 *
 * This module is kept only for backward-compatible exports used by app-init-di.ts.
 *
 * @module dashboard
 */
'use strict';

// Re-export for backward compatibility
export { animateValue } from './dashboard-animations.js';

// ==========================================
// INITIALIZATION (backward compatibility)
// ==========================================

/**
 * @deprecated Dashboard is now initialized via reactive components in app-init-di.ts
 * @returns No-op cleanup function
 */
export function initDashboard(): () => void {
  return () => {};
}
