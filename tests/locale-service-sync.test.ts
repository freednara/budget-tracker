import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Phase 5g-8 Slice 8 coverage:
 *   - M14 (Inline-Behavior-Review rev 12): locale-service cross-tab sync via
 *     BroadcastChannel('locale_sync'). Channel name uses the same
 *     un-prefixed convention as `pin_rate_limit_sync` and `auto_lock_sync` —
 *     it's a transient message channel, not a storage key, so it stays out
 *     of the `harbor_` storage-registry contract.
 *       * outbound: `updateSettings` broadcasts `{ type: 'settings-changed' }`.
 *       * inbound: sibling tab message triggers reload from storage + formatter
 *         rebuild, WITHOUT echoing back (inboundBroadcastActive guard).
 *       * payload validation: malformed or off-type messages are dropped.
 *       * graceful degradation: no throw when BroadcastChannel is undefined.
 *   - M15 (Inline-Behavior-Review rev 12): `parseNumber` returns NaN for
 *     unparseable input (no `|| 0` mask) and escapes regex metacharacters
 *     in `thousandsSeparator` before building the dynamic replace regex.
 */

type GlobalWithBC = typeof globalThis & { BroadcastChannel?: typeof BroadcastChannel };

// ==========================================
// Minimal BroadcastChannel mock (mirrors auto-lock.test.ts / multi-tab-sync-broadcast.test.ts)
// ==========================================

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

  static get channelByName(): (name: string) => MockBroadcastChannel | undefined {
    return (name: string) => MockBroadcastChannel.instances.find((c) => c.name === name);
  }
}

const LOCALE_CHANNEL = 'locale_sync';

async function importFreshLocaleService(): Promise<
  typeof import('../js/modules/core/locale-service.js')
> {
  vi.resetModules();
  // Fresh import so the module-level `new LocaleService()` re-runs with the
  // current globalThis.BroadcastChannel (mocked or undefined).
  return await import('../js/modules/core/locale-service.js');
}

function installMockBroadcastChannel(): void {
  (globalThis as GlobalWithBC).BroadcastChannel =
    MockBroadcastChannel as unknown as typeof BroadcastChannel;
}

describe('locale-service — cross-tab sync (M14)', () => {
  let originalBroadcastChannel: typeof BroadcastChannel | undefined;

  beforeEach(() => {
    originalBroadcastChannel = (globalThis as GlobalWithBC).BroadcastChannel;
    MockBroadcastChannel.reset();
    // Clear any persisted locale state that prior tests may have left behind.
    try {
      localStorage.clear();
    } catch {
      /* ignore */
    }
    installMockBroadcastChannel();
  });

  afterEach(() => {
    MockBroadcastChannel.reset();
    // Phase 6 Slice 1j (rev 12 L6): narrower cast with explicit
    // `| undefined` for `exactOptionalPropertyTypes`.
    (globalThis as unknown as { BroadcastChannel: typeof BroadcastChannel | undefined }).BroadcastChannel =
      originalBroadcastChannel;
    try {
      localStorage.clear();
    } catch {
      /* ignore */
    }
  });

  it('opens a "harbor_locale_sync" BroadcastChannel on singleton creation', async () => {
    await importFreshLocaleService();
    const channel = MockBroadcastChannel.channelByName(LOCALE_CHANNEL);
    expect(channel).toBeDefined();
  });

  it('broadcasts { type: "settings-changed" } when updateSettings is called', async () => {
    const mod = await importFreshLocaleService();
    const channel = MockBroadcastChannel.channelByName(LOCALE_CHANNEL);
    expect(channel).toBeDefined();
    channel!.messages.length = 0;

    mod.localeService.updateSettings({ currency: 'EUR' });

    expect(channel!.messages).toContainEqual({ type: 'settings-changed' });
  });

  it('reloads from storage and rebuilds formatters on inbound settings-changed', async () => {
    const mod = await importFreshLocaleService();
    const channel = MockBroadcastChannel.channelByName(LOCALE_CHANNEL);
    expect(channel).toBeDefined();

    // Simulate a sibling tab that wrote new settings directly to storage
    // and then broadcast. We write to localStorage via the production key,
    // then fire the inbound message and verify the singleton picked it up.
    const nextSettings = {
      locale: 'de-DE',
      currency: 'EUR',
      dateFormat: 'DD.MM.YYYY',
      numberFormat: 'de-DE',
      firstDayOfWeek: 1,
      decimalSeparator: ',',
      thousandsSeparator: '.',
      currencyPosition: 'after' as const
    };
    localStorage.setItem('harbor_locale_settings', JSON.stringify(nextSettings));

    channel!.onmessage?.({ data: { type: 'settings-changed' } } as MessageEvent);

    expect(mod.localeService.getCurrency()).toBe('EUR');
    expect(mod.localeService.getLocale()).toBe('de-DE');
  });

  it('does NOT re-broadcast when applying an inbound settings-changed (echo-loop guard)', async () => {
    const mod = await importFreshLocaleService();
    const channel = MockBroadcastChannel.channelByName(LOCALE_CHANNEL);
    expect(channel).toBeDefined();

    // Seed storage so reloadFromStorage has something to consume.
    const nextSettings = {
      locale: 'fr-FR',
      currency: 'EUR',
      dateFormat: 'DD/MM/YYYY',
      numberFormat: 'fr-FR',
      firstDayOfWeek: 1,
      decimalSeparator: ',',
      thousandsSeparator: ' ',
      currencyPosition: 'after' as const
    };
    localStorage.setItem('harbor_locale_settings', JSON.stringify(nextSettings));
    channel!.messages.length = 0;

    channel!.onmessage?.({ data: { type: 'settings-changed' } } as MessageEvent);

    // The handler must not post anything back on the channel — otherwise
    // tabs pingpong forever after the first settings change.
    expect(channel!.messages).toHaveLength(0);
    // Sanity: the inbound was actually applied, not silently dropped.
    expect(mod.localeService.getLocale()).toBe('fr-FR');
  });

  it('drops malformed inbound payloads (null, non-object, wrong type)', async () => {
    const mod = await importFreshLocaleService();
    const channel = MockBroadcastChannel.channelByName(LOCALE_CHANNEL);
    expect(channel).toBeDefined();

    const localeBefore = mod.localeService.getLocale();

    // Seed an alternate state in storage; if any of these payloads slipped
    // past the validator, reloadFromStorage would pick it up and localeBefore
    // would change.
    const hijack = {
      locale: 'ja-JP',
      currency: 'JPY',
      dateFormat: 'YYYY/MM/DD',
      numberFormat: 'ja-JP',
      firstDayOfWeek: 0,
      decimalSeparator: '.',
      thousandsSeparator: ',',
      currencyPosition: 'before' as const
    };
    localStorage.setItem('harbor_locale_settings', JSON.stringify(hijack));

    channel!.onmessage?.({ data: null } as MessageEvent);
    channel!.onmessage?.({ data: 'settings-changed' } as MessageEvent);
    channel!.onmessage?.({ data: { type: 42 } } as MessageEvent);
    channel!.onmessage?.({ data: { type: 'lock' } } as MessageEvent);
    channel!.onmessage?.({ data: { type: '__proto__' } } as MessageEvent);
    channel!.onmessage?.({ data: undefined } as MessageEvent);

    expect(mod.localeService.getLocale()).toBe(localeBefore);
  });

  it('does not throw when BroadcastChannel is undefined (graceful degradation)', async () => {
    // Remove the mock before importing — exercises the `typeof BroadcastChannel !== 'undefined'` branch.
    // Cast through `unknown` so strict-mode `delete` accepts the non-optional lib prop.
    delete (globalThis as unknown as { BroadcastChannel?: typeof BroadcastChannel }).BroadcastChannel;

    await expect(importFreshLocaleService()).resolves.toBeDefined();

    const mod = await import('../js/modules/core/locale-service.js');

    // updateSettings must not throw in environments without BroadcastChannel;
    // the outbound side is a silent no-op.
    expect(() => mod.localeService.updateSettings({ currency: 'EUR' })).not.toThrow();
    expect(mod.localeService.getCurrency()).toBe('EUR');
  });
});

describe('locale-service — parseNumber contract (M15)', () => {
  let originalBroadcastChannel: typeof BroadcastChannel | undefined;

  beforeEach(() => {
    originalBroadcastChannel = (globalThis as GlobalWithBC).BroadcastChannel;
    MockBroadcastChannel.reset();
    try {
      localStorage.clear();
    } catch {
      /* ignore */
    }
    installMockBroadcastChannel();
  });

  afterEach(() => {
    MockBroadcastChannel.reset();
    // Phase 6 Slice 1j (rev 12 L6): narrower cast with explicit
    // `| undefined` for `exactOptionalPropertyTypes`.
    (globalThis as unknown as { BroadcastChannel: typeof BroadcastChannel | undefined }).BroadcastChannel =
      originalBroadcastChannel;
    try {
      localStorage.clear();
    } catch {
      /* ignore */
    }
  });

  it('returns a finite number for parseable localized input', async () => {
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

    expect(mod.parseNumber('1,234.56')).toBeCloseTo(1234.56);
    expect(mod.parseNumber('$1,234.56')).toBeCloseTo(1234.56);
    expect(mod.parseNumber('0.99')).toBeCloseTo(0.99);
    expect(mod.parseNumber('-42')).toBe(-42);
  });

  it('returns NaN for empty, whitespace, or non-numeric input (no `|| 0` mask)', async () => {
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

    expect(mod.parseNumber('')).toBeNaN();
    expect(mod.parseNumber('   ')).toBeNaN();
    expect(mod.parseNumber('abc')).toBeNaN();
    expect(mod.parseNumber('$')).toBeNaN();
  });

  it('escapes regex metacharacters in thousandsSeparator ("." for de-DE)', async () => {
    // German locale: decimal = ',' and thousands = '.'. The thousands
    // separator is a regex metacharacter — without escapeRegExp the dynamic
    // replace regex would eat every char. With escapeRegExp, only literal
    // dots are stripped.
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

    // 1.234,56 in de-DE == 1234.56 canonical.
    expect(mod.parseNumber('1.234,56')).toBeCloseTo(1234.56);
    // Pure integer with thousands grouping.
    expect(mod.parseNumber('12.345')).toBeCloseTo(12345);
    // Negative with grouping.
    expect(mod.parseNumber('-1.234,50')).toBeCloseTo(-1234.5);
  });

  it('parseCurrency delegates to parseNumber and inherits the NaN contract', async () => {
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

    expect(mod.parseCurrency('$99.99')).toBeCloseTo(99.99);
    expect(mod.parseCurrency('')).toBeNaN();
    expect(mod.parseCurrency('not a number')).toBeNaN();
  });
});
