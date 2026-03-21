import { defineConfig } from 'vitest/config';
import { existsSync } from 'fs';
import { resolve, dirname } from 'path';

// Plugin to resolve .js imports to .ts files during TypeScript migration
function tsJsResolverPlugin() {
  return {
    name: 'ts-js-resolver',
    resolveId(source: string, importer: string | undefined) {
      if (source.endsWith('.js') && importer) {
        const dir = dirname(importer);
        const tsPath = resolve(dir, source.replace(/\.js$/, '.ts'));
        if (existsSync(tsPath)) {
          return tsPath;
        }
      }
      return null;
    }
  };
}

export default defineConfig({
  plugins: [tsJsResolverPlugin()],
  test: {
    environment: 'happy-dom',
    globals: true,
    include: ['tests/**/*.test.ts'],
    coverage: {
      enabled: process.env.CI === 'true', // Enable in CI by default
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      exclude: [
        'node_modules/',
        'tests/',
        'e2e/',
        'dist/',
        '*.config.js',
        '*.config.ts',
        'js/workers/',
        'js/modules/types/',
        'playwright-report/'
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 75,
        statements: 80,
        perFile: true
      },
    }
  }
});
