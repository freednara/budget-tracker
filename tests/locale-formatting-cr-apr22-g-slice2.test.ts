import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * CR-Apr22-G slice 2 coverage — Locale-aware formatting.
 *
 * Six production sites previously bypassed the canonical locale service:
 *   1. `calendar.ts` — local `fmtShort` duplicate (deleted; delegates to utils-pure)
 *   2. `daily-allowance.ts` — `toLocaleDateString(undefined, { month: 'long', year })`
 *   3. `transaction-renderer.ts` delete modal — `toLocaleDateString(undefined, …)`
 *   4. `transaction-detail-panel.ts` — `toLocaleDateString(undefined, …)`
 *   5. `category-detail-panel.ts` — `toLocaleDateString(undefined, { month: 'short', day })`
 *   6. `debt-list.ts` APR label — `(rate * 100).toFixed(2)`
 *
 * All six now route through `locale-service`. Two new helpers were added:
 *   - `formatDateWithYear(date, monthStyle)` unifies the "year + month + day"
 *     shape in both 'short' and 'long' month variants.
 *   - `formatRate(value, decimals)` emits a decimal-formatted number bound to
 *     the user's locale so APR-style labels get the right separator.
 *
 * These tests exercise each helper across locales (en-US, de-DE, ja-JP) and
 * validate that `formatDateShort` respects user preference too — previously
 * it was correct, but the CR-Apr22-G audit surfaced one caller
 * (`category-detail-panel`) that had diverged from it. The test locks in the
 * contract against future regression.
 */

type GlobalWithBC = typeof globalThis & { BroadcastChannel?: typeof BroadcastChannel };

class MockBroadcastChannel {
  static instances: MockBroadcastChannel[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  messages: unknown[] = [];
  name: string;
  constructor(name: string) {
    this.name = name;
    MockBroadcastChannel.instances.push(this);
  }
  postMessage(data: unknown): void {
    this.messages.push(data);
  }
  close(): void {
    MockBroadcastChannel.instances = MockBroadcastChannel.instances.filter((c) => c !== this);
  }
  static reset(): void {
    MockBroadcastChannel.instances = [];
  }
}

async function importFreshLocaleService(): Promise<
  typeof import('../js/modules/core/locale-service.js')
> {
  vi.resetModules();
  return await import('../js/modules/core/locale-service.js');
}

describe('locale-service — formatDateWithYear (CR-Apr22-G slice 2)', () => {
  let originalBC: typeof BroadcastChannel | undefined;

  beforeEach(() => {
    originalBC = (globalThis as GlobalWithBC).BroadcastChannel;
    MockBroadcastChannel.reset();
    try {
      localStorage.clear();
    } catch {
      /* ignore */
    }
    (globalThis as GlobalWithBC).BroadcastChannel =
      MockBroadcastChannel as unknown as typeof BroadcastChannel;
  });

  afterEach(() => {
    MockBroadcastChannel.reset();
    (globalThis as unknown as {
      BroadcastChannel: typeof BroadcastChannel | undefined;
    }).BroadcastChannel = originalBC;
    try {
      localStorage.clear();
    } catch {
      /* ignore */
    }
  });

  it('respects the configured locale for "short" month style (en-US → "Jan 15, 2026")', async () => {
    const mod = await importFreshLocaleService();
    mod.localeService.updateSettings({
      locale: 'en-US',
      currency: 'USD',
      dateFormat: 'MM/DD/YYYY',
      numberFormat: 'en-US',
      firstDayOfWeek: 0,
      decimalSeparator: '.',
      thousandsSeparator: ',',
      currencyPosition: 'before'
    });

    const out = mod.formatDateWithYear('2026-01-15', 'short');

    // en-US short form: "Jan 15, 2026"
    expect(out).toContain('Jan');
    expect(out).toContain('15');
    expect(out).toContain('2026');
    // Month must not be spelled out (proves 'short' style is honored).
    expect(out).not.toContain('January');
  });

  it('respects the configured locale for "long" month style (en-US → "January 15, 2026")', async () => {
    const mod = await importFreshLocaleService();
    mod.localeService.updateSettings({
      locale: 'en-US',
      currency: 'USD',
      dateFormat: 'MM/DD/YYYY',
      numberFormat: 'en-US',
      firstDayOfWeek: 0,
      decimalSeparator: '.',
      thousandsSeparator: ',',
      currencyPosition: 'before'
    });

    const out = mod.formatDateWithYear('2026-01-15', 'long');
    expect(out).toContain('January');
    expect(out).toContain('15');
    expect(out).toContain('2026');
  });

  it('switches month/day order under de-DE (day-first locale)', async () => {
    const mod = await importFreshLocaleService();
    mod.localeService.updateSettings({
      locale: 'de-DE',
      currency: 'EUR',
      dateFormat: 'DD.MM.YYYY',
      numberFormat: 'de-DE',
      firstDayOfWeek: 1,
      decimalSeparator: ',',
      thousandsSeparator: '.',
      currencyPosition: 'after'
    });

    const out = mod.formatDateWithYear('2026-01-15', 'long');
    // de-DE long form: "15. Januar 2026"
    expect(out).toContain('Januar');
    expect(out).toContain('15');
    expect(out).toContain('2026');
    // Day precedes month — "15" must appear before "Januar".
    expect(out.indexOf('15')).toBeLessThan(out.indexOf('Januar'));
  });

  it('produces the ja-JP year-first calendar ordering', async () => {
    const mod = await importFreshLocaleService();
    mod.localeService.updateSettings({
      locale: 'ja-JP',
      currency: 'JPY',
      dateFormat: 'YYYY/MM/DD',
      numberFormat: 'ja-JP',
      firstDayOfWeek: 0,
      decimalSeparator: '.',
      thousandsSeparator: ',',
      currencyPosition: 'before'
    });

    const out = mod.formatDateWithYear('2026-01-15', 'short');
    expect(out).toContain('2026');
    expect(out).toContain('15');
    // Year leads the label in ja-JP.
    expect(out.indexOf('2026')).toBeLessThan(out.indexOf('15'));
  });

  it('parses string input via parseLocalDate (H16 contract — no negative-TZ drift)', async () => {
    const mod = await importFreshLocaleService();
    mod.localeService.updateSettings({
      locale: 'en-US',
      currency: 'USD',
      dateFormat: 'MM/DD/YYYY',
      numberFormat: 'en-US',
      firstDayOfWeek: 0,
      decimalSeparator: '.',
      thousandsSeparator: ',',
      currencyPosition: 'before'
    });

    // `new Date('2026-01-15')` alone parses as midnight UTC — under a
    // negative-TZ runner (e.g. America/Los_Angeles) that shifts to
    // "Jan 14". parseLocalDate treats YYYY-MM-DD as wall-clock local,
    // so the day value must match regardless of the host timezone.
    const out = mod.formatDateWithYear('2026-01-15', 'short');
    expect(out).toContain('15');
    expect(out).not.toContain('14');
  });
});

describe('locale-service — formatRate (CR-Apr22-G slice 2)', () => {
  let originalBC: typeof BroadcastChannel | undefined;

  beforeEach(() => {
    originalBC = (globalThis as GlobalWithBC).BroadcastChannel;
    MockBroadcastChannel.reset();
    try {
      localStorage.clear();
    } catch {
      /* ignore */
    }
    (globalThis as GlobalWithBC).BroadcastChannel =
      MockBroadcastChannel as unknown as typeof BroadcastChannel;
  });

  afterEach(() => {
    MockBroadcastChannel.reset();
    (globalThis as unknown as {
      BroadcastChannel: typeof BroadcastChannel | undefined;
    }).BroadcastChannel = originalBC;
    try {
      localStorage.clear();
    } catch {
      /* ignore */
    }
  });

  it('uses a dot decimal separator under en-US', async () => {
    const mod = await importFreshLocaleService();
    mod.localeService.updateSettings({
      locale: 'en-US',
      currency: 'USD',
      dateFormat: 'MM/DD/YYYY',
      numberFormat: 'en-US',
      firstDayOfWeek: 0,
      decimalSeparator: '.',
      thousandsSeparator: ',',
      currencyPosition: 'before'
    });

    expect(mod.formatRate(15)).toBe('15.00');
    expect(mod.formatRate(0)).toBe('0.00');
    expect(mod.formatRate(24.749)).toBe('24.75');
  });

  it('uses a comma decimal separator under de-DE (primary motivation for the helper)', async () => {
    const mod = await importFreshLocaleService();
    mod.localeService.updateSettings({
      locale: 'de-DE',
      currency: 'EUR',
      dateFormat: 'DD.MM.YYYY',
      numberFormat: 'de-DE',
      firstDayOfWeek: 1,
      decimalSeparator: ',',
      thousandsSeparator: '.',
      currencyPosition: 'after'
    });

    // The debt-list APR label was `"${(rate * 100).toFixed(2)}% APR"`,
    // which always rendered "15.00%" regardless of locale. Under de-DE
    // the user expects comma-decimal separation.
    expect(mod.formatRate(15)).toBe('15,00');
    expect(mod.formatRate(24.749)).toBe('24,75');
  });

  it('honors a custom decimals count (e.g. 1 decimal for whole-percent labels)', async () => {
    const mod = await importFreshLocaleService();
    mod.localeService.updateSettings({
      locale: 'en-US',
      currency: 'USD',
      dateFormat: 'MM/DD/YYYY',
      numberFormat: 'en-US',
      firstDayOfWeek: 0,
      decimalSeparator: '.',
      thousandsSeparator: ',',
      currencyPosition: 'before'
    });

    expect(mod.formatRate(15, 1)).toBe('15.0');
    expect(mod.formatRate(15, 0)).toBe('15');
    expect(mod.formatRate(15.45, 0)).toBe('15');
  });
});

describe('locale-service — formatDateShort under non-default locales (CR-Apr22-G slice 2)', () => {
  let originalBC: typeof BroadcastChannel | undefined;

  beforeEach(() => {
    originalBC = (globalThis as GlobalWithBC).BroadcastChannel;
    MockBroadcastChannel.reset();
    try {
      localStorage.clear();
    } catch {
      /* ignore */
    }
    (globalThis as GlobalWithBC).BroadcastChannel =
      MockBroadcastChannel as unknown as typeof BroadcastChannel;
  });

  afterEach(() => {
    MockBroadcastChannel.reset();
    (globalThis as unknown as {
      BroadcastChannel: typeof BroadcastChannel | undefined;
    }).BroadcastChannel = originalBC;
    try {
      localStorage.clear();
    } catch {
      /* ignore */
    }
  });

  it('returns a localized month/day string under de-DE (category-detail-panel fix site)', async () => {
    const mod = await importFreshLocaleService();
    mod.localeService.updateSettings({
      locale: 'de-DE',
      currency: 'EUR',
      dateFormat: 'DD.MM.YYYY',
      numberFormat: 'de-DE',
      firstDayOfWeek: 1,
      decimalSeparator: ',',
      thousandsSeparator: '.',
      currencyPosition: 'after'
    });

    // category-detail-panel replaced `d.toLocaleDateString(undefined, { month: 'short', day })`
    // with `formatDateShort(tx.date)`. Day must precede month under de-DE.
    const out = mod.formatDateShort('2026-01-15');
    expect(out).toContain('15');
    // de-DE short month is "Jan." — substring check is resilient to the period.
    expect(out).toContain('Jan');
    expect(out.indexOf('15')).toBeLessThan(out.indexOf('Jan'));
  });

  it('returns a year-less label (the "short" shape)', async () => {
    const mod = await importFreshLocaleService();
    mod.localeService.updateSettings({
      locale: 'en-US',
      currency: 'USD',
      dateFormat: 'MM/DD/YYYY',
      numberFormat: 'en-US',
      firstDayOfWeek: 0,
      decimalSeparator: '.',
      thousandsSeparator: ',',
      currencyPosition: 'before'
    });

    const out = mod.formatDateShort('2026-01-15');
    expect(out).toContain('Jan');
    expect(out).toContain('15');
    // formatDateShort must NOT include the year (that's what
    // formatDateWithYear is for). Guards against silent contract drift.
    expect(out).not.toContain('2026');
  });
});
