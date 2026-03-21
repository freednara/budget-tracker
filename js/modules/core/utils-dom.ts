/**
 * DOM Utility Functions Module
 * 
 * Contains utility functions that depend on DOM or browser APIs.
 * These functions require a browser environment to function properly.
 *
 * @module utils-dom
 */

import { esc as escPure, sanitize } from './utils-pure.js';

// ==========================================
// FILE/DOWNLOAD UTILITIES
// ==========================================

/**
 * Download blob as file
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ==========================================
// DATE FORMATTING
// ==========================================

/**
 * Get month badge HTML string
 */
export function getMonthBadge(monthKey: string): string {
  const [y, m] = monthKey.split('-');
  const monthName = new Date(parseInt(y), parseInt(m) - 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  return `<span class="time-badge">${monthName}</span>`;
}

// ==========================================
// HTML/XSS PROTECTION
// ==========================================

/**
 * Escape HTML special characters with enhanced XSS protection
 */
export function esc(str: string): string {
  // Delegate to pure version for consistency
  const escaped = escPure(str);
  
  // Additional proactive logging for suspicious patterns in DOM-based contexts
  if (typeof str === 'string' && /<script|<iframe|javascript:|data:/i.test(str)) {
    if (import.meta.env.DEV) console.warn('[Security] Proactively sanitized suspicious input:', str.substring(0, 50));
  }
  
  return escaped;
}

// Alias for backwards compatibility
export { esc as escapeHtml };

/**
 * Safely set innerHTML with additional XSS protection
 * Use this instead of direct innerHTML assignment for user-generated content
 */
export function safeSetHTML(element: HTMLElement | null, html: string): void {
  if (!element || typeof html !== 'string') return;

  // Use robust sanitizer before setting innerHTML
  const cleanHtml = sanitize(html);
  
  if (cleanHtml !== html) {
    if (import.meta.env.DEV) console.warn('[Security] Stripped potentially dangerous content from HTML string');
  }

  element.innerHTML = cleanHtml;
}

// ==========================================
// ID GENERATION (CRYPTO-SECURE)
// ==========================================

/**
 * Generate cryptographically secure unique ID
 * Uses crypto API with fallback to Math.random
 */
export function generateSecureId(): string {
  // Use crypto.randomUUID() if available (Chrome 92+, Safari 15.4+)
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  // Fallback for older browsers using crypto.getRandomValues()
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = (crypto.getRandomValues(new Uint8Array(1))[0] & 15) | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  // Final fallback using Math.random() (not cryptographically secure)
  if (import.meta.env.DEV) console.warn('Using Math.random() for ID generation - not cryptographically secure');
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// Maintain backwards compatibility with original name
export { generateSecureId as generateId };

// ==========================================
// CLIPBOARD UTILITIES
// ==========================================

/**
 * Copy text to clipboard
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      // Use modern clipboard API
      await navigator.clipboard.writeText(text);
      return true;
    } else {
      // Fallback for older browsers
      const textArea = document.createElement('textarea');
      textArea.value = text;
      textArea.style.position = 'fixed';
      textArea.style.left = '-999999px';
      textArea.style.top = '-999999px';
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();
      
      const successful = document.execCommand('copy');
      document.body.removeChild(textArea);
      return successful;
    }
  } catch (err) {
    if (import.meta.env.DEV) console.error('Failed to copy to clipboard:', err);
    return false;
  }
}

// ==========================================
// VISIBILITY UTILITIES
// ==========================================

/**
 * Check if element is visible in viewport
 */
export function isElementInViewport(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  return (
    rect.top >= 0 &&
    rect.left >= 0 &&
    rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
    rect.right <= (window.innerWidth || document.documentElement.clientWidth)
  );
}

/**
 * Scroll element into view with smooth animation
 */
export function scrollIntoViewSmooth(element: Element, options?: ScrollIntoViewOptions): void {
  element.scrollIntoView({
    behavior: 'smooth',
    block: 'nearest',
    ...options
  });
}

// ==========================================
// FOCUS MANAGEMENT
// ==========================================

/**
 * Trap focus within a container (useful for modals)
 */
export function trapFocus(container: HTMLElement): () => void {
  const focusableElements = container.querySelectorAll<HTMLElement>(
    'a[href], button, textarea, input[type="text"], input[type="radio"], input[type="checkbox"], select'
  );
  
  const firstFocusable = focusableElements[0];
  const lastFocusable = focusableElements[focusableElements.length - 1];

  const handleKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== 'Tab') return;

    if (e.shiftKey) {
      if (document.activeElement === firstFocusable) {
        lastFocusable?.focus();
        e.preventDefault();
      }
    } else {
      if (document.activeElement === lastFocusable) {
        firstFocusable?.focus();
        e.preventDefault();
      }
    }
  };

  container.addEventListener('keydown', handleKeyDown);

  // Focus first element
  firstFocusable?.focus();

  // Return cleanup function
  return () => {
    container.removeEventListener('keydown', handleKeyDown);
  };
}

// ==========================================
// ANIMATION UTILITIES
// ==========================================

/**
 * Request animation frame with fallback
 */
export function requestFrame(callback: FrameRequestCallback): number {
  if (window.requestAnimationFrame) {
    return window.requestAnimationFrame(callback);
  }
  return window.setTimeout(callback, 1000 / 60);
}

/**
 * Cancel animation frame with fallback
 */
export function cancelFrame(id: number): void {
  if (window.cancelAnimationFrame) {
    window.cancelAnimationFrame(id);
  } else {
    window.clearTimeout(id);
  }
}