/**
 * Focus Trap Utility
 *
 * Lightweight focus trap for modal dialogs. Keeps Tab / Shift+Tab cycling
 * within the modal's focusable descendants so keyboard users can't tab
 * out of an active dialog.
 *
 * @module ui/components/focus-trap
 */
'use strict';

// Selector covering all natively focusable elements and elements with
// explicit tabindex. Filters out disabled and inert elements at runtime.
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

/**
 * Get all focusable elements within a container, filtered to visible ones.
 */
function getFocusableElements(container: HTMLElement): HTMLElement[] {
  const candidates = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
  return candidates.filter(el => {
    // Skip hidden or zero-dimension elements
    if (el.offsetParent === null && el.style.position !== 'fixed') return false;
    // Skip elements inside inert subtrees
    if (el.closest('[inert]')) return false;
    return true;
  });
}

/**
 * Create a focus trap keydown handler for a container.
 * Returns the handler function so it can be removed later.
 *
 * @param container - The modal element to trap focus within
 * @returns A keydown event handler that enforces the trap
 */
export function createFocusTrapHandler(container: HTMLElement): (e: KeyboardEvent) => void {
  return (e: KeyboardEvent) => {
    if (e.key !== 'Tab') return;

    const focusable = getFocusableElements(container);
    if (focusable.length === 0) return;

    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    const active = document.activeElement;

    if (e.shiftKey) {
      // Shift+Tab: if at first element (or outside container), wrap to last
      if (active === first || !container.contains(active as Node)) {
        e.preventDefault();
        last.focus();
      }
    } else {
      // Tab: if at last element (or outside container), wrap to first
      if (active === last || !container.contains(active as Node)) {
        e.preventDefault();
        first.focus();
      }
    }
  };
}

/**
 * Activate a focus trap on a container.
 * Returns a cleanup function that removes the trap.
 */
export function activateFocusTrap(container: HTMLElement): () => void {
  const handler = createFocusTrapHandler(container);
  container.addEventListener('keydown', handler);
  return () => container.removeEventListener('keydown', handler);
}
