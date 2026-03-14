/**
 * Streak Tracker Module
 *
 * Tracks daily logging streaks for gamification.
 *
 * @module streak-tracker
 */
'use strict';

import { SK, persist } from '../../core/state.js';
import * as signals from '../../core/signals.js';
import { getTodayStr } from '../../core/utils.js';
import DOM from '../../core/dom-cache.js';
import type { StreakData } from '../../../types/index.js';

/**
 * Check and update streak when a transaction is logged
 * Only counts transactions logged on the current day
 */
export function checkStreak(txDate: string): void {
  const today = getTodayStr();

  // Historical transaction - don't touch streak
  if (txDate !== today) return;

  const streak = signals.streak.value as StreakData;

  // Already logged today
  if (streak.lastDate === today) return;

  // Calculate yesterday's date
  const yesterdayDate = new Date(Date.now() - 86400000); // 24 hours ago
  const yesterday = `${yesterdayDate.getFullYear()}-${String(yesterdayDate.getMonth() + 1).padStart(2, '0')}-${String(yesterdayDate.getDate()).padStart(2, '0')}`;

  // Continue streak or start new one
  if (streak.lastDate === yesterday) {
    streak.current++;
  } else {
    streak.current = 1;
  }

  streak.lastDate = today;
  streak.longest = Math.max(streak.longest, streak.current);
  signals.streak.value = { ...streak };
  persist(SK.STREAK, signals.streak.value);
  renderStreak();
}

/**
 * Render the streak widget UI
 */
export function renderStreak(): void {
  const widget = DOM.get('streak-widget');
  if (!widget) return;

  const streak = signals.streak.value as StreakData;

  if (streak.current > 0) {
    widget.classList.remove('hidden');
    const countEl = DOM.get('streak-count');
    if (countEl) countEl.textContent = String(streak.current);
  } else {
    widget.classList.add('hidden');
  }
}

/**
 * Get current streak info
 */
export function getStreakInfo(): StreakData {
  const streak = signals.streak.value as StreakData;
  return { ...streak };
}
