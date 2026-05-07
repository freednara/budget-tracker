/**
 * Form Events — Edit Merge Contract
 *
 * Regression tests for 7b (Inline-Behavior-Review P2, Transaction edit
 * partial-payload field strip).
 *
 * `dataSdk.update` is replace-semantics (see `data-manager.ts:714`
 * `newData[idx] = updatedTx`) — it writes the payload verbatim into the row.
 * The edit flow in `handleEditTransaction` used to build a 7-field partial
 * payload and cast it to `Transaction`, silently stripping every field the
 * form doesn't touch: `currency`, `recurring`, `recurring_type`,
 * `recurring_end`, `reconciled`, `splits`, `parentTxId`, `debtId`,
 * `recurringTemplateId`.
 *
 * These tests exercise the fix: fetch the original row via `dataSdk.get` and
 * merge the form-edited fields on top, mirroring the shape used by
 * `UpdateTransactionOperation.execute` at `transaction-operations.ts:82-85`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import DOM from '../js/modules/core/dom-cache.js';

// ==========================================
// MOCKS — match the shape used by form-events-lifecycle.test.ts so the
// module-under-test's transitive imports don't pull in heavy dependencies.
// ==========================================

vi.mock('../js/modules/core/signals.js', () => ({
  currentType: { value: 'expense' },
  selectedCategory: { value: 'food' },
  editingId: { value: null },
  filtersExpanded: { value: false },
}));

vi.mock('@preact/signals-core', () => ({
  batch: (fn: () => void) => fn(),
  signal: (v: unknown) => ({ value: v }),
  computed: (fn: () => unknown) => ({ value: fn() }),
  effect: () => () => {},
}));

vi.mock('../js/modules/core/state-actions.js', () => ({
  actions: {
    form: { setSelectedCategory: vi.fn(), setEditingId: vi.fn() },
    pagination: { resetPage: vi.fn() },
  },
  batchUpdates: (fn: () => void) => fn(),
}));

vi.mock('../js/modules/core/state.js', () => ({
  SK: {},
}));

// Capture the mock references so each test can set up per-call behavior.
// Hoisted so the factory below (which is itself hoisted above imports by
// Vitest) can reference it without a TDZ error.
const { dataSdkMock } = vi.hoisted(() => ({
  dataSdkMock: {
    create: vi.fn().mockResolvedValue({ isOk: true }),
    update: vi.fn().mockResolvedValue({ isOk: true }),
    get: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../js/modules/data/data-manager.js', () => ({
  dataSdk: dataSdkMock,
}));

vi.mock('../js/modules/data/recurring-templates.js', () => ({
  createRecurringTemplate: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../js/modules/core/event-bus.js', () => ({
  emit: vi.fn(),
  Events: { FORM_VALIDATED: 'form-validated', FORM_SUBMITTED: 'form-submitted' },
  createListenerGroup: vi.fn(() => 'mock-group-id'),
  destroyListenerGroup: vi.fn(),
}));

vi.mock('../js/modules/core/validator.js', () => ({
  validator: {
    validateTransaction: vi.fn(() => ({ valid: true, errors: {} })),
    showFieldError: vi.fn(),
    clearFieldError: vi.fn(),
  },
}));

vi.mock('../js/modules/core/feature-event-interface.js', () => ({
  checkAchievements: vi.fn(),
}));

vi.mock('../js/modules/core/global-error-handler.js', () => ({
  handleError: vi.fn(),
}));

vi.mock('../js/modules/core/locale-service.js', () => ({
  localeService: {
    formatCurrency: (amount: number) => `$${amount.toFixed(2)}`,
  },
}));

const { showToastMock } = vi.hoisted(() => ({
  showToastMock: vi.fn(),
}));
vi.mock('../js/modules/ui/core/ui.js', () => ({
  showToast: (...args: unknown[]) => showToastMock(...args),
}));

vi.mock('../js/modules/core/form-binder.js', () => ({
  FormBinder: vi.fn().mockImplementation(() => ({
    bind: vi.fn(),
    clear: vi.fn(),
  })),
}));

vi.mock('../js/modules/core/utils-pure.js', () => ({
  parseAmount: (v: string | number) =>
    typeof v === 'number' ? v : parseFloat(v as string) || 0,
  getTodayStr: () => '2026-04-21',
  parseLocalDate: (d: string) => new Date(d),
}));

// Form-signal mocks — values are mutated per-test to drive the submit flow.
const { formSignals } = vi.hoisted(() => ({
  formSignals: {
    formAmount: { value: '' },
    formDescription: { value: '' },
    formTags: { value: '' },
    formDate: { value: '2026-04-21' },
    formNotes: { value: '' },
    formRecurring: { value: false as boolean },
    formRecurringType: { value: 'monthly' },
    formRecurringEnd: { value: '' },
  },
}));

vi.mock('../js/modules/transactions/template-manager.js', () => ({
  ...formSignals,
  syncFormWithSignals: vi.fn(),
  readFormIntoSignals: vi.fn(),
}));

import * as signals from '../js/modules/core/signals.js';
import {
  initFormEvents,
  cleanupFormEvents,
  handleFormSubmit,
} from '../js/modules/ui/interactions/form-events.js';
import type { Transaction } from '../js/types/index.js';

// ==========================================
// HELPERS
// ==========================================

function setupFormDOM(): void {
  document.body.innerHTML = `
    <form id="transaction-form">
      <input id="amount" type="text" />
      <input id="description" type="text" />
      <input id="date" type="date" />
      <input id="tags" type="text" />
      <textarea id="tx-notes"></textarea>
      <div id="category-chips"></div>
      <div id="category-error" class="hidden">Please select a category</div>
      <input id="recurring-toggle" type="checkbox" />
      <select id="recurring-type"><option value="monthly">Monthly</option></select>
      <input id="recurring-end" type="date" />
      <button id="submit-btn" type="submit">Add</button>
      <button id="cancel-edit-btn" type="button">Cancel</button>
    </form>
    <div id="toast-container"></div>
  `;
}

/**
 * Seed the form signals with values as if the user had loaded an existing
 * transaction into edit mode and changed the amount + description.
 */
function seedEditFormSignals(): void {
  formSignals.formAmount.value = '99.99';
  formSignals.formDescription.value = 'Edited description';
  formSignals.formTags.value = 'edited,tag';
  formSignals.formDate.value = '2026-04-21';
  formSignals.formNotes.value = 'edited notes';
  formSignals.formRecurring.value = false;
  formSignals.formRecurringType.value = 'monthly';
  formSignals.formRecurringEnd.value = '';
  // Explicitly not null — edit mode is active.
  (signals.editingId as { value: string | null }).value = 'tx_original_123';
  (signals.currentType as { value: string }).value = 'expense';
  (signals.selectedCategory as { value: string }).value = 'groceries';
}

/**
 * A fully-populated original transaction including every optional field the
 * prior partial-payload shape silently stripped. The fix must preserve all of
 * these in the `dataSdk.update` call.
 */
function makeFullOriginalTransaction(): Transaction {
  return {
    __backendId: 'tx_original_123',
    type: 'expense',
    amount: 10.00,
    description: 'Original description',
    date: '2026-04-20',
    category: 'other',
    tags: 'old',
    notes: 'old notes',
    currency: 'EUR', // non-USD to catch currency-stripping regressions
    recurring: true,
    recurring_type: 'monthly',
    recurring_end: '2027-04-20',
    reconciled: true,
    splits: false,
    parentTxId: 'tx_parent_999',
    debtId: 'debt_abc',
    recurringTemplateId: 'rt_xyz',
  };
}

// ==========================================
// TESTS
// ==========================================

describe('form-events edit-merge contract (7b P2)', () => {
  beforeEach(() => {
    setupFormDOM();
    DOM.clearAll();
    dataSdkMock.create.mockReset();
    dataSdkMock.update.mockReset();
    dataSdkMock.get.mockReset();
    dataSdkMock.create.mockResolvedValue({ isOk: true });
    dataSdkMock.update.mockResolvedValue({ isOk: true });
    dataSdkMock.get.mockResolvedValue(undefined);
    showToastMock.mockReset();
  });

  afterEach(() => {
    cleanupFormEvents();
    DOM.clearAll();
    document.body.innerHTML = '';
    (signals.editingId as { value: string | null }).value = null;
  });

  it('preserves currency / recurring / debtId / recurringTemplateId / reconciled when editing a transaction', async () => {
    const original = makeFullOriginalTransaction();
    dataSdkMock.get.mockResolvedValue(original);

    initFormEvents({});
    seedEditFormSignals();

    await handleFormSubmit();

    // dataSdk.get was called with the editing id to fetch the original row.
    expect(dataSdkMock.get).toHaveBeenCalledWith('tx_original_123');

    // dataSdk.update received a fully-merged payload: form-edited fields on
    // top, everything else preserved from the original.
    expect(dataSdkMock.update).toHaveBeenCalledTimes(1);
    const updatedCall = dataSdkMock.update.mock.calls[0];
    if (!updatedCall) throw new Error('dataSdk.update was not invoked');
    const payload = updatedCall[0] as Transaction;

    // Edited fields reflect the form state.
    expect(payload.amount).toBe(99.99);
    expect(payload.description).toBe('Edited description');
    expect(payload.tags).toBe('edited,tag');
    expect(payload.notes).toBe('edited notes');
    expect(payload.category).toBe('groceries');
    expect(payload.type).toBe('expense');
    expect(payload.date).toBe('2026-04-21');
    expect(payload.__backendId).toBe('tx_original_123');

    // Fields NOT on the form must survive the edit. These are the ones the
    // pre-fix partial-payload path silently stripped.
    expect(payload.currency).toBe('EUR');
    expect(payload.recurring).toBe(true);
    expect(payload.recurring_type).toBe('monthly');
    expect(payload.recurring_end).toBe('2027-04-20');
    expect(payload.reconciled).toBe(true);
    expect(payload.splits).toBe(false);
    expect(payload.parentTxId).toBe('tx_parent_999');
    expect(payload.debtId).toBe('debt_abc');
    expect(payload.recurringTemplateId).toBe('rt_xyz');
  });

  it('surfaces an error toast and does not call update when the original row is missing', async () => {
    // Simulates: the row was deleted in another tab (or rolled back / import-
    // replaced) between edit-mode open and form submit. The pre-fix code would
    // have written a phantom row with every non-form field undefined.
    dataSdkMock.get.mockResolvedValue(undefined);

    initFormEvents({});
    seedEditFormSignals();

    await handleFormSubmit();

    expect(dataSdkMock.get).toHaveBeenCalledWith('tx_original_123');
    expect(dataSdkMock.update).not.toHaveBeenCalled();

    // Error toast fired with the specific "no longer exists" copy.
    expect(showToastMock).toHaveBeenCalledTimes(1);
    const toastCall = showToastMock.mock.calls[0];
    if (!toastCall) throw new Error('showToast was not invoked');
    const [message, level] = toastCall as [string, string];
    expect(level).toBe('error');
    expect(message).toMatch(/no longer exists/i);
  });
});
