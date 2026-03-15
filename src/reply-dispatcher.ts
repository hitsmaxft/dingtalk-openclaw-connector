import type { GetReplyOptions, ReplyPayload, PluginRuntime } from 'openclaw/plugin-sdk';
import type { DingTalkConfig } from '../plugin';
import {
  createAICardForTarget, finishAICard, streamAICard,
  createPlainCard, finishPlainCard,
  type AICardTarget, type AICardInstance, type PlainCardConfig
} from './ai-card';
import { sendProactive, type ProactiveTarget } from './send-proactive';
import { processLocalImages } from './process-local-images';
import { getOapiAccessToken } from './oapi-token';

export interface DingtalkReplyDispatcherOptions {
  cfg: any;
  agentId: string;
  runtime: PluginRuntime;
  dingtalkConfig: DingTalkConfig;
  data: any;
  isDirect: boolean;
  log?: any;
}

export interface DingtalkReplyDispatcherResult {
  dispatcher: any;
  replyOptions: GetReplyOptions;
  markDispatchIdle: () => void;
  markRunComplete?: () => void;
}

interface PendingPlainCard {
  cardId: string;
  cardConfig: PlainCardConfig;
  target: AICardTarget;
}

export function createDingtalkReplyDispatcher(
  options: DingtalkReplyDispatcherOptions,
): DingtalkReplyDispatcherResult {
  const { cfg, agentId, runtime, dingtalkConfig, data, isDirect, log } = options;

  log?.info?.(`[DingTalk][Dispatcher] createDingtalkReplyDispatcher called, usePlainCard=${dingtalkConfig.usePlainCard}`);

  // 获取 access token (用于媒体上传)
  let oapiToken: string | null = null;

  // 待处理的 AI Card（用于流式输出）
  let pendingAICard: AICardInstance | null = null;
  let aiCardContent = '';

  // 待处理的普通卡片（用于流式输出）
  let pendingPlainCard: PendingPlainCard | null = null;
  let plainCardContent = '';

  // 是否使用普通卡片
  const usePlainCard = dingtalkConfig.usePlainCard === true;

  // 标记 deliver 是否被调用过（用于区分 onPartialReply 是否应该创建卡片）
  let deliverCalled = false;

  // 卡片创建 Promise 锁 - 确保 initCard 只被调用一次
  let cardCreationPromise: Promise<boolean> | null = null;

  // 构建 AI Card 目标
  const buildAICardTarget = (): AICardTarget => {
    return isDirect
      ? { type: 'user', userId: data.senderStaffId || data.senderId }
      : { type: 'group', openConversationId: data.conversationId };
  };

  // 构建主动推送目标
  const buildProactiveTarget = (): ProactiveTarget => {
    return isDirect
      ? { userId: data.senderStaffId || data.senderId }
      : { openConversationId: data.conversationId };
  };

  // 确保获取 access token
  const ensureToken = async (): Promise<string | null> => {
    if (!oapiToken && dingtalkConfig.enableMediaUpload !== false) {
      oapiToken = await getOapiAccessToken(dingtalkConfig);
      log?.info?.(`[DingTalk][Dispatcher] oapiToken 获取${oapiToken ? '成功' : '失败'}`);
    }
    return oapiToken;
  };

  // 处理文本消息（后处理媒体标记）
  const processTextWithMedia = async (text: string): Promise<string> => {
    const token = await ensureToken();
    if (!token) return text;
    const processed = await processLocalImages(text, token, log);
    return processed;
  };

  // 初始化卡片（AI Card 或普通卡片）
  const initCard = async (): Promise<boolean> => {
    log?.info?.(`[DingTalk][Dispatcher] initCard called, usePlainCard=${usePlainCard}`);

    const aiCardTarget = buildAICardTarget();
    log?.info?.(`[DingTalk][Dispatcher] Building AI Card target: ${JSON.stringify(aiCardTarget)}`);

    if (usePlainCard) {
      const token = await ensureToken();
      if (!token) {
        log?.error?.('[DingTalk][Dispatcher] Cannot get token for plain card creation');
        return false;
      }
      const cardConfig: PlainCardConfig = { title: 'AI 助手', content: '' };
      log?.info?.(`[DingTalk][Dispatcher] Creating plain card...`);
      const cardId = await createPlainCard(dingtalkConfig, aiCardTarget, cardConfig, token, log);
      if (cardId) {
        pendingPlainCard = { cardId, cardConfig, target: aiCardTarget };
        plainCardContent = '';
        log?.info?.(`[DingTalk][Dispatcher] Plain card created: ${cardId}`);
        return true;
      }
    } else {
      log?.info?.(`[DingTalk][Dispatcher] Creating AI Card...`);
      const card = await createAICardForTarget(dingtalkConfig, aiCardTarget, log);
      if (card) {
        pendingAICard = card;
        aiCardContent = '';
        log?.info?.(`[DingTalk][Dispatcher] AI Card created: ${card.cardInstanceId}`);
        return true;
      }
    }

    log?.error?.('[DingTalk][Dispatcher] Failed to create card');
    return false;
  };

  // 更新卡片内容（流式）- content 是完整内容
  const updateCard = async (content: string): Promise<void> => {
    if (usePlainCard && pendingPlainCard) {
      plainCardContent = content;
      log?.debug?.(`[DingTalk][Dispatcher] Plain card content updated, length: ${plainCardContent.length}`);
    } else if (pendingAICard) {
      // 保存当前内容用于后续媒体处理
      aiCardContent = content;
      log?.debug?.(`[DingTalk][Dispatcher] Streaming AI Card update, cardId: ${pendingAICard.cardInstanceId}, content length: ${content.length}`);
      // 发送完整内容给钉钉 API（isFull=true 表示全量替换）
      await streamAICard(pendingAICard, content, false, log);
      log?.debug?.(`[DingTalk][Dispatcher] AI Card stream update completed`);
    } else {
      log?.warn?.(`[DingTalk][Dispatcher] No pending card to update`);
    }
  };

  // 完成卡片
  const finishCard = async (): Promise<void> => {
    log?.info?.(`[DingTalk][Dispatcher] finishCard called, usePlainCard=${usePlainCard}, pendingAICard=${!!pendingAICard}, pendingPlainCard=${!!pendingPlainCard}`);
    const token = await ensureToken();
    if (!token) {
      log?.error?.('[DingTalk][Dispatcher] Cannot get token for finishCard');
      return;
    }

    if (usePlainCard && pendingPlainCard) {
      const finalContent = await processTextWithMedia(plainCardContent);
      await finishPlainCard(dingtalkConfig, pendingPlainCard.cardId, finalContent, pendingPlainCard.target, token, log);
      log?.info?.(`[DingTalk][Dispatcher] Plain card finished: ${pendingPlainCard.cardId}`);
      pendingPlainCard = null;
      plainCardContent = '';
    } else if (pendingAICard) {
      const finalContent = await processTextWithMedia(aiCardContent);
      await finishAICard(pendingAICard, finalContent, log);
      log?.info?.(`[DingTalk][Dispatcher] AI Card finished: ${pendingAICard.cardInstanceId}`);
      pendingAICard = null;
      aiCardContent = '';
    } else {
      log?.warn?.('[DingTalk][Dispatcher] No pending card to finish');
    }
  };

  // 发送普通文本消息（降级方案）
  const sendTextReply = async (text: string): Promise<void> => {
    const proactiveTarget = buildProactiveTarget();
    const processedText = await processTextWithMedia(text);
    await sendProactive(dingtalkConfig, proactiveTarget, processedText, { msgType: 'text', useAICard: false, fallbackToNormal: true, log });
  };

  // 队列流式更新 - 使用 Promise 链确保顺序执行
  let streamingUpdateQueue: Promise<void> = Promise.resolve();
  const queueStreamingUpdate = async (content: string): Promise<void> => {
    streamingUpdateQueue = streamingUpdateQueue.then(async () => {
      await updateCard(content);
    }).catch((err) => {
      log?.error?.(`[DingTalk][Dispatcher] Streaming update error: ${err?.message || err}`);
    });
    await streamingUpdateQueue;
  };

  // 使用 createReplyDispatcherWithTyping 创建 dispatcher
  const { dispatcher, replyOptions: baseReplyOptions, markDispatchIdle, markRunComplete } =
    runtime.channel.reply.createReplyDispatcherWithTyping({
      deliver: async (payload: ReplyPayload, info: { kind: 'tool' | 'block' | 'final' }) => {
        const text = payload.text ?? '';
        const hasText = Boolean(text.trim());

        if (!hasText) return;

        // 标记 deliver 被调用过
        deliverCalled = true;

        // 对于 block 类型，创建卡片并更新
        if (info.kind === 'block') {
          // 如果没有卡片，创建一张（使用锁确保只创建一次）
          if (!pendingAICard && !pendingPlainCard) {
            // 如果已经有创建 Promise 在运行，等待它完成
            if (!cardCreationPromise) {
              cardCreationPromise = initCard();
            }
            const created = await cardCreationPromise;
            if (!created) {
              log?.warn?.(`[DingTalk][Dispatcher] Card creation failed, falling back to text`);
              await sendTextReply(text);
              return;
            }
          }

          // 直接发送完整内容，钉钉 API 会处理全量替换
          log?.info?.(`[DingTalk][Dispatcher] deliver block: text=${text.slice(0, 30)}..., len=${text.length}`);
          await queueStreamingUpdate(text);
        }

        // 对于 final 类型，完成流式
        if (info.kind === 'final') {
          // 只有在已经有卡片的情况下才发送最终内容
          if (!pendingAICard && !pendingPlainCard) {
            log?.info?.(`[DingTalk][Dispatcher] deliver final: no pending card, sending text reply`);
            await sendTextReply(text);
            return;
          }

          // 直接发送完整内容
          log?.info?.(`[DingTalk][Dispatcher] deliver final: text=${text.slice(0, 30)}..., len=${text.length}`);
          await queueStreamingUpdate(text);

          // 完成卡片
          await finishCard();
        }
      },
      onError: (error, info) => {
        log?.error?.(`[DingTalk][Dispatcher] ${info.kind} deliver failed: ${String(error)}`);
      },
    });

  // 扩展 replyOptions，添加 onPartialReply 作为备用
  const replyOptions: GetReplyOptions = {
    ...baseReplyOptions,
    disableBlockStreaming: true,
    onPartialReply: async (payload: ReplyPayload): Promise<void> => {
      try {
        const text = payload.text ?? '';
        if (!text.trim()) return;

        // onPartialReply 只更新已有卡片，绝不创建新卡片
        // 如果 deliver 从未被调用，直接忽略（避免重复创建卡片）
        if (!deliverCalled) {
          log?.debug?.(`[DingTalk][Dispatcher] onPartialReply: deliver not called, ignoring`);
          return;
        }

        // 等待卡片创建完成（如果还在创建中）
        if (!pendingAICard && !pendingPlainCard) {
          log?.debug?.(`[DingTalk][Dispatcher] onPartialReply: waiting for card creation...`);
          // 简单等待一下，让 deliver 的 initCard 完成
          await new Promise(r => setTimeout(r, 100));
        }

        // 如果卡片存在，更新内容
        if (pendingAICard || pendingPlainCard) {
          log?.info?.(`[DingTalk][Dispatcher] onPartialReply: updating card, text=${text.slice(0, 30)}...`);
          await queueStreamingUpdate(text);
        }
      } catch (err: any) {
        log?.error?.(`[DingTalk][Dispatcher] onPartialReply error: ${err?.message || err}`);
        // 捕获异常，防止 Gateway 异常
      }
    },
  };

  return {
    dispatcher,
    replyOptions,
    markDispatchIdle,
    markRunComplete,
  };
}
