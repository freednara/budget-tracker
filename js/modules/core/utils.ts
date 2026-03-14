/**
 * Utility Functions Module
 * Core helper functions for Budget Tracker Elite
 *
 * @module utils
 */

import type { Transaction, CurrencySettings } from '../../types/index.js';

// ==========================================
// CURRENCY MAPPING
// ==========================================

export const CURRENCY_MAP: Record<string, string> = {
  USD: '$', EUR: '€', GBP: '£', JPY: '¥', CAD: 'C$', AUD: 'A$',
  CHF: 'Fr', CNY: '¥', INR: '₹', MXN: 'Mex$', BRL: 'R$', KRW: '₩'
};

// ==========================================
// CURRENCY FORMATTING
// ==========================================

interface StateWithCurrency {
  currency?: CurrencySettings;
}

/**
 * Format amount as currency string
 */
export function fmtCur(amount: number, currency?: string, S?: StateWithCurrency): string {
  const sym = currency ? (CURRENCY_MAP[currency] || '') : S?.currency?.symbol || '$';
  return `${sym}${Number(amount).toFixed(2)}`;
}

// ==========================================
// DATE UTILITIES
// ==========================================

/**
 * Parse date string to Date object (DST-safe)
 * Uses noon local time to avoid DST edge cases where midnight may not exist
 */
export function parseLocalDate(dateStr: string | Date): Date {
  if (dateStr instanceof Date) return dateStr;
  if (typeof dateStr === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    const [y, m, d] = dateStr.split('-').map(Number);
    // Use noon (12:00) to avoid DST transitions that occur at midnight/2am
    return new Date(y, m - 1, d, 12, 0, 0);
  }
  return new Date(dateStr);
}

/**
 * Get month key from date (YYYY-MM format)
 */
export function getMonthKey(d: Date | string): string {
  const dt = d instanceof Date ? d : parseLocalDate(d);
  if (isNaN(dt.getTime())) return '';
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Parse month key to Date object
 */
export function parseMonthKey(mk: string): Date {
  // Input validation
  if (!mk || typeof mk !== 'string') {
    console.warn('parseMonthKey: Invalid input, using current date');
    return new Date();
  }

  const parts = mk.split('-');
  if (parts.length !== 2) {
    console.warn('parseMonthKey: Invalid format, expected YYYY-MM');
    return new Date();
  }

  const [y, m] = parts.map(Number);

  // Validate year and month ranges
  if (isNaN(y) || isNaN(m) || y < 1900 || y > 2100 || m < 1 || m > 12) {
    console.warn(`parseMonthKey: Invalid date values y=${y}, m=${m}`);
    return new Date();
  }

  return new Date(y, m - 1, 1);
}

/**
 * Get formatted month label
 */
export function monthLabel(mk: string): string {
  const d = parseMonthKey(mk);
  return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

/**
 * Get previous month key
 */
export function getPrevMonthKey(mk: string): string {
  const d = parseMonthKey(mk);
  d.setMonth(d.getMonth() - 1);
  return getMonthKey(d);
}

/**
 * Get next month key
 */
export function getNextMonthKey(mk: string): string {
  const d = parseMonthKey(mk);
  d.setMonth(d.getMonth() + 1);
  return getMonthKey(d);
}

/**
 * Get today's date as string (YYYY-MM-DD)
 */
export function getTodayStr(): string {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
}

/**
 * Format date for input field (YYYY-MM-DD)
 */
export function formatDateForInput(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// ==========================================
// FINANCIAL CALCULATIONS (INTEGER MATH)
// ==========================================

// Maximum safe value for cents (prevents integer overflow)
const MAX_SAFE_CENTS = Number.MAX_SAFE_INTEGER; // 9007199254740991
const MAX_DOLLARS = MAX_SAFE_CENTS / 100;       // ~90 trillion dollars

/**
 * Convert dollar amount to cents (integer)
 * Avoids floating-point precision errors in financial calculations
 * Includes bounds checking for extremely large values
 */
export function toCents(dollars: number | string): number {
  const val = typeof dollars === 'number' ? dollars : parseFloat(dollars);
  if (isNaN(val)) return 0;
  if (Math.abs(val) > MAX_DOLLARS) {
    console.warn(`toCents: Value ${val} exceeds safe integer range, clamping`);
    return val > 0 ? MAX_SAFE_CENTS : -MAX_SAFE_CENTS;
  }
  return Math.round(val * 100);
}

/**
 * Convert cents to dollars
 * Includes bounds checking for extremely large values
 */
export function toDollars(cents: number): number {
  if (Math.abs(cents) > MAX_SAFE_CENTS) {
    console.warn(`toDollars: Value ${cents} exceeds safe integer range`);
  }
  return cents / 100;
}

/**
 * Add multiple dollar amounts safely (using cents internally)
 * Avoids floating-point errors like 0.1 + 0.2 = 0.30000000000000004
 */
export function addAmounts(...amounts: number[]): number {
  const sumCents = amounts.reduce((sum, amt) => sum + toCents(amt), 0);
  return toDollars(sumCents);
}

/**
 * Subtract dollar amounts safely (using cents internally)
 */
export function subtractAmounts(minuend: number, subtrahend: number): number {
  return toDollars(toCents(minuend) - toCents(subtrahend));
}

/**
 * Parse and validate user input amount
 * Normalizes to cents precision and handles invalid input
 */
export function parseAmount(input: string | number): number {
  const val = typeof input === 'number' ? input : parseFloat(input);
  if (isNaN(val) || val < 0) return 0;
  // Round to cents precision to normalize
  return Math.round(val * 100) / 100;
}

/**
 * Sum transactions by type (uses integer math to avoid floating-point errors)
 */
export function sumByType(txList: Transaction[], type: 'expense' | 'income'): number {
  const cents = txList
    .filter(t => t.type === type)
    .reduce((s, t) => s + toCents(t.amount), 0);
  return toDollars(cents);
}

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
// HTML/XSS PROTECTION
// ==========================================

/**
 * Escape HTML special characters with enhanced XSS protection
 */
export function esc(str: string): string {
  if (typeof str !== 'string') return '';

  // Additional input validation for potential XSS vectors
  const suspicious = /<script|<iframe|<object|<embed|<link|<meta|javascript:|data:|vbscript:/i;
  if (suspicious.test(str)) {
    console.warn('Potentially malicious input detected and sanitized:', str.substring(0, 50));
  }

  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Alias for backwards compatibility
export { esc as escapeHtml };

/**
 * Safely set innerHTML with additional XSS protection
 * Use this instead of direct innerHTML assignment for user-generated content
 */
export function safeSetHTML(element: HTMLElement | null, html: string): void {
  if (!element || typeof html !== 'string') return;

  // Additional check for potential XSS in supposedly safe HTML
  const dangerous = /<script\b|<iframe\b|<object\b|<embed\b|javascript:|data:(?!image\/)|vbscript:/i;
  if (dangerous.test(html)) {
    console.error('Dangerous HTML content blocked:', html.substring(0, 100));
    element.textContent = '[Content blocked for security]';
    return;
  }

  element.innerHTML = html;
}

// ==========================================
// MATH UTILITIES
// ==========================================

/**
 * Calculate percentage
 */
export function calcPercentage(value: number, total: number): number {
  if (!total || total === 0) return 0;
  return Math.min(100, Math.max(0, (value / total) * 100));
}

/**
 * Clamp value between min and max
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

// ==========================================
// FUNCTION UTILITIES
// ==========================================

/**
 * Debounce function execution
 */
export function debounce<T extends (...args: unknown[]) => unknown>(
  func: T,
  wait: number
): (...args: Parameters<T>) => void {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  return function executedFunction(...args: Parameters<T>): void {
    const later = (): void => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

// ==========================================
// ID GENERATION
// ==========================================

/**
 * Generate unique ID with fallback for older browsers
 */
export function generateId(): string {
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
  console.warn('Using Math.random() for ID generation - not cryptographically secure');
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// ==========================================
// NUMBER FORMATTING
// ==========================================

/**
 * Format number with thousand separators
 */
export function formatNumber(num: number): string {
  return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// ==========================================
// LOGGING
// ==========================================

/**
 * Centralized error logging
 */
export function logError(context: string, error: Error | string): void {
  console.error(`[${context}]`, error);
}
