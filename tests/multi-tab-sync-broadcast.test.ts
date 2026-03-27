import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BroadcastChannelManager } from '../js/modules/core/multi-tab-sync-broadcast.js';

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

    manager.sendStateUpdate('budget_tracker_transactions', undefined, {
      revision: 14,
      changedIds: ['tx_1', 'tx_2'],
      changeType: 'update'
    });

    const channel = MockBroadcastChannel.instances[0];
    expect(channel).toBeDefined();

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
      key: 'budget_tracker_transactions',
      value: undefined,
      revision: 14,
      changedIds: ['tx_1', 'tx_2'],
      changeType: 'update'
    });

    manager.dispose();
  });
});
