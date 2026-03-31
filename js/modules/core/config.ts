/**
 * Configuration Module
 *
 * Shared configuration constants used across modules.
 *
 * @module config
 */

// ==========================================
// TIMING CONFIGURATION
// ==========================================

interface TimingConfig {
  readonly TOAST_DURATION: number;
  readonly TOAST_FADE_OUT: number;
  readonly CELEBRATION_DURATION: number;
  readonly CONFETTI_REMOVAL: number;
  readonly UI_DELAY: number;
  readonly FOCUS_DELAY: number;
  readonly PIN_ERROR_DISPLAY: number;
  readonly SPLIT_RESET: number;
  readonly URL_REVOKE_DELAY: number;
  readonly MODAL_FOCUS_DELAY: number;
}

// ==========================================
// SECURITY CONFIGURATION
// ==========================================

interface SecurityConfig {
  readonly PBKDF2_ITERATIONS: number;
  readonly PIN_MIN_LENGTH: number;
  readonly SALT_BYTES: number;
  readonly DERIVED_BITS: number;
}

// ==========================================
// AUTO-LOCK CONFIGURATION
// ==========================================

interface AutoLockConfig {
  readonly TIMEOUT_MS: number;
  readonly ENABLED: boolean;
}

// ==========================================
// RATE LIMIT CONFIGURATION
// ==========================================

interface RateLimitConfig {
  readonly MAX_ATTEMPTS: number;
  readonly BASE_LOCKOUT_MS: number;
}

// ==========================================
// GESTURES CONFIGURATION
// ==========================================

interface GesturesConfig {
  readonly SWIPE_THRESHOLD: number;
  readonly VERTICAL_THRESHOLD: number;
}

// ==========================================
// SWIPE CONFIGURATION
// ==========================================

interface SwipeConfig {
  readonly THRESHOLD: number;
  readonly VELOCITY_THRESHOLD: number;
  readonly MAX_OFFSET: number;
  readonly RESISTANCE: number;
}

// ==========================================
// CHARTS CONFIGURATION
// ==========================================

interface DonutChartConfig {
  readonly CX: number;
  readonly CY: number;
  readonly RADIUS: number;
  readonly INNER_RADIUS: number;
  readonly SVG_SIZE: number;
}

interface TrendChartPadding {
  readonly LEFT: number;
  readonly BOTTOM: number;
  readonly TOP: number;
  readonly RIGHT: number;
}

interface TrendChartConfig {
  readonly WIDTH: number;
  readonly HEIGHT: number;
  readonly PADDING: TrendChartPadding;
}

interface CategoryTrendConfig {
  readonly WIDTH: number;
  readonly HEIGHT: number;
}

interface ChartsConfig {
  readonly DONUT: DonutChartConfig;
  readonly TREND: TrendChartConfig;
  readonly CATEGORY_TREND: CategoryTrendConfig;
  readonly BUDGET_PROGRESS_RADIUS: number;
  readonly MIN_BAR_HEIGHT: number;
}

// ==========================================
// CALENDAR CONFIGURATION
// ==========================================

interface CalendarIntensityConfig {
  readonly base: number;
  readonly multiplier: number;
}

// ==========================================
// PAGINATION CONFIGURATION
// ==========================================

interface PaginationConfig {
  readonly PAGE_SIZE: number;
  readonly FILTER_DEBOUNCE_MS: number;
}

interface BackupConfig {
  readonly REMINDER_DAYS: number;
  readonly TRANSACTION_THRESHOLD: number;
  readonly SNOOZE_HOURS: number;
  readonly MAX_SNOOZE_COUNT: number;
  readonly URGENT_THRESHOLD: number;
}

// ==========================================
// UI CONFIGURATION
// ==========================================

interface UIConfig {
  readonly MAX_FILE_SIZE_MB: number;
  readonly MAX_TRANSACTIONS_LIMIT: number;
  readonly CHAR_WARNING_THRESHOLD: number;
}

// ==========================================
// ANIMATION CONFIGURATION
// ==========================================

interface AnimationConfig {
  readonly CONFETTI_COUNT: number;
  readonly CONFETTI_DURATION_BASE: number;
}

// ==========================================
// APP CONFIGURATION
// ==========================================

interface AppConfig {
  readonly MAX_ID_LENGTH: number;
  readonly MAX_AMOUNT: number;
  readonly MAX_DESCRIPTION_LENGTH: number;
  readonly MAX_NOTES_LENGTH: number;
  readonly MAX_DATE_YEARS: number;
  readonly RECURRING_MAX_ENTRIES: number;
  readonly BACKUP: BackupConfig;
  readonly TIMING: TimingConfig;
  readonly SECURITY: SecurityConfig;
  readonly GESTURES: GesturesConfig;
  readonly SWIPE: SwipeConfig;
  readonly CHARTS: ChartsConfig;
  readonly CALENDAR_INTENSITY: CalendarIntensityConfig;
  readonly PAGINATION: PaginationConfig;
  readonly UI: UIConfig;
  readonly ANIMATION: AnimationConfig;
  readonly AUTO_LOCK: AutoLockConfig;
  readonly RATE_LIMIT: RateLimitConfig;
}

export const CONFIG: AppConfig = {
  // Data limits
  MAX_ID_LENGTH: 128,
  MAX_AMOUNT: 999999.99,
  MAX_DESCRIPTION_LENGTH: 500,
  MAX_NOTES_LENGTH: 500,
  MAX_DATE_YEARS: 10,
  RECURRING_MAX_ENTRIES: 365,

  // Backup Settings
  BACKUP: {
    REMINDER_DAYS: 7,
    TRANSACTION_THRESHOLD: 5,
    SNOOZE_HOURS: 24,
    MAX_SNOOZE_COUNT: 3,
    URGENT_THRESHOLD: 14
  },

  // Timing (milliseconds)
  TIMING: {
    TOAST_DURATION: 3000,
    TOAST_FADE_OUT: 300,
    CELEBRATION_DURATION: 4000,
    CONFETTI_REMOVAL: 3000,
    UI_DELAY: 50,
    FOCUS_DELAY: 100,
    PIN_ERROR_DISPLAY: 2000,
    SPLIT_RESET: 2000,
    URL_REVOKE_DELAY: 1000,
    MODAL_FOCUS_DELAY: 50
  },

  // Security
  SECURITY: {
    PBKDF2_ITERATIONS: 600000,
    PIN_MIN_LENGTH: 4,
    SALT_BYTES: 16,
    DERIVED_BITS: 256
  },

  // Touch gestures (pixels)
  GESTURES: {
    SWIPE_THRESHOLD: 60,
    VERTICAL_THRESHOLD: 100
  },

  // Transaction row swipe actions
  SWIPE: {
    THRESHOLD: 80,
    VELOCITY_THRESHOLD: 0.5,
    MAX_OFFSET: 168,
    RESISTANCE: 0.4
  },

  // Chart dimensions
  CHARTS: {
    DONUT: { CX: 90, CY: 90, RADIUS: 70, INNER_RADIUS: 42, SVG_SIZE: 140 },
    TREND: { WIDTH: 500, HEIGHT: 250, PADDING: { LEFT: 55, BOTTOM: 80, TOP: 25, RIGHT: 15 } },
    CATEGORY_TREND: { WIDTH: 500, HEIGHT: 220 },
    BUDGET_PROGRESS_RADIUS: 70,
    MIN_BAR_HEIGHT: 2
  },

  // Calendar heatmap
  CALENDAR_INTENSITY: { base: 8, multiplier: 50 },

  // Pagination
  PAGINATION: {
    PAGE_SIZE: 50,
    FILTER_DEBOUNCE_MS: 300
  },

  // UI limits
  UI: {
    MAX_FILE_SIZE_MB: 25, // FIXED: Unified with import-export default
    MAX_TRANSACTIONS_LIMIT: 10000,
    CHAR_WARNING_THRESHOLD: 0.9
  },

  // Animation settings
  ANIMATION: {
    CONFETTI_COUNT: 30,
    CONFETTI_DURATION_BASE: 1.5
  },

  // Auto-lock on inactivity
  AUTO_LOCK: {
    TIMEOUT_MS: 300000, // 5 minutes
    ENABLED: true
  },

  // PIN rate limiting (brute-force protection)
  RATE_LIMIT: {
    MAX_ATTEMPTS: 5,
    BASE_LOCKOUT_MS: 30000 // 30 seconds, doubles each lockout
  }
} as const;

// ==========================================
// CURRENCY CONFIGURATION
// ==========================================

// Re-export canonical currency map from utils-pure (single source of truth)
// Do NOT duplicate this map - update utils-pure.ts if currencies need to change
export { CURRENCY_MAP } from './utils-pure.js';

// Re-export types for use in other modules
export type {
  AppConfig,
  TimingConfig,
  SecurityConfig,
  GesturesConfig,
  SwipeConfig,
  ChartsConfig,
  DonutChartConfig,
  TrendChartConfig,
  CategoryTrendConfig,
  CalendarIntensityConfig,
  PaginationConfig,
  UIConfig,
  AnimationConfig,
  AutoLockConfig,
  RateLimitConfig
};
