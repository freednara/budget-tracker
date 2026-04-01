/**
 * UI Module
 * Core UI components: toasts, progress indicators, modals
 */

import DOM from '../../core/dom-cache.js';

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

// Extend HTMLElement to support custom property
interface ModalElement extends HTMLElement {
  _hasBackdropListener?: boolean;
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
    warning: { bg: '#f59e0b', icon: '⚠' }
  };

  const { bg, icon } = colors[type] || colors.info;

  const toast = document.createElement('div');
  toast.className = 'toast px-4 py-3 rounded-lg shadow-lg flex items-center gap-2 pointer-events-auto transform transition-all duration-300 translate-y-4 opacity-0';
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
  onUndo: (() => void) | null,
  duration: number = 5000
): () => void {
  const container = DOM.get('toast-container');
  if (!container) return () => {};

  const toast = document.createElement('div');
  toast.className = 'undo-toast px-4 py-3 rounded-lg shadow-lg flex items-center gap-3 pointer-events-auto transform transition-all duration-300 translate-y-4 opacity-0';
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
    if (onUndo) onUndo();
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
 * Show progress modal for async operations
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

  modal.classList.remove('hidden');
  modal.classList.add('active');
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
 * Hide progress modal
 */
export function hideProgress(): void {
  const modal = DOM.get('progress-modal');
  if (modal) {
    modal.classList.remove('active');
    modal.classList.add('hidden');
  }
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
  const m = DOM.get(id) as ModalElement | null;
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
  m.setAttribute('aria-hidden', 'false');

  // Auto-focus a safe initial control without triggering native picker UIs on iPhone.
  setTimeout(() => {
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
  if (!m._hasBackdropListener) {
    m.addEventListener('click', (e: MouseEvent) => {
      if (e.target !== m) return;
      // Settings backdrop click → cancel without saving (discard changes)
      if (id === 'settings-modal') {
        const cancelBtn = DOM.get('cancel-settings') as HTMLElement | null;
        cancelBtn?.click();
      } else if (id === 'sync-conflict-modal') {
        const keepLocalBtn = DOM.get('sync-keep-local') as HTMLElement | null;
        keepLocalBtn?.click();
      } else {
        closeModal(id);
      }
    });

    m.addEventListener('keydown', (e: KeyboardEvent) => trapFocus(e, m));
    m._hasBackdropListener = true;
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

    const activeModals = document.querySelectorAll('.modal-overlay.active');
    if (activeModals.length === 0) {
      // Remove inert from main content only when no modals remain open
      const mainContent = DOM.get('app');
      if (mainContent) {
        mainContent.removeAttribute('inert');
        mainContent.removeAttribute('aria-hidden');
      }

      // Restore focus to the element that opened this modal
      const previousFocus = modalFocusMap.get(id) as HTMLElement | null;
      modalFocusMap.delete(id);
      if (previousFocus && typeof previousFocus.focus === 'function') {
        setTimeout(() => previousFocus.focus(), timingConfig.MODAL_FOCUS_DELAY);
      }
      return;
    }

    // Keep app inert while another modal remains open; move focus to top modal
    modalFocusMap.delete(id);
    const topModalId = modalStack[modalStack.length - 1];
    const topModal = topModalId ? DOM.get(topModalId) : null;
    if (topModal) {
      setTimeout(() => {
        const firstInput = topModal.querySelector<HTMLElement>('input:not([disabled]), select:not([disabled]), textarea:not([disabled])');
        if (firstInput) {
          firstInput.focus();
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

// UI event bridge removed - all callers now import showToast/showProgress directly
