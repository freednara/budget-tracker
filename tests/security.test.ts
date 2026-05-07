/**
 * Security Tests
 * Tests XSS prevention (esc) and PIN crypto functions.
 *
 * Phase 5g-4 Slice 3 (Inline-Behavior-Review rev 12, L7): the
 * describe('sanitize', ...) block that lived in this file was removed
 * alongside the deletion of the regex-based `sanitize()` in
 * utils-pure.ts. The 11 assertions in that block tested behavior of a
 * function the codebase no longer ships (single production caller
 * `validator.sanitizeText` was also retired in the same slice). XSS
 * defense at the view boundary is now owned by lit-html's render-time
 * auto-escaping of interpolated values; `esc()` remains for the narrow
 * cases that build strings outside a template tag.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../js/modules/core/config.js', async () => {
  const actual = await vi.importActual<typeof import('../js/modules/core/config.js')>('../js/modules/core/config.js');
  return {
    ...actual,
    CONFIG: {
      ...actual.CONFIG,
      SECURITY: {
        ...actual.CONFIG.SECURITY,
        PBKDF2_ITERATIONS: 1000
      }
    }
  };
});

import { esc } from '../js/modules/core/utils-pure.js';
import {
  generateRecoveryPhrase,
  validateRecoveryPhrase,
  hashPin,
  verifyPin,
  hasRecoveryEnabled,
  createPinWithRecovery
} from '../js/modules/features/security/pin-crypto.js';

// ==========================================
// XSS PREVENTION
// ==========================================

describe('esc (HTML escaping)', () => {
  it('should escape angle brackets', () => {
    expect(esc('<script>alert(1)</script>')).not.toContain('<');
    expect(esc('<script>alert(1)</script>')).not.toContain('>');
  });

  it('should escape quotes', () => {
    expect(esc('" onmouseover="alert(1)"')).not.toContain('"');
    expect(esc("' onclick='alert(1)'")).not.toContain("'");
  });

  it('should escape ampersands', () => {
    expect(esc('a&b')).toBe('a&amp;b');
  });

  it('should escape backticks', () => {
    expect(esc('`${evil}`')).not.toContain('`');
  });

  it('should return empty string for falsy input', () => {
    expect(esc('')).toBe('');
    expect(esc(null as any)).toBe('');
    expect(esc(undefined as any)).toBe('');
  });

  it('should preserve normal text', () => {
    const text = 'Hello, this is a normal description with 100 items';
    expect(esc(text)).toBe(text);
  });
});

// Phase 5g-4 Slice 3 (Inline-Behavior-Review rev 12, L7): the
// describe('sanitize (HTML tag stripping)', ...) block that lived here
// was deleted alongside the regex-based `sanitize()` function in
// utils-pure.ts. The 11 assertions all tested behavior of a function
// the codebase no longer ships. See file-header comment for full
// rationale; the short version is that lit-html's render-time
// auto-escaping owns the view-boundary XSS defense, and the regex
// sanitizer's documented limits (DOM clobbering, mutation XSS,
// namespace tricks) made it a misleading "safe facade" rather than a
// genuine defense layer worth maintaining.

// ==========================================
// PIN CRYPTO
// ==========================================

describe('Recovery Phrase', () => {
  it('should generate a 12-word phrase', () => {
    const phrase = generateRecoveryPhrase();
    const words = phrase.split(' ');
    expect(words).toHaveLength(12);
  });

  it('should generate different phrases each time', () => {
    const p1 = generateRecoveryPhrase();
    const p2 = generateRecoveryPhrase();
    expect(p1).not.toBe(p2);
  });

  it('should validate a correctly generated phrase', () => {
    const phrase = generateRecoveryPhrase();
    expect(validateRecoveryPhrase(phrase)).toBe(true);
  });

  it('should reject phrase with wrong word count', () => {
    expect(validateRecoveryPhrase('one two three')).toBe(false);
  });

  it('should reject empty phrase', () => {
    expect(validateRecoveryPhrase('')).toBe(false);
  });
});

describe('PIN Hashing and Verification', () => {
  it('should hash and verify a PIN successfully', async () => {
    const pin = '1234';
    const hash = await hashPin(pin);

    expect(hash).toBeTruthy();
    expect(hash).not.toBe(pin); // Should not be plaintext
    expect(await verifyPin(pin, hash)).toBe(true);
  });

  it('should reject wrong PIN', async () => {
    const hash = await hashPin('1234');
    expect(await verifyPin('5678', hash)).toBe(false);
  });

  it('should detect recovery-enabled format', async () => {
    const result = await createPinWithRecovery('9876');

    expect(result.bundle).toBeTruthy();
    expect(result.recoveryPhrase).toBeTruthy();
    expect(hasRecoveryEnabled(result.bundle)).toBe(true);
  });

  it('should verify PIN in recovery-enabled format', async () => {
    const result = await createPinWithRecovery('4321');

    expect(await verifyPin('4321', result.bundle)).toBe(true);
    expect(await verifyPin('0000', result.bundle)).toBe(false);
  });

  it('should handle plain PBKDF2 format (salt:hash)', async () => {
    const hash = await hashPin('5555');
    // hashPin returns PBKDF2 format (contains colon)
    expect(hash).toContain(':');
    expect(await verifyPin('5555', hash)).toBe(true);
  });
});
