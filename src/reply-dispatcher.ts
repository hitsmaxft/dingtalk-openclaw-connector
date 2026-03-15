import type { ReplyDispatcher, GetReplyOptions, ReplyPayload } from 'openclaw/plugin-sdk';
import type { DingTalkConfig } from '../plugin';
import {
  createAICardForTarget, finishAICard, streamAICard,
  createPlainCard, finishPlainCard,
  type AICardTarget, type AICardConfig, type PlainCardConfig
} from './ai-card';
import { sendProactive, type ProactiveTarget } from './send-proactive';
import { processLocalImages } from './process-local-images';
import { getOapiAccessToken } from './oapi-token';

export interface DingtalkReplyDispatcherOptions {
  cfg: any;
  agentId: string;
  runtime: any;
  dingtalkConfig: DingTalkConfig;
  data: any;
  isDirect: boolean;
  log?: any;
}

export interface DingtalkReplyDispatcherResult {
  dispatcher: ReplyDispatcher;
  replyOptions: Omit<GetReplyOptions, 'onToolResult' | 'onBlockReply'>;
  markDispatchIdle: () => void;
}

interface PendingAICard {
  cardId: string;
  cardConfig: AICardConfig;
  target: AICardTarget;
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

  // 获取 access token
  let oapiToken: string | null = null;

  // 待处理的 AI Card（用于流式输出）
  let pendingAICard: PendingAICard | null = null;
  let aiCardContent = '';

  // 待处理的普通卡片（用于流式输出）
  let pendingPlainCard: PendingPlainCard | null = null;
  let plainCardContent = '';

  // 是否使用普通卡片
  const usePlainCard = dingtalkConfig.usePlainCard === true;

  // 标记 dispatcher 是否空闲
  let isIdle = true;
  const markDispatchIdle = () => {
    isIdle = true;
  };

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

    // 处理本地图片
    const processed = await processLocalImages(text, token, log);

    return processed;
  };

  // 初始化卡片（AI Card 或普通卡片）
  const initCard = async (): Promise<boolean> => {
    console.log(`[DingTalk][Dispatcher] initCard called, usePlainCard=${usePlainCard}`);
    const token = await ensureToken();
    if (!token) {
      console.error('[DingTalk][Dispatcher] Cannot get token, skipping card creation');
      log?.warn?.('[DingTalk][Dispatcher] 无法获取 token，跳过卡片创建');
      return false;
    }

    const aiCardTarget = buildAICardTarget();
    console.log(`[DingTalk][Dispatcher] Building AI Card target: ${JSON.stringify(aiCardTarget)}`);

    if (usePlainCard) {
      // 创建普通卡片
      const cardConfig: PlainCardConfig = {
        title: 'AI 助手',
        content: '',
      };

      console.log(`[DingTalk][Dispatcher] Creating plain card...`);
      const cardId = await createPlainCard(
        dingtalkConfig,
        aiCardTarget,
        cardConfig,
        token,
        log,
      );

      if (cardId) {
        pendingPlainCard = {
          cardId,
          cardConfig,
          target: aiCardTarget,
        };
        plainCardContent = '';
        console.log(`[DingTalk][Dispatcher] Plain card created: ${cardId}`);
        log?.info?.(`[DingTalk][Dispatcher] 普通卡片创建成功: ${cardId}`);
        return true;
      }
    } else {
      // 创建 AI Card
      const cardConfig: AICardConfig = {
        title: 'AI 助手',
        content: '',
      };

      console.log(`[DingTalk][Dispatcher] Creating AI Card...`);
      const cardId = await createAICardForTarget(
        dingtalkConfig,
        aiCardTarget,
        cardConfig,
        token,
        log,
      );

      if (cardId) {
        pendingAICard = {
          cardId,
          cardConfig,
          target: aiCardTarget,
        };
        aiCardContent = '';
        console.log(`[DingTalk][Dispatcher] AI Card created: ${cardId}`);
        log?.info?.(`[DingTalk][Dispatcher] AI Card 创建成功: ${cardId}`);
        return true;
      }
    }

    console.error('[DingTalk][Dispatcher] Failed to create card');
    return false;
  };

  // 更新卡片内容（流式）
  const updateCard = async (text: string): Promise<void> => {
    console.log(`[DingTalk][Dispatcher] updateCard called, text length: ${text?.length || 0}, usePlainCard: ${usePlainCard}, pendingAICard: ${!!pendingAICard}, pendingPlainCard: ${!!pendingPlainCard}`);
    if (usePlainCard && pendingPlainCard) {
      // 普通卡片：只累积内容，不流式更新
      plainCardContent += text;
      console.log(`[DingTalk][Dispatcher] Plain card content updated, length: ${plainCardContent.length}`);
    } else if (pendingAICard) {
      // AI Card：累积内容并流式更新
      const token = await ensureToken();
      if (!token) {
        console.error('[DingTalk][Dispatcher] Cannot get token for updateCard');
        return;
      }

      aiCardContent += text;
      console.log(`[DingTalk][Dispatcher] Streaming AI Card update, cardId: ${pendingAICard.cardId}, content length: ${aiCardContent.length}`);

      await streamAICard(
        dingtalkConfig,
        pendingAICard.cardId,
        aiCardContent,
        pendingAICard.target,
        token,
        log,
      );
      console.log(`[DingTalk][Dispatcher] AI Card stream update completed`);
    } else {
      console.warn(`[DingTalk][Dispatcher] No pending card to update. usePlainCard=${usePlainCard}, pendingAICard=${!!pendingAICard}, pendingPlainCard=${!!pendingPlainCard}`);
    }
  };

  // 完成卡片
  const finishCard = async (): Promise<void> => {
    console.log(`[DingTalk][Dispatcher] finishCard called, usePlainCard=${usePlainCard}, pendingAICard=${!!pendingAICard}, pendingPlainCard=${!!pendingPlainCard}`);
    const token = await ensureToken();
    if (!token) {
      console.error('[DingTalk][Dispatcher] Cannot get token for finishCard');
      return;
    }

    if (usePlainCard && pendingPlainCard) {
      // 后处理最终内容
      const finalContent = await processTextWithMedia(plainCardContent);
      console.log(`[DingTalk][Dispatcher] Finishing plain card: ${pendingPlainCard.cardId}`);

      // 完成普通卡片
      await finishPlainCard(
        dingtalkConfig,
        pendingPlainCard.cardId,
        finalContent,
        pendingPlainCard.target,
        token,
        log,
      );

      console.log(`[DingTalk][Dispatcher] Plain card finished: ${pendingPlainCard.cardId}`);
      log?.info?.(`[DingTalk][Dispatcher] 普通卡片完成: ${pendingPlainCard.cardId}`);

      // 清理状态
      pendingPlainCard = null;
      plainCardContent = '';
    } else if (pendingAICard) {
      // 后处理最终内容
      const finalContent = await processTextWithMedia(aiCardContent);
      console.log(`[DingTalk][Dispatcher] Finishing AI Card: ${pendingAICard.cardId}`);

      // 完成 AI Card
      await finishAICard(
        dingtalkConfig,
        pendingAICard.cardId,
        finalContent,
        pendingAICard.target,
        token,
        log,
      );

      console.log(`[DingTalk][Dispatcher] AI Card finished: ${pendingAICard.cardId}`);
      log?.info?.(`[DingTalk][Dispatcher] AI Card 完成: ${pendingAICard.cardId}`);

      // 清理状态
      pendingAICard = null;
      aiCardContent = '';
    } else {
      console.warn('[DingTalk][Dispatcher] No pending card to finish');
    }
  };

  // 发送普通文本消息（降级方案）
  const sendTextReply = async (text: string): Promise<void> => {
    const proactiveTarget = buildProactiveTarget();
    const processedText = await processTextWithMedia(text);

    await sendProactive(dingtalkConfig, proactiveTarget, processedText, {
      msgType: 'text',
      useAICard: false,
      fallbackToNormal: true,
      log,
    });
  };

  // 创建 dispatcher 对象
  const dispatcher: ReplyDispatcher = {
    sendToolResult: (payload: ReplyPayload): boolean => {
      const text = payload.text?.slice(0, 50);
      console.log(`[DingTalk][Dispatcher] Tool result: ${text}`);
      log?.debug?.(`[DingTalk][Dispatcher] Tool result: ${text}`);
      // 工具结果不发送到用户，只记录日志
      return true;
    },

    sendBlockReply: (payload: ReplyPayload): boolean => {
      isIdle = false;
      console.log(`[DingTalk][Dispatcher] sendBlockReply called: ${payload.text?.slice(0, 50)}...`);

      // 异步处理流式块
      (async () => {
        try {
          // 如果没有待处理的卡片，初始化一个
          if (!pendingAICard && !pendingPlainCard) {
            console.log(`[DingTalk][Dispatcher] No pending card, initializing...`);
            const created = await initCard();
            if (!created) {
              // 卡片创建失败，降级为普通消息
              console.log(`[DingTalk][Dispatcher] Card init failed, falling back to text`);
              await sendTextReply(payload.text || '');
              return;
            }
          }

          // 更新卡片内容
          if (payload.text) {
            await updateCard(payload.text);
          }
        } catch (err: any) {
          console.error(`[DingTalk][Dispatcher] sendBlockReply failed: ${err?.message || err}`);
          log?.error?.(`[DingTalk][Dispatcher] sendBlockReply 失败: ${err?.message || err}`);
        }
      })();

      return true;
    },

    sendFinalReply: (payload: ReplyPayload): boolean => {
      isIdle = false;
      console.log(`[DingTalk][Dispatcher] sendFinalReply called: ${payload.text?.slice(0, 50)}...`);

      // 异步处理最终回复
      (async () => {
        try {
          // 如果没有待处理的卡片，初始化一个
          if (!pendingAICard && !pendingPlainCard) {
            console.log(`[DingTalk][Dispatcher] No pending card, initializing...`);
            const created = await initCard();
            if (!created) {
              // 卡片创建失败，降级为普通消息
              console.log(`[DingTalk][Dispatcher] Card init failed, falling back to text`);
              await sendTextReply(payload.text || '');
              isIdle = true;
              return;
            }
          }

          // 如果有文本内容，更新卡片
          if (payload.text) {
            await updateCard(payload.text);
          }

          // 完成卡片
          await finishCard();
        } catch (err: any) {
          console.error(`[DingTalk][Dispatcher] sendFinalReply failed: ${err?.message || err}`);
          log?.error?.(`[DingTalk][Dispatcher] sendFinalReply 失败: ${err?.message || err}`);
        } finally {
          isIdle = true;
        }
      })();

      return true;
    },

    waitForIdle: async (): Promise<void> => {
      // 等待所有异步操作完成
      let attempts = 0;
      while ((!isIdle || pendingAICard || pendingPlainCard) && attempts < 50) {
        await new Promise(resolve => setTimeout(resolve, 100));
        attempts++;
      }
    },

    getQueuedCounts: (): Record<'tool' | 'block' | 'final', number> => {
      return { tool: 0, block: 0, final: 0 };
    },

    markComplete: (): void => {
      log?.debug?.('[DingTalk][Dispatcher] markComplete called');
      // 确保所有卡片都被完成
      if (pendingAICard || pendingPlainCard) {
        finishCard().catch((err: any) => {
          log?.error?.(`[DingTalk][Dispatcher] markComplete 完成卡片失败: ${err?.message || err}`);
        });
      }
    },
  };

  // 构建 replyOptions - 使用 GetReplyOptions 类型
  const replyOptions: Omit<GetReplyOptions, 'onToolResult' | 'onBlockReply'> = {
    // 钉钉支持 Markdown
    supportsMarkdown: true,
    // 支持 AI Card
    supportsAICard: true,
    // 支持流式输出
    supportsStreaming: true,
    // 最大消息长度
    maxMessageLength: 20000,
  };

  return {
    dispatcher,
    replyOptions,
    markDispatchIdle,
  };
}
