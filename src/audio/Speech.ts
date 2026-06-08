/**
 * Speech.ts — 浏览器端 TTS/STT 助手（TypeScript 完整实现）
 *
 * 提供三大功能：
 * 1. Keepwork TTS 播放（playKeepworkAudio）—— 百度 TTS，按年龄/性别自动选音色
 * 2. Volcano TTS 播放（playSynthesizedAudio）—— 火山 TTS，支持多种音色
 * 3. 麦克风录音 + 转写（speechToText）—— MediaRecorder + 服务端 STT
 */

import AudioEngine from './AudioEngine';
import SDKLogger from '../utils/SDKLogger';

const console = SDKLogger.createModuleConsole('Speech');

// ──────────────────── 类型 ────────────────────

/** TTS 失败回退模式 */
export type FallbackMode = 'system' | 'silent' | 'retry';

/** 年龄性别音色配置 */
interface VoiceConfig {
  child:  { male: number; female: number };
  teen:   { male: number; female: number };
  adult:  { male: number; female: number };
  senior: { male: number; female: number };
}

/** Keepwork TTS 请求选项 */
export interface PlayKeepworkAudioOptions {
  /** 发音人 ID（数字或字符串，内部统一转换） */
  per?: string | number;
  spd?: number;
  pit?: number;
  vol?: number;
  age?: number;
  gender?: 'male' | 'female';
  key?: string;
  useCache?: boolean;
  fallbackMode?: FallbackMode;
  onLoaded?: () => void;
  onEnded?: () => void;
  onError?: (error: unknown) => void;
  [key: string]: unknown;
}

/** Volcano TTS 选项 */
export interface PlaySynthesizedAudioOptions {
  voiceType?: string;
  encoding?: string;
  speedRatio?: number;
  loudnessRatio?: number;
  explicitLanguage?: string;
  fallbackMode?: FallbackMode;
  onLoaded?: () => void;
  onEnded?: () => void;
  onError?: (error: unknown) => void;
  [key: string]: unknown;
}

/** speechToText 配置 */
export interface SpeechToTextOptions {
  maxDuration?: number;
  sampleRate?: number;
  format?: string;
  onStart?: () => void;
  onStop?: () => void;
  onError?: (error: Error) => void;
  onResult?: (result: unknown) => void;
  [key: string]: unknown;
}

/** speechToText 返回的录音控制器 */
export interface SpeechToTextRecorder {
  start: () => void;
  stop: () => void;
  getState: () => string;
  isRecording: () => boolean;
}

/** TTS 服务配置 */
interface TTSServiceConfig {
  url: string;
  voiceType: string;
  encoding: string;
  speedRatio: number;
  loudnessRatio: number;
  explicitLanguage: string;
}

/** 浏览器兼容性检测结果 */
export interface BrowserCompatibilityResult {
  isSupported: boolean;
  errors: string[];
  warnings: string[];
  supportedFormats: string[];
}

// ──────────────────── MD5 懒加载 ────────────────────

let _md5: ((str: string) => string) | null = null;
async function getMd5(): Promise<(str: string) => string> {
  if (_md5) return _md5;
  try {
    const mod = await import('blueimp-md5') as { default?: (str: string) => string } & ((str: string) => string);
    _md5 = (mod.default ?? mod) as (str: string) => string;
  } catch {
    // 降级：简单字符串哈希
    _md5 = (str: string): string =>
      Array.from(str)
        .reduce((h, c) => (((h << 5) - h) + c.charCodeAt(0)) | 0, 0)
        .toString(16);
  }
  return _md5;
}

// ──────────────────── Speech ────────────────────

/**
 * Speech — 浏览器端 TTS/STT 助手。
 *
 * 通常通过 `window.keepwork.speech` 访问共享实例；
 * 也可直接 `new Speech(sdk)` 创建独立实例。
 */
class Speech {
  sdk: unknown;
  api: string;
  rate: number;
  volume: number;
  pitch: number;
  ttsService: TTSServiceConfig;
  /**
   * TTS 失败时的全局回退模式（可被单次调用的 options.fallbackMode 覆盖）：
   * - `'system'`（默认）：回退到浏览器原生 speechSynthesis
   * - `'silent'`：静默失败，不播放任何音频
   * - `'retry'`：重试一次远程 TTS，仍失败则静默
   */
  fallbackMode: FallbackMode;

  constructor(sdk: unknown) {
    this.sdk = sdk;
    const hostname = typeof window !== 'undefined' ? window.location.hostname : 'keepwork.com';
    const domain = this.extractMainDomain(hostname);
    this.api = `https://api.${domain}/ts-storage/text2audio`;
    this.rate = 4;
    this.volume = 100;
    this.pitch = 0;
    this.ttsService = {
      url: `https://api.${domain}/ts-storage/volcano-tts/synthesize`,
      voiceType: 'S_T3n79nTy1',
      encoding: 'mp3',
      speedRatio: 1.0,
      loudnessRatio: 1.0,
      explicitLanguage: 'zh',
    };
    this.fallbackMode = 'system';
  }

  // ──────────────────── 工具 ────────────────────

  /**
   * 提取主域名（去掉子域名前缀）。
   * localhost / 127.x / 192.168.x 回退到 keepwork.com。
   */
  extractMainDomain(hostname: string): string {
    if (
      hostname === 'localhost' ||
      hostname.startsWith('127.') ||
      hostname.startsWith('192.168.') ||
      hostname.trim() === ''
    ) return 'keepwork.com';
    const parts = hostname.split('.');
    return parts.length <= 2 ? hostname : parts.slice(-2).join('.');
  }

  setRate(rate: number): void { this.rate = rate; }
  setVolume(volume: number): void { this.volume = volume; }
  setPitch(pitch: number): void { this.pitch = pitch; }

  /**
   * 设置全局 TTS 回退模式。
   * 无效值会被忽略并发出警告。
   */
  setFallbackMode(mode: FallbackMode): void {
    const valid: FallbackMode[] = ['system', 'silent', 'retry'];
    if (valid.includes(mode)) {
      this.fallbackMode = mode;
    } else {
      console.warn(`Invalid fallbackMode "${mode}", expected one of: ${valid.join(', ')}`);
    }
  }

  /** 获取共享 AudioEngine 实例（优先 sdk.audioEngine，否则 AudioEngine.getShared()）。 */
  getAudioEngine(): ReturnType<typeof AudioEngine.getShared> {
    return (this.sdk as Record<string, unknown>)?.['audioEngine'] as ReturnType<typeof AudioEngine.getShared>
      ?? AudioEngine.getShared();
  }

  /**
   * 恢复共享 AudioEngine 的 AudioContext（绕过浏览器自动播放策略）。
   * 失败时静默忽略。
   */
  resumeSharedAudioEngine(options: Record<string, unknown> = {}): Promise<unknown> | null {
    const audioEngine = this.getAudioEngine();
    if (!audioEngine?.isSupported()) return null;
    try {
      return audioEngine.resume(options) ?? null;
    } catch {
      return null;
    }
  }

  // ──────────────────── 音调重采样 ────────────────────

  /**
   * 将 AudioBuffer 重采样到目标采样率（使用 OfflineAudioContext）。
   * 若浏览器不支持或采样率已匹配则原样返回。
   */
  async resampleAudioBuffer(audioBuffer: AudioBuffer, targetSampleRate: number): Promise<AudioBuffer> {
    const nextSampleRate = Number(targetSampleRate);
    if (!audioBuffer || !Number.isFinite(nextSampleRate) || nextSampleRate <= 0 || audioBuffer.sampleRate === nextSampleRate) {
      return audioBuffer;
    }
    const OfflineCtx = typeof window !== 'undefined'
      ? (window.OfflineAudioContext || (window as Window & { webkitOfflineAudioContext?: typeof OfflineAudioContext }).webkitOfflineAudioContext)
      : null;
    if (!OfflineCtx) {
      console.warn('当前浏览器不支持 OfflineAudioContext，返回原始采样率音频');
      return audioBuffer;
    }
    const frameCount = Math.max(1, Math.ceil(audioBuffer.duration * nextSampleRate));
    const offlineContext = new OfflineCtx(audioBuffer.numberOfChannels, frameCount, nextSampleRate);
    const source = offlineContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(offlineContext.destination);
    source.start(0);
    return offlineContext.startRendering();
  }

  // ──────────────────── Keepwork TTS ────────────────────

  /**
   * 调用 Keepwork TTS API，返回音频 URL。
   * @param text    - 要转换的文字
   * @param options - 发音人 / 语速 / 音量等参数
   */
  async textToAudio(text: string, options: PlayKeepworkAudioOptions = {}): Promise<{ data?: string; [key: string]: unknown }> {
    if (!text || typeof text !== 'string') throw new Error('文本内容不能为空');
    const defaults = { per: 20003, spd: this.rate || 5, pit: this.pitch || 5, vol: this.volume || 5 };
    const final = { ...defaults, ...options } as Record<string, unknown>;
    const md5Fn = await getMd5();
    const cacheKey = (options.key as string | undefined) ||
      (md5Fn(`${text}`) + `_${String(final['per'])}_spd${String(final['spd'])}_pit${String(final['pit'])}_vol${String(final['vol'])}`);
    const hostname = typeof window !== 'undefined' ? window.location.hostname : 'keepwork.com';
    const domain = this.extractMainDomain(hostname);
    const response = await fetch(this.api, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'Accept': 'application/json',
        'Referer': `https://${domain}/`, 'Origin': `https://${domain}`,
      },
      body: JSON.stringify({ text, key: `keepwork_${cacheKey}`, options: final }),
    });
    return response.json() as Promise<{ data?: string }>;
  }

  /**
   * 获取年龄/性别对应的 Keepwork 发音人 ID 配置表。
   */
  getVoiceConfig(): VoiceConfig {
    return {
      child:  { male: 20012, female: 20011 },
      teen:   { male: 20013, female: 20001 },
      adult:  { male: 20002, female: 20003 },
      senior: { male: 106,   female: 20006 },
    };
  }

  /**
   * 根据年龄和性别获取对应的发音人 ID。
   * @param age    - 说话人年龄
   * @param gender - 性别（'male' | 'female'，默认 'female'）
   */
  getVoiceIdByAgeGender(age: number, gender: string): number {
    const config = this.getVoiceConfig();
    const g: 'male' | 'female' = (gender === 'male' || gender === 'female') ? gender : 'female';
    const grp = age <= 12 ? 'child' : age <= 20 ? 'teen' : age <= 45 ? 'adult' : 'senior';
    return config[grp][g];
  }

  /**
   * 播放 Keepwork TTS 音频。
   * 若指定了 `age` / `gender` 则自动映射发音人 ID。
   * 支持 AudioEngine 缓存（传入 `useCache: true`）。
   *
   * @param text    - 要朗读的文字
   * @param options - 播放选项（发音人/语速/音量/缓存/回调等）
   */
  async playKeepworkAudio(text: string, options: PlayKeepworkAudioOptions = {}): Promise<unknown> {
    // 年龄/性别 → 发音人 ID
    if (options.gender || options.age !== undefined) {
      const age = options.age ?? 25;
      const gender = options.gender ?? 'female';
      options.per = this.getVoiceIdByAgeGender(age, gender);
      delete options.gender;
      delete options.age;
    }

    return new Promise((resolve) => {
      let settled = false;
      const safeResolve = (result: unknown): void => { if (!settled) { settled = true; resolve(result); } };

      const originalOnEnded = typeof options.onEnded === 'function' ? options.onEnded : null;
      let onEndedFired = false;
      const fireOnEnded = (): void => { if (!onEndedFired) { onEndedFired = true; originalOnEnded?.(); } };
      const safeOptions = { ...options, onEnded: fireOnEnded };

      // 尝试 AudioEngine 缓存快速路径
      const audioEngine = this.getAudioEngine();
      if (options.useCache && audioEngine?.play) {
        const aePlayOptions = { ...options, per: options.per !== undefined ? String(options.per) : undefined };
      const playResult = audioEngine.play(text, {
          ...aePlayOptions,
          onEnd: () => { fireOnEnded(); safeResolve({ data: audioEngine.getCachedUrl?.(text, aePlayOptions), cached: true }); },
          onStart: () => { if (typeof options.onLoaded === 'function') options.onLoaded(); },
          onError: (err: unknown) => { if (typeof options.onError === 'function') options.onError(err); },
        });
      if (playResult != null) return;
      }

      void (async (): Promise<void> => {
        try {
          const result = await this.textToAudio(text, options);
          if (result?.data) {
            const aeSetOptions = { ...options, per: options.per !== undefined ? String(options.per) : undefined };
            if (options.useCache && audioEngine?.set) audioEngine.set(text, result.data, aeSetOptions);
            let audio = document.getElementById('keepwork-audio') as HTMLAudioElement | null;
            if (!audio) {
              audio = document.createElement('audio');
              audio.id = 'keepwork-audio';
              audio.preload = 'auto';
              document.body.appendChild(audio);
            }
            audio.pause(); audio.currentTime = 0;
            audio.src = result.data;
            audio.onloadeddata = () => { if (typeof options.onLoaded === 'function') options.onLoaded(); };
            audio.onerror = (e) => {
              if (typeof options.onError === 'function') options.onError(e);
              void this._handleFallback(text, safeOptions, safeResolve, result, () => this.playKeepworkAudio(text, { ...options, fallbackMode: 'silent' }));
            };
            audio.onended = () => { fireOnEnded(); safeResolve(result); };
            await this.resumeSharedAudioEngine();
            const p = audio.play();
            if (p) p.catch((err: unknown) => {
              if (typeof options.onError === 'function') options.onError(err);
              void this._handleFallback(text, safeOptions, safeResolve, result, () => this.playKeepworkAudio(text, { ...options, fallbackMode: 'silent' }));
            });
          } else {
            void this._handleFallback(text, safeOptions, safeResolve, null, () => this.playKeepworkAudio(text, { ...options, fallbackMode: 'silent' }));
          }
        } catch (error) {
          if (typeof options.onError === 'function') options.onError(error);
          void this._handleFallback(text, safeOptions, safeResolve, null, () => this.playKeepworkAudio(text, { ...options, fallbackMode: 'silent' }));
        }
      })();
    });
  }

  // ──────────────────── Volcano TTS ────────────────────

  /**
   * 调用火山 TTS API，返回 base64 音频数据。
   */
  async synthesizeAudio(text: string, options: PlaySynthesizedAudioOptions = {}): Promise<{ data?: { audioBase64?: string } }> {
    if (!text || typeof text !== 'string') throw new Error('文本内容不能为空');
    const hostname = typeof window !== 'undefined' ? window.location.hostname : 'keepwork.com';
    const domain = this.extractMainDomain(hostname);
    const response = await fetch(this.ttsService.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'Accept': 'application/json',
        'Referer': `https://${domain}/`, 'Origin': `https://${domain}`,
      },
      body: JSON.stringify({
        text,
        voice_type: options.voiceType ?? this.ttsService.voiceType,
        encoding: options.encoding ?? this.ttsService.encoding,
        speed_ratio: options.speedRatio ?? this.ttsService.speedRatio,
        loudness_ratio: options.loudnessRatio ?? this.ttsService.loudnessRatio,
        explicit_language: options.explicitLanguage ?? this.ttsService.explicitLanguage,
      }),
    });
    return response.json() as Promise<{ data?: { audioBase64?: string } }>;
  }

  /**
   * 播放火山 TTS 合成音频。
   * 自动处理 base64 → Audio 元素播放，失败时按 fallbackMode 回退。
   *
   * @param text    - 要合成的文字
   * @param options - 音色/语速/编码/回调等
   */
  async playSynthesizedAudio(text: string, options: PlaySynthesizedAudioOptions = {}): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const safeResolve = (r: unknown): void => { if (!settled) { settled = true; resolve(r); } };

      const originalOnEnded = typeof options.onEnded === 'function' ? options.onEnded : null;
      let onEndedFired = false;
      const fireOnEnded = (): void => { if (!onEndedFired) { onEndedFired = true; originalOnEnded?.(); } };
      const safeOptions = { ...options, onEnded: fireOnEnded };

      void (async (): Promise<void> => {
        try {
          const result = await this.synthesizeAudio(text, options);
          if (result?.data?.audioBase64) {
            const encoding = options.encoding ?? this.ttsService.encoding;
            const mimeType = encoding === 'wav' ? 'audio/wav' : encoding === 'ogg' ? 'audio/ogg' : 'audio/mpeg';
            const audioUrl = `data:${mimeType};base64,${result.data.audioBase64}`;
            const audioData = { audioBase64: result.data.audioBase64, mimeType, audioUrl };

            let audio = document.getElementById('synthesized-audio') as HTMLAudioElement | null;
            if (!audio) {
              audio = document.createElement('audio');
              audio.id = 'synthesized-audio';
              audio.preload = 'auto';
              document.body.appendChild(audio);
            }
            audio.pause(); audio.currentTime = 0; audio.src = audioUrl;
            audio.onloadeddata = () => { if (typeof options.onLoaded === 'function') options.onLoaded(); };
            audio.onerror = (e) => {
              if (typeof options.onError === 'function') options.onError(e);
              void this._handleFallback(text, safeOptions, safeResolve, audioData, () => this.playSynthesizedAudio(text, { ...options, fallbackMode: 'silent' }));
            };
            audio.onended = () => { fireOnEnded(); safeResolve(audioData); };
            await this.resumeSharedAudioEngine();
            const p = audio.play();
            if (p) p.catch((err: unknown) => {
              if (typeof options.onError === 'function') options.onError(err);
              void this._handleFallback(text, safeOptions, safeResolve, audioData, () => this.playSynthesizedAudio(text, { ...options, fallbackMode: 'silent' }));
            });
          } else {
            void this._handleFallback(text, safeOptions, safeResolve, null, () => this.playSynthesizedAudio(text, { ...options, fallbackMode: 'silent' }));
          }
        } catch (error) {
          if (typeof options.onError === 'function') options.onError(error);
          void this._handleFallback(text, safeOptions, safeResolve, null, () => this.playSynthesizedAudio(text, { ...options, fallbackMode: 'silent' }));
          reject(error);
        }
      })();
    });
  }

  // ──────────────────── 回退处理 ────────────────────

  /**
   * 统一处理 TTS 失败后的回退逻辑。
   * - `silent`：静默 resolve
   * - `retry`：重试一次，失败后 silent
   * - `system`（默认）：使用浏览器 speechSynthesis
   * @private
   */
  async _handleFallback(
    text: string,
    safeOptions: Record<string, unknown>,
    safeResolve: (v: unknown) => void,
    resultData: unknown,
    retryFn: () => Promise<unknown>
  ): Promise<void> {
    const mode = (safeOptions['fallbackMode'] as FallbackMode | undefined) ?? this.fallbackMode ?? 'system';
    if (mode === 'silent') {
      safeResolve(resultData);
      return;
    }
    if (mode === 'retry' && retryFn) {
      try {
        const r = await retryFn();
        safeResolve(r ?? resultData);
      } catch {
        safeResolve(resultData);
      }
      return;
    }
    await this.playSystemAudio(text, safeOptions);
    safeResolve(resultData);
  }

  /**
   * 使用浏览器原生 speechSynthesis 朗读文字（TTS 失败时的回退路径）。
   */
  playSystemAudio(text: string, options: Record<string, unknown> = {}): Promise<void> {
    return new Promise((resolve) => {
      if (!('speechSynthesis' in window)) { resolve(); return; }
      const msg = new SpeechSynthesisUtterance();
      msg.text = text;
      if (this.rate) { msg.rate = this.rate < 0 ? Math.max(0.1, this.rate / 10 + 1) : this.rate; }
      if (this.volume) msg.volume = this.volume / 100;
      if (this.pitch) msg.pitch = (this.pitch + 10) / 10;
      msg.onend = () => { if (typeof options['onEnded'] === 'function') (options['onEnded'] as () => void)(); resolve(); };
      msg.onerror = (e) => { if (typeof options['onError'] === 'function') (options['onError'] as (e: unknown) => void)(e); resolve(); };
      speechSynthesis.speak(msg);
    });
  }

  // ──────────────────── 音频停止 ────────────────────

  /**
   * 停止所有音频播放（AudioEngine + speechSynthesis + 所有 audio 元素）。
   */
  stopAllAudio(): void {
    try {
      const ae = this.getAudioEngine() as Record<string, unknown> | undefined;
      if (typeof ae?.['stopPlayback'] === 'function') (ae['stopPlayback'] as () => void)();
      if ('speechSynthesis' in window) speechSynthesis.cancel();
      for (const id of ['synthesized-audio', 'keepwork-audio', 'word-audio']) {
        const el = document.getElementById(id) as HTMLAudioElement | null;
        if (el) { el.pause(); el.currentTime = 0; }
      }
      document.querySelectorAll<HTMLAudioElement>('audio').forEach((a) => {
        if (!a.paused) { a.pause(); a.currentTime = 0; }
      });
    } catch (error) { console.error('停止音频播放时发生错误:', error); }
  }

  /** 停止所有音频（stopAllAudio 的别名）。 */
  stop(): void { this.stopAllAudio(); }

  // ──────────────────── 有道词典发音 ────────────────────

  /** 播放有道词典发音（英语词汇朗读）。 */
  playYouDaoAudio(text: string): void {
    try {
      const audioUrl = `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(text.trim())}&type=1`;
      let audio = document.getElementById('word-audio') as HTMLAudioElement | null;
      if (!audio) {
        audio = document.createElement('audio');
        audio.id = 'word-audio';
        audio.preload = 'auto';
        document.body.appendChild(audio);
      }
      audio.pause(); audio.currentTime = 0; audio.src = audioUrl;
      void this.resumeSharedAudioEngine()?.finally?.(() => {
        const p = (audio as HTMLAudioElement).play();
        if (p) p.catch((err: unknown) => console.error('Error playing YouDao audio:', err));
      });
    } catch (e) { console.error('Error with YouDao API:', e); }
  }

  // ──────────────────── 语音转文字（STT）────────────────────

  /**
   * 创建麦克风录音控制器，并返回 start / stop / getState / isRecording 方法。
   * 录音停止后自动调用服务端 STT API 并通过 `options.onResult` 回调结果。
   *
   * @param options - 录音配置（maxDuration / sampleRate / 各种回调）
   * @throws 浏览器不支持 / 非 HTTPS 环境时抛出错误
   */
  async speechToText(options: SpeechToTextOptions = {}): Promise<SpeechToTextRecorder> {
    const finalOptions: Required<SpeechToTextOptions> = {
      maxDuration: 60, sampleRate: 16000, format: 'wav',
      onStart: () => console.log('录音开始'),
      onStop: () => console.log('录音停止'),
      onError: (e: Error) => console.error('录音错误:', e),
      onResult: (r: unknown) => console.log('识别结果:', r),
      ...options,
    };

    if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前浏览器不支持录音功能，请使用现代浏览器并确保在HTTPS环境下访问');
    if (!window.MediaRecorder) throw new Error('当前浏览器不支持 MediaRecorder API，请更新浏览器版本');
    if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
      throw new Error('录音功能需要在安全上下文（HTTPS）中使用');
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { sampleRate: finalOptions.sampleRate, channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    const mimeType = this.getSupportedMimeType();
    const mediaRecorder = new MediaRecorder(stream, { mimeType });
    let audioChunks: Blob[] = [];
    let recordingTimer: ReturnType<typeof setTimeout> | null = null;

    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunks.push(e.data); };
    mediaRecorder.onerror = (e) => { finalOptions.onError(new Error('录音过程中发生错误: ' + String((e as ErrorEvent).error ?? ''))); };

    mediaRecorder.onstop = async (): Promise<void> => {
      try {
        finalOptions.onStop();
        if (recordingTimer) { clearTimeout(recordingTimer); recordingTimer = null; }
        stream.getTracks().forEach((t) => t.stop());
        if (!audioChunks.length) throw new Error('没有录制到音频数据');
        const audioBlob = new Blob(audioChunks, { type: mimeType });
        if (!audioBlob.size) throw new Error('录制的音频数据为空，请重新尝试录音');
        const wavBase64 = await this.convertToWavBase64(audioBlob, finalOptions.sampleRate);
        const result = await this.callSpeechToTextAPI(wavBase64);
        finalOptions.onResult(result);
      } catch (error) {
        finalOptions.onError(error as Error);
      }
    };

    const start = (): void => {
      if (mediaRecorder.state === 'inactive') {
        audioChunks = [];
        mediaRecorder.start(100);
        finalOptions.onStart();
        recordingTimer = setTimeout(() => {
          if (mediaRecorder.state === 'recording') mediaRecorder.stop();
        }, finalOptions.maxDuration * 1000);
      }
    };
    const stop = (): void => { if (mediaRecorder.state === 'recording') mediaRecorder.stop(); };
    const getState = (): string => mediaRecorder.state;
    const isRecording = (): boolean => getState() === 'recording';

    return { start, stop, getState, isRecording };
  }

  /** 获取当前浏览器支持的录音 MIME 类型（优先 opus/webm）。 */
  getSupportedMimeType(): string {
    if (typeof window.MediaRecorder === 'undefined' || !window.MediaRecorder.isTypeSupported) return 'audio/webm';
    for (const t of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']) {
      if (MediaRecorder.isTypeSupported(t)) return t;
    }
    return 'audio/webm';
  }

  /**
   * 返回当前浏览器支持的录音音频格式简称（如 `webm` / `mp4` / `ogg`），
   * 便于 UI 展示或作为文件扩展名。无法检测时回退为 `webm`。
   */
  getSupportedAudioFormat(): string {
    const mime = this.getSupportedMimeType();           // 形如 audio/webm;codecs=opus
    const subtype = mime.split('/')[1] ?? 'webm';       // webm;codecs=opus
    return subtype.split(';')[0] || 'webm';             // webm
  }

  // ──────────────────── 音频格式转换 ────────────────────

  /**
   * 将音频 Blob 转换为 WAV 格式的 base64 字符串。
   * 内部使用 Web Audio API 解码 + 必要时重采样。
   */
  async convertToWavBase64(audioBlob: Blob, sampleRate = 16000): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!audioBlob?.size) { reject(new Error('音频数据为空，无法进行转换')); return; }
      const reader = new FileReader();
      reader.onload = async (): Promise<void> => {
        try {
          const arrayBuffer = reader.result as ArrayBuffer;
          if (!arrayBuffer?.byteLength) throw new Error('读取到的音频数据为空');
          if (audioBlob.type.includes('wav')) { resolve(this.arrayBufferToBase64(arrayBuffer)); return; }
          const ae = this.getAudioEngine() as { isSupported?: () => boolean; getContext?: () => AudioContext };
          if (!ae.isSupported?.()) throw new Error('当前浏览器不支持 Web Audio API，无法进行音频格式转换');
          const ctx = ae.getContext?.();
          if (!ctx) throw new Error('无法获取 AudioContext');
          let buf = await ctx.decodeAudioData(arrayBuffer.slice(0));
          buf = await this.resampleAudioBuffer(buf, sampleRate);
          resolve(this.arrayBufferToBase64(this.audioBufferToWav(buf)));
        } catch (error) {
          const e = error as Error;
          if (e.name === 'EncodingError' || e.message.includes('decode')) {
            try { resolve(this.arrayBufferToBase64(reader.result as ArrayBuffer)); return; } catch { /* fall through */ }
          }
          reject(new Error('音频格式转换失败: ' + e.message));
        }
      };
      reader.onerror = () => reject(new Error('读取音频文件失败'));
      reader.readAsArrayBuffer(audioBlob);
    });
  }

  /** 将 ArrayBuffer 分块转换为 base64 字符串（避免大缓冲区栈溢出）。 */
  arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    const chunkSize = 8192;
    let binary = '';
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...Array.from(bytes.subarray(i, i + chunkSize)));
    }
    return btoa(binary);
  }

  /** 将 AudioBuffer 编码为 WAV ArrayBuffer（16-bit PCM）。 */
  audioBufferToWav(buffer: AudioBuffer): ArrayBuffer {
    const { length, sampleRate, numberOfChannels } = buffer;
    const bytesPerSample = 2;
    const blockAlign = numberOfChannels * bytesPerSample;
    const dataSize = length * blockAlign;
    const ab = new ArrayBuffer(44 + dataSize);
    const view = new DataView(ab);
    const writeStr = (offset: number, s: string): void => {
      for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
    };
    writeStr(0, 'RIFF'); view.setUint32(4, 36 + dataSize, true);
    writeStr(8, 'WAVE'); writeStr(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true);
    view.setUint16(22, numberOfChannels, true); view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true); view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true); writeStr(36, 'data'); view.setUint32(40, dataSize, true);
    let offset = 44;
    for (let i = 0; i < length; i++) {
      for (let ch = 0; ch < numberOfChannels; ch++) {
        const s = Math.max(-1, Math.min(1, buffer.getChannelData(ch)[i]!));
        view.setInt16(offset, s * 0x7fff, true);
        offset += 2;
      }
    }
    return ab;
  }

  /**
   * 调用服务端 STT API（Keepwork audioEncode2Text）。
   * @param speechBase64 - WAV base64 字符串
   * @param format       - 音频格式（默认 'wav'）
   */
  async callSpeechToTextAPI(speechBase64: string, format = 'wav'): Promise<unknown> {
    const hostname = typeof window !== 'undefined' ? window.location.hostname : 'keepwork.com';
    const domain = this.extractMainDomain(hostname);
    const response = await fetch(`https://api.${domain}/ts-storage/audioEncode2Text`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'Accept': 'application/json',
        'Referer': `https://webparacraft.${domain}/`, 'Origin': `https://webparacraft.${domain}`,
      },
      body: JSON.stringify({ speech: speechBase64, format }),
    });
    return response.json();
  }

  /**
   * 检查当前浏览器是否支持录音功能。
   * @returns 兼容性检测结果（isSupported / errors / warnings / supportedFormats）
   */
  checkBrowserCompatibility(): BrowserCompatibilityResult {
    const result: BrowserCompatibilityResult = { isSupported: true, errors: [], warnings: [], supportedFormats: [] };
    if (!navigator.mediaDevices?.getUserMedia) {
      result.isSupported = false;
      result.errors.push('浏览器不支持录音功能');
    }
    if (!window.MediaRecorder) {
      result.isSupported = false;
      result.errors.push('浏览器不支持 MediaRecorder API');
    }
    if (!(this.getAudioEngine() as { isSupported?: () => boolean }).isSupported?.()) {
      result.warnings.push('浏览器不支持 Web Audio API，音频处理功能可能受限');
    }
    if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
      result.isSupported = false;
      result.errors.push('录音功能需要在安全上下文（HTTPS）中使用');
    }
    if (typeof window.MediaRecorder !== 'undefined' && typeof window.MediaRecorder.isTypeSupported === 'function') {
      result.supportedFormats = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
        .filter((f) => MediaRecorder.isTypeSupported(f));
    }
    return result;
  }

  /**
   * 一键录音识别（自动启动录音，录音停止后返回识别结果）。
   * @param options - 同 speechToText 选项
   */
  async quickSpeechToText(options: SpeechToTextOptions = {}): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const finalOptions: SpeechToTextOptions = {
        ...options,
        onResult: (result: unknown) => { options.onResult?.(result); resolve(result); },
        onError: (error: Error) => { options.onError?.(error); reject(error); },
      };
      void this.speechToText(finalOptions).then((recorder) => {
        recorder.start();
        resolve(recorder);
      }).catch(reject);
    });
  }
}

export default Speech;
