/**
 * Dashboard Animation Utilities
 * 
 * Animation functions extracted from dashboard module
 * for better separation of concerns.
 * 
 * @module dashboard-animations
 */

import { fmtCur } from '../core/utils.js';
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

/**
 * Animate multiple values simultaneously
 */
export function animateMultiple(animations: Array<{ elId: string; target: number; options?: AnimationOptions }>): void {
  animations.forEach(({ elId, target, options }) => {
    animateValue(elId, target, options);
  });
}

/**
 * Animate a progress bar width
 */
export function animateProgress(elId: string, percent: number, duration = 400): void {
  const el = DOM.get(elId);
  if (!el || !(el instanceof HTMLElement)) return;
  
  const current = parseFloat(el.style.width) || 0;
  const start = performance.now();
  
  const animate = (now: number): void => {
    const elapsed = now - start;
    const progress = Math.min(elapsed / duration, 1);
    const eased = easingFunctions['ease-out'](progress);
    const width = current + (percent - current) * eased;
    
    el.style.width = `${width}%`;
    
    if (progress < 1) {
      requestAnimationFrame(animate);
    }
  };
  
  requestAnimationFrame(animate);
}

/**
 * Animate element opacity (fade in/out)
 */
export function animateOpacity(elId: string, targetOpacity: number, duration = 300): Promise<void> {
  return new Promise((resolve) => {
    const el = DOM.get(elId);
    if (!el || !(el instanceof HTMLElement)) {
      resolve();
      return;
    }
    
    // Cache computed opacity on the element to avoid forcing layout on subsequent calls
    const cachedOpacity = el.dataset._cachedOpacity;
    const current = cachedOpacity !== undefined
      ? parseFloat(cachedOpacity) || 0
      : parseFloat(window.getComputedStyle(el).opacity) || 0;
    const start = performance.now();
    
    const animate = (now: number): void => {
      const elapsed = now - start;
      const progress = Math.min(elapsed / duration, 1);
      const eased = easingFunctions['ease-in-out'](progress);
      const opacity = current + (targetOpacity - current) * eased;
      
      el.style.opacity = String(opacity);
      // Update cached opacity so subsequent calls skip getComputedStyle
      el.dataset._cachedOpacity = String(opacity);

      if (progress < 1) {
        requestAnimationFrame(animate);
      } else {
        resolve();
      }
    };
    
    requestAnimationFrame(animate);
  });
}

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