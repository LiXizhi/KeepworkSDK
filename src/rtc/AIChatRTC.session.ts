/**
 * AIChatRTC.session.js — RTCChatSession 类（VolcEngine RTC 语音会话生命周期）
 *
 * 由 AIChatRTC.js 导入，不单独使用。
 */

import SandboxToolEnv from '../ai-chat/SandboxToolEnv';
import { initChildSessionState, childSessionMethods } from '../ai-chat/ChildSessionMixin';
import { compressBase64Image, base64ByteSize, DEFAULT_MAX_BYTES } from '../utils/ImageUtils';
import {
  DEFAULT_RTC_SDK_URL,
  MESSAGE_TYPE, AGENT_STATE, AGENT_STATE_LABELS, COMMAND, INTERRUPT_PRIORITY,
  string2tlv, tlv2String,
  genId, deepClone, mergeToolDefinitions, formatChildResultsSummary, normalizeRTCMessageContent,
} from './AIChatRTC.constants';
import SDKLogger from '../utils/SDKLogger';
const console = SDKLogger.createModuleConsole('AIChatRTC');

/** RTC 引擎/SDK 宽松调用类型（方法返回 any 以便链式调用） */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RTCAny = Record<string, any>;
declare const VERTC: RTCAny;

class RTCChatSession {
  // 重度使用的字段显式声明（避免 index 签名把它们变成 unknown 而无法调用/索引）
  aiChatRTC!: RTCAny;
  sdk: RTCAny = null as unknown as RTCAny;
  options!: Record<string, unknown>;
  rtcEngine: RTCAny = null as unknown as RTCAny;
  sandbox: RTCAny = null as unknown as RTCAny;
  _listeners: Record<string, Array<(data?: unknown) => void>> = {};
  _subtitleBuffer: Record<string, { text: string; isUser: boolean; [k: string]: unknown }> = {};
  _history: Array<Record<string, unknown>> = [];
  _pendingMessages: Array<{ targetUserId?: string; binaryData?: unknown; label?: string; isRoomMessage?: boolean; [k: string]: unknown }> = [];
  _comfortSentTypes!: Set<string>;
  _chatReassemblyBuffer: Record<string, { chunks: string[]; userId?: unknown; username?: unknown; timestamp?: unknown; [k: string]: unknown }> = {};
  _autoPlayFailUsers: unknown[] = [];
  enabledToolCategories!: unknown;
  customTools!: unknown[];
  agentState: number = AGENT_STATE.UNKNOWN;
  isActive = false;
  isMuted = false;
  isConnected = false;
  isScreenSharing = false;
  isCameraSharing = false;
  mode!: string;
  appId: unknown;
  roomId!: string;
  userId!: string;
  taskId!: string;
  agentUserId!: string;
  _chatGroupId = 0;
  _imageGroupId = 100;
  // ChildSessionMixin 在运行时附加的方法
  _cleanupChildSessions!: () => void;
  _cancelDebounceTimers!: () => void;
  _consumePendingChildResults!: () => unknown[];
  [key: string]: unknown;

  /**
   * @param {AIChatRTC} aiChatRTC - Parent AIChatRTC instance
   * @param {Object} config - Session configuration (see AIChatRTC.createSession)
   */
  constructor(aiChatRTC: Record<string, unknown>, config: Record<string, unknown> = {}) {
    this.aiChatRTC = aiChatRTC as RTCAny;
    this.sdk = aiChatRTC.sdk as RTCAny;
    this.options = { ...config };
    this.model = config.model || (config.config as { LLMConfig?: { Model?: string } })?.LLMConfig?.Model || 'keepwork-flash';

    // IDs — auto-generate where not provided
    this.appId = config.appId;
    const username = (aiChatRTC.sdk as { user?: { username?: string } })?.user?.username;
    this.roomId = (config.roomId as string) || genId('room_', username);
    this.userId = (config.userId as string) || genId('user_', username);
    this.taskId = (config.taskId as string) || genId('task_', username);
    this.agentUserId = (config.agentUserId as string) || 'ai_agent_bot';
    this.rtcToken = config.rtcToken || null;

    // Session mode: 'ai' (default) or 'human' (no AI agent)
    this.mode = (config.mode as string) || 'ai';

    // Voice chat config
    this.agentConfig = config.agentConfig || {};
    this.voiceChatConfig = config.config || {};

    // Sandbox / tools
    this.workspace = config.workspace || '';
    this.mountFolder = config.mountFolder || null;
    this.enabledToolCategories = config.enabledToolCategories || ['fileOps', 'agent'];
    this.customTools = Array.isArray(config.tools) ? config.tools : [];
    this.toolProxy = config.toolProxy || null;
    this.sandbox = null as unknown as RTCAny; // created on start()

    // RTC engine state
    this.rtcEngine = null as unknown as RTCAny;
    this.isActive = false;
    this.isMuted = false;
    this.isConnected = false;
    this.isScreenSharing = false;
    this.isCameraSharing = false;

    // Agent state tracking
    this.agentState = AGENT_STATE.UNKNOWN;
    this._stateEventReceived = false;

    // Connection resilience: queued messages during disconnect
    this._pendingMessages = [];

    // Comfort message: each type allowed once per turn
    this._comfortSentTypes = new Set();

    // Subtitle streaming buffer: { [key]: { text, isUser } }
    this._subtitleBuffer = {};
    this._history = []; // accumulated subtitle messages

    // Image upload counter
    this._imageGroupId = 100;

    // Room chat chunking
    this._chatGroupId = 0;
    this._chatReassemblyBuffer = {}; // { [groupId]: { chunks: [], total, userId, username, timestamp } }

    // Autoplay failure tracking
    this._autoPlayFailUsers = [];
    this._autoPlayResumeRegistered = false;

    // Event emitter storage
    this._listeners = {};

    // Child agent session support (via ChildSessionMixin)
    initChildSessionState(this as unknown as Parameters<typeof initChildSessionState>[0], config);
  }

  // ─── Event Emitter ─────────────────────────────────────────────────

  /**
   * Subscribe to an event.
   * @param {string} event
   * @param {Function} callback
   * @returns {RTCChatSession} this (for chaining)
   */
  on(event: string, callback: (data?: unknown) => void): this {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(callback);
    return this;
  }

  /**
   * Unsubscribe from an event.
   * @param {string} event
   * @param {Function} callback
   * @returns {RTCChatSession}
   */
  off(event: string, callback: (data?: unknown) => void): this {
    const list = this._listeners[event];
    if (list) {
      this._listeners[event] = list.filter((fn) => fn !== callback);
    }
    return this;
  }

  /**
   * Emit an event to all subscribers.
   * @param {string} event
   * @param {*} data
   */
  emit(event: string, data?: unknown): void {
    const list = this._listeners[event];
    if (!list) return;
    for (const fn of list) {
      try {
        fn(data);
      } catch (e) {
        console.warn(`[RTCChatSession] Event '${event}' listener error:`, e);
      }
    }
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────

  /**
   * Start the session: load RTC SDK → fetch token → join room → start audio.
   * In 'ai' mode, also starts the server-side AI voice agent.
   * In 'human' mode, only joins the RTC room for multi-user voice/text chat.
   * @returns {Promise<void>}
   */
  async start() {
    if (this.isActive) throw new Error('Session already active');

    // 1. Load VolcEngine RTC SDK
    await this.aiChatRTC.loadSDK();

    // 2. Create SandboxToolEnv for this session (ai mode only)
    let copilotToolDefs = [];
    if (this.mode === 'ai') {
      this._ensureSandbox();
      copilotToolDefs = await this.sandbox.getToolDefinitions();
    }

    // 3. Get RTC token
    let token = this.rtcToken;
    if (!token) {
      const resp = await this.sdk.post('/gpt/generateRTCToken', {
        roomId: this.roomId,
        userId: this.userId,
        appId: this.appId,
      });
      if (!resp?.token) throw new Error('Failed to get RTC token');
      token = resp.token;
    }

    // 4. Create engine & wire events
    this.rtcEngine = VERTC.createEngine(this.appId);
    try {
      this.rtcEngine.enableAudioPropertiesReport({ interval: 300 });
    } catch (_) {
      /* older SDK versions may not support this */
    }
    this._setupRTCEvents();

    // 5. Join room
    await this.rtcEngine.joinRoom(
      token,
      this.roomId,
      { userId: this.userId },
      {
        isAutoPublish: true,
        isAutoSubscribeAudio: true,
        isAutoSubscribeVideo: false,
      },
    );
    this.isConnected = true;
    this.isActive = true;

    // 6. Check microphone availability and start audio capture
    // Explicit AEC/ANS/AGC constraints prevent echo loops on mobile where
    // the AI speaker output would otherwise feed back into the microphone.
    const audioConstraints = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    };
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
        // Release the test stream immediately
        stream.getTracks().forEach(t => t.stop());
      } catch (micErr) {
        this._cleanup();
        const me = micErr as { name?: string; message?: string };
        const reason = me.name === 'NotAllowedError'
          ? 'Microphone permission denied. Please allow microphone access.'
          : me.name === 'NotFoundError'
            ? 'No microphone found on this device.'
            : `Microphone access failed: ${me.message}`;
        throw new Error(reason);
      }
    } else {
      this._cleanup();
      throw new Error('Microphone not supported in this browser/WebView. getUserMedia API is not available.');
    }
    await this.rtcEngine.startAudioCapture();

    // 7–9. AI agent startup (skipped in human mode)
    if (this.mode === 'ai') {
      const voiceChatBody = await this._buildVoiceChatBody(copilotToolDefs);

      const startResp = await this.sdk.post(
        '/gpt/voiceChat/start',
        voiceChatBody,
      );
      if (startResp?.error) {
        throw new Error(startResp.error.message || 'StartVoiceChat failed');
      }

      const welcomeMsg = (voiceChatBody.AgentConfig as { WelcomeMessage?: string })?.WelcomeMessage;
      if (welcomeMsg) {
        this._addHistory('assistant', welcomeMsg, 'welcome');
        this.emit('welcome', { message: welcomeMsg });
      }
    }

    this.emit('connected', { roomId: this.roomId, userId: this.userId });
  }

  /**
   * Stop the session and leave the RTC room.
   * In 'ai' mode, also stops the server-side AI voice agent.
   * @returns {Promise<void>}
   */
  async stop() {
    // Stop voice chat agent on server (ai mode only)
    if (this.mode === 'ai' && this.taskId && this.roomId && this.appId) {
      try {
        await this.sdk.post('/gpt/voiceChat/stop', {
          appId: this.appId,
          roomId: this.roomId,
          taskId: this.taskId,
        });
      } catch (e) {
        console.warn('[RTCChatSession] stop voiceChat warning:', (e as Error)?.message);
      }
    }
    this._cleanup();
  }

  /**
   * Update an active voice chat session via REST API.
   * Supports commands: ExternalTextToSpeech, UpdateParameters, interrupt, etc.
   * @param {string} command - Command type
   * @param {Object} [options] - Additional fields (Message, InterruptMode, Parameters, etc.)
   * @returns {Promise<Object>} API response
   */
  async updateVoiceChat(command: string, options: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.isActive || !this.taskId || !this.roomId || !this.appId) {
      throw new Error('[RTCChatSession] updateVoiceChat: session not active');
    }
    const body = {
      appId: this.appId,
      roomId: this.roomId,
      taskId: this.taskId,
      command,
      ...options,
    };
    return this.sdk.post('/gpt/voiceChat/update', body);
  }

  /**
   * Update LLM/TTS/etc. parameters without leaving the RTC room.
   * @param {Object} config - New Config block for VolcEngine UpdateParameters
   * @param {Object} [options] - Additional UpdateVoiceChat fields
   * @returns {Promise<Object>} API response
   */
  async updateParameters(config: unknown = this.voiceChatConfig, options: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.isActive || !this.taskId || !this.roomId || !this.appId) {
      throw new Error('[RTCChatSession] updateParameters: session not active');
    }

    const nextConfig = deepClone(config || {});
    const toolDefs = this.mode === 'ai'
      ? await this._ensureSandbox().getToolDefinitions(true)
      : [];
    const apiConfig = await this._buildVoiceChatConfigForAPI(toolDefs, nextConfig, { replaceTools: true });
    const updateConfig = this._buildVoiceChatUpdateConfig(apiConfig);
    const { parameters: _lowerParameters, ...restOptions } = options;
    const parameters = {
      ...(_lowerParameters || {}),
      Config: updateConfig,
    };

    const response = await this.updateVoiceChat('UpdateParameters', {
      ...restOptions,
      parameters,
    });
    this.voiceChatConfig = nextConfig;
    return response;
  }

  /** Alias for stop() + full cleanup */
  async destroy() {
    await this.stop();
  }

  _cleanup() {
    if (this.rtcEngine) {
      try {
        if (this.isScreenSharing) this.rtcEngine.stopScreenCapture();
        if (this.isCameraSharing) this.rtcEngine.stopVideoCapture();
        this.rtcEngine.stopAudioCapture();
        this.rtcEngine.leaveRoom();
        VERTC.destroyEngine(this.rtcEngine);
      } catch (e) {
        console.warn('[RTCChatSession] cleanup warning:', (e as Error)?.message);
      }
      this.rtcEngine = null as unknown as RTCAny;
    }
    this.isActive = false;
    this.isMuted = false;
    this.isConnected = false;
    this.isScreenSharing = false;
    this.isCameraSharing = false;
    this._pendingMessages = [];
    this._subtitleBuffer = {};
    this._chatReassemblyBuffer = {};
    this.agentState = AGENT_STATE.UNKNOWN;
    this._stateEventReceived = false;
    this._autoPlayResumeRegistered = false;
    this._cleanupChildSessionsSafe();
  }

  _cleanupChildSessionsSafe(): void {
    const cleanup = this._cleanupChildSessions;
    if (typeof cleanup === 'function') {
      cleanup.call(this);
      return;
    }

    // 兜底：某些运行时 bundle 可能未注入 ChildSessionMixin 方法，停止语音时不能因此中断清理链路。
    for (const timer of (this._debounceTimers as ReturnType<typeof setTimeout>[] | undefined) || []) {
      clearTimeout(timer);
    }
    this._debounceTimers = [];
    this._childSessions = {};
    this._pendingChildResults = [];
  }

  _ensureSandbox(): RTCAny {
    if (!this.sandbox) {
      this.sandbox = new SandboxToolEnv(this.sdk, {
        workspace: this.workspace as string,
        mountFolder: this.mountFolder as string,
        enabledCategories: this.enabledToolCategories as string[],
        toolProxy: this.toolProxy as Record<string, unknown>,
        session: this,
      } as ConstructorParameters<typeof SandboxToolEnv>[1]);
    }
    return this.sandbox;
  }

  // ─── Chat-like API ─────────────────────────────────────────────────

  /**
   * Send a message using a ChatSession-like API.
   * Supports delayed child-agent result injection and local `${...}` template
   * expansion via `runCode` before sending through the RTC text channel.
   *
   * Returns the text submitted into the RTC pipeline. The actual assistant
   * response continues to arrive via RTC events such as `subtitle`.
   *
   * @param {string|Object|null} userMessage
   * @param {Object} [options]
   * @param {boolean} [options.runCode=false] - Resolve `${...}` expressions via sandbox before sending
   * @returns {Promise<string|null>}
   */
  async send(userMessage: unknown, options: Record<string, unknown> = {}): Promise<string | null> {
    this._cancelDebounceTimers();
    this._isSending = true;

    try {
      let resolvedUserMessage = userMessage;
      const effectiveOptions = {
        ...this.options,
        ...options,
      };

      if (effectiveOptions.runCode === true && typeof userMessage === 'string') {
        resolvedUserMessage = await this._ensureSandbox().processTemplate(userMessage);
      }

      const outboundParts: string[] = [];
      const childResults = this._consumePendingChildResults() as Array<Record<string, unknown>>;
      if (childResults.length > 0) {
        outboundParts.push(formatChildResultsSummary(childResults));
      }

      const normalizedMessage = normalizeRTCMessageContent(resolvedUserMessage);
      if (normalizedMessage !== null && normalizedMessage !== '') {
        outboundParts.push(normalizedMessage);
      }

      this._lastSendOptions = effectiveOptions;

      if (outboundParts.length === 0) {
        return null;
      }

      const outboundText = outboundParts.join('\n\n');
      this.sendText(outboundText);
      return outboundText;
    } catch (error) {
      if (options.onError) {
        (options.onError as (e: unknown) => void)(error);
      }
      throw error;
    } finally {
      this._isSending = false;
    }
  }

  /**
   * Send text. In 'ai' mode, sends to the agent's LLM via RTC binary channel.
   * In 'human' mode, broadcasts to all room members via sendRoomText().
   * @param {string} text
   */
  sendText(text: string): void {
    if (this.mode === 'human') {
      this.sendRoomText(text);
      return;
    }
    this._sendCommand(COMMAND.EXTERNAL_TEXT_TO_LLM, text);
    this._addHistory('user', text);
  }

  /**
   * Broadcast a text message to all users in the RTC room.
   * Works in both 'ai' and 'human' modes.
   * Automatically chunks messages that exceed 1 KB.
   * @param {string} text
   */
  sendRoomText(text: string): void {
    if (!this.rtcEngine || !this.isActive) return;
    const MAX_PAYLOAD = 1024 - 8; // TLV header = 8 bytes

    const userId = this.userId;
    const username = this.sdk?.user?.username || this.userId;
    const timestamp = Date.now();

    // Fast path: fits in a single message
    const singlePayload = JSON.stringify({ userId, username, text, timestamp });
    if (new TextEncoder().encode(singlePayload).length <= MAX_PAYLOAD) {
      const binaryData = string2tlv(singlePayload, MESSAGE_TYPE.CHAT);
      if (!this.isConnected) {
        this._pendingMessages.push({ binaryData, label: `chat: ${text.substring(0, 50)}`, isRoomMessage: true });
      } else {
        try {
          const result = this.rtcEngine.sendRoomBinaryMessage(binaryData);
          if (result?.catch) {
            result.catch(() => {
              this._pendingMessages.push({ binaryData, label: `chat: ${text.substring(0, 50)}`, isRoomMessage: true });
            });
          }
        } catch (_) {
          this._pendingMessages.push({ binaryData, label: `chat: ${text.substring(0, 50)}`, isRoomMessage: true });
        }
      }
      this._addHistory('user', text);
      return;
    }

    // Measure wrapper overhead (text is empty string)
    const groupId = ++this._chatGroupId;
    const wrapperPayload = JSON.stringify({
      userId, username, text: '', timestamp, _g: groupId, _f: 99999, _p: true,
    });
    const overhead = new TextEncoder().encode(wrapperPayload).length;
    const chunkByteCap = MAX_PAYLOAD - overhead - 16;

    const chunks = this._splitTextForTLV(text, chunkByteCap);

    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      const chunkPayload = JSON.stringify({
        userId, username, text: chunks[i], timestamp,
        _g: groupId, _f: i + 1, _p: !isLast,
      });
      const binaryData = string2tlv(chunkPayload, MESSAGE_TYPE.CHAT);
      if (!this.isConnected) {
        this._pendingMessages.push({ binaryData, label: `chat ${i + 1}/${chunks.length}: ${text.substring(0, 30)}`, isRoomMessage: true });
      } else {
        try {
          const result = this.rtcEngine.sendRoomBinaryMessage(binaryData);
          if (result?.catch) {
            result.catch(() => {
              this._pendingMessages.push({ binaryData, label: `chat ${i + 1}/${chunks.length}: ${text.substring(0, 30)}`, isRoomMessage: true });
            });
          }
        } catch (_) {
          this._pendingMessages.push({ binaryData, label: `chat ${i + 1}/${chunks.length}: ${text.substring(0, 30)}`, isRoomMessage: true });
        }
      }
    }
    this._addHistory('user', text);
  }

  /**
   * Send background context to the agent's LLM via RTC binary channel.
   * Uses ExternalPromptsForLLM: injected as context for the next reply
   * without triggering an immediate response.
   * @param {string} text - Context text to inject
   * @param {Object} [options]
   * @param {boolean} [options.useREST=false] - Use REST API instead of binary channel
   */
  sendContext(text: string, options: Record<string, unknown> = {}): unknown {
    if (options.useREST) {
      return this.updateVoiceChat('ExternalPromptsForLLM', { Message: text });
    }
    this._sendCommand(COMMAND.EXTERNAL_PROMPTS_FOR_LLM, text);
    return undefined;
  }

  /**
   * Send text to the agent's TTS (text-to-speech) via RTC binary channel.
   * @param {string} text
   * @param {Object} [options]
   * @param {boolean} [options.useREST=false] - Use REST API instead of binary channel (supports InterruptMode)
   * @param {number} [options.interruptMode] - REST only: 1=high/2=medium/3=low priority
   */
  sendTTS(text: string, options: Record<string, unknown> = {}): unknown {
    if (options.useREST) {
      const restOpts: Record<string, unknown> = { Message: text };
      if (options.interruptMode != null) restOpts.InterruptMode = options.interruptMode;
      return this.updateVoiceChat('ExternalTextToSpeech', restOpts);
    }
    this._sendCommand(COMMAND.EXTERNAL_TEXT_TO_SPEECH, text);
    return undefined;
  }

  /**
   * Send an interrupt command to stop the agent mid-speech.
   */
  interrupt() {
    if (!this.rtcEngine || !this.isActive) return;
    this._sendBinaryMessageSafe(
      this.agentUserId,
      string2tlv(
        JSON.stringify({
          Command: COMMAND.INTERRUPT,
          InterruptMode: INTERRUPT_PRIORITY.NONE,
          Message: '',
        }),
        'ctrl',
      ),
      'interrupt',
    );
  }

  /**
   * Send a base64-encoded image with text to the agent's LLM.
   * Automatically splits into 1 KB TLV chunks per VolcEngine protocol.
   * @param {string} imageBase64 - Base64 image data (no data URI prefix)
   * @param {string} text - Accompanying text message
   */
  async sendImageWithText(imageBase64: string, text: string, options: Record<string, unknown> = {}): Promise<void> {
    if (!this.rtcEngine || !this.isActive) return;
    const maxBytes = (options.maxBytes as number) || DEFAULT_MAX_BYTES;
    if (base64ByteSize(imageBase64) > maxBytes) {
      imageBase64 = await compressBase64Image(imageBase64, { maxBytes }) as string;
    }
    const groupId = this._imageGroupId++;
    this._sendImageChunked(imageBase64, text, groupId);
    this._addHistory('user', text);
  }

  /**
   * Mute the local microphone.
   * Idempotent: no-op if already muted; swallows RTC SDK promise rejections
   * (e.g. "Has already stop capture") so callers don't see UnhandledPromiseRejection.
   */
  mute() {
    if (!this.rtcEngine) return;
    if (this.isMuted) return;
    this.isMuted = true;
    try {
      const ret = this.rtcEngine.stopAudioCapture();
      if (ret && typeof ret.catch === 'function') ret.catch(() => {});
    } catch (_) { /* ignore */ }
  }

  /**
   * Unmute the local microphone.
   * Idempotent: no-op if already unmuted; swallows RTC SDK promise rejections
   * (e.g. "Has already capture") so callers don't see UnhandledPromiseRejection.
   */
  unmute() {
    if (!this.rtcEngine) return;
    if (this.isMuted === false) return;
    this.isMuted = false;
    try {
      const ret = this.rtcEngine.startAudioCapture();
      if (ret && typeof ret.catch === 'function') ret.catch(() => {});
    } catch (_) { /* ignore */ }
  }

  /**
   * Start sharing the screen. The agent can see the shared screen.
   */
  async startScreenShare() {
    if (!this.rtcEngine || !this.isActive) return;
    if (this.isScreenSharing || this.isCameraSharing) await this.stopVideoShare();
    await this.rtcEngine.startScreenCapture();
    await this.rtcEngine.publishScreen(VERTC.MediaType.VIDEO);
    this.isScreenSharing = true;
  }

  /**
   * Start sharing the camera. The agent can see the camera feed.
   */
  async startCameraShare() {
    if (!this.rtcEngine || !this.isActive) return;
    if (this.isScreenSharing || this.isCameraSharing) await this.stopVideoShare();
    await this.rtcEngine.startVideoCapture();
    await this.rtcEngine.publishStream(VERTC.MediaType.VIDEO);
    this.isCameraSharing = true;
  }

  /**
   * Stop any active video sharing (screen or camera).
   */
  async stopVideoShare() {
    if (!this.rtcEngine) return;
    if (this.isScreenSharing) {
      this.rtcEngine.stopScreenCapture();
      this.isScreenSharing = false;
    }
    if (this.isCameraSharing) {
      this.rtcEngine.stopVideoCapture();
      this.isCameraSharing = false;
    }
  }

  /**
   * Try to resume audio playback after an autoplay failure.
   * Call this in response to a user interaction (click/tap).
   */
  resumeAudio() {
    if (!this.rtcEngine) return;
    for (const uid of this._autoPlayFailUsers) {
      try {
        this.rtcEngine.play(uid);
      } catch (_) {
        /* ignore */
      }
    }
    this._autoPlayFailUsers = [];
  }

  /**
   * Get accumulated subtitle history.
   * @returns {Array<{ role: string, text: string, roundId: string }>}
   */
  getHistory() {
    return [...this._history];
  }

  /** Clear subtitle history. */
  clear() {
    this._history = [];
    this._subtitleBuffer = {};
  }

  /**
   * Restart the RTC agent session with an optional prompt file.
   *
   * Behavior:
   * - No promptFile: restores settings to initial defaults.
   * - Pure markdown (only system_prompt): changes only system prompt.
   * - Full config: temporarily overrides; next empty restart reverts to defaults.
   *
   * @param {string} [promptFile] - URL or path to agent config file.
   * @param {string[]} [tools] - Optional tool category override. Empty means inherit defaults.
   * @returns {Promise<Object>} { configSource }
   */
  async restartAgent(promptFile?: string, tools?: unknown): Promise<{ configSource: unknown }> {
    console.log(`[RTCChatSession] restartAgent promptFile=${promptFile || '(none)'}`);
    const normalizedTools = Array.isArray(tools) ? tools.filter((t) => typeof t === 'string' && t.trim()) : [];

    if (typeof this._cleanupChildSessions === 'function') {
      this._cleanupChildSessions();
    }

    // Save defaults on first call
    if (!this._defaultVoiceChatConfig) {
      this._defaultVoiceChatConfig = JSON.parse(JSON.stringify(this.voiceChatConfig || {}));
    }

    // Always restore defaults first
    this.voiceChatConfig = JSON.parse(JSON.stringify(this._defaultVoiceChatConfig));
    this.clear();

    let loadedConfig = null;
    if (promptFile && typeof promptFile === 'string' && promptFile.trim()) {
      try {
        const AgentConfig = (await import('../core/AgentConfig')).default;
        loadedConfig = await AgentConfig.fetch(promptFile.trim()) as Record<string, unknown>;
      } catch (e) {
        console.warn(`[RTCChatSession] restartAgent failed to load '${promptFile}': ${(e as Error)?.message}`);
      }
    }

    // Apply temporary overrides from loaded config
    if (loadedConfig) {
      const lc = loadedConfig as Record<string, unknown>;
      const vcc = this.voiceChatConfig as { LLMConfig?: RTCAny; config?: { LLMConfig?: RTCAny } };
      if (lc.system_prompt || lc.systemPrompt) {
        const prompt = lc.system_prompt || lc.systemPrompt;
        const llmConfig = vcc?.LLMConfig || vcc?.config?.LLMConfig;
        if (llmConfig) {
          llmConfig.SystemMessages = [prompt];
        }
      }
      if (lc.model) {
        const llmConfig = vcc?.LLMConfig || vcc?.config?.LLMConfig;
        if (llmConfig) llmConfig.Model = lc.model;
      }
    }

    if (normalizedTools.length > 0) {
      this.enabledToolCategories = normalizedTools;
      this._ensureSandbox().setEnabledCategories(normalizedTools);
    }

    if (this.isActive && typeof this.updateParameters === 'function') {
      await this.updateParameters(this.voiceChatConfig);
    }

    const configSource = loadedConfig ? promptFile : 'default';
    return { configSource };
  }

  // ─── Local model resolution ────────────────────────────────────────

  _resolveLocalModelSettings(model: string): RTCAny {
    const s = this.sdk?.localAPIKeySettings;
    return s ? s.resolveModelSettings(model) : { model: model || '', apiKey: '' };
  }

  // ─── Internal: Build voiceChat/start Body ──────────────────────────

  async _buildVoiceChatBody(copilotToolDefs: unknown): Promise<RTCAny> {
    const config = await this._buildVoiceChatConfigForAPI(copilotToolDefs);

    // Ensure TargetUserId includes this session's userId
    const agentCfg = {
      UserId: this.agentUserId,
      EnableConversationStateCallback: true,
      ...(this.agentConfig as Record<string, unknown>),
      TargetUserId: [this.userId],
    };

    return {
      appId: this.appId,
      roomId: this.roomId,
      taskId: this.taskId,
      config,
      AgentConfig: agentCfg,
      user: { Id: this.userId },
    };
  }

  async _buildVoiceChatConfigForAPI(copilotToolDefs: unknown, sourceConfig: unknown = this.voiceChatConfig, options: Record<string, unknown> = {}): Promise<RTCAny> {
    const config = deepClone(sourceConfig) as RTCAny;

    // Resolve local model settings (apiKey + model override)
    const currentModel = config?.LLMConfig?.Model || this.model;
    const localModelSettings = this._resolveLocalModelSettings(currentModel);
    if (config.LLMConfig) {
      if (localModelSettings.model && localModelSettings.model !== currentModel) {
        config.LLMConfig.Model = localModelSettings.model;
      }
      if (localModelSettings.apiKey) {
        config.LLMConfig.apiKey = localModelSettings.apiKey;
      }
    }

    // Expand ${...} template expressions in SystemMessages
    await this._expandSystemMessages(config);

    // Merge caller tools + sandbox tools into LLMConfig.Tools
    if (config.LLMConfig) {
      const nextTools = [...(this.customTools as unknown[]), ...((copilotToolDefs as unknown[]) || [])];
      const allTools = options.replaceTools
        ? mergeToolDefinitions([], nextTools)
        : mergeToolDefinitions(config.LLMConfig.Tools, nextTools);
      config.LLMConfig.Tools = allTools;
    }

    return config;
  }

  _buildVoiceChatUpdateConfig(config: RTCAny = {}): RTCAny {
    const updateConfig: RTCAny = {};
    const llmConfig = config.LLMConfig;

    if (llmConfig && typeof llmConfig === 'object') {
      const nextLLMConfig: RTCAny = {};
      for (const key of ['SystemMessages', 'UserPrompts', 'UserMessages', 'HistoryLength', 'Tools', 'VisionConfig']) {
        if (Object.prototype.hasOwnProperty.call(llmConfig, key)) {
          nextLLMConfig[key] = deepClone(llmConfig[key]);
        }
      }
      if (Object.keys(nextLLMConfig).length > 0) {
        updateConfig.LLMConfig = nextLLMConfig;
      }
    }

    if (config.TTSConfig && typeof config.TTSConfig === 'object') {
      updateConfig.TTSConfig = deepClone(config.TTSConfig);
    }

    if (Object.prototype.hasOwnProperty.call(config, 'InterruptMode')) {
      updateConfig.InterruptMode = config.InterruptMode;
    }

    return updateConfig;
  }

  /**
   * Expand all ${...} template expressions in SystemMessages using the sandbox.
   */
  async _expandSystemMessages(config: RTCAny): Promise<void> {
    for (const cfgKey of ['LLMConfig', 'S2SConfig']) {
      const cfg = config?.[cfgKey];
      if (!cfg || !Array.isArray(cfg.SystemMessages)) continue;
      cfg.SystemMessages = await Promise.all(
        cfg.SystemMessages.map(async (msg: unknown) => {
          // VolcEngine API expects SystemMessages as plain strings.
          // Normalize { Role, Content } objects to their Content string first.
          const text = typeof msg === 'string' ? msg
            : (msg && typeof msg === 'object' && typeof (msg as { Content?: unknown }).Content === 'string') ? (msg as { Content: string }).Content
            : null;
          if (!text) return msg;
          return this.sandbox.processTemplate(text);
        }),
      );
    }
  }

  // ─── Internal: RTC Event Wiring ────────────────────────────────────

  _setupRTCEvents() {
    const engine = this.rtcEngine;
    if (!engine) return;

    engine.on(VERTC.events.onUserJoined, (event: RTCAny) => {
      this.emit('userJoined', { userId: event.userInfo?.userId });
    });

    engine.on(VERTC.events.onUserLeave, (event: RTCAny) => {
      this.emit('userLeft', { userId: event.userInfo?.userId });
    });

    engine.on(VERTC.events.onUserPublishStream, async (event: RTCAny) => {
      try {
        await engine.subscribeStream(event.userId, VERTC.MediaType.AUDIO);
      } catch (_) {
        /* best effort */
      }
    });

    engine.on(VERTC.events.onAutoplayFailed, (event: RTCAny) => {
      if (!this._autoPlayFailUsers.includes(event.userId)) {
        this._autoPlayFailUsers.push(event.userId);
      }
      this.emit('autoplayFailed', { userId: event.userId, kind: event.kind });

      // Auto-register a click/tap handler to resume audio (browser autoplay policy)
      if (!this._autoPlayResumeRegistered) {
        this._autoPlayResumeRegistered = true;
        const resumeHandler = () => {
          this.resumeAudio();
          this._autoPlayResumeRegistered = false;
          document.removeEventListener('click', resumeHandler);
          document.removeEventListener('touchend', resumeHandler);
        };
        document.addEventListener('click', resumeHandler, { once: true });
        document.addEventListener('touchend', resumeHandler, { once: true });
      }
    });

    engine.on(VERTC.events.onLocalAudioPropertiesReport, (reports: RTCAny) => {
      if (!this.isActive) return;
      const speaking = reports?.some(
        (r: RTCAny) => r.audioPropertiesInfo?.linearVolume > 0.01,
      );
      this.emit('audioLevel', { speaking: speaking && !this.isMuted });
    });

    engine.on(VERTC.events.onRemoteAudioPropertiesReport, (reports: RTCAny) => {
      if (!this.isActive) return;
      let agentVolume = 0;
      for (const r of (reports || []) as RTCAny[]) {
        if (r.streamKey?.userId === this.agentUserId) {
          const vol = r.audioPropertiesInfo?.linearVolume || 0;
          if (vol > agentVolume) agentVolume = vol;
        }
      }
      const normalized = agentVolume > 0.01 ? Math.min(1, agentVolume / 30) : 0;
      this.emit('remoteAudioLevel', { speaking: normalized > 0, linearVolume: normalized });
    });

    engine.on(VERTC.events.onRoomBinaryMessageReceived, (event: RTCAny) => {
      this._handleBinaryMessage(event);
    });

    engine.on(VERTC.events.onError, (error: RTCAny) => {
      this.emit('error', {
        error: error.message || error.errorCode || 'RTC error',
      });
    });

    engine.on(VERTC.events.onConnectionStateChanged, (state: RTCAny) => {
      this._handleConnectionStateChanged(state);
    });
  }

  // ─── Internal: Connection State ────────────────────────────────────

  _handleConnectionStateChanged({ state }: { state?: unknown }): void {
    // 1=DISCONNECTED, 2=CONNECTING, 3=CONNECTED, 4=RECONNECTING, 5=RECONNECTED
    switch (state) {
      case 1:
        this.isConnected = false;
        this.emit('disconnected', {});
        break;
      case 2:
        this.isConnected = false;
        break;
      case 3:
        this.isConnected = true;
        this.emit('connected', { roomId: this.roomId, userId: this.userId });
        this._flushPendingMessages();
        break;
      case 4:
        this.isConnected = false;
        this.emit('reconnecting', {});
        break;
      case 5:
        this.isConnected = true;
        this.emit('reconnected', {});
        this._flushPendingMessages();
        break;
    }
  }

  // ─── Internal: Binary Message Dispatch ─────────────────────────────

  async _handleBinaryMessage(event: RTCAny): Promise<void> {
    try {
      const { type, value } = tlv2String(event.message);
      const parsed = JSON.parse(value);
      switch (type) {
        case MESSAGE_TYPE.CHAT:
          this._handleChatMessage(parsed);
          break;
        case MESSAGE_TYPE.SUBTITLE:
          this._handleSubtitleData(parsed);
          break;
        case MESSAGE_TYPE.BRIEF:
          this._handleAgentBrief(parsed);
          break;
        case MESSAGE_TYPE.FUNCTION_CALL_INFO:
          this._handleFunctionCallInfo(parsed);
          break;
        case MESSAGE_TYPE.FUNCTION_CALL:
          await this._handleFunctionCall(parsed);
          break;
        default:
          // Fallback: try legacy JSON subtitle format
          this._handleLegacySubtitle(event);
      }
    } catch (_) {
      this._handleLegacySubtitle(event);
    }
  }

  _handleChatMessage(parsed: RTCAny): void {
    const { userId, username, text, timestamp, _g: groupId, _f: fragmentId, _p: isPartial } = parsed;
    // Ignore own messages (already added to history on send)
    if (userId === this.userId) return;

    // Non-chunked message (no groupId) — deliver immediately
    if (!groupId) {
      this._addHistory('peer', text);
      this.emit('message', { userId, username, text, timestamp });
      return;
    }

    // Chunked message — reassemble
    if (!this._chatReassemblyBuffer[groupId]) {
      this._chatReassemblyBuffer[groupId] = { chunks: [], userId, username, timestamp };
    }
    const buf = this._chatReassemblyBuffer[groupId];
    buf.chunks[fragmentId - 1] = text;

    if (!isPartial) {
      // Last fragment received — concatenate and emit
      const fullText = buf.chunks.join('');
      delete this._chatReassemblyBuffer[groupId];
      this._addHistory('peer', fullText);
      this.emit('message', { userId: buf.userId, username: buf.username, text: fullText, timestamp: buf.timestamp });
    }
  }

  // ─── Internal: Subtitle Handling ───────────────────────────────────

  _handleSubtitleData(parsed: RTCAny): void {
    const dataArr = parsed.data || [parsed];
    for (const data of dataArr) {
      const isUser = data.userId && data.userId === this.userId;
      const roundId = data.roundId ?? 'default';
      const key = `${roundId}_${isUser ? 'user' : 'ai'}`;
      const role = isUser ? 'user' : 'assistant';

      if (data.text == null) continue;

      if (!this._subtitleBuffer[key]) {
        this._subtitleBuffer[key] = { text: '', isUser };
      }
      const buf = this._subtitleBuffer[key];

      if (data.definite) {
        buf.text += data.text;
        this.emit('subtitle', {
          text: buf.text,
          isUser,
          roundId,
          definite: true,
          paragraph: !!data.paragraph,
        });

        if (data.paragraph) {
          this._addHistory(role, buf.text, roundId);
          delete this._subtitleBuffer[key];
        }
      } else if (data.text.trim()) {
        this.emit('subtitle', {
          text: buf.text + data.text,
          isUser,
          roundId,
          definite: false,
          paragraph: false,
        });
      }
    }
  }

  _handleLegacySubtitle(event: RTCAny): void {
    try {
      const jsonStr = new TextDecoder('utf-8').decode(event.message);
      const data = JSON.parse(jsonStr);
      this._handleSubtitleData(data);
    } catch (_) {
      /* not a valid message */
    }
  }

  // ─── Internal: Agent State ─────────────────────────────────────────

  _handleAgentBrief(parsed: RTCAny): void {
    const { Stage } = parsed || {};
    const code = Stage?.Code;
    const prevState = this.agentState;
    this.agentState = code;
    this._stateEventReceived = true;

    // agent 离开 THINKING 状态后重置安慰消息标记，允许下一轮再发
    if (prevState === AGENT_STATE.THINKING && code !== AGENT_STATE.THINKING) {
      this._comfortSentTypes.clear();
    }

    this.emit('state', {
      code,
      label: AGENT_STATE_LABELS[code] || '—',
      description: Stage?.Description,
    });
  }

  // ─── Internal: Function Call Handling ──────────────────────────────

  _handleFunctionCallInfo(parsed: RTCAny): void {
    const funcName = parsed?.function || 'unknown';
    const toolCallId = parsed?.tool_call_id || '';
    //console.log('[AIChatRTC] functionCallInfo:', funcName, toolCallId, parsed);
    this.emit('functionCallInfo', { name: funcName, toolCallId });

    // 单次对话中，两种安慰语各允许出现一次，避免叠加播放
    if (this.rtcEngine) {
      const comfortMsg = funcName.includes('replace_string')
        ? '(记录中...)'
        : '(查询中...)';
      if (!this._comfortSentTypes.has(comfortMsg)) {
        this._comfortSentTypes.add(comfortMsg);
        this._sendBinaryMessageSafe(
          this.agentUserId,
          string2tlv(
            JSON.stringify({
              Command: COMMAND.EXTERNAL_TEXT_TO_SPEECH,
              Message: comfortMsg,
              InterruptMode: INTERRUPT_PRIORITY.LOW,
            }),
            'ctrl',
          ),
          `comfort: ${funcName}`,
        );
      }
    }
  }

  async _handleFunctionCall(parsed: RTCAny): Promise<void> {
    const toolCalls = parsed?.tool_calls || [];
    if (!toolCalls.length) return;

    //console.log('[AIChatRTC] functionCall:', JSON.stringify(toolCalls, null, 2));
    this.emit('functionCall', { toolCalls });

    for (const toolCall of toolCalls) {
      const funcName = toolCall.function?.name;

      // Skip tool calls with empty/missing function name (RTC protocol anomaly)
      if (!funcName) {
        console.warn('[AIChatRTC] Skipping tool call with empty function name', toolCall?.id);
        if (this.rtcEngine && toolCall.id) {
          await this._sendFuncResultChunked(toolCall.id, 'OK', 'unknown');
        }
        continue;
      }

      const rawArgs = toolCall.function?.arguments || '{}';
      let funcArgs;
      try {
        funcArgs = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs;
      } catch (_) {
        funcArgs = {};
      }

      let result;
      try {
        result = await this.sandbox.execute(funcName, funcArgs, { _session: this });
      } catch (eRaw) {
        const e = eRaw as RTCAny;
        // Handle RestartAgentSignal: delegate to the owning DigitalHuman
        if (e && e.isRestartAgentSignal) {
          const dh = this._digitalHuman as RTCAny;
          if (dh && typeof dh.restartAgent === 'function') {
            console.log(`[AIChatRTC] RestartAgentSignal caught in _handleFunctionCall, restarting with '${e.promptFile}'`);
            // Send a brief result back before restarting so the RTC server doesn't hang
            if (this.rtcEngine && toolCall.id) {
              await this._sendFuncResultChunked(toolCall.id, 'Agent restarting...', funcName);
            }
            // Defer restart out of the RTC event handler — destroying the engine
            // while inside its own binary-message callback causes server-side errors
            const promptFile = e.promptFile;
            const tools = Array.isArray(e.tools) ? e.tools : undefined;
            setTimeout(async () => {
              try {
                await dh.restartAgent(promptFile, tools);
              } catch (err) {
                console.error('[AIChatRTC] deferred restartAgent failed:', (err as Error)?.message);
                dh.emit('error', { error: err, stage: 'restartAgent' });
              }
            }, 0);
            return; // Abort remaining tool calls — restart is scheduled
          }
        }
        result = `Error: ${e.message}`;
      }

      this.emit('functionCallResult', {
        toolCallId: toolCall.id,
        name: funcName,
        args: funcArgs,
        result,
      });

      // Send function result back to agent via 'func' TLV type (chunked if >1KB)
      if (this.rtcEngine) {
        const content =
          typeof result === 'string' ? result : JSON.stringify(result);
        await this._sendFuncResultChunked(toolCall.id, content, funcName);
      }
    }
  }

  // ─── Internal: Command Helpers ─────────────────────────────────────

  _sendCommand(command: string, message: string): void {
    if (!this.rtcEngine || !this.isActive) return;
    this._sendCommandChunked(command, message);
  }

  // ─── Internal: Connection-Resilient Send ───────────────────────────

  _sendBinaryMessageSafe(targetUserId: string, binaryData: unknown, label: string): boolean {
    if (!this.rtcEngine || !this.isActive) return false;
    if (!this.isConnected) {
      this._pendingMessages.push({ targetUserId, binaryData, label });
      return false;
    }
    try {
      const result = this.rtcEngine.sendUserBinaryMessage(targetUserId, binaryData);
      if (result?.catch) {
        result.catch(() => {
          this._pendingMessages.push({ targetUserId, binaryData, label });
        });
      }
      return true;
    } catch (_) {
      this._pendingMessages.push({ targetUserId, binaryData, label });
      return false;
    }
  }

  _flushPendingMessages() {
    if (!this._pendingMessages.length || !this.rtcEngine) return;
    const msgs = this._pendingMessages.splice(0);
    for (const { targetUserId, binaryData, isRoomMessage } of msgs) {
      try {
        const result = isRoomMessage
          ? this.rtcEngine.sendRoomBinaryMessage(binaryData)
          : this.rtcEngine.sendUserBinaryMessage(targetUserId, binaryData);
        if (result?.catch) result.catch(() => { /* best effort */ });
      } catch (_) {
        /* best effort */
      }
    }
  }

  // ─── Internal: Text/Func Chunking ──────────────────────────────────

  /**
   * Split a string into chunks whose JSON-encoded byte length fits within maxBytes.
   * Accounts for JSON string escaping (e.g. quotes, backslashes, control chars).
   */
  _splitTextForTLV(text: string, maxBytes: number): string[] {
    const encoder = new TextEncoder();
    const chunks = [];
    let pos = 0;
    while (pos < text.length) {
      let end = Math.min(pos + maxBytes, text.length);
      let chunk = text.slice(pos, end);
      // Measure actual bytes after JSON escaping (subtract 2 for surrounding quotes)
      let encoded = encoder.encode(JSON.stringify(chunk)).length - 2;
      while (encoded > maxBytes && end > pos + 1) {
        end = pos + Math.max(1, Math.floor((end - pos) * maxBytes / encoded));
        chunk = text.slice(pos, end);
        encoded = encoder.encode(JSON.stringify(chunk)).length - 2;
      }
      chunks.push(chunk);
      pos = end;
    }
    if (chunks.length === 0) chunks.push('');
    return chunks;
  }

  /**
   * Send a function-call result back to the agent, chunking if it exceeds 1 KB.
   * Uses IsPartial + FragmentID on the 'func' TLV type (mirrors image chunking).
   */
  async _sendFuncResultChunked(toolCallId: string, content: string, funcName: string): Promise<void> {
    const MAX_PAYLOAD = 1024 - 8; // TLV header = 8 bytes

    // Fast path: fits in a single message
    const singlePayload = JSON.stringify({ ToolCallID: toolCallId, Content: content });
    if (new TextEncoder().encode(singlePayload).length <= MAX_PAYLOAD) {
      this._sendBinaryMessageSafe(
        this.agentUserId,
        string2tlv(singlePayload, 'func'),
        `FC result: ${funcName}(${toolCallId})`,
      );
      return;
    }

    // Measure JSON wrapper overhead (Content is empty string → 2 quote bytes)
    const wrapperPayload = JSON.stringify({
      ToolCallID: toolCallId,
      Content: '',
      IsPartial: true,
      FragmentID: 99999,
    });
    const overhead = new TextEncoder().encode(wrapperPayload).length;
    const chunkByteCap = MAX_PAYLOAD - overhead - 16; // safety margin

    const chunks = this._splitTextForTLV(content, chunkByteCap);

    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      const payload = JSON.stringify({
        ToolCallID: toolCallId,
        Content: chunks[i],
        IsPartial: !isLast,
        FragmentID: i + 1,
      });
      this._sendBinaryMessageSafe(
        this.agentUserId,
        string2tlv(payload, 'func'),
        `FC result ${i + 1}/${chunks.length}: ${funcName}(${toolCallId})`,
      );
      if (!isLast) await new Promise((r) => setTimeout(r, 50));
    }
  }

  /**
   * Send a text command (e.g. ExternalTextToLLM) that may exceed 1 KB.
   * Splits into multiple sequential ctrl messages if necessary.
   */
  async _sendCommandChunked(command: string, message: string): Promise<void> {
    const MAX_PAYLOAD = 1024 - 8;

    // Fast path: fits in a single message
    const singlePayload = JSON.stringify({
      Command: command,
      InterruptMode: INTERRUPT_PRIORITY.HIGH,
      Message: message,
    });
    if (new TextEncoder().encode(singlePayload).length <= MAX_PAYLOAD) {
      this._sendBinaryMessageSafe(
        this.agentUserId,
        string2tlv(singlePayload, 'ctrl'),
        `${command}: ${message.substring(0, 50)}`,
      );
      return;
    }

    // Measure wrapper overhead
    const wrapperPayload = JSON.stringify({
      Command: command,
      InterruptMode: INTERRUPT_PRIORITY.HIGH,
      Message: '',
    });
    const overhead = new TextEncoder().encode(wrapperPayload).length;
    const chunkByteCap = MAX_PAYLOAD - overhead - 16;

    const chunks = this._splitTextForTLV(message, chunkByteCap);

    for (let i = 0; i < chunks.length; i++) {
      const payload = JSON.stringify({
        Command: command,
        InterruptMode: INTERRUPT_PRIORITY.HIGH,
        Message: chunks[i],
      });
      this._sendBinaryMessageSafe(
        this.agentUserId,
        string2tlv(payload, 'ctrl'),
        `${command} ${i + 1}/${chunks.length}: ${chunks[i].substring(0, 30)}`,
      );
      if (i < chunks.length - 1) await new Promise((r) => setTimeout(r, 50));
    }
  }

  // ─── Internal: Image Chunking ──────────────────────────────────────

  /**
   * Send a base64 image in chunks via sendUserBinaryMessage.
   * Per VolcEngine docs: default per-message limit is 1 KB.
   * IsPartial=true / FragmentID for intermediate chunks.
   * Message text only in the last chunk (IsPartial=false).
   */
  async _sendImageChunked(imageBase64: string, message: string, groupId: number): Promise<void> {
    const MAX_TLV_SIZE = 1024;
    const TLV_HEADER = 8;
    const MAX_JSON_BYTES = MAX_TLV_SIZE - TLV_HEADER;

    const samplePayload = JSON.stringify({
      Command: COMMAND.EXTERNAL_TEXT_TO_LLM,
      Message: '',
      InterruptMode: INTERRUPT_PRIORITY.HIGH,
      ImageConfig: {
        Action: 'insert',
        GroupID: groupId,
        ImageType: 'base64',
        Images: [''],
        Total: 99999,
        ImageID: 1,
        IsPartial: true,
        FragmentID: 99999,
      },
    });
    const overhead = new TextEncoder().encode(samplePayload).length;
    const messageBytes = new TextEncoder().encode(message).length;
    const chunkCap = MAX_JSON_BYTES - overhead - 16;
    const lastChunkCap = MAX_JSON_BYTES - overhead - messageBytes - 16;

    if (chunkCap <= 0) return;

    const chunks = [];
    let offset = 0;
    while (offset < imageBase64.length) {
      const remaining = imageBase64.length - offset;
      if (
        remaining <= lastChunkCap ||
        (remaining <= chunkCap && lastChunkCap <= 0)
      ) {
        chunks.push(imageBase64.substring(offset));
        break;
      }
      const size = Math.min(chunkCap, remaining);
      chunks.push(imageBase64.substring(offset, offset + size));
      offset += size;
    }
    if (chunks.length === 0) chunks.push('');
    const totalChunks = chunks.length;

    for (let i = 0; i < totalChunks; i++) {
      const isLast = i === totalChunks - 1;
      const payload = JSON.stringify({
        Command: COMMAND.EXTERNAL_TEXT_TO_LLM,
        Message: isLast ? message : '',
        InterruptMode: INTERRUPT_PRIORITY.HIGH,
        ImageConfig: {
          Action: 'insert',
          GroupID: groupId,
          ImageType: 'base64',
          Images: [chunks[i]],
          Total: totalChunks,
          ImageID: 1,
          IsPartial: !isLast,
          FragmentID: i + 1,
        },
      });
      this._sendBinaryMessageSafe(
        this.agentUserId,
        string2tlv(payload, 'ctrl'),
        `image chunk ${i + 1}/${totalChunks}`,
      );
      if (!isLast) await new Promise((r) => setTimeout(r, 100));
    }
  }

  // ─── Internal: History ─────────────────────────────────────────────

  _addHistory(role: string, text: string, roundId?: unknown): void {
    if (text) {
      this._history.push({ role, text, roundId: roundId || null, _ts: Date.now() });
    }
  }
}

/**
 * 安装 RTCChatSession 的 ChildSessionMixin 相关 prototype 注册：
 * 1. 将 childSessionMethods 混入 RTCChatSession.prototype
 * 2. 覆盖 RTCChatSession.prototype._triggerImmediateCallback
 *
 * 注意：必须用「导出函数 + 在聚合入口（AIChatRTC.ts）实际调用」的方式注册，
 * 而非模块顶层裸语句。后者是对被聚合引用类的无返回值顶层副作用语句，
 * Rollup tree-shaking 会因其无外部可观测副作用而删除，导致 RTC 子 agent 方法
 * （_triggerImmediateCallback / queueChildResult 等）在打包产物中缺失。
 * 集中到本函数并由 AIChatRTC.ts 引用调用，可被 Rollup 当作有副作用的调用保留。
 */
export function installRTCChatSessionMixin(): void {
  // Apply child session mixin methods to RTCChatSession prototype
  Object.assign(RTCChatSession.prototype, childSessionMethods);

  // Override _triggerImmediateCallback for RTCChatSession:
  // Wait for any ongoing send() to finish, then call send(null) so the standard
  // child-result injection path can forward the pending results.
  (RTCChatSession.prototype as RTCAny)._triggerImmediateCallback = async function (this: RTCAny) {
    if (this._isSending) {
      await new Promise<void>((resolve) => {
        const check = () => {
          if (!this._isSending) resolve();
          else setTimeout(check, 50);
        };
        setTimeout(check, 50);
      });
    }
    if (this._pendingChildResults.length === 0) return;
    try {
      await this.send(null, this._lastSendOptions);
    } catch (e) {
      console.error('[RTCChatSession] Immediate callback send failed:', e);
    }
  };
}

// 模块求值时立即执行（副作用注册）。聚合入口 AIChatRTC.ts 仍会显式调用一次以确保保留。
installRTCChatSessionMixin();

export default RTCChatSession;
export { RTCChatSession };