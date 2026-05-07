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
  /**
   * 7l (debt domain parity): mirrors `PayoffInfo.cannotPayOff` in the
   * feature layer (`types/index.ts:134`). True when the monthly payment
   * doesn't cover monthly interest accrual and the debt is projected to
   * grow forever. Callers should treat `months === Infinity` +
   * `cannotPayOff === true` as "explicitly unpayable at current rate",
   * distinct from `payment <= 0` (no payment committed).
   */
  cannotPayOff?: boolean;
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
  /**
   * 7l (debt domain parity): mirrors `PayoffStrategyResult.cannotPayOff`
   * in the feature layer (`types/index.ts:186`). True when the strategy
   * cannot fully amortize one or more debts — i.e., the simulation
   * bailed on observed negative amortization.
   */
  cannotPayOff?: boolean;
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

    // 7l (debt domain parity): detect negative amortization on the first
    // iteration, not after 12 months. Mirrors the feature-layer fix in
    // `debt-planner.ts:calculatePayoffDate`. Because `balanceCents` never
    // decreases when `interestCents >= paymentCents`, the condition is
    // monotonically stable — bailing on month 1 is correct and prevents
    // the prior implementation from inflating `totalInterest` by up to a
    // year's worth of phantom projected interest before returning
    // Infinity.
    if (interestCents >= paymentCents) {
      return { months: Infinity, totalInterest: Infinity, payoffDate: null, cannotPayOff: true };
    }

    totalInterestCents += interestCents;

    const newBalance = balanceCents + interestCents - paymentCents;
    balanceCents = Math.max(0, newBalance);
    months++;
  }

  // Fixes H11 (Inline-Behavior-Review rev 12): setDate(1) first so a
  // payoff projection generated on the 31st doesn't overflow into a
  // later month (e.g. Jan 31 + 1 month silently lands on Mar 3).
  const payoffDate = new Date();
  payoffDate.setDate(1);
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

    // 7l (debt domain parity): mirror the feature-layer fix in
    // `debt-planner.ts:generateAmortizationSchedule`. Emit a row that
    // satisfies the `payment = principal + interest` identity — the prior
    // shape reported `interest = interestCents` (accrued) while `payment
    // = paymentCents` (paid), which chart code consuming
    // `entry.interest` double-counted as "interest paid this period."
    // New shape: `interest` == what this payment actually covered
    // (`paymentCents`); `principal` == 0; `balance` reflects the
    // capitalized unpaid interest so the negative amortization is
    // visible in the balance column instead.
    if (interestCents >= paymentCents) {
      balanceCents = balanceCents + interestCents - paymentCents;
      schedule.push({
        month,
        payment: toDollars(paymentCents),
        principal: 0,
        interest: toDollars(paymentCents),
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
  let cannotPayOff = false;

  while (states.some(d => d.balanceCents > 0) && month < maxMonths) {
    month++;
    let monthInterest = 0;
    let availableExtraCents = baseExtraCents + (opts.enableRollover ? totalReleasedCents : 0);
    let monthlyReleasedCents = 0;

    // 7l (debt domain parity): snapshot start-of-month balances so neg-am
    // detection compares end-of-month vs start-of-month for each debt
    // rather than heuristically comparing interest to a stale "min +
    // leftover extra" figure. Mirrors the feature-layer fix in
    // `debt-planner.ts:simulatePayoffStrategy`.
    const monthStartBalances = new Map<string, number>(
      states.map(d => [d.id, d.balanceCents])
    );

    // Focus debt = first with balance > 0
    const focusIdx = states.findIndex(d => d.balanceCents > 0);

    // 7l (debt domain parity): apply interest + minimums in pass 1, then
    // cascade leftover extra across remaining debts in priority order in
    // pass 2, then mark payoff + rollover in pass 3. Mirrors the three-
    // pass restructure in `debt-planner.ts:simulatePayoffStrategy`. The
    // old one-pass shape gated extra on `idx === focusIdx`, stranding any
    // extra that exceeded the focus debt's remaining balance — the
    // strategy under-delivered on its own promise, especially in the
    // last month of each debt's payoff.
    for (let idx = 0; idx < states.length; idx++) {
      const debt = states[idx];
      if (!debt || debt.balanceCents <= 0 || debt.paidOffMonth !== null) continue;

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
    }

    // Pass 2: cascade leftover extra across remaining debts in priority order.
    for (let idx = focusIdx; idx >= 0 && idx < states.length && availableExtraCents > 0; idx++) {
      const debt = states[idx];
      if (!debt || debt.balanceCents <= 0 || debt.paidOffMonth !== null) continue;
      const extraApplied = Math.min(availableExtraCents, debt.balanceCents);
      debt.balanceCents -= extraApplied;
      availableExtraCents -= extraApplied;
    }

    // Pass 3: finalize payoff + rollover releases after all payments land.
    for (const debt of states) {
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

    // 7l (debt domain parity): observed neg-am — bail when no active debt
    // saw its balance decrease this month. Mirrors feature-layer fix:
    // strictly more accurate than the old "interest >= min + leftover-
    // extra" heuristic, and drops the arbitrary 12-month warmup. Infinite
    // growth is caught immediately while the simulation is still allowed
    // to run for profiles where rollover eventually unlocks later debts.
    const activeDebts = states.filter(d => d.balanceCents > 0);
    const allDebtsNegAm = activeDebts.length > 0 && activeDebts.every(d => {
      const start = monthStartBalances.get(d.id) ?? 0;
      return d.balanceCents >= start;
    });
    if (allDebtsNegAm) {
      cannotPayOff = true;
      break;
    }
  }

  return {
    months: month,
    totalInterest: toDollars(totalInterestCents),
    order,
    schedule,
    totalReleased: toDollars(totalReleasedCents),
    paymentAcceleration: opts.enableRollover ? toDollars(totalReleasedCents) : 0,
    cannotPayOff
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
