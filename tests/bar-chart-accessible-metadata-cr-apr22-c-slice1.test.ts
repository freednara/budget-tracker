import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { renderBarChart } from '../js/modules/ui/charts/chart-renderers.js';

/**
 * CR-Apr22-C slice 1 [P2] — `renderBarChart` accessible metadata
 * parameterized.
 *
 * Pre-fix: the SVG's `role="figure" aria-label="Budget vs actual
 * spending comparison"` + `<title>Budget vs Actual</title>` + `<desc>
 * Bar chart comparing budgeted amounts to actual spending across N
 * categories</desc>` was hardcoded. The same renderer is reused by:
 *   - budget-vs-actual (dashboard + analytics) — accurate
 *   - year-trend chart — WRONG: not a budget-actual comparison
 *   - YoY expense comparison — WRONG: not a budget-actual comparison
 *   - category-trends top-N chart — WRONG
 *
 * Screen-reader users hitting any of those three non-BvA charts heard
 * misleading copy describing a chart that wasn't in front of them.
 *
 * Fix: `renderBarChart(id, labels, datasets, a11y?)` — the new optional
 * 4th arg supplies `ariaLabel` / `title` / `desc`. Default preserves
 * the BvA copy so the two BvA call sites need no change; the three
 * non-BvA call sites pass context-appropriate metadata.
 */

const CONTAINER_ID = 'test-bar-chart';

function seedContainer(): HTMLElement {
  document.body.innerHTML = `<div id="${CONTAINER_ID}"></div>`;
  return document.getElementById(CONTAINER_ID) as HTMLElement;
}

function getSvg(): SVGElement | null {
  const container = document.getElementById(CONTAINER_ID);
  return container?.querySelector('svg') ?? null;
}

describe('renderBarChart accessibility metadata (CR-Apr22-C slice 1)', () => {
  beforeEach(() => {
    seedContainer();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  describe('default behavior (backward compatibility)', () => {
    it('emits the budget-vs-actual defaults when no a11y arg is supplied', () => {
      renderBarChart(CONTAINER_ID, ['Food', 'Rent', 'Utilities'], [
        { label: 'Budget', data: [100, 200, 50], color: '#000' },
        { label: 'Actual', data: [120, 180, 55], color: '#f00' }
      ]);

      const svg = getSvg();
      expect(svg).not.toBeNull();
      expect(svg?.getAttribute('role')).toBe('figure');
      expect(svg?.getAttribute('aria-label')).toBe('Budget vs actual spending comparison');

      const title = svg?.querySelector('title');
      expect(title?.textContent).toBe('Budget vs Actual');

      const desc = svg?.querySelector('desc');
      expect(desc?.textContent).toBe(
        'Bar chart comparing budgeted amounts to actual spending across 3 categories'
      );
    });

    it('default desc reflects the label count dynamically', () => {
      renderBarChart(CONTAINER_ID, ['A', 'B', 'C', 'D', 'E'], [
        { label: 'Budget', data: [1, 2, 3, 4, 5], color: '#000' }
      ]);

      const desc = getSvg()?.querySelector('desc');
      expect(desc?.textContent).toContain('across 5 categories');
    });
  });

  describe('custom a11y metadata (the fix)', () => {
    it('uses supplied aria-label for year-trend context', () => {
      renderBarChart(
        CONTAINER_ID,
        ['Jan', 'Feb', 'Mar'],
        [{ label: '2026 Income', data: [1000, 1100, 1050], color: '#0f0' }],
        {
          ariaLabel: 'Monthly income and expenses for 2026',
          title: '2026 Year Trend',
          desc: 'Bar chart showing monthly income and expenses across 3 months of 2026'
        }
      );

      const svg = getSvg();
      expect(svg?.getAttribute('aria-label')).toBe(
        'Monthly income and expenses for 2026'
      );
      expect(svg?.querySelector('title')?.textContent).toBe('2026 Year Trend');
      expect(svg?.querySelector('desc')?.textContent).toBe(
        'Bar chart showing monthly income and expenses across 3 months of 2026'
      );
    });

    it('uses supplied aria-label for YoY-comparison context', () => {
      renderBarChart(
        CONTAINER_ID,
        ['Jan', 'Feb', 'Mar'],
        [
          { label: '2026', data: [500, 520, 510], color: '#f00' },
          { label: '2025', data: [450, 460, 455], color: '#00f' }
        ],
        {
          ariaLabel: 'Year-over-year expense comparison: 2026 versus 2025',
          title: 'YoY Comparison: 2026 vs 2025',
          desc: 'Bar chart comparing monthly expenses for 2026 and 2025 across 3 months'
        }
      );

      const svg = getSvg();
      expect(svg?.getAttribute('aria-label')).toBe(
        'Year-over-year expense comparison: 2026 versus 2025'
      );
      expect(svg?.querySelector('title')?.textContent).toBe('YoY Comparison: 2026 vs 2025');
    });

    it('uses supplied aria-label for category-trends top-N context', () => {
      renderBarChart(
        CONTAINER_ID,
        ['Food', 'Transport', 'Shopping'],
        [{ label: 'Top Categories (2026)', data: [800, 500, 300], color: '#abc' }],
        {
          ariaLabel: 'Top spending categories for 2026',
          title: 'Top Categories: 2026',
          desc: 'Bar chart showing the 3 highest-spending categories over 2026, sorted by total spend'
        }
      );

      const svg = getSvg();
      expect(svg?.getAttribute('aria-label')).toBe('Top spending categories for 2026');
      expect(svg?.querySelector('desc')?.textContent).toContain('highest-spending categories');
    });

    it('never contains the hardcoded BvA copy when custom a11y is supplied', () => {
      // Regression lock: verify the fix actually substitutes — if any future
      // refactor accidentally drops the a11y arg through, this test flags it.
      renderBarChart(
        CONTAINER_ID,
        ['Q1', 'Q2'],
        [{ label: 'Revenue', data: [1000, 1200], color: '#0ff' }],
        {
          ariaLabel: 'Quarterly revenue',
          title: 'Revenue by Quarter',
          desc: 'Revenue split across 2 quarters'
        }
      );

      const svg = getSvg();
      const ariaLabel = svg?.getAttribute('aria-label') ?? '';
      const titleText = svg?.querySelector('title')?.textContent ?? '';
      const descText = svg?.querySelector('desc')?.textContent ?? '';

      expect(ariaLabel).not.toContain('Budget vs actual');
      expect(titleText).not.toContain('Budget vs Actual');
      expect(descText).not.toContain('budgeted amounts to actual spending');
    });
  });

  describe('robustness', () => {
    it('survives empty-label render with both default and custom a11y', () => {
      // maxVal = Math.max(...[], 1) = 1 — renderer still produces an SVG.
      renderBarChart(CONTAINER_ID, [], []);
      const svgDefault = getSvg();
      expect(svgDefault?.querySelector('desc')?.textContent).toContain('across 0 categories');

      document.body.innerHTML = `<div id="${CONTAINER_ID}"></div>`;
      renderBarChart(CONTAINER_ID, [], [], {
        ariaLabel: 'Empty chart',
        title: 'Empty',
        desc: 'No data to display'
      });
      const svgCustom = getSvg();
      expect(svgCustom?.getAttribute('aria-label')).toBe('Empty chart');
    });

    it('no-ops cleanly when container is missing', () => {
      document.body.innerHTML = '';
      // Should not throw.
      expect(() => {
        renderBarChart('does-not-exist', ['A'], [
          { label: 'X', data: [1], color: '#000' }
        ]);
      }).not.toThrow();
    });
  });
});
