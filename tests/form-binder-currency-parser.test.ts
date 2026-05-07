/**
 * Form-binder currency parser — M9 (Inline-Behavior-Review rev 12).
 *
 * The `Parsers.currency` preset in form-binder.ts used to run a plain
 * `value.replace(/[$,]/g, '').parseFloat`-style strip that assumed en-US
 * formatting. M9 re-routed it through `parseAmount` / localeService so
 * non-en-US locales parse correctly. This file locks in the new contract
 * end-to-end: default (en-US) still works, de-DE locale flips the
 * thousands/decimal roles, and invalid input stays at the safe-zero
 * fallback.
 *
 * Tests the same parser pipeline used by template-manager.ts:190
 * (`amount: parseAmount(formAmount.value)`) and worker-manager.ts:462-463
 * (filter min/maxAmount) — all three call sites route through `parseAmount`
 * which delegates to `localeService.parseCurrency`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Parsers } from '../js/modules/core/form-binder.js';
import { localeService } from '../js/modules/core/locale-service.js';

// Capture the starting settings so each test restores a clean default.
let originalSettings: ReturnType<typeof localeService.getSettings>;

beforeEach(() => {
  originalSettings = localeService.getSettings();
});

afterEach(() => {
  localeService.updateSettings(originalSettings);
});

describe('form-binder Parsers.currency (M9 — locale-aware)', () => {
  it('parses plain en-US formatted amounts', () => {
    expect(Parsers.currency('1234.56')).toBe(1234.56);
    expect(Parsers.currency('100')).toBe(100);
    expect(Parsers.currency('0.01')).toBe(0.01);
  });

  it('strips $ and commas in en-US formatting', () => {
    expect(Parsers.currency('$1,234.56')).toBe(1234.56);
    expect(Parsers.currency('$50')).toBe(50);
  });

  it('honors active locale settings — de-DE flips comma / period roles', () => {
    // de-DE: thousands=".", decimal=",". Prior implementation hard-coded
    // the en-US pattern and returned 1 for "1,50" — a 50-cent-per-template
    // silent error that was the motivating failure for M9.
    localeService.updateSettings({
      decimalSeparator: ',',
      thousandsSeparator: '.'
    });

    expect(Parsers.currency('1,50')).toBe(1.5);
    expect(Parsers.currency('1.234,56')).toBe(1234.56);
  });

  it('returns 0 for non-parseable input (masked-default contract preserved)', () => {
    // parseAmount keeps the legacy "return 0 on NaN" mask — distinct from
    // parseNumber's NaN-propagation contract (M15). The currency preset
    // is consumed by form-binder callers that want a number for binding,
    // not a validation signal; validation lives in validator.validateAmount.
    expect(Parsers.currency('')).toBe(0);
    expect(Parsers.currency('abc')).toBe(0);
    expect(Parsers.currency('$')).toBe(0);
  });

  it('rejects negatives by returning 0 (inherited from parseAmount)', () => {
    expect(Parsers.currency('-50')).toBe(0);
  });

  it('rounds to cents precision (inherited from parseAmount)', () => {
    // parseAmount uses Math.round(val * 100) / 100 for cents normalization.
    expect(Parsers.currency('1.999')).toBe(2);
    expect(Parsers.currency('1.994')).toBe(1.99);
  });
});
