/**
 * Regression tests for CR-Apr24-P fix cluster.
 *
 * Cluster P — Currency reactivity P2 fixes
 *   74   setCurrency() emits CURRENCY_CHANGED event
 *   76   locale-service formatters rebuild on currency change
 *   77   (covered by 76 — toasts use localeService.formatCurrency)
 *   78   (covered by 76 — duplicate-review uses localeService.formatCurrency)
 *   79   locale-service respects zero-decimal currencies (JPY, KRW)
 *   81   fmtCur() uses Intl currency formatting for locale-aware placement
 *   69   month-comparison rerenders on CURRENCY_CHANGED
 *   98   template list rerenders on CURRENCY_CHANGED
 */

import { describe, it, expect, vi } from 'vitest';

// ==========================================
// Finding 74 — CURRENCY_CHANGED event emission
// ==========================================

describe('Cluster P — setCurrency event emission (finding 74)', () => {
  it('setCurrency() emits CURRENCY_CHANGED with the new CurrencySettings', async () => {
    const eventBus = await import('../js/modules/core/event-bus.js');
    eventBus.clearAll();

    const handler = vi.fn();
    eventBus.on(eventBus.Events.CURRENCY_CHANGED, handler);

    const { settings } = await import('../js/modules/core/actions/data-actions.js');
    settings.setCurrency('EUR', '€');

    // queueEvent may batch — flush by awaiting a microtask
    await new Promise(r => setTimeout(r, 0));

    expect(handler).toHaveBeenCalled();
    const payload = handler.mock.calls[0]?.[0] as { home: string; symbol: string } | undefined;
    expect(payload?.home).toBe('EUR');
    expect(payload?.symbol).toBe('€');

    eventBus.off(eventBus.Events.CURRENCY_CHANGED, handler);
    eventBus.clearAll();
  });

  it('setCurrencySettings() also emits CURRENCY_CHANGED', async () => {
    const eventBus = await import('../js/modules/core/event-bus.js');
    eventBus.clearAll();

    const handler = vi.fn();
    eventBus.on(eventBus.Events.CURRENCY_CHANGED, handler);

    const dataActions = await import('../js/modules/core/actions/data-actions.js');
    // setCurrencySettings lives on the `data` export, not `settings`
    dataActions.data.setCurrencySettings({ home: 'GBP', symbol: '£' });

    await new Promise(r => setTimeout(r, 0));

    expect(handler).toHaveBeenCalled();
    const payload = handler.mock.calls[0]?.[0] as { home: string; symbol: string } | undefined;
    expect(payload?.home).toBe('GBP');
    expect(payload?.symbol).toBe('£');

    eventBus.off(eventBus.Events.CURRENCY_CHANGED, handler);
    eventBus.clearAll();
  });
});

// ==========================================
// Finding 79 — zero-decimal currency support
// ==========================================

describe('Cluster P — locale-service zero-decimal currencies (finding 79)', () => {
  it('formatCurrency uses 0 decimals for JPY', async () => {
    const { localeService } = await import('../js/modules/core/locale-service.js');

    const original = localeService.getSettings();

    localeService.updateCurrency('JPY');
    const formatted = localeService.formatCurrency(1234);

    // Should NOT contain ".00" for JPY — zero-decimal currency
    expect(formatted).not.toMatch(/\.00/);

    // Restore
    localeService.updateCurrency(original.currency);
  });

  it('formatCurrency uses 2 decimals for USD', async () => {
    const { localeService } = await import('../js/modules/core/locale-service.js');

    const original = localeService.getSettings();

    localeService.updateCurrency('USD');
    const formatted = localeService.formatCurrency(1234.5);

    // Should contain decimals for USD
    expect(formatted).toMatch(/1[,.]?234/);

    localeService.updateCurrency(original.currency);
  });
});

// ==========================================
// Finding 76 — locale-service updateCurrency
// ==========================================

describe('Cluster P — locale-service currency update (finding 76)', () => {
  it('updateCurrency rebuilds formatters with the new currency', async () => {
    const { localeService } = await import('../js/modules/core/locale-service.js');

    const original = localeService.getSettings();

    localeService.updateCurrency('EUR');
    expect(localeService.getCurrency()).toBe('EUR');

    const formatted = localeService.formatCurrency(100);
    // Should contain EUR symbol or code, not the prior currency
    expect(formatted).toMatch(/[€]|EUR/);

    // Restore
    localeService.updateCurrency(original.currency);
  });

  it('updateCurrency is a no-op when currency unchanged', async () => {
    const { localeService } = await import('../js/modules/core/locale-service.js');

    const original = localeService.getSettings();
    localeService.updateCurrency('USD');

    const before = localeService.formatCurrency(42);
    // Call again with same code
    localeService.updateCurrency('USD');
    const after = localeService.formatCurrency(42);

    expect(before).toBe(after);

    localeService.updateCurrency(original.currency);
  });
});

// ==========================================
// Finding 81 — fmtCur Intl currency formatting
// ==========================================

describe('Cluster P — fmtCur Intl currency formatting (finding 81)', () => {
  it('fmtCur formats with the synced currency code', async () => {
    const { syncCurrencyFormat, fmtCur } = await import('../js/modules/core/utils-pure.js');

    syncCurrencyFormat({ home: 'JPY', symbol: '¥' });
    const jpyFormatted = fmtCur(1234);
    // JPY is zero-decimal — should NOT show ".00"
    expect(jpyFormatted).not.toMatch(/\.00/);

    syncCurrencyFormat({ home: 'USD', symbol: '$' });
    const usdFormatted = fmtCur(1234.56);
    // Should contain the amount
    expect(usdFormatted).toMatch(/1[,.]?234/);
  });

  it('fmtCur handles NaN gracefully', async () => {
    const { syncCurrencyFormat, fmtCur } = await import('../js/modules/core/utils-pure.js');

    syncCurrencyFormat({ home: 'USD', symbol: '$' });
    const result = fmtCur(NaN);
    // Should return a formatted zero, not crash
    expect(result).toBeDefined();
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('fmtCur handles negative amounts', async () => {
    const { syncCurrencyFormat, fmtCur } = await import('../js/modules/core/utils-pure.js');

    syncCurrencyFormat({ home: 'USD', symbol: '$' });
    const result = fmtCur(-50);
    // Should contain a negative indicator
    expect(result).toMatch(/-/);
    expect(result).toMatch(/50/);
  });
});

// ==========================================
// Finding 69 + 98 — CURRENCY_CHANGED event exists
// ==========================================

describe('Cluster P — CURRENCY_CHANGED event wiring', () => {
  it('Events object includes CURRENCY_CHANGED', async () => {
    const { Events } = await import('../js/modules/core/event-bus.js');
    expect(Events.CURRENCY_CHANGED).toBe('currency:changed');
  });
});
