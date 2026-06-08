/**
 * DigitalHumanFrameMessages.ts — DigitalHumanFrame 跨 iframe 消息类型常量
 *
 * 定义父页面 ↔ iframe（DigitalHuman 内嵌帧）之间 postMessage 通信使用的消息类型字符串。
 * 所有消息类型都带统一前缀（默认 `dh-frame:`）以避免与其他 postMessage 冲突。
 */

/** DigitalHumanFrame 消息类型前缀 */
export const FRAME_MSG_PREFIX = 'dh-frame:';

/** DigitalHumanFrame 消息类型表（key → 完整消息类型字符串） */
export interface FrameMessages {
  INIT_AVATAR: string;
  INIT_FROM_CONFIG: string;
  CREATE_SESSION: string;
  SEND: string;
  SEND_MESSAGE: string;
  CANCEL_SEND: string;
  SEND_BOOT_MESSAGE: string;
  PLAY_ACTION: string;
  SWITCH_VIDEO: string;
  SWITCH_TO_IDLE: string;
  SWITCH_TO_TALKING: string;
  SET_MOUTH_OPEN: string;
  PLAY_MOTION: string;
  GET_ACTIONS: string;
  GET_ACTION_LIST: string;
  GET_AVATAR_STATUS: string;
  DESTROY: string;
  GET_SESSION: string;
  START_VOICE_CHAT: string;
  STOP_VOICE_CHAT: string;
  SEND_VOICE_TEXT: string;
  SEND_CONTEXT: string;
  SEND_TTS: string;
  MUTE_MICROPHONE: string;
  UPDATE_VOICE_CHAT: string;
  RESTART_VOICE_CHAT: string;
  RESTART_AGENT: string;
  SEND_HEARTBEAT: string;
  TRIGGER_VOICE_HEARTBEAT: string;
  SET_ACTIVE: string;
  SET_SUBTITLE_CONFIG: string;
  GET_SUBTITLE_CONFIG: string;
  CLEAR_SUBTITLE: string;
  EXPAND_INLINE_SYSTEM_PROMPT: string;
  LOAD_SUMMARIZE_AGENT_CONFIG: string;
  SUMMARIZE: string;
  SET_TOKEN: string;
  EVENT: string;
  READY: string;
  RESPONSE: string;
}

/**
 * 用指定前缀生成一套消息类型常量。
 * @param prefix - 消息类型前缀（默认 FRAME_MSG_PREFIX）
 */
export function createFrameMessages(prefix: string = FRAME_MSG_PREFIX): FrameMessages {
  return {
    INIT_AVATAR: `${prefix}init-avatar`,
    INIT_FROM_CONFIG: `${prefix}init-from-config`,
    CREATE_SESSION: `${prefix}create-session`,
    SEND: `${prefix}send`,
    SEND_MESSAGE: `${prefix}send-message`,
    CANCEL_SEND: `${prefix}cancel-send`,
    SEND_BOOT_MESSAGE: `${prefix}send-boot-message`,
    PLAY_ACTION: `${prefix}play-action`,
    SWITCH_VIDEO: `${prefix}switch-video`,
    SWITCH_TO_IDLE: `${prefix}switch-to-idle`,
    SWITCH_TO_TALKING: `${prefix}switch-to-talking`,
    SET_MOUTH_OPEN: `${prefix}set-mouth-open`,
    PLAY_MOTION: `${prefix}play-motion`,
    GET_ACTIONS: `${prefix}get-actions`,
    GET_ACTION_LIST: `${prefix}get-action-list`,
    GET_AVATAR_STATUS: `${prefix}get-avatar-status`,
    DESTROY: `${prefix}destroy`,
    GET_SESSION: `${prefix}get-session`,
    START_VOICE_CHAT: `${prefix}start-voice-chat`,
    STOP_VOICE_CHAT: `${prefix}stop-voice-chat`,
    SEND_VOICE_TEXT: `${prefix}send-voice-text`,
    SEND_CONTEXT: `${prefix}send-context`,
    SEND_TTS: `${prefix}send-tts`,
    MUTE_MICROPHONE: `${prefix}mute-microphone`,
    UPDATE_VOICE_CHAT: `${prefix}update-voice-chat`,
    RESTART_VOICE_CHAT: `${prefix}restart-voice-chat`,
    RESTART_AGENT: `${prefix}restart-agent`,
    SEND_HEARTBEAT: `${prefix}send-heartbeat`,
    TRIGGER_VOICE_HEARTBEAT: `${prefix}trigger-voice-heartbeat`,
    SET_ACTIVE: `${prefix}set-active`,
    SET_SUBTITLE_CONFIG: `${prefix}set-subtitle-config`,
    GET_SUBTITLE_CONFIG: `${prefix}get-subtitle-config`,
    CLEAR_SUBTITLE: `${prefix}clear-subtitle`,
    EXPAND_INLINE_SYSTEM_PROMPT: `${prefix}expand-inline-system-prompt`,
    LOAD_SUMMARIZE_AGENT_CONFIG: `${prefix}load-summarize-agent-config`,
    SUMMARIZE: `${prefix}summarize`,
    SET_TOKEN: `${prefix}set-token`,
    EVENT: `${prefix}event`,
    READY: `${prefix}ready`,
    RESPONSE: `${prefix}response`,
  };
}

/** 默认消息类型常量（使用默认前缀） */
export const MSG: FrameMessages = createFrameMessages(FRAME_MSG_PREFIX);
