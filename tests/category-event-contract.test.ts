/**
 * Category event-contract regression guard (Rev 13 L72,
 * Inline-Behavior-Review).
 *
 * Two symmetric gaps this file locks down:
 *
 *   1. Local mutations. Every category CRUD surface
 *      (`addCategory`, `updateCategory`, `deleteCategory`,
 *      `reorderCategory`, `toggleCategoryVisibility`) routes through
 *      the shared `updateConfig()` helper, and `applyPreset` /
 *      `mergePreset` write the signal directly. Prior to the fix,
 *      none of these emitted `Events.CATEGORY_UPDATED`, so the
 *      `app-events.ts` handler that schedules `renderCategories`,
 *      `populateCategoryFilter`, and `updateInsights` never fired —
 *      the UI only refreshed because callers manually re-rendered
 *      after every mutation, inconsistently.
 *
 *   2. Remote sync. The `SK.USER_CATS` branch of
 *      `syncState.applyKeyUpdate()` used to mirror the local gap:
 *      it wrote `userCategoryConfig.value` directly (no dedicated
 *      setter) and returned `true` without queuing any event. Every
 *      other `SK.*` branch delegates to a setter that emits its
 *      domain event internally — `USER_CATS` was the outlier.
 *
 * Both gaps are now plugged with a `queueEvent(CATEGORY_UPDATED)`
 * call at the write site. These tests assert the emit fires for
 * each mutation path so a future refactor cannot silently
 * re-introduce the bug.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearAll, Events, on } from '../js/modules/core/event-bus.js';
import { SK } from '../js/modules/core/state.js';
import {
  addCategory,
  applyPreset,
  deleteCategory,
  mergePreset,
  reorderCategory,
  toggleCategoryVisibility,
  updateCategory,
  userCategoryConfig
} from '../js/modules/core/category-store.js';
import { syncState } from '../js/modules/core/state-actions.js';
import type { UserCategoryConfig } from '../js/types/index.js';

function seedConfig(): UserCategoryConfig {
  const config: UserCategoryConfig = {
    presetId: 'personal',
    version: 1,
    expense: [
      { id: 'food', name: 'Food', emoji: '🍔', color: '#ef4444', type: 'expense', order: 0 },
      { id: 'transport', name: 'Transport', emoji: '🚗', color: '#3b82f6', type: 'expense', order: 1 }
    ],
    income: [
      { id: 'salary', name: 'Salary', emoji: '💰', color: '#22c55e', type: 'income', order: 0 }
    ]
  };
  userCategoryConfig.value = config;
  return config;
}

describe('CATEGORY_UPDATED event contract', () => {
  let listener: ReturnType<typeof vi.fn>;
  let unsubscribe: (() => void) | null = null;

  beforeEach(() => {
    clearAll();
    localStorage.clear();
    listener = vi.fn();
    unsubscribe = on(Events.CATEGORY_UPDATED, listener);
    seedConfig();
  });

  afterEach(() => {
    unsubscribe?.();
    unsubscribe = null;
    clearAll();
    userCategoryConfig.value = null;
    localStorage.clear();
  });

  describe('local mutations (category-store)', () => {
    it('emits on addCategory', () => {
      addCategory({ name: 'Coffee', emoji: '☕', color: '#7c3aed', type: 'expense' });
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('emits on updateCategory', () => {
      updateCategory('food', { name: 'Groceries' });
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('emits on deleteCategory', () => {
      deleteCategory('food');
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('emits on reorderCategory', () => {
      reorderCategory('food', 1);
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('emits on toggleCategoryVisibility', () => {
      toggleCategoryVisibility('food');
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('emits on applyPreset even when no prior preset was set', () => {
      // First-time apply: oldPresetId is undefined → migrateStoredCategoryIds
      // never runs, so the emit must come from applyPreset itself.
      userCategoryConfig.value = null;
      applyPreset('personal');
      expect(listener).toHaveBeenCalled();
    });

    it('emits on applyPreset when switching presets', () => {
      // Preset-to-preset switch: migrateStoredCategoryIds queues its own
      // CATEGORY_UPDATED, and applyPreset adds one at the tail. The
      // contract only requires *at least one* emit — dedup is handled
      // by the renderScheduler, not this test.
      applyPreset('freelancer');
      expect(listener).toHaveBeenCalled();
    });

    it('emits on mergePreset', () => {
      mergePreset('personal');
      expect(listener).toHaveBeenCalled();
    });
  });

  describe('remote sync (syncState.applyKeyUpdate)', () => {
    it('emits on applyKeyUpdate(SK.USER_CATS, config)', () => {
      const incoming: UserCategoryConfig = {
        presetId: 'remote',
        version: 1,
        expense: [
          { id: 'remote_cat', name: 'Remote', emoji: '🛰️', color: '#0ea5e9', type: 'expense', order: 0 }
        ],
        income: []
      };

      const applied = syncState.applyKeyUpdate(SK.USER_CATS, incoming);

      expect(applied).toBe(true);
      expect(userCategoryConfig.value?.presetId).toBe('remote');
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('does not emit when applyKeyUpdate rejects an invalid payload', () => {
      // Guard against the inverse regression: the validator gate must
      // run *before* the emit, so a rejected payload stays silent.
      const applied = syncState.applyKeyUpdate(SK.USER_CATS, { not: 'a-config' });

      expect(applied).toBe(false);
      expect(listener).not.toHaveBeenCalled();
    });
  });
});
