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

export function isTrackedExpenseTransaction(tx: TransferLikeTransaction): boolean {
  return tx.type === 'expense' && !isSavingsTransferTransaction(tx);
}
