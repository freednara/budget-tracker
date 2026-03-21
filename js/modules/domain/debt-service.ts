/**
 * Debt Domain Service
 * Pure business logic for debt payoff calculations. No side effects.
 *
 * All functions are pure: they take data as parameters and return results.
 * No signal access, no event emission, no DOM, no storage.
 *
 * @module domain/debt-service
 */
'use strict';

import { toCents, toDollars } from '../core/utils-pure.js';

// ==========================================
// TYPES
// ==========================================

/** Minimal debt shape required by domain functions */
export interface DebtInput {
  id: string;
  name: string;
  balance: number;
  originalBalance: number;
  interestRate: number;   // Annual rate as decimal (e.g. 0.18 for 18%)
  minimumPayment: number;
  isActive?: boolean;
}

export interface PayoffResult {
  months: number;
  totalInterest: number;
  payoffDate: Date | null;
}

export interface AmortizationEntry {
  month: number;
  payment: number;
  principal: number;
  interest: number;
  balance: number;
}

export interface DebtPayoffOrder {
  id: string;
  name: string;
  month: number;
}

export interface PayoffScheduleEntry {
  month: number;
  totalBalance: number;
  interest: number;
  availableExtra: number;
  releasedThisMonth: number;
}

export interface StrategyResult {
  months: number;
  totalInterest: number;
  order: DebtPayoffOrder[];
  schedule: PayoffScheduleEntry[];
  totalReleased: number;
  paymentAcceleration: number;
}

export interface StrategyComparison {
  snowball: StrategyResult;
  avalanche: StrategyResult;
  interestSaved: number;
  timeDiff: number;
  recommended: 'avalanche' | 'snowball';
}

export interface DebtProgressResult {
  original: number;
  current: number;
  paid: number;
  percentComplete: number;
}

export interface DebtSummaryResult {
  totalBalance: number;
  totalOriginal: number;
  totalPaid: number;
  percentComplete: number;
  debtCount: number;
  monthlyMinimum: number;
  avgInterestRate: number;
}

export interface SimulationConfig {
  interestTiming?: 'before_payment' | 'after_payment' | 'mid_month';
  enableRollover?: boolean;
}

// ==========================================
// INTEREST CALCULATIONS
// ==========================================

/**
 * Calculate monthly interest on a debt balance.
 * Uses cents-based math for precision.
 */
export function calculateMonthlyInterest(balance: number, apr: number): number {
  const balanceCents = toCents(balance);
  const monthlyRate = apr / 12;
  const interestCents = Math.round(balanceCents * monthlyRate);
  return toDollars(interestCents);
}

// ==========================================
// PAYOFF DATE
// ==========================================

/**
 * Calculate months to payoff and total interest for a single debt.
 * Pure function — takes principal, annual rate, and monthly payment.
 *
 * @param principal Current balance
 * @param rate Annual interest rate as decimal (e.g. 0.18)
 * @param payment Monthly payment amount
 * @returns PayoffResult with months, total interest, and projected payoff date
 */
export function calculatePayoffDate(
  principal: number,
  rate: number,
  payment: number
): PayoffResult {
  if (principal <= 0) {
    return { months: 0, totalInterest: 0, payoffDate: new Date() };
  }
  if (payment <= 0) {
    return { months: Infinity, totalInterest: Infinity, payoffDate: null };
  }

  let balanceCents = toCents(principal);
  const monthlyRate = rate / 12;
  const paymentCents = toCents(payment);
  let months = 0;
  let totalInterestCents = 0;
  const maxMonths = 1200; // 100 years safety limit

  while (balanceCents > 0 && months < maxMonths) {
    const interestCents = Math.round(balanceCents * monthlyRate);
    totalInterestCents += interestCents;

    const newBalance = balanceCents + interestCents - paymentCents;
    balanceCents = Math.max(0, newBalance);
    months++;

    // Check if payment doesn't cover interest (infinite loop prevention)
    if (interestCents >= paymentCents && months > 12) {
      return { months: Infinity, totalInterest: Infinity, payoffDate: null };
    }
  }

  const payoffDate = new Date();
  payoffDate.setMonth(payoffDate.getMonth() + months);

  return {
    months,
    totalInterest: toDollars(totalInterestCents),
    payoffDate
  };
}

// ==========================================
// AMORTIZATION SCHEDULE
// ==========================================

/**
 * Generate amortization schedule for a single debt.
 * Pure function — takes principal, rate, payment, and optional max months.
 *
 * @param principal Current balance
 * @param rate Annual interest rate as decimal
 * @param payment Monthly payment (total, not extra)
 * @param maxMonths Maximum months to simulate (default 360 = 30 years)
 */
export function generateAmortizationSchedule(
  principal: number,
  rate: number,
  payment: number,
  maxMonths: number = 360
): AmortizationEntry[] {
  const schedule: AmortizationEntry[] = [];
  let balanceCents = toCents(principal);
  const monthlyRate = rate / 12;
  const paymentCents = toCents(payment);

  if (paymentCents <= 0 || balanceCents <= 0) return schedule;

  let month = 0;
  while (balanceCents > 0 && month < maxMonths) {
    month++;

    const interestCents = Math.round(balanceCents * monthlyRate);

    // If payment doesn't cover interest, record the shortfall and stop
    if (interestCents >= paymentCents) {
      balanceCents = balanceCents + interestCents - paymentCents;
      schedule.push({
        month,
        payment: toDollars(paymentCents),
        principal: 0,
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

    if (balanceCents <= 0) break;
  }

  return schedule;
}

// ==========================================
// PAYOFF STRATEGIES
// ==========================================

/**
 * Simulate a multi-debt payoff strategy given debts in priority order.
 * Supports payment rollover (freed-up minimums accelerate remaining debts).
 * Pure function — no signals, no events.
 *
 * @param sortedDebts Debts in priority order (first = focus debt)
 * @param extraMonthly Extra monthly payment beyond all minimums
 * @param config Optional simulation configuration
 */
export function simulatePayoffStrategy(
  sortedDebts: ReadonlyArray<DebtInput>,
  extraMonthly: number = 0,
  config?: SimulationConfig
): StrategyResult {
  const opts = {
    interestTiming: 'mid_month' as const,
    enableRollover: true,
    ...config
  };

  if (!sortedDebts.length || sortedDebts.every(d => d.balance <= 0)) {
    return { months: 0, totalInterest: 0, order: [], schedule: [], totalReleased: 0, paymentAcceleration: 0 };
  }

  // Clone debts with cents balances
  const states = sortedDebts
    .filter(d => d.balance > 0 && d.isActive !== false)
    .map(d => ({
      id: d.id,
      name: d.name,
      balanceCents: toCents(d.balance),
      rateCents: d.interestRate / 12,
      minPaymentCents: toCents(d.minimumPayment),
      paidOffMonth: null as number | null
    }));

  const baseExtraCents = toCents(extraMonthly);
  let totalInterestCents = 0;
  let month = 0;
  let totalReleasedCents = 0;
  const maxMonths = 1200;
  const order: DebtPayoffOrder[] = [];
  const schedule: PayoffScheduleEntry[] = [];

  while (states.some(d => d.balanceCents > 0) && month < maxMonths) {
    month++;
    let monthInterest = 0;
    let availableExtraCents = baseExtraCents + (opts.enableRollover ? totalReleasedCents : 0);
    let monthlyReleasedCents = 0;

    // Focus debt = first with balance > 0
    const focusIdx = states.findIndex(d => d.balanceCents > 0);

    for (let idx = 0; idx < states.length; idx++) {
      const debt = states[idx];
      if (debt.balanceCents <= 0 || debt.paidOffMonth !== null) continue;

      let interestCents: number;

      // Apply interest timing strategy
      if (opts.interestTiming === 'mid_month') {
        const minPayment = Math.min(debt.minPaymentCents, debt.balanceCents);
        const avgBalance = debt.balanceCents - (minPayment / 2);
        interestCents = Math.round(Math.max(0, avgBalance) * debt.rateCents);
      } else if (opts.interestTiming === 'after_payment') {
        const minPayment = Math.min(debt.minPaymentCents, debt.balanceCents);
        const effectiveBalance = debt.balanceCents - minPayment;
        interestCents = Math.round(Math.max(0, effectiveBalance) * debt.rateCents);
      } else {
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

        if (opts.enableRollover) {
          monthlyReleasedCents += debt.minPaymentCents;
        }
      }
    }

    totalReleasedCents += monthlyReleasedCents;
    totalInterestCents += monthInterest;

    // Record monthly snapshot (first 60 months for charts)
    if (month <= 60) {
      const totalBalance = states.reduce((s, d) => s + d.balanceCents, 0);
      schedule.push({
        month,
        totalBalance: toDollars(totalBalance),
        interest: toDollars(monthInterest),
        availableExtra: toDollars(baseExtraCents + totalReleasedCents),
        releasedThisMonth: toDollars(monthlyReleasedCents)
      });
    }

    // Safety check for negative amortization
    const activeDebts = states.filter(d => d.balanceCents > 0);
    if (activeDebts.length > 0 && month > 12) {
      const hasNegAmort = activeDebts.some((d, i) => {
        const monthlyInterest = Math.round(d.balanceCents * d.rateCents);
        const totalPayment = d.minPaymentCents + (i === 0 ? availableExtraCents : 0);
        return monthlyInterest >= totalPayment;
      });
      if (hasNegAmort) break;
    }
  }

  return {
    months: month,
    totalInterest: toDollars(totalInterestCents),
    order,
    schedule,
    totalReleased: toDollars(totalReleasedCents),
    paymentAcceleration: opts.enableRollover ? toDollars(totalReleasedCents) : 0
  };
}

/**
 * Compare avalanche vs snowball strategies.
 * Pure function — takes debts and extra monthly payment, returns comparison.
 */
export function compareStrategies(
  debts: ReadonlyArray<DebtInput>,
  extraPayment: number = 0,
  config?: SimulationConfig
): StrategyComparison {
  const activeDebts = debts.filter(d => d.balance > 0 && d.isActive !== false);

  // Snowball: smallest balance first
  const snowballOrder = [...activeDebts].sort((a, b) => a.balance - b.balance);
  const snowball = simulatePayoffStrategy(snowballOrder, extraPayment, config);

  // Avalanche: highest interest first
  const avalancheOrder = [...activeDebts].sort((a, b) => b.interestRate - a.interestRate);
  const avalanche = simulatePayoffStrategy(avalancheOrder, extraPayment, config);

  const interestSaved = snowball.totalInterest - avalanche.totalInterest;
  const timeDiff = snowball.months - avalanche.months;

  // Recommendation logic
  let recommended: 'avalanche' | 'snowball';
  if (interestSaved > 500) {
    recommended = 'avalanche';
  } else if (interestSaved < 100 && timeDiff < 6) {
    recommended = 'snowball';
  } else {
    recommended = interestSaved > 100 ? 'avalanche' : 'snowball';
  }

  return {
    snowball,
    avalanche,
    interestSaved,
    timeDiff,
    recommended
  };
}

// ==========================================
// PROGRESS TRACKING
// ==========================================

/**
 * Calculate progress for a single debt.
 * Pure function — takes balance info, returns progress.
 */
export function calculateDebtProgress(
  currentBalance: number,
  originalBalance: number
): DebtProgressResult {
  const originalCents = toCents(originalBalance);
  const currentCents = toCents(currentBalance);
  const paidCents = originalCents - currentCents;

  const percentComplete = originalCents > 0
    ? Math.round((paidCents / originalCents) * 100)
    : 100;

  return {
    original: originalBalance,
    current: currentBalance,
    paid: toDollars(paidCents),
    percentComplete: Math.max(0, Math.min(100, percentComplete))
  };
}

/**
 * Calculate summary across all debts.
 * Pure function — takes array of debts, returns aggregate summary.
 */
export function calculateDebtSummary(
  debts: ReadonlyArray<DebtInput>
): DebtSummaryResult {
  const activeDebts = debts.filter(d => d.isActive !== false);

  if (!activeDebts.length) {
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

  for (const d of activeDebts) {
    const balCents = toCents(d.balance);
    totalBalanceCents += balCents;
    totalOriginalCents += toCents(d.originalBalance);
    totalMinimumCents += toCents(d.minimumPayment);
    weightedRateSum += balCents * d.interestRate;
  }

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
    debtCount: activeDebts.length,
    monthlyMinimum: toDollars(totalMinimumCents),
    avgInterestRate: totalBalanceCents > 0
      ? weightedRateSum / totalBalanceCents
      : 0
  };
}
