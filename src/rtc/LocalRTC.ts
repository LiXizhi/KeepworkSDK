/**
 * LocalRTC.ts — SherpaOnnxLocalRTC 的 KeepworkSDK 薄封装
 *
 * 将运行时 CDN 加载的 `window.SherpaOnnxLocalRTC` 重新导出为 `LocalRTC`，
 * 供 SDK 内部统一引用。
 *
 * 前置依赖（须在此模块前加载）：
 * ```html
 * <script src="https://cdn.keepwork.com/npm/sherpaonnx-full-js/sherpa-onnx-local-rtc.js"></script>
 * ```
 *
 * 该脚本在 window 上挂载 `SherpaOnnxLocalRTC`，提供 KWS + ASR 功能。
 * 未加载时 `LocalRTC` 为 `null`，使用前需检查。
 *
 * @see LocalRTC.js 中的完整 JSDoc（含构造选项、状态机、所有方法说明）
 */

/** SherpaOnnxLocalRTC 实例选项（简化类型，运行时由 CDN 库实现） */
export interface LocalRTCOptions {
  baseUrl?: string;
  kwsKeywords?: Array<{ phonemes: string; keyword: string; type?: 'start' | 'stop' }>;
  kwsThreshold?: number;
  asrRuntime?: 'wasm' | 'android';
  minAudioRms?: number;
  vadConfig?: {
    enabled?: boolean;
    threshold?: number;
    minSilenceDuration?: number;
    minSpeechDuration?: number;
  };
  audioSource?: 'voice_communication' | 'voice_recognition' | 'mic';
  aecEnabled?: boolean;
  bargeInThreshold?: number;
  bargeInMinFrames?: number;
  onLog?: (msg: string) => void;
  onError?: (msg: string) => void;
  onProgress?: (label: string, pct: number, source: string) => void;
  onStateChange?: (newState: string, oldState: string) => void;
  onKwsDetected?: (keyword: string, action: 'start' | 'stop' | 'wakeup') => void;
  onAsrResult?: (text: string, allResults: string[]) => void;
  onAsrPartial?: (text: string) => void;
  onBargeIn?: (rms: number) => void;
  [key: string]: unknown;
}

/** SherpaOnnxLocalRTC 实例最小接口 */
export interface LocalRTCInstance {
  init(): Promise<void>;
  preloadKws(): Promise<void>;
  preloadAsr(): Promise<void>;
  start(): Promise<void>;
  stop(): void;
  destroy(): void;
  switchToKws(): void;
  switchToAsr(): Promise<boolean>;
  stopAsr(): void;
  pauseAsr(): Promise<void>;
  resumeAsr(): Promise<void>;
  isAsrPaused(): boolean;
  getState(): string;
  getVersion(): string;
  getAsrResults(): string[];
  getAsrLastResult(): string;
  clearAsrResults(): void;
  setKwsKeywords(keywords: LocalRTCOptions['kwsKeywords']): void;
  setKwsThreshold(threshold: number): void;
  setAecEnabled(enabled: boolean): void;
  setMinAudioRms(val: number): void;
  getAsrRuntime(): 'wasm' | 'android';
  needsWasm(): boolean;
  [key: string]: unknown;
}

/** LocalRTC 构造函数类型（可能为 null，取决于 CDN 是否已加载） */
export type LocalRTCConstructor = (new (options: LocalRTCOptions) => LocalRTCInstance) & {
  STATE: { IDLE: string; KWS: string; ASR: string };
  Cache?: unknown;
  samplesToWav?(samples: Float32Array, sampleRate: number): Blob;
  isLikelyEcho?(asrText: string, ttsText: string, opts?: { prefixRatio?: number; bigramRatio?: number }): boolean;
} | null;

// 运行时获取：CDN 脚本挂载到 window.SherpaOnnxLocalRTC
const LocalRTC: LocalRTCConstructor =
  (typeof window !== 'undefined' && (window as Window & { SherpaOnnxLocalRTC?: LocalRTCConstructor }).SherpaOnnxLocalRTC) || null;

export default LocalRTC;
