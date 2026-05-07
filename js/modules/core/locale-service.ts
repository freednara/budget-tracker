/**
 * Locale Service Module
 * Centralized locale detection and formatting for internationalization.
 *
 * Multi-tab behavior (M14 — Inline-Behavior-Review rev 12):
 *   Writes to locale settings on one tab post a `BroadcastChannel('locale_sync')`
 *   message of shape `{ type: 'settings-changed' }`. Other tabs reload settings
 *   from storage and rebuild formatters in place — no app-level refresh needed.
 *   Falls back to silent no-op if `BroadcastChannel` is unavailable (mirrors
 *   rate-limiter.ts / auto-lock.ts contract). Channel name intentionally
 *   omits the `harbor_` prefix so it stays out of the storage-registry
 *   contract — it's a transient message channel, not a storage key.
 *
 * Parse contract (M15 — Inline-Behavior-Review rev 12):
 *   `parseNumber` / `parseCurrency` return `NaN` on parse failure rather than
 *   masking with `|| 0`. Callers (`toCents`, `parseAmount` in utils-pure.ts)
 *   already `isNaN(val)` guard before consuming, so the contract change is
 *   behavior-neutral there; any future caller must decide explicitly whether
 *   to treat empty/invalid input as zero.
 */

import { lsGet, lsSet } from './state.js';
import { parseLocalDate, getMonthKey, parseMonthKey } from './utils-pure.js';

/**
 * Decimal places per currency code. Unlisted codes default to 2.
 * Duplicated from utils-pure.ts to avoid a circular import
 * (utils-pure imports localeService, locale-service imports utils-pure).
 * CR-Apr24-I finding 79.
 */
const CURRENCY_DECIMALS: Record<string, number> = {
  JPY: 0, KRW: 0, VND: 0, HUF: 0, CLP: 0, IDR: 0
};

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
  /** Currency sans decimals — for chart axis labels and compact summaries. */
  currencyCompact: Intl.NumberFormat;
  date: Intl.DateTimeFormat;
  dateShort: Intl.DateTimeFormat;
  /** Longer date with year — used for selected-day summaries, forecast badges. */
  dateLong: Intl.DateTimeFormat;
  month: Intl.DateTimeFormat;
  /** Month-short ('Jan', 'Feb' …) for trend/axis labels. */
  monthShort: Intl.DateTimeFormat;
  /** Month-short + year for navigation/calendar headers. */
  monthShortYear: Intl.DateTimeFormat;
  year: Intl.DateTimeFormat;
  percent: Intl.NumberFormat;
}

// ==========================================
// REGEX ESCAPE (M15)
// ==========================================

/**
 * Escape regex metacharacters in a literal string so it can safely be used
 * inside a `new RegExp(...)` construction. Fixes M15 sub-finding — the prior
 * inline `new RegExp(\`\\${thousandsSeparator}\`, 'g')` only worked by luck
 * on single-character separators that happened not to be metacharacters.
 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ==========================================
// CROSS-TAB SYNC (M14)
// ==========================================

/**
 * BroadcastChannel for locale-settings changes across tabs. Pattern mirrors
 * `rate-limiter.ts` (`pin_rate_limit_sync`) and `auto-lock.ts` (`auto_lock_sync`)
 * — separate channel name so the three security/locale modules don't
 * cross-contaminate.
 */
const LOCALE_SYNC_CHANNEL_NAME = 'locale_sync';

interface LocaleSettingsChangedMessage {
  type: 'settings-changed';
}

let localeSyncChannel: BroadcastChannel | null = null;
/**
 * Echo-loop guard — true while an inbound `settings-changed` message is
 * being processed. Prevents a reload-triggered `updateSettings` call (if
 * callers ever chain through one) from re-broadcasting and producing a
 * three-tab relay storm. BroadcastChannel doesn't echo to the sender by
 * spec, so the guard is defense-in-depth.
 */
let inboundBroadcastActive = false;

function initLocaleSyncChannel(onInbound: () => void): void {
  if (localeSyncChannel) return;
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      localeSyncChannel = new BroadcastChannel(LOCALE_SYNC_CHANNEL_NAME);
      localeSyncChannel.onmessage = (event: MessageEvent) => {
        // MessageEvent.data is typed `any` in lib.dom — narrow to unknown.
        const data: unknown = event.data;
        // Defensive payload validation — reject null, non-objects, missing
        // type, unknown type. Matches rate-limiter.ts and auto-lock.ts
        // guards against same-eTLD+1 extension garbage.
        if (
          !data ||
          typeof data !== 'object' ||
          typeof (data as { type?: unknown }).type !== 'string' ||
          (data as { type: string }).type !== 'settings-changed'
        ) {
          return;
        }
        inboundBroadcastActive = true;
        try {
          onInbound();
        } finally {
          inboundBroadcastActive = false;
        }
      };
    }
  } catch (e) {
    if (import.meta.env.DEV) console.debug('[locale-service] BroadcastChannel init failed:', e);
  }
}

function broadcastLocaleChange(): void {
  if (inboundBroadcastActive) return; // echo-loop guard
  try {
    const message: LocaleSettingsChangedMessage = { type: 'settings-changed' };
    localeSyncChannel?.postMessage(message);
  } catch (e) {
    if (import.meta.env.DEV) console.debug('[locale-service] Broadcast failed:', e);
  }
}

function closeLocaleSyncChannel(): void {
  try { localeSyncChannel?.close(); } catch { /* ignore */ }
  localeSyncChannel = null;
}

// ==========================================
// LOCALE HELPERS
// ==========================================

// Intl.Locale#getWeekInfo (or the older #weekInfo accessor) returns
// { firstDay, weekend, minimalDays } where firstDay is ISO 1..7
// (1 = Monday … 7 = Sunday). We convert to the 0-based Sunday-first
// convention the rest of the app uses (0 = Sunday, 1 = Monday).
function detectFirstDayOfWeek(locale: string): number {
  try {
    const loc = new Intl.Locale(locale);
    // Spec-track name is getWeekInfo(); older Chromium shipped as `weekInfo`.
    // Cast to unknown first because the standard Intl.Locale TS type doesn't
    // yet include these members in all TS lib versions.
    const anyLoc = loc as unknown as {
      getWeekInfo?: () => { firstDay?: number };
      weekInfo?: { firstDay?: number };
    };
    const info = anyLoc.getWeekInfo?.() ?? anyLoc.weekInfo;
    const firstDay = info?.firstDay;
    if (typeof firstDay === 'number' && firstDay >= 1 && firstDay <= 7) {
      // ISO 7 = Sunday maps to our 0; ISO 1..6 map to our 1..6.
      return firstDay === 7 ? 0 : firstDay;
    }
  } catch {
    // Intl.Locale unavailable or locale string invalid — fall through.
  }
  // Legacy fallback: preserves previous behavior on older runtimes (iOS
  // Safari <16.4, some Capacitor WebViews) where weekInfo isn't exposed.
  return ['en-US', 'en-CA', 'en-MX'].includes(locale) ? 0 : 1;
}

// ==========================================
// LOCALE SERVICE CLASS
// ==========================================

class LocaleService {
  private settings: LocaleSettings;
  private formats: LocaleFormats;
  private readonly STORAGE_KEY = 'harbor_locale_settings';

  constructor() {
    this.settings = this.loadSettings();
    this.formats = this.createFormatters();
    // M14 — wire cross-tab sync. Inbound handler reloads from storage and
    // rebuilds formatters in place, so downstream consumers that hold onto
    // `localeService.getSettings()` between events still see fresh values
    // on their next access.
    initLocaleSyncChannel(() => this.reloadFromStorage());
  }

  /**
   * Reload settings from storage and rebuild formatters. Called by the
   * cross-tab sync handler when a sibling tab broadcasts a settings change.
   * Distinct from `loadSettings()` — that runs during construction and
   * falls back to browser detection when storage is empty; this one
   * assumes storage already holds the latest.
   *
   * Does NOT re-broadcast (the inbound echo-loop guard also covers that).
   */
  private reloadFromStorage(): void {
    const stored = lsGet<Partial<LocaleSettings> | null>(this.STORAGE_KEY, null);
    this.settings = stored?.locale ? this.mergeWithDefaults(stored) : this.detectLocaleSettings();
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
    
    // Detect first day of week.
    //
    // Prefer Intl.Locale.prototype.weekInfo when available — gives authoritative
    // data for every locale (Brazil/Israel/Japan are Sunday-first; the static
    // en-US/en-CA/en-MX list misses them). weekInfo returns 1-based day numbers
    // (1=Monday…7=Sunday per ISO-8601), so we translate to the 0-based
    // Sunday-first convention the rest of the app uses (0=Sunday).
    //
    // Fall back to the hard-coded North American list when the API is absent
    // (older iOS Safari, some Capacitor WebViews). That preserves the previous
    // behavior rather than silently switching those users to Monday-first.
    //
    // Fixes L15 (Inline-Behavior-Review rev 12) — replaces the US-centric
    // heuristic with locale-aware detection.
    const firstDayOfWeek = detectFirstDayOfWeek(locale);
    
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
      'vi-VN': 'VND',
      // CR-Apr24-I finding 228: add exact mappings for supported locales
      // so they don't fall through to the wrong language-prefix match.
      'es-MX': 'MXN',
      'hi-IN': 'INR',
      'es-AR': 'ARS',
      'es-CL': 'CLP',
      'es-CO': 'COP',
      'en-NG': 'NGN',
      'en-PK': 'PKR',
      'bn-BD': 'BDT',
      'uk-UA': 'UAH',
      'ar-EG': 'EGP'
    };
    
    // Check exact match first
    const exact = currencyMap[locale];
    if (exact) {
      return exact;
    }

    // Check language code only.
    // Phase 6 Slice 1i (rev 12 L6): `split('-')[0]` is `string | undefined`
    // under `noUncheckedIndexedAccess`; default to '' so `startsWith` and
    // the lookup behave like a no-match and fall through to USD.
    const lang = locale.split('-')[0] ?? '';
    const langMatch = Object.keys(currencyMap).find(key => key.startsWith(lang));
    if (langMatch) {
      return currencyMap[langMatch] ?? 'USD';
    }

    // Default to USD
    return 'USD';
  }

  /**
   * Get date format pattern for locale
   */
  private getDateFormat(locale: string): string {
    // CR-Apr24-I finding 379: use Intl.DateTimeFormat.formatToParts to
    // reliably detect field ordering instead of pattern-matching on
    // formatted strings, which fails for year-first slash locales
    // (ja-JP, zh-CN), dotted year-first locales (ko-KR), and
    // non-ASCII digit locales (ar-SA).
    try {
      const sample = new Date(2024, 0, 15); // Jan 15, 2024
      const parts = new Intl.DateTimeFormat(locale).formatToParts(sample);
      const order = parts
        .filter(p => p.type === 'day' || p.type === 'month' || p.type === 'year')
        .map(p => p.type);

      // Detect separator from the first literal between date parts
      const litPart = parts.find(p => p.type === 'literal' && p.value.trim().length > 0);
      const sep = litPart?.value.trim() || '/';

      const first = order[0];
      const second = order[1];

      if (first === 'year') {
        return sep === '-' ? 'YYYY-MM-DD' : sep === '.' ? 'YYYY.MM.DD' : 'YYYY/MM/DD';
      }
      if (first === 'day') {
        return sep === '.' ? 'DD.MM.YYYY' : sep === '-' ? 'DD-MM-YYYY' : 'DD/MM/YYYY';
      }
      if (first === 'month' && second === 'day') {
        return sep === '-' ? 'MM-DD-YYYY' : 'MM/DD/YYYY';
      }
    } catch {
      // formatToParts unavailable in very old environments — fall through
    }

    return 'MM/DD/YYYY'; // Default
  }

  /**
   * Get number format pattern for locale
   */
  private getNumberFormat(locale: string): string {
    // CR-Apr24-I finding 380: use formatToParts to reliably detect
    // grouping and decimal separators. The old approach checked only
    // for ASCII comma+dot, collapsing locales with narrow-space
    // grouping (fr-FR, ru-RU, sv-SE, fi-FI) or comma-only decimals
    // (pt-PT, it-IT, es-ES) back to the US pattern.
    try {
      const parts = new Intl.NumberFormat(locale).formatToParts(1234.56);
      const group = parts.find(p => p.type === 'group')?.value || ',';
      const decimal = parts.find(p => p.type === 'decimal')?.value || '.';
      return `1${group}234${decimal}56`;
    } catch {
      // formatToParts unavailable — fall through
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
    // CR-Apr24-I finding 79: respect zero-decimal currencies (JPY, KRW, etc.)
    // instead of hardcoding 2 decimals for every currency code.
    const decimals = CURRENCY_DECIMALS[currency] ?? 2;

    return {
      number: new Intl.NumberFormat(locale),
      currency: new Intl.NumberFormat(locale, {
        style: 'currency',
        currency,
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals
      }),
      currencyCompact: new Intl.NumberFormat(locale, {
        style: 'currency',
        currency,
        minimumFractionDigits: 0,
        maximumFractionDigits: 0
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
      dateLong: new Intl.DateTimeFormat(locale, {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        year: 'numeric'
      }),
      month: new Intl.DateTimeFormat(locale, {
        month: 'long',
        year: 'numeric'
      }),
      monthShort: new Intl.DateTimeFormat(locale, {
        month: 'short'
      }),
      monthShortYear: new Intl.DateTimeFormat(locale, {
        month: 'short',
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
   * Update locale settings.
   *
   * M14: broadcasts `{ type: 'settings-changed' }` to sibling tabs after
   * persisting so they reload from storage and rebuild formatters. Echo-loop
   * guard in `broadcastLocaleChange` prevents re-broadcast when this call
   * originated from an inbound sync.
   */
  updateSettings(settings: Partial<LocaleSettings>): void {
    // CR-Apr24-I finding 80: merge with *current* settings first so that
    // partial updates (e.g. only changing `locale`) preserve the user's
    // existing numberFormat, dateFormat, etc. instead of resetting them
    // back to browser defaults via `detectLocaleSettings()`.
    this.settings = { ...this.settings, ...settings };
    this.formats = this.createFormatters();
    lsSet(this.STORAGE_KEY, this.settings);
    broadcastLocaleChange();
  }

  /**
   * Update just the currency code and rebuild formatters in place.
   *
   * CR-Apr24-I finding 76: `setCurrency()` in data-actions writes the signal
   * and syncs `fmtCur()`, but never told locale-service. Callers use
   * `localeService.formatCurrency()` in toasts, duplicate-review summaries,
   * and other imperative paths, so those surfaces kept the old currency.
   *
   * Unlike `updateSettings()` this does NOT persist or broadcast — the
   * signal write in data-actions already owns persistence and the
   * `syncCurrencyFormat` call keeps `fmtCur()` in sync independently.
   */
  updateCurrency(currencyCode: string): void {
    if (this.settings.currency === currencyCode) return;
    this.settings = { ...this.settings, currency: currencyCode };
    this.formats = this.createFormatters();
  }

  /**
   * Tear down the cross-tab sync channel. Intended for test isolation;
   * the production singleton lives for the full app lifetime.
   */
  destroy(): void {
    closeLocaleSyncChannel();
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
   * Format date.
   *
   * Routes string inputs through `parseLocalDate` so 'YYYY-MM-DD' inputs
   * are anchored at local noon rather than UTC midnight \u2014 otherwise
   * negative-TZ users see the previous day in PDF exports and row
   * renders. Fixes H16 (Inline-Behavior-Review rev 12).
   */
  formatDate(date: Date | string): string {
    const d = typeof date === 'string' ? parseLocalDate(date) : date;
    return this.formats.date.format(d);
  }

  /**
   * Format month/year label.
   *
   * Routes string inputs through `parseLocalDate` (same rationale as
   * `formatDate`). Fixes H16 (Inline-Behavior-Review rev 12).
   */
  formatMonth(date: Date | string): string {
    // CR-Apr24-I finding 369: normalise YYYY-MM strings the same way
    // formatMonthShort / formatMonthShortYear already do, so negative-
    // offset timezones don't shift to the previous month.
    const d =
      typeof date === 'string'
        ? /^\d{4}-\d{2}$/.test(date)
          ? parseLocalDate(`${date}-01`)
          : parseLocalDate(date)
        : date;
    return this.formats.month.format(d);
  }

  /**
   * Format currency with zero decimals — used for chart axes and
   * compact summaries where full cents would be visual noise.
   */
  formatCurrencyCompact(amount: number): string {
    return this.formats.currencyCompact.format(amount);
  }

  /**
   * Format short date: month + day, no year (e.g. "Jan 15", "15 janv.").
   * Routes string inputs through `parseLocalDate` for parity with
   * `formatDate` (H16 contract).
   */
  formatDateShort(date: Date | string): string {
    const d = typeof date === 'string' ? parseLocalDate(date) : date;
    return this.formats.dateShort.format(d);
  }

  /**
   * Format date with year using month-name style (e.g. "Jan 15, 2024"
   * or "January 15, 2024"). Fills the gap between `formatDateShort`
   * (no year) and `formatDateLong` (includes weekday) — common shape
   * for transaction detail rows and delete-transaction confirmation
   * modals that want a year anchor without the weekday preamble.
   *
   * CR-Apr22-G slice 2: replaces scattered
   * `date.toLocaleDateString(undefined, { month, day, year })` calls
   * that bypassed the user's chosen locale (always resolving to the
   * browser default instead).
   *
   * @param monthStyle 'short' for abbreviated month names ("Jan"),
   *        'long' for full names ("January"). Defaults to 'short'.
   */
  formatDateWithYear(date: Date | string, monthStyle: 'short' | 'long' = 'short'): string {
    const d = typeof date === 'string' ? parseLocalDate(date) : date;
    // Build a one-off formatter bound to the service's configured locale
    // so the output respects user preference rather than the environment
    // default. Not cached because the two shapes are rarely mixed at the
    // same site — construction cost is trivial relative to the render
    // paths that call this (modal bodies, detail rows).
    return new Intl.DateTimeFormat(this.settings.locale, {
      year: 'numeric',
      month: monthStyle,
      day: 'numeric'
    }).format(d);
  }

  /**
   * Format a numeric rate with a fixed number of decimals in the user's
   * locale (e.g. `formatRate(15)` → "15.00" in en-US, "15,00" in de-DE).
   *
   * Intended for APR/percent-like labels that pair a number with an
   * externally supplied unit suffix (e.g. `"% APR"`). Returns just the
   * formatted number — callers compose the suffix.
   *
   * CR-Apr22-G slice 2: replaces `(rate * 100).toFixed(2)` in the debt
   * list's APR label, which always rendered with a dot separator
   * regardless of the user's chosen locale.
   */
  formatRate(value: number, decimals: number = 2): string {
    return new Intl.NumberFormat(this.settings.locale, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals
    }).format(value);
  }

  /**
   * Format long date with weekday + year (e.g. "Monday, January 15, 2026").
   * Used by selected-day summaries and forecast badges.
   */
  formatDateLong(date: Date | string): string {
    const d = typeof date === 'string' ? parseLocalDate(date) : date;
    return this.formats.dateLong.format(d);
  }

  /**
   * Format 3-letter month abbreviation (e.g. "Jan", "févr.").
   * Used by trend-chart axis labels and analytics month comparisons.
   *
   * Accepts either a `Date` or a `YYYY-MM` month-key string. Month keys
   * are parsed as the first day of that month at local time so
   * negative-TZ users don't get the previous month back.
   */
  formatMonthShort(date: Date | string): string {
    const d =
      typeof date === 'string'
        ? /^\d{4}-\d{2}$/.test(date)
          ? parseLocalDate(`${date}-01`)
          : parseLocalDate(date)
        : date;
    return this.formats.monthShort.format(d);
  }

  /**
   * Format month + year (e.g. "Jan 2026", "janv. 2026"). Used by
   * calendar month badges and analytics navigation headers.
   */
  formatMonthShortYear(date: Date | string): string {
    const d =
      typeof date === 'string'
        ? /^\d{4}-\d{2}$/.test(date)
          ? parseLocalDate(`${date}-01`)
          : parseLocalDate(date)
        : date;
    return this.formats.monthShortYear.format(d);
  }

  /**
   * Format percentage
   */
  formatPercent(value: number): string {
    return this.formats.percent.format(value / 100);
  }

  /**
   * Parse localized number string to number.
   *
   * Contract (M15 — Inline-Behavior-Review rev 12):
   *   - Returns a finite number when `str` holds a parseable amount.
   *   - Returns `NaN` for empty strings, whitespace-only input, or any
   *     input whose digit-extraction residue doesn't `parseFloat`.
   *
   * Callers must decide whether to treat the NaN as "zero" or as a user
   * error. Internal consumers in `utils-pure.ts` (`toCents`, `parseAmount`)
   * already `isNaN(val)` guard before returning 0, so this is behavior-
   * neutral for them. Any new caller expecting the legacy "empty means
   * zero" semantics should write that intent explicitly:
   *   `const n = parseNumber(str); const amt = Number.isFinite(n) ? n : 0;`
   *
   * Thousands-separator regex now routes through `escapeRegExp` so locales
   * with metacharacter separators (unlikely in practice but reachable
   * through `updateSettings({ thousandsSeparator: '.' })`) don't produce a
   * broken dynamic regex.
   */
  parseNumber(str: string): number {
    const { decimalSeparator, thousandsSeparator } = this.settings;

    let normalized = str;

    // Remove thousands separators
    if (thousandsSeparator) {
      normalized = normalized.replace(new RegExp(escapeRegExp(thousandsSeparator), 'g'), '');
    }

    // Replace decimal separator with dot
    if (decimalSeparator !== '.') {
      normalized = normalized.replaceAll(decimalSeparator, '.');
    }

    // CR-Apr24-I finding 378: transliterate Arabic-Indic (٠-٩) and
    // Extended Arabic-Indic (۰-۹) digits to ASCII before stripping,
    // so ar-SA formatted numbers like ١٬٢٣٤٫٥٦ parse correctly.
    normalized = normalized.replace(/[\u0660-\u0669]/g, c =>
      String.fromCharCode(c.charCodeAt(0) - 0x0660 + 48));
    normalized = normalized.replace(/[\u06F0-\u06F9]/g, c =>
      String.fromCharCode(c.charCodeAt(0) - 0x06F0 + 48));
    // Also transliterate Arabic decimal mark (٫ U+066B) and thousands
    // separator (٬ U+066C) that Intl may produce for ar-SA.
    normalized = normalized.replace(/\u066B/g, '.');
    normalized = normalized.replace(/\u066C/g, '');

    // Remove currency symbols and spaces
    normalized = normalized.replace(/[^\d.-]/g, '');

    // M15: propagate NaN for unparseable input — no `|| 0` mask.
    return parseFloat(normalized);
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
export const formatCurrencyCompact = (amount: number): string => localeService.formatCurrencyCompact(amount);
export const formatDate = (date: Date | string): string => localeService.formatDate(date);
export const formatDateShort = (date: Date | string): string => localeService.formatDateShort(date);
export const formatDateLong = (date: Date | string): string => localeService.formatDateLong(date);
export const formatDateWithYear = (date: Date | string, monthStyle: 'short' | 'long' = 'short'): string =>
  localeService.formatDateWithYear(date, monthStyle);
export const formatRate = (value: number, decimals: number = 2): string =>
  localeService.formatRate(value, decimals);
export const formatMonth = (date: Date | string): string => localeService.formatMonth(date);
export const formatMonthShort = (date: Date | string): string => localeService.formatMonthShort(date);
export const formatMonthShortYear = (date: Date | string): string => localeService.formatMonthShortYear(date);
export const formatPercent = (value: number): string => localeService.formatPercent(value);
export const parseNumber = (str: string): number => localeService.parseNumber(str);
export const parseCurrency = (str: string): number => localeService.parseCurrency(str);
export const getLocale = (): string => localeService.getLocale();
export const getCurrency = (): string => localeService.getCurrency();

/**
 * Month-relative copy helper for UI strings that used to hardcode
 * "this month". Returns "this month" when the user is viewing the real
 * current month, otherwise returns a preposition-prefixed month label
 * (e.g. "in April 2026") so the copy stays correct when the user is
 * browsing a past or future month.
 *
 * Design-Review-Apr21 P3 (batch 6 follow-up wave L): several widgets
 * (weekly rollup, category drill-down, ledger empty state, calendar
 * empty state, hero guidance) kept static "this month" copy even
 * though their data source was reactive to `signals.currentMonth`.
 * When the user navigated to a different month, the copy no longer
 * matched the period on screen — making the dashboard feel like it
 * had lost track of which month it was summarizing.
 *
 * The helper embeds the preposition ("in ...") so callers can drop
 * the phrase into copy in place of bare "this month" without having
 * to conditionalize the preposition at each site:
 *
 *   Before: `No transactions recorded this month.`
 *   After:  `No transactions recorded ${formatViewedMonthPhrase(mk)}.`
 *     → current-month view: "No transactions recorded this month."
 *     → April 2026 view:    "No transactions recorded in April 2026."
 *
 * Accepts an optional `realMonthKey` override for deterministic
 * testing (otherwise derives from `new Date()` via `getMonthKey`).
 */
export const formatViewedMonthPhrase = (
  monthKey: string,
  realMonthKey?: string
): string => {
  const real = realMonthKey ?? getMonthKey(new Date());
  if (monthKey === real) return 'this month';
  try {
    const labeled = formatMonth(parseMonthKey(monthKey));
    if (!labeled) return 'this month';
    return `in ${labeled}`;
  } catch {
    return 'this month';
  }
};

/**
 * Companion helper that returns a bare month label (no preposition),
 * for cases where the caller needs to compose its own preposition
 * ("for April 2026", "of April 2026") or render the label standalone
 * (section headers, captions).
 *
 * Returns "this month" when viewing the real current month so the
 * natural-language shape stays readable at the current-month
 * default. Callers that need the unconditional explicit label can
 * use `formatMonth(parseMonthKey(monthKey))` directly.
 */
export const formatViewedMonthLabel = (
  monthKey: string,
  realMonthKey?: string
): string => {
  const real = realMonthKey ?? getMonthKey(new Date());
  if (monthKey === real) return 'this month';
  try {
    return formatMonth(parseMonthKey(monthKey)) || 'this month';
  } catch {
    return 'this month';
  }
};