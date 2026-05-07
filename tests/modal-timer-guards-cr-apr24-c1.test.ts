import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openModal, closeModal } from '../js/modules/ui/core/ui.js';

/**
 * CR-Apr24-C1 [P2×3] — Modal open/close timer guards
 * (Code-Review-Report findings 114, 115, 119).
 *
 * Pre-fix: openModal()'s deferred initial-focus and closeModal()'s
 * deferred focus-restore (single-modal AND nested-modal paths) ran on
 * setTimeout callbacks with no "still open?" / "still topmost?" / "no
 * newer modal opened?" checks. Quick close+open / nested-handoff
 * sequences let the queued callback yank focus into a hidden or
 * no-longer-topmost modal, breaking keyboard nav and SR announcements.
 *
 * Fix pattern: each setTimeout body re-validates the modal-stack state
 * captured at scheduling time AND bails when the captured state no
 * longer matches the live state.
 */

function seedDom(): void {
  document.body.innerHTML = `
    <div id="app">
      <button id="opener">Open</button>
    </div>
    <div id="modal-a" class="modal-overlay" style="display:none">
      <button id="a-btn-1">A1</button>
      <button id="a-btn-2">A2</button>
    </div>
    <div id="modal-b" class="modal-overlay" style="display:none">
      <button id="b-btn-1">B1</button>
    </div>
  `;
}

describe('CR-Apr24-C1 — modal open/close timer guards', () => {
  beforeEach(() => {
    seedDom();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  describe('finding 114 — openModal initial focus bails when modal closed before timer fires', () => {
    it('does not focus a control inside a modal that was closed before the focus timer fired', () => {
      const opener = document.getElementById('opener') as HTMLButtonElement;
      opener.focus();
      expect(document.activeElement).toBe(opener);

      openModal('modal-a');
      // Close immediately — before the deferred focus timer fires.
      closeModal('modal-a');

      // Run all pending timers.
      vi.runAllTimers();

      // Focus must NOT have moved into modal-a (its controls are inside
      // a now-hidden modal). It should be the opener (closeModal restores)
      // or stay where it was — either way, NOT inside modal-a.
      const a1 = document.getElementById('a-btn-1');
      const a2 = document.getElementById('a-btn-2');
      expect(document.activeElement).not.toBe(a1);
      expect(document.activeElement).not.toBe(a2);
    });

    it('does not focus modal-A when modal-B was opened on top before A timer fires', () => {
      const opener = document.getElementById('opener') as HTMLButtonElement;
      opener.focus();

      openModal('modal-a');
      // Stack a second modal on top before the A focus timer fires.
      openModal('modal-b');

      vi.runAllTimers();

      // A's deferred focus should bail because A is no longer the
      // topmost modal — B's focus path takes over instead. Final focus
      // should be in B.
      const a1 = document.getElementById('a-btn-1');
      expect(document.activeElement).not.toBe(a1);
    });
  });

  describe('finding 115 — closeModal focus restore bails when a new modal opens before fire', () => {
    it('does not steal focus back from a newly-opened modal', () => {
      const opener = document.getElementById('opener') as HTMLButtonElement;
      opener.focus();

      openModal('modal-a');
      vi.runAllTimers(); // let A's focus settle

      closeModal('modal-a');
      // Open B BEFORE the A close timer fires (race with fast user nav).
      openModal('modal-b');

      vi.runAllTimers();

      // B's open-focus must win. The A close-focus-restore must have
      // bailed (it would have moved focus back to opener — destroying
      // B's freshly-mounted focus state).
      expect(document.activeElement).not.toBe(opener);
    });

    it('still attempts focus restore on a clean close (no race)', () => {
      // happy-dom does not always blur an element when its container's
      // display flips to none, so testing exact `activeElement` after
      // the close path is unreliable. Instead, verify the close path
      // didn't bail out spuriously: stack is empty + the inert flag was
      // removed from the app container (only happens when the close-time
      // post-stack branch runs).
      const opener = document.getElementById('opener') as HTMLButtonElement;
      opener.focus();

      openModal('modal-a');
      vi.runAllTimers();

      closeModal('modal-a');
      vi.runAllTimers();

      // Post-close contract: app no longer inert (modal-stack empty).
      const app = document.getElementById('app');
      expect(app?.hasAttribute('inert')).toBe(false);
      expect(app?.hasAttribute('aria-hidden')).toBe(false);
    });

    it('bails when previousFocus element has been removed from the DOM', () => {
      const opener = document.getElementById('opener') as HTMLButtonElement;
      opener.focus();

      openModal('modal-a');
      vi.runAllTimers();

      // Remove opener from DOM before close timer fires.
      opener.remove();

      // Should not throw.
      expect(() => {
        closeModal('modal-a');
        vi.runAllTimers();
      }).not.toThrow();
    });
  });

  describe('finding 119 — nested-modal focus handoff bails when parent changed before fire', () => {
    it('does not throw when parent was closed before child-close timer fires', () => {
      // The structural guard lock: scheduling the child-close focus
      // restore against a captured `topModal` reference, then closing
      // that parent before the timer fires, must not produce a runtime
      // error from accessing a missing DOM node. happy-dom's focus
      // model isn't reliable enough to assert exact final focus across
      // display:none transitions, so we lock in the no-throw contract.
      const opener = document.getElementById('opener') as HTMLButtonElement;
      opener.focus();

      expect(() => {
        openModal('modal-a');     // parent
        vi.runAllTimers();
        openModal('modal-b');     // child stacked on top
        vi.runAllTimers();
        closeModal('modal-b');
        closeModal('modal-a');
        vi.runAllTimers();
      }).not.toThrow();

      // Stack should be fully cleared.
      const app = document.getElementById('app');
      expect(app?.hasAttribute('inert')).toBe(false);
    });

    it('clean nested close-child path: focus returns to parent', () => {
      const opener = document.getElementById('opener') as HTMLButtonElement;
      opener.focus();

      openModal('modal-a');
      vi.runAllTimers();
      const a1 = document.getElementById('a-btn-1') as HTMLButtonElement;
      a1.focus(); // user navigates to a specific control in parent

      openModal('modal-b');
      vi.runAllTimers();

      closeModal('modal-b');
      vi.runAllTimers();

      // Recorded child focus was a1; parent (A) is still topmost; clean
      // restore should put focus back on a1.
      expect(document.activeElement).toBe(a1);
    });
  });
});
