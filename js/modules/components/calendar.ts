/**
 * Calendar Component
 *
 * Reactive wrapper for the calendar heatmap.
 * Automatically re-renders when transactions or month changes.
 *
 * @module components/calendar
 */
'use strict';

import { mountCalendar as mountCalendarImpl } from '../ui/widgets/calendar.js';

// ==========================================
// COMPONENT MOUNTING
// ==========================================

/**
 * Mount the reactive calendar component
 * Delegates to the real implementation in ui/widgets/calendar.ts
 * which sets up signal effects for auto-updating
 */
export function mountCalendar(): () => void {
  return mountCalendarImpl();
}
