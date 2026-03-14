/**
 * Type Definitions for Budget Tracker Elite
 *
 * Central type definitions for the application.
 * Import types from here to ensure consistency across modules.
 *
 * @module types
 */

// ==========================================
// CORE TRANSACTION TYPE
// ==========================================

export interface Transaction {
  __backendId: string;
  type: 'expense' | 'income';
  amount: number;
  description: string;
  date: string; // YYYY-MM-DD format
  category: string;
  tags?: string;
  notes?: string;
  currency: string;
  recurring: boolean;
  recurring_type?: 'daily' | 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'yearly';
  recurring_end?: string;
  reconciled?: boolean;
  splits?: boolean;
  parentTxId?: string;
  debtId?: string; // Link to debt for debt payments
}

export type TransactionType = 'expense' | 'income';

// ==========================================
// DEBT TRACKING
// ==========================================

export type DebtType = 'credit_card' | 'student_loan' | 'mortgage' | 'auto' | 'personal' | 'medical' | 'other';

export interface DebtTypeInfo {
  label: string;
  emoji: string;
}

export interface DebtPayment {
  id: string;
  date: string;
  amount: number;
  principal: number;
  interest: number;
  transactionId: string;
}

export interface Debt {
  id: string;
  name: string;
  type: DebtType;
  balance: number;
  originalBalance: number;
  interestRate: number; // APR as decimal (e.g., 0.1999 for 19.99%)
  minimumPayment: number;
  dueDay: number;
  createdAt: string;
  payments: DebtPayment[];
  isActive: boolean;
}

// Simplified Debt for backwards compatibility
export interface DebtSimple {
  id: string;
  name: string;
  balance: number;
  rate: number; // APR as percentage
  minPayment: number;
  dueDay?: number;
}

export interface PayoffInfo {
  months: number;
  date: Date | null;
  totalInterest: number;
}

export interface AmortizationEntry {
  month: number;
  payment: number;
  principal: number;
  interest: number;
  balance: number;
}

export interface DebtPayoffOrder {
  id: string;
  name: string;
  month: number;
}

export interface PayoffScheduleEntry {
  month: number;
  totalBalance: number;
  interest: number;
}

export interface PayoffStrategyResult {
  months: number;
  totalInterest: number;
  order: DebtPayoffOrder[];
  schedule: PayoffScheduleEntry[];
}

export interface StrategyComparison {
  snowball: PayoffStrategyResult;
  avalanche: PayoffStrategyResult;
  interestSaved: number;
  timeDiff: number;
  recommended: 'avalanche' | 'snowball';
}

export interface DebtProgress {
  original: number;
  current: number;
  paid: number;
  percentComplete: number;
  paymentsCount: number;
  lastPayment: DebtPayment | null;
}

export interface TotalDebtSummary {
  totalBalance: number;
  totalOriginal: number;
  totalPaid: number;
  percentComplete: number;
  debtCount: number;
  monthlyMinimum: number;
  avgInterestRate: number;
}

export interface PaymentResult {
  isOk: boolean;
  error?: string;
  debt?: Debt;
  payment?: DebtPayment;
  transaction?: Transaction;
}

// ==========================================
// SAVINGS GOALS
// ==========================================

export interface SavingsGoal {
  id: string;
  name: string;
  target: number;
  saved: number;
  deadline?: string;
  icon?: string;
}

export interface SavingsContribution {
  id: string;
  goalId: string;
  amount: number;
  date: string;
  note?: string;
}

// ==========================================
// BUDGET ALLOCATION
// ==========================================

export interface MonthlyAllocation {
  [categoryId: string]: number;
}

// ==========================================
// CURRENCY SETTINGS
// ==========================================

export interface CurrencySettings {
  home: string;
  symbol: string;
}

// ==========================================
// STREAK TRACKING
// ==========================================

export interface StreakData {
  current: number;
  longest: number;
  lastDate: string;
}

// ==========================================
// ALERT PREFERENCES
// ==========================================

export interface AlertPrefs {
  budgetThreshold: number | null;
}

// ==========================================
// ROLLOVER SETTINGS
// ==========================================

export interface RolloverSettings {
  enabled: boolean;
  mode: 'all' | 'selected';
  categories: string[];
  maxRollover: number | null;
  negativeHandling: 'zero' | 'carry' | 'ignore';
}

// ==========================================
// PAGINATION STATE
// ==========================================

export interface PaginationState {
  page: number;
  totalPages: number;
  totalItems: number;
}

// ==========================================
// CUSTOM CATEGORY
// ==========================================

export interface CustomCategory {
  id: string;
  name: string;
  emoji: string;
  color: string;
  type: 'expense' | 'income';
}

// ==========================================
// FILTER PRESET
// ==========================================

export interface FilterState {
  type: string;
  category: string;
  search: string;
  tags: string;
  from: string;
  to: string;
  minAmt: string;
  maxAmt: string;
  recurring: boolean;
  unreconciled: boolean;
  showAllMonths: boolean;
}

export interface FilterPreset {
  id: string;
  name: string;
  filters: FilterState;
}

// ==========================================
// TRANSACTION TEMPLATE
// ==========================================

export interface TxTemplate {
  id: string;
  name: string;
  type: 'expense' | 'income';
  category: string;
  amount?: number;
  description?: string;
}

// ==========================================
// SECTIONS CONFIG
// ==========================================

export interface SectionsConfig {
  envelope: boolean;
}

// ==========================================
// INSIGHT PERSONALITY
// ==========================================

export type InsightPersonality = 'serious' | 'casual' | 'motivating';

// ==========================================
// MAIN TAB
// ==========================================

export type MainTab = 'dashboard' | 'transactions' | 'budget';

// ==========================================
// FULL APPLICATION STATE
// ==========================================

export interface AppState {
  // Data
  transactions: Transaction[];
  savingsGoals: Record<string, SavingsGoal>;
  savingsContribs: SavingsContribution[];
  monthlyAlloc: Record<string, MonthlyAllocation>;
  achievements: Record<string, unknown>;
  streak: StreakData;
  customCats: CustomCategory[];
  debts: Debt[];

  // Settings
  currency: CurrencySettings;
  sections: SectionsConfig;
  pin: string;
  insightPers: InsightPersonality;
  alerts: AlertPrefs;
  rolloverSettings: RolloverSettings;
  filterPresets: FilterPreset[];
  txTemplates: TxTemplate[];

  // Navigation/UI State
  currentMonth: string; // YYYY-MM format
  currentType: TransactionType;
  currentTab: TransactionType;
  selectedCategory: string;
  editingId: string | null;
  deleteTargetId: string | null;
  addSavingsGoalId: string | null;
  splitTxId: string | null;
  pendingEditTx: Transaction | null;
  editSeriesMode: boolean;
  activeMainTab: MainTab;
  pagination: PaginationState;
}

// ==========================================
// STORAGE KEYS
// ==========================================

export interface StorageKeys {
  TX: string;
  SAVINGS: string;
  ALLOC: string;
  THEME: string;
  ACHIEVE: string;
  STREAK: string;
  ONBOARD: string;
  CUSTOM_CAT: string;
  CURRENCY: string;
  SECTIONS: string;
  PIN: string;
  INSIGHT_PERS: string;
  ALERTS: string;
  SAVINGS_CONTRIB: string;
  LAST_BACKUP: string;
  FILTER_PRESETS: string;
  TX_TEMPLATES: string;
  FILTER_EXPANDED: string;
  ROLLOVER_SETTINGS: string;
  DEBTS: string;
}

// ==========================================
// EVENT BUS TYPES
// ==========================================

export type EventCallback = (payload?: unknown) => void;

export interface EventBusSubscription {
  unsubscribe: () => void;
}

// ==========================================
// STORAGE ADAPTER TYPES
// ==========================================

export interface StorageResult {
  isOk: boolean;
  error?: string;
  data?: unknown;
}

// Storage store names
export const STORES = {
  TRANSACTIONS: 'transactions',
  SETTINGS: 'settings',
  SAVINGS_GOALS: 'savingsGoals',
  SAVINGS_CONTRIBUTIONS: 'savingsContributions',
  MONTHLY_ALLOCATIONS: 'monthlyAllocations',
  ACHIEVEMENTS: 'achievements',
  STREAK: 'streak',
  CUSTOM_CATEGORIES: 'customCategories',
  DEBTS: 'debts',
  FILTER_PRESETS: 'filterPresets',
  TX_TEMPLATES: 'txTemplates',
  METADATA: 'metadata'
} as const;

export type StoreName = typeof STORES[keyof typeof STORES];

// Settings keys stored in the SETTINGS store
export const SETTINGS_KEYS = {
  THEME: 'theme',
  CURRENCY: 'currency',
  PIN: 'pin',
  SECTIONS: 'sections',
  INSIGHT_PERSONALITY: 'insightPersonality',
  ALERTS: 'alerts',
  ROLLOVER_SETTINGS: 'rolloverSettings',
  ONBOARDING: 'onboarding',
  LAST_BACKUP: 'lastBackup',
  FILTER_EXPANDED: 'filterExpanded'
} as const;

export type SettingKey = typeof SETTINGS_KEYS[keyof typeof SETTINGS_KEYS];

// Storage type
export type StorageType = 'indexeddb' | 'localstorage';

export interface StorageAdapter {
  isAvailable(): boolean;
  getType(): StorageType;
  init(): Promise<StorageResult>;
  get(store: StoreName, key: string): Promise<unknown>;
  set(store: StoreName, key: string, value: unknown): Promise<boolean>;
  delete(store: StoreName, key: string): Promise<boolean>;
  getAll(store: StoreName): Promise<unknown[]>;
  clear(store: StoreName): Promise<boolean>;
  getTransactionsByMonth(monthKey: string): Promise<Transaction[]>;
  getTransactionsByDateRange(startDate: string, endDate: string): Promise<Transaction[]>;
  countTransactions(filters?: TransactionFilters): Promise<number>;
  createBatch(store: StoreName, items: unknown[]): Promise<boolean>;
  updateBatch(store: StoreName, items: unknown[]): Promise<boolean>;
  deleteBatch(store: StoreName, keys: string[]): Promise<boolean>;
  exportAll(): Promise<Record<string, unknown>>;
  importAll(data: Record<string, unknown>, overwrite?: boolean): Promise<boolean>;
  clearAll(): Promise<boolean>;
}

// Sync messaging for multi-tab
export interface SyncMessage {
  type: 'create' | 'update' | 'delete' | 'batch' | 'clear';
  store: StoreName | 'all';
  data?: unknown;
  timestamp: number;
  tabId: string;
}

// Data handler interface
export interface DataHandler {
  onDataChanged(transactions: Transaction[]): void;
}

// Generic operation result
export interface OperationResult<T = unknown> {
  isOk: boolean;
  error?: string;
  data?: T;
  errors?: Record<string, string>;
}

// ==========================================
// MIGRATION TYPES
// ==========================================

export interface MigrationStatus {
  completed: boolean;
  timestamp?: number;
  version?: string;
  itemCount?: number;
}

export interface MigrationProgress {
  phase: 'reading' | 'migrating' | 'verifying' | 'complete' | 'error';
  progress: number;
  current?: number;
  total?: number;
  error?: string;
}

export type MigrationProgressCallback = (progress: MigrationProgress) => void;

// ==========================================
// VIRTUAL SCROLLER TYPES
// ==========================================

export interface VirtualScrollerOptions {
  estimatedRowHeight?: number;
  bufferSize?: number;
  overscan?: number;
}

export type RowRenderer<T> = (
  container: HTMLElement,
  item: T,
  index: number
) => void;

export type RowRecycler = (row: HTMLElement) => void;

// ==========================================
// CHART TYPES
// ==========================================

export interface ChartDataPoint {
  label: string;
  value: number;
  color?: string;
}

export interface TrendData {
  labels: string[];
  values: number[];
}

// ==========================================
// CALCULATION RESULT TYPES
// ==========================================

export interface CategorySummary {
  categoryId: string;
  categoryName: string;
  total: number;
  percentage: number;
  count: number;
}

export interface MonthSummary {
  income: number;
  expenses: number;
  net: number;
  categories: CategorySummary[];
}

// ==========================================
// FILTER TYPES
// ==========================================

export interface TransactionFilters {
  search?: string;
  searchQuery?: string;
  type?: TransactionType | 'all';
  category?: string;
  dateFrom?: string;
  dateTo?: string;
  amountMin?: number | string;
  amountMax?: number | string;
  minAmount?: number | string;
  maxAmount?: number | string;
  tags?: string[] | string;
  reconciled?: boolean | 'all' | 'yes' | 'no';
  monthKey?: string;
  showAllMonths?: boolean;
  recurringOnly?: boolean;
}

// ==========================================
// SWIPE MANAGER TYPES
// ==========================================

export interface SwipeState {
  startX: number;
  startY: number;
  currentX: number;
  isActive: boolean;
  direction: 'left' | 'right' | null;
}

export interface SwipeCallbacks {
  onSwipeLeft?: (element: HTMLElement) => void;
  onSwipeRight?: (element: HTMLElement) => void;
}

// ==========================================
// UTILITY TYPES
// ==========================================

export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

export type Nullable<T> = T | null;

// ==========================================
// VALIDATION TYPES
// ==========================================

export interface ValidationSuccess<T> {
  valid: true;
  value: T;
}

export interface ValidationFailure {
  valid: false;
  error: string;
}

export type ValidationResult<T> = ValidationSuccess<T> | ValidationFailure;

export type TextFieldType = 'description' | 'notes' | 'tags';

export type ValidationFieldType = 'amount' | 'date' | 'pin' | TextFieldType;

export interface AmountRule {
  min: number;
  max: number;
  pattern: RegExp;
  message: string;
}

export interface TextRule {
  maxLength: number;
  pattern: RegExp;
  message: string;
}

export interface DateRule {
  min: string;
  max: string;
  message: string;
}

export interface PinRule {
  pattern: RegExp;
  message: string;
}

export interface ValidationRules {
  amount: AmountRule;
  description: TextRule;
  notes: TextRule;
  tags: TextRule;
  date: DateRule;
  pin: PinRule;
}

export interface TransactionValidationResult {
  valid: boolean;
  errors: Record<string, string>;
  sanitized: Partial<Transaction>;
}

export interface ImportValidationError {
  index: number;
  item: unknown;
  errors: Record<string, string>;
}

export interface ImportValidationResult {
  valid: Transaction[];
  invalid: unknown[];
  errors: ImportValidationError[];
}

// ==========================================
// CATEGORY TYPES
// ==========================================

export interface CategoryChild {
  id: string;
  name: string;
  emoji: string;
  color: string;
}

export interface CategoryDefinition extends CategoryChild {
  children?: CategoryChild[];
}

export interface FlattenedCategory extends CategoryChild {
  parent?: string;
  parentName?: string;
  type?: TransactionType;
}

export type EmojiPickerCategories = Record<string, string[]>;

// ==========================================
// CALCULATION TYPES
// ==========================================

export interface Totals {
  income: number;
  expenses: number;
  balance: number;
}

export interface VelocityData {
  dailyRate: number;
  projected: number;
  actual: number;
}

export type DailyAllowanceStatus = 'neutral' | 'no-budget' | 'over' | 'warning' | 'healthy';

export interface DailyAllowanceData {
  dailyAllowance: number;
  daysRemaining: number;
  totalBudget: number;
  spent: number;
  remaining: number;
  status: DailyAllowanceStatus;
  isCurrentMonth: boolean;
}

export type SpendingPaceStatus = 'no-budget' | 'over' | 'on-track' | 'under';

export interface SpendingPaceData {
  status: SpendingPaceStatus;
  percentOfBudget: number;
  expectedPercent: number;
  difference: number;
  isCurrentMonth?: boolean;
}

export interface TopCategoryResult extends CategoryChild {
  amount: number;
}

export interface YearStats {
  year: string;
  income: number;
  expenses: number;
  net: number;
  savingsRate: number;
  topCategories: TopCategoryResult[];
  monthlyData: Record<string, { income: number; expenses: number }>;
  avgMonthlyIncome: number;
  avgMonthlyExpenses: number;
  txCount: number;
}

export interface MonthBestWorst {
  month: string;
  income: number;
  expenses: number;
  net: number;
}

export interface AllTimeStats {
  firstDate: string;
  lastDate: string;
  totalIncome: number;
  totalExpenses: number;
  netSavings: number;
  savingsRate: number;
  txCount: number;
  avgMonthlySpend: number;
  bestMonth: MonthBestWorst | null;
  worstMonth: MonthBestWorst | null;
  years: string[];
}

export interface DetailedMonthData {
  income: number;
  expenses: number;
  net: number;
  categories: Record<string, number>;
}

export interface MonthlyComparison {
  month: number;
  monthLabel: string;
  year1: DetailedMonthData;
  year2: DetailedMonthData;
  expenseChange: number;
  incomeChange: number;
  netChange: number;
}

// ==========================================
// THEME TYPES
// ==========================================

export type Theme = 'dark' | 'light' | 'system';
export type ActualTheme = 'dark' | 'light';

// ==========================================
// DOM CACHE TYPES
// ==========================================

export interface FilterValues {
  type: string;
  category: string;
  dateFrom: string;
  dateTo: string;
  amountMin: string;
  amountMax: string;
  tags: string;
  search: string;
  reconciled: string;
}

export interface FormValues {
  amount: string;
  description: string;
  date: string;
  category: string;
  notes: string;
  tags: string;
  recurring: boolean;
  recurringType: string;
  recurringEnd: string;
}

export interface SafeMockElement {
  value: string;
  checked: boolean;
  textContent: string;
  innerHTML: string;
  style: Record<string, string>;
  classList: {
    add: () => void;
    remove: () => void;
    toggle: () => void;
    contains: () => boolean;
  };
  setAttribute: () => void;
  getAttribute: () => null;
  addEventListener: () => void;
  removeEventListener: () => void;
  focus: () => void;
  blur: () => void;
  click: () => void;
  scrollIntoView: () => void;
  querySelector: () => null;
  querySelectorAll: () => never[];
  closest: () => null;
  getBoundingClientRect: () => DOMRect;
  offsetHeight: number;
  offsetWidth: number;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

// ==========================================
// SWIPE MANAGER TYPES
// ==========================================

export interface TouchHandlers {
  touchstart: (e: TouchEvent) => void;
  touchmove: (e: TouchEvent) => void;
  touchend: (e: TouchEvent) => void;
}

export interface SwipeConfig {
  threshold: number;
  maxSwipe: number;
  resistance: number;
}

export interface SwipeCallbacks {
  onSwipeLeft?: (element: HTMLElement) => void;
  onSwipeRight?: (element: HTMLElement) => void;
}

// ==========================================
// UI TIMING TYPES
// ==========================================

export interface TimingConfig {
  toastDuration: number;
  toastFadeIn: number;
  toastFadeOut: number;
  undoToastDuration: number;
  modalFadeIn: number;
  modalFadeOut: number;
}

// ==========================================
// EMPTY STATE TYPES
// ==========================================

export interface EmptyStateAction {
  id: string;
  label: string;
}

// ==========================================
// PHASE E: FEATURE MODULE TYPES
// ==========================================

// Rollover types
export interface RolloverSummary {
  positive: number;
  negative: number;
  net: number;
  count: number;
}

export type RolloverMode = 'all' | 'selected';
export type NegativeHandling = 'zero' | 'carry' | 'ignore';

// Filter types
export interface DatePresetRange {
  start: string;
  end: string;
}

export type DatePreset = 'today' | 'yesterday' | 'this-week' | 'last-week' | 'this-month' | 'last-month' | 'this-year' | 'last-year';

// Dashboard types
export interface BudgetGaugeData {
  spent: number;
  budget: number;
  percentage: number;
  status: 'under' | 'warning' | 'over';
}

export interface EnvelopeData {
  category: string;
  categoryName: string;
  emoji: string;
  allocated: number;
  spent: number;
  remaining: number;
  percentage: number;
  rollover: number;
}

// Calendar types
export interface CalendarDay {
  date: string;
  day: number;
  transactions: Transaction[];
  isCurrentMonth: boolean;
  isToday: boolean;
  total: number;
}

export interface UpcomingBill {
  description: string;
  amount: number;
  dueDate: string;
  category: string;
  categoryEmoji: string;
}

// Debt types
export interface DebtPayoffPlan {
  method: 'avalanche' | 'snowball';
  debts: DebtPayoffItem[];
  totalInterest: number;
  payoffDate: string;
  monthsToPayoff: number;
}

export interface DebtPayoffItem extends Debt {
  payoffOrder: number;
  monthsToPayoff: number;
  totalInterest: number;
  payoffDate: string;
}

// Transactions rendering
export interface TransactionRenderOptions {
  resetPage?: boolean;
  preserveScroll?: boolean;
}

// Savings goal forecast
export interface GoalForecast {
  goalId: string;
  currentAmount: number;
  targetAmount: number;
  monthlyContribution: number;
  monthsToGoal: number;
  projectedDate: string | null;
  onTrack: boolean;
}

// ==========================================
// PHASE F: ANALYTICS & INSIGHTS TYPES
// ==========================================

// Chart handler types for event listener cleanup
export interface ChartHandlerRecord {
  element: HTMLElement | SVGElement;
  type: string;
  handler: EventListener;
}

export interface ChartElementWithHandlers extends HTMLElement {
  _chartHandler?: EventListener | null;
  _chartMoveHandler?: EventListener | null;
  _chartLeaveHandler?: EventListener | null;
  _chartClickHandler?: EventListener | null;
  _barChartHandlers?: ChartHandlerRecord[] | null;
  _trendChartHandlers?: ChartHandlerRecord[] | null;
  _weeklyRollupHandlers?: ChartHandlerRecord[] | null;
}

// Analytics - Seasonal patterns
export interface SeasonalMonthData {
  yearMonth: string;
  total: number;
}

export interface SeasonalPattern {
  month: number;
  monthLabel: string;
  monthShort: string;
  average: number;
  min: number;
  max: number;
  dataPoints: number;
  variance: number;
  deviationPct: number;
}

export interface SeasonalInsight {
  type: 'high' | 'low';
  month: string;
  message: string;
}

export interface SeasonalPatternData {
  patterns: SeasonalPattern[];
  yearlyAverage: number;
  highSpendingMonths: SeasonalPattern[];
  lowSpendingMonths: SeasonalPattern[];
  insights: SeasonalInsight[];
}

// Analytics - Category trends
export interface CategoryMonthData {
  month: string;
  amount: number;
}

export interface CategoryTrendData extends CategoryChild {
  monthlyData: CategoryMonthData[];
  rollingAvg: number[];
  totalSpend: number;
  avgMonthly: number;
  trendPct: number;
  trendDirection: 'growing' | 'shrinking' | 'stable';
}

export interface CategoryTrendsResult {
  months: string[];
  categories: Record<string, CategoryTrendData>;
  sorted: CategoryTrendData[];
}

export interface TrendingCategoriesResult {
  growing: CategoryTrendData[];
  shrinking: CategoryTrendData[];
  stable: CategoryTrendData[];
}

export interface CategoryTrendChange {
  change: number;
  direction: 'up' | 'down' | 'flat' | 'new';
}

// Chart renderers - Callback types
export type CurrencyFormatter = (value: number) => string;
export type ShortCurrencyFormatter = (value: number) => string;
export type MonthLabelFormatter = (monthKey: string) => string;
export type VelocityCalculator = () => VelocityData;

export interface ChartRendererCallbacks {
  fmtCur?: CurrencyFormatter;
  monthLabel?: MonthLabelFormatter;
  calcVelocity?: VelocityCalculator;
}

export interface WeeklyRollupCallbacks {
  fmtCur?: CurrencyFormatter;
  fmtShort?: ShortCurrencyFormatter;
  switchMainTab?: (tab: MainTab) => void;
  renderTransactions?: () => void;
}

// Chart data types
export interface DonutChartData {
  label: string;
  value: number;
  color: string;
  catId?: string;
}

export interface BarChartDataset {
  label: string;
  data: number[];
  color: string;
}

// Weekly rollup types
export interface WeekData {
  start: number;
  end: number;
  total: number;
  txCount: number;
  categories: Record<string, number>;
  topCategories?: { cat: string; amt: number }[];
}

// Insights types
export type InsightPersonalityType = 'roast' | 'friendly' | 'serious' | 'casual' | 'motivating';

export interface InsightContext {
  income: number;
  expenses: number;
  balance: number;
}

export interface InsightAction {
  type: string;
  category?: string;
  label: string;
}

export interface InsightResultWithAction {
  text: string;
  action?: InsightAction;
}

export type InsightResult = string | InsightResultWithAction | null;

export interface InsightGenerator {
  slot: number;
  fn: (personality: InsightPersonalityType, context: InsightContext) => InsightResult;
  priority: number;
}

export interface InsightActionData {
  actionType: string;
  data: unknown;
}

// ==========================================
// GAMIFICATION TYPES
// ==========================================

// Achievement definition
export interface AchievementDefinition {
  id: string;
  name: string;
  emoji: string;
  desc: string;
}

// Earned achievement record
export interface EarnedAchievement {
  earned: boolean;
  date: string;
}

// Celebration configuration
export interface CelebrationConfig {
  celebrationDuration: number;
  confettiRemoval: number;
  confettiCount: number;
  confettiDurationBase: number;
}

// ==========================================
// SECURITY TYPES
// ==========================================

// Encrypted PIN bundle components
export interface EncryptedBundle {
  encryptedData: string;
  salt: string;
  iv: string;
}

// Stored PIN bundle (version 2 with recovery)
export interface PinBundle extends EncryptedBundle {
  hash: string;
  version: number;
}

// Result of creating PIN with recovery
export interface PinCreationResult {
  bundle: string;
  recoveryPhrase: string;
  pinHash: string;
}

// ==========================================
// WEB WORKER TYPES
// ==========================================

// Worker message types
export type WorkerMessageType = 'filter' | 'aggregate' | 'search';

// Sort options for worker
export type WorkerSortField = 'date' | 'amount' | 'description' | 'category';
export type WorkerSortDirection = 'asc' | 'desc';

// Category map entry for worker
export interface WorkerCategoryMapEntry {
  name: string;
  children?: string[];
}

// Extended filters with worker-specific fields
export interface WorkerTransactionFilters extends TransactionFilters {
  childCatIds?: string[] | null;
  categoryMap?: Record<string, WorkerCategoryMapEntry>;
  tagsFilter?: string;
}

// Filter payload
export interface WorkerFilterPayload {
  transactions: Transaction[];
  filters: WorkerTransactionFilters;
  sortBy?: WorkerSortField;
  sortDir?: WorkerSortDirection;
  page?: number;
  pageSize?: number;
}

// Aggregate payload
export interface WorkerAggregatePayload {
  transactions: Transaction[];
  filters: WorkerTransactionFilters;
}

// Search payload
export interface WorkerSearchPayload {
  transactions: Transaction[];
  query: string;
  limit?: number;
}

// Union type for all payloads
export type WorkerPayload = WorkerFilterPayload | WorkerAggregatePayload | WorkerSearchPayload;

// Worker message structure
export interface WorkerMessage {
  type: WorkerMessageType;
  payload: WorkerPayload;
  requestId: string;
}

// Aggregation result
export interface WorkerAggregations {
  totalIncome: number;
  totalExpenses: number;
  balance: number;
  incomeCount: number;
  expenseCount: number;
  totalCount: number;
  categoryTotals: Record<string, number>;
}

// Paginated result
export interface WorkerPaginatedResult<T> {
  items: T[];
  totalPages: number;
  currentPage: number;
  totalItems: number;
  hasMore: boolean;
}

// Filter result (paginated + aggregations)
export interface WorkerFilterResult extends WorkerPaginatedResult<Transaction> {
  aggregations: WorkerAggregations;
}

// Worker response
export interface WorkerResponse<T = unknown> {
  requestId: string;
  success: boolean;
  result?: T;
  error?: string;
}
