/**
 * Input Validation Module
 * Provides comprehensive validation for all user inputs
 *
 * @module validator
 */

import DOM from './dom-cache.js';
import type {
  Transaction,
  ValidationRules,
  ValidationResult,
  TextFieldType,
  ValidationFieldType,
  TransactionValidationResult,
  ImportValidationResult,
  ImportValidationError
} from '../types/index.js';

// ==========================================
// VALIDATOR CLASS
// ==========================================

class Validator {
  private rules: ValidationRules;

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
        pattern: /^[^<>]*$/,  // No HTML tags
        message: 'Description cannot contain HTML tags'
      },
      notes: {
        maxLength: 500,
        pattern: /^[^<>]*$/,
        message: 'Notes cannot contain HTML tags'
      },
      tags: {
        maxLength: 200,
        pattern: /^[^<>]*$/,
        message: 'Tags cannot contain HTML tags'
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

    // Check format (YYYY-MM-DD)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(strValue)) {
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
   *
   * Note: Only trim whitespace - HTML escaping is done at render time via esc().
   * Pattern validation in validateText() already rejects < and > characters.
   */
  sanitizeText(text: string): string {
    return String(text).trim();
  }

  /**
   * Escape HTML for safe display
   */
  escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
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

    // Add error styling
    element.classList.add('error');
    element.setAttribute('aria-invalid', 'true');

    // Find or create error message element
    const parent = element.parentElement;
    if (!parent) return;

    let errorEl = parent.querySelector('.field-error') as HTMLElement | null;
    if (!errorEl) {
      errorEl = document.createElement('div');
      errorEl.className = 'field-error';
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

    // Remove error styling
    element.classList.remove('error');
    element.removeAttribute('aria-invalid');

    // Hide error message
    const parent = element.parentElement;
    if (!parent) return;

    const errorEl = parent.querySelector('.field-error') as HTMLElement | null;
    if (errorEl) {
      errorEl.style.display = 'none';
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

// ==========================================
// VALIDATION STYLES
// ==========================================

if (!DOM.get('validator-styles')) {
  const style = document.createElement('style');
  style.id = 'validator-styles';
  style.textContent = `
    .field-error {
      color: var(--color-expense, #e74c3c);
      font-size: 12px;
      margin-top: 4px;
      display: none;
    }

    input.error,
    textarea.error,
    select.error {
      border-color: var(--color-expense, #e74c3c) !important;
      background-color: rgba(231, 76, 60, 0.05);
    }

    input.error:focus,
    textarea.error:focus,
    select.error:focus {
      outline-color: var(--color-expense, #e74c3c);
      box-shadow: 0 0 0 3px rgba(231, 76, 60, 0.1);
    }

    [aria-invalid="true"] {
      border-color: var(--color-expense, #e74c3c) !important;
    }
  `;
  document.head.appendChild(style);
}

// ==========================================
// STANDALONE EXPORTS FOR TESTING
// These wrap class methods to provide a simpler API for unit tests
// ==========================================

export const validateAmount = (value: string | number) => validator.validateAmount(value);
export const validateDate = (value: string) => validator.validateDate(value);
export const validateText = (value: string | null | undefined, type: TextFieldType) => validator.validateText(value, type);
export const validateTransaction = (transaction: Partial<Transaction>) => validator.validateTransaction(transaction);
export const validateImportData = (data: unknown[]) => validator.validateImportData(data);

export default validator;
export { validator };
