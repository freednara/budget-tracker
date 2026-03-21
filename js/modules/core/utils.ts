/**
 * Utility Functions Module
 * 
 * Re-exports utilities from split modules for backwards compatibility.
 * New code should import directly from utils-pure or utils-dom as needed.
 *
 * @module utils
 * @deprecated Import from utils-pure or utils-dom directly
 */

// Re-export all pure utilities
export {
  // Currency
  CURRENCY_MAP,
  fmtCur,
  
  // Date utilities
  parseLocalDate,
  getMonthKey,
  parseMonthKey,
  monthLabel,
  getPrevMonthKey,
  getNextMonthKey,
  getTodayStr,
  formatDateForInput,
  
  // Financial calculations
  toCents,
  toDollars,
  addAmounts,
  subtractAmounts,
  parseAmount,
  sumByType,
  
  // Math utilities
  calcPercentage,
  clamp,
  linearTrend,

  // Season utilities
  getSeason,
  
  // Function utilities
  debounce,
  
  // ID generation (pure version - for non-critical use only)
  generateId,
  
  // Number formatting
  formatNumber,
  
  // Logging
  logError,
  
  // String utilities
  escAttr
} from './utils-pure.js';

// Re-export all DOM utilities
export {
  // File/download utilities
  downloadBlob,
  
  // HTML/XSS protection
  esc,
  escapeHtml,
  safeSetHTML,
  
  // ID generation (secure version)
  generateSecureId,
  
  // Clipboard utilities
  copyToClipboard,
  
  // Visibility utilities
  isElementInViewport,
  scrollIntoViewSmooth,
  
  // Focus management
  trapFocus,
  
  // Animation utilities
  requestFrame,
  cancelFrame
} from './utils-dom.js';

// ==========================================
// SECURE ID GENERATION NOTES
// ==========================================

// Note: For critical data (Transaction IDs, etc.), prefer generateSecureId over generateId
// generateId (from utils-pure) uses Math.random - suitable for non-critical use only
// generateSecureId (from utils-dom) uses crypto.randomUUID() - secure for critical data