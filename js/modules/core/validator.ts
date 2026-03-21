/**
 * Input Validation Module
 * Provides comprehensive validation for all user inputs
 *
 * @module validator
 */

import DOM from './dom-cache.js';
import { sanitize, esc } from './utils-pure.js';
import type {
  Transaction,
  ValidationRules,
  ValidationResult,
  TextFieldType,
  ValidationFieldType,
  TransactionValidationResult,
  ImportValidationResult,
  ImportValidationError
} from '../../types/index.js';

// ==========================================
// VALIDATOR CLASS
// ==========================================

class Validator {
  private rules: ValidationRules;
  // Pre-compiled regexes for performance (avoid re-creation on every call)
  private readonly dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  private readonly legacyShaRegex = /^[0-9a-f]{64}$/;

  constructor() {
    this.rules = {
      amount: {
        min: 0.01,
        max: 999999.99,
        pattern: /^\d+(\.\d{0,2})?$/,
        message: 'Amount must be between $0.01 and $999,999.99'
      },
      description: {
        maxLength: 500,
        // Allow < and > for mathematical expressions, comparisons, etc.
        // HTML escaping happens at render time via esc()
        pattern: /^[\s\S]*$/,  // Allow all characters
        message: 'Description is too long (max 500 characters)'
      },
      notes: {
        maxLength: 500,
        // Allow < and > for mathematical expressions, comparisons, etc.
        // HTML escaping happens at render time via esc()
        pattern: /^[\s\S]*$/,  // Allow all characters
        message: 'Notes are too long (max 500 characters)'
      },
      tags: {
        maxLength: 200,
        // Allow < and > in tags as well
        // HTML escaping happens at render time via esc()
        pattern: /^[\s\S]*$/,  // Allow all characters
        message: 'Tags are too long (max 200 characters)'
      },
      date: {
        min: '1900-01-01',
        max: '2100-12-31',
        message: 'Date must be between 1900 and 2100'
      },
      pin: {
        pattern: /^\d{4,6}$/,
        message: 'PIN must be 4-6 digits'
      }
    };
  }

  /**
   * Validate amount input
   */
  validateAmount(value: string | number): ValidationResult<number> {
    const strValue = String(value).trim();

    // Remove currency symbols and commas
    const cleanValue = strValue.replace(/[$,]/g, '');

    // Check if empty
    if (!cleanValue) {
      return { valid: false, error: 'Amount is required' };
    }

    // Check pattern
    if (!this.rules.amount.pattern.test(cleanValue)) {
      return { valid: false, error: 'Invalid amount format' };
    }

    const numValue = parseFloat(cleanValue);

    // Check if valid number
    if (isNaN(numValue)) {
      return { valid: false, error: 'Amount must be a number' };
    }

    // Check range
    if (numValue < this.rules.amount.min || numValue > this.rules.amount.max) {
      return { valid: false, error: this.rules.amount.message };
    }

    return { valid: true, value: numValue };
  }

  /**
   * Validate text input (description, notes, tags)
   */
  validateText(value: string | null | undefined, type: TextFieldType): ValidationResult<string> {
    const rule = this.rules[type];
    if (!rule) {
      return { valid: false, error: `Unknown field type: ${type}` };
    }

    const strValue = String(value || '').trim();

    // Check length
    if (strValue.length > rule.maxLength) {
      return {
        valid: false,
        error: `${type} must be ${rule.maxLength} characters or less`
      };
    }

    // Check for HTML tags
    if (!rule.pattern.test(strValue)) {
      return { valid: false, error: rule.message };
    }

    // Sanitize the value
    const sanitized = this.sanitizeText(strValue);

    return { valid: true, value: sanitized };
  }

  /**
   * Validate date input
   */
  validateDate(value: string): ValidationResult<string> {
    const strValue = String(value).trim();

    if (!strValue) {
      return { valid: false, error: 'Date is required' };
    }

    // Check format (YYYY-MM-DD) - uses pre-compiled regex
    if (!this.dateRegex.test(strValue)) {
      return { valid: false, error: 'Invalid date format' };
    }

    const date = new Date(strValue + 'T00:00:00');

    // Check if valid date
    if (isNaN(date.getTime())) {
      return { valid: false, error: 'Invalid date' };
    }

    // Check range
    const minDate = new Date(this.rules.date.min);
    const maxDate = new Date(this.rules.date.max);

    if (date < minDate || date > maxDate) {
      return { valid: false, error: this.rules.date.message };
    }

    return { valid: true, value: strValue };
  }

  /**
   * Validate PIN
   */
  validatePin(value: string): ValidationResult<string> {
    const strValue = String(value).trim();

    if (!strValue) {
      return { valid: true, value: '' }; // PIN is optional
    }

    if (!this.rules.pin.pattern.test(strValue)) {
      return { valid: false, error: this.rules.pin.message };
    }

    return { valid: true, value: strValue };
  }

  /**
   * Sanitize text input
   * FIXED: Uses robust sanitization to prevent XSS while allowing safe characters.
   */
  sanitizeText(text: string): string {
    if (!text) return '';
    // 1. Trim whitespace
    let sanitized = text.trim();
    // 2. Strip dangerous HTML tags/attributes (esc() is applied at render time by Lit)
    sanitized = sanitize(sanitized);
    // 3. Length limit safety (redundant but good for defense-in-depth)
    return sanitized.slice(0, 1000);
  }

  /**
   * Validate transaction object
   */
  validateTransaction(transaction: Partial<Transaction>): TransactionValidationResult {
    const errors: Record<string, string> = {};
    const sanitized: Partial<Transaction> = { ...transaction };

    // Validate amount
    const amountResult = this.validateAmount(transaction.amount ?? '');
    if (!amountResult.valid) {
      errors.amount = amountResult.error;
    } else {
      sanitized.amount = amountResult.value;
    }

    // Validate date
    const dateResult = this.validateDate(transaction.date ?? '');
    if (!dateResult.valid) {
      errors.date = dateResult.error;
    } else {
      sanitized.date = dateResult.value;
    }

    // Validate description
    if (transaction.description) {
      const descResult = this.validateText(transaction.description, 'description');
      if (!descResult.valid) {
        errors.description = descResult.error;
      } else {
        sanitized.description = descResult.value;
      }
    }

    // Validate notes
    if (transaction.notes) {
      const notesResult = this.validateText(transaction.notes, 'notes');
      if (!notesResult.valid) {
        errors.notes = notesResult.error;
      } else {
        sanitized.notes = notesResult.value;
      }
    }

    // Validate tags
    if (transaction.tags) {
      const tagsResult = this.validateText(transaction.tags, 'tags');
      if (!tagsResult.valid) {
        errors.tags = tagsResult.error;
      } else {
        sanitized.tags = tagsResult.value;
      }
    }

    // Validate type
    if (!transaction.type || !['income', 'expense'].includes(transaction.type)) {
      errors.type = 'Invalid transaction type';
    }

    // Validate category
    if (!transaction.category) {
      errors.category = 'Category is required';
    }

    return {
      valid: Object.keys(errors).length === 0,
      errors,
      sanitized
    };
  }

  /**
   * Validate import data
   */
  validateImportData(data: unknown[]): ImportValidationResult {
    const valid: Transaction[] = [];
    const invalid: unknown[] = [];
    const errors: ImportValidationError[] = [];

    data.forEach((item, index) => {
      const result = this.validateTransaction(item as Partial<Transaction>);
      if (result.valid) {
        valid.push(result.sanitized as Transaction);
      } else {
        invalid.push(item);
        errors.push({
          index,
          item,
          errors: result.errors
        });
      }
    });

    return { valid, invalid, errors };
  }

  /**
   * Show validation error on form field
   */
  showFieldError(element: HTMLElement | null, message: string): void {
    if (!element) return;

    element.classList.add('error');
    element.setAttribute('aria-invalid', 'true');

    const parent = element.parentElement;
    if (!parent) return;

    let errorEl = parent.querySelector('.error-message') as HTMLElement | null;
    if (!errorEl) {
      errorEl = document.createElement('span');
      errorEl.className = 'error-message text-xs';
      errorEl.style.color = 'var(--color-expense)';
      parent.appendChild(errorEl);
    }

    errorEl.textContent = message;
    errorEl.style.display = 'block';
  }

  /**
   * Clear validation error from form field
   */
  clearFieldError(element: HTMLElement | null): void {
    if (!element) return;

    element.classList.remove('error');
    element.setAttribute('aria-invalid', 'false');

    const parent = element.parentElement;
    if (!parent) return;

    const errorEl = parent.querySelector('.error-message') as HTMLElement | null;
    if (errorEl) {
      errorEl.remove();
    }
  }

  /**
   * Add real-time validation to form element
   */
  addRealtimeValidation(element: HTMLInputElement | null, type: ValidationFieldType): void {
    if (!element) return;

    element.addEventListener('input', () => {
      let result: ValidationResult<string | number>;

      switch (type) {
        case 'amount':
          result = this.validateAmount(element.value);
          break;
        case 'date':
          result = this.validateDate(element.value);
          break;
        case 'description':
        case 'notes':
        case 'tags':
          result = this.validateText(element.value, type);
          break;
        case 'pin':
          result = this.validatePin(element.value);
          break;
        default:
          return;
      }

      if (result.valid) {
        this.clearFieldError(element);
      } else {
        this.showFieldError(element, result.error);
      }
    });

    // Also validate on blur
    element.addEventListener('blur', () => {
      element.dispatchEvent(new Event('input'));
    });
  }
}

// ==========================================
// SINGLETON INSTANCE
// ==========================================

const validator = new Validator();

// Validation styles are defined in style.css (not injected from JS)
// See: input.error, .field-error, [aria-invalid="true"] rules in style.css

// ==========================================
// STANDALONE EXPORTS FOR TESTING
// These wrap class methods to provide a simpler API for unit tests
// ==========================================

export const validateAmount = (value: string | number) => validator.validateAmount(value);
export const validateDate = (value: string) => validator.validateDate(value);
export const validateText = (value: string | null | undefined, type: TextFieldType) => validator.validateText(value, type);
export const validateTransaction = (transaction: Partial<Transaction>) => validator.validateTransaction(transaction);
export const validateImportData = (data: unknown[]) => validator.validateImportData(data);

// ==========================================
// FIELD ERROR UI UTILITIES
// Shared by any form that needs validation feedback
// ==========================================

import DOMCache from './dom-cache.js';

/**
 * Show validation error on a form field.
 * Sets aria-invalid, adds .error class, and creates/updates an error message span.
 */
export function setFieldError(fieldName: string, message: string): void {
  const fieldEl = DOMCache.get(fieldName) as HTMLInputElement | null;
  if (!fieldEl) return;

  fieldEl.setAttribute('aria-invalid', 'true');
  fieldEl.classList.add('error');

  let errorEl = fieldEl.parentElement?.querySelector('.error-message') as HTMLElement;
  if (!errorEl) {
    errorEl = document.createElement('span');
    errorEl.className = 'error-message text-xs';
    errorEl.style.color = 'var(--color-expense)';
    fieldEl.parentElement?.appendChild(errorEl);
  }
  errorEl.textContent = message;
}

/**
 * Clear validation error from a form field.
 */
export function clearFieldError(fieldName: string): void {
  const fieldEl = DOMCache.get(fieldName) as HTMLInputElement | null;
  if (!fieldEl) return;

  fieldEl.setAttribute('aria-invalid', 'false');
  fieldEl.classList.remove('error');

  const errorEl = fieldEl.parentElement?.querySelector('.error-message');
  if (errorEl) errorEl.remove();
}

export default validator;
export { validator };
