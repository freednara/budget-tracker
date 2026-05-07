/**
 * Dashboard Animation Utilities
 * 
 * Animation functions extracted from dashboard module
 * for better separation of concerns.
 * 
 * @module dashboard-animations
 */

import { fmtCur } from '../core/utils-pure.js';
import DOM from '../core/dom-cache.js';

// ==========================================
// ANIMATION CONFIGURATION
// ==========================================

export interface AnimationOptions {
  duration?: number;
  easing?: 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out' | 'cubic';
  format?: 'currency' | 'percent' | 'number';
  decimals?: number;
  prefix?: string;
  suffix?: string;
}

// ==========================================
// EASING FUNCTIONS
// ==========================================

const easingFunctions = {
  linear: (t: number) => t,
  'ease-in': (t: number) => t * t,
  'ease-out': (t: number) => 1 - Math.pow(1 - t, 3),
  'ease-in-out': (t: number) => t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t,
  cubic: (t: number) => 1 - Math.pow(1 - t, 3)
};

// ==========================================
// ANIMATION FUNCTIONS
// ==========================================

// Track active animation frame IDs per element to cancel on re-entry
const activeAnimations = new Map<string, number>();

/**
 * Animate a numeric value with easing
 */
export function animateValue(elId: string, target: number, options: AnimationOptions = {}): void {
  const el = DOM.get(elId);
  if (!el) return;

  // Cancel any in-progress animation on this element
  const existingId = activeAnimations.get(elId);
  if (existingId) cancelAnimationFrame(existingId);

  const {
    duration = 400,
    easing = 'cubic',
    format = 'currency',
    decimals = 2,
    prefix = '',
    suffix = ''
  } = options;

  const current = parseFloat(el.textContent?.replace(/[^0-9.-]/g, '') || '0') || 0;

  // Skip animation if difference is negligible
  if (Math.abs(current - target) < 0.01) {
    el.textContent = formatValue(target, format, decimals, prefix, suffix);
    activeAnimations.delete(elId);
    return;
  }

  const start = performance.now();
  const easingFunc = easingFunctions[easing];

  const animate = (now: number): void => {
    const elapsed = now - start;
    const progress = Math.min(elapsed / duration, 1);
    const eased = easingFunc(progress);
    const val = current + (target - current) * eased;

    el.textContent = formatValue(val, format, decimals, prefix, suffix);

    if (progress < 1) {
      activeAnimations.set(elId, requestAnimationFrame(animate));
    } else {
      activeAnimations.delete(elId);
    }
  };

  activeAnimations.set(elId, requestAnimationFrame(animate));
}

// Phase 5g-1 (Inline-Behavior-Review rev 12, L28): removed three exported
// but unused animation helpers — `animateMultiple`, `animateProgress`,
// `animateOpacity`. Grep across js/ confirmed zero callers for any of the
// three. Two of them (`animateProgress`, `animateOpacity`) also had latent
// race conditions (no activeAnimations tracking — concurrent calls on the
// same element would produce duelling rAF loops and, for `animateOpacity`,
// a Promise-vs-last-frame ordering hazard that could resolve a fade-in
// while a trailing frame from the prior fade-out writes opacity:0).
// Deleting them kills ~70 LOC and removes the affordance trap — if any of
// these helpers is needed later, re-extract from git history with the
// `activeAnimations` cancellation pattern applied. Only `animateValue`
// above is consumed (summary-cards.ts, daily-allowance.ts).

// ==========================================
// UTILITY FUNCTIONS
// ==========================================

/**
 * Format value based on type
 */
function formatValue(
  value: number,
  format: AnimationOptions['format'],
  decimals: number,
  prefix: string,
  suffix: string
): string {
  let formatted: string;
  
  switch (format) {
    case 'currency':
      formatted = fmtCur(value);
      break;
    case 'percent':
      formatted = `${value.toFixed(decimals)}%`;
      break;
    case 'number':
    default:
      formatted = value.toFixed(decimals);
      break;
  }
  
  return `${prefix}${formatted}${suffix}`;
}