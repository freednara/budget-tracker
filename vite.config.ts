import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { existsSync } from 'fs';
import { resolve, dirname } from 'path';

const APP_VERSION = process.env.npm_package_version || '0.0.0';
const APP_BUILD_TIME = new Date().toISOString();

// Plugin to resolve .js imports to .ts files during TypeScript migration
// Enhanced with better path resolution and error handling
function tsJsResolverPlugin() {
  return {
    name: 'ts-js-resolver',
    resolveId(source: string, importer: string | undefined) {
      // Only process relative imports from our source files
      if (!source.startsWith('.') || !source.endsWith('.js')) {
        return null;
      }
      
      // Skip node_modules and external libraries
      if (!importer || importer.includes('node_modules')) {
        return null;
      }
      
      // Process files in our project (js/modules/ and root .ts files like app.ts)
      if (importer.includes('node_modules')) {
        return null;
      }
      
      try {
        const dir = dirname(importer);
        const tsPath = resolve(dir, source.replace(/\.js$/, '.ts'));
        
        // Check if TypeScript file exists
        if (existsSync(tsPath)) {
          return tsPath;
        }
        
        // Fallback: check if actual .js file exists (for hybrid migration)
        const jsPath = resolve(dir, source);
        if (existsSync(jsPath)) {
          return jsPath;
        }
      } catch (err) {
        console.warn(`Failed to resolve ${source} from ${importer}:`, err);
      }
      
      return null;
    }
  };
}

// Strip CSP meta tag in dev mode so Vite HMR inline scripts work
function cspDevStripPlugin() {
  return {
    name: 'csp-dev-strip',
    transformIndexHtml(html: string, ctx: { server?: unknown }) {
      if (ctx.server) {
        // Dev mode: remove the CSP meta tag
        return html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '');
      }
      return html;
    }
  };
}

export default defineConfig({
  root: '.',
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
    __APP_BUILD_TIME__: JSON.stringify(APP_BUILD_TIME),
  },
  build: {
    outDir: 'dist',
    target: 'esnext',
    minify: 'esbuild',
    sourcemap: false,
    cssCodeSplit: true,
    rollupOptions: {
      input: 'index.html',
      treeshake: {
        moduleSideEffects: false,
        propertyReadSideEffects: false,
        tryCatchDeoptimization: false
      },
      output: {
        manualChunks: (id) => {
          if (id.includes('node_modules')) {
            if (id.includes('@preact/signals-core') || id.includes('lit-html')) {
              return 'framework';
            }
            return 'vendor';
          }
          return undefined;
        }
      }
    }
  },
  server: {
    host: '127.0.0.1',
    port: 3000,
    strictPort: true,
    open: false
  },
  plugins: [
    tsJsResolverPlugin(),
    cspDevStripPlugin(),
    VitePWA({
      // Use prompt so user can finish current work before update activates
      registerType: 'prompt',
      injectRegister: 'script',
      devOptions: {
        enabled: false, // Disable PWA service worker in dev to reduce console noise
        type: 'module'
      },
      manifest: {
        name: 'Harbor Ledger',
        short_name: 'Harbor',
        description: 'Harbor Ledger helps you track expenses, income, and savings goals privately.',
        start_url: './',
        scope: './',
        display: 'standalone',
        orientation: 'portrait-primary',
        background_color: '#0a0e27',
        theme_color: '#3b82f6',
        categories: ['finance', 'productivity'],
        icons: [
          {
            src: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 192 192'%3E%3Crect fill='%230a0e27' width='192' height='192' rx='32'/%3E%3Crect fill='%233b82f6' x='16' y='16' width='160' height='160' rx='24'/%3E%3Ctext x='96' y='118' font-size='90' text-anchor='middle' font-family='sans-serif'%3E%F0%9F%92%B0%3C/text%3E%3C/svg%3E",
            sizes: '192x192',
            type: 'image/svg+xml',
            purpose: 'any'
          },
          {
            src: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 512 512'%3E%3Crect fill='%230a0e27' width='512' height='512' rx='80'/%3E%3Crect fill='%233b82f6' x='40' y='40' width='432' height='432' rx='64'/%3E%3Ctext x='256' y='320' font-size='240' text-anchor='middle' font-family='sans-serif'%3E%F0%9F%92%B0%3C/text%3E%3C/svg%3E",
            sizes: '512x512',
            type: 'image/svg+xml',
            purpose: 'any'
          }
        ],
        shortcuts: [
          {
            name: 'Quick Add Expense',
            short_name: 'Add Expense',
            description: 'Quickly add a new expense transaction',
            url: './index.html?action=add&type=expense',
            icons: [
              {
                src: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 96 96'%3E%3Crect fill='%23ef4444' width='96' height='96' rx='16'/%3E%3Ctext x='48' y='64' font-size='48' text-anchor='middle' fill='white' font-family='sans-serif'%3E%2B%3C/text%3E%3C/svg%3E",
                sizes: '96x96',
                type: 'image/svg+xml'
              }
            ]
          },
          {
            name: 'View Analytics',
            short_name: 'Analytics',
            description: 'View your spending analytics and trends',
            url: './index.html?tab=analytics',
            icons: [
              {
                src: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 96 96'%3E%3Crect fill='%233b82f6' width='96' height='96' rx='16'/%3E%3Ctext x='48' y='64' font-size='48' text-anchor='middle' fill='white' font-family='sans-serif'%3E%F0%9F%93%8A%3C/text%3E%3C/svg%3E",
                sizes: '96x96',
                type: 'image/svg+xml'
              }
            ]
          }
        ]
      },
      workbox: {
        // Critical update settings for financial app
        cleanupOutdatedCaches: true,
        skipWaiting: false, // Wait for user to accept update
        clientsClaim: true, // Take control on next page load
        
        // Explicitly define what to cache, excluding non-essential files
        globPatterns: [
          '**/*.{js,css,html,ico,png,svg,woff2}'
        ],
        navigateFallback: 'index.html',
        // Define maximum cache sizes to prevent bloat
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024, // 5MB
        runtimeCaching: []
      }
    })
  ]
});
