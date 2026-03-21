/**
 * Tab ID Module
 * 
 * Simple standalone module to provide a unique identifier for the current browser tab.
 * Extracted to avoid circular dependencies between core modules.
 */
import { generateId } from './utils-dom.js';

/**
 * Unique identifier for this tab session
 */
export const TAB_ID = generateId();

/**
 * Get the current tab identifier
 */
export function getTabId(): string {
  return TAB_ID;
}
