// @vitest-environment node
/**
 * Currency Formatter Consolidation — Integration Tests
 *
 * Verifies that fmtCur (the single canonical formatter in utils-pure.ts)
 * produces correct output for multiple currencies, including edge cases
 * like zero-decimal (JPY, KRW) and high-value amounts. Also verifies
 * that all screen-facing modules use fmtCur instead of stale DI lambdas.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  fmtCur,
  syncCurrencyFormat,
  CURRENCY_DECIMALS
} from '../js/modules/core/utils-pure.js';

// ==========================================
// UNIT: fmtCur correctness per currency
// ==========================================

describe('fmtCur — canonical currency formatter', () => {
  beforeEach(() => {
    // Reset to USD default
    syncCurrencyFormat({ home: 'USD', symbol: '$' });
  });

  describe('USD (2-decimal default)', () => {
    it('formats a simple amount', () => {
      expect(fmtCur(42.5)).toBe('$42.50');
    });

    it('formats zero', () => {
      expect(fmtCur(0)).toBe('$0.00');
    });

    it('formats negative amounts', () => {
      const result = fmtCur(-123.45);
      expect(result).toBe('-$123.45');
    });

    it('formats large amounts with grouping', () => {
      const result = fmtCur(1234567.89);
      // Intl grouping is locale-dependent, but the symbol and decimals must be right
      expect(result).toContain('$');
      expect(result).toMatch(/1.*234.*567/); // grouped somehow
      expect(result).toMatch(/\.89$/);
    });

    it('handles NaN gracefully', () => {
      expect(fmtCur(NaN)).toBe('$0.00');
    });

    it('handles non-number gracefully', () => {
      // @ts-expect-error: testing runtime guard
      expect(fmtCur('abc')).toBe('$0.00');
    });
  });

  describe('JPY (zero-decimal)', () => {
    beforeEach(() => {
      syncCurrencyFormat({ home: 'JPY', symbol: '¥' });
    });

    it('formats without decimals', () => {
      expect(fmtCur(1500)).toBe('¥1,500');
    });

    it('rounds to whole number', () => {
      // Intl.NumberFormat will round
      const result = fmtCur(1500.75);
      expect(result).toBe('¥1,501');
    });

    it('formats zero', () => {
      expect(fmtCur(0)).toBe('¥0');
    });

    it('handles NaN', () => {
      expect(fmtCur(NaN)).toBe('¥0');
    });
  });

  describe('KRW (zero-decimal)', () => {
    beforeEach(() => {
      syncCurrencyFormat({ home: 'KRW', symbol: '₩' });
    });

    it('formats without decimals', () => {
      expect(fmtCur(50000)).toBe('₩50,000');
    });
  });

  describe('EUR (2-decimal)', () => {
    beforeEach(() => {
      syncCurrencyFormat({ home: 'EUR', symbol: '€' });
    });

    it('formats with euro symbol', () => {
      expect(fmtCur(19.99)).toBe('€19.99');
    });

    it('negative with euro', () => {
      expect(fmtCur(-5.5)).toBe('-€5.50');
    });
  });

  describe('GBP (2-decimal)', () => {
    beforeEach(() => {
      syncCurrencyFormat({ home: 'GBP', symbol: '£' });
    });

    it('formats with pound symbol', () => {
      expect(fmtCur(100)).toBe('£100.00');
    });
  });

  describe('INR (2-decimal)', () => {
    beforeEach(() => {
      syncCurrencyFormat({ home: 'INR', symbol: '₹' });
    });

    it('formats with rupee symbol', () => {
      const result = fmtCur(50000);
      expect(result).toContain('₹');
      expect(result).toContain('50');
      expect(result).toMatch(/\.00$/);
    });
  });

  describe('currency switching at runtime', () => {
    it('switches from USD to JPY mid-session', () => {
      syncCurrencyFormat({ home: 'USD', symbol: '$' });
      expect(fmtCur(1234.56)).toBe('$1,234.56');

      syncCurrencyFormat({ home: 'JPY', symbol: '¥' });
      expect(fmtCur(1234.56)).toBe('¥1,235'); // rounded

      syncCurrencyFormat({ home: 'USD', symbol: '$' });
      expect(fmtCur(1234.56)).toBe('$1,234.56'); // back to normal
    });

    it('idempotent when same currency is re-synced', () => {
      syncCurrencyFormat({ home: 'EUR', symbol: '€' });
      const first = fmtCur(42);
      syncCurrencyFormat({ home: 'EUR', symbol: '€' });
      const second = fmtCur(42);
      expect(first).toBe(second);
    });
  });

  describe('CURRENCY_DECIMALS coverage', () => {
    it('all zero-decimal currencies are mapped', () => {
      const expected = ['JPY', 'KRW', 'VND', 'HUF', 'CLP', 'IDR'];
      for (const code of expected) {
        expect(CURRENCY_DECIMALS[code]).toBe(0);
      }
    });

    it('unmapped currencies default to 2 decimals', () => {
      syncCurrencyFormat({ home: 'USD', symbol: '$' });
      expect(fmtCur(1.5)).toBe('$1.50');

      syncCurrencyFormat({ home: 'GBP', symbol: '£' });
      expect(fmtCur(1.5)).toBe('£1.50');
    });
  });
});

// ==========================================
// ARCHITECTURE: No stale fmtCur DI patterns
// ==========================================

describe('currency formatter — no stale DI injection patterns', () => {
  const modulesDir = resolve(process.cwd(), 'js/modules');

  /**
   * Files that previously had `let fmtCurFn` or equivalent DI-injected
   * currency formatter variables. After consolidation, these should
   * no longer contain local mutable formatter state.
   */
  const consolidatedFiles = [
    'ui/interactions/modal-events.ts',
    'transactions/template-manager.ts',
    'features/financial/budget-planner-ui.ts',
    'ui/charts/analytics-ui.ts',
    'ui/charts/chart-renderers.ts',
    'features/financial/weekly-rollup.ts',
    'features/import-export/import-export-events.ts',
    'features/financial/split-transactions.ts',
    'ui/widgets/debt-ui-handlers.ts'
  ];

  for (const relPath of consolidatedFiles) {
    const filePath = resolve(modulesDir, relPath);
    const fileName = relPath.split('/').pop()!;

    describe(fileName, () => {
      const src = readFileSync(filePath, 'utf-8');

      it('has no local mutable fmtCur/fmtCurFn variable', () => {
        // Match patterns like: let fmtCurFn, let fmtCur =, let splitFmtCurFn
        const mutableFmtPattern = /\blet\s+(fmtCur\b|fmtCurFn\b|splitFmtCurFn\b)/;
        expect(src).not.toMatch(mutableFmtPattern);
      });

      it('has no setXxxFmtCur setter export', () => {
        // Match patterns like: export function setTemplateFmtCurFn, export function setDebtFmtCur
        const setterPattern = /export\s+function\s+set\w*FmtCur/;
        expect(src).not.toMatch(setterPattern);
      });
    });
  }

  it('app-init-di.ts has no inline currency formatter lambdas', () => {
    const diSrc = readFileSync(
      resolve(modulesDir, 'orchestration/app-init-di.ts'),
      'utf-8'
    );
    // The old pattern: (v: number) => signals.currency.value.symbol + v.toFixed(2)
    const inlineLambda = /signals\.currency\.value\.symbol\s*\+\s*v\.toFixed\(2\)/;
    expect(diSrc).not.toMatch(inlineLambda);
  });

  it('transaction-renderer.ts uses fmtCur from utils-pure, not currency-service', () => {
    const src = readFileSync(
      resolve(modulesDir, 'data/transaction-renderer.ts'),
      'utf-8'
    );
    expect(src).not.toContain('currency-service');
    expect(src).toContain("from '../core/utils-pure.js'");
    expect(src).toContain('fmtCur');
  });

  it('no production module imports formatCurrency from currency-service', () => {
    const allFiles = getAllTsFiles(modulesDir);
    const violations: string[] = [];

    for (const file of allFiles) {
      const src = readFileSync(file, 'utf-8');
      if (src.includes("from") && src.includes('currency-service') && !file.includes('currency-service.ts')) {
        violations.push(file.replace(modulesDir + '/', ''));
      }
    }

    expect(violations).toEqual([]);
  });
});

// ==========================================
// Helper: recursive TS file finder
// ==========================================

function getAllTsFiles(dir: string): string[] {
  const { readdirSync, statSync } = require('node:fs');
  const { join } = require('node:path');
  const files: string[] = [];

  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...getAllTsFiles(full));
    } else if (full.endsWith('.ts')) {
      files.push(full);
    }
  }

  return files;
}
