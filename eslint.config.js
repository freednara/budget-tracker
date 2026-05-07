// @ts-check
/**
 * ESLint flat config for Harbor Ledger.
 *
 * Phase 6 Slice 1b (Inline-Behavior-Review rev 12, L5): project-level
 * ESLint with a "no-escape-hatch" ruleset. Every issue in the behavior
 * review escaped because no linter was catching `as any`, empty
 * `catch {}`, missing `await`, or `// @ts-ignore` introductions.
 * Running this config as a CI gate shrinks the hand-audit surface.
 *
 * ## Rule-tier strategy
 *
 * The review rev 12 (L5) specifies six rules verbatim. All six are ON.
 * Severity is split between `error` (blocks CI) and `warn` (signal only,
 * does not block) based on legacy-violation count as of this slice:
 *
 * | Rule                                             | Tier  | Why                                                    |
 * |--------------------------------------------------|-------|--------------------------------------------------------|
 * | @typescript-eslint/no-explicit-any               | error | Phase 6 Apr 2026 ratcheted — baseline clean           |
 * | @typescript-eslint/no-unsafe-assignment          | error | Phase 6 Apr 2026 ratcheted — baseline clean           |
 * | @typescript-eslint/consistent-type-assertions    | error | 37 pre-existing (all autofixable — fixed this slice)  |
 * | @typescript-eslint/no-misused-promises           | error | 31 pre-existing — fixed this slice                    |
 * | @typescript-eslint/no-floating-promises          | error | 23 pre-existing — fixed this slice                    |
 * | no-empty: { allowEmptyCatch: false }             | error | ~0 pre-existing — baseline clean                      |
 *
 * We deliberately do NOT spread `tseslint.configs.recommendedTypeChecked`.
 * That preset includes ~15 rules outside L5 scope (require-await,
 * unbound-method, prefer-promise-reject-errors, etc.) which generated
 * ~150 extraneous errors on first scan. Keeping the ruleset tight
 * enforces the L5 spec literally and avoids scope creep.
 *
 * Type-aware rules (no-unsafe-*, no-floating-promises, no-misused-promises)
 * require the `projectService` parser option so the linter gets full type
 * information from `tsconfig.json`.
 *
 * Test files get a narrower set (no-explicit-any and no-unsafe-assignment
 * off): vitest mocks and fixture builders legitimately need `any`-typed
 * value slots. Everything else still applies.
 */

import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  // Ignore patterns (replaces .eslintignore under flat config).
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
      'html-report/**',
      // Capacitor / Android build outputs — bundled third-party copy of dist.
      'android/**',
      'ios/**',
      // Generated / third-party within repo.
      'public/sw.js',
      'public/**/*.js',
      '**/*.min.js',
      // Anything under `js/**/*.js` is a Vite-bundled build artifact; only
      // `.ts` files are source. (checkJs is off in tsconfig.)
      '**/*.js.map',
      // `.sfdx/` is a stray Salesforce LWC typings snapshot that shipped into
      // the repo; it isn't included in tsconfig.json and typescript-eslint's
      // projectService refuses to parse files outside the TS project graph.
      '.sfdx/**',
      // Tooling / build configs live outside the app tsconfig graph.
      'capacitor.config.ts',
      'playwright.config.ts',
      'run-preview-test.ts',
    ],
  },

  // Base TypeScript parser setup. We do NOT spread `recommendedTypeChecked`
  // — see the header comment for why. Parser config must still be set up
  // so type-aware rules have tsc's view of the code.
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.es2022,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
    },
    rules: {
      // ---- L5 no-escape-hatch ruleset ---------------------------------
      // All six rules from L5 are ON and all are 'error'. The two that
      // landed as 'warn' in Slice 1b (`no-explicit-any`,
      // `no-unsafe-assignment`) were ratcheted to 'error' in Phase 6's
      // April-2026 cleanup once the pre-existing violations were tightened
      // (primitive-shape sites moved to `unknown`, DI/perf/bootstrap
      // plumbing scoped via the file override below).
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/consistent-type-assertions': [
        'error',
        { assertionStyle: 'as', objectLiteralTypeAssertions: 'never' },
      ],
      'no-empty': ['error', { allowEmptyCatch: false }],

      // ---- Supporting rules (keep tight around the L5 intent) ---------
      // Ban bare `// @ts-ignore` and `// @ts-expect-error` without a
      // reason comment. The review flagged these as a major escape hatch.
      '@typescript-eslint/ban-ts-comment': [
        'error',
        {
          'ts-ignore': { descriptionFormat: '^: .+$' },
          'ts-expect-error': { descriptionFormat: '^: .+$' },
          'ts-nocheck': true,
          'ts-check': false,
        },
      ],

      // Handled by tsc (noUnusedLocals). The eslint version catches the
      // same things but gives us `argsIgnorePattern: '^_'` which tsc
      // doesn't honor. Keep at warn so tsc stays the primary signal.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],

      // ---- Locale-drift guards (CR-Apr21) -----------------------------
      // After the CR-Apr21 full-sweep pulled ADR-001's deferred i18n fix
      // forward, keep the guardrail in place so new code can't reintroduce
      // hardcoded locale literals or bare `.toLocaleDateString()` /
      // `.toLocaleString()` calls that inherit the system locale. Route
      // everything through locale-service (`formatDateShort`, `formatMonthShort`,
      // `formatMonthShortYear`, `formatCurrency`, `formatNumber`) or the
      // `fmtCur` / `fmtShort` currency helpers instead.
      'no-restricted-syntax': [
        'error',
        {
          // Ban: `Intl.DateTimeFormat('en-US', ...)` and similar hardcoded
          // locale constructor calls in application code.
          selector: "NewExpression[callee.object.name='Intl'][callee.property.name=/^(DateTimeFormat|NumberFormat)$/] > Literal:first-child[value=/^[a-z]{2}(-[A-Z]{2})?$/]",
          message: 'Locale drift: pass no locale (use localeService.getLocale()) or call formatDateShort / formatMonthShort / formatCurrency from locale-service instead of hardcoding "en-US" etc.',
        },
        {
          // Ban: `x.toLocaleDateString('en-US', ...)` and `.toLocaleString('en-US', ...)`
          // with a literal locale argument. The helper exports in
          // `core/locale-service.ts` are the canonical surface.
          selector: "CallExpression[callee.property.name=/^toLocale(Date|Time)?String$/] > Literal:first-child[value=/^[a-z]{2}(-[A-Z]{2})?$/]",
          message: 'Locale drift: do not pass a literal locale to toLocale*String — route through locale-service helpers (formatDateShort, formatMonthShort, formatMonthShortYear, formatCurrency) or pass `localeService.getLocale()`.',
        },
      ],
    },
  },

  // Ambient declaration files — allow `any` as it's sometimes the only
  // way to model third-party APIs. Everything else still applies.
  {
    files: ['**/*.d.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
    },
  },

  // ---- Load-bearing `any` — infrastructure plumbing --------------------
  // Phase 6 cleanup (no-explicit-any sweep) leaves these three files with
  // site-specific `any` because the surfaces involved are fundamentally
  // heterogeneous and cannot be statically typed without breaking the
  // feature set they provide:
  //
  //   • core/di-container.ts — generic service container. `T = any` on
  //     `ServiceRegistration`, `(...deps: any[])` on factories, and the
  //     runtime injection plumbing all need `any` because a container that
  //     holds arbitrary services cannot be generic over every service's
  //     full type graph without per-token generics (which the registry-by-
  //     string-key contract rules out). Tokens carry their own typing at
  //     the `resolve<T>()` call site.
  //
  //   • core/performance-monitor.ts — reads `performance.getEntriesByType()`,
  //     `PerformanceObserver` entries, and browser-vendor fields that
  //     lib.dom types either don't model (`layoutShift.hadRecentInput`,
  //     Chrome-only memory APIs) or types as `PerformanceEntry` base which
  //     doesn't expose the subclass fields we measure. Narrowing at every
  //     site via structural guards would add ~50 lines of defensive code
  //     to a module that already runs a DEV-only sampling branch.
  //
  //   • orchestration/app-init-di.ts — boot sequence that wires services
  //     into the DI container. The `any` surface mirrors di-container's
  //     untyped service slots; factory callbacks receive `any` deps by
  //     the container contract.
  //
  // The remaining warnings here are all in well-commented hot paths where
  // Phase 6's "tighten tractable sites" directive explicitly exempts
  // infrastructure plumbing. If a slice ever replaces the string-keyed
  // DI with a branded-token variant, revisit these overrides.
  {
    files: [
      'js/modules/core/di-container.ts',
      'js/modules/core/performance-monitor.ts',
      'js/modules/orchestration/app-init-di.ts',
    ],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
    },
  },

  // Test files — slightly relaxed. vi.fn() mocks and DOM fixture setups
  // legitimately want `any`-typed value slots; `allowEmptyCatch: false`
  // still catches real bugs in "assert-does-not-throw" scaffolding.
  {
    files: ['tests/**/*.ts', 'e2e/**/*.ts', '**/*.test.ts', '**/*.spec.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      // Test setup commonly uses sync vi.fn() mocks that replace async
      // functions; the factory must be declared async even if the stub
      // body has no await. Keep the L5 intent on application code only.
      '@typescript-eslint/no-misused-promises': 'off',
      // Test fixture builders heavily use `{ ... } as PartialT` patterns
      // to stub only the handful of shape keys a given test exercises.
      // The assertion style is orthogonal to behavior correctness; keep
      // the rule as-error in app code only.
      '@typescript-eslint/consistent-type-assertions': 'off',
    },
  },

  // Config files (eslint.config.js, vite.config.ts, etc.) — these run
  // in Node, not the browser, and may need looser rules.
  {
    files: ['*.config.{js,ts}', '*.config.*.{js,ts}'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
);
