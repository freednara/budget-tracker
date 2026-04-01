import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface StorageStub {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
  dump: () => Record<string, string>;
}

function createStorageStub(options: { throwOnSet?: boolean; throwOnGet?: boolean; throwOnRemove?: boolean } = {}): StorageStub {
  const store = new Map<string, string>();

  return {
    getItem(key: string): string | null {
      if (options.throwOnGet) throw new Error('get blocked');
      return store.get(key) ?? null;
    },
    setItem(key: string, value: string): void {
      if (options.throwOnSet) throw new Error('set blocked');
      store.set(key, value);
    },
    removeItem(key: string): void {
      if (options.throwOnRemove) throw new Error('remove blocked');
      store.delete(key);
    },
    dump(): Record<string, string> {
      return Object.fromEntries(store.entries());
    }
  };
}

describe('rate limiter persistence', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('falls back to sessionStorage when localStorage writes fail', async () => {
    const localStorageStub = createStorageStub({ throwOnSet: true });
    const sessionStorageStub = createStorageStub();

    vi.stubGlobal('localStorage', localStorageStub);
    vi.stubGlobal('sessionStorage', sessionStorageStub);

    const { checkRateLimit, recordAttempt } = await import('../js/modules/features/security/rate-limiter.js');

    const before = checkRateLimit();
    recordAttempt(false);
    const after = checkRateLimit();

    expect(after.attemptsRemaining).toBe(before.attemptsRemaining - 1);
    expect(sessionStorageStub.dump()).toHaveProperty('_pin_rate_limit_session');
  });

  it('keeps lockout state in memory when both storage backends are unavailable', async () => {
    vi.stubGlobal('localStorage', createStorageStub({ throwOnSet: true, throwOnGet: true, throwOnRemove: true }));
    vi.stubGlobal('sessionStorage', createStorageStub({ throwOnSet: true, throwOnGet: true, throwOnRemove: true }));

    const { checkRateLimit, recordAttempt, resetRateLimit } = await import('../js/modules/features/security/rate-limiter.js');

    const before = checkRateLimit();
    recordAttempt(false);
    const after = checkRateLimit();
    resetRateLimit();
    const reset = checkRateLimit();

    expect(after.attemptsRemaining).toBe(before.attemptsRemaining - 1);
    expect(reset.attemptsRemaining).toBe(before.attemptsRemaining);
  });
});
