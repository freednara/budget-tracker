/**
 * Celebration Module
 *
 * Handles achievement celebrations with confetti animations.
 *
 * @module celebration
 */
'use strict';

import DOM from '../../core/dom-cache.js';
import { closeModal } from '../../ui/core/ui.js';
import type { AchievementDefinition, CelebrationConfig } from '../../../types/index.js';

// ==========================================
// ACHIEVEMENT DEFINITIONS
// ==========================================

export const ACHIEVEMENTS: readonly AchievementDefinition[] = [
  { id: 'first_budget', name: 'First Budget', emoji: '📋', desc: 'Set your first monthly budget allocation' },
  { id: 'week_warrior', name: 'Week Warrior', emoji: '⚔️', desc: '7-day logging streak' },
  { id: 'month_master', name: 'Month Master', emoji: '👑', desc: '30-day logging streak' },
  { id: 'savers_club', name: "Saver's Club", emoji: '🏦', desc: 'Save $1,000 total' },
  { id: 'budget_boss', name: 'Budget Boss', emoji: '🏆', desc: 'All categories under budget for a month' },
  { id: 'diversified', name: 'Diversified', emoji: '🌈', desc: 'Use 5+ categories in one month' },
  { id: 'data_pro', name: 'Data Pro', emoji: '💾', desc: 'Export your data' },
  { id: 'century_club', name: 'Century Club', emoji: '💯', desc: 'Log 100 transactions' },
  { id: 'early_bird', name: 'Early Bird', emoji: '🌅', desc: 'Log an expense before 9am' },
  { id: 'penny_pincher', name: 'Penny Pincher', emoji: '🪙', desc: 'Finish a month with money left over' },
  { id: 'goal_getter', name: 'Goal Getter', emoji: '🎯', desc: 'Complete a savings goal' },
  { id: 'big_saver', name: 'Big Saver', emoji: '💰', desc: 'Save $5,000 total' },
  { id: 'year_strong', name: 'Year Strong', emoji: '🗓️', desc: '365-day logging streak' },
  { id: 'night_owl', name: 'Night Owl', emoji: '🦉', desc: 'Log an expense after 10pm' }
] as const;

// ==========================================
// CONFIGURATION
// ==========================================

// Default animation settings
const DEFAULTS: CelebrationConfig = {
  celebrationDuration: 4000,
  confettiRemoval: 3000,
  confettiCount: 30,
  confettiDurationBase: 1.5
};

// Configurable settings
let config: CelebrationConfig = { ...DEFAULTS };
let celebrationTimeoutId: ReturnType<typeof setTimeout> | null = null;

/**
 * Configure celebration settings
 */
export function configureCelebration(options: Partial<CelebrationConfig>): void {
  config = { ...config, ...options };
}

// ==========================================
// ACHIEVEMENT HELPERS
// ==========================================

/**
 * Get achievement by ID
 */
export function getAchievement(id: string): AchievementDefinition | undefined {
  return ACHIEVEMENTS.find(a => a.id === id);
}

/**
 * Get all achievements
 */
export function getAllAchievements(): AchievementDefinition[] {
  return [...ACHIEVEMENTS];
}

// ==========================================
// CELEBRATION DISPLAY
// ==========================================

/**
 * Spawn confetti particles
 */
export function spawnConfetti(): void {
  const colors = ['#ef4444', '#3b82f6', '#22c55e', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4'];

  for (let i = 0; i < config.confettiCount; i++) {
    const p = document.createElement('div');
    p.className = 'confetti-particle';
    p.style.left = Math.random() * 100 + 'vw';
    p.style.top = '-10px';
    p.style.background = colors[Math.floor(Math.random() * colors.length)];
    p.style.animationDelay = Math.random() * 1 + 's';
    p.style.animationDuration = (config.confettiDurationBase + Math.random()) + 's';
    document.body.appendChild(p);
    setTimeout(() => p.remove(), config.confettiRemoval);
  }
}

/**
 * Show celebration modal for an achievement
 */
export function showCelebration(achieveId: string): void {
  const a = getAchievement(achieveId);
  if (!a) return;

  const overlay = DOM.get('celebration-overlay');
  const emojiEl = DOM.get('celebration-emoji');
  const titleEl = DOM.get('celebration-title');
  const descEl = DOM.get('celebration-desc');

  if (!overlay || !emojiEl || !titleEl || !descEl) return;

  emojiEl.textContent = a.emoji;
  titleEl.textContent = 'Achievement Unlocked!';
  descEl.textContent = a.desc;

  if (celebrationTimeoutId) {
    clearTimeout(celebrationTimeoutId);
  }

  overlay.classList.add('active');
  spawnConfetti();
  celebrationTimeoutId = setTimeout(() => {
    closeModal('celebration-overlay');
    celebrationTimeoutId = null;
  }, config.celebrationDuration);
}
