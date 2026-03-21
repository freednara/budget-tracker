/**
 * Categories Module
 * Category definitions and helper functions with reactive indexing for O(1) performance.
 *
 * @module categories
 */

import * as signals from './signals.js';
import { computed } from '@preact/signals-core';
import {
  isSavingsTransferCategory,
  SAVINGS_TRANSFER_CATEGORY_INFO
} from './transaction-classification.js';
import type {
  TransactionType,
  CategoryChild,
  CategoryDefinition,
  FlattenedCategory,
  EmojiPickerCategories
} from '../../types/index.js';

// ==========================================
// CONSTANTS
// ==========================================

/** Default color for new/unknown categories. */
export const DEFAULT_CATEGORY_COLOR = '#8b5cf6';

// ==========================================
// CATEGORY DEFINITIONS
// ==========================================

/**
 * Expense category definitions with hierarchical subcategories
 */
export const EXPENSE_CATS: readonly CategoryDefinition[] = [
  { id: 'food', name: 'Food & Dining', emoji: '🍔', color: '#f97316', children: [
    { id: 'food_groceries', name: 'Groceries', emoji: '🛒', color: '#f97316' },
    { id: 'food_dining', name: 'Dining Out', emoji: '🍽️', color: '#f97316' },
    { id: 'food_coffee', name: 'Coffee & Snacks', emoji: '☕', color: '#f97316' }
  ]},
  { id: 'transport', name: 'Transport', emoji: '🚗', color: '#3b82f6', children: [
    { id: 'transport_gas', name: 'Gas', emoji: '⛽', color: '#3b82f6' },
    { id: 'transport_parking', name: 'Parking', emoji: '🅿️', color: '#3b82f6' },
    { id: 'transport_maintenance', name: 'Maintenance', emoji: '🔧', color: '#3b82f6' },
    { id: 'transport_public', name: 'Public Transit', emoji: '🚌', color: '#3b82f6' }
  ]},
  { id: 'shopping', name: 'Shopping', emoji: '🛍️', color: '#ec4899', children: [
    { id: 'shopping_clothes', name: 'Clothing', emoji: '👕', color: '#ec4899' },
    { id: 'shopping_electronics', name: 'Electronics', emoji: '📱', color: '#ec4899' },
    { id: 'shopping_home', name: 'Home Goods', emoji: '🏠', color: '#ec4899' }
  ]},
  { id: 'bills', name: 'Bills', emoji: '📄', color: '#8b5cf6', children: [] },
  { id: 'entertainment', name: 'Entertainment', emoji: '🎬', color: '#06b6d4', children: [] },
  { id: 'health', name: 'Health', emoji: '💊', color: '#22c55e', children: [] },
  { id: 'education', name: 'Education', emoji: '📚', color: '#eab308', children: [] },
  { id: 'other', name: 'Other', emoji: '📦', color: '#64748b', children: [] }
] as const;

/**
 * Income category definitions
 */
export const INCOME_CATS: readonly CategoryChild[] = [
  { id: 'salary', name: 'Salary', emoji: '💰', color: '#22c55e' },
  { id: 'freelance', name: 'Freelance', emoji: '💻', color: '#3b82f6' },
  { id: 'investment', name: 'Investment', emoji: '📈', color: '#8b5cf6' },
  { id: 'gift', name: 'Gift', emoji: '🎁', color: '#ec4899' },
  { id: 'refund', name: 'Refund', emoji: '↩️', color: '#06b6d4' },
  { id: 'other_income', name: 'Other', emoji: '💵', color: '#64748b' }
] as const;

/**
 * Emoji picker categories
 */
export const EMOJI_PICKER_CATEGORIES: EmojiPickerCategories = {
  money: ['💵', '💴', '💶', '💷', '💰', '💸', '💳', '🏦', '🪙', '💎', '📈', '📉', '💹', '🏧'],
  food: ['🍔', '🍕', '🍣', '🥗', '🍜', '☕', '🍺', '🛒', '🥡', '🍳', '🍰', '🥤'],
  transport: ['🚗', '🚌', '✈️', '🚂', '⛽', '🚕', '🚲', '🛴', '🚇', '🛫', '🚢', '🛵'],
  shopping: ['🛍️', '👕', '👗', '👟', '💄', '🎁', '📦', '🏪', '🏬', '💍', '👜', '🛒'],
  entertainment: ['🎬', '🎮', '🎵', '📺', '🎭', '🎤', '🎸', '📚', '🎲', '🎪', '🎨', '🎧'],
  health: ['💊', '🏥', '🩺', '🦷', '💪', '🧘', '🏃', '❤️', '🩹', '🧠', '🏋️', '🩻'],
  home: ['🏠', '🔌', '💡', '🛋️', '🧹', '🔧', '🪴', '🛏️', '🚿', '🧺', '🪑', '🏡'],
  work: ['💼', '💻', '📱', '📧', '📊', '🖨️', '📁', '🎓', '✏️', '📎', '🗂️', '📝'],
  misc: ['⭐', '✨', '🎯', '🔔', '⚡', '🌈', '🏆', '📌', '🎀', '💝', '🌟', '🔥']
} as const;

// ==========================================
// REACTIVE INDEXED CATEGORIES
// ==========================================

/**
 * All categories indexed by ID for fast O(1) lookup
 * WATCHES: signals.customCats
 */
/**
 * Pre-built index of all static (built-in) categories.
 * Computed once at module load since EXPENSE_CATS and INCOME_CATS never change.
 */
const STATIC_CATEGORY_INDEX: Map<string, FlattenedCategory> = (() => {
  const index = new Map<string, FlattenedCategory>();
  for (const cat of EXPENSE_CATS) {
    index.set(cat.id, cat as FlattenedCategory);
    if (cat.children) {
      for (const child of cat.children) {
        index.set(child.id, { ...child, parent: cat.id, parentName: cat.name } as FlattenedCategory);
      }
    }
  }
  for (const cat of INCOME_CATS) {
    index.set(cat.id, cat as FlattenedCategory);
  }
  return index;
})();

export const indexedCategories = computed(() => {
  const customCats = signals.customCats.value;

  // Fast path: no custom categories, return the static index directly
  if (customCats.length === 0) {
    return STATIC_CATEGORY_INDEX;
  }

  // Clone static index and overlay custom categories
  const index = new Map(STATIC_CATEGORY_INDEX);
  for (const cat of customCats) {
    index.set(cat.id, cat as FlattenedCategory);
  }
  return index;
});

// ==========================================
// CATEGORY HELPER FUNCTIONS
// ==========================================

/**
 * Get category information by ID
 * FIXED: Uses indexed lookups for high performance
 */
export function getCatInfo(_type: TransactionType, catId: string): CategoryChild {
  if (isSavingsTransferCategory(catId)) {
    return { ...SAVINGS_TRANSFER_CATEGORY_INFO, id: catId };
  }

  const found = indexedCategories.value.get(catId);
  if (found) return found as CategoryChild;

  // Fallback for unknown categories
  return { id: catId, name: 'Unknown', emoji: '❓', color: DEFAULT_CATEGORY_COLOR };
}

/**
 * Get all categories for a given type
 */
export function getAllCats(type: TransactionType, includeChildren: boolean = false): FlattenedCategory[] {
  const base = type === 'expense' ? EXPENSE_CATS : INCOME_CATS;
  const custom = signals.customCats.value.filter((c: { type: TransactionType }) => c.type === type);

  if (!includeChildren) {
    return [...base, ...custom] as FlattenedCategory[];
  }

  // Flatten to include subcategories
  const flattened: FlattenedCategory[] = [];

  if (type === 'expense') {
    (base as readonly CategoryDefinition[]).forEach(cat => {
      flattened.push(cat);
      if (cat.children && cat.children.length > 0) {
        cat.children.forEach(child => {
          flattened.push({ ...child, parent: cat.id, parentName: cat.name } as FlattenedCategory);
        });
      }
    });
  } else {
    flattened.push(...(base as readonly CategoryChild[]).map(c => c as FlattenedCategory));
  }

  return [...flattened, ...(custom as FlattenedCategory[])];
}

/**
 * Find category by ID across all categories (expense and income)
 */
export function findCategoryById(catId: string): CategoryChild | null {
  if (isSavingsTransferCategory(catId)) {
    return { ...SAVINGS_TRANSFER_CATEGORY_INFO, id: catId };
  }

  const found = indexedCategories.value.get(catId);
  return found ? (found as CategoryChild) : null;
}

/**
 * Check if a category has subcategories
 */
export function hasSubcategories(catId: string): boolean {
  const cat = EXPENSE_CATS.find(c => c.id === catId);
  return !!(cat && cat.children && cat.children.length > 0);
}

/**
 * Get parent category ID for a subcategory
 */
export function getParentCategory(subcatId: string): string | null {
  const found = indexedCategories.value.get(subcatId);
  return found?.parent || null;
}
