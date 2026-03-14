/**
 * Calendar Component
 *
 * Reactive wrapper for the calendar heatmap.
 * Automatically re-renders when transactions or month changes.
 *
 * @module components/calendar
 */
'use strict';

import { effect } from '@preact/signals-core';
import * as signals from '../core/signals.js';
import { renderCalendar as renderCalendarImpl } from '../ui/widgets/calendar.js';
import DOM from '../core/dom-cache.js';

// ==========================================
// COMPONENT MOUNTING
// ==========================================

/**
 * Mount the reactive calendar component
 * Watches transactions and currentMonth signals to auto-update the calendar
 * Returns cleanup function to dispose effects
 */
export function mountCalendar(): () => void {
  const container = DOM.get('spending-heatmap');

  if (!container) {
    return () => {};
  }

  const cleanup = effect(() => {
    // Read signals to establish dependency tracking
    const _month = signals.currentMonth.value;
    const _txCount = signals.transactions.value.length;

    // Re-render calendar when month or transactions change
    renderCalendarImpl();
  });

  return cleanup;
}
