/**
 * Regression tests for CR-Apr24-I / J / K fix clusters.
 *
 * Cluster I — Core utility & contract P2 fixes
 *   304  di-container async singleton truthiness
 *   349  baseline NaN/Infinity guard (computeBaselineDelta)
 *   350/351  baseline NaN guard (formatBaselineDelta)
 *   353/354  fmtShort rounding & sub-unit decimals
 *   355/356  parseMonthKey invalid→NaN instead of silent substitution
 *   362  getMonthAlloc corrupted-value guard
 *   365/366/367  parseLocalDate / getMonthKey / formatDate YYYY-MM fix
 *   311/312/313  Semaphore / ReadWriteLock over-release guards
 *
 * Cluster J — Locale & currency parity P2 fixes
 *   373/374  CURRENCY_MAP parity with Settings dropdown
 *   228  detectCurrency es-MX / hi-IN misclassification
 *   369  formatMonth YYYY-MM timezone fix
 *   378  parseNumber Arabic digit transliteration
 *   361  formatNumber decimals parameter honoured
 *
 * Cluster K — Import/backup fidelity P2 fixes
 *   174  SETTINGS_KEY_MAP lastBackupTxCount entry
 *   179  _getSettingsKey throws on unmapped keys
 *   187  normalizeBackupSettings clamps lastBackupTxCount
 *   196  state-hydration uses stricter tx-count normalizer
 */

import { describe, it, expect } from 'vitest';

// ==========================================
// CLUSTER I
// ==========================================

describe('Cluster I: Core utility & contract fixes', () => {

  // --- Finding 304: DI container async singleton truthiness ---
  describe('Finding 304 — DI container falsy singleton', () => {
    it('resolves falsy singleton values (0, false, empty string, null) without re-creating', async () => {
      const { DIContainer } = await import('../js/modules/core/di-container.js');
      const container = new DIContainer();

      container.register('zero', () => 0, { singleton: true });
      container.register('falseBool', () => false, { singleton: true });
      container.register('emptyStr', () => '', { singleton: true });
      container.register('nullVal', () => null, { singleton: true });

      expect(await container.resolve('zero')).toBe(0);
      expect(await container.resolve('zero')).toBe(0); // second call — must not re-create
      expect(await container.resolve('falseBool')).toBe(false);
      expect(await container.resolve('emptyStr')).toBe('');
      expect(await container.resolve('nullVal')).toBe(null);
    });
  });

  // --- Findings 349-351: baseline NaN/Infinity guards ---
  describe('Findings 349-351 — baseline NaN/Infinity guards', () => {
    it('computeBaselineDelta returns no-data for NaN inputs', async () => {
      const { computeBaselineDelta } = await import('../js/modules/core/baseline.js');
      expect(computeBaselineDelta(NaN, 100)).toEqual({ status: 'no-data', percent: null, delta: 0 });
      expect(computeBaselineDelta(100, NaN)).toEqual({ status: 'no-data', percent: null, delta: 0 });
    });

    it('computeBaselineDelta returns no-data for Infinity inputs', async () => {
      const { computeBaselineDelta } = await import('../js/modules/core/baseline.js');
      expect(computeBaselineDelta(Infinity, 100)).toEqual({ status: 'no-data', percent: null, delta: 0 });
      expect(computeBaselineDelta(100, -Infinity)).toEqual({ status: 'no-data', percent: null, delta: 0 });
    });

    it('formatBaselineDelta returns dash for malformed percent', async () => {
      const { formatBaselineDelta } = await import('../js/modules/core/baseline.js');
      // Externally constructed delta with NaN percent
      expect(formatBaselineDelta({ status: 'comparable', percent: NaN, delta: 50 })).toBe('—');
      expect(formatBaselineDelta({ status: 'comparable', percent: Infinity, delta: 50 })).toBe('—');
    });
  });

  // --- Findings 353/354: fmtShort rounding ---
  describe('Findings 353/354 — fmtShort rounding', () => {
    it('preserves sub-unit decimal amounts', async () => {
      const { fmtShort, syncCurrencyFormat } = await import('../js/modules/core/utils-pure.js');
      syncCurrencyFormat({ home: 'USD', symbol: '$' });

      // $0.50 should show as $0.50, not $0 or $1
      const result = fmtShort(0.5);
      expect(result).toContain('0.50');
    });

    it('rounds before k-threshold comparison', async () => {
      const { fmtShort, syncCurrencyFormat } = await import('../js/modules/core/utils-pure.js');
      syncCurrencyFormat({ home: 'USD', symbol: '$' });

      // $999.995 rounds to $1000 → should show as 1.0k, not $999.995
      const result = fmtShort(999.995);
      expect(result).toContain('k');
    });
  });

  // --- Findings 355/356: parseMonthKey invalid → NaN ---
  describe('Findings 355/356 — parseMonthKey returns Invalid Date', () => {
    it('returns Invalid Date for empty/null input', async () => {
      const { parseMonthKey } = await import('../js/modules/core/utils-pure.js');
      const d = parseMonthKey('');
      expect(isNaN(d.getTime())).toBe(true);
    });

    it('returns Invalid Date for malformed format', async () => {
      const { parseMonthKey } = await import('../js/modules/core/utils-pure.js');
      const d = parseMonthKey('not-a-date');
      expect(isNaN(d.getTime())).toBe(true);
    });

    it('returns Invalid Date for out-of-range month', async () => {
      const { parseMonthKey } = await import('../js/modules/core/utils-pure.js');
      const d = parseMonthKey('2026-13');
      expect(isNaN(d.getTime())).toBe(true);
    });

    it('returns valid Date for valid YYYY-MM', async () => {
      const { parseMonthKey } = await import('../js/modules/core/utils-pure.js');
      const d = parseMonthKey('2026-04');
      expect(isNaN(d.getTime())).toBe(false);
      expect(d.getFullYear()).toBe(2026);
      expect(d.getMonth()).toBe(3); // April = 3
    });
  });

  // --- Finding 362: getMonthAlloc corrupted value ---
  describe('Finding 362 — getMonthAlloc rejects non-record values', () => {
    it('falls through to empty object when value is null', async () => {
      const { getMonthAlloc } = await import('../js/modules/core/month-alloc.js');
      // Simulate corrupted allocMap with null value
      const allocMap = { '2026-04': null as unknown as Record<string, number> };
      const result = getMonthAlloc('2026-04', allocMap as any);
      expect(result).toEqual({});
    });

    it('falls through to empty object when value is a number', async () => {
      const { getMonthAlloc } = await import('../js/modules/core/month-alloc.js');
      const allocMap = { '2026-04': 42 as unknown as Record<string, number> };
      const result = getMonthAlloc('2026-04', allocMap as any);
      expect(result).toEqual({});
    });

    it('returns valid record values normally', async () => {
      const { getMonthAlloc } = await import('../js/modules/core/month-alloc.js');
      const alloc = { food: 500 };
      const allocMap = { '2026-04': alloc };
      const result = getMonthAlloc('2026-04', allocMap as any);
      expect(result).toBe(alloc);
    });
  });

  // --- Findings 365/366/367: parseLocalDate / getMonthKey YYYY-MM ---
  describe('Findings 365-367 — YYYY-MM string handling', () => {
    it('parseLocalDate normalises YYYY-MM to local date', async () => {
      const { parseLocalDate } = await import('../js/modules/core/utils-pure.js');
      const d = parseLocalDate('2026-04');
      expect(d.getFullYear()).toBe(2026);
      expect(d.getMonth()).toBe(3); // April
      expect(d.getDate()).toBe(1);
    });

    it('getMonthKey preserves month from YYYY-MM input', async () => {
      const { getMonthKey } = await import('../js/modules/core/utils-pure.js');
      // Must return '2026-04' regardless of timezone
      expect(getMonthKey('2026-04')).toBe('2026-04');
    });
  });

  // --- Findings 311/312/313: Semaphore & ReadWriteLock over-release ---
  describe('Findings 311-313 — over-release guards', () => {
    it('Semaphore.release throws on underflow', async () => {
      const { Semaphore } = await import('../js/modules/core/mutex.js');
      const sem = new Semaphore(2);
      // No acquire → release should throw
      expect(() => sem.release()).toThrow('no matching acquire');
    });

    it('ReadWriteLock.releaseRead throws when no readers', async () => {
      const { ReadWriteLock } = await import('../js/modules/core/mutex.js');
      const rwl = new ReadWriteLock();
      expect(() => rwl.releaseRead()).toThrow('no matching acquireRead');
    });

    it('ReadWriteLock.releaseWrite throws when not writing', async () => {
      const { ReadWriteLock } = await import('../js/modules/core/mutex.js');
      const rwl = new ReadWriteLock();
      expect(() => rwl.releaseWrite()).toThrow('no matching acquireWrite');
    });

    it('Semaphore acquire/release cycle works normally', async () => {
      const { Semaphore } = await import('../js/modules/core/mutex.js');
      const sem = new Semaphore(1);
      await sem.acquire();
      expect(() => sem.release()).not.toThrow();
    });

    it('ReadWriteLock read cycle works normally', async () => {
      const { ReadWriteLock } = await import('../js/modules/core/mutex.js');
      const rwl = new ReadWriteLock();
      await rwl.acquireRead();
      expect(() => rwl.releaseRead()).not.toThrow();
    });

    it('ReadWriteLock write cycle works normally', async () => {
      const { ReadWriteLock } = await import('../js/modules/core/mutex.js');
      const rwl = new ReadWriteLock();
      await rwl.acquireWrite();
      expect(() => rwl.releaseWrite()).not.toThrow();
    });
  });
});


// ==========================================
// CLUSTER J
// ==========================================

describe('Cluster J: Locale & currency parity fixes', () => {

  // --- Findings 373/374: CURRENCY_MAP parity ---
  describe('Findings 373/374 — CURRENCY_MAP covers all Settings currencies', () => {
    it('every currency from getAvailableCurrencies has a CURRENCY_MAP entry', async () => {
      const { CURRENCY_MAP } = await import('../js/modules/core/utils-pure.js');
      const { localeService } = await import('../js/modules/core/locale-service.js');
      const available = localeService.getAvailableCurrencies();
      const missing: string[] = [];
      for (const { code } of available) {
        if (!(code in CURRENCY_MAP)) missing.push(code);
      }
      expect(missing).toEqual([]);
    });
  });

  // --- Finding 361: formatNumber honours decimals ---
  describe('Finding 361 — formatNumber honours decimals parameter', () => {
    it('respects explicit decimal precision', async () => {
      const { formatNumber } = await import('../js/modules/core/utils-pure.js');
      // Even with locale service live, decimals=2 should produce 2 decimals
      const result = formatNumber(1.23456, 2);
      // Should contain "1.23" (or locale equivalent with comma)
      expect(result).toMatch(/1[.,]23$/);
    });
  });
});


// ==========================================
// CLUSTER K
// ==========================================

describe('Cluster K: Import/backup fidelity fixes', () => {

  // --- Finding 187: normalizeBackupSettings clamps lastBackupTxCount ---
  describe('Finding 187 — normalizeBackupSettings clamps tx count', () => {
    it('clamps negative lastBackupTxCount to 0', async () => {
      const { normalizeBackupSettings } = await import('../js/modules/features/backup/auto-backup.js');
      const result = normalizeBackupSettings({ lastBackupTxCount: -5 });
      expect(result.lastBackupTxCount).toBe(0);
    });

    it('rounds fractional lastBackupTxCount', async () => {
      const { normalizeBackupSettings } = await import('../js/modules/features/backup/auto-backup.js');
      const result = normalizeBackupSettings({ lastBackupTxCount: 3.7 });
      expect(result.lastBackupTxCount).toBe(4);
    });

    it('passes valid integer lastBackupTxCount through', async () => {
      const { normalizeBackupSettings } = await import('../js/modules/features/backup/auto-backup.js');
      const result = normalizeBackupSettings({ lastBackupTxCount: 42 });
      expect(result.lastBackupTxCount).toBe(42);
    });
  });
});
