/**
 * Lit-html Helpers Module
 *
 * Central re-exports and utilities for lit-html templating.
 * Provides a consistent import point for all lit-html functionality.
 *
 * @module lit-helpers
 */
'use strict';

import { html, svg, render, nothing, type TemplateResult } from 'lit-html';
import { repeat } from 'lit-html/directives/repeat.js';
import { classMap } from 'lit-html/directives/class-map.js';
import { styleMap } from 'lit-html/directives/style-map.js';
import { unsafeHTML } from 'lit-html/directives/unsafe-html.js';
import { unsafeSVG } from 'lit-html/directives/unsafe-svg.js';
import { ifDefined } from 'lit-html/directives/if-defined.js';

// Re-export core lit-html functions
export { html, svg, render, nothing, repeat, classMap, styleMap, unsafeHTML, unsafeSVG, ifDefined };

// Re-export types
export type { TemplateResult };

/**
 * Type for lit-html template results, including nothing
 */
export type LitTemplate = TemplateResult | typeof nothing;

/**
 * Helper for conditional rendering
 * Returns trueValue when condition is true, otherwise returns falseValue (defaults to nothing)
 *
 * @example
 * html`${when(isActive, html`<span>Active</span>`)}`
 * html`${when(hasError, html`<span class="error">Error</span>`, html`<span>OK</span>`)}`
 */
export function when<T>(
  condition: boolean,
  trueValue: T,
  falseValue: T | typeof nothing = nothing
): T | typeof nothing {
  return condition ? trueValue : falseValue;
}

/**
 * Helper for rendering a list with optional empty state
 * Returns nothing if the list is empty, otherwise renders the template for each item
 *
 * @example
 * html`${renderList(items, item => item.id, item => html`<div>${item.name}</div>`)}`
 */
export function renderList<T>(
  items: T[],
  keyFn: (item: T) => unknown,
  template: (item: T, index: number) => TemplateResult
): TemplateResult | typeof nothing {
  if (items.length === 0) return nothing;
  return html`${repeat(items, keyFn, template)}`;
}

/**
 * Helper for joining templates with a separator
 *
 * @example
 * html`${join(items.map(i => html`<span>${i}</span>`), html`, `)}`
 */
export function join(
  templates: TemplateResult[],
  separator: TemplateResult | string = html`, `
): TemplateResult {
  return html`${templates.map((t, i) => i > 0 ? html`${separator}${t}` : t)}`;
}

/**
 * Mount multiple sub-components and return a single cleanup function.
 * Eliminates the repeated "collect cleanups in array, return dispose" boilerplate.
 *
 * @example
 * export function mountDailyAllowance(): () => void {
 *   return mountAll(mountHeroCard, mountTodayBudget, mountMonthlyPace);
 * }
 */
export function mountAll(...mountFns: Array<() => (() => void)>): () => void {
  const cleanups = mountFns.map(fn => fn());
  return () => { cleanups.forEach(c => c()); };
}
