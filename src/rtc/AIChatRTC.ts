/**
 * AIChatRTC — VolcEngine RTC-based voice chat module.
 *
 * Provides an interface similar to AIChat.js (constructor takes SDK, provides
 * `createSession()`) plus real-time event emitting for subtitles, agent state,
 * and function calls. Supports S2S, ASR+LLM+TTS, and mixed modes.
 *
 * Usage:
 *   import AIChatRTC from './AIChatRTC';
 *   // or: const { AIChatRTC, AGENT_STATE } = window; // from IIFE bundle
 *
 *   const rtc = new AIChatRTC(sdk);
 *   const session = rtc.createSession({
 *     appId: '...',
 *     agentConfig: { WelcomeMessage: 'Hello!', ... },
 *     config: { LLMConfig: { ... }, TTSConfig: { ... }, ... },
 *   });
 *   session.on('subtitle', ({ text, isUser }) => console.log(text));
 *   session.on('state', ({ code, label }) => console.log(label));
 *   await session.start();
 *   session.sendText('Hi there');
 *   await session.stop();
 *
 * Reference: https://www.volcengine.com/docs/6348/1554654?lang=zh
 */

import SandboxToolEnv from '../ai-chat/SandboxToolEnv';
import { initChildSessionState, childSessionMethods } from '../ai-chat/ChildSessionMixin';
import { compressBase64Image, base64ByteSize, DEFAULT_MAX_BYTES } from '../utils/ImageUtils';

// RTCChatSession 类在独立文件中以减小单文件体积。
// installRTCChatSessionMixin 必须显式 import 并调用（见下方），否则 RTCChatSession.session.ts
// 内的 ChildSessionMixin prototype 注册会被 Rollup tree-shaking 删除。
import RTCChatSession, { installRTCChatSessionMixin } from './AIChatRTC.session';

installRTCChatSessionMixin();




import {
  DEFAULT_RTC_SDK_URL,
  MESSAGE_TYPE, AGENT_STATE, AGENT_STATE_LABELS, COMMAND, INTERRUPT_PRIORITY,
  string2tlv, tlv2String,
  genId, deepClone, mergeToolDefinitions, formatChildResultsSummary, normalizeRTCMessageContent,
} from './AIChatRTC.constants';

// ============================================================================
// AIChatRTC — Main Entry Point
// ============================================================================

declare const VERTC: unknown;

class AIChatRTC {
  static AGENT_STATE = AGENT_STATE;
  static AGENT_STATE_LABELS = AGENT_STATE_LABELS;
  static COMMAND = COMMAND;

  sdk: unknown;
  sdkUrl: string;
  _loadPromise: Promise<void> | null;
  [key: string]: unknown;

  /**
   * @param {Object} sdk  - KeepworkSDK instance (provides sdk.post, sdk.token, sdk.copilotTools)
   * @param {Object} [options]
   * @param {string} [options.sdkUrl] - Override VolcEngine RTC CDN URL
   */
  constructor(sdk: unknown, options: Record<string, unknown> = {}) {
    this.sdk = sdk;
    this.sdkUrl = (options.sdkUrl as string) || DEFAULT_RTC_SDK_URL;
    this._loadPromise = null;
  }

  /**
   * Preload the VolcEngine RTC SDK. Called automatically by session.start(),
   * but can be invoked earlier for faster startup.
   * @returns {Promise<void>}
   */
  loadSDK(): Promise<void> {
    if (typeof VERTC !== 'undefined') return Promise.resolve();
    if (this._loadPromise) return this._loadPromise;
    this._loadPromise = new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = this.sdkUrl;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => {
        this._loadPromise = null;
        reject(new Error('Failed to load VolcEngine RTC SDK'));
      };
      document.head.appendChild(script);
    });
    return this._loadPromise;
  }

  /**
   * Create a new RTC chat session.
   * @param {Object} config - Session configuration
   * @param {string} config.appId - VolcEngine AppId
   * @param {'ai'|'human'} [config.mode='ai'] - Session mode: 'ai' starts an AI voice agent;
   *   'human' joins the room for human-only voice/text chat (no AI agent is created)
   * @param {string} [config.roomId] - Room ID (auto-generated if omitted)
   * @param {string} [config.userId] - User ID (auto-generated if omitted)
   * @param {string} [config.taskId] - Task ID (auto-generated if omitted)
   * @param {string} [config.agentUserId='ai_agent_bot'] - Agent bot user ID in the RTC room
   * @param {string} [config.rtcToken] - Pre-fetched RTC token (skips server request if provided)
   * @param {Object} [config.agentConfig] - AgentConfig for voiceChat/start (ai mode only)
   * @param {Object} [config.config] - The main Config block (ASR/LLM/TTS/S2S/Subtitle/Interrupt etc.) (ai mode only)
   * @param {string} [config.workspace] - SandboxToolEnv workspace name (ai mode only)
   * @param {string|Object} [config.mountFolder] - Readonly fallback folder for file operations (ai mode only)
   * @param {string[]} [config.enabledToolCategories=['fileOps','agent']] - Tool categories for SandboxToolEnv (ai mode only)
   * @param {Array} [config.tools] - Additional custom tool definitions (OpenAI format) (ai mode only)
   * @returns {RTCChatSession}
   */
  createSession(config: Record<string, unknown> = {}): RTCChatSession {
    return new RTCChatSession(this, config);
  }
}

// ============================================================================
// RTCChatSession — Manages One RTC Room + Voice Agent Lifecycle
// ============================================================================


export {
  AIChatRTC,
  RTCChatSession,
  MESSAGE_TYPE,
  AGENT_STATE,
  AGENT_STATE_LABELS,
  COMMAND,
  INTERRUPT_PRIORITY,
  string2tlv,
  tlv2String,
  DEFAULT_RTC_SDK_URL,
};
export default AIChatRTC;
