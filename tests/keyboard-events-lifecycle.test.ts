import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import DOM from '../js/modules/core/dom-cache.js';
import { initKeyboardEvents } from '../js/modules/ui/interactions/keyboard-events.js';
// Phase 5g-1 (Inline-Behavior-Review rev 12, L52): the standalone
// `clearFieldError(fieldName)` export was deleted from validator.ts.
// keyboard-events.ts now calls `validator.clearFieldError(element)` on the
// singleton, so the test spies on that singleton method (with the actual
// element argument) instead of mocking the deleted named export.
import { validator } from '../js/modules/core/validator.js';

describe('keyboard-events lifecycle', () => {
  let cleanup: (() => void) | null = null;
  let clearFieldErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    document.body.innerHTML = `
      <input id="amount" />
      <input id="date" />
    `;
    DOM.clearAll();
    clearFieldErrorSpy = vi.spyOn(validator, 'clearFieldError').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup?.();
    cleanup = null;
    DOM.clearAll();
    document.body.innerHTML = '';
    clearFieldErrorSpy.mockRestore();
  });

  it('does not duplicate validation listeners after re-init and removes them on cleanup', () => {
    initKeyboardEvents({});
    cleanup = initKeyboardEvents({});

    const amountInput = document.getElementById('amount') as HTMLInputElement;
    const dateInput = document.getElementById('date') as HTMLInputElement;

    amountInput.dispatchEvent(new Event('input', { bubbles: true }));
    dateInput.dispatchEvent(new Event('change', { bubbles: true }));

    expect(clearFieldErrorSpy).toHaveBeenNthCalledWith(1, amountInput);
    expect(clearFieldErrorSpy).toHaveBeenNthCalledWith(2, dateInput);

    cleanup();
    cleanup = null;

    amountInput.dispatchEvent(new Event('input', { bubbles: true }));
    dateInput.dispatchEvent(new Event('change', { bubbles: true }));

    expect(clearFieldErrorSpy).toHaveBeenCalledTimes(2);
  });
});
