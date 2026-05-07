/**
 * Theme Allowlist — single source of truth for the declared
 * `'dark' | 'light' | 'system'` union.
 *
 * Fixes M3 (Inline-Behavior-Review rev 12): three copies of this allowlist
 * existed (state-hydration.ts `SUPPORTED_THEMES`, sync-state-actions.ts
 * `isTheme`, auto-backup.ts `SUPPORTED_BACKUP_THEMES`). A fourth was about
 * to land in data-actions.ts to close the final `settings.setTheme()`
 * runtime gap. Consolidating them here means:
 *
 *   1. There is exactly ONE place to update if the Theme union gains a
 *      member (e.g. `'high-contrast'`) — the drift risk across four files
 *      disappears.
 *   2. The lowest-level setter (`settings.setTheme`, data-actions.ts) can
 *      enforce the allowlist at runtime, covering every remaining bypass
 *      path: `theme.ts:setTheme`, `FeatureEvents.SET_THEME` subscribers,
 *      `modal-events` dataset-driven clicks, `import-export-events`
 *      unvalidated imports, direct `settings.setTheme()` callers.
 *   3. Defense-in-depth stays intact — upstream validators (hydration
 *      normalizer, sync-state `isTheme` gate, backup normalizer) continue
 *      to reject bad payloads at their boundaries BEFORE they reach the
 *      setter. The setter's guard is a last-resort backstop that preserves
 *      the invariant "signals.theme.value is always a valid Theme".
 *
 * @module core/theme-allowlist
 */

import type { Theme } from '../../types/index.js';

/**
 * Canonical allowlist. Update here and here only.
 */
export const VALID_THEMES: ReadonlySet<Theme> = new Set<Theme>(['dark', 'light', 'system']);

/**
 * Structural type guard — returns true iff `v` is a declared Theme string.
 * Cheap enough for per-write use; see sync-state-actions.ts reject/accept
 * gating for the canonical usage pattern.
 */
export function isTheme(v: unknown): v is Theme {
  return typeof v === 'string' && VALID_THEMES.has(v as Theme);
}

/**
 * Clamp an arbitrary value to a valid Theme.
 *
 * Returns the input if already a valid Theme; otherwise returns the
 * provided fallback (default `'dark'`, matching the boot-path default in
 * state.ts / storage-events.ts / signals.ts).
 *
 * Prefer `isTheme()` at rejection boundaries (sync payloads, import
 * payloads) where you want to *refuse* a bad value with telemetry.
 * Prefer `normalizeTheme()` at hydration/setter boundaries where you
 * want to *recover* to a safe default rather than leave the signal
 * invalid.
 */
export function normalizeTheme(raw: unknown, fallback: Theme = 'dark'): Theme {
  // CR-Apr24-I finding 345: validate fallback too — a plain-JS or
  // unsafely-cast caller can pass an invalid fallback, which would
  // defeat the "clamp to valid Theme" guarantee.
  if (isTheme(raw)) return raw;
  return isTheme(fallback) ? fallback : 'dark';
}
