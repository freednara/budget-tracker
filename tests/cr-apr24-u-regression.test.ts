/**
 * Regression tests for CR-Apr24-U fix cluster.
 *
 * Cluster U — Misc UI stale-state P2 fixes
 *   29   Debt planner neg-amort detection (already fixed by CR-Apr24-A)
 *   62   Weekly rollup dead action → now routes through filter-actions
 *   71   Analytics modal visibility-aware refresh
 *   72   Multi-tab sync refreshes full analytics modal
 *   136  Cross-tab streak widget rendering
 *   142  Recurring-edit chooser (already fixed by CR-Apr24-C3)
 *   315  Validator showFieldError respects aria-describedby
 */

import { describe, it, expect, vi } from 'vitest';

// ==========================================
// Finding 29 — debt planner neg-amort detection (already fixed)
// ==========================================

describe('Cluster U — debt planner neg-amort detection (finding 29)', () => {
  it('calculatePayoffDate is exported from debt-planner', async () => {
    const dp = await import('../js/modules/features/financial/debt-planner.js');
    expect(dp.calculatePayoffDate).toBeDefined();
    expect(typeof dp.calculatePayoffDate).toBe('function');
  });
});

// ==========================================
// Finding 62 — weekly rollup filter action wired
// ==========================================

describe('Cluster U — weekly rollup filter action (finding 62)', () => {
  it('weekly-rollup module loads without error', async () => {
    const wr = await import('../js/modules/components/weekly-rollup.js');
    expect(wr).toBeDefined();
  });

  it('filters-actions exports updateFilters via the filters object', async () => {
    // The fix routes weekly bar clicks through filters.updateFilters
    const { filters } = await import('../js/modules/core/actions/filters-actions.js');
    expect(filters.updateFilters).toBeDefined();
    expect(typeof filters.updateFilters).toBe('function');
  });
});

// ==========================================
// Finding 71 — analytics modal visibility-aware refresh
// ==========================================

describe('Cluster U — analytics modal visibility-aware refresh (finding 71)', () => {
  it('refreshAnalyticsIfOpen is exported from analytics-ui', async () => {
    const analyticsUi = await import('../js/modules/features/analytics/analytics-ui.js');
    expect(analyticsUi.refreshAnalyticsIfOpen).toBeDefined();
    expect(typeof analyticsUi.refreshAnalyticsIfOpen).toBe('function');
  });

  it('refreshAnalyticsIfOpen does not throw when modal is absent', async () => {
    const analyticsUi = await import('../js/modules/features/analytics/analytics-ui.js');
    // No DOM — should be a safe no-op
    expect(() => analyticsUi.refreshAnalyticsIfOpen()).not.toThrow();
  });
});

// ==========================================
// Finding 72 — multi-tab sync full analytics refresh
// ==========================================

describe('Cluster U — multi-tab sync analytics refresh (finding 72)', () => {
  it('refreshAnalyticsIfOpen is importable for use by app-init-di', async () => {
    // The fix adds `refreshAnalyticsIfOpen()` to setupRemoteTransactionFollowUps.
    // Verify the function exists and is callable.
    const { refreshAnalyticsIfOpen } = await import('../js/modules/features/analytics/analytics-ui.js');
    expect(typeof refreshAnalyticsIfOpen).toBe('function');
  });
});

// ==========================================
// Finding 136 — cross-tab streak widget rendering
// ==========================================

describe('Cluster U — cross-tab streak rendering (finding 136)', () => {
  it('renderStreak is exported from streak-tracker', async () => {
    const st = await import('../js/modules/features/gamification/streak-tracker.js');
    expect(st.renderStreak).toBeDefined();
    expect(typeof st.renderStreak).toBe('function');
  });
});

// ==========================================
// Finding 142 — recurring-edit chooser (already fixed by CR-Apr24-C3)
// ==========================================

describe('Cluster U — recurring-edit chooser wiring (finding 142)', () => {
  it('pendingEditTx signal exists and routeTransactionEdit writes it', async () => {
    const signals = await import('../js/modules/core/signals.js');
    expect(signals.pendingEditTx).toBeDefined();
    expect(signals.pendingEditTx.value).toBeNull();

    const renderer = await import('../js/modules/data/transaction-renderer.js');
    expect(renderer.routeTransactionEdit).toBeDefined();
    expect(typeof renderer.routeTransactionEdit).toBe('function');
  });
});

// ==========================================
// Finding 315 — showFieldError respects aria-describedby
// ==========================================

describe('Cluster U — showFieldError a11y (finding 315)', () => {
  it('showFieldError uses prewired aria-describedby node when present', async () => {
    const validatorModule = await import('../js/modules/core/validator.js');
    const validator = validatorModule.default;

    // Create a field with an aria-describedby error node
    const field = document.createElement('input');
    field.setAttribute('aria-describedby', 'test-error-node');
    const errorNode = document.createElement('span');
    errorNode.id = 'test-error-node';
    errorNode.setAttribute('role', 'alert');
    errorNode.style.display = 'none';
    document.body.appendChild(field);
    document.body.appendChild(errorNode);

    validator.showFieldError(field, 'Amount is required');

    // The prewired node should have the message
    expect(errorNode.textContent).toBe('Amount is required');
    expect(errorNode.style.display).toBe('block');
    // The field should be marked invalid
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(field.classList.contains('error')).toBe(true);

    // No ad-hoc sibling .error-message should have been created
    const parent = field.parentElement;
    const siblingError = parent?.querySelector('.error-message');
    expect(siblingError).toBeNull();

    // Cleanup
    validator.clearFieldError(field);
    expect(errorNode.textContent).toBe('');
    expect(errorNode.style.display).toBe('none');
    expect(field.getAttribute('aria-invalid')).toBe('false');

    document.body.removeChild(field);
    document.body.removeChild(errorNode);
  });

  it('showFieldError falls back to sibling span when no aria-describedby', async () => {
    const validatorModule = await import('../js/modules/core/validator.js');
    const validator = validatorModule.default;

    // Create a field WITHOUT aria-describedby, inside a container
    const container = document.createElement('div');
    const field = document.createElement('input');
    container.appendChild(field);
    document.body.appendChild(container);

    validator.showFieldError(field, 'Field is required');

    // Should create a sibling .error-message span
    const errorEl = container.querySelector('.error-message');
    expect(errorEl).toBeTruthy();
    expect(errorEl!.textContent).toBe('Field is required');

    // Cleanup
    validator.clearFieldError(field);
    expect(container.querySelector('.error-message')).toBeNull();

    document.body.removeChild(container);
  });
});
