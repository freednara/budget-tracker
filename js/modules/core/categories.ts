/**
 * Categories Module
 * Category definitions and helper functions with reactive indexing for O(1) performance.
 *
 * Now reads from the user-owned category store instead of hardcoded constants.
 * The public API (getCatInfo, getAllCats, etc.) is unchanged — all consumers
 * continue to work without modification.
 *
 * @module categories
 */

import {
  expenseCategories,
  incomeCategories,
  indexedUserCategories
} from './category-store.js';
import {
  isSavingsTransferCategory,
  SAVINGS_TRANSFER_CATEGORY_INFO
} from './transaction-classification.js';
import { CATEGORY_PRESETS } from './category-presets.js';
import type {
  TransactionType,
  CategoryChild,
  FlattenedCategory,
  EmojiPickerCategories
} from '../../types/index.js';

// ==========================================
// CONSTANTS
// ==========================================

/** Default color for new/unknown categories. */
export const DEFAULT_CATEGORY_COLOR = '#8b5cf6';

// ==========================================
// LEGACY EXPORTS (kept for backward compat during migration)
// These now read from the store instead of being hardcoded.
// ==========================================

/**
 * Expense categories — reads from user store.
 * NOTE: This is a getter, not a static array. Consumers that need
 * reactivity should use expenseCategories computed signal directly.
 */
export function getExpenseCats(): readonly CategoryChild[] {
  return expenseCategories.value;
}

/**
 * Income categories — reads from user store.
 */
export function getIncomeCats(): readonly CategoryChild[] {
  return incomeCategories.value;
}

/**
 * Legacy constants — kept as getters for existing imports.
 * Code that imports EXPENSE_CATS/INCOME_CATS will still work,
 * but now gets live data from the store.
 */
export const EXPENSE_CATS = new Proxy([] as CategoryChild[], {
  get(target, prop) {
    const cats = expenseCategories.value;
    if (prop === Symbol.iterator) return cats[Symbol.iterator].bind(cats);
    if (prop === 'length') return cats.length;
    if (prop === 'find') return cats.find.bind(cats);
    if (prop === 'filter') return cats.filter.bind(cats);
    if (prop === 'map') return cats.map.bind(cats);
    if (prop === 'forEach') return cats.forEach.bind(cats);
    if (prop === 'reduce') return cats.reduce.bind(cats);
    if (prop === 'some') return cats.some.bind(cats);
    if (prop === 'every') return cats.every.bind(cats);
    if (prop === 'flatMap') return cats.flatMap.bind(cats);
    if (prop === 'includes') return cats.includes.bind(cats);
    if (typeof prop === 'string' && !isNaN(Number(prop))) return cats[Number(prop)];
    return Reflect.get(cats, prop);
  }
});

export const INCOME_CATS = new Proxy([] as CategoryChild[], {
  get(target, prop) {
    const cats = incomeCategories.value;
    if (prop === Symbol.iterator) return cats[Symbol.iterator].bind(cats);
    if (prop === 'length') return cats.length;
    if (prop === 'find') return cats.find.bind(cats);
    if (prop === 'filter') return cats.filter.bind(cats);
    if (prop === 'map') return cats.map.bind(cats);
    if (prop === 'forEach') return cats.forEach.bind(cats);
    if (prop === 'reduce') return cats.reduce.bind(cats);
    if (prop === 'some') return cats.some.bind(cats);
    if (prop === 'every') return cats.every.bind(cats);
    if (prop === 'flatMap') return cats.flatMap.bind(cats);
    if (prop === 'includes') return cats.includes.bind(cats);
    if (typeof prop === 'string' && !isNaN(Number(prop))) return cats[Number(prop)];
    return Reflect.get(cats, prop);
  }
});

/**
 * Emoji picker categories (these remain static — not user-configurable)
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
 * All categories indexed by ID for fast O(1) lookup.
 * Now backed by the user store.
 */
export const indexedCategories = indexedUserCategories;

// ==========================================
// CATEGORY HELPER FUNCTIONS
// ==========================================

/**
 * Get category information by ID
 * Uses indexed lookups for high performance.
 * Falls back to scanning all presets for orphaned category IDs
 * (e.g. transactions left over from a different preset).
 */
export function getCatInfo(_type: TransactionType, catId: string): CategoryChild {
  if (isSavingsTransferCategory(catId)) {
    return { ...SAVINGS_TRANSFER_CATEGORY_INFO, id: catId };
  }

  const found = indexedCategories.value.get(catId);
  if (found) return found as CategoryChild;

  // Cross-preset fallback: scan all preset definitions for orphaned category IDs
  for (const preset of CATEGORY_PRESETS) {
    const lists = _type === 'income' ? [preset.income] : [preset.expense];
    // Also check the other type as a last resort
    lists.push(_type === 'income' ? preset.expense : preset.income);
    for (const list of lists) {
      const match = list.find(c => c.id === catId);
      if (match) return match;
    }
  }

  // Final fallback for truly unknown categories
  return { id: catId, name: 'Unknown', emoji: '❓', color: DEFAULT_CATEGORY_COLOR };
}

/**
 * Get all categories for a given type
 */
export function getAllCats(type: TransactionType): FlattenedCategory[] {
  if (type === 'expense') {
    return expenseCategories.value as FlattenedCategory[];
  }

  return incomeCategories.value as FlattenedCategory[];
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
