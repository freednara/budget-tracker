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
import { html, render, mountAll } from '../core/lit-helpers.js';
import { mountEffects, unmountEffects } from '../core/effect-manager.js';
import {
  fmtCur,
  parseMonthKey,
  getMonthKey,
  getTodayStr,
  toCents,
  toDollars
} from '../core/utils.js';
import {
  getEffectiveIncome,
  calcTotals,
  getMonthTx,
  getMonthlySavings
} from '../features/financial/calculations.js';
import { isTrackedExpenseTransaction } from '../core/transaction-classification.js';
import DOM from '../core/dom-cache.js';
import { animateValue as animateValueById } from '../orchestration/dashboard-animations.js';
import { revealTransactionsForm } from '../ui/core/ui-navigation.js';

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
 * Progress percentage for the month
 */
const progressPercent = computed(() => {
  const m = dailyMetrics.value;
  return (m.daysElapsed / m.daysInMonth) * 100;
});

/**
 * Spending percent shown in the hero pace label.
 * This is intentionally based on expenses as a share of income for the month.
 */
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
type BadgeStatus = 'positive' | 'negative' | 'neutral';
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
  const heroLeftEl = DOM.get('hero-left-to-spend');
  const heroTodayEl = DOM.get('hero-today-spent');
  const heroDaysEl = DOM.get('hero-days-remaining');
  const heroProgressBar = DOM.get('hero-progress-bar');
  const heroProgressPct = DOM.get('hero-progress-pct');
  const heroMotivation = DOM.get('hero-motivation');
  const heroBadge = DOM.get('hero-pace-badge');
  const heroPrimaryAction = DOM.get('hero-primary-action') as HTMLButtonElement | null;
  const heroSecondaryAction = DOM.get('hero-secondary-action') as HTMLButtonElement | null;
  const balanceEl = DOM.get('total-balance');
  const balanceBadge = DOM.get('balance-badge');

  if (!heroDailyEl) {
    return () => {}; // Hero card not present
  }

  let lastAllowance = 0;
  let lastBalance = 0;

  const navigateFromHero = (action: string): void => {
    if (action === 'budget') {
      (DOM.get('tab-budget-btn') as HTMLButtonElement | null)?.click();
      window.setTimeout(() => {
        const section = DOM.get('envelope-section') as HTMLElement | null;
        section?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        (DOM.get('open-plan-budget') as HTMLButtonElement | null)?.focus();
      }, 80);
      return;
    }
    if (action === 'transactions') {
      (DOM.get('tab-transactions-btn') as HTMLButtonElement | null)?.click();
      window.setTimeout(() => {
        revealTransactionsForm('amount', true);
      }, 80);
    }
  };

  const handlePrimaryActionClick = (): void => navigateFromHero(heroPrimaryAction?.dataset.action || 'transactions');
  const handleSecondaryActionClick = (): void => navigateFromHero(heroSecondaryAction?.dataset.action || 'budget');

  heroPrimaryAction?.addEventListener('click', handlePrimaryActionClick);
  heroSecondaryAction?.addEventListener('click', handleSecondaryActionClick);

  const cleanup = effect(() => {
    const m = dailyMetrics.value;
    const dailyBudget = m.income / m.daysInMonth;
    const noActivity = m.income === 0 && m.expenses === 0;
    const noBudget = signals.dailyAllowanceData.value.status === 'no-budget';

    // Daily allowance with animation
    if (noActivity && noBudget) {
      heroDailyEl.textContent = '—';
      lastAllowance = 0;
    } else if (m.dailyAllowance !== lastAllowance) {
      animateValue(heroDailyEl, m.dailyAllowance);
      lastAllowance = m.dailyAllowance;
    }

    // Style based on allowance status
    heroDailyEl.classList.remove('negative', 'warning');
    heroDailyEl.style.color = 'var(--color-income)';
    if (noActivity && noBudget) {
      heroDailyEl.style.color = 'var(--text-tertiary)';
    } else if (m.dailyAllowance < 0) {
      heroDailyEl.classList.add('negative');
    } else if (m.dailyAllowance < dailyBudget * 0.5) {
      heroDailyEl.classList.add('warning');
    }

    if (heroAmountCaption) {
      if (m.isFutureMonth) {
        heroAmountCaption.textContent = 'Projected daily allowance for this upcoming month';
      } else if (noActivity && noBudget && m.savings > 0) {
        heroAmountCaption.textContent = `Savings transfers are tracked separately, with ${fmtCur(m.savings)} already set aside this month`;
      } else if (m.isPastMonth) {
        heroAmountCaption.textContent = 'What this month could support per day';
      } else if (noActivity && noBudget) {
        heroAmountCaption.textContent = 'Set a budget or add income to unlock your daily allowance';
      } else if (noBudget) {
        heroAmountCaption.textContent = m.savings > 0
          ? `Estimated from income, spending, and ${fmtCur(m.savings)} moved to savings because no budget is set`
          : 'Estimated from income and spending because no budget is set';
      } else if (m.savings > 0) {
        heroAmountCaption.textContent = `Available to spend per day after ${fmtCur(m.savings)} moved to savings this month`;
      } else {
        heroAmountCaption.textContent = 'Available to spend per day';
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

    // Secondary metrics
    if (heroLeftEl) {
      heroLeftEl.textContent = fmtCur(Math.abs(m.remaining));
      heroLeftEl.style.color = m.remaining >= 0 ? 'var(--color-income)' : 'var(--color-expense)';
    }
    // Update label to reflect over-budget state
    const heroLeftLabel = heroLeftEl?.previousElementSibling as HTMLElement | null;
    if (heroLeftLabel) {
      heroLeftLabel.textContent = m.remaining >= 0 ? 'LEFT TO SPEND' : 'OVER BUDGET';
    }

    if (heroTodayEl) {
      heroTodayEl.textContent = fmtCur(m.todayExpenses);
    }

    if (heroDaysEl) {
      heroDaysEl.textContent = String(m.daysRemaining);
    }

    // Progress bar
    const pct = progressPercent.value;
    if (heroProgressBar) {
      heroProgressBar.style.width = `${pct}%`;
      heroProgressBar.setAttribute('aria-valuenow', pct.toFixed(0));
    }
    if (heroProgressPct) {
      heroProgressPct.textContent = `${pct.toFixed(0)}% complete`;
    }

    // Badge status
    if (heroBadge) {
      if (m.isFutureMonth) setBadge(heroBadge, 'Upcoming', 'neutral');
      else if (m.isPastMonth && m.income === 0 && m.expenses === 0) setBadge(heroBadge, 'No Data', 'neutral');
      else if (m.isPastMonth) setBadge(heroBadge, 'Month Ended', 'neutral');
      else if (m.income === 0 && m.expenses === 0) setBadge(heroBadge, 'Get Started', 'neutral');
      else if (m.remaining < 0) setBadge(heroBadge, 'Over Budget', 'negative');
      else if (m.dailyAllowance < dailyBudget * 0.3) setBadge(heroBadge, 'Running Low', 'neutral');
      else setBadge(heroBadge, 'On Track', 'positive');
    }

    // Motivational messages
    if (heroMotivation) {
      let message = '';
      if (m.isFutureMonth) {
        message = '🗓️ You are planning ahead. Use the Budget tab to shape this month before it starts.';
      } else if (m.isPastMonth && noActivity) {
        message = '📭 No activity was recorded for this month yet.';
      } else if (noActivity && noBudget && m.savings > 0) {
        message = `💚 You moved ${fmtCur(m.savings)} to savings this month. Add income or a budget to turn that into a daily allowance.`;
      } else if (noActivity && noBudget) {
        message = '👋 Start with a budget or your first transaction so this dashboard can guide you.';
      } else if (noBudget) {
        message = m.savings > 0
          ? `💚 ${fmtCur(m.savings)} is already set aside for savings, and this estimate reflects that transfer.`
          : '🧭 Add a budget to turn this estimate into a real daily allowance target.';
      } else if (m.remaining < 0) {
        message = '⚠️ You\'ve exceeded your budget. Time to review spending!';
      } else if (m.savings > 0) {
        message = `💚 ${fmtCur(m.savings)} has already been moved to savings this month, so it’s excluded from what’s left to spend.`;
      } else if (m.daysRemaining <= 3) {
        message = '🎯 Almost to the finish line! Stay strong!';
      } else if (m.dailyAllowance > dailyBudget * 1.5) {
        message = '💪 Great job! You\'re ahead of your budget goals!';
      } else if (m.dailyAllowance < dailyBudget * 0.5) {
        message = '🔍 Watch your spending - allowance is running low.';
      } else {
        message = '✨ Stay consistent with tracking for best results!';
      }
      heroMotivation.textContent = message;
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
      if (balance !== lastBalance) {
        animateValue(balanceEl, balance);
        lastBalance = balance;
      }
      balanceEl.style.color = balance >= 0 ? 'var(--color-income)' : 'var(--color-expense)';

      if (balanceBadge) {
        if (balance > m.income * 0.3) setBadge(balanceBadge, 'Healthy', 'positive');
        else if (balance > 0) setBadge(balanceBadge, 'OK', 'neutral');
        else setBadge(balanceBadge, 'Deficit', 'negative');
      }
    }
  });

  return () => {
    heroPrimaryAction?.removeEventListener('click', handlePrimaryActionClick);
    heroSecondaryAction?.removeEventListener('click', handleSecondaryActionClick);
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

  let lastTodayRemaining = 0;

  const cleanup = effect(() => {
    const m = dailyMetrics.value;
    const todayRemaining = m.dailyAllowance - m.todayExpenses;
    const noActivity = m.income === 0 && m.expenses === 0;
    const noBudget = signals.dailyAllowanceData.value.status === 'no-budget';

    // Animate today's remaining
    if (m.isFutureMonth) {
      todayEl.textContent = fmtCur(Math.max(0, m.dailyAllowance));
      lastTodayRemaining = 0;
    } else if (noActivity && noBudget) {
      todayEl.textContent = '—';
      lastTodayRemaining = 0;
    } else if (todayRemaining !== lastTodayRemaining) {
      animateValue(todayEl, todayRemaining);
      lastTodayRemaining = todayRemaining;
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

  if (!barEl) {
    return () => {};
  }

  const cleanup = effect(() => {
    const m = dailyMetrics.value;
    const calPct = calendarPercent.value;
    const spendPct = spendingPercent.value;

    barEl.style.width = calPct + '%';
    barEl.style.background = spendPct > calPct ? 'var(--color-expense)' : 'var(--color-income)';
    barEl.setAttribute('aria-valuenow', String(calPct));

    if (labelEl) labelEl.textContent = `${spendPct}% of income spent`;
    if (markerEl) markerEl.textContent = `Day ${m.dayOfMonth} of ${m.daysInMonth}`;
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

  let lastAllowance = 0;

  const cleanup = effect(() => {
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
      if (data.dailyAllowance !== lastAllowance) {
        animateValue(amountEl, data.dailyAllowance);
        lastAllowance = data.dailyAllowance;
      }

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
 * Mount the reactive spending pace indicator
 */
function mountSpendingPaceIndicator(): () => void {
  const paceEl = DOM.get('spending-pace-indicator');

  if (!paceEl) {
    return () => {};
  }

  const cleanup = effect(() => {
    const pace = signals.spendingPaceData.value;

    let statusClass: string, statusIcon: string, statusText: string;
    switch (pace.status) {
      case 'no-budget':
        statusClass = 'pace-neutral';
        statusIcon = '—';
        statusText = 'No budget set';
        break;
      case 'under':
        statusClass = 'pace-under';
        statusIcon = '✓';
        statusText = `${Math.abs(pace.difference).toFixed(0)}% under pace`;
        break;
      case 'on-track':
        statusClass = 'pace-on-track';
        statusIcon = '•';
        statusText = 'On track';
        break;
      case 'over':
        statusClass = 'pace-over';
        statusIcon = '!';
        statusText = `${pace.difference.toFixed(0)}% over pace`;
        break;
      default:
        statusClass = 'pace-neutral';
        statusIcon = '—';
        statusText = 'Unknown';
    }

    paceEl.className = `spending-pace-indicator ${statusClass}`;
    render(html`<span class="pace-icon">${statusIcon}</span><span class="pace-text">${statusText}</span>`, paceEl);
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
