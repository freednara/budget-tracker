/**
 * Multi-Tab Sync Broadcast Channel
 * 
 * Handles BroadcastChannel communication for multi-tab synchronization.
 * Extracted from multi-tab-sync.ts for better modularity.
 * 
 * @module multi-tab-sync-broadcast
 */

import { generateId } from './utils-dom.js';
import { emit } from './event-bus.js';
import { getTabId } from './tab-id.js';

// ==========================================
// TYPE DEFINITIONS
// ==========================================

export interface BroadcastMessage {
  type: 'state_update' | 'full_sync' | 'ping' | 'reload_request' | 'atomic_sync' | 'conflict_warning';
  key?: string;
  value?: unknown;
  timestamp: number;
  tabId: string;
  messageId?: string;
  atomicBundle?: AtomicSyncBundle;
  userActivity?: any;
}

export interface AtomicSyncBundle {
  bundleId: string;
  bundleTimestamp: number;
  atomicUpdates: Array<{
    key: string;
    value: unknown;
    checksum?: string;
  }>;
  coupledKeys: string[];
}

// ==========================================
// BROADCAST CHANNEL MANAGEMENT
// ==========================================

export class BroadcastChannelManager {
  private channel: BroadcastChannel | null = null;
  private readonly channelName = 'budget_tracker_sync';
  private readonly tabId = getTabId();
  private messageHandlers = new Map<string, Set<(msg: BroadcastMessage) => void>>();
  private isInitialized = false;
  private processedMessages = new Set<string>();
  private readonly MESSAGE_CACHE_SIZE = 100;

  /**
   * Initialize the broadcast channel
   */
  init(): boolean {
    if (this.isInitialized || !('BroadcastChannel' in window)) {
      return false;
    }

    try {
      this.channel = new BroadcastChannel(this.channelName);
      
      this.channel.onmessage = (event) => {
        this.handleMessage(event.data);
      };
      
      this.channel.onmessageerror = (event) => {
        if (import.meta.env.DEV) console.error('BroadcastChannel message error:', event);
      };
      
      this.isInitialized = true;
      this.sendPing();
      
      return true;
    } catch (error) {
      if (import.meta.env.DEV) console.warn('Failed to initialize BroadcastChannel:', error);
      return false;
    }
  }

  /**
   * Send a message to other tabs
   */
  send(message: Omit<BroadcastMessage, 'tabId' | 'timestamp' | 'messageId'>): void {
    if (!this.channel || !this.isInitialized) {
      return;
    }

    const fullMessage: BroadcastMessage = {
      ...message,
      tabId: this.tabId,
      timestamp: Date.now(),
      messageId: generateId()
    };

    try {
      this.channel.postMessage(fullMessage);
      this.addToProcessed(fullMessage.messageId!);
    } catch (error) {
      if (import.meta.env.DEV) console.error('Failed to send broadcast message:', error);
    }
  }

  /**
   * Handle incoming message
   */
  private handleMessage(message: BroadcastMessage): void {
    // Ignore our own messages
    if (message.tabId === this.tabId) {
      return;
    }

    // Ignore already processed messages (deduplication)
    if (message.messageId && this.processedMessages.has(message.messageId)) {
      return;
    }

    if (message.messageId) {
      this.addToProcessed(message.messageId);
    }

    // Notify handlers
    const handlers = this.messageHandlers.get(message.type);
    if (handlers) {
      handlers.forEach(handler => {
        try {
          handler(message);
        } catch (error) {
          if (import.meta.env.DEV) console.error('Broadcast message handler error:', error);
        }
      });
    }

    // Emit generic event
    emit('broadcast:message', message);
  }

  /**
   * Register a message handler
   */
  on(type: BroadcastMessage['type'], handler: (msg: BroadcastMessage) => void): () => void {
    if (!this.messageHandlers.has(type)) {
      this.messageHandlers.set(type, new Set());
    }
    
    this.messageHandlers.get(type)!.add(handler);
    
    // Return unsubscribe function
    return () => {
      this.messageHandlers.get(type)?.delete(handler);
    };
  }

  /**
   * Send a ping message
   */
  sendPing(): void {
    this.send({ type: 'ping' });
  }

  /**
   * Send state update
   */
  sendStateUpdate(key: string, value: unknown): void {
    this.send({
      type: 'state_update',
      key,
      value
    });
  }

  /**
   * Send atomic sync bundle
   */
  sendAtomicSync(bundle: AtomicSyncBundle): void {
    this.send({
      type: 'atomic_sync',
      atomicBundle: bundle
    });
  }

  /**
   * Request full sync from other tabs
   */
  requestFullSync(): void {
    this.send({ type: 'full_sync' });
  }

  /**
   * Request reload from other tabs
   */
  requestReload(): void {
    this.send({ type: 'reload_request' });
  }

  /**
   * Send conflict warning
   */
  sendConflictWarning(key: string, userActivity?: any): void {
    this.send({
      type: 'conflict_warning',
      key,
      userActivity
    });
  }

  /**
   * Add message ID to processed cache
   */
  private addToProcessed(messageId: string): void {
    this.processedMessages.add(messageId);
    
    // Cleanup old messages if cache is too large
    if (this.processedMessages.size > this.MESSAGE_CACHE_SIZE) {
      const toDelete = this.processedMessages.size - this.MESSAGE_CACHE_SIZE;
      const iterator = this.processedMessages.values();
      for (let i = 0; i < toDelete; i++) {
        const result = iterator.next();
        if (!result.done) {
          this.processedMessages.delete(result.value);
        }
      }
    }
  }

  /**
   * Get the current tab ID
   */
  getTabId(): string {
    return this.tabId;
  }

  /**
   * Check if broadcast channel is supported and initialized
   */
  isAvailable(): boolean {
    return this.isInitialized && this.channel !== null;
  }

  /**
   * Cleanup and close the channel
   */
  dispose(): void {
    if (this.channel) {
      this.channel.close();
      this.channel = null;
    }
    this.messageHandlers.clear();
    this.processedMessages.clear();
    this.isInitialized = false;
  }
}

// Export singleton instance
export const broadcastManager = new BroadcastChannelManager();