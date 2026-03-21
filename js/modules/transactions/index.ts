/**
 * Transactions Module - Public API
 *
 * Re-exports from all transaction-related submodules.
 *
 * @module transactions
 */
'use strict';

// Transaction row rendering
export {
  transactionRowTemplate,
  renderTransactionRowIntoContainer,
  type CurrencyFormatter,
  type CategoryInfoGetter
} from './transaction-row.js';

// Template management
export {
  saveAsTemplate,
  applyTemplate,
  deleteTemplate,
  renderTemplates,
  setTemplateFmtCurFn,
  setTemplateRenderCategoriesFn,
  setTemplateSwitchTabFn
} from './template-manager.js';

// Edit mode
export {
  startEditing,
  cancelEditing,
  mountRecurringPreview,
  mountEditUI
} from './edit-mode.js';
