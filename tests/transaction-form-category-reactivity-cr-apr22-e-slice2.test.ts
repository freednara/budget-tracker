import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as signals from '../js/modules/core/signals.js';
import {
  userCategoryConfig,
  updateCategory,
  deleteCategory,
  addCategory,
  applyPreset
} from '../js/modules/core/category-store.js';
import { form, navigation } from '../js/modules/core/state-actions.js';
import {
  initShellNavigation,
  cleanupShellNavigation
} from '../js/modules/ui/core/ui-navigation.js';
import DOM from '../js/modules/core/dom-cache.js';
import type { UserCategoryConfig } from '../js/types/index.js';

/**
 * CR-Apr22-E slice 2 coverage — Transaction form reacts to category
 * deletion, hiding, and preset switches (finding 59, `[P2]`).
 *
 * Before this slice, the `bindTransactionTypeUi` effect subscribed
 * only to `currentType`, `selectedCategory`, and `editingId`. It called
 * `getAllCats(currentType)` to validate the current selection, but that
 * read was conditional on `!editingId && selectedCategory` — so on a
 * fresh form with no selection, the dep-track edge to `userCategoryConfig`
 * (transitively via the `expenseCategories`/`incomeCategories`
 * computeds) was never established. Even with a selection, the edge was
 * incidental: any future render that took a different branch would drop
 * the subscription.
 *
 * Failure mode: user picks "Food", goes to Settings, deletes or hides
 * "Food", returns to the entry form — the selection chip stays stuck on
 * the now-nonexistent category until they tap a type toggle or touch an
 * unrelated signal. The form renders with a ghost selection whose id no
 * longer exists in `userCategoryConfig`.
 *
 * The fix reads `userCategoryConfig.value` explicitly at the top of the
 * effect body, establishing a permanent subscription. Any config mutation
 * (delete / hide / rename / preset switch / bulk import) now re-runs
 * `syncTransactionEntryUi`, which re-validates the selection against
 * `getAllCats` and calls `form.clearSelectedCategory()` when the
 * selection has become invalid.
 *
 * These tests exercise the full pipeline: real `initShellNavigation` +
 * real signal mutations + real `selectedCategory` observation. They use
 * no mocks beyond a minimal DOM — the goal is to lock the effect's
 * wake-up contract, which is the load-bearing property the review
 * identified as broken.
 */

function seedConfig(): UserCategoryConfig {
  return {
    presetId: 'personal',
    version: 1,
    expense: [
      { id: 'food', name: 'Food', emoji: '🍔', color: '#ff6b6b', type: 'expense', order: 0 },
      { id: 'transport', name: 'Transport', emoji: '🚗', color: '#4dabf7', type: 'expense', order: 1 },
      { id: 'other', name: 'Other', emoji: '📦', color: '#8b5cf6', type: 'expense', order: 2 }
    ],
    income: [
      { id: 'salary', name: 'Salary', emoji: '💰', color: '#51cf66', type: 'income', order: 0 },
      { id: 'other_income', name: 'Other', emoji: '💵', color: '#8b5cf6', type: 'income', order: 1 }
    ]
  };
}

function seedDom(): void {
  // Minimal navigation shell. All inner listeners / ResizeObservers in
  // `initShellNavigation` null-check their targets, so the bare
  // `#tab-dashboard` tab lets `bindTransactionTypeUi` wire up without
  // touching any swipe/metrics subtrees.
  document.body.innerHTML = `
    <header class="app-shell"></header>
    <main>
      <section id="tab-dashboard"></section>
    </main>
    <button id="tab-expense"></button>
    <button id="tab-income"></button>
  `;
  DOM.clearAll();
}

describe('transaction form category reactivity — CR-Apr22-E slice 2', () => {
  const originalConfig = userCategoryConfig.value;
  const originalType = signals.currentType.value;
  const originalCat = signals.selectedCategory.value;
  const originalEditing = signals.editingId.value;

  beforeEach(() => {
    seedDom();
    userCategoryConfig.value = seedConfig();
    navigation.setCurrentTab('expense');
    form.clearSelectedCategory();
    form.setEditingId(null);
  });

  afterEach(() => {
    try { cleanupShellNavigation(); } catch { /* swallow */ }
    userCategoryConfig.value = originalConfig;
    navigation.setCurrentTab(originalType);
    signals.selectedCategory.value = originalCat;
    form.setEditingId(originalEditing);
    DOM.clearAll();
    document.body.innerHTML = '';
  });

  describe('regression lock — deletion of the currently-selected category', () => {
    it('clears the form selection when the selected expense category is DELETED', () => {
      form.setSelectedCategory('food');
      initShellNavigation();
      // Sanity: mount doesn't erase a valid selection.
      expect(signals.selectedCategory.value).toBe('food');

      deleteCategory('food');

      // The load-bearing assertion: the effect must have woken, re-run
      // `syncTransactionEntryUi`, observed that 'food' is no longer in
      // `getAllCats('expense')`, and cleared the selection.
      expect(signals.selectedCategory.value).toBe('');
    });

    it('clears the form selection when the selected income category is DELETED', () => {
      navigation.setCurrentTab('income');
      form.setSelectedCategory('salary');
      initShellNavigation();
      expect(signals.selectedCategory.value).toBe('salary');

      deleteCategory('salary');

      expect(signals.selectedCategory.value).toBe('');
    });
  });

  describe('regression lock — hiding the currently-selected category', () => {
    it('clears the form selection when the selected category is HIDDEN', () => {
      // `expenseCategories` / `incomeCategories` filter out `hidden` —
      // so a hide is semantically equivalent to a delete for the form's
      // validation path. Locked down to catch a future regression if
      // either computed's filter predicate changes.
      form.setSelectedCategory('transport');
      initShellNavigation();
      expect(signals.selectedCategory.value).toBe('transport');

      updateCategory('transport', { hidden: true });

      expect(signals.selectedCategory.value).toBe('');
    });

    it('restores nothing on UNHIDE — unhiding is not re-selection', () => {
      // Documents the intentional one-way behavior: clearing on hide is
      // automatic; restoring the selection when the category is
      // unhidden would require remembering the prior selection, which
      // the product doesn't do.
      form.setSelectedCategory('food');
      initShellNavigation();
      updateCategory('food', { hidden: true });
      expect(signals.selectedCategory.value).toBe('');

      updateCategory('food', { hidden: false });

      // Still empty — user must re-pick if they want it again.
      expect(signals.selectedCategory.value).toBe('');
    });
  });

  describe('positive path — unrelated category mutations preserve selection', () => {
    it('keeps the selection when a DIFFERENT category is deleted', () => {
      form.setSelectedCategory('food');
      initShellNavigation();

      deleteCategory('transport');

      expect(signals.selectedCategory.value).toBe('food');
    });

    it('keeps the selection when a category is RENAMED (but the id is stable)', () => {
      form.setSelectedCategory('food');
      initShellNavigation();

      updateCategory('food', { name: 'Groceries' });

      // Id is stable across rename, so the selection remains valid.
      expect(signals.selectedCategory.value).toBe('food');
    });

    it('keeps the selection when a NEW category is ADDED', () => {
      form.setSelectedCategory('food');
      initShellNavigation();

      addCategory({ name: 'Entertainment', emoji: '🎮', color: '#ff922b', type: 'expense' });

      expect(signals.selectedCategory.value).toBe('food');
    });
  });

  describe('preset-switch invalidation (one of the highest-impact paths)', () => {
    it('clears the selection when a preset switch removes the selected id', () => {
      // The `personal` preset has `food`; the `business` preset does
      // not. Switching presets replaces the whole config, and the
      // currently-selected id disappears — the effect must wake and
      // clear. Pre-fix the form kept a phantom 'food' selection.
      form.setSelectedCategory('food');
      initShellNavigation();
      expect(signals.selectedCategory.value).toBe('food');

      applyPreset('business');

      expect(signals.selectedCategory.value).toBe('');
    });
  });

  describe('edit-mode guard — do NOT clear the selection while editing', () => {
    it('preserves the selection during edit even when the category is deleted', () => {
      // Existing logic in `syncTransactionEntryUi` (line 64):
      //   `if (!editingId && selectedCategory) { validate... }`
      // The edit-mode branch is intentional — when the user is editing a
      // transaction with a now-deleted category, they need to see the
      // original selection so they can choose a replacement. The fix
      // must NOT regress this behavior: the new subscription should
      // wake the effect on config change, but the validate-and-clear
      // logic stays gated on `!editingId`.
      form.setSelectedCategory('food');
      form.setEditingId('tx_abc');
      initShellNavigation();
      expect(signals.selectedCategory.value).toBe('food');

      deleteCategory('food');

      // During edit: keep the stale selection visible. User will fix it
      // by picking a new category before saving.
      expect(signals.selectedCategory.value).toBe('food');
    });
  });

  describe('cleanup disposes the subscription', () => {
    it('cleanupShellNavigation stops further re-runs of the form effect', () => {
      form.setSelectedCategory('food');
      initShellNavigation();

      cleanupShellNavigation();

      // After cleanup a category delete must NOT clear the selection —
      // the effect is gone. (If this regresses, it usually means a new
      // signal subscription was added inside the effect but not tied
      // to the disposer, which tends to produce memory leaks in
      // production too.)
      deleteCategory('food');

      expect(signals.selectedCategory.value).toBe('food');
    });
  });

  describe('initial-sync path — deleted selection cleared on mount', () => {
    it('clears an already-invalid selection at mount time', () => {
      // Corruption scenario: selection points to a category that
      // doesn't exist when the app boots. The synchronous
      // `syncTransactionEntryUi()` call at the end of
      // `initShellNavigation` catches this on the first render — no
      // user interaction required.
      form.setSelectedCategory('phantom_cat');

      initShellNavigation();

      expect(signals.selectedCategory.value).toBe('');
    });
  });
});
