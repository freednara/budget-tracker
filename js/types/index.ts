/**
 * Type Definitions for Budget Tracker Elite
 *
 * Central type definitions for the application.
 * Import types from here to ensure consistency across modules.
 *
 * @module types
 */

// Re-exported so consumers that already import from the types barrel can pick
// up `BaselineDelta` alongside the analytics types that reference it.
// Design-Review-Apr21 batch 7 (7a): the shared baseline contract lives in
// `core/baseline.ts` as a runtime module — this is a pure type-only import
// and contributes no runtime edge to the dependency graph.
import type { BaselineDelta } from '../modules/core/baseline.js';
export type { BaselineDelta, BaselineStatus } from '../modules/core/baseline.js';

// ==========================================
// CORE TRANSACTION TYPE
// ==========================================

/** A financial transaction (expense or income) stored in the ledger. */
export interface Transaction {
  /** Unique identifier generated on save (format: `tx_<ulid>`). */
  __backendId: string;
  /** Whether this is money going out or coming in. */
  type: 'expense' | 'income';
  /** Amount in the user's home currency (dollars, not cents). */
  amount: number;
  /** User-entered description / merchant name. */
  description: string;
  /** Transaction date in `YYYY-MM-DD` format. */
  date: string;
  /** Category identifier — references a built-in or user-defined category. */
  category: string;
  /** Comma-separated tags for filtering. */
  tags?: string;
  /** Free-form notes attached to the transaction. */
  notes?: string;
  /** ISO 4217 currency code (e.g., `USD`, `EUR`). */
  currency: string;
  /** Whether this transaction repeats on a schedule. */
  recurring: boolean;
  /** Recurrence interval — only meaningful when `recurring` is true. */
  recurring_type?: 'daily' | 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'yearly';
  /** End date for recurrence in `YYYY-MM-DD` format. Empty means indefinite. */
  recurring_end?: string;
  /** Whether the user has verified this transaction against a bank statement. */
  reconciled?: boolean;
  /** True if this transaction was created by splitting another transaction. */
  splits?: boolean;
  /** If split, the `__backendId` of the original parent transaction. */
  parentTxId?: string;
  /** If this is a debt payment, the ID of the associated `Debt`. */
  debtId?: string;
  /**
   * If this transaction was materialized from a recurring template, the
   * `id` of that template. Used as a backlink so the recurring-templates
   * module can find and delete generated transactions when its parent
   * template is removed.
   *
   * Fixes C1 (Inline-Behavior-Review rev 12): previously both read and
   * write sites relied on `as any` casts, defeating the typechecker and
   * letting a typo silently orphan generated transactions.
   */
  recurringTemplateId?: string;
}

/** Whether a transaction represents money going out (`expense`) or coming in (`income`). */
export type TransactionType = 'expense' | 'income';

// ==========================================
// DEBT TRACKING
// ==========================================

/** Supported debt categories, each with distinct payoff strategies and UI treatment. */
export type DebtType = 'credit_card' | 'student_loan' | 'mortgage' | 'auto' | 'personal' | 'medical' | 'other';

/** Display metadata for a debt type (label and emoji icon). */
export interface DebtTypeInfo {
  label: string;
  emoji: string;
}

/** A single payment made toward a debt, linked to a ledger transaction. */
export interface DebtPayment {
  id: string;
  /** Payment date in `YYYY-MM-DD` format. */
  date: string;
  /** Total payment amount (principal + interest). */
  amount: number;
  /** Portion applied to the principal balance. */
  principal: number;
  /** Portion applied to accrued interest. */
  interest: number;
  /** `__backendId` of the corresponding ledger transaction. */
  transactionId: string;
  description?: string;
}

/** A tracked debt account with balance, interest rate, and payment history. */
export interface Debt {
  id: string;
  /** User-friendly name (e.g., "Chase Visa", "Student Loan"). */
  name: string;
  type: DebtType;
  /** Current outstanding balance in dollars. */
  balance: number;
  /** Balance when the debt was first added. */
  originalBalance: number;
  /** Annual Percentage Rate as a decimal (e.g., `0.1999` for 19.99%). */
  interestRate: number;
  /** Required monthly minimum payment in dollars. */
  minimumPayment: number;
  /** Day of month the payment is due (1–31). */
  dueDay: number;
  /** ISO date string when the debt was added to the tracker. */
  createdAt: string;
  /** Chronological payment history. */
  payments: DebtPayment[];
  /** False if the debt is paid off or archived. */
  isActive: boolean;
  /**
   * CR-Apr22-G slice 4: rename history, most-recent-first. Populated by
   * `updateDebt` whenever the debt's name actually changes. Enables the
   * transaction-detail panel's debt drill-down to keep linked legacy rows
   * (whose descriptions encode the older name verbatim, e.g. "Chase Visa
   * payment") attached after a rename. Optional — goals that have never
   * been renamed carry no entry.
   */
  historicalNames?: string[];
  /**
   * CR-Apr24-A2 [P2] finding 24: ISO date of the last interest accrual
   * (equivalent to "date of last recorded payment that charged interest").
   * Used by `DebtPaymentOperation.execute()` to prorate the interest
   * portion of a new payment by the number of days elapsed since the
   * previous accrual, instead of charging a full month's interest on
   * every entry. Missing (pre-migration) → the payment path falls back
   * to `createdAt` so existing debts don't get over-charged on their
   * first post-upgrade payment.
   */
  lastInterestAccrualDate?: string;
}

/** Projected payoff timeline for a single debt at current payment rate. */
export interface PayoffInfo {
  /** Estimated months until payoff. */
  months: number;
  /** Projected payoff date, or `null` if unpayable at current rate. */
  date: Date | null;
  /** Total interest paid over the payoff period. */
  totalInterest: number;
  /** True when minimum payment doesn't cover monthly interest accrual. */
  cannotPayOff?: boolean;
}

/** One row of a debt amortization schedule (month-by-month breakdown). */
export interface AmortizationEntry {
  month: number;
  payment: number;
  principal: number;
  interest: number;
  /** Remaining balance after this month's payment. */
  balance: number;
}

/** Position of a single debt within a payoff strategy's ordered timeline. */
export interface DebtPayoffOrder {
  /** Unique debt identifier. */
  id: string;
  /** Display name of the debt. */
  name: string;
  /** Month number (1-based) when this debt is projected to be fully paid off. */
  month: number;
}

/** One month's row in the aggregate debt-payoff schedule. */
export interface PayoffScheduleEntry {
  /** Month number (1-based) in the payoff timeline. */
  month: number;
  /** Combined remaining balance across all debts after this month. */
  totalBalance: number;
  /** Total interest accrued across all debts this month. */
  interest: number;
  /** Extra dollars available after minimum payments are met. */
  availableExtra?: number;
  /** Dollars freed this month from a debt that was just paid off. */
  releasedThisMonth?: number;
}

/** Full result of running a debt-payoff strategy (avalanche or snowball). */
export interface PayoffStrategyResult {
  /** Total months to pay off all debts. */
  months: number;
  /** Total interest paid over the entire payoff period. */
  totalInterest: number;
  /** Ordered list of debts by their projected payoff month. */
  order: DebtPayoffOrder[];
  /** Month-by-month aggregate schedule rows. */
  schedule: PayoffScheduleEntry[];
  /** Total dollars released from paid-off debts and redirected. */
  totalReleased?: number;
  /** Factor by which payments accelerate as debts are eliminated. */
  paymentAcceleration?: number;
  /** True when the strategy cannot fully pay off all debts. */
  cannotPayOff?: boolean;
}

/** Side-by-side comparison of snowball vs. avalanche payoff strategies. */
export interface StrategyComparison {
  /** Results for the snowball (lowest-balance-first) strategy. */
  snowball: PayoffStrategyResult;
  /** Results for the avalanche (highest-rate-first) strategy. */
  avalanche: PayoffStrategyResult;
  /** Dollars saved by choosing avalanche over snowball. */
  interestSaved: number;
  /** Month difference (positive = snowball takes longer). */
  timeDiff: number;
  /** Which strategy is recommended for this debt profile. */
  recommended: 'avalanche' | 'snowball';
  /**
   * CR-Apr24-A3 [P2] finding 30: true when BOTH strategies hit negative
   * amortization and neither can ever pay the debts off. When this is
   * true, `recommended` is meaningless — UI must show an explicit
   * failure state and stop quoting numerical payoff metrics as if they
   * described a valid plan.
   */
  cannotPayOff?: boolean;
  /** Optional rollover-aware acceleration metrics. */
  rolloverImpact?: {
    snowballAcceleration: number;
    avalancheAcceleration: number;
    accelerationDifference: number;
  };
}

/** Progress snapshot for a single debt. */
export interface DebtProgress {
  /** Original balance when the debt was created. */
  original: number;
  /** Current outstanding balance. */
  current: number;
  /** Total dollars paid toward this debt so far. */
  paid: number;
  /** Percentage of the original balance that has been paid (0–100). */
  percentComplete: number;
  /** Number of payments recorded. */
  paymentsCount: number;
  /** Most recent payment, or `null` if none. */
  lastPayment: DebtPayment | null;
}

/** Aggregate summary across all active debts. */
export interface TotalDebtSummary {
  /** Combined current balance of all debts. */
  totalBalance: number;
  /** Combined original balance of all debts. */
  totalOriginal: number;
  /** Combined total paid across all debts. */
  totalPaid: number;
  /** Overall payoff percentage (0–100). */
  percentComplete: number;
  /** Number of active debts. */
  debtCount: number;
  /** Sum of all minimum monthly payments. */
  monthlyMinimum: number;
  /** Weighted average APR across all debts. */
  avgInterestRate: number;
}

/** Result of recording a debt payment. */
export interface PaymentResult {
  /** Whether the payment was recorded successfully. */
  isOk: boolean;
  /** Human-readable error message on failure. */
  error?: string;
  /** Updated debt after the payment. */
  debt?: Debt;
  /** The payment record that was created. */
  payment?: DebtPayment;
  /** Linked ledger transaction, if one was auto-created. */
  transaction?: Transaction;
}

// ==========================================
// SAVINGS GOALS
// ==========================================

/** A savings goal the user is working toward. */
export interface SavingsGoal {
  id: string;
  /** User-friendly goal name (e.g., "Emergency Fund", "Vacation"). */
  name: string;
  /** Target amount in dollars. */
  target: number;
  /** Amount saved so far in dollars. */
  saved: number;
  /** Optional target date in `YYYY-MM-DD` format. */
  deadline?: string;
  /** Optional emoji icon for display. */
  icon?: string;
  /**
   * Creation date in `YYYY-MM-DD` format (local wall-clock).
   *
   * CR-Apr22-G slice 3: anchors the synthetic "starting balance" row in
   * the transaction-detail drill-down when no real contributions exist
   * yet. Previously defaulted to today, which misrepresented long-dormant
   * seeded goals as "just created." Optional for backward compatibility
   * with legacy records — callers fall back to `getTodayStr()` when absent.
   */
  createdAt?: string;
  /**
   * Historical names this goal has carried, in order of change
   * (most-recent-first). Used by the transaction-detail-panel's
   * description-fallback linker so renaming a goal doesn't sever the
   * link to pre-`[id:goalId]`-marker legacy contribution rows whose
   * description still reads `Savings Transfer: <old name>`.
   *
   * CR-Apr22-G slice 3: new goals start with `[]`. When a rename action
   * (`data-actions.savingsGoals.renameGoal`) is invoked, the prior name
   * is unshifted onto this array before `name` is overwritten.
   */
  historicalNames?: string[];
}

/** A contribution (deposit) toward a savings goal. */
export interface SavingsContribution {
  id: string;
  /** The `SavingsGoal.id` this contribution applies to. */
  goalId: string;
  /** Contribution amount in dollars. */
  amount: number;
  /** User-chosen date of contribution in `YYYY-MM-DD` format. Drives where the linked transaction lands in the ledger. */
  date: string;
  /**
   * ISO timestamp of when the contribution was actually recorded (wall-clock at time of entry).
   * Used for savings-velocity/forecast calculations so backdated contributions don't distort the rate.
   * Optional for backward compatibility with legacy records; callers should fall back to `date` when absent.
   */
  createdAt?: string | undefined;
  note?: string | undefined;
  /** If linked to a ledger transaction, its `__backendId`. */
  // Phase 6 Slice 1j (rev 12 L6): widened for `exactOptionalPropertyTypes`
  // — data-actions.ts:328 passes `txResult.data?.__backendId` directly.
  transactionId?: string | undefined;
}

/** Forecast for a savings goal that is already fully funded. */
export interface GoalForecastComplete {
  completed: true;
}

/** Forecast for a savings goal still in progress. */
export interface GoalForecastInProgress {
  completed: false;
  /** Estimated date the goal will be fully funded. */
  projectedDate: Date;
  /** Estimated days remaining to reach the target. */
  daysToComplete: number;
  /** Average dollars saved per day based on contribution history. */
  dailyRate: number;
  /** `true` if on track to meet deadline, `false` if behind, `null` if no deadline set. */
  onTrack: boolean | null;
}

/** Discriminated union: either a completed goal or an in-progress forecast. */
export type GoalForecast = GoalForecastComplete | GoalForecastInProgress;

// ==========================================
// BUDGET ALLOCATION
// ==========================================

/** Budget allocations for a single month, keyed by category ID → amount in cents. */
export interface MonthlyAllocation {
  [categoryId: string]: number;
}

// ==========================================
// CURRENCY SETTINGS
// ==========================================

/** User's currency preferences. */
export interface CurrencySettings {
  /** ISO 4217 code (e.g., `USD`). */
  home: string;
  /** Display symbol (e.g., `$`). */
  symbol: string;
}

// ==========================================
// STREAK TRACKING
// ==========================================

/** Tracks consecutive-day usage streaks for gamification. */
export interface StreakData {
  /** Current active streak in days. */
  current: number;
  /** All-time longest streak in days. */
  longest: number;
  /** Last activity date in `YYYY-MM-DD` format. */
  lastDate: string;
}

// ==========================================
// ALERT PREFERENCES
// ==========================================

/** User preferences for budget alerts and notifications. */
export interface AlertPrefs {
  /** Percentage threshold (0–100) at which a budget alert fires, or `null` to disable. */
  budgetThreshold: number | null;
  /** Whether browser push notifications are enabled. */
  browserNotificationsEnabled: boolean;
  /** Alert keys already shown so the same alert isn't repeated. */
  lastNotifiedAlertKeys: string[];
}

// ==========================================
// ROLLOVER SETTINGS
// ==========================================

/** Configuration for rolling unspent budget into the next month. */
export interface RolloverSettings {
  /** Master toggle for the rollover feature. */
  enabled: boolean;
  /** `'all'` rolls over every category; `'selected'` limits to the categories list. */
  mode: 'all' | 'selected';
  /** Category IDs eligible for rollover when mode is `'selected'`. */
  categories: string[];
  /** Cap on rollover dollars per category, or `null` for unlimited. */
  maxRollover: number | null;
  /** How to handle categories that went over budget: zero out, carry the deficit, or ignore. */
  negativeHandling: 'zero' | 'carry' | 'ignore';
}

// ==========================================
// PAGINATION STATE
// ==========================================

/** Current pagination position for the transaction list. */
export interface PaginationState {
  /** Current page number (1-based). */
  page: number;
  /** Total number of pages available. */
  totalPages: number;
  /** Total number of items across all pages. */
  totalItems: number;
}

// ==========================================
// CUSTOM CATEGORY
// ==========================================

/** A user-defined transaction category beyond the built-in set. */
export interface CustomCategory {
  /** Unique category identifier (UUID). */
  id: string;
  /** Display name chosen by the user. */
  name: string;
  /** Emoji used as the category icon. */
  emoji: string;
  /** Hex colour code for category accent (e.g., `#ff5733`). */
  color: string;
  /** Whether this category applies to expenses or income. */
  type: 'expense' | 'income';
}

// ==========================================
// FILTER PRESET
// ==========================================

/**
 * Shape of filter values persisted inside a `FilterPreset`. Mirrors
 * `signals.FilterState` (core/signals.ts) — we cannot import signals into
 * `types/index.ts` without creating a module cycle, so the fields are
 * duplicated here. If you change `FilterState`, mirror the change below.
 *
 * Phase 6 (Apr 2026): the previous `LegacyFilterState` shape (pre-v2 field
 * names like `search`/`from`/`to`/`minAmt`/`unreconciled`) was never
 * actually written by the runtime — `saveFilterPreset` always wrote the
 * current `FilterState` shape and cast it away with `as any`. The legacy
 * type was aspirational backwards-compat typing, not real migration code.
 * Renamed to `PersistedFilterState` and aligned with reality so the cast
 * can be dropped.
 */
export interface PersistedFilterState {
  searchText: string;
  type: TransactionType | 'all';
  category: string;
  tags: string;
  dateFrom: string;
  dateTo: string;
  minAmount: string;
  maxAmount: string;
  reconciled: 'all' | 'yes' | 'no';
  recurring: boolean;
  showAllMonths: boolean;
  sortBy: string;
}

/** A saved, reusable set of transaction filters. */
export interface FilterPreset {
  /** Unique preset identifier (UUID). */
  id: string;
  /** User-chosen name for this preset. */
  name: string;
  /** The saved filter values. */
  filters: PersistedFilterState;
}

// ==========================================
// TRANSACTION TEMPLATE
// ==========================================

/** A reusable transaction template for quick entry of common transactions. */
// Phase 6 Slice 1j (rev 12 L6): optional fields widened for
// `exactOptionalPropertyTypes` — `template-manager.ts` constructs TxTemplate
// objects from form inputs where each optional field is already typed
// `T | undefined` (e.g., `amount: parseOptionalNumber(...)`).
export interface TxTemplate {
  /** Unique template identifier (UUID). */
  id: string;
  /** Display name for the template (e.g., "Morning Coffee"). */
  name: string;
  /** Whether this template creates an expense or income entry. */
  type: 'expense' | 'income';
  /** Category ID to assign when the template is used. */
  category: string;
  /** Pre-filled amount in dollars, or `undefined` to prompt the user. */
  amount?: number | undefined;
  /** Pre-filled description text. */
  description?: string | undefined;
  /** Comma-separated tag string. */
  tags?: string | undefined;
  /** Whether transactions from this template are recurring. */
  recurring?: boolean | undefined;
  /** Recurrence interval when `recurring` is true. */
  recurringType?: 'daily' | 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'yearly' | undefined;
  /** ISO date string after which recurrence stops. */
  recurringEnd?: string | undefined;
  /** Optional merchant name for future use. */
  merchant?: string | undefined;
  /** Optional location for future use. */
  location?: string | undefined;
  /** Optional freeform notes for future use. */
  notes?: string | undefined;
}

// ==========================================
// SECTIONS CONFIG
// ==========================================

/** Toggles for optional UI sections the user can show or hide. */
export interface SectionsConfig {
  /** Show the envelope-budgeting section on the budget tab. */
  envelope: boolean;
  /** Show the transaction-templates quick-entry panel. */
  transactionsTemplates: boolean;
}

// ==========================================
// INSIGHT PERSONALITY
// ==========================================

/** Tone used by the AI spending-insight generator. */
export type InsightPersonality = 'serious' | 'friendly' | 'roast' | 'casual' | 'motivating';

// ==========================================
// MAIN TAB
// ==========================================

/** Top-level navigation tabs in the app shell. */
export type MainTab = 'dashboard' | 'transactions' | 'budget' | 'calendar';

// ==========================================
// FULL APPLICATION STATE
// ==========================================

/**
 * Complete snapshot of the application state.
 *
 * Composed of three sections: persisted **data**, persisted **settings**,
 * and ephemeral **navigation / UI state**.
 */
export interface AppState {
  // ── Data ──────────────────────────────────────────
  transactions: Transaction[];
  savingsGoals: Record<string, SavingsGoal>;
  savingsContribs: SavingsContribution[];
  /** Keyed by `YYYY-MM` month string. */
  monthlyAlloc: Record<string, MonthlyAllocation>;
  achievements: Record<string, unknown>;
  streak: StreakData;
  customCats: CustomCategory[];
  debts: Debt[];

  // ── Settings ─────────────────────────────────────
  currency: CurrencySettings;
  sections: SectionsConfig;
  /** PBKDF2-hashed PIN for app lock, or empty string when unset. */
  pin: string;
  insightPers: InsightPersonality;
  alerts: AlertPrefs;
  rolloverSettings: RolloverSettings;
  filterPresets: FilterPreset[];
  txTemplates: TxTemplate[];

  // ── Navigation / UI State ────────────────────────
  /** Currently viewed month in `YYYY-MM` format. */
  currentMonth: string;
  currentType: TransactionType;
  currentTab: TransactionType;
  selectedCategory: string;
  /** `__backendId` of the transaction being edited, or `null`. */
  editingId: string | null;
  /** `__backendId` of the transaction queued for deletion confirmation, or `null`. */
  deleteTargetId: string | null;
  /** Savings goal ID for the "add contribution" modal, or `null`. */
  addSavingsGoalId: string | null;
  /** Transaction ID for the split-transaction modal, or `null`. */
  splitTxId: string | null;
  /** Transaction snapshot loaded into the edit form, or `null`. */
  pendingEditTx: Transaction | null;
  /** True when editing the entire recurring series rather than a single occurrence. */
  editSeriesMode: boolean;
  activeMainTab: MainTab;
  pagination: PaginationState;
}

// ==========================================
// STORAGE KEYS
// ==========================================

/** localStorage key map — each property holds the string key used in `localStorage.getItem()`. */
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
  BUDGET_PLANS: string;
  ATTACHMENTS: string;
  USER_SETTINGS: string;
  SYNC_STATE: string;
  RECURRING: string;
  APP_STATS: string;
  HAS_ONBOARDED: string;
  USER_CATS: string;
}

// ==========================================
// EVENT BUS TYPES
// ==========================================

/** Listener callback signature for the event bus. */
export type EventCallback = (payload?: unknown) => void;

/** Handle returned by `on()` — call `unsubscribe()` to remove the listener. */
export interface EventBusSubscription {
  unsubscribe: () => void;
}

// ==========================================
// STORAGE ADAPTER TYPES
// ==========================================

/** Generic result wrapper returned by storage adapter operations. */
export interface StorageResult {
  /** Whether the operation succeeded. */
  isOk: boolean;
  /** Human-readable error message on failure. */
  error?: string;
  /** Payload returned by the operation (type depends on the call). */
  data?: unknown;
}

/** IndexedDB object-store name constants. */
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

/** Union of all valid IndexedDB object-store name strings. */
export type StoreName = typeof STORES[keyof typeof STORES];

/** Key constants for values stored inside the `SETTINGS` object store. */
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
  // New-batch P3: `lastBackupTxCount` is persisted alongside
  // `lastBackup` inside the backup-reminder settings blob
  // (see `auto-backup.ts:297,578-579` and `import-export.ts:1623`).
  // It was missing from this enum, which left backup round-trip
  // consumers using an untyped string literal and made the key set
  // diverge from the actual persisted shape.
  LAST_BACKUP_TX_COUNT: 'lastBackupTxCount',
  FILTER_EXPANDED: 'filterExpanded'
} as const;

/** Union of all valid settings key strings. */
export type SettingKey = typeof SETTINGS_KEYS[keyof typeof SETTINGS_KEYS];

/** Which persistence backend is in use. */
export type StorageType = 'indexeddb' | 'localstorage';

/** Abstract storage backend — implemented by IndexedDB and localStorage adapters. */
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

/** BroadcastChannel message sent between tabs to synchronise storage changes. */
export interface SyncMessage {
  /** Kind of storage mutation that occurred. */
  type: 'create' | 'update' | 'delete' | 'batch' | 'clear';
  /** Which object store was affected, or `'all'` for a full wipe/import. */
  store: StoreName | 'all';
  /** Mutation payload (shape varies by `type`). */
  data?: unknown;
  /** Unix-ms timestamp when the mutation occurred. */
  timestamp: number;
  /** Unique identifier of the tab that originated the change. */
  tabId: string;
}

/**
 * Describes a single mutation to the transaction ledger (used by the surface
 * coordinator).
 *
 * Phase 6 Slice 1j (rev 12 L6): each optional field is declared `T | undefined`
 * so callers can assign the result of an indexed access (`string | undefined`)
 * or a `.find(...)` miss (`Transaction | undefined`) directly under
 * `exactOptionalPropertyTypes`.
 */
export interface TransactionDataChange {
  type: 'add' | 'update' | 'delete' | 'batch-add' | 'batch-delete' | 'split';
  /** The transaction that was added or updated. */
  item?: Transaction | undefined;
  /** Previous version of the transaction before an update. */
  previousItem?: Transaction | undefined;
  /** Batch of transactions (for batch-add / split). */
  items?: Transaction[] | undefined;
  /** `__backendId` of the affected transaction (for single operations). */
  id?: string | undefined;
  /** Array of `__backendId`s (for batch-delete). */
  ids?: string[] | undefined;
}

/** Callback interface for modules that react to transaction data changes. */
export interface DataHandler {
  onDataChanged(transactions: Transaction[]): void;
  onDataPatched?(change: TransactionDataChange, transactions: Transaction[]): void;
}

/** Generic result wrapper with optional typed data and field-level errors. */
export interface OperationResult<T = unknown> {
  isOk: boolean;
  error?: string;
  data?: T;
  errors?: Record<string, string>;
  /**
   * For create operations only: `true` when an idempotency guard short-
   * circuited the mutation because a record with this `__backendId` was
   * already persisted. Callers (notably `CreateTransactionOperation.rollback`)
   * need this signal so they do NOT delete a pre-existing row that was
   * never actually created by the in-flight operation.
   *
   * Absent / `false` = the row was freshly persisted by this call and is
   * safe to roll back by deletion. See new-batch P2: "Transaction-create
   * rollback can delete a pre-existing row" (data-manager.ts:601 / 656,
   * transaction-operations.ts:28 / 143).
   */
  alreadyExisted?: boolean;
}

// ==========================================
// MIGRATION TYPES
// ==========================================

/** Persisted record of whether a data migration has been applied. */
export interface MigrationStatus {
  /** True once the migration ran successfully. */
  completed: boolean;
  /** Unix-ms timestamp when the migration finished. */
  timestamp?: number;
  /** Schema version this migration targets. */
  version?: string;
  /** Number of records processed. */
  itemCount?: number;
}

/** Real-time progress of an in-flight data migration. */
export interface MigrationProgress {
  /** Current phase of the migration pipeline. */
  phase: 'reading' | 'migrating' | 'verifying' | 'complete' | 'error';
  /** Overall progress as a fraction (0–1). */
  progress: number;
  /** Index of the record currently being processed. */
  current?: number;
  /** Total records to process. */
  total?: number;
  /** Error message if `phase` is `'error'`. */
  error?: string;
}

/** Callback invoked periodically during a migration to report progress. */
export type MigrationProgressCallback = (progress: MigrationProgress) => void;

// ==========================================
// VIRTUAL SCROLLER TYPES — REMOVED
// ==========================================
//
// Phase 5g-3 Slice 5 (Inline-Behavior-Review rev 12, L57/L58/L59): the
// `VirtualScrollerOptions` / `RowRenderer<T>` / `RowRecycler` types were
// deleted alongside the `VirtualScroller` class and `createVirtualScroller`
// factory in `js/modules/ui/widgets/virtual-scroller.ts`.
//
// Direction reversal vs. the review's recommended L57/L58/L59 hardening
// (cancel scrollRAF on re-init / detach-before-attach swipe handlers /
// track top-visible-row identity instead of ratio): grep across
// `js/` + `tests/` + `e2e/` returned ZERO callers of `createVirtualScroller`,
// `new VirtualScroller`, `.setData(`, `.refresh()`, or the type symbols
// themselves. Three correctness fixes against an unimported class would
// have preserved ~700 LOC of DOM-recycling / row-pooling / swipe-integration
// machinery that nothing exercises.
//
// Same shape as Phase 5g-2 M31 (`SAFE_MOCK` / `getSafe<>`) and Phase 5g-3
// Slice 4 (`addRealtimeValidation` + `ValidationFieldType`): an unused API
// that advertises a contract is strictly worse than no API at all. A future
// caller who needs virtual scrolling should (a) audit the actual list-size
// problem first — transaction-renderer.ts currently renders with lit-html
// `map()` templates and has no observable perf issue — and (b) reach for
// a maintained library or a freshly-scoped implementation, not re-inherit
// this legacy shape.
//
// Incidental cleanup opportunity surfaced during verification:
// `js/modules/ui/templates/transaction-row-template.ts` still exports
// `createRowRenderer()` and `batchRenderTransactions()` (which consume
// `transactionRowSimple`) — grep-confirmed zero-caller, same family.
// Deferred to a follow-up slice to keep this slice's blast radius to the
// virtual-scroller surface proper.

// ==========================================
// CHART TYPES
// ==========================================

/** A single data point for pie / bar chart renderers. */
export interface ChartDataPoint {
  label: string;
  value: number;
  /** CSS colour string; auto-assigned from palette if omitted. */
  color?: string;
}

/** Parallel arrays of labels and numeric values for line/trend charts. */
export interface TrendData {
  labels: string[];
  values: number[];
}

// ==========================================
// CALCULATION RESULT TYPES
// ==========================================

/** Spending breakdown for a single category within a time period. */
export interface CategorySummary {
  categoryId: string;
  categoryName: string;
  /** Total amount spent or earned in this category. */
  total: number;
  /** Share of total spending/income (0–100). */
  percentage: number;
  /** Number of transactions in this category. */
  count: number;
}

/** Aggregate financial summary for a single month. */
export interface MonthSummary {
  income: number;
  expenses: number;
  /** Income minus expenses. */
  net: number;
  /** Per-category breakdowns. */
  categories: CategorySummary[];
}

// ==========================================
// FILTER TYPES
// ==========================================

/** Criteria for filtering the transaction list. All fields are optional; omitted fields are ignored. */
export interface TransactionFilters {
  /** Free-text search across description, notes, and tags. */
  search?: string;
  /** @deprecated Use `search` instead. */
  searchQuery?: string;
  /** Filter by transaction type, or `'all'` to include both. */
  type?: TransactionType | 'all';
  /** Category ID to match. */
  category?: string;
  /** Inclusive start date in `YYYY-MM-DD` format. */
  dateFrom?: string;
  /** Inclusive end date in `YYYY-MM-DD` format. */
  dateTo?: string;
  /** Minimum transaction amount. */
  minAmount?: number | string;
  /** Maximum transaction amount. */
  maxAmount?: number | string;
  /** Tag(s) to match — array or comma-separated string. */
  tags?: string[] | string;
  /** Reconciliation filter. */
  reconciled?: boolean | 'all' | 'yes' | 'no';
  /** Limit results to a single `YYYY-MM` month. */
  monthKey?: string;
  /** When true, ignore `monthKey` and show all months. */
  showAllMonths?: boolean;
  /** When true, only return recurring transactions. */
  recurringOnly?: boolean;
}

// ==========================================
// SWIPE MANAGER TYPES
// ==========================================

/** Internal tracking state for an in-progress touch swipe gesture. */
export interface SwipeState {
  startX: number;
  startY: number;
  currentX: number;
  isActive: boolean;
  direction: 'left' | 'right' | null;
}

/** Callbacks invoked when a swipe gesture completes. */
export interface SwipeCallbacks {
  onSwipeLeft?: (element: HTMLElement) => void;
  onSwipeRight?: (element: HTMLElement) => void;
}

// ==========================================
// UTILITY TYPES
// ==========================================

/** Recursively makes every property in `T` optional. */
export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

/** Widens `T` to also accept `null`. */
export type Nullable<T> = T | null;

// ==========================================
// VALIDATION TYPES
// ==========================================

/** Successful validation — carries the sanitized value. */
export interface ValidationSuccess<T> {
  valid: true;
  value: T;
}

/** Failed validation — carries an error message. */
export interface ValidationFailure {
  valid: false;
  error: string;
}

/** Discriminated union returned by field validators. */
export type ValidationResult<T> = ValidationSuccess<T> | ValidationFailure;

/** Text-input field names that share the same validation rule shape. */
export type TextFieldType = 'description' | 'notes' | 'tags';

// Phase 5g-3 Slice 4 (Inline-Behavior-Review rev 12, L53): deleted the
// `ValidationFieldType = 'amount' | 'date' | 'pin' | TextFieldType` union.
// Its sole consumer was `Validator.addRealtimeValidation(element, type)` in
// `js/modules/core/validator.ts`, which has been removed (grep-confirmed
// zero external callers; see validator.ts for the full rationale). The
// surviving per-field validators (`validateAmount`, `validateDate`,
// `validatePin`, `validateText`) accept their field inputs directly and
// don't need a union-typed discriminator.

/** Validation constraints for the amount field. */
export interface AmountRule {
  min: number;
  max: number;
  pattern: RegExp;
  /** Error message shown when validation fails. */
  message: string;
}

/** Validation constraints for a text input field. */
export interface TextRule {
  maxLength: number;
  pattern: RegExp;
  message: string;
}

/** Validation constraints for a date input field. */
export interface DateRule {
  /** Earliest allowed date in `YYYY-MM-DD` format. */
  min: string;
  /** Latest allowed date in `YYYY-MM-DD` format. */
  max: string;
  message: string;
}

/** Validation constraints for the PIN field. */
export interface PinRule {
  pattern: RegExp;
  message: string;
}

/** Complete map of per-field validation rules used by the form validator. */
export interface ValidationRules {
  amount: AmountRule;
  description: TextRule;
  notes: TextRule;
  tags: TextRule;
  date: DateRule;
  pin: PinRule;
}

/** Result of validating an entire transaction form submission. */
export interface TransactionValidationResult {
  valid: boolean;
  /** Field-name → error-message map (empty when valid). */
  errors: Record<string, string>;
  /** Sanitized field values safe for persistence. */
  sanitized: Partial<Transaction>;
}

/** Details about a single invalid row encountered during CSV/JSON import. */
export interface ImportValidationError {
  /** Zero-based index of the row in the import file. */
  index: number;
  /** Raw import record that failed validation. */
  item: unknown;
  errors: Record<string, string>;
}

/** Aggregate result of validating an import file. */
export interface ImportValidationResult {
  /** Transactions that passed validation and are ready to save. */
  valid: Transaction[];
  /** Raw records that failed validation. */
  invalid: unknown[];
  /** Per-row error details. */
  errors: ImportValidationError[];
}

// ==========================================
// CATEGORY TYPES
// ==========================================

/** Base shape shared by all category representations. */
export interface CategoryChild {
  id: string;
  name: string;
  emoji: string;
  /** Hex colour code (e.g., `#ff5733`). */
  color: string;
}

/** @deprecated Use CategoryChild directly — subcategories have been removed. */
export type CategoryDefinition = CategoryChild;

/** A category with its expense/income type resolved (used by category lookups). */
export interface FlattenedCategory extends CategoryChild {
  type?: TransactionType;
}

/**
 * User-owned category stored in localStorage.
 * Flat structure — no subcategories.
 */
export interface UserCategory extends CategoryChild {
  type: 'expense' | 'income';
  order: number;
  hidden?: boolean;
}

/**
 * Full user category configuration stored in localStorage
 */
export interface UserCategoryConfig {
  presetId: string;
  version: number;
  expense: UserCategory[];
  income: UserCategory[];
}

/** Map of group names to arrays of emoji characters for the emoji picker UI. */
export type EmojiPickerCategories = Record<string, string[]>;

// ==========================================
// CALCULATION TYPES
// ==========================================

/** Running totals for a set of transactions (typically one month). */
export interface Totals {
  income: number;
  expenses: number;
  /** Income minus expenses. */
  balance: number;
  /** Optional per-category totals keyed by category ID. */
  categoryTotals?: Record<string, number>;
}

/** Spending velocity metrics for the current month. */
export interface VelocityData {
  /** Average dollars spent per day so far. */
  dailyRate: number;
  /** Projected total spending if current rate continues. */
  projected: number;
  /** Actual spending to date. */
  actual: number;
}

/** Traffic-light status for the daily allowance widget. */
export type DailyAllowanceStatus = 'neutral' | 'no-budget' | 'over' | 'warning' | 'healthy';

/** Data powering the "daily allowance" dashboard card. */
export interface DailyAllowanceData {
  /** Dollars available to spend per remaining day. */
  dailyAllowance: number;
  daysRemaining: number;
  totalBudget: number;
  spent: number;
  remaining: number;
  status: DailyAllowanceStatus;
  isCurrentMonth: boolean;
}

/** Traffic-light status for the spending pace widget. */
export type SpendingPaceStatus = 'no-budget' | 'over' | 'on-track' | 'under';

/** Data powering the "spending pace" dashboard card. */
export interface SpendingPaceData {
  status: SpendingPaceStatus;
  /** Actual spending as a percentage of total budget. */
  percentOfBudget: number;
  /** Expected percentage based on elapsed days in the month. */
  expectedPercent: number;
  /** `percentOfBudget - expectedPercent` (positive = ahead of pace). */
  difference: number;
  isCurrentMonth?: boolean;
}

/** A category with its total amount, used for "top categories" rankings. */
export interface TopCategoryResult extends CategoryChild {
  amount: number;
}

/** Yearly financial statistics for the stats / year-in-review view. */
export interface YearStats {
  /** Four-digit year string (e.g., `"2025"`). */
  year: string;
  income: number;
  expenses: number;
  net: number;
  /** `net / income` as a percentage (0–100). */
  savingsRate: number;
  topCategories: TopCategoryResult[];
  /** Keyed by `YYYY-MM`. */
  monthlyData: Record<string, { income: number; expenses: number }>;
  avgMonthlyIncome: number;
  avgMonthlyExpenses: number;
  txCount: number;
}

/** Identifies a single month as a "best" or "worst" performer. */
export interface MonthBestWorst {
  /** Month in `YYYY-MM` format. */
  month: string;
  income: number;
  expenses: number;
  net: number;
}

/** Lifetime statistics across all recorded data. */
export interface AllTimeStats {
  /** Earliest transaction date (`YYYY-MM-DD`). */
  firstDate: string;
  /** Latest transaction date (`YYYY-MM-DD`). */
  lastDate: string;
  totalIncome: number;
  totalExpenses: number;
  netSavings: number;
  savingsRate: number;
  txCount: number;
  avgMonthlySpend: number;
  /**
   * 7a (Inline-Behavior-Review, Period/scope coherence): count of months
   * in the **full tracked span** from the first-tracked month to the later
   * of (last-tracked month, current month). Mirrors the denominator that
   * `avgMonthlySpend` already divides by, so the UI "Months Tracked"
   * display cannot drift from the divisor behind "Avg/Month". Zero-
   * activity months are counted. See `calculations.ts` for the span
   * derivation and its rationale.
   */
  monthsTracked: number;
  bestMonth: MonthBestWorst | null;
  worstMonth: MonthBestWorst | null;
  /** List of years that contain data (e.g., `["2024","2025"]`). */
  years: string[];
}

/** Full income/expense/category breakdown for a single month (used in comparisons). */
export interface DetailedMonthData {
  income: number;
  expenses: number;
  net: number;
  /** Category ID → total amount. */
  categories: Record<string, number>;
}

/** Side-by-side comparison of the same calendar month across two years. */
export interface MonthlyComparison {
  /** Month number (1–12). */
  month: number;
  /** Display label (e.g., "January"). */
  monthLabel: string;
  year1: DetailedMonthData;
  year2: DetailedMonthData;
  // 7a (Inline-Behavior-Review, Period/scope coherence + baseline helper):
  // this shape previously carried `expenseChange`, `incomeChange`, and
  // `netChange` fields computed via the pre-baseline-helper fabrication
  // `prev === 0 ? (cur > 0 ? 100 : 0) : pct`. Grep confirmed zero consumers
  // across the entire repo (production, tests, HTML). The fabrication
  // pattern is exactly what `core/baseline.ts::computeBaselineDelta` was
  // introduced to replace (see its module JSDoc). Per the Phase 5 durable
  // pattern — "direction-reversal over per-call rebuild" — an unused API
  // advertising a semantic contract the module has moved away from is
  // worse than no API at all, so we retire rather than migrate.
  //
  // If a future reviewer needs per-month YoY percentages on this shape,
  // route the new fields through `computeBaselineDelta` so "new" / "no-
  // data" surfaces honestly instead of collapsing to +100% / 0%.
}

// ==========================================
// THEME TYPES
// ==========================================

/** User's theme preference — `'system'` defers to the OS setting. */
export type Theme = 'dark' | 'light' | 'system';
/** Resolved theme after evaluating `'system'` against the OS preference. */
export type ActualTheme = 'dark' | 'light';

// ==========================================
// DOM CACHE TYPES
// ==========================================

/** Raw string values read from the filter form DOM elements. */
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

/** Raw string values read from the transaction entry form DOM elements. */
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

// Phase 5g-2 (Inline-Behavior-Review rev 12, M31): deleted the
// `SafeMockElement` interface alongside the `SAFE_MOCK` singleton +
// `getSafe()` method in dom-cache.ts. Grep across js/ + tests/
// confirms zero remaining references. See the file-level note in
// dom-cache.ts for the full rationale (latent state-bleed bug; zero
// callers; explicit `DOM.get(id)` + null-guard is the supported path).

// ==========================================
// SWIPE MANAGER TYPES
// ==========================================

/** Map of touch event handlers to attach to a swipeable element. */
export interface TouchHandlers {
  touchstart: (e: TouchEvent) => void;
  touchmove: (e: TouchEvent) => void;
  touchend: (e: TouchEvent) => void;
}

/** Tunable constants for the swipe gesture recogniser. */
export interface SwipeConfig {
  /** Minimum horizontal pixel distance to register as a swipe. */
  threshold: number;
  /** Maximum pixel offset the element can be dragged. */
  maxSwipe: number;
  /** Damping factor applied as the swipe approaches `maxSwipe`. */
  resistance: number;
}

// SwipeCallbacks is declared above (line ~613) — not duplicated here

// ==========================================
// UI TIMING TYPES
// ==========================================

/** Millisecond durations for toast and modal animations. */
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

/** Quick-action button shown inside an empty-state placeholder. */
export interface EmptyStateAction {
  id: string;
  label: string;
  /** Pre-filled date for the action (e.g., today's date). */
  date?: string;
}

/** Function that formats a numeric amount into a locale-aware currency string. */
export type CurrencyFormatter = (value: number) => string;

// ==========================================
// PHASE E: FEATURE MODULE TYPES
// ==========================================

/** Summary of rollover amounts across categories for a given month. */
export interface RolloverSummary {
  /** Total positive (unspent) rollover dollars. */
  positive: number;
  /** Total negative (over-budget) rollover dollars. */
  negative: number;
  /** Net rollover (positive − negative). */
  net: number;
  /** Number of categories that rolled over. */
  count: number;
}

/** Which categories participate in rollover. */
export type RolloverMode = 'all' | 'selected';
/** How over-budget categories are handled during rollover. */
export type NegativeHandling = 'zero' | 'carry' | 'ignore';

/** Resolved start/end dates for a date preset (e.g., "this-week"). */
export interface DatePresetRange {
  /** Start date in `YYYY-MM-DD` format. */
  start: string;
  /** End date in `YYYY-MM-DD` format. */
  end: string;
}

/** Named quick-select date ranges for the filter panel. */
export type DatePreset = 'today' | 'yesterday' | 'this-week' | 'last-week' | 'this-month' | 'last-month' | 'this-year' | 'last-year';

/** Data driving the budget gauge arc on the dashboard. */
export interface BudgetGaugeData {
  spent: number;
  budget: number;
  /** `spent / budget` as a percentage (0–100+). */
  percentage: number;
  status: 'under' | 'warning' | 'over';
}

/** One row in the envelope-budgeting breakdown table. */
export interface EnvelopeData {
  /** Category ID. */
  category: string;
  categoryName: string;
  emoji: string;
  /** Budgeted amount for this category. */
  allocated: number;
  spent: number;
  remaining: number;
  /** `spent / allocated` as a percentage (0–100+). */
  percentage: number;
  /** Rolled-over amount from the previous month. */
  rollover: number;
}

/** A single day cell in the calendar view. */
export interface CalendarDay {
  /** Date in `YYYY-MM-DD` format. */
  date: string;
  /** Day of month (1–31). */
  day: number;
  transactions: Transaction[];
  isCurrentMonth: boolean;
  isToday: boolean;
  /** Net amount across all transactions on this day. */
  total: number;
}

/** A recurring transaction shown in the "upcoming bills" list. */
export interface UpcomingBill {
  description: string;
  amount: number;
  /** Due date in `YYYY-MM-DD` format. */
  dueDate: string;
  category: string;
  categoryEmoji: string;
}

/** Full debt-payoff plan for display in the debt dashboard. */
export interface DebtPayoffPlan {
  method: 'avalanche' | 'snowball';
  debts: DebtPayoffItem[];
  totalInterest: number;
  /** Projected final payoff date in `YYYY-MM-DD` format. */
  payoffDate: string;
  monthsToPayoff: number;
}

/** A single debt within a payoff plan, extended with projections. */
export interface DebtPayoffItem extends Debt {
  payoffOrder: number;
  monthsToPayoff: number;
  totalInterest: number;
  payoffDate: string;
}

/** Options controlling how the transaction list re-renders. */
export interface TransactionRenderOptions {
  /** Reset pagination to page 1. */
  resetPage?: boolean;
  /** Preserve current scroll position. */
  preserveScroll?: boolean;
}

/** External forecast data for a savings goal (used by the savings goal UI cards). */
export interface SavingsGoalForecastData {
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

// Phase 5g-1 (Inline-Behavior-Review rev 12, L16): removed the
// `ChartHandlerRecord` and `ChartElementWithHandlers` type definitions.
// Both existed to support the dead `cleanupChartListeners` infrastructure
// (deleted from chart-utils.ts this phase). Lit-html's template bindings
// handle listener teardown automatically — no handler-storage slots are
// assigned anywhere in the codebase.

/** Monthly spending total used as input for seasonal pattern analysis. */
export interface SeasonalMonthData {
  /** Month in `YYYY-MM` format. */
  yearMonth: string;
  total: number;
}

/** Calendar season for seasonal spending analysis. */
export type Season = 'winter' | 'spring' | 'summer' | 'autumn';

/** One category's contribution to a seasonal spending pattern. */
export interface SeasonalCategoryEntry {
  category: CategoryChild;
  amount: number;
  /** Share of the season's total spending (0–100). */
  percentage: number;
}

/** Aggregate spending pattern for a single season. */
export interface SeasonalPattern {
  season: Season;
  totalSpent: number;
  averageTransaction: number;
  transactionCount: number;
  topCategories: SeasonalCategoryEntry[];
}

/** A human-readable insight derived from seasonal spending data. */
export interface SeasonalInsight {
  type: string;
  season: string;
  message: string;
  amount: number;
  comparison?: number;
  category?: string;
}

/** Complete seasonal analysis result. */
export interface SeasonalPatternData {
  patterns: SeasonalPattern[];
  insights: SeasonalInsight[];
}

/** One month's spend for a single category (used in trend analysis). */
export interface CategoryMonthData {
  /** Month in `YYYY-MM` format. */
  month: string;
  amount: number;
}

/** Linear regression result describing a category's spending direction. */
export interface CategoryTrendDirection {
  direction: 'increasing' | 'decreasing' | 'stable';
  /** Slope of the regression line (dollars per month). */
  slope: number;
  /** R² strength of the trend (0–1). */
  strength: number;
}

/** Full trend analysis for a single category over a time window. */
export interface CategoryTrendData {
  category: CategoryChild;
  monthlyData: CategoryMonthData[];
  totalSpend: number;
  trend: CategoryTrendDirection;
  averageMonthly: number;
  /** Average of the most recent 3 months. */
  recentAverage: number;
  /**
   * Percentage change between recent and overall average.
   *
   * Retained as a numeric field for backward-compat with consumers that
   * filter or sort purely by magnitude (e.g. `getTrendingCategories`
   * thresholding at `>20` / `<-20`). For degenerate baselines (previous
   * window was zero) this field is `0` — callers that need to surface
   * "new / no baseline" as a first-class state must branch on
   * `baseline.status` instead. See `baseline` below.
   */
  percentageChange: number;
  /**
   * Structured baseline classification behind `percentageChange`.
   *
   * Design-Review-Apr21 batch 7 (7a): trend percentages previously collapsed
   * any degenerate baseline (previous-window zero, brand-new category, sparse
   * history) into a flat `0%` via `prev > 0 ? pct : 0`. That shortcut silently
   * hid the case the user most needed to see. Routing through
   * `computeBaselineDelta` preserves the numeric field for existing filters
   * while exposing `status: 'new' | 'no-data' | 'comparable'` so renderers can
   * distinguish "truly flat" from "no baseline to compare against".
   */
  baseline: BaselineDelta;
}

/** All category trends for a given analysis period. */
export interface CategoryTrendsResult {
  trends: CategoryTrendData[];
  periodMonths: number;
}

/** Categories split into increasing and decreasing buckets. */
export interface TrendingCategoriesResult {
  increasing: CategoryTrendData[];
  decreasing: CategoryTrendData[];
}

/** Month-over-month change indicator for a single category.
 *
 * 7a (Inline-Behavior-Review, Period/scope coherence + baseline helper):
 * `change` widened from `number` to `number | null` — `null` is the
 * honest signal when no baseline exists (prior month zero, `direction:
 * 'new'`) or when neither month carried activity (`direction: 'flat'`
 * as "no-data"). Previously the producer fabricated `change: 100` for
 * 'new' and `change: 0` for the no-baseline 'flat' case, mirroring the
 * retired `calcPercentChange` / `calculatePercentChange` helpers. All
 * current consumers (`getDashboardCategoryBreakdownStatus`,
 * `renderDonutChart`) already branch on `direction` before reading
 * `change`, so widening to nullable is structurally safe; null-guards
 * were added at the five read sites as defense-in-depth against a
 * future consumer that forgets the direction branch. Canonical
 * producer shape is `core/baseline.ts::computeBaselineDelta`. */
export interface CategoryTrendChange {
  /** Percentage change from previous month; `null` when no baseline. */
  change: number | null;
  direction: 'up' | 'down' | 'flat' | 'new';
}

/** Abbreviated currency formatter (e.g., "$1.2k"). */
export type ShortCurrencyFormatter = (value: number) => string;
/** Converts a `YYYY-MM` key into a display label (e.g., "Jan '25"). */
export type MonthLabelFormatter = (monthKey: string) => string;
/** Returns current spending velocity metrics. */
export type VelocityCalculator = () => VelocityData;

/** Dependency-injected callbacks used by chart renderer modules. */
export interface ChartRendererCallbacks {
  monthLabel?: MonthLabelFormatter;
  calcVelocity?: VelocityCalculator;
}

/** A single slice in the donut/pie chart. */
export interface DonutChartData {
  label: string;
  value: number;
  color: string;
  catId?: string;
}

/** A labelled data series for grouped bar charts. */
export interface BarChartDataset {
  label: string;
  data: number[];
  color: string;
}

/** Aggregated transaction data for one calendar week. */
export interface WeekData {
  /** Day-of-month the week starts on. */
  start: number;
  /** Day-of-month the week ends on. */
  end: number;
  startDate?: Date;
  endDate?: Date;
  /** Total spending stored as integer cents. */
  totalCents: number;
  txCount: number;
  /** Category ID → total cents. */
  categoriesCents: Record<string, number>;
  topCategories?: { cat: string; amt: number }[];
  /** @deprecated Legacy getter — returns `totalCents / 100`. */
  get total(): number;
  /** @deprecated Legacy getter — converts cents to dollars. */
  get categories(): Record<string, number>;
}

/** Duplicate of `InsightPersonality` used within the insight generator system. */
export type InsightPersonalityType = 'roast' | 'friendly' | 'serious' | 'casual' | 'motivating';

/** Financial context passed to each insight generator function. */
export interface InsightContext {
  income: number;
  expenses: number;
  balance: number;
}

/** An actionable CTA rendered alongside an insight message. */
export interface InsightAction {
  type: string;
  category?: string;
  label: string;
}

/** An insight message that may include an optional action button. */
export interface InsightResultWithAction {
  text: string;
  action?: InsightAction;
}

/** Return type from insight generator functions. */
export type InsightResult = string | InsightResultWithAction | null;

/**
 * Payload shape for the `currentInsights` signal.
 *
 * - **Success:** all three slots populated by `generateInsights()`.
 * - **Bootstrap (DI not ready):** all three slots `null`.
 * - **Error:** `insight1` carries the error copy, slots 2/3 are `null`,
 *   and `_error: true` lets the UI suppress default action buttons.
 *
 * Keeping success, bootstrap, and error on a single shape lets the consumer
 * render defensively without re-invoking `generateInsights()` outside the
 * signal's try/catch (see Inline-Behavior-Review H4 + P1 #1).
 */
export interface InsightsPayload {
  insight1: InsightResult;
  insight2: InsightResult;
  insight3: InsightResult;
  _error?: boolean;
}

/** A registered insight generator with its display slot and priority. */
export interface InsightGenerator {
  /** Dashboard slot index this generator occupies. */
  slot: number;
  fn: (personality: InsightPersonalityType, context: InsightContext) => InsightResult;
  /** Higher priority generators run first within the same slot. */
  priority: number;
}

/** Payload dispatched when the user taps an insight action button. */
export interface InsightActionData {
  actionType: string;
  data: unknown;
}

// ==========================================
// GAMIFICATION TYPES
// ==========================================

/** Static definition of an unlockable achievement. */
export interface AchievementDefinition {
  id: string;
  name: string;
  emoji: string;
  /** Human-readable description shown on the achievement card. */
  desc: string;
}

/** Persisted record that the user has earned a specific achievement. */
export interface EarnedAchievement {
  earned: boolean;
  /** ISO date string when the achievement was earned. */
  date: string;
}

/** Timing and quantity constants for the confetti celebration animation. */
export interface CelebrationConfig {
  /** Total celebration duration in milliseconds. */
  celebrationDuration: number;
  /** Delay before confetti elements are removed from the DOM (ms). */
  confettiRemoval: number;
  confettiCount: number;
  /** Base animation duration per confetti piece (ms). */
  confettiDurationBase: number;
}

// ==========================================
// SECURITY TYPES
// ==========================================

/** AES-GCM encrypted payload with its key-derivation parameters. */
export interface EncryptedBundle {
  /** Base64-encoded ciphertext. */
  encryptedData: string;
  /** Base64-encoded PBKDF2 salt. */
  salt: string;
  /** Base64-encoded initialisation vector. */
  iv: string;
}

/** Stored PIN bundle (v2) with PBKDF2 hash and recovery support. */
export interface PinBundle extends EncryptedBundle {
  /** PBKDF2 hash of the PIN for verification. */
  hash: string;
  /** Schema version (currently `2`). */
  version: number;
}

/** Result returned after the user sets a new PIN. */
export interface PinCreationResult {
  /** Serialised JSON bundle to persist in storage. */
  bundle: string;
  /** 12-word BIP39 recovery phrase shown once to the user. */
  recoveryPhrase: string;
  /** PBKDF2 hash of the new PIN. */
  pinHash: string;
}

// ==========================================
// WEB WORKER TYPES
// ==========================================

/** Operations the Web Worker can perform.
 *
 * Fixes H15 (Inline-Behavior-Review rev 12): added `'abort'` so the main
 * thread's timeout + AbortController paths have a target on the worker's
 * switch. Previously the worker hit `default:` and threw
 * "Unknown message type: abort" on any cancellation attempt, which then
 * fired `onerror` and poisoned every *other* in-flight request.
 */
export type WorkerMessageType = 'filter' | 'aggregate' | 'search' | 'init' | 'update' | 'abort';

/** Payload for an `abort` worker message — references the request to cancel. */
export interface WorkerAbortPayload {
  /** requestId of the in-flight request whose result should be discarded. */
  abortRequestId: number;
}

/** Sortable transaction fields in the worker. */
export type WorkerSortField = 'date' | 'amount' | 'description' | 'category';
/** Sort direction. */
export type WorkerSortDirection = 'asc' | 'desc';

/** Minimal category info passed to the worker for name-based filtering. */
export interface WorkerCategoryMapEntry {
  name: string;
}

/** Transaction filters extended with worker-specific lookups. */
export interface WorkerTransactionFilters extends TransactionFilters {
  /** ID → category name map for category-name search. */
  categoryMap?: Record<string, WorkerCategoryMapEntry>;
  /** Comma-separated tags string for tag matching. */
  tagsFilter?: string;
}

/** Payload for a `filter` worker message. */
// CR-Apr24-I finding 245: allow `null` for the cached-dataset protocol —
// the worker manager passes `null` when the worker's dataset is already warm.
export interface WorkerFilterPayload {
  transactions: Transaction[] | null;
  filters: WorkerTransactionFilters;
  sortBy?: WorkerSortField | undefined;
  sortDir?: WorkerSortDirection | undefined;
  page?: number | undefined;
  pageSize?: number | undefined;
}

/** Payload for an `aggregate` worker message. */
export interface WorkerAggregatePayload {
  transactions: Transaction[] | null;
  filters: WorkerTransactionFilters;
}

/** Payload for a `search` worker message. */
export interface WorkerSearchPayload {
  transactions: Transaction[] | null;
  query: string;
  limit?: number | undefined;
}

/** Payload for an `update` / `init` worker message. */
// Phase 6 Slice 1j (rev 12 L6): optional fields widened for
// `exactOptionalPropertyTypes` — call sites construct payloads with
// `{ transactions, categories }` where `categories` is typed
// `Record<string, any> | undefined`.
export interface WorkerUpdatePayload {
  transactions?: Transaction[] | undefined;
  categories?: Record<string, unknown> | undefined;
  change?: TransactionDataChange | undefined;
}

/** Discriminated union of all worker message payloads. */
export type WorkerPayload =
  | WorkerFilterPayload
  | WorkerAggregatePayload
  | WorkerSearchPayload
  | WorkerUpdatePayload
  | WorkerAbortPayload;

/** Envelope posted to the Web Worker via `postMessage`. */
export interface WorkerMessage {
  type: WorkerMessageType;
  payload: WorkerPayload;
  /** Monotonically increasing ID used to correlate responses. */
  requestId: number;
}

/** Aggregation totals computed by the worker. */
export interface WorkerAggregations {
  totalIncome: number;
  totalExpenses: number;
  balance: number;
  incomeCount: number;
  expenseCount: number;
  totalCount: number;
  /** Category ID → total amount. */
  categoryTotals: Record<string, number>;
}

/** Generic paginated result wrapper returned by the worker. */
export interface WorkerPaginatedResult<T> {
  items: T[];
  totalPages: number;
  currentPage: number;
  totalItems: number;
  hasMore: boolean;
}

/** Worker filter result: paginated transactions plus aggregation totals. */
export interface WorkerFilterResult extends WorkerPaginatedResult<Transaction> {
  aggregations: WorkerAggregations;
}

/** Envelope returned from the Web Worker in response to a `WorkerMessage`. */
export interface WorkerResponse<T = unknown> {
  /** Matches the `requestId` of the originating message. */
  requestId: number;
  success: boolean;
  result?: T;
  error?: string;
}
