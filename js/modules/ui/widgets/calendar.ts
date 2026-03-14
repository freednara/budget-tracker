/**
 * Calendar Module
 *
 * Calendar heatmap rendering and day selection.
 * Shows spending/income by day with bill indicators.
 *
 * @module calendar
 * @requires state
 * @requires utils
 * @requires categories
 * @requires calculations
 */
'use strict';

import * as signals from '../../core/signals.js';
import { parseMonthKey, parseLocalDate, getMonthKey, esc } from '../../core/utils.js';
import { getCatInfo } from '../../core/categories.js';
import { getMonthTx } from '../../features/financial/calculations.js';
import DOM from '../../core/dom-cache.js';
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

interface CalendarConfig {
  CALENDAR_INTENSITY: {
    base: number;
    multiplier: number;
  };
}

type CurrencyFormatter = (value: number) => string;

// ==========================================
// MODULE STATE
// ==========================================

// Module-level state for calendar selection
let calSelectedDay: number | null = null;

// Configuration for calendar intensity (passed from app.js)
let calendarConfig: CalendarConfig = {
  CALENDAR_INTENSITY: { base: 10, multiplier: 70 }
};

/**
 * Set calendar configuration
 */
export function setCalendarConfig(config: Partial<CalendarConfig>): void {
  if (config.CALENDAR_INTENSITY) {
    calendarConfig.CALENDAR_INTENSITY = config.CALENDAR_INTENSITY;
  }
}

// Callback for currency formatting (set by app.js)
let fmtCurFn: CurrencyFormatter = (v) => '$' + Math.abs(v).toFixed(2);

/**
 * Set the currency formatting function
 */
export function setFmtCurFn(fn: CurrencyFormatter): void {
  fmtCurFn = fn;
}

/**
 * Format number in short form (e.g., 1.2k)
 */
function fmtShort(v: number): string {
  const sign = v < 0 ? '-' : '';
  const abs = Math.abs(v);
  if (abs >= 1000) return sign + signals.currency.value.symbol + (abs/1000).toFixed(abs >= 10000 ? 0 : 1) + 'k';
  return sign + signals.currency.value.symbol + (abs % 1 === 0 ? abs : abs.toFixed(0));
}

/**
 * Get month badge HTML
 */
export function getMonthBadge(monthKey: string = signals.currentMonth.value): string {
  const [y, m] = monthKey.split('-');
  const monthName = new Date(parseInt(y), parseInt(m) - 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  return `<span class="time-badge">${monthName}</span>`;
}

/**
 * Get upcoming bills for a specific month
 * @returns Map of day -> array of bill objects
 */
export function getUpcomingBillsForMonth(monthKey: string): Map<number, BillInfo[]> {
  const viewDate = parseMonthKey(monthKey);
  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Find all recurring expense transactions in this month
  const billsMap = new Map<number, BillInfo[]>();

  signals.transactions.value.forEach((t: Transaction) => {
    if (t.recurring !== true || t.type !== 'expense') return;

    const txDate = parseLocalDate(t.date);
    if (txDate.getFullYear() !== year || txDate.getMonth() !== month) return;

    const day = txDate.getDate();
    const isPaid = t.reconciled === true;
    const isUpcoming = txDate >= today;

    if (!billsMap.has(day)) {
      billsMap.set(day, []);
    }

    const cat = getCatInfo(t.type, t.category);
    billsMap.get(day)!.push({
      id: t.__backendId,
      category: t.category,
      categoryName: cat.name,
      emoji: cat.emoji,
      amount: t.amount,
      description: t.description,
      isPaid,
      isUpcoming,
      date: t.date
    });
  });

  return billsMap;
}

/**
 * Render the calendar heatmap
 */
export function renderCalendar(): void {
  const el = DOM.get('spending-heatmap');
  const detailEl = DOM.get('cal-detail-panel');
  if (!el) return;
  const calBadge = DOM.get('calendar-badge');
  if (calBadge) calBadge.innerHTML = getMonthBadge();

  const mk = signals.currentMonth.value;

  const viewDate = parseMonthKey(mk);
  const year = viewDate.getFullYear(), month = viewDate.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstDow = new Date(year, month, 1).getDay();

  // Build daily spending map
  const dailySpend: Record<number, number> = {};
  const dailyIncome: Record<number, number> = {};
  const calTx = getMonthTx(mk);
  calTx.forEach(t => {
    const day = parseLocalDate(t.date).getDate();
    if (t.type === 'expense') dailySpend[day] = (dailySpend[day] || 0) + (parseFloat(String(t.amount)) || 0);
    else dailyIncome[day] = (dailyIncome[day] || 0) + (parseFloat(String(t.amount)) || 0);
  });

  const maxSpend = Math.max(...Object.values(dailySpend), 1);
  const todayDate = new Date();
  const isCurrentMonth = getMonthKey(todayDate) === mk;
  const todayDay = isCurrentMonth ? todayDate.getDate() : -1;

  // Get upcoming bills for this month
  const billsMap = getUpcomingBillsForMonth(mk);

  function buildDayCell(d: number): string {
    const spend = dailySpend[d] || 0;
    const inc = dailyIncome[d] || 0;
    const isToday = d === todayDay;
    const isSelected = d === calSelectedDay;
    const bills = billsMap.get(d) || [];
    const hasUpcomingBills = bills.some(b => b.isUpcoming && !b.isPaid);
    const hasPaidBills = bills.some(b => b.isPaid);

    const classes = ['cal-day'];
    if (isToday) classes.push('cal-today');
    if (isSelected) classes.push('cal-selected');
    let bg = '';
    if (spend > 0) {
      const intensity = Math.min(spend / maxSpend, 1);
      bg = `background: color-mix(in srgb, var(--color-expense) ${Math.round(intensity * calendarConfig.CALENDAR_INTENSITY.multiplier + calendarConfig.CALENDAR_INTENSITY.base)}%, transparent);`;
    } else if (inc > 0) {
      bg = `background: color-mix(in srgb, var(--color-income) 12%, transparent);`;
    }
    const tabIdx = isSelected || (calSelectedDay === null && isToday) ? '0' : '-1';

    // Bill marker HTML
    let billMarkerHtml = '';
    if (bills.length > 0) {
      const markerClass = hasUpcomingBills ? 'cal-bill-upcoming' : (hasPaidBills ? 'cal-bill-paid' : '');
      const tooltipText = bills.map(b => `${b.emoji} ${b.categoryName}: ${fmtCurFn(b.amount)}${b.isPaid ? ' ✓' : ''}`).join('&#10;');
      billMarkerHtml = `<div class="cal-bill-indicator ${markerClass}" title="${tooltipText}">
        <span class="cal-bill-dot"></span>
        ${bills.length > 1 ? `<span class="cal-bill-count">${bills.length}</span>` : ''}
      </div>`;
    }

    const billAriaLabel = bills.length > 0 ? `, ${bills.length} bill${bills.length > 1 ? 's' : ''} due` : '';

    return `<div class="${classes.join(' ')}" data-day="${d}" style="${bg}" role="gridcell" tabindex="${tabIdx}" aria-selected="${isSelected}" aria-label="Day ${d}${spend > 0 ? `, spent ${fmtCurFn(spend)}` : ''}${inc > 0 ? `, income ${fmtCurFn(inc)}` : ''}${billAriaLabel}">
      <span class="cal-day-num">${d}</span>
      ${billMarkerHtml}
      ${spend > 0 ? `<span class="cal-day-amt" style="color: var(--color-expense);">${fmtShort(spend)}</span>` : ''}
      ${inc > 0 && spend === 0 ? `<span class="cal-day-amt" style="color: var(--color-income);">+${fmtShort(inc)}</span>` : ''}
    </div>`;
  }

  let html = '<div class="cal-grid" role="grid" aria-label="Calendar">';
  // Row header + Day headers
  html += '<div class="cal-header"></div>'; // week total column header
  ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].forEach(d => {
    html += `<div class="cal-header">${d}</div>`;
  });

  // Build weeks
  let dayNum = 1;
  let weekSpend = 0;
  // First row: empty cells before first day + week total
  html += '<div class="cal-week-total"></div>'; // will be updated
  for (let i = 0; i < firstDow; i++) html += '<div class="cal-empty"></div>';
  // Fill rest of first week
  for (let i = firstDow; i < 7 && dayNum <= daysInMonth; i++, dayNum++) {
    html += buildDayCell(dayNum);
    weekSpend += dailySpend[dayNum] || 0;
  }
  // Replace first week total placeholder
  html = html.replace('<div class="cal-week-total"></div>', `<div class="cal-week-total">${weekSpend > 0 ? fmtShort(weekSpend) : ''}</div>`);

  // Remaining weeks
  while (dayNum <= daysInMonth) {
    weekSpend = 0;
    const weekDays: string[] = [];
    for (let i = 0; i < 7 && dayNum <= daysInMonth; i++, dayNum++) {
      weekDays.push(buildDayCell(dayNum));
      weekSpend += dailySpend[dayNum] || 0;
    }
    html += `<div class="cal-week-total">${weekSpend > 0 ? fmtShort(weekSpend) : ''}</div>`;
    html += weekDays.join('');
    // Pad remaining cells in last row
    for (let i = weekDays.length; i < 7; i++) html += '<div class="cal-empty"></div>';
  }
  html += '</div>';

  el.innerHTML = html;

  // Click/keyboard handler for day cells
  el.querySelectorAll<HTMLElement>('.cal-day[data-day]').forEach(cell => {
    cell.addEventListener('click', () => selectCalDay(parseInt(cell.dataset.day!), el, detailEl));
    cell.addEventListener('keydown', (e: KeyboardEvent) => {
      const day = parseInt(cell.dataset.day!);
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        selectCalDay(day, el, detailEl);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        navigateCalDay(day + 1, daysInMonth, el);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        navigateCalDay(day - 1, daysInMonth, el);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        navigateCalDay(day + 7, daysInMonth, el);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        navigateCalDay(day - 7, daysInMonth, el);
      }
    });
  });

  // Detail panel for selected day
  if (detailEl && calSelectedDay) {
    const dayTx = calTx.filter(t => parseLocalDate(t.date).getDate() === calSelectedDay);
    let panelHtml = '';

    if (dayTx.length) {
      panelHtml += `<div class="p-3 rounded-lg" style="background: var(--bg-input);">
        <p class="text-xs font-bold mb-2" style="color: var(--text-secondary);">Transactions</p>
        ${dayTx.map(t => {
          const cat = getCatInfo(t.type, t.category);
          const isExp = t.type === 'expense';
          return `<div class="flex justify-between items-center py-1">
            <span class="text-xs" style="color: var(--text-primary);">${esc(cat.emoji)} ${esc(t.description || cat.name)}</span>
            <span class="text-xs font-bold" style="color: ${isExp ? 'var(--color-expense)' : 'var(--color-income)'};">${isExp ? '-' : '+'}${fmtCurFn(t.amount)}</span>
          </div>`;
        }).join('')}
      </div>`;
    }

    detailEl.innerHTML = panelHtml ? `<div class="mt-3">${panelHtml}</div>` : '';
  } else if (detailEl) { detailEl.innerHTML = ''; }
}

/**
 * Select a calendar day and update the detail panel
 */
function selectCalDay(day: number, el: HTMLElement, detailEl: HTMLElement | null): void {
  calSelectedDay = day;
  // Update visual selection without full re-render
  el.querySelectorAll<HTMLElement>('.cal-day').forEach(c => {
    const d = parseInt(c.dataset.day!);
    c.classList.toggle('cal-selected', d === day);
    c.setAttribute('aria-selected', String(d === day));
    c.tabIndex = d === day ? 0 : -1;
  });
  // Update detail panel
  if (!detailEl) return;

  const mk = signals.currentMonth.value;
  const calTx = getMonthTx(mk);
  const dayTx = calTx.filter(t => parseLocalDate(t.date).getDate() === day);
  const billsMap = getUpcomingBillsForMonth(mk);
  const dayBills = billsMap.get(day) || [];

  let panelHtml = '';

  // Bills section (show first if there are bills)
  if (dayBills.length > 0) {
    panelHtml += `<div class="p-3 rounded-lg mb-2" style="background: color-mix(in srgb, var(--color-warning) 10%, var(--bg-input));">
      <p class="text-xs font-bold mb-2" style="color: var(--color-warning);">Recurring Bills</p>
      ${dayBills.map(b => `<div class="flex justify-between items-center py-1">
        <span class="text-xs" style="color: var(--text-primary);">${esc(b.emoji)} ${esc(b.description || b.categoryName)}</span>
        <span class="flex items-center gap-2">
          <span class="text-xs font-bold" style="color: var(--color-expense);">${fmtCurFn(b.amount)}</span>
          ${b.isPaid ? '<span class="text-xs" style="color: var(--color-income);">Paid</span>' : '<span class="text-xs" style="color: var(--color-warning);">Pending</span>'}
        </span>
      </div>`).join('')}
    </div>`;
  }

  // Transactions section
  if (dayTx.length) {
    panelHtml += `<div class="p-3 rounded-lg" style="background: var(--bg-input);">
      <p class="text-xs font-bold mb-2" style="color: var(--text-secondary);">Transactions</p>
      ${dayTx.map(t => {
        const cat = getCatInfo(t.type, t.category);
        const isExp = t.type === 'expense';
        return `<div class="flex justify-between items-center py-1">
          <span class="text-xs" style="color: var(--text-primary);">${esc(cat.emoji)} ${esc(t.description || cat.name)}</span>
          <span class="text-xs font-bold" style="color: ${isExp ? 'var(--color-expense)' : 'var(--color-income)'};">${isExp ? '-' : '+'}${fmtCurFn(t.amount)}</span>
        </div>`;
      }).join('')}
    </div>`;
  }
  detailEl.innerHTML = panelHtml ? `<div class="mt-3">${panelHtml}</div>` : '';
}

/**
 * Navigate to a different calendar day via keyboard
 */
function navigateCalDay(day: number, daysInMonth: number, el: HTMLElement): void {
  if (day < 1 || day > daysInMonth) return;
  const cell = el.querySelector<HTMLElement>(`.cal-day[data-day="${day}"]`);
  if (cell) cell.focus();
}

/**
 * Reset calendar selection state
 */
export function resetCalendarSelection(): void {
  calSelectedDay = null;
}
