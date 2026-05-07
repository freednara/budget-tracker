import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BroadcastChannelManager } from '../js/modules/core/multi-tab-sync-broadcast.js';
import * as errorTracker from '../js/modules/core/error-tracker.js';

class MockBroadcastChannel {
  static instances: MockBroadcastChannel[] = [];

  onmessage: ((event: MessageEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  messages: unknown[] = [];
  name: string;

  constructor(name: string) {
    this.name = name;
    MockBroadcastChannel.instances.push(this);
  }

  postMessage(data: unknown): void {
    this.messages.push(data);
  }

  close(): void {
    MockBroadcastChannel.instances = MockBroadcastChannel.instances.filter((instance) => instance !== this);
  }

  static reset(): void {
    MockBroadcastChannel.instances = [];
  }
}

describe('BroadcastChannelManager', () => {
  beforeEach(() => {
    MockBroadcastChannel.reset();
    (globalThis as typeof globalThis & { BroadcastChannel?: typeof BroadcastChannel }).BroadcastChannel =
      MockBroadcastChannel as unknown as typeof BroadcastChannel;
  });

  afterEach(() => {
    MockBroadcastChannel.reset();
  });

  it('includes revision metadata in transaction state update broadcasts', () => {
    const manager = new BroadcastChannelManager();
    manager.init();

    manager.sendStateUpdate('harbor_transactions', undefined, {
      revision: 14,
      changedIds: ['tx_1', 'tx_2'],
      changeType: 'update'
    });

    const channel = MockBroadcastChannel.instances[0];
    expect(channel).toBeDefined();
    if (!channel) throw new Error('expected mock channel to be instantiated');

    const lastMessage = channel.messages[channel.messages.length - 1] as {
      type: string;
      key: string;
      value?: unknown;
      revision?: number;
      changedIds?: string[];
      changeType?: string;
    };

    expect(lastMessage).toMatchObject({
      type: 'state_update',
      key: 'harbor_transactions',
      value: undefined,
      revision: 14,
      changedIds: ['tx_1', 'tx_2'],
      changeType: 'update'
    });

    manager.dispose();
  });

  it('ignores malformed and stale inbound broadcast payloads', () => {
    const manager = new BroadcastChannelManager();
    manager.init();

    const onPing = vi.fn();
    const onStateUpdate = vi.fn();
    const unsubscribe = manager.on('ping', onPing);
    const unsubscribeStateUpdate = manager.on('state_update', onStateUpdate);
    const channel = MockBroadcastChannel.instances[0];
    if (!channel) throw new Error('expected mock channel to be instantiated');

    channel.onmessage?.({
      data: {
        type: '__proto__',
        tabId: 'other-tab',
        timestamp: Date.now(),
        messageId: 'invalid-type'
      }
    } as MessageEvent);

    channel.onmessage?.({
      data: {
        type: 'ping',
        tabId: 'other-tab',
        timestamp: Date.now() - (5 * 60 * 1000) - 1,
        messageId: 'stale-message'
      }
    } as MessageEvent);

    channel.onmessage?.({
      data: {
        type: 'state_update',
        tabId: 'other-tab',
        timestamp: Date.now(),
        messageId: 'missing-key'
      }
    } as MessageEvent);

    channel.onmessage?.({
      data: {
        type: 'atomic_sync',
        tabId: 'other-tab',
        timestamp: Date.now(),
        messageId: 'missing-bundle'
      }
    } as MessageEvent);

    channel.onmessage?.({
      data: {
        type: 'ping',
        tabId: 'other-tab',
        timestamp: Date.now(),
        messageId: 'valid-message'
      }
    } as MessageEvent);

    expect(onPing).toHaveBeenCalledTimes(1);
    expect(onStateUpdate).not.toHaveBeenCalled();

    unsubscribe();
    unsubscribeStateUpdate();
    manager.dispose();
  });

  it('SYNC-02: calls trackError on BroadcastChannel message deserialization failure', () => {
    const trackErrorSpy = vi.spyOn(errorTracker, 'trackError').mockImplementation(() => {});
    const manager = new BroadcastChannelManager();
    manager.init();

    const channel = MockBroadcastChannel.instances[0];
    if (!channel) throw new Error('expected mock channel to be instantiated');

    // Simulate a message deserialization error
    channel.onmessageerror?.({ data: null } as unknown as MessageEvent);

    expect(trackErrorSpy).toHaveBeenCalledTimes(1);
    expect(trackErrorSpy).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ module: 'MultiTabSync', action: 'onmessageerror' }),
      'error'
    );

    trackErrorSpy.mockRestore();
    manager.dispose();
  });
});
