/**
 * category-manager — add-category cancel + preset re-apply regression
 * guards (CR-Apr22-B slice 2).
 *
 * Two findings, both in `js/modules/components/category-manager.ts`:
 *
 *  Finding #1 — `handleAddCategory` coalesced the emoji prompt's `null`
 *  (explicit cancel) and `''` (empty confirm) through `(emoji?.trim()) ||
 *  '📦'`. Canceling the emoji dialog still persisted a category using
 *  the default 📦, contradicting the user's intent to abort. Fix: an
 *  explicit `if (emoji === null) return;` before the `addCategory` call.
 *  Empty-confirm still accepts the default emoji.
 *
 *  Finding #3 — `handlePresetClick` early-returned on `presetId ===
 *  presetId`, treating the active preset as "no-op" even when the
 *  config had diverged from the preset's canonical shape (user_* custom
 *  cats added, preset cats hidden, preset cats deleted, or preset cats
 *  renamed). Users couldn't reset a diverged preset without flipping to
 *  a different preset and back — and the cross-preset round-trip would
 *  trample their custom data anyway. Fix: a shape-aware divergence
 *  check. When shape matches → alert ("already using preset, nothing to
 *  reset"). When shape diverges → confirm with per-kind summary, then
 *  sweep user_* cats via `deleteCategoryWithCleanup` (so transactions,
 *  templates, allocations, and recurring get remapped atomically) and
 *  finally `applyPreset(presetId)` to restore the canonical shape.
 *
 * These tests mount the real component into a happy-dom container with
 * mocked dialog overrides and spy on the underlying category-store
 * writes (signals + localStorage) to verify the add flow aborts on
 * emoji-cancel and the preset re-apply performs the full sweep+reset.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { SK, persist } from '../js/modules/core/state.js';
import * as signals from '../js/modules/core/signals.js';
import {
  applyPreset,
  userCategoryConfig,
  allExpenseCategories,
} from '../js/modules/core/category-store.js';
import type { Transaction } from '../js/types/index.js';

// data-manager stub — `deleteCategoryWithCleanup` calls
// `dataSdk.replaceAllTransactions` whenever a sweep rewrites transaction
// rows. Default to success so the sweep completes atomically.
const mockReplace = vi.fn();
vi.mock('../js/modules/data/data-manager.js', () => ({
  dataSdk: {
    replaceAllTransactions: (...args: unknown[]) => mockReplace(...args),
  },
}));

// Partial mock of recurring-templates so the in-memory scheduler refresh
// path doesn't crash when SK.RECURRING is empty. We spread `vi.importActual`
// per memory feedback_test_mock_drift so the real module's export surface
// stays intact.
vi.mock('../js/modules/data/recurring-templates.js', async () => {
  const actual = await vi.importActual<typeof import('../js/modules/data/recurring-templates.js')>(
    '../js/modules/data/recurring-templates.js'
  );
  return {
    ...actual,
    loadRecurringTemplates: () => {
      actual.loadRecurringTemplates();
    }
  };
});

// --- Test helpers -----------------------------------------------------------

function makeTx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    __backendId: `tx_${Math.random().toString(36).slice(2, 10)}`,
    type: 'expense',
    category: 'food',
    amount: 10,
    description: 'Seed',
    date: '2026-01-15',
    currency: 'USD',
    tags: '',
    recurring: false,
    ...overrides
  } as Transaction;
}

function resetState(): void {
  localStorage.clear();
  userCategoryConfig.value = null;
  signals.monthlyAlloc.value = {};
  signals.txTemplates.value = [];
  signals.rolloverSettings.value = {
    enabled: false,
    mode: 'all',
    categories: [],
    maxRollover: null,
    negativeHandling: 'zero'
  };
  signals.transactions.value = [];
  mockReplace.mockReset();
  mockReplace.mockResolvedValue({ isOk: true, data: [] });
  document.body.innerHTML = '';
}

// Module-level state inside `category-manager.ts` (`previewingPresetId`,
// `editingCatId`, `activeTab`) persists between mounts unless the cleanup
// returned by `mountCategoryManager` is called. We register every mount's
// cleanup here and invoke them all in `afterEach` to prevent cross-test
// leakage.
const pendingCleanups: Array<() => void> = [];

async function mountIntoDom(opts: {
  containerId: string;
  confirmReturn?: boolean;
  promptReturns?: Array<string | null>;
  onConfirm?: Mock;
  onAlert?: Mock;
  onPrompt?: Mock;
}): Promise<{ cleanup: () => void }> {
  const container = document.createElement('div');
  container.id = opts.containerId;
  document.body.appendChild(container);

  const { mountCategoryManager } = await import('../js/modules/components/category-manager.js');

  const confirmFn = opts.onConfirm || vi.fn(async () => opts.confirmReturn ?? true);
  const alertFn = opts.onAlert || vi.fn(async () => undefined);

  // Each call to `prompt` pulls the next value from `promptReturns`.
  let promptCallIdx = 0;
  const promptFn = opts.onPrompt || vi.fn(async () => {
    const list = opts.promptReturns || [];
    const v = list[promptCallIdx] ?? null;
    promptCallIdx++;
    return v;
  });

  const cleanup = mountCategoryManager(
    opts.containerId,
    undefined,
    {
      confirm: confirmFn,
      alert: alertFn,
      prompt: promptFn
    }
  );

  pendingCleanups.push(cleanup);
  return { cleanup };
}

// --- Setup + teardown -------------------------------------------------------

beforeEach(() => {
  resetState();
  // Seed with a clean Personal preset by default — most tests start from
  // the pristine shape and mutate into divergent states per-case.
  applyPreset('personal');
});

afterEach(() => {
  // Flush each mount's cleanup so module-level state
  // (previewingPresetId / editingCatId / activeTab) resets.
  while (pendingCleanups.length > 0) {
    const fn = pendingCleanups.pop();
    try { fn?.(); } catch { /* ignore double-cleanup */ }
  }
  document.body.innerHTML = '';
  // `vi.clearAllMocks` erases per-test mocks (like the prompt queues we
  // wired up in `mountIntoDom`), but the module-level `mockReplace` has
  // to be re-seeded because `mockReset` wipes its default resolution.
  vi.clearAllMocks();
});

// ============================================================================
// Finding #1 — emoji-prompt cancel must abort add-category flow
// ============================================================================

describe('handleAddCategory — emoji prompt cancel', () => {
  it('aborts the add flow when the emoji prompt returns null (user canceled)', async () => {
    // Arrange: prompt queue — first call (name) returns "Piano Lessons",
    // second call (emoji) returns `null` (explicit cancel).
    const promptFn = vi.fn()
      .mockResolvedValueOnce('Piano Lessons')  // name
      .mockResolvedValueOnce(null);            // emoji — CANCELED

    const confirmFn = vi.fn(async () => true);
    const alertFn = vi.fn(async () => undefined);

    await mountIntoDom({
      containerId: 'cm-1',
      onConfirm: confirmFn,
      onAlert: alertFn,
      onPrompt: promptFn
    });

    const preAddExpenseCount = allExpenseCategories.value.length;

    // Act: click the Add button
    const addBtn = document.querySelector('.catmgr-add-btn') as HTMLButtonElement;
    expect(addBtn).toBeTruthy();
    addBtn.click();

    // Wait for the async handler to settle — two awaits (name + emoji prompts).
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));

    // Assert: the emoji prompt was reached…
    expect(promptFn).toHaveBeenCalledTimes(2);
    // …but NO new category was added.
    expect(allExpenseCategories.value.length).toBe(preAddExpenseCount);
    expect(allExpenseCategories.value.find(c => c.name === 'Piano Lessons')).toBeUndefined();
    // And no `alert` was shown (abort is silent — the user clicked Cancel
    // deliberately, they don't need to be told nothing happened).
    expect(alertFn).not.toHaveBeenCalled();
  });

  it('proceeds with default emoji when the emoji prompt returns empty string (blank confirm)', async () => {
    // Empty-confirm is a DIFFERENT intent from cancel — user accepted
    // the default placeholder. We keep the existing behavior here
    // (empty-confirm coalesces to 📦) so only `null` aborts.
    //
    // CR-Apr24-I finding 49: the add flow now stores a pendingNewCat
    // instead of persisting immediately. The category only lands in the
    // store when the user clicks Save in the inline edit form. This test
    // verifies the pending edit form renders, then simulates Save to
    // confirm the category is committed with the default 📦 emoji.
    const promptFn = vi.fn()
      .mockResolvedValueOnce('Piano Lessons')  // name
      .mockResolvedValueOnce('');              // emoji — empty confirm

    await mountIntoDom({
      containerId: 'cm-1b',
      onPrompt: promptFn,
      onConfirm: vi.fn(async () => true),
      onAlert: vi.fn(async () => undefined)
    });

    const preAddExpenseCount = allExpenseCategories.value.length;

    const addBtn = document.querySelector('.catmgr-add-btn') as HTMLButtonElement;
    addBtn.click();

    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));

    // Category is NOT yet in the store — it's pending in the edit form.
    expect(allExpenseCategories.value.length).toBe(preAddExpenseCount);

    // The inline edit form should be rendered with the pending data.
    const editForm = document.querySelector('.catmgr-edit-form');
    expect(editForm).toBeTruthy();

    // Click Save to commit the pending category.
    const saveBtn = document.querySelector('.catmgr-save-btn') as HTMLButtonElement;
    expect(saveBtn).toBeTruthy();
    saveBtn.click();

    await new Promise(r => setTimeout(r, 0));

    // NOW the category should be persisted with the default emoji.
    expect(allExpenseCategories.value.length).toBe(preAddExpenseCount + 1);
    const added = allExpenseCategories.value.find(c => c.name === 'Piano Lessons');
    expect(added).toBeTruthy();
    expect(added?.emoji).toBe('📦');
  });

  it('aborts the add flow when the NAME prompt returns null (same abort semantics)', async () => {
    // This guard already existed via `!name?.trim()` but we lock it down
    // alongside the emoji-cancel case so the pair is regression-guarded.
    const promptFn = vi.fn()
      .mockResolvedValueOnce(null);  // name — CANCELED

    await mountIntoDom({
      containerId: 'cm-1c',
      onPrompt: promptFn,
      onConfirm: vi.fn(async () => true),
      onAlert: vi.fn(async () => undefined)
    });

    const preAddExpenseCount = allExpenseCategories.value.length;

    const addBtn = document.querySelector('.catmgr-add-btn') as HTMLButtonElement;
    addBtn.click();

    await new Promise(r => setTimeout(r, 0));

    // Only the first prompt fires — the emoji prompt is never reached.
    expect(promptFn).toHaveBeenCalledTimes(1);
    expect(allExpenseCategories.value.length).toBe(preAddExpenseCount);
  });
});

// ============================================================================
// Finding #3 — preset re-apply guard: shape-aware divergence handling
// ============================================================================

describe('handlePresetClick — same-preset divergence-aware reset', () => {
  // Helper: click the active-preset button in the grid, then click the
  // preview's apply CTA. Returns after the full async chain settles.
  async function clickActivePresetApply(): Promise<void> {
    // First click opens the preview.
    const activeBtn = document.querySelector('.catmgr-preset-btn--active') as HTMLButtonElement;
    expect(activeBtn).toBeTruthy();
    activeBtn.click();

    // Render is synchronous inside lit, so the preview should be
    // available on the next tick.
    await new Promise(r => setTimeout(r, 0));

    const applyBtn = document.querySelector('.catmgr-preset-preview__apply') as HTMLButtonElement;
    expect(applyBtn).toBeTruthy();
    applyBtn.click();

    // Let the async confirm/sweep chain settle.
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
  }

  it('shows "already active" alert and performs no reset when config matches preset shape exactly', async () => {
    // Arrange: config is pristine Personal preset (applyPreset in beforeEach).
    const confirmFn = vi.fn(async () => true);
    const alertFn = vi.fn(async () => undefined);

    await mountIntoDom({
      containerId: 'cm-2',
      onConfirm: confirmFn,
      onAlert: alertFn,
      onPrompt: vi.fn(async () => null)
    });

    const initialExpenseIds = allExpenseCategories.value.map(c => c.id).sort();

    await clickActivePresetApply();

    // Alert fired, confirm did NOT fire.
    expect(alertFn).toHaveBeenCalledTimes(1);
    expect(confirmFn).not.toHaveBeenCalled();

    // Alert message references the "already active" state.
    const alertArgs = (alertFn.mock.calls[0] as unknown[] | undefined)?.[0] as { title?: string; message?: string };
    expect(alertArgs?.title).toMatch(/Active/i);
    expect(alertArgs?.message).toMatch(/already/i);

    // Config unchanged.
    expect(allExpenseCategories.value.map(c => c.id).sort()).toEqual(initialExpenseIds);
    // Preview should be dismissed after the no-op alert.
    expect(document.querySelector('.catmgr-preset-preview')).toBeNull();
  });

  it('detects user_* custom cats as divergence and surfaces them in the confirm details', async () => {
    // Arrange: add a user_* custom cat so the config shape diverges.
    const current = userCategoryConfig.value;
    if (!current) throw new Error('seed failed');
    userCategoryConfig.value = {
      ...current,
      expense: [
        ...current.expense,
        { id: 'user_custom_abc', name: 'Piano', emoji: '🎹', color: '#888', type: 'expense', order: current.expense.length }
      ]
    };
    persist(SK.USER_CATS, userCategoryConfig.value);

    const confirmFn = vi.fn(async () => false);  // user cancels the confirm
    const alertFn = vi.fn(async () => undefined);

    await mountIntoDom({
      containerId: 'cm-3',
      onConfirm: confirmFn,
      onAlert: alertFn,
      onPrompt: vi.fn(async () => null)
    });

    await clickActivePresetApply();

    // Confirm fired (not alert).
    expect(confirmFn).toHaveBeenCalledTimes(1);
    expect(alertFn).not.toHaveBeenCalled();

    const confirmArgs = (confirmFn.mock.calls[0] as unknown[] | undefined)?.[0] as { title?: string; details?: string };
    expect(confirmArgs?.title).toMatch(/Reset/i);
    // Details must enumerate the divergence kind.
    expect(confirmArgs?.details).toMatch(/1 custom categor/i);

    // User canceled → user_* cat still present, no reset happened.
    expect(allExpenseCategories.value.find(c => c.id === 'user_custom_abc')).toBeTruthy();
  });

  it('detects hidden preset cats as divergence and restores them on reset', async () => {
    // Arrange: hide one preset cat so the config shape diverges.
    const current = userCategoryConfig.value;
    if (!current) throw new Error('seed failed');
    userCategoryConfig.value = {
      ...current,
      expense: current.expense.map(c => c.id === 'entertainment' ? { ...c, hidden: true } : c)
    };
    persist(SK.USER_CATS, userCategoryConfig.value);

    const confirmFn = vi.fn(async () => true);
    const alertFn = vi.fn(async () => undefined);

    await mountIntoDom({
      containerId: 'cm-4',
      onConfirm: confirmFn,
      onAlert: alertFn,
      onPrompt: vi.fn(async () => null)
    });

    await clickActivePresetApply();

    expect(confirmFn).toHaveBeenCalledTimes(1);
    const confirmArgs = (confirmFn.mock.calls[0] as unknown[] | undefined)?.[0] as { details?: string };
    expect(confirmArgs?.details).toMatch(/hidden/i);

    // After reset: entertainment is back to visible.
    const entertainment = allExpenseCategories.value.find(c => c.id === 'entertainment');
    expect(entertainment).toBeTruthy();
    expect(entertainment?.hidden).toBeFalsy();
  });

  it('detects missing (deleted) preset cats as divergence and re-adds them on reset', async () => {
    // Arrange: drop a preset cat so the config shape diverges. (In real
    // usage this would be the result of `deleteCategoryWithCleanup` —
    // we shortcut it here for test clarity.)
    const current = userCategoryConfig.value;
    if (!current) throw new Error('seed failed');
    userCategoryConfig.value = {
      ...current,
      expense: current.expense.filter(c => c.id !== 'entertainment')
    };
    persist(SK.USER_CATS, userCategoryConfig.value);

    const confirmFn = vi.fn(async () => true);

    await mountIntoDom({
      containerId: 'cm-5',
      onConfirm: confirmFn,
      onAlert: vi.fn(async () => undefined),
      onPrompt: vi.fn(async () => null)
    });

    expect(allExpenseCategories.value.find(c => c.id === 'entertainment')).toBeUndefined();

    await clickActivePresetApply();

    const confirmArgs = (confirmFn.mock.calls[0] as unknown[] | undefined)?.[0] as { details?: string };
    expect(confirmArgs?.details).toMatch(/deleted preset/i);

    // After reset: entertainment is back.
    expect(allExpenseCategories.value.find(c => c.id === 'entertainment')).toBeTruthy();
  });

  it('detects renamed preset cats as divergence and restores canonical name/emoji on reset', async () => {
    // Arrange: rename a preset cat so the config shape diverges.
    const current = userCategoryConfig.value;
    if (!current) throw new Error('seed failed');
    userCategoryConfig.value = {
      ...current,
      expense: current.expense.map(c =>
        c.id === 'food' ? { ...c, name: 'Groceries & Eats', emoji: '🥗' } : c
      )
    };
    persist(SK.USER_CATS, userCategoryConfig.value);

    const confirmFn = vi.fn(async () => true);

    await mountIntoDom({
      containerId: 'cm-6',
      onConfirm: confirmFn,
      onAlert: vi.fn(async () => undefined),
      onPrompt: vi.fn(async () => null)
    });

    await clickActivePresetApply();

    const confirmArgs = (confirmFn.mock.calls[0] as unknown[] | undefined)?.[0] as { details?: string };
    expect(confirmArgs?.details).toMatch(/renamed preset/i);

    // After reset: food's canonical name/emoji are back.
    const food = allExpenseCategories.value.find(c => c.id === 'food');
    expect(food).toBeTruthy();
    expect(food?.name).toBe('Food & Dining');
    expect(food?.emoji).toBe('🍔');
  });

  it('sweeps user_* custom cat refs in transactions via deleteCategoryWithCleanup before applyPreset', async () => {
    // Arrange: add a user_* cat AND reference it from a transaction.
    const current = userCategoryConfig.value;
    if (!current) throw new Error('seed failed');
    userCategoryConfig.value = {
      ...current,
      expense: [
        ...current.expense,
        { id: 'user_custom_xyz', name: 'Piano', emoji: '🎹', color: '#888', type: 'expense', order: current.expense.length }
      ]
    };
    persist(SK.USER_CATS, userCategoryConfig.value);

    const tx1 = makeTx({ category: 'user_custom_xyz', description: 'Piano lesson' });
    const tx2 = makeTx({ category: 'food', description: 'Lunch' });
    signals.transactions.value = [tx1, tx2];

    const confirmFn = vi.fn(async () => true);

    await mountIntoDom({
      containerId: 'cm-7',
      onConfirm: confirmFn,
      onAlert: vi.fn(async () => undefined),
      onPrompt: vi.fn(async () => null)
    });

    await clickActivePresetApply();

    // replaceAllTransactions was called to rewrite refs atomically.
    expect(mockReplace).toHaveBeenCalled();
    const replacedTx = (mockReplace.mock.calls[0] as unknown[] | undefined)?.[0] as Transaction[];
    // Tx that referenced user_custom_xyz got remapped to the preset's
    // fallback "other" (Personal preset has an `other` cat).
    const rewrittenTx1 = replacedTx.find(t => t.description === 'Piano lesson');
    expect(rewrittenTx1?.category).toBe('other');
    // Tx that referenced an unaffected cat is unchanged.
    const rewrittenTx2 = replacedTx.find(t => t.description === 'Lunch');
    expect(rewrittenTx2?.category).toBe('food');

    // After reset: config is pristine preset again — user_custom_xyz gone.
    expect(allExpenseCategories.value.find(c => c.id === 'user_custom_xyz')).toBeUndefined();
  });

  it('does NOT reset when the user cancels the confirm — all divergence state is preserved', async () => {
    // Arrange: add a user_* custom cat.
    const current = userCategoryConfig.value;
    if (!current) throw new Error('seed failed');
    userCategoryConfig.value = {
      ...current,
      expense: [
        ...current.expense,
        { id: 'user_custom_keep', name: 'Keep Me', emoji: '📌', color: '#888', type: 'expense', order: current.expense.length }
      ]
    };
    persist(SK.USER_CATS, userCategoryConfig.value);

    const confirmFn = vi.fn(async () => false);  // user cancels

    await mountIntoDom({
      containerId: 'cm-8',
      onConfirm: confirmFn,
      onAlert: vi.fn(async () => undefined),
      onPrompt: vi.fn(async () => null)
    });

    await clickActivePresetApply();

    // Confirm was asked. replaceAllTransactions was NOT called
    // (sweep never started).
    expect(confirmFn).toHaveBeenCalledTimes(1);
    expect(mockReplace).not.toHaveBeenCalled();

    // user_* cat is still there, preset is unchanged.
    expect(allExpenseCategories.value.find(c => c.id === 'user_custom_keep')).toBeTruthy();
  });

  it('still supports switching to a DIFFERENT preset via the preview panel (unchanged cross-preset flow)', async () => {
    // Regression guard: this test confirms the existing cross-preset
    // "switch to X" flow still works. Sweep of user_* cats only happens
    // for same-preset resets; the cross-preset path delegates to
    // `migrateStoredCategoryIds` inside `applyPreset` as before.
    const confirmFn = vi.fn(async () => true);

    await mountIntoDom({
      containerId: 'cm-9',
      onConfirm: confirmFn,
      onAlert: vi.fn(async () => undefined),
      onPrompt: vi.fn(async () => null)
    });

    // Find the Business preset button (not active — Personal is).
    const allButtons = document.querySelectorAll('.catmgr-preset-btn');
    const businessBtn = Array.from(allButtons).find(b => b.textContent?.includes('Business')) as HTMLButtonElement;
    expect(businessBtn).toBeTruthy();

    businessBtn.click();
    await new Promise(r => setTimeout(r, 0));

    const applyBtn = document.querySelector('.catmgr-preset-preview__apply') as HTMLButtonElement;
    expect(applyBtn).toBeTruthy();
    expect(applyBtn.textContent).toMatch(/Switch to Business/);
    applyBtn.click();

    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));

    expect(confirmFn).toHaveBeenCalledTimes(1);
    const confirmArgs = (confirmFn.mock.calls[0] as unknown[] | undefined)?.[0] as { title?: string };
    expect(confirmArgs?.title).toMatch(/Switch to Business/i);

    // Preset swapped.
    expect(userCategoryConfig.value?.presetId).toBe('business');
  });

  it('allows the active-preset button to open the preview panel (previously locked out)', async () => {
    // Regression guard for the button-level fix: clicking the active
    // preset button must toggle the preview so the Reset CTA is
    // reachable. Before slice 2, `if (isActive) return;` silently
    // swallowed this click.
    await mountIntoDom({
      containerId: 'cm-10',
      onConfirm: vi.fn(async () => true),
      onAlert: vi.fn(async () => undefined),
      onPrompt: vi.fn(async () => null)
    });

    // No preview initially.
    expect(document.querySelector('.catmgr-preset-preview')).toBeNull();

    const activeBtn = document.querySelector('.catmgr-preset-btn--active') as HTMLButtonElement;
    expect(activeBtn).toBeTruthy();
    activeBtn.click();
    await new Promise(r => setTimeout(r, 0));

    // Preview opened — and its CTA is relabeled for the active preset.
    expect(document.querySelector('.catmgr-preset-preview')).toBeTruthy();
    const applyBtn = document.querySelector('.catmgr-preset-preview__apply') as HTMLButtonElement;
    expect(applyBtn.textContent).toMatch(/Reset to .* Defaults/);
  });
});
