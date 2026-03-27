import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { clearFieldErrorMock } = vi.hoisted(() => ({
  clearFieldErrorMock: vi.fn(),
}));

vi.mock('../js/modules/core/validator.js', async () => {
  const actual = await vi.importActual('../js/modules/core/validator.js');
  return {
    ...actual,
    clearFieldError: clearFieldErrorMock,
  };
});

import DOM from '../js/modules/core/dom-cache.js';
import { initKeyboardEvents } from '../js/modules/ui/interactions/keyboard-events.js';

describe('keyboard-events lifecycle', () => {
  let cleanup: (() => void) | null = null;

  beforeEach(() => {
    clearFieldErrorMock.mockReset();
    document.body.innerHTML = `
      <input id="amount" />
      <input id="date" />
    `;
    DOM.clearAll();
  });

  afterEach(() => {
    cleanup?.();
    cleanup = null;
    DOM.clearAll();
    document.body.innerHTML = '';
  });

  it('does not duplicate validation listeners after re-init and removes them on cleanup', () => {
    initKeyboardEvents({});
    cleanup = initKeyboardEvents({});

    const amountInput = document.getElementById('amount') as HTMLInputElement;
    const dateInput = document.getElementById('date') as HTMLInputElement;

    amountInput.dispatchEvent(new Event('input', { bubbles: true }));
    dateInput.dispatchEvent(new Event('change', { bubbles: true }));

    expect(clearFieldErrorMock).toHaveBeenNthCalledWith(1, 'amount');
    expect(clearFieldErrorMock).toHaveBeenNthCalledWith(2, 'date');

    cleanup();
    cleanup = null;

    amountInput.dispatchEvent(new Event('input', { bubbles: true }));
    dateInput.dispatchEvent(new Event('change', { bubbles: true }));

    expect(clearFieldErrorMock).toHaveBeenCalledTimes(2);
  });
});
