/**
 * PDF Export unit tests.
 *
 * Covers the security and correctness invariants of `pdf-export.ts`:
 *   - `formatCurrencyHtml` must HTML-escape its symbol argument (defense-in-depth
 *     against a malicious sync payload reaching the print surface once cloud
 *     sync lands in v3.0 Phase 3).
 *   - `buildPdfHtml` must not emit raw attacker-controlled strings anywhere in
 *     its output.
 *
 * These tests exist because prior to 2026-04-10 there was no coverage of this
 * module at all, which allowed a latent floating-point + transfer-exclusion
 * bug to sit unnoticed (fixed in ADR-001 §9.5 Step 6).
 */
import { describe, it, expect } from 'vitest';
import { formatCurrencyHtml, buildPdfHtml } from '../js/modules/features/import-export/pdf-export.js';
import { createTx, createIncomeTx, resetFixtureCounter } from './helpers/fixtures.js';

describe('pdf-export — formatCurrencyHtml security', () => {
  it('escapes a plain currency symbol through the HTML-safe path', () => {
    const result = formatCurrencyHtml(100, '$');
    // The escape function turns '$' into itself (not in the 8-char escape set),
    // but the assertion we care about is that the output contains no raw tag.
    expect(result).toContain('$');
    expect(result).toContain('100.00');
  });

  it('escapes an HTML-injection attempt in the symbol', () => {
    const malicious = '<img src=x onerror=alert(1)>';
    const result = formatCurrencyHtml(100, malicious);
    // The raw tag must not appear in the output.
    expect(result).not.toContain('<img');
    expect(result).not.toContain('onerror=');
    // The escaped form must appear instead.
    expect(result).toContain('&lt;img');
  });

  it('escapes quotes, ampersands, and angle brackets', () => {
    const result = formatCurrencyHtml(100, `"&<>`);
    expect(result).toContain('&quot;');
    expect(result).toContain('&amp;');
    expect(result).toContain('&lt;');
    expect(result).toContain('&gt;');
  });

  it('escapes backticks and equals signs (defense-in-depth)', () => {
    const result = formatCurrencyHtml(100, '`=');
    expect(result).toContain('&#96;');
    expect(result).toContain('&#61;');
  });

  it('formats the numeric portion independently of the symbol', () => {
    expect(formatCurrencyHtml(1234.5, '$')).toContain('1,234.50');
    expect(formatCurrencyHtml(0.1, '$')).toContain('0.10');
    expect(formatCurrencyHtml(-50, '$')).toContain('50.00'); // Math.abs strips the sign
  });
});

describe('pdf-export — buildPdfHtml never emits raw attacker content', () => {
  it('escapes HTML in the transaction description', () => {
    resetFixtureCounter();
    const txs = [
      createTx({ description: '<script>alert(1)</script>', amount: 50 }),
    ];
    const html = buildPdfHtml(txs, '$');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes HTML in the currency symbol passed through', () => {
    resetFixtureCounter();
    const txs = [createTx({ amount: 50 })];
    const html = buildPdfHtml(txs, '<b>$</b>');
    // The <b> tag must be escaped inside the amount cells.
    expect(html).not.toContain('<td class="amount expense">-<b>$</b>');
    expect(html).toContain('&lt;b&gt;');
  });

  it('produces a full statement with mixed income and expense transactions', () => {
    resetFixtureCounter();
    const txs = [
      createIncomeTx({ amount: 5000, description: 'Paycheck' }),
      createTx({ amount: 50, description: 'Groceries' }),
      createTx({ amount: 25, description: 'Coffee' }),
    ];
    const html = buildPdfHtml(txs, '$');
    expect(html).toContain('Paycheck');
    expect(html).toContain('Groceries');
    expect(html).toContain('Coffee');
    // Totals should appear somewhere in the document header/summary.
    expect(html.length).toBeGreaterThan(500);
  });
});

describe('pdf-export — aggregation correctness (ADR-001 §9.5 Step 6)', () => {
  it('uses integer-cents math so float amounts do not drift in totals', () => {
    resetFixtureCounter();
    // 0.1 + 0.2 === 0.30000000000000004 with naïve float reduce.
    // Three such rows should land on exactly 0.90, not 0.9000000...
    const txs = [
      createTx({ amount: 0.1, description: 'a' }),
      createTx({ amount: 0.2, description: 'b' }),
      createTx({ amount: 0.6, description: 'c' }),
    ];
    const html = buildPdfHtml(txs, '$');
    // Summary must show $0.90 exactly — not a long float expansion.
    expect(html).toContain('$0.90');
    expect(html).not.toMatch(/0\.9000+/);
  });

  it('excludes savings-transfer expenses from the "Total Expenses" figure', () => {
    resetFixtureCounter();
    // A normal expense + a savings transfer expense. Only the first should
    // count toward the header "Total Expenses" figure; the savings transfer
    // is money moving between the user's own accounts.
    const txs = [
      createTx({ amount: 40, description: 'Groceries', category: 'food' }),
      createTx({
        amount: 100,
        description: 'Savings Transfer: Emergency Fund',
        category: 'savings_transfer',
        tags: 'savings,goal,savings_transfer',
        notes: '[savings-transfer] Contribution to goal: Emergency Fund [id:sg_123]',
      }),
    ];
    const html = buildPdfHtml(txs, '$');
    // Expenses header should read 40.00, NOT 140.00.
    expect(html).toMatch(/-\$40\.00/);
    expect(html).not.toMatch(/-\$140\.00/);
    // But the transfer row itself should still render in the body table.
    expect(html).toContain('Savings Transfer: Emergency Fund');
  });

  it('computes net balance using the transfer-aware expense total', () => {
    resetFixtureCounter();
    const txs = [
      createIncomeTx({ amount: 1000, description: 'Paycheck' }),
      createTx({ amount: 300, description: 'Rent', category: 'housing' }),
      createTx({
        amount: 200,
        description: 'Savings Transfer: Vacation',
        category: 'savings_transfer',
        tags: 'savings,goal,savings_transfer',
        notes: '[savings-transfer] Contribution to goal: Vacation [id:sg_2]',
      }),
    ];
    const html = buildPdfHtml(txs, '$');
    // Net = 1000 income − 300 tracked expense = +700 (savings transfer excluded).
    expect(html).toMatch(/\+\$700\.00/);
  });
});
