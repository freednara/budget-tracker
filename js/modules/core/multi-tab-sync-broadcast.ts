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
import { trackError } from './error-tracker.js';

// ==========================================
// TYPE DEFINITIONS
// ==========================================

// Phase 6 Slice 1j (rev 12 L6): optional fields widened to `field?: T | undefined`
// so callers can pass explicit `undefined` values under
// `exactOptionalPropertyTypes`. Sync payloads are assembled from remote
// sources where any of these fields may be legitimately absent.
export interface BroadcastMessage {
  type: 'state_update' | 'full_sync' | 'ping' | 'reload_request' | 'atomic_sync' | 'conflict_warning';
  key?: string | undefined;
  value?: unknown;
  revision?: number | undefined;
  changedIds?: string[] | undefined;
  changeType?: string | undefined;
  timestamp: number;
  tabId: string;
  messageId?: string | undefined;
  atomicBundle?: AtomicSyncBundle | undefined;
  userActivity?: unknown;
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

const VALID_MESSAGE_TYPES = new Set<BroadcastMessage['type']>([
  'state_update',
  'full_sync',
  'ping',
  'reload_request',
  'atomic_sync',
  'conflict_warning'
]);

// ==========================================
// BROADCAST CHANNEL MANAGEMENT
// ==========================================

export class BroadcastChannelManager {
  private channel: BroadcastChannel | null = null;
  private readonly channelName = 'harbor_sync';
  private readonly tabId = getTabId();
  private messageHandlers = new Map<string, Set<(msg: BroadcastMessage) => void>>();
  private isInitialized = false;
  private processedMessages = new Map<string, number>();
  private readonly MESSAGE_TTL_MS = 30000; // 30 seconds
  private readonly MAX_MESSAGE_AGE_MS = 5 * 60 * 1000;
  private readonly MAX_FUTURE_SKEW_MS = 10 * 1000;

  /**
   * Initialize the broadcast channel
   */
  init(): boolean {
    // CR-Apr24-I finding 339: return true for idempotent re-init
    // so callers can distinguish "already live" from "failed".
    if (this.isInitialized) return true;
    if (!('BroadcastChannel' in window)) return false;

    try {
      this.channel = new BroadcastChannel(this.channelName);
      
      this.channel.onmessage = (event) => {
        this.handleMessage(event.data);
      };
      
      this.channel.onmessageerror = (event) => {
        if (import.meta.env.DEV) console.error('BroadcastChannel message error:', event);
        // SYNC-02: surface in production so dropped messages are observable
        trackError(
          new Error('BroadcastChannel message deserialization failed'),
          { module: 'MultiTabSync', action: 'onmessageerror' },
          'error'
        );
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
  private handleMessage(message: unknown): void {
    if (!this.isValidMessage(message)) {
      if (import.meta.env.DEV) console.warn('Ignoring invalid BroadcastChannel payload', message);
      return;
    }

    // Ignore our own messages
    if (message.tabId === this.tabId) {
      return;
    }

    // Validate that messageId exists before processing
    if (!message.messageId) {
      return;
    }

    // Ignore already processed messages (deduplication)
    if (this.processedMessages.has(message.messageId)) {
      return;
    }

    this.addToProcessed(message.messageId);

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

  private isValidMessage(message: unknown): message is BroadcastMessage {
    if (!message || typeof message !== 'object') {
      return false;
    }

    const candidate = message as Partial<BroadcastMessage>;
    if (!VALID_MESSAGE_TYPES.has(candidate.type as BroadcastMessage['type'])) {
      return false;
    }

    if (typeof candidate.tabId !== 'string' || candidate.tabId.trim().length === 0) {
      return false;
    }

    if (typeof candidate.messageId !== 'string' || candidate.messageId.trim().length === 0) {
      return false;
    }

    if (typeof candidate.timestamp !== 'number' || !Number.isFinite(candidate.timestamp)) {
      return false;
    }

    const now = Date.now();
    if (candidate.timestamp < now - this.MAX_MESSAGE_AGE_MS) {
      return false;
    }

    if (candidate.timestamp > now + this.MAX_FUTURE_SKEW_MS) {
      return false;
    }

    if (candidate.key !== undefined && typeof candidate.key !== 'string') {
      return false;
    }

    if (candidate.revision !== undefined && !Number.isFinite(candidate.revision)) {
      return false;
    }

    if (candidate.changedIds !== undefined) {
      if (!Array.isArray(candidate.changedIds) || candidate.changedIds.some((id) => typeof id !== 'string')) {
        return false;
      }
    }

    if (candidate.atomicBundle !== undefined && !this.isValidAtomicBundle(candidate.atomicBundle)) {
      return false;
    }

    switch (candidate.type) {
      case 'state_update':
      case 'conflict_warning':
        return typeof candidate.key === 'string' && candidate.key.trim().length > 0;
      case 'atomic_sync':
        return this.isValidAtomicBundle(candidate.atomicBundle);
      case 'full_sync':
      case 'ping':
      case 'reload_request':
        return true;
      default:
        return false;
    }
  }

  private isValidAtomicBundle(bundle: unknown): bundle is AtomicSyncBundle {
    if (!bundle || typeof bundle !== 'object') {
      return false;
    }

    const candidate = bundle as Partial<AtomicSyncBundle>;
    if (typeof candidate.bundleId !== 'string' || candidate.bundleId.trim().length === 0) {
      return false;
    }

    if (typeof candidate.bundleTimestamp !== 'number' || !Number.isFinite(candidate.bundleTimestamp)) {
      return false;
    }

    if (!Array.isArray(candidate.coupledKeys) || candidate.coupledKeys.some((key) => typeof key !== 'string')) {
      return false;
    }

    if (!Array.isArray(candidate.atomicUpdates)) {
      return false;
    }

    return candidate.atomicUpdates.every((update) => {
      if (!update || typeof update !== 'object') {
        return false;
      }

      const candidateUpdate = update as Partial<AtomicSyncBundle['atomicUpdates'][number]>;
      if (typeof candidateUpdate.key !== 'string' || candidateUpdate.key.trim().length === 0) {
        return false;
      }

      if (candidateUpdate.checksum !== undefined && typeof candidateUpdate.checksum !== 'string') {
        return false;
      }

      return true;
    });
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
  sendStateUpdate(
    key: string,
    value: unknown,
    metadata: { revision?: number; changedIds?: string[]; changeType?: string } = {}
  ): void {
    this.send({
      type: 'state_update',
      key,
      value,
      revision: metadata.revision,
      changedIds: metadata.changedIds,
      changeType: metadata.changeType
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
  sendConflictWarning(key: string, userActivity?: unknown): void {
    this.send({
      type: 'conflict_warning',
      key,
      userActivity
    });
  }

  /**
   * Add message ID to processed cache with TTL-based cleanup
   */
  private addToProcessed(messageId: string): void {
    const now = Date.now();
    this.processedMessages.set(messageId, now);

    // Cleanup expired messages (older than MESSAGE_TTL_MS)
    const expireTime = now - this.MESSAGE_TTL_MS;
    for (const [id, timestamp] of this.processedMessages.entries()) {
      if (timestamp < expireTime) {
        this.processedMessages.delete(id);
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
