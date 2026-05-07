/**
 * PDF Export Module
 *
 * Generates a print-ready transaction statement using the browser's
 * built-in print/PDF functionality. Zero external dependencies.
 *
 * @module pdf-export
 */
'use strict';

import * as signals from '../../core/signals.js';
import { getCatInfo } from '../../core/categories.js';
import { esc } from '../../core/utils-dom.js';
import { getTodayStr, sumByType, sumTrackedExpenses } from '../../core/utils-pure.js';
import { localeService } from '../../core/locale-service.js';
import type { Transaction, TransactionType } from '../../../types/index.js';

// ==========================================
// HELPERS
// ==========================================

function formatDate(dateStr: string): string {
  // Route through locale-service so exported PDF dates respect the app's
  // configured locale (was hardcoded 'en-US' — flagged as a latent i18n
  // bug by ADR-001's deferral list, now pulled forward in CR-Apr21).
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString(localeService.getLocale(), { month: 'short', day: 'numeric', year: 'numeric' });
}

/** @internal Exported for unit tests. Not part of the module's public API. */
export function formatCurrencyHtml(amount: number, symbol: string): string {
  // Defense-in-depth: `esc()` the symbol unconditionally so this function is
  // XSS-safe regardless of how the caller sourced the symbol. Today every call
  // site routes the symbol through `CURRENCY_MAP`, but once Phase 3 of the
  // cloud-sync ADR lands, remote devices could feed `syncState.applyKeyUpdate(
  // 'CURRENCY', ...)` with attacker-controlled content. See ADR-001 §1.4.
  // Route the number portion through the app's configured locale so
  // thousands/decimal separators match the rest of the UI (was hardcoded
  // 'en-US'). Symbol stays separate for XSS-safe esc() wrapping.
  return `${esc(symbol)}${Math.abs(amount).toLocaleString(localeService.getLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function getDateRange(txs: Transaction[]): { start: string; end: string } {
  if (!txs.length) {
    const today = getTodayStr();
    return { start: today, end: today };
  }
  const dates = txs.map(t => t.date).sort();
  // Phase 6 Slice 1i (rev 12 L6): `dates[i]` is `string | undefined`
  // under `noUncheckedIndexedAccess`; the `!txs.length` early return
  // above guarantees presence, but `?? today` keeps both fields typed.
  const today = getTodayStr();
  return { start: dates[0] ?? today, end: dates[dates.length - 1] ?? today };
}

// ==========================================
// PDF HTML BUILDER
// ==========================================

/** @internal Exported for unit tests. Not part of the module's public API. */
export function buildPdfHtml(txs: Transaction[], currencySymbol: string): string {
  const sorted = [...txs].sort((a, b) => b.date.localeCompare(a.date) || b.amount - a.amount);
  const range = getDateRange(sorted);

  // Correctness:
  //   - `sumByType` and `sumTrackedExpenses` route every amount through
  //     `toCents()` so we get integer math and avoid the classic
  //     0.1 + 0.2 = 0.30000000000000004 drift that plain
  //     `reduce((s, t) => s + t.amount, 0)` produces on real decimal data.
  //   - `sumTrackedExpenses` excludes savings-transfer transactions so the
  //     "Total Expenses" figure on the statement matches what the user sees
  //     everywhere else in the app. Prior to ADR-001 §9.5 Step 6, this path
  //     was double-counting savings contributions as expenses AND accumulating
  //     float drift — two bugs hiding in one five-line block.
  const totalIncome = sumByType(sorted, 'income');
  const totalExpenses = sumTrackedExpenses(sorted);
  const net = totalIncome - totalExpenses;

  // Round 7 fix: paginate large transaction sets to prevent memory exhaustion.
  // Limit each page to 500 transactions; build multiple pages with breaks.
  const PAGE_SIZE = 500;
  const pages: string[] = [];
  
  for (let pageIdx = 0; pageIdx < Math.ceil(sorted.length / PAGE_SIZE); pageIdx++) {
    const pageStart = pageIdx * PAGE_SIZE;
    const pageEnd = Math.min(pageStart + PAGE_SIZE, sorted.length);
    const pageTxs = sorted.slice(pageStart, pageEnd);
    
    const rows = pageTxs.map((tx, i) => {
      const cat = getCatInfo(tx.type as TransactionType, tx.category);
      const amountClass = tx.type === 'income' ? 'income' : 'expense';
      const sign = tx.type === 'income' ? '+' : '-';
      return `
      <tr class="${i % 2 === 0 ? 'even' : 'odd'}">
        <td class="date">${esc(formatDate(tx.date))}</td>
        <td class="desc">${esc(tx.description || '—')}</td>
        <td class="cat"><span class="emoji">${esc(cat.emoji)}</span> ${esc(cat.name)}</td>
        <td class="type type-${tx.type}">${tx.type === 'income' ? 'Income' : 'Expense'}</td>
        <td class="amount ${amountClass}">${sign}${formatCurrencyHtml(tx.amount, currencySymbol)}</td>
      </tr>`;
    }).join('');
    
    // Round 7 fix: add page break after each page except the last
    const pageBreak = pageIdx < Math.ceil(sorted.length / PAGE_SIZE) - 1 ? 
      '<div class="page-break" style="page-break-after: always;"></div>' : '';
    pages.push(rows + pageBreak);
  }
  
  const rows = pages.join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Harbor Ledger — Transaction Statement</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    color: #1e293b;
    background: #fff;
    padding: 2rem;
    font-size: 11px;
    line-height: 1.5;
  }

  /* Header */
  .header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    border-bottom: 3px solid #1e293b;
    padding-bottom: 1rem;
    margin-bottom: 1.5rem;
  }
  .header h1 {
    font-size: 1.6rem;
    font-weight: 900;
    letter-spacing: -0.03em;
    color: #0f172a;
  }
  .header .subtitle {
    font-size: 0.85rem;
    color: #64748b;
    margin-top: 0.2rem;
  }
  .header .meta {
    text-align: right;
    font-size: 0.78rem;
    color: #64748b;
  }
  .header .meta strong {
    display: block;
    color: #1e293b;
    font-size: 0.85rem;
  }

  /* Summary Cards */
  .summary {
    display: flex;
    gap: 1rem;
    margin-bottom: 1.5rem;
  }
  .summary-card {
    flex: 1;
    padding: 0.85rem 1rem;
    border-radius: 0.5rem;
    border: 1px solid #e2e8f0;
  }
  .summary-card.income { background: #f0fdf4; border-color: #bbf7d0; }
  .summary-card.expense { background: #fef2f2; border-color: #fecaca; }
  .summary-card.net { background: #f8fafc; border-color: #e2e8f0; }
  .summary-card .label {
    font-size: 0.7rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #64748b;
    margin-bottom: 0.25rem;
  }
  .summary-card .value {
    font-size: 1.25rem;
    font-weight: 800;
  }
  .summary-card.income .value { color: #16a34a; }
  .summary-card.expense .value { color: #dc2626; }
  .summary-card.net .value { color: ${net >= 0 ? '#16a34a' : '#dc2626'}; }

  /* Table */
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.82rem;
  }
  thead th {
    background: #1e293b;
    color: #f8fafc;
    font-size: 0.68rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    padding: 0.55rem 0.65rem;
    text-align: left;
    white-space: nowrap;
  }
  thead th:last-child { text-align: right; }
  tbody td {
    padding: 0.5rem 0.65rem;
    border-bottom: 1px solid #f1f5f9;
    vertical-align: middle;
  }
  tr.odd td { background: #f8fafc; }
  .date { white-space: nowrap; width: 9%; color: #475569; }
  .desc { width: 36%; }
  .cat { width: 22%; color: #475569; white-space: nowrap; }
  .emoji { font-size: 0.9rem; }
  .type { width: 8%; font-weight: 600; font-size: 0.72rem; text-transform: uppercase; }
  .type-income { color: #16a34a; }
  .type-expense { color: #dc2626; }
  .amount { width: 14%; text-align: right; font-weight: 700; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .amount.income { color: #16a34a; }
  .amount.expense { color: #dc2626; }

  /* Footer */
  .footer {
    margin-top: 1.5rem;
    padding-top: 0.75rem;
    border-top: 1px solid #e2e8f0;
    display: flex;
    justify-content: space-between;
    font-size: 0.72rem;
    color: #94a3b8;
  }

  /* Print */
  @media print {
    body { padding: 0; }
    @page { margin: 1.5cm; size: landscape; }
    thead { display: table-header-group; }
    tr { page-break-inside: avoid; }
    .summary-card { break-inside: avoid; }
  }
</style>
</head>
<body>

<div class="header">
  <div>
    <h1>Harbor Ledger</h1>
    <p class="subtitle">Transaction Statement</p>
  </div>
  <div class="meta">
    <strong>${esc(formatDate(range.start))} — ${esc(formatDate(range.end))}</strong>
    ${sorted.length} transaction${sorted.length !== 1 ? 's' : ''}
  </div>
</div>

<div class="summary">
  <div class="summary-card income">
    <div class="label">Total Income</div>
    <div class="value">+${formatCurrencyHtml(totalIncome, currencySymbol)}</div>
  </div>
  <div class="summary-card expense">
    <div class="label">Total Expenses</div>
    <div class="value">-${formatCurrencyHtml(totalExpenses, currencySymbol)}</div>
  </div>
  <div class="summary-card net">
    <div class="label">Net Balance</div>
    <div class="value">${net >= 0 ? '+' : '-'}${formatCurrencyHtml(Math.abs(net), currencySymbol)}</div>
  </div>
</div>

<table>
  <thead>
    <tr>
      <th>Date</th>
      <th>Description</th>
      <th>Category</th>
      <th>Type</th>
      <th style="text-align:right">Amount</th>
    </tr>
  </thead>
  <tbody>
    ${rows || '<tr><td colspan="5" style="text-align:center;padding:2rem;color:#94a3b8;">No transactions to display</td></tr>'}
  </tbody>
</table>

<div class="footer">
  <span>Generated ${esc(formatDate(getTodayStr()))} by Harbor Ledger</span>
  <span>Save as PDF via your browser's print dialog</span>
</div>

</body>
</html>`;
}

// ==========================================
// PUBLIC API
// ==========================================

/**
 * Open a print-ready transaction statement in a new window.
 * The user can then save it as PDF via the browser's print dialog.
 * @param overrideTxs - Optional pre-filtered transaction list. When omitted, exports all transactions.
 */
export function triggerPdfExport(overrideTxs?: Transaction[]): void {
  const txs = overrideTxs ?? [...signals.transactions.value] as Transaction[];
  const currencySymbol = (signals.currency.value as { symbol: string })?.symbol || '$';

  if (!txs.length) {
    // Still generate the statement — it'll show "No transactions"
  }

  const html = buildPdfHtml(txs, currencySymbol);
  const printWindow = window.open('', '_blank');
  if (!printWindow) {
    // Popup blocked — fall back to downloadable HTML
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `harbor-ledger-statement-${getTodayStr()}.html`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    return;
  }

  printWindow.document.write(html);
  printWindow.document.close();

  // Allow rendering to complete, then trigger print
  printWindow.addEventListener('afterprint', () => {
    // Don't auto-close — let the user review
  });
  setTimeout(() => {
    printWindow.print();
  }, 400);
}
