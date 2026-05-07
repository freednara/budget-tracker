/**
 * State Actions — Barrel Re-export
 *
 * This file was split into `core/actions/*.ts` during ADR-001 Phase 1.
 * It re-exports everything under the same public names so that the 28+
 * existing import sites (`from '../core/state-actions.js'`) continue to
 * work without modification.
 *
 * @module state-actions
 */

export { batchUpdates } from './actions/action-utils.js';
export { navigation } from './actions/navigation-actions.js';
export { form, modal, cleanupModalState } from './actions/form-actions.js';
export { settings, data, savingsGoals, debts, achievements } from './actions/data-actions.js';
export { pagination, filters, calendar, alerts, onboarding } from './actions/filters-actions.js';
export { syncState } from './actions/sync-state-actions.js';

// Combined actions export — preserves the `import { actions } from ...` pattern.
import { batchUpdates } from './actions/action-utils.js';
import { navigation } from './actions/navigation-actions.js';
import { form, modal } from './actions/form-actions.js';
import { settings, data, savingsGoals, debts, achievements } from './actions/data-actions.js';
import { pagination, filters, calendar, alerts, onboarding } from './actions/filters-actions.js';
import { syncState } from './actions/sync-state-actions.js';

export const actions = {
  batchUpdates,
  navigation,
  form,
  modal,
  settings,
  data,
  savingsGoals,
  pagination,
  filters,
  calendar,
  alerts,
  onboarding,
  debts,
  achievements,
  syncState
};

export default actions;
