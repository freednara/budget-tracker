/**
 * Navigation Actions
 * Month navigation, tab switching, and filter panel state.
 *
 * @module actions/navigation-actions
 */
import * as signals from '../signals.js';
import { Events } from '../event-bus.js';
import { queueEvent } from './action-utils.js';
import { monthKeyParts } from '../utils-pure.js';
import type { TransactionType, MainTab } from '../../../types/index.js';

export const navigation = {
  setCurrentMonth(monthKey: string): boolean {
    if (!/^\d{4}-\d{2}$/.test(monthKey)) return false;
    // Validate month is 01-12. Phase 6 Slice 1i (rev 12 L6): the regex
    // above guarantees a well-formed "YYYY-MM" string, but under
    // `noUncheckedIndexedAccess` the indexed access is still `string |
    // undefined`; default to '0' so `parseInt` can't return NaN.
    const [, month] = monthKeyParts(monthKey);
    if (month < 1 || month > 12) return false;
    signals.currentMonth.value = monthKey;
    queueEvent(Events.MONTH_CHANGED, monthKey);
    return true;
  },

  prevMonth(): boolean {
    const [y, m] = monthKeyParts(signals.currentMonth.value);
    const d = new Date(y, m - 2, 1);
    const newMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    return this.setCurrentMonth(newMonth);
  },

  nextMonth(): boolean {
    const [y, m] = monthKeyParts(signals.currentMonth.value);
    const d = new Date(y, m, 1);
    const newMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    return this.setCurrentMonth(newMonth);
  },

  setCurrentTab(type: TransactionType): boolean {
    if (type !== 'expense' && type !== 'income') return false;
    signals.currentTab.value = type;
    signals.currentType.value = type;
    queueEvent(Events.TAB_CHANGED, type);
    return true;
  },

  setActiveMainTab(tabName: MainTab): boolean {
    const validTabs: MainTab[] = ['dashboard', 'transactions', 'budget', 'calendar'];
    if (!validTabs.includes(tabName)) return false;
    signals.activeMainTab.value = tabName;
    return true;
  },

  toggleFiltersExpanded(): void {
    signals.filtersExpanded.value = !signals.filtersExpanded.value;
  },

  setFiltersExpanded(expanded: boolean): void {
    signals.filtersExpanded.value = expanded;
  },

  goToMonth(monthKey: string): boolean {
    return this.setCurrentMonth(monthKey);
  }
};
