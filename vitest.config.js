import { defineConfig } from 'vitest/config';
import { existsSync } from 'fs';
import { resolve, dirname } from 'path';

// Plugin to resolve .js imports to .ts files during TypeScript migration
function tsJsResolverPlugin() {
  return {
    name: 'ts-js-resolver',
    resolveId(source, importer) {
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
    setupFiles: ['./tests/setup.js'],
    globals: true,
    include: ['tests/**/*.test.js']
  }
});
