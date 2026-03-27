/**
 * Security Tests
 * Tests XSS prevention (esc/sanitize) and PIN crypto functions
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

import { esc, sanitize } from '../js/modules/core/utils-pure.js';
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

describe('sanitize (HTML tag stripping)', () => {
  it('should remove script tags and content', () => {
    expect(sanitize('<script>alert(1)</script>')).not.toContain('script');
    expect(sanitize('<script>alert(1)</script>')).not.toContain('alert');
  });

  it('should remove event handlers (quoted)', () => {
    expect(sanitize('<div onmouseover="alert(1)">test</div>')).not.toContain('onmouseover');
  });

  it('should remove event handlers (unquoted)', () => {
    expect(sanitize('<div onmouseover=alert(1)>test</div>')).not.toContain('onmouseover');
  });

  it('should remove nested tag tricks', () => {
    // <scr<script>ipt> after inner removal should NOT leave <script>
    const result = sanitize('<scr<script>ipt>alert(1)</scr<script>ipt>');
    expect(result).not.toContain('<script');
  });

  it('should remove SVG tags', () => {
    expect(sanitize('<svg onload=alert(1)>test</svg>')).not.toContain('svg');
  });

  it('should remove style attributes', () => {
    expect(sanitize('<div style="background:url(javascript:alert(1))">test</div>')).not.toContain('style');
  });

  it('should remove javascript: protocol in href', () => {
    const result = sanitize('<a href="javascript:alert(1)">click</a>');
    expect(result).not.toContain('javascript:');
  });

  it('should remove data: protocol in src', () => {
    const result = sanitize('<img src="data:text/html,<script>alert(1)</script>">');
    expect(result).not.toContain('data:');
  });

  it('should remove iframe tags', () => {
    expect(sanitize('<iframe src="evil.com"></iframe>')).not.toContain('iframe');
  });

  it('should preserve safe HTML', () => {
    expect(sanitize('<b>bold</b> <em>italic</em>')).toContain('<b>bold</b>');
    expect(sanitize('<b>bold</b> <em>italic</em>')).toContain('<em>italic</em>');
  });

  it('should return empty string for falsy input', () => {
    expect(sanitize('')).toBe('');
    expect(sanitize(null as any)).toBe('');
  });
});

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
