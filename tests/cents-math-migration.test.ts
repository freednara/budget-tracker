// @vitest-environment node
/**
 * Cents-Math Migration Guard
 * ==========================
 *
 * Grep-based CI tripwire for Inline-Behavior-Review rev 12, action-plan #16
 * (cents-math migration, end-to-end in the features tree).
 *
 * **Why this test exists.** Across rev-12 Phases 2-5c we closed a stream of
 * drift bugs where dollar values were accumulated or compared as
 * binary-floating-point numbers and the rounded result silently disagreed
 * with a sibling calculation that already used integer cents:
 *
 *   - category-detail-panel / transaction-detail-panel totals drifted from
 *     the parent-card `sumTrackedExpenses` header by a trailing cent when
 *     the dataset straddled a .10 boundary.
 *   - achievements.goal_getter flipped FALSE when `saved` was a cent short
 *     of `target` purely from float noise, denying users a legitimate
 *     achievement.
 *   - achievements.budget_boss flipped TRUE when spent was $50.000000001 vs
 *     allocated $50, awarding the badge on a rollover rounding error.
 *   - insights.insightDayOfWeek gate at 10% flipped wrong side of the
 *     threshold on flat-weekday datasets.
 *   - debt-planner.calculateTotalInterestPaid could clamp a real penny of
 *     interest to zero via float-subtract-then-Math.max chain.
 *
 * The fixes route every accumulation through `toCents(...)` (integer) and
 * convert once at the end via `toDollars(...)`, and route every
 * dollar-to-dollar comparison through `toCents()` on both sides. See
 * ADR-001 §9.5 Step 6 and `utils-pure.ts` (toCents / toDollars / addAmounts
 * / sumByType / sumTrackedExpenses) for the canonical pattern.
 *
 * **What this test catches.** New code under `js/modules/features/` that:
 *   1. sums dollar-field values without wrapping in `toCents(...)`, e.g.
 *      `sum + tx.amount`, `sum + goal.saved`, `sum + debt.balance`.
 *   2. compares two dollar-valued fields (`.saved` vs `.target`) with
 *      `<`, `<=`, `>`, `>=` without wrapping both sides in `toCents(...)`.
 *
 * **What this test does NOT catch.** Zero-comparisons (`balance > 0`),
 * division, multiplication, or non-feature code paths. The guard is scoped
 * narrowly to the accumulators and comparisons called out in #16 — a full
 * static analyzer would be overkill for a handful of files.
 *
 * **If this test fails on a new PR.** Do one of the following:
 *   - Rewrite the math in integer cents (preferred — matches ADR-001).
 *   - If the dollar-float arithmetic is genuinely safe (e.g. a
 *     display-only percentage where drift is imperceptible), add the
 *     `repoPath:lineNumber` to `ALLOWED_OFFENDERS` below with a comment
 *     explaining why.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const FEATURES_ROOT = resolve(process.cwd(), 'js/modules/features');

function getTypeScriptFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      files.push(...getTypeScriptFiles(fullPath));
      continue;
    }
    if (fullPath.endsWith('.ts')) {
      files.push(fullPath);
    }
  }
  return files.sort();
}

function toRepoPath(filePath: string): string {
  return relative(process.cwd(), filePath).replaceAll('\\', '/');
}

/**
 * Strip TypeScript comments so hazard regexes don't match references that
 * appear in explanatory comments (every cents-math fix ships with a comment
 * block that cites the hazard it closes). We strip block comments outright
 * and line comments starting at `//`, with a small escape hatch for `://`
 * so we don't mangle `http://`-style URLs that occasionally appear in JSDoc
 * links. Strings are not tracked; in practice the repo has no `//` inside
 * string literals on the same line as dollar-field math.
 */
function stripComments(source: string): string {
  const noBlock = source.replace(/\/\*[\s\S]*?\*\//g, '');
  return noBlock.split('\n').map((line) => {
    const idx = line.indexOf('//');
    if (idx === -1) return line;
    if (idx > 0 && line[idx - 1] === ':') return line;
    return line.slice(0, idx);
  }).join('\n');
}

interface HazardPattern {
  description: string;
  regex: RegExp;
  fix: string;
}

/**
 * Each pattern flags a class of unwrapped dollar-float math that has
 * produced a real drift bug during the rev-12 cents-math migration.
 * A passing match = unwrapped arithmetic. Wrapped calls like
 * `+ toCents(x.amount)` do NOT match because the `+` is followed by
 * `toCents(`, not by a field-access token.
 */
const HAZARDOUS_PATTERNS: HazardPattern[] = [
  {
    description: 'unwrapped "+ X.amount" accumulator',
    regex: /\+\s*[A-Za-z_$][\w$]*\.amount\b/,
    fix: 'Accumulate in cents: `sum + toCents(x.amount)`; convert the final total once with `toDollars(sum)`. See utils-pure.sumByType / sumTrackedExpenses for helpers.',
  },
  {
    description: 'unwrapped "+= X.amount" accumulator',
    regex: /\+=\s*[A-Za-z_$][\w$]*\.amount\b/,
    fix: 'Accumulate in cents: `centsAcc += toCents(x.amount)`; convert once at the end with `toDollars(centsAcc)`.',
  },
  {
    description: 'unwrapped "+ X.saved" / "+ X.saved_amount" accumulator',
    regex: /\+\s*[A-Za-z_$][\w$]*\.saved(?:_amount)?\b/,
    fix: 'Use `addAmounts(a, b)` for a single-step add, or `sum + toCents(x.saved || 0)` / `toDollars(sum)` for a reduce.',
  },
  {
    description: 'unwrapped "+ X.target" accumulator',
    regex: /\+\s*[A-Za-z_$][\w$]*\.target\b/,
    fix: 'Sum in cents: `sum + toCents(x.target || 0)` then `toDollars(sum)`.',
  },
  {
    description: 'unwrapped "+ X.balance" accumulator',
    regex: /\+\s*[A-Za-z_$][\w$]*\.balance\b/,
    fix: 'Sum in cents: `sum + toCents(x.balance || 0)` then `toDollars(sum)`.',
  },
  {
    description: 'unwrapped dollar-field vs dollar-field comparison (saved/target)',
    regex: /\.(saved|saved_amount)\s*[<>]=?\s*[A-Za-z_$][\w$]*\.target\b/,
    fix: 'Compare in cents: `toCents(g.saved || 0) >= toCents(g.target || 0)`.',
  },
];

/**
 * Known exceptions. Add entries as `js/modules/features/path/file.ts:LINE`
 * keyed off the stripped-comment line number, with a one-line comment
 * explaining why the pattern is safe. Keep this list small — the default
 * answer should always be to migrate the math, not allow-list the site.
 */
const ALLOWED_OFFENDERS: Set<string> = new Set([
  // Currently empty. All sites flagged during rev 12 Phase 5c #16 were
  // migrated to cents-math; no exceptions remain.
]);

describe('cents-math migration guard (rev 12 #16)', () => {
  it('has no unwrapped dollar-float accumulators or comparisons in features/', () => {
    const offenders: string[] = [];

    for (const filePath of getTypeScriptFiles(FEATURES_ROOT)) {
      const repoPath = toRepoPath(filePath);
      const raw = readFileSync(filePath, 'utf8');
      const stripped = stripComments(raw);
      const lines = stripped.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line || !line.trim()) continue;

        for (const { description, regex, fix } of HAZARDOUS_PATTERNS) {
          if (!regex.test(line)) continue;
          const key = `${repoPath}:${i + 1}`;
          if (ALLOWED_OFFENDERS.has(key)) continue;
          offenders.push(
            `${key} — ${description}\n  ${line.trim()}\n  Fix: ${fix}`
          );
        }
      }
    }

    // Fail with a readable report so the offending lines + fix guidance
    // surface directly in the test output rather than forcing a round trip
    // through the source tree.
    if (offenders.length > 0) {
      const report =
        `Found ${offenders.length} unwrapped dollar-float site(s) in js/modules/features/. ` +
        `Route each through toCents/toDollars (see ADR-001 §9.5 Step 6):\n\n` +
        offenders.map((o) => `  - ${o}`).join('\n\n');
      expect.fail(report);
    }
  });

  it('detects unwrapped "+ x.amount" reducers (self-check)', () => {
    // Self-check: confirm the primary regex actually matches the classic
    // hazard pattern on a synthetic string. If someone loosens the regex
    // and breaks detection, this assertion fires immediately instead of
    // silently passing the main guard.
    const hazardRegex = HAZARDOUS_PATTERNS[0]?.regex;
    if (!hazardRegex) throw new Error('expected hazard regex at index 0');
    expect(hazardRegex.test('const total = txs.reduce((sum, tx) => sum + tx.amount, 0);')).toBe(true);
    expect(hazardRegex.test('const total = txs.reduce((sum, tx) => sum + toCents(tx.amount), 0);')).toBe(false);
  });

  it('detects "saved vs target" comparisons without double-wrapping (self-check)', () => {
    const compareRegex = HAZARDOUS_PATTERNS[5]?.regex;
    if (!compareRegex) throw new Error('expected hazard regex at index 5');
    expect(compareRegex.test('if (g.saved >= g.target) awardAchievement("goal_getter");')).toBe(true);
    expect(compareRegex.test('if (toCents(g.saved || 0) >= toCents(g.target || 0)) awardAchievement("goal_getter");')).toBe(false);
  });
});
