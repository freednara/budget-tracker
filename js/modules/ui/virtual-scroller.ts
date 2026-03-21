/**
 * Virtual Scrolling Implementation
 * 
 * High-performance virtual scrolling for large data lists.
 * Only renders visible items to maintain smooth performance.
 * 
 * @module ui/virtual-scroller
 */
'use strict';

// ==========================================
// TYPES
// ==========================================

export interface VirtualScrollConfig<T> {
  container: HTMLElement;
  items: T[];
  itemHeight: number;
  renderItem: (item: T, index: number) => string;
  overscan?: number; // Extra items to render for smooth scrolling
}

export interface VirtualScrollState {
  scrollTop: number;
  containerHeight: number;
  visibleStartIndex: number;
  visibleEndIndex: number;
  totalHeight: number;
}

// ==========================================
// VIRTUAL SCROLLER CLASS
// ==========================================

export class VirtualScroller<T> {
  private config: Required<VirtualScrollConfig<T>>;
  private state: VirtualScrollState;
  private viewport!: HTMLElement;
  private content!: HTMLElement;
  private scrollHandler: () => void;
  private resizeObserver: ResizeObserver | null = null;
  private rafPending: boolean = false;

  constructor(config: VirtualScrollConfig<T>) {
    this.config = {
      overscan: 5,
      ...config
    };

    this.state = {
      scrollTop: 0,
      containerHeight: 0,
      visibleStartIndex: 0,
      visibleEndIndex: 0,
      totalHeight: config.items.length * config.itemHeight
    };

    this.scrollHandler = this.handleScroll.bind(this);
    this.init();
  }

  /**
   * Initialize virtual scroller
   */
  private init(): void {
    this.setupDOM();
    this.setupObservers();
    this.updateState();
    this.render();
  }

  /**
   * Setup DOM structure
   */
  private spacer!: HTMLDivElement;

  private setupDOM(): void {
    // Clear container
    this.config.container.innerHTML = '';

    // Create viewport (scrollable container)
    this.viewport = document.createElement('div');
    this.viewport.style.cssText = `
      height: 100%;
      overflow-y: auto;
      position: relative;
    `;

    // Create spacer (sets total scroll height for proper scrollbar)
    this.spacer = document.createElement('div');
    this.spacer.style.cssText = `
      width: 1px;
      pointer-events: none;
    `;

    // Create content container (holds visible items)
    this.content = document.createElement('div');
    this.content.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
    `;

    this.viewport.appendChild(this.spacer);
    this.viewport.appendChild(this.content);
    this.config.container.appendChild(this.viewport);

    // Add scroll listener
    this.viewport.addEventListener('scroll', this.scrollHandler, { passive: true });
  }

  /**
   * Setup resize observer for responsive updates
   */
  private setupObservers(): void {
    if ('ResizeObserver' in window) {
      this.resizeObserver = new ResizeObserver(entries => {
        for (const entry of entries) {
          if (entry.target === this.config.container) {
            this.state.containerHeight = entry.contentRect.height;
            this.updateState();
            this.render();
          }
        }
      });
      
      this.resizeObserver.observe(this.config.container);
    } else {
      // Fallback for browsers without ResizeObserver
      this.state.containerHeight = this.config.container.clientHeight;
    }
  }

  /**
   * Handle scroll events
   */
  private handleScroll(): void {
    if (this.rafPending) return;
    this.rafPending = true;
    requestAnimationFrame(() => {
      this.rafPending = false;
      this.state.scrollTop = this.viewport.scrollTop;
      this.updateState();
      this.render();
    });
  }

  /**
   * Update virtual scroll state
   */
  private updateState(): void {
    const { itemHeight, items, overscan } = this.config;
    const { scrollTop, containerHeight } = this.state;

    // Calculate visible range
    const visibleStart = Math.floor(scrollTop / itemHeight);
    const visibleEnd = Math.min(
      items.length - 1,
      Math.ceil((scrollTop + containerHeight) / itemHeight)
    );

    // Add overscan for smooth scrolling
    this.state.visibleStartIndex = Math.max(0, visibleStart - overscan);
    this.state.visibleEndIndex = Math.min(items.length - 1, visibleEnd + overscan);
    this.state.totalHeight = items.length * itemHeight;
  }

  /**
   * Render visible items
   */
  private render(): void {
    const { items, itemHeight, renderItem } = this.config;
    const { visibleStartIndex, visibleEndIndex, totalHeight } = this.state;

    // Set spacer height for proper scrollbar (viewport keeps its CSS height)
    this.spacer.style.height = `${totalHeight}px`;

    // Position content container
    const offsetY = visibleStartIndex * itemHeight;
    this.content.style.transform = `translateY(${offsetY}px)`;

    // Render visible items
    let html = '';
    for (let i = visibleStartIndex; i <= visibleEndIndex; i++) {
      if (i < items.length) {
        html += `<div class="virtual-item" style="height: ${itemHeight}px;">
          ${renderItem(items[i], i)}
        </div>`;
      }
    }

    this.content.innerHTML = html;
  }

  /**
   * Update items and re-render
   */
  updateItems(newItems: T[]): void {
    this.config.items = newItems;
    this.state.totalHeight = newItems.length * this.config.itemHeight;
    this.updateState();
    this.render();
  }

  /**
   * Scroll to specific item index
   */
  scrollToIndex(index: number): void {
    const targetScrollTop = index * this.config.itemHeight;
    this.viewport.scrollTop = targetScrollTop;
  }

  /**
   * Get performance stats
   */
  getStats(): {
    totalItems: number;
    renderedItems: number;
    renderRatio: number;
  } {
    const totalItems = this.config.items.length;
    const renderedItems = this.state.visibleEndIndex - this.state.visibleStartIndex + 1;
    
    return {
      totalItems,
      renderedItems,
      renderRatio: totalItems > 0 ? renderedItems / totalItems : 0
    };
  }

  /**
   * Cleanup virtual scroller
   */
  destroy(): void {
    this.viewport?.removeEventListener('scroll', this.scrollHandler);
    
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    
    this.config.container.innerHTML = '';
  }
}

// ==========================================
// HELPER FUNCTIONS
// ==========================================

/**
 * Create a virtual scroller for transaction lists
 */
export function createTransactionVirtualScroller(
  container: HTMLElement,
  transactions: any[],
  renderTransaction: (transaction: any, index: number) => string
): VirtualScroller<any> {
  return new VirtualScroller({
    container,
    items: transactions,
    itemHeight: 60, // Standard transaction row height
    renderItem: renderTransaction,
    overscan: 10 // Render 10 extra items for smooth scrolling
  });
}

/**
 * Performance-optimized virtual list for large datasets
 */
export function createOptimizedVirtualList<T>(
  config: VirtualScrollConfig<T> & {
    debounceMs?: number;
    onScroll?: (state: VirtualScrollState) => void;
  }
): VirtualScroller<T> & { onScroll?: (state: VirtualScrollState) => void } {
  const scroller = new VirtualScroller(config);

  // Attach debounced scroll callback via viewport event listener (not monkey-patching)
  if (config.onScroll) {
    let debounceTimer: number;
    const viewport = scroller['viewport'] as HTMLElement;
    if (viewport) {
      viewport.addEventListener('scroll', () => {
        if (debounceTimer) {
          clearTimeout(debounceTimer);
        }
        debounceTimer = window.setTimeout(() => {
          config.onScroll!(scroller['state']);
        }, config.debounceMs || 100);
      }, { passive: true });
    }
  }

  return scroller as any;
}