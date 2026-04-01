import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const indexHtml = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
const viteConfig = readFileSync(resolve(process.cwd(), 'vite.config.ts'), 'utf8');

describe('PWA privacy config', () => {
  it('does not load third-party web fonts from Google', () => {
    expect(indexHtml).not.toContain('fonts.googleapis.com');
    expect(indexHtml).not.toContain('fonts.gstatic.com');
  });

  it('does not define runtime caches for financial sync or export endpoints', () => {
    expect(viteConfig).not.toContain("/backup");
    expect(viteConfig).not.toContain("/sync");
    expect(viteConfig).not.toContain("/export");
    expect(viteConfig).toContain('runtimeCaching: []');
  });
});
