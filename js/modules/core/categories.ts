/**
 * Categories Module
 * Category definitions and helper functions
 *
 * @module categories
 */

import * as signals from './signals.js';
import type {
  TransactionType,
  CategoryChild,
  CategoryDefinition,
  FlattenedCategory,
  EmojiPickerCategories
} from '../../types/index.js';

// ==========================================
// CATEGORY DEFINITIONS
// ==========================================

/**
 * Expense category definitions with hierarchical subcategories
 * Each category can have optional children array for subcategories
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
 * Emoji picker categories for custom category creation
 * Organized by theme for easy emoji selection
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
// CATEGORY HELPER FUNCTIONS
// ==========================================

/**
 * Get category information by ID
 * Searches custom categories first, then built-in categories
 */
export function getCatInfo(type: TransactionType, catId: string): CategoryChild {
  // Check custom categories first
  const custom = signals.customCats.value.find((c: { id: string }) => c.id === catId);
  if (custom) return custom as CategoryChild;

  // Check built-in categories
  const cats = type === 'expense' ? EXPENSE_CATS : INCOME_CATS;

  // First check parent categories
  const parent = cats.find(c => c.id === catId);
  if (parent) return parent;

  // Then check subcategories (only for expense categories with children)
  if (type === 'expense') {
    for (const cat of EXPENSE_CATS) {
      if (cat.children && cat.children.length > 0) {
        const child = cat.children.find(c => c.id === catId);
        if (child) return child;
      }
    }
  }

  // Fallback for unknown categories
  return { id: catId, name: 'Unknown', emoji: '❓', color: '#64748b' };
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
          flattened.push({ ...child, parent: cat.id, parentName: cat.name });
        });
      }
    });
  } else {
    flattened.push(...(base as readonly CategoryChild[]));
  }

  return [...flattened, ...(custom as FlattenedCategory[])];
}

/**
 * Find category by ID across all categories (expense and income)
 */
export function findCategoryById(catId: string): CategoryChild | null {
  // Search expense categories
  let cat = getCatInfo('expense', catId);
  if (cat.name !== 'Unknown') return cat;

  // Search income categories
  cat = getCatInfo('income', catId);
  if (cat.name !== 'Unknown') return cat;

  return null;
}

/**
 * Check if a category has subcategories
 */
export function hasSubcategories(catId: string): boolean {
  const allCats: readonly CategoryDefinition[] = [...EXPENSE_CATS];
  const cat = allCats.find(c => c.id === catId);
  return !!(cat && cat.children && cat.children.length > 0);
}

/**
 * Get parent category ID for a subcategory
 */
export function getParentCategory(subcatId: string): string | null {
  for (const cat of EXPENSE_CATS) {
    if (cat.children && cat.children.length > 0) {
      const hasChild = cat.children.some(child => child.id === subcatId);
      if (hasChild) return cat.id;
    }
  }

  return null;
}
