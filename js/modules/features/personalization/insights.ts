/**
 * Insights Module
 *
 * Smart insight generators for the Budget Tracker.
 * Extracts and displays personalized spending insights.
 */
'use strict';

import * as signals from '../../core/signals.js';
import { fmtCur, getPrevMonthKey, getMonthKey, parseLocalDate, toCents, toDollars } from '../../core/utils-pure.js';
import { formatViewedMonthPhrase, formatViewedMonthLabel } from '../../core/locale-service.js';
import { getMonthTx, getMonthExpenses, calcTotals, getMonthExpByCat, calcVelocity, getTopCat, getMonthlySavings } from '../financial/calculations.js';
// CR-Apr22-D slice 4 (finding 67 [P2]): `insightBudgetAdherence` must
// compare spending to the *effective* budget when rollover is enabled
// — i.e., raw allocation plus any carryover from a prior month's
// underspend. Pre-fix, categories that were rolled over $100+ from
// last month but fully within their effective budget this month were
// still counted as `over`, producing "X categories over budget"
// insight text that contradicted the Budget Planner's green-bar UI.
// Importing the same `isRolloverEnabled` / `calculateMonthRollovers`
// pair used by `getDailyAllowance` and `getSpendingPace` keeps the
// rollover semantics consistent across the dashboard surface.
import { isRolloverEnabled, calculateMonthRollovers } from '../financial/rollover.js';
import { getAllCats, getCatInfo } from '../../core/categories.js';
import { isTrackedExpenseTransaction, SAVINGS_TRANSFER_CATEGORY_ID } from '../../core/transaction-classification.js';
import type {
  Transaction,
  InsightPersonalityType,
  InsightContext,
  InsightResult,
  InsightGenerator,
  FlattenedCategory
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

// fmtCur is now reactive via syncCurrencyFormat — no local wrapper needed.

// ==========================================
// INSIGHT GENERATOR FUNCTIONS
// ==========================================

function insightMonthChange(pers: InsightPersonalityType, ctx: InsightContext): InsightResult {
  const { expenses } = ctx;
  const prevMk = getPrevMonthKey(signals.currentMonth.value);
  const prevExp = calcTotals(getMonthExpenses(prevMk)).expenses;
  // Design-Review-Apr21 P2 (batch 6 follow-up wave M): suppress the
  // month-change insight entirely when there is no usable comparison
  // baseline. Previously the generator returned a result unconditionally
  // and forced `change = 0` when `prevExp <= 0`, producing meaningless
  // copy like "Spending down 0% vs last month" or (in roast mode)
  // "Down 0%. Miracle." Because this generator sits in slot 1 alongside
  // `insightSavingsRate` (priority 1) and `insightCategoryTrend`
  // (priority 2), a forced 0% trend would mask the savings-rate insight
  // for every brand-new user and for any user navigating into a month
  // whose predecessor had no expenses (first month after import, gaps
  // in the ledger, etc.). Returning `null` lets the slot-1 fallback
  // chain pick a generator that actually has signal to report.
  if (prevExp <= 0) return null;
  const change = Math.round(((expenses - prevExp) / prevExp) * 100);
  // Symmetric guard: a 0% change is also not a usable trend signal — it
  // surfaces only when prev/current expenses round to identical totals,
  // which is information-free for a "trend" insight. Yield to the next
  // candidate instead of publishing "Spending down 0% vs last month".
  if (change === 0) return null;
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
    action: change > 0
      ? { type: 'goto-transactions', label: 'Review spending' }
      : { type: 'goto-transactions', label: 'See trend' }
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
    // Design-Review-Apr21 P3 (batch 6 follow-up wave N): when the friendly
    // path falls into the no-positive-delta branch, the previous copy
    // ("You're saving X% this month!") implicitly anchored to the real
    // current month. The insight is computed off `signals.currentMonth`,
    // so use `formatViewedMonthPhrase` to surface "this month" at
    // current-view default and "in April 2026"-style labels when the
    // user is reviewing another period — keeps the friendly tone while
    // accurately naming the period being summarized.
    const monthPhrase = formatViewedMonthPhrase(signals.currentMonth.value);
    return diff > 0
      ? { text: `Saving ${rate}%! Up from ${prevRate}% last month!`, action: { type: 'goto-budget', label: 'Keep it up' } }
      : { text: `You're saving ${rate}% ${monthPhrase}!`, action: { type: 'goto-budget', label: 'Improve' } };
  }
  return {
    text: `Savings rate: ${rate}%${diff !== 0 ? ` (${diff > 0 ? '+' : ''}${diff}% vs last month)` : ''}`,
    action: { type: 'goto-budget', label: 'Improve' }
  };
}

function insightCategoryTrend(pers: InsightPersonalityType, _ctx: InsightContext): InsightResult {
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
  // UI/UX Review (Gamification): context-specific CTA labels instead of
  // generic "View details" — "Review spending" for increases, "See trend"
  // for decreases. Deep-links to filtered transaction view for that category.
  const actionLabel = change > 0 ? 'Review spending' : 'See trend';
  if (pers === 'roast') {
    return {
      text: change > 0 ? `${cat.emoji} ${cat.name} up ${change}%? Oof.` : `${cat.emoji} ${cat.name} down ${Math.abs(change)}%. Finally.`,
      action: { type: 'filter-category', category: cat.id, label: actionLabel }
    };
  }
  if (pers === 'friendly') {
    return {
      text: change > 0 ? `${cat.emoji} ${cat.name} up ${change}% — watch this one!` : `${cat.emoji} ${cat.name} down ${Math.abs(change)}%! Nice!`,
      action: { type: 'filter-category', category: cat.id, label: actionLabel }
    };
  }
  return {
    text: `${cat.emoji} ${cat.name}: ${change > 0 ? '+' : ''}${change}% vs last month`,
    action: { type: 'filter-category', category: cat.id, label: actionLabel }
  };
}

function insightVelocity(pers: InsightPersonalityType, _ctx: InsightContext): InsightResult {
  const vel = calcVelocity();
  // Design-Review-Apr21 P3 (batch 6 follow-up wave M): `calcVelocityPure`
  // treats non-current months as fully elapsed (`daysElapsed = daysInMonth`),
  // which makes `projected === actual` for past months and makes both
  // zero for empty future months. The forecast copy ("you'll spend…",
  // "On track for…", "Projected: …") reads as a live prediction and
  // feels semantically wrong when the user is reviewing a finished
  // period or peeking at an empty future month.
  //
  // Classify the viewed month against the real current month and pick
  // copy that matches:
  //   - past    → past-tense recap ("You spent $X total" / "Total: $X")
  //   - future  → suppress (no projection signal available yet)
  //   - current → existing forecast copy
  //
  // Slot 2 has `insightSavingsTransfers`, `insightBudgetAdherence`, and
  // `insightDayOfWeek` as fallbacks, so suppressing on future months
  // yields cleanly to the next candidate instead of surfacing "$0
  // projected" noise.
  const viewedMk = signals.currentMonth.value;
  const realMk = getMonthKey(new Date());
  const isCurrentMonth = viewedMk === realMk;
  const isFutureMonth = viewedMk > realMk;

  if (isFutureMonth) return null;

  if (!isCurrentMonth) {
    // Past month — `vel.projected` equals the finished total, so surface
    // it as a recap rather than a forecast.
    //
    // Design-Review-Apr21 P3 (batch 6 follow-up wave P): "that month"
    // is a demonstrative that assumes the reader already has the
    // period in mind. The slot renders independently of its title
    // and may be read in isolation by AT users scanning insight
    // cards, so the reference was ambiguous ("that month" — which?).
    // Replaced with the actual period via formatViewedMonthLabel
    // so each personality branch names the month it's recapping.
    const viewedLabel = formatViewedMonthLabel(viewedMk);
    if (pers === 'roast') {
      return { text: `${viewedLabel.replace(/^./, (c) => c.toUpperCase())} burned ${fmtCur(vel.actual)} at ${fmtCur(vel.dailyRate)}/day. Memorable.`, action: { type: 'goto-budget', label: 'Review plan' } };
    }
    if (pers === 'friendly') {
      return { text: `You spent ${fmtCur(vel.actual)} in ${viewedLabel} (${fmtCur(vel.dailyRate)}/day on average)`, action: { type: 'goto-budget', label: 'Review plan' } };
    }
    return { text: `Total: ${fmtCur(vel.actual)} in ${viewedLabel} (${fmtCur(vel.dailyRate)}/day average)`, action: { type: 'goto-budget', label: 'Review plan' } };
  }

  // Real current month — live forecast is meaningful.
  if (pers === 'roast') {
    return { text: `At ${fmtCur(vel.dailyRate)}/day, you'll spend ${fmtCur(vel.projected)} this month. Yikes.`, action: { type: 'goto-budget', label: 'Adjust plan' } };
  }
  if (pers === 'friendly') {
    return { text: `On track for ${fmtCur(vel.projected)} this month (${fmtCur(vel.dailyRate)}/day)`, action: { type: 'goto-budget', label: 'Adjust plan' } };
  }
  return { text: `Projected: ${fmtCur(vel.projected)} this month (${fmtCur(vel.dailyRate)}/day)`, action: { type: 'goto-budget', label: 'Adjust plan' } };
}

/**
 * CR-Apr22-D slice 4 (finding 67): exported for direct test coverage of
 * the rollover-aware over/under classification — the per-generator tests
 * exercise this helper in isolation from the full `generateInsights`
 * orchestration so the rollover-vs-raw-budget branch can be locked down
 * deterministically without mocking out the other nine generators.
 */
export function insightBudgetAdherence(pers: InsightPersonalityType, _ctx: InsightContext): InsightResult {
  const mk = signals.currentMonth.value;
  const allocRecord = signals.monthlyAlloc.value as Record<string, Record<string, number>>;
  const alloc = allocRecord[mk] || {};
  const cats = Object.keys(alloc);
  if (cats.length === 0) return null;

  // CR-Apr22-D slice 4 (finding 67): apply the same rollover-aware
  // effective-budget calculation used by `getDailyAllowance` / `getSpendingPace`
  // so the insight's over/under count matches the Budget Planner's green/red
  // bar verdict. `calculateMonthRollovers` returns dollars per category;
  // resolve once per call rather than per iteration to keep the forEach cheap.
  const rolloverActive = isRolloverEnabled();
  const rollovers = rolloverActive ? calculateMonthRollovers(mk) : {};

  let over = 0;
  let under = 0;
  cats.forEach(c => {
    // Phase 6 Slice 1i (rev 12 L6): `alloc[c]` is `number | undefined`
    // under `noUncheckedIndexedAccess`; `c` came from `Object.keys(alloc)`
    // so presence is guaranteed, but `?? 0` keeps the comparator typed.
    const spent = getMonthExpByCat(c, mk);
    // CR-Apr22-D slice 4: compare against effective budget in cents to avoid
    // float-compare false positives on threshold-boundary spends. Rollover is
    // a per-category additive — zero when disabled or when the category has
    // no prior-month carryover.
    const effectiveBudgetCents = toCents(alloc[c] ?? 0) +
      (rolloverActive ? toCents(rollovers[c] ?? 0) : 0);
    if (toCents(spent) > effectiveBudgetCents) over++;
    else under++;
  });

  const catWord = (n: number) => n === 1 ? 'category' : 'categories';

  // UI/UX Review (Gamification): use specific "Reallocate" CTA for over-budget
  // state, linking directly to the budget planner's allocation section.
  const overAction = { type: 'goto-budget', label: `Reallocate ${over} ${catWord(over)}` };
  const underAction = { type: 'goto-budget', label: 'View budget' };

  if (pers === 'roast') {
    return {
      text: over > 0 ? `${over} ${catWord(over)} over budget. Classic.` : `All ${under} ${catWord(under)} under budget? Suspicious.`,
      action: over > 0 ? overAction : underAction
    };
  }
  if (pers === 'friendly') {
    return {
      text: over > 0 ? `${under} on track, ${over} over — you can do it!` : `All ${under} ${catWord(under)} on track! Amazing!`,
      action: over > 0 ? overAction : underAction
    };
  }
  return {
    text: `Budget check: ${under} ${catWord(under)} on track, ${over} over budget`,
    action: over > 0 ? overAction : underAction
  };
}

function insightDayOfWeek(pers: InsightPersonalityType, _ctx: InsightContext): InsightResult {
  const monthTx = (getMonthTx()).filter((t: Transaction) => isTrackedExpenseTransaction(t));
  if (monthTx.length < 5) return null;

  // rev 12 #16 / M22 (cents-math migration): accumulate in integer cents.
  // This is a *published* insight gated by a 10% threshold; pre-migration,
  // float accumulation across dozens of .XX transactions could drift by
  // ~3-5 basis points on a 1k-tx month, enough to flip the threshold check
  // and publish (or withhold) an insight that shouldn't have been. Ratios
  // cancel the cents unit, so no `toDollars` round-trip is needed.
  let weekdayCents = 0;
  let weekendCents = 0;
  let wdCount = 0;
  let weCount = 0;

  monthTx.forEach(t => {
    const d = parseLocalDate(t.date).getDay();
    const cents = toCents(t.amount);
    if (d === 0 || d === 6) {
      weekendCents += cents;
      weCount++;
    } else {
      weekdayCents += cents;
      wdCount++;
    }
  });

  if (wdCount === 0 || weCount === 0) return null;

  const wdAvg = weekdayCents / wdCount;
  const weAvg = weekendCents / weCount;
  if (wdAvg === 0) return null; // guard against division-by-zero on all-$0 weekday tx (edge, but possible with refund-only weekdays)
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

  return { text, action: { type: 'filter-category', category: topCat.id, label: 'View spending' } };
}

function insightUnusualSpending(pers: InsightPersonalityType, _ctx: InsightContext): InsightResult {
  const monthTx = (getMonthTx()).filter((t: Transaction) => isTrackedExpenseTransaction(t));
  if (monthTx.length < 3) return null;

  const byCategory: Record<string, number[]> = {};
  monthTx.forEach(t => {
    // Phase 6 Slice 1i (rev 12 L6): `byCategory[t.category]` is
    // `number[] | undefined` under `noUncheckedIndexedAccess`. Pull
    // the array into a local after ensuring it exists, then push —
    // avoids a second index access that TS can't narrow.
    let bucket = byCategory[t.category];
    if (!bucket) {
      bucket = [];
      byCategory[t.category] = bucket;
    }
    bucket.push(t.amount);
  });

  let unusual: UnusualSpending | null = null;
  let unusualCatId: string | null = null;

  for (const [catId, amounts] of Object.entries(byCategory)) {
    if (amounts.length < 2) continue;
    const avg = toDollars(amounts.reduce((sumCents, amount) => sumCents + toCents(amount), 0)) / amounts.length;
    // Phase 5g-3 Slice 3 (Inline-Behavior-Review rev 12, L25): replaced
    // `Math.max(...amounts)` with a reduce-based max. Spread-as-argument
    // hits V8's ~130k argument call-stack limit. Today's scope (single
    // month per category) never approaches that, but this code is a
    // plausible candidate for reuse in an "all-time" or full-history
    // insight mode where a single very-active category ("Groceries",
    // "Restaurants") could easily push tens of thousands of entries.
    // Constant-memory, no stack risk. Paired ESLint rule candidate for
    // action-plan item #48 (`unicorn/no-useless-spread` / similar).
    const max = amounts.reduce((m, a) => (a > m ? a : m), -Infinity);
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

// Exported for unit tests (rev 12 L26 — verifies the skip-on-invalid-target
// contract directly without relying on priority selection).
export function insightSavingsGoal(pers: InsightPersonalityType, _ctx: InsightContext): InsightResult {
  // Fixes H7: signal is canonical `Record<string, SavingsGoal>` post-hydration.
  const goals = Object.entries(signals.savingsGoals.value);
  if (goals.length === 0) return null;

  // Phase 6 Slice 1i (rev 12 L6): `goals[0]` is
  // `[string, SavingsGoal] | undefined` under `noUncheckedIndexedAccess`;
  // the `length === 0` guard guarantees presence, but a local narrow
  // keeps the tuple destructure type-safe.
  const firstGoal = goals[0];
  if (!firstGoal) return null;
  const [_gid, g] = firstGoal;
  // rev 12 L26: skip rather than synthesize a fake percentage when the
  // goal has no usable target. With L42 rejecting invalid targets at the
  // input boundary, this branch should only fire for legacy records that
  // were persisted before L42 landed — in which case showing "0%" or a
  // div-by-zero-masked 100% is worse than just picking a different insight.
  if (!Number.isFinite(g.target) || g.target <= 0) return null;

  const saved = Number.isFinite(g.saved) && g.saved > 0 ? g.saved : 0;
  const target = g.target;
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
  // Design-Review-Apr21 P3 (batch 6 follow-up wave N): all three user-
  // facing branches hardcoded "this month", but the generator computes
  // transfers for `signals.currentMonth`, so the copy drifted whenever
  // the user reviewed another month. `formatViewedMonthPhrase` returns
  // "this month" at current-view default and "in April 2026"-style
  // labels otherwise — the friendly/neutral sentences end with a
  // terminal adverbial so the phrase form (preposition-carrying) fits
  // directly; the roast version already uses "in {count} transfers" so
  // it picks up the phrase at the tail too.
  const monthPhrase = formatViewedMonthPhrase(monthKey);

  if (pers === 'roast') {
    return {
      text: `You moved ${fmtCur(totalMoved)} to savings ${monthPhrase} in ${transferCount} ${transferLabel}. At least that money is behaving.`,
      action: { type: 'filter-category', category: SAVINGS_TRANSFER_CATEGORY_ID, label: 'View transfers' }
    };
  }
  if (pers === 'friendly') {
    return {
      text: `You moved ${fmtCur(totalMoved)} to savings across ${transferCount} ${transferLabel} ${monthPhrase}.`,
      action: { type: 'filter-category', category: SAVINGS_TRANSFER_CATEGORY_ID, label: 'View transfers' }
    };
  }
  return {
    text: `${fmtCur(totalMoved)} moved to savings ${monthPhrase} across ${transferCount} ${transferLabel}`,
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
  const transactions = signals.transactions.value;
  if (transactions.length === 0) {
    // Design-Review-Apr21 P3 (batch 6 follow-up wave P): the
    // brand-new-user empty state hardcoded "this month" / "the
    // month", but the insight slots subscribe to
    // `signals.currentMonth` so this copy also renders when a
    // first-time user lands on April and then scrolls to plan
    // ahead for May. `formatViewedMonthPhrase` returns "this
    // month" for the real current month and "in April 2026" for
    // other views — ideal for insight1's "driving" carrier.
    // `formatViewedMonthLabel` returns the bare "April 2026" form
    // that fits insight3's "keep ${x} intentional" frame cleanly.
    // insight2 stays period-neutral because it's advice about the
    // setup workflow itself, not the viewed month.
    const viewedPhrase = formatViewedMonthPhrase(signals.currentMonth.value);
    const viewedLabel = formatViewedMonthLabel(signals.currentMonth.value);
    return {
      insight1: { text: `Add your first few transactions to reveal what is really driving ${viewedPhrase}.`, action: { type: 'goto-transactions', label: 'Open ledger' } },
      insight2: { text: 'Set a budget early so the dashboard can tell you what is healthy versus risky.', action: { type: 'goto-budget', label: 'Plan budget' } },
      insight3: { text: `Once the basics are in place, review your goals and keep ${viewedLabel} intentional.`, action: { type: 'goto-budget-goals', label: 'Open goals' } }
    };
  }

  const monthTx = getMonthTx();
  // Design-Review-Apr21 P2 (batch 6 follow-up wave M): when the user has
  // history elsewhere but the selected month has no transactions yet,
  // fall through into month-scoped generators would surface misleading
  // copy — a 0% month-change trend, a "$0 projected this month" forecast,
  // a "Top category: — $0.00" line, etc. The slot fallback strings
  // ("Review the ledger to confirm what changed this month.") are also
  // written as if data existed. Gate on `monthTx.length` so a separate
  // empty-month panel surfaces instead, tailored to the "history but
  // not here" case (as opposed to the brand-new-user empty above, which
  // still keys off the global dataset). The future-vs-past distinction
  // is handled by individual generators (see `insightVelocity`'s
  // past/future/current branching); here we only short-circuit when
  // there is literally nothing to say about the viewed month.
  if (monthTx.length === 0) {
    const viewedMk = signals.currentMonth.value;
    const realMk = getMonthKey(new Date());
    const isFutureMonth = viewedMk > realMk;
    const isPastMonth = viewedMk < realMk;
    // Design-Review-Apr21 P3 (batch 6 follow-up wave O): the future/
    // past empty-month branches are only entered when `viewedMk`
    // is strictly not the real current month, so the copy must
    // name the viewed period, not fall back to "this month". The
    // `formatViewedMonthLabel` helper returns a bare month label
    // ("April 2026") for non-current views — ideal here because
    // the carrier sentences supply their own syntactic frame
    // ("plan ahead so ${label} starts intentional", "No activity
    // landed in ${label}"). Using `formatViewedMonthPhrase` would
    // produce either "this month" (wrong — viewedMk ≠ realMk by
    // construction) or "in April 2026" (wrong — "landed in in
    // April 2026" double-prep, "so in April 2026 starts
    // intentional" reads as sentence-fragment).
    const viewedLabel = formatViewedMonthLabel(viewedMk);
    if (isFutureMonth) {
      // Design-Review-Apr21 P3 (batch 6 follow-up wave P): insight3
      // previously said "upcoming months" (plural, unspecified),
      // which drifted away from the branch's focus on a single
      // specific future month. The user is planning ${viewedLabel},
      // not the generic future — naming it keeps the three slots
      // thematically aligned (insight1 and insight2 already
      // reference ${viewedLabel} by name).
      return {
        insight1: { text: `Nothing logged for ${viewedLabel} yet — plan ahead so ${viewedLabel} starts intentional instead of reactive.`, action: { type: 'goto-budget', label: 'Plan budget' } },
        insight2: { text: `Set allocations now so the first few transactions in ${viewedLabel} land in the right categories.`, action: { type: 'goto-budget', label: 'Open allocations' } },
        insight3: { text: `Keep goals fresh so ${viewedLabel} stays aligned with what matters.`, action: { type: 'goto-budget-goals', label: 'Open goals' } }
      };
    }
    if (isPastMonth) {
      return {
        insight1: { text: `No activity landed in ${viewedLabel}, so there is no trend to report here.`, action: { type: 'goto-transactions', label: 'Open ledger' } },
        insight2: { text: `Compare ${viewedLabel} with a month that has activity, or confirm this period is expected to be empty.`, action: { type: 'goto-budget', label: 'Review budget' } },
        insight3: { text: 'Review other months to see how your goals progressed over time.', action: { type: 'goto-budget-goals', label: 'Open goals' } }
      };
    }
    // Real current month with zero transactions but history elsewhere —
    // the user is starting a fresh period but isn't a brand-new user.
    return {
      insight1: { text: 'This month is fresh — log a few transactions to see what this month is really about.', action: { type: 'goto-transactions', label: 'Open ledger' } },
      insight2: { text: 'Confirm this month\u2019s allocations so the first spending lines up with your plan.', action: { type: 'goto-budget', label: 'Review budget' } },
      insight3: { text: 'Check in on your goals to keep momentum from last month.', action: { type: 'goto-budget-goals', label: 'Open goals' } }
    };
  }

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

  // Design-Review-Apr21 P2 (batch 6 follow-up wave N): slot fallback
  // strings used to hardcode "this month" in all three slots, but these
  // fall through from generators that key off `signals.currentMonth` —
  // when the user reviewed a past/future month and every slot generator
  // returned null, the fallback copy still claimed to talk about "this
  // month". Use both helpers per grammatical context:
  //   - `formatViewedMonthPhrase` ("this month" / "in April 2026") for
  //     terminal adverbials ("changed ${phrase}", "driving ${phrase}")
  //   - `formatViewedMonthLabel` ("this month" / "April 2026") for
  //     carrier sentences whose structure already supplies a preposition
  //     or where the label is positioned as the grammatical object
  //     ("keep ${label} aligned")
  const fallbackPhrase = formatViewedMonthPhrase(signals.currentMonth.value);
  const fallbackLabel = formatViewedMonthLabel(signals.currentMonth.value);
  // Design-Review-Apr21 P3 (batch 6 follow-up wave O): slot-3
  // fallback used `driving ${fallbackPhrase}`, which reads fine in
  // the current-month case ("driving this month") but produces a
  // double-preposition construction for past/future views
  // ("driving in April 2026"). Rewriting the carrier around "that
  // shaped ${fallbackLabel}" uses the bare label form — "that
  // shaped this month" reads as an object-position noun phrase,
  // "that shaped April 2026" reads as a specific-period object.
  // Both are grammatical and match the tense of the surface.
  return {
    insight1: pickForSlot(1, `Review the ledger to confirm what changed ${fallbackPhrase}.`),
    insight2: pickForSlot(2, `Open Budget to keep ${fallbackLabel} aligned with your plan.`),
    insight3: pickForSlot(3, `Review the ledger to spot the transactions that shaped ${fallbackLabel}.`)
  };
}

// updateInsights() removed — rendering is handled by reactive components/insights.ts (mountInsights)
