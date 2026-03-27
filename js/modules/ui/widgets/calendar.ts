/**
 * Calendar Module
 * 
 * Reactive calendar heatmap rendering and day selection using signals and Lit.
 * Shows spending/income by day with bill indicators.
 */
'use strict';

import * as signals from '../../core/signals.js';
import { calendar as calendarActions } from '../../core/state-actions.js';
import { parseMonthKey, parseLocalDate, getMonthKey } from '../../core/utils.js';
import { getCatInfo } from '../../core/categories.js';
import { isTrackedExpenseTransaction } from '../../core/transaction-classification.js';
import { getMonthTx } from '../../features/financial/calculations.js';
import { openTransactionsForDate, openTransactionsEdit } from '../core/ui-navigation.js';
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
  calendarActions.setSelectedDay(day);
}

/**
 * Reset selection
 */
export function resetCalendarSelection(): void {
  calendarActions.clearSelectedDay();
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
  const summaryContainer = DOM.get('calendar-upcoming-summary');
  if (!container) return () => {};

  const monthData = computed(() => {
    const mk = signals.currentMonth.value;
    const txs = getMonthTx(mk);
    const bills = getBillsForMonth(mk);
    return {
      mk,
      txs,
      bills,
      isEmpty: txs.length === 0 && bills.size === 0
    };
  });

  const monthCleanup = effect(() => {
    const { mk, txs, bills, isEmpty } = monthData.value;
    const selectedDay = signals.selectedCalendarDay.peek();

    if (badgeContainer) {
      const [y, m] = mk.split('-');
      const monthName = new Date(parseInt(y), parseInt(m) - 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
      render(html`<span class="time-badge">${monthName}</span>`, badgeContainer);
    }

    if (isEmpty) {
      render(html`<div class="p-4 rounded-lg text-center text-xs" style="background: var(--bg-input); color: var(--text-tertiary);">No calendar activity for this month yet.</div>`, container);
      if (detailContainer) {
        render(html`
          <div class="calendar-detail-empty">
            <p class="calendar-detail-empty__title">No calendar activity yet</p>
            <p class="calendar-detail-empty__body">Add transactions or recurring bills to plan the month day by day.</p>
          </div>
        `, detailContainer);
      }
      if (summaryContainer) {
        render(html`
          <div class="calendar-summary-card">
            <p class="calendar-summary-card__label">Activity Days</p>
            <p class="calendar-summary-card__value">0</p>
            <p class="calendar-summary-card__meta">No recorded days in this month yet.</p>
          </div>
          <div class="calendar-summary-card">
            <p class="calendar-summary-card__label">Recurring Bills</p>
            <p class="calendar-summary-card__value">0</p>
            <p class="calendar-summary-card__meta">No recurring bill activity scheduled for this month.</p>
          </div>
          <div class="calendar-summary-card">
            <p class="calendar-summary-card__label">Next Planning Step</p>
            <p class="calendar-summary-card__value calendar-summary-card__value--small">Add your first transaction</p>
            <p class="calendar-summary-card__meta">The calendar tab will start highlighting busy days automatically.</p>
          </div>
        `, summaryContainer);
      }
      return;
    }

    renderCalendarGrid(container, mk, txs, bills, selectedDay);
  });

  const selectionCleanup = effect(() => {
    const { mk, txs, bills, isEmpty } = monthData.value;
    const selectedDay = signals.selectedCalendarDay.value;

    updateCalendarSelection(container, selectedDay);

    if (isEmpty) {
      return;
    }

    if (detailContainer) {
      renderDetailPanel(detailContainer, mk, selectedDay, txs, bills);
    }

    if (summaryContainer) {
      renderSummaryStrip(summaryContainer, mk, txs, bills, selectedDay);
    }
  });

  return () => {
    monthCleanup();
    selectionCleanup();
  };
}

function updateCalendarSelection(container: HTMLElement, selectedDay: number | null): void {
  const dayCells = container.querySelectorAll<HTMLElement>('.cal-day');
  dayCells.forEach((cell) => {
    const day = Number(cell.dataset.day || 0);
    const isSelected = selectedDay !== null && day === selectedDay;
    cell.classList.toggle('cal-selected', isSelected);
    cell.tabIndex = isSelected ? 0 : -1;
  });
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

function renderSummaryStrip(
  container: HTMLElement,
  mk: string,
  txs: Transaction[],
  billsMap: Map<number, BillInfo[]>,
  selectedDay: number | null
): void {
  const monthDate = parseMonthKey(mk);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const activeDays = new Set<number>();
  txs.forEach((tx) => activeDays.add(parseLocalDate(tx.date).getDate()));
  billsMap.forEach((_bills, day) => activeDays.add(day));

  const billEntries = Array.from(billsMap.values()).flat();
  const upcomingBills = billEntries
    .filter((bill) => !bill.isPaid && (getMonthKey(today) !== mk || parseLocalDate(bill.date) >= today))
    .sort((a, b) => a.date.localeCompare(b.date));
  const nextUpcomingBill = upcomingBills[0] || null;

  const selectedDateLabel = selectedDay
    ? new Date(monthDate.getFullYear(), monthDate.getMonth(), selectedDay).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric'
      })
    : 'No day selected';

  render(html`
    <div class="calendar-summary-card">
      <p class="calendar-summary-card__label">Activity Days</p>
      <p class="calendar-summary-card__value">${activeDays.size}</p>
      <p class="calendar-summary-card__meta">${activeDays.size === 1 ? '1 active day' : `${activeDays.size} days with spending, income, or recurring activity`}</p>
    </div>
    <div class="calendar-summary-card">
      <p class="calendar-summary-card__label">Upcoming Bills</p>
      <p class="calendar-summary-card__value">${upcomingBills.length}</p>
      <p class="calendar-summary-card__meta">
        ${nextUpcomingBill
          ? `Next due: ${nextUpcomingBill.description || nextUpcomingBill.categoryName} on ${new Date(nextUpcomingBill.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
          : 'No unpaid recurring bills left in this month.'}
      </p>
    </div>
    <div class="calendar-summary-card">
      <p class="calendar-summary-card__label">Selected Day</p>
      <p class="calendar-summary-card__value calendar-summary-card__value--small">${selectedDateLabel}</p>
      <p class="calendar-summary-card__meta">
        ${selectedDay ? 'Inspect the day details or jump straight into the transaction form.' : 'Pick a day on the calendar to review activity and plan from that date.'}
      </p>
    </div>
  `, container);
}

function renderDetailPanel(container: HTMLElement, mk: string, day: number | null, txs: Transaction[], billsMap: Map<number, BillInfo[]>): void {
  if (!day) {
    render(html`
      <div class="calendar-detail-empty">
        <p class="calendar-detail-empty__title">Select a day</p>
        <p class="calendar-detail-empty__body">Choose a date to inspect transactions, review recurring bills, or jump into the transaction form for that day.</p>
      </div>
    `, container);
    return;
  }

  const dayTx = txs.filter(t => parseLocalDate(t.date).getDate() === day);
  const dayBills = billsMap.get(day) || [];
  const fmtCur = getDefaultContainer().resolveSync<CurrencyFormatter>(Services.CURRENCY_FORMATTER);
  const selectedDate = `${mk}-${String(day).padStart(2, '0')}`;
  const selectedDateLabel = new Date(`${selectedDate}T00:00:00`).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric'
  });

  if (dayTx.length === 0 && dayBills.length === 0) {
    render(html`
      <div class="calendar-detail-panel">
        <div class="calendar-day-actions">
          <div>
            <p class="calendar-day-actions__label">${selectedDateLabel}</p>
            <p class="calendar-day-actions__meta">No activity recorded on this day yet.</p>
          </div>
          <button
            type="button"
            class="btn btn-primary calendar-day-actions__button"
            @click=${() => void openTransactionsForDate(selectedDate)}
          >
            Add Transaction
          </button>
        </div>
      </div>
    `, container);
    return;
  }

  render(html`
    <div class="calendar-detail-panel">
      <div class="calendar-day-actions">
        <div>
          <p class="calendar-day-actions__label">${selectedDateLabel}</p>
          <p class="calendar-day-actions__meta">
            ${dayTx.length} transaction${dayTx.length === 1 ? '' : 's'} · ${dayBills.length} recurring bill${dayBills.length === 1 ? '' : 's'}
          </p>
        </div>
        <button
          type="button"
          class="btn btn-primary calendar-day-actions__button"
          @click=${() => void openTransactionsForDate(selectedDate)}
        >
          Add Transaction
        </button>
      </div>

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
                <div class="flex-1 min-w-0 pr-2">
                  <span class="text-xs font-medium text-primary">${cat.emoji} ${t.description || cat.name}</span>
                </div>
                <div class="flex items-center gap-2">
                  <span class="text-xs font-black ${t.type === 'expense' ? 'text-expense' : 'text-income'}">
                    ${t.type === 'expense' ? '-' : '+'}${fmtCur(t.amount)}
                  </span>
                  <button
                    type="button"
                    class="calendar-detail-edit-btn"
                    aria-label="Edit transaction ${t.description || cat.name}"
                    @click=${() => void openTransactionsEdit(t)}
                  >
                    Edit
                  </button>
                </div>
              </div>
            `;
          })}
        </div>
      ` : ''}
      </div>
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
