/**
 * Rate Limiter Module - Brute-force protection for PIN entry
 *
 * Tracks failed PIN attempts and enforces exponential lockout.
 * State is persisted in localStorage so lockouts survive page refreshes.
 *
 * @module rate-limiter
 */
'use strict';

import { CONFIG } from '../../core/config.js';

// ==========================================
// TYPES
// ==========================================

interface RateLimitState {
  attempts: number;
  lockoutCount: number;
  lockedUntil: number; // epoch ms, 0 = not locked
}

export interface RateLimitCheck {
  allowed: boolean;
  waitMs: number;
  attemptsRemaining: number;
}

// ==========================================
// CONSTANTS
// ==========================================

const STORAGE_KEY = '_pin_rate_limit';
const MAX_ATTEMPTS = CONFIG.RATE_LIMIT.MAX_ATTEMPTS;
const BASE_LOCKOUT_MS = CONFIG.RATE_LIMIT.BASE_LOCKOUT_MS;

// ==========================================
// STATE HELPERS
// ==========================================

function loadState(): RateLimitState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as RateLimitState;
      if (
        typeof parsed.attempts === 'number' &&
        typeof parsed.lockoutCount === 'number' &&
        typeof parsed.lockedUntil === 'number'
      ) {
        return parsed;
      }
    }
  } catch {
    // Corrupted data — reset
  }
  return { attempts: 0, lockoutCount: 0, lockedUntil: 0 };
}

function saveState(state: RateLimitState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage full or unavailable — silently ignore
  }
}

// ==========================================
// PUBLIC API
// ==========================================

/**
 * Check whether a PIN attempt is currently allowed.
 */
export function checkRateLimit(): RateLimitCheck {
  const state = loadState();
  const now = Date.now();

  // Currently in lockout?
  if (state.lockedUntil > now) {
    return {
      allowed: false,
      waitMs: state.lockedUntil - now,
      attemptsRemaining: 0
    };
  }

  // Lockout has expired — clear it but keep lockoutCount for escalation
  if (state.lockedUntil > 0 && state.lockedUntil <= now) {
    state.attempts = 0;
    state.lockedUntil = 0;
    saveState(state);
  }

  const remaining = MAX_ATTEMPTS - state.attempts;
  return {
    allowed: remaining > 0,
    waitMs: 0,
    attemptsRemaining: remaining
  };
}

/**
 * Record a PIN attempt result.
 * On success: resets all rate-limit state.
 * On failure: increments counter and may trigger lockout.
 */
export function recordAttempt(success: boolean): void {
  if (success) {
    resetRateLimit();
    return;
  }

  const state = loadState();
  state.attempts += 1;

  if (state.attempts >= MAX_ATTEMPTS) {
    // Exponential lockout: base * 2^lockoutCount
    const lockoutMs = BASE_LOCKOUT_MS * Math.pow(2, state.lockoutCount);
    state.lockedUntil = Date.now() + lockoutMs;
    state.lockoutCount += 1;
    // Keep attempts at max so checkRateLimit stays locked until expiry
  }

  saveState(state);
}

/**
 * Fully reset rate-limit state (e.g. after successful PIN entry or PIN removal).
 */
export function resetRateLimit(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore
  }
}

// ==========================================
// FORMATTING HELPER
// ==========================================

/**
 * Format a lockout duration in milliseconds to a human-readable string.
 * Examples: "5 seconds", "1 minute", "2 minutes 30 seconds"
 */
export function formatLockoutTime(ms: number): string {
  if (ms <= 0) return '0 seconds';

  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  const parts: string[] = [];
  if (minutes > 0) {
    parts.push(`${minutes} minute${minutes === 1 ? '' : 's'}`);
  }
  if (seconds > 0 || parts.length === 0) {
    parts.push(`${seconds} second${seconds === 1 ? '' : 's'}`);
  }

  return parts.join(' ');
}
