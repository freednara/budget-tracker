/**
 * UI Module
 * Core UI components: toasts, progress indicators, modals
 */

import DOM from '../../core/dom-cache.js';
import { on, Events } from '../../core/event-bus.js';
import { cleanupModalState } from '../../core/state-actions.js';
// Design-Review-Apr21 P3 (batch 6 follow-up): `clearImportData` import
// removed — backdrop dismissal of the import-options modal now preserves
// `_importData` so an accidental tap outside the dialog doesn't force a
// re-parse of the selected backup file.

// ==========================================
// TYPE DEFINITIONS
// ==========================================

type ToastType = 'success' | 'error' | 'info' | 'warning';

interface ToastColors {
  bg: string;
  icon: string;
}

interface TimingConfigInternal {
  TOAST_DURATION: number;
  TOAST_FADE_OUT: number;
  MODAL_FOCUS_DELAY: number;
}

interface SwipeManagerLike {
  closeAll: () => void;
}

// ==========================================
// CONFIGURATION
// ==========================================

/**
 * Default timing configuration (can be overridden)
 */
const DEFAULT_TIMING: TimingConfigInternal = {
  TOAST_DURATION: 3000,
  TOAST_FADE_OUT: 300,
  MODAL_FOCUS_DELAY: 50
};

// Store timing config (will be set from main app)
let timingConfig: TimingConfigInternal = DEFAULT_TIMING;

/**
 * Set timing configuration
 */
export function setTimingConfig(config: Partial<TimingConfigInternal>): void {
  timingConfig = { ...DEFAULT_TIMING, ...config };
}

// ==========================================
// TOAST NOTIFICATIONS
// ==========================================

/**
 * Show a toast notification
 */
export function showToast(message: string, type: ToastType = 'success'): void {
  const container = DOM.get('toast-container');
  if (!container) return;

  const colors: Record<ToastType, ToastColors> = {
    success: { bg: 'var(--color-income)', icon: '✓' },
    error: { bg: 'var(--color-expense)', icon: '✕' },
    info: { bg: 'var(--color-accent)', icon: 'ℹ' },
    warning: { bg: 'var(--color-warning)', icon: '⚠' }
  };

  const { bg, icon } = colors[type] || colors.info;

  const toast = document.createElement('div');
  toast.className = 'toast-item px-4 py-3 flex items-center gap-2 transform transition-all duration-300 translate-y-4 opacity-0';
  toast.style.cssText = `background: ${bg}; color: white; min-width: 200px;`;

  const iconEl = document.createElement('span');
  iconEl.className = 'font-bold';
  iconEl.textContent = icon;

  const messageEl = document.createElement('span');
  messageEl.className = 'text-sm font-semibold';
  messageEl.textContent = message;

  toast.append(iconEl, messageEl);

  container.appendChild(toast);

  requestAnimationFrame(() => {
    toast.classList.remove('translate-y-4', 'opacity-0');
  });

  setTimeout(() => {
    toast.classList.add('translate-y-4', 'opacity-0');
    setTimeout(() => toast.remove(), timingConfig.TOAST_FADE_OUT);
  }, timingConfig.TOAST_DURATION);
}

/**
 * Show an undo toast with action button
 * @returns Function to dismiss the toast early
 */
export function showUndoToast(
  message: string,
  // Phase 6 Slice 1b (L5 #181): widened to `void | Promise<void>` so
  // callers can pass async undo handlers (transaction-restore writes to
  // IndexedDB) without a sync-wrapper dance. Invocation sites must use
  // `void onUndo()` — the click handler is fire-and-forget and any
  // rejection should route through the caller's own trackError.
  onUndo: (() => void | Promise<void>) | null,
  duration: number = 5000
): () => void {
  const container = DOM.get('toast-container');
  if (!container) return () => {};

  const toast = document.createElement('div');
  toast.className = 'toast-item px-4 py-3 flex items-center gap-3 transform transition-all duration-300 translate-y-4 opacity-0';
  toast.style.cssText = 'background: var(--bg-card); color: var(--text-primary); min-width: 280px; border: 1px solid var(--border-input);';

  const messageEl = document.createElement('span');
  messageEl.className = 'flex-1 text-sm font-semibold';
  messageEl.textContent = message;

  const undoBtn = document.createElement('button');
  undoBtn.className = 'undo-btn px-3 py-1 rounded text-sm font-bold transition-colors';
  undoBtn.style.cssText = 'background: var(--color-accent); color: white;';
  undoBtn.textContent = 'Undo';

  const timerBar = document.createElement('div');
  timerBar.className = 'undo-timer-bar';
  timerBar.style.cssText = `position: absolute; bottom: 0; left: 0; right: 0; height: 3px; background: var(--color-accent); border-radius: 0 0 0.5rem 0.5rem; animation: undoTimer ${duration}ms linear forwards;`;

  toast.append(messageEl, undoBtn, timerBar);

  container.appendChild(toast);

  let dismissed = false;
  let timeoutId: ReturnType<typeof setTimeout>;

  const dismiss = (): void => {
    if (dismissed) return;
    dismissed = true;
    clearTimeout(timeoutId);
    toast.classList.add('translate-y-4', 'opacity-0');
    setTimeout(() => toast.remove(), timingConfig.TOAST_FADE_OUT);
  };

  // Handle undo click
  undoBtn.addEventListener('click', () => {
    // `void` discard: onUndo is `() => void | Promise<void>` per signature
    // note above. Rejections surface via the caller's own trackError.
    if (onUndo) void onUndo();
    dismiss();
  }, { once: true });

  // Animate in
  requestAnimationFrame(() => {
    toast.classList.remove('translate-y-4', 'opacity-0');
  });

  // Auto-dismiss after duration
  timeoutId = setTimeout(dismiss, duration);

  return dismiss;
}

// ==========================================
// PROGRESS MODAL
// ==========================================

/**
 * Show progress modal for async operations.
 *
 * Routes through openModal() so the progress overlay participates in the shared
 * modal stack: main content is marked inert, focus history is preserved, and
 * focus is moved into the dialog. Backdrop clicks are ignored for this modal
 * (see openModal) because progress is non-dismissible while an operation runs.
 */
export function showProgress(title: string, text: string = 'Please wait...', showBar: boolean = false): void {
  const modal = DOM.get('progress-modal');
  const titleEl = DOM.get('progress-title');
  const textEl = DOM.get('progress-text');
  const barContainer = DOM.get('progress-bar-container');

  if (!modal) return;

  if (titleEl) titleEl.textContent = title;
  if (textEl) textEl.textContent = text;

  if (showBar && barContainer) {
    barContainer.classList.remove('hidden');
    const progressBar = DOM.get('progress-bar');
    const progressCount = DOM.get('progress-count');
    if (progressBar) progressBar.style.width = '0%';
    if (progressCount) progressCount.textContent = '0 of 0';
  } else if (barContainer) {
    barContainer.classList.add('hidden');
  }

  openModal('progress-modal');
}

/**
 * Update progress bar
 */
export function updateProgress(current: number, total: number, text?: string): void {
  const textEl = DOM.get('progress-text');
  const bar = DOM.get('progress-bar');
  const count = DOM.get('progress-count');
  const barContainer = DOM.get('progress-bar-container');

  if (text && textEl) textEl.textContent = text;

  if (total > 0 && barContainer) {
    barContainer.classList.remove('hidden');
    const pct = Math.round((current / total) * 100);
    if (bar) bar.style.width = `${pct}%`;
    if (count) count.textContent = `${current} of ${total}`;
  }
}

/**
 * Hide progress modal.
 *
 * Routes through closeModal() to pop the progress overlay off the modal stack,
 * restore prior focus, and remove inert/aria-hidden from main content when no
 * other modals remain open.
 */
export function hideProgress(): void {
  closeModal('progress-modal');
}

// ==========================================
// MODAL MANAGEMENT
// ==========================================

// Track modal stack and focus history for nested modal support
const modalStack: string[] = [];
const modalFocusMap = new Map<string, Element | null>();

// Reference to swipeManager (set from main app)
let swipeManagerRef: SwipeManagerLike | null = null;

/**
 * Set swipe manager reference for modal integration
 */
export function setSwipeManager(manager: SwipeManagerLike): void {
  swipeManagerRef = manager;
}

/**
 * Get focusable elements within a container
 */
export function getFocusableElements(container: HTMLElement): NodeListOf<HTMLElement> {
  return container.querySelectorAll<HTMLElement>(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  );
}

// Design-Review-Apr21 P2: a modal is a "data-entry surface" when it hosts
// an editable input/select/textarea — clicking the backdrop on these
// discards the user's in-progress edits and there is no dirty-state or
// confirm UI to recover. Some modals explicitly opt out of this protection
// by setting `data-backdrop-close="force"` (e.g. the debt strategy viewer,
// which has one throwaway extra-payment field but is a read-only
// comparison surface). The presence of `data-backdrop-close="force"`
// short-circuits the protection so a backdrop tap still dismisses those.
function isDataEntryModal(modalEl: HTMLElement): boolean {
  if (modalEl.dataset['backdropClose'] === 'force') return false;
  const editable = modalEl.querySelector<HTMLElement>(
    'input:not([type="hidden"]):not([type="button"]):not([type="submit"]):not([type="reset"]), select, textarea'
  );
  return editable !== null;
}

/**
 * Trap focus within modal
 */
export function trapFocus(e: KeyboardEvent, modal: HTMLElement): void {
  const focusables = getFocusableElements(modal);
  const first = focusables[0];
  const last = focusables[focusables.length - 1];

  if (e.key === 'Tab') {
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last?.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first?.focus();
    }
  }
}

/**
 * Open a modal by ID
 */
export function openModal(id: string): void {
  const m = DOM.get(id);
  if (!m) return;

  // Close any open swipe actions
  if (swipeManagerRef && typeof swipeManagerRef.closeAll === 'function') {
    swipeManagerRef.closeAll();
  }

  // Store focus for this modal and track open order
  if (!m.classList.contains('active')) {
    modalStack.push(id);
    modalFocusMap.set(id, document.activeElement);
  }

  // Mark main content as inert for complete accessibility
  const mainContent = DOM.get('app');
  if (mainContent) {
    mainContent.setAttribute('inert', '');
    mainContent.setAttribute('aria-hidden', 'true');
  }

  m.classList.remove('hidden');
  m.classList.add('active');
  m.style.display = 'flex';
  m.removeAttribute('aria-hidden');

  // Auto-focus a safe initial control without triggering native picker UIs on iPhone.
  //
  // CR-Apr24-C1 [P2] finding 114: guard the deferred focus move against
  // a close-before-fire race. Pre-fix: if the user (or some side effect)
  // closed the modal between `openModal(id)` and the focus callback,
  // the timer would still run and yank focus into a hidden modal —
  // breaking keyboard nav for sighted users and announcing a hidden
  // dialog to screen readers. Bail when the modal is no longer marked
  // active OR is no longer the topmost modal in the stack (a quick
  // open-A → open-B sequence shouldn't have A's deferred focus
  // override B's freshly-mounted focus).
  setTimeout(() => {
    if (!m.classList.contains('active')) return;
    if (modalStack[modalStack.length - 1] !== id) return;

    const explicitInitialFocus = m.querySelector<HTMLElement>('[data-modal-initial-focus]:not([disabled])');
    if (explicitInitialFocus) {
      explicitInitialFocus.focus();
      return;
    }

    const firstSafeControl = m.querySelector<HTMLElement>(
      'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"]), input:not([disabled]):not([type="hidden"]), textarea:not([disabled])'
    );
    if (firstSafeControl) {
      firstSafeControl.focus();
      return;
    }

    const firstSelect = m.querySelector<HTMLElement>('select:not([disabled])');
    if (firstSelect) {
      firstSelect.focus();
      return;
    }

    m.tabIndex = -1;
    m.focus();
  }, timingConfig.MODAL_FOCUS_DELAY);

  // Setup focus trap and backdrop click (only once)
  const mWithFlag = m as HTMLElement & { _hasBackdropListener?: boolean };
  if (!mWithFlag._hasBackdropListener) {
    m.addEventListener('click', (e: MouseEvent) => {
      if (e.target !== m) return;
      // Settings backdrop click → cancel without saving (discard changes)
      if (id === 'settings-modal') {
        const cancelBtn = DOM.get('cancel-settings');
        cancelBtn?.click();
      } else if (id === 'sync-conflict-modal') {
        // Design-Review-Apr21 P2 (batch 6 follow-up): a conflict-resolution
        // dialog must never treat dismissal as a decision. Previously the
        // backdrop-click path programmatically triggered `#sync-keep-local`,
        // which silently committed one side of a data-conflict resolution
        // on an accidental tap outside the dialog — discarding the cloud
        // revision with no user intent. Treat backdrop as a no-op here
        // (matching the progress-modal pattern below) so the only way out
        // is an explicit "Keep Local" / "Use Cloud" selection. The
        // Escape-key path in keyboard-events.ts is symmetrically hardened.
        return;
      } else if (id === 'progress-modal') {
        // Progress overlay is non-dismissible while an async operation runs;
        // ignore backdrop clicks so users can't accidentally close it mid-flight.
        return;
      } else if (isDataEntryModal(m)) {
        // Design-Review-Apr21 P2: data-entry modals (forms with inputs/
        // selects/textareas where users may have in-progress edits) used
        // to close on accidental backdrop taps, discarding those edits
        // with no warning. Treat backdrop as a no-op for them so users
        // must use the explicit Cancel/Save controls — especially
        // important on touch devices where the tap target is generous.
        return;
      } else {
        // Design-Review-Apr21 P2: backdrop dismissal previously called
        // bare `closeModal(id)` and bypassed the per-modal state cleanup
        // that the Escape path already performs (`splitTxId`,
        // `addSavingsGoalId`, `deleteTargetId`, `pendingEditTx`, import
        // data). Route through the shared helper so both dismissal paths
        // leave signal state consistent instead of one stranding stale
        // ids behind a visually-closed overlay.
        closeModal(id);
        cleanupModalState(id);
        // Design-Review-Apr21 P3 (batch 6 follow-up): removed the
        // `clearImportData()` call that ran on backdrop dismissal of
        // the import-options chooser. Accidental backdrop taps were
        // discarding the parsed backup payload, forcing users to
        // reopen the file picker and re-parse from scratch —
        // especially punishing on touch devices and large backup
        // files. `_importData` is now preserved across accidental
        // dismissals; the explicit Cancel button path clears, and
        // `openImportFileChooser` short-circuits back to the chooser
        // modal when a parsed payload is already preserved.
      }
    });

    m.addEventListener('keydown', (e: KeyboardEvent) => trapFocus(e, m));
    mWithFlag._hasBackdropListener = true;
  }
}

/**
 * Close a modal by ID
 */
export function closeModal(id: string): void {
  const m = DOM.get(id);
  if (m) {
    m.classList.remove('active');
    m.classList.add('hidden');
    m.style.display = 'none';
    m.setAttribute('aria-hidden', 'true');

    // Remove closed modal from stack
    const idx = modalStack.lastIndexOf(id);
    if (idx !== -1) modalStack.splice(idx, 1);

    const activeModals = DOM.queryAll('.modal-overlay.active');
    if (activeModals.length === 0) {
      // Remove inert from main content only when no modals remain open
      const mainContent = DOM.get('app');
      if (mainContent) {
        mainContent.removeAttribute('inert');
        mainContent.removeAttribute('aria-hidden');
      }

      // Restore focus to the element that opened this modal.
      //
      // CR-Apr24-C1 [P2] finding 115: guard the deferred focus restoration
      // against a re-open-before-fire race. Pre-fix: closing modal A and
      // immediately opening modal B let A's queued focus-restore callback
      // fire AFTER B mounted, yanking focus out of B and into the
      // pre-modal control — breaking the user's expected focus path.
      // Bail if any modal is now open (in which case openModal's own
      // focus path is responsible) OR if the originally-stored focus
      // target has been removed from the document (would silently no-op
      // anyway, but the early-return is cheaper and clearer).
      const previousFocus = modalFocusMap.get(id) as HTMLElement | null;
      modalFocusMap.delete(id);
      if (previousFocus && typeof previousFocus.focus === 'function') {
        setTimeout(() => {
          if (modalStack.length > 0) return;
          if (!previousFocus.isConnected) return;
          previousFocus.focus();
        }, timingConfig.MODAL_FOCUS_DELAY);
      }
      return;
    }

    // Keep app inert while another modal remains open; move focus to the
    // right place within the remaining top modal.
    //
    // Design-Review-Apr21 P2 (batch 6 follow-up wave L): previously this
    // branch (a) deleted the closing child modal's recorded opener
    // without ever using it, and (b) reached for the first raw input/
    // select/textarea descendant of the parent, bypassing the parent's
    // `data-modal-initial-focus` target. In nested flows like Settings →
    // Reset App Data or Plan Budget → Add Category, the user's focus
    // landed on an arbitrary control instead of the button they opened
    // the child from — losing their place in the parent modal.
    //
    // New ordering (mirrors the activeModals-empty branch + openModal's
    // fallback chain so the focus-restore contract is consistent across
    // single- and multi-modal contexts):
    //   1. Recorded opener for the closing modal, if the element is still
    //      connected to the DOM AND inside the remaining top modal
    //      (covers the normal Parent-button → Child-modal → back-to-button
    //      flow without letting a stale DOM reference escape).
    //   2. Parent's explicit `data-modal-initial-focus` target, matching
    //      the opener's initial-focus contract.
    //   3. Parent's first-focusable control (button/link/tabbable) —
    //      the same selector openModal uses, not just input/select/
    //      textarea. Keeps the fallback consistent and covers parents
    //      that have no editable fields (read-only drill-downs).
    //   4. Parent panel itself via tabindex=-1 (SR-announcement safe).
    const previousChildFocus = modalFocusMap.get(id) as HTMLElement | null;
    modalFocusMap.delete(id);
    const topModalId = modalStack[modalStack.length - 1];
    const topModal = topModalId ? DOM.get(topModalId) : null;
    if (topModal) {
      setTimeout(() => {
        // CR-Apr24-C1 [P2] finding 119: guard the nested-modal focus
        // handoff against a parent-closed-before-fire race. Pre-fix:
        // closing child modal C, then quickly closing or replacing
        // parent modal P before this timer fires, let the queued
        // callback focus a hidden or no-longer-topmost modal. Bail when
        // the captured top modal isn't the current top modal anymore
        // (parent closed → empty stack, or parent replaced → different
        // id at top). The element reconnection check covers the
        // single-frame teardown window where the modal node itself was
        // removed from the document.
        const currentTopId = modalStack[modalStack.length - 1];
        if (currentTopId !== topModalId) return;
        if (!topModal.isConnected) return;

        if (
          previousChildFocus &&
          typeof previousChildFocus.focus === 'function' &&
          previousChildFocus.isConnected &&
          topModal.contains(previousChildFocus)
        ) {
          previousChildFocus.focus();
          return;
        }

        const explicitInitialFocus = topModal.querySelector<HTMLElement>(
          '[data-modal-initial-focus]:not([disabled])'
        );
        if (explicitInitialFocus) {
          explicitInitialFocus.focus();
          return;
        }

        const firstSafeControl = topModal.querySelector<HTMLElement>(
          'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"]), input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), select:not([disabled])'
        );
        if (firstSafeControl) {
          firstSafeControl.focus();
          return;
        }

        topModal.tabIndex = -1;
        topModal.focus();
      }, timingConfig.MODAL_FOCUS_DELAY);
    }
  }
}

// ==========================================
// UI EVENT LISTENERS
// ==========================================

// UI event bridge — allows core modules to trigger UI feedback without importing
// from the UI layer directly, keeping the dependency arrow: core → event-bus ← UI.
on<{ message: string; type?: ToastType }>(Events.SHOW_TOAST, ({ message, type }) => {
  showToast(message, type);
});

on<{ id: string }>(Events.OPEN_MODAL, ({ id }) => {
  openModal(id);
});

on<{ id: string }>(Events.CLOSE_MODAL, ({ id }) => {
  closeModal(id);
});

on<{ title: string; text?: string; showBar?: boolean }>(Events.SHOW_PROGRESS, ({ title, text, showBar }) => {
  showProgress(title, text, showBar);
});

on(Events.HIDE_PROGRESS, () => {
  hideProgress();
});
