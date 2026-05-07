// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import {
  ALL_REGISTERED_PATTERNS,
  APP_STORAGE_REGISTRY,
  APP_LOCAL_STORAGE_KEYS,
  APP_LOCAL_STORAGE_PREFIXES,
  PRESERVED_KEYS
} from '../js/modules/core/storage-registry.js';

const MODULE_ROOT = resolve(process.cwd(), 'js/modules');

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

describe('architecture contract', () => {
  const directSignalWritePattern = /\b(?:signals\.[A-Za-z0-9_]+|[A-Za-z0-9_$.]+\.signal)\.value\s*=/;

  it('keeps transaction rendering owned by the transaction surface coordinator', () => {
    const rendererImporters = getTypeScriptFiles(MODULE_ROOT)
      .filter((filePath) => readFileSync(filePath, 'utf8').includes('transaction-renderer.js'))
      .map(toRepoPath);

    expect(rendererImporters).toEqual([
      'js/modules/data/transaction-surface-coordinator.ts'
    ]);
  });

  it('limits direct signal writers to the approved low-level modules', () => {
    const directSignalWriters = getTypeScriptFiles(MODULE_ROOT)
      .filter((filePath) => directSignalWritePattern.test(readFileSync(filePath, 'utf8')))
      .map(toRepoPath);

    expect(directSignalWriters).toEqual([
      'js/modules/core/actions/data-actions.ts',
      'js/modules/core/actions/filters-actions.ts',
      'js/modules/core/actions/form-actions.ts',
      'js/modules/core/actions/navigation-actions.ts',
      'js/modules/core/category-store.ts',
      'js/modules/core/state-hydration.ts',
      'js/modules/data/transaction-renderer.ts',
      'js/modules/features/backup/auto-backup.ts',
      'js/modules/features/gamification/achievements.ts',
      'js/modules/features/gamification/streak-tracker.ts',
      'js/modules/orchestration/app-reset.ts',
      'js/modules/orchestration/backup-reminder.ts',
      // sample-data.ts writes rolloverSettings directly when loading demo profiles
      'js/modules/orchestration/sample-data.ts',
      'js/modules/transactions/edit-mode.ts',
      'js/modules/ui/core/ui-render.ts',
      // CR-Apr24-I findings 194/203: storage-events.ts is the cross-tab
      // sync boundary — it writes backup-reminder and recurring-template
      // signals directly because those keys are outside the syncState
      // SYNC_ALLOWED_KEYS allowlist.
      'js/modules/ui/interactions/storage-events.ts'
    ]);
  });

  it('allows only the documented core/data UI bridge files to import ui modules directly', () => {
    const uiImportPattern = /from\s+['"]\.\.\/ui\/|from\s+['"]\.\.\/components\/|from\s+['"]\.\.\/\.\.\/ui\//;
    const bridgeImporters = getTypeScriptFiles(join(MODULE_ROOT, 'core'))
      .concat(getTypeScriptFiles(join(MODULE_ROOT, 'data')))
      .filter((filePath) => uiImportPattern.test(readFileSync(filePath, 'utf8')))
      .map(toRepoPath)
      .sort();

    // Core modules no longer import directly from UI — they use event-bus
    // bridge events (SHOW_TOAST, OPEN_MODAL) instead. Only the data layer
    // transaction-renderer still has a legitimate UI bridge.
    expect(bridgeImporters).toEqual([
      'js/modules/data/transaction-renderer.ts'
    ]);
  });

  it('limits components-to-features/orchestration bridges to the documented exceptions', () => {
    const componentBridgeImportPattern = /from\s+['"]\.\.\/(?:features|orchestration)\//;
    const bridgeImporters = getTypeScriptFiles(join(MODULE_ROOT, 'components'))
      .filter((filePath) => componentBridgeImportPattern.test(readFileSync(filePath, 'utf8')))
      .map(toRepoPath)
      .sort();

    // `insights.ts` dropped off this list on 2026-04-20 when the P1 #1 fix
    // removed its direct `generateInsights` fallback — the component now
    // reads the memoized `currentInsights` signal exclusively, so it no
    // longer crosses into `features/personalization/`.
    expect(bridgeImporters).toEqual([
      'js/modules/components/daily-allowance.ts',
      'js/modules/components/debt-list.ts',
      'js/modules/components/debt-summary.ts',
      'js/modules/components/envelope-budget.ts',
      'js/modules/components/savings-goals.ts',
      'js/modules/components/summary-cards.ts',
      'js/modules/components/weekly-rollup.ts'
    ]);
  });

  it('limits components-to-ui bridges to the documented exceptions', () => {
    const componentUiBridgeImportPattern = /from\s+['"]\.\.\/ui\//;
    const bridgeImporters = getTypeScriptFiles(join(MODULE_ROOT, 'components'))
      .filter((filePath) => componentUiBridgeImportPattern.test(readFileSync(filePath, 'utf8')))
      .map(toRepoPath)
      .sort();

    expect(bridgeImporters).toEqual([
      'js/modules/components/calendar.ts',
      'js/modules/components/category-detail-panel.ts',
      'js/modules/components/charts.ts',
      'js/modules/components/daily-allowance.ts',
      'js/modules/components/insights.ts',
      'js/modules/components/transaction-detail-panel.ts'
    ]);
  });

  it('forbids imports from the deleted core/utils.js barrel', () => {
    // The deprecated core/utils.ts barrel was fully migrated and deleted
    // during ADR-001 Phase 1 (2026-04-12). All code now imports directly
    // from utils-pure.js or utils-dom.js. This test ensures no regression.
    const deprecatedBarrelPattern = /from\s+['"](?:\.\.?\/)+core\/utils\.js['"]/;
    const importers = getTypeScriptFiles(MODULE_ROOT)
      .filter((filePath) => deprecatedBarrelPattern.test(readFileSync(filePath, 'utf8')))
      .map(toRepoPath);

    expect(importers).toEqual([]);
  });

  it('bans budget_tracker_ string literals in production code (except preserved migration keys)', () => {
    // After the harbor rename, only migration.ts, key-migration.ts, and
    // app-reset.ts may contain the old prefix — for legacy key preservation.
    // Everything else must use the harbor_* names via the SK enum or direct
    // string literals. This test catches accidental regressions.
    const ALLOWED_FILES = new Set([
      'js/modules/data/migration.ts',
      'js/modules/data/key-migration.ts',
      'js/modules/orchestration/app-reset.ts',
      'js/modules/orchestration/app-init-di.ts', // Comment referencing the migration
      // rev 12 #13b (M35): storage-registry.ts holds the preserved legacy
      // key literals so the registry can annotate their cleanup behavior.
      'js/modules/core/storage-registry.ts',
    ]);

    const offenders = getTypeScriptFiles(MODULE_ROOT)
      .filter((filePath) => {
        const repoPath = toRepoPath(filePath);
        if (ALLOWED_FILES.has(repoPath)) return false;
        return readFileSync(filePath, 'utf8').includes('budget_tracker_');
      })
      .map(toRepoPath);

    expect(offenders).toEqual([]);
  });

  it('keeps syncState.applyKeyUpdate in lockstep with the 17-key sync allowlist', () => {
    // Invariant: Firestore's per-field merge in Phase 3 depends on the set of
    // keys syncState.applyKeyUpdate() accepts. Adding a new syncable key
    // without updating this allowlist (or vice versa) would silently break
    // cross-device merge. The ADR-001 delta contract is built on top of this
    // exact list — see docs/adr/ADR-001-firestore-cloud-sync.md §1.4.
    const source = readFileSync(
      resolve(process.cwd(), 'js/modules/core/actions/sync-state-actions.ts'),
      'utf8'
    );

    // Extract the body of syncState.applyKeyUpdate by slicing from the
    // declaration to the closing of its switch statement.
    const startIdx = source.indexOf('applyKeyUpdate(key: string, value: unknown)');
    expect(startIdx).toBeGreaterThan(-1);
    const bodyEnd = source.indexOf('default:', startIdx);
    expect(bodyEnd).toBeGreaterThan(startIdx);
    const body = source.slice(startIdx, bodyEnd);

    // Pull every `case SK.XXX:` token out of the switch.
    const caseMatches = Array.from(body.matchAll(/case\s+SK\.([A-Z_]+)\s*:/g))
      .map((m) => m[1])
      .sort();

    // The authoritative 17-key sync allowlist. Additions to this list are a
    // deliberate design decision — update both the switch and this test in
    // the same PR, and update ADR-001 §1.4 to match.
    const EXPECTED_SYNC_KEYS = [
      'ACHIEVE',
      'ALERTS',
      'ALLOC',
      'CURRENCY',
      'DEBTS',
      'FILTER_PRESETS',
      'INSIGHT_PERS',
      'PIN',
      'ROLLOVER_SETTINGS',
      'SAVINGS',
      'SAVINGS_CONTRIB',
      'SECTIONS',
      'STREAK',
      'THEME',
      'TX',
      'TX_TEMPLATES',
      'USER_CATS'
    ];

    expect(caseMatches).toEqual(EXPECTED_SYNC_KEYS);
    expect(caseMatches).toHaveLength(17);
  });

  it('keeps the storage registry in lockstep with every harbor_/budget_tracker_ literal in production code', () => {
    // Invariant (rev 12 #13b M35, Inline-Behavior-Review): every storage-key
    // string literal that lives in js/modules/ must be registered in
    // core/storage-registry.ts with an explicit cleanup category. This catches
    // two regressions the previous hardcoded `APP_LOCAL_STORAGE_KEYS` list
    // missed:
    //   (a) New keys quietly added to a feature module without being added to
    //       the reset wipe list (e.g. error-tracker telemetry, locale settings).
    //   (b) Dead entries left in the wipe list after their owning subsystem
    //       moved to a different storage tier (the `monthly_totals_cache`
    //       prefix sat in the list for several releases after the cache moved
    //       to an in-memory Map).
    //
    // Test strategy: grep every .ts file under js/modules/ for literals that
    // start with `harbor_`, `budget_tracker_`, or `backup_reminder_`. For each
    // unique literal, assert it equals an `APP_STORAGE_REGISTRY` entry's
    // `pattern` (for `type: 'key'`) OR starts with one (for `type: 'prefix'`).
    //
    // Three regex captures cover the literal forms in this codebase:
    //   - Single-quoted string literals: 'harbor_foo'
    //   - Double-quoted string literals: "harbor_foo"
    //   - Template-literal heads:        `harbor_foo_${...}` -> 'harbor_foo_'
    const literalPattern = /(?:'(harbor_[a-z_][a-z0-9_]*)'|"(harbor_[a-z_][a-z0-9_]*)"|`(harbor_[a-z_][a-z0-9_]*)(?:\$\{|`)|'(budget_tracker_[a-z_][a-z0-9_]*)'|"(budget_tracker_[a-z_][a-z0-9_]*)"|'(backup_reminder_[a-z_][a-z0-9_]*)'|"(backup_reminder_[a-z_][a-z0-9_]*)")/g;

    const seen = new Map<string, string[]>(); // literal -> files that contain it
    for (const filePath of getTypeScriptFiles(MODULE_ROOT)) {
      const repoPath = toRepoPath(filePath);
      // The registry itself contains every literal — that's the point. Skip it
      // so we don't claim it as evidence of an unregistered usage.
      if (repoPath === 'js/modules/core/storage-registry.ts') continue;

      const source = readFileSync(filePath, 'utf8');
      let match: RegExpExecArray | null;
      while ((match = literalPattern.exec(source)) !== null) {
        const literal = match.slice(1).find((g) => g !== undefined);
        if (!literal) continue;
        const owners = seen.get(literal) ?? [];
        if (!owners.includes(repoPath)) owners.push(repoPath);
        seen.set(literal, owners);
      }
    }

    // For each observed literal, find a registry entry that covers it.
    const unregistered: { literal: string; files: string[] }[] = [];
    for (const [literal, files] of seen) {
      const covered = APP_STORAGE_REGISTRY.some((entry) => {
        if (entry.type === 'key') return entry.pattern === literal;
        // type === 'prefix' — literal must start with the prefix
        return literal.startsWith(entry.pattern);
      });
      if (!covered) unregistered.push({ literal, files: files.sort() });
    }

    if (unregistered.length > 0) {
      const report = unregistered
        .map(({ literal, files }) => `  - "${literal}" used in: ${files.join(', ')}`)
        .join('\n');
      expect.fail(
        `Storage registry is missing ${unregistered.length} literal(s) found in js/modules/:\n${report}\n\n`
        + 'Add an entry to APP_STORAGE_REGISTRY in js/modules/core/storage-registry.ts '
        + 'for each one, choosing the correct cleanup category.'
      );
    }
  });

  it('keeps every storage-registry entry reachable (no dead registry entries)', () => {
    // Companion to the literal-coverage test: every entry the registry
    // declares must actually be referenced somewhere in js/modules/. A dead
    // entry usually means the owning subsystem stopped using the key and the
    // registry wasn't updated — the registry is supposed to be a *current*
    // map, not an archive.
    const allSource = getTypeScriptFiles(MODULE_ROOT)
      .filter((filePath) => toRepoPath(filePath) !== 'js/modules/core/storage-registry.ts')
      .map((filePath) => readFileSync(filePath, 'utf8'))
      .join('\n');

    const deadEntries = APP_STORAGE_REGISTRY.filter((entry) => {
      // For SK enum values we won't see the literal directly outside state.ts —
      // they're referenced via SK.XXX. The state.ts source itself contains the
      // literal in `TX: 'harbor_transactions'` form, so allSource already
      // includes them. For non-SK keys/prefixes the literal must appear too.
      return !allSource.includes(entry.pattern);
    });

    if (deadEntries.length > 0) {
      const report = deadEntries
        .map((e) => `  - "${e.pattern}" (${e.cleanup}, owner: ${e.owner})`)
        .join('\n');
      expect.fail(
        `Storage registry has ${deadEntries.length} entry/entries no longer referenced in js/modules/:\n${report}\n\n`
        + 'Remove them from APP_STORAGE_REGISTRY in js/modules/core/storage-registry.ts.'
      );
    }
  });

  it('exposes derived registry views consistent with the source registry', () => {
    // Sanity check on the derivation logic itself, so a future refactor of
    // the registry shape can\'t silently drop entries from the wipe list.
    const expectedKeys = APP_STORAGE_REGISTRY
      .filter((e) => e.cleanup === 'wipe-in-reset' && e.type === 'key')
      .map((e) => e.pattern);
    const expectedPrefixes = APP_STORAGE_REGISTRY
      .filter((e) => e.cleanup === 'wipe-in-reset' && e.type === 'prefix')
      .map((e) => e.pattern);
    const expectedPreserved = APP_STORAGE_REGISTRY
      .filter((e) => e.cleanup === 'preserve-migration')
      .map((e) => e.pattern);

    expect([...APP_LOCAL_STORAGE_KEYS]).toEqual(expectedKeys);
    expect([...APP_LOCAL_STORAGE_PREFIXES]).toEqual(expectedPrefixes);
    expect([...PRESERVED_KEYS]).toEqual(expectedPreserved);
    expect([...ALL_REGISTERED_PATTERNS]).toEqual(APP_STORAGE_REGISTRY.map((e) => e.pattern));

    // No two registry entries can have the same pattern + type combo —
    // would silently double-wipe.
    const pairs = APP_STORAGE_REGISTRY.map((e) => `${e.type}::${e.pattern}`);
    const dupes = pairs.filter((p, i) => pairs.indexOf(p) !== i);
    expect(dupes).toEqual([]);
  });

  it('keeps relative imports on the .js extension convention', () => {
    const offendingFiles = getTypeScriptFiles(MODULE_ROOT).filter((filePath) => {
      const source = readFileSync(filePath, 'utf8');
      const lines = source.split('\n');
      return lines.some((line) => {
        const match = line.match(/from\s+['"](\.{1,2}\/[^'"]+)['"]/);
        if (!match) return false;
        const specifier = match[1];
        if (!specifier) return false;
        return !specifier.endsWith('.js') && !specifier.endsWith('.json');
      });
    }).map(toRepoPath);

    expect(offendingFiles).toEqual([]);
  });
});
