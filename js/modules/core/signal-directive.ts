/**
 * Signal Directive for lit-html
 * Automatically subscribes to signals and triggers re-renders
 *
 * This directive allows using @preact/signals-core signals directly
 * in lit-html templates with automatic re-rendering when values change.
 *
 * @module signal-directive
 */
'use strict';

import { AsyncDirective, directive } from 'lit-html/async-directive.js';
import type { DirectiveResult, PartInfo, PartType } from 'lit-html/directive.js';
import { effect } from '@preact/signals-core';
import type { Signal, ReadonlySignal } from '@preact/signals-core';

/**
 * Signal directive class that subscribes to signal changes
 * and updates the lit-html part when the signal value changes.
 */
class SignalDirective extends AsyncDirective {
  private cleanup?: () => void;
  private _connected = true;

  /**
   * Initial render - just return the signal's current value
   */
  render<T>(sig: Signal<T> | ReadonlySignal<T>): T {
    return sig.value;
  }

  /**
   * Called when the directive is connected to the DOM
   * Sets up the signal subscription
   */
  override reconnected(): void {
    this._connected = true;
  }

  /**
   * Called when the directive is disconnected from the DOM
   * Cleans up the signal subscription to prevent memory leaks
   */
  override disconnected(): void {
    this._connected = false;
    if (this.cleanup) {
      this.cleanup();
      this.cleanup = undefined;
    }
  }

  /**
   * Called on updates after initial render
   * Sets up the effect to react to signal changes
   */
  override update<T>(
    _part: unknown,
    [sig]: [Signal<T> | ReadonlySignal<T>]
  ): T {
    // Clean up any existing subscription
    if (this.cleanup) {
      this.cleanup();
    }

    // Set up new effect to track signal changes
    this.cleanup = effect(() => {
      // Read the signal value to establish tracking
      const value = sig.value;

      // Only setValue if we're connected (after initial render)
      if (this._connected) {
        this.setValue(value);
      }
    });

    return sig.value;
  }
}

/**
 * Directive function for using signals in lit-html templates
 *
 * @example
 * ```typescript
 * import { currentMonthTotals } from './signals.js';
 * import { sig } from './signal-directive.js';
 *
 * const template = html`
 *   <div>Income: ${sig(currentMonthTotals).income}</div>
 * `;
 * ```
 *
 * Note: For computed values derived from signals, create a computed
 * signal first and pass it to sig():
 *
 * @example
 * ```typescript
 * import { computed } from '@preact/signals-core';
 * import { currentMonthTotals, currency } from './signals.js';
 * import { sig } from './signal-directive.js';
 *
 * const formattedIncome = computed(() =>
 *   `${currency.value.symbol}${currentMonthTotals.value.income.toFixed(2)}`
 * );
 *
 * const template = html`<div>Income: ${sig(formattedIncome)}</div>`;
 * ```
 */
export const sig = directive(SignalDirective);

/**
 * Type helper for the sig directive result
 */
export type SigDirectiveResult<T> = DirectiveResult<typeof SignalDirective>;

/**
 * Helper function to create a reactive text binding
 * Useful when you want to map a signal value to a string
 *
 * @example
 * ```typescript
 * import { computed } from '@preact/signals-core';
 * const greeting = computed(() => `Hello, ${userName.value}!`);
 * html`<h1>${sig(greeting)}</h1>`
 * ```
 *
 * Note: For transformations, create a computed signal externally
 * rather than using an inline transform. This is more efficient
 * and type-safe.
 */
export function sigValue<T>(signal: Signal<T> | ReadonlySignal<T>): T {
  return signal.value;
}
