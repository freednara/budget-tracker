/**
 * Form Binder Utility
 * 
 * Eliminates repetitive DOM-to-Signal boilerplate by automatically
 * binding form inputs to signals with two-way data binding.
 * 
 * @module form-binder
 */

import { Signal, effect, batch } from '@preact/signals-core';
import { debounce } from './utils.js';
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
  parse?: (value: string) => any;
  /** Transform value from signal to DOM */
  format?: (value: any) => string;
  /** Validate on change */
  validate?: (value: any) => boolean | string;
  /** Event to listen for (default: 'input') */
  event?: 'input' | 'change' | 'blur';
  /** Two-way binding (default: true) */
  twoWay?: boolean;
}

interface FormBinding {
  element: InputElement;
  signal: Signal<any>;
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
    if (bindingOptions.twoWay) {
      const value = signal.value;
      element.value = bindingOptions.format 
        ? bindingOptions.format(value)
        : String(value ?? '');
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
  private autoParseValue(element: InputElement, value: string): any {
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
    bindings: Record<string, { signal: Signal<any>; options?: BindingOptions }>
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
    signal: Signal<any>;
    validate?: (value: any) => boolean | string;
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
    validate: () => binder.isValid(),
    getErrors: () => binder.getErrors()
  };
}

// ==========================================
// PRESET PARSERS AND FORMATTERS
// ==========================================

export const Parsers = {
  /** Parse currency amount (removes $ and ,) */
  currency: (value: string): number => {
    const cleaned = value.replace(/[$,]/g, '');
    const num = parseFloat(cleaned);
    return isNaN(num) ? 0 : num;
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
    return `$${(value || 0).toFixed(2)}`;
  },
  
  /** Format percentage */
  percent: (value: number): string => {
    return `${(value * 100).toFixed(0)}%`;
  },
  
  /** Format date */
  date: (value: Date | string | null): string => {
    if (!value) return '';
    const date = typeof value === 'string' ? new Date(value) : value;
    return date.toISOString().split('T')[0];
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