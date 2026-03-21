/**
 * State Hydration Service
 * 
 * Automated state hydration that maps storage keys to their corresponding signals.
 * Eliminates manual signal updates and prevents data loss during imports.
 */

import { SK, lsGet } from './state.js';
import * as signals from './signals.js';
import { safeStorage } from './safe-storage.js';
import { batch } from '@preact/signals-core';
import type { Transaction } from '../../types/index.js';

// ==========================================
// SIGNAL MAPPING REGISTRY
// ==========================================

/**
 * Maps storage keys to their corresponding signals and optional transformers
 * FIXED: Removed SK.TX from here as it's correctly handled by DataManager.init()
 */
const SIGNAL_MAPPINGS = {
  [SK.SAVINGS]: {
    signal: signals.savingsGoals,
    transformer: (value: unknown) => value as typeof signals.savingsGoals.value
  },
  [SK.SAVINGS_CONTRIB]: {
    signal: signals.savingsContribs,
    transformer: (value: unknown) => value as typeof signals.savingsContribs.value
  },
  [SK.CURRENCY]: {
    signal: signals.currency,
    transformer: (value: unknown) => value as typeof signals.currency.value
  },
  [SK.CUSTOM_CAT]: {
    signal: signals.customCats,
    transformer: (value: unknown) => value as typeof signals.customCats.value
  },
  [SK.ALLOC]: {
    signal: signals.monthlyAlloc,
    transformer: (value: unknown) => value as typeof signals.monthlyAlloc.value
  },
  [SK.DEBTS]: {
    signal: signals.debts,
    transformer: (value: unknown) => value as typeof signals.debts.value
  },
  [SK.ROLLOVER_SETTINGS]: {
    signal: signals.rolloverSettings,
    transformer: (value: unknown) => value as typeof signals.rolloverSettings.value
  },
  [SK.ALERTS]: {
    signal: signals.alerts,
    transformer: (value: unknown) => value as typeof signals.alerts.value
  },
  [SK.ACHIEVE]: {
    signal: signals.achievements,
    transformer: (value: unknown) => value as typeof signals.achievements.value
  },
  [SK.STREAK]: {
    signal: signals.streak,
    transformer: (value: unknown) => value as typeof signals.streak.value
  },
  [SK.INSIGHT_PERS]: {
    signal: signals.insightPers,
    transformer: (value: unknown) => value as typeof signals.insightPers.value
  },
  [SK.FILTER_PRESETS]: {
    signal: signals.filterPresets,
    transformer: (value: unknown) => value as typeof signals.filterPresets.value
  },
  [SK.TX_TEMPLATES]: {
    signal: signals.txTemplates,
    transformer: (value: unknown) => value as typeof signals.txTemplates.value
  },
  [SK.SECTIONS]: {
    signal: signals.sections,
    transformer: (value: unknown) => value as typeof signals.sections.value
  },
  [SK.THEME]: {
    signal: signals.theme,
    transformer: (value: unknown) => value as any
  }
} as const;

// ==========================================
// HYDRATION SERVICE
// ==========================================

/**
 * Hydrate all signals from their corresponding storage values
 * FIXED: Uses batch() for atomic updates and safeStorage for reliability
 */
export function hydrateAllSignals(): void {
  batch(() => {
    for (const [storageKey, mapping] of Object.entries(SIGNAL_MAPPINGS)) {
      const storedValue = safeStorage.getJSON(storageKey, undefined);
      
      if (storedValue !== undefined) {
        try {
          const transformedValue = mapping.transformer(storedValue);
          (mapping.signal as any).value = transformedValue;
        } catch (error) {
          if (import.meta.env.DEV) console.warn(`Failed to hydrate signal for ${storageKey}:`, error);
        }
      }
    }
  });
}

/**
 * Hydrate signals from import state data
 * @param importData - The imported state data object
 * FIXED: Uses batch() for atomic consistency
 */
export function hydrateFromImport(importData: Record<string, unknown>): void {
  // Build reverse mapping: property name -> storage key
  const propertyToStorageKey: Record<string, string> = {
    savingsGoals: SK.SAVINGS,
    savingsContribs: SK.SAVINGS_CONTRIB,
    currency: SK.CURRENCY,
    customCats: SK.CUSTOM_CAT,
    monthlyAlloc: SK.ALLOC,
    debts: SK.DEBTS,
    rolloverSettings: SK.ROLLOVER_SETTINGS,
    alerts: SK.ALERTS,
    achievements: SK.ACHIEVE,
    streak: SK.STREAK,
    insightPers: SK.INSIGHT_PERS,
    filterPresets: SK.FILTER_PRESETS,
    txTemplates: SK.TX_TEMPLATES,
    sections: SK.SECTIONS,
    theme: SK.THEME
  };

  batch(() => {
    for (const [propertyName, value] of Object.entries(importData)) {
      const storageKey = propertyToStorageKey[propertyName];
      
      if (storageKey && value !== undefined) {
        const mapping = (SIGNAL_MAPPINGS as any)[storageKey];
        
        if (mapping) {
          try {
            const transformedValue = mapping.transformer(value);
            mapping.signal.value = transformedValue;
          } catch (error) {
            if (import.meta.env.DEV) console.warn(`Failed to hydrate signal ${propertyName} from import:`, error);
          }
        }
      }
    }

    // Always reload transactions from storage after import
    const transactions = safeStorage.getJSON<Transaction[]>(SK.TX, []);
    signals.transactions.value = transactions;
  });
}

/**
 * Validate that all critical signals are properly hydrated
 * @returns Array of missing or invalid signal names
 */
export function validateSignalHydration(): string[] {
  const issues: string[] = [];

  // Check critical signals for proper initialization
  if (!Array.isArray(signals.transactions.value)) {
    issues.push('transactions signal not properly initialized');
  }

  if (!signals.currency.value || typeof signals.currency.value.symbol !== 'string') {
    issues.push('currency signal missing or invalid');
  }

  if (!Array.isArray(signals.customCats.value)) {
    issues.push('customCats signal not properly initialized');
  }

  // Add more validation as needed for other critical signals

  return issues;
}

/**
 * Get statistics about current signal hydration
 */
export function getHydrationStats() {
  const totalMappings = Object.keys(SIGNAL_MAPPINGS).length;
  let hydratedCount = 0;
  let emptyCount = 0;

  for (const [storageKey, mapping] of Object.entries(SIGNAL_MAPPINGS)) {
    const currentValue = (mapping.signal as any).value;
    
    if (currentValue !== undefined && currentValue !== null) {
      hydratedCount++;
      
      if (Array.isArray(currentValue) && currentValue.length === 0) {
        emptyCount++;
      } else if (typeof currentValue === 'object' && Object.keys(currentValue).length === 0) {
        emptyCount++;
      }
    }
  }

  return {
    totalMappings,
    hydratedCount,
    emptyCount,
    hydrationRate: hydratedCount / totalMappings
  };
}

// ==========================================
// DEBUGGING UTILITIES
// ==========================================

/**
 * Log the current state of all signals for debugging
 */
export function debugSignalState(): void {
  if (!import.meta.env.DEV) return;
  console.group('Signal Hydration Debug');

  for (const [storageKey, mapping] of Object.entries(SIGNAL_MAPPINGS)) {
    const currentValue = (mapping.signal as any).value;
    const storageValue = lsGet(storageKey as keyof typeof SK, undefined);

    console.log(`${storageKey}:`, {
      signalValue: currentValue,
      storageValue,
      synced: JSON.stringify(currentValue) === JSON.stringify(storageValue)
    });
  }

  console.groupEnd();
}

export default {
  hydrateAllSignals,
  hydrateFromImport,
  validateSignalHydration,
  getHydrationStats,
  debugSignalState
};