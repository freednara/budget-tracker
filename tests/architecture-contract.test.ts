import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

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
      'js/modules/core/state-actions.ts',
      'js/modules/core/state-hydration.ts',
      'js/modules/data/transaction-renderer.ts',
      'js/modules/features/backup/auto-backup.ts',
      'js/modules/features/gamification/achievements.ts',
      'js/modules/features/gamification/streak-tracker.ts',
      'js/modules/orchestration/app-reset.ts',
      'js/modules/orchestration/backup-reminder.ts',
      'js/modules/transactions/edit-mode.ts',
      'js/modules/ui/core/ui-render.ts'
    ]);
  });

  it('allows only the documented core/data UI bridge files to import ui modules directly', () => {
    const uiImportPattern = /from\s+['"]\.\.\/ui\/|from\s+['"]\.\.\/components\/|from\s+['"]\.\.\/\.\.\/ui\//;
    const bridgeImporters = getTypeScriptFiles(join(MODULE_ROOT, 'core'))
      .concat(getTypeScriptFiles(join(MODULE_ROOT, 'data')))
      .filter((filePath) => uiImportPattern.test(readFileSync(filePath, 'utf8')))
      .map(toRepoPath)
      .sort();

    expect(bridgeImporters).toEqual([
      'js/modules/core/error-boundary.ts',
      'js/modules/core/error-tracker.ts',
      'js/modules/core/multi-tab-sync-conflicts.ts',
      'js/modules/core/multi-tab-sync.ts',
      'js/modules/data/transaction-renderer.ts'
    ]);
  });

  it('keeps relative imports on the .js extension convention', () => {
    const offendingFiles = getTypeScriptFiles(MODULE_ROOT).filter((filePath) => {
      const source = readFileSync(filePath, 'utf8');
      const lines = source.split('\n');
      return lines.some((line) => {
        const match = line.match(/from\s+['"](\.{1,2}\/[^'"]+)['"]/);
        if (!match) return false;
        const specifier = match[1];
        return !specifier.endsWith('.js') && !specifier.endsWith('.json');
      });
    }).map(toRepoPath);

    expect(offendingFiles).toEqual([]);
  });
});
