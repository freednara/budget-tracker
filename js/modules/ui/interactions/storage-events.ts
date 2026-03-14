/**
 * Storage Events Module
 *
 * Multi-tab synchronization via localStorage storage events.
 * Extracted from app.ts to reduce file size and improve maintainability.
 *
 * @module storage-events
 */
'use strict';

import { SK, lsGet } from '../../core/state.js';
import * as signals from '../../core/signals.js';
import { emit, Events } from '../../core/event-bus.js';
import { showToast } from '../core/ui.js';
import { setTheme } from '../../features/personalization/theme.js';
import { shouldShowPinLock, showPinLock } from '../widgets/pin-ui-handlers.js';
import { DOM } from '../../core/dom-cache.js';
import type { Theme, CustomCategory, CurrencySettings, RolloverSettings, AlertPrefs, StreakData, SavingsGoal, SavingsContribution, FilterPreset, TxTemplate } from '../../../types/index.js';

// ==========================================
// TYPE DEFINITIONS
// ==========================================

type VoidCallback = () => void;

interface StorageEventCallbacks {
  refreshAll: VoidCallback;
  updateSummary: VoidCallback;
  renderSavingsGoals: VoidCallback;
  checkAlerts: VoidCallback;
  updateInsights: VoidCallback;
  renderBadges: VoidCallback;
  renderStreak: VoidCallback;
  renderFilterPresets: VoidCallback;
  renderTemplates: VoidCallback;
}

// ==========================================
// MODULE STATE
// ==========================================

let callbacks: StorageEventCallbacks | null = null;

// ==========================================
// PUBLIC API
// ==========================================

/**
 * Initializes storage event listener for multi-tab synchronization.
 */
export function initStorageEvents(cb: StorageEventCallbacks): void {
  callbacks = cb;

  window.addEventListener('storage', (e: StorageEvent) => {
    if (!e.key || !Object.values(SK).includes(e.key)) return;

    switch (e.key) {
      case SK.TX:
        // Reload transactions from storage
        signals.transactions.value = lsGet(SK.TX, []) as typeof signals.transactions.value;
        emit(Events.DATA_IMPORTED);
        showToast('Data updated from another tab', 'info');
        break;

      case SK.THEME:
        try {
          setTheme(JSON.parse(e.newValue || '"dark"') as Theme);
        } catch {
          setTheme((e.newValue || 'dark') as Theme);
        }
        break;

      case SK.PIN:
        // If PIN changed in another tab, re-check lock status
        try {
          signals.pin.value = JSON.parse(e.newValue || '""') || '';
        } catch {
          signals.pin.value = e.newValue || '';
        }
        if (shouldShowPinLock()) {
          showPinLock();
        }
        break;

      case SK.ALLOC:
        signals.monthlyAlloc.value = lsGet(SK.ALLOC, {}) as Record<string, Record<string, number>>;
        emit(Events.BUDGET_UPDATED);
        break;

      case SK.SAVINGS:
        signals.savingsGoals.value = lsGet(SK.SAVINGS, {}) as Record<string, SavingsGoal>;
        emit(Events.SAVINGS_UPDATED);
        break;

      case SK.CUSTOM_CAT:
        signals.customCats.value = lsGet(SK.CUSTOM_CAT, []) as CustomCategory[];
        emit(Events.CATEGORY_UPDATED);
        break;

      case SK.DEBTS:
        signals.debts.value = lsGet(SK.DEBTS, []) as typeof signals.debts.value;
        cb.refreshAll();
        break;

      case SK.CURRENCY:
        signals.currency.value = lsGet(SK.CURRENCY, { home: 'USD', symbol: '$' }) as CurrencySettings;
        const currDisplaySync = DOM.get('currency-display');
        if (currDisplaySync) currDisplaySync.textContent = signals.currency.value.symbol;
        cb.refreshAll();
        break;

      case SK.SAVINGS_CONTRIB:
        signals.savingsContribs.value = lsGet(SK.SAVINGS_CONTRIB, []) as SavingsContribution[];
        cb.updateSummary();
        cb.renderSavingsGoals();
        break;

      case SK.ROLLOVER_SETTINGS:
        signals.rolloverSettings.value = lsGet(SK.ROLLOVER_SETTINGS, { enabled: false, mode: 'all', categories: [], maxRollover: null, negativeHandling: 'zero' }) as RolloverSettings;
        cb.refreshAll();
        break;

      case SK.SECTIONS:
        signals.sections.value = lsGet(SK.SECTIONS, { envelope: true }) as { envelope: boolean };
        cb.refreshAll();
        break;

      case SK.ALERTS:
        signals.alerts.value = lsGet(SK.ALERTS, { budgetThreshold: 0.8 }) as AlertPrefs;
        cb.checkAlerts();
        break;

      case SK.INSIGHT_PERS:
        signals.insightPers.value = lsGet(SK.INSIGHT_PERS, 'serious') as 'serious' | 'casual' | 'motivating';
        cb.updateInsights();
        break;

      case SK.ACHIEVE:
        signals.achievements.value = lsGet(SK.ACHIEVE, {}) as Record<string, boolean>;
        cb.renderBadges();
        break;

      case SK.STREAK:
        signals.streak.value = lsGet(SK.STREAK, { current: 0, longest: 0, lastDate: '' }) as StreakData;
        cb.renderStreak();
        break;

      case SK.FILTER_PRESETS:
        signals.filterPresets.value = lsGet(SK.FILTER_PRESETS, []) as FilterPreset[];
        cb.renderFilterPresets();
        break;

      case SK.TX_TEMPLATES:
        signals.txTemplates.value = lsGet(SK.TX_TEMPLATES, []) as TxTemplate[];
        cb.renderTemplates();
        break;
    }
  });
}
