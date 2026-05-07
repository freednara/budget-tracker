/**
 * Form & Modal Actions
 * Category selection, edit mode, delete targets, split transactions,
 * and savings-goal modal state.
 *
 * @module actions/form-actions
 */
import * as signals from '../signals.js';
import { generateSecureId } from '../utils-dom.js';

export const form = {
  setSelectedCategory(categoryId: string): boolean {
    signals.selectedCategory.value = categoryId || '';
    return true;
  },

  clearSelectedCategory(): void {
    signals.selectedCategory.value = '';
  },

  setEditingId(txId: string | null): boolean {
    signals.editingId.value = txId;
    return true;
  },

  setEditSeriesMode(mode: boolean): void {
    signals.editSeriesMode.value = mode;
  }
};

export const modal = {
  setDeleteTargetId(txId: string | null): boolean {
    signals.deleteTargetId.value = txId;
    return true;
  },

  clearDeleteTargetId(): void {
    signals.deleteTargetId.value = null;
  },

  setAddSavingsGoalId(goalId: string | null): boolean {
    signals.addSavingsGoalId.value = goalId;
    return true;
  },

  clearAddSavingsGoalId(): void {
    signals.addSavingsGoalId.value = null;
  },

  setSplitTxId(txId: string | null): boolean {
    signals.splitTxId.value = txId;
    if (txId === null) {
      signals.splitRows.value = [];
      return true;
    }

    const tx = signals.transactions.value.find((item) => item.__backendId === txId);
    if (tx) {
      const initialRow: signals.SplitRow = {
        id: `row_${generateSecureId()}`,
        categoryId: tx.category || 'other',
        amount: tx.amount
      };
      signals.splitRows.value = [initialRow];
    } else {
      signals.splitRows.value = [];
    }
    return true;
  },

  clearSplitTxId(): void {
    signals.splitTxId.value = null;
    signals.splitRows.value = [];
  },

  clearPendingEditTx(): void {
    signals.pendingEditTx.value = null;
  },

  setSplitRows(rows: signals.SplitRow[]): void {
    signals.splitRows.value = [...rows];
  },

  addSplitRow(row: signals.SplitRow): void {
    signals.splitRows.value = [...signals.splitRows.value, row];
  },

  updateSplitRow(rowId: string, updates: Partial<signals.SplitRow>): boolean {
    const existing = signals.splitRows.value.some((row) => row.id === rowId);
    if (!existing) return false;
    signals.splitRows.value = signals.splitRows.value.map((row) =>
      row.id === rowId ? { ...row, ...updates } : row
    );
    return true;
  },

  removeSplitRow(rowId: string): boolean {
    const nextRows = signals.splitRows.value.filter((row) => row.id !== rowId);
    if (nextRows.length === signals.splitRows.value.length) return false;
    signals.splitRows.value = nextRows;
    return true;
  }
};

// Design-Review-Apr21 P2: the modal-state clear calls (for split /
// add-savings / delete / edit-recurring / import-options) were previously
// inlined only in the Escape-key handler. Backdrop-click dismissal went
// through a bare `closeModal(id)` and skipped the cleanup, leaving stale
// `splitTxId`, `addSavingsGoalId`, `deleteTargetId`, `pendingEditTx`, and
// import-data state behind once the overlay was gone. Centralizing the
// id→clear mapping here lets both dismissal paths (Escape + backdrop) call
// the same helper and keeps the coupling at a single site as new modals
// with transient state are added. `clearImportData()` lives in a feature
// module, so callers that need the full cleanup should call that
// separately after this — this helper only covers form-actions state.
export function cleanupModalState(id: string): void {
  switch (id) {
    case 'split-modal':
      modal.clearSplitTxId();
      break;
    case 'add-savings-modal':
      modal.clearAddSavingsGoalId();
      break;
    case 'delete-modal':
      modal.clearDeleteTargetId();
      break;
    case 'edit-recurring-modal':
      modal.clearPendingEditTx();
      break;
    default:
      // no-op — modals without transient state need no cleanup
      break;
  }
}
