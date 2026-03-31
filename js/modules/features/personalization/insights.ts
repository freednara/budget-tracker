/**
 * Insights Module
 *
 * Smart insight generators for the Budget Tracker.
 * Extracts and displays personalized spending insights.
 */
'use strict';

import * as signals from '../../core/signals.js';
import { fmtCur as fmtCurBase, getPrevMonthKey, getMonthKey, sumByType, parseLocalDate, toCents, toDollars } from '../../core/utils.js';
import { getMonthTx, getMonthExpenses, calcTotals, getMonthExpByCat, calcVelocity, getTopCat, getMonthlySavings } from '../financial/calculations.js';
import { getAllCats, getCatInfo } from '../../core/categories.js';
import { isTrackedExpenseTransaction, SAVINGS_TRANSFER_CATEGORY_ID } from '../../core/transaction-classification.js';
import DOM from '../../core/dom-cache.js';
import { html, render, nothing } from '../../core/lit-helpers.js';
import type {
  Transaction,
  Totals,
  InsightPersonalityType,
  InsightContext,
  InsightResult,
  InsightResultWithAction,
  InsightGenerator,
  FlattenedCategory,
  SavingsGoal,
  LegacySavingsGoal
} from '../../../types/index.js';

// ==========================================
// TYPE DEFINITIONS
// ==========================================

interface CategorySpendingData {
  cat: { id: string; name: string; emoji: string };
  change: number;
  current: number;
}

interface UnusualSpending {
  cat: { id: string; name: string; emoji: string };
  amount: number;
  avg: number;
}

// Using LegacySavingsGoal from central types

// ==========================================
// CURRENCY FORMATTER
// ==========================================

// Create a currency formatter that auto-passes currency from signals
const fmtCur = (amount: number, currency?: string): string => fmtCurBase(amount, currency, { currency: signals.currency.value });

// ==========================================
// INSIGHT GENERATOR FUNCTIONS
// ==========================================

function insightMonthChange(pers: InsightPersonalityType, ctx: InsightContext): InsightResult {
  const { expenses } = ctx;
  const prevMk = getPrevMonthKey(signals.currentMonth.value);
  const prevExp = calcTotals(getMonthExpenses(prevMk)).expenses;
  const change = prevExp > 0 ? Math.round(((expenses - prevExp) / prevExp) * 100) : 0;
  let text: string;

  if (pers === 'roast') {
    text = change > 0 ? `Spending up ${change}%? Your wallet is crying.` : `Down ${Math.abs(change)}%. Miracle.`;
  } else if (pers === 'friendly') {
    text = change > 0 ? `Spending up ${change}% — you got this!` : `Down ${Math.abs(change)}%! Amazing work!`;
  } else {
    text = change > 0 ? `Spending up ${change}% vs last month` : `Spending down ${Math.abs(change)}% vs last month`;
  }

  return {
    text,
    action: { type: 'goto-budget', label: change > 0 ? 'Adjust' : 'Review' }
  };
}

function insightSavingsRate(pers: InsightPersonalityType, ctx: InsightContext): InsightResult {
  const { income, expenses } = ctx;
  if (income <= 0) return null;

  const rate = Math.round(((income - expenses) / income) * 100);
  const prevMk = getPrevMonthKey(signals.currentMonth.value);
  const prevTx = getMonthTx(prevMk);
  const prevTotals = calcTotals(prevTx);
  const prevRate = prevTotals.income > 0 ? Math.round(((prevTotals.income - prevTotals.expenses) / prevTotals.income) * 100) : 0;
  const diff = rate - prevRate;

  if (pers === 'roast') {
    return rate < 10
      ? { text: `Saving ${rate}%? That's... something.`, action: { type: 'goto-budget', label: 'Improve' } }
      : { text: `${rate}% saved. Not bad, I guess.`, action: { type: 'goto-budget', label: 'Improve' } };
  }
  if (pers === 'friendly') {
    return diff > 0
      ? { text: `Saving ${rate}%! Up from ${prevRate}% last month!`, action: { type: 'goto-budget', label: 'Keep it up' } }
      : { text: `You're saving ${rate}% this month!`, action: { type: 'goto-budget', label: 'Improve' } };
  }
  return {
    text: `Savings rate: ${rate}%${diff !== 0 ? ` (${diff > 0 ? '+' : ''}${diff}% vs last month)` : ''}`,
    action: { type: 'goto-budget', label: 'Improve' }
  };
}

function insightCategoryTrend(pers: InsightPersonalityType, ctx: InsightContext): InsightResult {
  const prevMk = getPrevMonthKey(signals.currentMonth.value);
  const cats = getAllCats('expense');
  let biggest: CategorySpendingData = { cat: { id: '', name: '', emoji: '' }, change: 0, current: 0 };

  cats.forEach((c: FlattenedCategory) => {
    const curr = getMonthExpByCat(c.id, signals.currentMonth.value);
    const prev = getMonthExpByCat(c.id, prevMk);
    if (prev > 0 && curr > 50) {
      const pct = Math.round(((curr - prev) / prev) * 100);
      if (Math.abs(pct) > Math.abs(biggest.change)) {
        biggest = { cat: c, change: pct, current: curr };
      }
    }
  });

  if (!biggest.cat.id) return null;

  const { cat, change } = biggest;
  if (pers === 'roast') {
    return {
      text: change > 0 ? `${cat.emoji} ${cat.name} up ${change}%? Oof.` : `${cat.emoji} ${cat.name} down ${Math.abs(change)}%. Finally.`,
      action: { type: 'filter-category', category: cat.id, label: 'Review' }
    };
  }
  if (pers === 'friendly') {
    return {
      text: change > 0 ? `${cat.emoji} ${cat.name} up ${change}% — watch this one!` : `${cat.emoji} ${cat.name} down ${Math.abs(change)}%! Nice!`,
      action: { type: 'filter-category', category: cat.id, label: 'Review' }
    };
  }
  return {
    text: `${cat.emoji} ${cat.name}: ${change > 0 ? '+' : ''}${change}% vs last month`,
    action: { type: 'filter-category', category: cat.id, label: 'Review' }
  };
}

function insightVelocity(pers: InsightPersonalityType, _ctx: InsightContext): InsightResult {
  const vel = calcVelocity();
  if (pers === 'roast') {
    return { text: `At ${fmtCur(vel.dailyRate)}/day, you'll spend ${fmtCur(vel.projected)} this month. Yikes.`, action: { type: 'goto-budget', label: 'Adjust plan' } };
  }
  if (pers === 'friendly') {
    return { text: `On track for ${fmtCur(vel.projected)} this month (${fmtCur(vel.dailyRate)}/day)`, action: { type: 'goto-budget', label: 'Adjust plan' } };
  }
  return { text: `Projected: ${fmtCur(vel.projected)} this month (${fmtCur(vel.dailyRate)}/day)`, action: { type: 'goto-budget', label: 'Adjust plan' } };
}

function insightBudgetAdherence(pers: InsightPersonalityType, _ctx: InsightContext): InsightResult {
  const allocRecord = signals.monthlyAlloc.value as Record<string, Record<string, number>>;
  const alloc = allocRecord[signals.currentMonth.value] || {};
  const cats = Object.keys(alloc);
  if (cats.length === 0) return null;

  let over = 0;
  let under = 0;
  cats.forEach(c => {
    const spent = getMonthExpByCat(c, signals.currentMonth.value);
    if (spent > alloc[c]) over++;
    else under++;
  });

  if (pers === 'roast') {
    return {
      text: over > 0 ? `${over} categories over budget. Classic.` : `All ${under} categories under budget? Suspicious.`,
      action: { type: 'goto-budget', label: over > 0 ? 'Fix budget' : 'Review budget' }
    };
  }
  if (pers === 'friendly') {
    return {
      text: over > 0 ? `${under} on track, ${over} over — you can do it!` : `All ${under} categories on track! Amazing!`,
      action: { type: 'goto-budget', label: over > 0 ? 'Fix budget' : 'Review budget' }
    };
  }
  return {
    text: `Budget check: ${under} categories on track, ${over} over budget`,
    action: { type: 'goto-budget', label: over > 0 ? 'Fix budget' : 'Review budget' }
  };
}

function insightDayOfWeek(pers: InsightPersonalityType, _ctx: InsightContext): InsightResult {
  const monthTx = (getMonthTx() as Transaction[]).filter((t: Transaction) => isTrackedExpenseTransaction(t));
  if (monthTx.length < 5) return null;

  let weekday = 0;
  let weekend = 0;
  let wdCount = 0;
  let weCount = 0;

  monthTx.forEach(t => {
    const d = parseLocalDate(t.date).getDay();
    if (d === 0 || d === 6) {
      weekend += t.amount;
      weCount++;
    } else {
      weekday += t.amount;
      wdCount++;
    }
  });

  if (wdCount === 0 || weCount === 0) return null;

  const wdAvg = weekday / wdCount;
  const weAvg = weekend / weCount;
  const diff = Math.round(((weAvg - wdAvg) / wdAvg) * 100);

  if (Math.abs(diff) < 10) return null;

  if (pers === 'roast') {
    return {
      text: diff > 0 ? `Weekends cost ${diff}% more per transaction. Ouch.` : `Weekdays cost ${Math.abs(diff)}% more. Interesting.`,
      action: { type: 'goto-budget', label: 'Plan ahead' }
    };
  }
  if (pers === 'friendly') {
    return {
      text: diff > 0 ? `Weekends run ${diff}% higher — treat yourself!` : `Weekdays run ${Math.abs(diff)}% higher`,
      action: { type: 'goto-budget', label: 'Plan ahead' }
    };
  }
  return {
    text: `${diff > 0 ? 'Weekend' : 'Weekday'} spending ${Math.abs(diff)}% higher per transaction`,
    action: { type: 'goto-budget', label: 'Plan ahead' }
  };
}

function insightTopCat(pers: InsightPersonalityType, _ctx: InsightContext): InsightResult {
  const topCat = getTopCat();
  if (!topCat) return null;

  let text: string;
  if (pers === 'roast') {
    text = `${topCat.emoji} ${topCat.name}: ${fmtCur(topCat.amount)}. That's a lot.`;
  } else if (pers === 'friendly') {
    text = `${topCat.emoji} ${topCat.name} leads at ${fmtCur(topCat.amount)}`;
  } else {
    text = `Top category: ${topCat.emoji} ${topCat.name} at ${fmtCur(topCat.amount)}`;
  }

  return { text, action: { type: 'filter-category', category: topCat.id, label: 'View' } };
}

function insightUnusualSpending(pers: InsightPersonalityType, _ctx: InsightContext): InsightResult {
  const monthTx = (getMonthTx() as Transaction[]).filter((t: Transaction) => isTrackedExpenseTransaction(t));
  if (monthTx.length < 3) return null;

  const byCategory: Record<string, number[]> = {};
  monthTx.forEach(t => {
    if (!byCategory[t.category]) byCategory[t.category] = [];
    byCategory[t.category].push(t.amount);
  });

  let unusual: UnusualSpending | null = null;
  let unusualCatId: string | null = null;

  for (const [catId, amounts] of Object.entries(byCategory)) {
    if (amounts.length < 2) continue;
    const avg = toDollars(amounts.reduce((sumCents, amount) => sumCents + toCents(amount), 0)) / amounts.length;
    const max = Math.max(...amounts);
    if (max >= avg * 2 && max > 30) {
      const cat = getCatInfo('expense', catId);
      unusual = { cat, amount: max, avg };
      unusualCatId = catId;
      break;
    }
  }

  if (!unusual || !unusualCatId) return null;

  let text: string;
  if (pers === 'roast') {
    text = `${unusual.cat.emoji} ${fmtCur(unusual.amount)} — that's ${Math.round(unusual.amount / unusual.avg)}x your usual. Oops.`;
  } else if (pers === 'friendly') {
    text = `Big ${unusual.cat.emoji} expense: ${fmtCur(unusual.amount)} (usually ~${fmtCur(unusual.avg)})`;
  } else {
    text = `${unusual.cat.emoji} ${unusual.cat.name} spiked to ${fmtCur(unusual.amount)} vs your usual ${fmtCur(unusual.avg)}`;
  }

  return { text, action: { type: 'filter-category', category: unusualCatId, label: 'Review' } };
}

function insightSavingsGoal(pers: InsightPersonalityType, _ctx: InsightContext): InsightResult {
  const goalsRecord = signals.savingsGoals.value as unknown as Record<string, LegacySavingsGoal>;
  const goals = Object.entries(goalsRecord);
  if (goals.length === 0) return null;

  const [_gid, g] = goals[0];
  const saved = g.saved_amount || 0;
  const target = g.target_amount || 1;
  const pct = Math.round((saved / target) * 100);
  const name = g.name || 'Goal';

  if (pers === 'roast') {
    return {
      text: pct < 50 ? `${name}: ${pct}% there. Keep going... or don't.` : `${name}: ${pct}% done. Almost bearable.`,
      action: { type: 'goto-budget-goals', label: 'Open goals' }
    };
  }
  if (pers === 'friendly') {
    return {
      text: `${name}: ${fmtCur(saved)}/${fmtCur(target)} (${pct}%) — you're doing great!`,
      action: { type: 'goto-budget-goals', label: 'Open goals' }
    };
  }
  return {
    text: `${name}: ${fmtCur(saved)}/${fmtCur(target)} (${pct}%)`,
    action: { type: 'goto-budget-goals', label: 'Open goals' }
  };
}

function insightSavingsTransfers(pers: InsightPersonalityType, _ctx: InsightContext): InsightResult {
  const monthKey = signals.currentMonth.value;
  const transferCount = signals.savingsContribs.value.filter((c) => getMonthKey(c.date) === monthKey).length;
  if (transferCount === 0) return null;

  const totalMoved = getMonthlySavings(monthKey);
  const transferLabel = transferCount === 1 ? 'transfer' : 'transfers';

  if (pers === 'roast') {
    return {
      text: `You moved ${fmtCur(totalMoved)} to savings in ${transferCount} ${transferLabel}. At least that money is behaving.`,
      action: { type: 'filter-category', category: SAVINGS_TRANSFER_CATEGORY_ID, label: 'View transfers' }
    };
  }
  if (pers === 'friendly') {
    return {
      text: `You moved ${fmtCur(totalMoved)} to savings across ${transferCount} ${transferLabel} this month.`,
      action: { type: 'filter-category', category: SAVINGS_TRANSFER_CATEGORY_ID, label: 'View transfers' }
    };
  }
  return {
    text: `${fmtCur(totalMoved)} moved to savings this month across ${transferCount} ${transferLabel}`,
    action: { type: 'filter-category', category: SAVINGS_TRANSFER_CATEGORY_ID, label: 'View transfers' }
  };
}

// ==========================================
// INSIGHT GENERATORS PRIORITY ARRAY
// ==========================================

// Priority levels: anomaly (4) > warning (3) > trend (2) > info (1)
const INSIGHT_GENERATORS: InsightGenerator[] = [
  { slot: 1, fn: insightMonthChange, priority: 2 },     // trend
  { slot: 1, fn: insightSavingsRate, priority: 1 },     // info
  { slot: 1, fn: insightCategoryTrend, priority: 2 },   // trend
  { slot: 2, fn: insightVelocity, priority: 2 },        // trend
  { slot: 2, fn: insightSavingsTransfers, priority: 2 }, // transfer activity
  { slot: 2, fn: insightBudgetAdherence, priority: 3 }, // warning (over budget)
  { slot: 2, fn: insightDayOfWeek, priority: 1 },       // info
  { slot: 3, fn: insightTopCat, priority: 1 },          // info
  { slot: 3, fn: insightUnusualSpending, priority: 4 }, // anomaly (highest)
  { slot: 3, fn: insightSavingsGoal, priority: 1 },     // info
];

// ==========================================
// RENDERING & ACTION HANDLING
// ==========================================

/**
 * Generate insights for all slots (pure business logic)
 * Returns computed insights without UI concerns
 */
export function generateInsights(): { insight1: InsightResult | string; insight2: InsightResult | string; insight3: InsightResult | string } {
  const transactions = signals.transactions.value as Transaction[];
  if (transactions.length === 0) {
    return {
      insight1: { text: 'Add your first few transactions to reveal what is really driving this month.', action: { type: 'goto-transactions', label: 'Open ledger' } },
      insight2: { text: 'Set a budget early so the dashboard can tell you what is healthy versus risky.', action: { type: 'goto-budget', label: 'Plan budget' } },
      insight3: { text: 'Once the basics are in place, review your goals and keep the month intentional.', action: { type: 'goto-budget-goals', label: 'Open goals' } }
    };
  }

  const monthTx = getMonthTx() as Transaction[];
  const ctx = calcTotals(monthTx) as InsightContext;
  const pers = signals.insightPers.value as InsightPersonalityType;

  // Priority-based insight selection (higher priority = shown first)
  const pickForSlot = (slot: number, fallbackText: string): InsightResult | string => {
    const candidates = INSIGHT_GENERATORS.filter(g => g.slot === slot);
    // Sort by priority descending (highest priority first)
    const prioritized = candidates.sort((a, b) => b.priority - a.priority);
    for (const g of prioritized) {
      const result = g.fn(pers, ctx);
      if (result) return result;
    }
    return fallbackText;
  };

  return {
    insight1: pickForSlot(1, 'Review the ledger to confirm what changed this month.'),
    insight2: pickForSlot(2, 'Open Budget to keep this month aligned with your plan.'),
    insight3: pickForSlot(3, 'Review the ledger to spot the transactions driving this month.')
  };
}

// updateInsights() removed — rendering is handled by reactive components/insights.ts (mountInsights)
