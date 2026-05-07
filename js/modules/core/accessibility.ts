/**
 * Accessibility (a11y) Enhancement Module
 * 
 * Provides comprehensive accessibility improvements including
 * ARIA attributes, keyboard navigation, and screen reader support.
 */
'use strict';

import { html, LitTemplate } from './lit-helpers.js';

// ==========================================
// TYPE DEFINITIONS
// ==========================================

// Phase 6 Slice 1j (rev 12 L6): optional fields widened for
// `exactOptionalPropertyTypes` — `ariaField()` spreads a
// `Partial<AriaConfig>` where `describedBy` carries `config?.errorId`
// (string | undefined) straight into the payload.
interface AriaConfig {
  role?: string | undefined;
  label?: string | undefined;
  describedBy?: string | undefined;
  labelledBy?: string | undefined;
  expanded?: boolean | undefined;
  selected?: boolean | undefined;
  checked?: boolean | undefined;
  disabled?: boolean | undefined;
  hidden?: boolean | undefined;
  live?: 'polite' | 'assertive' | 'off' | undefined;
  atomic?: boolean | undefined;
  relevant?: string | undefined;
  busy?: boolean | undefined;
  invalid?: boolean | 'grammar' | 'spelling' | undefined;
  required?: boolean | undefined;
  readonly?: boolean | undefined;
  multiselectable?: boolean | undefined;
  orientation?: 'horizontal' | 'vertical' | undefined;
  valueMin?: number | undefined;
  valueMax?: number | undefined;
  valueNow?: number | undefined;
  valueText?: string | undefined;
  level?: number | undefined;
  setSize?: number | undefined;
  posInSet?: number | undefined;
  colspan?: number | undefined;
  rowspan?: number | undefined;
  controls?: string | undefined;
  flowTo?: string | undefined;
  owns?: string | undefined;
}

interface KeyboardConfig {
  trapFocus?: boolean;
  escapeClose?: boolean;
  enterSubmit?: boolean;
  arrowNavigation?: boolean;
  tabIndex?: number;
}

// ==========================================
// ARIA ATTRIBUTE HELPERS
// ==========================================

/**
 * Generate ARIA attributes object for lit-html
 */
export function aria(config: AriaConfig): Record<string, string> {
  const attrs: Record<string, string> = {};
  
  if (config.role) attrs.role = config.role;
  if (config.label) attrs['aria-label'] = config.label;
  if (config.describedBy) attrs['aria-describedby'] = config.describedBy;
  if (config.labelledBy) attrs['aria-labelledby'] = config.labelledBy;
  if (config.expanded !== undefined) attrs['aria-expanded'] = String(config.expanded);
  if (config.selected !== undefined) attrs['aria-selected'] = String(config.selected);
  if (config.checked !== undefined) attrs['aria-checked'] = String(config.checked);
  if (config.disabled !== undefined) attrs['aria-disabled'] = String(config.disabled);
  if (config.hidden !== undefined) attrs['aria-hidden'] = String(config.hidden);
  if (config.live) attrs['aria-live'] = config.live;
  if (config.atomic !== undefined) attrs['aria-atomic'] = String(config.atomic);
  if (config.relevant) attrs['aria-relevant'] = config.relevant;
  if (config.busy !== undefined) attrs['aria-busy'] = String(config.busy);
  if (config.invalid !== undefined) attrs['aria-invalid'] = String(config.invalid);
  if (config.required !== undefined) attrs['aria-required'] = String(config.required);
  if (config.readonly !== undefined) attrs['aria-readonly'] = String(config.readonly);
  if (config.multiselectable !== undefined) attrs['aria-multiselectable'] = String(config.multiselectable);
  if (config.orientation) attrs['aria-orientation'] = config.orientation;
  if (config.valueMin !== undefined) attrs['aria-valuemin'] = String(config.valueMin);
  if (config.valueMax !== undefined) attrs['aria-valuemax'] = String(config.valueMax);
  if (config.valueNow !== undefined) attrs['aria-valuenow'] = String(config.valueNow);
  if (config.valueText) attrs['aria-valuetext'] = config.valueText;
  if (config.level !== undefined) attrs['aria-level'] = String(config.level);
  if (config.setSize !== undefined) attrs['aria-setsize'] = String(config.setSize);
  if (config.posInSet !== undefined) attrs['aria-posinset'] = String(config.posInSet);
  if (config.colspan !== undefined) attrs['aria-colspan'] = String(config.colspan);
  if (config.rowspan !== undefined) attrs['aria-rowspan'] = String(config.rowspan);
  if (config.controls) attrs['aria-controls'] = config.controls;
  if (config.flowTo) attrs['aria-flowto'] = config.flowTo;
  if (config.owns) attrs['aria-owns'] = config.owns;
  
  return attrs;
}

/**
 * Create accessible button attributes
 */
export function ariaButton(label: string, config?: Partial<AriaConfig>): Record<string, string> {
  return aria({
    role: 'button',
    label,
    ...config
  });
}

/**
 * Create accessible link attributes
 */
export function ariaLink(label: string, config?: Partial<AriaConfig>): Record<string, string> {
  return aria({
    role: 'link',
    label,
    ...config
  });
}

/**
 * Create accessible form field attributes
 */
export function ariaField(
  label: string,
  config?: Partial<AriaConfig> & { errorId?: string }
): Record<string, string> {
  const attrs = aria({
    label,
    invalid: config?.invalid,
    required: config?.required,
    describedBy: config?.errorId,
    ...config
  });
  
  return attrs;
}

// ==========================================
// SCREEN READER ANNOUNCEMENTS
// ==========================================

class ScreenReaderAnnouncer {
  private assertiveRegion: HTMLElement | null = null;
  private politeRegion: HTMLElement | null = null;
  private regionTimers = new WeakMap<
    HTMLElement,
    {
      announceId: number | null;
      clearId: number | null;
    }
  >();

  constructor() {
    this.initRegions();
  }

  /**
   * Initialize ARIA live regions.
   * Reuses the existing #sr-announcer element from index.html for assertive announcements.
   * Creates a polite region only if needed.
   */
  private initRegions(): void {
    // Reuse existing HTML element for assertive announcements
    this.assertiveRegion = document.getElementById('sr-announcer');

    // Create polite region if it doesn't exist
    this.politeRegion = document.querySelector('[aria-live="polite"].sr-only');
    if (!this.politeRegion) {
      this.politeRegion = document.createElement('div');
      this.politeRegion.setAttribute('aria-live', 'polite');
      this.politeRegion.setAttribute('aria-atomic', 'true');
      this.politeRegion.className = 'sr-only';
      this.politeRegion.style.cssText = 'position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden';
      document.body.appendChild(this.politeRegion);
    }
  }

  /**
   * Announce message to screen readers
   */
  announce(message: string, priority: 'polite' | 'assertive' = 'polite'): void {
    // CR-Apr24-I finding 283: re-resolve cached live-region references
    // if they've been detached from the DOM since module init.
    if (this.assertiveRegion && !this.assertiveRegion.isConnected) {
      this.assertiveRegion = document.getElementById('sr-announcer');
    }
    if (this.politeRegion && !this.politeRegion.isConnected) {
      this.politeRegion = document.querySelector('[aria-live="polite"].sr-only');
    }

    const region = priority === 'assertive'
      ? (this.assertiveRegion || this.politeRegion)
      : this.politeRegion;

    if (!region) return;

    const timers = this.regionTimers.get(region) || {
      announceId: null,
      clearId: null
    };

    // This prevents the first's clear timer from clearing the second announcement
    // Round 7 fix: Clear any pending timers before starting a new announcement sequence
    if (timers.announceId !== null) {
      window.clearTimeout(timers.announceId);
    }
    if (timers.clearId !== null) {
      window.clearTimeout(timers.clearId);
    }

    // Clear and set new message (delay ensures screen reader picks up change)
    region.textContent = '';
    timers.announceId = window.setTimeout(() => {
      region.textContent = message;
      timers.announceId = null;
      timers.clearId = window.setTimeout(() => {
        if (region.textContent === message) {
          region.textContent = '';
        }
        timers.clearId = null;
      }, 1000);
    }, 100);

    this.regionTimers.set(region, timers);
  }
}

export const announcer = new ScreenReaderAnnouncer();

// ==========================================
// KEYBOARD NAVIGATION
// ==========================================

/**
 * Set up keyboard navigation for a container
 */
export function setupKeyboardNav(
  container: HTMLElement,
  config: KeyboardConfig = {}
): () => void {
  const {
    trapFocus = false,
    escapeClose = false,
    enterSubmit = false,
    arrowNavigation = false
  } = config;
  
  const handlers: Array<[string, EventListener]> = [];
  
  // Focus trap
  if (trapFocus) {
    const focusableSelector = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
    const focusHandler = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      
      const focusables = Array.from(container.querySelectorAll<HTMLElement>(focusableSelector));
      if (focusables.length === 0) return;

      // Phase 6 Slice 1i (rev 12 L6): length>0 check above guarantees
      // both ends exist, but `focusables[i]` is `HTMLElement | undefined`
      // under `noUncheckedIndexedAccess` — guard explicitly so the
      // `.focus()` calls stay typed.
      const firstFocusable = focusables[0];
      const lastFocusable = focusables[focusables.length - 1];
      if (!firstFocusable || !lastFocusable) return;

      if (e.shiftKey && document.activeElement === firstFocusable) {
        e.preventDefault();
        lastFocusable.focus();
      } else if (!e.shiftKey && document.activeElement === lastFocusable) {
        e.preventDefault();
        firstFocusable.focus();
      }
    };
    
    container.addEventListener('keydown', focusHandler as EventListener);
    handlers.push(['keydown', focusHandler as EventListener]);
  }
  
  // Escape key
  if (escapeClose) {
    const escapeHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        container.dispatchEvent(new CustomEvent('escape'));
      }
    };
    
    container.addEventListener('keydown', escapeHandler as EventListener);
    handlers.push(['keydown', escapeHandler as EventListener]);
  }
  
  // Enter key
  if (enterSubmit) {
    const enterHandler = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        const target = e.target as HTMLElement;
        if (target.tagName !== 'TEXTAREA') {
          // CR-Apr24-I finding 334: prevent native form submission so
          // we don't double-submit when attached to a real <form>.
          e.preventDefault();
          container.dispatchEvent(new CustomEvent('submit'));
        }
      }
    };
    
    container.addEventListener('keydown', enterHandler as EventListener);
    handlers.push(['keydown', enterHandler as EventListener]);
  }
  
  // Arrow navigation
  if (arrowNavigation) {
    const arrowHandler = (e: KeyboardEvent) => {
      const navigableSelector = '[role="option"], [role="menuitem"], [role="tab"]';
      const navigables = Array.from(container.querySelectorAll<HTMLElement>(navigableSelector));
      
      if (navigables.length === 0) return;
      
      const currentIndex = navigables.indexOf(document.activeElement as HTMLElement);
      let nextIndex = currentIndex;
      
      switch (e.key) {
        case 'ArrowDown':
        case 'ArrowRight':
          e.preventDefault();
          nextIndex = (currentIndex + 1) % navigables.length;
          break;
        case 'ArrowUp':
        case 'ArrowLeft':
          e.preventDefault();
          nextIndex = currentIndex - 1;
          if (nextIndex < 0) nextIndex = navigables.length - 1;
          break;
        case 'Home':
          e.preventDefault();
          nextIndex = 0;
          break;
        case 'End':
          e.preventDefault();
          nextIndex = navigables.length - 1;
          break;
        default:
          return;
      }
      
      // Phase 6 Slice 1i (rev 12 L6): index access returns
      // `HTMLElement | undefined` under `noUncheckedIndexedAccess`;
      // guard before calling `.focus()`.
      navigables[nextIndex]?.focus();
    };
    
    container.addEventListener('keydown', arrowHandler as EventListener);
    handlers.push(['keydown', arrowHandler as EventListener]);
  }
  
  // Return cleanup function
  return () => {
    handlers.forEach(([event, handler]) => {
      container.removeEventListener(event, handler);
    });
  };
}

// ==========================================
// FOCUS MANAGEMENT
// ==========================================

/**
 * Focus manager for modals and overlays
 */
export class FocusManager {
  private focusStack: HTMLElement[] = [];
  
  /**
   * Push focus context
   */
  push(element: HTMLElement): void {
    // Store current focus
    const current = document.activeElement as HTMLElement;
    if (current) {
      this.focusStack.push(current);
    }
    
    // Focus first focusable element
    const firstFocusable = element.querySelector<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    
    if (firstFocusable) {
      firstFocusable.focus();
    } else {
      element.focus();
    }
  }
  
  /**
   * Pop focus context
   */
  pop(): void {
    const previous = this.focusStack.pop();
    if (previous && document.body.contains(previous)) {
      previous.focus();
    }
  }
  
  /**
   * Clear focus stack
   */
  clear(): void {
    this.focusStack = [];
  }
}

export const focusManager = new FocusManager();

// ==========================================
// ACCESSIBLE TEMPLATES
// ==========================================

/**
 * Create accessible button template
 */
export function accessibleButton(
  label: string,
  onClick: () => void,
  options?: {
    icon?: string;
    variant?: 'primary' | 'secondary' | 'danger';
    disabled?: boolean;
    loading?: boolean;
  }
): LitTemplate {
  const { icon, variant = 'primary', disabled = false, loading = false } = options || {};
  
  return html`
    <button
      class="btn btn-${variant}"
      ...${ariaButton(label, {
        disabled: disabled || loading,
        busy: loading
      })}
      @click=${onClick}
      ?disabled=${disabled || loading}
    >
      ${loading ? html`<span class="spinner" aria-hidden="true"></span>` : ''}
      ${icon ? html`<span class="icon" aria-hidden="true">${icon}</span>` : ''}
      <span class="btn-label">${label}</span>
    </button>
  `;
}

/**
 * Create accessible modal template
 */
export function accessibleModal(
  title: string,
  content: LitTemplate,
  options?: {
    id?: string;
    closeLabel?: string;
    actions?: LitTemplate;
  }
): LitTemplate {
  const { id = 'modal', closeLabel = 'Close', actions } = options || {};
  
  return html`
    <div
      class="modal"
      ...${aria({
        role: 'dialog',
        labelledBy: `${id}-title`,
        describedBy: `${id}-content`
      })}
    >
      <div class="modal-header">
        <h2 id="${id}-title">${title}</h2>
        <button
          class="modal-close"
          ...${ariaButton(closeLabel)}
          @click=${(e: Event) => {
            // CR-Apr24-I finding 332: dispatch a 'close' custom event
            // so consumers can dismiss the modal, not just pop focus.
            const modal = (e.target as HTMLElement).closest('.modal');
            if (modal) {
              modal.dispatchEvent(new CustomEvent('close', { bubbles: true }));
            }
            focusManager.pop();
          }}
        >
          ×
        </button>
      </div>
      <div id="${id}-content" class="modal-body">
        ${content}
      </div>
      ${actions ? html`<div class="modal-footer">${actions}</div>` : ''}
    </div>
  `;
}

/**
 * Create skip navigation link
 */
// CR-Apr24-I finding 333: default changed from 'main' to 'main-content'
// to match the live app shell's <main id="main-content">.
export function skipNavigation(targetId: string = 'main-content'): LitTemplate {
  return html`
    <a
      href="#${targetId}"
      class="skip-nav"
      @click=${(e: Event) => {
        e.preventDefault();
        const target = document.getElementById(targetId);
        if (target) {
          // CR-Apr24-I finding 341: ensure the target is programmatically
          // focusable — non-interactive elements like <main> need tabindex.
          if (!target.hasAttribute('tabindex')) {
            target.setAttribute('tabindex', '-1');
          }
          target.focus();
          target.scrollIntoView();
        }
      }}
    >
      Skip to main content
    </a>
  `;
}

// ==========================================
// COLOR CONTRAST CHECKER
// ==========================================

/**
 * Check color contrast ratio for WCAG compliance
 */
export function checkContrast(
  foreground: string,
  background: string
): {
  ratio: number;
  aa: boolean;
  aaa: boolean;
  largeAA: boolean;
  largeAAA: boolean;
} {
  // Convert colors to RGB
  // CR-Apr24-I finding 335: return NaN-based ratio for unsupported formats
  // so callers can detect the failure instead of getting misleading results.
  const fg = hexToRgb(foreground);
  const bg = hexToRgb(background);
  if (!fg || !bg) {
    return { ratio: NaN, aa: false, aaa: false, largeAA: false, largeAAA: false };
  }

  // Calculate relative luminance
  const fgLum = relativeLuminance(fg);
  const bgLum = relativeLuminance(bg);
  
  // Calculate contrast ratio
  const ratio = (Math.max(fgLum, bgLum) + 0.05) / (Math.min(fgLum, bgLum) + 0.05);
  
  return {
    ratio,
    aa: ratio >= 4.5,        // Normal text AA
    aaa: ratio >= 7,         // Normal text AAA
    largeAA: ratio >= 3,     // Large text AA
    largeAAA: ratio >= 4.5   // Large text AAA
  };
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  // CR-Apr24-I finding 335: support 3-digit hex (#fff) and return null
  // for unsupported formats instead of silently treating them as black.
  const short = /^#?([a-f\d])([a-f\d])([a-f\d])$/i.exec(hex);
  if (short) {
    return {
      r: parseInt((short[1] ?? '0') + (short[1] ?? '0'), 16),
      g: parseInt((short[2] ?? '0') + (short[2] ?? '0'), 16),
      b: parseInt((short[3] ?? '0') + (short[3] ?? '0'), 16)
    };
  }
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (result) {
    return {
      r: parseInt(result[1] ?? '0', 16),
      g: parseInt(result[2] ?? '0', 16),
      b: parseInt(result[3] ?? '0', 16)
    };
  }
  return null;
}

function relativeLuminance(rgb: { r: number; g: number; b: number }): number {
  const { r, g, b } = rgb;
  const rsRGB = r / 255;
  const gsRGB = g / 255;
  const bsRGB = b / 255;
  
  const rL = rsRGB <= 0.03928 ? rsRGB / 12.92 : Math.pow((rsRGB + 0.055) / 1.055, 2.4);
  const gL = gsRGB <= 0.03928 ? gsRGB / 12.92 : Math.pow((gsRGB + 0.055) / 1.055, 2.4);
  const bL = bsRGB <= 0.03928 ? bsRGB / 12.92 : Math.pow((bsRGB + 0.055) / 1.055, 2.4);
  
  return 0.2126 * rL + 0.7152 * gL + 0.0722 * bL;
}
