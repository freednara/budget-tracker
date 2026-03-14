/**
 * Theme Module
 * Handles light/dark/system theme switching and persistence
 */

import { SK, lsGet, persist } from '../../core/state.js';
import type { Theme, ActualTheme } from '../../../types/index.js';

// ==========================================
// TYPE DEFINITIONS
// ==========================================

interface ThemeState {
  theme: Theme;
}

// ==========================================
// MODULE STATE
// ==========================================

// Store reference to S.theme - will be set from main app
let stateRef: ThemeState | null = null;

// Track system theme listener for cleanup
let systemThemeListener: ((e: MediaQueryListEvent) => void) | null = null;

// ==========================================
// THEME FUNCTIONS
// ==========================================

/**
 * Set state reference for theme updates
 */
export function setThemeState(state: ThemeState): void {
  stateRef = state;
}

/**
 * Get the current system theme preference
 */
export function getSystemTheme(): ActualTheme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * Apply a theme to the document
 */
export function applyTheme(actualTheme: ActualTheme): void {
  document.documentElement.setAttribute('data-theme', actualTheme);
}

/**
 * Set and persist the theme
 */
export function setTheme(theme: Theme): void {
  // Update state if reference is set
  if (stateRef) {
    stateRef.theme = theme;
  }
  persist(SK.THEME, theme);

  // Remove existing system theme listener
  if (systemThemeListener) {
    window.matchMedia('(prefers-color-scheme: dark)').removeEventListener('change', systemThemeListener);
    systemThemeListener = null;
  }

  if (theme === 'system') {
    // Apply current system preference
    applyTheme(getSystemTheme());
    // Listen for system theme changes
    systemThemeListener = (e: MediaQueryListEvent) => applyTheme(e.matches ? 'dark' : 'light');
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', systemThemeListener);
  } else {
    applyTheme(theme);
  }

  // Update button states
  document.querySelectorAll<HTMLButtonElement>('.theme-btn').forEach(b => {
    const isActive = b.dataset.theme === theme;
    b.classList.toggle('btn-primary', isActive);
    b.classList.toggle('form-input', !isActive);
    b.setAttribute('aria-pressed', String(isActive));
  });
}

/**
 * Initialize theme from saved preference
 */
export function initTheme(): Theme {
  const saved = lsGet(SK.THEME, 'dark') as Theme;
  setTheme(saved);
  return saved;
}
