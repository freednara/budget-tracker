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

// ==========================================
// TRANSACTION VALIDATION
// ==========================================

/**
 * Validate transactions on application load
 * Checks required fields, types, amounts, and dates
 * Unknown categories are allowed but logged as warnings
 *
 * @param txs - Array of transactions to validate
 * @returns Object with valid transactions and count of removed
 */
export function validateTransactionsOnLoad(txs: unknown[]): ValidationResult {
  if (!Array.isArray(txs)) return { valid: [], removed: 0 };

  // Build set of all known category IDs
  const allCatIds = new Set([
    ...EXPENSE_CATS.map(c => c.id),
    ...INCOME_CATS.map(c => c.id),
    ...(signals.customCats.value || []).map((c: CustomCategory) => c.id)
  ]);

  const valid: Transaction[] = [];
  let removed = 0;

  for (const t of txs) {
    // Check required fields exist
    if (!t || typeof t !== 'object') {
      removed++;
      continue;
    }

    const tx = t as Record<string, unknown>;

    // Check required fields
    if (!tx.date || !tx.type || !tx.category) {
      removed++;
      continue;
    }

    // Check type is valid
    if (tx.type !== 'income' && tx.type !== 'expense') {
      removed++;
      continue;
    }

    // Check amount is a valid number
    const amt = parseFloat(String(tx.amount));
    if (isNaN(amt)) {
      removed++;
      continue;
    }

    // Check date is parseable
    const dateObj = parseLocalDate(String(tx.date));
    if (isNaN(dateObj.getTime())) {
      removed++;
      continue;
    }

    // Check category exists (allow unknown categories for flexibility)
    // but log a warning if not recognized
    if (!allCatIds.has(String(tx.category))) {
      console.warn('Unknown category:', tx.category, 'in transaction:', t);
    }

    valid.push(t as Transaction);
  }

  return { valid, removed };
}
