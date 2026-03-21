/**
 * Centralized Currency Service
 * 
 * Eliminates the 17x duplication of currency formatting logic
 * by providing a single source of truth for currency operations.
 */
'use strict';

import { getDefaultContainer, Services } from './di-container.js';
import { toCents, toDollars, CURRENCY_MAP } from './utils-pure.js';
import type { CurrencyConfig, CurrencyFormatter } from '../types/app-config.js';

// ==========================================
// DEFAULT CONFIGURATION
// ==========================================

const DEFAULT_CONFIG: CurrencyConfig = {
  symbol: '$',
  code: 'USD',
  decimals: 2,
  thousandSeparator: ',',
  decimalSeparator: '.',
  position: 'before'
};

// ==========================================
// CURRENCY SYMBOLS MAP
// ==========================================

// Use canonical currency map from utils-pure (single source of truth)
export const CURRENCY_SYMBOLS = CURRENCY_MAP;

// ==========================================
// CURRENCY SERVICE CLASS
// ==========================================

export class CurrencyService {
  private config: CurrencyConfig;
  
  constructor(config: Partial<CurrencyConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }
  
  /**
   * Update currency configuration
   */
  updateConfig(config: Partial<CurrencyConfig>): void {
    this.config = { ...this.config, ...config };
  }
  
  /**
   * Get current currency configuration
   */
  getConfig(): Readonly<CurrencyConfig> {
    return { ...this.config };
  }
  
  /**
   * Format amount as currency string
   * This is the main formatter that replaces all duplicated functions
   * FIXED: Uses integer math to avoid floating point precision issues
   */
  format(amount: number, options?: {
    showSign?: boolean;
    compact?: boolean;
    hideSymbol?: boolean;
  }): string {
    const { showSign = false, compact = false, hideSymbol = false } = options || {};
    
    // Handle invalid input
    if (typeof amount !== 'number' || isNaN(amount)) {
      return this.config.symbol + '0.00';
    }
    
    // Use integer math for precision
    const amountCents = toCents(amount);
    const isNegative = amountCents < 0;
    const absAmountCents = isNegative ? -amountCents : amountCents;
    const absAmount = toDollars(absAmountCents);
    
    // Format number
    let formatted: string;
    
    if (compact && absAmount >= 1000) {
      formatted = this.formatCompact(absAmount);
    } else {
      formatted = this.formatStandard(absAmount);
    }
    
    // Add currency symbol
    if (!hideSymbol) {
      formatted = this.config.position === 'before'
        ? this.config.symbol + formatted
        : formatted + this.config.symbol;
    }
    
    // Add sign
    if (isNegative) {
      formatted = '-' + formatted;
    } else if (showSign && amountCents > 0) {
      formatted = '+' + formatted;
    }
    
    return formatted;
  }
  
  /**
   * Format amount without currency symbol
   */
  formatNumber(amount: number): string {
    return this.format(amount, { hideSymbol: true });
  }
  
  /**
   * Format amount with explicit sign
   */
  formatSigned(amount: number): string {
    return this.format(amount, { showSign: true });
  }
  
  /**
   * Format amount in compact notation (1.2K, 3.4M, etc.)
   * FIXED: Uses integer math to avoid precision issues
   */
  formatCompact(amount: number): string {
    // Use integer math
    const amountCents = toCents(amount);
    const isNegative = amountCents < 0;
    const absAmountCents = isNegative ? -amountCents : amountCents;
    const absAmount = toDollars(absAmountCents);
    const sign = isNegative ? '-' : '';

    if (absAmount >= 1e9) {
      return sign + (absAmount / 1e9).toFixed(1) + 'B';
    } else if (absAmount >= 1e6) {
      return sign + (absAmount / 1e6).toFixed(1) + 'M';
    } else if (absAmount >= 1e3) {
      return sign + (absAmount / 1e3).toFixed(1) + 'K';
    }

    return sign + this.formatStandard(absAmount);
  }
  
  /**
   * Format amount with thousand separators
   * Uses Intl.NumberFormat when available for locale-aware formatting,
   * falling back to manual formatting only when needed.
   */
  private formatStandard(amount: number): string {
    // Use Intl.NumberFormat for locale-aware formatting (respects user's locale)
    try {
      const formatted = new Intl.NumberFormat(undefined, {
        minimumFractionDigits: this.config.decimals,
        maximumFractionDigits: this.config.decimals,
        useGrouping: true
      }).format(amount);
      return formatted;
    } catch {
      // Fallback for environments without Intl support
      const fixed = amount.toFixed(this.config.decimals);
      const [integerPart, decimalPart] = fixed.split('.');
      const withSeparators = integerPart.replace(
        /\B(?=(\d{3})+(?!\d))/g,
        this.config.thousandSeparator
      );
      if (decimalPart && this.config.decimals > 0) {
        return withSeparators + this.config.decimalSeparator + decimalPart;
      }
      return withSeparators;
    }
  }
  
  /**
   * Parse currency string to number
   */
  parse(value: string): number {
    if (typeof value !== 'string') return 0;
    
    // Remove currency symbol and spaces
    let cleaned = value.replace(this.config.symbol, '').trim();
    
    // Remove thousand separators
    cleaned = cleaned.replace(new RegExp('\\' + this.config.thousandSeparator, 'g'), '');
    
    // Replace decimal separator with dot
    if (this.config.decimalSeparator !== '.') {
      cleaned = cleaned.replace(this.config.decimalSeparator, '.');
    }
    
    // Parse to number
    const parsed = parseFloat(cleaned);
    return isNaN(parsed) ? 0 : parsed;
  }
  
  /**
   * Get currency symbol for a given code
   */
  static getSymbol(code: string): string {
    return CURRENCY_SYMBOLS[code] || code;
  }
  
  /**
   * Create a formatter function with fixed configuration
   * Useful for backward compatibility
   */
  createFormatter(options?: {
    showSign?: boolean;
    compact?: boolean;
    hideSymbol?: boolean;
  }): CurrencyFormatter {
    return (amount: number) => this.format(amount, options);
  }
}

// ==========================================
// SINGLETON INSTANCE
// ==========================================

let instance: CurrencyService | null = null;

/**
 * Get or create the singleton currency service instance
 */
export function getCurrencyService(): CurrencyService {
  if (!instance) {
    // Try to get configuration from container if available
    try {
      const container = getDefaultContainer();
      const config = container.resolveSync('currencyConfig');
      instance = new CurrencyService(config as CurrencyConfig);
    } catch {
      // Fall back to default configuration
      instance = new CurrencyService();
    }
  }
  return instance;
}

/**
 * Initialize the currency service with configuration
 */
export function initializeCurrencyService(config?: Partial<CurrencyConfig>): CurrencyService {
  instance = new CurrencyService(config);
  
  // Register in DI container
  const container = getDefaultContainer();
  container.registerValue(Services.CURRENCY_FORMATTER, instance.createFormatter());
  container.registerValue('currencyConfig', instance.getConfig());
  
  return instance;
}

// ==========================================
// BACKWARD COMPATIBILITY EXPORTS
// ==========================================

/**
 * Default currency formatter for backward compatibility
 * This replaces the 17 duplicated functions across the codebase
 */
export const formatCurrency: CurrencyFormatter = (amount: number) => {
  return getCurrencyService().format(amount);
};

/**
 * Short currency formatter (compact notation)
 */
export const formatCurrencyShort: CurrencyFormatter = (amount: number) => {
  return getCurrencyService().format(amount, { compact: true });
};

/**
 * Signed currency formatter
 */
export const formatCurrencySigned: CurrencyFormatter = (amount: number) => {
  return getCurrencyService().formatSigned(amount);
};

// ==========================================
// MIGRATION HELPERS
// ==========================================

/**
 * Replace all old formatter patterns with centralized service
 * This can be used in a migration script
 * FIXED: Removed createLegacyFormatter which incorrectly used Math.abs
 * All formatters should properly handle negative values
 */
export function replaceFormatters(callbacks: {
  setFmtCurFn?: (fn: CurrencyFormatter) => void;
  setTxFmtCurFn?: (fn: CurrencyFormatter) => void;
  setAnalyticsFmtCurFn?: (fn: CurrencyFormatter) => void;
  setSavingsGoalsFmtCur?: (fn: CurrencyFormatter) => void;
  setDebtFmtCur?: (fn: CurrencyFormatter) => void;
  setSplitFmtCur?: (fn: CurrencyFormatter) => void;
  setBudgetPlannerFmtCur?: (fn: CurrencyFormatter) => void;
  [key: string]: ((fn: CurrencyFormatter) => void) | undefined;
}): void {
  const formatter = getCurrencyService().createFormatter();
  
  Object.entries(callbacks).forEach(([key, setter]) => {
    if (setter && typeof setter === 'function') {
      setter(formatter);
    }
  });
}