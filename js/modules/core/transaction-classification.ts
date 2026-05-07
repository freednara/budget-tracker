'use strict';

import type { CategoryChild, Transaction } from '../../types/index.js';

export const SAVINGS_TRANSFER_CATEGORY_ID = 'savings_transfer';
export const LEGACY_SAVINGS_CATEGORY_ID = 'savings';
export const SAVINGS_TRANSFER_TAG = 'savings_transfer';
export const SAVINGS_TRANSFER_NOTE_MARKER = '[savings-transfer]';

export const SAVINGS_TRANSFER_CATEGORY_INFO: CategoryChild = {
  id: SAVINGS_TRANSFER_CATEGORY_ID,
  name: 'Savings Transfer',
  emoji: '💚',
  color: '#10b981'
};

type TransferLikeTransaction = {
  type: Transaction['type'] | string;
  category: string;
  tags?: string;
  notes?: string;
  description?: string;
};

function parseTags(tags?: string): string[] {
  return (tags || '')
    .split(',')
    .map((tag: string) => tag.trim())
    .filter(Boolean);
}

export function isSavingsTransferCategory(categoryId: string): boolean {
  return categoryId === SAVINGS_TRANSFER_CATEGORY_ID || categoryId === LEGACY_SAVINGS_CATEGORY_ID;
}

export function isSavingsTransferTransaction(tx: Pick<TransferLikeTransaction, 'category' | 'tags' | 'notes' | 'description'>): boolean {
  if (tx.category === SAVINGS_TRANSFER_CATEGORY_ID) return true;

  const tags = parseTags(tx.tags);
  const hasSavingsGoalTags = tags.includes(SAVINGS_TRANSFER_TAG) || (tags.includes('savings') && tags.includes('goal'));
  const hasSavingsMarker = (tx.notes || '').includes(SAVINGS_TRANSFER_NOTE_MARKER)
    || (tx.notes || '').includes('Contribution to goal:')
    || (tx.description || '').startsWith('Savings Transfer:');

  return tx.category === LEGACY_SAVINGS_CATEGORY_ID && (hasSavingsGoalTags || hasSavingsMarker);
}

export function getSavingsTransferGoalName(tx: Pick<TransferLikeTransaction, 'description' | 'notes'>): string | null {
  const description = tx.description || '';
  if (description.startsWith('Savings Transfer:')) {
    return description.replace(/^Savings Transfer:\s*/, '').trim() || null;
  }

  const notes = tx.notes || '';
  const noteMatch = notes.match(/Contribution to goal:\s*(.+?)(?:\s*\[id:|$)/);
  return noteMatch?.[1]?.trim() || null;
}

/**
 * Round 7 fix: Document assumption about savings detection and broaden category check.
 * A "tracked expense" is an expense that is NOT a savings transfer.
 * Savings transfers are identified by:
 * 1. Category ID: SAVINGS_TRANSFER_CATEGORY_ID or LEGACY_SAVINGS_CATEGORY_ID
 * 2. Tags: Contains 'savings_transfer' OR both 'savings' and 'goal'
 * 3. Description/Notes: Contains markers like '[savings-transfer]' or 'Savings Transfer:' or 'Contribution to goal:'
 *
 * To broaden this check and prevent custom "Savings" categories from slipping through,
 * also exclude expenses whose category name contains "savings" or "transfer" (case-insensitive).
 */
export function isTrackedExpenseTransaction(tx: TransferLikeTransaction): boolean {
  if (tx.type !== 'expense') return false;

  // Round 7 fix: Check if category name (not just ID) suggests it's a savings/transfer category
  const categoryLower = (tx.category || '').toLowerCase();
  if (categoryLower.includes('savings') || categoryLower.includes('transfer')) {
    return false;
  }

  return !isSavingsTransferTransaction(tx);
}
