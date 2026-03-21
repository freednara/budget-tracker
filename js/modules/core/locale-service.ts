/**
 * Locale Service Module
 * Centralized locale detection and formatting for internationalization
 */

import { lsGet, lsSet, SK } from './state.js';

// ==========================================
// TYPES
// ==========================================

export interface LocaleSettings {
  locale: string;
  currency: string;
  dateFormat: string;
  numberFormat: string;
  firstDayOfWeek: number; // 0 = Sunday, 1 = Monday
  decimalSeparator: string;
  thousandsSeparator: string;
  currencyPosition: 'before' | 'after';
}

export interface LocaleFormats {
  number: Intl.NumberFormat;
  currency: Intl.NumberFormat;
  date: Intl.DateTimeFormat;
  dateShort: Intl.DateTimeFormat;
  month: Intl.DateTimeFormat;
  year: Intl.DateTimeFormat;
  percent: Intl.NumberFormat;
}

// ==========================================
// LOCALE SERVICE CLASS
// ==========================================

class LocaleService {
  private settings: LocaleSettings;
  private formats: LocaleFormats;
  private readonly STORAGE_KEY = 'budget_tracker_locale_settings';

  constructor() {
    this.settings = this.loadSettings();
    this.formats = this.createFormatters();
  }

  /**
   * Load locale settings from storage or detect from browser
   */
  private loadSettings(): LocaleSettings {
    const stored = lsGet<Partial<LocaleSettings> | null>(this.STORAGE_KEY, null);
    
    if (stored?.locale) {
      return this.mergeWithDefaults(stored);
    }
    
    // Detect from browser
    return this.detectLocaleSettings();
  }

  /**
   * Detect locale settings from browser
   */
  private detectLocaleSettings(): LocaleSettings {
    const locale = navigator.language || 'en-US';
    const numberFormat = new Intl.NumberFormat(locale);
    const parts = numberFormat.formatToParts(1234.56);
    
    // Extract separators from formatted number
    const decimalSeparator = parts.find(p => p.type === 'decimal')?.value || '.';
    const thousandsSeparator = parts.find(p => p.type === 'group')?.value || ',';
    
    // Detect currency position (simplified - real implementation would be more comprehensive)
    const currencyFormat = new Intl.NumberFormat(locale, { 
      style: 'currency', 
      currency: this.detectCurrency(locale) 
    });
    const currencyParts = currencyFormat.formatToParts(100);
    const currencyIndex = currencyParts.findIndex(p => p.type === 'currency');
    const integerIndex = currencyParts.findIndex(p => p.type === 'integer');
    const currencyPosition = currencyIndex < integerIndex ? 'before' : 'after';
    
    // Detect first day of week (Monday for most of world, Sunday for US/Canada)
    const firstDayOfWeek = ['en-US', 'en-CA', 'en-MX'].includes(locale) ? 0 : 1;
    
    return {
      locale,
      currency: this.detectCurrency(locale),
      dateFormat: this.getDateFormat(locale),
      numberFormat: this.getNumberFormat(locale),
      firstDayOfWeek,
      decimalSeparator,
      thousandsSeparator,
      currencyPosition
    };
  }

  /**
   * Detect currency based on locale
   */
  private detectCurrency(locale: string): string {
    // Map common locales to currencies
    const currencyMap: Record<string, string> = {
      'en-US': 'USD',
      'en-GB': 'GBP',
      'en-CA': 'CAD',
      'en-AU': 'AUD',
      'en-NZ': 'NZD',
      'fr-FR': 'EUR',
      'de-DE': 'EUR',
      'es-ES': 'EUR',
      'it-IT': 'EUR',
      'pt-PT': 'EUR',
      'nl-NL': 'EUR',
      'ja-JP': 'JPY',
      'zh-CN': 'CNY',
      'ko-KR': 'KRW',
      'ru-RU': 'RUB',
      'pt-BR': 'BRL',
      'en-IN': 'INR',
      'ar-SA': 'SAR',
      'tr-TR': 'TRY',
      'pl-PL': 'PLN',
      'sv-SE': 'SEK',
      'no-NO': 'NOK',
      'da-DK': 'DKK',
      'fi-FI': 'EUR',
      'cs-CZ': 'CZK',
      'hu-HU': 'HUF',
      'ro-RO': 'RON',
      'bg-BG': 'BGN',
      'hr-HR': 'HRK',
      'en-ZA': 'ZAR',
      'en-SG': 'SGD',
      'en-HK': 'HKD',
      'en-MY': 'MYR',
      'en-PH': 'PHP',
      'th-TH': 'THB',
      'id-ID': 'IDR',
      'vi-VN': 'VND'
    };
    
    // Check exact match first
    if (currencyMap[locale]) {
      return currencyMap[locale];
    }
    
    // Check language code only
    const lang = locale.split('-')[0];
    const langMatch = Object.keys(currencyMap).find(key => key.startsWith(lang));
    if (langMatch) {
      return currencyMap[langMatch];
    }
    
    // Default to USD
    return 'USD';
  }

  /**
   * Get date format pattern for locale
   */
  private getDateFormat(locale: string): string {
    const sample = new Date(2024, 0, 15); // Jan 15, 2024
    const formatted = new Intl.DateTimeFormat(locale).format(sample);
    
    // Detect format from sample
    if (formatted.includes('/')) {
      const parts = formatted.split('/');
      if (parts[0] === '15') return 'DD/MM/YYYY';
      if (parts[1] === '15') return 'MM/DD/YYYY';
    } else if (formatted.includes('.')) {
      return 'DD.MM.YYYY';
    } else if (formatted.includes('-')) {
      return 'YYYY-MM-DD';
    }
    
    return 'MM/DD/YYYY'; // Default
  }

  /**
   * Get number format pattern for locale
   */
  private getNumberFormat(locale: string): string {
    const formatted = new Intl.NumberFormat(locale).format(1234.56);
    
    if (formatted.includes(',') && formatted.includes('.')) {
      return formatted.indexOf(',') < formatted.indexOf('.') ? '1,234.56' : '1.234,56';
    }
    
    return '1,234.56'; // Default
  }

  /**
   * Merge partial settings with defaults
   */
  private mergeWithDefaults(partial: Partial<LocaleSettings>): LocaleSettings {
    const defaults = this.detectLocaleSettings();
    return { ...defaults, ...partial };
  }

  /**
   * Create Intl formatters based on current settings
   */
  private createFormatters(): LocaleFormats {
    const { locale, currency } = this.settings;
    
    return {
      number: new Intl.NumberFormat(locale),
      currency: new Intl.NumberFormat(locale, {
        style: 'currency',
        currency,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      }),
      date: new Intl.DateTimeFormat(locale, {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      }),
      dateShort: new Intl.DateTimeFormat(locale, {
        month: 'short',
        day: 'numeric'
      }),
      month: new Intl.DateTimeFormat(locale, {
        month: 'long',
        year: 'numeric'
      }),
      year: new Intl.DateTimeFormat(locale, {
        year: 'numeric'
      }),
      percent: new Intl.NumberFormat(locale, {
        style: 'percent',
        minimumFractionDigits: 0,
        maximumFractionDigits: 2
      })
    };
  }

  // ==========================================
  // PUBLIC API
  // ==========================================

  /**
   * Get current locale
   */
  getLocale(): string {
    return this.settings.locale;
  }

  /**
   * Get current currency
   */
  getCurrency(): string {
    return this.settings.currency;
  }

  /**
   * Get all settings
   */
  getSettings(): LocaleSettings {
    return { ...this.settings };
  }

  /**
   * Update locale settings
   */
  updateSettings(settings: Partial<LocaleSettings>): void {
    this.settings = this.mergeWithDefaults(settings);
    this.formats = this.createFormatters();
    lsSet(this.STORAGE_KEY, this.settings);
  }

  /**
   * Format a number
   */
  formatNumber(value: number): string {
    return this.formats.number.format(value);
  }

  /**
   * Format currency
   */
  formatCurrency(amount: number): string {
    return this.formats.currency.format(amount);
  }

  /**
   * Format date
   */
  formatDate(date: Date | string): string {
    const d = typeof date === 'string' ? new Date(date) : date;
    return this.formats.date.format(d);
  }

  /**
   * Format month/year label
   */
  formatMonth(date: Date | string): string {
    const d = typeof date === 'string' ? new Date(date) : date;
    return this.formats.month.format(d);
  }

  /**
   * Format percentage
   */
  formatPercent(value: number): string {
    return this.formats.percent.format(value / 100);
  }

  /**
   * Parse localized number string to number
   */
  parseNumber(str: string): number {
    // Remove thousands separators and normalize decimal separator
    const { decimalSeparator, thousandsSeparator } = this.settings;
    
    let normalized = str;
    
    // Remove thousands separators
    if (thousandsSeparator) {
      normalized = normalized.replace(new RegExp(`\\${thousandsSeparator}`, 'g'), '');
    }
    
    // Replace decimal separator with dot
    if (decimalSeparator !== '.') {
      normalized = normalized.replace(decimalSeparator, '.');
    }
    
    // Remove currency symbols and spaces
    normalized = normalized.replace(/[^\d.-]/g, '');
    
    return parseFloat(normalized) || 0;
  }

  /**
   * Parse localized currency string to number
   */
  parseCurrency(str: string): number {
    return this.parseNumber(str);
  }

  /**
   * Get first day of week (0 = Sunday, 1 = Monday)
   */
  getFirstDayOfWeek(): number {
    return this.settings.firstDayOfWeek;
  }

  /**
   * Get decimal separator
   */
  getDecimalSeparator(): string {
    return this.settings.decimalSeparator;
  }

  /**
   * Get thousands separator
   */
  getThousandsSeparator(): string {
    return this.settings.thousandsSeparator;
  }

  /**
   * Check if currency should be displayed before or after amount
   */
  getCurrencyPosition(): 'before' | 'after' {
    return this.settings.currencyPosition;
  }

  /**
   * Get available locales (for settings dropdown)
   */
  getAvailableLocales(): Array<{ code: string; name: string }> {
    return [
      { code: 'en-US', name: 'English (United States)' },
      { code: 'en-GB', name: 'English (United Kingdom)' },
      { code: 'en-CA', name: 'English (Canada)' },
      { code: 'en-AU', name: 'English (Australia)' },
      { code: 'fr-FR', name: 'Français (France)' },
      { code: 'de-DE', name: 'Deutsch (Deutschland)' },
      { code: 'es-ES', name: 'Español (España)' },
      { code: 'es-MX', name: 'Español (México)' },
      { code: 'it-IT', name: 'Italiano (Italia)' },
      { code: 'pt-BR', name: 'Português (Brasil)' },
      { code: 'pt-PT', name: 'Português (Portugal)' },
      { code: 'nl-NL', name: 'Nederlands (Nederland)' },
      { code: 'ja-JP', name: '日本語 (日本)' },
      { code: 'zh-CN', name: '中文 (中国)' },
      { code: 'ko-KR', name: '한국어 (한국)' },
      { code: 'ru-RU', name: 'Русский (Россия)' },
      { code: 'ar-SA', name: 'العربية (السعودية)' },
      { code: 'hi-IN', name: 'हिन्दी (भारत)' },
      { code: 'tr-TR', name: 'Türkçe (Türkiye)' },
      { code: 'pl-PL', name: 'Polski (Polska)' },
      { code: 'sv-SE', name: 'Svenska (Sverige)' },
      { code: 'no-NO', name: 'Norsk (Norge)' },
      { code: 'da-DK', name: 'Dansk (Danmark)' },
      { code: 'fi-FI', name: 'Suomi (Suomi)' }
    ];
  }

  /**
   * Get available currencies (for settings dropdown)
   */
  getAvailableCurrencies(): Array<{ code: string; name: string; symbol: string }> {
    return [
      { code: 'USD', name: 'US Dollar', symbol: '$' },
      { code: 'EUR', name: 'Euro', symbol: '€' },
      { code: 'GBP', name: 'British Pound', symbol: '£' },
      { code: 'JPY', name: 'Japanese Yen', symbol: '¥' },
      { code: 'CNY', name: 'Chinese Yuan', symbol: '¥' },
      { code: 'CAD', name: 'Canadian Dollar', symbol: '$' },
      { code: 'AUD', name: 'Australian Dollar', symbol: '$' },
      { code: 'CHF', name: 'Swiss Franc', symbol: 'Fr' },
      { code: 'SEK', name: 'Swedish Krona', symbol: 'kr' },
      { code: 'NZD', name: 'New Zealand Dollar', symbol: '$' },
      { code: 'KRW', name: 'South Korean Won', symbol: '₩' },
      { code: 'SGD', name: 'Singapore Dollar', symbol: '$' },
      { code: 'NOK', name: 'Norwegian Krone', symbol: 'kr' },
      { code: 'MXN', name: 'Mexican Peso', symbol: '$' },
      { code: 'INR', name: 'Indian Rupee', symbol: '₹' },
      { code: 'RUB', name: 'Russian Ruble', symbol: '₽' },
      { code: 'ZAR', name: 'South African Rand', symbol: 'R' },
      { code: 'BRL', name: 'Brazilian Real', symbol: 'R$' },
      { code: 'HKD', name: 'Hong Kong Dollar', symbol: '$' },
      { code: 'IDR', name: 'Indonesian Rupiah', symbol: 'Rp' },
      { code: 'AED', name: 'UAE Dirham', symbol: 'د.إ' },
      { code: 'SAR', name: 'Saudi Riyal', symbol: '﷼' },
      { code: 'TRY', name: 'Turkish Lira', symbol: '₺' },
      { code: 'THB', name: 'Thai Baht', symbol: '฿' },
      { code: 'PLN', name: 'Polish Zloty', symbol: 'zł' },
      { code: 'DKK', name: 'Danish Krone', symbol: 'kr' },
      { code: 'HUF', name: 'Hungarian Forint', symbol: 'Ft' },
      { code: 'CZK', name: 'Czech Koruna', symbol: 'Kč' },
      { code: 'ILS', name: 'Israeli Shekel', symbol: '₪' },
      { code: 'CLP', name: 'Chilean Peso', symbol: '$' },
      { code: 'PHP', name: 'Philippine Peso', symbol: '₱' },
      { code: 'EGP', name: 'Egyptian Pound', symbol: '£' },
      { code: 'COP', name: 'Colombian Peso', symbol: '$' },
      { code: 'MYR', name: 'Malaysian Ringgit', symbol: 'RM' },
      { code: 'RON', name: 'Romanian Leu', symbol: 'lei' },
      { code: 'NGN', name: 'Nigerian Naira', symbol: '₦' },
      { code: 'ARS', name: 'Argentine Peso', symbol: '$' },
      { code: 'UAH', name: 'Ukrainian Hryvnia', symbol: '₴' },
      { code: 'VND', name: 'Vietnamese Dong', symbol: '₫' },
      { code: 'PKR', name: 'Pakistani Rupee', symbol: '₨' },
      { code: 'BDT', name: 'Bangladeshi Taka', symbol: '৳' }
    ];
  }
}

// ==========================================
// SINGLETON INSTANCE
// ==========================================

export const localeService = new LocaleService();

// ==========================================
// CONVENIENCE EXPORTS
// ==========================================

export const formatNumber = (value: number): string => localeService.formatNumber(value);
export const formatCurrency = (amount: number): string => localeService.formatCurrency(amount);
export const formatDate = (date: Date | string): string => localeService.formatDate(date);
export const formatMonth = (date: Date | string): string => localeService.formatMonth(date);
export const formatPercent = (value: number): string => localeService.formatPercent(value);
export const parseNumber = (str: string): number => localeService.parseNumber(str);
export const parseCurrency = (str: string): number => localeService.parseCurrency(str);
export const getLocale = (): string => localeService.getLocale();
export const getCurrency = (): string => localeService.getCurrency();