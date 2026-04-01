/**
 * Storage Events Module
 *
 * Multi-tab synchronization via localStorage storage events.
 * Extracted from app.ts to reduce file size and improve maintainability.
 *
 * @module storage-events
 */
'use strict';

import { SK, lsGet, normalizeAlertPrefs } from '../../core/state.js';
import { syncState } from '../../core/state-actions.js';
import { setTheme } from '../../core/feature-event-interface.js';
import { shouldShowPinLock, showPinLock } from '../widgets/pin-ui-handlers.js';
import { DOM } from '../../core/dom-cache.js';
import type { Theme, CustomCategory, CurrencySettings, RolloverSettings, AlertPrefs, StreakData, SavingsGoal, SavingsContribution, FilterPreset, TxTemplate, InsightPersonality } from '../../../types/index.js';

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

// Store previous handler for cleanup on re-init
let _storageHandler: ((e: StorageEvent) => void) | null = null;

const SUPPORTED_INSIGHT_PERSONALITIES = new Set<InsightPersonality>([
  'serious',
  'friendly',
  'roast',
  'casual',
  'motivating'
]);

function normalizeInsightPersonality(value: unknown): InsightPersonality {
  if (typeof value === 'string' && SUPPORTED_INSIGHT_PERSONALITIES.has(value as InsightPersonality)) {
    return value as InsightPersonality;
  }
  return 'serious';
}

export function cleanupStorageEvents(): void {
  if (_storageHandler) {
    window.removeEventListener('storage', _storageHandler);
    _storageHandler = null;
  }
  callbacks = null;
}

// ==========================================
// PUBLIC API
// ==========================================

/**
 * Initializes storage event listener for multi-tab synchronization.
 */
export function initStorageEvents(cb: StorageEventCallbacks): void {
  callbacks = cb;

  // Remove previous handler to prevent accumulation on re-init
  cleanupStorageEvents();
  callbacks = cb;

  _storageHandler = (e: StorageEvent) => {
    if (!e.key || !Object.values(SK).includes(e.key)) return;

    switch (e.key) {
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
          syncState.applyKeyUpdate(SK.PIN, JSON.parse(e.newValue || '""') || '');
        } catch {
          syncState.applyKeyUpdate(SK.PIN, e.newValue || '');
        }
        if (shouldShowPinLock()) {
          showPinLock();
        }
        break;

      case SK.ALLOC:
        syncState.applyKeyUpdate(SK.ALLOC, lsGet(SK.ALLOC, {}) as Record<string, Record<string, number>>);
        break;

      case SK.SAVINGS:
        syncState.applyKeyUpdate(SK.SAVINGS, lsGet(SK.SAVINGS, {}) as Record<string, SavingsGoal>);
        break;

      case SK.CUSTOM_CAT:
        syncState.applyKeyUpdate(SK.CUSTOM_CAT, lsGet(SK.CUSTOM_CAT, []) as CustomCategory[]);
        break;

      case SK.DEBTS:
        syncState.applyKeyUpdate(SK.DEBTS, lsGet(SK.DEBTS, []) as unknown[]);
        cb.refreshAll();
        break;

      case SK.CURRENCY:
        const nextCurrency = lsGet(SK.CURRENCY, { home: 'USD', symbol: '$' }) as CurrencySettings;
        syncState.applyKeyUpdate(SK.CURRENCY, nextCurrency);
        const currDisplaySync = DOM.get('currency-display');
        if (currDisplaySync) currDisplaySync.textContent = nextCurrency.symbol;
        cb.refreshAll();
        break;

      case SK.SAVINGS_CONTRIB:
        syncState.applyKeyUpdate(SK.SAVINGS_CONTRIB, lsGet(SK.SAVINGS_CONTRIB, []) as SavingsContribution[]);
        cb.updateSummary();
        cb.renderSavingsGoals();
        break;

      case SK.ROLLOVER_SETTINGS:
        syncState.applyKeyUpdate(
          SK.ROLLOVER_SETTINGS,
          lsGet(SK.ROLLOVER_SETTINGS, { enabled: false, mode: 'all', categories: [], maxRollover: null, negativeHandling: 'zero' }) as RolloverSettings
        );
        cb.refreshAll();
        break;

      case SK.SECTIONS:
        syncState.applyKeyUpdate(SK.SECTIONS, lsGet(SK.SECTIONS, { envelope: true }) as { envelope: boolean });
        cb.refreshAll();
        break;

      case SK.ALERTS:
        syncState.applyKeyUpdate(SK.ALERTS, normalizeAlertPrefs(lsGet(SK.ALERTS, null)));
        cb.checkAlerts();
        break;

      case SK.INSIGHT_PERS:
        syncState.applyKeyUpdate(SK.INSIGHT_PERS, normalizeInsightPersonality(lsGet(SK.INSIGHT_PERS, 'serious')));
        cb.updateInsights();
        break;

      case SK.ACHIEVE:
        syncState.applyKeyUpdate(SK.ACHIEVE, lsGet(SK.ACHIEVE, {}) as Record<string, boolean>);
        cb.renderBadges();
        break;

      case SK.STREAK:
        syncState.applyKeyUpdate(SK.STREAK, lsGet(SK.STREAK, { current: 0, longest: 0, lastDate: '' }) as StreakData);
        cb.renderStreak();
        break;

      case SK.FILTER_PRESETS:
        syncState.applyKeyUpdate(SK.FILTER_PRESETS, lsGet(SK.FILTER_PRESETS, []) as FilterPreset[]);
        cb.renderFilterPresets();
        break;

      case SK.TX_TEMPLATES:
        syncState.applyKeyUpdate(SK.TX_TEMPLATES, lsGet(SK.TX_TEMPLATES, []) as TxTemplate[]);
        cb.renderTemplates();
        break;
    }
  };

  window.addEventListener('storage', _storageHandler);
}
