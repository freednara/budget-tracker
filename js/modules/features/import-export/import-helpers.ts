/**
 * Import/Export Shared Helpers
 *
 * DRY-01: Extracted from import-export.ts and export-builders.ts to
 * eliminate duplicate definitions of cloneStorageDefault and
 * readOptionalSignalValue.
 *
 * @module import-helpers
 */
'use strict';

import { STORAGE_DEFAULTS } from '../../core/state.js';
import * as signals from '../../core/signals.js';

/**
 * Deep-clone a STORAGE_DEFAULTS value so callers get a fresh object
 * every time (avoids shared-reference mutation).
 */
export function cloneStorageDefault<T>(key: string): T {
  const source = STORAGE_DEFAULTS[key];
  if (source === null || typeof source !== 'object') return source as T;
  if (typeof structuredClone === 'function') return structuredClone(source) as T;
  return JSON.parse(JSON.stringify(source)) as T;
}

/**
 * Read a signal's current `.value` by name, falling back to the provided
 * default when the signal doesn't exist or isn't a valid signal object.
 */
export function readOptionalSignalValue<T>(key: string, fallback: T): T {
  const signalNamespace = signals as unknown as Record<string, unknown>;
  if (!(key in signalNamespace)) return fallback;

  const candidate = signalNamespace[key];
  if (!candidate || typeof candidate !== 'object' || !('value' in candidate)) {
    return fallback;
  }

  return (candidate as { value: T }).value;
}
