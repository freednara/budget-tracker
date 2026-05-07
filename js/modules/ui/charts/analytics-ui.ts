/**
 * Analytics UI Module
 * Month comparison rendering and analytics UI components
 *
 * @module analytics-ui
 */
'use strict';

import * as signals from '../../core/signals.js';
import { getPrevMonthKey, monthKeyParts, fmtCur } from '../../core/utils-pure.js';
import { getMonthTx, calcTotals, getEffectiveIncome, getMonthExpByCat } from '../../features/financial/calculations.js';
import { getAllCats } from '../../core/categories.js';
import { fmtShort } from './chart-renderers.js';
import { formatMonthShort } from '../../core/locale-service.js';
import DOM from '../../core/dom-cache.js';
import { html, nothing, render, repeat, type TemplateResult } from '../../core/lit-helpers.js';
import { computeBaselineDelta, type BaselineDelta } from '../../core/baseline.js';

// ==========================================
// TYPES
// ==========================================

interface CategoryChange {
  id: string;
  name: string;
  emoji: string;
  color: string;
  cur: number;
  prev: number;
  diff: number;
  /**
   * Structured baseline classification of `cur` against `prev`.
   *
   * Design-Review-Apr21 batch 7 (7a): prior implementation stored a raw
   * `pct: number` and fabricated `+100%` for brand-new categories (prev=0,
   * cur>0). That collapsed a `0 → $6` first-time spend and a `0 → $600`
   * blowout into the same "+100%" badge. Routing through
   * `computeBaselineDelta` lets the renderer surface "New" for these
   * cases and a real signed percent for comparable ones.
   */
  baseline: BaselineDelta;
}

/**
 * Render a signed percent chip with up/down/flat glyph.
 *
 * Centralizes the three-way presentation (increase / decrease / flat / new /
 * no-data) so the month-comparison summary cards can't drift out of sync
 * with the baseline-delta contract. `increaseIsBad` flips the semantic color
 * pairing — expenses "going up" is bad (expense color), income/savings
 * "going up" is good (income color).
 */
function renderDeltaChip(d: BaselineDelta, increaseIsBad: boolean): TemplateResult {
  if (d.status === 'no-data') {
    return html`<span class="text-tertiary">—</span>`;
  }
  if (d.status === 'new') {
    // "New" is informational — pick the positive color so a first-time
    // income or first-time expense both read as a neutral arrival rather
    // than a panic signal.
    return html`<span class="text-tertiary">New</span>`;
  }
  const pct = d.percent ?? 0;
  const rounded = Math.round(pct);
  if (rounded === 0) {
    return html`<span class="text-tertiary">— 0%</span>`;
  }
  // XOR: a positive outcome is "decrease when increase is bad" or "increase
  // when increase is good" — i.e. direction matches desirability exactly when
  // the two disagree, which is the XOR of `rounded > 0` and `increaseIsBad`.
  const isPositiveOutcome = (rounded > 0) !== increaseIsBad;
  const cls = isPositiveOutcome ? 'text-income' : 'text-expense';
  const glyph = rounded > 0 ? '↑' : '↓';
  return html`<span class="${cls}">${glyph} ${Math.abs(rounded)}%</span>`;
}

// ==========================================
// RENDER FUNCTIONS
// ==========================================

/**
 * Render the month-over-month comparison section
 * Shows expenses, income, savings changes and top category movers
 */
export function renderMonthComparison(): void {
  const el = DOM.get('month-comparison');
  if (!el) return;

  const curMk = signals.currentMonth.value;
  const prevMk = getPrevMonthKey(curMk);

  // Update badge with previous month name
  const compBadge = DOM.get('month-comparison-badge');
  if (compBadge) {
    const [py, pm] = monthKeyParts(prevMk);
    const prevName = formatMonthShort(new Date(py, pm - 1));
    render(html`<span class="time-badge">vs ${prevName}</span>`, compBadge);
  }

  // Calculate totals for both months
  const curExp = calcTotals(getMonthTx(curMk)).expenses;
  const prevExp = calcTotals(getMonthTx(prevMk)).expenses;
  const curInc = getEffectiveIncome(curMk);
  const prevInc = getEffectiveIncome(prevMk);
  const curSav = curInc - curExp;
  const prevSav = prevInc - prevExp;

  if (curExp === 0 && prevExp === 0 && curInc === 0 && prevInc === 0) {
    // Design-Review-Apr21 P3 (batch 6 follow-up wave N): copy used to
    // read "No current or previous month activity to compare yet.",
    // but the comparison is `curMk` vs `prevMk` — both derive from
    // `signals.currentMonth`, so "current" was inaccurate whenever the
    // user was reviewing a past/future month. Period-neutral phrasing
    // ("selected" vs "prior") works across the whole month-picker range.
    render(html`<div class="p-4 rounded-lg text-center text-xs analytics-bar-track text-tertiary">No activity in the selected month or the prior month to compare yet.</div>`, el);
    return;
  }

  // Design-Review-Apr21 batch 7 (7a): percentage changes now route through
  // `computeBaselineDelta` so degenerate baselines (prev=0) surface as
  // "new" instead of being fabricated as "+0%" (expenses/income) or folded
  // into a misleading flat number (savings). The helper also handles the
  // negative-savings case correctly via `Math.abs(prev)` in the denominator.
  const expDelta = computeBaselineDelta(curExp, prevExp);
  const incDelta = computeBaselineDelta(curInc, prevInc);
  const savDelta = computeBaselineDelta(curSav, prevSav);

  // Category changes — sorted by absolute magnitude. The top 3 display
  // by default; a "View All" toggle reveals the rest for power users
  // (UI/UX Review Final, recommendation 1).
  const catChanges: CategoryChange[] = getAllCats('expense')
    .map(c => {
      const cur = getMonthExpByCat(c.id, curMk);
      const prev = getMonthExpByCat(c.id, prevMk);
      const diff = cur - prev;
      const baseline = computeBaselineDelta(cur, prev);
      return { ...c, cur, prev, diff, baseline };
    })
    .filter(c => Math.abs(c.diff) > 5)
    .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));

  // Visual comparison bars
  const maxVal = Math.max(curInc, prevInc, curExp, prevExp, 1);
  const barPct = (v: number): number => Math.round((v / maxVal) * 100);

  // Design-Review-Apr21 P3 (batch 6 follow-up wave N): derive the short
  // month label for the selected-month rows in the comparison bars.
  // Previously those rows were hardcoded to "This mo." — when the user
  // navigated to a past/future month the shorthand still read as the
  // real current month. Routing through `formatMonthShort` ties the
  // row label to the same period the bar is actually plotting, and
  // pairs naturally with the previous-month "vs March 2026" badge.
  const [cy, cm] = monthKeyParts(curMk);
  const curMonthShort = formatMonthShort(new Date(cy, cm - 1));

  render(html`
    ${buildSummaryCards(curExp, curInc, curSav, expDelta, incDelta, savDelta)}
    ${buildComparisonBars(curInc, prevInc, curExp, prevExp, barPct, curMonthShort)}
    ${buildCategoryBreakdown(catChanges)}
  `, el);
}

/**
 * Build the summary cards HTML (expenses, income, savings).
 *
 * Each card renders the delta chip via `renderDeltaChip`, which centralizes
 * the direction/color/new/no-data presentation so the three cards can't
 * drift apart. `increaseIsBad` flips the sense for expenses (where going up
 * is a negative signal) vs income/savings (where going up is positive).
 */
function buildSummaryCards(
  curExp: number,
  curInc: number,
  curSav: number,
  expDelta: BaselineDelta,
  incDelta: BaselineDelta,
  savDelta: BaselineDelta
): TemplateResult {
  return html`<div class="grid grid-cols-3 gap-3 mb-4" role="region" aria-label="Month comparison: current vs previous month">
    <div class="analytics-summary-card">
      <p class="text-xs font-bold text-secondary">Expenses</p>
      <p class="text-lg font-black text-expense">${fmtCur(curExp)}</p>
      <p class="text-xs">${renderDeltaChip(expDelta, /* increaseIsBad */ true)}</p>
    </div>
    <div class="analytics-summary-card">
      <p class="text-xs font-bold text-secondary">Income</p>
      <p class="text-lg font-black text-income">${fmtCur(curInc)}</p>
      <p class="text-xs">${renderDeltaChip(incDelta, /* increaseIsBad */ false)}</p>
    </div>
    <div class="analytics-summary-card">
      <p class="text-xs font-bold text-secondary">Savings</p>
      <p class="text-lg font-black ${curSav >= 0 ? 'text-accent' : 'text-expense'}">${fmtCur(curSav)}</p>
      <p class="text-xs">${renderDeltaChip(savDelta, /* increaseIsBad */ false)}</p>
    </div>
  </div>`;
}

/**
 * Build the comparison bars HTML
 */
function buildComparisonBars(
  curInc: number,
  prevInc: number,
  curExp: number,
  prevExp: number,
  barPct: (v: number) => number,
  // Design-Review-Apr21 P3 (batch 6 follow-up wave N): selected-month
  // short label ("Apr") replaces the hardcoded "This mo." row labels so
  // the bar chart stays accurate when the user is comparing March or
  // any other historical month. Caller derives via `formatMonthShort`
  // from `signals.currentMonth.value`.
  curMonthShort: string
): TemplateResult {
  return html`<div class="mb-4 p-3 rounded-lg analytics-bar-track">
    <div class="flex items-center gap-2 mb-2">
      <span class="text-xs font-bold w-16 text-secondary">Income</span>
      <div class="flex-1 flex gap-1 items-center">
        <div class="h-4 rounded" style="width: ${barPct(prevInc)}%; background: var(--color-income); opacity: 0.4;"></div>
        <span class="text-xs text-tertiary">${fmtShort(prevInc)}</span>
      </div>
    </div>
    <div class="flex items-center gap-2 mb-3">
      <span class="text-xs w-16 text-tertiary">${curMonthShort}</span>
      <div class="flex-1 flex gap-1 items-center">
        <div class="h-4 rounded" style="width: ${barPct(curInc)}%; background: var(--color-income);"></div>
        <span class="text-xs font-bold text-income">${fmtShort(curInc)}</span>
      </div>
    </div>
    <div class="flex items-center gap-2 mb-2">
      <span class="text-xs font-bold w-16 text-secondary">Expenses</span>
      <div class="flex-1 flex gap-1 items-center">
        <div class="h-4 rounded" style="width: ${barPct(prevExp)}%; background: var(--color-expense); opacity: 0.4;"></div>
        <span class="text-xs text-tertiary">${fmtShort(prevExp)}</span>
      </div>
    </div>
    <div class="flex items-center gap-2">
      <span class="text-xs w-16 text-tertiary">${curMonthShort}</span>
      <div class="flex-1 flex gap-1 items-center">
        <div class="h-4 rounded" style="width: ${barPct(curExp)}%; background: var(--color-expense);"></div>
        <span class="text-xs font-bold text-expense">${fmtShort(curExp)}</span>
      </div>
    </div>
  </div>`;
}

/**
 * Build the category breakdown HTML.
 *
 * Design-Review-Apr21 batch 7 (7a): the trailing "(+N%)" token now branches
 * on `baseline.status`. For categories with no prior-month spend (`status
 * === 'new'`) the renderer shows "(New)" instead of the fabricated "+100%"
 * that the old `prev > 0 ? pct : (cur > 0 ? 100 : 0)` idiom produced. The
 * raw dollar `diff` is still shown so the user sees magnitude regardless
 * of whether a percent is meaningful.
 *
 * UI/UX Review Final: added "View All / Show Less" toggle when more than 3
 * categories have changed, giving power users deeper visibility.
 */

// Module-level expansion state for the "View All" toggle. Resets each
// time the component re-renders from a new month, which is the expected
// behavior — expanding carries across re-renders within the same month.
let _catChangesExpanded = false;

function buildCategoryBreakdown(catChanges: CategoryChange[]): TemplateResult | typeof nothing {
  if (!catChanges.length) return nothing;

  const DEFAULT_VISIBLE = 3;
  const hasMore = catChanges.length > DEFAULT_VISIBLE;
  const visible = _catChangesExpanded ? catChanges : catChanges.slice(0, DEFAULT_VISIBLE);

  const renderRow = (change: CategoryChange) => {
    const isUp = change.diff > 0;
    let pctLabel: string;
    if (change.baseline.status === 'new') {
      pctLabel = 'New';
    } else if (change.baseline.status === 'no-data') {
      pctLabel = '—';
    } else {
      const pct = Math.round(change.baseline.percent ?? 0);
      pctLabel = `${pct > 0 ? '+' : ''}${pct}%`;
    }
    return html`<div class="flex justify-between items-center py-1">
      <span class="text-xs text-primary">${change.emoji} ${change.name}</span>
      <span class="text-xs font-bold ${isUp ? 'text-expense' : 'text-income'}">${isUp ? '+' : ''}${fmtCur(change.diff)} (${pctLabel})</span>
    </div>`;
  };

  const handleToggle = () => {
    _catChangesExpanded = !_catChangesExpanded;
    // Re-render the analytics panel to reflect the toggle
    renderMonthComparison();
  };

  return html`<div class="p-3 rounded-lg analytics-bar-track">
    <p class="text-xs font-bold mb-2 text-secondary">Biggest Changes</p>
    ${repeat(visible, (change) => change.id, renderRow)}
    ${hasMore ? html`
      <button class="btn-ghost w-full text-center text-xs font-semibold mt-1 py-1"
        @click=${handleToggle}
        aria-expanded=${_catChangesExpanded ? 'true' : 'false'}>
        ${_catChangesExpanded
          ? `Show Less`
          : `View All (${catChanges.length})`}
      </button>
    ` : nothing}
  </div>`;
}
