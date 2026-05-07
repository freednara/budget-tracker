/**
 * Calendar Module
 * 
 * Reactive calendar heatmap rendering and day selection using signals and Lit.
 * Shows spending/income by day with bill indicators.
 */
'use strict';

import * as signals from '../../core/signals.js';
import { calendar as calendarActions, navigation } from '../../core/state-actions.js';
import { parseMonthKey, parseLocalDate, getMonthKey, monthKeyParts, fmtShort, getTodayStr } from '../../core/utils-pure.js';
import { formatDateShort, formatMonthShortYear, formatViewedMonthPhrase, formatViewedMonthLabel, localeService } from '../../core/locale-service.js';
import { getCatInfo } from '../../core/categories.js';
// CR-Apr22-E slice 4 (finding 61d [P3]): calendar month + selection effects
// used to subscribe to `userCategoryConfig` only incidentally — via
// `getCatInfo(...)` reads deep inside `getBillsForMonth()` (conditional
// on recurring-expense rows existing) and inside `renderDetailPanel`
// (conditional on `dayTx.length > 0`). Paths that did NOT call
// `getCatInfo` (e.g., viewing a month with zero recurring bills and
// selecting a day with zero transactions) left the effect without any
// edge to `userCategoryConfig`. A subsequent rename / recolor / emoji
// change would then leave the heatmap + day-detail panel stale with
// the pre-rename category info until some unrelated signal woke the
// effect. Explicit reads at the top of both effects guarantee the edge
// is live regardless of the branch the body takes. Matches the pattern
// CR-Apr22-D slice 1 used for the dashboard chart effects.
import { userCategoryConfig } from '../../core/category-store.js';
import { isTrackedExpenseTransaction } from '../../core/transaction-classification.js';
import { safeAmount } from '../../core/safe-amount.js';
import { getMonthTx } from '../../features/financial/calculations.js';
import { openTransactionsForDate, openTransactionsEdit } from '../core/ui-navigation.js';
import DOM from '../../core/dom-cache.js';
// Phase 5g-1 (Inline-Behavior-Review rev 12, L30d): removed unused `repeat`
// from this import. Grep across calendar.ts confirms zero `repeat(` call
// sites — the rendered day/week lists use plain `.map(...)` in the html``
// templates. If keyed re-rendering is ever needed here, re-import
// deliberately.
import { html, render, classMap } from '../../core/lit-helpers.js';
import { effect, computed } from '@preact/signals-core';
import { getDefaultContainer, Services } from '../../core/di-container.js';
// emptyState import removed — calendar now uses app-panel-empty pattern directly
import type { Transaction } from '../../../types/index.js';

// ==========================================
// TYPE DEFINITIONS
// ==========================================

export interface BillInfo {
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

/**
 * Bucket bill entries into "upcoming" (due today or later) and "overdue"
 * (due date strictly before today) — excluding already-paid bills from
 * both buckets. Paid bills are independent of the bucket, since "paid"
 * nullifies both "upcoming you should pay" and "overdue you forgot."
 *
 * CR-Apr22-G slice 6: the calendar summary strip previously collapsed this
 * into a single `upcoming` list with a short-circuit that bypassed the
 * date check whenever the viewed month was not the current real-time
 * month. That short-circuit was right for FUTURE months (every day is
 * strictly >= today) but wrong for PAST months (every day is strictly
 * < today, yet the short-circuit counted them all as "upcoming"). This
 * helper replaces the short-circuit with an unconditional date compare.
 *
 * Sorting: both buckets are sorted ascending by YYYY-MM-DD string
 * compare, which agrees with chronological order under the fixed-width
 * date format. Callers read `[0]` for "the soonest upcoming" or "the
 * oldest overdue."
 *
 * @param billEntries flat list of bills harvested from the month's billsMap
 * @param today       local-midnight Date used as the cutoff
 * @returns           `{ upcoming, overdue }` — two disjoint, sorted lists
 */
export function bucketBillsByDueDate(
  billEntries: BillInfo[],
  today: Date
): { upcoming: BillInfo[]; overdue: BillInfo[] } {
  const upcoming: BillInfo[] = [];
  const overdue: BillInfo[] = [];
  for (const bill of billEntries) {
    if (bill.isPaid) continue;
    const due = parseLocalDate(bill.date);
    if (due >= today) upcoming.push(bill);
    else overdue.push(bill);
  }
  const asc = (a: BillInfo, b: BillInfo) => a.date.localeCompare(b.date);
  upcoming.sort(asc);
  overdue.sort(asc);
  return { upcoming, overdue };
}

type CurrencyFormatter = (value: number) => string;

interface CalendarDayCell {
  day: number;
  spend: number;
  income: number;
  isToday: boolean;
  isSelected: boolean;
  bills: BillInfo[];
}

export function getEmptyCalendarActionDate(monthKey: string, selectedDay: number | null): string {
  if (selectedDay === null || !Number.isInteger(selectedDay) || selectedDay < 1) {
    return `${monthKey}-01`;
  }

  const viewDate = parseMonthKey(monthKey);
  const daysInMonth = new Date(viewDate.getFullYear(), viewDate.getMonth() + 1, 0).getDate();
  if (selectedDay > daysInMonth) {
    return `${monthKey}-01`;
  }

  return `${monthKey}-${String(selectedDay).padStart(2, '0')}`;
}

export function getCalendarFocusableDay(selectedDay: number | null, fallbackDay: number): number {
  if (selectedDay !== null && Number.isInteger(selectedDay) && selectedDay > 0) {
    return selectedDay;
  }

  return Math.max(1, fallbackDay);
}

export function getCalendarKeyboardTarget(day: number, key: string, daysInMonth: number): number | null {
  switch (key) {
    case 'ArrowLeft':
      return Math.max(1, day - 1);
    case 'ArrowRight':
      return Math.min(daysInMonth, day + 1);
    case 'ArrowUp':
      return Math.max(1, day - 7);
    case 'ArrowDown':
      return Math.min(daysInMonth, day + 7);
    case 'Home':
      return 1;
    case 'End':
      return daysInMonth;
    default:
      return null;
  }
}

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
    const _cur = signals.currency.value;  // re-render on currency change
    // CR-Apr22-E slice 4: explicit subscription to the category config so
    // a rename / recolor / emoji swap always re-runs the heatmap render
    // (see import block above for the full rationale).
    userCategoryConfig.value;
    const { mk, txs, bills, isEmpty } = monthData.value;
    const selectedDay = signals.selectedCalendarDay.value;

    if (badgeContainer) {
      const [y, m] = monthKeyParts(mk);
      const monthName = formatMonthShortYear(new Date(y, m - 1));
      render(html`<span class="time-badge">${monthName}</span>`, badgeContainer);
    }

    if (isEmpty) {
      // Design-Review-Apr21 P3 (batch 6 follow-up wave L): empty-state
      // copy below used to hardcode "this month" even though the
      // widget is reactive to `signals.currentMonth`. Use the shared
      // month-phrase helpers so copy stays correct when the user is
      // browsing a past or future month. `monthPhrase` embeds the
      // "in" preposition for sentences that end with the month
      // reference ("left {phrase}"); the label variant is used for
      // carrier sentences that already supply their own preposition
      // ("scheduled for {label}").
      const monthPhrase = formatViewedMonthPhrase(mk);
      const monthLabelOrThis = formatViewedMonthLabel(mk);
      render(html`
        <div class="app-panel-empty">
          <div class="app-panel-empty__icon">📅</div>
          <p class="app-panel-empty__title">No calendar activity yet</p>
          <p class="app-panel-empty__copy">Add transactions or recurring bills to plan the month day by day.</p>
        </div>
      `, container);
      if (detailContainer) {
        // UI/UX Review Part 2: added CTA to the calendar empty state
        // so users can jump straight to adding a transaction for today
        // instead of seeing a dead-end message.
        const todayStr = getTodayStr();
        render(html`
          <div class="calendar-detail-empty">
            <p class="calendar-detail-empty__title">No day details yet</p>
            <p class="calendar-detail-empty__body">Tap a day on the calendar, or add your first transaction to get started.</p>
            <button
              type="button"
              class="btn btn-primary mt-3 text-sm"
              @click=${() => void openTransactionsForDate(todayStr)}
            >
              Add Transaction for Today
            </button>
          </div>
        `, detailContainer);
      }
      if (summaryContainer) {
        render(html`
          <div class="calendar-summary-card">
            <p class="calendar-summary-card__label">Activity Days</p>
            <p class="calendar-summary-card__value">0</p>
            <p class="calendar-summary-card__meta">No recorded days ${monthPhrase} yet.</p>
          </div>
          <div class="calendar-summary-card">
            <p class="calendar-summary-card__label">Recurring Bills</p>
            <p class="calendar-summary-card__value">0</p>
            <p class="calendar-summary-card__meta">No recurring bill activity scheduled for ${monthLabelOrThis}.</p>
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
    const _cur = signals.currency.value;  // re-render on currency change
    // CR-Apr22-E slice 4: same reason as `monthCleanup` — selection-level
    // day-detail + summary renders also walk `getCatInfo` on conditional
    // paths, so an explicit read guarantees re-firing on config change.
    userCategoryConfig.value;
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
  const todayCell = container.querySelector<HTMLElement>('.cal-today');
  const firstDayCell = container.querySelector<HTMLElement>('.cal-day');
  const fallbackDay = Number(todayCell?.dataset.day || firstDayCell?.dataset.day || 1);
  const focusableDay = getCalendarFocusableDay(selectedDay, fallbackDay);

  dayCells.forEach((cell) => {
    const day = Number(cell.dataset.day || 0);
    const isSelected = selectedDay !== null && day === selectedDay;
    cell.classList.toggle('cal-selected', isSelected);
    cell.tabIndex = day === focusableDay ? 0 : -1;
  });
}

function focusCalendarDay(container: HTMLElement, day: number): void {
  window.requestAnimationFrame(() => {
    container.querySelector<HTMLElement>(`.cal-day[data-day="${day}"]`)?.focus();
  });
}

function changeCalendarMonth(container: HTMLElement, monthKey: string, offset: number, preferredDay: number): void {
  const monthDate = parseMonthKey(monthKey);
  const nextMonthDate = new Date(monthDate.getFullYear(), monthDate.getMonth() + offset, 1);
  const nextMonthKey = `${nextMonthDate.getFullYear()}-${String(nextMonthDate.getMonth() + 1).padStart(2, '0')}`;
  const nextDaysInMonth = new Date(nextMonthDate.getFullYear(), nextMonthDate.getMonth() + 1, 0).getDate();
  const nextDay = Math.min(preferredDay, nextDaysInMonth);

  navigation.setCurrentMonth(nextMonthKey);
  calendarActions.setSelectedDay(nextDay);
  focusCalendarDay(container, nextDay);
}

function handleCalendarDayKeydown(
  event: KeyboardEvent,
  container: HTMLElement,
  monthKey: string,
  day: number,
  daysInMonth: number
): void {
  const targetDay = getCalendarKeyboardTarget(day, event.key, daysInMonth);
  if (targetDay !== null) {
    event.preventDefault();
    calendarActions.setSelectedDay(targetDay);
    focusCalendarDay(container, targetDay);
    return;
  }

  if (event.key === 'PageUp' || event.key === 'PageDown') {
    event.preventDefault();
    changeCalendarMonth(container, monthKey, event.key === 'PageUp' ? -1 : 1, day);
  }
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
    // rev 12 / #39 M1: `t.amount || 0` replaced with `safeAmount(t)` so
    // non-finite ledger values surface as trackError telemetry rather than
    // silently collapsing into the daily-spend / daily-income heatmap.
    const amount = safeAmount(t);
    if (isTrackedExpenseTransaction(t)) dailySpend[day] = (dailySpend[day] || 0) + amount;
    else dailyIncome[day] = (dailyIncome[day] || 0) + amount;
  });

  const maxSpend = Math.max(...Object.values(dailySpend), 1);
  const today = new Date();
  const todayDay = (getMonthKey(today) === mk) ? today.getDate() : -1;
  const focusableDay = getCalendarFocusableDay(selectedDay, todayDay > 0 ? todayDay : 1);

  // Build rows/weeks
  const rows: Array<{ week: Array<CalendarDayCell | null>; weekTotal: number }> = [];
  let dayNum = 1;

  while (dayNum <= daysInMonth) {
    const week: Array<CalendarDayCell | null> = [];
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

  // Phase 5g-1 (Inline-Behavior-Review rev 12, L30d): removed an unused
  // `const fmtCur = ...resolveSync<CurrencyFormatter>(...)` here. The
  // renderDayCell path formats via the local `fmtShort()` helper, not the
  // currency formatter. The separate `fmtCur` declared in renderSummaryStrip
  // (further down in this file) IS used by its own scope and is unrelated.
  const isPhoneLayout = window.matchMedia('(max-width: 767px)').matches;

  const renderDayCell = (cell: CalendarDayCell) => {
    const intensity = Math.min(cell.spend / maxSpend, 1);
    const bg = cell.spend > 0
      ? `color-mix(in srgb, var(--color-expense) ${Math.round(intensity * 70 + 10)}%, transparent)`
      : (cell.income > 0 ? 'color-mix(in srgb, var(--color-income) 12%, transparent)' : 'transparent');
    const ariaLabelParts = [
      `Day ${cell.day}`,
      cell.spend > 0 ? `${fmtShort(cell.spend)} spent` : '',
      cell.income > 0 ? `${fmtShort(cell.income)} income` : '',
      cell.bills.length > 0 ? `${cell.bills.length} bill${cell.bills.length === 1 ? '' : 's'}` : ''
    ].filter(Boolean);

    return html`
      <button
            type="button"
            class=${classMap({ 'cal-day': true, 'cal-today': cell.isToday, 'cal-selected': cell.isSelected })}
            data-day="${cell.day}"
            tabindex=${cell.day === focusableDay ? '0' : '-1'}
            style="background: ${bg}"
            aria-label=${ariaLabelParts.join(', ')}
            aria-current=${cell.isToday ? 'date' : 'false'}
            aria-pressed=${cell.isSelected ? 'true' : 'false'}
            @keydown=${(event: KeyboardEvent) => handleCalendarDayKeydown(event, container, mk, cell.day, daysInMonth)}
            @click=${() => selectDay(cell.day)}>
        <span class="cal-day-num">${cell.day}</span>

        ${cell.bills.length > 0 ? html`
          <div class="cal-bill-indicator ${cell.bills.some((bill) => bill.isUpcoming && !bill.isPaid) ? 'cal-bill-upcoming' : (cell.bills.some((bill) => bill.isPaid) ? 'cal-bill-paid' : '')}">
            <span class="cal-bill-dot"></span>
            ${cell.bills.length > 1 ? html`<span class="cal-bill-count">${cell.bills.length}</span>` : ''}
          </div>
        ` : ''}

        ${cell.spend > 0 ? html`<span class="cal-day-amt text-expense">${fmtShort(cell.spend)}</span>` : ''}
        ${cell.income > 0 && cell.spend === 0 ? html`<span class="cal-day-amt text-income">+${fmtShort(cell.income)}</span>` : ''}
      </button>
    `;
  };

  if (isPhoneLayout) {
    const flatCells: Array<CalendarDayCell | null> = [];

    for (let i = 0; i < firstDow; i += 1) {
      flatCells.push(null);
    }

    rows.forEach((row) => {
      row.week.forEach((cell) => {
        flatCells.push(cell);
      });
    });

    while (flatCells.length % 7 !== 0) {
      flatCells.push(null);
    }

    render(html`
      <div class="cal-grid cal-grid--phone" role="grid" aria-label="Monthly Spending Calendar">
        ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((dayLabel) => html`<div class="cal-header">${dayLabel}</div>`)}

        ${flatCells.map((cell) => {
          if (!cell) {
            return html`<div class="cal-empty" aria-hidden="true"></div>`;
          }
          return renderDayCell(cell);
        })}
      </div>
    `, container);
    return;
  }

  render(html`
    <div class="cal-grid" role="grid" aria-label="Monthly Spending Calendar">
      <div class="cal-header"></div>
      ${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d => html`<div class="cal-header">${d}</div>`)}

      ${rows.map(row => html`
        <div class="cal-week-total">${row.weekTotal > 0 ? fmtShort(row.weekTotal) : ''}</div>
        ${row.week.map((cell) => {
          if (!cell) return html`<div class="cal-empty"></div>`;
          return renderDayCell(cell);
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

  // CR-Apr22-G slice 6: bucket unpaid bills by due date vs. today (see
  // `bucketBillsByDueDate` above for the rationale). The prior logic
  // short-circuited with `getMonthKey(today) !== mk || date >= today`,
  // which was wrong for past-month views: every unpaid bill in a past
  // month was bucketed as "upcoming" because the "!== mk" branch bypassed
  // the date check entirely.
  const { upcoming: upcomingBills, overdue: overdueBills } =
    bucketBillsByDueDate(billEntries, today);
  const nextUpcomingBill = upcomingBills[0] || null;
  const overdueCount = overdueBills.length;

  // Route through canonical helper so the summary respects the app's
  // configured locale (was hardcoded 'en-US').
  const selectedDateLabel = selectedDay
    ? formatDateShort(new Date(monthDate.getFullYear(), monthDate.getMonth(), selectedDay))
    : 'No day selected';

  // Design-Review-Apr21 P3 (batch 6 follow-up wave L): "left in this month"
  // was hardcoded but this widget renders for any viewed month — when the
  // user navigated to a past/future month the empty-state copy still
  // implied the real current period. `formatViewedMonthPhrase` returns
  // "this month" at current-view default and "in April 2026"-style labels
  // when navigated elsewhere; dropping the literal "in" from the carrier
  // sentence and letting the phrase supply it yields natural copy in both
  // cases ("left this month." / "left in April 2026.") and avoids the
  // double-preposition trap (`monthLabelOrThis` would have given
  // "left in this month." at current view, the same awkward original).
  const monthPhrase = formatViewedMonthPhrase(mk);

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
        ${(() => {
          // CR-Apr22-G slice 6: three-way meta copy so past-month unpaid
          // bills are surfaced as "overdue" rather than silently hidden.
          //   • any upcoming        → "Next due: X on Y" (+ overdue chip)
          //   • none upcoming + any overdue → "N overdue before today"
          //   • none of either       → "No unpaid recurring bills left …"
          // The overdue count appears as a trailing chip when upcoming
          // bills exist so the user keeps the primary "what's next" signal
          // but also sees the catch-up backlog at a glance.
          const overdueChip = overdueCount > 0
            ? ` (${overdueCount} overdue)`
            : '';
          if (nextUpcomingBill) {
            const nextLabel = nextUpcomingBill.description || nextUpcomingBill.categoryName;
            const nextDate = formatDateShort(parseLocalDate(nextUpcomingBill.date));
            return `Next due: ${nextLabel} on ${nextDate}${overdueChip}`;
          }
          if (overdueCount > 0) {
            return `${overdueCount} unpaid bill${overdueCount === 1 ? '' : 's'} overdue before today.`;
          }
          return `No unpaid recurring bills left ${monthPhrase}.`;
        })()}
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
  // Route through locale-service so the detail heading respects the app's
  // configured locale (was hardcoded 'en-US'). Custom format includes
  // weekday, so call toLocaleDateString directly with the configured locale
  // rather than adding a one-off formatter variant.
  const selectedDateLabel = new Date(`${selectedDate}T00:00:00`).toLocaleDateString(
    localeService.getLocale(),
    { weekday: 'short', month: 'short', day: 'numeric' }
  );

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
        <div class="cal-detail-section cal-detail-section--bills">
          <p class="cal-detail-section__header cal-detail-section__header--bills">Recurring Bills</p>
          ${dayBills.map(b => html`
            <div class="flex justify-between items-center py-1">
              <span class="text-xs font-bold text-primary">${b.emoji} ${b.description || b.categoryName}</span>
              <div class="flex items-center gap-2">
                <span class="text-xs font-black text-expense">${fmtCur(b.amount)}</span>
                <span class="cal-status-badge ${b.isPaid ? 'cal-status-badge--paid' : 'cal-status-badge--due'}">
                  ${b.isPaid ? 'PAID' : 'DUE'}
                </span>
              </div>
            </div>
          `)}
        </div>
      ` : ''}

      ${dayTx.length > 0 ? html`
        <div class="cal-detail-section cal-detail-section--transactions">
          <p class="cal-detail-section__header cal-detail-section__header--transactions">Transactions</p>
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
                    aria-label="Edit transaction ${t.description || cat.name}, ${t.type === 'expense' ? '-' : '+'}${fmtCur(t.amount)}"
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

// CR-Apr22-G slice 2: local `fmtShort` deleted in favor of the canonical
// `fmtShort` export from `utils-pure.js`. The local copy was a near-
// duplicate that read `signals.currency.value.symbol` directly rather
// than the cached formatter state maintained by `syncCurrencyFormat`.
// The canonical helper uses the same formatter cache as `fmtCur` and
// stays in lockstep with it — which matters because the month/selection
// effects in this file already subscribe to `signals.currency.value`
// (search: "re-render on currency change"), so deleting the local copy
// does not lose reactivity. Also folds in the missing negative-sign
// handling that the local copy lacked.

// Phase 5g-1 (Inline-Behavior-Review rev 12, L30d): deleted the
// `export function renderCalendar(): void {}` legacy no-op shim.
// Calendar rendering is now driven entirely by the reactive
// `mountCalendar()` effect on signals.currentMonth. Grep across js/ +
// tests/ confirms zero remaining callers — the only reference was an
// already-commented-out `renderScheduler.register('renderCalendar', ...)`
// line in app-events.ts, which can be cleaned up in a future sweep.
