# Budget Tracker Elite - Agent Guidelines

TypeScript PWA (~41,000 lines) using Preact Signals, Lit HTML, DI Container, and IndexedDB. Layered architecture with explicit bridge exceptions and reactive state management.

## Architecture Rules

### Layer Dependencies (enforced default ordering)

```
types/ --> core/ --> data/ --> features/ --> orchestration/ --> ui/ + components/
```

- **core/** defaults to **types/**-only dependencies, with a small bridge allowlist for shell/error/sync adapters that must surface UI state
- **data/** imports from **core/** and **types/**, plus the transaction rendering surface that intentionally bridges into **ui/**
- **features/** should prefer **core/**, **data/**, and **types/** and use the **Event Bus** or feature-event interface for UI-triggered workflows
- **ui/** and **components/** import from **core/**, **data/**, and **types/**
- **orchestration/** can import from all layers (app startup coordinator)
- When a boundary exception is required, keep it narrow and add/update the architecture guard test rather than silently introducing another ad hoc import path

### Import Conventions

- By convention, all imports in this codebase use `.js` extensions. With `moduleResolution: "bundler"`, extensions are technically optional, but the project uses them consistently. Follow the existing pattern:

  ```typescript
  // CORRECT
  import { lsGet } from './state.js';
  import type { Transaction } from '../../types/index.js';

  // WRONG
  import { lsGet } from './state';
  import { lsGet } from './state.ts';
  ```

- The Vite resolver plugin (`vite.config.ts`) maps `.js` to `.ts` at build time
- Use `import type { ... }` for type-only imports (required by `isolatedModules`)
- Barrel files (`index.ts`) are used selectively for public module APIs -- only re-export what actually exists in the source module

### TypeScript Requirements

- `strict: true` is enabled -- this turns on `noImplicitAny`, `strictNullChecks`, `strictFunctionTypes`, `strictBindCallApply`, `strictPropertyInitialization`, `noImplicitThis`, `alwaysStrict`, and `useUnknownInCatchVariables`
- `noEmit: true` -- TypeScript is for type-checking only; Vite handles bundling
- `moduleResolution: "bundler"` -- modern ESM resolution
- All signals must have explicit generic types: `signal<Type>(value)`
- All function parameters must have explicit types in strict mode
- Run `npm run typecheck` (`tsc --noEmit`) to verify -- must produce 0 errors

## State Management

### Signals (`js/modules/core/signals.ts`)

Reactive state uses `@preact/signals-core`:

```typescript
// Creating a signal with persisted storage
export const theme = signal<Theme>(getStored<Theme>(SK.THEME, 'dark'));

// Computed signals for derived values
export const budgetUsagePercent = computed(() => {
  const budget = totalBudget.value;
  return budget === 0 ? 0 : Math.round((currentMonthTotals.value.expenses / budget) * 100);
});
```

**Rules:**

- Signals are defined in `signals.ts` and imported as `import * as signals from './signals.js'`
- `signals.ts` re-exports: `signal`, `batch`, `getDefaultContainer`, `Services`
- Never mutate signal values in-place; always assign a new value

### Mutations via Action Objects (`js/modules/core/state-actions.ts`)

Default all app-facing state changes through action methods. Direct signal writes are reserved for a narrow low-level allowlist that is enforced by tests:
- `js/modules/core/state-actions.ts`
- `js/modules/core/state-hydration.ts`
- `js/modules/data/transaction-renderer.ts`
- `js/modules/features/backup/auto-backup.ts`
- `js/modules/features/gamification/achievements.ts`
- `js/modules/features/gamification/streak-tracker.ts`
- `js/modules/orchestration/app-reset.ts`
- `js/modules/orchestration/backup-reminder.ts`
- `js/modules/transactions/edit-mode.ts`
- `js/modules/ui/core/ui-render.ts`

Use actions everywhere else:

```typescript
// CORRECT - use action methods
navigation.setCurrentMonth('2026-03');
modal.clearDeleteTargetId();
settings.setPin(bundle);

// WRONG - direct signal mutation from outside approved low-level writers
signals.currentMonth.value = '2026-03';
```

**Action object groups:** `navigation`, `form`, `modal`, `settings`, `data`, `savingsGoals`, `pagination`, `filters`, `calendar`, `alerts`, `onboarding`, `debts`, `syncState`

Action methods should:

1. Validates input
2. Updates the signal
3. Emits an event via `queueEvent(Events.EVENT_NAME, payload)`
4. Returns `boolean` for success/failure

### Adding New State

1. Add signal in `signals.ts`: `export const newThing = signal<Type>(getStored<Type>(SK.NEW_THING))`
2. Add storage key in `state.ts`: `SK.NEW_THING: 'budget_tracker_new_thing'` and add default to `STORAGE_DEFAULTS`
3. Add action methods in `state-actions.ts` in the appropriate group
4. The auto-persist effect in `signals.ts` handles saving to localStorage

### Batch Updates

Use `batchUpdates()` when changing multiple signals together:

```typescript
batchUpdates(() => {
  signals.currentMonth.value = newMonth;
  signals.pagination.value = { page: 0, totalPages: 1 };
});
// Events are emitted AFTER the batch completes
```

## Cross-Module Communication

### Event Bus (`js/modules/core/event-bus.ts`)

```typescript
import { emit, on, Events } from './event-bus.js';

// Emit
emit(Events.TRANSACTION_ADDED, { id, transaction });

// Subscribe (returns unsubscribe function)
const unsub = on(Events.TRANSACTION_ADDED, (payload) => { ... });
unsub(); // cleanup

// Listener groups for bulk cleanup
const groupId = createListenerGroup('MyComponent');
// ... add listeners ...
destroyListenerGroup(groupId);
```

Event constants are defined in `Events` object in `event-bus.ts`. Always use the constant, never a raw string.

### Feature Event Interface (`js/modules/core/feature-event-interface.ts`)

Request/response pattern for UI-to-feature communication:

```typescript
// UI requests data from feature
const data = await requestFeature<ResultType>('feature:request:month_tx', { month });

// Feature handles request
on('feature:request:month_tx', ({ payload, responseEvent }) => {
  const result = getMonthTransactions(payload.month);
  emit(responseEvent, { result });
});
```

### DI Container (`js/modules/core/di-container.ts`)

```typescript
// Synchronous resolution (for pre-registered values)
const formatter = container.resolveSync<CurrencyFormatter>(Services.CURRENCY_FORMATTER);

// Async resolution (for lazy-loaded services)
const service = await container.resolve<MyService>('serviceName');
```

Service names are in the `Services` enum. Use `getDefaultContainer()` to access the container.

## Data Layer

### CRUD via dataSdk (`js/modules/data/data-manager.ts`)

```typescript
import { dataSdk } from '../data/data-manager.js';

const result = await dataSdk.create({ type: 'expense', amount: 50, ... });
const allTx = await dataSdk.getAll();
await dataSdk.delete(transaction);
```

Never access IndexedDB or localStorage directly for transaction data.

### Atomic Operations (`js/modules/data/transaction-manager.ts`)

```typescript
import { withTransaction, type Operation } from './transaction-manager.js';

class MyOperation implements Operation<ResultType> {
  async execute(): Promise<ResultType> { ... }
  async rollback(): Promise<void> { ... }
}

const result = await withTransaction<ResultType>(
  [new MyOperation()],
  (results: ResultType[]) => results[0]
);
```

Operations run sequentially; on failure, all completed operations roll back in reverse order (LIFO).

### Storage Keys (`js/modules/core/state.ts`)

```typescript
import { SK, persist, lsGet, lsSet, getStored } from './state.js';

// Always use SK constants
persist(SK.THEME, 'dark');
const theme = getStored<Theme>(SK.THEME, 'dark'); // optional default param

// NEVER hardcode storage keys
localStorage.setItem('budget_tracker_theme', 'dark'); // WRONG
```

`getStored<T>(key: string, defaultValue?: T)` accepts an optional second argument for a default fallback.

## UI Patterns

### Lit HTML (`js/modules/core/lit-helpers.ts`)

Always import Lit utilities from the centralized module:

```typescript
// CORRECT
import { html, render, nothing, repeat, classMap } from '../core/lit-helpers.js';

// WRONG - direct lit-html imports
import { html } from 'lit-html';
```

Available exports: `html`, `svg`, `render`, `nothing`, `repeat`, `classMap`, `styleMap`, `unsafeHTML`, `ifDefined`, `when`, `renderList`, `mountAll`

### DOM Access (`js/modules/core/dom-cache.ts`)

```typescript
import DOM from '../core/dom-cache.js';

// Cached lookup by ID
const el = DOM.get('my-element');
const input = DOM.get('my-input') as HTMLInputElement;

// Safe access (never throws, returns mock if missing)
const safe = DOM.getSafe('maybe-missing');

// NEVER use raw DOM queries for cached elements
document.getElementById('my-element'); // WRONG
```

### Component Mount/Cleanup Pattern

```typescript
export function mountMyWidget(): () => void {
  const cleanup = effect(() => {
    // reactive rendering
  });
  return cleanup; // caller stores and invokes on teardown
}
```

Register cleanup via `registerCleanup()` in `app-init-di.ts`.

## Financial Calculations

### Integer Math (`js/modules/core/utils-pure.ts`)

All financial math uses integer cents to avoid floating-point errors:

```typescript
import { toCents, toDollars, addAmounts, subtractAmounts } from '../core/utils.js';

const cents = toCents(19.99);        // 1999
const dollars = toDollars(1999);      // 19.99
const sum = addAmounts(10.50, 20.00); // 30.50 (internally uses cents)
```

### Totals Type (`js/types/index.ts`)

```typescript
interface Totals {
  income: number;
  expenses: number;
  balance: number;
  categoryTotals?: Record<string, number>; // OPTIONAL - use with fallback
}

// Always guard categoryTotals access
Object.entries(totals.categoryTotals || {}).forEach(...)
const spent = (totals.categoryTotals || {})[categoryId] || 0;
```

## Testing

### Framework

- **Runner:** Vitest with `happy-dom` environment
- **Config:** `vitest.config.ts`
- **Tests:** `tests/**/*.test.ts`
- **E2E:** `e2e/*.spec.ts` with Playwright

### Useful Commands

```bash
npm run typecheck
npm test
npm run test:run
npm run test:coverage
npm run test:e2e
npm run test:e2e:smoke
npm run test:e2e:ui
npm run test:e2e:debug
npx playwright test e2e/accessibility.spec.ts
npx playwright test e2e/security.spec.ts
npx playwright test e2e/visual-regression.spec.ts --project=chromium
```

- Use `npm run test:e2e:smoke` for the pinned smoke subset: `transaction-crud`, `dashboard-layout`, `data-lifecycle`, `advanced-resilience`
- Playwright runs three browser projects by default: `chromium`, `webkit`, and `mobile-safari`
- Some layout interactions are intentionally `webkit`-only in `e2e/dashboard-layout.spec.ts`; use `--project=webkit` when investigating those cases
- Set `PW_PERF_PROFILE=1` to run Playwright against `npm run build && npm run preview -- --host 127.0.0.1 --port 4173` instead of the Vite dev server
- Set `PW_REUSE_SERVER=1` to reuse an existing local server, and `PW_REPORTER` to override the default Playwright `line` reporter
- Set `RUN_PERF_BENCH=1` to enable `e2e/performance-benchmark.spec.ts`; without it, the benchmark-only Playwright tests are skipped
- `e2e/visual-regression.spec.ts-snapshots/` contains generated Playwright baselines; regenerate via the spec, do not hand-edit the snapshot files
- The browser perf workflow has two modes: the required shell and hot-path regression check, plus advisory 1k/5k/10k ledger benchmark runs for local scale testing
- GitHub Pages deploy uses `npm run test:run` before `npm run build`, so prefer `npm run test:run` for a fast local pre-deploy check when you do not need coverage

### Transaction Factory Pattern

Test Transaction objects MUST include all required fields:

```typescript
// CORRECT - use a helper
function tx(overrides: Partial<Transaction> & {
  type: 'expense' | 'income'; amount: number; date: string; category: string;
}): Transaction {
  return {
    __backendId: `test_${Math.random().toString(36).slice(2)}`,
    description: 'Test',
    currency: 'USD',
    recurring: false,
    ...overrides
  };
}

// WRONG - missing required fields
const t = { type: 'expense', amount: 50, date: '2026-01-01', category: 'food' };
```

Required Transaction fields: `__backendId`, `type`, `amount`, `description`, `date`, `category`, `currency`, `recurring`

### ValidationResult Narrowing

```typescript
// CORRECT - narrow before accessing
const result = validateAmount(value);
if (result.valid) {
  console.log(result.value); // safe
} else {
  console.log(result.error); // safe
}

// WRONG - no narrowing
console.log(result.value); // TS error: might be ValidationFailure
```

### String Literals in Tests

Use `as const` for union-typed string fields:

```typescript
// CORRECT
validateTransaction({ type: 'expense' as const, ... });

// WRONG - 'expense' widens to string
validateTransaction({ type: 'expense', ... }); // TS error
```

## Common Regression Pitfalls

These are the specific mistakes that caused 180 TypeScript errors. Do not repeat them:

1. **Missing action methods** -- If consumer code calls `modal.clearFoo()`, the method must exist in `state-actions.ts`. When adding a new signal that UI code will clear/set, add the corresponding action methods.

2. **Forgetting `.js` in imports** -- Every relative import should end in `.js` to match the existing codebase convention. The Vite resolver handles `.js` -> `.ts` mapping.

3. **`categoryTotals` without guard** -- `Totals.categoryTotals` is optional. Always use `(totals.categoryTotals || {})` or optional chaining.

4. **Barrel file re-exports** -- Never re-export a name from `index.ts` that doesn't exist in the source module. Verify exports exist before adding re-exports.

5. **Missing `await` on async functions** -- If a function returns `Promise<T>`, you must `await` it before comparing/using the result. `Promise<number> > 0` is always `true`.

6. **Missing type imports** -- When using a type like `Theme`, ensure it's imported with `import type { Theme } from '../../types/index.js'`.

7. **`getStored` arity** -- `getStored<T>(key, defaultValue?)` accepts 1 or 2 arguments. The second is optional.

8. **ToastType values** -- Valid values: `'success' | 'error' | 'info' | 'warning'`. If adding a new type, update `ToastType` in `ui.ts` AND `error-handler.ts`, and add color mapping in `showToast`.

9. **Test Transaction completeness** -- Test Transaction objects need all required fields (`__backendId`, `description`, `currency`, `recurring`). Use a factory function.

10. **Implicit `any` in callbacks** -- Strict mode requires explicit types on all parameters, including in `.map()`, `.filter()`, event handlers, and catch blocks.

## Quick Reference Checklist

Before submitting changes, verify:

- [ ] `npm run typecheck` passes
- [ ] All imports use `.js` extensions
- [ ] All new signals have corresponding action methods in `state-actions.ts`
- [ ] All new storage keys use `SK` constants with defaults in `STORAGE_DEFAULTS`
- [ ] No new direct signal writes outside the approved low-level writer allowlist
- [ ] Optional properties accessed with guards (`|| {}`, `?.`)
- [ ] All async functions are `await`ed when their result is used
- [ ] Barrel file re-exports match actual source module exports
- [ ] Test Transaction objects include all required fields
- [ ] No new forbidden cross-layer imports outside the documented bridge allowlist
