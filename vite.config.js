import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
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
  root: '.',
  build: {
    outDir: 'dist',
    target: 'esnext',
    minify: 'esbuild',
    sourcemap: true,
    rollupOptions: {
      input: 'index.html'
    }
  },
  server: {
    port: 3000,
    open: true
  },
  plugins: [
    tsJsResolverPlugin(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: 'script',
      manifest: {
        name: 'Budget Tracker Elite',
        short_name: 'Budget Tracker',
        description: 'Premium financial management - track expenses, income, and savings goals',
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
        globPatterns: ['**/*.{js,css,html}'],
        navigateFallback: 'index.html',
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/fonts\.(googleapis|gstatic)\.com/,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'google-fonts',
              expiration: { maxEntries: 30, maxAgeSeconds: 60 * 60 * 24 * 365 }
            }
          }
        ]
      }
    })
  ]
});
