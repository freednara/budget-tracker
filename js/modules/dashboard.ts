/**
 * Dashboard Module
 *
 * Summary cards, budget gauge, and daily allowance calculations.
 * Uses signals for reactive state access.
 */
'use strict';

import * as signals from './core/signals.js';
import {
  getMonthTx,
  calcTotals,
  getEffectiveIncome,
  getMonthlySavings,
  getMonthExpByCat,
  getUnassigned,
  getDailyAllowance,
  getSpendingPace
} from './features/financial/calculations.js';
import {
  fmtCur,
  parseMonthKey,
  getMonthKey,
  getPrevMonthKey,
  getTodayStr,
  sumByType,
  toCents
} from './core/utils.js';
import { html, render, nothing, unsafeSVG, styleMap } from './core/lit-helpers.js';
import { getCatInfo } from './core/categories.js';
import {
  isRolloverEnabled,
  getEffectiveBudget,
  calculateMonthRollovers
} from './features/financial/rollover.js';
import DOM from './core/dom-cache.js';

// Reactive component imports
import { mountSummaryCards } from './components/summary-cards.js';
import { mountEnvelopeBudget } from './components/envelope-budget.js';
import { mountBudgetGauge } from './components/budget-gauge.js';
import { mountDailyAllowance } from './components/daily-allowance.js';
import { mountDebtSummary } from './components/debt-summary.js';
import { mountDebtList } from './components/debt-list.js';
import { mountSavingsGoals } from './components/savings-goals.js';
import { mountCalendar } from './components/calendar.js';
import { mountCharts } from './components/charts.js';
import { mountTransactions } from './components/transactions.js';

// ==========================================
// SVG HELPERS
// ==========================================

/**
 * Helper function to describe SVG arc path
 */
function describeArc(cx: number, cy: number, r: number, startAngle: number, endAngle: number): string {
  const x1 = cx + r * Math.cos(startAngle);
  const y1 = cy - r * Math.sin(startAngle);
  const x2 = cx + r * Math.cos(endAngle);
  const y2 = cy - r * Math.sin(endAngle);
  const largeArc = Math.abs(endAngle - startAngle) > Math.PI ? 1 : 0;
  const sweep = startAngle > endAngle ? 1 : 0;
  return `M ${x1} ${y1} A ${r} ${r} 0 ${largeArc} ${sweep} ${x2} ${y2}`;
}

// ==========================================
// ANIMATION HELPERS
// ==========================================

/**
 * Animate a numeric value with easing
 */
export function animateValue(elId: string, target: number): void {
  const el = DOM.get(elId);
  if (!el) return;
  const current = parseFloat(el.textContent?.replace(/[^0-9.-]/g, '') || '0') || 0;
  if (Math.abs(current - target) < 0.01) { el.textContent = fmtCur(target); return; }
  const duration = 400;
  const start = performance.now();
  const animate = (now: number): void => {
    const elapsed = now - start;
    const progress = Math.min(elapsed / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3); // ease-out cubic
    const val = current + (target - current) * eased;
    el.textContent = fmtCur(val);
    if (progress < 1) requestAnimationFrame(animate);
  };
  requestAnimationFrame(animate);
}

// ==========================================
// TREND INDICATORS
// ==========================================

/**
 * Update trend indicator showing % change vs previous month
 */
function updateTrendIndicator(elementId: string, current: number, previous: number, upIsGood: boolean): void {
  const el = DOM.get(elementId);
  if (!el) return;
  if (previous === 0) { el.classList.add('hidden'); return; }
  const pctChange = Math.round(((current - previous) / Math.abs(previous)) * 100);
  if (pctChange === 0) { el.classList.add('hidden'); return; }
  const isUp = pctChange > 0;
  const isGood = upIsGood ? isUp : !isUp;
  const arrow = isUp ? '↑' : '↓';
  const color = isGood ? 'var(--color-income)' : 'var(--color-expense)';
  render(html`<span style=${styleMap({ color })}>${arrow} ${Math.abs(pctChange)}%</span> vs last month`, el);
  el.classList.remove('hidden');
}

// ==========================================
// SUMMARY CARDS
// ==========================================

/**
 * Update the summary cards (income, expenses)
 */
export function updateSummary(): void {
  const currentMk = signals.currentMonth.value;
  const monthTx = getMonthTx();
  const { expenses } = calcTotals(monthTx);
  const income = getEffectiveIncome(currentMk);
  animateValue('total-income', income);
  animateValue('total-expenses', expenses);

  // Calculate trends vs previous month
  const prevMk = getPrevMonthKey(currentMk);
  const prevTx = getMonthTx(prevMk);
  const prevTotals = calcTotals(prevTx);
  const prevIncome = getEffectiveIncome(prevMk);

  updateTrendIndicator('income-trend', income, prevIncome, true);
  updateTrendIndicator('expense-trend', expenses, prevTotals.expenses, false);

  updateDailyAllowance();
  updateTodayBudget();
  updateMonthlyPace();
  updateSidebarAllowance();
  updateSpendingPaceIndicator();
}

// ==========================================
// ENVELOPE BUDGET
// ==========================================

/**
 * Render the envelope budget allocation cards
 * Includes rollover amounts when rollover feature is enabled
 */
export function renderEnvelope(): void {
  const sec = DOM.get('envelope-section');
  if (!sec) return;
  if (!signals.sections.value.envelope) { sec.classList.add('hidden'); return; }
  sec.classList.remove('hidden');
  const currentMk = signals.currentMonth.value;
  const alloc = signals.monthlyAlloc.value[currentMk] || {};
  const grid = DOM.get('envelope-grid');
  const unassigned = getUnassigned(currentMk);
  const unassignedEl = DOM.get('unassigned-amount');
  if (unassignedEl) {
    unassignedEl.textContent = fmtCur(unassigned);
    unassignedEl.classList.remove('text-accent', 'text-expense');
    unassignedEl.classList.add(unassigned >= 0 ? 'text-accent' : 'text-expense');
  }

  if (!grid) return;

  if (Object.keys(alloc).length === 0) {
    render(html`<p class="text-center py-4 text-xs" style="color: var(--text-tertiary);">No budget allocated yet. Click "Plan Budget" to start.</p>`, grid);
    return;
  }

  // Get rollovers for this month if feature is enabled
  const rolloverEnabled = isRolloverEnabled();
  const rollovers = rolloverEnabled ? calculateMonthRollovers(currentMk) : {};

  render(html`
    ${Object.entries(alloc).map(([catId, amt]) => {
      const cat = getCatInfo('expense', catId);
      const spent = getMonthExpByCat(catId, currentMk);
      const rollover = rollovers[catId] || 0;
      const effectiveBudget = rolloverEnabled ? getEffectiveBudget(catId, currentMk) : amt;
      const pct = effectiveBudget > 0 ? Math.min((spent/effectiveBudget)*100, 100) : 0;
      const over = spent > effectiveBudget;
      const fillColor = over ? 'var(--color-expense)' : pct > 80 ? 'var(--color-warning)' : 'var(--color-income)';

      return html`
        <div class="flex items-center gap-3 p-3 rounded-lg" style="background: var(--bg-input);">
          <span class="text-lg">${cat.emoji}</span>
          <div class="flex-1">
            <div class="flex justify-between text-xs mb-1">
              <span class="font-bold" style="color: var(--text-primary);">
                ${cat.name}
                ${rolloverEnabled && rollover !== 0
                  ? html`<span class="text-xs ml-1" style=${styleMap({ color: rollover > 0 ? 'var(--color-income)' : 'var(--color-expense)' })}>(${rollover > 0 ? '+' : ''}${fmtCur(rollover)} rollover)</span>`
                  : nothing}
              </span>
              <span class="font-bold" style=${styleMap({ color: over ? 'var(--color-expense)' : 'var(--color-income)' })}>${fmtCur(spent)} / ${fmtCur(effectiveBudget)}</span>
            </div>
            <div class="goal-bar"><div class="goal-fill" style=${styleMap({ width: `${pct}%`, background: fillColor })}></div></div>
          </div>
        </div>
      `;
    })}
  `, grid);
}

// ==========================================
// BUDGET GAUGE
// ==========================================

/**
 * Render the budget health gauge (semi-circular SVG gauge)
 */
export function renderBudgetGauge(): void {
  const section = DOM.get('budget-gauge-section');
  const el = DOM.get('budget-gauge-container');
  if (!section || !el) return;

  // Check if there are budget allocations for the CURRENT MONTH (use cents to avoid floating-point errors)
  const currentMk = signals.currentMonth.value;
  const alloc = signals.monthlyAlloc.value[currentMk] || {};
  const totalBudgetCents = Object.values(alloc).reduce((s: number, v: number) => s + toCents(v), 0);
  const totalBudget = totalBudgetCents / 100;

  if (totalBudget === 0) {
    section.classList.add('hidden');
    return;
  }

  section.classList.remove('hidden');

  // Calculate actual spending vs budget
  const monthTx = getMonthTx();
  const totalExpenses = sumByType(monthTx, 'expense');
  const usedPct = Math.min(150, Math.round((totalExpenses / totalBudget) * 100)); // Cap at 150%
  const displayPct = Math.min(usedPct, 100);

  // Determine color based on usage
  let gaugeColor = 'var(--color-income)'; // Green: <80%
  let statusText = 'Healthy';
  if (usedPct >= 100) {
    gaugeColor = 'var(--color-expense)'; // Red: Over budget
    statusText = 'Over Budget';
  } else if (usedPct >= 80) {
    gaugeColor = 'var(--color-warning)'; // Yellow: 80-100%
    statusText = 'Caution';
  }

  // Build semi-circular gauge SVG
  const w = 200, h = 120;
  const cx = w / 2, cy = h - 10;
  const r = 70;
  const startAngle = Math.PI; // 180 degrees (left)
  const endAngle = 0; // 0 degrees (right)

  // Background arc (gray)
  const bgArc = describeArc(cx, cy, r, startAngle, endAngle);
  // Filled arc based on percentage
  const fillAngle = startAngle - (startAngle - endAngle) * (displayPct / 100);
  const fillArc = describeArc(cx, cy, r, startAngle, fillAngle);

  // SVG content - using unsafeSVG for dynamic paths
  const svgContent = `
    <path d="${bgArc}" fill="none" stroke="var(--bg-input)" stroke-width="14" stroke-linecap="round"/>
    <path d="${fillArc}" fill="none" stroke="${gaugeColor}" stroke-width="14" stroke-linecap="round"/>
    <text x="${cx}" y="${cy - 25}" text-anchor="middle" font-size="28" font-weight="800" fill="${gaugeColor}">${usedPct}%</text>
    <text x="${cx}" y="${cy - 5}" text-anchor="middle" font-size="10" fill="var(--text-secondary)">${statusText}</text>
  `;

  render(html`
    <svg viewBox="0 0 ${w} ${h}" class="w-48" role="img" aria-label="Budget health gauge showing ${usedPct}% used">
      <title>Budget Health</title>
      <desc>Semi-circular gauge indicating ${statusText} status with ${usedPct}% of budget used</desc>
      ${unsafeSVG(svgContent)}
    </svg>
    <div class="text-center mt-2">
      <p class="text-xs" style="color: var(--text-tertiary);">
        ${fmtCur(totalExpenses)} of ${fmtCur(totalBudget)} budget used
      </p>
    </div>
  `, el);
}

// ==========================================
// DAILY ALLOWANCE
// ==========================================

/**
 * Update the daily allowance in the hero card
 */
export function updateDailyAllowance(): void {
  // New hero card elements
  const heroDailyEl = DOM.get('hero-daily-amount');
  const heroLeftEl = DOM.get('hero-left-to-spend');
  const heroTodayEl = DOM.get('hero-today-spent');
  const heroDaysEl = DOM.get('hero-days-remaining');
  const heroProgressBar = DOM.get('hero-progress-bar');
  const heroProgressPct = DOM.get('hero-progress-pct');
  const heroMotivation = DOM.get('hero-motivation');
  const heroBadge = DOM.get('hero-pace-badge');

  if (!heroDailyEl) return; // Hero card not present

  // Calculate core metrics
  const currentMk = signals.currentMonth.value;
  const income = getEffectiveIncome(currentMk);
  const { expenses } = calcTotals(getMonthTx());
  const savings = getMonthlySavings(currentMk);
  const viewDate = parseMonthKey(currentMk);
  const now = new Date();
  const daysInMonth = new Date(viewDate.getFullYear(), viewDate.getMonth() + 1, 0).getDate();
  const isCurrentMonth = getMonthKey(now) === currentMk;
  const currentDay = now.getDate();
  const daysElapsed = isCurrentMonth ? currentDay : daysInMonth;
  const daysRemaining = isCurrentMonth ? Math.max(1, daysInMonth - currentDay + 1) : daysInMonth;
  const remaining = income - expenses - savings;
  const allowance = remaining / daysRemaining;

  // Update hero card - Daily Allowance
  animateValue('hero-daily-amount', allowance);

  if (allowance < 0) {
    heroDailyEl.classList.add('negative');
    heroDailyEl.classList.remove('warning');
  } else if (allowance < income / daysInMonth * 0.5) {
    heroDailyEl.classList.add('warning');
    heroDailyEl.classList.remove('negative');
  } else {
    heroDailyEl.classList.remove('negative', 'warning');
  }

  // Update secondary metrics
  if (heroLeftEl) {
    heroLeftEl.textContent = fmtCur(Math.abs(remaining));
    heroLeftEl.style.color = remaining >= 0 ? 'var(--color-income)' : 'var(--color-expense)';
  }

  // Today's spending (use integer math to avoid floating-point errors)
  const todayStr = getTodayStr();
  const todayExpensesCents = signals.transactions.value
    .filter(t => t.type === 'expense' && t.date === todayStr)
    .reduce((sum, t) => sum + toCents(t.amount), 0);
  const todayExpenses = todayExpensesCents / 100;

  if (heroTodayEl) {
    heroTodayEl.textContent = fmtCur(todayExpenses);
  }

  // Days remaining
  if (heroDaysEl) {
    heroDaysEl.textContent = String(daysRemaining);
  }

  // Progress bar (days elapsed / days in month)
  const progressPct = (daysElapsed / daysInMonth) * 100;
  if (heroProgressBar) {
    heroProgressBar.style.width = `${progressPct}%`;
    heroProgressBar.setAttribute('aria-valuenow', progressPct.toFixed(0));
  }
  if (heroProgressPct) {
    heroProgressPct.textContent = `${progressPct.toFixed(0)}% complete`;
  }

  // Badge status
  if (heroBadge) {
    if (remaining < 0) {
      heroBadge.textContent = 'Over Budget';
      heroBadge.className = 'stat-badge stat-negative text-xs';
    } else if (allowance < income / daysInMonth * 0.3) {
      heroBadge.textContent = 'Running Low';
      heroBadge.className = 'stat-badge stat-neutral text-xs';
    } else {
      heroBadge.textContent = 'On Track';
      heroBadge.className = 'stat-badge stat-positive text-xs';
    }
  }

  // Motivational messages (context-aware)
  if (heroMotivation) {
    let message = '';
    if (remaining < 0) {
      message = '⚠️ You\'ve exceeded your budget. Time to review spending!';
    } else if (daysRemaining <= 3) {
      message = '🎯 Almost to the finish line! Stay strong!';
    } else if (allowance > income / daysInMonth * 1.5) {
      message = '💪 Great job! You\'re ahead of your budget goals!';
    } else if (allowance < income / daysInMonth * 0.5) {
      message = '🔍 Watch your spending - allowance is running low.';
    } else {
      message = '✨ Stay consistent with tracking for best results!';
    }
    heroMotivation.textContent = message;
  }

  // Update balance card (new in hero layout)
  const balanceEl = DOM.get('total-balance');
  const balanceBadge = DOM.get('balance-badge');
  if (balanceEl) {
    const balance = income - expenses;
    animateValue('total-balance', balance);
    balanceEl.style.color = balance >= 0 ? 'var(--color-income)' : 'var(--color-expense)';

    if (balanceBadge) {
      if (balance > income * 0.3) {
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
}

// ==========================================
// TODAY'S BUDGET
// ==========================================

/**
 * Update today's budget remaining display
 */
export function updateTodayBudget(): void {
  const todayEl = DOM.get('today-remaining');
  if (!todayEl) return;

  const currentMk = signals.currentMonth.value;
  const todayStr = getTodayStr();
  const isCurrentMonth = getMonthKey(new Date()) === currentMk;

  // Get today's expenses (use integer math to avoid floating-point errors)
  const todayExpensesCents = signals.transactions.value
    .filter(t => t.type === 'expense' && t.date === todayStr)
    .reduce((sum, t) => sum + toCents(t.amount), 0);
  const todayExpenses = todayExpensesCents / 100;

  // Calculate daily budget (same logic as updateDailyAllowance)
  const income = getEffectiveIncome(currentMk);
  const { expenses } = calcTotals(getMonthTx());
  const savings = getMonthlySavings(currentMk);
  const remaining = income - expenses - savings;
  const now = new Date();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const daysRemaining = isCurrentMonth ? Math.max(1, daysInMonth - now.getDate() + 1) : daysInMonth;
  const dailyBudget = remaining / daysRemaining;

  // Today's remaining = daily budget - already spent today
  const todayRemaining = dailyBudget - todayExpenses;

  // Update display
  animateValue('today-remaining', todayRemaining);
  todayEl.style.color = todayRemaining >= 0 ? 'var(--color-income)' : 'var(--color-expense)';

  const spentEl = DOM.get('today-spent');
  const budgetEl = DOM.get('today-budget');
  if (spentEl) spentEl.textContent = fmtCur(todayExpenses);
  if (budgetEl) budgetEl.textContent = fmtCur(Math.max(0, dailyBudget));

  // Update badge
  const badge = DOM.get('today-badge');
  if (badge) {
    if (todayRemaining < 0) {
      badge.textContent = 'Over';
      badge.className = 'stat-badge stat-negative text-xs';
    } else if (todayRemaining < dailyBudget * 0.2) {
      badge.textContent = 'Low';
      badge.className = 'stat-badge stat-neutral text-xs';
    } else {
      badge.textContent = 'On Track';
      badge.className = 'stat-badge stat-positive text-xs';
    }
  }
}

// ==========================================
// MONTHLY PACE
// ==========================================

/**
 * Update the monthly pace indicator
 */
export function updateMonthlyPace(): void {
  const now = new Date();
  const currentMk = signals.currentMonth.value;
  const viewDate = parseMonthKey(currentMk);
  const daysInMonth = new Date(viewDate.getFullYear(), viewDate.getMonth()+1, 0).getDate();
  const isCurrentMonth = getMonthKey(now) === currentMk;
  const dayOfMonth = isCurrentMonth ? now.getDate() : daysInMonth;
  const calendarPct = Math.min(100, Math.round((dayOfMonth / daysInMonth) * 100));
  const income = getEffectiveIncome(currentMk);
  const { expenses } = calcTotals(getMonthTx());
  const spendPct = income > 0 ? Math.round((expenses / income) * 100) : 0;
  const barEl = DOM.get('pace-bar');
  const labelEl = DOM.get('pace-label');
  const markerEl = DOM.get('pace-day-marker');
  if (barEl) {
    barEl.style.width = calendarPct + '%';
    barEl.style.background = spendPct > calendarPct ? 'var(--color-expense)' : 'var(--color-income)';
    barEl.setAttribute('aria-valuenow', String(calendarPct));
  }
  if (labelEl) labelEl.textContent = spendPct + '% spent';
  if (markerEl) markerEl.textContent = `Day ${dayOfMonth} / ${daysInMonth}`;
}

// ==========================================
// SIDEBAR DAILY ALLOWANCE CARD
// ==========================================

/**
 * Update the sidebar daily allowance card
 * Uses the getDailyAllowance calculation from calculations.js
 */
export function updateSidebarAllowance(): void {
  const cardEl = DOM.get('daily-allowance-card');
  const amountEl = DOM.get('daily-allowance');
  const subtitleEl = DOM.get('allowance-subtitle');
  const badgeEl = DOM.get('allowance-badge');

  if (!cardEl || !amountEl) return;

  const data = getDailyAllowance(signals.currentMonth.value);

  // Update the daily allowance amount
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
    animateValue('daily-allowance', data.dailyAllowance);

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
}

// ==========================================
// SPENDING PACE INDICATOR
// ==========================================

/**
 * Update the spending pace status indicator
 * Shows if spending is ahead, on track, or behind budget pace
 */
export function updateSpendingPaceIndicator(): void {
  const paceEl = DOM.get('spending-pace-indicator');
  if (!paceEl) return;

  const pace = getSpendingPace(signals.currentMonth.value);

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
}

// ==========================================
// REACTIVE DASHBOARD INITIALIZATION
// ==========================================

/**
 * Cleanup functions for reactive components
 */
let dashboardCleanups: Array<() => void> = [];

/**
 * Initialize all reactive dashboard components.
 * Call this once during app startup to enable automatic UI updates
 * when signals change.
 *
 * @returns Cleanup function to dispose all effects
 */
export function initDashboard(): () => void {
  // Mount all reactive components
  dashboardCleanups = [
    mountSummaryCards(),
    mountEnvelopeBudget(),
    mountBudgetGauge(),
    mountDailyAllowance(),
    mountDebtSummary(),
    mountDebtList(),
    mountSavingsGoals(),
    mountCalendar(),
    mountCharts(),
    mountTransactions()
  ];

  // Return cleanup function
  return () => {
    dashboardCleanups.forEach(cleanup => cleanup());
    dashboardCleanups = [];
  };
}

/**
 * Check if reactive dashboard is initialized
 */
export function isDashboardInitialized(): boolean {
  return dashboardCleanups.length > 0;
}
