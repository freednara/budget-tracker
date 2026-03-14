/**
 * Debt Payoff Planner Module
 *
 * Comprehensive debt tracking, payoff strategy calculations, and progress visualization.
 * Debt payments are integrated with transactions for unified expense tracking.
 */
'use strict';

import { SK, persist } from '../../core/state.js';
import * as signals from '../../core/signals.js';
import { toCents, toDollars, parseAmount, generateId, getTodayStr } from '../../core/utils.js';
import { dataSdk } from '../../data/data-manager.js';
import { emit, Events } from '../../core/event-bus.js';
import type {
  Debt,
  DebtType,
  DebtTypeInfo,
  DebtPayment,
  PayoffInfo,
  AmortizationEntry,
  PayoffStrategyResult,
  StrategyComparison,
  DebtProgress,
  TotalDebtSummary,
  PaymentResult,
  DebtPayoffOrder,
  PayoffScheduleEntry,
  Transaction
} from '../../../types/index.js';

// ==========================================
// CONSTANTS
// ==========================================

/**
 * Debt type options
 */
export const DEBT_TYPES: Record<string, DebtType> = {
  CREDIT_CARD: 'credit_card',
  STUDENT_LOAN: 'student_loan',
  MORTGAGE: 'mortgage',
  AUTO: 'auto',
  PERSONAL: 'personal',
  MEDICAL: 'medical',
  OTHER: 'other'
};

/**
 * Debt type display info
 */
export const DEBT_TYPE_INFO: Record<DebtType, DebtTypeInfo> = {
  credit_card: { label: 'Credit Card', emoji: '💳' },
  student_loan: { label: 'Student Loan', emoji: '🎓' },
  mortgage: { label: 'Mortgage', emoji: '🏠' },
  auto: { label: 'Auto Loan', emoji: '🚗' },
  personal: { label: 'Personal Loan', emoji: '💰' },
  medical: { label: 'Medical Debt', emoji: '🏥' },
  other: { label: 'Other', emoji: '📄' }
};

/**
 * Category ID for debt payments (should exist or be created)
 */
export const DEBT_PAYMENT_CATEGORY = 'debt_payment';

// ==========================================
// INTERNAL TYPES
// ==========================================

interface DebtData {
  name?: string;
  type?: string;
  balance?: number | string;
  originalBalance?: number | string;
  interestRate?: number | string;
  minimumPayment?: number | string;
  dueDay?: number | string;
}

interface DebtUpdates {
  name?: string;
  type?: DebtType;
  balance?: number | string;
  interestRate?: number | string;
  minimumPayment?: number | string;
  dueDay?: number | string;
}

interface DebtState {
  id: string;
  name: string;
  balanceCents: number;
  rateCents: number;
  minPaymentCents: number;
  paidOffMonth: number | null;
}

// ==========================================
// DATA MANAGEMENT
// ==========================================

/**
 * Get all active debts
 */
export function getDebts(): Debt[] {
  return ((signals.debts.value as Debt[]) || []).filter(d => d.isActive !== false);
}

/**
 * Get all debts including inactive
 */
export function getAllDebts(): Debt[] {
  return (signals.debts.value as Debt[]) || [];
}

/**
 * Get a single debt by ID
 */
export function getDebt(debtId: string): Debt | null {
  return ((signals.debts.value as Debt[]) || []).find(d => d.id === debtId) || null;
}

/**
 * Add a new debt
 */
export function addDebt(debtData: DebtData): Debt {
  const balanceValue = debtData.balance ?? 0;
  const debt: Debt = {
    id: `debt_${generateId()}`,
    name: ((debtData.name || 'Untitled Debt').trim()).slice(0, 100),
    type: (DEBT_TYPES[debtData.type as string] || debtData.type || DEBT_TYPES.OTHER) as DebtType,
    balance: parseAmount(balanceValue),
    originalBalance: parseAmount(debtData.originalBalance ?? balanceValue),
    interestRate: Math.max(0, Math.min(1, parseFloat(String(debtData.interestRate ?? 0)) || 0)),
    minimumPayment: parseAmount(debtData.minimumPayment ?? 0),
    dueDay: Math.max(1, Math.min(31, parseInt(String(debtData.dueDay ?? 1)) || 1)),
    createdAt: new Date().toISOString(),
    payments: [],
    isActive: true
  };

  // Use immutable update to trigger signal effects
  const currentDebts = (signals.debts.value as Debt[]) || [];
  signals.debts.value = [...currentDebts, debt];
  persist(SK.DEBTS, signals.debts.value);

  emit(Events.DEBT_ADDED, debt);
  return debt;
}

/**
 * Update an existing debt
 */
export function updateDebt(debtId: string, updates: DebtUpdates): Debt | null {
  const debt = getDebt(debtId);
  if (!debt) return null;

  // Create updated debt object
  const updatedDebt = { ...debt };
  if (updates.name !== undefined) updatedDebt.name = updates.name.trim().slice(0, 100);
  if (updates.type !== undefined) updatedDebt.type = updates.type;
  if (updates.balance !== undefined) updatedDebt.balance = parseAmount(updates.balance as string | number);
  if (updates.interestRate !== undefined) updatedDebt.interestRate = Math.max(0, Math.min(1, parseFloat(String(updates.interestRate)) || 0));
  if (updates.minimumPayment !== undefined) updatedDebt.minimumPayment = parseAmount(updates.minimumPayment as string | number);
  if (updates.dueDay !== undefined) updatedDebt.dueDay = Math.max(1, Math.min(31, parseInt(String(updates.dueDay)) || 1));

  // Use immutable update to trigger signal effects
  const currentDebts = (signals.debts.value as Debt[]) || [];
  signals.debts.value = currentDebts.map(d => d.id === debtId ? updatedDebt : d);
  persist(SK.DEBTS, signals.debts.value);
  emit(Events.DEBT_UPDATED, updatedDebt);
  return updatedDebt;
}

/**
 * Delete (soft) a debt
 */
export function deleteDebt(debtId: string): boolean {
  const debt = getDebt(debtId);
  if (!debt) return false;

  // Use immutable update to trigger signal effects
  const updatedDebt = { ...debt, isActive: false };
  const currentDebts = (signals.debts.value as Debt[]) || [];
  signals.debts.value = currentDebts.map(d => d.id === debtId ? updatedDebt : d);
  persist(SK.DEBTS, signals.debts.value);
  emit(Events.DEBT_DELETED, updatedDebt);
  return true;
}

/**
 * Permanently remove a debt (hard delete)
 */
export function removeDebt(debtId: string): boolean {
  const currentDebts = (signals.debts.value as Debt[]) || [];
  const debtToRemove = currentDebts.find(d => d.id === debtId);
  if (!debtToRemove) return false;

  // Use immutable update to trigger signal effects
  signals.debts.value = currentDebts.filter(d => d.id !== debtId);
  persist(SK.DEBTS, signals.debts.value);
  emit(Events.DEBT_DELETED, debtToRemove);
  return true;
}

// ==========================================
// PAYMENT RECORDING
// ==========================================

/**
 * Record a payment on a debt
 * Creates a transaction AND updates the debt balance (integrated approach)
 */
export async function recordPayment(debtId: string, amount: number | string, date: string | null = null): Promise<PaymentResult> {
  const debt = getDebt(debtId);
  if (!debt) {
    return { isOk: false, error: 'Debt not found' };
  }

  const paymentAmount = parseAmount(amount);
  if (paymentAmount <= 0) {
    return { isOk: false, error: 'Payment amount must be positive' };
  }

  const paymentDate = date || getTodayStr();

  // Calculate how much goes to interest vs principal
  // Simple monthly interest calculation (APR / 12)
  const monthlyRate = debt.interestRate / 12;
  const interestPortion = toDollars(Math.round(toCents(debt.balance) * monthlyRate));
  const principalPortion = Math.max(0, paymentAmount - interestPortion);

  // Create expense transaction for the payment
  const txResult = await dataSdk.create({
    type: 'expense',
    category: DEBT_PAYMENT_CATEGORY,
    amount: paymentAmount,
    description: `${debt.name} payment`,
    date: paymentDate,
    notes: `Principal: $${principalPortion.toFixed(2)}, Interest: $${interestPortion.toFixed(2)}`,
    tags: 'debt,payment',
    debtId: debtId  // Link to debt for reference
  });

  if (!txResult.isOk) {
    return { isOk: false, error: 'Failed to create payment transaction' };
  }

  // Record payment in debt history
  const payment: DebtPayment = {
    id: `pay_${generateId()}`,
    date: paymentDate,
    amount: paymentAmount,
    principal: principalPortion,
    interest: interestPortion,
    transactionId: (txResult.data as Transaction).__backendId
  };

  // Update debt balance (reduce by principal portion)
  const newBalanceCents = Math.max(0, toCents(debt.balance) - toCents(principalPortion));
  const updatedDebt = {
    ...debt,
    balance: toDollars(newBalanceCents),
    payments: [...debt.payments, payment]
  };

  // Use immutable update to trigger signal effects
  const currentDebts = (signals.debts.value as Debt[]) || [];
  signals.debts.value = currentDebts.map(d => d.id === debtId ? updatedDebt : d);
  persist(SK.DEBTS, signals.debts.value);
  emit(Events.DEBT_PAYMENT, { debt: updatedDebt, payment, transaction: txResult.data });

  return {
    isOk: true,
    debt: updatedDebt,
    payment,
    transaction: txResult.data as Transaction
  };
}

// ==========================================
// INTEREST CALCULATIONS
// ==========================================

/**
 * Calculate monthly interest on a debt balance
 * Uses cents-based math for precision
 */
export function calculateMonthlyInterest(balance: number, apr: number): number {
  const balanceCents = toCents(balance);
  const monthlyRate = apr / 12;
  const interestCents = Math.round(balanceCents * monthlyRate);
  return toDollars(interestCents);
}

/**
 * Calculate payoff date for a debt
 */
export function calculatePayoffDate(debt: Debt, extraPayment: number = 0): PayoffInfo {
  if (debt.balance <= 0) {
    return { months: 0, date: new Date(), totalInterest: 0 };
  }

  const monthlyPayment = debt.minimumPayment + extraPayment;
  if (monthlyPayment <= 0) {
    return { months: Infinity, date: null, totalInterest: Infinity };
  }

  let balanceCents = toCents(debt.balance);
  const monthlyRate = debt.interestRate / 12;
  const paymentCents = toCents(monthlyPayment);
  let months = 0;
  let totalInterestCents = 0;
  const maxMonths = 1200; // 100 years safety limit

  while (balanceCents > 0 && months < maxMonths) {
    // Calculate interest for this month
    const interestCents = Math.round(balanceCents * monthlyRate);
    totalInterestCents += interestCents;

    // Apply payment (after interest accrues)
    const newBalance = balanceCents + interestCents - paymentCents;
    balanceCents = Math.max(0, newBalance);
    months++;

    // Check if payment doesn't cover interest (infinite loop prevention)
    if (interestCents >= paymentCents && months > 12) {
      return { months: Infinity, date: null, totalInterest: Infinity };
    }
  }

  // Calculate payoff date
  const payoffDate = new Date();
  payoffDate.setMonth(payoffDate.getMonth() + months);

  return {
    months,
    date: payoffDate,
    totalInterest: toDollars(totalInterestCents)
  };
}

/**
 * Generate amortization schedule for a debt
 */
export function generateAmortizationSchedule(debt: Debt, extraPayment: number = 0, maxMonths: number = 360): AmortizationEntry[] {
  const schedule: AmortizationEntry[] = [];
  let balanceCents = toCents(debt.balance);
  const monthlyRate = debt.interestRate / 12;
  const paymentCents = toCents(debt.minimumPayment + extraPayment);

  if (paymentCents <= 0 || balanceCents <= 0) return schedule;

  let month = 0;
  while (balanceCents > 0 && month < maxMonths) {
    month++;

    const interestCents = Math.round(balanceCents * monthlyRate);
    const principalCents = Math.min(paymentCents - interestCents, balanceCents);
    const actualPaymentCents = interestCents + principalCents;

    balanceCents = Math.max(0, balanceCents - principalCents);

    schedule.push({
      month,
      payment: toDollars(actualPaymentCents),
      principal: toDollars(principalCents),
      interest: toDollars(interestCents),
      balance: toDollars(balanceCents)
    });

    // Stop if payment doesn't cover interest
    if (interestCents >= paymentCents) break;
  }

  return schedule;
}

// ==========================================
// PAYOFF STRATEGIES
// ==========================================

/**
 * Calculate snowball payoff strategy (smallest balance first)
 * Good for psychological wins
 */
export function calculateSnowball(debts: Debt[], extraMonthly: number = 0): PayoffStrategyResult {
  const activeDebts = debts.filter(d => d.balance > 0 && d.isActive !== false);
  if (!activeDebts.length) {
    return { months: 0, totalInterest: 0, order: [], schedule: [] };
  }

  // Sort by balance ascending (smallest first)
  const sorted = [...activeDebts].sort((a, b) => a.balance - b.balance);
  return simulatePayoffStrategy(sorted, extraMonthly);
}

/**
 * Calculate avalanche payoff strategy (highest interest first)
 * Mathematically optimal - saves most on interest
 */
export function calculateAvalanche(debts: Debt[], extraMonthly: number = 0): PayoffStrategyResult {
  const activeDebts = debts.filter(d => d.balance > 0 && d.isActive !== false);
  if (!activeDebts.length) {
    return { months: 0, totalInterest: 0, order: [], schedule: [] };
  }

  // Sort by interest rate descending (highest first)
  const sorted = [...activeDebts].sort((a, b) => b.interestRate - a.interestRate);
  return simulatePayoffStrategy(sorted, extraMonthly);
}

/**
 * Simulate payoff with debts in a specific order
 */
function simulatePayoffStrategy(sortedDebts: Debt[], extraMonthly: number): PayoffStrategyResult {
  // Clone debts with cents balances
  const debtStates: DebtState[] = sortedDebts.map(d => ({
    id: d.id,
    name: d.name,
    balanceCents: toCents(d.balance),
    rateCents: d.interestRate / 12,
    minPaymentCents: toCents(d.minimumPayment),
    paidOffMonth: null
  }));

  const extraCents = toCents(extraMonthly);
  let totalInterestCents = 0;
  let month = 0;
  const maxMonths = 1200;
  const order: DebtPayoffOrder[] = [];
  const schedule: PayoffScheduleEntry[] = [];

  while (debtStates.some(d => d.balanceCents > 0) && month < maxMonths) {
    month++;
    let monthInterest = 0;
    let availableExtraCents = extraCents;

    // Find the focus debt (first one with balance > 0)
    const focusIdx = debtStates.findIndex(d => d.balanceCents > 0);

    debtStates.forEach((debt, idx) => {
      if (debt.balanceCents <= 0) return;

      // Calculate interest
      const interestCents = Math.round(debt.balanceCents * debt.rateCents);
      debt.balanceCents += interestCents;
      monthInterest += interestCents;

      // Apply minimum payment
      const paymentCents = Math.min(debt.minPaymentCents, debt.balanceCents);
      debt.balanceCents -= paymentCents;

      // Apply extra to focus debt
      if (idx === focusIdx && availableExtraCents > 0) {
        const extraApplied = Math.min(availableExtraCents, debt.balanceCents);
        debt.balanceCents -= extraApplied;
        availableExtraCents -= extraApplied;
      }

      // Check if paid off
      if (debt.balanceCents <= 0 && debt.paidOffMonth === null) {
        debt.paidOffMonth = month;
        debt.balanceCents = 0;
        order.push({ id: debt.id, name: debt.name, month });

        // Released minimum payment becomes available for next debt
        // (This is the "snowball" effect)
      }
    });

    totalInterestCents += monthInterest;

    // Record monthly snapshot (first 60 months for chart)
    if (month <= 60) {
      schedule.push({
        month,
        totalBalance: toDollars(debtStates.reduce((s, d) => s + d.balanceCents, 0)),
        interest: toDollars(monthInterest)
      });
    }
  }

  return {
    months: month,
    totalInterest: toDollars(totalInterestCents),
    order,
    schedule
  };
}

/**
 * Compare snowball and avalanche strategies
 */
export function compareStrategies(debts: Debt[], extraMonthly: number = 0): StrategyComparison {
  const snowball = calculateSnowball(debts, extraMonthly);
  const avalanche = calculateAvalanche(debts, extraMonthly);

  const interestSaved = snowball.totalInterest - avalanche.totalInterest;
  const timeDiff = snowball.months - avalanche.months;

  return {
    snowball,
    avalanche,
    interestSaved,      // Positive = avalanche saves more
    timeDiff,           // Positive = avalanche is faster
    recommended: interestSaved > 100 ? 'avalanche' : 'snowball'  // Recommend avalanche if saves $100+
  };
}

// ==========================================
// PROGRESS TRACKING
// ==========================================

/**
 * Get progress for a single debt
 */
export function getDebtProgress(debt: Debt): DebtProgress {
  const originalBalance = debt.originalBalance !== undefined ? debt.originalBalance : debt.balance;
  const originalCents = toCents(originalBalance);
  const currentCents = toCents(debt.balance);
  const paidCents = originalCents - currentCents;

  const percentComplete = originalCents > 0
    ? Math.round((paidCents / originalCents) * 100)
    : 100;

  return {
    original: debt.originalBalance,
    current: debt.balance,
    paid: toDollars(paidCents),
    percentComplete: Math.max(0, Math.min(100, percentComplete)),
    paymentsCount: debt.payments?.length || 0,
    lastPayment: debt.payments?.length ? debt.payments[debt.payments.length - 1] : null
  };
}

/**
 * Get summary of all debts
 */
export function getTotalDebtSummary(): TotalDebtSummary {
  const debts = getDebts();

  if (!debts.length) {
    return {
      totalBalance: 0,
      totalOriginal: 0,
      totalPaid: 0,
      percentComplete: 0,
      debtCount: 0,
      monthlyMinimum: 0,
      avgInterestRate: 0
    };
  }

  let totalBalanceCents = 0;
  let totalOriginalCents = 0;
  let totalMinimumCents = 0;
  let weightedRateSum = 0;

  debts.forEach(d => {
    const balCents = toCents(d.balance);
    totalBalanceCents += balCents;
    totalOriginalCents += toCents(d.originalBalance);
    totalMinimumCents += toCents(d.minimumPayment);
    weightedRateSum += balCents * d.interestRate;
  });

  const totalBalance = toDollars(totalBalanceCents);
  const totalOriginal = toDollars(totalOriginalCents);
  const totalPaid = toDollars(totalOriginalCents - totalBalanceCents);

  return {
    totalBalance,
    totalOriginal,
    totalPaid,
    percentComplete: totalOriginalCents > 0
      ? Math.round((totalOriginalCents - totalBalanceCents) / totalOriginalCents * 100)
      : 0,
    debtCount: debts.length,
    monthlyMinimum: toDollars(totalMinimumCents),
    avgInterestRate: totalBalanceCents > 0
      ? weightedRateSum / totalBalanceCents
      : 0
  };
}

/**
 * Get total monthly debt payments required
 */
export function getMonthlyDebtPayments(): number {
  const debts = getDebts();
  const totalCents = debts.reduce((sum, d) => sum + toCents(d.minimumPayment), 0);
  return toDollars(totalCents);
}

// ==========================================
// INITIALIZATION
// ==========================================

/**
 * Initialize debt planner module
 * Ensures the debt payment category exists
 */
export function initDebtPlanner(): void {
  // Debts are already loaded via state.js
  // Check if debt_payment category exists in custom categories
  const hasDebtCat = signals.customCats.value?.some(c => c.id === DEBT_PAYMENT_CATEGORY);

  if (!hasDebtCat && signals.customCats.value) {
    // Auto-create debt payment category if it doesn't exist
    signals.customCats.value.push({
      id: DEBT_PAYMENT_CATEGORY,
      name: 'Debt Payment',
      type: 'expense',
      emoji: '💳',
      color: '#dc2626'  // Red
    });
    persist(SK.CUSTOM_CAT, signals.customCats.value);
  }
}
