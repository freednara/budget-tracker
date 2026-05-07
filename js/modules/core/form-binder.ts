/**
 * Form Binder Utility
 * 
 * Eliminates repetitive DOM-to-Signal boilerplate by automatically
 * binding form inputs to signals with two-way data binding.
 * 
 * @module form-binder
 */

import { Signal, effect } from '@preact/signals-core';
import { debounce, formatDateForInput, parseAmount, fmtCur } from './utils-pure.js';
import DOM from './dom-cache.js';
import { validator } from './validator.js';

// ==========================================
// TYPE DEFINITIONS
// ==========================================

type InputElement = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

interface BindingOptions {
  /** Debounce delay in ms for input events */
  debounce?: number;
  /** Transform value from DOM to signal */
  parse?: (value: string) => unknown;
  /** Transform value from signal to DOM */
  format?: (value: unknown) => string;
  /** Validate on change */
  validate?: (value: unknown) => boolean | string;
  /** Event to listen for (default: 'input') */
  event?: 'input' | 'change' | 'blur';
  /** Two-way binding (default: true) */
  twoWay?: boolean;
}

interface FormBinding {
  element: InputElement;
  signal: Signal<unknown>;
  options: BindingOptions;
  cleanup: () => void;
}

// ==========================================
// FORM BINDER CLASS
// ==========================================

export class FormBinder {
  private bindings = new Map<string, FormBinding>();
  private validationErrors = new Map<string, string>();
  
  /**
   * Bind a form element to a signal
   */
  bind<T>(
    elementOrId: string | InputElement,
    signal: Signal<T>,
    options: BindingOptions = {}
  ): () => void {
    // Get element
    const element = typeof elementOrId === 'string'
      ? DOM.get(elementOrId) as InputElement
      : elementOrId;
    
    if (!element) {
      if (import.meta.env.DEV) console.warn(`FormBinder: Element ${elementOrId} not found`);
      return () => {};
    }
    
    const id = element.id || `binding_${Date.now()}`;
    
    // Set defaults
    const bindingOptions: BindingOptions = {
      event: 'input',
      twoWay: true,
      ...options
    };
    
    // Create event handler
    const updateSignal = bindingOptions.debounce
      ? debounce(this.createUpdateHandler(element, signal, bindingOptions), bindingOptions.debounce)
      : this.createUpdateHandler(element, signal, bindingOptions);
    
    // Add event listener
    element.addEventListener(bindingOptions.event!, updateSignal);
    
    // Setup two-way binding
    let effectCleanup: (() => void) | null = null;
    
    if (bindingOptions.twoWay) {
      effectCleanup = effect(() => {
        const value = signal.value;

        // CR-Apr24-I finding 233: checkbox signal→DOM must write .checked,
        // not .value, so two-way binding actually reflects the boolean.
        if (element.getAttribute('type') === 'checkbox') {
          (element as HTMLInputElement).checked = !!value;
          return;
        }

        // CR-Apr24-I finding 252: <select multiple> signal→DOM must set
        // selectedOptions, not .value (which only handles single selects).
        if (element.tagName === 'SELECT' && (element as HTMLSelectElement).multiple) {
          const selectedValues = Array.isArray(value) ? value.map(String) : [];
          const options = (element as HTMLSelectElement).options;
          for (let i = 0; i < options.length; i++) {
            const opt = options[i];
            if (opt) opt.selected = selectedValues.includes(opt.value);
          }
          return;
        }

        const formatted = bindingOptions.format
          ? bindingOptions.format(value)
          : String(value ?? '');

        if (element.value !== formatted) {
          element.value = formatted;
        }
      });
    }
    
    // Store binding
    const cleanup = () => {
      element.removeEventListener(bindingOptions.event!, updateSignal);
      effectCleanup?.();
      this.bindings.delete(id);
      this.validationErrors.delete(id);
    };
    
    this.bindings.set(id, {
      element,
      signal,
      options: bindingOptions,
      cleanup
    });
    
    // Initial sync from signal to element
    // CR-Apr24-I findings 233+252: route initial sync through the same
    // type-aware paths as the effect above.
    if (bindingOptions.twoWay) {
      const value = signal.value;
      if (element.getAttribute('type') === 'checkbox') {
        (element as HTMLInputElement).checked = !!value;
      } else if (element.tagName === 'SELECT' && (element as HTMLSelectElement).multiple) {
        const selectedValues = Array.isArray(value) ? value.map(String) : [];
        const options = (element as HTMLSelectElement).options;
        for (let i = 0; i < options.length; i++) {
          const opt = options[i];
          if (opt) opt.selected = selectedValues.includes(opt.value);
        }
      } else {
        element.value = bindingOptions.format
          ? bindingOptions.format(value)
          : String(value ?? '');
      }
    }
    
    return cleanup;
  }
  
  /**
   * Create update handler for DOM -> Signal
   */
  private createUpdateHandler<T>(
    element: InputElement,
    signal: Signal<T>,
    options: BindingOptions
  ): (...args: unknown[]) => unknown {
    return (...args: unknown[]) => {
      const event = args[0] as Event;
      const rawValue = (event.target as InputElement).value;
      
      // Parse value
      const parsedValue = options.parse 
        ? options.parse(rawValue)
        : this.autoParseValue(element, rawValue);
      
      // Validate if validator provided
      if (options.validate) {
        const result = options.validate(parsedValue);
        
        if (typeof result === 'string') {
          // Validation failed with error message
          this.setError(element, result);
          return;
        } else if (result === false) {
          // Validation failed
          this.setError(element, 'Invalid value');
          return;
        } else {
          // Validation passed
          this.clearError(element);
        }
      }
      
      // Update signal
      signal.value = parsedValue as T;
    };
  }
  
  /**
   * Auto-parse value based on input type
   * FIXED: Uses attribute checks instead of instanceof for better cross-context reliability
   */
  private autoParseValue(element: InputElement, value: string): unknown {
    const type = element.getAttribute('type');
    
    // Handle checkbox
    if (type === 'checkbox') {
      return (element as HTMLInputElement).checked;
    }
    
    // Handle number input
    if (type === 'number') {
      const num = parseFloat(value);
      return isNaN(num) ? 0 : num;
    }
    
    // Handle date input
    if (type === 'date') {
      return value || null;
    }
    
    // Handle select multiple
    if (element.tagName === 'SELECT' && (element as HTMLSelectElement).multiple) {
      return Array.from((element as HTMLSelectElement).selectedOptions).map(opt => opt.value);
    }
    
    // Default to string
    return value;
  }
  
  /**
   * Set validation error on element
   * FIXED: Delegates to central validator for UI consistency
   */
  private setError(element: InputElement, message: string): void {
    const id = element.id || 'element';
    this.validationErrors.set(id, message);
    validator.showFieldError(element, message);
  }
  
  /**
   * Clear validation error
   * FIXED: Delegates to central validator for UI consistency
   */
  private clearError(element: InputElement): void {
    const id = element.id || 'element';
    this.validationErrors.delete(id);
    validator.clearFieldError(element);
  }
  
  /**
   * Bind multiple form elements at once
   */
  bindForm(
    formId: string,
    bindings: Record<string, { signal: Signal<unknown>; options?: BindingOptions }>
  ): () => void {
    const form = DOM.get(formId) as HTMLFormElement;
    if (!form) {
      if (import.meta.env.DEV) console.warn(`FormBinder: Form ${formId} not found`);
      return () => {};
    }
    
    const cleanups: Array<() => void> = [];
    
    for (const [elementId, config] of Object.entries(bindings)) {
      const element = form.querySelector(`#${elementId}`) as InputElement;
      if (element) {
        const cleanup = this.bind(element, config.signal, config.options);
        cleanups.push(cleanup);
      }
    }
    
    // Return combined cleanup
    return () => {
      cleanups.forEach(cleanup => cleanup());
    };
  }
  
  /**
   * Get all current validation errors
   */
  getErrors(): Map<string, string> {
    return new Map(this.validationErrors);
  }
  
  /**
   * Check if form is valid
   */
  isValid(): boolean {
    return this.validationErrors.size === 0;
  }

  /**
   * CR-Apr24-I finding 247: actively run all bound validators and return
   * true only if every binding passes. Unlike isValid(), this forces
   * validation on untouched fields.
   */
  validateAll(): boolean {
    for (const [, binding] of this.bindings) {
      if (binding.options.validate) {
        const value = binding.signal.value;
        const result = binding.options.validate(value);
        if (result === false) {
          this.setError(binding.element, 'Invalid value');
        } else if (typeof result === 'string') {
          this.setError(binding.element, result);
        } else {
          this.clearError(binding.element);
        }
      }
    }
    return this.validationErrors.size === 0;
  }
  
  /**
   * Clear all bindings
   */
  clear(): void {
    for (const binding of this.bindings.values()) {
      binding.cleanup();
    }
    this.bindings.clear();
    this.validationErrors.clear();
  }
}

// ==========================================
// CONVENIENCE FUNCTIONS
// ==========================================

/**
 * Create a form binder instance
 */
export function createFormBinder(): FormBinder {
  return new FormBinder();
}

/**
 * Quick bind single element (uses module-level singleton to avoid creating
 * a new FormBinder instance on every call)
 */
export function bindInput<T>(
  elementOrId: string | InputElement,
  signal: Signal<T>,
  options?: BindingOptions
): () => void {
  return formBinder.bind(elementOrId, signal, options);
}

/**
 * Bind form with validation
 */
export function bindFormWithValidation(
  formId: string,
  bindings: Record<string, {
    signal: Signal<unknown>;
    validate?: (value: unknown) => boolean | string;
    options?: BindingOptions;
  }>
): {
  cleanup: () => void;
  validate: () => boolean;
  getErrors: () => Map<string, string>;
} {
  const binder = new FormBinder();
  
  // Create bindings with validation
  const bindingsWithValidation = Object.entries(bindings).reduce(
    (acc, [id, config]) => ({
      ...acc,
      [id]: {
        signal: config.signal,
        options: {
          ...config.options,
          validate: config.validate
        }
      }
    }),
    {}
  );
  
  const cleanup = binder.bindForm(formId, bindingsWithValidation);
  
  return {
    cleanup,
    // CR-Apr24-I finding 247: actively run validators on all bindings
    // instead of just reading the stale error map. Without this, an
    // untouched form with invalid required fields reports valid.
    validate: () => binder.validateAll(),
    getErrors: () => binder.getErrors()
  };
}

// ==========================================
// PRESET PARSERS AND FORMATTERS
// ==========================================

export const Parsers = {
  /**
   * Parse currency amount — locale-aware via `parseAmount` / localeService
   * (M9, Inline-Behavior-Review rev 12). The prior inline `$,`-strip +
   * `parseFloat` pattern assumed en-US formatting and silently mis-parsed
   * "1,50" (de-DE) as 1 instead of 1.50. `parseAmount` routes through
   * `localeService.parseCurrency`, handles configured decimal/thousands
   * separators, rejects negatives, and rounds to cents precision.
   */
  currency: (value: string): number => {
    return parseAmount(value);
  },
  
  /** Parse integer */
  int: (value: string): number => {
    const num = parseInt(value, 10);
    return isNaN(num) ? 0 : num;
  },
  
  /** Parse float */
  float: (value: string): number => {
    const num = parseFloat(value);
    return isNaN(num) ? 0 : num;
  },
  
  /** Parse boolean from string */
  bool: (value: string): boolean => {
    return value === 'true' || value === '1' || value === 'yes';
  },
  
  /** Parse tags from comma-separated string */
  tags: (value: string): string[] => {
    return value
      .split(',')
      .map(tag => tag.trim())
      .filter(tag => tag.length > 0);
  }
};

export const Formatters = {
  /** Format currency */
  currency: (value: number): string => {
    // Route through fmtCur so form-binder's currency formatter respects the
    // app's configured currency symbol + locale (was hardcoded '$' prefix).
    return fmtCur(value || 0);
  },
  
  /** Format percentage */
  percent: (value: number): string => {
    return `${(value * 100).toFixed(0)}%`;
  },
  
  /** Format date */
  date: (value: Date | string | null): string => {
    if (!value) return '';
    // CR-Apr24-I finding 253: `new Date('YYYY-MM-DD')` parses as UTC midnight.
    // In negative-UTC-offset timezones, local-time getters then roll back a day.
    // Append 'T00:00:00' to date-only strings to force local-time parsing.
    // See ADR-001 §9.5 Step 8.
    let date: Date;
    if (typeof value === 'string') {
      // Only append for bare date strings (YYYY-MM-DD), not full ISO timestamps
      const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00` : value;
      date = new Date(normalized);
    } else {
      date = value;
    }
    return formatDateForInput(date);
  },
  
  /** Format tags array */
  tags: (value: string[]): string => {
    return (value || []).join(', ');
  }
};

// ==========================================
// GLOBAL INSTANCE
// ==========================================

// Export singleton for convenience
export const formBinder = new FormBinder();