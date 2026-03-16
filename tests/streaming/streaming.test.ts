import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createDingtalkReplyDispatcher } from '../../src/reply-dispatcher';

// Mock dependencies
vi.mock('../../src/ai-card', () => ({
  createAICardForTarget: vi.fn(),
  finishAICard: vi.fn(),
  streamAICard: vi.fn(),
  createPlainCard: vi.fn(),
  finishPlainCard: vi.fn(),
}));

vi.mock('../../src/oapi-token', () => ({
  getOapiAccessToken: vi.fn().mockResolvedValue('mock-token'),
}));

vi.mock('../../src/process-local-images', () => ({
  processLocalImages: vi.fn().mockImplementation((text) => Promise.resolve(text)),
}));

vi.mock('../../src/send-proactive', () => ({
  sendProactive: vi.fn().mockResolvedValue(undefined),
}));

describe('DingTalk Streaming', () => {
  // Helper to create mock runtime that properly calls deliver
  const createMockRuntime = () => ({
    channel: {
      reply: {
        createReplyDispatcherWithTyping: vi.fn().mockImplementation(({ deliver, onError }) => {
          let isIdle = true;
          let hasDeliverBeenCalled = false;

          return {
            dispatcher: {
              sendToolResult: vi.fn().mockReturnValue(true),
              sendBlockReply: vi.fn().mockImplementation((payload) => {
                isIdle = false;
                hasDeliverBeenCalled = true;
                // Simulate block delivery
                setTimeout(async () => {
                  await deliver(payload, { kind: 'block' });
                  isIdle = true;
                }, 0);
                return true;
              }),
              sendFinalReply: vi.fn().mockImplementation((payload) => {
                isIdle = false;
                hasDeliverBeenCalled = true;
                // Simulate final delivery
                setTimeout(async () => {
                  await deliver(payload, { kind: 'final' });
                  isIdle = true;
                }, 0);
                return true;
              }),
              waitForIdle: vi.fn().mockImplementation(async () => {
                while (!isIdle) {
                  await new Promise(r => setTimeout(r, 10));
                }
              }),
              getQueuedCounts: vi.fn().mockReturnValue({ tool: 0, block: 0, final: 0 }),
              markComplete: vi.fn(),
            },
            replyOptions: {
              onReplyStart: undefined,
              onTypingCleanup: undefined,
              onTypingController: undefined,
              // onPartialReply should check if deliver was called
              onPartialReply: vi.fn().mockImplementation(async (payload) => {
                // Simulate: if deliver was never called, onPartialReply handles it
                if (!hasDeliverBeenCalled) {
                  await deliver(payload, { kind: 'block' });
                }
              }),
            },
            markDispatchIdle: () => { isIdle = true; },
            markRunComplete: vi.fn(),
          };
        }),
        resolveHumanDelayConfig: vi.fn().mockReturnValue(undefined),
      },
    },
  });

  const mockConfig = {
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    usePlainCard: false,
  };

  const mockData = {
    senderStaffId: 'manager9461',
    conversationId: 'conv123',
  };

  const mockLog = {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  // Helper to create mock AICardInstance
  const createMockCard = (id: string) => ({
    cardInstanceId: id,
    accessToken: 'mock-access-token',
    inputingStarted: false,
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should initialize card only once during streaming via deliver', async () => {
    const { createAICardForTarget, streamAICard } = await import('../../src/ai-card');
    vi.mocked(createAICardForTarget).mockResolvedValueOnce(createMockCard('card-123'));
    vi.mocked(streamAICard).mockResolvedValue(undefined);

    const { dispatcher } = createDingtalkReplyDispatcher({
      cfg: {},
      agentId: 'test-agent',
      runtime: createMockRuntime() as any,
      dingtalkConfig: mockConfig as any,
      data: mockData,
      isDirect: true,
      log: mockLog,
    });

    // Use sendBlockReply to trigger deliver with kind='block'
    dispatcher.sendBlockReply({ text: 'Hello' });
    dispatcher.sendBlockReply({ text: 'Hello world' });
    dispatcher.sendBlockReply({ text: 'Hello world!' });

    // Wait for async operations
    await dispatcher.waitForIdle();

    // Verify createAICardForTarget was called only once
    expect(createAICardForTarget).toHaveBeenCalledTimes(1);

    // Verify streamAICard was called for each update
    expect(streamAICard).toHaveBeenCalledTimes(3);
  });

  it('should send full content for each block update', async () => {
    const { createAICardForTarget, streamAICard } = await import('../../src/ai-card');
    vi.mocked(createAICardForTarget).mockResolvedValueOnce(createMockCard('card-123'));
    vi.mocked(streamAICard).mockResolvedValue(undefined);

    const { dispatcher } = createDingtalkReplyDispatcher({
      cfg: {},
      agentId: 'test-agent',
      runtime: createMockRuntime() as any,
      dingtalkConfig: mockConfig as any,
      data: mockData,
      isDirect: true,
      log: mockLog,
    });

    const streamCalls: string[] = [];
    vi.mocked(streamAICard).mockImplementation(async (card, content, finished) => {
      streamCalls.push(content);
    });

    // Simulate streaming via sendBlockReply
    dispatcher.sendBlockReply({ text: 'H' });
    dispatcher.sendBlockReply({ text: 'He' });
    dispatcher.sendBlockReply({ text: 'Hello' });

    await dispatcher.waitForIdle();

    // Verify full content was sent each time
    expect(streamCalls).toEqual(['H', 'He', 'Hello']);
  });

  it('should finish card on final deliver', async () => {
    const { createAICardForTarget, finishAICard, streamAICard } = await import('../../src/ai-card');
    vi.mocked(createAICardForTarget).mockResolvedValueOnce(createMockCard('card-123'));
    vi.mocked(streamAICard).mockResolvedValue(undefined);
    vi.mocked(finishAICard).mockResolvedValue(undefined);

    const { dispatcher } = createDingtalkReplyDispatcher({
      cfg: {},
      agentId: 'test-agent',
      runtime: createMockRuntime() as any,
      dingtalkConfig: mockConfig as any,
      data: mockData,
      isDirect: true,
      log: mockLog,
    });

    // First, stream some content
    dispatcher.sendBlockReply({ text: 'Hello world' });
    await dispatcher.waitForIdle();

    // Then send final reply
    dispatcher.sendFinalReply({ text: 'Hello world!' });
    await dispatcher.waitForIdle();

    // Verify finishAICard was called with the card instance
    expect(finishAICard).toHaveBeenCalled();
    const finishCall = vi.mocked(finishAICard).mock.calls[0];
    expect(finishCall[0]).toHaveProperty('cardInstanceId', 'card-123');
  });

  it('should not create card when only onPartialReply is called (no deliver)', async () => {
    const { createAICardForTarget, streamAICard } = await import('../../src/ai-card');
    const { sendProactive } = await import('../../src/send-proactive');
    vi.mocked(createAICardForTarget).mockResolvedValue(createMockCard('card-123'));
    vi.mocked(streamAICard).mockResolvedValue(undefined);

    // Create a mock runtime where deliver is never called
    const mockRuntimeNoDeliver = {
      channel: {
        reply: {
          createReplyDispatcherWithTyping: vi.fn().mockImplementation(({ deliver, onError }) => {
            return {
              dispatcher: {
                sendToolResult: vi.fn().mockReturnValue(true),
                sendBlockReply: vi.fn().mockReturnValue(true),
                sendFinalReply: vi.fn().mockReturnValue(true),
                waitForIdle: vi.fn().mockResolvedValue(undefined),
                getQueuedCounts: vi.fn().mockReturnValue({ tool: 0, block: 0, final: 0 }),
                markComplete: vi.fn(),
              },
              replyOptions: {
                onReplyStart: undefined,
                onTypingCleanup: undefined,
                onTypingController: undefined,
                // onPartialReply that does NOT call deliver
                onPartialReply: vi.fn().mockImplementation(async (payload) => {
                  // This simulates the case where onPartialReply handles the reply
                  // without calling deliver
                }),
              },
              markDispatchIdle: vi.fn(),
              markRunComplete: vi.fn(),
            };
          }),
          resolveHumanDelayConfig: vi.fn().mockReturnValue(undefined),
        },
      },
    };

    const { replyOptions } = createDingtalkReplyDispatcher({
      cfg: {},
      agentId: 'test-agent',
      runtime: mockRuntimeNoDeliver as any,
      dingtalkConfig: mockConfig as any,
      data: mockData,
      isDirect: true,
      log: mockLog,
    });

    // Call onPartialReply directly
    if (replyOptions.onPartialReply) {
      await replyOptions.onPartialReply({ text: 'Hello' });
    }

    // Card should NOT be created because deliver was never called
    expect(createAICardForTarget).not.toHaveBeenCalled();
  });

  it('should handle empty or undefined text', async () => {
    const { createAICardForTarget, streamAICard } = await import('../../src/ai-card');

    const { dispatcher } = createDingtalkReplyDispatcher({
      cfg: {},
      agentId: 'test-agent',
      runtime: createMockRuntime() as any,
      dingtalkConfig: mockConfig as any,
      data: mockData,
      isDirect: true,
      log: mockLog,
    });

    // Empty string
    dispatcher.sendBlockReply({ text: '' });
    // Undefined
    dispatcher.sendBlockReply({});
    // Whitespace only
    dispatcher.sendBlockReply({ text: '   ' });

    await dispatcher.waitForIdle();

    // Card should not be created for empty content
    expect(createAICardForTarget).not.toHaveBeenCalled();
    expect(streamAICard).not.toHaveBeenCalled();
  });

  it('should not create multiple cards when deliver is called concurrently', async () => {
    const { createAICardForTarget, streamAICard } = await import('../../src/ai-card');

    // Simulate slow card creation
    let callCount = 0;
    vi.mocked(createAICardForTarget).mockImplementation(async () => {
      callCount++;
      await new Promise(r => setTimeout(r, 50));
      return createMockCard(`card-${callCount}`);
    });
    vi.mocked(streamAICard).mockResolvedValue(undefined);

    const { dispatcher } = createDingtalkReplyDispatcher({
      cfg: {},
      agentId: 'test-agent',
      runtime: createMockRuntime() as any,
      dingtalkConfig: mockConfig as any,
      data: mockData,
      isDirect: true,
      log: mockLog,
    });

    // Call sendBlockReply multiple times concurrently
    dispatcher.sendBlockReply({ text: 'Hello' });
    dispatcher.sendBlockReply({ text: 'Hello world' });
    dispatcher.sendBlockReply({ text: 'Hello world!' });

    await dispatcher.waitForIdle();

    // Verify createAICardForTarget was called only once
    expect(createAICardForTarget).toHaveBeenCalledTimes(1);

    // Verify all updates used the same card
    expect(streamAICard).toHaveBeenCalledTimes(3);
    const firstCardId = (vi.mocked(streamAICard).mock.calls[0][0] as any).cardInstanceId;
    expect((vi.mocked(streamAICard).mock.calls[1][0] as any).cardInstanceId).toBe(firstCardId);
    expect((vi.mocked(streamAICard).mock.calls[2][0] as any).cardInstanceId).toBe(firstCardId);
  });
});
