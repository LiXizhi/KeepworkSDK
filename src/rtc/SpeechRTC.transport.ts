/**
 * SpeechRTC — VolcEngine bidirectional TTS client with managed session reuse.
 *
 * https://www.volcengine.com/docs/6561/1329505?lang=zh
 *
 * Browser callers work with text streams rather than raw WebSocket lifecycle.
 * The SDK opens connections lazily, reuses pooled stream objects created via
 * createTextStream(), auto-finishes an idle session after 10 seconds by
 * default, and closes an underlying connection after 60 seconds of silence by
 * default. Repeated createTextStream() calls with matching voice/connection
 * settings will reuse an existing pooled stream instead of allocating a fresh
 * one, up to maxParallelSessions pooled streams per SpeechRTC instance.
 *
 * Example usage:
 * const speechRTC = new SpeechRTC(window.keepwork, {
 *   // appId and accessToken are optional when the proxy provides defaults.
 *   proxyUrl: 'wss://tts.keepwork.com/ws/tts/',
 *   voiceType: 'zh_female_tianmeiyueyue_moon_bigtts',
 * });
 *
 * const stream = speechRTC.createTextStream();
 * stream.on('audioChunk', ({ bytes }) => console.log('audio chunk', bytes?.byteLength));
 * stream.on('sentenceEnd', ({ text }) => console.log('sentence end', text));
 *
 * await stream.beginText('你好，欢迎使用 SpeechRTC。');
 * await stream.appendText('这一段会继续发送到同一个会话。');
 * const result = await stream.finish();
 *
 * // Or forward model output incrementally:
 * await speechRTC.synthesizeChunks(asyncChunkSource);
 */

import AudioEngine from '../audio/AudioEngine';
import SDKLogger from '../utils/SDKLogger';
const console = SDKLogger.createModuleConsole('SpeechRTC');

const DEFAULT_WS_URL = 'wss://openspeech.bytedance.com/api/v3/tts/bidirection';
const DEFAULT_PROXY_URL = 'wss://speechrtc.keepwork.com/tts';
//const DEFAULT_PROXY_URL = 'ws://localhost:55002/tts';
const DEFAULT_RESOURCE_ID = 'volc.service_type.10029';
const DEFAULT_NAMESPACE = 'BidirectionalTTS';
const DEFAULT_FORMAT = 'pcm';
const DEFAULT_SAMPLE_RATE = 24000;
const DEFAULT_SPEAKER = 'zh_female_tianmeiyueyue_moon_bigtts';

const EVENT = {
  NONE: 0,
  START_CONNECTION: 1,
  FINISH_CONNECTION: 2,
  CONNECTION_STARTED: 50,
  CONNECTION_FAILED: 51,
  CONNECTION_FINISHED: 52,
  START_SESSION: 100,
  CANCEL_SESSION: 101,
  FINISH_SESSION: 102,
  SESSION_STARTED: 150,
  SESSION_CANCELED: 151,
  SESSION_FINISHED: 152,
  SESSION_FAILED: 153,
  USAGE_RESPONSE: 154,
  TASK_REQUEST: 200,
  UPDATE_CONFIG: 201,
  AUDIO_MUTED: 250,
  TTS_SENTENCE_START: 350,
  TTS_SENTENCE_END: 351,
  TTS_RESPONSE: 352,
  TTS_ENDED: 359,
  PODCAST_ROUND_START: 360,
  PODCAST_ROUND_RESPONSE: 361,
  PODCAST_ROUND_END: 362,
  SOURCE_SUBTITLE_START: 650,
  SOURCE_SUBTITLE_RESPONSE: 651,
  SOURCE_SUBTITLE_END: 652,
  TRANSLATION_SUBTITLE_START: 653,
  TRANSLATION_SUBTITLE_RESPONSE: 654,
  TRANSLATION_SUBTITLE_END: 655,
};

const SESSION_STATE = {
  IDLE: 'idle',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  STARTING: 'starting',
  ACTIVE: 'active',
  FINISHING: 'finishing',
  FINISHED: 'finished',
  CANCELED: 'canceled',
  CLOSED: 'closed',
  FAILED: 'failed',
};

const MESSAGE_TYPE = {
  INVALID: 0x0,
  FULL_CLIENT_REQUEST: 0x1,
  AUDIO_ONLY_REQUEST: 0x2,
  FULL_SERVER_RESPONSE: 0x9,
  AUDIO_ONLY_RESPONSE: 0xb,
  FRONT_END_RESULT_RESPONSE: 0xc,
  ERROR_INFORMATION: 0xf,
};

const MESSAGE_FLAG = {
  NO_SEQUENCE: 0x0,
  POSITIVE_SEQUENCE: 0x1,
  LAST_NO_SEQUENCE: 0x2,
  NEGATIVE_SEQUENCE: 0x3,
  WITH_EVENT: 0x4,
};

const VERSION_BITS = {
  VERSION_1: 0x1,
};

const HEADER_SIZE_BITS = {
  HEADER_SIZE_4: 0x1,
};

const SERIALIZATION = {
  RAW: 0x0,
  JSON: 0x1,
};

const COMPRESSION = {
  NONE: 0x0,
  GZIP: 0x1,
};

const CONNECTION_EVENTS = new Set([
  EVENT.START_CONNECTION,
  EVENT.FINISH_CONNECTION,
  EVENT.CONNECTION_STARTED,
  EVENT.CONNECTION_FAILED,
  EVENT.CONNECTION_FINISHED,
]);

const CONNECT_ID_EVENTS = new Set([
  EVENT.CONNECTION_STARTED,
  EVENT.CONNECTION_FAILED,
  EVENT.CONNECTION_FINISHED,
]);

// ──────────────────── 类型声明 ────────────────────

/** _waitForEvent 等待者 */
interface SpeechRTCWaiter {
  values: unknown[];
  resolve: (payload: unknown) => void;
  reject: (error: unknown) => void;
}

/** VolcEngine 二进制协议消息结构 */
interface SpeechRTCMessage {
  version: number;
  headerSize: number;
  type: number;
  flag: number;
  serialization: number;
  compression: number;
  payload: Uint8Array;
  event?: number;
  sessionId?: string;
  connectId?: string;
  sequence?: number;
  errorCode?: number;
  [key: string]: unknown;
}

function randomId(prefix = '', length = 12): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';
  for (let index = 0; index < length; index++) {
    value += chars[Math.floor(Math.random() * chars.length)];
  }
  return `${prefix}${value}`;
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function ensureObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function mergeDeep(base: unknown, extra: unknown): Record<string, unknown> {
  const source = ensureObject(base);
  const overrides = ensureObject(extra);
  const result: Record<string, unknown> = { ...source };

  for (const [key, value] of Object.entries(overrides)) {
    const sourceValue = source[key];
    if (
      value && typeof value === 'object' && !Array.isArray(value)
      && sourceValue && typeof sourceValue === 'object' && !Array.isArray(sourceValue)
    ) {
      result[key] = mergeDeep(sourceValue, value);
      continue;
    }
    result[key] = value;
  }

  return result;
}

function concatUint8Arrays(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum: number, chunk: Uint8Array) => sum + chunk.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }

  return merged;
}

function shouldIncludeSessionId(eventCode: number): boolean {
  return !CONNECTION_EVENTS.has(eventCode);
}

function shouldIncludeConnectId(eventCode: number): boolean {
  return CONNECT_ID_EVENTS.has(eventCode);
}

function inferResourceId(voiceType: unknown): string {
  if (String(voiceType || '').startsWith('S_')) {
    return 'volc.megatts.default';
  }
  return DEFAULT_RESOURCE_ID;
}

function createMessage(messageType: number, flag: number): SpeechRTCMessage {
  return {
    version: VERSION_BITS.VERSION_1,
    headerSize: HEADER_SIZE_BITS.HEADER_SIZE_4,
    type: messageType,
    flag,
    serialization: SERIALIZATION.JSON,
    compression: COMPRESSION.NONE,
    payload: new Uint8Array(0),
  };
}

function encodeString(value: unknown): Uint8Array {
  return new TextEncoder().encode(String(value || ''));
}

function decodeString(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function uint32ToBytes(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value >>> 0, false);
  return bytes;
}

function int32ToBytes(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setInt32(0, value | 0, false);
  return bytes;
}

function readUint32(view: DataView, offset: number): number {
  return view.getUint32(offset, false);
}

function readInt32(view: DataView, offset: number): number {
  return view.getInt32(offset, false);
}

function toUint8Array(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  throw new Error('Unsupported websocket binary frame type');
}

function describeSocketCloseCode(code: number): string {
  const descriptions: Record<number, string> = {
    1000: 'Normal Closure',
    1001: 'Going Away',
    1002: 'Protocol Error',
    1003: 'Unsupported Data',
    1005: 'No Status Received',
    1006: 'Abnormal Closure',
    1007: 'Invalid Frame Payload Data',
    1008: 'Policy Violation',
    1009: 'Message Too Big',
    1010: 'Mandatory Extension Missing',
    1011: 'Internal Error',
    1012: 'Service Restart',
    1013: 'Try Again Later',
    1015: 'TLS Handshake Failure',
  };
  return descriptions[code] || 'Unknown Close Code';
}

function formatSocketCloseEvent(event: { code?: number; reason?: string; wasClean?: boolean } | null | undefined): string {
  if (!event) return 'no close details';
  const parts: string[] = [];
  if (typeof event.code === 'number') {
    parts.push(`code=${event.code}`);
    parts.push(describeSocketCloseCode(event.code));
  }
  if (event.reason) {
    parts.push(`reason=${event.reason}`);
  }
  if (typeof event.wasClean === 'boolean') {
    parts.push(`wasClean=${event.wasClean}`);
  }
  return parts.length ? parts.join(', ') : 'no close details';
}

async function maybeDecompress(bytes: Uint8Array, compression: number): Promise<Uint8Array> {
  if (compression !== COMPRESSION.GZIP) return bytes;
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('Received gzip-compressed websocket payload but DecompressionStream is unavailable');
  }
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  const arrayBuffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(arrayBuffer);
}

function writeSizedString(value: unknown): Uint8Array {
  const bytes = encodeString(value);
  return concatUint8Arrays([uint32ToBytes(bytes.length), bytes]);
}

function marshalMessage(message: SpeechRTCMessage): Uint8Array {
  const headerSize = message.headerSize * 4;
  const header = new Uint8Array(headerSize);
  header[0] = ((message.version & 0x0f) << 4) | (message.headerSize & 0x0f);
  header[1] = ((message.type & 0x0f) << 4) | (message.flag & 0x0f);
  header[2] = ((message.serialization & 0x0f) << 4) | (message.compression & 0x0f);

  const chunks: Uint8Array[] = [header];

  if (message.flag === MESSAGE_FLAG.WITH_EVENT) {
    chunks.push(int32ToBytes(message.event || 0));
    if (shouldIncludeSessionId(message.event || 0)) {
      chunks.push(writeSizedString(message.sessionId || ''));
    }
    if (message.connectId && shouldIncludeConnectId(message.event || 0)) {
      chunks.push(writeSizedString(message.connectId));
    }
  } else if (
    message.flag === MESSAGE_FLAG.POSITIVE_SEQUENCE
    || message.flag === MESSAGE_FLAG.NEGATIVE_SEQUENCE
  ) {
    chunks.push(int32ToBytes(message.sequence || 0));
  }

  if (message.type === MESSAGE_TYPE.ERROR_INFORMATION) {
    chunks.push(int32ToBytes(message.errorCode || 0));
  }

  const payloadBytes = message.payload instanceof Uint8Array ? message.payload : new Uint8Array(0);
  chunks.push(uint32ToBytes(payloadBytes.length), payloadBytes);
  return concatUint8Arrays(chunks);
}

function unmarshalMessage(data: unknown): SpeechRTCMessage {
  const bytes = toUint8Array(data);
  if (bytes.length < 4) {
    throw new Error(`Invalid websocket frame: expected at least 4 bytes, got ${bytes.length}`);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const versionAndHeader = bytes[0];
  const typeAndFlag = bytes[1];
  const serializationAndCompression = bytes[2];

  const message: SpeechRTCMessage = {
    version: (versionAndHeader >> 4) & 0x0f,
    headerSize: versionAndHeader & 0x0f,
    type: (typeAndFlag >> 4) & 0x0f,
    flag: typeAndFlag & 0x0f,
    serialization: (serializationAndCompression >> 4) & 0x0f,
    compression: serializationAndCompression & 0x0f,
    payload: new Uint8Array(0),
  };

  let offset = message.headerSize * 4;

  if (message.type === MESSAGE_TYPE.ERROR_INFORMATION) {
    if (offset + 4 > bytes.length) {
      throw new Error('Invalid websocket frame: missing error code');
    }
    message.errorCode = readUint32(view, offset);
    offset += 4;
  } else if (message.flag === MESSAGE_FLAG.WITH_EVENT) {
    if (offset + 4 > bytes.length) {
      throw new Error('Invalid websocket frame: missing event code');
    }
    message.event = readInt32(view, offset);
    offset += 4;

    if (shouldIncludeSessionId(message.event ?? 0)) {
      if (offset + 4 > bytes.length) {
        throw new Error('Invalid websocket frame: missing session id length');
      }
      const sessionIdLength = readUint32(view, offset);
      offset += 4;
      if (offset + sessionIdLength > bytes.length) {
        throw new Error('Invalid websocket frame: session id exceeds payload length');
      }
      if (sessionIdLength > 0) {
        message.sessionId = decodeString(bytes.subarray(offset, offset + sessionIdLength));
        offset += sessionIdLength;
      }
    }

    if (shouldIncludeConnectId(message.event ?? 0)) {
      if (offset + 4 > bytes.length) {
        throw new Error('Invalid websocket frame: missing connect id length');
      }
      const connectIdLength = readUint32(view, offset);
      offset += 4;
      if (offset + connectIdLength > bytes.length) {
        throw new Error('Invalid websocket frame: connect id exceeds payload length');
      }
      if (connectIdLength > 0) {
        message.connectId = decodeString(bytes.subarray(offset, offset + connectIdLength));
        offset += connectIdLength;
      }
    }
  } else if (
    message.flag === MESSAGE_FLAG.POSITIVE_SEQUENCE
    || message.flag === MESSAGE_FLAG.NEGATIVE_SEQUENCE
  ) {
    if (offset + 4 > bytes.length) {
      throw new Error('Invalid websocket frame: missing sequence');
    }
    message.sequence = readInt32(view, offset);
    offset += 4;
  }

  if (offset + 4 > bytes.length) {
    throw new Error('Invalid websocket frame: missing payload length');
  }

  const payloadLength = readUint32(view, offset);
  offset += 4;
  if (offset + payloadLength > bytes.length) {
    throw new Error('Invalid websocket frame: payload exceeds frame length');
  }

  message.payload = bytes.subarray(offset, offset + payloadLength);
  return message;
}

async function decodeMessagePayload(message: SpeechRTCMessage): Promise<{ payload: unknown; payloadBytes: Uint8Array; payloadText: string | null }> {
  const rawPayload = message.payload || new Uint8Array(0);
  const payloadBytes = await maybeDecompress(rawPayload, message.compression);
  let payload: unknown = payloadBytes;
  let payloadText: string | null = null;

  if (message.serialization === SERIALIZATION.JSON) {
    payloadText = decodeString(payloadBytes);
    try {
      payload = payloadText ? JSON.parse(payloadText) : {};
    } catch {
      payload = payloadText;
    }
  }

  return {
    payload,
    payloadBytes,
    payloadText,
  };
}

async function parseServerFrame(data: unknown): Promise<Record<string, unknown>> {
  const message = unmarshalMessage(data);
  const decoded = await decodeMessagePayload(message);
  return {
    version: message.version,
    headerSize: message.headerSize,
    messageType: message.type,
    flag: message.flag,
    serialization: message.serialization,
    compression: message.compression,
    event: message.event ?? null,
    sessionId: message.sessionId || null,
    connectId: message.connectId || null,
    sequence: message.sequence ?? null,
    errorCode: message.errorCode ?? null,
    payloadLength: message.payload ? message.payload.length : 0,
    payload: decoded.payload,
    payloadBytes: decoded.payloadBytes,
    payloadText: decoded.payloadText,
  };
}

function encodeFullClientEvent(eventCode: number, payload: unknown, sessionId?: string): ArrayBufferLike {
  const message = createMessage(MESSAGE_TYPE.FULL_CLIENT_REQUEST, MESSAGE_FLAG.WITH_EVENT);
  message.event = eventCode;
  if (shouldIncludeSessionId(eventCode)) {
    message.sessionId = sessionId || '';
  }
  message.payload = encodeString(JSON.stringify(payload || {}));
  return marshalMessage(message).buffer;
}

function pcm16ToFloat32(bytes: Uint8Array): Float32Array {
  const sampleCount = Math.floor(bytes.byteLength / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = new Float32Array(sampleCount);
  for (let index = 0; index < sampleCount; index++) {
    samples[index] = view.getInt16(index * 2, true) / 32768;
  }
  return samples;
}

function isSessionTerminalState(state: unknown): boolean {
  return state === SESSION_STATE.FINISHED
    || state === SESSION_STATE.CANCELED
    || state === SESSION_STATE.CLOSED
    || state === SESSION_STATE.FAILED;
}

function positiveNumberOr(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

async function* iterateTextChunks(input: unknown): AsyncGenerator<string> {
  if (input == null) return;

  if (typeof input === 'string') {
    if (input) yield input;
    return;
  }

  if (typeof (input as Record<symbol, unknown>)?.[Symbol.asyncIterator] === 'function') {
    for await (const chunk of input as AsyncIterable<unknown>) {
      if (chunk == null) continue;
      const text = String(chunk);
      if (text) yield text;
    }
    return;
  }

  if (typeof (input as Record<symbol, unknown>)?.[Symbol.iterator] === 'function') {
    for (const chunk of input as Iterable<unknown>) {
      if (chunk == null) continue;
      const text = String(chunk);
      if (text) yield text;
    }
    return;
  }

  const text = String(input);
  if (text) yield text;
}

const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 10000;
const DEFAULT_CONNECTION_IDLE_TIMEOUT_MS = 60000;
const DEFAULT_CONNECTION_MAX_LIFETIME_MS = 10 * 60 * 1000;

class SpeechRTCTransport {
  speechRTC: Record<string, unknown>;
  sdk: unknown;
  ws: WebSocket | null;
  isConnected: boolean;
  connectId: string;
  _connectionPromise: Promise<unknown> | null;
  _waiters: Map<unknown, SpeechRTCWaiter[]>;
  _activeSession: Record<string, unknown> | null;
  _connectionOptions: Record<string, unknown> | null;
  _connectionSignature: string;
  _restartPending: boolean;
  _socketOpenedAt: number;
  _lastActivityAt: number;
  _connectionIdleTimer: ReturnType<typeof setTimeout> | null;
  baseOptions!: Record<string, unknown>;
  [key: string]: unknown;

  constructor(speechRTC: Record<string, unknown>, options: Record<string, unknown> = {}) {
    this.speechRTC = speechRTC;
    this.sdk = speechRTC.sdk;

    this.ws = null;
    this.isConnected = false;
    this.connectId = '';
    this._connectionPromise = null;
    this._waiters = new Map();
    this._activeSession = null;
    this._connectionOptions = null;
    this._connectionSignature = '';
    this._restartPending = false;
    this._socketOpenedAt = 0;
    this._lastActivityAt = 0;
    this._connectionIdleTimer = null;

    this.updateBaseOptions(options);
  }

  updateBaseOptions(options: Record<string, unknown> = {}): void {
    this.baseOptions = mergeDeep(this.baseOptions || {}, options);
  }

  async prepareSession(session: Record<string, unknown>): Promise<void> {
    this.updateBaseOptions((session.options as Record<string, unknown>) || {});
    this._applyConnectionOptions((session.options as Record<string, unknown>) || {});

    if (this._activeSession && this._activeSession !== session && this._activeSession.isSessionActive) {
      throw new Error('SpeechRTC supports only one active synthesis session per websocket connection');
    }

    // If a stale session lingers on this transport (locally finished/failed but
    // possibly still alive server-side), proactively cancel it to prevent
    // Volcengine "session number limit exceeded" errors.
    if (this._activeSession && !this._activeSession.isSessionActive
        && this.isConnected && this.ws && this.ws.readyState === WebSocket.OPEN) {
      const staleId = this._activeSession.sessionId as string;
      this._activeSession = null;
      try {
        this._sendBinary(encodeFullClientEvent(EVENT.CANCEL_SESSION, { event: EVENT.CANCEL_SESSION }, staleId));
        await this._waitForEvent([EVENT.SESSION_CANCELED, EVENT.SESSION_FAILED], 3000).catch(() => {});
      } catch { /* ignore */ }
    }

    if (this._shouldRestartConnection()) {
      await this.shutdown({ graceful: true }).catch(() => {
        this._closeSocket();
      });
    }

    await this._ensureConnected();
    this._activeSession = session;
    this._clearConnectionIdleTimer();
    session.connectId = this.connectId;
  }

  releaseSession(session: Record<string, unknown>): void {
    if (this._activeSession !== session) return;
    this._activeSession = null;
    this._scheduleConnectionIdleTimer();
  }

  /**
   * Fire-and-forget CANCEL_SESSION for a session that failed locally but may
   * still be alive on the Volcengine server. Silently ignored if the socket
   * is not open.
   */
  _tryCancelStaleSession(sessionId: string): void {
    if (!sessionId || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this._sendBinary(encodeFullClientEvent(EVENT.CANCEL_SESSION, { event: EVENT.CANCEL_SESSION }, sessionId));
    } catch { /* ignore */ }
  }

  async sendEvent(eventCode: number, payload: unknown, sessionId?: string): Promise<void> {
    await this._ensureConnected();
    this._sendBinary(encodeFullClientEvent(eventCode, payload, sessionId));
    this._touchActivity();
  }

  async shutdown(options: { graceful?: boolean; timeout?: number } = {}): Promise<void> {
    this._clearConnectionIdleTimer();

    const graceful = options.graceful !== false;
    if (graceful && this.ws && this.ws.readyState === WebSocket.OPEN && this.isConnected) {
      try {
        this._sendBinary(encodeFullClientEvent(EVENT.FINISH_CONNECTION, { event: EVENT.FINISH_CONNECTION }, undefined));
        await this._waitForEvent(EVENT.CONNECTION_FINISHED, options.timeout || 10000);
      } catch { /* ignore */ }
    }

    this._closeSocket();
  }

  _applyConnectionOptions(options: Record<string, unknown> = {}): void {
    const merged = mergeDeep(this.baseOptions || {}, options);
    const nextOptions: Record<string, unknown> = {
      appId: merged.appId || merged.appKey || '',
      accessToken: merged.accessToken || merged.token || '',
      resourceId: merged.resourceId || inferResourceId(merged.voiceType || merged.speaker || DEFAULT_SPEAKER),
      wsUrl: merged.wsUrl || DEFAULT_WS_URL,
      proxyUrl: merged.proxyUrl || DEFAULT_PROXY_URL,
      webSocketFactory: typeof merged.webSocketFactory === 'function' ? merged.webSocketFactory : null,
      includeUsage: merged.includeUsage !== false,
      connectionIdleTimeoutMs: positiveNumberOr(merged.connectionIdleTimeoutMs, DEFAULT_CONNECTION_IDLE_TIMEOUT_MS),
      connectionMaxLifetimeMs: positiveNumberOr(merged.connectionMaxLifetimeMs, DEFAULT_CONNECTION_MAX_LIFETIME_MS),
    };

    const nextSignature = JSON.stringify({
      appId: nextOptions.appId,
      accessToken: nextOptions.accessToken,
      resourceId: nextOptions.resourceId,
      wsUrl: nextOptions.wsUrl,
      proxyUrl: nextOptions.proxyUrl,
      includeUsage: nextOptions.includeUsage,
      hasFactory: !!nextOptions.webSocketFactory,
    });

    if (this._connectionSignature && this._connectionSignature !== nextSignature) {
      this._restartPending = true;
    }

    this._connectionOptions = nextOptions;
    this._connectionSignature = nextSignature;
    if (!this.connectId) {
      this.connectId = (merged.connectId as string) || randomId('connect_');
    }
  }

  _shouldRestartConnection(): boolean {
    if (!this.ws || !this.isConnected) return false;
    if (this._restartPending) return true;
    if (!this._connectionOptions) return false;
    const maxLifetime = this._connectionOptions.connectionMaxLifetimeMs as number;
    return maxLifetime > 0 && this._socketOpenedAt > 0 && (Date.now() - this._socketOpenedAt) >= maxLifetime;
  }

  async _ensureConnected(): Promise<WebSocket | null | unknown> {
    if (!this._connectionOptions) {
      this._applyConnectionOptions(this.baseOptions || {});
    }

    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.isConnected && !this._shouldRestartConnection()) {
      this._touchActivity();
      return this.ws;
    }

    if (this._connectionPromise) {
      return this._connectionPromise;
    }

    if ((this.ws || this.isConnected) && !this._activeSession) {
      await this.shutdown({ graceful: true }).catch(() => {
        this._closeSocket();
      });
    }

    this._connectionPromise = new Promise((resolve, reject) => {
      let socket: WebSocket;
      try {
        socket = this._createWebSocket() as WebSocket;
      } catch (error) {
        reject(error);
        return;
      }

      let settled = false;
      let lastSocketCloseEvent: CloseEvent | null = null;

      this.ws = socket;
      this.ws.binaryType = 'arraybuffer';

      this.ws.onopen = async () => {
        this._socketOpenedAt = Date.now();
        this._touchActivity();
        try {
          await this._sendConnectionStart();
          this._restartPending = false;
          settled = true;
          resolve(this.ws);
        } catch (error) {
          settled = true;
          reject(error);
        }
      };

      this.ws.onerror = (event) => {
        const detail = lastSocketCloseEvent
          ? ` (${formatSocketCloseEvent(lastSocketCloseEvent)})`
          : ' (the browser did not expose handshake details)';
        const error = new Error(`SpeechRTC websocket connection failed${detail}`) as Error & { event?: unknown; closeEvent?: unknown };
        error.event = event;
        if (lastSocketCloseEvent) {
          error.closeEvent = lastSocketCloseEvent;
        }
        if (!settled) {
          settled = true;
          reject(error);
          return;
        }
        this._handleTransportFailure(error, 'socket');
      };

      this.ws.onclose = (event) => {
        lastSocketCloseEvent = event;
        this.isConnected = false;
        this._resolveAllWaiters(new Error(`SpeechRTC websocket closed (${formatSocketCloseEvent(event)})`));
        const error = new Error(`SpeechRTC websocket closed (${formatSocketCloseEvent(event)})`) as Error & { closeEvent?: unknown };
        error.closeEvent = event;
        if (!settled) {
          settled = true;
          reject(error);
          return;
        }
        if (this._activeSession && event && event.code !== 1000) {
          (this._activeSession._fail as (e: unknown, r: string) => void)(error, 'socket-close');
          this.releaseSession(this._activeSession);
        }
        this._closeSocket({ preserveWaiters: true });
      };

      this.ws.onmessage = async (message) => {
        try {
          await this._handleMessage(message.data);
        } catch (error) {
          this._handleTransportFailure(error, 'message');
        }
      };
    });

    try {
      return await this._connectionPromise;
    } finally {
      this._connectionPromise = null;
    }
  }

  _createWebSocket(): unknown {
    const options = (this._connectionOptions || {}) as Record<string, unknown>;
    if (options.webSocketFactory) {
      return (options.webSocketFactory as (cfg: unknown) => unknown)({
        url: options.wsUrl,
        proxyUrl: options.proxyUrl,
        headers: this._buildHandshakeHeaders(),
        connectId: this.connectId,
      });
    }

    if (options.proxyUrl) {
      const url = new URL(options.proxyUrl as string, typeof window !== 'undefined' ? window.location.href : undefined);
      url.searchParams.set('upstream', options.wsUrl as string);
      url.searchParams.set('connect_id', this.connectId);
      if (options.appId) {
        url.searchParams.set('app_key', options.appId as string);
      }
      if (options.accessToken) {
        url.searchParams.set('access_token', options.accessToken as string);
      }
      url.searchParams.set('resource_id', options.resourceId as string);
      if (options.includeUsage) {
        url.searchParams.set('usage_tokens', '*');
      }
      return new WebSocket(url.toString());
    }

    throw new Error('SpeechRTC requires either proxyUrl or webSocketFactory. Direct browser websocket mode is not supported because the browser WebSocket API cannot set the Volcengine auth headers directly.');
  }

  _buildHandshakeHeaders(): Record<string, unknown> {
    const options = (this._connectionOptions || {}) as Record<string, unknown>;
    const headers: Record<string, unknown> = {
      'X-Api-Resource-Id': options.resourceId,
      'X-Api-Connect-Id': this.connectId,
    };
    if (options.appId) {
      headers['X-Api-App-Key'] = options.appId;
    }
    if (options.accessToken) {
      headers['X-Api-Access-Key'] = options.accessToken;
    }
    if (options.includeUsage) {
      headers['X-Control-Require-Usage-Tokens-Return'] = '*';
    }
    return headers;
  }

  async _sendConnectionStart(): Promise<void> {
    this._sendBinary(encodeFullClientEvent(EVENT.START_CONNECTION, {}, undefined));
    const frame = await this._waitForEvent([EVENT.CONNECTION_STARTED, EVENT.CONNECTION_FAILED], 15000) as Record<string, unknown>;
    if (frame.event === EVENT.CONNECTION_FAILED) {
      throw this._createProtocolError(frame, 'Volcengine connection rejected');
    }
    if (frame.connectId) {
      this.connectId = frame.connectId as string;
    }
    this.isConnected = true;
    this._touchActivity();
  }

  async _handleMessage(data: unknown): Promise<void> {
    if (typeof data === 'string') {
      throw new Error(data);
    }

    const frame = await parseServerFrame(data);
    this._touchActivity();

    if (frame.event !== null && frame.event !== undefined) {
      this._resolveWaiters(frame.event, frame);
    }

    if (frame.connectId) {
      this.connectId = frame.connectId as string;
    }

    if (!this._activeSession) return;
    await (this._activeSession._handleFrame as (f: unknown) => Promise<void>)(frame);
  }

  _handleTransportFailure(error: unknown, source: string): void {
    this._resolveAllWaiters(error);
    if (this._activeSession) {
      (this._activeSession._fail as (e: unknown, s: string) => void)(error, source);
      this.releaseSession(this._activeSession);
    }
  }

  _sendBinary(buffer: ArrayBufferLike | ArrayBufferView): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('SpeechRTC websocket is not open');
    }
    this.ws.send(buffer as ArrayBuffer);
  }

  _touchActivity(): void {
    this._lastActivityAt = Date.now();
    if (!this._activeSession) {
      this._scheduleConnectionIdleTimer();
    }
  }

  _scheduleConnectionIdleTimer(): void {
    this._clearConnectionIdleTimer();
    if (!this.ws || !this.isConnected || this._activeSession) return;

    const timeout = (this._connectionOptions?.connectionIdleTimeoutMs as number) || DEFAULT_CONNECTION_IDLE_TIMEOUT_MS;
    this._connectionIdleTimer = setTimeout(() => {
      this._connectionIdleTimer = null;
      if (this._activeSession || !this.ws || !this.isConnected) return;
      this.shutdown({ graceful: true }).catch(() => {
        this._closeSocket();
      });
    }, timeout);
  }

  _clearConnectionIdleTimer(): void {
    if (!this._connectionIdleTimer) return;
    clearTimeout(this._connectionIdleTimer);
    this._connectionIdleTimer = null;
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

  _createProtocolError(frame: Record<string, unknown>, message: string): Error {
    const f = frame as { payload?: { message?: unknown }; payloadText?: unknown; errorCode?: unknown };
    const detail = f?.payload?.message || f?.payloadText || f?.errorCode || 'unknown error';
    const error = new Error(`${message}: ${detail}`) as Error & { frame?: unknown };
    error.frame = frame;
    return error;
  }

  _closeSocket(options: { preserveWaiters?: boolean } = {}): void {
    this._clearConnectionIdleTimer();
    if (this.ws) {
      try {
        this.ws.close();
      } catch { /* ignore */ }
    }
    this.ws = null;
    this.isConnected = false;
    this._socketOpenedAt = 0;
    if (!options.preserveWaiters) {
      this._resolveAllWaiters(new Error('SpeechRTC websocket closed'));
    }
  }
}
export {
  SpeechRTCTransport,
  DEFAULT_WS_URL, DEFAULT_PROXY_URL, DEFAULT_RESOURCE_ID, DEFAULT_NAMESPACE,
  DEFAULT_FORMAT, DEFAULT_SAMPLE_RATE, DEFAULT_SPEAKER,
  DEFAULT_SESSION_IDLE_TIMEOUT_MS, DEFAULT_CONNECTION_IDLE_TIMEOUT_MS, DEFAULT_CONNECTION_MAX_LIFETIME_MS,
  EVENT, SESSION_STATE, MESSAGE_TYPE, MESSAGE_FLAG, VERSION_BITS, HEADER_SIZE_BITS,
  SERIALIZATION, COMPRESSION, CONNECTION_EVENTS, CONNECT_ID_EVENTS,
  randomId, clamp, ensureObject, mergeDeep, concatUint8Arrays,
  shouldIncludeSessionId, shouldIncludeConnectId, inferResourceId,
  positiveNumberOr, stableJson,
  pcm16ToFloat32, isSessionTerminalState, iterateTextChunks,
};
