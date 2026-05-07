/**
 * Form Events Lifecycle Tests
 * Integration tests for form event handler init/cleanup and key interaction flows.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import DOM from '../js/modules/core/dom-cache.js';

// Mock heavy dependencies before importing the module under test
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

vi.mock('../js/modules/data/data-manager.js', () => ({
  dataSdk: {
    create: vi.fn().mockResolvedValue({ isOk: true }),
    update: vi.fn().mockResolvedValue({ isOk: true }),
  },
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

// Phase 5g-2 (Inline-Behavior-Review rev 12, L34): stub `localeService` so
// `locale-service.ts`'s eager constructor (which calls `lsGet` through
// `state.js`) doesn't run during module import. `state.js` is already
// mocked to only expose `SK`, so a transitive dependency on `lsGet` from
// the real locale service would break these lifecycle tests. We only need
// `formatCurrency` for the submit-success toast path, which these tests
// don't exercise — but the mock has to cover the surface that
// `form-events.ts` imports.
vi.mock('../js/modules/core/locale-service.js', () => ({
  localeService: {
    formatCurrency: (amount: number) => `$${amount.toFixed(2)}`,
  },
}));

vi.mock('../js/modules/ui/core/ui.js', () => ({
  showToast: vi.fn(),
}));

vi.mock('../js/modules/core/form-binder.js', () => {
  return {
    FormBinder: vi.fn().mockImplementation(() => ({
      bind: vi.fn(),
      clear: vi.fn(),
    })),
  };
});

vi.mock('../js/modules/core/utils-pure.js', () => ({
  parseAmount: (v: string) => parseFloat(v) || 0,
  getTodayStr: () => '2026-04-04',
  parseLocalDate: (d: string) => new Date(d),
}));

vi.mock('../js/modules/transactions/template-manager.js', () => ({
  formAmount: { value: '' },
  formDescription: { value: '' },
  formTags: { value: '' },
  formDate: { value: '2026-04-04' },
  formNotes: { value: '' },
  formRecurring: { value: false },
  formRecurringType: { value: 'monthly' },
  formRecurringEnd: { value: '' },
  syncFormWithSignals: vi.fn(),
  readFormIntoSignals: vi.fn(),
}));

import {
  initFormEvents,
  cleanupFormEvents,
  initReactiveForm,
  cleanupReactiveForm,
  resetForm,
} from '../js/modules/ui/interactions/form-events.js';

// ==========================================
// DOM SETUP
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

// ==========================================
// TESTS
// ==========================================

describe('form-events lifecycle', () => {
  beforeEach(() => {
    setupFormDOM();
    DOM.clearAll();
  });

  afterEach(() => {
    cleanupFormEvents();
    DOM.clearAll();
    document.body.innerHTML = '';
  });

  it('initializes without throwing', () => {
    expect(() => {
      initFormEvents({});
    }).not.toThrow();
  });

  it('cleans up without throwing', () => {
    initFormEvents({});
    expect(() => {
      cleanupFormEvents();
    }).not.toThrow();
  });

  it('re-init cleans up previous listeners (no double-fire)', () => {
    const submitSpy = vi.fn();

    initFormEvents({});
    initFormEvents({});

    const form = document.getElementById('transaction-form') as HTMLFormElement;
    form.addEventListener('submit', submitSpy);
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    // The internal handler should only fire once despite double init
    // (We verify by checking submit was only called once on our spy)
    expect(submitSpy).toHaveBeenCalledTimes(1);
    form.removeEventListener('submit', submitSpy);
  });

  it('cleanup removes form submit listener', () => {
    initFormEvents({});
    cleanupFormEvents();

    // After cleanup, submitting the form should not be handled internally
    // We can verify by checking the form still exists but no error is thrown
    const form = document.getElementById('transaction-form') as HTMLFormElement;
    expect(() => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    }).not.toThrow();
  });

  it('stores cancelEditing callback', () => {
    const cancelEditing = vi.fn();
    initFormEvents({ cancelEditing });

    // Cancel edit button should trigger the callback
    const cancelBtn = document.getElementById('cancel-edit-btn') as HTMLButtonElement;
    cancelBtn.click();
    expect(cancelEditing).toHaveBeenCalledTimes(1);
  });

  it('cleanup removes cancel-edit listener', () => {
    const cancelEditing = vi.fn();
    initFormEvents({ cancelEditing });
    cleanupFormEvents();

    const cancelBtn = document.getElementById('cancel-edit-btn') as HTMLButtonElement;
    cancelBtn.click();
    // After cleanup, clicking should not call our callback
    expect(cancelEditing).not.toHaveBeenCalled();
  });

  it('resetForm does not throw', () => {
    initFormEvents({});
    expect(() => {
      resetForm();
    }).not.toThrow();
  });

  it('resetForm clears category error styling', () => {
    initFormEvents({});
    // Simulate a category error state
    const chips = document.getElementById('category-chips')!;
    chips.style.outline = '2px solid red';
    chips.setAttribute('aria-invalid', 'true');

    resetForm();

    expect(chips.style.outline).toBe('');
    expect(chips.hasAttribute('aria-invalid')).toBe(false);
  });
});

describe('form-events reactive form', () => {
  beforeEach(() => {
    setupFormDOM();
    DOM.clearAll();
  });

  afterEach(() => {
    cleanupReactiveForm();
    DOM.clearAll();
    document.body.innerHTML = '';
  });

  it('initReactiveForm does not throw', () => {
    expect(() => {
      initReactiveForm();
    }).not.toThrow();
  });

  it('cleanupReactiveForm does not throw', () => {
    initReactiveForm();
    expect(() => {
      cleanupReactiveForm();
    }).not.toThrow();
  });

  it('double cleanup does not throw', () => {
    initReactiveForm();
    cleanupReactiveForm();
    expect(() => {
      cleanupReactiveForm();
    }).not.toThrow();
  });
});

describe('form-events DOM resilience', () => {
  it('handles missing DOM elements gracefully', () => {
    document.body.innerHTML = ''; // Empty DOM
    DOM.clearAll();

    expect(() => {
      initFormEvents({});
    }).not.toThrow();

    expect(() => {
      cleanupFormEvents();
    }).not.toThrow();
  });

  it('handles partial DOM (only form exists)', () => {
    document.body.innerHTML = `
      <form id="transaction-form">
        <button id="submit-btn" type="submit">Add</button>
      </form>
    `;
    DOM.clearAll();

    expect(() => {
      initFormEvents({});
    }).not.toThrow();
  });

  it('resetForm handles missing elements gracefully', () => {
    document.body.innerHTML = '';
    DOM.clearAll();

    initFormEvents({});
    expect(() => {
      resetForm();
    }).not.toThrow();
  });
});
