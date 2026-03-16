import axios from 'axios';
import FormData from 'form-data';
import fs from 'fs';
import path from 'path';
import { getOapiAccessToken } from './oapi-token';
import type { AICardTarget } from './ai-card';

/**
 * 处理文件标记 [file:path]
 */
export async function processFileMarkers(
  text: string,
  cardId: string,
  cfg: any,
  token: string,
  log?: any,
  sendImmediately = true,
  aiCardTarget?: AICardTarget,
): Promise<string> {
  const fileRegex = /\[file:([^\]]+)\]/g;
  let result = text;
  let match: RegExpExecArray | null;

  while ((match = fileRegex.exec(text)) !== null) {
    const [fullMatch, filePath] = match;

    try {
      // 解析路径
      const resolvedPath = path.resolve(filePath);

      if (!fs.existsSync(resolvedPath)) {
        log?.warn?.(`[DingTalk][processFileMarkers] 文件不存在: ${resolvedPath}`);
        continue;
      }

      // 获取文件信息
      const stats = fs.statSync(resolvedPath);
      const fileName = path.basename(resolvedPath);

      // 上传文件
      const form = new FormData();
      form.append('media', fs.createReadStream(resolvedPath));

      const resp = await axios.post(
        'https://oapi.dingtalk.com/media/upload',
        form,
        {
          params: {
            access_token: token,
            type: 'file',
          },
          headers: form.getHeaders(),
        },
      );

      if (resp.data?.errcode === 0 && resp.data?.media_id) {
        const mediaId = resp.data.media_id;

        if (sendImmediately && aiCardTarget) {
          // 立即发送文件消息
          await sendFileMessage(cfg, aiCardTarget, mediaId, fileName, log);
        }

        // 从文本中移除标记
        result = result.replace(fullMatch, '');
        log?.info?.(`[DingTalk][processFileMarkers] 文件上传成功: ${mediaId}`);
      } else {
        log?.error?.(`[DingTalk][processFileMarkers] 文件上传失败: ${resp.data?.errmsg}`);
      }
    } catch (err: any) {
      log?.error?.(`[DingTalk][processFileMarkers] 处理文件失败: ${err?.message || err}`);
    }
  }

  return result;
}

/**
 * 发送文件消息
 */
async function sendFileMessage(
  cfg: any,
  target: AICardTarget,
  mediaId: string,
  fileName: string,
  log?: any,
): Promise<void> {
  try {
    const token = await getOapiAccessToken(cfg);
    if (!token) {
      throw new Error('无法获取 access_token');
    }

    const msg = {
      msgtype: 'file',
      file: { media_id: mediaId },
    };

    const body: any = { msg };

    if (target.openConversationId) {
      body.openConversationId = target.openConversationId;
    } else if (target.userId) {
      body.userid = target.userId;
    }

    await axios.post(
      'https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend',
      body,
      {
        headers: {
          'x-acs-dingtalk-access-token': token,
          'Content-Type': 'application/json',
        },
      },
    );

    log?.info?.(`[DingTalk][sendFileMessage] 文件发送成功: ${fileName}`);
  } catch (err: any) {
    log?.error?.(`[DingTalk][sendFileMessage] 发送失败: ${err?.message || err}`);
  }
}
