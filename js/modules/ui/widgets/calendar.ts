/**
 * Calendar Module
 * 
 * Reactive calendar heatmap rendering and day selection using signals and Lit.
 * Shows spending/income by day with bill indicators.
 */
'use strict';

import * as signals from '../../core/signals.js';
import { parseMonthKey, parseLocalDate, getMonthKey } from '../../core/utils.js';
import { getCatInfo } from '../../core/categories.js';
import { isTrackedExpenseTransaction } from '../../core/transaction-classification.js';
import { getMonthTx } from '../../features/financial/calculations.js';
import DOM from '../../core/dom-cache.js';
import { html, render, repeat, classMap } from '../../core/lit-helpers.js';
import { effect, computed } from '@preact/signals-core';
import { getDefaultContainer, Services } from '../../core/di-container.js';
import type { Transaction } from '../../../types/index.js';

// ==========================================
// TYPE DEFINITIONS
// ==========================================

interface BillInfo {
  id: string;
  category: string;
  categoryName: string;
  emoji: string;
  amount: number;
  description: string;
  isPaid: boolean;
  isUpcoming: boolean;
  date: string;
}

type CurrencyFormatter = (value: number) => string;

// ==========================================
// ACTIONS
// ==========================================

/**
 * Select a calendar day
 */
export function selectDay(day: number | null): void {
  signals.selectedCalendarDay.value = day;
}

/**
 * Reset selection
 */
export function resetCalendarSelection(): void {
  signals.selectedCalendarDay.value = null;
}

// ==========================================
// BADGE
// ==========================================

/**
 * Get month badge HTML (re-exported from core/utils-dom for backwards compat)
 */
export { getMonthBadge } from '../../core/utils-dom.js';

// ==========================================
// DATA FETCHERS
// ==========================================

/**
 * Get upcoming bills for a specific month
 */
function getBillsForMonth(monthKey: string): Map<number, BillInfo[]> {
  const viewDate = parseMonthKey(monthKey);
  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const billsMap = new Map<number, BillInfo[]>();

  signals.transactions.value.forEach((t: Transaction) => {
    if (t.recurring !== true || t.type !== 'expense') return;

    const txDate = parseLocalDate(t.date);
    if (txDate.getFullYear() !== year || txDate.getMonth() !== month) return;

    const day = txDate.getDate();
    if (!billsMap.has(day)) billsMap.set(day, []);

    const cat = getCatInfo(t.type, t.category);
    billsMap.get(day)!.push({
      id: t.__backendId,
      category: t.category,
      categoryName: cat.name,
      emoji: cat.emoji,
      amount: t.amount,
      description: t.description,
      isPaid: !!t.reconciled,
      isUpcoming: txDate >= today,
      date: t.date
    });
  });

  return billsMap;
}

// ==========================================
// RENDERER
// ==========================================

/**
 * Mount the reactive calendar component
 */
export function mountCalendar(): () => void {
  const container = DOM.get('spending-heatmap');
  const detailContainer = DOM.get('cal-detail-panel');
  const badgeContainer = DOM.get('calendar-badge');
  if (!container) return () => {};

  const cleanup = effect(() => {
    const mk = signals.currentMonth.value;
    const selectedDay = signals.selectedCalendarDay.value;
    const txs = getMonthTx(mk);
    const bills = getBillsForMonth(mk);
    
    // 1. Update Month Badge
    if (badgeContainer) {
      const [y, m] = mk.split('-');
      const monthName = new Date(parseInt(y), parseInt(m) - 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
      render(html`<span class="time-badge">${monthName}</span>`, badgeContainer);
    }

    // 2. Render Main Grid
    renderCalendarGrid(container, mk, txs, bills, selectedDay);

    // 3. Render Detail Panel
    if (detailContainer) {
      renderDetailPanel(detailContainer, selectedDay, txs, bills);
    }
  });

  return cleanup;
}

function renderCalendarGrid(container: HTMLElement, mk: string, txs: Transaction[], bills: Map<number, BillInfo[]>, selectedDay: number | null): void {
  const viewDate = parseMonthKey(mk);
  const year = viewDate.getFullYear(), month = viewDate.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstDow = new Date(year, month, 1).getDay();

  // Data maps
  const dailySpend: Record<number, number> = {};
  const dailyIncome: Record<number, number> = {};
  txs.forEach(t => {
    const day = parseLocalDate(t.date).getDate();
    if (isTrackedExpenseTransaction(t)) dailySpend[day] = (dailySpend[day] || 0) + (t.amount || 0);
    else dailyIncome[day] = (dailyIncome[day] || 0) + (t.amount || 0);
  });

  const maxSpend = Math.max(...Object.values(dailySpend), 1);
  const today = new Date();
  const todayDay = (getMonthKey(today) === mk) ? today.getDate() : -1;

  // Build rows/weeks
  const rows: any[] = [];
  let dayNum = 1;

  while (dayNum <= daysInMonth) {
    const week: any[] = [];
    let weekTotal = 0;

    for (let i = 0; i < 7; i++) {
      if ((rows.length === 0 && i < firstDow) || dayNum > daysInMonth) {
        week.push(null);
      } else {
        const spend = dailySpend[dayNum] || 0;
        weekTotal += spend;
        week.push({
          day: dayNum,
          spend,
          income: dailyIncome[dayNum] || 0,
          isToday: dayNum === todayDay,
          isSelected: dayNum === selectedDay,
          bills: bills.get(dayNum) || []
        });
        dayNum++;
      }
    }
    rows.push({ week, weekTotal });
  }

  const fmtCur = getDefaultContainer().resolveSync<CurrencyFormatter>(Services.CURRENCY_FORMATTER);

  render(html`
    <div class="cal-grid" role="grid" aria-label="Monthly Spending Calendar">
      <div class="cal-header"></div>
      ${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d => html`<div class="cal-header">${d}</div>`)}

      ${rows.map(row => html`
        <div class="cal-week-total">${row.weekTotal > 0 ? fmtShort(row.weekTotal) : ''}</div>
        ${row.week.map((cell: any) => {
          if (!cell) return html`<div class="cal-empty"></div>`;
          
          const intensity = Math.min(cell.spend / maxSpend, 1);
          const bg = cell.spend > 0 
            ? `color-mix(in srgb, var(--color-expense) ${Math.round(intensity * 70 + 10)}%, transparent)`
            : (cell.income > 0 ? 'color-mix(in srgb, var(--color-income) 12%, transparent)' : 'transparent');

          return html`
            <div class=${classMap({ 'cal-day': true, 'cal-today': cell.isToday, 'cal-selected': cell.isSelected })}
                 data-day="${cell.day}"
                 style="background: ${bg}"
                 tabindex="${cell.isSelected ? '0' : '-1'}"
                 @click=${() => selectDay(cell.day)}>
              <span class="cal-day-num">${cell.day}</span>
              
              ${cell.bills.length > 0 ? html`
                <div class="cal-bill-indicator ${cell.bills.some((b: any) => b.isUpcoming && !b.isPaid) ? 'cal-bill-upcoming' : (cell.bills.some((b: any) => b.isPaid) ? 'cal-bill-paid' : '')}">
                  <span class="cal-bill-dot"></span>
                  ${cell.bills.length > 1 ? html`<span class="cal-bill-count">${cell.bills.length}</span>` : ''}
                </div>
              ` : ''}

              ${cell.spend > 0 ? html`<span class="cal-day-amt text-expense">${fmtShort(cell.spend)}</span>` : ''}
              ${cell.income > 0 && cell.spend === 0 ? html`<span class="cal-day-amt text-income">+${fmtShort(cell.income)}</span>` : ''}
            </div>
          `;
        })}
      `)}
    </div>
  `, container);
}

function renderDetailPanel(container: HTMLElement, day: number | null, txs: Transaction[], billsMap: Map<number, BillInfo[]>): void {
  if (!day) {
    render(html``, container);
    return;
  }

  const dayTx = txs.filter(t => parseLocalDate(t.date).getDate() === day);
  const dayBills = billsMap.get(day) || [];
  const fmtCur = getDefaultContainer().resolveSync<CurrencyFormatter>(Services.CURRENCY_FORMATTER);

  if (dayTx.length === 0 && dayBills.length === 0) {
    render(html`<div class="mt-3 p-4 text-center text-xs text-tertiary">No activity on this day</div>`, container);
    return;
  }

  render(html`
    <div class="mt-3 space-y-2">
      ${dayBills.length > 0 ? html`
        <div class="p-3 rounded-xl bg-warning/10 border border-warning/20">
          <p class="text-[10px] font-black uppercase tracking-widest text-warning mb-2">Recurring Bills</p>
          ${dayBills.map(b => html`
            <div class="flex justify-between items-center py-1">
              <span class="text-xs font-bold text-primary">${b.emoji} ${b.description || b.categoryName}</span>
              <div class="flex items-center gap-2">
                <span class="text-xs font-black text-expense">${fmtCur(b.amount)}</span>
                <span class="text-[9px] font-bold px-1.5 py-0.5 rounded ${b.isPaid ? 'bg-income/20 text-income' : 'bg-warning/20 text-warning'}">
                  ${b.isPaid ? 'PAID' : 'DUE'}
                </span>
              </div>
            </div>
          `)}
        </div>
      ` : ''}

      ${dayTx.length > 0 ? html`
        <div class="p-3 rounded-xl bg-input">
          <p class="text-[10px] font-black uppercase tracking-widest text-tertiary mb-2">Transactions</p>
          ${dayTx.map(t => {
            const cat = getCatInfo(t.type, t.category);
            return html`
              <div class="flex justify-between items-center py-1">
                <span class="text-xs font-medium text-primary">${cat.emoji} ${t.description || cat.name}</span>
                <span class="text-xs font-black ${t.type === 'expense' ? 'text-expense' : 'text-income'}">
                  ${t.type === 'expense' ? '-' : '+'}${fmtCur(t.amount)}
                </span>
              </div>
            `;
          })}
        </div>
      ` : ''}
    </div>
  `, container);
}

/**
 * Format number in short form (e.g., 1.2k)
 */
function fmtShort(v: number): string {
  const symbol = signals.currency.value.symbol;
  const abs = Math.abs(v);
  if (abs >= 1000) return symbol + (abs/1000).toFixed(abs >= 10000 ? 0 : 1) + 'k';
  return symbol + Math.round(abs);
}

/**
 * Legacy support for renderCalendar (now reactive)
 */
export function renderCalendar(): void {
  // Logic is now automatic via signals.currentMonth and mountCalendar
}
