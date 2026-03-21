/**
 * Application Configuration Type Definitions
 * 
 * Strongly typed configuration interfaces to replace 'any' types
 * throughout the application.
 */
'use strict';

// ==========================================
// TIMING CONFIGURATION
// ==========================================

export interface TimingConfig {
  TOAST_DURATION: number;
  TOAST_FADE_OUT: number;
  MODAL_ANIMATION: number;
  SPLIT_RESET: number;
  PIN_ERROR_DISPLAY: number;
  DEBOUNCE_DELAY: number;
  SEARCH_DEBOUNCE: number;
  RENDER_DELAY: number;
  WORKER_TIMEOUT: number;
}

// ==========================================
// PAGINATION CONFIGURATION
// ==========================================

export interface PaginationConfig {
  PAGE_SIZE: number;
  MAX_PAGES_SHOWN?: number;
  SCROLL_TO_TOP?: boolean;
}

// ==========================================
// SWIPE CONFIGURATION
// ==========================================

export interface SwipeConfig {
  THRESHOLD: number;
  VELOCITY_THRESHOLD: number;
  RESTRAINT: number;
  ALLOWED_TIME: number;
  ENABLE_MOUSE?: boolean;
  ENABLE_TOUCH?: boolean;
}

// ==========================================
// CALENDAR CONFIGURATION
// ==========================================

export interface CalendarConfig {
  CALENDAR_INTENSITY: {
    LOW: number;
    MEDIUM: number;
    HIGH: number;
    MAX: number;
  };
  START_DAY?: 0 | 1 | 6; // Sunday, Monday, or Saturday
  SHOW_WEEK_NUMBERS?: boolean;
}

// ==========================================
// CURRENCY CONFIGURATION
// ==========================================

export interface CurrencyConfig {
  symbol: string;
  code: string;
  decimals: number;
  thousandSeparator: string;
  decimalSeparator: string;
  position: 'before' | 'after';
}

// ==========================================
// EMPTY STATE ACTION
// ==========================================

export interface EmptyStateAction {
  id: string;
  label: string;
  icon?: string;
  variant?: 'primary' | 'secondary' | 'text';
}

// ==========================================
// SWIPE MANAGER INTERFACE
// ==========================================

export interface SwipeManager {
  attach(element: HTMLElement): void;
  detach(element: HTMLElement): void;
  closeSwipe(element: HTMLElement): void;
  closeAll(): void;
  destroy(): void;
  isOpen(element: HTMLElement): boolean;
  getOpenElements(): HTMLElement[];
}

// ==========================================
// RENDER CALLBACKS
// ==========================================

export type RenderCallback = () => void;
export type AsyncRenderCallback = () => Promise<void>;
export type CurrencyFormatter = (value: number) => string;
export type DateFormatter = () => string;
export type MonthFormatter = (monthKey: string) => string;

// ==========================================
// EMPTY STATE RENDERER
// ==========================================

export type EmptyStateRenderer = (
  emoji: string,
  title: string,
  subtitle: string,
  action: EmptyStateAction | null
) => any; // Returns LitTemplate but keeping any for compatibility

// ==========================================
// TAB SWITCHERS
// ==========================================

export type TabSwitcher = (tabName: string) => void;
export type MainTabSwitcher = (tab: string) => void;

// ==========================================
// FEATURE CALLBACKS
// ==========================================

export interface FeatureCallbacks {
  renderCategories: RenderCallback;
  renderQuickShortcuts: RenderCallback;
  populateCategoryFilter: RenderCallback;
  renderCustomCatsList: RenderCallback;
  updateSplitRemaining: RenderCallback;
  openSettingsModal: RenderCallback;
  updateCharts: RenderCallback;
  refreshAll: AsyncRenderCallback;
}

// ==========================================
// APPLICATION SERVICES
// ==========================================

export interface ApplicationServices {
  // Core formatters
  fmtCur: CurrencyFormatter;
  fmtShort: CurrencyFormatter;
  getTodayStr: DateFormatter;
  monthLabel: MonthFormatter;
  
  // UI functions
  renderCategories: RenderCallback;
  renderTransactions: (resetPage?: boolean) => void;
  switchTab: TabSwitcher;
  switchMainTab: MainTabSwitcher;
  emptyState: EmptyStateRenderer;
  updateCharts: RenderCallback;
  refreshAll: AsyncRenderCallback;
  
  // Features
  calcVelocity: () => any; // Returns VelocityData
  renderQuickShortcuts: RenderCallback;
  populateCategoryFilter: RenderCallback;
  renderCustomCatsList: RenderCallback;
  updateSplitRemaining: RenderCallback;
  openSettingsModal: RenderCallback;
  
  // Managers
  swipeManager: SwipeManager;
}

// ==========================================
// APPLICATION CONFIGURATION
// ==========================================

export interface ApplicationConfig {
  TIMING: TimingConfig;
  PAGINATION: PaginationConfig;
  SWIPE: SwipeConfig;
  CALENDAR_INTENSITY: CalendarConfig['CALENDAR_INTENSITY'];
  PIN_ERROR_DISPLAY: number;
  RECURRING_MAX_ENTRIES: number;
  VIRTUAL_SCROLL_THRESHOLD?: number;
  WORKER_THRESHOLD?: number;
  MAX_ATTACHMENT_SIZE?: number;
  SUPPORTED_FILE_TYPES?: string[];
}

// ==========================================
// CHART RENDERER CONFIG
// ==========================================

export interface ChartRendererConfig {
  fmtCur: CurrencyFormatter;
  monthLabel: MonthFormatter;
  calcVelocity: () => any; // Returns VelocityData
}

// ==========================================
// KEYBOARD EVENT CONFIG
// ==========================================

export interface KeyboardEventConfig {
  switchMainTab: MainTabSwitcher;
  switchTab: TabSwitcher;
  cancelEditing: () => void;
  openSettingsModal: () => void;
  renderCategories: RenderCallback;
}

// ==========================================
// IMPORT/EXPORT EVENT CONFIG
// ==========================================

export interface ImportExportEventConfig {
  fmtCur: CurrencyFormatter;
}

// ==========================================
// FILTER EVENT CONFIG
// ==========================================

export interface FilterEventConfig {
  handleTransactionListClick: (e: Event) => void;
  handlePaginationClick: (e: Event) => void;
  swipeManagerCloseAll: () => void;
}

// ==========================================
// WEEKLY ROLLUP CONFIG
// ==========================================

export interface WeeklyRollupConfig {
  fmtCur: CurrencyFormatter;
  fmtShort: CurrencyFormatter;
  switchMainTab: MainTabSwitcher;
  renderTransactions: (resetPage?: boolean) => void;
}