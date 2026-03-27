/**
 * Debt Payoff Planner Module
 *
 * Comprehensive debt tracking, payoff strategy calculations, and progress visualization.
 * Debt payments are integrated with transactions for unified expense tracking.
 */
'use strict';

import { SK, persist } from '../../core/state.js';
import * as signals from '../../core/signals.js';
import { debts, data } from '../../core/state-actions.js';
import { toCents, toDollars, parseAmount, generateId, getTodayStr } from '../../core/utils.js';
import { dataSdk } from '../../data/data-manager.js';
import { withTransaction, type Operation } from '../../data/transaction-manager.js';
import { emit, Events, on, createListenerGroup, destroyListenerGroup } from '../../core/event-bus.js';
import { FeatureEvents } from '../../core/feature-event-interface.js';
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
  debts.addDebt(debt);
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
  debts.replaceDebt(debtId, updatedDebt);
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
  debts.replaceDebt(debtId, updatedDebt);
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
  debts.removeDebt(debtId);
  persist(SK.DEBTS, signals.debts.value);
  emit(Events.DEBT_DELETED, debtToRemove);
  return true;
}

// ==========================================
// ATOMIC OPERATIONS
// ==========================================

/**
 * Atomic operation for recording a debt payment
 */
class DebtPaymentOperation implements Operation<PaymentResult> {
  private originalDebt: Debt | null = null;
  private updatedDebt: Debt | null = null;
  private transaction: Transaction | null = null;

  constructor(
    private debtId: string,
    private amount: number,
    private date: string
  ) {}

  async execute(): Promise<PaymentResult> {
    const currentDebts = (signals.debts.value as Debt[]) || [];
    this.originalDebt = currentDebts.find(d => d.id === this.debtId) || null;

    if (!this.originalDebt) throw new Error('Debt not found');

    // 1. Calculate portions
    const monthlyRate = this.originalDebt.interestRate / 12;
    const interestCents = Math.round(toCents(this.originalDebt.balance) * monthlyRate);
    const principalCents = Math.max(0, toCents(this.amount) - interestCents);

    // 2. Create transaction via SDK
    const txResult = await dataSdk.create({
      type: 'expense',
      category: DEBT_PAYMENT_CATEGORY,
      amount: this.amount,
      description: `${this.originalDebt.name} payment`,
      date: this.date,
      notes: `Principal: $${toDollars(principalCents).toFixed(2)}, Interest: $${toDollars(interestCents).toFixed(2)}`,
      tags: 'debt,payment',
      debtId: this.debtId
    });

    if (!txResult.isOk) throw new Error('Failed to create payment transaction');
    this.transaction = txResult.data as Transaction;

    // 3. Update debt state
    const payment: DebtPayment = {
      id: `pay_${generateId()}`,
      date: this.date,
      amount: this.amount,
      principal: toDollars(principalCents),
      interest: toDollars(interestCents),
      transactionId: this.transaction.__backendId
    };

    const newBalanceCents = Math.max(0, toCents(this.originalDebt.balance) - principalCents);
    this.updatedDebt = {
      ...this.originalDebt,
      balance: toDollars(newBalanceCents),
      payments: [...this.originalDebt.payments, payment]
    };

    // Apply update to signals
    debts.replaceDebt(this.debtId, this.updatedDebt!);
    persist(SK.DEBTS, signals.debts.value);

    return {
      isOk: true,
      debt: this.updatedDebt,
      payment,
      transaction: this.transaction
    };
  }

  async rollback(): Promise<void> {
    // Restore original debt state
    if (this.originalDebt) {
      const currentDebts = (signals.debts.value as Debt[]) || [];
      debts.replaceDebt(this.debtId, this.originalDebt!);
      persist(SK.DEBTS, signals.debts.value);
    }

    // Delete the transaction if it was created
    if (this.transaction) {
      await dataSdk.delete(this.transaction);
    }
  }
}

// ==========================================
// PAYMENT RECORDING
// ==========================================

/**
 * Record a payment on a debt
 * FIXED: Now uses atomic TransactionManager to prevent data corruption
 */
export async function recordPayment(debtId: string, amount: number | string, date: string | null = null): Promise<PaymentResult> {
  const paymentAmount = parseAmount(amount);
  const paymentDate = date || getTodayStr();

  try {
    const result = await withTransaction<PaymentResult>(
      [new DebtPaymentOperation(debtId, paymentAmount, paymentDate)],
      (results: PaymentResult[]) => results[0] as PaymentResult
    );

    if (result.isOk) {
      emit(Events.DEBT_PAYMENT, result);
    }

    return result;
  } catch (error) {
    return { 
      isOk: false, 
      error: error instanceof Error ? error.message : 'Unknown error during payment' 
    };
  }
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

    // If payment doesn't cover interest, record the shortfall and stop
    if (interestCents >= paymentCents) {
      const principalCents = 0;
      const actualPaymentCents = paymentCents;
      balanceCents = balanceCents + interestCents - paymentCents;
      schedule.push({
        month,
        payment: toDollars(actualPaymentCents),
        principal: toDollars(principalCents),
        interest: toDollars(interestCents),
        balance: toDollars(balanceCents)
      });
      break;
    }

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

    // Early exit: no need to continue once balance is fully paid
    if (balanceCents <= 0) break;
  }

  return schedule;
}

// ==========================================
// PAYOFF STRATEGIES
// ==========================================

/**
 * Configuration for payoff simulations
 */
export interface PayoffConfig {
  interestTiming?: 'before_payment' | 'after_payment' | 'mid_month';
  enableRollover?: boolean;
}

/**
 * Calculate snowball payoff strategy (smallest balance first)
 * Good for psychological wins and motivation
 */
export function calculateSnowball(debts: Debt[], extraMonthly: number = 0, config?: PayoffConfig): PayoffStrategyResult {
  const activeDebts = debts.filter(d => d.balance > 0 && d.isActive !== false);
  if (!activeDebts.length) {
    return { months: 0, totalInterest: 0, order: [], schedule: [] };
  }

  // Sort by balance ascending (smallest first)
  const sorted = [...activeDebts].sort((a, b) => a.balance - b.balance);
  return simulatePayoffStrategy(sorted, extraMonthly, config);
}

/**
 * Calculate avalanche payoff strategy (highest interest first)
 * Mathematically optimal - saves most on interest
 */
export function calculateAvalanche(debts: Debt[], extraMonthly: number = 0, config?: PayoffConfig): PayoffStrategyResult {
  const activeDebts = debts.filter(d => d.balance > 0 && d.isActive !== false);
  if (!activeDebts.length) {
    return { months: 0, totalInterest: 0, order: [], schedule: [] };
  }

  // Sort by interest rate descending (highest first)
  const sorted = [...activeDebts].sort((a, b) => b.interestRate - a.interestRate);
  return simulatePayoffStrategy(sorted, extraMonthly, config);
}

/**
 * Calculate custom order payoff strategy
 * Allows user to specify their own priority order
 */
export function calculateCustomOrder(debts: Debt[], order: string[], extraMonthly: number = 0, config?: PayoffConfig): PayoffStrategyResult {
  const activeDebts = debts.filter(d => d.balance > 0 && d.isActive !== false);
  if (!activeDebts.length) {
    return { months: 0, totalInterest: 0, order: [], schedule: [] };
  }

  // Sort by specified order
  const orderMap = new Map(order.map((id, idx) => [id, idx]));
  const sorted = [...activeDebts].sort((a, b) => {
    const aOrder = orderMap.get(a.id) ?? 999;
    const bOrder = orderMap.get(b.id) ?? 999;
    return aOrder - bOrder;
  });

  return simulatePayoffStrategy(sorted, extraMonthly, config);
}

/**
 * Enhanced payoff simulation with payment rollover and configurable interest timing
 */
function simulatePayoffStrategy(sortedDebts: Debt[], extraMonthly: number, options?: {
  interestTiming?: 'before_payment' | 'after_payment' | 'mid_month';
  enableRollover?: boolean;
}): PayoffStrategyResult {
  const config = {
    interestTiming: 'mid_month' as const,  // More realistic mid-month payment timing
    enableRollover: true,                  // Enable payment rollover by default
    ...options
  };

  // Clone debts with cents balances
  const debtStates: DebtState[] = sortedDebts.map(d => ({
    id: d.id,
    name: d.name,
    balanceCents: toCents(d.balance),
    rateCents: d.interestRate / 12,
    minPaymentCents: toCents(d.minimumPayment),
    paidOffMonth: null
  }));

  const baseExtraCents = toCents(extraMonthly);
  let totalInterestCents = 0;
  let month = 0;
  let totalReleasedCents = 0; // Accumulate freed-up minimum payments
  const maxMonths = 1200;
  const order: DebtPayoffOrder[] = [];
  const schedule: PayoffScheduleEntry[] = [];

  while (debtStates.some(d => d.balanceCents > 0) && month < maxMonths) {
    month++;
    let monthInterest = 0;
    
    // Total available extra = base extra + rollover from paid-off debts
    let availableExtraCents = baseExtraCents + (config.enableRollover ? totalReleasedCents : 0);
    let monthlyReleasedCents = 0; // Track releases this month

    // Find the focus debt (first one with balance > 0)
    const focusIdx = debtStates.findIndex(d => d.balanceCents > 0);

    debtStates.forEach((debt, idx) => {
      if (debt.balanceCents <= 0 || debt.paidOffMonth !== null) return;

      let interestCents: number;
      let effectiveBalance = debt.balanceCents;

      // Apply interest timing strategy
      if (config.interestTiming === 'mid_month') {
        // More realistic: apply interest on average balance (assumes mid-month payment)
        const minPayment = Math.min(debt.minPaymentCents, debt.balanceCents);
        const avgBalance = debt.balanceCents - (minPayment / 2); // Approximate mid-month balance
        interestCents = Math.round(Math.max(0, avgBalance) * debt.rateCents);
      } else if (config.interestTiming === 'after_payment') {
        // Payment first, then interest (most favorable to user)
        const minPayment = Math.min(debt.minPaymentCents, debt.balanceCents);
        effectiveBalance = debt.balanceCents - minPayment;
        interestCents = Math.round(Math.max(0, effectiveBalance) * debt.rateCents);
      } else {
        // Traditional: interest before payment (current implementation)
        interestCents = Math.round(debt.balanceCents * debt.rateCents);
      }

      debt.balanceCents += interestCents;
      monthInterest += interestCents;

      // Apply minimum payment
      const minPaymentCents = Math.min(debt.minPaymentCents, debt.balanceCents);
      debt.balanceCents -= minPaymentCents;

      // Apply extra to focus debt only
      if (idx === focusIdx && availableExtraCents > 0) {
        const extraApplied = Math.min(availableExtraCents, debt.balanceCents);
        debt.balanceCents -= extraApplied;
        availableExtraCents -= extraApplied;
      }

      // Check if paid off this month
      if (debt.balanceCents <= 0 && debt.paidOffMonth === null) {
        debt.paidOffMonth = month;
        debt.balanceCents = 0;
        order.push({ id: debt.id, name: debt.name, month });

        // CRITICAL FIX: Add freed-up minimum payment to rollover pool
        if (config.enableRollover) {
          monthlyReleasedCents += debt.minPaymentCents;
          if (import.meta.env.DEV) console.log(`Debt '${debt.name}' paid off in month ${month}. Releasing $${toDollars(debt.minPaymentCents)}/month for accelerated payoff.`);
        }

        // NOTE: Do NOT emit DEBT_PAID_OFF here — this is a simulation/projection,
        // not an actual payoff. Emitting would trigger celebrations/achievements
        // for debts that are not actually paid off.
      }
    });

    // Add this month's released payments to the cumulative total
    totalReleasedCents += monthlyReleasedCents;

    totalInterestCents += monthInterest;

    // Record monthly snapshot (first 60 months for chart)
    if (month <= 60) {
      const totalBalance = debtStates.reduce((s, d) => s + d.balanceCents, 0);
      schedule.push({
        month,
        totalBalance: toDollars(totalBalance),
        interest: toDollars(monthInterest),
        availableExtra: toDollars(baseExtraCents + totalReleasedCents), // Show growing extra payment power
        releasedThisMonth: toDollars(monthlyReleasedCents)
      });
    }

    // Safety check for negative amortization
    const activeDebts = debtStates.filter(d => d.balanceCents > 0);
    if (activeDebts.some(d => {
      const monthlyInterest = Math.round(d.balanceCents * d.rateCents);
      const totalPayment = d.minPaymentCents + (activeDebts[0] === d ? availableExtraCents : 0);
      return monthlyInterest >= totalPayment;
    }) && month > 12) {
      if (import.meta.env.DEV) console.warn('Negative amortization detected - payments do not cover interest');
      break;
    }
  }

  return {
    months: month,
    totalInterest: toDollars(totalInterestCents),
    order,
    schedule,
    totalReleased: toDollars(totalReleasedCents), // New: show total payment acceleration
    paymentAcceleration: config.enableRollover ? toDollars(totalReleasedCents) : 0
  };
}

/**
 * Enhanced strategy comparison with configurable simulation options
 */
export function compareStrategies(debts: Debt[], extraMonthly: number = 0, config?: PayoffConfig): StrategyComparison {
  const snowball = calculateSnowball(debts, extraMonthly, config);
  const avalanche = calculateAvalanche(debts, extraMonthly, config);

  const interestSaved = snowball.totalInterest - avalanche.totalInterest;
  const timeDiff = snowball.months - avalanche.months;

  // Enhanced recommendation logic that considers both savings and time
  let recommended: 'avalanche' | 'snowball';
  if (interestSaved > 500) {
    // Significant interest savings favor avalanche
    recommended = 'avalanche';
  } else if (interestSaved < 100 && timeDiff < 6) {
    // Small difference - go with psychological wins
    recommended = 'snowball';
  } else {
    // Default to avalanche for meaningful savings
    recommended = interestSaved > 100 ? 'avalanche' : 'snowball';
  }

  return {
    snowball,
    avalanche,
    interestSaved,      // Positive = avalanche saves more
    timeDiff,           // Positive = avalanche is faster  
    recommended,
    rolloverImpact: config?.enableRollover ? {
      snowballAcceleration: snowball.paymentAcceleration || 0,
      avalancheAcceleration: avalanche.paymentAcceleration || 0,
      accelerationDifference: (avalanche.paymentAcceleration || 0) - (snowball.paymentAcceleration || 0)
    } : undefined
  };
}

/**
 * Get detailed simulation insights for a specific strategy
 */
export function getStrategyInsights(debts: Debt[], strategy: 'snowball' | 'avalanche' | 'custom', extraMonthly: number = 0, customOrder?: string[]): {
  result: PayoffStrategyResult;
  insights: {
    totalPayments: number;
    averageMonthlyPayment: number;
    largestPaymentBoost: number;
    earlyPayoffCount: number;
    motivationScore: number;
  };
} {
  let result: PayoffStrategyResult;
  
  switch (strategy) {
    case 'snowball':
      result = calculateSnowball(debts, extraMonthly);
      break;
    case 'avalanche':
      result = calculateAvalanche(debts, extraMonthly);
      break;
    case 'custom':
      result = calculateCustomOrder(debts, customOrder || [], extraMonthly);
      break;
  }

  const totalBalance = debts.reduce((sum, d) => sum + d.balance, 0);
  const totalMinimums = debts.reduce((sum, d) => sum + d.minimumPayment, 0);
  const totalPayments = totalBalance + result.totalInterest;
  const averageMonthlyPayment = result.months > 0 ? totalPayments / result.months : 0;

  // Calculate largest payment boost from rollover
  const largestPaymentBoost = result.totalReleased || 0;

  // Count debts paid off in first 2 years (motivational factor)
  const earlyPayoffCount = result.order.filter(o => o.month <= 24).length;

  // Motivation score (0-100) based on early wins and time to completion
  let motivationScore = Math.max(0, 100 - result.months * 2); // Base score decreases with time
  motivationScore += earlyPayoffCount * 15; // Bonus for early payoffs
  if (strategy === 'snowball') motivationScore += 10; // Psychological bonus
  motivationScore = Math.min(100, motivationScore);

  return {
    result,
    insights: {
      totalPayments,
      averageMonthlyPayment,
      largestPaymentBoost,
      earlyPayoffCount,
      motivationScore
    }
  };
}

// recordDebtPayment removed - use recordPayment() (async, uses dataSdk) as the single authority
// for recording debt payments with proper transaction creation.
//
// Old synchronous recordDebtPayment bypassed dataSdk and manually persisted to localStorage,
// which could desync with IndexedDB and skip multi-tab sync protections.

/** @deprecated Use recordPayment() instead - this bypasses dataSdk */
export function recordDebtPayment(_debtId: string, _amount: number, _description?: string): PaymentResult {
  throw new Error('recordDebtPayment is deprecated. Use recordPayment() which persists via dataSdk.');
}

/**
 * Calculate total interest paid on a debt based on payment history
 */
function calculateTotalInterestPaid(debt: Debt): number {
  const totalPaid = (debt.payments || []).reduce((sum, p) => sum + p.amount, 0);
  const principalPaid = (debt.originalBalance || 0) - debt.balance;
  return Math.max(0, totalPaid - principalPaid);
}

/**
 * Simulate a payment schedule for visualization
 */
export function simulatePaymentSchedule(debt: Debt, paymentAmount: number): {
  schedule: Array<{
    month: number;
    payment: number;
    principal: number;
    interest: number;
    balance: number;
  }>;
  summary: {
    totalMonths: number;
    totalInterest: number;
    totalPayments: number;
  };
} {
  const schedule = generateAmortizationSchedule(debt, paymentAmount - debt.minimumPayment);
  const totalInterest = schedule.reduce((sum, entry) => sum + entry.interest, 0);
  const totalPayments = schedule.reduce((sum, entry) => sum + entry.payment, 0);

  return {
    schedule,
    summary: {
      totalMonths: schedule.length,
      totalInterest,
      totalPayments
    }
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

let debtPlannerListenerGroupId: string | null = null;

export function cleanupDebtPlanner(): void {
  if (debtPlannerListenerGroupId) {
    destroyListenerGroup(debtPlannerListenerGroupId);
    debtPlannerListenerGroupId = null;
  }
}

/**
 * Initialize debt planner module and register feature event listeners
 * Ensures the debt payment category exists using proper state management
 */
export function initDebtPlanner(): void {
  cleanupDebtPlanner();
  debtPlannerListenerGroupId = createListenerGroup('debt-planner');

  // Register Feature Event Listeners
  // Request: Get all debts
  on(FeatureEvents.REQUEST_DEBTS, (data: any) => {
    const responseEvent = data.responseEvent;
    if (responseEvent) {
      const result = getDebts();
      emit(responseEvent, { type: FeatureEvents.REQUEST_DEBTS, result });
    }
  }, { groupId: debtPlannerListenerGroupId });

  // Action: Add debt
  on(FeatureEvents.ADD_DEBT, (debt: Debt) => {
    addDebt(debt);
  }, { groupId: debtPlannerListenerGroupId });

  // Action: Update debt
  on(FeatureEvents.UPDATE_DEBT, (data: { id: string, updates: Partial<Debt> }) => {
    updateDebt(data.id, data.updates);
  }, { groupId: debtPlannerListenerGroupId });

  // Action: Delete debt
  on(FeatureEvents.DELETE_DEBT, (data: { id: string }) => {
    deleteDebt(data.id);
  }, { groupId: debtPlannerListenerGroupId });

  // Check if debt_payment category exists in custom categories
  const currentCustomCats = signals.customCats.value || [];
  const hasDebtCat = currentCustomCats.some(c => c.id === DEBT_PAYMENT_CATEGORY);

  if (!hasDebtCat) {
    // ARCHITECTURE FIX: Use immutable update to trigger reactive effects
    const newCategory = {
      id: DEBT_PAYMENT_CATEGORY,
      name: 'Debt Payment',
      type: 'expense' as const,
      emoji: '💳',
      color: '#dc2626'  // Red
    };
    
    // Create new array reference to ensure signals trigger properly
    data.setCustomCategories([...currentCustomCats, newCategory]);
    persist(SK.CUSTOM_CAT, signals.customCats.value);

    if (import.meta.env.DEV) console.debug('Created debt payment category with proper signal reactivity');
  }

  if (import.meta.env.DEV) console.debug('Debt planner feature events initialized');
}
