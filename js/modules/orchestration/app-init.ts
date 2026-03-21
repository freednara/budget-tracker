/**
 * App Initialization Module
 * Startup validation, deduplication, and initialization helpers
 *
 * @module app-init
 */
'use strict';

import { generateId, parseLocalDate } from '../core/utils.js';
import { EXPENSE_CATS, INCOME_CATS } from '../core/categories.js';
import * as signals from '../core/signals.js';
import type { Transaction, CustomCategory } from '../../types/index.js';

// ==========================================
// TYPES
// ==========================================

export interface ValidationResult {
  valid: Transaction[];
  removed: number;
}

// ==========================================
// TRANSACTION DEDUPLICATION
// ==========================================

/**
 * Deduplicate transactions by __backendId
 * Assigns new IDs to transactions without one or with duplicate IDs
 *
 * @param txs - Array of transactions (possibly with duplicates)
 * @returns Deduplicated array with unique IDs
 */
export function deduplicateTransactions(txs: unknown[]): Transaction[] {
  if (!Array.isArray(txs)) return [];

  const seen = new Set<string>();
  const genId = (): string => 'tx_' + generateId();

  return txs.map(t => {
    const tx = t as Transaction;
    if (!tx.__backendId || seen.has(tx.__backendId)) {
      return { ...tx, __backendId: genId() };
    }
    seen.add(tx.__backendId);
    return tx;
  });
}

// validateTransactionsOnLoad removed - use validator.validateTransaction() for per-transaction validation
// or validator.validateImportData() for batch validation
