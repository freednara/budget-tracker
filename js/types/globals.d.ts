/**
 * Ambient global type declarations for Harbor Ledger.
 *
 * This file exists so the 17 `(window as any).__APP_*__` casts that used to
 * be scattered across `js/modules/core/*` and `js/modules/orchestration/*`
 * can be replaced by typed accesses. TypeScript picks this file up
 * automatically via the `"include": ["js/**\/*"]` pattern in `tsconfig.json`
 * — no explicit import needed.
 *
 * Phase 6 Slice 1a (Inline-Behavior-Review rev 12, L1): centralized window
 * augmentation for startup-progress flags, debug toggles, ready-state
 * signals, deferred-error queue, test-mode flag, and debug exports. Every
 * property is optional — the app reads/writes them opportunistically and
 * code must continue to guard with `typeof window !== 'undefined'` where
 * relevant (these are browser-only surfaces).
 *
 * Rule for adding new entries: if a runtime variable is assigned to
 * `window.<foo>` or read from `window.<foo>` anywhere in the codebase,
 * declare it here instead of casting at the call site. One source of
 * truth, no more typos, contracts visible via "go to definition."
 */

declare global {
  /**
   * Payload shape enqueued on `window.__APP_DEFERRED_ERRORS__` when a
   * background-tier startup step fails before the error-tracker is ready.
   * Consumed later in the boot sequence to replay into `trackError`.
   */
  interface DeferredStartupError {
    /** Short label identifying the failing step (e.g. "migration:apply"). */
    label: string;
    /** Human-readable error message extracted at the moment of failure. */
    message: string;
    /** `Date.now()` when the failure was captured — used for ordering. */
    timestamp: number;
  }

  /**
   * Minimal contract for the optional error-reporter integration hook that
   * `error-boundary.ts` invokes when present. Decoupled from any specific
   * vendor SDK — callers only need the single `report(info)` method.
   */
  interface ErrorReporterHook {
    report(info: {
      error: { name: string; message: string; stack: string | undefined };
      context: unknown;
      severity: string;
      timestamp: string;
      url: string;
      userAgent: string;
    }): void;
  }

  /**
   * Runtime metadata snapshot published at boot so e2e + diagnostic tools
   * can read version, build time, PWA standalone state, and service-worker
   * control without parsing the DOM.
   */
  interface HarborLedgerRuntimeInfo {
    version: string;
    buildTime: string;
    runtimeMode: 'browser' | 'standalone';
    serviceWorkerControlled: boolean;
  }

  /**
   * Playwright test API surface — only attached when `__PW_TEST__ === true`.
   * Keep the surface intentionally tiny; every method here is a supported
   * e2e handle, not an escape hatch.
   */
  interface HarborLedgerTestApi {
    switchMainTab: (tab: string) => void;
  }

  interface Window {
    // ---- Startup progress + ready-state signals (set by app-init-di.ts + app.ts)

    /** Current boot phase label (mirrored onto `<html data-app-startup-progress>`). */
    __APP_STARTUP_PROGRESS__?: string | null;
    /** Last fatal startup error message — cleared on successful re-init. */
    __APP_ERRORS__?: string | null;
    /** True once blocking startup is complete and the app is interactive. */
    __APP_INITIALIZED__?: boolean;
    /** True once the shell (critical-path UI + first paint) is interactive. */
    __APP_SHELL_READY__?: boolean;
    /** True once the interactive tier (primary UI handlers) is wired. */
    __APP_INTERACTIVE_READY__?: boolean;
    /** True once the background tier (migrations, analytics, etc.) is ready. */
    __APP_BACKGROUND_READY__?: boolean;
    /** True if the background tier threw — consumed by e2e + diagnostics. */
    __APP_BACKGROUND_FAILED__?: boolean;
    /** Queue of deferred startup errors awaiting replay to error-tracker. */
    __APP_DEFERRED_ERRORS__?: DeferredStartupError[];

    // ---- Runtime metadata (published by app.ts `publishRuntimeInfo`)

    /** App version string from `__APP_VERSION__` Vite define. */
    __APP_VERSION__?: string;
    /** ISO build timestamp from `__APP_BUILD_TIME__` Vite define. */
    __APP_BUILD_TIME__?: string;
    /** Snapshot of boot-time runtime info — see `HarborLedgerRuntimeInfo`. */
    __APP_RUNTIME_INFO__?: HarborLedgerRuntimeInfo;
    /** Playwright-only API handle; null/undefined outside test mode. */
    __APP_TEST_API__?: HarborLedgerTestApi | null;

    // ---- Debug toggles (DEV-gated in every read site)

    /** `true` enables `[startup] <step>` console logs. */
    __APP_DEBUG_STARTUP__?: boolean;
    /** `true` enables per-flush cache telemetry in `monthly-totals-cache`. */
    __APP_DEBUG_CACHE__?: boolean;
    /** `true` enables performance-monitor verbose logging. */
    __APP_DEBUG_PERF__?: boolean;
    /** `true` enables event-bus verbose tracing. */
    __APP_DEBUG_EVENTS__?: boolean;

    // ---- Test-mode flag (set by Playwright harness)

    /** Playwright sets this before the app boots to alter lazy-load behavior. */
    __PW_TEST__?: boolean;

    // ---- Optional integration points

    /** DEV-only handle for poking at the live `PerformanceMonitor`. */
    perfMonitor?: unknown;
    /** Optional error-reporting SDK installed by embedders. */
    errorReporter?: ErrorReporterHook;
  }
}

// Marking this file as a module so `declare global` is interpreted as an
// augmentation rather than a script-global declaration. Empty export is
// the idiomatic way to do this under `isolatedModules`.
export {};
