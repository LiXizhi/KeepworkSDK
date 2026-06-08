/**
 * SpeechRTC — VolcEngine bidirectional TTS client with managed session reuse.
 *
 * 协议层（constants, helpers, SpeechRTCTransport）已拆分至 SpeechRTC.transport.js。
 */

import AudioEngine from '../audio/AudioEngine';
import {
  SpeechRTCTransport,
  DEFAULT_SAMPLE_RATE,
  EVENT, SESSION_STATE, MESSAGE_TYPE,
  pcm16ToFloat32, isSessionTerminalState, iterateTextChunks,
  randomId, clamp, ensureObject, mergeDeep, concatUint8Arrays, inferResourceId,
  positiveNumberOr, stableJson,
  DEFAULT_SPEAKER, DEFAULT_WS_URL, DEFAULT_PROXY_URL, DEFAULT_NAMESPACE, DEFAULT_FORMAT,
  DEFAULT_SESSION_IDLE_TIMEOUT_MS, DEFAULT_CONNECTION_IDLE_TIMEOUT_MS, DEFAULT_CONNECTION_MAX_LIFETIME_MS,
} from './SpeechRTC.transport';


/** _waitForEvent 等待者 */
interface SpeechRTCWaiter {
  values: unknown[];
  resolve: (payload: unknown) => void;
  reject: (error: unknown) => void;
}

/** 会话池条目 */
interface SpeechRTCPoolEntry {
  key: string;
  session: SpeechRTCSession;
  lastUsedAt: number;
}

/** SpeechRTCTransport 的结构化调用表面（供 Session 使用） */
interface ITransport {
  connectId: string;
  prepareSession(session: unknown): Promise<void>;
  releaseSession(session: unknown): void;
  sendEvent(eventCode: number, payload: unknown, sessionId?: string): Promise<void>;
  shutdown(options?: unknown): Promise<void>;
  _closeSocket(options?: unknown): void;
  _tryCancelStaleSession(sessionId: string): void;
  [key: string]: unknown;
}

class SpeechRTC {
  static EVENT = EVENT;
  static SESSION_STATE = SESSION_STATE;

  sdk: unknown;
  options: Record<string, unknown>;
  maxParallelSessions: number;
  _sessionPool: SpeechRTCPoolEntry[];
  _transports: Set<Record<string, unknown>>;
  [key: string]: unknown;

  constructor(sdk: unknown, options: Record<string, unknown> = {}) {
    this.sdk = sdk;
    this.options = { ...options };
    this.maxParallelSessions = positiveNumberOr(this.options.maxParallelSessions, 2);
    this._sessionPool = [];
    this._transports = new Set();
  }

  createSession(config: Record<string, unknown> = {}): SpeechRTCSession {
    return this._createSessionInstance(config);
  }

  createTextStream(config: Record<string, unknown> = {}): SpeechRTCSession {
    const poolKey = this._buildTextStreamPoolKey(config);
    const existing = this._findPooledSession(poolKey);
    if (existing) {
      this._touchPooledSession(existing);
      return existing.session;
    }

    const maxParallelSessions = positiveNumberOr(config.maxParallelSessions, this.maxParallelSessions);
    if (this._sessionPool.length >= maxParallelSessions) {
      const evicted = this._evictLeastRecentlyUsedInactiveSession();
      if (!evicted) {
        throw new Error(`SpeechRTC createTextStream() reached maxParallelSessions=${maxParallelSessions}`);
      }
    }

    const session = this._createSessionInstance(config, { pooled: true, poolKey });
    const entry = {
      key: poolKey,
      session,
      lastUsedAt: Date.now(),
    };
    this._sessionPool.push(entry);
    return session;
  }

  async synthesize(text: string, config: Record<string, unknown> = {}): Promise<unknown> {
    return this.createSession(config).synthesize(text, config);
  }

  async synthesizeChunks(chunks: unknown, config: Record<string, unknown> = {}): Promise<unknown> {
    return this.createSession(config).synthesizeChunks(chunks, config);
  }

  async shutdown(options: Record<string, unknown> = {}): Promise<void> {
    const transports = [...this._transports];
    await Promise.all(transports.map((transport) => (transport.shutdown as (o: unknown) => Promise<void>)(options).catch(() => {
      (transport._closeSocket as () => void)();
    })));
  }

  _createSessionInstance(config: Record<string, unknown> = {}, metadata: Record<string, unknown> = {}): SpeechRTCSession {
    const transport = new SpeechRTCTransport(this as unknown as Record<string, unknown>, mergeDeep(this.options, config));
    this._transports.add(transport as unknown as Record<string, unknown>);
    const session = new SpeechRTCSession(this, config, {
      transport,
      pooled: metadata.pooled === true,
      poolKey: (metadata.poolKey as string) || '',
      onStateChange: () => {
        if (metadata.pooled && metadata.poolKey) {
          const entry = this._sessionPool.find((item) => item.session === session);
          if (entry) entry.lastUsedAt = Date.now();
        }
      },
    });
    return session;
  }

  _buildTextStreamPoolKey(config: Record<string, unknown> = {}): string {
    const merged = mergeDeep(this.options, config);
    return stableJson({
      appId: merged.appId || merged.appKey || '',
      accessToken: merged.accessToken || merged.token || '',
      resourceId: merged.resourceId || inferResourceId(merged.voiceType || merged.speaker || DEFAULT_SPEAKER),
      wsUrl: merged.wsUrl || DEFAULT_WS_URL,
      proxyUrl: merged.proxyUrl || DEFAULT_PROXY_URL,
      hasFactory: typeof merged.webSocketFactory === 'function',
      voiceType: merged.voiceType || merged.speaker || DEFAULT_SPEAKER,
      namespace: merged.namespace || DEFAULT_NAMESPACE,
      model: merged.model || '',
      audioFormat: merged.audioFormat || merged.format || DEFAULT_FORMAT,
      sampleRate: Number(merged.sampleRate) || DEFAULT_SAMPLE_RATE,
      autoPlay: merged.autoPlay !== false,
      includeUsage: merged.includeUsage !== false,
      enableSubtitle: merged.enableSubtitle !== false,
      enableTimestamp: !!merged.enableTimestamp,
      speechRate: merged.speechRate ?? 0,
      loudnessRate: merged.loudnessRate ?? 0,
      bitRate: merged.bitRate || 64000,
      emotion: merged.emotion || '',
      emotionScale: merged.emotionScale ?? 4,
      additions: ensureObject(merged.additions),
      reqParams: ensureObject(merged.reqParams),
    });
  }

  _findPooledSession(poolKey: string): SpeechRTCPoolEntry | null {
    return this._sessionPool.find((entry) => entry.key === poolKey) || null;
  }

  _touchPooledSession(entry: SpeechRTCPoolEntry): void {
    entry.lastUsedAt = Date.now();
  }

  _evictLeastRecentlyUsedInactiveSession(): SpeechRTCPoolEntry | null {
    const candidates = this._sessionPool
      .filter((entry) => !entry.session.isSessionActive)
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt);

    if (!candidates.length) return null;

    const evicted = candidates[0];
    this._sessionPool = this._sessionPool.filter((entry) => entry !== evicted);
    this._transports.delete(evicted.session.transport as unknown as Record<string, unknown>);
    (evicted.session.transport as { shutdown(o: unknown): Promise<void> }).shutdown({ graceful: true }).catch(() => {
      (evicted.session.transport as { _closeSocket(): void })._closeSocket();
    });
    return evicted;
  }
}

class SpeechRTCSession {
  speechRTC: Record<string, unknown>;
  transport: ITransport;
  sdk: unknown;
  options: Record<string, unknown>;
  isPooledStream: boolean;
  poolKey: string;
  _onStateChange: ((state?: unknown, session?: unknown) => void) | null;
  state: unknown;
  isConnected: boolean;
  isSessionActive: boolean;
  _listeners: Record<string, Array<(payload?: unknown) => void>>;
  _waiters: Map<unknown, SpeechRTCWaiter[]>;
  _audioContext: AudioContext | null;
  _audioTime: number;
  _activeSources: Set<unknown>;
  _encodedChunks: unknown[];
  _sessionResult: Record<string, unknown> | null;
  _usage: unknown;
  _sentenceText: string;
  _sessionIdleTimer: ReturnType<typeof setTimeout> | null;
  _audioUrl: string | null;
  [key: string]: unknown;

  constructor(speechRTC: Record<string, unknown>, config: Record<string, unknown> = {}, runtime: Record<string, unknown> = {}) {
    this.speechRTC = speechRTC;
    this.transport = (runtime.transport as ITransport) || new SpeechRTCTransport(speechRTC, mergeDeep(speechRTC.options, config)) as unknown as ITransport;
    this.sdk = speechRTC.sdk;
    this.options = mergeDeep(speechRTC.options, config);
    this.isPooledStream = runtime.pooled === true;
    this.poolKey = (runtime.poolKey as string) || '';
    this._onStateChange = typeof runtime.onStateChange === 'function' ? runtime.onStateChange as (s?: unknown, sess?: unknown) => void : null;

    const opt = this.options;
    this.appId = opt.appId || opt.appKey || '';
    this.accessToken = opt.accessToken || opt.token || '';
    this.voiceType = opt.voiceType || opt.speaker || DEFAULT_SPEAKER;
    this.resourceId = opt.resourceId || inferResourceId(this.voiceType);
    this.wsUrl = opt.wsUrl || DEFAULT_WS_URL;
    this.proxyUrl = opt.proxyUrl || DEFAULT_PROXY_URL;
    this.webSocketFactory = typeof opt.webSocketFactory === 'function' ? opt.webSocketFactory : null;
    this.userId = opt.userId || (this.sdk as { user?: { username?: string } })?.user?.username || randomId('user_');
    this.connectId = opt.connectId || '';
    this.sessionId = opt.sessionId || randomId('session_');
    this.namespace = opt.namespace || DEFAULT_NAMESPACE;
    this.model = opt.model || '';
    this.audioFormat = opt.audioFormat || opt.format || DEFAULT_FORMAT;
    this.sampleRate = Number(opt.sampleRate) || DEFAULT_SAMPLE_RATE;
    this.autoPlay = opt.autoPlay !== false;
    this.includeUsage = opt.includeUsage !== false;
    this.sessionIdleTimeoutMs = positiveNumberOr(opt.sessionIdleTimeoutMs, DEFAULT_SESSION_IDLE_TIMEOUT_MS);

    this.state = SESSION_STATE.IDLE;
    this.isConnected = false;
    this.isSessionActive = false;
    this._listeners = {};
    this._waiters = new Map();
    this._audioContext = null;
    this._audioTime = 0;
    this._activeSources = new Set();
    this._encodedChunks = [];
    this._sessionResult = null;
    this._usage = null;
    this._sentenceText = '';
    this._sessionIdleTimer = null;
    this._audioUrl = null;
  }

  on(event: string, callback: (payload?: unknown) => void): this {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(callback);
    return this;
  }

  off(event: string, callback: (payload?: unknown) => void): this {
    const list = this._listeners[event];
    if (!list) return this;
    this._listeners[event] = list.filter((fn) => fn !== callback);
    return this;
  }

  emit(event: string, payload?: unknown): void {
    const list = this._listeners[event];
    if (!list) return;
    for (const callback of list) {
      try {
        callback(payload);
      } catch (error) {
        console.warn(`[SpeechRTCSession] Listener error for ${event}:`, error);
      }
    }
  }

  async start(): Promise<this> {
    if (this.isSessionActive) return this;
    if (isSessionTerminalState(this.state)) {
      this._resetForReuse();
    }

    // Pre-create AudioContext inside the user-gesture call stack so Chrome
    // autoplay policy is satisfied before async audio frames arrive.
    await this._ensureAudioContext();

    this._setState(SESSION_STATE.CONNECTING);
    await this.transport.prepareSession(this);
    this.isConnected = true;
    this.connectId = this.transport.connectId;
    this._setState(SESSION_STATE.CONNECTED);
    this.emit('connectionStarted', { connectId: this.connectId });
    await this._sendSessionStart();
    this._armSessionIdleTimer();
    return this;
  }

  async sendText(text: string, options: Record<string, unknown> = {}): Promise<void> {
    const content = String(text || '');
    if (!content.trim()) return;
    if (!this.isSessionActive) {
      await this.start();
    }

    const payload = {
      event: EVENT.TASK_REQUEST,
      namespace: this.namespace,
      req_params: {
        text: content,
        ...ensureObject(options.req_params),
      },
      ...ensureObject(options.payload),
    };

    await this.transport.sendEvent(EVENT.TASK_REQUEST, payload, this.sessionId as string);
    this._armSessionIdleTimer();
    this.emit('textSent', { text: content, payload });
  }

  async sendTextChunks(chunks: unknown, options: Record<string, unknown> = {}): Promise<unknown> {
    if (options.start !== false) {
      await this.start();
    }

    for await (const chunk of iterateTextChunks(chunks)) {
      await this.sendText(chunk, options);
    }

    if (options.finish !== false) {
      return this.finish(options);
    }

    return this;
  }

  async streamText(chunks: unknown, options: Record<string, unknown> = {}): Promise<unknown> {
    return this.sendTextChunks(chunks, options);
  }

  async appendText(text: string, options: Record<string, unknown> = {}): Promise<void> {
    return this.sendText(text, options);
  }

  async interrupt(options: Record<string, unknown> = {}): Promise<this> {
    this._clearSessionIdleTimer();

    if (this.isSessionActive) {
      try {
        await this.cancel({ timeout: options.timeout || 15000 });
      } catch (error) {
        this.transport.releaseSession(this);
        this._fail(error, 'interrupt');
        throw error;
      }
    } else {
      this.transport.releaseSession(this);
    }

    if (options.resetAudio !== false) {
      await this._closeAudio();
    }

    this._resetForReuse();
    return this;
  }

  async beginText(text = '', options: Record<string, unknown> = {}): Promise<this> {
    await this.interrupt(options);
    await this.start();

    const content = String(text || '');
    if (content.trim()) {
      await this.sendText(content, options);
    }

    return this;
  }

  async finish(options: Record<string, unknown> = {}): Promise<unknown> {
    this._clearSessionIdleTimer();
    if (!this.isConnected || !this.isSessionActive) return this._sessionResult;

    this._setState(SESSION_STATE.FINISHING);
    await this.transport.sendEvent(EVENT.FINISH_SESSION, { event: EVENT.FINISH_SESSION }, this.sessionId as string);

    const frame = await this._waitForEvent([
      EVENT.SESSION_FINISHED,
      EVENT.SESSION_FAILED,
      EVENT.SESSION_CANCELED,
    ], (options.timeout as number) || 30000) as Record<string, unknown>;

    if (frame?.event === EVENT.SESSION_FAILED) {
      throw this._createProtocolError(frame, 'Volcengine session failed');
    }

    return this._sessionResult;
  }

  async cancel(options: Record<string, unknown> = {}): Promise<void> {
    this._clearSessionIdleTimer();
    if (!this.isConnected || !this.isSessionActive) return;

    await this.transport.sendEvent(EVENT.CANCEL_SESSION, { event: EVENT.CANCEL_SESSION }, this.sessionId as string);
    const frame = await this._waitForEvent([EVENT.SESSION_CANCELED, EVENT.SESSION_FAILED], (options.timeout as number) || 15000) as Record<string, unknown>;
    if (frame?.event === EVENT.SESSION_FAILED) {
      throw this._createProtocolError(frame, 'Volcengine session cancel failed');
    }
  }

  async stop(options: Record<string, unknown> = {}): Promise<unknown> {
    const shouldFinish = options.finish !== false;
    if (shouldFinish && this.isSessionActive) {
      try {
        await this.finish(options);
      } catch {
        if (options.cancelOnFinishError !== false) {
          try {
            await this.cancel();
          } catch { /* ignore */ }
        }
      }
    }

    if (options.closeConnection !== false) {
      await (this.speechRTC.shutdown as (o: unknown) => Promise<void>)({ graceful: true, timeout: (options.timeout as number) || 10000 });
    }

    await this._closeAudio();
    this._setState(SESSION_STATE.CLOSED);
    return this._sessionResult;
  }

  async close(options: Record<string, unknown> = {}): Promise<unknown> {
    return this.stop(options);
  }

  async synthesize(text: string, options: Record<string, unknown> = {}): Promise<unknown> {
    await this.start();
    await this.sendText(text, options);
    const result = await this.finish(options);
    if (options.close !== false) {
      await this.stop({ finish: false, closeConnection: options.closeConnection });
    }
    return result;
  }

  async synthesizeChunks(chunks: unknown, options: Record<string, unknown> = {}): Promise<unknown> {
    await this.start();
    const result = await this.sendTextChunks(chunks, { ...options, start: false, finish: options.finish !== false });
    if (options.close !== false && options.finish !== false) {
      await this.stop({ finish: false, closeConnection: options.closeConnection });
    }
    return result;
  }

  async _sendSessionStart(): Promise<void> {
    this._setState(SESSION_STATE.STARTING);
    const payload = {
      ...this._buildSessionStartPayload(),
      event: EVENT.START_SESSION,
    };
    await this.transport.sendEvent(EVENT.START_SESSION, payload, this.sessionId as string);

    const frame = await this._waitForEvent([EVENT.SESSION_STARTED, EVENT.SESSION_FAILED], 20000) as Record<string, unknown>;
    if (frame.event === EVENT.SESSION_FAILED) {
      throw this._createProtocolError(frame, 'Volcengine session start failed');
    }
    if (frame.sessionId) {
      this.sessionId = frame.sessionId;
    }

    this.isSessionActive = true;
    this._setState(SESSION_STATE.ACTIVE);
    this.emit('sessionStarted', { sessionId: this.sessionId, payload, frame });
  }

  _buildSessionStartPayload(): Record<string, unknown> {
    const baseAudioParams: Record<string, unknown> = {
      format: this.audioFormat,
      sample_rate: this.sampleRate,
    };

    if (this.audioFormat !== 'pcm') {
      baseAudioParams.bit_rate = this.options.bitRate || 64000;
    }
    if (this.options.enableSubtitle !== false) {
      baseAudioParams.enable_subtitle = true;
    }
    if (this.options.enableTimestamp) {
      baseAudioParams.enable_timestamp = true;
    }
    if (this.options.emotion) {
      baseAudioParams.emotion = this.options.emotion;
      baseAudioParams.emotion_scale = clamp(this.options.emotionScale, 1, 5, 4);
    }
    if (this.options.speechRate !== undefined) {
      baseAudioParams.speech_rate = clamp(this.options.speechRate, -50, 100, 0);
    }
    if (this.options.loudnessRate !== undefined) {
      baseAudioParams.loudness_rate = clamp(this.options.loudnessRate, -50, 100, 0);
    }

    const reqParams: Record<string, unknown> = mergeDeep({
      speaker: this.voiceType,
      audio_params: baseAudioParams,
    }, ensureObject(this.options.reqParams));

    if (this.model) {
      reqParams.model = this.model;
    }
    if (this.options.additions) {
      reqParams.additions = this.options.additions;
    }
    if (this.options.mixSpeaker) {
      reqParams.mix_speaker = this.options.mixSpeaker;
    }

    return mergeDeep({
      user: { uid: String(this.userId) },
      namespace: this.namespace,
      req_params: reqParams,
    }, ensureObject(this.options.sessionPayload));
  }

  async _handleFrame(frame: Record<string, unknown>): Promise<void> {
    this.emit('frame', frame);

    if (frame.event !== null && frame.event !== undefined) {
      this._resolveWaiters(frame.event, frame);
    }

    if (frame.messageType === MESSAGE_TYPE.ERROR_INFORMATION) {
      this._fail(this._createProtocolError(frame, 'Volcengine returned an error frame'), 'protocol');
      return;
    }

    if (frame.connectId) {
      this.connectId = frame.connectId;
    }
    if (frame.sessionId) {
      this.sessionId = frame.sessionId;
    }

    if (frame.messageType === MESSAGE_TYPE.AUDIO_ONLY_RESPONSE) {
      await this._handleAudioFrame(frame);
      return;
    }

    const fp = frame.payload as { res_params?: { text?: string }; text?: string; usage?: unknown } | undefined;
    switch (frame.event) {
      case EVENT.TTS_SENTENCE_START:
        this._sentenceText = fp?.res_params?.text || fp?.text || '';
        this.emit('sentenceStart', {
          text: this._sentenceText,
          payload: frame.payload,
          frame,
        });
        break;
      case EVENT.TTS_SENTENCE_END:
        this.emit('sentenceEnd', {
          text: fp?.res_params?.text || fp?.text || this._sentenceText,
          payload: frame.payload,
          frame,
        });
        break;
      case EVENT.TTS_RESPONSE:
        this.emit('ttsResponse', { payload: frame.payload, frame });
        break;
      case EVENT.SOURCE_SUBTITLE_RESPONSE:
      case EVENT.TRANSLATION_SUBTITLE_RESPONSE:
        this.emit('subtitle', {
          subtitle: frame.payload,
          text: fp?.text || fp?.res_params?.text || '',
          frame,
        });
        break;
      case EVENT.USAGE_RESPONSE:
        this._usage = frame.payload || null;
        this.emit('usage', { usage: this._usage, frame });
        break;
      case EVENT.SESSION_FINISHED:
        this._clearSessionIdleTimer();
        this.isSessionActive = false;
        this._sessionResult = {
          status: 'finished',
          payload: frame.payload,
          usage: fp?.usage || this._usage || null,
          sessionId: this.sessionId,
          audioUrl: this._buildAudioUrl(),
        };
        this._setState(SESSION_STATE.FINISHED);
        this.emit('sessionFinished', this._sessionResult);
        this.transport.releaseSession(this);
        break;
      case EVENT.SESSION_CANCELED:
        this._clearSessionIdleTimer();
        this.isSessionActive = false;
        this._sessionResult = {
          status: 'canceled',
          payload: frame.payload,
          usage: this._usage || null,
          sessionId: this.sessionId,
          audioUrl: this._buildAudioUrl(),
        };
        this._setState(SESSION_STATE.CANCELED);
        this.emit('sessionCanceled', this._sessionResult);
        this.transport.releaseSession(this);
        break;
      case EVENT.SESSION_FAILED:
        this._clearSessionIdleTimer();
        this._sessionResult = {
          status: 'failed',
          payload: frame.payload,
          usage: this._usage || null,
          sessionId: this.sessionId,
          audioUrl: this._buildAudioUrl(),
        };
        this.transport.releaseSession(this);
        this._fail(this._createProtocolError(frame, 'Volcengine session failed'), 'session');
        break;
      case EVENT.CONNECTION_FINISHED:
        this.emit('connectionFinished', { connectId: this.connectId, frame });
        break;
      case EVENT.CONNECTION_FAILED:
        this._fail(this._createProtocolError(frame, 'Volcengine connection failed'), 'connection');
        break;
      default:
        if (frame.event !== null && frame.event !== undefined) {
          this.emit('event', frame);
        }
        break;
    }
  }

  async _handleAudioFrame(frame: Record<string, unknown>): Promise<void> {
    const bytes = (frame.payloadBytes as Uint8Array) || new Uint8Array(0);
    if (!bytes.length) return;

    this._encodedChunks.push(bytes.slice());
    this.emit('audioChunk', {
      bytes,
      format: this.audioFormat,
      sampleRate: this.sampleRate,
      sessionId: this.sessionId,
      frame,
    });

    if (!this.autoPlay || this.audioFormat !== 'pcm') return;
    await this._playPCMChunk(bytes);
  }

  async _ensureAudioContext(): Promise<AudioContext | null> {
    if (!this.autoPlay || this.audioFormat !== 'pcm') return null;

    const audioEngine = (this.sdk as { audioEngine?: { resume(o: unknown): Promise<AudioContext> } })?.audioEngine || (AudioEngine as unknown as { getShared(o: unknown): { resume(o: unknown): Promise<AudioContext> } }).getShared({ sampleRate: this.sampleRate });
    this._audioContext = await audioEngine.resume({ sampleRate: this.sampleRate });

    return this._audioContext;
  }

  async _playPCMChunk(bytes: Uint8Array): Promise<void> {
    const audioContext = await this._ensureAudioContext();
    if (!audioContext) return;

    const samples = pcm16ToFloat32(bytes);
    if (!samples.length) return;

    const buffer = audioContext.createBuffer(1, samples.length, this.sampleRate as number);
    buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);

    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContext.destination);

    const now = audioContext.currentTime;
    if (!this._audioTime || this._audioTime < now + 0.02) {
      this._audioTime = now + 0.02;
    }

    const startAt = this._audioTime;
    this._audioTime += buffer.duration;
    this._activeSources.add(source);

    source.onended = () => {
      this._activeSources.delete(source);
      try { source.disconnect(); } catch { /* ignore */ }
      if (this._activeSources.size === 0 && !this.isSessionActive) {
        this.emit('audioPlaybackEnded', { sessionId: this.sessionId });
      }
    };

    source.start(startAt);
  }

  _buildAudioUrl() {
    if (!this._encodedChunks.length || this.audioFormat === 'pcm') return null;
    if (this._audioUrl) return this._audioUrl;

    const mimeType = this.audioFormat === 'ogg_opus'
      ? 'audio/ogg'
      : this.audioFormat === 'mp3'
        ? 'audio/mpeg'
        : 'application/octet-stream';

    this._audioUrl = URL.createObjectURL(new Blob(this._encodedChunks as BlobPart[], { type: mimeType }));
    return this._audioUrl;
  }

  _armSessionIdleTimer() {
    this._clearSessionIdleTimer();
    if (!this.isSessionActive) return;

    this._sessionIdleTimer = setTimeout(() => {
      this._sessionIdleTimer = null;
      this._handleSessionIdleTimeout();
    }, this.sessionIdleTimeoutMs as number);
  }

  _clearSessionIdleTimer() {
    if (!this._sessionIdleTimer) return;
    clearTimeout(this._sessionIdleTimer);
    this._sessionIdleTimer = null;
  }

  async _handleSessionIdleTimeout(): Promise<void> {
    if (!this.isSessionActive) return;
    this.emit('sessionTimeout', {
      sessionId: this.sessionId,
      connectId: this.connectId,
      timeoutMs: this.sessionIdleTimeoutMs,
    });

    try {
      await this.finish({ timeout: 30000 });
    } catch {
      try {
        await this.cancel({ timeout: 10000 });
      } catch { /* ignore */ }
    }
  }

  _waitForEvent(eventCodes: unknown, timeout = 15000): Promise<unknown> {
    const values = Array.isArray(eventCodes) ? eventCodes : [eventCodes];

    return new Promise((resolve, reject) => {
      const waiter: SpeechRTCWaiter = {
        values,
        resolve: (payload: unknown) => {
          if (timer) clearTimeout(timer);
          resolve(payload);
        },
        reject: (error: unknown) => {
          if (timer) clearTimeout(timer);
          reject(error);
        },
      };

      const timer = timeout > 0
        ? setTimeout(() => {
            this._removeWaiter(waiter);
            reject(new Error(`Timed out waiting for SpeechRTC events: ${values.join(', ')}`));
          }, timeout)
        : null;

      for (const value of values) {
        if (!this._waiters.has(value)) this._waiters.set(value, []);
        this._waiters.get(value)!.push(waiter);
      }
    });
  }

  _resolveWaiters(key: unknown, payload: unknown): void {
    const list = this._waiters.get(key);
    if (!list || !list.length) return;
    this._waiters.delete(key);

    for (const waiter of list) {
      this._removeWaiter(waiter, key);
      waiter.resolve(payload);
    }
  }

  _resolveAllWaiters(error: unknown): void {
    for (const key of [...this._waiters.keys()]) {
      const list = this._waiters.get(key);
      if (!list || !list.length) continue;
      this._waiters.delete(key);
      for (const waiter of list) {
        waiter.reject(error instanceof Error ? error : new Error(String(error || key)));
      }
    }
  }

  _removeWaiter(waiter: SpeechRTCWaiter, skipKey?: unknown): void {
    for (const [key, list] of this._waiters.entries()) {
      if (skipKey !== undefined && key === skipKey) continue;
      const next = list.filter((entry) => entry !== waiter);
      if (next.length) {
        this._waiters.set(key, next);
      } else {
        this._waiters.delete(key);
      }
    }
  }

  _setState(state: unknown): void {
    this.state = state;
    if (this._onStateChange) {
      this._onStateChange(state, this);
    }
    this.emit('state', { state, sessionId: this.sessionId, connectId: this.connectId });
  }

  _createProtocolError(frame: Record<string, unknown>, message: string): Error {
    const f = frame as { payload?: { message?: unknown }; payloadText?: unknown; errorCode?: unknown };
    const detail = f?.payload?.message || f?.payloadText || f?.errorCode || 'unknown error';
    const error = new Error(`${message}: ${detail}`) as Error & { frame?: unknown };
    error.frame = frame;
    return error;
  }

  _fail(error: unknown, source: string): void {
    const wasActive = this.isSessionActive;
    const staleSessionId = this.sessionId;
    this.isConnected = false;
    this.isSessionActive = false;
    this._clearSessionIdleTimer();
    this._setState(SESSION_STATE.FAILED);
    this.emit('error', { error, source });
    this._resolveAllWaiters(error);

    // Try to cancel the server-side session to prevent "session number limit exceeded"
    // on subsequent reuse of the same transport connection.
    if (wasActive && this.transport) {
      try {
        this.transport._tryCancelStaleSession(staleSessionId as string);
      } catch { /* ignore */ }
      this.transport.releaseSession(this);
    }
  }

  _resetForReuse(): void {
    this._clearSessionIdleTimer();
    this._resolveAllWaiters(new Error('SpeechRTC session restarted'));
    this.isConnected = false;
    this.isSessionActive = false;
    this.state = SESSION_STATE.IDLE;
    this.connectId = '';
    this.sessionId = randomId('session_');
    this._usage = null;
    this._sentenceText = '';
    this._sessionResult = null;
    if (this._audioUrl) {
      try { URL.revokeObjectURL(this._audioUrl); } catch { /* ignore */ }
      this._audioUrl = null;
    }
    this._encodedChunks = [];
  }

  getRemainingPlaybackTime(): number {
    if (!this._audioContext || !this._audioTime) return 0;
    const remaining = this._audioTime - this._audioContext.currentTime;
    return remaining > 0 ? remaining : 0;
  }

  async _closeAudio(): Promise<void> {
    for (const source of this._activeSources as Set<{ stop(): void; disconnect(): void }>) {
      try { source.stop(); } catch { /* ignore */ }
      try { source.disconnect(); } catch { /* ignore */ }
    }
    this._activeSources.clear();

    this._audioContext = null;
    this._audioTime = 0;
  }
}

export { SpeechRTCSession, EVENT as SPEECH_RTC_EVENT, SESSION_STATE as SPEECH_RTC_SESSION_STATE };
export default SpeechRTC;