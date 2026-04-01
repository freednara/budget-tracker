/**
 * Analytics UI Module
 * Month comparison rendering and analytics UI components
 *
 * @module analytics-ui
 */
'use strict';

import * as signals from '../../core/signals.js';
import { getPrevMonthKey } from '../../core/utils.js';
import { getMonthTx, calcTotals, getEffectiveIncome, getMonthExpByCat } from '../../features/financial/calculations.js';
import { getAllCats } from '../../core/categories.js';
import { fmtShort } from './chart-renderers.js';
import DOM from '../../core/dom-cache.js';
import { html, nothing, render, repeat, type TemplateResult } from '../../core/lit-helpers.js';

// ==========================================
// TYPES
// ==========================================

type CurrencyFormatter = (amount: number, currency?: string) => string;

interface CategoryChange {
  id: string;
  name: string;
  emoji: string;
  color: string;
  cur: number;
  prev: number;
  diff: number;
  pct: number;
}

// ==========================================
// CURRENCY FORMATTER
// ==========================================

let fmtCurFn: CurrencyFormatter = (v: number) => '$' + v.toFixed(2);

/**
 * Set the currency formatting function
 * @param fn - Currency formatter that takes amount and optional currency code
 */
export function setAnalyticsUiFmtCur(fn: CurrencyFormatter): void {
  fmtCurFn = fn;
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
    const [py, pm] = prevMk.split('-');
    const prevName = new Date(parseInt(py), parseInt(pm) - 1).toLocaleDateString('en-US', { month: 'short' });
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
    render(html`<div class="p-4 rounded-lg text-center text-xs" style="background: var(--bg-input); color: var(--text-tertiary);">No current or previous month activity to compare yet.</div>`, el);
    return;
  }

  // Calculate percentage changes
  const expChange = prevExp > 0 ? Math.round(((curExp - prevExp) / prevExp) * 100) : 0;
  const incChange = prevInc > 0 ? Math.round(((curInc - prevInc) / prevInc) * 100) : 0;
  const savChange = prevSav !== 0 ? Math.round(((curSav - prevSav) / Math.abs(prevSav)) * 100) : 0;

  // Category changes - top 3 biggest movers
  const catChanges: CategoryChange[] = getAllCats('expense')
    .map(c => {
      const cur = getMonthExpByCat(c.id, curMk);
      const prev = getMonthExpByCat(c.id, prevMk);
      const diff = cur - prev;
      const pct = prev > 0 ? Math.round(((cur - prev) / prev) * 100) : (cur > 0 ? 100 : 0);
      return { ...c, cur, prev, diff, pct };
    })
    .filter(c => Math.abs(c.diff) > 5)
    .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff))
    .slice(0, 3);

  // Visual comparison bars
  const maxVal = Math.max(curInc, prevInc, curExp, prevExp, 1);
  const barPct = (v: number): number => Math.round((v / maxVal) * 100);

  render(html`
    ${buildSummaryCards(curExp, curInc, curSav, expChange, incChange, savChange)}
    ${buildComparisonBars(curInc, prevInc, curExp, prevExp, barPct)}
    ${buildCategoryBreakdown(catChanges)}
  `, el);
}

/**
 * Build the summary cards HTML (expenses, income, savings)
 */
function buildSummaryCards(
  curExp: number,
  curInc: number,
  curSav: number,
  expChange: number,
  incChange: number,
  savChange: number
): TemplateResult {
  return html`<div class="grid grid-cols-3 gap-3 mb-4" role="region" aria-label="Month comparison: current vs previous month">
    <div class="p-3 rounded-lg" style="background: var(--bg-input);">
      <p class="text-xs font-bold" style="color: var(--text-secondary);">Expenses</p>
      <p class="text-lg font-black" style="color: var(--color-expense);">${fmtCurFn(curExp)}</p>
      <p class="text-xs" style="color: ${expChange > 0 ? 'var(--color-expense)' : expChange < 0 ? 'var(--color-income)' : 'var(--text-tertiary)'};">${expChange > 0 ? '↑' : expChange < 0 ? '↓' : '—'} ${Math.abs(expChange)}%</p>
    </div>
    <div class="p-3 rounded-lg" style="background: var(--bg-input);">
      <p class="text-xs font-bold" style="color: var(--text-secondary);">Income</p>
      <p class="text-lg font-black" style="color: var(--color-income);">${fmtCurFn(curInc)}</p>
      <p class="text-xs" style="color: ${incChange > 0 ? 'var(--color-income)' : incChange < 0 ? 'var(--color-expense)' : 'var(--text-tertiary)'};">${incChange > 0 ? '↑' : incChange < 0 ? '↓' : '—'} ${Math.abs(incChange)}%</p>
    </div>
    <div class="p-3 rounded-lg" style="background: var(--bg-input);">
      <p class="text-xs font-bold" style="color: var(--text-secondary);">Savings</p>
      <p class="text-lg font-black" style="color: ${curSav >= 0 ? 'var(--color-accent)' : 'var(--color-expense)'};">${fmtCurFn(curSav)}</p>
      <p class="text-xs" style="color: ${savChange > 0 ? 'var(--color-income)' : savChange < 0 ? 'var(--color-expense)' : 'var(--text-tertiary)'};">${savChange > 0 ? '↑' : savChange < 0 ? '↓' : '—'} ${Math.abs(savChange)}%</p>
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
  barPct: (v: number) => number
): TemplateResult {
  return html`<div class="mb-4 p-3 rounded-lg" style="background: var(--bg-input);">
    <div class="flex items-center gap-2 mb-2">
      <span class="text-xs font-bold w-16" style="color: var(--text-secondary);">Income</span>
      <div class="flex-1 flex gap-1 items-center">
        <div class="h-4 rounded" style="width: ${barPct(prevInc)}%; background: var(--color-income); opacity: 0.4;"></div>
        <span class="text-xs" style="color: var(--text-tertiary);">${fmtShort(prevInc)}</span>
      </div>
    </div>
    <div class="flex items-center gap-2 mb-3">
      <span class="text-xs w-16" style="color: var(--text-tertiary);">This mo.</span>
      <div class="flex-1 flex gap-1 items-center">
        <div class="h-4 rounded" style="width: ${barPct(curInc)}%; background: var(--color-income);"></div>
        <span class="text-xs font-bold" style="color: var(--color-income);">${fmtShort(curInc)}</span>
      </div>
    </div>
    <div class="flex items-center gap-2 mb-2">
      <span class="text-xs font-bold w-16" style="color: var(--text-secondary);">Expenses</span>
      <div class="flex-1 flex gap-1 items-center">
        <div class="h-4 rounded" style="width: ${barPct(prevExp)}%; background: var(--color-expense); opacity: 0.4;"></div>
        <span class="text-xs" style="color: var(--text-tertiary);">${fmtShort(prevExp)}</span>
      </div>
    </div>
    <div class="flex items-center gap-2">
      <span class="text-xs w-16" style="color: var(--text-tertiary);">This mo.</span>
      <div class="flex-1 flex gap-1 items-center">
        <div class="h-4 rounded" style="width: ${barPct(curExp)}%; background: var(--color-expense);"></div>
        <span class="text-xs font-bold" style="color: var(--color-expense);">${fmtShort(curExp)}</span>
      </div>
    </div>
  </div>`;
}

/**
 * Build the category breakdown HTML
 */
function buildCategoryBreakdown(catChanges: CategoryChange[]): TemplateResult | typeof nothing {
  if (!catChanges.length) return nothing;

  return html`<div class="p-3 rounded-lg" style="background: var(--bg-input);">
    <p class="text-xs font-bold mb-2" style="color: var(--text-secondary);">Biggest Changes</p>
    ${repeat(catChanges, (change) => change.id, (change) => {
      const isUp = change.diff > 0;
      return html`<div class="flex justify-between items-center py-1">
        <span class="text-xs" style="color: var(--text-primary);">${change.emoji} ${change.name}</span>
        <span class="text-xs font-bold" style="color: ${isUp ? 'var(--color-expense)' : 'var(--color-income)'};">${isUp ? '+' : ''}${fmtCurFn(change.diff)} (${isUp ? '+' : ''}${change.pct}%)</span>
      </div>`;
    })}
  </div>`;
}
