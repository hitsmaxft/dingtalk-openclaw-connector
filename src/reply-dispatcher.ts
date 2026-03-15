/**
 * DingTalk Reply Dispatcher
 *
 * 使用 OpenClaw 标准的消息分发机制处理钉钉消息
 */

import type { ClawdbotConfig, RuntimeEnv } from 'clawdbot/plugin-sdk';
import type { DingtalkConfig } from './config.js';
import { sendAICardInternal, sendMarkdownMessage, sendTextMessage } from './ai-card.js';
import { sendMessage } from './send.js';
import { processLocalImages, processVideoMarkers, processAudioMarkers, processFileMarkers } from './media.js';
import { getOapiAccessToken } from './token.js';

/** 创建钉钉 Reply Dispatcher */
export function createDingtalkReplyDispatcher(params: {
  cfg: ClawdbotConfig;
  agentId: string;
  runtime: RuntimeEnv;
  dingtalkConfig: DingtalkConfig;
  data: any;  // DingTalk message data
  isDirect: boolean;
  log?: any;
}) {
  const core = params.runtime;
  const { cfg, agentId, dingtalkConfig, data, isDirect, log } = params;

  const textChunkLimit = core.channel.text.resolveTextChunkLimit(cfg, 'dingtalk-connector', undefined, {
    fallbackLimit: 20000,  // 钉钉消息长度限制
  });
  const chunkMode = core.channel.text.resolveChunkMode(cfg, 'dingtalk-connector');
  const tableMode = core.channel.text.resolveMarkdownTableMode({ cfg, channel: 'dingtalk-connector' });

  // AI Card 配置
  const useAICard = dingtalkConfig.useAICard !== false;
  const oapiToken = getOapiAccessToken(dingtalkConfig);

  const { dispatcher, replyOptions, markDispatchIdle } =
    core.channel.reply.createReplyDispatcherWithTyping({
      humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, agentId),
      onReplyStart: () => {
        log?.info?.(`[DingTalk] Reply start for agent=${agentId}`);
      },
      deliver: async (payload, info) => {
        const text = payload.text ?? '';
        const mediaList =
          payload.mediaUrls && payload.mediaUrls.length > 0
            ? payload.mediaUrls
            : payload.mediaUrl
              ? [payload.mediaUrl]
              : [];

        const hasText = Boolean(text.trim());
        const hasMedia = mediaList.length > 0;

        if (!hasText && !hasMedia) {
          return;
        }

        // 处理文本消息
        if (hasText) {
          let processedText = text;

          // 上传本地图片到钉钉
          processedText = await processLocalImages(processedText, await oapiToken, log);

          // 提取并发送视频
          const proactiveMediaTarget = isDirect
            ? { type: 'user' as const, userId: data.senderStaffId || data.senderId }
            : { type: 'group' as const, openConversationId: data.conversationId };
          processedText = await processVideoMarkers(
            processedText,
            '',
            dingtalkConfig,
            await oapiToken,
            log,
            true,
            proactiveMediaTarget
          );

          // 提取并发送音频
          processedText = await processAudioMarkers(
            processedText,
            '',
            dingtalkConfig,
            await oapiToken,
            log,
            true,
            proactiveMediaTarget
          );

          // 提取并发送文件
          processedText = await processFileMarkers(
            processedText,
            '',
            dingtalkConfig,
            await oapiToken,
            log,
            true,
            proactiveMediaTarget
          );

          // 分块发送文本
          const converted = core.channel.text.convertMarkdownTables(processedText, tableMode);
          for (const chunk of core.channel.text.chunkTextWithMode(
            converted,
            textChunkLimit,
            chunkMode,
          )) {
            // 优先使用 AI Card
            if (useAICard) {
              const cardResult = await sendAICardInternal({
                dingtalkConfig,
                data,
                text: chunk,
                log,
              });

              if (!cardResult) {
                // AI Card 失败，降级为普通消息
                await sendMarkdownMessage(dingtalkConfig, data, chunk, { log });
              }
            } else {
              // 使用普通 Markdown 消息
              await sendMarkdownMessage(dingtalkConfig, data, chunk, { log });
            }
          }
        }

        // 处理媒体文件
        if (hasMedia) {
          for (const mediaUrl of mediaList) {
            log?.info?.(`[DingTalk] Sending media: ${mediaUrl}`);
            // TODO: 实现媒体文件发送
          }
        }
      },
      onError: async (error, info) => {
        log?.error?.(`[DingTalk] ${info.kind} reply failed: ${String(error)}`);
      },
      onIdle: async () => {
        log?.info?.(`[DingTalk] Dispatch idle`);
      },
    });

  return {
    dispatcher,
    replyOptions,
    markDispatchIdle,
  };
}