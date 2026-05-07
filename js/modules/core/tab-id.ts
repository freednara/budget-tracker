/**
 * Tab ID Module
 *
 * Simple standalone module to provide a unique identifier for the current browser tab.
 * Extracted to avoid circular dependencies between core modules.
 *
 * CR-Apr24-I finding 347: persisted in sessionStorage so the same tab
 * retains its identity across reloads, matching the documented "tab
 * session" contract.
 */
import { generateId } from './utils-dom.js';

const TAB_ID_KEY = 'harbor_tab_id';

function resolveTabId(): string {
  try {
    const stored = sessionStorage.getItem(TAB_ID_KEY);
    if (stored) return stored;
    const id = generateId();
    sessionStorage.setItem(TAB_ID_KEY, id);
    return id;
  } catch {
    // sessionStorage unavailable (e.g. iframe sandbox) — fall back to ephemeral id
    return generateId();
  }
}

/**
 * Unique identifier for this tab session
 */
export const TAB_ID = resolveTabId();

/**
 * Get the current tab identifier
 */
export function getTabId(): string {
  return TAB_ID;
}
