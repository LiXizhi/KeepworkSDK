/**
 * AIChatRTC.constants.js — AIChatRTC 共享常量与工具函数
 *
 * 提供给 AIChatRTC.js（主类）和 AIChatRTC.session.js（RTCChatSession）共同使用，
 * 避免两个文件之间的循环依赖。
 */

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_RTC_SDK_URL =
  'https://cdn.keepwork.com/keepwork/cdn/volcengine/rtc@4.68.1.index.min.js';

/** TLV message types matching VolcEngine AIGC protocol */
const MESSAGE_TYPE = {
  SUBTITLE: 'subv',
  FUNCTION_CALL: 'tool',
  FUNCTION_CALL_INFO: 'info',
  BRIEF: 'conv',
  CHAT: 'chat',
};

/** Agent conversation states */
const AGENT_STATE = {
  UNKNOWN: 0,
  LISTENING: 1,
  THINKING: 2,
  SPEAKING: 3,
  INTERRUPTED: 4,
  FINISHED: 5,
};

const AGENT_STATE_LABELS = {
  [AGENT_STATE.UNKNOWN]: '—',
  [AGENT_STATE.LISTENING]: 'Listening',
  [AGENT_STATE.THINKING]: 'Thinking',
  [AGENT_STATE.SPEAKING]: 'Speaking',
  [AGENT_STATE.INTERRUPTED]: 'Interrupted',
  [AGENT_STATE.FINISHED]: 'Finished',
};

/** Binary-channel control commands */
const COMMAND = {
  INTERRUPT: 'interrupt',
  EXTERNAL_TEXT_TO_SPEECH: 'ExternalTextToSpeech',
  EXTERNAL_TEXT_TO_LLM: 'ExternalTextToLLM',
  EXTERNAL_PROMPTS_FOR_LLM: 'ExternalPromptsForLLM',
};

const INTERRUPT_PRIORITY = {
  NONE: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
};

// ============================================================================
// TLV Binary Protocol Helpers
// ============================================================================

/**
 * Encode a string into TLV (Type-Length-Value) binary format.
 * TLV: | type (4 bytes) | length (4 bytes, big-endian) | value (N bytes) |
 */
function string2tlv(str: string, type: string): ArrayBufferLike {
  const typeBuffer = new Uint8Array(4);
  for (let i = 0; i < type.length && i < 4; i++) {
    typeBuffer[i] = type.charCodeAt(i);
  }
  const valueBuffer = new TextEncoder().encode(str);
  const length = valueBuffer.length;
  const tlvBuffer = new Uint8Array(4 + 4 + length);
  tlvBuffer.set(typeBuffer, 0);
  tlvBuffer[4] = (length >> 24) & 0xff;
  tlvBuffer[5] = (length >> 16) & 0xff;
  tlvBuffer[6] = (length >> 8) & 0xff;
  tlvBuffer[7] = length & 0xff;
  tlvBuffer.set(valueBuffer, 8);
  return tlvBuffer.buffer;
}

/**
 * Decode TLV binary data back to { type, value } strings.
 */
function tlv2String(tlvBuffer: ArrayBuffer | ArrayBufferView): { type: string; value: string } {
  const bytes = new Uint8Array(tlvBuffer as ArrayBuffer);
  let type = '';
  for (let i = 0; i < 4; i++) {
    if (bytes[i]) type += String.fromCharCode(bytes[i]);
  }
  const length =
    (bytes[4] << 24) | (bytes[5] << 16) | (bytes[6] << 8) | bytes[7];
  const value = new TextDecoder().decode(bytes.subarray(8, 8 + length));
  return { type, value };
}

// ============================================================================
// Utility Helpers
// ============================================================================

function _randomId(len = 8): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let r = '';
  for (let i = 0; i < len; i++)
    r += chars[Math.floor(Math.random() * chars.length)];
  return r;
}

function genId(prefix: string, username?: string): string {
  const suffix = username || _randomId();
  return prefix + suffix;
}

function deepClone<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function mergeToolDefinitions(existingTools: unknown, copilotTools: unknown[]): Array<Record<string, unknown>> {
  const existing = (Array.isArray(existingTools) ? existingTools : []) as Array<Record<string, unknown>>;
  const seen = new Set(
    existing.map((t) => (t?.function as { name?: string })?.name).filter(Boolean),
  );
  const merged = [...existing];
  for (const toolDef of copilotTools as Array<Record<string, unknown>>) {
    const fnName = (toolDef?.function as { name?: string })?.name;
    if (!fnName || seen.has(fnName)) continue;
    seen.add(fnName);
    merged.push(toolDef);
  }
  return merged;
}

function formatChildResultsSummary(results: Array<Record<string, unknown>>): string {
  return results
    .map((childResult) => {
      const resultText = typeof childResult.result === 'string'
        ? childResult.result
        : JSON.stringify(childResult.result);
      return `[Agent ${childResult.agentName}] Task: ${childResult.taskSummary}\nResult: ${resultText}`;
    })
    .join('\n\n');
}

function normalizeRTCMessageContent(content: unknown): string | null {
  if (content === null || content === undefined) return null;
  return typeof content === 'string' ? content : JSON.stringify(content);
}

export {
  DEFAULT_RTC_SDK_URL,
  MESSAGE_TYPE, AGENT_STATE, AGENT_STATE_LABELS, COMMAND, INTERRUPT_PRIORITY,
  string2tlv, tlv2String,
  _randomId, genId, deepClone, mergeToolDefinitions,
  formatChildResultsSummary, normalizeRTCMessageContent,
};
