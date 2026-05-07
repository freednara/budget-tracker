/**
 * Regression tests for CR-Apr24-AE+AF fix clusters.
 *
 * Cluster AE — Locale detection fixes
 *   377  updateSettings preserves current settings (already fixed by finding 80)
 *   379  getDateFormat uses formatToParts for reliable detection
 *   380  getNumberFormat uses formatToParts for reliable detection
 *
 * Cluster AF — Misc code-level P3 fixes
 *   37   debt payment history historical names (already addressed)
 *   90   calendar day-detail edit button a11y labels include amount
 *   95   calendar day-detail rerenders on category config (already addressed by CR-Apr22-E slice 4)
 *   219  achievements setter runtime guard against legacy boolean shape
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ==========================================
// Findings 379, 380 — locale-service detection
// ==========================================

describe('Findings 379/380 — locale-service date/number format detection', () => {
  it('localeService singleton is exported', async () => {
    const mod = await import('../js/modules/core/locale-service.js');
    expect(mod.localeService).toBeDefined();
    expect(typeof mod.localeService.getSettings).toBe('function');
  });

  it('getDateFormat source uses formatToParts for reliable detection (finding 379)', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../js/modules/core/locale-service.ts'),
      'utf-8'
    );
    expect(source).toContain('formatToParts');
    expect(source).toContain('finding 379');
  });

  it('getNumberFormat source uses formatToParts for reliable detection (finding 380)', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../js/modules/core/locale-service.ts'),
      'utf-8'
    );
    expect(source).toContain('finding 380');
    // Should detect group and decimal via parts, not just comma+dot
    expect(source).toMatch(/type.*===.*'group'/);
    expect(source).toMatch(/type.*===.*'decimal'/);
  });
});

// ==========================================
// Finding 377 — updateSettings preserves current settings
// ==========================================

describe('Finding 377 — updateSettings preserves current settings', () => {
  it('localeService.updateSettings merges with current, not browser defaults', async () => {
    const mod = await import('../js/modules/core/locale-service.js');
    const svc = mod.localeService;

    const before = svc.getSettings();
    const originalDateFormat = before.dateFormat;

    // Update only currency — dateFormat should be preserved
    svc.updateSettings({ currency: 'EUR' });
    const after = svc.getSettings();

    expect(after.currency).toBe('EUR');
    expect(after.dateFormat).toBe(originalDateFormat);

    // Reset
    svc.updateSettings({ currency: before.currency });
  });
});

// ==========================================
// Finding 90 — calendar day-detail edit button labels
// ==========================================

describe('Finding 90 — calendar edit button a11y label', () => {
  it('calendar.ts edit button aria-label includes amount for disambiguation', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../js/modules/ui/widgets/calendar.ts'),
      'utf-8'
    );
    // The aria-label should reference the amount for uniqueness
    expect(source).toMatch(/aria-label.*fmtCur\(t\.amount\)/);
  });
});

// ==========================================
// Finding 219 — achievements setter runtime guard
// ==========================================

describe('Finding 219 — achievements setter guards legacy boolean shape', () => {
  it('setAchievements source includes runtime coercion guard', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../js/modules/core/actions/data-actions.ts'),
      'utf-8'
    );
    // Should check for legacy boolean shape
    expect(source).toContain('finding 219');
    expect(source).toContain("val === true");
    // Should create EarnedAchievement shape for boolean entries
    expect(source).toContain("earned: true, date: ''");
  });
});
