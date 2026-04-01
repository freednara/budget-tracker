import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import DOM from '../js/modules/core/dom-cache.js';
import { openModal, closeModal } from '../js/modules/ui/core/ui.js';
import { initKeyboardEvents } from '../js/modules/ui/interactions/keyboard-events.js';

describe('sync conflict modal resolution paths', () => {
  let cleanupKeyboard = (): void => {};

  beforeEach(() => {
    DOM.clearAll();
    document.body.innerHTML = `
      <div id="app"></div>
      <div id="sync-conflict-modal" class="modal-overlay hidden" aria-hidden="true">
        <button id="sync-keep-local" type="button">Keep local</button>
      </div>
    `;
    cleanupKeyboard = initKeyboardEvents({});
  });

  afterEach(() => {
    cleanupKeyboard();
    closeModal('sync-conflict-modal');
    DOM.clearAll();
    document.body.innerHTML = '';
  });

  it('routes backdrop dismissal through the keep-local action', () => {
    const keepLocal = document.getElementById('sync-keep-local') as HTMLButtonElement;
    const keepLocalSpy = vi.fn();
    keepLocal.addEventListener('click', keepLocalSpy);

    openModal('sync-conflict-modal');
    const modal = document.getElementById('sync-conflict-modal') as HTMLDivElement;
    modal.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(keepLocalSpy).toHaveBeenCalledTimes(1);
  });

  it('routes Escape dismissal through the keep-local action', () => {
    const keepLocal = document.getElementById('sync-keep-local') as HTMLButtonElement;
    const keepLocalSpy = vi.fn();
    keepLocal.addEventListener('click', keepLocalSpy);

    openModal('sync-conflict-modal');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(keepLocalSpy).toHaveBeenCalledTimes(1);
  });
});
