/**
 * Input Validation Module
 * Provides comprehensive validation for all user inputs
 *
 * @module validator
 */

// Phase 5g-1 (Inline-Behavior-Review rev 12, L51): consolidated the
// top-of-file `import DOM` (which had zero references) with the mid-file
// `import DOMCache` at the old line 414. Single canonical alias is
// `DOMCache`, matching the class-body idiom used by every other file
// in core/.
import { localeService } from './locale-service.js';
// Phase 5g-4 Slice 3 (Inline-Behavior-Review rev 12, L7): dropped the
// `{ sanitize, esc }` import from utils-pure. Background:
//   * `sanitize` was the regex-based HTML-tag stripper called only from
//     the now-deleted `sanitizeText` below. With the regex sanitizer
//     retired, its import no longer has a consumer here.
//   * `esc` was imported at the top of the file but only appeared in
//     comments ("HTML escaping still happens at render time via esc()").
//     Grep confirmed zero call sites in this module — it was a dead
//     import advertising a contract this file never exercised. Lit-html
//     templates perform their own auto-escaping at render time; the
//     validator does not need to import the escape helper to make that
//     true.
// If a future caller in validator.ts genuinely needs either helper,
// re-add a narrow import at that time rather than pre-importing on
// speculation.
import type {
  Transaction,
  ValidationRules,
  ValidationResult,
  TextFieldType,
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
        message: 'Enter an amount between $0.01 and $999,999.99 (e.g., 125.00). Zero or negative amounts can\'t be tracked.'
      },
      description: {
        maxLength: 500,
        // Allow printable characters, newlines, and tabs. Reject control chars
        // (\x00-\x08, \x0B, \x0C, \x0E-\x1F) as defense-in-depth.
        // HTML escaping still happens at render time via esc().
        pattern: /^[^\x00-\x08\x0B\x0C\x0E-\x1F]*$/,
        message: 'Keep descriptions under 500 characters. Control characters aren\'t allowed — stick to normal text, numbers, and punctuation.'
      },
      notes: {
        maxLength: 500,
        // Allow printable characters, newlines, and tabs. Reject control chars.
        // HTML escaping still happens at render time via esc().
        pattern: /^[^\x00-\x08\x0B\x0C\x0E-\x1F]*$/,
        message: 'Keep notes under 500 characters. Control characters aren\'t allowed — stick to normal text, numbers, and punctuation.'
      },
      tags: {
        maxLength: 200,
        // Allow printable characters, newlines, and tabs. Reject control chars.
        // HTML escaping still happens at render time via esc().
        pattern: /^[^\x00-\x08\x0B\x0C\x0E-\x1F]*$/,
        message: 'Keep tags under 200 characters. Control characters aren\'t allowed — use commas to separate multiple tags.'
      },
      date: {
        min: '1900-01-01',
        max: '2100-12-31',
        message: 'Enter a date between Jan 1900 and Dec 2100. Dates outside this range can\'t be stored reliably.'
      },
      pin: {
        pattern: /^\d{4,6}$/,
        message: 'PINs must be 4–6 digits, numbers only (e.g., 1234). Letters and symbols aren\'t supported.'
      }
    };
  }

  /**
   * Validate amount input.
   *
   * M9 (Inline-Behavior-Review rev 12) — this path is now locale-aware.
   * The prior implementation stripped `$` and `,` then pattern-matched
   * `^\d+(\.\d{0,2})?$`, which correctly handled en-US ($1,234.56) but
   * rejected every other locale's formatting:
   *   - "1.234,56"  (de-DE)        → rejected by pattern
   *   - "1 234,56"  (fr-FR)        → rejected (space not stripped)
   *   - "1'234.56"  (de-CH)        → rejected (apostrophe not stripped)
   * Switched to `localeService.parseNumber` which honors the active
   * `decimalSeparator` / `thousandsSeparator` settings, strips non-digit
   * residue, and returns `NaN` on unparseable input (M15 contract).
   * Range + NaN checks preserve every prior error branch; callers that
   * passed a numeric `value` still skip parsing.
   */
  validateAmount(value: string | number): ValidationResult<number> {
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        return { valid: false, error: 'Amount must be a valid number — remove any letters or extra symbols.' };
      }
      if (value < this.rules.amount.min || value > this.rules.amount.max) {
        return { valid: false, error: this.rules.amount.message };
      }
      return { valid: true, value };
    }

    const strValue = String(value).trim();

    if (!strValue) {
      return { valid: false, error: 'Amount is required — enter how much was spent or received.' };
    }

    // Locale-aware parse — NaN on empty-after-strip / non-numeric input.
    const numValue = localeService.parseNumber(strValue);

    if (!Number.isFinite(numValue)) {
      return { valid: false, error: 'Amount must be a valid number — remove any letters or extra symbols.' };
    }

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
        error: `${type} must be ${rule.maxLength} characters or fewer — shorten the text or split across multiple entries.`
      };
    }

    // Check for HTML tags
    if (!rule.pattern.test(strValue)) {
      return { valid: false, error: rule.message };
    }

    // Phase 5g-4 Slice 3 (Inline-Behavior-Review rev 12, L7): the
    // prior `this.sanitizeText(strValue)` call here was a three-layer
    // no-op by this point:
    //   1. trim() — already applied at line 120 (`String(value || '').trim()`)
    //   2. regex sanitize() — redundant with lit-html's render-time
    //      auto-escaping of interpolated values, and the regex itself
    //      had documented limits (DOM clobbering, mutation XSS,
    //      namespace tricks) per its own NOTE comment in utils-pure.
    //   3. slice(0, 1000) — redundant with the `rule.maxLength` check
    //      at line 123 (500 for description/notes, 200 for tags) which
    //      has already rejected any over-long input before we get here.
    // strValue is the authoritative post-validation value.
    return { valid: true, value: strValue };
  }

  /**
   * Validate date input
   */
  validateDate(value: string): ValidationResult<string> {
    const strValue = String(value).trim();

    if (!strValue) {
      return { valid: false, error: 'Date is required — pick when this transaction happened.' };
    }

    // Check format (YYYY-MM-DD) - uses pre-compiled regex
    if (!this.dateRegex.test(strValue)) {
      return { valid: false, error: 'Enter a date in YYYY-MM-DD format (e.g., 2026-04-04)' };
    }

    const date = new Date(strValue + 'T00:00:00');

    // Check if valid date
    if (isNaN(date.getTime())) {
      return { valid: false, error: 'That\u2019s not a valid calendar date \u2014 check the month and day.' };
    }

    // Round-trip YMD check: `new Date("2024-02-30T00:00:00")` silently overflows
    // to Mar 1 (valid Date, valid getTime) \u2014 the only way to reject impossible
    // calendar dates (Feb 30, Apr 31, non-leap Feb 29) is to compare the parsed
    // components back against the input. Fixes C12 (Inline-Behavior-Review rev 12).
    const [y, m, d] = strValue.split('-').map(Number);
    if (date.getFullYear() !== y || date.getMonth() + 1 !== m || date.getDate() !== d) {
      return { valid: false, error: 'That\u2019s not a valid calendar date \u2014 check the month and day.' };
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

  // Phase 5g-4 Slice 3 (Inline-Behavior-Review rev 12, L7): deleted the
  // `sanitizeText(text)` method that lived here. Context:
  //   * Grep across js/ + tests/ + e2e/ confirmed ZERO external callers —
  //     its only consumer was `validateText` (line ~136) internally.
  //   * Its three defensive layers were each already enforced upstream
  //     by `validateText` itself: (1) trim at line 120, (2) maxLength
  //     check at line 123 rejects anything longer than the rule allows,
  //     (3) pattern check at line 131 rejects control chars.
  //   * The middle `sanitize()` call was the only layer doing anything
  //     new — regex-stripping HTML tags — but lit-html templates
  //     auto-escape interpolated values at render time, so stripping
  //     tags here was redundant defense against a boundary (user input
  //     → DOM) that the template engine already owns. The regex
  //     sanitizer itself had documented limits (DOM clobbering,
  //     mutation XSS, namespace tricks) per its own NOTE comment and
  //     was a "safe facade" at best.
  //   * Same direction-reversal as the Phase 5g-3 Slices 4-7 dead-API
  //     deletions and the Phase 5g-4 Slice 2 inline-alerts host
  //     deletion: an API that advertises a contract its one caller
  //     doesn't need is strictly worse than no API at all.
  // If truly untrusted HTML ever needs rendering (currently nothing
  // does — all user text flows through lit-html text interpolation),
  // install DOMPurify rather than resurrecting a regex sanitizer.

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
      errors.type = 'Choose either "income" or "expense" as the transaction type.';
    }

    // Validate category
    if (!transaction.category) {
      errors.category = 'Category is required — pick one so the transaction shows up in reports.';
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
   * Show validation error on form field.
   *
   * CR-Apr24-I finding 315: the original implementation always created
   * or reused a sibling `.error-message` span under `element.parentElement`,
   * ignoring any prewired accessible error node linked via
   * `aria-describedby`. Screen readers were pointed at the hidden
   * original `role="alert"` node while the visible message appeared in
   * an anonymous span outside the field's accessible description.
   *
   * Fix: check `aria-describedby` first. If the attribute points to an
   * existing DOM node, use that node for the message text, ensuring the
   * screen reader and the visible UI surface are the same element. Fall
   * back to the old sibling-span path only when no prewired node exists
   * (e.g. dynamically generated fields with no HTML template).
   */
  showFieldError(element: HTMLElement | null, message: string): void {
    if (!element) return;

    element.classList.add('error');
    element.setAttribute('aria-invalid', 'true');

    // Prefer the prewired accessible error node (aria-describedby → id)
    const describedById = element.getAttribute('aria-describedby');
    if (describedById) {
      const prewiredEl = document.getElementById(describedById);
      if (prewiredEl) {
        prewiredEl.textContent = message;
        prewiredEl.style.display = 'block';
        return;
      }
    }

    // Fallback: create or reuse a sibling .error-message span.
    // CR-Apr24-I finding 316: walk past known layout-only wrappers
    // (e.g. `.relative` used for currency adornment on #amount) so the
    // error node is appended to the outer field container, not inside
    // the adornment wrapper.
    const WRAPPER_CLASSES = ['relative', 'input-wrapper'];
    let parent = element.parentElement;
    if (!parent) return;
    if (WRAPPER_CLASSES.some(cls => parent!.classList.contains(cls)) && parent.parentElement) {
      parent = parent.parentElement;
    }

    let errorEl = parent.querySelector<HTMLSpanElement>(':scope > .error-message');
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
  /**
   * CR-Apr24-I finding 315: clear prewired accessible error node too.
   */
  clearFieldError(element: HTMLElement | null): void {
    if (!element) return;

    element.classList.remove('error');
    element.setAttribute('aria-invalid', 'false');

    // Clear the prewired accessible error node if it exists
    const describedById = element.getAttribute('aria-describedby');
    if (describedById) {
      const prewiredEl = document.getElementById(describedById);
      if (prewiredEl) {
        prewiredEl.textContent = '';
        prewiredEl.style.display = 'none';
      }
    }

    // Also clean up any fallback sibling .error-message span.
    // CR-Apr24-I finding 316: walk past layout-only wrappers (matching showFieldError).
    const WRAPPER_CLASSES = ['relative', 'input-wrapper'];
    let parent = element.parentElement;
    if (!parent) return;
    if (WRAPPER_CLASSES.some(cls => parent!.classList.contains(cls)) && parent.parentElement) {
      parent = parent.parentElement;
    }

    const errorEl = parent.querySelector(':scope > .error-message');
    if (errorEl) {
      errorEl.remove();
    }
  }

  // Phase 5g-3 Slice 4 (Inline-Behavior-Review rev 12, L53): deleted the
  // `addRealtimeValidation(element, type)` method that lived here.
  //
  // Why deletion rather than the review-recommended "add an optional
  // `cleanups: (() => void)[]` parameter to match the createEventBinder
  // factory convention":
  //   * Grep across js/ + tests/ confirmed ZERO callers — the method
  //     attached `input` + `blur` listeners that nothing ever requested.
  //     Paired `showFieldError` / `clearFieldError` class methods stay
  //     (live callers per L52: form-events.ts:354/474 +
  //     form-binder.ts:207/217); only this realtime helper is zero-caller.
  //   * Adding a `cleanups` parameter would preserve ~35 LOC of listener
  //     wiring that no caller exercises. The L53 leak concern ("would
  //     leak if ever called from a render path") is hypothetical — with
  //     zero callers there is no leak to fix.
  //   * Same direction-reversal as M31 `SAFE_MOCK` deletion in Phase 5g-2:
  //     an unused API that advertises a contract is strictly worse than
  //     no API at all. A future caller who needed per-field realtime
  //     validation would reach for `bind = createEventBinder(cleanups)`
  //     directly (the established pattern in modal-events /
  //     filter-events / pin-ui-handlers / debt-ui-handlers /
  //     budget-planner-ui) rather than re-inheriting this legacy shape.
  //
  // The `ValidationFieldType` type import was also dropped — this method
  // was its sole consumer in validator.ts, and it has now been removed
  // from js/types/index.ts as well (zero remaining consumers across js/).
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

// Phase 5g-1 (Inline-Behavior-Review rev 12, L52): deleted the standalone
// `setFieldError(fieldName, message)` and `clearFieldError(fieldName)`
// helpers that duplicated the class methods `Validator.showFieldError(el)`
// / `Validator.clearFieldError(el)`. Reasons:
//   * `setFieldError` had zero callers across js/.
//   * `clearFieldError(fieldName)` had a single caller (keyboard-events.ts)
//     which has been migrated to `validator.clearFieldError(DOMCache.get(...))`.
//   * Keeping a single element-based API matches the four existing live
//     consumers (form-events.ts:354/474, form-binder.ts:207/217) and the
//     internal `addRealtimeValidation` pathway.
// The mid-file `import DOMCache` that those helpers needed is gone — the
// consolidated top-of-file import from L51 handles the remaining
// validator-class needs.

export default validator;
export { validator };
