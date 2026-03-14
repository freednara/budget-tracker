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
import { getPrevMonthKey } from '../../core/utils.js';
import { getMonthExpByCat, getMonthTx, getEffectiveIncome, calcTotals, getMonthlySavings } from '../financial/calculations.js';
import { ACHIEVEMENTS, showCelebration } from './celebration.js';
import DOM from '../../core/dom-cache.js';
import { html, render, repeat, classMap, styleMap } from '../../core/lit-helpers.js';
import type { Transaction, EarnedAchievement, StreakData } from '../../../types/index.js';

// ==========================================
// TYPE DEFINITIONS
// ==========================================

interface LegacySavingsGoal {
  name: string;
  target_amount: number;
  saved_amount: number;
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
  renderBadges();
}

/**
 * Render achievement badges in the badges container
 */
export function renderBadges(): void {
  const sec = DOM.get('badges-section');
  const el = DOM.get('badges-container');
  if (!sec || !el) return;

  const achievements = signals.achievements.value as Record<string, EarnedAchievement>;

  sec.classList.remove('hidden');

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
}

/**
 * Check all achievement conditions and award any newly earned
 */
export function checkAchievements(): void {
  const achievements = signals.achievements.value as Record<string, EarnedAchievement>;
  const streak = signals.streak.value as StreakData;
  const monthlyAlloc = signals.monthlyAlloc.value as Record<string, Record<string, number>>;
  const savingsGoals = signals.savingsGoals.value as unknown as Record<string, LegacySavingsGoal>;
  const transactions = signals.transactions.value as Transaction[];
  const currentMonth = signals.currentMonth.value;

  // First Budget
  if (Object.keys(monthlyAlloc).length > 0) awardAchievement('first_budget');

  // Streak achievements
  if (streak.current >= 7) awardAchievement('week_warrior');
  if (streak.current >= 30) awardAchievement('month_master');
  if (streak.current >= 365) awardAchievement('year_strong');

  // Savings achievements
  const totalSaved = Object.values(savingsGoals).reduce((s, g) => s + (g.saved_amount || 0), 0);
  if (totalSaved >= 1000) awardAchievement('savers_club');
  if (totalSaved >= 5000) awardAchievement('big_saver');

  // Goal Getter: Any completed savings goal
  const hasCompletedGoal = Object.values(savingsGoals).some(g => g.saved_amount >= g.target_amount);
  if (hasCompletedGoal) awardAchievement('goal_getter');

  // Budget Boss: All allocated categories under budget
  const alloc = monthlyAlloc[currentMonth] || {};
  const allocCats = Object.keys(alloc);
  const totalSpentInAlloc = allocCats.reduce((s, c) => s + getMonthExpByCat(c, currentMonth), 0);
  if (allocCats.length > 0 && totalSpentInAlloc > 0 && allocCats.every(c => getMonthExpByCat(c, currentMonth) <= alloc[c])) {
    awardAchievement('budget_boss');
  }

  // Diversified: 5+ categories used in a month
  const monthTx = getMonthTx() as Transaction[];
  const usedCats = new Set(monthTx.filter(t => t.type === 'expense').map(t => t.category));
  if (usedCats.size >= 5) awardAchievement('diversified');

  // Century Club: 100+ transactions
  if (transactions.length >= 100) awardAchievement('century_club');

  // Penny Pincher: Previous month had positive balance
  const prevMonth = getPrevMonthKey(currentMonth);
  const prevIncome = getEffectiveIncome(prevMonth);
  const prevTx = getMonthTx(prevMonth) as Transaction[];
  const prevExpenses = calcTotals(prevTx).expenses;
  const prevSavings = getMonthlySavings(prevMonth);
  if (prevIncome > 0 && prevIncome - prevExpenses - prevSavings > 0) {
    awardAchievement('penny_pincher');
  }
}
