/**
 * Virtual Scroller Module
 *
 * Efficient rendering for large lists using DOM recycling and viewport-based rendering.
 * Only renders visible items plus a buffer zone for smooth scrolling.
 *
 * @module virtual-scroller
 */

import { swipeManager } from '../interactions/swipe-manager.js';

// ==========================================
// TYPE DEFINITIONS
// ==========================================

export interface VirtualScrollerOptions {
  estimatedRowHeight?: number;
  bufferSize?: number;
  rowClass?: string;
  enableSwipe?: boolean;
}

export type RowRenderer<T> = (rowEl: HTMLElement, item: T, index: number) => void;

type ScrollPosition = 'start' | 'center' | 'end';

interface VirtualScrollerStats {
  totalItems: number;
  visibleStart: number;
  visibleEnd: number;
  renderedCount: number;
  poolSize: number;
  estimatedHeight: number;
  scrollTop: number;
}

// ==========================================
// VIRTUAL SCROLLER CLASS
// ==========================================

/**
 * VirtualScroller efficiently renders large lists by only displaying
 * items currently visible in the viewport plus a small buffer.
 */
export class VirtualScroller<T = unknown> {
  // Configuration
  private rowHeight: number;
  private bufferSize: number;
  private rowClass: string;
  private enableSwipe: boolean;

  // State
  private containerEl: HTMLElement | null = null;
  private items: T[] = [];
  private rowRenderer: RowRenderer<T> | null = null;
  private visibleStart: number = 0;
  private visibleEnd: number = 0;
  private lastScrollTop: number = 0;

  // DOM elements
  private scrollContainer: HTMLDivElement | null = null;
  private spacerTop: HTMLDivElement | null = null;
  private spacerBottom: HTMLDivElement | null = null;
  private rowContainer: HTMLDivElement | null = null;

  // Row recycling pool
  private rowPool: HTMLDivElement[] = [];
  private activeRows: Map<number, HTMLDivElement> = new Map();

  // Height cache for variable height rows
  private heightCache: Map<number, number> = new Map();
  private totalHeightEstimate: number = 0;

  // Throttling
  private scrollRAF: number | null = null;
  private resizeObserver: ResizeObserver | null = null;

  /**
   * @param options - Configuration options
   */
  constructor(options: VirtualScrollerOptions = {}) {
    this.rowHeight = options.estimatedRowHeight || 72;
    this.bufferSize = options.bufferSize || 10;
    this.rowClass = options.rowClass || 'vs-row';
    this.enableSwipe = options.enableSwipe !== false;

    // Bind handlers
    this._onScroll = this._onScroll.bind(this);
    this._onResize = this._onResize.bind(this);
  }

  /**
   * Initialize the virtual scroller
   */
  init(containerEl: HTMLElement, items: T[], rowRenderer: RowRenderer<T>): void {
    this.containerEl = containerEl;
    this.items = items;
    this.rowRenderer = rowRenderer;

    // Clear existing content and swipe handlers
    this._cleanupExistingContent();

    // Create scroll structure
    this._createScrollStructure();

    // Set up event listeners
    this.scrollContainer!.addEventListener('scroll', this._onScroll, { passive: true });

    // Watch for container resize
    this.resizeObserver = new ResizeObserver(this._onResize);
    this.resizeObserver.observe(this.scrollContainer!);

    // Initial render
    this._calculateHeightEstimate();
    this._updateVisibleRange();
    this._render();

    // Mark container as virtual scroll enabled
    this.containerEl.classList.add('vs-enabled');
  }

  /**
   * Clean up existing content and swipe handlers
   */
  private _cleanupExistingContent(): void {
    // Detach swipe handlers from existing content
    this.containerEl!.querySelectorAll<HTMLElement>('.swipe-container').forEach(container => {
      swipeManager.detach(container);
    });

    // Clear active rows
    this.activeRows.forEach((rowEl) => {
      this._recycleRow(rowEl, true);
    });
    this.activeRows.clear();
  }

  /**
   * Create the scroll structure
   */
  private _createScrollStructure(): void {
    // Clear container
    this.containerEl!.innerHTML = '';

    // Create scroll container (inherits container's dimensions)
    this.scrollContainer = document.createElement('div');
    this.scrollContainer.className = 'vs-scroll-container';
    this.scrollContainer.style.cssText = `
      height: 100%;
      overflow-y: auto;
      overflow-x: hidden;
      -webkit-overflow-scrolling: touch;
      contain: strict;
    `;

    // Top spacer for scroll position
    this.spacerTop = document.createElement('div');
    this.spacerTop.className = 'vs-spacer-top';
    this.spacerTop.style.cssText = 'width: 100%; pointer-events: none;';

    // Row container
    this.rowContainer = document.createElement('div');
    this.rowContainer.className = 'vs-row-container';
    this.rowContainer.style.cssText = 'position: relative;';

    // Bottom spacer for scroll height
    this.spacerBottom = document.createElement('div');
    this.spacerBottom.className = 'vs-spacer-bottom';
    this.spacerBottom.style.cssText = 'width: 100%; pointer-events: none;';

    // Assemble structure
    this.scrollContainer.appendChild(this.spacerTop);
    this.scrollContainer.appendChild(this.rowContainer);
    this.scrollContainer.appendChild(this.spacerBottom);
    this.containerEl!.appendChild(this.scrollContainer);
  }

  /**
   * Calculate total height estimate
   */
  private _calculateHeightEstimate(): void {
    this.totalHeightEstimate = this.items.length * this.rowHeight;
  }

  /**
   * Handle scroll events (throttled with RAF)
   */
  private _onScroll(): void {
    if (this.scrollRAF) return;

    this.scrollRAF = requestAnimationFrame(() => {
      this.scrollRAF = null;

      const scrollTop = this.scrollContainer!.scrollTop;
      const scrollDelta = Math.abs(scrollTop - this.lastScrollTop);

      // Only update if scrolled more than half a row
      if (scrollDelta > this.rowHeight / 2) {
        this.lastScrollTop = scrollTop;
        this._updateVisibleRange();
        this._render();
      }
    });
  }

  /**
   * Handle container resize
   */
  private _onResize(): void {
    this._updateVisibleRange();
    this._render();
  }

  /**
   * Update the visible range based on scroll position
   */
  private _updateVisibleRange(): void {
    const scrollTop = this.scrollContainer!.scrollTop;
    const viewportHeight = this.scrollContainer!.clientHeight;

    // Calculate visible range with buffer
    const firstVisible = Math.floor(scrollTop / this.rowHeight);
    const visibleCount = Math.ceil(viewportHeight / this.rowHeight);

    this.visibleStart = Math.max(0, firstVisible - this.bufferSize);
    this.visibleEnd = Math.min(this.items.length, firstVisible + visibleCount + this.bufferSize);
  }

  /**
   * Render visible rows
   */
  private _render(): void {
    // Update spacer heights
    const startOffset = this.visibleStart * this.rowHeight;
    const endOffset = Math.max(0, this.totalHeightEstimate - (this.visibleEnd * this.rowHeight));

    this.spacerTop!.style.height = `${startOffset}px`;
    this.spacerBottom!.style.height = `${endOffset}px`;

    // Track which indices are currently rendered
    const currentIndices = new Set(this.activeRows.keys());
    const neededIndices = new Set<number>();

    for (let i = this.visibleStart; i < this.visibleEnd; i++) {
      neededIndices.add(i);
    }

    // Recycle rows that are no longer visible
    currentIndices.forEach(index => {
      if (!neededIndices.has(index)) {
        const rowEl = this.activeRows.get(index);
        if (rowEl) {
          this._recycleRow(rowEl);
        }
        this.activeRows.delete(index);
      }
    });

    // Render new rows
    neededIndices.forEach(index => {
      if (!this.activeRows.has(index)) {
        const rowEl = this._getOrCreateRow();
        this._renderRow(rowEl, index);
        this.activeRows.set(index, rowEl);
      }
    });

    // Sort rows in DOM order (important for screen readers)
    const sortedIndices = Array.from(this.activeRows.keys()).sort((a, b) => a - b);
    sortedIndices.forEach(index => {
      const rowEl = this.activeRows.get(index);
      if (rowEl) {
        this.rowContainer!.appendChild(rowEl);
      }
    });
  }

  /**
   * Get a row from the pool or create a new one
   */
  private _getOrCreateRow(): HTMLDivElement {
    if (this.rowPool.length > 0) {
      return this.rowPool.pop()!;
    }

    const row = document.createElement('div');
    row.className = this.rowClass;
    return row;
  }

  /**
   * Render content into a row element
   */
  private _renderRow(rowEl: HTMLDivElement, index: number): void {
    const item = this.items[index];
    if (!item) return;

    // Clear existing content
    rowEl.innerHTML = '';

    // Call the render function
    if (this.rowRenderer) {
      this.rowRenderer(rowEl, item, index);
    }

    // Set ARIA attributes for accessibility
    rowEl.setAttribute('aria-posinset', String(index + 1));
    rowEl.setAttribute('aria-setsize', String(this.items.length));

    // Attach swipe handlers if enabled
    if (this.enableSwipe) {
      const swipeContainer = rowEl.querySelector<HTMLElement>('.swipe-container');
      if (swipeContainer) {
        swipeManager.attach(swipeContainer);
      }
    }

    // Cache measured height if different from estimate
    // (done after next frame to ensure layout is complete)
    requestAnimationFrame(() => {
      const measuredHeight = rowEl.offsetHeight;
      if (measuredHeight && measuredHeight !== this.rowHeight) {
        this.heightCache.set(index, measuredHeight);
      }
    });
  }

  /**
   * Recycle a row back to the pool
   */
  private _recycleRow(rowEl: HTMLDivElement, skipSwipeCleanup: boolean = false): void {
    if (!skipSwipeCleanup && this.enableSwipe) {
      // Detach swipe handlers
      const swipeContainer = rowEl.querySelector<HTMLElement>('.swipe-container');
      if (swipeContainer) {
        swipeManager.detach(swipeContainer);
        // Reset swipe state
        swipeContainer.classList.remove('revealed-left', 'revealed-right');
        const content = swipeContainer.querySelector<HTMLElement>('.swipe-content');
        if (content) {
          content.style.transform = '';
          content.classList.remove('swiping', 'spring-back');
        }
      }
    }

    // Remove from DOM
    if (rowEl.parentNode) {
      rowEl.parentNode.removeChild(rowEl);
    }

    // Clear content
    rowEl.innerHTML = '';

    // Add to pool
    this.rowPool.push(rowEl);
  }

  /**
   * Update the data set
   */
  setData(items: T[], preservePosition: boolean = false): void {
    const previousScrollRatio = preservePosition && this.items.length > 0
      ? this.scrollContainer!.scrollTop / this.totalHeightEstimate
      : 0;

    this.items = items;
    this.heightCache.clear();
    this._calculateHeightEstimate();

    // Recycle all current rows
    this.activeRows.forEach((rowEl) => {
      this._recycleRow(rowEl);
    });
    this.activeRows.clear();

    if (preservePosition && items.length > 0) {
      // Restore approximate scroll position
      requestAnimationFrame(() => {
        this.scrollContainer!.scrollTop = previousScrollRatio * this.totalHeightEstimate;
        this._updateVisibleRange();
        this._render();
      });
    } else {
      // Reset to top
      this.scrollContainer!.scrollTop = 0;
      this.visibleStart = 0;
      this._updateVisibleRange();
      this._render();
    }
  }

  /**
   * Scroll to a specific item index
   */
  scrollToIndex(index: number, position: ScrollPosition = 'start'): void {
    const targetOffset = index * this.rowHeight;
    const viewportHeight = this.scrollContainer!.clientHeight;

    let scrollTop: number;
    switch (position) {
      case 'center':
        scrollTop = targetOffset - (viewportHeight / 2) + (this.rowHeight / 2);
        break;
      case 'end':
        scrollTop = targetOffset - viewportHeight + this.rowHeight;
        break;
      default: // 'start'
        scrollTop = targetOffset;
    }

    this.scrollContainer!.scrollTop = Math.max(0, scrollTop);
  }

  /**
   * Get the scroll container element (for external scroll position management)
   */
  getScrollContainer(): HTMLDivElement | null {
    return this.scrollContainer;
  }

  /**
   * Get the current scroll position
   */
  getScrollTop(): number {
    return this.scrollContainer?.scrollTop || 0;
  }

  /**
   * Set the scroll position
   */
  setScrollTop(scrollTop: number): void {
    if (this.scrollContainer) {
      this.scrollContainer.scrollTop = scrollTop;
    }
  }

  /**
   * Refresh the visible items (re-render without changing data)
   */
  refresh(): void {
    // Re-render all active rows
    this.activeRows.forEach((rowEl, index) => {
      this._renderRow(rowEl, index);
    });
  }

  /**
   * Destroy the virtual scroller and clean up
   */
  destroy(): void {
    // Cancel pending RAF
    if (this.scrollRAF) {
      cancelAnimationFrame(this.scrollRAF);
      this.scrollRAF = null;
    }

    // Disconnect resize observer
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }

    // Remove scroll listener
    if (this.scrollContainer) {
      this.scrollContainer.removeEventListener('scroll', this._onScroll);
    }

    // Recycle all rows
    this.activeRows.forEach((rowEl) => {
      this._recycleRow(rowEl);
    });
    this.activeRows.clear();
    this.rowPool = [];

    // Clear container
    if (this.containerEl) {
      this.containerEl.classList.remove('vs-enabled');
      this.containerEl.innerHTML = '';
    }

    // Clear references
    this.containerEl = null;
    this.scrollContainer = null;
    this.spacerTop = null;
    this.spacerBottom = null;
    this.rowContainer = null;
    this.items = [];
    this.rowRenderer = null;
    this.heightCache.clear();
  }

  /**
   * Check if the scroller is initialized
   */
  isInitialized(): boolean {
    return this.containerEl !== null && this.scrollContainer !== null;
  }

  /**
   * Get statistics about the current state
   */
  getStats(): VirtualScrollerStats {
    return {
      totalItems: this.items.length,
      visibleStart: this.visibleStart,
      visibleEnd: this.visibleEnd,
      renderedCount: this.activeRows.size,
      poolSize: this.rowPool.length,
      estimatedHeight: this.totalHeightEstimate,
      scrollTop: this.scrollContainer?.scrollTop || 0
    };
  }
}

// ==========================================
// FACTORY FUNCTION
// ==========================================

/**
 * Create a new VirtualScroller instance
 */
export function createVirtualScroller<T = unknown>(options: VirtualScrollerOptions = {}): VirtualScroller<T> {
  return new VirtualScroller<T>(options);
}
