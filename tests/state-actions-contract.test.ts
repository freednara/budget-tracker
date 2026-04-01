import { afterEach, describe, expect, it } from 'vitest';

import { SK } from '../js/modules/core/state.js';
import * as signals from '../js/modules/core/signals.js';
import { alerts, calendar, debts, filters, modal, onboarding, syncState } from '../js/modules/core/state-actions.js';
import type { Debt } from '../js/types/index.js';

describe('state action contract', () => {
  afterEach(() => {
    filters.clearFilters();
    calendar.clearSelectedDay();
    modal.clearSplitTxId();
    onboarding.setState({ active: false, step: 0, completed: false });
    signals.dismissedAlerts.value = new Set();
    signals.debts.value = [];
    signals.customCats.value = [];
  });

  it('updates calendar selection through actions', () => {
    calendar.setSelectedDay(14);
    expect(signals.selectedCalendarDay.value).toBe(14);

    calendar.clearSelectedDay();
    expect(signals.selectedCalendarDay.value).toBeNull();
  });

  it('manages split rows through modal actions', () => {
    modal.setSplitRows([{ id: 'row_1', categoryId: 'food', amount: 10 }]);
    modal.addSplitRow({ id: 'row_2', categoryId: 'transport', amount: 15 });
    modal.updateSplitRow('row_2', { amount: 20 });
    modal.removeSplitRow('row_1');

    expect(signals.splitRows.value).toEqual([
      { id: 'row_2', categoryId: 'transport', amount: 20 }
    ]);
  });

  it('tracks onboarding state through actions', () => {
    onboarding.reset();
    expect(signals.onboarding.value).toEqual({ active: true, step: 0, completed: false });

    onboarding.nextStep(3);
    expect(signals.onboarding.value.step).toBe(1);

    onboarding.complete();
    expect(signals.onboarding.value).toEqual({ active: false, step: 0, completed: true });
  });

  it('applies shared sync updates through one contract', () => {
    const nextDebt: Debt = {
      id: 'debt_1',
      name: 'Card',
      type: 'credit_card',
      balance: 500,
      originalBalance: 800,
      interestRate: 0.2,
      minimumPayment: 25,
      dueDay: 15,
      createdAt: '2026-03-01T00:00:00.000Z',
      payments: [],
      isActive: true
    };

    const appliedDebt = syncState.applyKeyUpdate(SK.DEBTS, [nextDebt]);
    const appliedCategory = syncState.applyKeyUpdate(SK.CUSTOM_CAT, [{
      id: 'custom_food',
      name: 'Coffee',
      emoji: '☕',
      color: '#123456',
      type: 'expense'
    }]);

    expect(appliedDebt).toBe(true);
    expect(appliedCategory).toBe(true);
    expect(signals.debts.value).toEqual([nextDebt]);
    expect(signals.customCats.value[0]?.id).toBe('custom_food');
  });

  it('dismisses alerts through the alert action contract', () => {
    alerts.dismissAlert('2026-03:food:budget-threshold', '2026-03');
    alerts.dismissAlert('🍔 Food: 80% spent', '2026-03');
    expect(Array.from(signals.dismissedAlerts.value)).toEqual([
      '2026-03:food:budget-threshold',
      '2026-03:🍔 Food: 80% spent'
    ]);
  });
});
