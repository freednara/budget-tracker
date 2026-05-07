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
import { achievements as achievementActions } from '../../core/state-actions.js';
import { getPrevMonthKey, toCents } from '../../core/utils-pure.js';
// M33 (Phase 5f): `...Sync` suffix dropped — monthly-totals-cache is now sync-only.
import { calculateMonthlyTotalsWithCache } from '../../core/monthly-totals-cache.js';
import { isTrackedExpenseTransaction } from '../../core/transaction-classification.js';
import { getMonthlySavings } from '../financial/calculations.js';
import { ACHIEVEMENTS, showCelebration } from './celebration.js';
import DOM from '../../core/dom-cache.js';
import { html, render, repeat, classMap, styleMap } from '../../core/lit-helpers.js';
import { on, Events, createListenerGroup, destroyListenerGroup } from '../../core/event-bus.js';
import { effect } from '@preact/signals-core';
import { FeatureEvents } from '../../core/feature-event-interface.js';
import type { Transaction, EarnedAchievement } from '../../../types/index.js';

// ==========================================
// TYPE DEFINITIONS
// ==========================================

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

// Round 7 fix: Queue for achievement celebrations to prevent simultaneous modals
let celebrationQueue: string[] = [];
let isCelebrationActive = false;

function processCelebrationQueue(): void {
  // Round 7 fix: If a celebration is already in progress, return immediately.
  // The queue will be drained when the current celebration completes and
  // recursively calls this function again.
  if (isCelebrationActive) {
    return;
  }

  // If there are no more celebrations to show, we're done
  if (celebrationQueue.length === 0) {
    return;
  }

  // Pop the first celebration from the queue and show it
  isCelebrationActive = true;
  const key = celebrationQueue.shift();
  if (!key) {
    isCelebrationActive = false;
    return;
  }

  // Show the celebration. The modal will be active for celebrationDuration ms
  // (typically 4000ms as per celebration.ts config). After that time expires,
  // mark the celebration as inactive and recursively process the next item
  // in the queue.
  showCelebration(key);
  
  // Round 7 fix: Use a reasonable timeout to allow the celebration modal
  // to display and then automatically dismiss. This allows the queue to
  // drain sequentially without waiting for explicit user interaction.
  setTimeout(() => {
    isCelebrationActive = false;
    processCelebrationQueue();
  }, 4500); // Slightly longer than celebrationDuration to ensure modal is dismissed
}

/**
 * Award an achievement to the user.
 *
 * Fixes M25a (Inline-Behavior-Review rev 12): signal mutation now routes
 * through `achievements.award` in state-actions, matching how every other
 * feature module in this codebase writes to signals. The old direct
 * `signals.achievements.value = { ... }` write was the only bypass in the
 * `gamification/` tree — removing it closes the contract gap and gives any
 * future cross-cutting concern (event emission, telemetry, test doubles) a
 * single node to hook. `award(...)` returns `true` only when a new badge
 * was recorded, so `persist` + celebration only run on a fresh award
 * instead of every call — eliminates the old "re-celebrate on redundant
 * awardAchievement call" artifact.
 *
 * Round 7 fix: Celebration modals are queued to prevent simultaneous popups
 * which can confuse the user and cause layout thrashing. Only one modal
 * displays at a time with proper sequencing through a recursive queue.
 */
export function awardAchievement(key: string): void {
  const awarded = achievementActions.award(key);
  if (!awarded) return;
  persist(SK.ACHIEVE, signals.achievements.value);
  // Queue the celebration instead of showing it immediately
  celebrationQueue.push(key);
  void processCelebrationQueue();
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
  const streak = signals.streak.value;
  const monthlyAlloc = signals.monthlyAlloc.value;
  // Fixes H7: signal now holds canonical `Record<string, SavingsGoal>`
  // (normalized at hydration). Read `target` / `saved` directly — the
  // previous double-cast through LegacySavingsGoal made newly-created
  // goals silently fail these checks (undefined >= undefined → false).
  const savingsGoals = signals.savingsGoals.value;
  const currentMonth = signals.currentMonth.value;

  // First Budget
  if (Object.keys(monthlyAlloc).length > 0) awardAchievement('first_budget');

  // Streak achievements
  if (streak.current >= 7) awardAchievement('week_warrior');
  if (streak.current >= 30) awardAchievement('month_master');
  if (streak.current >= 365) awardAchievement('year_strong');

  // Savings achievements (using cents-first math)
  const totalSavedCents = Object.values(savingsGoals).reduce((sum, g) => sum + toCents(g.saved || 0), 0);
  if (totalSavedCents >= 100000) awardAchievement('savers_club');
  if (totalSavedCents >= 500000) awardAchievement('big_saver');

  // Goal Getter: Any completed savings goal
  // rev 12 #16 / M23 (cents-math migration): compare in integer cents.
  // Float comparison `g.saved >= g.target` can flip FALSE when saved is
  // $0.01 short (addAmounts in data-actions rounds to cents, but any
  // legacy dollar-path `saved` carries FP noise); it can also flip TRUE
  // when saved is a penny under target after a contribution rollover
  // (e.g. 99.99999999 >= 100.0). Routing through toCents makes the
  // check byte-accurate — no penny-short false negatives, no FP-noise
  // false positives.
  const hasCompletedGoal = Object.values(savingsGoals).some(g => toCents(g.saved || 0) >= toCents(g.target || 0));
  if (hasCompletedGoal) awardAchievement('goal_getter');

  // Budget Boss: All allocated categories under budget
  // rev 12 #16 / M23 (cents-math migration): compare in integer cents so
  // an over-budget category can't flip `budget_boss` green on a rounding
  // rollover (e.g. spent $50.000000001 vs. allocated $50 → was true in
  // float, now correctly false).
  const alloc = monthlyAlloc[currentMonth] || {};
  const allocCats = Object.keys(alloc);
  const expensesByCategory = signals.expensesByCategory.value;
  if (allocCats.length > 0 && allocCats.every(c => toCents(expensesByCategory[c] || 0) <= toCents(alloc[c] || 0))) {
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

  // Fixes M25b (Inline-Behavior-Review rev 12): `early_bird` / `night_owl`
  // used to fire from this sweep with the gate `hour < 9 &&
  // transactionCount > 0` — which meant any user with any historical
  // transaction got `early_bird` simply by opening the app before 9am,
  // regardless of whether they had logged anything that session. The
  // celebration metadata at celebration.ts:27,32 literally says "Log an
  // expense before 9am" / "Log an expense after 10pm", so the sweep gate
  // was off-spec. The hour-window check has moved to a
  // `TRANSACTION_ADDED` listener wired in `initAchievements`, which fires
  // only on a newly logged tracked-expense transaction.

  // Penny Pincher: Previous month had positive net balance
  const prevMonth = getPrevMonthKey(currentMonth);
  const prevTotals = calculateMonthlyTotalsWithCache(prevMonth);
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
 * Transaction-level gate for time-of-day achievements.
 *
 * Fixes M25b (Inline-Behavior-Review rev 12): `early_bird` and `night_owl`
 * used to fire from the sweep-style `checkAchievements()` with the gate
 * `hour < 9 && transactionCount > 0`, which matched "user has any
 * transaction in history AND happens to have opened the app in the
 * window" rather than the celebration-metadata text "Log an expense
 * before 9am" / "Log an expense after 10pm". This listener enforces the
 * spec: fire only when a newly logged, tracked-expense transaction lands
 * inside the hour window — using the transaction's own `createdAt` when
 * available (fallback to wall-clock `Date.now()` for legacy payloads).
 * Savings-transfer transactions are excluded via `isTrackedExpenseTransaction`
 * so a scheduled contribution at 8am doesn't accidentally earn `early_bird`.
 */
function handleTransactionAddedForTimeAchievements(tx: unknown): void {
  if (!tx || typeof tx !== 'object') return;
  const txRecord = tx as Transaction & { createdAt?: string };
  if (!isTrackedExpenseTransaction(txRecord)) return;

  // Prefer the transaction's own logged-at time so back-dated entries
  // (user fills in yesterday's coffee at 11pm) still key on when the
  // action was taken, not on the transaction's `date` field (which
  // reflects spend date, not logging time).
  const loggedAt = txRecord.createdAt ? new Date(txRecord.createdAt) : new Date();
  const hour = Number.isFinite(loggedAt.getTime()) ? loggedAt.getHours() : new Date().getHours();

  if (hour < 9) awardAchievement('early_bird');
  if (hour >= 22) awardAchievement('night_owl');
}

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

  // CR-Apr24-F finding 241: the emitter (feature-event-interface.ts)
  // sends `{ id }` but the listener was typed as receiving a raw string.
  // Destructure the object to extract the actual achievement key.
  on(FeatureEvents.AWARD_ACHIEVEMENT, (payload: { id: string } | string) => {
    const achievementId = typeof payload === 'string' ? payload : payload.id;
    if (achievementId) awardAchievement(achievementId);
  }, { groupId: achievementsListenerGroupId });

  // Fixes M25b: time-of-day achievements are gated on fresh
  // tracked-expense additions, not on the sweep-style checkAchievements
  // pass. See handleTransactionAddedForTimeAchievements above.
  on(Events.TRANSACTION_ADDED, (tx: unknown) => {
    handleTransactionAddedForTimeAchievements(tx);
  }, { groupId: achievementsListenerGroupId });
}
