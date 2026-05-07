import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as signals from '../js/modules/core/signals.js';
import { savingsGoals as savingsActions } from '../js/modules/core/actions/data-actions.js';
import { addDebt, updateDebt } from '../js/modules/features/financial/debt-planner.js';
import {
  selectedSavingsGoal,
  selectedDebt,
  mountTransactionDetailPanel
} from '../js/modules/components/transaction-detail-panel.js';
import type { SavingsGoal } from '../js/types/index.js';

/**
 * CR-Apr22-G slice 5 coverage — Transaction detail modal: stale titles.
 *
 * One P3 finding: `transaction-detail-panel.ts` snapshots the goal/debt
 * `name` + `emoji` into `selectedSavingsGoal.value` / `selectedDebt.value`
 * at open-time (via `DetailTarget { id, name, emoji }`). If the underlying
 * SavingsGoal or Debt is renamed or has its icon changed while the modal
 * is open, the header text/emoji stays stale.
 *
 * Fix: the effects now look up the canonical live record from the
 * corresponding signal and prefer its `name` (and, for goals, `icon`)
 * over the DetailTarget snapshot. `savingsPanelData` and
 * `debtTransactions` already subscribe their effects to the underlying
 * signals transitively — the rename re-runs the effect automatically;
 * this slice just swings the header read from the snapshot to the live
 * record.
 *
 * These tests assert the data that feeds the header, not the DOM render.
 * Driving the lit-html render through a happy-dom modal would exercise
 * the same derivation path with strictly more ceremony.
 */

const originalGoals = signals.savingsGoals.value;
const originalDebts = signals.debts.value;
const originalTxs = signals.transactions.value;
const originalSelectedGoal = selectedSavingsGoal.value;
const originalSelectedDebt = selectedDebt.value;

let unmount: (() => void) | null = null;

beforeEach(() => {
  // Ensure a DOM modal container exists so mountTransactionDetailPanel
  // can attach without failing on the missing `#modal-container` lookup.
  if (!document.getElementById('modal-container')) {
    const c = document.createElement('div');
    c.id = 'modal-container';
    document.body.appendChild(c);
  }
  signals.savingsGoals.value = {};
  signals.debts.value = [];
  signals.transactions.value = [];
  selectedSavingsGoal.value = null;
  selectedDebt.value = null;
  unmount = null;
});

afterEach(() => {
  if (unmount) {
    try { unmount(); } catch { /* swallow */ }
    unmount = null;
  }
  signals.savingsGoals.value = originalGoals;
  signals.debts.value = originalDebts;
  signals.transactions.value = originalTxs;
  selectedSavingsGoal.value = originalSelectedGoal;
  selectedDebt.value = originalSelectedDebt;
  const modalRoot = document.getElementById('tx-detail-modal');
  if (modalRoot?.parentElement) modalRoot.parentElement.removeChild(modalRoot);
});

/**
 * Contract: the savings effect prefers the live record's `name` and `icon`
 * over the DetailTarget snapshot. Reproduced here to lock the derivation
 * independent of the lit-html render.
 */
function resolveHeader(
  goalRecord: SavingsGoal | null,
  snapshot: { name: string; emoji: string }
): { name: string; emoji: string } {
  return {
    name: goalRecord?.name ?? snapshot.name,
    emoji: goalRecord?.icon ?? snapshot.emoji
  };
}

describe('savings goal header — live record preference (CR-Apr22-G slice 5)', () => {
  it('reads name from the live SavingsGoal record, not the DetailTarget snapshot', () => {
    const id = savingsActions.addGoal({ name: 'Emergency Fund', target: 1000 });

    // Snapshot captures the name at open time.
    const snapshot = { name: 'Emergency Fund', emoji: '💰' };

    // User renames the goal via the rename action.
    savingsActions.renameGoal(id, 'Rainy Day Fund');

    const liveGoal = signals.savingsGoals.value[id] ?? null;
    const header = resolveHeader(liveGoal, snapshot);

    expect(header.name).toBe('Rainy Day Fund');
    expect(header.name).not.toBe(snapshot.name);
  });

  it('reads icon from the live SavingsGoal record when set', () => {
    const id = savingsActions.addGoal({ name: 'Goal A', target: 500, icon: '🎯' });

    // Snapshot carried a DIFFERENT emoji (e.g., default fallback at open).
    const snapshot = { name: 'Goal A', emoji: '📦' };

    const liveGoal = signals.savingsGoals.value[id] ?? null;
    const header = resolveHeader(liveGoal, snapshot);

    expect(header.emoji).toBe('🎯');
    expect(header.emoji).not.toBe(snapshot.emoji);
  });

  it('falls back to snapshot emoji when the live record has no icon', () => {
    const id = savingsActions.addGoal({ name: 'Goal B', target: 500 });
    expect(signals.savingsGoals.value[id]?.icon).toBeUndefined();

    const snapshot = { name: 'Goal B', emoji: '📦' };
    const liveGoal = signals.savingsGoals.value[id] ?? null;
    const header = resolveHeader(liveGoal, snapshot);

    expect(header.emoji).toBe('📦');
  });

  it('falls back to snapshot name when the goal has been deleted', () => {
    const id = savingsActions.addGoal({ name: 'Doomed Goal', target: 100 });
    const snapshot = { name: 'Doomed Goal', emoji: '💰' };

    // Delete the goal — live lookup now returns undefined.
    const updated = { ...signals.savingsGoals.value };
    delete updated[id];
    signals.savingsGoals.value = updated;

    const liveGoal = signals.savingsGoals.value[id] ?? null;
    const header = resolveHeader(liveGoal, snapshot);

    expect(header.name).toBe('Doomed Goal');
  });

  it('effect subscribes through savingsPanelData so renames re-trigger', () => {
    // Verify the subscription wiring: mount the panel, select a goal,
    // rename, and confirm the DOM modal title element reflects the new
    // name. If the effect was NOT subscribed, the rendered DOM would keep
    // the snapshot name.
    const id = savingsActions.addGoal({ name: 'Initial Title', target: 1000, icon: '💰' });
    selectedSavingsGoal.value = { id, name: 'Initial Title', emoji: '💰' };

    unmount = mountTransactionDetailPanel();

    // Give the effect a tick to mount.
    const modalAfterOpen = document.getElementById('tx-detail-modal');
    expect(modalAfterOpen).not.toBeNull();
    const titleAfterOpen = modalAfterOpen?.querySelector('.category-detail-modal__title')?.textContent ?? '';
    expect(titleAfterOpen).toContain('Initial Title');

    // Rename — the effect should re-run and re-render the header.
    savingsActions.renameGoal(id, 'Renamed Title');

    const modalAfterRename = document.getElementById('tx-detail-modal');
    const titleAfterRename = modalAfterRename?.querySelector('.category-detail-modal__title')?.textContent ?? '';
    expect(titleAfterRename).toContain('Renamed Title');
    expect(titleAfterRename).not.toContain('Initial Title');
  });
});

describe('debt header — live record preference (CR-Apr22-G slice 5)', () => {
  function resolveDebtHeaderName(
    liveName: string | null,
    snapshotName: string
  ): string {
    return liveName ?? snapshotName;
  }

  it('reads name from the live Debt record, not the DetailTarget snapshot', () => {
    const debt = addDebt({ name: 'Chase Visa', balance: 500 });
    const snapshot = { name: 'Chase Visa', emoji: '💳' };

    updateDebt(debt.id, { name: 'Chase Sapphire' });

    const liveDebt = signals.debts.value.find(d => d.id === debt.id) ?? null;
    const headerName = resolveDebtHeaderName(liveDebt?.name ?? null, snapshot.name);

    expect(headerName).toBe('Chase Sapphire');
    expect(headerName).not.toBe(snapshot.name);
  });

  it('falls back to snapshot name when the debt has been removed', () => {
    const debt = addDebt({ name: 'Gone Debt', balance: 100 });
    const snapshot = { name: 'Gone Debt', emoji: '💳' };

    // Simulate a removal — signal drops the record.
    signals.debts.value = signals.debts.value.filter(d => d.id !== debt.id);

    const liveDebt = signals.debts.value.find(d => d.id === debt.id) ?? null;
    const headerName = resolveDebtHeaderName(liveDebt?.name ?? null, snapshot.name);

    expect(headerName).toBe('Gone Debt');
  });

  it('effect re-runs on rename — DOM header reflects the live name', () => {
    const debt = addDebt({ name: 'First Name', balance: 500 });
    selectedDebt.value = { id: debt.id, name: 'First Name', emoji: '💳' };

    unmount = mountTransactionDetailPanel();

    const modalAfterOpen = document.getElementById('tx-detail-modal');
    const titleAfterOpen = modalAfterOpen?.querySelector('.category-detail-modal__title')?.textContent ?? '';
    expect(titleAfterOpen).toContain('First Name');

    updateDebt(debt.id, { name: 'Second Name' });

    const modalAfterRename = document.getElementById('tx-detail-modal');
    const titleAfterRename = modalAfterRename?.querySelector('.category-detail-modal__title')?.textContent ?? '';
    expect(titleAfterRename).toContain('Second Name');
    expect(titleAfterRename).not.toContain('First Name');
  });
});
