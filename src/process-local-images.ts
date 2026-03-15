import axios from 'axios';
import FormData from 'form-data';
import fs from 'fs';
import path from 'path';

/**
 * 匹配 markdown 图片中的本地文件路径（跨平台）：
 * - ![alt](file:///path/to/image.jpg)
 * - ![alt](MEDIA:/var/folders/xxx.jpg)
 * - ![alt](attachment:///path.jpg)
 * macOS:
 * - ![alt](/tmp/xxx.jpg)
 * - ![alt](/var/folders/xxx.jpg)
 * - ![alt](/Users/xxx/photo.jpg)
 * Linux:
 * - ![alt](/home/user/photo.jpg)
 * - ![alt](/root/photo.jpg)
 * Windows:
 * - ![alt](C:\Users\xxx\photo.jpg)
 * - ![alt](C:/Users/xxx/photo.jpg)
 */
const LOCAL_IMAGE_RE = /!\[([^\]]*)\]\(((?:file:\/\/\/|MEDIA:|attachment:\/\/\/)[^)]+|\/(?:tmp|var|private|Users|home|root)[^)]+|[A-Za-z]:[\\/ ][^)]+)\)/g;

/**
 * 匹配纯文本中的本地图片路径（不在 markdown 图片语法中，跨平台）：
 * macOS:
 * - `/var/folders/.../screenshot.png`
 * - `/tmp/image.jpg`
 * - `/Users/xxx/photo.png`
 * Linux:
 * - `/home/user/photo.png`
 * - `/root/photo.png`
 * Windows:
 * - `C:\Users\xxx\photo.png`
 * - `C:/temp/image.jpg`
 * 支持 backtick 包裹: `path`
 */
const BARE_IMAGE_PATH_RE = /`?((?:\/(?:tmp|var|private|Users|home|root)\/[^\s`'",)]+|[A-Za-z]:[\\/][^\s`'",)]+)\.(?:png|jpg|jpeg|gif|bmp|webp))`?/gi;

/** 去掉 file:// / MEDIA: / attachment:// 前缀，得到实际的绝对路径 */
function toLocalPath(raw: string): string {
  let p = raw;
  if (p.startsWith('file://')) p = p.replace('file://', '');
  else if (p.startsWith('MEDIA:')) p = p.replace('MEDIA:', '');
  else if (p.startsWith('attachment://')) p = p.replace('attachment://', '');

  // 解码 URL 编码的路径（如中文字符 %E5%9B%BE → 图）
  try {
    p = decodeURIComponent(p);
  } catch {
    // 解码失败则保持原样
  }
  return p;
}

/**
 * 上传媒体文件到钉钉
 */
async function uploadMediaToDingTalk(
  filePath: string,
  token: string,
  log?: any,
): Promise<string | null> {
  try {
    const absPath = toLocalPath(filePath);

    if (!fs.existsSync(absPath)) {
      log?.warn?.(`[DingTalk][processLocalImages] 文件不存在: ${absPath}`);
      return null;
    }

    const stats = fs.statSync(absPath);
    const maxSize = 20 * 1024 * 1024; // 20MB

    if (stats.size > maxSize) {
      const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
      log?.warn?.(`[DingTalk][processLocalImages] 文件过大: ${absPath}, 大小: ${fileSizeMB}MB, 超过限制 20MB`);
      return null;
    }

    const form = new FormData();
    form.append('media', fs.createReadStream(absPath), {
      filename: path.basename(absPath),
      contentType: 'image/jpeg',
    });

    const resp = await axios.post(
      `https://oapi.dingtalk.com/media/upload?access_token=${token}&type=image`,
      form,
      { headers: form.getHeaders(), timeout: 60_000 },
    );

    const mediaId = resp.data?.media_id;
    if (mediaId) {
      log?.info?.(`[DingTalk][processLocalImages] 上传成功: media_id=${mediaId}`);
      return mediaId;
    }
    log?.warn?.(`[DingTalk][processLocalImages] 上传返回无 media_id: ${JSON.stringify(resp.data)}`);
    return null;
  } catch (err: any) {
    log?.error?.(`[DingTalk][processLocalImages] 上传失败: ${err.message}`);
    return null;
  }
}

/**
 * 处理本地图片标记 ![alt](path) 并上传
 * 同时支持检测纯文本中的本地图片路径
 */
export async function processLocalImages(
  text: string,
  token: string,
  log?: any,
): Promise<string> {
  let result = text;

  // 第一步：匹配 markdown 图片语法 ![alt](path)
  const mdMatches = [...text.matchAll(LOCAL_IMAGE_RE)];
  if (mdMatches.length > 0) {
    log?.info?.(`[DingTalk][processLocalImages] 检测到 ${mdMatches.length} 个 markdown 图片，开始上传...`);
    for (const match of mdMatches) {
      const [fullMatch, alt, rawPath] = match;
      // 清理转义字符（AI 可能会对含空格的路径添加 \ ）
      const cleanPath = rawPath.replace(/\\ /g, ' ');
      const mediaId = await uploadMediaToDingTalk(cleanPath, token, log);
      if (mediaId) {
        result = result.replace(fullMatch, `media_id:${mediaId}`);
      }
    }
  }

  // 第二步：匹配纯文本中的本地图片路径（如 `/var/folders/.../xxx.png`）
  // 排除已被 markdown 图片语法包裹的路径
  const bareMatches = [...result.matchAll(BARE_IMAGE_PATH_RE)];
  const newBareMatches = bareMatches.filter(m => {
    // 检查这个路径是否已经在 ![...](...) 中
    const idx = m.index!;
    const before = result.slice(Math.max(0, idx - 10), idx);
    return !before.includes('](');
  });

  if (newBareMatches.length > 0) {
    log?.info?.(`[DingTalk][processLocalImages] 检测到 ${newBareMatches.length} 个纯文本图片路径，开始上传...`);
    // 从后往前替换，避免 index 偏移
    for (const match of newBareMatches.reverse()) {
      const [fullMatch, rawPath] = match;
      log?.info?.(`[DingTalk][processLocalImages] 纯文本图片: "${fullMatch}" -> path="${rawPath}"`);
      const mediaId = await uploadMediaToDingTalk(rawPath, token, log);
      if (mediaId) {
        const replacement = `media_id:${mediaId}`;
        result = result.slice(0, match.index!) + result.slice(match.index!).replace(fullMatch, replacement);
        log?.info?.(`[DingTalk][processLocalImages] 替换纯文本路径为图片: ${replacement}`);
      }
    }
  }

  if (mdMatches.length === 0 && newBareMatches.length === 0) {
    log?.info?.(`[DingTalk][processLocalImages] 未检测到本地图片路径`);
  }

  return result;
}
