/**
 * UI State Actions
 * Pagination, filters, calendar selection, alert dismissals, and
 * onboarding step management.
 *
 * @module actions/filters-actions
 */
import * as signals from '../signals.js';
import { Events } from '../event-bus.js';
import { queueEvent } from './action-utils.js';
import { navigation } from './navigation-actions.js';

// ==========================================
// PAGINATION ACTIONS
// ==========================================

export const pagination = {
  setPage(page: number): void {
    const current = signals.pagination.value;
    signals.pagination.value = {
      ...current,
      page: Math.max(0, Math.min(page, current.totalPages - 1))
    };
  },

  resetPage(): void {
    this.setPage(0);
  }
};

// ==========================================
// FILTER ACTIONS
// ==========================================

const DEFAULT_FILTER_STATE: signals.FilterState = {
  searchText: '',
  type: 'all',
  category: '',
  tags: '',
  dateFrom: '',
  dateTo: '',
  minAmount: '',
  maxAmount: '',
  reconciled: 'all',
  recurring: false,
  showAllMonths: false,
  sortBy: 'date-desc'
};

export const filters = {
  setFilters(nextFilters: signals.FilterState): void {
    signals.filters.value = { ...nextFilters };
    queueEvent(Events.FILTER_CHANGED, signals.filters.value);
  },

  updateFilters(updates: Partial<signals.FilterState>): void {
    signals.filters.value = { ...signals.filters.value, ...updates };
    queueEvent(Events.FILTER_CHANGED, signals.filters.value);
  },

  clearFilters(): void {
    this.setFilters(DEFAULT_FILTER_STATE);
  },

  setExpanded(expanded: boolean): void {
    navigation.setFiltersExpanded(expanded);
  }
};

// ==========================================
// CALENDAR ACTIONS
// ==========================================

export const calendar = {
  setSelectedDay(day: number | null): void {
    signals.selectedCalendarDay.value = day;
  },

  clearSelectedDay(): void {
    signals.selectedCalendarDay.value = null;
  }
};

// ==========================================
// ALERT ACTIONS
// ==========================================

export const alerts = {
  dismissAlert(alertId: string, monthKey?: string): void {
    if (!alertId) return;
    const activeMonth = monthKey || signals.currentMonth.value;
    const normalizedAlertId = alertId.startsWith(`${activeMonth}:`)
      ? alertId
      : `${activeMonth}:${alertId.replace(/ \(\+\d+ more\)$/, '')}`;
    const nextDismissed = new Set(signals.dismissedAlerts.value);
    nextDismissed.add(normalizedAlertId);
    signals.dismissedAlerts.value = nextDismissed;

    // CR-Apr22-F slice 3: persist dismissals to sessionStorage so they
    // survive reload for the rest of the browsing session. Previously the
    // signal was ephemeral — the user would dismiss the same over-budget
    // toast on every page refresh. Scoped to sessionStorage (not local)
    // because a dismissal is a "stop bugging me right now" gesture, not a
    // permanent preference, and the alert keys already embed the month so
    // there's no cross-month leakage to worry about. Swallow storage
    // errors (private mode / quota) — the dismissal still applies for
    // this tab, which is the primary UX expectation.
    if (typeof sessionStorage === 'undefined') return;
    try {
      sessionStorage.setItem(
        signals.DISMISSED_ALERTS_SESSION_KEY,
        JSON.stringify(Array.from(nextDismissed))
      );
    } catch {
      // Storage unavailable (private mode, quota) — signal value still sticks
      // for this tab, which is the primary UX expectation. Reload-persistence
      // is best-effort.
    }
  }
};

// ==========================================
// ONBOARDING ACTIONS
// ==========================================

export const onboarding = {
  setState(nextState: signals.OnboardingState): void {
    signals.onboarding.value = { ...nextState };
  },

  start(): void {
    signals.onboarding.value = { ...signals.onboarding.value, active: true };
  },

  nextStep(totalSteps: number): void {
    const currentState = signals.onboarding.value;
    const nextStep = currentState.step + 1;
    if (nextStep >= totalSteps) {
      signals.onboarding.value = { active: false, step: 0, completed: true };
      return;
    }
    signals.onboarding.value = { ...currentState, step: nextStep };
  },

  complete(): void {
    signals.onboarding.value = { active: false, step: 0, completed: true };
  },

  reset(): void {
    signals.onboarding.value = { active: true, step: 0, completed: false };
  }
};
