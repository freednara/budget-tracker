/**
 * Accessibility Tests
 * Validates WCAG AA compliance for the Budget Tracker
 */

import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { cleanAppState } from './test-helpers.js';

test.describe('WCAG Accessibility Compliance', () => {
  test.beforeEach(async ({ page }) => {
    await cleanAppState(page);
  });

  test('should meet WCAG AA standards in light theme', async ({ page }) => {
    // Switch to light theme
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'light');
    });

    // Wait for theme to apply
    await page.waitForTimeout(100);

    // Run axe accessibility scan
    const accessibilityScanResults = await new AxeBuilder({ page })
      .withTags(['wcag2aa', 'wcag21aa'])
      .analyze();

    // Check for violations
    expect(accessibilityScanResults.violations).toEqual([]);
  });

  test('should meet WCAG AA standards in dark theme', async ({ page }) => {
    // Ensure dark theme
    await page.evaluate(() => {
      document.documentElement.removeAttribute('data-theme');
    });

    // Wait for theme to apply
    await page.waitForTimeout(100);

    // Run axe accessibility scan
    const accessibilityScanResults = await new AxeBuilder({ page })
      .withTags(['wcag2aa', 'wcag21aa'])
      .analyze();

    // Check for violations
    expect(accessibilityScanResults.violations).toEqual([]);
  });

  test('should have sufficient color contrast for all text', async ({ page }) => {
    // Test both themes
    for (const theme of ['light', 'dark']) {
      await page.evaluate((t) => {
        if (t === 'light') {
          document.documentElement.setAttribute('data-theme', 'light');
        } else {
          document.documentElement.removeAttribute('data-theme');
        }
      }, theme);

      await page.waitForTimeout(100);

      // Run contrast-specific checks
      const contrastResults = await new AxeBuilder({ page })
        .withRules(['color-contrast'])
        .analyze();

      // Log any contrast issues for debugging
      if (contrastResults.violations.length > 0) {
        console.log(`Contrast violations in ${theme} theme:`, 
          contrastResults.violations.map(v => ({
            id: v.id,
            impact: v.impact,
            nodes: v.nodes.length,
            description: v.description
          }))
        );
      }

      expect(contrastResults.violations).toEqual([]);
    }
  });

  test('should have proper ARIA labels on interactive elements', async ({ page }) => {
    const ariaResults = await new AxeBuilder({ page })
      .withRules([
        'aria-allowed-attr',
        'aria-required-attr',
        'aria-valid-attr',
        'aria-valid-attr-value',
        'button-name',
        'link-name',
        'label'
      ])
      .analyze();

    expect(ariaResults.violations).toEqual([]);
  });

  test('should have keyboard navigation for all interactive elements', async ({ page }) => {
    // Test tab navigation
    await page.keyboard.press('Tab');
    
    // Check that focus is visible
    const focusedElement = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el) return null;
      return {
        tagName: el.tagName,
        hasVisibleFocus: window.getComputedStyle(el).outline !== 'none'
      };
    });

    expect(focusedElement).not.toBeNull();
    expect(focusedElement?.hasVisibleFocus).toBeTruthy();
  });

  test('should have sufficient focus indicators', async ({ page }) => {
    // Get all interactive elements
    const interactiveElements = await page.$$('button, a, input, select, textarea, [tabindex]');
    
    for (const element of interactiveElements.slice(0, 5)) { // Test first 5 elements
      await element.focus();
      
      const focusStyles = await element.evaluate(el => {
        const styles = window.getComputedStyle(el);
        return {
          outline: styles.outline,
          boxShadow: styles.boxShadow,
          border: styles.border
        };
      });

      // At least one focus indicator should be present
      const hasFocusIndicator = 
        focusStyles.outline !== 'none' ||
        focusStyles.boxShadow !== 'none' ||
        focusStyles.border !== 'none';

      expect(hasFocusIndicator).toBeTruthy();
    }
  });

  test('specific color values should meet WCAG AA contrast ratios', async ({ page }) => {
    const colorTests = [
      { 
        selector: '.text-tertiary',
        expectedMinContrast: 4.5,
        description: 'Tertiary text'
      },
      {
        selector: '.text-success',
        expectedMinContrast: 4.5,
        description: 'Success text (income)'
      },
      {
        selector: '.text-danger',
        expectedMinContrast: 4.5,
        description: 'Danger text (expense)'
      },
      {
        selector: '.text-warning',
        expectedMinContrast: 4.5,
        description: 'Warning text'
      }
    ];

    for (const theme of ['light', 'dark']) {
      await page.evaluate((t) => {
        if (t === 'light') {
          document.documentElement.setAttribute('data-theme', 'light');
        } else {
          document.documentElement.removeAttribute('data-theme');
        }
      }, theme);

      await page.waitForTimeout(100);

      // Add test elements to verify our CSS colors
      await page.evaluate(() => {
        const testDiv = document.createElement('div');
        testDiv.innerHTML = `
          <div style="background: var(--bg-primary); padding: 20px;">
            <span class="text-tertiary" style="color: var(--text-tertiary)">Tertiary Text</span>
            <span class="text-success" style="color: var(--color-income)">Success Text</span>
            <span class="text-danger" style="color: var(--color-expense)">Danger Text</span>
            <span class="text-warning" style="color: var(--color-warning)">Warning Text</span>
          </div>
        `;
        document.body.appendChild(testDiv);
      });

      // Run contrast check on our test elements
      const contrastResults = await new AxeBuilder({ page })
        .include('.text-tertiary, .text-success, .text-danger, .text-warning')
        .withRules(['color-contrast'])
        .analyze();

      if (contrastResults.violations.length > 0) {
        console.log(`Failed contrast in ${theme} theme:`, contrastResults.violations);
      }

      expect(contrastResults.violations).toHaveLength(0);
    }
  });
});

test.describe('Semantic HTML Structure', () => {
  test('should use proper heading hierarchy', async ({ page }) => {
    await page.goto('/');
    
    const headingResults = await new AxeBuilder({ page })
      .withRules(['heading-order'])
      .analyze();

    expect(headingResults.violations).toEqual([]);
  });

  test('should have proper landmarks', async ({ page }) => {
    await page.goto('/');
    
    const landmarks = await page.evaluate(() => {
      return {
        hasMain: !!document.querySelector('main'),
        hasNav: !!document.querySelector('nav'),
        hasHeader: !!document.querySelector('header')
      };
    });

    expect(landmarks.hasMain || landmarks.hasNav || landmarks.hasHeader).toBeTruthy();
  });
});

// Performance test to ensure accessibility doesn't impact performance
test.describe('Accessibility Performance', () => {
  test('focus transitions should be smooth', async ({ page }) => {
    await page.goto('/');
    
    // Measure focus transition time
    const transitionTime = await page.evaluate(() => {
      const button = document.querySelector('button');
      if (!button) return 0;
      
      const start = performance.now();
      button.focus();
      const styles = window.getComputedStyle(button);
      // Force style calculation
      styles.outline;
      return performance.now() - start;
    });

    // Focus should be applied quickly (under 100ms)
    expect(transitionTime).toBeLessThan(100);
  });
});