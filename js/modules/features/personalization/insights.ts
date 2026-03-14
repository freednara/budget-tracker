/**
 * Insights Module
 *
 * Smart insight generators for the Budget Tracker.
 * Extracts and displays personalized spending insights.
 */
'use strict';

import * as signals from '../../core/signals.js';
import { fmtCur as fmtCurBase, getPrevMonthKey, sumByType, parseLocalDate } from '../../core/utils.js';
import { getMonthTx, calcTotals, getMonthExpByCat, calcVelocity, getTopCat } from '../financial/calculations.js';
import { getAllCats, getCatInfo } from '../../core/categories.js';
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
  InsightActionData,
  FlattenedCategory,
  SavingsGoal
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

interface LegacySavingsGoal {
  name: string;
  target_amount: number;
  saved_amount: number;
}

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
  const prevExp = sumByType(getMonthTx(prevMk), 'expense');
  const change = prevExp > 0 ? Math.round(((expenses - prevExp) / prevExp) * 100) : 0;

  if (pers === 'roast') {
    return change > 0 ? `Spending up ${change}%? Your wallet is crying.` : `Down ${Math.abs(change)}%. Miracle.`;
  }
  if (pers === 'friendly') {
    return change > 0 ? `Spending up ${change}% — you got this!` : `Down ${Math.abs(change)}%! Amazing work!`;
  }
  return change > 0 ? `Spending up ${change}% vs last month` : `Spending down ${Math.abs(change)}% vs last month`;
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
    return rate < 10 ? `Saving ${rate}%? That's... something.` : `${rate}% saved. Not bad, I guess.`;
  }
  if (pers === 'friendly') {
    return diff > 0 ? `Saving ${rate}%! Up from ${prevRate}% last month!` : `You're saving ${rate}% this month!`;
  }
  return `Savings rate: ${rate}%${diff !== 0 ? ` (${diff > 0 ? '+' : ''}${diff}% vs last month)` : ''}`;
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
    return change > 0 ? `${cat.emoji} ${cat.name} up ${change}%? Oof.` : `${cat.emoji} ${cat.name} down ${Math.abs(change)}%. Finally.`;
  }
  if (pers === 'friendly') {
    return change > 0 ? `${cat.emoji} ${cat.name} up ${change}% — watch this one!` : `${cat.emoji} ${cat.name} down ${Math.abs(change)}%! Nice!`;
  }
  return `${cat.emoji} ${cat.name}: ${change > 0 ? '+' : ''}${change}% vs last month`;
}

function insightVelocity(pers: InsightPersonalityType, _ctx: InsightContext): InsightResult {
  const vel = calcVelocity();
  if (pers === 'roast') {
    return `At ${fmtCur(vel.dailyRate)}/day, you'll spend ${fmtCur(vel.projected)} this month. Yikes.`;
  }
  if (pers === 'friendly') {
    return `On track for ${fmtCur(vel.projected)} this month (${fmtCur(vel.dailyRate)}/day)`;
  }
  return `Projected: ${fmtCur(vel.projected)} this month (${fmtCur(vel.dailyRate)}/day)`;
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
    return over > 0 ? `${over} categories over budget. Classic.` : `All ${under} categories under budget? Suspicious.`;
  }
  if (pers === 'friendly') {
    return over > 0 ? `${under} on track, ${over} over — you can do it!` : `All ${under} categories on track! Amazing!`;
  }
  return `Budget: ${under} on track, ${over} over`;
}

function insightDayOfWeek(pers: InsightPersonalityType, _ctx: InsightContext): InsightResult {
  const monthTx = (getMonthTx() as Transaction[]).filter(t => t.type === 'expense');
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
    return diff > 0 ? `Weekends cost ${diff}% more per transaction. Ouch.` : `Weekdays cost ${Math.abs(diff)}% more. Interesting.`;
  }
  if (pers === 'friendly') {
    return diff > 0 ? `Weekends run ${diff}% higher — treat yourself!` : `Weekdays run ${Math.abs(diff)}% higher`;
  }
  return `${diff > 0 ? 'Weekend' : 'Weekday'} spending ${Math.abs(diff)}% higher per transaction`;
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
  const monthTx = (getMonthTx() as Transaction[]).filter(t => t.type === 'expense');
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
    const avg = amounts.reduce((a, b) => a + b, 0) / amounts.length;
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
    text = `Unusual: ${unusual.cat.emoji} ${fmtCur(unusual.amount)} (avg ${fmtCur(unusual.avg)})`;
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
    return pct < 50 ? `${name}: ${pct}% there. Keep going... or don't.` : `${name}: ${pct}% done. Almost bearable.`;
  }
  if (pers === 'friendly') {
    return `${name}: ${fmtCur(saved)}/${fmtCur(target)} (${pct}%) — you're doing great!`;
  }
  return `${name}: ${fmtCur(saved)}/${fmtCur(target)} (${pct}%)`;
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
 * Renders an insight result with optional action button
 */
export function renderInsightWithAction(el: HTMLElement | null, result: InsightResult | string): void {
  if (!el) return;

  if (typeof result === 'string') {
    render(html`${result}`, el);
    return;
  }

  if (result === null) {
    render(nothing, el);
    return;
  }

  // Result is an object with text and optional action
  const resultObj = result as InsightResultWithAction;
  render(html`
    <span>${resultObj.text}</span>
    ${resultObj.action ? html`
      <button class="insight-action-btn ml-2 px-2 py-1 rounded text-xs font-bold transition-all"
        data-action-type=${resultObj.action.type}
        data-category=${resultObj.action.category || ''}
        style="background: var(--color-accent); color: white;">
        ${resultObj.action.label} →
      </button>
    ` : nothing}
  `, el);
}

/**
 * Handles insight action button clicks
 * Returns action data for the caller to process UI changes
 */
export function handleInsightAction(actionType: string, data: Record<string, string>): InsightActionData {
  return { actionType, data };
}

/**
 * Updates all insight slots with priority-based content
 */
export function updateInsights(): void {
  const i1 = DOM.get('insight-1');
  const i2 = DOM.get('insight-2');
  const i3 = DOM.get('insight-3');

  const transactions = signals.transactions.value as Transaction[];
  if (transactions.length === 0) {
    if (i1) i1.textContent = 'Add transactions to unlock insights';
    if (i2) i2.textContent = 'Your spending patterns will appear here';
    if (i3) i3.textContent = 'Keep tracking!';
    return;
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

  renderInsightWithAction(i1, pickForSlot(1, 'Keep tracking your spending!'));
  renderInsightWithAction(i2, pickForSlot(2, 'More data = better insights'));
  renderInsightWithAction(i3, pickForSlot(3, 'Keep it up!'));
}
