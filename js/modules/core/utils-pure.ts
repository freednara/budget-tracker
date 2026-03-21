/**
 * Pure Utility Functions Module
 * 
 * Contains utility functions that don't depend on DOM or browser APIs.
 * These functions are pure, testable, and can be used in any environment.
 *
 * @module utils-pure
 */

import type { Transaction, CurrencySettings } from '../../types/index.js';
import { localeService } from './locale-service.js';

// ==========================================
// CURRENCY MAPPING
// ==========================================

/**
 * Canonical currency symbol map (single source of truth).
 * Update ONLY this map when adding currencies.
 */
export const CURRENCY_MAP: Record<string, string> = {
  USD: '$', EUR: '€', GBP: '£', JPY: '¥', CAD: 'C$', AUD: 'A$',
  CHF: 'Fr', CNY: '¥', INR: '₹', MXN: 'Mex$', BRL: 'R$', KRW: '₩',
  SEK: 'kr', NOK: 'kr', DKK: 'kr', PLN: 'zł', THB: '฿', IDR: 'Rp',
  HUF: 'Ft', CZK: 'Kč', ILS: '₪', CLP: '$', PHP: '₱', AED: 'د.إ',
  COP: '$', SAR: '﷼', MYR: 'RM', ZAR: 'R'
};

// ==========================================
// CURRENCY FORMATTING
// ==========================================

interface StateWithCurrency {
  currency?: CurrencySettings;
}

/**
 * Format amount as currency string using locale-aware formatting
 */
export function fmtCur(amount: number, currency?: string, S?: StateWithCurrency): string {
  // Use locale service if available
  if (typeof window !== 'undefined' && localeService) {
    return localeService.formatCurrency(amount);
  }
  
  // Fallback for testing/server environments
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
    if (import.meta.env.DEV) console.warn('parseMonthKey: Invalid input, using current date');
    return new Date();
  }

  const parts = mk.split('-');
  if (parts.length !== 2) {
    if (import.meta.env.DEV) console.warn('parseMonthKey: Invalid format, expected YYYY-MM');
    return new Date();
  }

  const [y, m] = parts.map(Number);

  // Validate year and month ranges
  if (isNaN(y) || isNaN(m) || y < 1900 || y > 2100 || m < 1 || m > 12) {
    if (import.meta.env.DEV) console.warn(`parseMonthKey: Invalid date values y=${y}, m=${m}`);
    return new Date();
  }

  return new Date(y, m - 1, 1);
}

/**
 * Get formatted month label using user's locale
 */
export function monthLabel(mk: string): string {
  const d = parseMonthKey(mk);
  
  // Use locale service if available
  if (typeof window !== 'undefined' && localeService) {
    return localeService.formatMonth(d);
  }
  
  // Use browser locale or fallback to en-US
  const locale = typeof navigator !== 'undefined' ? navigator.language : 'en-US';
  return d.toLocaleDateString(locale, { month: 'long', year: 'numeric' });
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
  let val: number;
  
  if (typeof dollars === 'number') {
    val = dollars;
  } else if (typeof dollars === 'string') {
    // Try locale-aware parsing first
    if (typeof window !== 'undefined' && localeService) {
      val = localeService.parseNumber(dollars);
    } else {
      // Fallback to parseFloat
      val = parseFloat(dollars);
    }
  } else {
    return 0;
  }
  
  if (isNaN(val)) return 0;
  if (Math.abs(val) > MAX_DOLLARS) {
    if (import.meta.env.DEV) console.warn(`toCents: Value ${val} exceeds safe integer range, clamping`);
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
    if (import.meta.env.DEV) console.warn(`toDollars: Value ${cents} exceeds safe integer range`);
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
 * Parse and validate user input amount with locale awareness
 * Normalizes to cents precision and handles invalid input
 */
export function parseAmount(input: string | number): number {
  let val: number;
  
  if (typeof input === 'number') {
    val = input;
  } else if (typeof input === 'string') {
    // Try locale-aware parsing first
    if (typeof window !== 'undefined' && localeService) {
      val = localeService.parseCurrency(input);
    } else {
      // Fallback to parseFloat
      val = parseFloat(input);
    }
  } else {
    return 0;
  }
  
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
export function debounce<T extends (...args: any[]) => any>(
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
 * Generate unique ID (pure version using Math.random)
 * Note: For crypto-secure IDs, use generateSecureId from utils-dom
 */
export function generateId(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// ==========================================
// LOCALE-AWARE FORMATTING
// ==========================================

/**
 * Format number with locale-aware thousand separators
 */
export function formatNumber(num: number, decimals?: number): string {
  // Use locale service if available
  if (typeof window !== 'undefined' && localeService) {
    return localeService.formatNumber(num);
  }
  
  // Fallback to browser locale or manual formatting
  if (typeof navigator !== 'undefined' && typeof Intl !== 'undefined') {
    const locale = navigator.language || 'en-US';
    return new Intl.NumberFormat(locale, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals
    }).format(num);
  }
  
  // Final fallback for non-browser environments
  return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Format date using user's locale
 */
export function formatDate(date: Date | string): string {
  // Use locale service if available
  if (typeof window !== 'undefined' && localeService) {
    return localeService.formatDate(date);
  }
  
  // Fallback to browser locale
  const d = typeof date === 'string' ? parseLocalDate(date) : date;
  const locale = typeof navigator !== 'undefined' ? navigator.language : 'en-US';
  
  if (typeof Intl !== 'undefined') {
    return new Intl.DateTimeFormat(locale).format(d);
  }
  
  // Final fallback
  return d.toLocaleDateString();
}

/**
 * Format percentage using user's locale
 */
export function formatPercent(value: number): string {
  // Use locale service if available
  if (typeof window !== 'undefined' && localeService) {
    return localeService.formatPercent(value);
  }
  
  // Fallback to browser locale
  if (typeof navigator !== 'undefined' && typeof Intl !== 'undefined') {
    const locale = navigator.language || 'en-US';
    return new Intl.NumberFormat(locale, {
      style: 'percent',
      minimumFractionDigits: 0,
      maximumFractionDigits: 2
    }).format(value / 100);
  }
  
  // Final fallback
  return `${Math.round(value)}%`;
}

/**
 * Get first day of week for user's locale (0 = Sunday, 1 = Monday)
 */
export function getFirstDayOfWeek(): number {
  // Use locale service if available
  if (typeof window !== 'undefined' && localeService) {
    return localeService.getFirstDayOfWeek();
  }
  
  // Simple heuristic: Most of world uses Monday, US/Canada use Sunday
  const locale = typeof navigator !== 'undefined' ? navigator.language : 'en-US';
  const sundayFirst = ['en-US', 'en-CA', 'en-MX', 'ja-JP', 'ko-KR'];
  
  return sundayFirst.some(l => locale.startsWith(l)) ? 0 : 1;
}

// ==========================================
// LOGGING
// ==========================================

/**
 * Centralized error logging
 */
export function logError(context: string, error: Error | string): void {
  if (import.meta.env.DEV) console.error(`[${context}]`, error);
}

// ==========================================
// STRING UTILITIES & SECURITY
// ==========================================

/**
 * Escape a string for safe use in HTML content or attributes.
 * Comprehensive pure-function version that works in all environments.
 * Protects against basic XSS by escaping all standard sensitive characters.
 */
export function esc(str: string): string {
  if (!str || typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\//g, '&#47;')
    .replace(/`/g, '&#96;')
    .replace(/=/g, '&#61;');
}

/**
 * Basic sanitizer for user-provided HTML strings.
 * Removes most dangerous tags and attributes.
 * NOTE: This is NOT a substitute for a full library like DOMPurify for complex HTML.
 */
export function sanitize(html: string): string {
  if (!html || typeof html !== 'string') return '';

  let clean = html;

  // Multi-pass to handle nested tag tricks like <scr<script>ipt>
  let prev = '';
  while (prev !== clean) {
    prev = clean;

    // Remove script tags and their content
    clean = clean.replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gim, '');

    // Remove dangerous tags: script, iframe, object, embed, link, meta, svg, math, base, form
    clean = clean.replace(/<\/?(script|iframe|object|embed|link|meta|svg|math|base|form|style)\b[^>]*>/gim, '');
  }

  // Remove event handlers — both quoted and unquoted values (onmouseover=alert(1), onclick="...", etc.)
  clean = clean.replace(/\bon\w+\s*=\s*(?:(['"])[^'"]*\1|[^\s>]+)/gim, '');

  // Remove javascript:, vbscript:, and data: protocol URIs in any attribute
  clean = clean.replace(/(href|src|action|formaction|xlink:href)\s*=\s*(['"]?)\s*(javascript|vbscript|data)\s*:[^'"\s>]*/gim, '$1=$2#');

  // Remove style attributes (blocks CSS expression() attacks)
  clean = clean.replace(/\bstyle\s*=\s*(['"])[^'"]*\1/gim, '');
  clean = clean.replace(/\bstyle\s*=\s*[^\s>]+/gim, '');

  return clean;
}

/** @deprecated Use esc instead */
export const escAttr = esc;

/** @deprecated Use esc instead */
export const escapeHtmlPure = esc;

// ==========================================
// MATH UTILITIES
// ==========================================

/**
 * Calculate linear trend (slope) using simple least-squares regression.
 * Returns the slope of the best-fit line through the values.
 * Useful for spending trends, savings projections, and debt payoff forecasts.
 */
export function linearTrend(values: number[]): number {
  if (values.length < 2) return 0;
  const n = values.length;
  const xSum = (n * (n + 1)) / 2;
  const ySum = values.reduce((sum, val) => sum + val, 0);
  const xySum = values.reduce((sum, val, i) => sum + val * (i + 1), 0);
  const xSquaredSum = (n * (n + 1) * (2 * n + 1)) / 6;
  const slope = (n * xySum - xSum * ySum) / (n * xSquaredSum - xSum * xSum);
  return isFinite(slope) ? slope : 0;
}

// ==========================================
// SEASON UTILITIES
// ==========================================

export type Season = 'winter' | 'spring' | 'summer' | 'autumn';

/**
 * Get the meteorological season for a given date.
 * Dec-Feb = winter, Mar-May = spring, Jun-Aug = summer, Sep-Nov = autumn.
 */
export function getSeason(date: Date): Season {
  const month = date.getMonth(); // 0-11
  if (month >= 11 || month <= 1) return 'winter';
  if (month >= 2 && month <= 4) return 'spring';
  if (month >= 5 && month <= 7) return 'summer';
  return 'autumn';
}