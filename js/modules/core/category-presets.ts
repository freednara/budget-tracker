/**
 * Category Presets Module
 *
 * Preset packs for different budgeting styles. Each preset is a complete
 * set of flat expense and income categories.
 * Users pick a preset on first launch, then fully own their category list.
 *
 * @module category-presets
 */
'use strict';

import type { CategoryChild } from '../../types/index.js';

// ==========================================
// PRESET TYPES
// ==========================================

export interface CategoryPreset {
  id: string;
  name: string;
  description: string;
  emoji: string;
  expense: CategoryChild[];
  income: CategoryChild[];
}

// ==========================================
// PERSONAL PRESET (default — current built-in set)
// ==========================================

const PERSONAL_EXPENSE: CategoryChild[] = [
  { id: 'food', name: 'Food & Dining', emoji: '🍔', color: '#f97316' },
  { id: 'transport', name: 'Transport', emoji: '🚗', color: '#3b82f6' },
  { id: 'shopping', name: 'Shopping', emoji: '🛍️', color: '#ec4899' },
  { id: 'bills', name: 'Bills', emoji: '📄', color: '#8b5cf6' },
  { id: 'entertainment', name: 'Entertainment', emoji: '🎬', color: '#06b6d4' },
  { id: 'health', name: 'Health', emoji: '💊', color: '#22c55e' },
  { id: 'education', name: 'Education', emoji: '📚', color: '#eab308' },
  { id: 'other', name: 'Other', emoji: '📦', color: '#64748b' },
  { id: 'debt_payment', name: 'Debt Payments', emoji: '💳', color: '#ef4444' }
];

const PERSONAL_INCOME: CategoryChild[] = [
  { id: 'salary', name: 'Salary', emoji: '💰', color: '#22c55e' },
  { id: 'freelance', name: 'Freelance', emoji: '💻', color: '#3b82f6' },
  { id: 'investment', name: 'Investment', emoji: '📈', color: '#8b5cf6' },
  { id: 'gift', name: 'Gift', emoji: '🎁', color: '#ec4899' },
  { id: 'refund', name: 'Refund', emoji: '↩️', color: '#06b6d4' },
  { id: 'other_income', name: 'Other', emoji: '💵', color: '#64748b' }
];

// ==========================================
// BUSINESS PRESET
// ==========================================

const BUSINESS_EXPENSE: CategoryChild[] = [
  { id: 'payroll', name: 'Payroll', emoji: '👥', color: '#3b82f6' },
  { id: 'office', name: 'Office', emoji: '🏢', color: '#8b5cf6' },
  { id: 'marketing', name: 'Marketing', emoji: '📣', color: '#ec4899' },
  { id: 'software', name: 'Software & Tools', emoji: '💻', color: '#06b6d4' },
  { id: 'travel', name: 'Travel', emoji: '✈️', color: '#f97316' },
  { id: 'taxes', name: 'Taxes', emoji: '🏛️', color: '#ef4444' },
  { id: 'insurance_biz', name: 'Insurance', emoji: '🛡️', color: '#22c55e' },
  { id: 'professional', name: 'Professional Services', emoji: '⚖️', color: '#eab308' },
  { id: 'cogs', name: 'Cost of Goods', emoji: '📦', color: '#64748b' },
  { id: 'other_biz', name: 'Other', emoji: '📦', color: '#64748b' },
  { id: 'debt_payment_biz', name: 'Debt Payments', emoji: '💳', color: '#ef4444' }
];

const BUSINESS_INCOME: CategoryChild[] = [
  { id: 'revenue', name: 'Revenue', emoji: '💰', color: '#22c55e' },
  { id: 'services', name: 'Services', emoji: '🛠️', color: '#3b82f6' },
  { id: 'consulting_inc', name: 'Consulting', emoji: '💼', color: '#8b5cf6' },
  { id: 'interest', name: 'Interest', emoji: '🏦', color: '#06b6d4' },
  { id: 'grants', name: 'Grants', emoji: '📜', color: '#eab308' },
  { id: 'other_biz_income', name: 'Other', emoji: '💵', color: '#64748b' }
];

// ==========================================
// HOUSEHOLD PRESET
// ==========================================

const HOUSEHOLD_EXPENSE: CategoryChild[] = [
  { id: 'housing', name: 'Housing', emoji: '🏠', color: '#8b5cf6' },
  { id: 'groceries_hh', name: 'Groceries', emoji: '🛒', color: '#f97316' },
  { id: 'utilities_hh', name: 'Utilities', emoji: '💡', color: '#eab308' },
  { id: 'childcare', name: 'Childcare', emoji: '👶', color: '#ec4899' },
  { id: 'transport_hh', name: 'Transport', emoji: '🚗', color: '#3b82f6' },
  { id: 'health_hh', name: 'Health', emoji: '💊', color: '#22c55e' },
  { id: 'pets', name: 'Pets', emoji: '🐾', color: '#06b6d4' },
  { id: 'entertainment_hh', name: 'Entertainment', emoji: '🎬', color: '#06b6d4' },
  { id: 'clothing_hh', name: 'Clothing', emoji: '👕', color: '#ec4899' },
  { id: 'other_hh', name: 'Other', emoji: '📦', color: '#64748b' },
  { id: 'debt_payment_hh', name: 'Debt Payments', emoji: '💳', color: '#ef4444' }
];

const HOUSEHOLD_INCOME: CategoryChild[] = [
  { id: 'salary_hh', name: 'Salary', emoji: '💰', color: '#22c55e' },
  { id: 'partner_income', name: 'Partner Income', emoji: '💰', color: '#3b82f6' },
  { id: 'child_support', name: 'Child Support', emoji: '👶', color: '#8b5cf6' },
  { id: 'benefits_hh', name: 'Benefits', emoji: '🏛️', color: '#06b6d4' },
  { id: 'side_income', name: 'Side Income', emoji: '💼', color: '#eab308' },
  { id: 'other_hh_income', name: 'Other', emoji: '💵', color: '#64748b' }
];

// ==========================================
// FREELANCER PRESET
// ==========================================

const FREELANCER_EXPENSE: CategoryChild[] = [
  { id: 'software_fl', name: 'Software & Tools', emoji: '💻', color: '#06b6d4' },
  { id: 'office_fl', name: 'Office', emoji: '🏢', color: '#8b5cf6' },
  { id: 'taxes_fl', name: 'Taxes', emoji: '🏛️', color: '#ef4444' },
  { id: 'marketing_fl', name: 'Marketing', emoji: '📣', color: '#ec4899' },
  { id: 'education_fl', name: 'Professional Development', emoji: '📚', color: '#eab308' },
  { id: 'travel_fl', name: 'Travel', emoji: '✈️', color: '#f97316' },
  { id: 'insurance_fl', name: 'Insurance', emoji: '🛡️', color: '#22c55e' },
  { id: 'living_fl', name: 'Living Expenses', emoji: '🏠', color: '#3b82f6' },
  { id: 'other_fl', name: 'Other', emoji: '📦', color: '#64748b' },
  { id: 'debt_payment_fl', name: 'Debt Payments', emoji: '💳', color: '#ef4444' }
];

const FREELANCER_INCOME: CategoryChild[] = [
  { id: 'client_income', name: 'Client Work', emoji: '💼', color: '#22c55e' },
  { id: 'retainer', name: 'Retainers', emoji: '📋', color: '#3b82f6' },
  { id: 'products', name: 'Products / Templates', emoji: '📦', color: '#8b5cf6' },
  { id: 'royalties', name: 'Royalties', emoji: '📈', color: '#ec4899' },
  { id: 'teaching', name: 'Teaching / Mentoring', emoji: '🎓', color: '#eab308' },
  { id: 'other_fl_income', name: 'Other', emoji: '💵', color: '#64748b' }
];

// ==========================================
// PRESET REGISTRY
// ==========================================

export const CATEGORY_PRESETS: readonly CategoryPreset[] = [
  {
    id: 'personal',
    name: 'Personal',
    description: 'Everyday budgeting for individuals and couples',
    emoji: '👤',
    expense: PERSONAL_EXPENSE,
    income: PERSONAL_INCOME
  },
  {
    id: 'household',
    name: 'Household',
    description: 'Family budgeting with kids, pets, and home costs',
    emoji: '🏠',
    expense: HOUSEHOLD_EXPENSE,
    income: HOUSEHOLD_INCOME
  },
  {
    id: 'freelancer',
    name: 'Freelancer',
    description: 'Track client income, taxes, tools, and living costs',
    emoji: '💻',
    expense: FREELANCER_EXPENSE,
    income: FREELANCER_INCOME
  },
  {
    id: 'business',
    name: 'Business',
    description: 'Revenue, payroll, COGS, and operational expenses',
    emoji: '🏢',
    expense: BUSINESS_EXPENSE,
    income: BUSINESS_INCOME
  }
] as const;

/**
 * Get a preset by ID
 */
export function getPresetById(presetId: string): CategoryPreset | undefined {
  return CATEGORY_PRESETS.find(p => p.id === presetId);
}

/**
 * Get the default preset.
 *
 * Phase 6 Slice 1i (rev 12 L6): `CATEGORY_PRESETS[0]` is
 * `CategoryPreset | undefined` under `noUncheckedIndexedAccess`. The
 * module-level array is populated with multiple entries and frozen in
 * practice, so presence is guaranteed — but we synthesize an empty
 * Personal fallback rather than asserting, which keeps the function
 * total even if the preset list is ever cleared for a test harness.
 */
export function getDefaultPreset(): CategoryPreset {
  return CATEGORY_PRESETS[0] ?? {
    id: 'personal',
    name: 'Personal',
    description: 'Default preset',
    emoji: '🏠',
    expense: [],
    income: []
  };
}

// ==========================================
// SEMANTIC ROLE MAPS (for cross-preset migration)
// ==========================================

/**
 * Maps each preset's category IDs to semantic roles.
 * Used to translate data when switching between presets.
 *
 * Expense roles: rent, utilities, internet, food, transport, shopping,
 *                entertainment, health, education, other
 * Income roles:  salary, freelance, investment, gift, refund
 */
interface PresetRoleMap {
  expense: Record<string, string>;  // catId → semantic role
  income: Record<string, string>;   // catId → semantic role
}

const PRESET_ROLE_MAPS: Record<string, PresetRoleMap> = {
  personal: {
    expense: {
      bills: 'rent',        // bills covers rent + utilities + internet
      food: 'food',
      transport: 'transport',
      shopping: 'shopping',
      entertainment: 'entertainment',
      health: 'health',
      education: 'education',
      other: 'other',
      debt_payment: 'debt_payment'
    },
    income: {
      salary: 'salary',
      freelance: 'freelance',
      investment: 'investment',
      gift: 'gift',
      refund: 'refund',
      other_income: 'other_income'
    }
  },
  household: {
    expense: {
      housing: 'rent',
      utilities_hh: 'utilities',
      groceries_hh: 'food',
      transport_hh: 'transport',
      clothing_hh: 'shopping',
      entertainment_hh: 'entertainment',
      health_hh: 'health',
      childcare: 'education',
      pets: 'pets',
      other_hh: 'other',
      debt_payment_hh: 'debt_payment'
    },
    income: {
      salary_hh: 'salary',
      partner_income: 'freelance',
      child_support: 'gift',
      benefits_hh: 'investment',
      side_income: 'freelance',
      other_hh_income: 'other_income'
    }
  },
  freelancer: {
    expense: {
      living_fl: 'rent',       // also serves as food + pets target
      software_fl: 'utilities',
      office_fl: 'shopping',
      taxes_fl: 'other',
      marketing_fl: 'entertainment',
      education_fl: 'education',
      travel_fl: 'transport',
      insurance_fl: 'health',
      other_fl: 'other',
      debt_payment_fl: 'debt_payment'
    },
    income: {
      client_income: 'salary',
      retainer: 'freelance',
      products: 'investment',
      royalties: 'investment',
      teaching: 'freelance',
      other_fl_income: 'other_income'
    }
  },
  business: {
    expense: {
      payroll: 'other',
      office: 'rent',
      marketing: 'entertainment',
      software: 'utilities',
      travel: 'transport',
      taxes: 'other',
      insurance_biz: 'health',
      professional: 'education',
      cogs: 'shopping',
      other_biz: 'other',
      debt_payment_biz: 'debt_payment'
    },
    income: {
      revenue: 'salary',
      services: 'freelance',
      consulting_inc: 'freelance',
      interest: 'investment',
      grants: 'gift',
      other_biz_income: 'other_income'
    }
  }
};

/**
 * Role fallbacks: when a target preset doesn't have a specific role,
 * fall back to a related role. e.g., 'food' → 'rent' (living expenses).
 */
const ROLE_FALLBACKS: Record<string, string[]> = {
  food: ['rent', 'other'],
  pets: ['other', 'rent'],
  rent: ['other'],
  utilities: ['rent', 'other'],
  transport: ['other'],
  shopping: ['other'],
  entertainment: ['other'],
  health: ['other'],
  education: ['other'],
  other: [],
  debt_payment: ['other'],
  salary: ['freelance', 'other_income'],
  freelance: ['salary', 'other_income'],
  investment: ['other_income', 'salary'],
  gift: ['other_income'],
  refund: ['other_income'],
  other_income: []
};

/**
 * Reverse role map: semantic role → catId for a given preset.
 * When multiple catIds map to the same role, the first one wins
 * (which is fine — we just need a valid target).
 */
function buildRoleToIdMap(presetId: string, type: 'expense' | 'income'): Map<string, string> {
  const roleMap = PRESET_ROLE_MAPS[presetId]?.[type] || {};
  const reversed = new Map<string, string>();
  for (const [catId, role] of Object.entries(roleMap)) {
    if (!reversed.has(role)) {
      reversed.set(role, catId);
    }
  }
  return reversed;
}

/**
 * Look up a role in the reverse map, falling back through ROLE_FALLBACKS
 * if the target preset doesn't have a direct mapping for that role.
 */
function resolveRole(role: string, reverseMap: Map<string, string>): string | undefined {
  const direct = reverseMap.get(role);
  if (direct) return direct;

  const fallbacks = ROLE_FALLBACKS[role];
  if (fallbacks) {
    for (const fb of fallbacks) {
      const fallback = reverseMap.get(fb);
      if (fallback) return fallback;
    }
  }
  return undefined;
}

/**
 * Build a category ID migration map from one preset to another.
 * Returns a Map<oldCatId, newCatId> for remapping stored data.
 * Only includes entries where the ID actually changes.
 */
export function buildPresetMigrationMap(
  fromPresetId: string,
  toPresetId: string
): Map<string, string> {
  const migrationMap = new Map<string, string>();

  for (const type of ['expense', 'income'] as const) {
    const fromRoles = PRESET_ROLE_MAPS[fromPresetId]?.[type] || {};
    const toReversed = buildRoleToIdMap(toPresetId, type);

    for (const [oldCatId, role] of Object.entries(fromRoles)) {
      const newCatId = resolveRole(role, toReversed);
      if (newCatId && newCatId !== oldCatId) {
        migrationMap.set(oldCatId, newCatId);
      }
    }
  }

  return migrationMap;
}
