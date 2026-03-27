/**
 * Central Test Data Factory
 * Generates consistent, type-safe mock data for all tests
 */
import type {
  Transaction,
  SavingsGoal,
  CustomCategory,
  MonthlyAllocation,
  Debt
} from '../js/types/index.js';

// ==========================================
// ID GENERATORS
// ==========================================

let idCounter = 0;

export function resetIdCounter(): void {
  idCounter = 0;
}

export function generateId(prefix = 'test'): string {
  return `${prefix}-${Date.now()}-${++idCounter}-${Math.random().toString(36).slice(2, 8)}`;
}

// ==========================================
// DATE GENERATORS
// ==========================================

export function generateDate(options: {
  year?: number;
  month?: number;
  day?: number;
  daysFromNow?: number;
} = {}): string {
  const now = new Date();
  
  if (options.daysFromNow !== undefined) {
    const date = new Date(now);
    date.setDate(date.getDate() + options.daysFromNow);
    return date.toISOString().split('T')[0];
  }
  
  const year = options.year ?? now.getFullYear();
  const month = options.month ?? now.getMonth() + 1;
  const day = options.day ?? now.getDate();
  
  return `${year}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
}

export function generateDateRange(startDaysAgo: number, endDaysAgo = 0): string[] {
  const dates: string[] = [];
  for (let i = startDaysAgo; i >= endDaysAgo; i--) {
    dates.push(generateDate({ daysFromNow: -i }));
  }
  return dates;
}

// ==========================================
// TRANSACTION FACTORY
// ==========================================

export function createTransaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    __backendId: generateId('backend'),
    type: 'expense' as const,
    amount: Math.round(Math.random() * 10000) / 100, // Random amount 0-100
    description: 'Test transaction',
    category: 'food',
    date: generateDate(),
    currency: 'USD',
    reconciled: false,
    notes: '',
    tags: '',
    recurring: false,
    ...overrides
  };
}

export function createIncomeTransaction(overrides: Partial<Transaction> = {}): Transaction {
  return createTransaction({
    type: 'income',
    category: 'salary',
    amount: 5000,
    description: 'Monthly salary',
    ...overrides
  });
}

export function createExpenseTransaction(overrides: Partial<Transaction> = {}): Transaction {
  return createTransaction({
    type: 'expense',
    category: 'food',
    amount: 50,
    description: 'Groceries',
    ...overrides
  });
}

export function createTransactionBatch(
  count: number,
  template: Partial<Transaction> = {}
): Transaction[] {
  const transactions: Transaction[] = [];
  for (let i = 0; i < count; i++) {
    transactions.push(createTransaction({
      ...template,
      __backendId: `${template.__backendId || 'tx'}-${i}`,
      date: generateDate({ daysFromNow: -i })
    }));
  }
  return transactions;
}

export function createDeterministicLedger(
  count: number,
  options: { startYear?: number; startMonth?: number; monthSpan?: number } = {}
): Transaction[] {
  const startYear = options.startYear ?? 2025;
  const startMonth = options.startMonth ?? 1;
  const monthSpan = options.monthSpan ?? 12;
  const expenseCategories = ['food', 'transport', 'shopping', 'bills', 'health'];
  const transactions: Transaction[] = [];

  for (let i = 0; i < count; i++) {
    const monthOffset = i % monthSpan;
    const year = startYear + Math.floor((startMonth - 1 + monthOffset) / 12);
    const month = ((startMonth - 1 + monthOffset) % 12) + 1;
    const day = (i % 28) + 1;
    const isIncome = i % 7 === 0;

    transactions.push(createTransaction({
      __backendId: `ledger-${count}-${i}`,
      type: isIncome ? 'income' : 'expense',
      amount: isIncome ? 2500 + (i % 4) * 125 : 8 + (i % 23) * 3.75,
      description: isIncome ? `Income ${i}` : `Expense ${i}`,
      category: isIncome ? 'salary' : expenseCategories[i % expenseCategories.length],
      date: generateDate({ year, month, day }),
      reconciled: i % 3 === 0,
      recurring: i % 11 === 0,
      tags: i % 5 === 0 ? 'benchmark,seed' : ''
    }));
  }

  return transactions;
}

// ==========================================
// SAVINGS GOAL FACTORY
// ==========================================

export function createSavingsGoal(overrides: Partial<SavingsGoal> = {}): SavingsGoal {
  return {
    id: generateId('goal'),
    name: 'Test Savings Goal',
    icon: '💰',
    target: 10000,
    saved: 2500,
    deadline: generateDate({ daysFromNow: 365 }),
    ...overrides
  };
}

// ==========================================
// CATEGORY FACTORY
// ==========================================

export function createCustomCategory(overrides: Partial<CustomCategory> = {}): CustomCategory {
  return {
    id: generateId('cat'),
    name: 'Custom Category',
    emoji: '📦',
    type: 'expense',
    color: '#3b82f6',
    ...overrides
  };
}

export function createCategorySet(): CustomCategory[] {
  return [
    createCustomCategory({ id: 'food', name: 'Food & Dining', emoji: '🍔' }),
    createCustomCategory({ id: 'transport', name: 'Transportation', emoji: '🚗' }),
    createCustomCategory({ id: 'shopping', name: 'Shopping', emoji: '🛍️' }),
    createCustomCategory({ id: 'bills', name: 'Bills & Utilities', emoji: '📱' }),
    createCustomCategory({ id: 'entertainment', name: 'Entertainment', emoji: '🎬' }),
    createCustomCategory({ id: 'health', name: 'Healthcare', emoji: '🏥' })
  ];
}

// ==========================================
// MONTHLY ALLOCATION FACTORY
// ==========================================

export function createMonthlyAllocation(
  categories: string[] = ['food', 'transport', 'bills']
): MonthlyAllocation {
  const allocation: MonthlyAllocation = {};
  categories.forEach(cat => {
    allocation[cat] = Math.round(Math.random() * 50000) / 100; // 0-500
  });
  return allocation;
}

// ==========================================
// DEBT FACTORY
// ==========================================

export function createDebt(overrides: Partial<Debt> = {}): Debt {
  return {
    id: generateId('debt'),
    name: 'Test Debt',
    type: 'personal',
    balance: 8000,
    originalBalance: 10000,
    interestRate: 0.055,
    minimumPayment: 200,
    dueDay: 15,
    createdAt: generateDate({ daysFromNow: -180 }),
    payments: [],
    isActive: true,
    ...overrides
  };
}

// ==========================================
// RECURRING TRANSACTION FACTORY
// ==========================================

export function createRecurringTransaction(
  overrides: Partial<Transaction> = {}
): Transaction {
  return createExpenseTransaction({
    recurring: true,
    recurring_type: 'monthly',
    ...overrides
  });
}

// ==========================================
// COMPLEX SCENARIO FACTORIES
// ==========================================

export function createMonthOfTransactions(options: {
  year?: number;
  month?: number;
  incomeCount?: number;
  expenseCount?: number;
} = {}): Transaction[] {
  const year = options.year ?? new Date().getFullYear();
  const month = options.month ?? new Date().getMonth() + 1;
  const incomeCount = options.incomeCount ?? 2;
  const expenseCount = options.expenseCount ?? 20;
  
  const transactions: Transaction[] = [];
  
  // Add income transactions
  for (let i = 0; i < incomeCount; i++) {
    transactions.push(createIncomeTransaction({
      date: generateDate({ year, month, day: i === 0 ? 1 : 15 }),
      amount: 2500
    }));
  }
  
  // Add varied expense transactions
  const categories = ['food', 'transport', 'entertainment', 'bills', 'shopping', 'health'];
  for (let i = 0; i < expenseCount; i++) {
    transactions.push(createExpenseTransaction({
      date: generateDate({ year, month, day: Math.floor(Math.random() * 28) + 1 }),
      amount: Math.round(Math.random() * 20000) / 100, // 0-200
      category: categories[Math.floor(Math.random() * categories.length)]
    }));
  }
  
  return transactions;
}

export function createYearOfTransactions(year?: number): Transaction[] {
  const targetYear = year ?? new Date().getFullYear();
  const transactions: Transaction[] = [];
  
  for (let month = 1; month <= 12; month++) {
    transactions.push(...createMonthOfTransactions({
      year: targetYear,
      month,
      incomeCount: 2,
      expenseCount: 15 + Math.floor(Math.random() * 10) // 15-25 expenses per month
    }));
  }
  
  return transactions;
}

// ==========================================
// STATE SNAPSHOT FACTORY
// ==========================================

export interface TestStateSnapshot {
  transactions: Transaction[];
  savingsGoals: Record<string, SavingsGoal>;
  customCategories: CustomCategory[];
  monthlyAllocations: Record<string, MonthlyAllocation>;
  debts: Debt[];
  recurringTransactions: Transaction[];
}

export function createFullStateSnapshot(): TestStateSnapshot {
  return {
    transactions: createMonthOfTransactions(),
    savingsGoals: {
      'goal-1': createSavingsGoal({ name: 'Emergency Fund', target: 10000 }),
      'goal-2': createSavingsGoal({ name: 'Vacation', target: 5000 }),
      'goal-3': createSavingsGoal({ name: 'New Car', target: 30000 })
    },
    customCategories: createCategorySet(),
    monthlyAllocations: {
      '2024-01': createMonthlyAllocation(),
      '2024-02': createMonthlyAllocation(),
      '2024-03': createMonthlyAllocation()
    },
    debts: [
      createDebt({ name: 'Car Loan', originalBalance: 25000 }),
      createDebt({ name: 'Credit Card', originalBalance: 5000 })
    ],
    recurringTransactions: [
      createRecurringTransaction({
        description: 'Netflix',
        amount: 15.99,
        category: 'entertainment'
      }),
      createRecurringTransaction({
        description: 'Rent',
        amount: 1500,
        category: 'bills'
      })
    ]
  };
}

// ==========================================
// ASSERTION HELPERS
// ==========================================

export function assertValidTransaction(tx: unknown): asserts tx is Transaction {
  if (!tx || typeof tx !== 'object') {
    throw new Error('Transaction must be an object');
  }
  
  const transaction = tx as any;
  
  if (typeof transaction.__backendId !== 'string') {
    throw new Error('Transaction must have string __backendId');
  }
  
  if (!['income', 'expense'].includes(transaction.type)) {
    throw new Error('Transaction type must be income or expense');
  }
  
  if (typeof transaction.amount !== 'number' || transaction.amount < 0) {
    throw new Error('Transaction amount must be non-negative number');
  }
  
  if (typeof transaction.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(transaction.date)) {
    throw new Error('Transaction date must be YYYY-MM-DD format');
  }
}
