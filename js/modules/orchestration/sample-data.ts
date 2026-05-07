/**
 * Sample Data Module
 * Builds a deterministic demo account with transactions and planning state.
 *
 * @module sample-data
 */
'use strict';

import * as signals from '../core/signals.js';
import { SK, persist } from '../core/state.js';
import { data as dataActions, savingsGoals as savingsGoalsActions } from '../core/state-actions.js';
import { dataSdk } from '../data/data-manager.js';
import { emit, Events } from '../core/event-bus.js';
import { trackError } from '../core/error-tracker.js';
import { asyncConfirm } from '../ui/components/async-modal.js';
import { userCategoryConfig } from '../core/category-store.js';
import { addDebt, recordPayment, removeDebt } from '../features/financial/debt-planner.js';
import {
  createRecurringTemplate,
  deleteRecurringTemplate,
  getRecurringTemplates,
  type RecurringTemplate
} from '../data/recurring-templates.js';
import { invalidateMonthlyTotalsCache, invalidateRolloverCache } from '../features/financial/calculations.js';
import { SAVINGS_TRANSFER_NOTE_MARKER } from '../core/transaction-classification.js';
import type {
  Debt,
  MonthlyAllocation,
  RolloverSettings,
  SavingsGoal,
  Transaction,
  TransactionType,
  TxTemplate
} from '../../types/index.js';

const DEMO_PROFILE_TAG = 'demo_profile';
const DEMO_PROFILE_NOTE_MARKER = '[demo_profile:starter]';
const DEMO_PROFILE_ID_PREFIX = 'demo_tx_';

interface DemoTransactionSeed {
  __backendId: string;
  type: TransactionType;
  category: string;
  amount: number;
  description: string;
  date: string;
  tags?: string;
  notes?: string;
  reconciled?: boolean;
}

// rev 12 #34: demo-seed shape mirrors the modern `SavingsGoalData` input
// shape from `data-actions.savingsGoals.addGoal`, so the seed object can
// be passed straight through without a field rename. `contributionAmount`
// is a seeder-only field and is consumed separately below by the
// addContribution call — it is not part of `SavingsGoalData`.
interface DemoContributionSeed {
  amount: number;
  date: string;
}

interface DemoSavingsGoalSeed {
  key: string;
  name: string;
  target: number;
  saved: number;
  deadline: string;
  contributionAmount?: number;
  /** Backdated contributions for realistic history. Each creates a
   *  savings-transfer transaction on the given date. */
  contributions?: DemoContributionSeed[];
}

interface DemoPaymentSeed {
  amount: number;
  date: string;
}

interface DemoDebtSeed {
  name: string;
  type: Debt['type'];
  balance: number;
  originalBalance: number;
  interestRate: number;
  minimumPayment: number;
  dueDay: number;
  samplePaymentAmount?: number;
  /** Backdated payments for realistic payoff history. */
  payments?: DemoPaymentSeed[];
}

export interface DemoProfileSeed {
  transactions: DemoTransactionSeed[];
  monthlyAllocations: Record<string, MonthlyAllocation>;
  savingsGoals: DemoSavingsGoalSeed[];
  debts: DemoDebtSeed[];
  txTemplates: TxTemplate[];
  recurringTemplates: Array<Omit<RecurringTemplate, 'id' | 'lastGeneratedDate' | 'active'>>;
  rolloverSettings?: RolloverSettings;
}

// ==========================================================================
// M26 (rev 12): structured seed-result types
//
// The three seeder helpers (`seedSavingsGoals`, `seedDebts`,
// `seedRecurringTemplates`) previously returned `Promise<number>` and threw
// on the first inner-await rejection. `Promise.all` then rejected, and
// `loadSampleData` raised unhandled — leaving a half-seeded profile that
// the `hasExistingDemoProfile()` guard would veto on retry.
//
// The new contract: each seeder catches per-iteration failures structurally
// into `DemoSeedResult.failed[]` and returns a complete `{ created, failed }`
// record. `loadSampleData` sequentializes the seeders (await-in-sequence
// instead of Promise.all) so a top-level exception path remains exclusively
// for truly unexpected failures (persist call throws, invalidate throws,
// etc.) — which rollback via `rollbackDemoTransactions`.
//
// Same fix shape as M12's `SanitizedImportResult` + `reportImportValidationRejections`
// pattern, applied to the demo-seed path.
// ==========================================================================
export interface DemoSeedFailure {
  /** Human-readable identifier for the failed row (goal name, debt name, template description). */
  name: string;
  /** Error message from the caught exception (or `String(err)` fallback). */
  reason: string;
}

export interface DemoSeedResult {
  /** Count of rows successfully created in this seeder run. */
  created: number;
  /** Per-row failures captured without aborting the outer loop. */
  failed: DemoSeedFailure[];
}

export interface DemoLoadSummary {
  /** Transactions landed via `dataSdk.createBatch` before the seeder phase. */
  transactionCount: number;
  goals: DemoSeedResult;
  debts: DemoSeedResult;
  recurring: DemoSeedResult;
}

/**
 * CR-Apr22-F slice 4 (Finding 9 P2): `loadSampleData` previously rolled
 * back only the batch-created transactions on unexpected failure —
 * allocations, tx-templates, and any successfully-seeded goals / debts /
 * recurring templates survived the catch. The user saw a "rollback"
 * toast but the account was left partially seeded.
 *
 * The log tracks ids of entities we actually CREATED on the current run
 * (skip-dedup paths do NOT append). On rollback we walk these lists to
 * undo exactly what we added — preserving any pre-existing demo state
 * that came from a prior partial success the user hasn't cleaned up.
 *
 * Paired with allocation + tx-template snapshots captured at entry so
 * those two merge sites can be restored wholesale (cheaper than diffing
 * the merge result against the original).
 */
export interface DemoLoadResourceLog {
  goalIds: string[];
  debtIds: string[];
  recurringIds: string[];
}

function createEmptyResourceLog(): DemoLoadResourceLog {
  return { goalIds: [], debtIds: [], recurringIds: [] };
}

interface DemoMonthContext {
  monthKey: string;
  daysInMonth: number;
  visibleDays: number;
  multiplier: number;
}

// ==========================================
// CATEGORY ROLE MAPPING
// ==========================================

/**
 * Maps semantic transaction roles to actual category IDs per preset.
 * Sample data uses these roles instead of hardcoded category IDs so
 * demo transactions, allocations, and templates align with whatever
 * category preset the user has active.
 */
interface CategoryRoleMap {
  salary: string;
  freelance: string;
  investment: string;
  gift: string;
  refund: string;
  rent: string;
  utilities: string;
  internet: string;
  food: string;
  transport: string;
  shopping: string;
  entertainment: string;
  health: string;
  education: string;
  other: string;
  debt_payment: string;
}

const PRESET_ROLE_MAPS: Record<string, CategoryRoleMap> = {
  personal: {
    salary: 'salary', freelance: 'freelance',
    investment: 'investment', gift: 'gift', refund: 'refund',
    rent: 'bills', utilities: 'bills', internet: 'bills',
    food: 'food', transport: 'transport', shopping: 'shopping',
    entertainment: 'entertainment', health: 'health',
    education: 'education', other: 'other',
    debt_payment: 'debt_payment'
  },
  household: {
    salary: 'salary_hh', freelance: 'side_income',
    investment: 'salary_hh', gift: 'salary_hh', refund: 'salary_hh',
    rent: 'housing', utilities: 'utilities_hh', internet: 'utilities_hh',
    food: 'groceries_hh', transport: 'transport_hh', shopping: 'clothing_hh',
    entertainment: 'entertainment_hh', health: 'health_hh',
    education: 'childcare', other: 'other_hh',
    debt_payment: 'debt_payment_hh'
  },
  freelancer: {
    salary: 'client_income', freelance: 'retainer',
    investment: 'client_income', gift: 'client_income', refund: 'client_income',
    rent: 'living_fl', utilities: 'living_fl', internet: 'software_fl',
    food: 'living_fl', transport: 'travel_fl', shopping: 'office_fl',
    entertainment: 'education_fl', health: 'insurance_fl',
    education: 'education_fl', other: 'other_fl',
    debt_payment: 'debt_payment_fl'
  },
  business: {
    salary: 'revenue', freelance: 'services',
    investment: 'interest', gift: 'other_biz_income', refund: 'other_biz_income',
    rent: 'office', utilities: 'office', internet: 'software',
    food: 'travel', transport: 'travel', shopping: 'cogs',
    entertainment: 'marketing', health: 'insurance_biz',
    education: 'professional', other: 'other_biz',
    debt_payment: 'debt_payment_biz'
  }
};

function getActiveRoleMap(): CategoryRoleMap {
  // Phase 6 Slice 1i (rev 12 L6): both index accesses are
  // `CategoryRoleMap | undefined` under `noUncheckedIndexedAccess`;
  // pull each into a local and fall through to the other before
  // surfacing the module-local `personal` map (known to be present
  // at module-eval — the PRESET_ROLE_MAPS literal above defines it).
  const presetId = userCategoryConfig.value?.presetId || 'personal';
  const byPreset = PRESET_ROLE_MAPS[presetId];
  if (byPreset) return byPreset;
  const personalMap = PRESET_ROLE_MAPS.personal;
  if (personalMap) return personalMap;
  // Defensive fallback — keeps the signature total even if the map
  // literal is ever trimmed in a test harness.
  return {
    salary: 'income', freelance: 'income', investment: 'income',
    gift: 'income', refund: 'income',
    rent: 'bills', utilities: 'bills', internet: 'bills',
    food: 'food', transport: 'transport', shopping: 'shopping',
    entertainment: 'entertainment', health: 'health',
    education: 'education', other: 'other', debt_payment: 'debt_payment'
  };
}

/**
 * Build a budget allocation object by resolving semantic roles to category IDs.
 * Merges amounts when multiple roles map to the same category (e.g., Freelancer
 * maps rent + utilities + food all to living_fl).
 */
function buildRolledAllocations(
  roles: CategoryRoleMap,
  entries: Array<[string, number]>
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [role, amount] of entries) {
    const catId = (roles as unknown as Record<string, string>)[role] || role;
    result[catId] = (result[catId] || 0) + amount;
  }
  return result;
}

// Deliberately English: this formatter generates demo transaction
// description strings like "Salary + December bonus". The surrounding
// prose is hardcoded English, so the month name must stay English too
// for the demo data to read coherently.
// eslint-disable-next-line no-restricted-syntax -- intentional English prose for demo data
const monthNameFormatter = new Intl.DateTimeFormat('en-US', { month: 'long' });

function seasonalMultiplier(month: number): number {
  if (month === 12) return 1.14;
  if (month === 11) return 1.08;
  if (month === 1) return 0.92;
  if (month === 2) return 0.95;
  if (month >= 6 && month <= 8) return 1.06;
  return 1.0;
}

function createSeededRandom(seed: number): () => number {
  let t = seed >>> 0;
  return (): number => {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function toMonthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function toDateString(year: number, monthIndex: number, day: number): string {
  return `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function shiftMonth(base: Date, offset: number): Date {
  return new Date(base.getFullYear(), base.getMonth() + offset, 1);
}

function addDaysSafe(base: Date, days: number): string {
  const next = new Date(base);
  next.setDate(next.getDate() + days);
  return toDateString(next.getFullYear(), next.getMonth(), next.getDate());
}

function buildMonthContext(baseDate: Date, monthsAgo: number): DemoMonthContext {
  const monthDate = shiftMonth(baseDate, -monthsAgo);
  const year = monthDate.getFullYear();
  const monthIndex = monthDate.getMonth();
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
  const isCurrentMonth =
    year === baseDate.getFullYear() &&
    monthIndex === baseDate.getMonth();

  return {
    monthKey: toMonthKey(monthDate),
    daysInMonth,
    visibleDays: isCurrentMonth ? baseDate.getDate() : daysInMonth,
    multiplier: seasonalMultiplier(monthIndex + 1)
  };
}

function makeDemoTags(...parts: string[]): string {
  return [...parts, DEMO_PROFILE_TAG].join(',');
}

function buildDemoTransaction(
  monthKey: string,
  day: number,
  idSuffix: string,
  config: Omit<DemoTransactionSeed, '__backendId' | 'date' | 'notes'>
): DemoTransactionSeed {
  return {
    ...config,
    __backendId: `${DEMO_PROFILE_ID_PREFIX}${monthKey}_${idSuffix}`,
    date: `${monthKey}-${String(day).padStart(2, '0')}`,
    notes: `${DEMO_PROFILE_NOTE_MARKER} ${config.description}`
  };
}

function addIfVisible(
  txs: DemoTransactionSeed[],
  context: DemoMonthContext,
  day: number,
  idSuffix: string,
  config: Omit<DemoTransactionSeed, '__backendId' | 'date' | 'notes'>
): void {
  if (day > context.visibleDays || day < 1 || day > context.daysInMonth) return;
  txs.push(buildDemoTransaction(context.monthKey, day, idSuffix, config));
}

function createMonthlyTransactions(baseDate: Date, roles: CategoryRoleMap): DemoTransactionSeed[] {
  const txs: DemoTransactionSeed[] = [];
  const seededRandom = createSeededRandom(20260320);

  for (let monthsAgo = 11; monthsAgo >= 0; monthsAgo--) {
    const context = buildMonthContext(baseDate, monthsAgo);
    const monthDate = shiftMonth(baseDate, -monthsAgo);
    const monthLabel = monthNameFormatter.format(monthDate);
    const salaryAmount = 4850 + (monthsAgo % 4 === 0 ? 250 : 0);

    addIfVisible(txs, context, 1, 'salary', {
      type: 'income',
      category: roles.salary,
      amount: salaryAmount,
      description: monthsAgo % 4 === 0 ? `Salary + ${monthLabel} bonus` : 'Salary deposit',
      tags: makeDemoTags('income', 'paycheck'),
      reconciled: true
    });

    if (monthsAgo % 3 === 1) {
      addIfVisible(txs, context, 18, 'freelance', {
        type: 'income',
        category: roles.freelance,
        amount: 640 + monthsAgo * 11,
        description: 'Client retainer payment',
        tags: makeDemoTags('income', 'side_hustle'),
        reconciled: false
      });
    }

    addIfVisible(txs, context, 1, 'rent', {
      type: 'expense',
      category: roles.rent,
      amount: 1450,
      description: 'Rent - Maple Apartments',
      tags: makeDemoTags('housing', 'fixed'),
      reconciled: true
    });

    addIfVisible(txs, context, 6, 'utilities', {
      type: 'expense',
      category: roles.utilities,
      amount: Math.round((155 + monthsAgo % 5 * 8) * context.multiplier * 100) / 100,
      description: 'Utilities bundle',
      tags: makeDemoTags('utilities', 'fixed'),
      reconciled: true
    });

    addIfVisible(txs, context, 10, 'internet', {
      type: 'expense',
      category: roles.internet,
      amount: 82,
      description: 'Internet bill',
      tags: makeDemoTags('utilities', 'recurring'),
      reconciled: true
    });

    const groceryDays = [4, 11, 18, 25];
    groceryDays.forEach((day, index) => {
      const amount = Math.round((92 + seededRandom() * 48 + index * 4) * context.multiplier * 100) / 100;
      addIfVisible(txs, context, day, `groceries_${index + 1}`, {
        type: 'expense',
        category: roles.food,
        amount,
        description: index % 2 === 0 ? 'Weekly groceries' : 'Costco grocery run',
        tags: makeDemoTags('groceries'),
        reconciled: index < 2
      });
    });

    const transportDays = [3, 14, 27];
    transportDays.forEach((day, index) => {
      const amount = Math.round((28 + seededRandom() * 34 + index * 3) * 100) / 100;
      addIfVisible(txs, context, day, `transport_${index + 1}`, {
        type: 'expense',
        category: roles.transport,
        amount,
        description: index === 1 ? 'Gas station' : 'Transit + rideshare',
        tags: makeDemoTags('transport'),
        reconciled: index !== 2
      });
    });

    addIfVisible(txs, context, 8, 'coffee', {
      type: 'expense',
      category: roles.food,
      amount: Math.round((9 + seededRandom() * 7) * 100) / 100,
      description: 'Coffee + breakfast',
      tags: makeDemoTags('food', 'small'),
      reconciled: false
    });

    addIfVisible(txs, context, 21, 'restaurant', {
      type: 'expense',
      category: roles.food,
      amount: Math.round((48 + seededRandom() * 26) * context.multiplier * 100) / 100,
      description: 'Dinner out',
      tags: makeDemoTags('food', 'lifestyle'),
      reconciled: false
    });

    if (monthsAgo % 2 === 0) {
      addIfVisible(txs, context, 16, 'shopping', {
        type: 'expense',
        category: roles.shopping,
        amount: Math.round((62 + seededRandom() * 95) * context.multiplier * 100) / 100,
        description: monthsAgo % 4 === 0 ? 'Home refresh order' : 'Target essentials',
        tags: makeDemoTags('shopping'),
        reconciled: false
      });
    }

    addIfVisible(txs, context, 23, 'entertainment', {
      type: 'expense',
      category: roles.entertainment,
      amount: Math.round((22 + seededRandom() * 38) * context.multiplier * 100) / 100,
      description: monthsAgo % 2 === 0 ? 'Streaming + movie night' : 'Concert tickets',
      tags: makeDemoTags('entertainment'),
      reconciled: false
    });

    if (monthsAgo % 3 === 0) {
      addIfVisible(txs, context, 12, 'health', {
        type: 'expense',
        category: roles.health,
        amount: Math.round((34 + seededRandom() * 46) * 100) / 100,
        description: 'Pharmacy + wellness',
        tags: makeDemoTags('health'),
        reconciled: true
      });
    }

    if (monthsAgo % 4 === 2) {
      addIfVisible(txs, context, 9, 'education', {
        type: 'expense',
        category: roles.education,
        amount: 39,
        description: 'Design course subscription',
        tags: makeDemoTags('education'),
        reconciled: true
      });
    }

    if (monthsAgo % 5 === 0) {
      addIfVisible(txs, context, 19, 'other', {
        type: 'expense',
        category: roles.other,
        amount: Math.round((18 + seededRandom() * 40) * 100) / 100,
        description: 'Household misc.',
        tags: makeDemoTags('other'),
        reconciled: false
      });
    }

    // --- Investment dividend (quarterly) ---
    if (monthsAgo % 3 === 0 && monthsAgo > 0) {
      addIfVisible(txs, context, 15, 'dividend', {
        type: 'income',
        category: roles.investment,
        amount: Math.round((85 + seededRandom() * 60) * 100) / 100,
        description: 'Vanguard ETF dividend',
        tags: makeDemoTags('investment', 'passive'),
        reconciled: true
      });
    }

    // --- Gift income (sporadic — birthday, holiday) ---
    if (monthsAgo === 6 || monthsAgo === 1) {
      const isHoliday = monthsAgo === 1;
      addIfVisible(txs, context, isHoliday ? 26 : 14, 'gift_income', {
        type: 'income',
        category: roles.gift,
        amount: isHoliday ? 200 : 75,
        description: isHoliday ? 'Holiday gift from family' : 'Birthday cash gift',
        tags: makeDemoTags('gift', 'personal'),
        reconciled: true
      });
    }

    // --- Refund (occasional) ---
    if (monthsAgo === 3 || monthsAgo === 8) {
      addIfVisible(txs, context, 22, 'refund', {
        type: 'income',
        category: roles.refund,
        amount: monthsAgo === 3 ? 47.99 : 129,
        description: monthsAgo === 3 ? 'Amazon return refund' : 'Insurance overpayment refund',
        tags: makeDemoTags('refund'),
        reconciled: true
      });
    }

    // --- Insurance (renters — every month, mapped to same cat as utilities) ---
    addIfVisible(txs, context, 5, 'insurance', {
      type: 'expense',
      category: roles.utilities,
      amount: 38,
      description: 'Renters insurance — Lemonade',
      tags: makeDemoTags('insurance', 'fixed', 'recurring'),
      reconciled: true
    });

    // --- Phone bill (every month, mapped to same cat as internet) ---
    addIfVisible(txs, context, 13, 'phone', {
      type: 'expense',
      category: roles.internet,
      amount: 55,
      description: 'Mint Mobile plan',
      tags: makeDemoTags('phone', 'fixed', 'recurring'),
      reconciled: true
    });

    // --- Subscriptions / software (every month) ---
    addIfVisible(txs, context, 7, 'subscriptions', {
      type: 'expense',
      category: roles.entertainment,
      amount: Math.round((14.99 + (monthsAgo % 3 === 0 ? 12.99 : 0)) * 100) / 100,
      description: monthsAgo % 3 === 0 ? 'Spotify + iCloud storage' : 'Spotify Premium',
      tags: makeDemoTags('subscription', 'digital', 'recurring'),
      reconciled: true
    });

    // --- Savings transfers (every month, earlier months only) ---
    if (monthsAgo >= 2) {
      addIfVisible(txs, context, 2, 'savings_emergency', {
        type: 'expense',
        category: roles.other,
        amount: 200,
        description: 'Transfer to Emergency Buffer',
        tags: makeDemoTags('savings', 'transfer'),
        reconciled: true
      });
    }
    if (monthsAgo >= 2 && monthsAgo <= 8) {
      addIfVisible(txs, context, 2, 'savings_japan', {
        type: 'expense',
        category: roles.other,
        amount: 250,
        description: 'Transfer to Japan Trip fund',
        tags: makeDemoTags('savings', 'transfer', 'japan'),
        reconciled: true
      });
    }

    // --- Small/micro transactions (coffee tips, parking) ---
    addIfVisible(txs, context, 15, 'micro_1', {
      type: 'expense',
      category: roles.food,
      amount: Math.round((2.5 + seededRandom() * 3.5) * 100) / 100,
      description: 'Vending machine / tip jar',
      tags: makeDemoTags('food', 'micro'),
      reconciled: false
    });

    // --- Split transaction example (one month) ---
    // Costco receipt split into food vs household items so the split
    // feature is showcased in the demo data. The `splits: true` flag
    // and `notes: 'Split from ...'` mirror what `dataSdk.splitTransaction`
    // produces, making these render identically to user-created splits.
    if (monthsAgo === 4) {
      const splitParentId = `${DEMO_PROFILE_ID_PREFIX}${context.monthKey}_costco_parent`;
      addIfVisible(txs, context, 22, 'costco_split_food', {
        type: 'expense',
        category: roles.food,
        amount: 94.37,
        description: 'Split: Costco — groceries & fresh produce',
        tags: makeDemoTags('groceries', 'split'),
        reconciled: true
      });
      // Override notes + splits flag on the just-pushed transaction
      const foodSplit = txs[txs.length - 1];
      if (foodSplit && foodSplit.description.startsWith('Split:')) {
        foodSplit.notes = `Split from ${splitParentId}`;
        (foodSplit as DemoTransactionSeed & { splits?: boolean }).splits = true;
      }

      addIfVisible(txs, context, 22, 'costco_split_household', {
        type: 'expense',
        category: roles.other,
        amount: 67.52,
        description: 'Split: Costco — household supplies & cleaning',
        tags: makeDemoTags('household', 'split'),
        reconciled: true
      });
      const householdSplit = txs[txs.length - 1];
      if (householdSplit && householdSplit.description.startsWith('Split:')) {
        householdSplit.notes = `Split from ${splitParentId}`;
        (householdSplit as DemoTransactionSeed & { splits?: boolean }).splits = true;
      }
    }

    // --- Large one-off purchases (sporadic) ---
    if (monthsAgo === 5) {
      addIfVisible(txs, context, 20, 'big_purchase', {
        type: 'expense',
        category: roles.shopping,
        amount: 849.99,
        description: 'Refurbished MacBook Air — Facebook Marketplace',
        tags: makeDemoTags('shopping', 'electronics', 'one-time'),
        reconciled: true
      });
    }
    if (monthsAgo === 2) {
      addIfVisible(txs, context, 10, 'big_purchase_2', {
        type: 'expense',
        category: roles.other,
        amount: 2450,
        description: 'Emergency car repair — transmission service at Pep Boys',
        tags: makeDemoTags('car', 'emergency', 'one-time'),
        reconciled: true
      });
    }

    // --- Debt payment logged as expense (every month for Chase Visa) ---
    if (monthsAgo > 0 && monthsAgo <= 10) {
      addIfVisible(txs, context, 18, 'debt_payment', {
        type: 'expense',
        category: roles.debt_payment,
        amount: 220,
        description: 'Chase Visa payment',
        tags: makeDemoTags('debt', 'credit-card', 'fixed'),
        reconciled: true
      });
    }

    // --- End-of-month and gap-day transactions ---
    // Fill calendar days 17, 24, 29, 30 so spending pace and calendar
    // view reflect realistic full-month activity.
    addIfVisible(txs, context, 17, 'lunch_out', {
      type: 'expense',
      category: roles.food,
      amount: Math.round((12 + seededRandom() * 14) * 100) / 100,
      description: 'Lunch — deli sandwich + drink',
      tags: makeDemoTags('food', 'lunch'),
      reconciled: false
    });

    addIfVisible(txs, context, 24, 'parking', {
      type: 'expense',
      category: roles.transport,
      amount: Math.round((8 + seededRandom() * 12) * 100) / 100,
      description: monthsAgo % 2 === 0 ? 'Downtown parking meter' : 'Airport parking garage',
      tags: makeDemoTags('transport', 'parking'),
      reconciled: false
    });

    addIfVisible(txs, context, 29, 'end_month_groceries', {
      type: 'expense',
      category: roles.food,
      amount: Math.round((38 + seededRandom() * 42) * context.multiplier * 100) / 100,
      description: 'End-of-month grocery restock',
      tags: makeDemoTags('groceries', 'food'),
      reconciled: false
    });

    if (context.daysInMonth >= 30) {
      addIfVisible(txs, context, 30, 'end_month_fuel', {
        type: 'expense',
        category: roles.transport,
        amount: Math.round((35 + seededRandom() * 20) * 100) / 100,
        description: 'Gas station fill-up',
        tags: makeDemoTags('transport', 'fuel'),
        reconciled: false
      });
    }

    if (context.daysInMonth === 31) {
      addIfVisible(txs, context, 31, 'end_month_misc', {
        type: 'expense',
        category: roles.other,
        amount: Math.round((5 + seededRandom() * 18) * 100) / 100,
        description: 'Household supplies',
        tags: makeDemoTags('other', 'household'),
        reconciled: false
      });
    }
  }

  return txs.sort((left, right) => left.date.localeCompare(right.date));
}

/**
 * Build budget allocations for all 12 months of demo history.
 * Base amounts drift gradually forward (small raises in rent, lifestyle
 * creep in food/entertainment) so the Budget tab's month-over-month
 * comparison and variance analysis have realistic data to work with.
 */
function buildMonthlyAllocations(
  baseDate: Date,
  roles: CategoryRoleMap
): Record<string, MonthlyAllocation> {
  // Baseline amounts (oldest month). Each tuple: [role, startAmount, monthlyDrift].
  // Drift is added cumulatively so month 0 = start, month 11 = start + 11*drift.
  const lines: Array<[string, number, number]> = [
    ['rent',          1400,   8],   // 1400 → 1488
    ['utilities',     235,    2],   // 235 → 257
    ['internet',      78,     0.6], // 78 → ~85
    ['food',          580,    9],   // 580 → 679
    ['transport',     220,    3],   // 220 → 253
    ['shopping',      155,    3],   // 155 → 188
    ['entertainment', 135,    3.6], // 135 → 175
    ['health',        130,    2.5], // 130 → 158
    ['education',     45,     1.4], // 45 → 60
    ['other',         700,    5.5], // 700 → 761
    ['debt_payment',  260,    8],   // 260 → 348
  ];

  const alloc: Record<string, MonthlyAllocation> = {};
  for (let monthsAgo = 11; monthsAgo >= 0; monthsAgo--) {
    const mk = toMonthKey(shiftMonth(baseDate, -monthsAgo));
    const age = 11 - monthsAgo; // 0 = oldest, 11 = current
    const entries: Array<[string, number]> = lines.map(
      ([role, start, drift]) => [role, Math.round(start + age * drift)]
    );
    alloc[mk] = buildRolledAllocations(roles, entries);
  }
  return alloc;
}

export function buildDemoProfile(baseDate: Date = new Date()): DemoProfileSeed {
  const roles = getActiveRoleMap();
  const nextMonth = shiftMonth(baseDate, 1);
  const nextMonthStart = toDateString(nextMonth.getFullYear(), nextMonth.getMonth(), 2);
  const nextMonthTenth = toDateString(nextMonth.getFullYear(), nextMonth.getMonth(), 10);
  const oneYearOut = toDateString(baseDate.getFullYear() + 1, baseDate.getMonth(), Math.min(baseDate.getDate(), 28));

  return {
    transactions: createMonthlyTransactions(baseDate, roles),
    monthlyAllocations: buildMonthlyAllocations(baseDate, roles),
    savingsGoals: [
      {
        key: 'emergency_buffer',
        name: 'Emergency Buffer',
        target: 6000,
        saved: 600,
        deadline: addDaysSafe(baseDate, 210),
        contributions: [
          { amount: 200, date: toDateString(shiftMonth(baseDate, -10).getFullYear(), shiftMonth(baseDate, -10).getMonth(), 2) },
          { amount: 200, date: toDateString(shiftMonth(baseDate, -8).getFullYear(), shiftMonth(baseDate, -8).getMonth(), 2) },
          { amount: 200, date: toDateString(shiftMonth(baseDate, -6).getFullYear(), shiftMonth(baseDate, -6).getMonth(), 2) },
          { amount: 200, date: toDateString(shiftMonth(baseDate, -4).getFullYear(), shiftMonth(baseDate, -4).getMonth(), 2) },
          { amount: 200, date: toDateString(shiftMonth(baseDate, -2).getFullYear(), shiftMonth(baseDate, -2).getMonth(), 2) }
        ]
      },
      {
        key: 'japan_trip',
        name: 'Japan Trip',
        target: 3200,
        saved: 150,
        deadline: addDaysSafe(baseDate, 160),
        contributions: [
          { amount: 250, date: toDateString(shiftMonth(baseDate, -7).getFullYear(), shiftMonth(baseDate, -7).getMonth(), 2) },
          { amount: 250, date: toDateString(shiftMonth(baseDate, -5).getFullYear(), shiftMonth(baseDate, -5).getMonth(), 2) },
          { amount: 250, date: toDateString(shiftMonth(baseDate, -3).getFullYear(), shiftMonth(baseDate, -3).getMonth(), 2) }
        ]
      }
    ],
    debts: [
      {
        name: 'Chase Visa',
        type: 'credit_card',
        balance: 3083.29,
        originalBalance: 5000,
        interestRate: 0.1999,
        minimumPayment: 150,
        dueDay: 18,
        payments: [
          { amount: 220, date: toDateString(shiftMonth(baseDate, -9).getFullYear(), shiftMonth(baseDate, -9).getMonth(), 18) },
          { amount: 220, date: toDateString(shiftMonth(baseDate, -7).getFullYear(), shiftMonth(baseDate, -7).getMonth(), 18) },
          { amount: 220, date: toDateString(shiftMonth(baseDate, -5).getFullYear(), shiftMonth(baseDate, -5).getMonth(), 18) },
          { amount: 220, date: toDateString(shiftMonth(baseDate, -3).getFullYear(), shiftMonth(baseDate, -3).getMonth(), 18) },
          { amount: 220, date: toDateString(shiftMonth(baseDate, -1).getFullYear(), shiftMonth(baseDate, -1).getMonth(), 18) }
        ]
      },
      {
        name: 'Auto Loan',
        type: 'auto',
        balance: 8420,
        originalBalance: 12000,
        interestRate: 0.064,
        minimumPayment: 285,
        dueDay: 12,
        payments: [
          { amount: 285, date: toDateString(shiftMonth(baseDate, -8).getFullYear(), shiftMonth(baseDate, -8).getMonth(), 12) },
          { amount: 285, date: toDateString(shiftMonth(baseDate, -6).getFullYear(), shiftMonth(baseDate, -6).getMonth(), 12) },
          { amount: 285, date: toDateString(shiftMonth(baseDate, -4).getFullYear(), shiftMonth(baseDate, -4).getMonth(), 12) },
          { amount: 285, date: toDateString(shiftMonth(baseDate, -2).getFullYear(), shiftMonth(baseDate, -2).getMonth(), 12) }
        ]
      }
    ],
    txTemplates: [
      {
        id: 'demo_template_weekly_groceries',
        name: 'Weekly Grocery Run',
        type: 'expense',
        category: roles.food,
        amount: 128,
        description: 'Weekly groceries',
        tags: 'groceries,home'
      },
      {
        id: 'demo_template_client_invoice',
        name: 'Client Invoice',
        type: 'income',
        category: roles.freelance,
        amount: 750,
        description: 'Client invoice payment',
        tags: 'work,income'
      }
    ],
    recurringTemplates: [
      {
        type: 'expense',
        category: roles.internet,
        amount: 82,
        description: 'Internet Bill',
        tags: makeDemoTags('utilities', 'recurring'),
        notes: `${DEMO_PROFILE_NOTE_MARKER} Internet Bill recurring template`,
        startDate: nextMonthTenth,
        endDate: oneYearOut,
        recurringType: 'monthly',
        originalDayOfMonth: 10
      },
      {
        type: 'expense',
        category: roles.health,
        amount: 48,
        description: 'Gym Membership',
        tags: makeDemoTags('health', 'recurring'),
        notes: `${DEMO_PROFILE_NOTE_MARKER} Gym Membership recurring template`,
        startDate: nextMonthStart,
        endDate: oneYearOut,
        recurringType: 'monthly',
        originalDayOfMonth: 2
      },
      {
        type: 'expense',
        category: roles.rent,
        amount: 1450,
        description: 'Rent - Maple Apartments',
        tags: makeDemoTags('housing', 'fixed', 'recurring'),
        notes: `${DEMO_PROFILE_NOTE_MARKER} Rent recurring template`,
        startDate: nextMonthStart,
        endDate: oneYearOut,
        recurringType: 'monthly',
        originalDayOfMonth: 1
      },
      {
        type: 'expense',
        category: roles.internet,
        amount: 55,
        description: 'Mint Mobile Plan',
        tags: makeDemoTags('phone', 'fixed', 'recurring'),
        notes: `${DEMO_PROFILE_NOTE_MARKER} Mint Mobile recurring template`,
        startDate: nextMonthStart,
        endDate: oneYearOut,
        recurringType: 'monthly',
        originalDayOfMonth: 13
      },
      {
        type: 'expense',
        category: roles.utilities,
        amount: 38,
        description: 'Renters Insurance — Lemonade',
        tags: makeDemoTags('insurance', 'fixed', 'recurring'),
        notes: `${DEMO_PROFILE_NOTE_MARKER} Renters Insurance recurring template`,
        startDate: nextMonthStart,
        endDate: oneYearOut,
        recurringType: 'monthly',
        originalDayOfMonth: 5
      },
      {
        type: 'expense',
        category: roles.entertainment,
        amount: 14.99,
        description: 'Spotify Premium',
        tags: makeDemoTags('subscription', 'digital', 'recurring'),
        notes: `${DEMO_PROFILE_NOTE_MARKER} Spotify recurring template`,
        startDate: nextMonthStart,
        endDate: oneYearOut,
        recurringType: 'monthly',
        originalDayOfMonth: 7
      }
    ],
    rolloverSettings: {
      enabled: true,
      mode: 'all',
      categories: [],
      maxRollover: 500,
      negativeHandling: 'carry'
    }
  };
}

function hasExistingDemoProfile(): boolean {
  return signals.transactions.value.some((tx: Transaction) =>
    tx.__backendId.startsWith(DEMO_PROFILE_ID_PREFIX) ||
    tx.tags?.includes(DEMO_PROFILE_TAG) ||
    tx.notes?.includes(DEMO_PROFILE_NOTE_MARKER)
  );
}

function mergeMonthlyAllocations(
  existing: Record<string, MonthlyAllocation>,
  next: Record<string, MonthlyAllocation>
): Record<string, MonthlyAllocation> {
  const merged: Record<string, MonthlyAllocation> = { ...existing };

  Object.entries(next).forEach(([monthKey, allocation]) => {
    merged[monthKey] = {
      ...allocation,
      ...(merged[monthKey] || {})
    };
  });

  return merged;
}

function mergeTemplates(existing: TxTemplate[], incoming: TxTemplate[]): TxTemplate[] {
  const byId = new Map<string, TxTemplate>();
  incoming.forEach((template: TxTemplate) => byId.set(template.id, template));
  existing.forEach((template: TxTemplate) => byId.set(template.id, template));
  return Array.from(byId.values());
}

/**
 * M26 (rev 12): each seeder now catches per-iteration failures into the
 * structured `DemoSeedResult.failed[]` rather than throwing past the loop.
 * Result: one bad row no longer prevents later rows from being attempted,
 * and `loadSampleData` can honestly report `"2 of 3 goals created"` plus
 * the reasons for the failure(s). Sync calls (`addGoal`, `addDebt`) are
 * still wrapped in the same try/catch so a thrown error during the
 * synchronous call layer is captured identically.
 */
async function seedSavingsGoals(
  goals: DemoSavingsGoalSeed[],
  log: DemoLoadResourceLog
): Promise<DemoSeedResult> {
  const existingNames = new Set(
    Object.values(signals.savingsGoals.value).map((goal: SavingsGoal) => goal.name)
  );

  let created = 0;
  const failed: DemoSeedFailure[] = [];

  for (const goal of goals) {
    if (existingNames.has(goal.name)) continue;
    try {
      const goalId = savingsGoalsActions.addGoal(goal);
      // CR-Apr22-F slice 4: append to the rollback log immediately after
      // the synchronous `addGoal` — if the subsequent `addContribution`
      // throws, the partially-seeded goal (goal without contribution)
      // still needs to be rolled back on catch-block unwind.
      log.goalIds.push(goalId);
      // Seed backdated contribution history when provided
      if (goal.contributions && goal.contributions.length > 0) {
        for (const contrib of goal.contributions) {
          await savingsGoalsActions.addContribution(goalId, contrib.amount, contrib.date);
        }
      } else if (goal.contributionAmount && goal.contributionAmount > 0) {
        await savingsGoalsActions.addContribution(goalId, goal.contributionAmount);
      }
      created++;
      existingNames.add(goal.name);
    } catch (err) {
      failed.push({
        name: goal.name,
        reason: err instanceof Error ? err.message : String(err)
      });
    }
  }

  return { created, failed };
}

async function seedDebts(
  debts: DemoDebtSeed[],
  log: DemoLoadResourceLog
): Promise<DemoSeedResult> {
  const existingNames = new Set(signals.debts.value.map((debt: Debt) => debt.name));
  let created = 0;
  const failed: DemoSeedFailure[] = [];

  for (const debt of debts) {
    if (existingNames.has(debt.name)) continue;
    try {
      const createdDebt = addDebt(debt);
      // CR-Apr22-F slice 4: same rationale as seedSavingsGoals — track
      // the debt id immediately so rollback can reach a soft-seeded debt
      // whose initial payment subsequently failed.
      log.debtIds.push(createdDebt.id);
      // Seed backdated payment history when provided
      if (debt.payments && debt.payments.length > 0) {
        for (const payment of debt.payments) {
          await recordPayment(createdDebt.id, payment.amount, payment.date);
        }
      } else if (debt.samplePaymentAmount && debt.samplePaymentAmount > 0) {
        await recordPayment(createdDebt.id, debt.samplePaymentAmount);
      }
      created++;
      existingNames.add(debt.name);
    } catch (err) {
      failed.push({
        name: debt.name,
        reason: err instanceof Error ? err.message : String(err)
      });
    }
  }

  return { created, failed };
}

async function seedRecurringTemplates(
  templates: Array<Omit<RecurringTemplate, 'id' | 'lastGeneratedDate' | 'active'>>,
  log: DemoLoadResourceLog
): Promise<DemoSeedResult> {
  // CR-Apr22-F slice 4 (Finding 10 P2): dedup used to check
  // `signals.transactions.value` for a row with matching description +
  // DEMO_PROFILE_NOTE_MARKER. But after a prior partial-failure whose
  // transaction rollback cleared the spawned occurrence, the template
  // row in `SK.RECURRING` survived — so the dedup check missed on
  // retry and created a duplicate template. Keying dedup off the
  // template store directly matches the same shape used by
  // `seedSavingsGoals` / `seedDebts` (dedup-by-name against the owning
  // store) and closes the retry-after-rollback gap.
  const existingDescriptions = new Set(
    getRecurringTemplates().map((t: RecurringTemplate) => t.description)
  );

  let created = 0;
  const failed: DemoSeedFailure[] = [];

  for (const template of templates) {
    if (existingDescriptions.has(template.description)) continue;
    try {
      const id = await createRecurringTemplate(template);
      log.recurringIds.push(id);
      existingDescriptions.add(template.description);
      created++;
    } catch (err) {
      failed.push({
        name: template.description,
        reason: err instanceof Error ? err.message : String(err)
      });
    }
  }

  return { created, failed };
}

// ==========================================================================
// M26 (rev 12): rollback + reporting helpers
// ==========================================================================

/**
 * Remove demo transactions from the data layer so a subsequent
 * `loadSampleData` invocation is not vetoed by `hasExistingDemoProfile()`.
 * Used on the unexpected-exception rollback path in `loadSampleData`.
 *
 * Idempotent per transaction — a failed `dataSdk.delete` (e.g. tx already
 * removed, storage transient) increments `failed` and the loop continues.
 * Sequential to keep the IDB contention surface predictable; demo profiles
 * carry ~80-100 transactions so O(n) persist rewrites cost milliseconds.
 *
 * Exported for testability.
 */
export async function rollbackDemoTransactions(
  transactions: Transaction[]
): Promise<{ removed: number; failed: number }> {
  let removed = 0;
  let failed = 0;

  for (const tx of transactions) {
    try {
      const result = await dataSdk.delete(tx);
      if (result.isOk) {
        removed++;
      } else {
        failed++;
      }
    } catch {
      failed++;
    }
  }

  return { removed, failed };
}

/**
 * CR-Apr22-F slice 4 (Finding 9 P2): composite rollback of the full demo
 * seed surface — not just transactions. The earlier `rollbackDemoTransactions`
 * helper covered only the initial `createBatch` payload, leaving
 * allocations / tx-templates / goals / debts / recurring templates (and
 * their spawned txs) in place after an unexpected top-level failure. The
 * user saw a "rolled back" toast while the account remained partially
 * seeded.
 *
 * Ordering rationale:
 *   1. Recurring first — `deleteRecurringTemplate(id, true)` removes each
 *      template AND cascades the per-template occurrence transactions
 *      (via `recurringTemplateId` match). Running this before the
 *      transaction cleanup ensures those occurrence rows don't leak into
 *      `signals.transactions` when the caller later snapshots.
 *   2. Debts — for each tracked debt id, delete any transaction whose
 *      `debtId` matches (payment ledger rows created by `recordPayment`),
 *      then `removeDebt(id)`.
 *   3. Goals — for each tracked goal id, delete any transaction whose
 *      `notes` contain the goal's `[id:goalId]` marker + the savings-
 *      transfer marker (from `addContribution`), then
 *      `savingsGoalsActions.deleteGoal(id)` which clears contribution
 *      entries in `signals.savingsContribs`.
 *   4. Restore allocation + tx-template snapshots — both were merged
 *      existing-wins, so restoring to the entry snapshot cleanly removes
 *      the demo's contribution without clobbering pre-existing state.
 *   5. Finally, delete the initial `createBatch` transaction payload via
 *      `rollbackDemoTransactions` — it stays idempotent per row so any
 *      already-deleted demo occurrence (e.g., one removed in step 1's
 *      recurring cascade) simply fails the `isOk:false` path and is
 *      counted toward `failed` without aborting.
 *
 * All steps are best-effort: one failing delete doesn't abort the
 * subsequent cleanup. Rollback runs in the user-visible failure path,
 * so an exception bubbling out would produce a worse UX than a
 * partial-rollback toast.
 *
 * Exported for testability.
 */
export async function rollbackDemoSeed(params: {
  log: DemoLoadResourceLog;
  createdTransactions: Transaction[];
  allocationsSnapshot: Record<string, MonthlyAllocation>;
  txTemplatesSnapshot: TxTemplate[];
}): Promise<{
  txRemoved: number;
  txFailed: number;
  entitiesRemoved: number;
  entitiesFailed: number;
}> {
  const { log, createdTransactions, allocationsSnapshot, txTemplatesSnapshot } = params;
  let entitiesRemoved = 0;
  let entitiesFailed = 0;

  // 1. Recurring templates — remove template + cascade spawned occurrences.
  // CR-Apr24-B [P2] finding 41: `deleteRecurringTemplate` now returns a
  // structured result; read `.ok` instead of treating the return as a
  // boolean. A partial-failure result (some linked transactions failed
  // to delete) counts as a failure here so the rollback log accurately
  // reflects which entities were left in place for retry.
  for (const id of log.recurringIds) {
    try {
      const result = await deleteRecurringTemplate(id, true);
      if (result.ok) entitiesRemoved++;
      else entitiesFailed++;
    } catch {
      entitiesFailed++;
    }
  }

  // 2. Debts — delete payment transactions, then the debt record
  for (const id of log.debtIds) {
    try {
      const paymentTxs = signals.transactions.value.filter(
        (tx: Transaction) => tx.debtId === id
      );
      for (const tx of paymentTxs) {
        try {
          await dataSdk.delete(tx);
        } catch {
          // best-effort: count downstream via entitiesFailed only if
          // the debt itself couldn't be removed — orphaned payment txs
          // after a best-effort attempt are not worse than the partial
          // seed that we're trying to undo.
        }
      }
      if (removeDebt(id)) entitiesRemoved++;
      else entitiesFailed++;
    } catch {
      entitiesFailed++;
    }
  }

  // 3. Savings goals — delete contribution transactions, then the goal
  for (const id of log.goalIds) {
    try {
      const idMarker = `[id:${id}]`;
      const contributionTxs = signals.transactions.value.filter(
        (tx: Transaction) =>
          tx.notes?.includes(idMarker) && tx.notes?.includes(SAVINGS_TRANSFER_NOTE_MARKER)
      );
      for (const tx of contributionTxs) {
        try {
          await dataSdk.delete(tx);
        } catch {
          // same rationale as debts — orphaned contribution txs after
          // a best-effort attempt are preferable to an aborted rollback
        }
      }
      if (savingsGoalsActions.deleteGoal(id)) entitiesRemoved++;
      else entitiesFailed++;
    } catch {
      entitiesFailed++;
    }
  }

  // 4. Restore allocation + tx-template snapshots. Both were merged
  // existing-wins on entry, so restoring the entry snapshot cleanly
  // removes the demo's contribution to those two stores.
  try {
    dataActions.setTxTemplates([...txTemplatesSnapshot]);
    persist(SK.TX_TEMPLATES, signals.txTemplates.value);
  } catch {
    entitiesFailed++;
  }
  try {
    dataActions.setMonthlyAllocations({ ...allocationsSnapshot });
    persist(SK.ALLOC, signals.monthlyAlloc.value);
  } catch {
    entitiesFailed++;
  }

  // 5. Delete the initial batch-created transactions. Idempotent per
  // row — if the recurring cascade in step 1 already removed one of
  // these (unlikely but possible when the tx shape overlaps), the
  // `isOk:false` path counts it as `failed` without aborting.
  const txRollback = await rollbackDemoTransactions(createdTransactions);

  return {
    txRemoved: txRollback.removed,
    txFailed: txRollback.failed,
    entitiesRemoved,
    entitiesFailed
  };
}

/**
 * Surface partial-failure in the demo seed phase via a warning toast + a
 * structured `trackError` for production telemetry. Mirrors M12's
 * `reportImportValidationRejections` — a purpose-built helper that owns
 * the toast wording, preview/reason caps, and telemetry action taxonomy so
 * `loadSampleData` stays focused on orchestration.
 *
 * - Toast wording: `"Demo loaded with N issue(s) skipped. First: goal — reason; debt — reason..."`
 *   (3-row preview cap, plural/singular-aware, `+X more` suffix when >3).
 * - `trackError` action is `demo_load_partial_failure` so dashboards can
 *   filter this specific path. Sample-reason cap at 10 preserves M28
 *   fingerprinting discipline (same dominant reason → dedup by fingerprint;
 *   different reason → new fingerprint).
 * - No-op when `summary` contains zero failures, so every successful call
 *   path can invoke it unconditionally without UX noise.
 *
 * Exported for testability.
 */
export function reportDemoLoadPartialFailure(summary: DemoLoadSummary): void {
  const allFailures: DemoSeedFailure[] = [
    ...summary.goals.failed,
    ...summary.debts.failed,
    ...summary.recurring.failed
  ];
  if (allFailures.length === 0) return;

  const totalFailed = allFailures.length;
  const plural = totalFailed === 1 ? '' : 's';
  const preview = allFailures
    .slice(0, 3)
    .map((f) => `${f.name} — ${f.reason}`)
    .join('; ');
  const more = totalFailed > 3 ? ` (+${totalFailed - 3} more)` : '';

  emit(Events.SHOW_TOAST, {
    message:
      `Demo loaded with ${totalFailed} issue${plural} skipped. ` +
      `First: ${preview}${more}`,
    type: 'warning'
  });

  // Production telemetry — sample-reason cap at 10 keeps the fingerprint
  // meaningful per M28 (same dominant reason → dedup; different reason → new
  // fingerprint). Counts break down per-seeder to speed root-cause triage.
  const sampleReasons = allFailures.slice(0, 10).map((f) => f.reason).join(' | ');
  trackError(
    new Error(
      `Demo load partial failure: ` +
        `${summary.goals.failed.length}g + ${summary.debts.failed.length}d + ` +
        `${summary.recurring.failed.length}r failed of ${summary.transactionCount} txns seeded` +
        (sampleReasons ? ` (sample: ${sampleReasons})` : '')
    ),
    {
      module: 'SampleData',
      action: 'demo_load_partial_failure'
    }
  );
}

/**
 * Load a deterministic demo account with transactions and planning state.
 */
export async function loadSampleData(): Promise<boolean> {
  if (hasExistingDemoProfile()) {
    emit(Events.SHOW_TOAST, { message: 'Demo account already loaded', type: 'info' });
    return false;
  }

  const confirmed = await asyncConfirm({
    title: 'Load Demo Account',
    message: 'Load demo data into this device?',
    details: 'This adds a deterministic demo account with transactions, budget allocations, savings goals, debts, and recurring activity. It will not overwrite your existing data.',
    type: 'warning',
    confirmText: 'Load Demo',
    cancelText: 'Cancel'
  });
  if (!confirmed) return false;

  const profile = buildDemoProfile(new Date());
  const currencyCode = signals.currency.value?.home || 'USD';

  const txResult = await dataSdk.createBatch(
    profile.transactions.map((transaction: DemoTransactionSeed) => ({
      ...transaction,
      currency: currencyCode,
      recurring: false
    }))
  );

  if (!txResult.isOk) {
    emit(Events.SHOW_TOAST, { message: 'Couldn\u2019t load demo data \u2014 your storage may be full. Try clearing old data in Settings.', type: 'error' });
    return false;
  }

  // M26 (rev 12): Transactions landed — capture for the rollback path below.
  // `data` is the Transaction[] with hydrated `__backendId`s, which is exactly
  // what `dataSdk.delete` needs to unwind them if a later step throws.
  // `OperationResult.data` is optional (see `js/types/index.ts:716`); the ok
  // branch of `createBatch` always populates it, but `?? []` keeps the type
  // narrowing honest and makes rollback a no-op on the (currently unreachable)
  // defensive path.
  const createdTransactions: Transaction[] = txResult.data ?? [];

  // CR-Apr22-F slice 4: snapshot the two merge targets BEFORE the
  // merge calls so rollback can restore them wholesale. Both signals
  // use existing-wins semantics on merge conflict, so the entry
  // snapshot captures exactly the state to restore on failure.
  // Shallow clones are sufficient: neither the inner MonthlyAllocation
  // objects nor the TxTemplate rows are mutated in place elsewhere —
  // signals replace their values on write.
  const allocationsSnapshot: Record<string, MonthlyAllocation> = { ...signals.monthlyAlloc.value };
  const txTemplatesSnapshot: TxTemplate[] = [...signals.txTemplates.value];

  // CR-Apr22-F slice 4: track ids we create on THIS run so rollback
  // touches only what we added — prior-partial-success state from an
  // earlier run that the current seeders skip-deduped is preserved.
  const resourceLog: DemoLoadResourceLog = createEmptyResourceLog();

  try {
    const mergedAllocations = mergeMonthlyAllocations(signals.monthlyAlloc.value, profile.monthlyAllocations);
    dataActions.setMonthlyAllocations(mergedAllocations);
    persist(SK.ALLOC, signals.monthlyAlloc.value);
    dataActions.setTxTemplates(mergeTemplates(signals.txTemplates.value, profile.txTemplates));
    persist(SK.TX_TEMPLATES, signals.txTemplates.value);

    // Enable rollover if the profile includes settings and the user hasn't
    // already configured rollover (respect existing user preference).
    if (profile.rolloverSettings && !signals.rolloverSettings.value.enabled) {
      signals.rolloverSettings.value = profile.rolloverSettings;
      persist(SK.ROLLOVER_SETTINGS, signals.rolloverSettings.value);
    }

    // M26 (rev 12): sequentialize the three seeders (was `Promise.all` which
    // (a) ran them in parallel so a failure in seeder #1 did not short-circuit
    // writes from seeders #2/#3 already in flight, and (b) rejected on first
    // failure without reporting which seeder or row failed. Each seeder now
    // captures per-iteration failures structurally into `DemoSeedResult` so
    // the top-level try/catch here is reserved for truly unexpected throws
    // (persist call rejection, invalidate call throw, etc.).
    const goals = await seedSavingsGoals(profile.savingsGoals, resourceLog);
    const debts = await seedDebts(profile.debts, resourceLog);
    const recurring = await seedRecurringTemplates(profile.recurringTemplates, resourceLog);

    invalidateMonthlyTotalsCache();
    invalidateRolloverCache();
    emit(Events.DATA_IMPORTED);

    const summary: DemoLoadSummary = {
      transactionCount: profile.transactions.length,
      goals,
      debts,
      recurring
    };

    // M26 (rev 12): honest reporting — when seeders captured any failures,
    // surface an aggregate warning toast + telemetry + a counts-visible
    // success message (so the user sees "loaded 2 of 3 goals" not silent
    // partial success). Zero-failure path still emits the clean success
    // toast matching the pre-M26 wording.
    reportDemoLoadPartialFailure(summary);

    const anyFailed = goals.failed.length + debts.failed.length + recurring.failed.length > 0;
    if (anyFailed) {
      emit(Events.SHOW_TOAST, {
        message:
          `Loaded demo account: ${profile.transactions.length} transactions, ` +
          `${goals.created} of ${goals.created + goals.failed.length} goals, ` +
          `${debts.created} of ${debts.created + debts.failed.length} debts, ` +
          `${recurring.created} of ${recurring.created + recurring.failed.length} recurring series.`,
        type: 'info'
      });
    } else {
      emit(Events.SHOW_TOAST, {
        message: `Loaded demo account: ${profile.transactions.length} transactions, ${goals.created} goals, ${debts.created} debts, ${recurring.created} recurring series.`,
        type: 'success'
      });
    }
    return true;
  } catch (err) {
    // M26 (rev 12) + CR-Apr22-F slice 4: unexpected top-level failure
    // (persist / invalidate / unexpected rejection from the action
    // layer). The structured seeders already capture their own per-row
    // failures; reaching here means something outside the seeder loops
    // threw. Roll back the ENTIRE demo seed — transactions, recurring
    // templates, debts, goals, allocations, and tx-templates — so
    // `hasExistingDemoProfile()` stops vetoing retries AND the store
    // doesn't retain partially-seeded demo state that the previous
    // tx-only rollback left behind.
    trackError(
      err instanceof Error ? err : new Error(String(err)),
      { module: 'SampleData', action: 'demo_load_unexpected_failure' }
    );
    const rollback = await rollbackDemoSeed({
      log: resourceLog,
      createdTransactions,
      allocationsSnapshot,
      txTemplatesSnapshot
    });
    const txPlural = rollback.txRemoved === 1 ? '' : 's';
    const entityNote = rollback.entitiesRemoved > 0
      ? ` and ${rollback.entitiesRemoved} related record${rollback.entitiesRemoved === 1 ? '' : 's'}`
      : '';
    const failNotes: string[] = [];
    if (rollback.txFailed > 0) {
      failNotes.push(`${rollback.txFailed} transaction${rollback.txFailed === 1 ? '' : 's'} could not be removed`);
    }
    if (rollback.entitiesFailed > 0) {
      failNotes.push(`${rollback.entitiesFailed} record${rollback.entitiesFailed === 1 ? '' : 's'} could not be removed`);
    }
    const failSuffix = failNotes.length > 0 ? ` (${failNotes.join('; ')})` : '';
    emit(Events.SHOW_TOAST, {
      message:
        `Couldn\u2019t finish loading demo data. ` +
        `Rolled back ${rollback.txRemoved} transaction${txPlural}${entityNote}${failSuffix}. ` +
        `Please try again.`,
      type: 'error'
    });
    return false;
  }
}
