/**
 * Celebration Module
 *
 * Handles achievement celebrations with confetti animations.
 *
 * @module celebration
 */
'use strict';

import DOM from '../../core/dom-cache.js';
import { emit, Events } from '../../core/event-bus.js';
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

// ==========================================
// CONFETTI STATE (module-scoped)
// ==========================================
// Phase 6 Slice 1k (Inline-Behavior-Review rev 12, L26 part 2): the
// `spawnConfetti` concurrency path previously had no re-entrancy guard.
// `awardAchievement` calls `showCelebration` → `spawnConfetti` on every
// unlock, so a synchronous burst of achievements (the canonical
// onboarding case: `first_budget` + `diversified` + `savers_club`
// unlock together when the user seeds demo data) would spawn
// `config.confettiCount * N` DOM nodes with N * confettiCount
// independent self-removal setTimeouts. One visual confetti burst
// reads the same as three stacked; stacking only costs DOM + scheduler
// time and creates a shape that scales poorly as the catalog grows.
//
// The guard: while a burst is in flight (particles on screen), a
// second spawnConfetti call is a no-op. After `config.confettiRemoval`
// ms — matching the self-removal timeout each particle is born with —
// the guard re-arms so the NEXT unlock cluster (hours / sessions
// later) fires fresh. The spawned particles are tracked in an array so
// `clearConfetti()` can eagerly remove them plus cancel pending
// self-removal timeouts (early-dismiss path, test teardown).
let confettiActive = false;
const confettiParticles: HTMLElement[] = [];
const confettiRemovalTimers: ReturnType<typeof setTimeout>[] = [];
let confettiReArmTimeoutId: ReturnType<typeof setTimeout> | null = null;

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
 * Spawn confetti particles.
 *
 * Re-entrancy guard: while a burst is in flight, a second call is a
 * no-op. Use `clearConfetti()` for the early-dismiss / test-teardown
 * path that wants to cancel the in-flight burst and re-arm
 * immediately.
 */
export function spawnConfetti(): void {
  if (confettiActive) return;
  confettiActive = true;

  const style = getComputedStyle(document.documentElement);
  const token = (name: string) => style.getPropertyValue(name).trim();
  const colors = [
    token('--color-expense'),
    token('--color-accent'),
    token('--color-income'),
    token('--color-warning'),
    token('--color-purple'),
    token('--color-pink'),
    token('--color-accent2'),
  ].filter(Boolean);

  for (let i = 0; i < config.confettiCount; i++) {
    const p = document.createElement('div');
    p.className = 'confetti-particle';
    p.style.left = Math.random() * 100 + 'vw';
    p.style.top = '-10px';
    // Phase 6 Slice 1i (rev 12 L6): `colors[i]` is `string | undefined`
    // under `noUncheckedIndexedAccess`; the array is non-empty (filter
    // above keeps truthy colors) but `?? ''` keeps the CSS assignment
    // well-typed when the color list is empty.
    p.style.background = colors[Math.floor(Math.random() * colors.length)] ?? '';
    p.style.animationDelay = Math.random() * 1 + 's';
    p.style.animationDuration = (config.confettiDurationBase + Math.random()) + 's';
    document.body.appendChild(p);
    confettiParticles.push(p);
    const removalId = setTimeout(() => {
      p.remove();
    }, config.confettiRemoval);
    confettiRemovalTimers.push(removalId);
  }

  // Re-arm the guard after the last particle self-removes. Pending
  // particles for the *current* burst are tracked in
  // `confettiParticles` and remain available to `clearConfetti()`
  // until this timer fires.
  confettiReArmTimeoutId = setTimeout(() => {
    confettiActive = false;
    confettiParticles.length = 0;
    confettiRemovalTimers.length = 0;
    confettiReArmTimeoutId = null;
  }, config.confettiRemoval);
}

/**
 * Cancel the in-flight confetti burst (if any): eagerly remove all
 * tracked particle nodes, cancel pending self-removal timeouts, and
 * re-arm the spawn guard immediately so the next `spawnConfetti()`
 * call starts a fresh burst.
 *
 * Safe to call when no burst is in flight (no-op).
 */
export function clearConfetti(): void {
  for (const timerId of confettiRemovalTimers) {
    clearTimeout(timerId);
  }
  confettiRemovalTimers.length = 0;

  for (const particle of confettiParticles) {
    particle.remove();
  }
  confettiParticles.length = 0;

  if (confettiReArmTimeoutId !== null) {
    clearTimeout(confettiReArmTimeoutId);
    confettiReArmTimeoutId = null;
  }

  confettiActive = false;
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
    emit(Events.CLOSE_MODAL, { id: 'celebration-overlay' });
    celebrationTimeoutId = null;
  }, config.celebrationDuration);
}
