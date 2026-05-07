/**
 * Daily Allowance Component
 *
 * Reactive component that handles all daily budget-related UI updates:
 * - Hero card daily allowance
 * - Today's budget remaining
 * - Monthly pace indicator
 * - Sidebar daily allowance card
 * - Spending pace indicator
 *
 * @module components/daily-allowance
 */
'use strict';

import { effect, computed } from '@preact/signals-core';
import * as signals from '../core/signals.js';
import { html, render } from '../core/lit-helpers.js';
import { mountEffects, unmountEffects } from '../core/effect-manager.js';
import { fmtCur, parseMonthKey, getMonthKey, getPrevMonthKey, toCents, toDollars } from '../core/utils-pure.js';
import { formatViewedMonthPhrase, formatViewedMonthLabel, formatMonth } from '../core/locale-service.js';
import type { SpendingPaceData } from '../../types/index.js';
import {
  calcTotals,
  getMonthTx,
  getMonthlySavings
} from '../features/financial/calculations.js';
import { isTrackedExpenseTransaction } from '../core/transaction-classification.js';
import DOM from '../core/dom-cache.js';
import { animateValue as animateValueById } from '../orchestration/dashboard-animations.js';
import { openTransactionsForMonthType, revealTransactionsForm } from '../ui/core/ui-navigation.js';

// ==========================================
// COMPUTED SIGNALS
// ==========================================

/**
 * Core metrics for daily allowance calculations
 */
interface DailyMetrics {
  income: number;
  expenses: number;
  savings: number;
  remaining: number;
  daysInMonth: number;
  daysRemaining: number;
  daysElapsed: number;
  dayOfMonth: number;
  isCurrentMonth: boolean;
  isFutureMonth: boolean;
  isPastMonth: boolean;
  dailyAllowance: number;
  todayExpenses: number;
}

const dailyMetrics = computed((): DailyMetrics => {
  const currentMk = signals.currentMonth.value;
  const now = new Date();
  const viewDate = parseMonthKey(currentMk);
  const currentMkNow = getMonthKey(now);
  const isCurrentMonth = currentMkNow === currentMk;
  const isFutureMonth = currentMk > currentMkNow;
  const isPastMonth = currentMk < currentMkNow;
  const daysInMonth = new Date(viewDate.getFullYear(), viewDate.getMonth() + 1, 0).getDate();
  const dayOfMonth = isCurrentMonth ? now.getDate() : (isPastMonth ? daysInMonth : 0);
  const daysElapsed = isCurrentMonth ? dayOfMonth : (isPastMonth ? daysInMonth : 0);
  const daysRemaining = isCurrentMonth ? Math.max(1, daysInMonth - dayOfMonth + 1) : (isFutureMonth ? daysInMonth : 0);

  // Use already-computed totals signal (avoids redundant O(N) transaction scans)
  const income = signals.currentMonthTotals.value.income;
  const expenses = signals.currentMonthTotals.value.expenses;
  const savings = getMonthlySavings(currentMk);

  // Use budget-based calculation when budget allocations exist (consistent with sidebar),
  // falling back to income-based when no budget is set
  const budgetData = signals.dailyAllowanceData.value;
  const hasBudget = budgetData.status !== 'no-budget';

  const remaining = hasBudget ? budgetData.remaining : (income - expenses - savings);
  const dailyAllowance = hasBudget ? budgetData.dailyAllowance : (daysRemaining > 0 ? remaining / daysRemaining : 0);

  // Today's expenses — use currentMonthTx (already filtered, smaller set than full transactions)
  const todayStr = signals.todayStr.value;
  const todayExpensesCents = signals.currentMonthTx.value
    .filter(t => isTrackedExpenseTransaction(t) && t.date === todayStr)
    .reduce((sum, t) => sum + toCents(t.amount), 0);
  const todayExpenses = toDollars(todayExpensesCents);

  return {
    income,
    expenses,
    savings,
    remaining,
    daysInMonth,
    daysRemaining,
    daysElapsed,
    dayOfMonth,
    isCurrentMonth,
    isFutureMonth,
    isPastMonth,
    dailyAllowance,
    todayExpenses
  };
});

/**
 * Spending percent shown in the hero pace label.
 * This is intentionally based on expenses as a share of income for the month.
 */
/** Cap a percentage at 999 for display readability */
function capPercent(pct: number, cap = 999): string {
  return pct > cap ? `>${cap}` : String(pct);
}

const spendingPercent = computed(() => {
  const m = dailyMetrics.value;
  return m.income > 0 ? Math.round((m.expenses / m.income) * 100) : 0;
});

/**
 * Calendar progress used as the pace bar baseline.
 */
const calendarPercent = computed(() => {
  const m = dailyMetrics.value;
  return Math.min(100, Math.round((m.dayOfMonth / m.daysInMonth) * 100));
});

// ==========================================
// HELPER FUNCTIONS
// ==========================================

/**
 * Animate a numeric value on an element (delegates to shared animation utility)
 */
function animateValue(el: HTMLElement, target: number): void {
  if (!el.id) {
    el.textContent = fmtCur(target);
    return;
  }
  animateValueById(el.id, target);
}

/**
 * Set badge status class. Centralizes the repeated stat-badge pattern.
 */
type BadgeStatus = 'positive' | 'negative' | 'neutral' | 'warning';
function setBadge(el: HTMLElement, text: string, status: BadgeStatus): void {
  el.textContent = text;
  el.className = `stat-badge stat-${status} text-xs`;
}

// ==========================================
// COMPONENT MOUNTING
// ==========================================

/**
 * Mount the reactive hero card component
 */
function mountHeroCard(): () => void {
  const heroCardEl = DOM.get('hero-dashboard-card');
  const heroDailyEl = DOM.get('hero-daily-amount');
  const heroAmountCaption = DOM.get('hero-amount-caption');
  const heroDaysEl = DOM.get('hero-days-remaining');
  const heroDaysLabelEl = DOM.get('hero-days-label');
  const heroMotivation = DOM.get('hero-motivation');
  const heroBadge = DOM.get('hero-pace-badge');
  const heroPrimaryAction = DOM.get('hero-primary-action');
  const heroSecondaryAction = DOM.get('hero-secondary-action');
  const incomeCard = DOM.get('dashboard-income-card');
  const expenseCard = DOM.get('dashboard-expense-card');
  const balanceCard = DOM.get('dashboard-balance-card');
  const incomeBadge = DOM.get('income-badge');
  const expenseBadge = DOM.get('expense-badge');
  const balanceEl = DOM.get('total-balance');
  const balanceBadge = DOM.get('balance-badge');
  const heroGuidance = DOM.get('hero-guidance');

  if (!heroDailyEl) {
    return () => {}; // Hero card not present
  }

  const navigateFromHero = (action: string): void => {
    if (action === 'budget') {
      (DOM.get('tab-budget-btn'))?.click();
      // CR-Apr24-I finding 125: guard deferred scroll/focus — bail if the
      // user navigated away from the budget tab before the timer fires.
      window.setTimeout(() => {
        if (signals.activeMainTab.value !== 'budget') return;
        const section = DOM.get('envelope-section');
        section?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        (DOM.get('open-plan-budget'))?.focus();
      }, 80);
      return;
    }
    if (action === 'transactions') {
      (DOM.get('tab-transactions-btn'))?.click();
      // CR-Apr24-I finding 125: guard deferred reveal — bail if the user
      // navigated away from the transactions tab before the timer fires.
      window.setTimeout(() => {
        if (signals.activeMainTab.value !== 'transactions') return;
        revealTransactionsForm('amount', true);
      }, 80);
    }
  };

  const handlePrimaryActionClick = (): void => navigateFromHero(heroPrimaryAction?.dataset.action || 'transactions');
  const handleSecondaryActionClick = (): void => navigateFromHero(heroSecondaryAction?.dataset.action || 'budget');
  const handleIncomeCardClick = (): void => {
    void openTransactionsForMonthType('income');
  };
  const handleExpenseCardClick = (): void => {
    void openTransactionsForMonthType('expense');
  };
  const handleBalanceCardClick = (): void => {
    void openTransactionsForMonthType('all');
  };

  heroPrimaryAction?.addEventListener('click', handlePrimaryActionClick);
  heroSecondaryAction?.addEventListener('click', handleSecondaryActionClick);
  incomeCard?.addEventListener('click', handleIncomeCardClick);
  expenseCard?.addEventListener('click', handleExpenseCardClick);
  balanceCard?.addEventListener('click', handleBalanceCardClick);

  const cleanup = effect(() => {
    const _cur = signals.currency.value;  // subscribe to currency changes
    const m = dailyMetrics.value;
    const dailyBudget = m.income / m.daysInMonth;
    const noActivity = m.income === 0 && m.expenses === 0;
    const noBudget = signals.dailyAllowanceData.value.status === 'no-budget';
    const previousMonthKey = getPrevMonthKey(signals.currentMonth.value);
    const previousIncome = calcTotals(getMonthTx(previousMonthKey)).income;
    // CR-Apr22-G slice 2: route the "long month + year" formatting through
    // the canonical locale service so the label honors the user's chosen
    // locale (`de-DE` → "April 2026" unchanged, `ja-JP` → "2026年4月")
    // rather than resolving to the browser default via
    // `toLocaleDateString(undefined, …)`.
    const monthLabel = formatMonth(parseMonthKey(signals.currentMonth.value));
    // Design-Review-Apr21 P3 (batch 6 follow-up wave L): caption and
    // guidance branches below used to hardcode "this month", but the
    // hero card reactively updates when `signals.currentMonth` moves.
    // `formatViewedMonthPhrase` keeps "this month" at current-view
    // default and swaps in an "in April 2026"-style label when a
    // user navigates to another month — so captions like "Daily
    // room for the rest of this month" become "Daily room for the
    // rest of in April 2026" -> phrased as "Daily room for the rest
    // of April 2026" by inlining without the leading preposition
    // where the carrier sentence already supplies it. See per-line
    // applications below (some use the phrase directly, a few past-
    // /future-month branches use the bare `monthLabel` so the copy
    // stays grammatical ("Set April 2026 up now..." is right where
    // "Set this month up now..." is wrong for the viewed-elsewhere
    // case).
    const monthPhrase = formatViewedMonthPhrase(signals.currentMonth.value);
    // Bare label variant (no "in" preposition) for carrier sentences
    // that already supply their own preposition — "for the rest of
    // {label}" / "categories driving {label}" — where the phrase
    // helper's prepended "in" would produce double-preposition
    // phrasing ("for the rest of in April 2026" ✗).
    const monthLabelOrThis = formatViewedMonthLabel(signals.currentMonth.value);

    // Daily allowance with animation (always re-format on currency change)
    if (noActivity && noBudget) {
      heroDailyEl.textContent = '—';
    } else {
      animateValue(heroDailyEl, m.dailyAllowance);
    }

    // Style based on allowance status
    heroDailyEl.classList.remove('negative', 'warning');
    if (noActivity && noBudget) {
      heroDailyEl.style.color = 'var(--text-tertiary)';
    } else if (m.dailyAllowance < 0) {
      heroDailyEl.style.color = 'var(--color-expense)';
      heroDailyEl.classList.add('negative');
    } else if (m.dailyAllowance < dailyBudget * 0.5) {
      heroDailyEl.style.color = 'var(--color-warning)';
      heroDailyEl.classList.add('warning');
    } else {
      heroDailyEl.style.color = 'var(--color-income)';
    }

    if (heroAmountCaption) {
      if (m.isFutureMonth) {
        // Design-Review-Apr21 P3 (batch 6 follow-up wave O): copy
        // used to read "Projected daily room for the upcoming
        // month", but the month picker lets users browse
        // arbitrarily far ahead — July 2027 is not "the upcoming
        // month". `monthLabel` is already computed above and
        // resolves to "May 2026", "July 2027", etc., keeping the
        // caption accurate regardless of how far out the user is
        // planning.
        heroAmountCaption.textContent = `Projected daily room for ${monthLabel}`;
      } else if (noActivity && noBudget && m.savings > 0) {
        heroAmountCaption.textContent = `${fmtCur(m.savings)} is already set aside, but you still need income or a budget for a daily target`;
      } else if (m.isPastMonth) {
        heroAmountCaption.textContent = `What ${monthLabel} could have supported per day`;
      } else if (noActivity && noBudget) {
        heroAmountCaption.textContent = 'Set a budget or add income to turn this into a real daily target';
      } else if (noBudget) {
        heroAmountCaption.textContent = m.savings > 0
          ? `Estimate based on income, spending, and ${fmtCur(m.savings)} moved to savings`
          : 'Estimate based on income and spending because no budget is set';
      } else if (m.savings > 0) {
        heroAmountCaption.textContent = `Daily room after ${fmtCur(m.savings)} moved to savings ${monthPhrase}`;
      } else {
        heroAmountCaption.textContent = `Daily room for the rest of ${monthLabelOrThis}`;
      }
    }

    if (heroCardEl) {
      let state = 'active';
      if (m.isFutureMonth) state = 'future';
      else if (m.isPastMonth && noActivity) state = 'empty-past';
      else if (noActivity && noBudget) state = 'setup';
      else if (noBudget) state = 'estimate';
      else if (m.remaining < 0) state = 'over';
      else if (m.dailyAllowance < dailyBudget * 0.5) state = 'warning';
      heroCardEl.dataset.heroState = state;
    }

    if (heroDaysEl) {
      heroDaysEl.textContent = String(m.daysRemaining);
    }
    // Design-Review-Apr21 P2 (batch 6 follow-up wave O): `daysRemaining`
    // switches meaning across month states — for a future month it
    // returns the total `daysInMonth`, not a countdown. With a
    // hardcoded "days left in month" suffix, a future-month view
    // read like "30 days left in month" as if a countdown were in
    // progress. For past/future views the value represents the
    // month's calendar length, so flip the suffix to "days in
    // month"; current-month keeps the countdown phrasing.
    if (heroDaysLabelEl) {
      heroDaysLabelEl.textContent = m.isCurrentMonth
        ? 'days left in month'
        : 'days in month';
    }

    // Badge status — synchronized with spending pace indicator
    if (heroBadge) {
      const pace = signals.spendingPaceData.value;
      if (m.isFutureMonth) setBadge(heroBadge, 'New', 'neutral');
      else if (m.isPastMonth && m.income === 0 && m.expenses === 0) setBadge(heroBadge, 'New', 'neutral');
      else if (m.isPastMonth && m.income > 0 && m.expenses > m.income) setBadge(heroBadge, 'Over Budget', 'negative');
      else if (m.isPastMonth && m.income > 0 && m.expenses >= m.income * 0.9) setBadge(heroBadge, 'Tight', 'warning');
      else if (m.isPastMonth) setBadge(heroBadge, 'On Track', 'positive');
      else if (m.income === 0 && m.expenses === 0) setBadge(heroBadge, 'New', 'neutral');
      else if (m.remaining < 0) setBadge(heroBadge, 'Over Budget', 'negative');
      else if (pace.status === 'over') setBadge(heroBadge, 'Over Pace', 'warning');
      else if (m.dailyAllowance < dailyBudget * 0.3) setBadge(heroBadge, 'Caution', 'warning');
      else setBadge(heroBadge, 'On Track', 'positive');
    }

    // Motivational messages + integrated pace status in guidance callout
    if (heroMotivation) {
      const pace = signals.spendingPaceData.value;
      let message = '';
      if (m.isFutureMonth) {
        // isFutureMonth gates on "not current", so `monthLabel` is
        // always a specific month — "Set May 2026 up now..."
        message = `Set ${monthLabel} up now so the first few transactions land inside a real plan.`;
      } else if (m.isPastMonth && noActivity) {
        // isPastMonth likewise guarantees a specific month.
        message = `No activity landed in ${monthLabel}, so there is nothing to review yet.`;
      } else if (noActivity && noBudget && m.savings > 0) {
        message = `Add income or a budget so ${fmtCur(m.savings)} in savings progress turns into a usable plan.`;
      } else if (noActivity && noBudget) {
        message = 'Start with a budget or a first transaction so this dashboard can guide the month.';
      } else if (noBudget) {
        message = m.savings > 0
          ? `Set a budget so this estimate and ${fmtCur(m.savings)} in savings progress work from the same plan.`
          : 'Set a budget to replace this estimate with a real spending target.';
      } else if (m.remaining < 0) {
        message = 'Review the categories driving the overage, then tighten the plan for the rest of the month.';
      } else if (m.savings > 0) {
        message = `Keep logging spending so the ${fmtCur(m.savings)} already set aside stays protected.`;
      } else if (m.daysRemaining <= 3) {
        message = 'Finish the month cleanly by keeping the last few spending decisions intentional.';
      } else if (m.dailyAllowance > dailyBudget * 1.5) {
        message = `You have room ${monthPhrase}. Keep it intentional instead of letting the extra room disappear.`;
      } else if (m.dailyAllowance < dailyBudget * 0.5) {
        message = 'Open Budget or Transactions now to find the pressure point while there is still time to react.';
      } else {
        message = `Stay consistent: keep logging spending and check the categories driving ${monthLabelOrThis}.`;
      }
      heroMotivation.textContent = message;

      // Integrate pace status into guidance callout styling
      if (heroGuidance) {
        heroGuidance.classList.remove('hero-guidance--positive', 'hero-guidance--warning', 'hero-guidance--danger');
        // Remove any existing pace status element
        const existingPace = heroGuidance.querySelector('.hero-guidance__pace');
        if (existingPace) existingPace.remove();

        const isActiveMonth = !m.isFutureMonth && !m.isPastMonth;

        if (isActiveMonth && pace.status === 'over') {
          heroGuidance.classList.add(m.remaining < 0 ? 'hero-guidance--danger' : 'hero-guidance--warning');
          const paceStatusEl = document.createElement('p');
          paceStatusEl.className = 'hero-guidance__pace';
          const iconSpan = document.createElement('span');
          iconSpan.className = 'hero-guidance__pace-icon';
          iconSpan.textContent = '!';
          paceStatusEl.appendChild(iconSpan);
          paceStatusEl.appendChild(document.createTextNode(` ${capPercent(Math.round(pace.difference))}% over pace`));
          heroGuidance.insertBefore(paceStatusEl, heroGuidance.firstChild);
        } else if (isActiveMonth && m.remaining < 0) {
          heroGuidance.classList.add('hero-guidance--danger');
        } else if (isActiveMonth && !noBudget && m.remaining > 0 && (pace.status === 'under' || pace.status === 'on-track')) {
          // All-clear state: budget set, under/on pace, positive balance
          heroGuidance.classList.add('hero-guidance--positive');
        }
      }
    }

    if (heroPrimaryAction && heroSecondaryAction) {
      if (m.isFutureMonth) {
        heroPrimaryAction.textContent = 'Plan Budget';
        heroPrimaryAction.dataset.action = 'budget';
        heroSecondaryAction.textContent = 'Open Ledger';
        heroSecondaryAction.dataset.action = 'transactions';
        heroSecondaryAction.hidden = false;
      } else if (noActivity && noBudget) {
        heroPrimaryAction.textContent = 'Plan Budget';
        heroPrimaryAction.dataset.action = 'budget';
        heroSecondaryAction.textContent = 'Add Transaction';
        heroSecondaryAction.dataset.action = 'transactions';
        heroSecondaryAction.hidden = false;
      } else if (noBudget) {
        heroPrimaryAction.textContent = 'Plan Budget';
        heroPrimaryAction.dataset.action = 'budget';
        heroSecondaryAction.textContent = 'Open Ledger';
        heroSecondaryAction.dataset.action = 'transactions';
        heroSecondaryAction.hidden = false;
      } else if (m.remaining < 0 || m.dailyAllowance < dailyBudget * 0.5) {
        heroPrimaryAction.textContent = 'Review Budget';
        heroPrimaryAction.dataset.action = 'budget';
        heroSecondaryAction.textContent = 'View Transactions';
        heroSecondaryAction.dataset.action = 'transactions';
        heroSecondaryAction.hidden = false;
      } else {
        heroPrimaryAction.textContent = 'Add Transaction';
        heroPrimaryAction.dataset.action = 'transactions';
        heroSecondaryAction.textContent = 'Review Budget';
        heroSecondaryAction.dataset.action = 'budget';
        heroSecondaryAction.hidden = false;
      }
    }

    // Balance card
    if (balanceEl) {
      const balance = m.income - m.expenses - m.savings;
      animateValue(balanceEl, balance);
      balanceEl.style.color = balance >= 0 ? 'var(--color-income)' : 'var(--color-expense)';

      if (balanceBadge) {
        if (m.income === 0 && m.expenses === 0) setBadge(balanceBadge, 'New', 'neutral');
        else if (balance > m.income * 0.3) setBadge(balanceBadge, 'Healthy', 'positive');
        else if (balance > 0) setBadge(balanceBadge, 'Caution', 'warning');
        else setBadge(balanceBadge, 'Over', 'negative');
      }
    }

    if (incomeBadge) {
      if (m.income === 0) setBadge(incomeBadge, 'New', 'neutral');
      else if (m.expenses > 0 && m.income < m.expenses * 0.5) setBadge(incomeBadge, 'Low', 'negative');
      else if (previousIncome > 0 && m.income < previousIncome * 0.85) setBadge(incomeBadge, 'Caution', 'warning');
      else if (m.expenses > 0 && m.income < m.expenses) setBadge(incomeBadge, 'Caution', 'warning');
      else setBadge(incomeBadge, 'Healthy', 'positive');
    }

    if (expenseBadge) {
      if (m.income === 0 && m.expenses === 0) setBadge(expenseBadge, 'New', 'neutral');
      else if (m.income > 0 && m.expenses > m.income) setBadge(expenseBadge, 'Over', 'negative');
      else if (m.income > 0 && m.expenses >= m.income * 0.8) setBadge(expenseBadge, 'Caution', 'warning');
      else setBadge(expenseBadge, 'Healthy', 'positive');
    }

    if (incomeCard) {
      incomeCard.setAttribute('aria-label', `View income transactions for ${monthLabel}`);
    }
    if (expenseCard) {
      expenseCard.setAttribute('aria-label', `View expense transactions for ${monthLabel}`);
    }
    if (balanceCard) {
      balanceCard.setAttribute('aria-label', `View all transactions for ${monthLabel}`);
    }
  });

  return () => {
    heroPrimaryAction?.removeEventListener('click', handlePrimaryActionClick);
    heroSecondaryAction?.removeEventListener('click', handleSecondaryActionClick);
    incomeCard?.removeEventListener('click', handleIncomeCardClick);
    expenseCard?.removeEventListener('click', handleExpenseCardClick);
    balanceCard?.removeEventListener('click', handleBalanceCardClick);
    cleanup();
  };
}

/**
 * Mount the reactive today's budget component
 */
function mountTodayBudget(): () => void {
  const todayEl = DOM.get('today-remaining');
  const spentEl = DOM.get('today-spent');
  const budgetEl = DOM.get('today-budget');
  const badge = DOM.get('today-badge');
  const todayCardTitle = badge?.parentElement?.querySelector('h4') as HTMLElement | null;

  if (!todayEl) {
    return () => {};
  }

  const cleanup = effect(() => {
    const _cur = signals.currency.value;  // subscribe to currency changes
    const m = dailyMetrics.value;
    const todayRemaining = m.dailyAllowance - m.todayExpenses;
    const noActivity = m.income === 0 && m.expenses === 0;
    const noBudget = signals.dailyAllowanceData.value.status === 'no-budget';

    // Animate today's remaining
    if (m.isFutureMonth) {
      todayEl.textContent = fmtCur(Math.max(0, m.dailyAllowance));
    } else if (noActivity && noBudget) {
      todayEl.textContent = '—';
    } else {
      animateValue(todayEl, todayRemaining);
    }
    todayEl.style.color = m.isFutureMonth
      ? 'var(--color-accent)'
      : noActivity && noBudget
        ? 'var(--text-tertiary)'
        : todayRemaining >= 0
          ? 'var(--color-income)'
          : 'var(--color-expense)';

    if (spentEl) spentEl.textContent = fmtCur(m.todayExpenses);
    if (budgetEl) budgetEl.textContent = fmtCur(Math.max(0, m.dailyAllowance));
    if (todayCardTitle) {
      todayCardTitle.textContent = m.isFutureMonth ? 'Planned Daily Budget' : 'Today\'s Budget';
    }

    if (badge) {
      if (m.isFutureMonth) setBadge(badge, 'Planned', 'neutral');
      else if (noActivity && noBudget) setBadge(badge, 'Set Up', 'neutral');
      else if (todayRemaining < 0) setBadge(badge, 'Over', 'negative');
      else if (todayRemaining < m.dailyAllowance * 0.2) setBadge(badge, 'Low', 'neutral');
      else setBadge(badge, 'On Track', 'positive');
    }
  });

  return cleanup;
}

/**
 * Mount the reactive spending pace component.
 * The bar reflects calendar progress, while the label reflects spending as a share of income.
 */
function mountMonthlyPace(): () => void {
  const barEl = DOM.get('pace-bar');
  const labelEl = DOM.get('pace-label');
  const markerEl = DOM.get('pace-day-marker');
  const endLabelEl = DOM.get('pace-end-label');

  if (!barEl) {
    return () => {};
  }

  const cleanup = effect(() => {
    const m = dailyMetrics.value;
    const calPct = calendarPercent.value;
    const spendPct = spendingPercent.value;

    barEl.style.width = calPct + '%';
    barEl.style.background = spendPct > calPct ? 'var(--color-warning)' : 'var(--color-income)';
    barEl.setAttribute('aria-valuenow', String(calPct));

    if (labelEl) labelEl.textContent = `${capPercent(spendPct)}% of income spent`;
    if (markerEl) markerEl.textContent = `Day ${m.dayOfMonth} of ${m.daysInMonth}`;
    if (endLabelEl) endLabelEl.textContent = `Day ${m.daysInMonth}`;
  });

  return cleanup;
}

/**
 * Mount the reactive sidebar daily allowance card
 */
function mountSidebarAllowance(): () => void {
  const cardEl = DOM.get('daily-allowance-card');
  const amountEl = DOM.get('daily-allowance');
  const subtitleEl = DOM.get('allowance-subtitle');
  const badgeEl = DOM.get('allowance-badge');

  if (!cardEl || !amountEl) {
    return () => {};
  }

  const cleanup = effect(() => {
    const _cur = signals.currency.value;  // subscribe to currency changes
    const data = signals.dailyAllowanceData.value;

    if (data.status === 'no-budget') {
      amountEl.textContent = '—';
      amountEl.style.color = 'var(--text-tertiary)';
      if (subtitleEl) subtitleEl.textContent = 'Set a budget to see';
      if (badgeEl) setBadge(badgeEl, 'Daily', 'neutral');
    } else if (!data.isCurrentMonth) {
      amountEl.textContent = fmtCur(data.remaining);
      amountEl.style.color = data.remaining >= 0 ? 'var(--color-income)' : 'var(--color-expense)';
      if (subtitleEl) subtitleEl.textContent = 'Month ended';
      if (badgeEl) setBadge(badgeEl, 'Closed', 'neutral');
    } else {
      animateValue(amountEl, data.dailyAllowance);

      if (data.status === 'over') {
        amountEl.style.color = 'var(--color-expense)';
        if (subtitleEl) subtitleEl.textContent = `Over budget by ${fmtCur(Math.abs(data.remaining))}`;
        if (badgeEl) setBadge(badgeEl, 'Over', 'negative');
      } else if (data.status === 'warning') {
        amountEl.style.color = 'var(--color-warning)';
        if (subtitleEl) subtitleEl.textContent = `${data.daysRemaining} days left · ${fmtCur(data.remaining)} remaining`;
        if (badgeEl) setBadge(badgeEl, 'Low', 'neutral');
      } else {
        amountEl.style.color = 'var(--color-income)';
        if (subtitleEl) subtitleEl.textContent = `${data.daysRemaining} days left · ${fmtCur(data.remaining)} remaining`;
        if (badgeEl) setBadge(badgeEl, 'Daily', 'positive');
      }
    }
  });

  return cleanup;
}

/**
 * CR-Apr22-D slice 2 [P1] — pure visual derivation for the spending-pace
 * indicator. Extracted from `mountSpendingPaceIndicator`'s effect body so
 * the primary defect (className always contained the literal `hidden`
 * token) has an explicit test lock: the returned `className` must never
 * include `hidden`, across all four `SpendingPaceStatus` values plus the
 * defensive default branch.
 *
 * Layout note: `mb-3` is carried through from `index.html` (the HTML
 * starts with `class="spending-pace-indicator pace-neutral mb-3 hidden"`)
 * so when the indicator transitions from hidden-by-default to visible via
 * the effect, the surrounding hero-card layout doesn't collapse.
 */
export function computePaceIndicatorVisual(
  pace: SpendingPaceData
): { className: string; icon: string; text: string } {
  let statusClass: string;
  let statusIcon: string;
  let statusText: string;
  switch (pace.status) {
    case 'no-budget':
      statusClass = 'pace-neutral';
      statusIcon = '—';
      statusText = 'No budget set';
      break;
    case 'under':
      statusClass = 'pace-under';
      statusIcon = '✓';
      statusText = `${capPercent(Math.round(Math.abs(pace.difference)))}% under pace`;
      break;
    case 'on-track':
      statusClass = 'pace-on-track';
      statusIcon = '•';
      statusText = 'On track';
      break;
    case 'over':
      statusClass = 'pace-over';
      statusIcon = '!';
      statusText = `${capPercent(Math.round(pace.difference))}% over pace`;
      break;
    default:
      statusClass = 'pace-neutral';
      statusIcon = '—';
      statusText = 'Unknown';
  }
  return {
    className: `spending-pace-indicator ${statusClass} mb-3`,
    icon: statusIcon,
    text: statusText
  };
}

/**
 * Mount the reactive spending pace indicator
 */
function mountSpendingPaceIndicator(): () => void {
  const paceEl = DOM.get('spending-pace-indicator');

  if (!paceEl) {
    return () => {};
  }

  const cleanup = effect(() => {
    const pace = signals.spendingPaceData.value;
    const { className, icon, text } = computePaceIndicatorVisual(pace);
    // CR-Apr22-D slice 2 [P1]: `className` from the helper intentionally
    // omits `hidden`. The prior implementation hardcoded `hidden` into
    // this assignment, so the effect re-ran on every pace change but the
    // element stayed display:none — a rich, fully-styled dashboard
    // indicator was dead throughout.
    paceEl.className = className;
    render(html`<span class="pace-icon">${icon}</span><span class="pace-text">${text}</span>`, paceEl);
  });

  return cleanup;
}

/**
 * Mount all daily allowance components
 * Returns cleanup function to dispose all effects
 */
export function mountDailyAllowance(): () => void {
  mountEffects('daily-allowance', [
    () => mountHeroCard(),
    () => mountTodayBudget(),
    () => mountMonthlyPace(),
    () => mountSidebarAllowance(),
    () => mountSpendingPaceIndicator(),
  ]);
  return () => unmountEffects('daily-allowance');
}
