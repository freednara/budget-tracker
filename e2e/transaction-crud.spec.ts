import { test, expect } from '@playwright/test';
import { cleanAppState, waitForTransactionsSurfaceReady } from './test-helpers.js';

/**
 * Helper: add an expense transaction with the given amount, description,
 * and first available category chip.
 * Returns the description used (for later lookup).
 */
async function addExpense(
  page: import('@playwright/test').Page,
  amount: string,
  description: string,
) {
  // Ensure we are on the Expense tab
  const expenseTab = page.locator('#tab-expense');
  if (!(await expenseTab.evaluate((el) => el.classList.contains('btn-primary') || el.style.background.includes('expense')))) {
    await expenseTab.click();
  }

  await page.locator('#amount').fill(amount);
  const categoryChip = page.locator('.category-chip').first();
  await expect(categoryChip).toBeVisible({ timeout: 5000 });
  await categoryChip.click();
  await page.locator('#description').fill(description);
  await page.locator('#submit-btn').click();

  // Wait for submission to complete (amount field gets cleared)
  await expect(page.locator('#amount')).toHaveValue('', { timeout: 5000 });
}

async function addExpenseWithDetails(
  page: import('@playwright/test').Page,
  options: {
    amount: string;
    description: string;
    categoryIndex?: number;
    date?: string;
    tags?: string;
    recurring?: boolean;
    recurringEnd?: string;
  }
) {
  const expenseTab = page.locator('#tab-expense');
  if (!(await expenseTab.evaluate((el) => el.classList.contains('btn-primary') || el.classList.contains('btn-danger')))) {
    await expenseTab.click();
  }

  await page.locator('#amount').fill(options.amount);
  if (options.date) {
    await page.locator('#date').fill(options.date);
  }

  const categoryChip = page.locator('.category-chip').nth(options.categoryIndex ?? 0);
  await expect(categoryChip).toBeVisible({ timeout: 5000 });
  await categoryChip.click();
  await page.locator('#description').fill(options.description);

  if (options.tags || options.recurring) {
    const details = page.locator('#transaction-details');
    await details.evaluate((el) => { (el as HTMLDetailsElement).open = true; });
    if (options.tags) {
      await page.locator('#tags').fill(options.tags);
    }
    if (options.recurring) {
      await page.locator('#recurring-toggle').check();
      await expect(page.locator('#recurring-end')).toBeVisible({ timeout: 5000 });
      await page.locator('#recurring-end').fill(options.recurringEnd || '2026-06-30');
    }
  }

  await page.locator('#submit-btn').click();
  await expect(page.locator('#amount')).toHaveValue('', { timeout: 5000 });
}

async function openAdvancedFilters(page: import('@playwright/test').Page) {
  const panel = page.locator('#advanced-filters');
  const toggle = page.locator('#toggle-advanced-filters');
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') {
    await toggle.click();
  }
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
}

/**
 * Helper: add an income transaction.
 */
async function addIncome(
  page: import('@playwright/test').Page,
  amount: string,
  description: string,
) {
  // Switch to Income tab
  await page.locator('#tab-income').click();
  await expect(page.locator('#tab-income')).toHaveClass(/btn-success/, { timeout: 3000 });

  await page.locator('#amount').fill(amount);
  const categoryChip = page.locator('.category-chip').first();
  await expect(categoryChip).toBeVisible({ timeout: 5000 });
  await categoryChip.click();
  await page.locator('#description').fill(description);
  await page.locator('#submit-btn').click();

  // Wait for submission to complete
  await expect(page.locator('#amount')).toHaveValue('', { timeout: 5000 });
}

// =========================================================
// Tests
// =========================================================

test.describe('Transaction CRUD', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    testInfo.setTimeout(Math.max(testInfo.timeout, 60000));
    await cleanAppState(page);
    await waitForTransactionsSurfaceReady(page);
  });

  // --------------------------------------------------
  // 1. Create expense
  // --------------------------------------------------
  test('create expense transaction and verify it appears in the list', async ({ page }) => {
    const desc = `Expense-${Date.now()}`;
    await addExpense(page, '42.50', desc);

    // The transaction should now appear in #transactions-list
    const txList = page.locator('#transactions-list');
    await expect(txList).toContainText(desc, { timeout: 5000 });
    await expect(txList).toContainText('42.50', { timeout: 3000 });
  });

  // --------------------------------------------------
  // 2. Create income
  // --------------------------------------------------
  test('create income transaction and verify it appears in the list', async ({ page }) => {
    const desc = `Income-${Date.now()}`;
    await addIncome(page, '1500.00', desc);

    const txList = page.locator('#transactions-list');
    await expect(txList).toContainText(desc, { timeout: 5000 });
    await expect(txList).toContainText('1,500.00', { timeout: 3000 });
  });

  test('switches transaction categories when toggling between expense and income', async ({ page }) => {
    await page.locator('#tab-transactions-btn').click();
    await expect(page.locator('#tab-transactions')).toBeVisible({ timeout: 10000 });

    const categoryChips = page.locator('#category-chips');
    await expect(categoryChips).toContainText('Food & Dining');
    await expect(categoryChips).not.toContainText('Salary');

    await page.locator('#tab-income').click();
    await expect(page.locator('#tab-income')).toHaveClass(/btn-success/, { timeout: 3000 });
    await expect(categoryChips).toContainText('Salary');
    await expect(categoryChips).not.toContainText('Food & Dining');

    await page.locator('#tab-expense').click();
    await expect(page.locator('#tab-expense')).toHaveClass(/btn-danger/, { timeout: 3000 });
    await expect(categoryChips).toContainText('Food & Dining');
    await expect(categoryChips).not.toContainText('Salary');
  });

  test('shows specific validation guidance when required transaction fields are missing', async ({ page }) => {
    await page.locator('#submit-btn').click();

    await expect(page.locator('.toast').filter({ hasText: 'Please complete: amount, category' }).last()).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#amount')).toHaveAttribute('aria-invalid', 'true');

    await page.locator('#amount').fill('25.00');
    await page.locator('#submit-btn').click();

    await expect(page.locator('.toast').filter({ hasText: 'Category is required' }).last()).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#category-chips')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('#category-error')).toBeVisible();
  });

  test('create recurring transaction and verify first occurrence appears', async ({ page }) => {
    const desc = `Recurring-${Date.now()}`;

    await page.locator('#amount').fill('44.00');
    const categoryChip = page.locator('.category-chip').first();
    await expect(categoryChip).toBeVisible({ timeout: 5000 });
    await categoryChip.click();
    await page.locator('#description').fill(desc);
    await page.locator('#transaction-details').click();
    await page.locator('#recurring-toggle').click();
    await expect(page.locator('#recurring-end')).toBeVisible({ timeout: 5000 });
    await page.locator('#recurring-end').fill('2026-06-30');
    await page.locator('#submit-btn').click();

    await expect(page.locator('.toast').filter({ hasText: 'Recurring series created' }).last()).toBeVisible({ timeout: 5000 });

    const txList = page.locator('#transactions-list');
    await expect(txList).toContainText(desc, { timeout: 5000 });
    await expect(txList.locator('.badge-recurring').first()).toBeVisible({ timeout: 5000 });
  });

  test('create custom category with selected emoji and verify it persists', async ({ page }) => {
    const customName = `Custom-${Date.now()}`;

    await page.locator('#inline-add-cat').click();
    await expect(page.locator('#category-modal')).toBeVisible({ timeout: 5000 });
    await page.locator('#custom-cat-name').fill(customName);
    await page.locator('#emoji-picker-trigger').click();
    await expect(page.locator('#emoji-picker-dropdown')).toBeVisible({ timeout: 5000 });
    await page.locator('.emoji-tab').filter({ hasText: 'Food' }).click();
    await page.locator('.emoji-cell[data-emoji="🥗"]').click();
    await page.locator('#save-custom-cat').click();

    const customChip = page.locator('.category-chip', { hasText: customName });
    await expect(customChip).toBeVisible({ timeout: 5000 });
    await expect(customChip).toContainText('🥗');

    const storedEmoji = await page.evaluate(() => {
      const customCats = JSON.parse(localStorage.getItem('budget_tracker_custom_categories') || '[]');
      return customCats.at(-1)?.emoji || null;
    });
    expect(storedEmoji).toBe('🥗');
  });

  test('delete template uses the app confirm modal instead of a browser dialog', async ({ page }) => {
    const templateName = `Template-${Date.now()}`;
    let dialogSeen = false;

    page.on('dialog', async (dialog) => {
      dialogSeen = true;
      await dialog.dismiss();
    });

    await page.locator('#amount').fill('27.50');
    const categoryChip = page.locator('.category-chip').first();
    await expect(categoryChip).toBeVisible({ timeout: 5000 });
    await categoryChip.click();
    await page.locator('#description').fill('Template delete check');
    await page.locator('#save-as-template-btn').click();

    await page.waitForSelector('#async-prompt-modal', { state: 'visible' });
    await page.locator('#prompt-input').fill(templateName);
    await page.locator('#prompt-ok').click();

    const templateCard = page.locator('#templates-list .template-btn', { hasText: templateName });
    await expect(templateCard).toBeVisible({ timeout: 5000 });

    await templateCard.locator('.delete-template-btn').click();
    await page.waitForSelector('#async-confirm-modal', { state: 'visible' });
    await expect(page.locator('#confirm-title')).toHaveText('Delete Template');
    expect(dialogSeen).toBeFalsy();

    await page.locator('#confirm-ok').click();
    await expect(templateCard).toHaveCount(0, { timeout: 5000 });
  });

  // --------------------------------------------------
  // 3. Edit transaction
  // --------------------------------------------------
  test('edit an existing transaction and verify updated value', async ({ page }) => {
    const desc = `EditMe-${Date.now()}`;
    await addExpense(page, '25.00', desc);

    // Verify it appeared
    const txList = page.locator('#transactions-list');
    await expect(txList).toContainText(desc, { timeout: 5000 });

    // Click the edit button on that transaction row
    const txRow = txList.locator(`.transaction-row`, { has: page.locator(`text=${desc}`) });
    await expect(txRow).toBeVisible({ timeout: 5000 });

    // The edit button is inside the row (or its parent swipe-container)
    const editBtn = txRow.locator('.edit-btn');
    await editBtn.click();

    // The form should now be in edit mode: title changes and amount is populated
    await expect(page.locator('#form-title')).toContainText('Edit', { timeout: 5000 });
    await expect(page.locator('#amount')).not.toHaveValue('', { timeout: 3000 });

    // Change the amount
    await page.locator('#amount').fill('99.99');

    // Submit the update
    await page.locator('#submit-btn').click();

    // Wait for form to reset (edit mode ends)
    await expect(page.locator('#amount')).toHaveValue('', { timeout: 5000 });

    // Verify the updated amount appears in the list
    await expect(txList).toContainText('99.99', { timeout: 5000 });
  });

  // --------------------------------------------------
  // 4. Delete transaction
  // --------------------------------------------------
  test('delete an existing transaction and verify it is removed', async ({ page }) => {
    const desc = `DeleteMe-${Date.now()}`;
    await addExpense(page, '15.00', desc);

    const txList = page.locator('#transactions-list');
    await expect(txList).toContainText(desc, { timeout: 5000 });

    // Click the delete button on that transaction
    const txRow = txList.locator(`.transaction-row`, { has: page.locator(`text=${desc}`) });
    const deleteBtn = txRow.locator('.delete-btn');
    await deleteBtn.click();

    // The delete confirmation modal should appear
    await expect(page.locator('#delete-modal')).toBeVisible({ timeout: 5000 });

    // Confirm deletion
    await page.locator('#confirm-delete').click();

    // Modal should close
    await expect(page.locator('#delete-modal')).not.toBeVisible({ timeout: 5000 });

    // The transaction should be gone from the list
    await expect(txList).not.toContainText(desc, { timeout: 5000 });
  });
});

test.describe('Month Navigation', () => {
  test.beforeEach(async ({ page }) => {
    await cleanAppState(page);
    await waitForTransactionsSurfaceReady(page);
  });

  test('clicking prev/next month changes the month label', async ({ page }) => {
    const monthLabel = page.locator('#current-month-label');
    const initialMonth = await monthLabel.textContent();
    expect(initialMonth).toBeTruthy();

    // Go to the previous month
    await page.locator('#prev-month').click();
    await expect(monthLabel).not.toHaveText(initialMonth!, { timeout: 5000 });
    const prevMonth = await monthLabel.textContent();

    // Go forward two months (back to current + one ahead)
    await page.locator('#next-month').click();
    await expect(monthLabel).toHaveText(initialMonth!, { timeout: 5000 });

    await page.locator('#next-month').click();
    await expect(monthLabel).not.toHaveText(initialMonth!, { timeout: 5000 });
    const nextMonth = await monthLabel.textContent();

    // All three labels should be different
    expect(prevMonth).not.toBe(initialMonth);
    expect(nextMonth).not.toBe(initialMonth);
    expect(prevMonth).not.toBe(nextMonth);
  });

  test('month navigation filters transactions to the correct month', async ({ page }) => {
    // Add a transaction for the current month
    const desc = `CurrentMonth-${Date.now()}`;
    await addExpense(page, '10.00', desc);

    const txList = page.locator('#transactions-list');
    await expect(txList).toContainText(desc, { timeout: 5000 });

    // Navigate to previous month — the transaction should not be visible
    await page.locator('#prev-month').click();
    // Wait for month label to change
    await expect(page.locator('#current-month-label')).not.toHaveText('', { timeout: 3000 });
    // Give the list time to re-render
    await expect(txList).not.toContainText(desc, { timeout: 5000 });

    // Navigate back to current month — the transaction should reappear
    await page.locator('#next-month').click();
    await expect(txList).toContainText(desc, { timeout: 5000 });
  });
});

test.describe('Calendar Tab', () => {
  test.beforeEach(async ({ page }) => {
    await cleanAppState(page);
    await waitForTransactionsSurfaceReady(page);
  });

  test('selected day can jump into transactions with that date prefilled', async ({ page }) => {
    const desc = `CalendarItem-${Date.now()}`;
    await addExpenseWithDetails(page, {
      amount: '32.00',
      description: desc,
      date: '2026-03-22'
    });

    await page.locator('#tab-calendar-btn').click();
    await expect(page.locator('#tab-calendar')).toBeVisible({ timeout: 10000 });

    const dayCell = page.locator('.cal-day[data-day="22"]').first();
    await expect(dayCell).toBeVisible({ timeout: 5000 });
    await dayCell.click();

    await expect(page.locator('#cal-detail-panel')).toContainText(desc, { timeout: 5000 });
    await page.locator('#cal-detail-panel').getByRole('button', { name: 'Add Transaction' }).click();

    await expect(page.locator('#tab-transactions-btn')).toHaveAttribute('aria-selected', 'true', { timeout: 10000 });
    await expect(page.locator('#date')).toHaveValue('2026-03-22', { timeout: 5000 });
    await expect(page.locator('#amount')).toBeFocused();
  });
});

test.describe('Search and Filter', () => {
  test.beforeEach(async ({ page }) => {
    await cleanAppState(page);
    await waitForTransactionsSurfaceReady(page);
  });

  test('search by description filters the transaction list', async ({ page }) => {
    const descA = `AlphaItem-${Date.now()}`;
    const descB = `BetaItem-${Date.now()}`;

    await addExpense(page, '20.00', descA);
    await addExpense(page, '30.00', descB);

    const txList = page.locator('#transactions-list');
    await expect(txList).toContainText(descA, { timeout: 5000 });
    await expect(txList).toContainText(descB, { timeout: 5000 });

    // Type in the search field to filter
    await page.locator('#search-text').fill('Alpha');

    // Only the matching transaction should be visible
    await expect(txList).toContainText(descA, { timeout: 5000 });
    await expect(txList).not.toContainText(descB, { timeout: 5000 });

    // Clear the search — both should reappear
    await page.locator('#search-text').fill('');
    await expect(txList).toContainText(descA, { timeout: 5000 });
    await expect(txList).toContainText(descB, { timeout: 5000 });
  });

  test('type filter dropdown filters by expense or income', async ({ page }) => {
    const expenseDesc = `FilterExpense-${Date.now()}`;
    const incomeDesc = `FilterIncome-${Date.now()}`;

    await addExpense(page, '45.00', expenseDesc);
    await addIncome(page, '2000.00', incomeDesc);

    // Switch back to expense tab so the form is ready, but the list shows all
    await page.locator('#tab-expense').click();

    const txList = page.locator('#transactions-list');
    await expect(txList).toContainText(expenseDesc, { timeout: 5000 });
    await expect(txList).toContainText(incomeDesc, { timeout: 5000 });

    // Filter by expense only
    await page.locator('#filter-type').selectOption('expense');
    await expect(txList).toContainText(expenseDesc, { timeout: 5000 });
    await expect(txList).not.toContainText(incomeDesc, { timeout: 5000 });

    // Filter by income only
    await page.locator('#filter-type').selectOption('income');
    await expect(txList).toContainText(incomeDesc, { timeout: 5000 });
    await expect(txList).not.toContainText(expenseDesc, { timeout: 5000 });

    // Reset to all
    await page.locator('#filter-type').selectOption('all');
    await expect(txList).toContainText(expenseDesc, { timeout: 5000 });
    await expect(txList).toContainText(incomeDesc, { timeout: 5000 });
  });

  test('advanced filters apply tags, recurring, amount, unreconciled, category, and custom date range', async ({ page }) => {
    const foodDesc = `FoodTagged-${Date.now()}`;
    const recurringDesc = `RecurringTagged-${Date.now()}`;
    const reconciledDesc = `ReconciledTagged-${Date.now()}`;
    const transportDesc = `TransportTagged-${Date.now()}`;

    await addExpenseWithDetails(page, {
      amount: '12.00',
      description: foodDesc,
      categoryIndex: 0,
      date: '2026-03-01',
      tags: 'coffee'
    });

    await addExpenseWithDetails(page, {
      amount: '55.00',
      description: recurringDesc,
      categoryIndex: 0,
      date: '2026-03-10',
      tags: 'rent',
      recurring: true,
      recurringEnd: '2026-06-30'
    });

    await addExpenseWithDetails(page, {
      amount: '95.00',
      description: reconciledDesc,
      categoryIndex: 0,
      date: '2026-03-12',
      tags: 'grocery'
    });

    await addExpenseWithDetails(page, {
      amount: '22.00',
      description: transportDesc,
      categoryIndex: 1,
      date: '2026-03-19',
      tags: 'commute'
    });

    const txList = page.locator('#transactions-list');
    await expect(txList).toContainText(foodDesc, { timeout: 5000 });
    await expect(txList).toContainText(recurringDesc, { timeout: 5000 });
    await expect(txList).toContainText(reconciledDesc, { timeout: 5000 });
    await expect(txList).toContainText(transportDesc, { timeout: 5000 });

    const reconciledRow = txList.locator('.transaction-row', { has: page.locator(`text=${reconciledDesc}`) });
    await reconciledRow.locator('.reconcile-btn').click();
    await expect(reconciledRow.locator('.reconcile-btn')).toHaveAttribute('aria-label', /unreconciled/i, { timeout: 5000 });

    await openAdvancedFilters(page);

    await page.locator('#filter-tags').fill('rent');
    await expect(txList).toContainText(recurringDesc, { timeout: 5000 });
    await expect(txList).not.toContainText(foodDesc, { timeout: 5000 });
    await expect(txList).not.toContainText(reconciledDesc, { timeout: 5000 });

    await page.locator('#filter-tags').fill('');
    await expect(txList).toContainText(foodDesc, { timeout: 5000 });
    await expect(txList).toContainText(recurringDesc, { timeout: 5000 });

    await page.locator('#filter-recurring').check();
    await expect(txList).toContainText(recurringDesc, { timeout: 5000 });
    await expect(txList).not.toContainText(foodDesc, { timeout: 5000 });

    await page.locator('#filter-recurring').uncheck();
    await page.locator('#filter-min-amt').fill('80');
    await expect(txList).toContainText(reconciledDesc, { timeout: 5000 });
    await expect(txList).not.toContainText(foodDesc, { timeout: 5000 });
    await expect(txList).not.toContainText(recurringDesc, { timeout: 5000 });

    await page.locator('#filter-min-amt').fill('');
    await page.locator('#filter-unreconciled').check();
    await expect(txList).toContainText(foodDesc, { timeout: 5000 });
    await expect(txList).toContainText(recurringDesc, { timeout: 5000 });
    await expect(txList).toContainText(transportDesc, { timeout: 5000 });
    await expect(txList).not.toContainText(reconciledDesc, { timeout: 5000 });

    await page.locator('#filter-unreconciled').uncheck();
    await page.locator('#filter-category').selectOption('transport');
    await expect(txList).toContainText(transportDesc, { timeout: 5000 });
    await expect(txList).not.toContainText(foodDesc, { timeout: 5000 });

    await page.locator('#filter-category').selectOption('');
    await page.locator('#filter-date-quick').selectOption('custom');
    await page.locator('#filter-from').fill('2026-03-15');
    await page.locator('#filter-to').fill('2026-03-31');
    await expect(txList).toContainText(transportDesc, { timeout: 5000 });
    await expect(txList).not.toContainText(foodDesc, { timeout: 5000 });
    await expect(txList).not.toContainText(recurringDesc, { timeout: 5000 });
    await expect(txList).not.toContainText(reconciledDesc, { timeout: 5000 });
  });
});
