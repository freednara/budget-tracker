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

// ==========================================================================
// M27: pin_recovery_phrase namespace — defense-in-depth throttle for the
// PIN-reset-via-recovery-phrase path. The critical invariants tested here are:
//   (1) namespaces isolate both counters and storage keys, so a brute-force
//       campaign against one path does not lock the other;
//   (2) resetting one namespace does not touch the other;
//   (3) the 'pin' default namespace preserves its pre-namespace storage keys
//       so upgraded installs keep their persisted lockout state.
// ==========================================================================
describe('rate limiter namespace isolation (M27)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('isolates attempt counters across namespaces', async () => {
    vi.stubGlobal('localStorage', createStorageStub());
    vi.stubGlobal('sessionStorage', createStorageStub());

    const { checkRateLimit, recordAttempt } = await import('../js/modules/features/security/rate-limiter.js');

    // Fail 3 PIN attempts
    recordAttempt(false);
    recordAttempt(false);
    recordAttempt(false);

    // PIN counter reflects the 3 failures
    expect(checkRateLimit().attemptsRemaining).toBe(2);
    // Recovery counter is untouched — the whole point of namespace isolation
    expect(checkRateLimit('pin_recovery_phrase').attemptsRemaining).toBe(5);
  });

  it('locks out pin_recovery_phrase without blocking the pin namespace', async () => {
    vi.stubGlobal('localStorage', createStorageStub());
    vi.stubGlobal('sessionStorage', createStorageStub());

    const { checkRateLimit, recordAttempt } = await import('../js/modules/features/security/rate-limiter.js');

    // Exhaust the recovery counter
    for (let i = 0; i < 5; i++) recordAttempt(false, 'pin_recovery_phrase');

    const recovery = checkRateLimit('pin_recovery_phrase');
    expect(recovery.allowed).toBe(false);
    expect(recovery.waitMs).toBeGreaterThan(0);
    expect(recovery.attemptsRemaining).toBe(0);

    // Critical inverse: exhausting recovery must NOT block the legitimate
    // owner from entering their PIN. This is the security-vs-usability
    // boundary the namespace split exists to hold.
    const pin = checkRateLimit();
    expect(pin.allowed).toBe(true);
    expect(pin.attemptsRemaining).toBe(5);
  });

  it('locks out the pin namespace without blocking pin_recovery_phrase', async () => {
    vi.stubGlobal('localStorage', createStorageStub());
    vi.stubGlobal('sessionStorage', createStorageStub());

    const { checkRateLimit, recordAttempt } = await import('../js/modules/features/security/rate-limiter.js');

    // Exhaust the PIN counter
    for (let i = 0; i < 5; i++) recordAttempt(false);

    const pin = checkRateLimit();
    expect(pin.allowed).toBe(false);
    expect(pin.waitMs).toBeGreaterThan(0);

    // Critical inverse: a user who forgot their PIN and triggered the PIN
    // lockout must still be able to enter their recovery phrase. This is
    // the entire point of the recovery path existing.
    const recovery = checkRateLimit('pin_recovery_phrase');
    expect(recovery.allowed).toBe(true);
    expect(recovery.attemptsRemaining).toBe(5);
  });

  it('persists each namespace under a distinct localStorage key', async () => {
    const localStorageStub = createStorageStub();
    vi.stubGlobal('localStorage', localStorageStub);
    vi.stubGlobal('sessionStorage', createStorageStub());

    const { recordAttempt } = await import('../js/modules/features/security/rate-limiter.js');

    recordAttempt(false); // default 'pin'
    recordAttempt(false, 'pin_recovery_phrase');

    const dump = localStorageStub.dump();
    // 'pin' preserves the pre-namespace key so upgraded installs keep state
    expect(dump).toHaveProperty('_pin_rate_limit');
    // Namespaced keys use a distinct prefix so they cannot collide
    expect(dump).toHaveProperty('_rate_limit:pin_recovery_phrase');
  });

  it('resetRateLimit is scoped to its namespace', async () => {
    vi.stubGlobal('localStorage', createStorageStub());
    vi.stubGlobal('sessionStorage', createStorageStub());

    const { checkRateLimit, recordAttempt, resetRateLimit } = await import('../js/modules/features/security/rate-limiter.js');

    // Burn attempts in both namespaces
    recordAttempt(false);
    recordAttempt(false);
    recordAttempt(false, 'pin_recovery_phrase');

    // Reset only recovery
    resetRateLimit('pin_recovery_phrase');

    // PIN counter preserved (still at 2 remaining after 2 failures above)
    expect(checkRateLimit().attemptsRemaining).toBe(3);
    // Recovery counter cleared to full budget
    expect(checkRateLimit('pin_recovery_phrase').attemptsRemaining).toBe(5);
  });
});

