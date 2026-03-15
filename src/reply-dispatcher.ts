import type { ReplyDispatcher, ReplyDispatcherOptions, ReplyItem } from '@openclaw/core';
import type { DingTalkConfig } from '../plugin';
import { createAICardForTarget, finishAICard, streamAICard, sendAICardInternal, type AICardTarget, type AICardConfig } from './ai-card';
import { sendProactive, type ProactiveTarget, type SendProactiveOptions } from './send-proactive';
import { processLocalImages } from './process-local-images';
import { processVideoMarkers } from './process-video-markers';
import { processAudioMarkers } from './process-audio-markers';
import { processFileMarkers } from './process-file-markers';
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
  replyOptions: ReplyDispatcherOptions;
  markDispatchIdle: () => void;
}

interface PendingAICard {
  cardId: string;
  cardConfig: AICardConfig;
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
    let processed = await processLocalImages(text, token, log);

    // 构建 AI Card 目标用于媒体处理
    const aiCardTarget = buildAICardTarget();

    // 处理视频标记
    processed = await processVideoMarkers(processed, '', dingtalkConfig, token, log, true, aiCardTarget);

    // 处理音频标记
    processed = await processAudioMarkers(processed, '', dingtalkConfig, token, log, true, aiCardTarget);

    // 处理文件标记
    processed = await processFileMarkers(processed, '', dingtalkConfig, token, log, true, aiCardTarget);

    return processed;
  };

  // 创建 dispatcher
  const dispatcher: ReplyDispatcher = {
    async deliver(item: ReplyItem, opts?: ReplyDispatcherOptions): Promise<void> {
      isIdle = false;

      try {
        const proactiveTarget = buildProactiveTarget();
        const aiCardTarget = buildAICardTarget();

        switch (item.type) {
          case 'text': {
            // 纯文本消息
            const text = item.text || '';
            const processedText = await processTextWithMedia(text);

            await sendProactive(dingtalkConfig, proactiveTarget, processedText, {
              msgType: 'text',
              useAICard: false,
              fallbackToNormal: true,
              log,
            });
            break;
          }

          case 'markdown': {
            // Markdown 消息
            const markdown = item.markdown || item.text || '';
            const processedMarkdown = await processTextWithMedia(markdown);

            await sendProactive(dingtalkConfig, proactiveTarget, processedMarkdown, {
              msgType: 'markdown',
              useAICard: false,
              fallbackToNormal: true,
              log,
            });
            break;
          }

          case 'thinking': {
            // 思考内容 - 可以选择忽略或作为调试信息
            log?.debug?.(`[DingTalk][Dispatcher] Thinking: ${item.text?.slice(0, 100)}...`);
            break;
          }

          case 'tool_use': {
            // 工具使用 - 记录日志
            log?.info?.(`[DingTalk][Dispatcher] Tool use: ${item.name}`);
            break;
          }

          case 'tool_result': {
            // 工具结果 - 记录日志
            log?.info?.(`[DingTalk][Dispatcher] Tool result: ${item.tool_use_id}`);
            break;
          }

          case 'ai_card_start': {
            // 开始 AI Card 流式输出
            const token = await ensureToken();
            if (!token) {
              log?.warn?.('[DingTalk][Dispatcher] 无法获取 token，跳过 AI Card');
              break;
            }

            // 创建 AI Card
            const cardConfig: AICardConfig = {
              title: item.title || 'AI 助手',
              content: '',
            };

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
              log?.info?.(`[DingTalk][Dispatcher] AI Card 创建成功: ${cardId}`);
            }
            break;
          }

          case 'ai_card_chunk': {
            // AI Card 流式内容块
            if (!pendingAICard) {
              log?.warn?.('[DingTalk][Dispatcher] 没有待处理的 AI Card，跳过 chunk');
              break;
            }

            const token = await ensureToken();
            if (!token) break;

            // 累积内容
            aiCardContent += item.text || '';

            // 流式更新 AI Card
            await streamAICard(
              dingtalkConfig,
              pendingAICard.cardId,
              aiCardContent,
              pendingAICard.target,
              token,
              log,
            );
            break;
          }

          case 'ai_card_end': {
            // 结束 AI Card 流式输出
            if (!pendingAICard) {
              log?.warn?.('[DingTalk][Dispatcher] 没有待处理的 AI Card，跳过 end');
              break;
            }

            const token = await ensureToken();
            if (!token) break;

            // 后处理最终内容
            const finalContent = await processTextWithMedia(aiCardContent);

            // 完成 AI Card
            await finishAICard(
              dingtalkConfig,
              pendingAICard.cardId,
              finalContent,
              pendingAICard.target,
              token,
              log,
            );

            log?.info?.(`[DingTalk][Dispatcher] AI Card 完成: ${pendingAICard.cardId}`);

            // 清理状态
            pendingAICard = null;
            aiCardContent = '';
            break;
          }

          case 'image': {
            // 图片消息
            if (item.url) {
              // 如果有 URL，直接发送
              await sendProactive(dingtalkConfig, proactiveTarget, item.url, {
                msgType: 'image',
                useAICard: false,
                fallbackToNormal: true,
                log,
              });
            } else if (item.path) {
              // 如果有本地路径，需要上传
              const token = await ensureToken();
              if (token) {
                // 使用 processLocalImages 处理并获取 media_id
                const processed = await processLocalImages(`![image](${item.path})`, token, log);
                // 提取 media_id 并发送
                const mediaMatch = processed.match(/media_id:(\w+)/);
                if (mediaMatch) {
                  await sendProactive(dingtalkConfig, proactiveTarget, mediaMatch[1], {
                    msgType: 'image',
                    useAICard: false,
                    fallbackToNormal: true,
                    log,
                  });
                }
              }
            }
            break;
          }

          case 'file': {
            // 文件消息
            if (item.path) {
              const token = await ensureToken();
              if (token) {
                // 使用 processFileMarkers 处理文件上传
                const fileMarker = `[file:${item.path}]`;
                await processFileMarkers(fileMarker, '', dingtalkConfig, token, log, true, aiCardTarget);
              }
            }
            break;
          }

          case 'audio': {
            // 音频消息
            if (item.path) {
              const token = await ensureToken();
              if (token) {
                const audioMarker = `[audio:${item.path}]`;
                await processAudioMarkers(audioMarker, '', dingtalkConfig, token, log, true, aiCardTarget);
              }
            }
            break;
          }

          case 'video': {
            // 视频消息
            if (item.path) {
              const token = await ensureToken();
              if (token) {
                const videoMarker = `[video:${item.path}]`;
                await processVideoMarkers(videoMarker, '', dingtalkConfig, token, log, true, aiCardTarget);
              }
            }
            break;
          }

          case 'error': {
            // 错误消息
            const errorText = `⚠️ 错误: ${item.text || '未知错误'}`;
            await sendProactive(dingtalkConfig, proactiveTarget, errorText, {
              msgType: 'text',
              useAICard: false,
              fallbackToNormal: true,
              log,
            });
            break;
          }

          default: {
            // 未知类型，尝试作为文本发送
            log?.warn?.(`[DingTalk][Dispatcher] 未知消息类型: ${(item as any).type}`);
            if (item.text) {
              const processedText = await processTextWithMedia(item.text);
              await sendProactive(dingtalkConfig, proactiveTarget, processedText, {
                msgType: 'text',
                useAICard: false,
                fallbackToNormal: true,
                log,
              });
            }
          }
        }
      } catch (err: any) {
        log?.error?.(`[DingTalk][Dispatcher] deliver 失败: ${err?.message || err}`);
        throw err;
      }
    },

    async flush(): Promise<void> {
      // 如果有未完成的 AI Card，完成它
      if (pendingAICard) {
        try {
          const token = await ensureToken();
          if (token) {
            const finalContent = await processTextWithMedia(aiCardContent);
            await finishAICard(
              dingtalkConfig,
              pendingAICard.cardId,
              finalContent,
              pendingAICard.target,
              token,
              log,
            );
            log?.info?.(`[DingTalk][Dispatcher] flush 完成 AI Card: ${pendingAICard.cardId}`);
          }
        } catch (err: any) {
          log?.error?.(`[DingTalk][Dispatcher] flush 失败: ${err?.message || err}`);
        } finally {
          pendingAICard = null;
          aiCardContent = '';
        }
      }
    },

    isIdle(): boolean {
      return isIdle && !pendingAICard;
    },
  };

  // 构建 replyOptions
  const replyOptions: ReplyDispatcherOptions = {
    // 钉钉支持 Markdown
    supportsMarkdown: true,
    // 支持 AI Card
    supportsAICard: true,
    // 支持流式输出
    supportsStreaming: true,
    // 最大消息长度
    maxMessageLength: 20000,
    // 其他选项...
  };

  return {
    dispatcher,
    replyOptions,
    markDispatchIdle,
  };
}
