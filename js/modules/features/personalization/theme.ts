/**
 * Theme Module
 * 
 * Handles light/dark/system theme switching and persistence using signals.
 * Fully reactive implementation that automatically synchronizes document
 * state and system listeners.
 */
'use strict';

import * as signals from '../../core/signals.js';
import { settings } from '../../core/state-actions.js';
import { on } from '../../core/event-bus.js';
import { effect } from '@preact/signals-core';
import { FeatureEvents } from '../../core/feature-event-interface.js';
import type { Theme, ActualTheme } from '../../../types/index.js';

// ==========================================
// MODULE STATE
// ==========================================

// Track system theme listener for cleanup
let systemThemeListener: ((e: MediaQueryListEvent) => void) | null = null;
let systemThemeMediaQuery: MediaQueryList | null = null;
let highContrastListener: ((e: MediaQueryListEvent) => void) | null = null;
let highContrastMediaQuery: MediaQueryList | null = null;

function getSystemThemeMediaQuery(): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return null;
  }

  if (!systemThemeMediaQuery) {
    systemThemeMediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
  }

  return systemThemeMediaQuery;
}

function getHighContrastMediaQuery(): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return null;
  }

  if (!highContrastMediaQuery) {
    highContrastMediaQuery = window.matchMedia('(prefers-contrast: more)');
  }

  return highContrastMediaQuery;
}

// ==========================================
// THEME FUNCTIONS
// ==========================================

/**
 * Get the current system theme preference
 */
export function getSystemTheme(): ActualTheme {
  return getSystemThemeMediaQuery()?.matches ? 'dark' : 'light';
}

/**
 * Sync the `<meta name="theme-color">` tag to match the current theme.
 *
 * Mobile browsers (iOS Safari, Android Chrome, and PWA shells) tint the
 * status/address bar from this value. If it stays pinned to the original
 * brand blue, a dark-theme user sees a stark light-blue bar against a navy
 * app; a light-theme user sees the bar mismatched against the pale
 * background. Reading the computed `--bg-primary` after `data-theme` flips
 * keeps the chrome aligned with whatever the stylesheet ships.
 */
function syncThemeColorMeta(): void {
  if (typeof document === 'undefined') return;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) return;

  // Computed styles reflect the value `data-theme` just activated.
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg-primary').trim();
  if (bg) meta.setAttribute('content', bg);
}

/**
 * Apply a theme to the document
 */
export function applyTheme(actualTheme: ActualTheme): void {
  document.documentElement.setAttribute('data-theme', actualTheme);

  // Apply high contrast class if high contrast is preferred
  const highContrastQuery = getHighContrastMediaQuery();
  if (highContrastQuery?.matches) {
    document.documentElement.classList.add('high-contrast');
  } else {
    document.documentElement.classList.remove('high-contrast');
  }

  // Keep the browser chrome (iOS status bar, Android address bar, PWA shell)
  // in sync with the theme palette.
  syncThemeColorMeta();

  // Dispatch event for non-reactive components that need to know
  window.dispatchEvent(new CustomEvent('theme-changed', { detail: { theme: actualTheme } }));
}

/**
 * Set the theme preference
 */
export function setTheme(theme: Theme): void {
  settings.setTheme(theme);
}

/**
 * Initialize reactive theme management
 * WATCHES: signals.theme
 */
export function initTheme(): () => void {
  // Create a reactive effect that applies the theme whenever the signal changes
  const cleanup = effect(() => {
    const theme = signals.theme.value;
    const mediaQuery = getSystemThemeMediaQuery();
    const contrastQuery = getHighContrastMediaQuery();

    // 1. Manage system theme listener
    if (systemThemeListener && mediaQuery) {
      mediaQuery.removeEventListener('change', systemThemeListener);
      systemThemeListener = null;
    }

    // 2. Manage high contrast listener
    if (highContrastListener && contrastQuery) {
      contrastQuery.removeEventListener('change', highContrastListener);
      highContrastListener = null;
    }

    // 3. Determine and apply actual theme
    if (theme === 'system') {
      applyTheme(getSystemTheme());

      systemThemeListener = (e: MediaQueryListEvent) => {
        if (signals.theme.peek() === 'system') {
          applyTheme(e.matches ? 'dark' : 'light');
        }
      };

      mediaQuery?.addEventListener('change', systemThemeListener);
    } else {
      applyTheme(theme as ActualTheme);
    }

    // 4. Set up high contrast listener for dynamic changes
    highContrastListener = () => {
      applyTheme(signals.theme.peek() === 'system' ? getSystemTheme() : (signals.theme.peek() as ActualTheme));
    };
    contrastQuery?.addEventListener('change', highContrastListener);

    // 5. Update UI buttons (if they exist)
    document.querySelectorAll<HTMLButtonElement>('.theme-btn').forEach(b => {
      const isActive = b.dataset.theme === theme;
      b.classList.toggle('btn-primary', isActive);
      b.classList.toggle('form-input', !isActive);
      b.setAttribute('aria-pressed', String(isActive));
    });
  });

  // Register Feature Event Listener for external control
  const unsubscribeThemeEvent = on(FeatureEvents.SET_THEME, (data: { theme: Theme }) => {
    setTheme(data.theme);
  });

  return () => {
    cleanup();
    unsubscribeThemeEvent();
    if (systemThemeListener && systemThemeMediaQuery) {
      systemThemeMediaQuery.removeEventListener('change', systemThemeListener);
      systemThemeListener = null;
    }
    if (highContrastListener && highContrastMediaQuery) {
      highContrastMediaQuery.removeEventListener('change', highContrastListener);
      highContrastListener = null;
    }
    systemThemeMediaQuery = null;
    highContrastMediaQuery = null;
  };
}

/**
 * @deprecated State is now managed automatically via signals.theme
 */
export function setThemeState(): void {}
