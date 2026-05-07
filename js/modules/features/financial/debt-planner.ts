/**
 * Debt Payoff Planner Module
 *
 * Comprehensive debt tracking, payoff strategy calculations, and progress visualization.
 * Debt payments are integrated with transactions for unified expense tracking.
 */
'use strict';

import { SK, persist } from '../../core/state.js';
import * as signals from '../../core/signals.js';
import { userCategoryConfig } from '../../core/category-store.js';
import { debts } from '../../core/state-actions.js';
import { toCents, toDollars, parseAmount, generateId, getTodayStr, fmtCur, parseLocalDate } from '../../core/utils-pure.js';
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
 * Debt payment category IDs per preset.
 * Each preset has its own namespaced ID so migration works correctly.
 */
const DEBT_PAYMENT_IDS: Record<string, string> = {
  personal: 'debt_payment',
  household: 'debt_payment_hh',
  freelancer: 'debt_payment_fl',
  business: 'debt_payment_biz'
};

/**
 * Resolve the debt-payment category id that should be used for a new debt
 * payment transaction.
 *
 * CR-Apr22-B slice 3 finding: the prior implementation assumed the
 * preset-provided debt_payment category still existed in the user's config.
 * Three scenarios violated that assumption and produced phantom category
 * references on freshly-recorded debt payments (transactions rendering as
 * "Unknown ❓" in the ledger):
 *
 *   1. User deleted `debt_payment` via category-manager. CR-Apr22-B slice 1's
 *      `deleteCategoryWithCleanup` sweep remapped EXISTING transactions to
 *      the fallback, but newly-created debt payments kept going to the
 *      phantom id because `recordPayment` didn't re-check existence.
 *   2. User's preset is not in `DEBT_PAYMENT_IDS` (future preset added
 *      without updating the map, or a corrupted `presetId`). The prior
 *      hardcoded fallback `'debt_payment'` is the personal-preset id and
 *      doesn't exist on business/household/freelance configs.
 *   3. Cross-preset leakage: user switched presets but the in-config
 *      debt_payment id belongs to the previous preset (e.g. `debt_payment_hh`
 *      under `presetId: 'personal'` after a mid-migration failure).
 *
 * Resolution tiers — each step preserves data integrity without overriding
 * the user's delete intent (we never auto-re-add a category the user removed):
 *
 *   A. Preset-mapped id IS present in current config → return it, hidden or
 *      not. The id itself is sound; visibility is a rendering concern that
 *      `toggleCategoryVisibility` owns, and the tx will re-surface the
 *      moment the user unhides the category.
 *   B. Preset-mapped id missing → scan config for any id starting with
 *      `debt_payment` (handles cross-preset leakage).
 *   C. No `debt_payment*` id anywhere → fall back to a visible `other*`
 *      expense cat (same tier-1 heuristic as `pickFallbackCategoryId`).
 *   D. No visible `other*` → first visible expense cat.
 *   E. All expense cats hidden → first expense cat regardless of hidden.
 *   F. Config has zero expense cats (corruption) → return the preset-mapped
 *      id as-is so the upstream tx create fails loudly rather than silently
 *      mis-assigning.
 */
export function getDebtPaymentCategoryId(): string {
  const config = userCategoryConfig.value;
  const presetId = config?.presetId || 'personal';
  const targetId = DEBT_PAYMENT_IDS[presetId] || 'debt_payment';

  if (!config) return targetId;

  const expense = config.expense;

  // A. Happy path — preset-mapped id present.
  if (expense.some(c => c.id === targetId)) return targetId;

  // B. Cross-preset debt_payment* salvage.
  const anyDebtPayment = expense.find(c => c.id.startsWith('debt_payment'));
  if (anyDebtPayment) {
    if (import.meta.env.DEV) {
      console.warn(
        `[debt-planner] Preset "${presetId}" expected "${targetId}" but ` +
        `found "${anyDebtPayment.id}" — using that id instead.`
      );
    }
    return anyDebtPayment.id;
  }

  // C. Visible "other*" fallback — matches pickFallbackCategoryId tier 1.
  const visibleOther = expense.find(c => c.id.startsWith('other') && !c.hidden);
  if (visibleOther) {
    if (import.meta.env.DEV) {
      console.warn(
        `[debt-planner] No debt_payment category in config — routing ` +
        `payment to visible fallback "${visibleOther.id}".`
      );
    }
    return visibleOther.id;
  }

  // D. First visible expense cat.
  const firstVisible = expense.find(c => !c.hidden);
  if (firstVisible) {
    if (import.meta.env.DEV) {
      console.warn(
        `[debt-planner] No debt_payment / other category — routing payment ` +
        `to first visible expense cat "${firstVisible.id}".`
      );
    }
    return firstVisible.id;
  }

  // E. All hidden — return first expense cat regardless.
  const firstAny = expense[0];
  if (firstAny) return firstAny.id;

  // F. Config has zero expense cats. Fall through to the preset-mapped id;
  // upstream tx create will surface the not-found as an explicit error.
  return targetId;
}

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
  /**
   * Explicit re-baseline of the debt's original balance. Rare — used when
   * the user consolidates, refinances, or corrects a mis-entered starting
   * balance. Normal payments should leave this alone so `getDebtProgress`
   * keeps its "how much has been paid down" meaning.
   */
  originalBalance?: number | string;
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
// INPUT NORMALIZERS
// ==========================================

/**
 * Normalize `interestRate` input to a clamped [0, 1] fraction.
 *
 * Phase 5g-4 Slice 1 (Inline-Behavior-Review rev 12, L23): replaces the
 * `Math.max(0, Math.min(1, parseFloat(String(x ?? 0)) || 0))` masking
 * default at addDebt / updateDebt. The prior form silently coerced every
 * unparseable value (`NaN`, whitespace-only strings, `undefined`) to
 * `0` — and in the debt domain a `0` APR renders as "interest-free"
 * while interest silently accrues on the real balance. Arguably a worse
 * lie than rollover's silent zero (L23 explicitly called out this
 * "interest-free" UI misread).
 *
 * Behavior:
 *   - `undefined` / `null` / `''`     → `0` (empty input means "no APR captured yet").
 *   - finite number in `[0, 1]`      → pass-through.
 *   - finite number outside `[0, 1]` → clamped, DEV-warn.
 *   - `NaN` / `Infinity` / unparseable → `0`, DEV-warn.
 *
 * The UI layer (`debt-ui-handlers.ts` saveDebtButton handler) is the
 * primary gatekeeper — it validates interest-rate input against the
 * percent scale (0-100) BEFORE calling addDebt/updateDebt, and shows a
 * user-visible toast on invalid input. This helper is the
 * defense-in-depth safety net for non-UI callers (event-bus dispatch
 * via FeatureEvents.ADD_DEBT, `sample-data.ts` seeder, any future API
 * or import path). Same separation-of-concerns shape as `setMaxRollover`
 * shipped in Phase 5g-3 Slice 3 (`rollover.ts:140`).
 */
function normalizeInterestRate(value: number | string | undefined | null): number {
  if (value === undefined || value === null || value === '') return 0;
  const parsed = typeof value === 'number' ? value : parseFloat(String(value));
  if (!Number.isFinite(parsed)) {
    if (import.meta.env.DEV) {
      console.warn('debt-planner.normalizeInterestRate: non-finite value, using 0% APR', value);
    }
    return 0;
  }
  if (parsed < 0 || parsed > 1) {
    if (import.meta.env.DEV) {
      console.warn(`debt-planner.normalizeInterestRate: ${parsed} outside [0, 1], clamping`);
    }
  }
  return Math.max(0, Math.min(1, parsed));
}

/**
 * Normalize `dueDay` input to a clamped [1, 31] integer.
 *
 * Phase 5g-4 Slice 1 (Inline-Behavior-Review rev 12, L23): companion to
 * `normalizeInterestRate`, replacing the sibling masking default at
 * `addDebt:155` + `updateDebt:184`. The prior form silently coerced any
 * unparseable due-day to `1` — so a user who typed "abc" or "0" or
 * "32" would see their debt mysteriously billed on the 1st of every
 * month with no feedback.
 *
 * Behavior:
 *   - `undefined` / `null` / `''`     → `1` (sensible default for "no day captured yet").
 *   - finite integer in `[1, 31]`    → pass-through (fractional values truncated).
 *   - finite integer outside `[1, 31]` → clamped, DEV-warn.
 *   - `NaN` / `Infinity` / unparseable → `1`, DEV-warn.
 *
 * Note `parseInt` without radix on browser input can silently treat
 * `"010"` as octal in some engines — this helper uses explicit radix 10
 * and `Math.trunc` on numeric input to match the intent.
 */
export function normalizeDueDay(value: number | string | undefined | null): number {
  if (value === undefined || value === null || value === '') return 1;
  const parsed = typeof value === 'number' ? Math.trunc(value) : parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) {
    if (import.meta.env.DEV) {
      console.warn('debt-planner.normalizeDueDay: non-finite value, using day 1', value);
    }
    return 1;
  }
  if (parsed < 1 || parsed > 31) {
    if (import.meta.env.DEV) {
      console.warn(`debt-planner.normalizeDueDay: ${parsed} outside [1, 31], clamping`);
    }
  }
  return Math.max(1, Math.min(31, parsed));
}

// ==========================================
// DATA MANAGEMENT
// ==========================================

/**
 * Get all active debts
 *
 * rev 12 / #39 M2: `(signals.debts.value as Debt[]) || []` guard removed —
 * `signals.debts` is `signal<Debt[]>(...)` at `signals.ts:139`, non-nullable
 * by contract, so the cast + `|| []` fallback were dead defensive noise.
 */
export function getDebts(): Debt[] {
  return signals.debts.value.filter(d => d.isActive !== false);
}

/**
 * Get all debts including inactive
 */
export function getAllDebts(): Debt[] {
  return signals.debts.value;
}

/**
 * Get a single debt by ID
 */
export function getDebt(debtId: string): Debt | null {
  return signals.debts.value.find(d => d.id === debtId) ?? null;
}

/**
 * Add a new debt
 */
export function addDebt(debtData: DebtData): Debt {
  const balanceValue = debtData.balance ?? 0;
  const debt: Debt = {
    id: `debt_${generateId()}`,
    name: ((debtData.name || 'Untitled Debt').trim()).slice(0, 100),
    // Phase 6 Slice 1i (rev 12 L6): `DEBT_TYPES[key]` now returns
    // `DebtType | undefined`. Chain through the fallbacks and pin
    // the final default to `DEBT_TYPES.OTHER` so the result is a
    // concrete `DebtType`.
    type: (DEBT_TYPES[debtData.type as string] ?? (debtData.type as DebtType | undefined) ?? DEBT_TYPES.OTHER) as DebtType,
    balance: parseAmount(balanceValue),
    originalBalance: parseAmount(debtData.originalBalance ?? balanceValue),
    interestRate: normalizeInterestRate(debtData.interestRate),
    minimumPayment: parseAmount(debtData.minimumPayment ?? 0),
    dueDay: normalizeDueDay(debtData.dueDay),
    createdAt: new Date().toISOString(),
    payments: [],
    isActive: true
  };

  // rev 12 / #39 M2: removed dead `const currentDebts = (signals.debts.value
  // as Debt[]) || []` local — assigned but never read; the add flow routes
  // through `debts.addDebt()` which reads the signal directly.
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
  if (updates.name !== undefined) {
    // CR-Apr22-G slice 4: rename-safe history. When the name ACTUALLY
    // changes, prepend the prior name onto historicalNames so the tx
    // detail panel's debt drill-down can still find legacy payment rows
    // whose descriptions encode the older name (see
    // transaction-detail-panel.ts debtTransactions). No-op if the
    // trimmed/clamped new name is empty or equal to the current name —
    // prevents the history log from accumulating duplicates on repeated
    // form saves that don't change the name.
    const trimmedNewName = updates.name.trim().slice(0, 100);
    if (trimmedNewName.length > 0 && trimmedNewName !== debt.name) {
      const priorHistory = debt.historicalNames ?? [];
      updatedDebt.historicalNames = [debt.name, ...priorHistory];
    }
    updatedDebt.name = trimmedNewName;
  }
  if (updates.type !== undefined) updatedDebt.type = updates.type;
  if (updates.balance !== undefined) updatedDebt.balance = parseAmount(updates.balance);
  if (updates.interestRate !== undefined) updatedDebt.interestRate = normalizeInterestRate(updates.interestRate);
  if (updates.minimumPayment !== undefined) updatedDebt.minimumPayment = parseAmount(updates.minimumPayment);
  if (updates.dueDay !== undefined) updatedDebt.dueDay = normalizeDueDay(updates.dueDay);

  // 7l (debt planner live item 1): keep `originalBalance` consistent with
  // `balance`. Two cases to handle; both previously let the baseline drift
  // and corrupt `getDebtProgress`:
  //
  //   a. Explicit re-baseline — the caller passes `originalBalance`
  //      (refinance, consolidation, correcting a mis-entered starting
  //      value). Honor it verbatim after normalization.
  //
  //   b. Implicit upward revision — the caller raised `balance` above the
  //      previously-captured `originalBalance` (new charges on a credit
  //      card, a balance-transfer that grew the debt, etc.). Without a
  //      fresh baseline, `paid = original - current` goes negative and
  //      `percentComplete` clamps to 0 with no explanation. Snap
  //      `originalBalance` up to the new floor so future payments are
  //      measured against a realistic starting point.
  //
  // Downward balance changes do NOT shift the baseline — that's the
  // normal "payment reduced the balance" path, and the progress math
  // depends on the old, higher original. Same separation-of-concerns
  // rationale as `addDebt` using `debtData.originalBalance ?? balanceValue`.
  if (updates.originalBalance !== undefined) {
    updatedDebt.originalBalance = parseAmount(updates.originalBalance);
  } else if (updates.balance !== undefined && updatedDebt.balance > updatedDebt.originalBalance) {
    updatedDebt.originalBalance = updatedDebt.balance;
  }

  // rev 12 / #39 M2: removed dead `const currentDebts = (signals.debts.value
  // as Debt[]) || []` local — assigned but never read; the replace flow
  // routes through `debts.replaceDebt()` which reads the signal directly.
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
  // rev 12 / #39 M2: `(signals.debts.value as Debt[]) || []` replaced with
  // direct signal read — `signals.debts` is `signal<Debt[]>(...)`.
  const debtToRemove = signals.debts.value.find(d => d.id === debtId);
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
    // rev 12 / #39 M2: `(signals.debts.value as Debt[]) || []` replaced with
    // direct signal read — `signals.debts` is `signal<Debt[]>(...)`.
    this.originalDebt = signals.debts.value.find(d => d.id === this.debtId) ?? null;

    if (!this.originalDebt) throw new Error('Debt not found');

    // 7l (debt planner live item 2): reject payments against archived debts.
    //
    // `deleteDebt` is a soft-delete (`isActive: false`), so an archived debt
    // still exists in `signals.debts`. Without this guard, a stale UI click
    // or an event-bus dispatch against a recently-archived debt would mint
    // a new transaction, mutate the soft-deleted debt's `balance` + payment
    // history, and emit DEBT_PAYMENT — making the debt look "alive" in
    // summary widgets and dashboards. Matches the same defensive posture as
    // the archived-debt checks in the strategy/progress surfaces
    // (`getDebts` filters `isActive !== false`).
    if (this.originalDebt.isActive === false) {
      throw new Error('Cannot record payment on an archived debt');
    }

    // 1. Calculate portions
    //
    // CR-Apr24-A2 [P2] finding 24: prorate the interest allocation by the
    // number of days elapsed since the last interest accrual, instead of
    // charging a full month of interest on every recorded payment. Pre-fix,
    // a user making four payments in a single month got four full-month
    // interest allocations applied — the principal-vs-interest split on
    // each recorded payment was wildly wrong and the notes string
    // ("Principal: $X, Interest: $Y") was misleading.
    //
    // Elapsed-day source:
    //  1. `lastInterestAccrualDate` (written on every successful payment, see
    //     step 3 below). Present on all debts created after this slice ships.
    //  2. `createdAt` fallback for pre-existing debts without the field —
    //     means the first post-upgrade payment accrues interest from debt
    //     creation, which is the most conservative choice (never over-charges).
    //  3. Safety fallback to the payment date itself (zero days elapsed →
    //     zero interest) for malformed records.
    //
    // Cap at 31 days. Users who go >1 month between payments shouldn't be
    // charged multi-month accumulated interest on a single payment —
    // that's what the amortization schedule is for. The cap keeps the
    // per-payment interest allocation bounded at its original
    // "full monthly interest" max, so this change only REDUCES
    // interest allocations relative to the pre-fix behavior — never
    // increases them.
    const monthlyRate = this.originalDebt.interestRate / 12;
    const fullMonthInterestCents = Math.round(toCents(this.originalDebt.balance) * monthlyRate);

    const accrualAnchorStr = this.originalDebt.lastInterestAccrualDate
      ?? this.originalDebt.createdAt
      ?? this.date;
    const anchorDate = parseLocalDate(accrualAnchorStr);
    const paymentDateObj = parseLocalDate(this.date);
    const msPerDay = 1000 * 60 * 60 * 24;
    const rawDaysElapsed = Math.max(
      0,
      Math.round((paymentDateObj.getTime() - anchorDate.getTime()) / msPerDay)
    );
    // Cap at 30 days so the maximum per-payment interest exactly equals
    // one full month's interest (matches pre-fix behavior as the upper
    // bound). A payment after a 6-month gap doesn't charge 6x monthly
    // interest on the historical balance — projecting historical
    // interest retroactively from the current balance is the
    // amortization schedule's job, not this per-payment accrual's.
    // 30-day cap keeps this change strictly INTEREST-REDUCING relative
    // to pre-fix (never increasing), so it's a safe upgrade for any
    // existing debt regardless of migration-default edge cases.
    const daysElapsed = Math.min(30, rawDaysElapsed);
    // Prorate: zero days → zero interest (same-day repeat payment),
    // 30 days → full monthly interest (linear within the cap).
    const interestCents = Math.round(fullMonthInterestCents * (daysElapsed / 30));

    // CR-Apr24-A1 [P2] finding 25: cap payments at (balance + prorated interest).
    // Before this guard, the operation silently accepted overpayments — the
    // principal allocation clamped `max(0, balance - principal)` so the
    // DEBT was fine (zeroed out), but the `amount`-sized transaction still
    // posted and the user's ledger / insights reflected that full amount as
    // "debt payment". A user paying $1,000 against a $500 debt got a $1,000
    // expense row when only $500 was actually needed — $500 of their
    // ledger became ghost spend against a phantom principal contribution.
    // Rejecting here surfaces the error to the debt-payment modal, which
    // can then prompt the user to enter the correct payoff amount.
    const maxPaymentCents = toCents(this.originalDebt.balance) + interestCents;
    const requestedCents = toCents(this.amount);
    if (requestedCents > maxPaymentCents) {
      throw new Error(
        `Payment exceeds remaining balance. Pay up to ${fmtCur(toDollars(maxPaymentCents))} to fully close this debt.`
      );
    }

    const principalCents = Math.max(0, requestedCents - interestCents);

    // 2. Create transaction via SDK
    const txResult = await dataSdk.create({
      type: 'expense',
      category: getDebtPaymentCategoryId(),
      amount: this.amount,
      description: `${this.originalDebt.name} payment`,
      date: this.date,
      notes: `Principal: ${fmtCur(toDollars(principalCents))}, Interest: ${fmtCur(toDollars(interestCents))}`,
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
      payments: [...this.originalDebt.payments, payment],
      // CR-Apr24-A2 [P2] finding 24: stamp the accrual anchor forward so
      // the NEXT payment prorates from this payment's date rather than
      // from `createdAt` or the previous `lastInterestAccrualDate`.
      // Essential for the prorate math to work correctly across a
      // payment sequence: four $50 payments in one month should
      // collectively charge ~one month of interest (the sum of the
      // prorated per-payment portions), not four months.
      lastInterestAccrualDate: this.date
    };

    // Apply update to signals
    debts.replaceDebt(this.debtId, this.updatedDebt);
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
      // rev 12 / #39 M2: removed dead `const currentDebts = (signals.debts
      // .value as Debt[]) || []` local — assigned but never read.
      debts.replaceDebt(this.debtId, this.originalDebt);
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
      // Phase 6 Slice 1i (rev 12 L6): `results[0]` is now
      // `PaymentResult | undefined` under `noUncheckedIndexedAccess`.
      // Fall back to a structured failure result so the handler
      // return type stays `PaymentResult`.
      // Phase 6 cleanup (no-explicit-any sweep): withTransaction's results
      // arg is `unknown[]` (the operations queue is heterogeneous); cast
      // here since the single op above is statically known to produce a
      // PaymentResult.
      (results) => (results[0] as PaymentResult | undefined) ?? { isOk: false, error: 'Payment operation produced no result' }
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

    // 7l (debt planner live item 3): detect negative amortization on the
    // FIRST iteration, not after 12 months.
    //
    // The prior `&& months > 12` guard let a year of phantom interest
    // accrue into `totalInterestCents` before bailing out — every caller
    // that surfaced `totalInterest` (dashboard, debt card, strategy
    // summary) quoted a year's worth of interest for a payment that can
    // never reduce the balance, inflating "money lost to interest" by up
    // to `12 × balance × rate`. Because `balanceCents` never decreases
    // when `interestCents >= paymentCents`, the condition is stable:
    // once true on month N, it's true on every later month. Bailing
    // immediately is both more correct and strictly safer.
    if (interestCents >= paymentCents) {
      return { months: Infinity, date: null, totalInterest: Infinity, cannotPayOff: true };
    }

    totalInterestCents += interestCents;

    // Apply payment (after interest accrues)
    const newBalance = balanceCents + interestCents - paymentCents;
    balanceCents = Math.max(0, newBalance);
    months++;
  }

  // Calculate payoff date
  // Fixes H11 (Inline-Behavior-Review rev 12): setDate(1) first so a
  // payoff projection generated on the 31st doesn't overflow into a
  // later month (e.g. Jan 31 + 1 month ≠ Mar 3).
  const payoffDate = new Date();
  payoffDate.setDate(1);
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

    // 7l (debt planner live item 4): record a row whose payment, principal,
    // and interest actually sum to the identity `payment = principal +
    // interest`.
    //
    // The prior shape emitted `payment = paymentCents` but `interest =
    // interestCents` (the FULL month's accrued interest, which — in this
    // branch — exceeds `paymentCents`). A summary row that shows
    // `payment = $10` and `interest = $300` is economically incoherent: no
    // payment was made against $300 of interest; $10 was. The rest
    // capitalizes into balance. Chart code that sums `row.interest` across
    // the schedule over-reports interest paid in the negative-amortization
    // month by an amount equal to the shortfall.
    //
    // New shape: `interest` == what this payment actually covered
    // (`paymentCents`), `principal` == 0, and `balance` reflects the
    // capitalized unpaid interest (`balanceCents + interestCents -
    // paymentCents`). Row identity holds: `paymentCents = 0 + paymentCents`.
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
  let cannotPayOff = false; // Track if negative amortization is detected

  while (debtStates.some(d => d.balanceCents > 0) && month < maxMonths) {
    month++;
    let monthInterest = 0;

    // Total available extra = base extra + rollover from paid-off debts
    let availableExtraCents = baseExtraCents + (config.enableRollover ? totalReleasedCents : 0);
    let monthlyReleasedCents = 0; // Track releases this month

    // 7l (debt planner live item 5): snapshot start-of-month balances so
    // post-pass neg-am detection compares like-to-like. A debt is in
    // negative amortization iff its end-of-month balance is >= its
    // start-of-month balance — i.e., interest outran EVERYTHING the user
    // routed to it (min + any cascaded extra). This is tighter and more
    // accurate than the old "interest >= min + stale-extra-leftover" heuristic.
    const monthStartBalances = new Map<string, number>(
      debtStates.map(d => [d.id, d.balanceCents])
    );

    // Find the focus debt (first one with balance > 0)
    const focusIdx = debtStates.findIndex(d => d.balanceCents > 0);

    // 7l (debt planner live item 6): apply interest + minimum payments in
    // pass 1, then cascade any leftover extra across remaining debts in
    // priority order in pass 2.
    //
    // Pre-fix, the extra-payment branch was nested in the per-debt loop
    // and gated on `idx === focusIdx`. If the focus debt's remaining
    // balance was smaller than `availableExtraCents` (e.g., the final
    // month of the focus debt's payoff), the LEFTOVER extra was silently
    // discarded — it never rolled onto the next debt in the priority
    // order, even though by the snowball/avalanche contract that's
    // exactly where it should have gone. Small leftover amounts on the
    // tail end of a focus debt were dropping on the floor every single
    // month, making the simulation systematically understate how fast
    // the payoff actually completes.
    //
    // The two-pass shape cleanly separates concerns: pass 1 handles
    // mandatory per-debt interest + minimums, pass 2 routes the discretionary
    // extra pool by priority and lets leftovers cascade.
    debtStates.forEach(debt => {
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
    });

    // Pass 2: cascade leftover extra across remaining debts in priority order.
    // Starts at `focusIdx` and rolls over to the next debt whenever the
    // current one is fully paid — so `availableExtraCents` is never stranded.
    for (let idx = focusIdx; idx >= 0 && idx < debtStates.length && availableExtraCents > 0; idx++) {
      const debt = debtStates[idx];
      if (!debt || debt.balanceCents <= 0 || debt.paidOffMonth !== null) continue;
      const extraApplied = Math.min(availableExtraCents, debt.balanceCents);
      debt.balanceCents -= extraApplied;
      availableExtraCents -= extraApplied;
    }

    // Pass 3: finalize payoff-this-month tracking + rollover releases.
    // Done after both payment passes so a debt that was finished by the
    // cascaded extra in pass 2 is correctly marked paid-off in the same
    // month (previously, any debt beyond focusIdx was frozen at min-only
    // progress — and any extra surplus that would have tipped it over
    // was wasted).
    debtStates.forEach(debt => {
      if (debt.balanceCents <= 0 && debt.paidOffMonth === null) {
        debt.paidOffMonth = month;
        debt.balanceCents = 0;
        order.push({ id: debt.id, name: debt.name, month });

        // Add freed-up minimum payment to rollover pool
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

    // 7l (debt planner live item 5): detect negative amortization on month 1,
    // not after 12 wasted months.
    //
    // The prior `&& month > 12` guard let a year of phantom projected
    // interest accumulate into `totalInterestCents` before bailing out
    // on a profile that literally cannot amortize. Same rationale as
    // the single-debt calculatePayoffDate fix above.
    //
    // The check is now anchored to observed balance change: a debt is in
    // neg-am iff its end-of-month balance is >= its start-of-month balance
    // (i.e., interest outran the total of min payment AND any cascaded
    // extra that landed on this debt). This is strictly more accurate
    // than the old "minPayment + stale availableExtraCents" approximation,
    // which (a) treated leftover extra after pass 1 as if it applied to
    // the first debt even though that's no longer the case post-cascade,
    // and (b) double-discounted against the focus debt every month.
    const activeDebts = debtStates.filter(d => d.balanceCents > 0);
    const allDebtsNegAm = activeDebts.length > 0 && activeDebts.every(d => {
      const start = monthStartBalances.get(d.id) ?? 0;
      return d.balanceCents >= start;
    });
    if (allDebtsNegAm) {
      if (import.meta.env.DEV) console.warn('Negative amortization detected - payments do not reduce balances');
      cannotPayOff = true;
      break;
    }
  }

  return {
    months: month,
    totalInterest: toDollars(totalInterestCents),
    order,
    schedule,
    totalReleased: toDollars(totalReleasedCents), // New: show total payment acceleration
    paymentAcceleration: config.enableRollover ? toDollars(totalReleasedCents) : 0,
    cannotPayOff
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

  // CR-Apr24-A3 [P2] finding 30: bubble `cannotPayOff` up to the
  // comparison level. The comparison is only "cannot pay off" when BOTH
  // strategies fail — if one works and the other doesn't, the viable
  // strategy is still a valid recommendation and the UI should still
  // render it. Only fold to a top-level failure state when no path home
  // exists.
  const cannotPayOff = (snowball.cannotPayOff ?? false) && (avalanche.cannotPayOff ?? false);

  // Phase 6 Slice 1j (rev 12 L6): conditional spread for
  // `exactOptionalPropertyTypes` — `rolloverImpact` is optional on
  // `StrategyComparison` and is omitted rather than set to `undefined`.
  return {
    snowball,
    avalanche,
    interestSaved,      // Positive = avalanche saves more
    timeDiff,           // Positive = avalanche is faster
    recommended,
    ...(cannotPayOff ? { cannotPayOff: true } : {}),
    ...(config?.enableRollover
      ? {
          rolloverImpact: {
            snowballAcceleration: snowball.paymentAcceleration || 0,
            avalancheAcceleration: avalanche.paymentAcceleration || 0,
            accelerationDifference: (avalanche.paymentAcceleration || 0) - (snowball.paymentAcceleration || 0),
          },
        }
      : {}),
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

  // CR-Apr24-A3 [P2] finding 31: when the simulation detected negative
  // amortization, `result.months` reflects the month the detection fired
  // (usually 1) rather than a real payoff timeline. Computing
  // totalPayments, averageMonthlyPayment, or motivationScore against
  // that truncated timeline quotes numerical insights for a plan that
  // can never pay off — the UI layer was rendering those numbers as if
  // they described a working plan. Collapse all numerical insights to 0
  // when the plan is impossible; the UI is expected to branch on
  // `result.cannotPayOff` and render an explicit failure state instead.
  if (result.cannotPayOff) {
    return {
      result,
      insights: {
        totalPayments: 0,
        averageMonthlyPayment: 0,
        largestPaymentBoost: 0,
        earlyPayoffCount: 0,
        motivationScore: 0
      }
    };
  }

  // rev 12 #16 (cents-math migration): sum balances in integer cents so the
  // `totalPayments = totalBalance + result.totalInterest` headline matches
  // what the user sees on individual debt cards. `result.totalInterest`
  // already comes from a cents-aware amortization path (worker-manager H12,
  // Phase 4b), so converting `totalBalance` brings the addends into the
  // same precision and prevents a stray cent in the strategy summary.
  const totalBalance = toDollars(debts.reduce((sum, d) => sum + toCents(d.balance), 0));
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
export function calculateTotalInterestPaid(debt: Debt): number {
  // rev 12 #16 (cents-math migration): sum payments in integer cents, then
  // derive principalPaid the same way so both sides of the subtraction
  // share precision. Without cents-math, a long payment history (N rows
  // × float add) could accumulate enough drift that `Math.max(0, ...)`
  // silently clamps a real penny of interest to zero — or, worse, flips
  // a $0.00 interest debt to $0.01 in the UI.
  //
  // CR-Apr24-A1 [P2] finding 36: clamp principal-paid at 0 BEFORE the
  // `totalPaid - principalPaid` subtraction. If a debt's balance has
  // grown above its original (neg-amort, manual bump, late fees), the
  // naive `original - current` is negative, and
  // `Math.max(0, totalPaid - (-x))` evaluates to `totalPaid + x` — which
  // *overstates* interest paid by the size of the balance growth. Real
  // rationale: when balance > original, we cannot infer how the payments
  // split between interest vs. new principal charges, so "interest paid"
  // collapses to an upper-bound approximation equal to the total payment
  // history. That is still more faithful than adding the balance-growth
  // delta to the interest total.
  const totalPaidCents = (debt.payments || []).reduce((sum, p) => sum + toCents(p.amount), 0);
  const principalPaidCents = Math.max(0, toCents(debt.originalBalance || 0) - toCents(debt.balance));
  const interestPaidCents = Math.max(0, totalPaidCents - principalPaidCents);
  return toDollars(interestPaidCents);
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

  // CR-Apr24-A1 [P2] finding 34: clamp `paid` at 0 so the UI can't render
  // "-$42 paid" when a debt's balance has grown above its original due to
  // fees, negative amortization, or a manual balance bump. `percentComplete`
  // was already clamped, but the dollar-denominated `paid` field was not,
  // so a card showing `0% paid` could still advertise `-$42 paid` in the
  // progress chip. Also clamps the raw input to the percent calc for
  // consistency — otherwise a future change that stops clamping
  // `percentComplete` regresses to the negative-paid render again.
  const paidCents = Math.max(0, originalCents - currentCents);

  const percentComplete = originalCents > 0
    ? Math.round((paidCents / originalCents) * 100)
    : 100;

  return {
    original: debt.originalBalance,
    current: debt.balance,
    paid: toDollars(paidCents),
    percentComplete: Math.max(0, Math.min(100, percentComplete)),
    paymentsCount: debt.payments?.length || 0,
    // Phase 6 Slice 1i (rev 12 L6): index access returns
    // `DebtPayment | undefined` under `noUncheckedIndexedAccess`.
    // Fold an undefined trailing entry into `null` so the payload
    // stays `DebtPayment | null`.
    lastPayment: debt.payments?.length ? (debt.payments[debt.payments.length - 1] ?? null) : null
  };
}

// ==========================================
// NEXT-STEP RECOMMENDATIONS
// ==========================================

export interface DebtRecommendation {
  text: string;
  priority: 'urgent' | 'focus' | 'info' | 'milestone';
}

/**
 * Generate a contextual "next step" recommendation for a single debt.
 *
 * Priority stack (first match wins):
 *  1. Due date within 7 days
 *  2. Near payoff (≤ 3 months remaining)
 *  3. Strategy focus debt (highest-APR or lowest-balance first target)
 *  4. Progress milestone (25 / 50 / 75 %)
 *  5. Fallback — estimated payoff timeline
 */
export function getNextStepRecommendation(
  debt: Debt,
  allDebts: Debt[]
): DebtRecommendation {
  const now = new Date();
  const progress = getDebtProgress(debt);
  const payoff = calculatePayoffDate(debt);

  // 1. Due-date proximity (within 7 days)
  if (debt.dueDay) {
    const dueDate = getNextDueDate(debt.dueDay, now);
    const daysUntilDue = Math.ceil(
      (dueDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
    );
    if (daysUntilDue >= 0 && daysUntilDue <= 7) {
      const label = daysUntilDue === 0
        ? 'Due today'
        : daysUntilDue === 1
          ? 'Due tomorrow'
          : `Due in ${daysUntilDue} days`;
      return { text: `${label} — ${fmtCur(debt.minimumPayment)} minimum`, priority: 'urgent' };
    }
  }

  // 2. Near payoff (≤ 3 months at current pace)
  if (payoff.months > 0 && payoff.months <= 3 && !payoff.cannotPayOff) {
    const paymentsLeft = payoff.months;
    const label = paymentsLeft === 1 ? '1 payment' : `${paymentsLeft} payments`;
    return {
      text: `Almost free — ${label} left`,
      priority: 'milestone'
    };
  }

  // 3. Strategy focus — is this the #1 target debt?
  const activeDebts = allDebts.filter(d => d.isActive !== false && d.balance > 0);
  if (activeDebts.length >= 2) {
    const highestApr = [...activeDebts].sort((a, b) => b.interestRate - a.interestRate);
    const lowestBalance = [...activeDebts].sort((a, b) => a.balance - b.balance);
    // Phase 6 Slice 1i (rev 12 L6): pull the head debts once — the
    // length >= 2 guard guarantees presence, but the compiler can't
    // see that through `sort()` under `noUncheckedIndexedAccess`.
    const topApr = highestApr[0];
    const topBalance = lowestBalance[0];
    if (!topApr || !topBalance) return { text: 'Keep paying minimums to stay on track', priority: 'info' };

    if (topApr.id === debt.id) {
      const monthlyInterest = debt.balance * (debt.interestRate / 12);
      return {
        text: `Highest rate — ~${fmtCur(monthlyInterest)}/mo in interest`,
        priority: 'focus'
      };
    }
    if (topBalance.id === debt.id && topBalance.id !== topApr.id) {
      return {
        text: `Smallest balance — quickest win to pay off`,
        priority: 'focus'
      };
    }
  }

  // 4. Progress milestones (nearest crossed threshold)
  const pct = progress.percentComplete;
  if (pct >= 75) {
    return { text: `${pct.toFixed(0)}% paid — the finish line is close`, priority: 'milestone' };
  }
  if (pct >= 50) {
    return { text: `${pct.toFixed(0)}% paid — past the halfway mark`, priority: 'milestone' };
  }
  if (pct >= 25) {
    return { text: `${pct.toFixed(0)}% paid — solid progress`, priority: 'milestone' };
  }

  // 5. Fallback — estimated payoff timeline
  if (payoff.cannotPayOff) {
    return { text: 'Payment doesn\u2019t cover interest — increase payment', priority: 'urgent' };
  }
  if (payoff.months === Infinity || !payoff.date) {
    return { text: 'Set a minimum payment to project payoff', priority: 'info' };
  }

  const payoffLabel = payoff.months <= 12
    ? `~${payoff.months} month${payoff.months === 1 ? '' : 's'}`
    : `~${(payoff.months / 12).toFixed(1)} years`;
  return { text: `Payoff in ${payoffLabel} at current pace`, priority: 'info' };
}

/** Next occurrence of a given day-of-month from a reference date */
function getNextDueDate(dueDay: number, from: Date): Date {
  const y = from.getFullYear();
  const m = from.getMonth();
  const d = from.getDate();

  // Clamp dueDay to last day of month
  const lastDay = new Date(y, m + 1, 0).getDate();
  const clamped = Math.min(dueDay, lastDay);

  if (clamped >= d) {
    return new Date(y, m, clamped);
  }
  // Already past this month's due date — next month
  const nextLastDay = new Date(y, m + 2, 0).getDate();
  return new Date(y, m + 1, Math.min(dueDay, nextLastDay));
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
  // CR-Apr24-A1 [P2] finding 35: clamp aggregate `totalPaid` at 0 for the
  // same reason as finding 34 (see getDebtProgress). One debt whose balance
  // has grown above its original could drag the whole-portfolio "paid"
  // summary negative. The percentComplete below gets the same clamp treatment.
  const paidCentsClamped = Math.max(0, totalOriginalCents - totalBalanceCents);
  const totalPaid = toDollars(paidCentsClamped);

  return {
    totalBalance,
    totalOriginal,
    totalPaid,
    percentComplete: totalOriginalCents > 0
      ? Math.round(paidCentsClamped / totalOriginalCents * 100)
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
  on(FeatureEvents.REQUEST_DEBTS, (data: { responseEvent?: string }) => {
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

  // Debt payment category is now built into every preset (debt_payment, debt_payment_hh, etc.)
  // No need to create it as a custom category — getDebtPaymentCategoryId() resolves the correct ID.

  if (import.meta.env.DEV) console.debug('Debt planner feature events initialized');
}
