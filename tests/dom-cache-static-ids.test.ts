// @vitest-environment node
/**
 * Phase 6 Slice 1g (Inline-Behavior-Review rev 12, L46)
 *
 * Contract test: every id in `STATIC_ELEMENT_IDS` (the fast-path
 * allowlist used by `DOMCache#get` to bypass WeakRef overhead for
 * long-lived app-shell elements) must exist as an `id="..."`
 * attribute in `index.html` at boot.
 *
 * Without this invariant, renaming a shell element in `index.html`
 * without updating the allowlist silently falls through to the slow
 * WeakRef path (or returns null entirely), producing a silent
 * performance regression — or worse, a silent null that makes the
 * downstream signal-effect no-op with no warning.
 *
 * The rev 12 L46 audit revealed that 12 of 17 original staticIds
 * had been silently lost this way over successive UI refactors. The
 * allowlist was pruned to the 5 that actually exist; this test
 * prevents the drift from re-accumulating.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STATIC_ELEMENT_IDS } from '../js/modules/core/dom-cache.js';

const INDEX_HTML_PATH = resolve(__dirname, '../index.html');

function loadIndexHtmlIds(): Set<string> {
  const html = readFileSync(INDEX_HTML_PATH, 'utf-8');
  const ids = new Set<string>();
  // Matches double- or single-quoted id attributes with a simple
  // [a-zA-Z0-9_-]+ id value. Templates/framework-bound expressions
  // like id="{foo}" are excluded by design — only literal ids qualify
  // as "present at boot."
  const idRegex = /\bid=["']([a-zA-Z][a-zA-Z0-9_-]*)["']/g;
  let match: RegExpExecArray | null;
  while ((match = idRegex.exec(html)) !== null) {
    const id = match[1];
    if (id) ids.add(id);
  }
  return ids;
}

describe('dom-cache STATIC_ELEMENT_IDS contract (L46)', () => {
  const indexHtmlIds = loadIndexHtmlIds();

  it('index.html parses successfully and contains at least one id', () => {
    // Guard against the test harness silently reading an empty file
    // and reporting a false pass for "every id exists in the empty set".
    expect(indexHtmlIds.size).toBeGreaterThan(50);
    expect(indexHtmlIds.has('app')).toBe(true);
  });

  it('STATIC_ELEMENT_IDS is not empty', () => {
    // Prevents an accidental empty allowlist from silently disabling
    // the fast path without the test noticing.
    expect(STATIC_ELEMENT_IDS.length).toBeGreaterThan(0);
  });

  it.each(STATIC_ELEMENT_IDS)(
    'staticId "%s" exists as an id attribute in index.html',
    (staticId) => {
      expect(indexHtmlIds).toContain(staticId);
    }
  );

  it('STATIC_ELEMENT_IDS has no duplicate entries', () => {
    const unique = new Set(STATIC_ELEMENT_IDS);
    expect(unique.size).toBe(STATIC_ELEMENT_IDS.length);
  });

  it('every STATIC_ELEMENT_IDS entry is non-empty and kebab-or-word shaped', () => {
    // Defensive: catch obvious typos ("app "), empty strings,
    // or template placeholders that slipped into the const.
    for (const id of STATIC_ELEMENT_IDS) {
      expect(id.length).toBeGreaterThan(0);
      expect(id).toMatch(/^[a-zA-Z][a-zA-Z0-9_-]*$/);
    }
  });
});
