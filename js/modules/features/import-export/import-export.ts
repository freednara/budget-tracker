/**
 * Import/Export Module
 *
 * Data import validation, export builders, and atomic writes.
 *
 * @module import-export
 */
'use strict';

import { SK, STORAGE_DEFAULTS, normalizeAlertPrefs } from '../../core/state.js';
import { safeStorage } from '../../core/safe-storage.js';
import * as signals from '../../core/signals.js';
import { CURRENCY_MAP, getTodayStr, parseAmount, generateId, toCents } from '../../core/utils.js';
import { DEFAULT_CATEGORY_COLOR } from '../../core/categories.js';
import { showToast } from '../../ui/core/ui.js';
import { validator } from '../../core/validator.js';
import type {
  Transaction,
  SavingsGoal,
  SavingsContribution,
  Debt,
  CustomCategory,
  CurrencySettings,
  StreakData,
  AlertPrefs,
  RolloverSettings,
  FilterPreset,
  TxTemplate,
  LegacySavingsGoal,
  InsightPersonality
} from '../../../types/index.js';

// ==========================================
// TYPE DEFINITIONS
// ==========================================

interface RejectedImportRecord {
  index: number;
  reason: string;
}

interface AtomicWriteEntry {
  key: string;
  value: unknown;
}

interface ImportData {
  version?: string;
  transactions?: unknown[];
  savingsGoals?: Record<string, unknown>;
  savingsContributions?: unknown[];
  currency?: unknown;
  achievements?: Record<string, unknown>;
  streak?: unknown;
  sections?: { envelope?: boolean };
  insightPersonality?: string;
  filterPresets?: unknown[];
  txTemplates?: unknown[];
  alertPrefs?: {
    budgetThreshold?: number | null;
    browserNotificationsEnabled?: boolean;
    lastNotifiedAlertKeys?: string[];
  };
  customCategories?: unknown[];
  monthlyAllocations?: Record<string, Record<string, unknown>>;
  debts?: unknown[];
  rolloverSettings?: unknown;
  theme?: string;
  lastBackup?: string;
  syncState?: unknown;
}

interface ImportStateResult {
  newS: Record<string, unknown>;
  writes: AtomicWriteEntry[];
  theme: string | null;
}

interface ExportData {
  transactions: Transaction[];
  savingsGoals: Record<string, SavingsGoal>;
  savingsContributions: SavingsContribution[];
  monthlyAllocations: Record<string, Record<string, number>>;
  customCategories: CustomCategory[];
  currency: CurrencySettings;
  achievements: Record<string, unknown>;
  streak: StreakData;
  sections: { envelope: boolean };
  theme: string;
  alertPrefs: AlertPrefs;
  insightPersonality: string;
  debts: Debt[];
  rolloverSettings: RolloverSettings | null;
  filterPresets: FilterPreset[];
  txTemplates: TxTemplate[];
  exportedAt: string;
  version: string;
  lastBackup: string | null;
}

// Using LegacySavingsGoal from central types

// ==========================================
// CONSTANTS
// ==========================================

export const MAX_IMPORT_SIZE = 5 * 1024 * 1024; // 5MB
export const MAX_IMPORT_TRANSACTIONS = 10000;
const MAX_ID_LENGTH = 128;
const SUPPORTED_INSIGHT_PERSONALITIES = new Set<InsightPersonality>([
  'serious',
  'friendly',
  'roast',
  'casual',
  'motivating'
]);

// ==========================================
// INTERNAL HELPERS
// ==========================================

/**
 * Sanitize an ID string to prevent injection/pollution
 */
function sanitizeId(id: unknown): string {
  const cleaned = String(id || '').replace(/[^a-zA-Z0-9_\-~.]/g, '').slice(0, MAX_ID_LENGTH);
  // P9-L2: Reject reserved JavaScript object keys (prototype pollution prevention)
  if (cleaned.startsWith('__') || ['constructor', 'prototype'].includes(cleaned)) {
    return '';
  }
  return cleaned;
}

function normalizeInsightPersonality(value: unknown): InsightPersonality {
  if (typeof value === 'string' && SUPPORTED_INSIGHT_PERSONALITIES.has(value as InsightPersonality)) {
    return value as InsightPersonality;
  }
  return 'serious';
}

// ==========================================
// VALIDATION FUNCTIONS
// ==========================================

// validateTransaction removed - use validator.validateTransaction() directly

/**
 * Sanitize and validate imported transactions
 */
export function sanitizeImportedTransactions(
  incoming: unknown[],
  existingIds: Set<string> = new Set()
): Transaction[] {
  const genId = (): string => 'tx_' + generateId();
  const seen = new Set<string>(existingIds);
  const rejected: RejectedImportRecord[] = [];
  const validated: Partial<Transaction>[] = [];

  // Validate and sanitize each transaction using the validator module
  incoming.forEach((t, idx) => {
    const result = validator.validateTransaction(t as Partial<Transaction>);
    if (!result.valid) {
      const reason = Object.entries(result.errors).map(([k, v]) => `${k}: ${v}`).join(', ');
      rejected.push({ index: idx, reason: reason || 'validation failed' });
    } else {
      validated.push(result.sanitized as Partial<Transaction>);
    }
  });

  // Log rejected records for debugging (in production, could show summary to user)
  if (rejected.length > 0) {
    if (import.meta.env.DEV) console.warn(`Import validation: ${rejected.length} record(s) rejected`, rejected.slice(0, 10));
  }

  // Assign unique IDs to validated transactions
  return validated.map(t => {
    let id = sanitizeId(t.__backendId);
    if (!id || seen.has(id)) id = genId();
    seen.add(id);

    return {
      ...t,
      __backendId: id
    } as Transaction;
  });
}

/**
 * Fuzzy duplicate detection (similar date, amount within 5%, category, similar description)
 */
/**
 * Find exact duplicates during import
 * FIXED: Now uses strict matching for financial accuracy
 * Returns both exact duplicates and potential similar transactions
 */
export function findContentDuplicates(
  incoming: Transaction[],
  existing: Transaction[]
): { exact: Transaction[]; similar: Transaction[] } {
  const normalizeDesc = (s: string | undefined): string => (s || '').toLowerCase().trim().replace(/\s+/g, ' ');
  
  // FIXED: Strict duplicate detection - exact match required
  const isExactDuplicate = (inc: Transaction, ex: Transaction): boolean => {
    return ex.date === inc.date &&
           ex.type === inc.type &&
           ex.category === inc.category &&
           ex.amount === inc.amount && // EXACT amount match required
           normalizeDesc(ex.description) === normalizeDesc(inc.description);
  };
  
  // Similar transactions (for UI suggestion only, not automatic filtering)
  const isSimilar = (inc: Transaction, ex: Transaction): boolean => {
    if (ex.date !== inc.date || ex.type !== inc.type) return false;
    
    const amtACents = toCents(ex.amount);
    const amtBCents = toCents(inc.amount);
    const diffCents = Math.abs(amtACents - amtBCents);
    const avgCents = (Math.abs(amtACents) + Math.abs(amtBCents)) / 2;
    const withinRange = avgCents > 0 && diffCents / avgCents <= 0.05; // 5% range
    
    const descA = normalizeDesc(ex.description);
    const descB = normalizeDesc(inc.description);
    const similarDesc = descA.includes(descB) || descB.includes(descA) ||
                       descA === descB;
    
    return withinRange && similarDesc && !isExactDuplicate(inc, ex);
  };

  // Build a Map of existing transactions keyed by exact-match fields for O(1) lookups
  const exactKeyMap = new Map<string, Transaction[]>();
  const similarKeyMap = new Map<string, Transaction[]>();
  for (const ex of existing) {
    // Exact match key: date|type|category|amount|description
    const exactKey = `${ex.date}|${ex.type}|${ex.category}|${ex.amount}|${normalizeDesc(ex.description)}`;
    if (!exactKeyMap.has(exactKey)) exactKeyMap.set(exactKey, []);
    exactKeyMap.get(exactKey)!.push(ex);

    // Similar match key (broader): date|type for pre-filtering
    const similarKey = `${ex.date}|${ex.type}`;
    if (!similarKeyMap.has(similarKey)) similarKeyMap.set(similarKey, []);
    similarKeyMap.get(similarKey)!.push(ex);
  }

  const exactDuplicates: Transaction[] = [];
  const similarTransactions: Transaction[] = [];

  for (const inc of incoming) {
    const exactKey = `${inc.date}|${inc.type}|${inc.category}|${inc.amount}|${normalizeDesc(inc.description)}`;
    if (exactKeyMap.has(exactKey)) {
      exactDuplicates.push(inc);
    } else {
      // Check for similar only among transactions with same date|type (narrowed search)
      const similarKey = `${inc.date}|${inc.type}`;
      const candidates = similarKeyMap.get(similarKey) || [];
      const similar = candidates.find(ex => isSimilar(inc, ex));
      if (similar) {
        similarTransactions.push(inc);
      }
    }
  }

  return { exact: exactDuplicates, similar: similarTransactions };
}

// ==========================================
// ATOMIC WRITE
// ==========================================

/**
 * Atomic write helper: snapshots current bytes for every key, applies each
 * lsSet in sequence, and rolls back all keys on the first failure.
 * FIXED: Now uses Web Locks API to prevent cross-tab interference
 */
export async function tryAtomicWrite(writes: AtomicWriteEntry[]): Promise<boolean> {
  // Use Web Locks API for true cross-tab atomicity during import
  if (typeof navigator.locks?.request === 'function') {
    return await navigator.locks.request(
      'budget_tracker_import_lock',
      { mode: 'exclusive', ifAvailable: false },
      async () => {
        return performAtomicWrite(writes);
      }
    );
  } else {
    // Fallback for browsers without Web Locks
    return performAtomicWrite(writes);
  }
}

/**
 * Internal atomic write implementation
 * FIXED: Uses safeStorage for consistent error handling and rollback
 */
function performAtomicWrite(writes: AtomicWriteEntry[]): boolean {
  const backups = writes.map(({ key }) => ({ 
    key, 
    raw: safeStorage.getItem(key) 
  }));

  for (const { key, value } of writes) {
    if (!safeStorage.setJSON(key, value)) {
      // Rollback failed write
      let rollbackFailed = false;
      backups.forEach(({ key: k, raw }) => {
        try {
          if (raw === null) safeStorage.removeItem(k);
          else if (!safeStorage.setItem(k, raw)) rollbackFailed = true;
        } catch (e) {
          if (import.meta.env.DEV) console.error('Rollback failed for key:', k, e);
          rollbackFailed = true;
        }
      });
      if (rollbackFailed) {
        if (import.meta.env.DEV) console.error('CRITICAL: Atomic write rollback failed - data may be in inconsistent state');
        showToast('Storage error: data may be corrupted. Please export and refresh.', 'error');
      }
      return false;
    }
  }
  return true;
}

// ==========================================
// IMPORT STATE BUILDER
// ==========================================

/**
 * Computes all new state values and storage writes for an import WITHOUT
 * touching S or calling persist. Returns { newS, writes, theme }.
 */
export function buildImportState(
  d: ImportData,
  mode: 'overwrite' | 'merge',
  existingTx: Transaction[] = []
): ImportStateResult {
  const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
  const importedTxCount = Array.isArray(d.transactions) ? d.transactions.length : 0;
  const finalTxCount = existingTx.length;

  // Safety check: reject both oversized payloads and oversized merged ledgers.
  if (importedTxCount > MAX_IMPORT_TRANSACTIONS || finalTxCount > MAX_IMPORT_TRANSACTIONS) {
    throw new Error(`Import exceeds maximum allowed transactions (${MAX_IMPORT_TRANSACTIONS})`);
  }

  // L7: version compatibility warning
  const importedVersion = d.version || '1.0';
  const compatibleVersions = ['2.3', '2.5', '2.6'];
  if (!compatibleVersions.includes(importedVersion)) {
    if (import.meta.env.DEV) console.warn(`Import: backup version ${importedVersion} may not be fully compatible with current schema.`);
  }

  const newS: Record<string, unknown> = {};
  const writes: AtomicWriteEntry[] = [];

  // Transactions (caller provides the merged/overwritten array)
  writes.push({ key: SK.TX, value: existingTx });

  // Type-safe state access - map property names to signal values for merge mode
  const getExistingValue = (prop: string): unknown => {
    const signalMap: Record<string, unknown> = {
      savingsGoals: signals.savingsGoals.value,
      savingsContribs: signals.savingsContribs.value,
      currency: signals.currency.value,
      achievements: signals.achievements.value,
      streak: signals.streak.value,
      sections: signals.sections.value,
      insightPers: signals.insightPers.value,
      filterPresets: signals.filterPresets.value,
      txTemplates: signals.txTemplates.value,
      lastBackup: signals.lastBackup.value,
    };
    return signalMap[prop];
  };

  // Simple key→prop map (objects / primitives)
  const restoreMap: Array<{ src: keyof ImportData; prop: string; sk: string; defaultVal: unknown }> = [
    { src: 'savingsGoals', prop: 'savingsGoals', sk: SK.SAVINGS, defaultVal: {} },
    { src: 'savingsContributions', prop: 'savingsContribs', sk: SK.SAVINGS_CONTRIB, defaultVal: [] },
    { src: 'currency', prop: 'currency', sk: SK.CURRENCY, defaultVal: { home: 'USD', symbol: '$' } },
    { src: 'achievements', prop: 'achievements', sk: SK.ACHIEVE, defaultVal: {} },
    { src: 'streak', prop: 'streak', sk: SK.STREAK, defaultVal: { current: 0, longest: 0, lastDate: null } },
    { src: 'sections', prop: 'sections', sk: SK.SECTIONS, defaultVal: { envelope: true } },
    { src: 'insightPersonality', prop: 'insightPers', sk: SK.INSIGHT_PERS, defaultVal: 'serious' },
    { src: 'filterPresets', prop: 'filterPresets', sk: SK.FILTER_PRESETS, defaultVal: [] },
    { src: 'txTemplates', prop: 'txTemplates', sk: SK.TX_TEMPLATES, defaultVal: [] },
    { src: 'lastBackup', prop: 'lastBackup', sk: SK.LAST_BACKUP, defaultVal: null },
  ];

  // Type validation: ensure imported data has correct types to prevent runtime errors
  if (d.savingsContributions && !Array.isArray(d.savingsContributions)) d.savingsContributions = [];
  if (d.filterPresets && !Array.isArray(d.filterPresets)) d.filterPresets = [];
  if (d.txTemplates && !Array.isArray(d.txTemplates)) d.txTemplates = [];
  if (d.currency && typeof d.currency !== 'object') d.currency = { home: 'USD', symbol: '$' };
  if (d.savingsGoals && typeof d.savingsGoals !== 'object') d.savingsGoals = {};
  if (d.achievements && typeof d.achievements !== 'object') d.achievements = {};

  restoreMap.forEach(({ src, prop, sk, defaultVal }) => {
    const srcValue = d[src];
    const existingValue = getExistingValue(prop);
    if (srcValue == null) {
      if (mode === 'overwrite') { newS[prop] = defaultVal; writes.push({ key: sk, value: defaultVal }); }
      else { newS[prop] = existingValue; } // keep existing
      return;
    }
    // For arrays in merge mode, concatenate instead of replacing
    if (mode === 'merge' && Array.isArray(existingValue) && Array.isArray(srcValue)) {
      newS[prop] = [...existingValue, ...srcValue];
    } else if (mode === 'merge' && isObj(existingValue) && isObj(srcValue)) {
      newS[prop] = { ...existingValue, ...srcValue };
    } else {
      newS[prop] = srcValue;
    }
    writes.push({ key: sk, value: newS[prop] });
  });

  if ('insightPers' in newS) {
    const normalizedInsightPersonality = normalizeInsightPersonality(newS.insightPers);
    newS.insightPers = normalizedInsightPersonality;
    const idx = writes.findIndex((write) => write.key === SK.INSIGHT_PERS);
    if (idx >= 0) writes[idx].value = normalizedInsightPersonality;
  }

  // P6-H1 + P6-M1 + P9-M3: Sanitize savingsGoals keys, normalize numeric fields, default to 1
  if (isObj(newS.savingsGoals)) {
    const sanitized: Record<string, LegacySavingsGoal> = {};
    Object.entries(newS.savingsGoals as Record<string, unknown>).forEach(([k, v]) => {
      const safeKey = sanitizeId(k);
      if (safeKey && isObj(v)) {
        const goal = v as unknown as LegacySavingsGoal;
        sanitized[safeKey] = {
          ...goal,
          target_amount: parseAmount(goal.target_amount ?? 0) || 1,  // Default to 1, not 0
          saved_amount: parseAmount(goal.saved_amount ?? 0),
        };
      }
    });
    newS.savingsGoals = sanitized;
    const idx = writes.findIndex(w => w.key === SK.SAVINGS);
    if (idx >= 0) writes[idx].value = sanitized;
  }

  // L8 + M-new-1: Validate alert prefs; in merge mode with no backup alertPrefs, keep existing
  const rawAlerts = d.alertPrefs;
  if (rawAlerts) {
    newS.alerts = normalizeAlertPrefs(rawAlerts);
  } else if (mode === 'merge') {
    newS.alerts = normalizeAlertPrefs(signals.alerts.value); // keep existing in merge mode when backup has no alertPrefs
  } else {
    newS.alerts = normalizeAlertPrefs(STORAGE_DEFAULTS[SK.ALERTS]); // overwrite → reset to defaults
  }
  writes.push({ key: SK.ALERTS, value: newS.alerts });

  // Validate currency symbol against CURRENCY_MAP
  const currencyMap = CURRENCY_MAP as Record<string, string>;
  if (newS.currency && typeof newS.currency === 'object') {
    const curr = newS.currency as CurrencySettings;
    if (!currencyMap[curr.home]) {
      newS.currency = { home: 'USD', symbol: '$' };
    } else if (!curr.symbol || curr.symbol !== currencyMap[curr.home]) {
      newS.currency = { ...curr, symbol: currencyMap[curr.home] };
    }
    // Update the writes entry for currency with corrected value
    const cidx = writes.findIndex(w => w.key === SK.CURRENCY);
    if (cidx >= 0) writes[cidx].value = newS.currency;
    else writes.push({ key: SK.CURRENCY, value: newS.currency });
  }

  // H5: Sanitize custom category IDs — allow only safe characters
  const sanitizeCat = (c: unknown): CustomCategory => {
    const cat = c as Record<string, unknown>;
    return {
      id: String(cat.id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || `cat_${generateId()}`,
      name: String(cat.name || '').slice(0, 50),
      type: cat.type as 'expense' | 'income',
      emoji: String(cat.emoji || '').replace(/<[^>]*>/g, '').slice(0, 10),
      color: /^#[0-9a-fA-F]{3,8}$/.test(String(cat.color || '')) ? String(cat.color) : DEFAULT_CATEGORY_COLOR
    };
  };

  const existingCustomCats = signals.customCats.value as CustomCategory[];
  if (d.customCategories) {
    const validCats = (d.customCategories as unknown[]).filter((c): c is Record<string, unknown> => {
      const cat = c as Record<string, unknown>;
      return cat && typeof cat.id === 'string' && typeof cat.name === 'string' && ['expense', 'income'].includes(cat.type as string);
    }).map(sanitizeCat);
    if (mode === 'merge') {
      const existingCatIds = new Set(existingCustomCats.map(c => c.id));
      newS.customCats = [...existingCustomCats, ...validCats.filter(c => !existingCatIds.has(c.id))];
    } else {
      newS.customCats = validCats;
    }
  } else if (mode === 'overwrite') {
    newS.customCats = [];
  } else {
    newS.customCats = existingCustomCats;
  }
  if (d.customCategories || mode === 'overwrite') writes.push({ key: SK.CUSTOM_CAT, value: newS.customCats });

  // Monthly allocations (nested object, category-level granularity)
  // P6-M1: Normalize numeric values to prevent string concatenation bugs
  const existingAlloc = signals.monthlyAlloc.value as Record<string, Record<string, number>>;
  if (d.monthlyAllocations && isObj(d.monthlyAllocations)) {
    if (mode === 'merge') {
      const merged: Record<string, Record<string, number>> = { ...existingAlloc };
      Object.entries(d.monthlyAllocations).forEach(([mk, alloc]) => {
        if (!isObj(alloc)) return;
        if (!merged[mk]) {
          merged[mk] = {};
          Object.entries(alloc).forEach(([catId, amt]) => {
            const safeId = sanitizeId(catId);
            if (safeId) merged[mk][safeId] = parseAmount(amt as string | number);
          });
        }
        else {
          Object.entries(alloc).forEach(([catId, amt]) => {
            const safeId = sanitizeId(catId);
            if (safeId && merged[mk][safeId] == null) merged[mk][safeId] = parseAmount(amt as string | number);
          });
        }
      });
      newS.monthlyAlloc = merged;
    } else {
      // Overwrite mode: normalize all values
      const normalized: Record<string, Record<string, number>> = {};
      Object.entries(d.monthlyAllocations).forEach(([mk, alloc]) => {
        if (!isObj(alloc)) return;
        normalized[mk] = {};
        Object.entries(alloc).forEach(([catId, amt]) => {
          const safeId = sanitizeId(catId);
          if (safeId) normalized[mk][safeId] = parseAmount(amt as string | number);
        });
      });
      newS.monthlyAlloc = normalized;
    }
    writes.push({ key: SK.ALLOC, value: newS.monthlyAlloc });
  } else if (mode === 'overwrite') {
    newS.monthlyAlloc = {};
    writes.push({ key: SK.ALLOC, value: {} });
  } else {
    newS.monthlyAlloc = existingAlloc;
  }

  // Debts - sanitize and validate
  const existingDebts = (signals.debts.value || []) as Debt[];
  if (Array.isArray(d.debts)) {
    const validDebts = (d.debts as unknown[]).filter((debt): debt is Record<string, unknown> =>
      debt !== null && typeof debt === 'object' &&
      typeof (debt as Record<string, unknown>).name === 'string' &&
      typeof (debt as Record<string, unknown>).balance === 'number'
    ).map((debt): Debt => ({
      id: sanitizeId(debt.id) || `debt_${generateId()}`,
      name: String(debt.name).slice(0, 100),
      type: (debt.type as Debt['type']) || 'other',
      balance: parseAmount(debt.balance as string | number),
      originalBalance: parseAmount((debt.originalBalance ?? debt.balance) as string | number),
      minimumPayment: parseAmount((debt.minimumPayment ?? 0) as string | number),
      interestRate: Math.max(0, Math.min(1, parseFloat(String(debt.interestRate)) || 0)),
      dueDay: typeof debt.dueDay === 'number' ? debt.dueDay : 1,
      createdAt: typeof debt.createdAt === 'string' ? debt.createdAt : new Date().toISOString(),
      payments: Array.isArray(debt.payments) ? debt.payments as Debt['payments'] : [],
      isActive: debt.isActive !== false
    }));
    if (mode === 'merge') {
      const existingIds = new Set(existingDebts.map(d => d.id));
      newS.debts = [...existingDebts, ...validDebts.filter(d => !existingIds.has(d.id))];
    } else {
      newS.debts = validDebts;
    }
    writes.push({ key: SK.DEBTS, value: newS.debts });
  } else if (mode === 'overwrite') {
    newS.debts = [];
    writes.push({ key: SK.DEBTS, value: [] });
  } else {
    newS.debts = existingDebts;
  }

  // Rollover settings
  const existingRollover = signals.rolloverSettings.value as RolloverSettings;
  if (d.rolloverSettings && typeof d.rolloverSettings === 'object') {
    const rs = d.rolloverSettings as Record<string, unknown>;
    newS.rolloverSettings = {
      enabled: rs.enabled === true,
      mode: (['all', 'selected'].includes(rs.mode as string) ? rs.mode : 'all') as 'all' | 'selected',
      categories: Array.isArray(rs.categories) ? rs.categories as string[] : [],
      maxRollover: rs.maxRollover === null || rs.maxRollover === undefined ? null : parseAmount(rs.maxRollover as string | number),
      negativeHandling: (['zero', 'carry', 'ignore'].includes(rs.negativeHandling as string)
        ? rs.negativeHandling : 'zero') as 'zero' | 'carry' | 'ignore'
    };
    writes.push({ key: SK.ROLLOVER_SETTINGS, value: newS.rolloverSettings });
  } else if (mode === 'overwrite') {
    newS.rolloverSettings = { enabled: false, mode: 'all', categories: [], maxRollover: null, negativeHandling: 'zero' };
    writes.push({ key: SK.ROLLOVER_SETTINGS, value: newS.rolloverSettings });
  } else {
    newS.rolloverSettings = existingRollover;
  }

  return { newS, writes, theme: d.theme || null };
}

// ==========================================
// EXPORT BUILDERS
// ==========================================

/**
 * Build export JSON data object
 * FIXED: Uses live signals for IndexedDB-backed data and includes all relevant state for a complete backup
 */
export function buildExportData(): ExportData {
  return {
    transactions: [...signals.transactions.value],
    savingsGoals: signals.savingsGoals.value as unknown as Record<string, SavingsGoal>,
    savingsContributions: signals.savingsContribs.value as SavingsContribution[],
    monthlyAllocations: signals.monthlyAlloc.value as Record<string, Record<string, number>>,
    customCategories: signals.customCats.value as CustomCategory[],
    currency: signals.currency.value as CurrencySettings,
    achievements: signals.achievements.value as Record<string, unknown>,
    streak: signals.streak.value as StreakData,
    sections: signals.sections.value as { envelope: boolean },
    theme: safeStorage.getItem(SK.THEME) || 'dark',
    alertPrefs: signals.alerts.value as AlertPrefs,
    insightPersonality: signals.insightPers.value as string,
    debts: (signals.debts.value || []) as Debt[],
    rolloverSettings: (signals.rolloverSettings.value || null) as RolloverSettings | null,
    filterPresets: (signals.filterPresets.value || []) as FilterPreset[],
    txTemplates: (signals.txTemplates.value || []) as TxTemplate[],
    lastBackup: signals.lastBackup.value ? String(signals.lastBackup.value) : null,
    exportedAt: new Date().toISOString(),
    version: '2.6'
  };
}

/**
 * Build CSV content from transactions
 */
export function buildCsvContent(txs: Transaction[]): string {
  const header = 'Date,Type,Category,Amount,Description,Tags,Notes,Recurring\n';
  const csvEsc = (s: unknown): string => {
    const str = String(s || '');
    const trimmed = str.trim(); // P8-L1: Trim before checking for formula injection
    const safe = /^[=+\-@|]/.test(trimmed) ? "'" + str : str; // Prefix original (preserving whitespace)
    return `"${safe.replace(/"/g, '""')}"`;
  };
  const rows = txs.map(t =>
    [t.date, t.type, t.category, t.amount, t.description, t.tags, t.notes, t.recurring ? t.recurring_type : '']
    .map(csvEsc).join(',')
  ).join('\n');
  return header + rows;
}
