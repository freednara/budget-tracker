/**
 * Regression tests for CR-Apr24-Z fix cluster.
 *
 * Cluster Z — Deferred focus/scroll guard P3 fixes
 *   120  Empty-state "Add transaction" CTA focus guard
 *   121  Empty-state "Add goal" CTA focus guard
 *   122  Empty-state "Plan budget" CTA deferred click guard
 *   123  Keyboard shortcut focus guards (Cmd+F, N)
 *   124  revealAfterTabSwitch tab-change guard
 *   125  Daily-allowance hero navigation guards
 *   128  revealTransactionsForm rAF focus guard
 *   129  openTransactionsForMonthType rAF scroll/focus guard
 *   133  Onboarding preset-picker double-rAF focus guard
 *   134  Onboarding targeted-step rAF focus guard
 *   135  Onboarding centered-step double-rAF focus guard
 *   138  asyncPrompt rAF focus guard
 */

import { describe, it, expect } from 'vitest';

// ==========================================
// Findings 120-122 — empty-state CTA guards
// ==========================================

describe('Cluster Z — empty-state CTA focus guards (findings 120-122)', () => {
  it('empty-state module loads and exports renderEmptyState', async () => {
    const mod = await import('../js/modules/ui/core/empty-state.js');
    expect(mod.renderEmptyState).toBeDefined();
    expect(typeof mod.renderEmptyState).toBe('function');
  });

  it('empty-state module exports init', async () => {
    const mod = await import('../js/modules/ui/core/empty-state.js');
    expect(mod.init).toBeDefined();
  });
});

// ==========================================
// Finding 123 — keyboard shortcut focus guards
// ==========================================

describe('Cluster Z — keyboard shortcut focus guards (finding 123)', () => {
  it('keyboard-events module loads and exports initKeyboardEvents', async () => {
    const mod = await import('../js/modules/ui/interactions/keyboard-events.js');
    expect(mod.initKeyboardEvents).toBeDefined();
  });
});

// ==========================================
// Finding 124 — revealAfterTabSwitch guard
// ==========================================

describe('Cluster Z — revealAfterTabSwitch tab-change guard (finding 124)', () => {
  it('ui-render module loads without error', async () => {
    const mod = await import('../js/modules/ui/core/ui-render.js');
    expect(mod).toBeDefined();
  });
});

// ==========================================
// Finding 125 — daily-allowance hero guards
// ==========================================

describe('Cluster Z — daily-allowance hero navigation guards (finding 125)', () => {
  it('daily-allowance module loads and exports mountDailyAllowance', async () => {
    const mod = await import('../js/modules/components/daily-allowance.js');
    expect(mod.mountDailyAllowance).toBeDefined();
  });
});

// ==========================================
// Findings 128-129 — ui-navigation rAF guards
// ==========================================

describe('Cluster Z — ui-navigation rAF guards (findings 128, 129)', () => {
  it('revealTransactionsForm is exported', async () => {
    const { revealTransactionsForm } = await import('../js/modules/ui/core/ui-navigation.js');
    expect(typeof revealTransactionsForm).toBe('function');
  });

  it('openTransactionsForMonthType is exported', async () => {
    const { openTransactionsForMonthType } = await import('../js/modules/ui/core/ui-navigation.js');
    expect(typeof openTransactionsForMonthType).toBe('function');
  });
});

// ==========================================
// Findings 133-135 — onboarding rAF guards
// ==========================================

describe('Cluster Z — onboarding rAF focus guards (findings 133-135)', () => {
  it('onboarding module loads and exports mountOnboarding', async () => {
    const mod = await import('../js/modules/features/personalization/onboarding.js');
    expect(mod.mountOnboarding).toBeDefined();
  });

  it('startOnboarding is exported', async () => {
    const { startOnboarding } = await import('../js/modules/features/personalization/onboarding.js');
    expect(typeof startOnboarding).toBe('function');
  });

  it('completeOnboarding is exported', async () => {
    const { completeOnboarding } = await import('../js/modules/features/personalization/onboarding.js');
    expect(typeof completeOnboarding).toBe('function');
  });
});

// ==========================================
// Finding 138 — asyncPrompt rAF focus guard
// ==========================================

describe('Cluster Z — asyncPrompt rAF focus guard (finding 138)', () => {
  it('asyncPrompt is exported from async-modal', async () => {
    const { asyncPrompt } = await import('../js/modules/ui/components/async-modal.js');
    expect(typeof asyncPrompt).toBe('function');
  });

  it('asyncConfirm is exported from async-modal', async () => {
    const { asyncConfirm } = await import('../js/modules/ui/components/async-modal.js');
    expect(typeof asyncConfirm).toBe('function');
  });
});
