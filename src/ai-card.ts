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
  console.log(`[DingTalk][createAICardForTarget] Starting, target=${JSON.stringify(target)}, templateId=${cfg.aiCardTemplateId || 'StandardCard'}`);
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
      console.log(`[DingTalk][createAICardForTarget] AI Card created successfully: ${cardId}`);
      log?.info?.(`[DingTalk][createAICardForTarget] AI Card 创建成功: ${cardId}`);
      return cardId;
    }

    console.error(`[DingTalk][createAICardForTarget] Failed to create AI Card: ${JSON.stringify(resp.data)}`);
    log?.error?.(`[DingTalk][createAICardForTarget] 创建失败: ${JSON.stringify(resp.data)}`);
    return null;
  } catch (err: any) {
    console.error(`[DingTalk][createAICardForTarget] Error: ${err?.message || err}`);
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
  console.log(`[DingTalk][streamAICard] Updating AI Card: ${cardId}, content length: ${content?.length || 0}`);
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

    console.log(`[DingTalk][streamAICard] AI Card updated successfully: ${cardId}`);
    log?.debug?.(`[DingTalk][streamAICard] AI Card 更新成功: ${cardId}`);
  } catch (err: any) {
    console.error(`[DingTalk][streamAICard] Failed to update AI Card: ${err?.message || err}`);
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
  console.log(`[DingTalk][finishAICard] Finishing AI Card: ${cardId}, content length: ${content?.length || 0}`);
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

    console.log(`[DingTalk][finishAICard] AI Card finished successfully: ${cardId}`);
    log?.info?.(`[DingTalk][finishAICard] AI Card 完成: ${cardId}`);
  } catch (err: any) {
    console.error(`[DingTalk][finishAICard] Failed to finish AI Card: ${err?.message || err}`);
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

// ============ 普通卡片支持 ============

export interface PlainCardConfig {
  title: string;
  content: string;
}

export interface PlainCardInstance {
  cardInstanceId: string;
  accessToken: string;
}

/**
 * 创建普通卡片（非 AI Card）
 * 使用标准 Markdown 卡片模板
 */
export async function createPlainCard(
  cfg: DingTalkConfig,
  target: AICardTarget,
  cardConfig: PlainCardConfig,
  token: string,
  log?: any,
): Promise<string | null> {
  try {
    // 普通卡片使用不同的模板 ID，例如标准 Markdown 卡片
    const templateId = cfg.plainCardTemplateId || 'StandardMarkdownCard';

    const resp = await axios.post(
      'https://api.dingtalk.com/v1.0/im/interactiveCards/instances',
      {
        cardTemplateId: templateId,
        openConversationId: target.openConversationId,
        singleChatReceiver: target.userId ? { userId: target.userId } : undefined,
        cardData: JSON.stringify({
          title: cardConfig.title,
          content: cardConfig.content,
        }),
        // 普通卡片不需要流式状态更新
        cardBizType: 0,
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
      log?.info?.(`[DingTalk][createPlainCard] 普通卡片创建成功: ${cardId}`);
      return cardId;
    }

    log?.error?.(`[DingTalk][createPlainCard] 创建失败: ${JSON.stringify(resp.data)}`);
    return null;
  } catch (err: any) {
    log?.error?.(`[DingTalk][createPlainCard] 错误: ${err?.message || err}`);
    return null;
  }
}

/**
 * 更新普通卡片内容
 */
export async function updatePlainCard(
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

    log?.debug?.(`[DingTalk][updatePlainCard] 普通卡片更新成功: ${cardId}`);
  } catch (err: any) {
    log?.error?.(`[DingTalk][updatePlainCard] 更新失败: ${err?.message || err}`);
  }
}

/**
 * 完成普通卡片
 */
export async function finishPlainCard(
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

    log?.info?.(`[DingTalk][finishPlainCard] 普通卡片完成: ${cardId}`);
  } catch (err: any) {
    log?.error?.(`[DingTalk][finishPlainCard] 完成失败: ${err?.message || err}`);
  }
}
