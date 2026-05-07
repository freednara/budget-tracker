// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Regression test for the April 21, 2026 incremental code-review finding #3:
 *
 *   `signals.ts` keeps a module-level setTimeout alive (todayStr midnight
 *   refresh) and exports `cancelMidnightTimer()`, but `cleanupApp()`
 *   previously never called it. Re-initialization paths (HMR, app reset, test
 *   harness reuse) left orphaned timers behind, scheduling duplicate midnight
 *   updates against stale app state.
 *
 * A behavioral test that exercises `cleanupApp()` is impractical — the function
 * pulls in the entire DI graph, multi-tab sync, error tracking, etc., none of
 * which the timer-cleanup wiring depends on. The contract we care about is
 * exactly the one-line call site, so we assert on the source directly. This
 * matches the pattern used by `architecture-contract.test.ts` for
 * source-level invariants.
 */
describe('cleanupApp tears down the midnight refresh timer', () => {
  const sourcePath = resolve(process.cwd(), 'js/modules/orchestration/app-init-di.ts');
  const source = readFileSync(sourcePath, 'utf8');

  function extractCleanupAppBody(): string {
    const declStart = source.indexOf('export function cleanupApp(');
    expect(declStart).toBeGreaterThan(-1);

    // Walk braces from the first `{` after the declaration to the matching `}`.
    const openBrace = source.indexOf('{', declStart);
    expect(openBrace).toBeGreaterThan(-1);
    let depth = 0;
    for (let i = openBrace; i < source.length; i++) {
      const ch = source[i];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return source.slice(openBrace, i + 1);
      }
    }
    throw new Error('cleanupApp body not terminated');
  }

  it('calls signals.cancelMidnightTimer() in cleanupApp', () => {
    const body = extractCleanupAppBody();
    expect(body).toMatch(/signals\.cancelMidnightTimer\s*\(\s*\)/);
  });

  it('imports the signals namespace it relies on', () => {
    expect(source).toMatch(/import\s+\*\s+as\s+signals\s+from\s+['"]\.\.\/core\/signals\.js['"]/);
  });
});
