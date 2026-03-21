/**
 * Sample Data Module
 * Builds a deterministic demo account with transactions and planning state.
 *
 * @module sample-data
 */
'use strict';

import * as signals from '../core/signals.js';
import { data as dataActions, savingsGoals as savingsGoalsActions } from '../core/state-actions.js';
import { dataSdk } from '../data/data-manager.js';
import { emit, Events } from '../core/event-bus.js';
import { showToast } from '../ui/core/ui.js';
import { asyncConfirm } from '../ui/components/async-modal.js';
import { addDebt, recordPayment } from '../features/financial/debt-planner.js';
import { createRecurringTemplate, type RecurringTemplate } from '../data/recurring-templates.js';
import { invalidateMonthlyTotalsCache, invalidateRolloverCache } from '../features/financial/calculations.js';
import type {
  Debt,
  MonthlyAllocation,
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

interface DemoSavingsGoalSeed {
  key: string;
  name: string;
  target_amount: number;
  saved_amount: number;
  deadline: string;
  contributionAmount?: number;
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
}

export interface DemoProfileSeed {
  transactions: DemoTransactionSeed[];
  monthlyAllocations: Record<string, MonthlyAllocation>;
  savingsGoals: DemoSavingsGoalSeed[];
  debts: DemoDebtSeed[];
  txTemplates: TxTemplate[];
  recurringTemplates: Array<Omit<RecurringTemplate, 'id' | 'lastGeneratedDate' | 'active'>>;
}

interface DemoMonthContext {
  monthKey: string;
  daysInMonth: number;
  visibleDays: number;
  multiplier: number;
}

interface TxTemplateSeed {
  type: TransactionType;
  category: string;
  amount: number;
  description: string;
  tags?: string;
}

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

function createMonthlyTransactions(baseDate: Date): DemoTransactionSeed[] {
  const txs: DemoTransactionSeed[] = [];
  const seededRandom = createSeededRandom(20260320);

  for (let monthsAgo = 11; monthsAgo >= 0; monthsAgo--) {
    const context = buildMonthContext(baseDate, monthsAgo);
    const monthDate = shiftMonth(baseDate, -monthsAgo);
    const monthLabel = monthNameFormatter.format(monthDate);
    const salaryAmount = 4850 + (monthsAgo % 4 === 0 ? 250 : 0);

    addIfVisible(txs, context, 1, 'salary', {
      type: 'income',
      category: 'salary',
      amount: salaryAmount,
      description: monthsAgo % 4 === 0 ? `Salary + ${monthLabel} bonus` : 'Salary deposit',
      tags: makeDemoTags('income', 'paycheck'),
      reconciled: true
    });

    if (monthsAgo % 3 === 1) {
      addIfVisible(txs, context, 18, 'freelance', {
        type: 'income',
        category: 'freelance',
        amount: 640 + monthsAgo * 11,
        description: 'Client retainer payment',
        tags: makeDemoTags('income', 'side_hustle'),
        reconciled: false
      });
    }

    addIfVisible(txs, context, 1, 'rent', {
      type: 'expense',
      category: 'bills',
      amount: 1450,
      description: 'Rent - Maple Apartments',
      tags: makeDemoTags('housing', 'fixed'),
      reconciled: true
    });

    addIfVisible(txs, context, 6, 'utilities', {
      type: 'expense',
      category: 'bills',
      amount: Math.round((155 + monthsAgo % 5 * 8) * context.multiplier * 100) / 100,
      description: 'Utilities bundle',
      tags: makeDemoTags('utilities', 'fixed'),
      reconciled: true
    });

    addIfVisible(txs, context, 10, 'internet', {
      type: 'expense',
      category: 'bills',
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
        category: 'food',
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
        category: 'transport',
        amount,
        description: index === 1 ? 'Gas station' : 'Transit + rideshare',
        tags: makeDemoTags('transport'),
        reconciled: index !== 2
      });
    });

    addIfVisible(txs, context, 8, 'coffee', {
      type: 'expense',
      category: 'food',
      amount: Math.round((9 + seededRandom() * 7) * 100) / 100,
      description: 'Coffee + breakfast',
      tags: makeDemoTags('food', 'small'),
      reconciled: false
    });

    addIfVisible(txs, context, 21, 'restaurant', {
      type: 'expense',
      category: 'food',
      amount: Math.round((48 + seededRandom() * 26) * context.multiplier * 100) / 100,
      description: 'Dinner out',
      tags: makeDemoTags('food', 'lifestyle'),
      reconciled: false
    });

    if (monthsAgo % 2 === 0) {
      addIfVisible(txs, context, 16, 'shopping', {
        type: 'expense',
        category: 'shopping',
        amount: Math.round((62 + seededRandom() * 95) * context.multiplier * 100) / 100,
        description: monthsAgo % 4 === 0 ? 'Home refresh order' : 'Target essentials',
        tags: makeDemoTags('shopping'),
        reconciled: false
      });
    }

    addIfVisible(txs, context, 23, 'entertainment', {
      type: 'expense',
      category: 'entertainment',
      amount: Math.round((22 + seededRandom() * 38) * context.multiplier * 100) / 100,
      description: monthsAgo % 2 === 0 ? 'Streaming + movie night' : 'Concert tickets',
      tags: makeDemoTags('entertainment'),
      reconciled: false
    });

    if (monthsAgo % 3 === 0) {
      addIfVisible(txs, context, 12, 'health', {
        type: 'expense',
        category: 'health',
        amount: Math.round((34 + seededRandom() * 46) * 100) / 100,
        description: 'Pharmacy + wellness',
        tags: makeDemoTags('health'),
        reconciled: true
      });
    }

    if (monthsAgo % 4 === 2) {
      addIfVisible(txs, context, 9, 'education', {
        type: 'expense',
        category: 'education',
        amount: 39,
        description: 'Design course subscription',
        tags: makeDemoTags('education'),
        reconciled: true
      });
    }

    if (monthsAgo % 5 === 0) {
      addIfVisible(txs, context, 19, 'other', {
        type: 'expense',
        category: 'other',
        amount: Math.round((18 + seededRandom() * 40) * 100) / 100,
        description: 'Household misc.',
        tags: makeDemoTags('other'),
        reconciled: false
      });
    }
  }

  return txs.sort((left, right) => left.date.localeCompare(right.date));
}

export function buildDemoProfile(baseDate: Date = new Date()): DemoProfileSeed {
  const currentMonth = toMonthKey(baseDate);
  const previousMonth = toMonthKey(shiftMonth(baseDate, -1));
  const nextMonth = shiftMonth(baseDate, 1);
  const nextMonthKey = toMonthKey(nextMonth);
  const nextMonthStart = toDateString(nextMonth.getFullYear(), nextMonth.getMonth(), 2);
  const nextMonthTenth = toDateString(nextMonth.getFullYear(), nextMonth.getMonth(), 10);
  const oneYearOut = toDateString(baseDate.getFullYear() + 1, baseDate.getMonth(), Math.min(baseDate.getDate(), 28));

  return {
    transactions: createMonthlyTransactions(baseDate),
    monthlyAllocations: {
      [previousMonth]: {
        bills: 1785,
        food: 620,
        transport: 240,
        shopping: 180,
        entertainment: 130,
        health: 110,
        education: 55,
        other: 85,
        debt_payment: 300
      },
      [currentMonth]: {
        bills: 1820,
        food: 680,
        transport: 255,
        shopping: 190,
        entertainment: 145,
        health: 120,
        education: 60,
        other: 90,
        debt_payment: 350
      }
    },
    savingsGoals: [
      {
        key: 'emergency_buffer',
        name: 'Emergency Buffer',
        target_amount: 6000,
        saved_amount: 2600,
        deadline: addDaysSafe(baseDate, 210)
      },
      {
        key: 'japan_trip',
        name: 'Japan Trip',
        target_amount: 3200,
        saved_amount: 900,
        deadline: addDaysSafe(baseDate, 160),
        contributionAmount: 250
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
        samplePaymentAmount: 220
      },
      {
        name: 'Auto Loan',
        type: 'auto',
        balance: 8420,
        originalBalance: 12000,
        interestRate: 0.064,
        minimumPayment: 285,
        dueDay: 12
      }
    ],
    txTemplates: [
      {
        id: 'demo_template_weekly_groceries',
        name: 'Weekly Grocery Run',
        type: 'expense',
        category: 'food',
        amount: 128,
        description: 'Weekly groceries',
        tags: 'groceries,home'
      },
      {
        id: 'demo_template_client_invoice',
        name: 'Client Invoice',
        type: 'income',
        category: 'freelance',
        amount: 750,
        description: 'Client invoice payment',
        tags: 'work,income'
      }
    ],
    recurringTemplates: [
      {
        type: 'expense',
        category: 'bills',
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
        category: 'health',
        amount: 48,
        description: 'Gym Membership',
        tags: makeDemoTags('health', 'recurring'),
        notes: `${DEMO_PROFILE_NOTE_MARKER} Gym Membership recurring template`,
        startDate: nextMonthStart,
        endDate: oneYearOut,
        recurringType: 'monthly',
        originalDayOfMonth: 2
      }
    ]
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

async function seedSavingsGoals(goals: DemoSavingsGoalSeed[]): Promise<number> {
  const existingNames = new Set(
    Object.values(signals.savingsGoals.value as Record<string, SavingsGoal>).map((goal: SavingsGoal) => goal.name)
  );

  let created = 0;

  for (const goal of goals) {
    if (existingNames.has(goal.name)) continue;
    const goalId = savingsGoalsActions.addGoal(goal);
    created++;
    existingNames.add(goal.name);

    if (goal.contributionAmount && goal.contributionAmount > 0) {
      await savingsGoalsActions.addContribution(goalId, goal.contributionAmount);
    }
  }

  return created;
}

async function seedDebts(debts: DemoDebtSeed[]): Promise<number> {
  const existingNames = new Set(signals.debts.value.map((debt: Debt) => debt.name));
  let created = 0;

  for (const debt of debts) {
    if (existingNames.has(debt.name)) continue;
    const createdDebt = addDebt(debt);
    created++;
    existingNames.add(debt.name);

    if (debt.samplePaymentAmount && debt.samplePaymentAmount > 0) {
      await recordPayment(createdDebt.id, debt.samplePaymentAmount);
    }
  }

  return created;
}

async function seedRecurringTemplates(
  templates: Array<Omit<RecurringTemplate, 'id' | 'lastGeneratedDate' | 'active'>>
): Promise<number> {
  let created = 0;

  for (const template of templates) {
    const alreadySeeded = signals.transactions.value.some((tx: Transaction) =>
      tx.description === template.description &&
      tx.notes?.includes(DEMO_PROFILE_NOTE_MARKER)
    );

    if (alreadySeeded) continue;
    await createRecurringTemplate(template);
    created++;
  }

  return created;
}

/**
 * Load a deterministic demo account with transactions and planning state.
 */
export async function loadSampleData(): Promise<boolean> {
  if (hasExistingDemoProfile()) {
    showToast('Demo account already loaded', 'info');
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
    showToast(`Failed to load demo data: ${txResult.error || 'storage may be full'}`, 'error');
    return false;
  }

  const mergedAllocations = mergeMonthlyAllocations(signals.monthlyAlloc.value, profile.monthlyAllocations);
  dataActions.setMonthlyAllocations(mergedAllocations);
  dataActions.setTxTemplates(mergeTemplates(signals.txTemplates.value, profile.txTemplates));

  const [createdGoals, createdDebts, createdRecurring] = await Promise.all([
    seedSavingsGoals(profile.savingsGoals),
    seedDebts(profile.debts),
    seedRecurringTemplates(profile.recurringTemplates)
  ]);

  invalidateMonthlyTotalsCache();
  invalidateRolloverCache();
  emit(Events.DATA_IMPORTED);
  showToast(
    `Loaded demo account: ${profile.transactions.length} transactions, ${createdGoals} goals, ${createdDebts} debts, ${createdRecurring} recurring series.`,
    'success'
  );
  return true;
}
