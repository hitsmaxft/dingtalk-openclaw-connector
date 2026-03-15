import axios from 'axios';
import type { DingTalkConfig } from '../plugin';

// ============ Constants ============

const DINGTALK_API = 'https://api.dingtalk.com';
const AI_CARD_TEMPLATE_ID = '02fcf2f4-5e02-4a85-b672-46d1f715543e.schema';

// flowStatus values consistent with Python SDK AICardStatus
const AICardStatus = {
  PROCESSING: '1',
  INPUTING: '2',
  FINISHED: '3',
  EXECUTING: '4',
  FAILED: '5',
} as const;

// ============ Types ============

export interface AICardTarget {
  type: 'user' | 'group';
  userId?: string;
  openConversationId?: string;
}

export interface AICardInstance {
  cardInstanceId: string;
  accessToken: string;
  inputingStarted: boolean;
}

// ============ Helper Functions ============

/**
 * Get access token from DingTalk
 */
async function getAccessToken(config: DingTalkConfig): Promise<string> {
  const resp = await axios.post(
    `${DINGTALK_API}/v1.0/oauth2/accessToken`,
    {
      appKey: config.clientId,
      appSecret: config.clientSecret,
    },
    {
      headers: { 'Content-Type': 'application/json' },
    },
  );

  if (!resp.data?.accessToken) {
    throw new Error(`Failed to get access token: ${JSON.stringify(resp.data)}`);
  }

  return resp.data.accessToken;
}

/**
 * Build deliver body for card delivery
 */
function buildDeliverBody(
  cardInstanceId: string,
  target: AICardTarget,
  robotCode: string,
): any {
  const base = { outTrackId: cardInstanceId, userIdType: 1 };

  if (target.type === 'group') {
    return {
      ...base,
      openSpaceId: `dtv1.card//IM_GROUP.${target.openConversationId}`,
      imGroupOpenDeliverModel: { robotCode },
    };
  }

  return {
    ...base,
    openSpaceId: `dtv1.card//IM_ROBOT.${target.userId}`,
    imRobotOpenDeliverModel: { spaceType: 'IM_ROBOT', robotCode },
  };
}

/**
 * Ensure Markdown tables have blank lines before them for proper rendering in DingTalk
 */
function ensureTableBlankLines(text: string): string {
  const lines = text.split('\n');
  const result: string[] = [];
  const tableRowRegex = /^\s*\|/;
  const isDivider = (line: string) => /^\s*\|[-:|\s]+\|\s*$/.test(line);

  for (let i = 0; i < lines.length; i++) {
    const currentLine = lines[i];
    const nextLine = lines[i + 1] ?? '';

    if (
      tableRowRegex.test(currentLine) &&
      isDivider(nextLine) &&
      i > 0 && lines[i - 1].trim() !== '' && !tableRowRegex.test(lines[i - 1])
    ) {
      result.push('');
    }

    result.push(currentLine);
  }
  return result.join('\n');
}

// ============ AI Card Functions ============

/**
 * Create AI Card for target
 * Uses the correct API: POST /v1.0/card/instances + POST /v1.0/card/instances/deliver
 */
export async function createAICardForTarget(
  config: DingTalkConfig,
  target: AICardTarget,
  log?: any,
): Promise<AICardInstance | null> {
  const targetDesc = target.type === 'group'
    ? `group ${target.openConversationId}`
    : `user ${target.userId}`;

  try {
    const token = await getAccessToken(config);
    const cardInstanceId = `card_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

    log?.info?.(`[DingTalk][AICard] Creating card: ${targetDesc}, outTrackId=${cardInstanceId}`);

    // 1. Create card instance
    const createBody = {
      cardTemplateId: AI_CARD_TEMPLATE_ID,
      outTrackId: cardInstanceId,
      cardData: { cardParamMap: {} },
      callbackType: 'STREAM',
      imGroupOpenSpaceModel: { supportForward: true },
      imRobotOpenSpaceModel: { supportForward: true },
    };

    log?.info?.(`[DingTalk][AICard] POST /v1.0/card/instances`);
    const createResp = await axios.post(`${DINGTALK_API}/v1.0/card/instances`, createBody, {
      headers: { 'x-acs-dingtalk-access-token': token, 'Content-Type': 'application/json' },
    });
    log?.info?.(`[DingTalk][AICard] Create response: status=${createResp.status}`);

    // 2. Deliver card
    const deliverBody = buildDeliverBody(cardInstanceId, target, config.clientId);

    log?.info?.(`[DingTalk][AICard] POST /v1.0/card/instances/deliver body=${JSON.stringify(deliverBody)}`);
    const deliverResp = await axios.post(`${DINGTALK_API}/v1.0/card/instances/deliver`, deliverBody, {
      headers: { 'x-acs-dingtalk-access-token': token, 'Content-Type': 'application/json' },
    });
    log?.info?.(`[DingTalk][AICard] Deliver response: status=${deliverResp.status}`);

    return { cardInstanceId, accessToken: token, inputingStarted: false };
  } catch (err: any) {
    log?.error?.(`[DingTalk][AICard] Failed to create card (${targetDesc}): ${err.message}`);
    if (err.response) {
      log?.error?.(`[DingTalk][AICard] Error response: status=${err.response.status} data=${JSON.stringify(err.response.data)}`);
    }
    return null;
  }
}

/**
 * Stream update AI Card content
 * Uses the correct API: PUT /v1.0/card/streaming
 */
export async function streamAICard(
  card: AICardInstance,
  content: string,
  finished: boolean = false,
  log?: any,
): Promise<void> {
  // First streaming call - switch to INPUTING state
  if (!card.inputingStarted) {
    const statusBody = {
      outTrackId: card.cardInstanceId,
      cardData: {
        cardParamMap: {
          flowStatus: AICardStatus.INPUTING,
          msgContent: '',
          staticMsgContent: '',
          sys_full_json_obj: JSON.stringify({
            order: ['msgContent'],
          }),
        },
      },
    };

    log?.info?.(`[DingTalk][AICard] PUT /v1.0/card/instances (INPUTING) outTrackId=${card.cardInstanceId}`);
    try {
      const statusResp = await axios.put(`${DINGTALK_API}/v1.0/card/instances`, statusBody, {
        headers: { 'x-acs-dingtalk-access-token': card.accessToken, 'Content-Type': 'application/json' },
      });
      log?.info?.(`[DingTalk][AICard] INPUTING response: status=${statusResp.status}`);
    } catch (err: any) {
      log?.error?.(`[DingTalk][AICard] INPUTING switch failed: ${err.message}, resp=${JSON.stringify(err.response?.data)}`);
      throw err;
    }
    card.inputingStarted = true;
  }

  // Call streaming API to update content
  const fixedContent = ensureTableBlankLines(content);
  const body = {
    outTrackId: card.cardInstanceId,
    guid: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    key: 'msgContent',
    content: fixedContent,
    isFull: true,  // Full replacement
    isFinalize: finished,
    isError: false,
  };

  log?.info?.(`[DingTalk][AICard] PUT /v1.0/card/streaming contentLen=${content.length} isFinalize=${finished} guid=${body.guid}`);
  try {
    const streamResp = await axios.put(`${DINGTALK_API}/v1.0/card/streaming`, body, {
      headers: { 'x-acs-dingtalk-access-token': card.accessToken, 'Content-Type': 'application/json' },
    });
    log?.info?.(`[DingTalk][AICard] Streaming response: status=${streamResp.status}`);
  } catch (err: any) {
    log?.error?.(`[DingTalk][AICard] Streaming update failed: ${err.message}, resp=${JSON.stringify(err.response?.data)}`);
    throw err;
  }
}

/**
 * Finish AI Card
 * 1. Close streaming channel with final content (isFinalize=true)
 * 2. Update card status to FINISHED
 */
export async function finishAICard(
  card: AICardInstance,
  content: string,
  log?: any,
): Promise<void> {
  const fixedContent = ensureTableBlankLines(content);
  log?.info?.(`[DingTalk][AICard] Finishing card, final content length=${fixedContent.length}`);

  // 1. Close streaming channel with final content
  await streamAICard(card, fixedContent, true, log);

  // 2. Update card status to FINISHED
  const body = {
    outTrackId: card.cardInstanceId,
    cardData: {
      cardParamMap: {
        flowStatus: AICardStatus.FINISHED,
        msgContent: fixedContent,
        staticMsgContent: '',
        sys_full_json_obj: JSON.stringify({
          order: ['msgContent'],
        }),
      },
    },
  };

  log?.info?.(`[DingTalk][AICard] PUT /v1.0/card/instances (FINISHED) outTrackId=${card.cardInstanceId}`);
  try {
    const finishResp = await axios.put(`${DINGTALK_API}/v1.0/card/instances`, body, {
      headers: { 'x-acs-dingtalk-access-token': card.accessToken, 'Content-Type': 'application/json' },
    });
    log?.info?.(`[DingTalk][AICard] FINISHED response: status=${finishResp.status}`);
  } catch (err: any) {
    log?.error?.(`[DingTalk][AICard] FINISHED update failed: ${err.message}, resp=${JSON.stringify(err.response?.data)}`);
  }
}

/**
 * Send AI Card internally (non-streaming, for simple replies)
 */
export async function sendAICardInternal(
  config: DingTalkConfig,
  target: AICardTarget,
  content: string,
  log?: any,
): Promise<void> {
  const card = await createAICardForTarget(config, target, log);
  if (card) {
    await finishAICard(card, content, log);
  }
}
