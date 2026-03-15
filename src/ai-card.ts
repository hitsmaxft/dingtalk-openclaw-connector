import axios from 'axios';
import type { DingTalkConfig } from '../plugin';

export interface AICardConfig {
  title: string;
  content: string;
}

export interface AICardTarget {
  type: 'user' | 'group';
  userId?: string;
  openConversationId?: string;
}

/**
 * 为指定目标创建 AI Card
 */
export async function createAICardForTarget(
  cfg: DingTalkConfig,
  target: AICardTarget,
  cardConfig: AICardConfig,
  token: string,
  log?: any,
): Promise<string | null> {
  try {
    const resp = await axios.post(
      'https://api.dingtalk.com/v1.0/im/interactiveCards/instances',
      {
        cardTemplateId: cfg.aiCardTemplateId || 'StandardCard',
        openConversationId: target.openConversationId,
        singleChatReceiver: target.userId ? { userId: target.userId } : undefined,
        cardData: JSON.stringify({
          title: cardConfig.title,
          content: cardConfig.content,
        }),
      },
      {
        headers: {
          'x-acs-dingtalk-access-token': token,
          'Content-Type': 'application/json',
        },
      },
    );

    if (resp.data?.success && resp.data?.result?.cardInstanceId) {
      const cardId = resp.data.result.cardInstanceId;
      log?.info?.(`[DingTalk][createAICardForTarget] AI Card 创建成功: ${cardId}`);
      return cardId;
    }

    log?.error?.(`[DingTalk][createAICardForTarget] 创建失败: ${JSON.stringify(resp.data)}`);
    return null;
  } catch (err: any) {
    log?.error?.(`[DingTalk][createAICardForTarget] 错误: ${err?.message || err}`);
    return null;
  }
}

/**
 * 流式更新 AI Card
 */
export async function streamAICard(
  cfg: DingTalkConfig,
  cardId: string,
  content: string,
  target: AICardTarget,
  token: string,
  log?: any,
): Promise<void> {
  try {
    await axios.put(
      `https://api.dingtalk.com/v1.0/im/interactiveCards/instances/${cardId}`,
      {
        cardData: JSON.stringify({
          content,
        }),
      },
      {
        headers: {
          'x-acs-dingtalk-access-token': token,
          'Content-Type': 'application/json',
        },
      },
    );

    log?.debug?.(`[DingTalk][streamAICard] AI Card 更新成功: ${cardId}`);
  } catch (err: any) {
    log?.error?.(`[DingTalk][streamAICard] 更新失败: ${err?.message || err}`);
  }
}

/**
 * 完成 AI Card
 */
export async function finishAICard(
  cfg: DingTalkConfig,
  cardId: string,
  content: string,
  target: AICardTarget,
  token: string,
  log?: any,
): Promise<void> {
  try {
    await axios.put(
      `https://api.dingtalk.com/v1.0/im/interactiveCards/instances/${cardId}`,
      {
        cardData: JSON.stringify({
          content,
          finished: true,
        }),
      },
      {
        headers: {
          'x-acs-dingtalk-access-token': token,
          'Content-Type': 'application/json',
        },
      },
    );

    log?.info?.(`[DingTalk][finishAICard] AI Card 完成: ${cardId}`);
  } catch (err: any) {
    log?.error?.(`[DingTalk][finishAICard] 完成失败: ${err?.message || err}`);
  }
}

/**
 * 内部发送 AI Card
 */
export async function sendAICardInternal(
  cfg: DingTalkConfig,
  target: AICardTarget,
  content: string,
  token: string,
  log?: any,
): Promise<void> {
  try {
    const cardId = await createAICardForTarget(
      cfg,
      target,
      { title: 'AI 助手', content },
      token,
      log,
    );

    if (cardId) {
      await finishAICard(cfg, cardId, content, target, token, log);
    }
  } catch (err: any) {
    log?.error?.(`[DingTalk][sendAICardInternal] 发送失败: ${err?.message || err}`);
  }
}
