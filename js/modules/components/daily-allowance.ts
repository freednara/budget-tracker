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
import DOM from '../core/dom-cache.js';

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
  dailyAllowance: number;
  todayExpenses: number;
}

const dailyMetrics = computed((): DailyMetrics => {
  const currentMk = signals.currentMonth.value;
  const now = new Date();
  const viewDate = parseMonthKey(currentMk);
  const isCurrentMonth = getMonthKey(now) === currentMk;
  const daysInMonth = new Date(viewDate.getFullYear(), viewDate.getMonth() + 1, 0).getDate();
  const dayOfMonth = isCurrentMonth ? now.getDate() : daysInMonth;
  const daysElapsed = isCurrentMonth ? dayOfMonth : daysInMonth;
  const daysRemaining = isCurrentMonth ? Math.max(1, daysInMonth - dayOfMonth + 1) : daysInMonth;

  const income = getEffectiveIncome(currentMk);
  const { expenses } = calcTotals(getMonthTx());
  const savings = getMonthlySavings(currentMk);
  const remaining = income - expenses - savings;
  const dailyAllowance = remaining / daysRemaining;

  // Today's expenses
  const todayStr = getTodayStr();
  const todayExpensesCents = signals.transactions.value
    .filter(t => t.type === 'expense' && t.date === todayStr)
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
 * Spending percentage compared to income
 */
const spendingPercent = computed(() => {
  const m = dailyMetrics.value;
  return m.income > 0 ? Math.round((m.expenses / m.income) * 100) : 0;
});

/**
 * Calendar percentage (for pace comparison)
 */
const calendarPercent = computed(() => {
  const m = dailyMetrics.value;
  return Math.min(100, Math.round((m.dayOfMonth / m.daysInMonth) * 100));
});

// ==========================================
// HELPER FUNCTIONS
// ==========================================

/**
 * Animate a numeric value with easing
 */
function animateValue(el: HTMLElement, target: number, duration: number = 400): void {
  const current = parseFloat(el.textContent?.replace(/[^0-9.-]/g, '') || '0') || 0;
  if (Math.abs(current - target) < 0.01) {
    el.textContent = fmtCur(target);
    return;
  }
  const start = performance.now();
  const animate = (now: number): void => {
    const elapsed = now - start;
    const progress = Math.min(elapsed / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    const val = current + (target - current) * eased;
    el.textContent = fmtCur(val);
    if (progress < 1) requestAnimationFrame(animate);
  };
  requestAnimationFrame(animate);
}

// ==========================================
// COMPONENT MOUNTING
// ==========================================

/**
 * Mount the reactive hero card component
 */
function mountHeroCard(): () => void {
  const heroDailyEl = DOM.get('hero-daily-amount');
  const heroLeftEl = DOM.get('hero-left-to-spend');
  const heroTodayEl = DOM.get('hero-today-spent');
  const heroDaysEl = DOM.get('hero-days-remaining');
  const heroProgressBar = DOM.get('hero-progress-bar');
  const heroProgressPct = DOM.get('hero-progress-pct');
  const heroMotivation = DOM.get('hero-motivation');
  const heroBadge = DOM.get('hero-pace-badge');
  const balanceEl = DOM.get('total-balance');
  const balanceBadge = DOM.get('balance-badge');

  if (!heroDailyEl) {
    return () => {}; // Hero card not present
  }

  let lastAllowance = 0;
  let lastBalance = 0;

  const cleanup = effect(() => {
    const m = dailyMetrics.value;
    const dailyBudget = m.income / m.daysInMonth;

    // Daily allowance with animation
    if (m.dailyAllowance !== lastAllowance) {
      animateValue(heroDailyEl, m.dailyAllowance);
      lastAllowance = m.dailyAllowance;
    }

    // Style based on allowance status
    heroDailyEl.classList.remove('negative', 'warning');
    if (m.dailyAllowance < 0) {
      heroDailyEl.classList.add('negative');
    } else if (m.dailyAllowance < dailyBudget * 0.5) {
      heroDailyEl.classList.add('warning');
    }

    // Secondary metrics
    if (heroLeftEl) {
      heroLeftEl.textContent = fmtCur(Math.abs(m.remaining));
      heroLeftEl.style.color = m.remaining >= 0 ? 'var(--color-income)' : 'var(--color-expense)';
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
      if (m.remaining < 0) {
        heroBadge.textContent = 'Over Budget';
        heroBadge.className = 'stat-badge stat-negative text-xs';
      } else if (m.dailyAllowance < dailyBudget * 0.3) {
        heroBadge.textContent = 'Running Low';
        heroBadge.className = 'stat-badge stat-neutral text-xs';
      } else {
        heroBadge.textContent = 'On Track';
        heroBadge.className = 'stat-badge stat-positive text-xs';
      }
    }

    // Motivational messages
    if (heroMotivation) {
      let message = '';
      if (m.remaining < 0) {
        message = '⚠️ You\'ve exceeded your budget. Time to review spending!';
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

    // Balance card
    if (balanceEl) {
      const balance = m.income - m.expenses;
      if (balance !== lastBalance) {
        animateValue(balanceEl, balance);
        lastBalance = balance;
      }
      balanceEl.style.color = balance >= 0 ? 'var(--color-income)' : 'var(--color-expense)';

      if (balanceBadge) {
        if (balance > m.income * 0.3) {
          balanceBadge.textContent = 'Healthy';
          balanceBadge.className = 'stat-badge stat-positive text-xs';
        } else if (balance > 0) {
          balanceBadge.textContent = 'OK';
          balanceBadge.className = 'stat-badge stat-neutral text-xs';
        } else {
          balanceBadge.textContent = 'Deficit';
          balanceBadge.className = 'stat-badge stat-negative text-xs';
        }
      }
    }
  });

  return cleanup;
}

/**
 * Mount the reactive today's budget component
 */
function mountTodayBudget(): () => void {
  const todayEl = DOM.get('today-remaining');
  const spentEl = DOM.get('today-spent');
  const budgetEl = DOM.get('today-budget');
  const badge = DOM.get('today-badge');

  if (!todayEl) {
    return () => {};
  }

  let lastTodayRemaining = 0;

  const cleanup = effect(() => {
    const m = dailyMetrics.value;
    const todayRemaining = m.dailyAllowance - m.todayExpenses;

    // Animate today's remaining
    if (todayRemaining !== lastTodayRemaining) {
      animateValue(todayEl, todayRemaining);
      lastTodayRemaining = todayRemaining;
    }
    todayEl.style.color = todayRemaining >= 0 ? 'var(--color-income)' : 'var(--color-expense)';

    if (spentEl) spentEl.textContent = fmtCur(m.todayExpenses);
    if (budgetEl) budgetEl.textContent = fmtCur(Math.max(0, m.dailyAllowance));

    if (badge) {
      if (todayRemaining < 0) {
        badge.textContent = 'Over';
        badge.className = 'stat-badge stat-negative text-xs';
      } else if (todayRemaining < m.dailyAllowance * 0.2) {
        badge.textContent = 'Low';
        badge.className = 'stat-badge stat-neutral text-xs';
      } else {
        badge.textContent = 'On Track';
        badge.className = 'stat-badge stat-positive text-xs';
      }
    }
  });

  return cleanup;
}

/**
 * Mount the reactive monthly pace component
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

    if (labelEl) labelEl.textContent = spendPct + '% spent';
    if (markerEl) markerEl.textContent = `Day ${m.dayOfMonth} / ${m.daysInMonth}`;
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
      if (badgeEl) {
        badgeEl.textContent = 'Daily';
        badgeEl.className = 'stat-badge stat-neutral text-xs';
      }
    } else if (!data.isCurrentMonth) {
      amountEl.textContent = fmtCur(data.remaining);
      amountEl.style.color = data.remaining >= 0 ? 'var(--color-income)' : 'var(--color-expense)';
      if (subtitleEl) subtitleEl.textContent = 'Month ended';
      if (badgeEl) {
        badgeEl.textContent = 'Closed';
        badgeEl.className = 'stat-badge stat-neutral text-xs';
      }
    } else {
      if (data.dailyAllowance !== lastAllowance) {
        animateValue(amountEl, data.dailyAllowance);
        lastAllowance = data.dailyAllowance;
      }

      if (data.status === 'over') {
        amountEl.style.color = 'var(--color-expense)';
        if (subtitleEl) subtitleEl.textContent = `Over budget by ${fmtCur(Math.abs(data.remaining))}`;
        if (badgeEl) {
          badgeEl.textContent = 'Over';
          badgeEl.className = 'stat-badge stat-negative text-xs';
        }
      } else if (data.status === 'warning') {
        amountEl.style.color = 'var(--color-warning)';
        if (subtitleEl) subtitleEl.textContent = `${data.daysRemaining} days left · ${fmtCur(data.remaining)} remaining`;
        if (badgeEl) {
          badgeEl.textContent = 'Low';
          badgeEl.className = 'stat-badge stat-neutral text-xs';
        }
      } else {
        amountEl.style.color = 'var(--color-income)';
        if (subtitleEl) subtitleEl.textContent = `${data.daysRemaining} days left · ${fmtCur(data.remaining)} remaining`;
        if (badgeEl) {
          badgeEl.textContent = 'Daily';
          badgeEl.className = 'stat-badge stat-positive text-xs';
        }
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
  const cleanups = [
    mountHeroCard(),
    mountTodayBudget(),
    mountMonthlyPace(),
    mountSidebarAllowance(),
    mountSpendingPaceIndicator()
  ];

  return () => {
    cleanups.forEach(cleanup => cleanup());
  };
}
