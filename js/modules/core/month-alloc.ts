'use strict';

/**
 * Defensive accessor for a month's budget allocation record.
 *
 * Rev 12 / #39 M4 (Inline-Behavior-Review): replaces the legacy
 * `signals.monthlyAlloc.value[mk] || {}` pattern at month-allocation
 * read sites. `monthlyAlloc` is a `Record<string, MonthlyAllocation>`
 * keyed by YYYY-MM month keys; a missing key returns `undefined`, and
 * the bare `|| {}` fallback silently substitutes a zeroed allocation.
 *
 * That fallback is semantically correct for a brand-new user who has
 * not yet created any budget, but it ALSO masks a real data-loss bug:
 * if a month the user DID allocate gets dropped (bad migration, failed
 * sync merge, corrupted import), calculations downstream of every
 * affected call site silently return zeros with no signal to the user
 * or to the monitoring pipeline.
 *
 * This helper preserves the existing `{}` fallback so downstream math
 * is byte-identical on the hit path, but fires a fingerprint-sampled
 * `trackError` telemetry event the **first time** each unique `mk` is
 * missed in the current page session. Subsequent misses for the same
 * `mk` stay silent — the dashboard only needs to see "October is
 * missing" once, not once per render tick.
 *
 * @module core/month-alloc
 *
 * DESIGN NOTES
 *
 * - **Parameterized on the map, not on the signal.** The helper takes
 *   `allocMap: Record<string, MonthlyAllocation>` so callers pass
 *   `signals.monthlyAlloc.value` explicitly. This mirrors `safeAmount(tx)`
 *   (rev 12 / #39 M1) where the Transaction slice is passed directly
 *   rather than reading a signal internally — it keeps the helper's
 *   import graph minimal (only `trackError` + the `MonthlyAllocation`
 *   type), which matters because signals.ts itself is one of the
 *   call sites and co-location there would close a runtime cycle.
 *
 * - **Miss detection uses `allocMap[mk] !== undefined`**, not a truthy
 *   check. The `|| {}` pattern the helper replaces conflates two
 *   distinct states: (a) the mk was never set (genuine miss) vs.
 *   (b) the mk was set to an explicitly empty allocation (user cleared
 *   every category). The helper treats (b) as a valid hit — returns
 *   the empty record as-is without a trackError — which is a semantic
 *   improvement over the legacy pattern.
 *
 * - **Empty-map suppression.** When the ENTIRE `allocMap` has no keys,
 *   a miss is expected rather than suspicious: either a new user
 *   hasn't set any budget yet, the app is mid-hydration on boot, or
 *   the user just ran app-reset. The review's "dropped month" concern
 *   only materializes when some months exist but the one being asked
 *   about doesn't — that's the signal we want. Suppressing the warning
 *   on an empty map keeps the telemetry dashboard clean of expected
 *   zero-budget states while preserving the load-bearing data-loss
 *   signal. Edge case not handled: a sync collision that deletes ALL
 *   months leaves an empty map and silences this guard — observability
 *   for that scenario is owned by the persistence delta layer, not by
 *   a read-path accessor.
 *
 * - **Set lifecycle: module-scoped, page-session lifetime.** The
 *   `warnedMissingMonths` set persists for the lifetime of the JS
 *   context. No explicit reset export — a page reload is the natural
 *   recovery path, and app-reset does not reload. If a future phase
 *   wires test-reset wiring (parallel to `clearErrorLog()` +
 *   `resetCircuitBreaker()` in error-tracker), add
 *   `resetMonthAllocWarnings()` at that time.
 *
 * - **Fallback return is `{}`, not a sentinel.** Semantic zero for
 *   `MonthlyAllocation` (which is `Record<string, number>` — an empty
 *   map means "no categories have been allocated"). Byte-identical to
 *   the legacy `|| {}` so downstream `.reduce` / `Object.values` /
 *   `Object.keys` paths continue to work without a shape probe.
 */

import type { MonthlyAllocation } from '../../types/index.js';
import { trackError } from './error-tracker.js';

/**
 * Session-scoped set of month keys we have already emitted a first-miss
 * trackError for. Module-scoped so the set survives across all call
 * sites but resets naturally on page reload.
 */
const warnedMissingMonths = new Set<string>();

/**
 * Returns `allocMap[mk]` when the key exists; otherwise returns `{}`
 * and fires a once-per-session `trackError` for the missing month key.
 *
 * @param mk       - Month key (YYYY-MM format).
 * @param allocMap - The full month-allocation record (typically
 *                   `signals.monthlyAlloc.value`).
 */
export function getMonthAlloc(
  mk: string,
  allocMap: Record<string, MonthlyAllocation>
): MonthlyAllocation {
  const hit = allocMap[mk];
  // CR-Apr24-I finding 362: guard against corrupted non-record values
  // (null, number, string) that would crash Object.entries() downstream.
  if (hit !== undefined && hit !== null && typeof hit === 'object') return hit;

  // Suppress warning on genuinely-empty allocMap (new user, pre-hydration,
  // post-reset) — see DESIGN NOTES. Only fire when OTHER months exist but
  // this one is missing, which is the data-loss signal the review targets.
  if (Object.keys(allocMap).length === 0) return {};

  if (!warnedMissingMonths.has(mk)) {
    warnedMissingMonths.add(mk);
    trackError(
      `getMonthAlloc: missing month allocation for ${mk}`,
      { module: 'month-alloc', action: 'getMonthAlloc' },
      'validationError'
    );
  }

  return {};
}
