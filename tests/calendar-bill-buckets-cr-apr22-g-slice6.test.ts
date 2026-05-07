import { describe, expect, it } from 'vitest';
import {
  bucketBillsByDueDate,
  type BillInfo
} from '../js/modules/ui/widgets/calendar.js';

/**
 * CR-Apr22-G slice 6 coverage — Calendar past-month unpaid-bill semantics.
 *
 * The calendar summary strip previously filtered bills with:
 *   !bill.isPaid && (getMonthKey(today) !== mk || parseLocalDate(bill.date) >= today)
 *
 * The `getMonthKey(today) !== mk` short-circuit was correct only for FUTURE
 * months (where every day is strictly ≥ today) and broken for PAST months
 * (where every day is strictly < today, yet every unpaid bill was still
 * counted as "upcoming"). This slice replaces the short-circuit with an
 * unconditional date compare via `bucketBillsByDueDate`, which also splits
 * the list into disjoint "upcoming" and "overdue" buckets so the caller
 * can surface overdue bills explicitly instead of masquerading them as
 * upcoming.
 *
 * These tests lock the bucket contract independent of the DOM render.
 */

function makeBill(overrides: Partial<BillInfo> = {}): BillInfo {
  return {
    id: overrides.id ?? `bill_${Math.random().toString(36).slice(2, 8)}`,
    category: 'utilities',
    categoryName: 'Utilities',
    emoji: '💡',
    amount: 100,
    description: 'Electric',
    isPaid: false,
    isUpcoming: true,
    date: '2026-04-24',
    ...overrides
  };
}

/**
 * April 24, 2026 at local midnight. Aligns with the current-date context
 * and exercises `parseLocalDate` (noon-local) vs. `today` (midnight-local)
 * comparisons on the same calendar day — the "due today ≥ today" case.
 */
const TODAY_APR_24 = new Date(2026, 3, 24, 0, 0, 0, 0);

describe('bucketBillsByDueDate — empty + paid filtering (CR-Apr22-G slice 6)', () => {
  it('returns empty buckets when given no bills', () => {
    const result = bucketBillsByDueDate([], TODAY_APR_24);
    expect(result.upcoming).toEqual([]);
    expect(result.overdue).toEqual([]);
  });

  it('excludes paid bills from both upcoming and overdue', () => {
    const bills = [
      makeBill({ id: 'paid_past', date: '2026-04-20', isPaid: true }),
      makeBill({ id: 'paid_future', date: '2026-04-30', isPaid: true }),
      makeBill({ id: 'paid_today', date: '2026-04-24', isPaid: true })
    ];
    const { upcoming, overdue } = bucketBillsByDueDate(bills, TODAY_APR_24);
    expect(upcoming).toEqual([]);
    expect(overdue).toEqual([]);
  });

  it('keeps unpaid bills in their respective buckets while dropping paid ones', () => {
    const bills = [
      makeBill({ id: 'unpaid_past', date: '2026-04-20' }),
      makeBill({ id: 'paid_past', date: '2026-04-21', isPaid: true }),
      makeBill({ id: 'unpaid_future', date: '2026-04-28' }),
      makeBill({ id: 'paid_future', date: '2026-04-29', isPaid: true })
    ];
    const { upcoming, overdue } = bucketBillsByDueDate(bills, TODAY_APR_24);
    expect(upcoming.map(b => b.id)).toEqual(['unpaid_future']);
    expect(overdue.map(b => b.id)).toEqual(['unpaid_past']);
  });
});

describe('bucketBillsByDueDate — boundary semantics (CR-Apr22-G slice 6)', () => {
  it('treats bills due TODAY as upcoming (>= boundary, not >)', () => {
    const bills = [makeBill({ id: 'today', date: '2026-04-24' })];
    const { upcoming, overdue } = bucketBillsByDueDate(bills, TODAY_APR_24);
    expect(upcoming.map(b => b.id)).toEqual(['today']);
    expect(overdue).toEqual([]);
  });

  it('treats bills due YESTERDAY as overdue', () => {
    const bills = [makeBill({ id: 'yesterday', date: '2026-04-23' })];
    const { upcoming, overdue } = bucketBillsByDueDate(bills, TODAY_APR_24);
    expect(overdue.map(b => b.id)).toEqual(['yesterday']);
    expect(upcoming).toEqual([]);
  });

  it('treats bills due TOMORROW as upcoming', () => {
    const bills = [makeBill({ id: 'tomorrow', date: '2026-04-25' })];
    const { upcoming, overdue } = bucketBillsByDueDate(bills, TODAY_APR_24);
    expect(upcoming.map(b => b.id)).toEqual(['tomorrow']);
    expect(overdue).toEqual([]);
  });
});

describe('bucketBillsByDueDate — month-view behavior (CR-Apr22-G slice 6)', () => {
  /**
   * Reproduces the exact bug: a past-month view populated by unpaid bills
   * (e.g., the user scrolls back to January). The PRIOR short-circuit would
   * bucket all of these as "upcoming"; the fix buckets them as "overdue".
   */
  it('buckets all unpaid bills from a PAST month as overdue', () => {
    const bills = [
      makeBill({ id: 'jan_05', date: '2026-01-05' }),
      makeBill({ id: 'jan_15', date: '2026-01-15' }),
      makeBill({ id: 'jan_28', date: '2026-01-28' })
    ];
    const { upcoming, overdue } = bucketBillsByDueDate(bills, TODAY_APR_24);
    expect(upcoming).toEqual([]);
    expect(overdue.map(b => b.id)).toEqual(['jan_05', 'jan_15', 'jan_28']);
  });

  it('buckets all unpaid bills from a FUTURE month as upcoming', () => {
    const bills = [
      makeBill({ id: 'jun_01', date: '2026-06-01' }),
      makeBill({ id: 'jun_15', date: '2026-06-15' }),
      makeBill({ id: 'jun_30', date: '2026-06-30' })
    ];
    const { upcoming, overdue } = bucketBillsByDueDate(bills, TODAY_APR_24);
    expect(overdue).toEqual([]);
    expect(upcoming.map(b => b.id)).toEqual(['jun_01', 'jun_15', 'jun_30']);
  });

  it('splits a CURRENT-month mix across both buckets', () => {
    // Early-month bills are in the past; late-month bills are upcoming;
    // today's bill falls in upcoming; paid bills are dropped wholesale.
    const bills = [
      makeBill({ id: 'apr_05', date: '2026-04-05' }),
      makeBill({ id: 'apr_10_paid', date: '2026-04-10', isPaid: true }),
      makeBill({ id: 'apr_20', date: '2026-04-20' }),
      makeBill({ id: 'apr_24_today', date: '2026-04-24' }),
      makeBill({ id: 'apr_28', date: '2026-04-28' }),
      makeBill({ id: 'apr_30_paid', date: '2026-04-30', isPaid: true })
    ];
    const { upcoming, overdue } = bucketBillsByDueDate(bills, TODAY_APR_24);
    expect(overdue.map(b => b.id)).toEqual(['apr_05', 'apr_20']);
    expect(upcoming.map(b => b.id)).toEqual(['apr_24_today', 'apr_28']);
  });
});

describe('bucketBillsByDueDate — sort invariants (CR-Apr22-G slice 6)', () => {
  it('returns upcoming sorted ascending by date (soonest first at [0])', () => {
    const bills = [
      makeBill({ id: 'late', date: '2026-04-30' }),
      makeBill({ id: 'soonest', date: '2026-04-25' }),
      makeBill({ id: 'mid', date: '2026-04-28' })
    ];
    const { upcoming } = bucketBillsByDueDate(bills, TODAY_APR_24);
    expect(upcoming.map(b => b.id)).toEqual(['soonest', 'mid', 'late']);
  });

  it('returns overdue sorted ascending by date (oldest first at [0])', () => {
    const bills = [
      makeBill({ id: 'recent', date: '2026-04-22' }),
      makeBill({ id: 'oldest', date: '2026-04-01' }),
      makeBill({ id: 'mid', date: '2026-04-15' })
    ];
    const { overdue } = bucketBillsByDueDate(bills, TODAY_APR_24);
    expect(overdue.map(b => b.id)).toEqual(['oldest', 'mid', 'recent']);
  });

  it('is stable across repeated calls (pure function, no hidden state)', () => {
    const bills = [
      makeBill({ id: 'a', date: '2026-04-28' }),
      makeBill({ id: 'b', date: '2026-04-20' })
    ];
    const first = bucketBillsByDueDate(bills, TODAY_APR_24);
    const second = bucketBillsByDueDate(bills, TODAY_APR_24);
    expect(first.upcoming.map(b => b.id)).toEqual(second.upcoming.map(b => b.id));
    expect(first.overdue.map(b => b.id)).toEqual(second.overdue.map(b => b.id));
    // And does not mutate the input.
    expect(bills.map(b => b.id)).toEqual(['a', 'b']);
  });

  it('produces disjoint buckets — no bill appears in both upcoming and overdue', () => {
    const bills = [
      makeBill({ id: 'a', date: '2026-04-05' }),
      makeBill({ id: 'b', date: '2026-04-24' }),
      makeBill({ id: 'c', date: '2026-04-28' })
    ];
    const { upcoming, overdue } = bucketBillsByDueDate(bills, TODAY_APR_24);
    const upcomingIds = new Set(upcoming.map(b => b.id));
    const overdueIds = new Set(overdue.map(b => b.id));
    for (const id of upcomingIds) expect(overdueIds.has(id)).toBe(false);
    for (const id of overdueIds) expect(upcomingIds.has(id)).toBe(false);
    // Every non-paid bill must appear in exactly one bucket.
    expect(upcomingIds.size + overdueIds.size).toBe(3);
  });
});
