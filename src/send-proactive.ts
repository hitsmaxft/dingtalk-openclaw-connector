import axios from 'axios';
import { getOapiAccessToken } from './oapi-token';
import { sendAICardInternal, type AICardTarget } from './ai-card';

export interface ProactiveTarget {
  userId?: string;
  openConversationId?: string;
}

export interface SendProactiveOptions {
  msgType?: 'text' | 'markdown' | 'image' | 'file';
  useAICard?: boolean;
  fallbackToNormal?: boolean;
  log?: any;
}

/**
 * 发送主动消息
 */
export async function sendProactive(
  cfg: any,
  target: ProactiveTarget,
  content: string,
  opts: SendProactiveOptions = {},
): Promise<void> {
  const { msgType = 'text', useAICard = false, fallbackToNormal = true, log } = opts;

  // 获取 access token
  const token = await getOapiAccessToken(cfg);
  if (!token) {
    throw new Error('无法获取 access_token');
  }

  // 如果需要使用 AI Card
  if (useAICard) {
    try {
      const aiCardTarget: AICardTarget = target.openConversationId
        ? { type: 'group', openConversationId: target.openConversationId }
        : { type: 'user', userId: target.userId! };

      await sendAICardInternal(cfg, aiCardTarget, content, token, log);
      log?.info?.(`[DingTalk][sendProactive] AI Card 发送成功`);
      return;
    } catch (err: any) {
      log?.error?.(`[DingTalk][sendProactive] AI Card 发送失败: ${err?.message || err}`);
      if (!fallbackToNormal) {
        throw err;
      }
      log?.info?.(`[DingTalk][sendProactive] 降级到普通消息`);
    }
  }

  // 构建消息体
  let msg: any = {};

  switch (msgType) {
    case 'text':
      msg = { msgtype: 'text', text: { content } };
      break;
    case 'markdown':
      msg = { msgtype: 'markdown', markdown: { title: '消息', text: content } };
      break;
    case 'image':
      msg = { msgtype: 'image', image: { media_id: content } };
      break;
    case 'file':
      msg = { msgtype: 'file', file: { media_id: content } };
      break;
    default:
      msg = { msgtype: 'text', text: { content } };
  }

  // 构建请求体
  const body: any = {
    msg,
  };

  if (target.openConversationId) {
    body.openConversationId = target.openConversationId;
  } else if (target.userId) {
    body.userid = target.userId;
  } else {
    throw new Error('必须提供 userId 或 openConversationId');
  }

  try {
    const resp = await axios.post(
      'https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend',
      body,
      {
        headers: {
          'x-acs-dingtalk-access-token': token,
          'Content-Type': 'application/json',
        },
      },
    );

    if (resp.data?.errcode !== 0 && resp.data?.errcode !== undefined) {
      throw new Error(`发送失败: ${resp.data?.errmsg || '未知错误'}`);
    }

    log?.info?.(`[DingTalk][sendProactive] 消息发送成功`);
  } catch (err: any) {
    log?.error?.(`[DingTalk][sendProactive] 发送失败: ${err?.message || err}`);
    throw err;
  }
}
