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

  // Design-Review-Apr21 P2 (batch 6 follow-up): conflict-resolution dialogs
  // must never treat dismissal as a decision. Previously backdrop-click and
  // Escape both programmatically clicked `#sync-keep-local`, silently
  // committing the local side of a data conflict on an accidental tap /
  // reflexive keypress. Both paths are now no-ops — the only way out is an
  // explicit "Keep Local" / "Use Cloud" click — so these tests lock in the
  // new behavior: spy uncalled + modal stays `active`.

  it('does not commit keep-local on backdrop click', () => {
    const keepLocal = document.getElementById('sync-keep-local') as HTMLButtonElement;
    const keepLocalSpy = vi.fn();
    keepLocal.addEventListener('click', keepLocalSpy);

    openModal('sync-conflict-modal');
    const modal = document.getElementById('sync-conflict-modal') as HTMLDivElement;
    modal.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(keepLocalSpy).not.toHaveBeenCalled();
    expect(modal.classList.contains('active')).toBe(true);
    expect(modal.classList.contains('hidden')).toBe(false);
  });

  it('does not commit keep-local on Escape press', () => {
    const keepLocal = document.getElementById('sync-keep-local') as HTMLButtonElement;
    const keepLocalSpy = vi.fn();
    keepLocal.addEventListener('click', keepLocalSpy);

    openModal('sync-conflict-modal');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    const modal = document.getElementById('sync-conflict-modal') as HTMLDivElement;

    expect(keepLocalSpy).not.toHaveBeenCalled();
    expect(modal.classList.contains('active')).toBe(true);
    expect(modal.classList.contains('hidden')).toBe(false);
  });
});
