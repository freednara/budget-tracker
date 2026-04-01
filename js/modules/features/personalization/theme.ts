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

function getSystemThemeMediaQuery(): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return null;
  }

  if (!systemThemeMediaQuery) {
    systemThemeMediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
  }

  return systemThemeMediaQuery;
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
 * Apply a theme to the document
 */
export function applyTheme(actualTheme: ActualTheme): void {
  document.documentElement.setAttribute('data-theme', actualTheme);
  
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

    // 1. Manage system theme listener
    if (systemThemeListener && mediaQuery) {
      mediaQuery.removeEventListener('change', systemThemeListener);
      systemThemeListener = null;
    }

    // 2. Determine and apply actual theme
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

    // 3. Update UI buttons (if they exist)
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
    systemThemeMediaQuery = null;
  };
}

/**
 * @deprecated State is now managed automatically via signals.theme
 */
export function setThemeState(): void {}
