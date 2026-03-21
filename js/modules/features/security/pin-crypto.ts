/**
 * PIN Crypto Module - Secure PIN storage with recovery phrase
 *
 * Uses Web Crypto API for:
 * - PBKDF2 key derivation from recovery phrase
 * - AES-GCM encryption of PIN hash
 * - Secure random recovery phrase generation
 */
'use strict';

import type { EncryptedBundle, PinBundle, PinCreationResult } from '../../../types/index.js';
import { CONFIG } from '../../core/config.js';

// ==========================================
// WORD LIST
// ==========================================

// BIP39-inspired word list (simplified subset of 256 common words)
const WORD_LIST: readonly string[] = [
  'apple', 'arrow', 'beach', 'bird', 'blue', 'boat', 'book', 'bread',
  'bridge', 'bright', 'brown', 'build', 'calm', 'card', 'chair', 'chest',
  'child', 'city', 'clean', 'clear', 'clock', 'cloud', 'coast', 'cold',
  'color', 'cool', 'corn', 'cream', 'cross', 'crown', 'dance', 'dark',
  'dawn', 'desk', 'door', 'down', 'dream', 'drive', 'drop', 'drum',
  'dust', 'earth', 'east', 'edge', 'empty', 'face', 'fall', 'farm',
  'fast', 'field', 'fire', 'fish', 'flame', 'flash', 'floor', 'flow',
  'flower', 'fold', 'food', 'foot', 'force', 'forest', 'form', 'fort',
  'frame', 'fresh', 'front', 'fruit', 'game', 'garden', 'gate', 'gift',
  'glass', 'glow', 'gold', 'good', 'grain', 'grape', 'grass', 'green',
  'ground', 'group', 'grow', 'guide', 'hand', 'happy', 'hard', 'harvest',
  'heart', 'heat', 'heavy', 'hero', 'hidden', 'high', 'hill', 'hold',
  'home', 'honey', 'hope', 'horse', 'house', 'human', 'hunt', 'ice',
  'iron', 'island', 'jewel', 'join', 'journey', 'jump', 'jungle', 'keep',
  'kind', 'king', 'kitchen', 'knee', 'knife', 'lake', 'lamp', 'land',
  'large', 'last', 'late', 'laugh', 'lawn', 'leaf', 'learn', 'left',
  'lemon', 'level', 'life', 'lift', 'light', 'lime', 'lion', 'list',
  'live', 'lock', 'long', 'look', 'lost', 'loud', 'love', 'lucky',
  'lunar', 'magic', 'main', 'make', 'maple', 'march', 'mark', 'mask',
  'match', 'maze', 'medal', 'melon', 'merge', 'metal', 'milk', 'mind',
  'mint', 'mirror', 'mist', 'moon', 'morning', 'moss', 'motor', 'mouse',
  'music', 'name', 'nature', 'near', 'nest', 'never', 'night', 'noble',
  'north', 'note', 'ocean', 'olive', 'open', 'orbit', 'order', 'outer',
  'owner', 'paint', 'palm', 'paper', 'park', 'party', 'path', 'peace',
  'pearl', 'pencil', 'piano', 'piece', 'pilot', 'pine', 'pink', 'place',
  'plain', 'plane', 'plant', 'plate', 'plaza', 'point', 'pond', 'pool',
  'power', 'press', 'price', 'pride', 'prize', 'proof', 'proud', 'pulse',
  'pump', 'queen', 'quest', 'quick', 'quiet', 'rain', 'range', 'rapid',
  'rare', 'raven', 'reach', 'ready', 'real', 'record', 'reef', 'relax',
  'rich', 'ridge', 'right', 'ring', 'river', 'road', 'robot', 'rock',
  'roof', 'room', 'root', 'rose', 'round', 'royal', 'ruby', 'rural',
  'safe', 'salt', 'sand', 'scale', 'scene', 'school', 'scout', 'screen'
] as const;

// Pre-built Set for O(1) word lookups instead of O(n) Array.includes()
const WORD_SET: ReadonlySet<string> = new Set(WORD_LIST);

// ==========================================
// RECOVERY PHRASE FUNCTIONS
// ==========================================

/**
 * Generate a random recovery phrase (12 words)
 */
export function generateRecoveryPhrase(): string {
  const words: string[] = [];
  const randomValues = new Uint32Array(12);
  crypto.getRandomValues(randomValues);

  for (let i = 0; i < 12; i++) {
    const index = randomValues[i] % WORD_LIST.length;
    words.push(WORD_LIST[index]);
  }

  return words.join(' ');
}

/**
 * Validate a recovery phrase format
 */
export function validateRecoveryPhrase(phrase: string): boolean {
  const words = phrase.toLowerCase().trim().split(/\s+/);
  if (words.length !== 12) return false;
  return words.every(word => WORD_SET.has(word));
}

// ==========================================
// KEY DERIVATION
// ==========================================

/**
 * Derive an encryption key from a recovery phrase using PBKDF2
 */
async function deriveKeyFromPhrase(phrase: string, salt: ArrayBuffer): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const phraseData = encoder.encode(phrase.toLowerCase().trim());

  // Import phrase as key material
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    phraseData,
    'PBKDF2',
    false,
    ['deriveKey']
  );

  // Derive AES-GCM key
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt,
      iterations: CONFIG.SECURITY.PBKDF2_ITERATIONS,
      hash: 'SHA-256'
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

// ==========================================
// ENCRYPTION / DECRYPTION
// ==========================================

/**
 * Encrypt PIN hash with recovery phrase
 * Returns: { encryptedData, salt, iv } as base64 strings
 */
export async function encryptPinWithRecovery(pinHash: string, recoveryPhrase: string): Promise<EncryptedBundle> {
  // Generate random salt and IV
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));

  // Derive key from recovery phrase
  const key = await deriveKeyFromPhrase(recoveryPhrase, salt.buffer);

  // Encrypt the PIN hash
  const encoder = new TextEncoder();
  const pinData = encoder.encode(pinHash);

  const encryptedData = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv },
    key,
    pinData
  );

  // Return as base64 for storage
  return {
    encryptedData: arrayBufferToBase64(encryptedData),
    salt: arrayBufferToBase64(salt.buffer),
    iv: arrayBufferToBase64(iv.buffer)
  };
}

/**
 * Decrypt PIN hash using recovery phrase
 * Returns the original PIN hash string, or null if decryption fails
 */
export async function decryptPinWithRecovery(encryptedBundle: EncryptedBundle, recoveryPhrase: string): Promise<string | null> {
  try {
    const { encryptedData, salt, iv } = encryptedBundle;

    // Convert from base64
    const encryptedBytes = base64ToArrayBuffer(encryptedData);
    const saltBytes = base64ToArrayBuffer(salt);
    const ivBytes = base64ToArrayBuffer(iv);

    // Derive key from recovery phrase
    const key = await deriveKeyFromPhrase(recoveryPhrase, saltBytes);

    // Decrypt
    const decryptedData = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(ivBytes) },
      key,
      encryptedBytes
    );

    // Return as string
    const decoder = new TextDecoder();
    return decoder.decode(decryptedData);

  } catch (err) {
    // Decryption failed (wrong phrase or corrupted data)
    if (import.meta.env.DEV) console.warn('PIN decryption failed:', (err as Error).message);
    return null;
  }
}

// ==========================================
// PIN HASHING
// ==========================================

/**
 * Hash a PIN using PBKDF2 (same as existing implementation)
 */
export async function hashPin(pin: string): Promise<string> {
  const encoder = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(pin),
    'PBKDF2',
    false,
    ['deriveBits']
  );

  const hash = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: salt,
      iterations: CONFIG.SECURITY.PBKDF2_ITERATIONS,
      hash: 'SHA-256'
    },
    keyMaterial,
    256
  );

  // Return as "salt:hash" format
  return arrayBufferToBase64(salt.buffer) + ':' + arrayBufferToBase64(hash);
}

/**
 * Verify a PIN against a PBKDF2-formatted stored hash (salt:hash)
 */
async function verifyPinPBKDF2(entered: string, stored: string): Promise<boolean> {
  const [saltB64, hashB64] = stored.split(':');
  if (!saltB64 || !hashB64) return false;

  const salt = base64ToArrayBuffer(saltB64);
  const encoder = new TextEncoder();

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(entered),
    'PBKDF2',
    false,
    ['deriveBits']
  );

  const newHash = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: salt,
      iterations: CONFIG.SECURITY.PBKDF2_ITERATIONS,
      hash: 'SHA-256'
    },
    keyMaterial,
    256
  );

  const storedHash = base64ToArrayBuffer(hashB64);
  return timingSafeEqual(new Uint8Array(newHash), new Uint8Array(storedHash));
}

/**
 * Verify entered PIN against stored PIN (single source of truth for all formats).
 * Supports: recovery-enabled JSON, PBKDF2 (salt:hash), legacy SHA-256, plaintext.
 */
export async function verifyPin(entered: string, stored: string): Promise<boolean> {
  // Recovery-enabled format (JSON with version: 2)
  if (hasRecoveryEnabled(stored)) {
    try {
      const bundle = JSON.parse(stored) as { hash: string };
      return verifyPinPBKDF2(entered, bundle.hash);
    } catch {
      return false;
    }
  }

  // PBKDF2 format (salt:hash with base64)
  if (stored.includes(':')) {
    try {
      return await verifyPinPBKDF2(entered, stored);
    } catch {
      if (import.meta.env.DEV) console.error('PIN verification failed: corrupted stored hash');
      return false;
    }
  }

  // Legacy SHA-256 hash (64 hex chars, no salt)
  if (/^[0-9a-f]{64}$/.test(stored)) {
    const encoder = new TextEncoder();
    const buf = await crypto.subtle.digest('SHA-256', encoder.encode(entered));
    const hash = Array.from(new Uint8Array(buf))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
    return hash === stored;
  }

  // Plaintext comparison (very old legacy)
  // FIXED: Use constant-time comparison to prevent timing attacks
  const enc = new TextEncoder();
  return timingSafeEqual(enc.encode(entered), enc.encode(stored));
}

// ==========================================
// UTILITY FUNCTIONS
// ==========================================

/**
 * Timing-safe comparison to prevent timing attacks
 */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  const maxLen = Math.max(a.length, b.length);
  let result = a.length !== b.length ? 1 : 0;
  for (let i = 0; i < maxLen; i++) {
    result |= (a[i % a.length] || 0) ^ (b[i % b.length] || 0);
  }
  return result === 0;
}

/**
 * Convert ArrayBuffer to Base64 string
 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Convert Base64 string to ArrayBuffer
 */
function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

// ==========================================
// RECOVERY FUNCTIONS
// ==========================================

/**
 * Check if stored PIN has recovery enabled
 */
export function hasRecoveryEnabled(pinData: string | null | undefined): boolean {
  if (!pinData) return false;
  try {
    const parsed = JSON.parse(pinData) as Partial<PinBundle>;
    return !!(parsed && parsed.encryptedData && parsed.salt && parsed.iv);
  } catch {
    return false;
  }
}

/**
 * Create a complete PIN bundle with recovery
 */
export async function createPinWithRecovery(pin: string): Promise<PinCreationResult> {
  // Generate recovery phrase
  const recoveryPhrase = generateRecoveryPhrase();

  // Hash the PIN
  const pinHash = await hashPin(pin);

  // Encrypt with recovery phrase
  const encrypted = await encryptPinWithRecovery(pinHash, recoveryPhrase);

  // Bundle for storage
  const bundle: PinBundle = {
    hash: pinHash,
    ...encrypted,
    version: 2 // Version 2 = recovery-enabled
  };

  return {
    bundle: JSON.stringify(bundle),
    recoveryPhrase,
    pinHash
  };
}

/**
 * Recover PIN hash using recovery phrase
 */
export async function recoverPinHash(storedBundle: string, recoveryPhrase: string): Promise<string | null> {
  try {
    const bundle = JSON.parse(storedBundle) as PinBundle;
    if (bundle.version !== 2) {
      throw new Error('PIN does not have recovery enabled');
    }

    return await decryptPinWithRecovery(bundle, recoveryPhrase);
  } catch (err) {
    if (import.meta.env.DEV) console.error('Recovery failed:', err);
    return null;
  }
}
