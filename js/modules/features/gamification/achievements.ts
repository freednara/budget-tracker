/**
 * Achievements Module
 *
 * Handles achievement checking, awarding, and badge rendering.
 *
 * @module achievements
 */
'use strict';

import { SK, persist } from '../../core/state.js';
import * as signals from '../../core/signals.js';
import { getPrevMonthKey, toCents, toDollars } from '../../core/utils.js';
import { calculateMonthlyTotalsWithCacheSync } from '../../core/monthly-totals-cache.js';
import { isTrackedExpenseTransaction } from '../../core/transaction-classification.js';
import { getMonthlySavings } from '../financial/calculations.js';
import { ACHIEVEMENTS, showCelebration } from './celebration.js';
import DOM from '../../core/dom-cache.js';
import { html, render, repeat, classMap, styleMap, nothing } from '../../core/lit-helpers.js';
import { on, createListenerGroup, destroyListenerGroup } from '../../core/event-bus.js';
import { effect } from '@preact/signals-core';
import { FeatureEvents } from '../../core/feature-event-interface.js';
import type { Transaction, EarnedAchievement, StreakData, LegacySavingsGoal } from '../../../types/index.js';

// ==========================================
// TYPE DEFINITIONS
// ==========================================

// Using LegacySavingsGoal from central types
let achievementsListenerGroupId: string | null = null;

export function cleanupAchievements(): void {
  if (achievementsListenerGroupId) {
    destroyListenerGroup(achievementsListenerGroupId);
    achievementsListenerGroupId = null;
  }
}

// ==========================================
// ACHIEVEMENT FUNCTIONS
// ==========================================

/**
 * Award an achievement to the user
 */
export function awardAchievement(key: string): void {
  const achievements = signals.achievements.value as Record<string, EarnedAchievement>;
  if (achievements[key]) return;

  signals.achievements.value = { ...achievements, [key]: { earned: true, date: new Date().toISOString() } };
  persist(SK.ACHIEVE, signals.achievements.value);
  showCelebration(key);
  }
/**
 * Mount achievement badges with reactive updates
 */
export function mountBadges(): () => void {
  const sec = DOM.get('badges-section');
  const el = DOM.get('badges-container');
  if (!sec || !el) return () => {};

  const cleanup = effect(() => {
    const achievements = signals.achievements.value as Record<string, EarnedAchievement>;
    const earnedCount = Object.keys(achievements).length;

    // Reactively show/hide section
    if (earnedCount > 0) {
      sec.classList.remove('hidden');
    } else {
      sec.classList.add('hidden');
    }

    render(html`
      ${repeat(ACHIEVEMENTS, a => a.id, a => {
        const earned = achievements[a.id];
        return html`
          <div class=${classMap({ 'badge-card': true, 'earned': !!earned, 'locked': !earned })}
               title=${a.desc}>
            <div class="text-2xl mb-1">${a.emoji}</div>
            <div class="text-xs font-bold"
                 style=${styleMap({ color: earned ? 'var(--color-warning)' : 'var(--text-tertiary)' })}>
              ${a.name}
            </div>
          </div>
        `;
      })}
    `, el);
  });

  return cleanup;
}

/**
 * Check all achievement conditions and award any newly earned
 * FIXED: Now fully optimized with cached totals
 */
export function checkAchievements(): void {
  const streak = signals.streak.value as StreakData;
  const monthlyAlloc = signals.monthlyAlloc.value;
  const savingsGoals = signals.savingsGoals.value as unknown as Record<string, LegacySavingsGoal>;
  const currentMonth = signals.currentMonth.value;

  // First Budget
  if (Object.keys(monthlyAlloc).length > 0) awardAchievement('first_budget');

  // Streak achievements
  if (streak.current >= 7) awardAchievement('week_warrior');
  if (streak.current >= 30) awardAchievement('month_master');
  if (streak.current >= 365) awardAchievement('year_strong');

  // Savings achievements (using cents-first math)
  const totalSavedCents = Object.values(savingsGoals).reduce((sum, g) => sum + toCents(g.saved_amount || 0), 0);
  if (totalSavedCents >= 100000) awardAchievement('savers_club');
  if (totalSavedCents >= 500000) awardAchievement('big_saver');

  // Goal Getter: Any completed savings goal
  const hasCompletedGoal = Object.values(savingsGoals).some(g => g.saved_amount >= g.target_amount);
  if (hasCompletedGoal) awardAchievement('goal_getter');

  // Budget Boss: All allocated categories under budget
  const alloc = monthlyAlloc[currentMonth] || {};
  const allocCats = Object.keys(alloc);
  const expensesByCategory = signals.expensesByCategory.value;
  if (allocCats.length > 0 && allocCats.every(c => (expensesByCategory[c] || 0) <= alloc[c])) {
    awardAchievement('budget_boss');
  }

  // Diversified: 5+ categories used in current month
  const usedCats = new Set(
    signals.currentMonthTx.value
      .filter((t: Transaction) => isTrackedExpenseTransaction(t))
      .map((t: Transaction) => t.category)
  );
  if (usedCats.size >= 5) awardAchievement('diversified');

  // Century Club: 100+ transactions
  if (signals.transactionCount.value >= 100) awardAchievement('century_club');

  // Time-based achievements
  const hour = new Date().getHours();
  if (hour < 9 && signals.transactionCount.value > 0) awardAchievement('early_bird');
  if (hour >= 22 && signals.transactionCount.value > 0) awardAchievement('night_owl');

  // Penny Pincher: Previous month had positive net balance
  const prevMonth = getPrevMonthKey(currentMonth);
  const prevTotals = calculateMonthlyTotalsWithCacheSync(prevMonth);
  const prevSavings = getMonthlySavings(prevMonth);
  
  if (prevTotals.income > 0) {
    const netBalance = toCents(prevTotals.income) - toCents(prevTotals.expenses) - toCents(prevSavings);
    if (netBalance > 0) {
      awardAchievement('penny_pincher');
    }
  }
}

// ==========================================
// INITIALIZATION
// ==========================================

/**
 * Initialize achievements module and register feature event listeners
 */
export function initAchievements(): void {
  cleanupAchievements();
  achievementsListenerGroupId = createListenerGroup('achievements');

  // Action: Check achievements
  on(FeatureEvents.CHECK_ACHIEVEMENTS, () => {
    checkAchievements();
  }, { groupId: achievementsListenerGroupId });

  // Action: Award achievement
  on(FeatureEvents.AWARD_ACHIEVEMENT, (id: string) => {
    awardAchievement(id);
  }, { groupId: achievementsListenerGroupId });
}
