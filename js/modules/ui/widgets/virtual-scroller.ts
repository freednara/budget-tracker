/**
 * Virtual Scroller Module
 *
 * Efficient rendering for large lists using DOM recycling and viewport-based rendering.
 * Only renders visible items plus a buffer zone for smooth scrolling.
 *
 * Key improvements:
 * - Optimized render cycle with differential updates
 * - Safe swipe manager integration with state reset
 * - Dynamic row height calculation for variable content
 * - Performance tracking and memory management
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
  trackRowHeights?: boolean; // Enable dynamic height tracking
  maxPoolSize?: number; // Limit row pool size for memory management
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
  averageRowHeight: number;
  scrollTop: number;
  renderCacheHits: number;
}

interface SwipeState {
  revealed: boolean;
  direction: 'left' | 'right' | null;
  animating: boolean;
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
  private trackRowHeights: boolean;
  private maxPoolSize: number;

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

  // Row recycling pool with size limit
  private rowPool: HTMLDivElement[] = [];
  private activeRows: Map<number, HTMLDivElement> = new Map();

  // Height tracking for variable content
  private heightCache: Map<number, number> = new Map();
  private totalHeightEstimate: number = 0;
  private measuredRowCount: number = 0;
  private totalMeasuredHeight: number = 0;

  // Swipe state tracking
  private swipeStates: Map<HTMLElement, SwipeState> = new Map();

  // Performance tracking
  private renderCacheHits: number = 0;

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
    this.trackRowHeights = options.trackRowHeights !== false;
    this.maxPoolSize = options.maxPoolSize || 50;

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
   * Clean up existing content and swipe handlers safely
   */
  private _cleanupExistingContent(): void {
    // Detach swipe handlers from existing content with state cleanup
    this.containerEl!.querySelectorAll<HTMLElement>('.swipe-container').forEach(container => {
      this._resetSwipeState(container);
      swipeManager.detach(container);
    });

    // Clear swipe state tracking
    this.swipeStates.clear();

    // Clear active rows
    this.activeRows.forEach((rowEl) => {
      this._recycleRow(rowEl, true);
    });
    this.activeRows.clear();
  }

  /**
   * Reset swipe state for an element
   */
  private _resetSwipeState(container: HTMLElement): void {
    const swipeState = this.swipeStates.get(container);
    if (swipeState?.animating) {
      // Force complete any ongoing animations
      container.classList.remove('revealed-left', 'revealed-right');
      const content = container.querySelector<HTMLElement>('.swipe-content');
      if (content) {
        content.style.transform = '';
        content.style.transition = '';
        content.classList.remove('swiping', 'spring-back');
      }
    }
    this.swipeStates.delete(container);
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
   * Calculate total height estimate using dynamic average when available
   */
  private _calculateHeightEstimate(): void {
    const averageHeight = this.getAverageRowHeight();
    this.totalHeightEstimate = this.items.length * averageHeight;
  }

  /**
   * Get average row height based on measured heights
   */
  private getAverageRowHeight(): number {
    if (this.measuredRowCount === 0) {
      return this.rowHeight; // Fallback to estimated height
    }
    
    const average = this.totalMeasuredHeight / this.measuredRowCount;
    // Smooth the transition between estimate and measured
    const confidence = Math.min(this.measuredRowCount / 20, 1); // Full confidence after 20 measurements
    return this.rowHeight * (1 - confidence) + average * confidence;
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
      if (scrollDelta > this.getAverageRowHeight() / 2) {
        this.lastScrollTop = scrollTop;
        this._updateVisibleRange();
        this._renderOptimized();
      }
    });
  }

  /**
   * Handle container resize
   */
  private _onResize(): void {
    this._updateVisibleRange();
    this._renderOptimized();
  }

  /**
   * Update the visible range based on scroll position
   */
  private _updateVisibleRange(): void {
    const scrollTop = this.scrollContainer!.scrollTop;
    const viewportHeight = this.scrollContainer!.clientHeight;
    const averageHeight = this.getAverageRowHeight();

    // Calculate visible range with buffer
    const firstVisible = Math.floor(scrollTop / averageHeight);
    const visibleCount = Math.ceil(viewportHeight / averageHeight);

    this.visibleStart = Math.max(0, firstVisible - this.bufferSize);
    this.visibleEnd = Math.min(this.items.length, firstVisible + visibleCount + this.bufferSize);
  }

  /**
   * Optimized render that only updates changed rows
   */
  private _renderOptimized(): void {
    // Update spacer heights
    const averageHeight = this.getAverageRowHeight();
    const startOffset = this.visibleStart * averageHeight;
    const endOffset = Math.max(0, this.totalHeightEstimate - (this.visibleEnd * averageHeight));

    this.spacerTop!.style.height = `${startOffset}px`;
    this.spacerBottom!.style.height = `${endOffset}px`;

    // Track which indices are currently rendered
    const currentIndices = new Set(this.activeRows.keys());
    const neededIndices = new Set<number>();

    for (let i = this.visibleStart; i < this.visibleEnd; i++) {
      neededIndices.add(i);
    }

    // Identify rows to recycle (no longer visible)
    const toRecycle: number[] = [];
    const toKeep: number[] = [];
    
    currentIndices.forEach(index => {
      if (!neededIndices.has(index)) {
        toRecycle.push(index);
      } else {
        toKeep.push(index);
        this.renderCacheHits++;
      }
    });

    // Identify new rows needed
    const toCreate: number[] = [];
    neededIndices.forEach(index => {
      if (!currentIndices.has(index)) {
        toCreate.push(index);
      }
    });

    // Recycle rows that are no longer visible
    toRecycle.forEach(index => {
      const rowEl = this.activeRows.get(index);
      if (rowEl) {
        this._recycleRow(rowEl);
      }
      this.activeRows.delete(index);
    });

    // Render new rows only
    toCreate.forEach(index => {
      const rowEl = this._getOrCreateRow();
      this._renderRow(rowEl, index);
      this.activeRows.set(index, rowEl);
    });

    // Only re-order DOM if we have new rows (optimization)
    if (toCreate.length > 0) {
      this._reorderRows();
    }
  }

  /**
   * Re-order rows in DOM for proper accessibility and screen reader support
   */
  private _reorderRows(): void {
    // Get all active row indices and sort them
    const sortedIndices = Array.from(this.activeRows.keys()).sort((a, b) => a - b);
    
    // Create document fragment for efficient DOM manipulation
    const fragment = document.createDocumentFragment();
    
    sortedIndices.forEach(index => {
      const rowEl = this.activeRows.get(index);
      if (rowEl) {
        fragment.appendChild(rowEl);
      }
    });
    
    // Replace all rows at once
    this.rowContainer!.innerHTML = '';
    this.rowContainer!.appendChild(fragment);
  }

  /**
   * Fallback render method for compatibility
   */
  private _render(): void {
    this._renderOptimized();
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

    // Clear existing content and reset any swipe state
    this._clearRowContent(rowEl);

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
        // Initialize swipe state
        this.swipeStates.set(swipeContainer, {
          revealed: false,
          direction: null,
          animating: false
        });
        swipeManager.attach(swipeContainer);
      }
    }

    // Cache measured height if tracking is enabled
    if (this.trackRowHeights) {
      requestAnimationFrame(() => {
        const measuredHeight = rowEl.offsetHeight;
        if (measuredHeight && measuredHeight > 0) {
          const previousHeight = this.heightCache.get(index);
          
          // Update cache and running average
          this.heightCache.set(index, measuredHeight);
          
          if (previousHeight === undefined) {
            // New measurement
            this.measuredRowCount++;
            this.totalMeasuredHeight += measuredHeight;
          } else if (previousHeight !== measuredHeight) {
            // Updated measurement
            this.totalMeasuredHeight = this.totalMeasuredHeight - previousHeight + measuredHeight;
          }
          
          // Recalculate total height estimate if we have significant new data
          if (this.measuredRowCount % 10 === 0) {
            this._calculateHeightEstimate();
          }
        }
      });
    }
  }

  /**
   * Clear row content and reset any associated state
   */
  private _clearRowContent(rowEl: HTMLDivElement): void {
    // Find any swipe containers and clean up their state
    const swipeContainers = rowEl.querySelectorAll<HTMLElement>('.swipe-container');
    swipeContainers.forEach(container => {
      this._resetSwipeState(container);
    });

    // Clear HTML content
    rowEl.innerHTML = '';
  }

  /**
   * Recycle a row back to the pool with safe swipe cleanup
   */
  private _recycleRow(rowEl: HTMLDivElement, skipSwipeCleanup: boolean = false): void {
    if (!skipSwipeCleanup && this.enableSwipe) {
      // Safe swipe state cleanup
      const swipeContainer = rowEl.querySelector<HTMLElement>('.swipe-container');
      if (swipeContainer) {
        const swipeState = this.swipeStates.get(swipeContainer);
        
        // If actively swiping, wait for animation to complete
        if (swipeState?.animating) {
          // Force complete the animation
          swipeContainer.style.transition = 'none';
          requestAnimationFrame(() => {
            this._resetSwipeState(swipeContainer);
            swipeManager.detach(swipeContainer);
            swipeContainer.style.transition = '';
          });
        } else {
          this._resetSwipeState(swipeContainer);
          swipeManager.detach(swipeContainer);
        }
      }
    }

    // Remove from DOM
    if (rowEl.parentNode) {
      rowEl.parentNode.removeChild(rowEl);
    }

    // Clear content
    rowEl.innerHTML = '';

    // Add to pool with size limit
    if (this.rowPool.length < this.maxPoolSize) {
      this.rowPool.push(rowEl);
    }
    // If pool is full, let the element be garbage collected
  }

  /**
   * Update the data set
   */
  setData(items: T[], preservePosition: boolean = false): void {
    const previousScrollRatio = preservePosition && this.items.length > 0
      ? this.scrollContainer!.scrollTop / this.totalHeightEstimate
      : 0;

    this.items = items;
    
    // Reset height cache for new data
    this.heightCache.clear();
    this.measuredRowCount = 0;
    this.totalMeasuredHeight = 0;
    this.renderCacheHits = 0;
    
    this._calculateHeightEstimate();

    // Recycle all current rows
    this.activeRows.forEach((rowEl) => {
      this._recycleRow(rowEl);
    });
    this.activeRows.clear();
    this.swipeStates.clear();

    if (preservePosition && items.length > 0) {
      // Restore approximate scroll position
      requestAnimationFrame(() => {
        this.scrollContainer!.scrollTop = previousScrollRatio * this.totalHeightEstimate;
        this._updateVisibleRange();
        this._renderOptimized();
      });
    } else {
      // Reset to top
      this.scrollContainer!.scrollTop = 0;
      this.visibleStart = 0;
      this._updateVisibleRange();
      this._renderOptimized();
    }
  }

  /**
   * Scroll to a specific item index
   */
  scrollToIndex(index: number, position: ScrollPosition = 'start'): void {
    const averageHeight = this.getAverageRowHeight();
    const targetOffset = index * averageHeight;
    const viewportHeight = this.scrollContainer!.clientHeight;

    let scrollTop: number;
    switch (position) {
      case 'center':
        scrollTop = targetOffset - (viewportHeight / 2) + (averageHeight / 2);
        break;
      case 'end':
        scrollTop = targetOffset - viewportHeight + averageHeight;
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

    // Clean up all swipe states
    this.swipeStates.clear();

    // Recycle all rows
    this.activeRows.forEach((rowEl) => {
      this._recycleRow(rowEl);
    });
    this.activeRows.clear();
    this.rowPool = [];

    // Clear height cache
    this.heightCache.clear();

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
      averageRowHeight: this.getAverageRowHeight(),
      scrollTop: this.scrollContainer?.scrollTop || 0,
      renderCacheHits: this.renderCacheHits
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