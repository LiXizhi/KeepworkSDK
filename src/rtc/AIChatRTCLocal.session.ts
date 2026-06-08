/**
 * AIChatRTCLocal.session.ts — LocalRTCSession
 *
 * 管理单次本地语音会话生命周期：VAD → ASR → LLM → TTS。
 * 依赖 ChildSessionMixin、SandboxToolEnv、backend 类。
 */

import { AGENT_STATE, AGENT_STATE_LABELS } from './AIChatRTC';
import SandboxToolEnv from '../ai-chat/SandboxToolEnv';
import { initChildSessionState, childSessionMethods } from '../ai-chat/ChildSessionMixin';
import SDKLogger from '../utils/SDKLogger';
import {
  BaseASRBackend, WebSpeechASRBackend, WhisperASRBackend, LocalNeuralASRBackend,
  BaseTTSBackend, BrowserSpeechTTSBackend, LocalNeuralTTSBackend,
  DEFAULT_VAD_CDN, DEFAULT_LOCAL_NEURAL_ASR, DEFAULT_WHISPER_ASR,
  DEFAULT_LOCAL_NEURAL_TTS, DEFAULT_LOCAL_NEURAL_TTS_PRESET, DEFAULT_LOCAL_NEURAL_TTS_ASSET_BASE,
  LOCAL_NEURAL_TTS_PRESETS, LOCAL_NEURAL_TTS_PRESET_ALIASES,
  DEFAULT_LOCAL_NEURAL_PRESET, DEFAULT_LOCAL_NEURAL_ASSET_BASE,
  LOCAL_NEURAL_ASR_PRESETS, LOCAL_NEURAL_ASR_PRESET_ALIASES,
  DEFAULT_WHISPER_PRESET, LOCAL_WHISPER_ASR_PRESETS, LOCAL_WHISPER_ASR_PRESET_ALIASES,
  normalizeASRProvider, normalizeTTSProvider, parseOptionalInteger, trimTrailingSlash,
  normalizeLocalNeuralTTSPreset, isMixedChineseEnglishLanguage, hasWhisperASRHints,
  getDefaultASRFallbackProviders,
  DEFAULT_AUDIO_CONSTRAINTS, ENERGY_VAD, ASR_PROVIDER, TTS_PROVIDER, SENTENCE_END_RE,
  DEFAULT_ASR_OPTIONS, DEFAULT_TTS_OPTIONS,
} from './AIChatRTCLocal.backends';
const console = SDKLogger.createModuleConsole('AIChatRTCLocal');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SessAny = Record<string, any>;
declare const vad: SessAny;

class LocalRTCSession {
  parent!: SessAny;
  sdk: SessAny;
  _cleanupChildSessions!: () => void;
  _cancelDebounceTimers!: () => void;
  _consumePendingChildResults!: () => unknown[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;

  /**
   * @param {AIChatRTCLocal} parent - Parent AIChatRTCLocal instance
   * @param {Object} config - Session configuration
   */
  constructor(parent: SessAny, config: SessAny = {}) {
    this.parent = parent;
    this.sdk = parent.sdk;

    // Voice chat config (mirrors RTCChatSession shape)
    this.agentConfig = config.agentConfig || {};
    this.voiceChatConfig = config.config || {};

    // Sandbox / tools (mirrors RTCChatSession)
    this.workspace = config.workspace || '';
    this.enabledToolCategories = config.enabledToolCategories || ['fileOps', 'agent'];
    this.customTools = Array.isArray(config.tools) ? config.tools : [];
    this.toolProxy = config.toolProxy || null;
    this.sandbox = null; // created on start()

    // Session state
    this.isActive = false;
    this.isMuted = false;
    this.agentState = AGENT_STATE.UNKNOWN;

    // Subtitle streaming
    this._roundId = 0;
    this._history = [];
    this._messages = []; // full LLM message history (system + user + assistant + tool)

    // Event emitter
    this._listeners = {};

    // VAD state
    this._micVAD = null;       // Silero MicVAD instance
    this._audioCtx = null;     // AudioContext for energy fallback
    this._analyser = null;     // AnalyserNode for energy fallback
    this._mediaStream = null;  // getUserMedia stream
    this._energyTimer = null;  // interval for energy sampling
    this._speechStart = 0;     // timestamp of speech start
    this._silenceStart = 0;    // timestamp when silence began
    this._isSpeaking = false;  // current VAD speech state

    // STT state
    this._asrBackend = null;
    this.asrBackendName = '';
    this.asrFallbackReason = '';
    this._interimText = '';
    this._finalText = '';

    // TTS backend state
    this._ttsBackend = null;
    this.ttsBackendName = '';
    this.ttsFallbackReason = '';

    // LLM state
    this._abortController = null;
    this._isLLMStreaming = false;

    // TTS state
    this._ttsQueue = [];
    this._isTTSSpeaking = false;
    this._ttsLevelTimer = null;
    this._pendingSentence = ''; // buffer for incomplete sentence from LLM stream
    this._ttsToken = 0;
    this._ttsDrainPromise = null;
    this._interruptResetTimer = null;

    // Child agent session support (via ChildSessionMixin)
    initChildSessionState(this as unknown as Parameters<typeof initChildSessionState>[0], config);
  }

  // ─── Event Emitter ─────────────────────────────────────────────────

  on(event: string, callback: (data?: unknown) => void) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(callback);
    return this;
  }

  off(event: string, callback: (data?: unknown) => void) {
    const list = this._listeners[event];
    if (list) this._listeners[event] = list.filter((fn: unknown) => fn !== callback);
    return this;
  }

  emit(event: string, data?: unknown) {
    const list = this._listeners[event];
    if (!list) return;
    for (const fn of list) {
      try { fn(data); } catch (eRaw) { const e = eRaw as SessAny;
        console.warn(`[LocalRTCSession] Event '${event}' listener error:`, e);
      }
    }
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────

  /**
   * Start the session: load VAD SDK → request mic → init VAD + STT.
   * @returns {Promise<void>}
   */
  async start() {
    if (this.isActive) throw new Error('Session already active');

    // 1. Load VAD library (may fall back to energy-based)
    await this.parent.loadSDK();

    // 2. Create SandboxToolEnv for this session
    this.sandbox = new SandboxToolEnv(this.sdk, {
      workspace: this.workspace,
      enabledCategories: this.enabledToolCategories,
      toolProxy: this.toolProxy,
      session: this,
    });

    // 3. Expand ${...} template expressions in SystemMessages
    await this._expandSystemMessages();

    // 4. Init VAD (Silero or energy fallback)
    if (this.parent._vadAvailable) {
      await this._initSileroVAD();
    } else {
      await this._initEnergyVAD();
    }

    // 5. Init ASR backend (local neural preferred, Web Speech fallback by default)
    await this._initializeASRBackend();

    // 6. Init TTS backend (browser speech by default; local neural when configured)
    await this._initializeTTSBackend();

    this.isActive = true;
    this._setState(AGENT_STATE.LISTENING);
    this.emit('connected', {});

    // 7. Welcome message
    const welcomeMsg = this.agentConfig.WelcomeMessage;
    if (welcomeMsg) {
      this._addHistory('assistant', welcomeMsg);
      this.emit('welcome', { message: welcomeMsg });
      this._speak(welcomeMsg);
    }
  }

  /**
   * Stop the session and release all resources.
   * @returns {Promise<void>}
   */
  async stop() {
    this._cleanup();
    this._setState(AGENT_STATE.FINISHED);
  }

  /** Alias for stop() */
  async destroy() {
    await this.stop();
  }

  _cleanup() {
    this.isActive = false;

    if (this._interruptResetTimer) {
      clearTimeout(this._interruptResetTimer);
      this._interruptResetTimer = null;
    }

    // Abort LLM
    if (this._abortController) {
      this._abortController.abort();
      this._abortController = null;
    }

    // Stop TTS
    this._cancelTTS();

    // Stop STT
    if (this._asrBackend) {
      this._asrBackend.destroy().catch(() => {});
      this._asrBackend = null;
    }

    if (this._ttsBackend) {
      this._ttsBackend.destroy().catch(() => {});
      this._ttsBackend = null;
    }

    // Stop Silero VAD
    if (this._micVAD) {
      try { this._micVAD.destroy(); } catch (_) {}
      this._micVAD = null;
    }

    // Stop energy VAD
    if (this._energyTimer) {
      clearInterval(this._energyTimer);
      this._energyTimer = null;
    }
    if (this._audioCtx) {
      try { this._audioCtx.close(); } catch (_) {}
      this._audioCtx = null;
    }
    this._analyser = null;

    // Release microphone
    if (this._mediaStream) {
      this._mediaStream.getTracks().forEach((t: SessAny) => t.stop());
      this._mediaStream = null;
    }

    this.isMuted = false;
    this._isSpeaking = false;
    this._isLLMStreaming = false;
    this._messages = [];
    this._cleanupChildSessionsSafe();
  }

  _cleanupChildSessionsSafe(): void {
    const cleanup = this._cleanupChildSessions;
    if (typeof cleanup === 'function') {
      cleanup.call(this);
      return;
    }

    // 兜底：ChildSessionMixin 方法未注入时，仍清理子 agent 状态，避免 stop() 抛错。
    for (const timer of this._debounceTimers || []) {
      clearTimeout(timer);
    }
    this._debounceTimers = [];
    this._childSessions = {};
    this._pendingChildResults = [];
  }

  _mergeConfigSection(currentConfig: SessAny = {}, nextConfig: SessAny = {}): SessAny {
    return {
      ...currentConfig,
      ...nextConfig,
      LocalNeural: {
        ...(currentConfig.LocalNeural || {}),
        ...(nextConfig.LocalNeural || {}),
      },
      ProviderParams: {
        ...(currentConfig.ProviderParams || {}),
        ...(nextConfig.ProviderParams || {}),
      },
      Runtime: {
        ...(currentConfig.Runtime || {}),
        ...(nextConfig.Runtime || {}),
      },
    };
  }

  _buildTTSBackendSignature(ttsConfig: SessAny = {}) {
    const localNeural = ttsConfig.LocalNeural || {};
    return JSON.stringify({
      provider: normalizeTTSProvider(ttsConfig.Provider),
      fallbackProvider: normalizeTTSProvider(ttsConfig.FallbackProvider),
      preset: normalizeLocalNeuralTTSPreset(localNeural.Preset || ttsConfig.Preset || ttsConfig.preset),
      assetBaseUrl: trimTrailingSlash(localNeural.AssetBaseURL || localNeural.assetBaseUrl || ''),
      runtimeBaseUrl: trimTrailingSlash(localNeural.RuntimeBaseURL || localNeural.runtimeBaseUrl || ''),
      modelBaseUrl: trimTrailingSlash(localNeural.ModelBaseURL || localNeural.modelBaseUrl || ''),
      ttsScriptUrl: trimTrailingSlash(localNeural.TtsScriptUrl || localNeural.ttsScriptUrl || ''),
      mainUrl: trimTrailingSlash(localNeural.MainURL || localNeural.mainUrl || ''),
      wasmUrl: trimTrailingSlash(localNeural.WasmURL || localNeural.wasmUrl || ''),
      dataUrl: trimTrailingSlash(localNeural.DataURL || localNeural.dataUrl || ''),
    });
  }

  async _reloadTTSBackend() {
    this._cancelTTS();
    if (this._ttsBackend) {
      try {
        await this._ttsBackend.destroy();
      } catch (_) {}
      this._ttsBackend = null;
    }
    this.ttsBackendName = '';
    this.ttsFallbackReason = '';
    await this._initializeTTSBackend();
  }

  async updateTTSConfig(nextTTSConfig: SessAny = {}, options: SessAny = {}) {
    const currentTTSConfig = this.voiceChatConfig.TTSConfig || {};
    const mergedTTSConfig = this._mergeConfigSection(currentTTSConfig, nextTTSConfig);
    const shouldReloadBackend = options.forceReload === true
      || this._buildTTSBackendSignature(currentTTSConfig) !== this._buildTTSBackendSignature(mergedTTSConfig);

    this.voiceChatConfig.TTSConfig = mergedTTSConfig;

    if (!this.isActive || !shouldReloadBackend) {
      return { applied: true, reinitialized: false };
    }

    await this._reloadTTSBackend();
    return { applied: true, reinitialized: true };
  }

  // ─── Chat-like API ─────────────────────────────────────────────────

  /**
   * Send text to the LLM (bypass voice pipeline).
   * @param {string} text
   */
  sendText(text: string) {
    if (!this.isActive || !text) return;
    const roundId = String(++this._roundId);
    this._addHistory('user', text, roundId);
    this.emit('subtitle', { text, isUser: true, roundId, definite: true, paragraph: true });
    this._sendToLLM(text, roundId);
  }

  /**
   * Interrupt: cancel TTS + abort LLM.
   */
  interrupt() {
    this._cancelTTS();

    // Abort LLM
    if (this._abortController) {
      this._abortController.abort();
      this._abortController = null;
    }
    this._isLLMStreaming = false;

    this._setState(AGENT_STATE.INTERRUPTED);

    // Resume listening after brief pause
    if (this._interruptResetTimer) {
      clearTimeout(this._interruptResetTimer);
    }
    this._interruptResetTimer = setTimeout(() => {
      this._interruptResetTimer = null;
      if (this.isActive && !this.isMuted) {
        this._setState(AGENT_STATE.LISTENING);
      }
    }, 300);
  }

  /**
   * Mute: pause VAD (stop detecting speech).
   */
  mute() {
    this.isMuted = true;
    if (this._micVAD) {
      try { this._micVAD.pause(); } catch (_) {}
    }
    this.emit('audioLevel', { speaking: false });
  }

  /**
   * Unmute: resume VAD.
   */
  unmute() {
    this.isMuted = false;
    if (this._micVAD) {
      try { this._micVAD.start(); } catch (_) {}
    }
  }

  /**
   * Get accumulated conversation history.
   * @returns {Array<{ role: string, text: string, roundId: string|null }>}
   */
  getHistory() {
    return [...this._history];
  }

  /** Clear conversation history. */
  clear() {
    this._history = [];
  }

  // ─── Internal: VAD ─────────────────────────────────────────────────

  _getAudioConstraints() {
    const sessionAudioConstraints = this.voiceChatConfig?.AudioConstraints;
    const vadAudioConstraints = this.voiceChatConfig?.VADConfig?.AudioConstraints;
    return {
      ...DEFAULT_AUDIO_CONSTRAINTS,
      ...(sessionAudioConstraints || {}),
      ...(vadAudioConstraints || {}),
    };
  }

  async _getMicrophoneStream() {
    return navigator.mediaDevices.getUserMedia({
      audio: this._getAudioConstraints(),
    });
  }

  _releaseMediaStream(stream = this._mediaStream) {
    if (!stream) return;
    try {
      stream.getTracks().forEach((track: SessAny) => track.stop());
    } catch (_) {}
    if (this._mediaStream === stream) {
      this._mediaStream = null;
    }
  }

  async _initSileroVAD() {
    try {
      this._micVAD = await vad.MicVAD.new({
        positiveSpeechThreshold: 0.5,
        negativeSpeechThreshold: 0.35,
        minSpeechFrames: 3,
        preSpeechPadFrames: 1,
        redemptionFrames: 8,
        modelURL: this.parent._resolvedVadModelURL || this.parent.vadModelURL,
        workletURL: this.parent.vadWorkletURL,
        getStream: async () => {
          const stream = await this._getMicrophoneStream();
          this._mediaStream = stream;
          this._notifyMediaStreamChanged(stream);
          return stream;
        },
        pauseStream: async (stream: SessAny) => {
          this._releaseMediaStream(stream);
          this._notifyMediaStreamChanged(null);
        },
        resumeStream: async () => {
          const stream = await this._getMicrophoneStream();
          this._mediaStream = stream;
          this._notifyMediaStreamChanged(stream);
          return stream;
        },
        onSpeechStart: () => {
          if (this.isMuted || !this.isActive) return;
          this._onSpeechStart();
        },
        onSpeechEnd: (audio: SessAny) => {
          if (this.isMuted || !this.isActive) return;
          this._onSpeechEnd(audio);
        },
        onVADMisfire: () => {
          // false positive — ignore
        },
      });
      this._micVAD.start();
      console.log('[LocalRTCSession] Silero VAD started (single-thread)');
    } catch (eRaw) { const e = eRaw as SessAny;
      console.warn('[LocalRTCSession] Silero VAD init failed, falling back to energy VAD:', e.message);
      this.parent._vadAvailable = false;
      await this._initEnergyVAD();
    }
  }

  async _initEnergyVAD() {
    try {
      this._mediaStream = await this._getMicrophoneStream();
      this._notifyMediaStreamChanged(this._mediaStream);
    } catch (eRaw) { const e = eRaw as SessAny;
      const msg = `Microphone access denied: ${e.message}`;
      this.emit('error', { error: msg });
      throw new Error(msg);
    }

    this._audioCtx = new ((window as SessAny).AudioContext || (window as SessAny).webkitAudioContext)();
    const source = this._audioCtx.createMediaStreamSource(this._mediaStream);
    this._analyser = this._audioCtx.createAnalyser();
    this._analyser.fftSize = 512;
    source.connect(this._analyser);

    const dataArray = new Uint8Array(this._analyser.frequencyBinCount);
    this._isSpeaking = false;
    this._silenceStart = 0;
    this._speechStart = 0;

    this._energyTimer = setInterval(() => {
      if (this.isMuted || !this.isActive) {
        if (this._isSpeaking) {
          this._isSpeaking = false;
          this.emit('audioLevel', { speaking: false });
        }
        return;
      }

      this._analyser.getByteFrequencyData(dataArray);
      const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
      const isSpeaking = avg > ENERGY_VAD.SPEECH_THRESHOLD;

      this.emit('audioLevel', { speaking: isSpeaking });

      const now = Date.now();

      if (isSpeaking && !this._isSpeaking) {
        // Speech start
        this._isSpeaking = true;
        this._speechStart = now;
        this._silenceStart = 0;
      } else if (!isSpeaking && this._isSpeaking) {
        // Silence began
        if (!this._silenceStart) {
          this._silenceStart = now;
        } else if (now - this._silenceStart > ENERGY_VAD.SILENCE_DURATION) {
          // Sustained silence — speech ended
          this._isSpeaking = false;
          const speechDuration = this._silenceStart - this._speechStart;
          if (speechDuration >= ENERGY_VAD.SPEECH_MIN_DURATION) {
            this._onSpeechEnd();
          }
          this._silenceStart = 0;
        }
      } else if (isSpeaking && this._isSpeaking) {
        // Still speaking — reset silence counter
        this._silenceStart = 0;
      }
    }, ENERGY_VAD.SAMPLE_INTERVAL);

    console.log('[LocalRTCSession] Energy VAD started (fallback)');
  }

  _onSpeechStart() {
    // If TTS is playing, interrupt it (user started speaking)
    if (this._isTTSSpeaking || this._isLLMStreaming) {
      this._cancelTTS();

      if (this._abortController) {
        this._abortController.abort();
        this._abortController = null;
      }
      this._isLLMStreaming = false;
      this._setState(AGENT_STATE.INTERRUPTED);

      if (this._interruptResetTimer) {
        clearTimeout(this._interruptResetTimer);
        this._interruptResetTimer = null;
      }
    }
    this._setState(AGENT_STATE.LISTENING);
    this.emit('audioLevel', { speaking: true });
    this._startRecognition().catch((error) => {
      this._handleASRError(error?.message || 'Failed to start speech recognition', { fatal: false });
    });
  }

  _onSpeechEnd(audio?: SessAny) {
    this.emit('audioLevel', { speaking: false });
    const finishRecognition = async () => {
      if (audio && this._asrBackend && typeof this._asrBackend.submitBufferedAudio === 'function') {
        await this._asrBackend.submitBufferedAudio(audio, DEFAULT_LOCAL_NEURAL_ASR.sampleRate);
      }
      await this._stopRecognition();
    };
    finishRecognition().catch((error) => {
      this._handleASRError(error?.message || 'Failed to stop speech recognition', { fatal: false });
    });
  }

  // ─── Internal: STT / ASR Backends ─────────────────────────────────

  async _initializeASRBackend() {
    const asrConfig = this.voiceChatConfig.ASRConfig || {};
    const explicitProvider = normalizeASRProvider(asrConfig.Provider);
    const explicitFallback = normalizeASRProvider(asrConfig.FallbackProvider);
    const prefersWhisper = isMixedChineseEnglishLanguage(asrConfig.Language) || hasWhisperASRHints(asrConfig);
    const preferred = explicitProvider || (prefersWhisper ? ASR_PROVIDER.WHISPER : DEFAULT_ASR_OPTIONS.provider);
    const fallbackProviders = explicitFallback
      ? [explicitFallback]
      : getDefaultASRFallbackProviders(preferred);
    const candidates = [preferred, ...fallbackProviders].filter((provider, index, list) => provider && list.indexOf(provider) === index);
    const errors = [];

    for (const provider of candidates) {
      let backend = null;
      try {
        backend = this._createASRBackend(provider, asrConfig);
        if (!backend) continue;
        await backend.initialize();
        this._asrBackend = backend;
        this.asrBackendName = provider;
        this._emitASRStatus('active', { provider });
        return;
      } catch (errorRaw) { const error = errorRaw as SessAny;
        if (backend) {
          try { await backend.destroy(); } catch (_) {}
        }
        errors.push(`${provider}: ${error.message || error}`);
        this.asrFallbackReason = error.message || String(error);
        this._emitASRStatus('fallback', {
          provider,
          message: this.asrFallbackReason,
        });
      }
    }

    throw new Error(errors.join(' | ') || 'No ASR backend could be initialized');
  }

  _createASRBackend(provider: string, asrConfig: SessAny) {
    switch (provider) {
      case ASR_PROVIDER.WHISPER:
        return new WhisperASRBackend(this, asrConfig);
      case ASR_PROVIDER.LOCAL_NEURAL:
        return new LocalNeuralASRBackend(this, asrConfig);
      case ASR_PROVIDER.WEB_SPEECH:
        return new WebSpeechASRBackend(this, asrConfig);
      default:
        return null;
    }
  }

  _emitASRStatus(phase: string, extra: SessAny = {}) {
    this.emit('asr', {
      phase,
      provider: extra.provider || this.asrBackendName || '',
      ...extra,
    });
  }

  async _initializeTTSBackend() {
    const ttsConfig = this.voiceChatConfig.TTSConfig || {};
    const explicitProvider = normalizeTTSProvider(ttsConfig.Provider);
    const explicitFallback = normalizeTTSProvider(ttsConfig.FallbackProvider);
    const hasLocalTTSConfig = !!(
      ttsConfig.LocalNeural
      || ttsConfig.ProviderParams
      || ttsConfig.Preset
      || ttsConfig.preset
    );

    const preferred = explicitProvider || (hasLocalTTSConfig ? TTS_PROVIDER.LOCAL_NEURAL : DEFAULT_TTS_OPTIONS.provider);
    const fallback = explicitFallback || (preferred === TTS_PROVIDER.LOCAL_NEURAL ? TTS_PROVIDER.BROWSER_SPEECH : '');
    const candidates = [preferred, fallback].filter((provider, index, list) => provider && list.indexOf(provider) === index);
    const errors = [];

    for (const provider of candidates) {
      let backend = null;
      try {
        backend = this._createTTSBackend(provider, ttsConfig);
        if (!backend) continue;
        await backend.initialize();
        this._ttsBackend = backend;
        this.ttsBackendName = provider;
        return;
      } catch (errorRaw) { const error = errorRaw as SessAny;
        if (backend) {
          try { await backend.destroy(); } catch (_) {}
        }
        errors.push(`${provider}: ${error.message || error}`);
        this.ttsFallbackReason = error.message || String(error);
        this._emitTTSStatus('fallback', {
          provider,
          message: this.ttsFallbackReason,
        });
      }
    }

    this._emitTTSStatus('unavailable', {
      provider: '',
      message: errors.join(' | ') || 'No TTS backend could be initialized',
    });
  }

  _createTTSBackend(provider: string, ttsConfig: SessAny) {
    switch (provider) {
      case TTS_PROVIDER.LOCAL_NEURAL:
        return new LocalNeuralTTSBackend(this, ttsConfig);
      case TTS_PROVIDER.BROWSER_SPEECH:
        return new BrowserSpeechTTSBackend(this, ttsConfig);
      default:
        return null;
    }
  }

  _emitTTSStatus(phase: string, extra: SessAny = {}) {
    this.emit('tts', {
      phase,
      provider: extra.provider || this.ttsBackendName || '',
      ...extra,
    });
  }

  _resolveLocalNeuralTTSSpeakerId(ttsConfig: SessAny, defaultSpeakerId: number) {
    const candidate = parseOptionalInteger(ttsConfig.SpeakerId)
      ?? parseOptionalInteger(ttsConfig.sid)
      ?? parseOptionalInteger(ttsConfig.VoiceType);
    if (Number.isFinite(candidate)) {
      return candidate;
    }
    return defaultSpeakerId;
  }

  _notifyMediaStreamChanged(stream: SessAny | null) {
    if (!this._asrBackend || typeof this._asrBackend.attachMediaStream !== 'function') return;
    this._asrBackend.attachMediaStream(stream).catch((error: SessAny) => {
      console.warn('[LocalRTCSession] Failed to rebind ASR media stream:', error?.message || error);
    });
  }

  _beginRecognitionRound() {
    this._interimText = '';
    this._finalText = '';
    this._roundId++;
  }

  _handleASRInterimText(text: string) {
    if (!this.isActive) return;
    this._interimText = text || '';
    if (!this._interimText) return;
    this.emit('subtitle', {
      text: this._interimText,
      isUser: true,
      roundId: String(this._roundId || 0),
      definite: false,
      paragraph: false,
    });
  }

  _handleASRFinalText(text: string) {
    if (!this.isActive) return;
    this._finalText = (text || '').trim();
    if (!this._finalText) return;
    this.emit('subtitle', {
      text: this._finalText,
      isUser: true,
      roundId: String(this._roundId || 0),
      definite: true,
      paragraph: false,
    });
  }

  _handleASRUtteranceEnd() {
    if (!this.isActive) return;
    if (this._finalText) {
      this._finalizeSpeech();
      return;
    }
    if (this._interimText) {
      this._finalText = this._interimText.trim();
      this._finalizeSpeech();
      return;
    }
    this._interimText = '';
    if (this.isActive && !this.isMuted) {
      this._setState(AGENT_STATE.LISTENING);
    }
  }

  _handleASRError(message: unknown, { fatal = false }: { fatal?: boolean } = {}) {
    if (message) {
      this.emit('error', { error: message });
    }
    if (fatal) {
      throw new Error((message as string) || 'Speech recognition failed');
    }
  }

  async _startRecognition() {
    if (!this._asrBackend || !this.isActive) return;
    if (typeof this._asrBackend.attachMediaStream === 'function') {
      if (this._mediaStream) {
        await this._asrBackend.attachMediaStream(this._mediaStream);
      }
    }
    this._beginRecognitionRound();
    await this._asrBackend.startUtterance();
  }

  async _stopRecognition() {
    if (!this._asrBackend) return;
    await this._asrBackend.stopUtterance();
  }

  _finalizeSpeech() {
    const text = this._finalText.trim();
    this._finalText = '';
    this._interimText = '';

    if (!text) {
      // No speech captured — resume listening
      if (this.isActive && !this.isMuted) {
        this._setState(AGENT_STATE.LISTENING);
      }
      return;
    }

    const roundId = String(this._roundId);

    // Emit final user subtitle
    this.emit('subtitle', {
      text,
      isUser: true,
      roundId,
      definite: true,
      paragraph: true,
    });

    this._addHistory('user', text, roundId);
    this._sendToLLM(text, roundId);
  }

  // ─── Internal: LLM Streaming ──────────────────────────────────────

  async _sendToLLM(userText: string, roundId: unknown) {
    this._setState(AGENT_STATE.THINKING);

    // Build messages from scratch each round using _history + system prompt
    const systemMessages = this._getSystemMessages();
    this._messages = [];
    if (systemMessages.length > 0) {
      this._messages.push({ role: 'system', content: systemMessages.join('\n') });
    }
    for (const h of this._history) {
      this._messages.push({ role: h.role, content: h.text });
    }

    // Collect tool definitions from sandbox + custom tools
    const toolDefs = this.sandbox ? this.sandbox.getToolDefinitions() : [];
    const allTools = [...this.customTools, ...toolDefs];

    await this._llmRound(roundId, allTools, 0);
  }

  /**
   * Execute one LLM round. If the LLM returns tool_calls, execute them and recurse.
   * @param {string} roundId
   * @param {Array} tools - Tool definitions for the LLM
   * @param {number} iteration - Current iteration (guards against runaway loops)
   */
  async _llmRound(roundId: unknown, tools: unknown, iteration: number) {
    const MAX_ITERATIONS = 10;
    if (iteration >= MAX_ITERATIONS) {
      console.warn('[LocalRTCSession] Max tool-call iterations reached');
      if (this.isActive && !this.isMuted) this._setState(AGENT_STATE.LISTENING);
      return;
    }

    // LLM config
    const llmConfig = this.voiceChatConfig.LLMConfig || {};
    const model = llmConfig.Model || llmConfig.EndPointId || 'keepwork-flash';

    // Abort controller for interrupt support
    this._abortController = new AbortController();
    this._isLLMStreaming = true;

    let fullResult = '';
    this._pendingSentence = '';
    let collectedToolCalls: SessAny[] = [];

    try {
      await this.sdk.aiChat._chatRequest({
        messages: this._messages,
        model,
        stream: true,
        tools: (tools as SessAny[]).length > 0 ? tools : undefined,
        abortController: this._abortController,
        onMessage: (resultSoFar: string) => {
          if (!this.isActive) return;
          const newText = resultSoFar.slice(fullResult.length);
          fullResult = resultSoFar;

          // Emit progressive subtitle
          this.emit('subtitle', {
            text: fullResult,
            isUser: false,
            roundId,
            definite: false,
            paragraph: false,
          });

          // Sentence-chunk TTS: buffer text and speak complete sentences
          this._pendingSentence += newText;
          this._flushSentencesToTTS();
        },
        onToolCall: (toolCall: SessAny) => {
          collectedToolCalls.push(toolCall);
          // Emit functionCallInfo (matches RTCChatSession event)
          this.emit('functionCallInfo', {
            name: toolCall.function?.name || 'unknown',
            toolCallId: toolCall.id || '',
          });
        },
        onComplete: () => {
          // handled after await
        },
        onError: (error: SessAny) => {
          if (error.name === 'AbortError') return;
          console.error('[LocalRTCSession] LLM error:', error.message);
          this.emit('error', { error: error.message || 'LLM request failed' });
        },
      });
    } catch (errorRaw) { const error = errorRaw as SessAny;
      this._isLLMStreaming = false;
      if (error.name === 'AbortError') return;
      console.error('[LocalRTCSession] LLM error:', error.message);
      this.emit('error', { error: error.message || 'LLM request failed' });
      if (this.isActive && !this.isMuted) this._setState(AGENT_STATE.LISTENING);
      return;
    }

    this._isLLMStreaming = false;

    // ── Handle tool calls ──
    if (collectedToolCalls.length > 0) {
      // Pause TTS during tool execution
      this.emit('functionCall', { toolCalls: collectedToolCalls });

      // Add assistant message with tool_calls to message history
      this._messages.push({
        role: 'assistant',
        content: fullResult || null,
        tool_calls: collectedToolCalls,
      });

      // Execute each tool call
      for (const toolCall of collectedToolCalls) {
        const funcName = toolCall.function?.name || 'unknown';
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
        } catch (eRaw) { const e = eRaw as SessAny;
          result = `Error: ${e.message}`;
        }

        this.emit('functionCallResult', {
          toolCallId: toolCall.id,
          name: funcName,
          args: funcArgs,
          result,
        });

        // Add tool result to message history
        const content = typeof result === 'string' ? result : JSON.stringify(result);
        this._messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content,
        });
      }

      // Recurse: send tool results back to LLM
      this._setState(AGENT_STATE.THINKING);
      await this._llmRound(roundId, tools, iteration + 1);
      return;
    }

    // ── No tool calls — finalize response ──
    // Final subtitle
    this.emit('subtitle', {
      text: fullResult,
      isUser: false,
      roundId,
      definite: true,
      paragraph: true,
    });

    this._addHistory('assistant', fullResult, roundId);

    // Flush any remaining text to TTS
    if (this._pendingSentence.trim()) {
      this._enqueueTTS(this._pendingSentence.trim());
      this._pendingSentence = '';
    }

    // If nothing was queued to TTS (empty response), go back to listening
    if (!this._isTTSSpeaking && this._ttsQueue.length === 0) {
      if (this.isActive && !this.isMuted) {
        this._setState(AGENT_STATE.LISTENING);
      }
    }
  }

  _getSystemMessages() {
    // Check both config.LLMConfig.SystemMessages and agentConfig
    const llmConfig = this.voiceChatConfig.LLMConfig || {};
    const s2sConfig = this.voiceChatConfig.S2SConfig || {};
    const system = llmConfig.SystemMessages || s2sConfig.SystemMessages || [];
    return Array.isArray(system) ? system : [system];
  }

  /**
   * Expand all ${...} template expressions in SystemMessages using the sandbox.
   * Called once during start().
   */
  async _expandSystemMessages() {
    if (!this.sandbox) return;
    for (const cfgKey of ['LLMConfig', 'S2SConfig']) {
      const cfg = this.voiceChatConfig?.[cfgKey];
      if (!cfg || !Array.isArray(cfg.SystemMessages)) continue;
      cfg.SystemMessages = await Promise.all(
        cfg.SystemMessages.map((msg: unknown) => this.sandbox.processTemplate(msg)),
      );
    }
  }

  // ─── Internal: TTS (speechSynthesis) ───────────────────────────────

  /**
   * Split buffered text on sentence boundaries and enqueue complete sentences.
   */
  _flushSentencesToTTS() {
    while (this._pendingSentence) {
      const match = this._pendingSentence.match(SENTENCE_END_RE);
      if (!match) break; // no complete sentence yet

      const endIdx = match.index + match[0].length;
      const sentence = this._pendingSentence.slice(0, endIdx).trim();
      this._pendingSentence = this._pendingSentence.slice(endIdx);

      if (sentence) {
        this._enqueueTTS(sentence);
      }
    }
  }

  _enqueueTTS(text: string) {
    this._ttsQueue.push(text);
    if (!this._ttsDrainPromise) {
      this._ttsDrainPromise = this._drainTTSQueue();
    }
  }

  _cancelTTS() {
    this._ttsToken += 1;
    if (this._ttsBackend && typeof this._ttsBackend.cancel === 'function') {
      this._ttsBackend.cancel();
    }
    this._ttsQueue = [];
    this._isTTSSpeaking = false;
    this._pendingSentence = '';
    this._ttsDrainPromise = null;
    this._stopTTSLevelTimer();
    this.emit('remoteAudioLevel', { speaking: false, linearVolume: 0 });
  }

  async _drainTTSQueue() {
    const drainToken = ++this._ttsToken;

    while (this._ttsQueue.length > 0 && this.isActive && this._ttsToken === drainToken) {
      const text = this._ttsQueue.shift();
      if (!text) continue;

      this._isTTSSpeaking = true;
      this._setState(AGENT_STATE.SPEAKING);
      this._startTTSLevelTimer();

      try {
        if (this._ttsBackend) {
          await this._ttsBackend.speak(text, this.voiceChatConfig.TTSConfig || {});
        }
      } catch (errorRaw) { const error = errorRaw as SessAny;
        if (error?.name === 'AbortError' || this._ttsToken !== drainToken) {
          break;
        }
        console.warn('[LocalRTCSession] TTS error:', error?.message || error);
        this._emitTTSStatus('error', {
          provider: this.ttsBackendName,
          message: error?.message || String(error),
        });
      }
    }

    if (this._ttsToken === drainToken) {
      this._isTTSSpeaking = false;
      this._stopTTSLevelTimer();
      this.emit('remoteAudioLevel', { speaking: false, linearVolume: 0 });
      if (!this._isLLMStreaming && this.isActive && !this.isMuted) {
        this._setState(AGENT_STATE.LISTENING);
      }
    }

    if (this._ttsDrainPromise && this._ttsToken === drainToken) {
      this._ttsDrainPromise = null;
    }
  }

  _startTTSLevelTimer() {
    if (this._ttsLevelTimer) return;
    this._ttsLevelTimer = setInterval(() => {
      if (this._isTTSSpeaking) {
        this.emit('remoteAudioLevel', { speaking: true, linearVolume: 0.5 });
      }
    }, 200);
  }

  _stopTTSLevelTimer() {
    if (!this._ttsLevelTimer) return;
    clearInterval(this._ttsLevelTimer);
    this._ttsLevelTimer = null;
  }

  _applyTTSConfig(utterance: SessAny, ttsConfig: SessAny) {
    // Speed / rate
    if (ttsConfig.Speed !== undefined) {
      // Map VolcEngine speed range to speechSynthesis rate (0.1–10, default 1)
      utterance.rate = Math.max(0.1, Math.min(10, ttsConfig.Speed || 1));
    }

    // Volume
    if (ttsConfig.Volume !== undefined) {
      utterance.volume = Math.max(0, Math.min(1, ttsConfig.Volume || 1));
    }

    // Language
    const lang = this.voiceChatConfig.ASRConfig?.Language || 'zh-CN';
    utterance.lang = lang;

    // Try to find a matching voice
    if (ttsConfig.VoiceType) {
      this._selectVoice(utterance, ttsConfig.VoiceType, lang);
    }
  }

  _selectVoice(utterance: SessAny, voiceType: string, lang: string) {
    const voices = speechSynthesis.getVoices();
    if (!voices.length) return; // voices not loaded yet

    const lowerType = (voiceType || '').toLowerCase();

    // Try exact name match first
    let voice = voices.find((v) => v.name.toLowerCase() === lowerType);

    // Then try partial match
    if (!voice) {
      voice = voices.find((v) => v.name.toLowerCase().includes(lowerType));
    }

    // Then match by language + gender hints
    if (!voice) {
      const langPrefix = lang.slice(0, 2);
      const langVoices = voices.filter((v) => v.lang.startsWith(langPrefix));

      // Check for gender hints in voiceType
      const isFemale = /female|女/.test(lowerType);
      const isMale = /male|男/.test(lowerType) && !isFemale;

      if (isFemale) {
        voice = langVoices.find((v) => /female/i.test(v.name)) || langVoices[0];
      } else if (isMale) {
        voice = langVoices.find((v) => /male/i.test(v.name) && !/female/i.test(v.name)) || langVoices[0];
      } else {
        voice = langVoices[0];
      }
    }

    if (voice) utterance.voice = voice;
  }

  /**
   * Speak text directly (utility method, bypasses queue).
   */
  _speak(text: string) {
    if (!text || typeof text !== 'string') return;
    this._enqueueTTS(text);
  }

  // ─── Internal: State ───────────────────────────────────────────────

  _setState(code: number) {
    if (this.agentState === code) return;
    this.agentState = code;
    this.emit('state', {
      code,
      label: AGENT_STATE_LABELS[code] || '—',
    });
  }

  // ─── Internal: History ─────────────────────────────────────────────

  _addHistory(role: string, text: string, roundId?: unknown) {
    if (text) {
      this._history.push({ role, text, roundId: roundId || null });
    }
  }
}

// ============================================================================
// LocalRTCSession mixin wiring
// ============================================================================

/**
 * 安装 LocalRTCSession 的 ChildSessionMixin 相关 prototype 注册。
 *
 * 注意：必须用「导出函数 + 在聚合入口（AIChatRTCLocal.core.ts）实际调用」的方式注册，
 * 而非模块顶层裸语句。后者是对被聚合引用类的无返回值顶层副作用语句，Rollup
 * tree-shaking 会因其无外部可观测副作用而删除，导致本地 RTC 子 agent 方法缺失。
 * 集中到本函数并由 core 引用调用，可被 Rollup 当作有副作用的调用保留。
 */
export function installLocalRTCSessionMixin(): void {
  // Apply child session mixin methods to LocalRTCSession prototype
  Object.assign(LocalRTCSession.prototype, childSessionMethods);

  // Override _triggerImmediateCallback for LocalRTCSession:
  // Format pending child results as a text summary and deliver via sendText
  // so the LLM processes them (same pattern as RTCChatSession).
  (LocalRTCSession.prototype as SessAny)._triggerImmediateCallback = async function (this: SessAny) {
    if (this._pendingChildResults.length === 0) return;
    const results = this._consumePendingChildResults();
    const parts = results.map((cr: SessAny) => {
      const resultText = typeof cr.result === 'string' ? cr.result : JSON.stringify(cr.result);
      return `[Agent ${cr.agentName}] Task: ${cr.taskSummary}\nResult: ${resultText}`;
    });
    const summary = parts.join('\n\n');
    this.sendText(summary);
  };
}

// 模块求值时立即执行（副作用注册）。聚合入口仍会显式调用一次以确保保留。
installLocalRTCSessionMixin();

export default LocalRTCSession;
export { LocalRTCSession };
