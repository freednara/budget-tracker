/**
 * Baseline delta helper
 *
 * Codifies a single "change from baseline" contract across the analytics
 * surface. Historically multiple sites (month-comparison totals,
 * month-comparison category movers, year-over-year expenses,
 * category-trend percentageChange) each rolled their own
 * `prev > 0 ? pct : 0` or `prev === 0 && cur > 0 ? 100 : pct` fabrication.
 * Those shortcuts silently collapsed degenerate baselines (zero prior
 * month, brand-new category, sparse histories) into misleading flat-0%
 * or a neat +100% exactly where the user most needed a "no baseline"
 * / "new" signal.
 *
 * Usage
 * -----
 *   const d = computeBaselineDelta(curExp, prevExp);
 *   if (d.status === 'new') show "New";
 *   else if (d.status === 'no-data') show "—";
 *   else show `${d.percent > 0 ? '+' : ''}${Math.round(d.percent)}%`;
 *
 * Inline `prev > 0 ? (pct) : 0` idioms should route through this helper
 * so the fabrication pattern cannot recur.
 *
 * @module core/baseline
 */

/**
 * Classification of a baseline comparison.
 *
 * - `comparable` — both current and previous exist; `percent` is defined.
 * - `new`        — current exists but previous is zero; "N%" would be
 *                  a fabrication, the correct signal is "new / no baseline".
 * - `no-data`    — both sides are zero; there is nothing to compare.
 */
export type BaselineStatus = 'comparable' | 'new' | 'no-data';

/**
 * Result of a baseline comparison. The shape is stable across all statuses —
 * `percent` is `null` whenever a real percentage cannot be computed, so
 * callers can safely consume the field without a second undefined check.
 */
export interface BaselineDelta {
  /** Classification — callers branch on this before reading `percent`. */
  status: BaselineStatus;
  /** Signed percent change when `status === 'comparable'`; `null` otherwise. */
  percent: number | null;
  /** Raw difference `current - previous`. Always defined for reference. */
  delta: number;
}

/**
 * Compute a baseline-aware delta between current and previous values.
 *
 * The denominator uses `Math.abs(previous)` so negative baselines (savings
 * can legitimately be negative) still produce a signed percent that
 * reflects improvement or regression rather than a sign-flip artifact.
 *
 * @param current  - current-period value (e.g. this month's expenses)
 * @param previous - baseline value (e.g. prior month's expenses)
 */
export function computeBaselineDelta(current: number, previous: number): BaselineDelta {
  // CR-Apr24-I finding 349: reject NaN / Infinity before classification
  // so corrupted ledger math cannot escape as malformed comparable deltas.
  if (!Number.isFinite(current) || !Number.isFinite(previous)) {
    return { status: 'no-data', percent: null, delta: 0 };
  }

  const delta = current - previous;
  const curAbs = Math.abs(current);
  const prevAbs = Math.abs(previous);

  // Both sides empty → no meaningful comparison.
  if (curAbs === 0 && prevAbs === 0) {
    return { status: 'no-data', percent: null, delta: 0 };
  }

  // Previous is zero → "new" is the honest signal, not "+N%".
  if (prevAbs === 0) {
    return { status: 'new', percent: null, delta };
  }

  const percent = (delta / prevAbs) * 100;
  return { status: 'comparable', percent, delta };
}

/**
 * Compact display label for a baseline delta.
 *
 * Tokens:
 *   - `comparable` with rounded percent → `"+12%"`, `"-8%"`, `"0%"`
 *   - `new`                             → `"New"`
 *   - `no-data`                         → `"—"`
 *
 * Callers that need locale-aware percent formatting or richer copy
 * (tooltips, long-form sentences) should branch on `status` themselves
 * rather than extending this helper with presentation concerns.
 */
export function formatBaselineDelta(delta: BaselineDelta): string {
  if (delta.status === 'no-data') return '—';
  if (delta.status === 'new') return 'New';
  const pct = delta.percent ?? 0;
  // CR-Apr24-I findings 350/351: guard against NaN/Infinity percent
  // (malformed BaselineDelta from external callers) and null masking.
  if (!Number.isFinite(pct)) return '—';
  const rounded = Math.round(pct);
  if (rounded === 0) return '0%';
  const sign = rounded > 0 ? '+' : '-';
  return `${sign}${Math.abs(rounded)}%`;
}
