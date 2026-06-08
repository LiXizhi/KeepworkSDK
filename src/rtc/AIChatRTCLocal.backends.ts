/**
 * AIChatRTCLocal — Local (browser-only) voice chat module.
 *
 * A zero-server-cost alternative to AIChatRTC that replaces VolcEngine RTC's
 * server-side ASR/LLM/TTS pipeline with:
 *   - Silero neural VAD (single-thread WASM) + energy-threshold fallback
 *   - Web Speech API (SpeechRecognition) for STT fallback
 *   - Optional local neural streaming ASR via a small Sherpa-ONNX-style model
 *   - Optional local Whisper ASR for Chinese/English mixed utterances
 *   - Optional local neural TTS with browser speechSynthesis fallback
 *   - Existing sdk.aiChat.chat() SSE streaming for LLM
 *
 * Mirrors AIChatRTC's public API shape so consumers can swap backends with
 * minimal changes. Supports tool calling via SandboxToolEnv and child-agent
 * sessions via ChildSessionMixin — same interface as RTCChatSession.
 *
 * Usage:
 *   const rtcLocal = new AIChatRTCLocal(window.keepwork);
 *   const session = rtcLocal.createSession({
 *     agentConfig: { WelcomeMessage: 'Hello!' },
 *     config: {
 *       LLMConfig: { Model: 'keepwork-flash', SystemMessages: ['You are a helpful assistant.'] },
 *       ASRConfig: { Language: 'zh-CN' },
 *       TTSConfig: { Speed: 1.0 },
 *     },
 *     workspace: 'myWorkspace',
 *     enabledToolCategories: ['fileOps', 'agent'],
 *   });
 *   session.on('subtitle', ({ text, isUser }) => console.log(text));
 *   session.on('state', ({ code, label }) => console.log(label));
 *   session.on('functionCallInfo', ({ name }) => console.log('calling', name));
 *   await session.start();
 *   // speak into microphone → VAD detects → STT → LLM → TTS
 *   session.sendText('Hi there');   // or type text
 *   await session.stop();
 */

import { AGENT_STATE, AGENT_STATE_LABELS } from './AIChatRTC';
import SandboxToolEnv from '../ai-chat/SandboxToolEnv';
import { initChildSessionState, childSessionMethods } from '../ai-chat/ChildSessionMixin';
import SDKLogger from '../utils/SDKLogger';
const console = SDKLogger.createModuleConsole('AIChatRTCLocal');

// 本地语音引擎/会话/后端涉及大量 sherpa-onnx/Web Audio 动态对象，统一用宽松类型
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RTCLocalAny = Record<string, any>;

interface RTCLocalWindow {
  SpeechRecognition?: RTCLocalAny;
  webkitSpeechRecognition?: RTCLocalAny;
  AudioContext?: RTCLocalAny;
  webkitAudioContext?: RTCLocalAny;
  [key: string]: unknown;
}
const _win = (typeof window !== 'undefined' ? window : {}) as unknown as RTCLocalWindow;

// ============================================================================
// Constants
// ============================================================================

/** CDN paths for Silero VAD (single-thread WASM) */
const DEFAULT_VAD_CDN = {
  ortUrl:
    'https://cdn.keepwork.com/keepwork/cdn/voice/ort.min.js',
  onnxWASMBasePath:
    'https://cdn.keepwork.com/keepwork/cdn/voice/',
  bundleUrl:
    'https://cdn.keepwork.com/keepwork/cdn/voice/bundle.min.js',
  modelURL:
    'https://cdn.keepwork.com/keepwork/cdn/voice/silero_vad.onnx',
  workletURL:
    'https://cdn.keepwork.com/keepwork/cdn/voice/vad.worklet.bundle.min.js',
};

const DEFAULT_ASSET_CACHE = {
  dbName: 'AIChatRTCLocalAssetCache',
  storeName: 'binaryAssets',
  namespace: 'keepwork-voice-v1',
  modelFileName: 'silero_vad.onnx',
  wasmFileNames: ['ort-wasm-simd.wasm', 'ort-wasm.wasm'],
};

/** Energy-VAD defaults */
const ENERGY_VAD = {
  SAMPLE_INTERVAL: 50,     // ms between AnalyserNode reads
  SPEECH_THRESHOLD: 15,    // byte-frequency average to consider "speaking"
  SILENCE_DURATION: 600,   // ms of silence before speech-end fires
  SPEECH_MIN_DURATION: 250, // ms minimum speech to avoid misfires
};

const DEFAULT_AUDIO_CONSTRAINTS = {
  channelCount: 1,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  voiceIsolation: true,
};

const ASR_PROVIDER = {
  LOCAL_NEURAL: 'local_neural',
  WHISPER: 'whisper',
  WEB_SPEECH: 'web_speech',
};

const DEFAULT_ASR_OPTIONS = {
  provider: ASR_PROVIDER.LOCAL_NEURAL,
  fallbackProvider: ASR_PROVIDER.WEB_SPEECH,
};

const DEFAULT_LOCAL_NEURAL_ASR = {
  sampleRate: 16000,
  featureDim: 80,
  numThreads: 1,
  executionProvider: 'cpu',
  modelingUnit: 'cjkchar',
  decodingMethod: 'greedy_search',
  tailPaddingSeconds: 0.4,
  bufferSize: 4096,
  initTimeoutMs: 15000,
  emitPartials: true,
};

const DEFAULT_WHISPER_ASR = {
  sampleRate: 16000,
  featureDim: 80,
  numThreads: 1,
  executionProvider: 'cpu',
  decodingMethod: 'greedy_search',
  task: 'transcribe',
  tailPaddings: 300,
  initTimeoutMs: 15000,
};

const TTS_PROVIDER = {
  LOCAL_NEURAL: 'local_neural',
  BROWSER_SPEECH: 'browser_speech',
};

const DEFAULT_TTS_OPTIONS = {
  provider: TTS_PROVIDER.BROWSER_SPEECH,
  fallbackProvider: TTS_PROVIDER.BROWSER_SPEECH,
};

const DEFAULT_KEEPWORK_MODEL_CDN = 'https://cdn.keepwork.com/keepwork/cdn/models';

/**
 * Resolve the default model asset base at runtime.
 * On localhost / LAN / file: serve from the local ./models directory;
 * everywhere else (production Keepwork pages) use the CDN.
 */
function getDefaultModelAssetBase() {
  if (typeof window === 'undefined') return DEFAULT_KEEPWORK_MODEL_CDN;
  const h = window.location.hostname;
  if (h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0'
      || h.endsWith('.local') || /^(10|172\.(1[6-9]|2\d|3[01])|192\.168)\./.test(h)
      || window.location.protocol === 'file:') {
    // return './models';
    return DEFAULT_KEEPWORK_MODEL_CDN;
  }
  return DEFAULT_KEEPWORK_MODEL_CDN;
}

const DEFAULT_LOCAL_NEURAL_TTS = {
  numThreads: 1,
  executionProvider: 'cpu',
  initTimeoutMs: 15000,
  speed: 1.15,
  volume: 1.35,
  speakerId: 0,
  silenceScale: 0.2,
  maxNumSentences: 1,
};

const DEFAULT_LOCAL_NEURAL_TTS_PRESET = 'vits_melo_zh_en';
const DEFAULT_LOCAL_NEURAL_TTS_ASSET_BASE = getDefaultModelAssetBase();
const DEFAULT_SHERPA_ONNX_TTS_WASM_VERSION = '1.12.32';

const LOCAL_NEURAL_TTS_PRESETS: Record<string, RTCLocalAny> = {
  auto_mobile_zh_en: {
    id: 'auto_mobile_zh_en',
    label: 'Auto mobile zh/en',
    description: 'Uses a lightweight Chinese preset for zh text and a bilingual preset for English or mixed text.',
    variants: {
      zh: 'vits_icefall_zh_aishell3_mobile',
      en: 'vits_melo_zh_en',
      mixed: 'vits_melo_zh_en',
    },
  },
  vits_icefall_zh_aishell3_mobile: {
    id: 'vits_icefall_zh_aishell3_mobile',
    label: 'VITS AISHELL3 mobile zh',
    description: 'Small Chinese VITS preset tuned for mobile CPUs.',
    runtimeBasePath: `sherpa-onnx/wasm/${DEFAULT_SHERPA_ONNX_TTS_WASM_VERSION}`,
    modelBasePath: 'tts/vits-icefall-zh-aishell3',
    modelFamily: 'vits',
    sampleRate: 8000,
    modelFileName: 'model.onnx',
    lexiconFileName: 'lexicon.txt',
    tokensFileName: 'tokens.txt',
    ruleFstsFileNames: ['phone.fst', 'date.fst', 'number.fst'],
    speakerId: 66,
  },
  vits_melo_zh_en: {
    id: 'vits_melo_zh_en',
    label: 'VITS Melo bilingual zh/en',
    description: 'Single-speaker bilingual VITS preset for Chinese and English.',
    runtimeBasePath: `sherpa-onnx/wasm/${DEFAULT_SHERPA_ONNX_TTS_WASM_VERSION}`,
    modelBasePath: 'tts/vits-melo-tts-zh_en',
    modelFamily: 'vits',
    sampleRate: 44100,
    modelFileName: 'model.onnx',
    lexiconFileName: 'lexicon.txt',
    tokensFileName: 'tokens.txt',
    ruleFstsFileNames: ['phone.fst', 'date.fst', 'number.fst', 'new_heteronym.fst'],
    speakerId: 0,
  },
};

const LOCAL_NEURAL_TTS_PRESET_ALIASES: Record<string, string> = {
  auto: 'auto_mobile_zh_en',
  mobile_zh_en: 'auto_mobile_zh_en',
  auto_zh_en: 'auto_mobile_zh_en',
  aishell3_mobile: 'vits_icefall_zh_aishell3_mobile',
  zh_mobile: 'vits_icefall_zh_aishell3_mobile',
  melo_zh_en: 'vits_melo_zh_en',
  bilingual_zh_en: 'vits_melo_zh_en',
};

const DEFAULT_LOCAL_NEURAL_PRESET = 'zipformer_small_bilingual_zh_en';
const DEFAULT_LOCAL_NEURAL_ASSET_BASE = getDefaultModelAssetBase();
const DEFAULT_SHERPA_ONNX_WASM_VERSION = '1.12.32';

const LOCAL_NEURAL_ASR_PRESETS: Record<string, RTCLocalAny> = {
  zipformer_small_bilingual_zh_en: {
    id: 'zipformer_small_bilingual_zh_en',
    label: 'Sherpa Zipformer Small Bilingual zh/en',
    description: 'Browser-friendly bilingual streaming zipformer with Chinese and English support.',
    runtimeBasePath: `sherpa-onnx/wasm/${DEFAULT_SHERPA_ONNX_WASM_VERSION}`,
    modelBasePath: 'asr/zipformer-small-bilingual-zh-en-2023-02-16',
    modelFamily: 'transducer',
    sampleRate: 16000,
    featureDim: 80,
    numThreads: 1,
    executionProvider: 'cpu',
    modelingUnit: 'bpe',
    decodingMethod: 'greedy_search',
    modelType: 'zipformer',
    encoderFileName: 'encoder-epoch-99-avg-1.int8.onnx',
    decoderFileName: 'decoder-epoch-99-avg-1.onnx',
    joinerFileName: 'joiner-epoch-99-avg-1.int8.onnx',
    tokensFileName: 'tokens.txt',
  },
  paraformer_bilingual_zh_en: {
    id: 'paraformer_bilingual_zh_en',
    label: 'Sherpa Paraformer Bilingual zh/en',
    description: 'Larger bilingual paraformer with stronger Chinese bias and no timestamps.',
    runtimeBasePath: `sherpa-onnx/wasm/${DEFAULT_SHERPA_ONNX_WASM_VERSION}`,
    modelBasePath: 'asr/paraformer-bilingual-zh-en',
    modelFamily: 'paraformer',
    sampleRate: 16000,
    featureDim: 80,
    numThreads: 1,
    executionProvider: 'cpu',
    decodingMethod: 'greedy_search',
    paraformerEncoderFileName: 'encoder.int8.onnx',
    paraformerDecoderFileName: 'decoder.int8.onnx',
    tokensFileName: 'tokens.txt',
  },
};

const LOCAL_NEURAL_ASR_PRESET_ALIASES: Record<string, string> = {
  small_zh_en: 'zipformer_small_bilingual_zh_en',
  zipformer_small_zh_en: 'zipformer_small_bilingual_zh_en',
  sherpa_small_zh_en: 'zipformer_small_bilingual_zh_en',
  bilingual_zh_en_small: 'zipformer_small_bilingual_zh_en',
  paraformer_zh_en: 'paraformer_bilingual_zh_en',
};

const DEFAULT_WHISPER_PRESET = 'whisper_tiny_multilingual';

const LOCAL_WHISPER_ASR_PRESETS: Record<string, RTCLocalAny> = {
  whisper_tiny_multilingual: {
    id: 'whisper_tiny_multilingual',
    label: 'Sherpa Whisper Tiny Multilingual',
    description: 'Non-streaming multilingual Whisper preset for Chinese/English mixed and other multilingual utterances.',
    runtimeBasePath: `sherpa-onnx/wasm/${DEFAULT_SHERPA_ONNX_WASM_VERSION}`,
    modelBasePath: 'asr/whisper-tiny',
    modelFamily: 'whisper',
    sampleRate: 16000,
    featureDim: 80,
    numThreads: 1,
    executionProvider: 'cpu',
    decodingMethod: 'greedy_search',
    modelType: 'whisper',
    encoderFileName: 'tiny-encoder.int8.onnx',
    decoderFileName: 'tiny-decoder.int8.onnx',
    tokensFileName: 'tiny-tokens.txt',
    tailPaddings: 300,
    task: 'transcribe',
  },
};

const LOCAL_WHISPER_ASR_PRESET_ALIASES: Record<string, string> = {
  whisper: 'whisper_tiny_multilingual',
  whisper_tiny: 'whisper_tiny_multilingual',
  whisper_multilingual: 'whisper_tiny_multilingual',
  whisper_mixed_zh_en: 'whisper_tiny_multilingual',
  zh_en_mixed_whisper: 'whisper_tiny_multilingual',
  mixed_zh_en: 'whisper_tiny_multilingual',
};

function normalizeASRProvider(provider: unknown): string {
  const value = String(provider || '').trim().toLowerCase();
  if (!value) return '';
  if (value === 'local' || value === 'local_neural' || value === 'local-neural' || value === 'sherpa' || value === 'sherpa_onnx' || value === 'sherpa-onnx') {
    return ASR_PROVIDER.LOCAL_NEURAL;
  }
  if (value === 'whisper' || value === 'offline_whisper' || value === 'offline-whisper' || value === 'local_whisper' || value === 'local-whisper') {
    return ASR_PROVIDER.WHISPER;
  }
  if (value === 'webspeech' || value === 'web_speech' || value === 'web-speech' || value === 'speechrecognition' || value === 'chrome') {
    return ASR_PROVIDER.WEB_SPEECH;
  }
  return value;
}

function normalizeTTSProvider(provider: unknown): string {
  const value = String(provider || '').trim().toLowerCase();
  if (!value) return '';
  if (value === 'local' || value === 'local_neural' || value === 'local-neural' || value === 'sherpa' || value === 'sherpa_onnx' || value === 'sherpa-onnx') {
    return TTS_PROVIDER.LOCAL_NEURAL;
  }
  if (value === 'browser' || value === 'browser_speech' || value === 'browser-speech' || value === 'speechsynthesis' || value === 'speech_synthesis' || value === 'system') {
    return TTS_PROVIDER.BROWSER_SPEECH;
  }
  return value;
}

function parseOptionalInteger(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.trunc(value) : undefined;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    if (/^-?\d+$/.test(trimmed)) {
      return parseInt(trimmed, 10);
    }
  }
  return undefined;
}

function trimTrailingSlash(url: unknown): string {
  return String(url || '').replace(/\/+$/, '');
}

function joinUrl(baseUrl: unknown, fileName: unknown): string {
  if (!baseUrl) return '';
  const base = trimTrailingSlash(baseUrl);
  const leaf = String(fileName || '').replace(/^\/+/, '');
  return leaf ? `${base}/${leaf}` : base;
}

function absolutizeBrowserUrl(value: unknown): string {
  if (!value) return '';
  try {
    return new URL(String(value), window.location.href).toString();
  } catch {
    return String(value);
  }
}

function normalizeLocalNeuralPreset(preset: unknown): string {
  const value = String(preset || '').trim().toLowerCase();
  if (!value) return '';
  return LOCAL_NEURAL_ASR_PRESETS[value] ? value : (LOCAL_NEURAL_ASR_PRESET_ALIASES[value] || '');
}

function normalizeWhisperPreset(preset: unknown): string {
  const value = String(preset || '').trim().toLowerCase();
  if (!value) return '';
  return LOCAL_WHISPER_ASR_PRESETS[value] ? value : (LOCAL_WHISPER_ASR_PRESET_ALIASES[value] || '');
}

function normalizeLocalNeuralTTSPreset(preset: unknown): string {
  const value = String(preset || '').trim().toLowerCase();
  if (!value) return '';
  return LOCAL_NEURAL_TTS_PRESETS[value] ? value : (LOCAL_NEURAL_TTS_PRESET_ALIASES[value] || '');
}

function isRemoteLikeUrl(value: unknown): boolean {
  return typeof value === 'string' && /^(https?:)?\/\//i.test(value);
}

function sanitizeAssetName(value: unknown, fallback?: string): string {
  const base = String(value || fallback || 'asset.bin').split('?')[0].split('#')[0];
  const name = base.split('/').pop() || fallback || 'asset.bin';
  return name.replace(/[^a-zA-Z0-9._-]+/g, '_');
}

function cloneJSON(value: unknown): unknown {
  return value ? JSON.parse(JSON.stringify(value)) : value;
}

function concatFloat32Arrays(left: unknown, right: unknown): Float32Array {
  const a = left instanceof Float32Array ? left : new Float32Array((left as number[]) || []);
  const b = right instanceof Float32Array ? right : new Float32Array((right as number[]) || []);
  if (!a.length) return new Float32Array(b);
  if (!b.length) return new Float32Array(a);
  const merged = new Float32Array(a.length + b.length);
  merged.set(a, 0);
  merged.set(b, a.length);
  return merged;
}

function createAbortError(message = 'The operation was aborted'): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function isMixedChineseEnglishLanguage(language: unknown): boolean {
  const normalized = String(language || '').trim().toLowerCase();
  if (!normalized) return false;
  if (normalized.includes('mixed') || normalized.includes('bilingual')) return true;
  const hasChinese = /(^|[^a-z])zh([_-][a-z0-9]+)?([^a-z]|$)/i.test(normalized) || normalized.includes('chinese');
  const hasEnglish = /(^|[^a-z])en([_-][a-z0-9]+)?([^a-z]|$)/i.test(normalized) || normalized.includes('english');
  return hasChinese && hasEnglish;
}

function resolveWhisperLanguage(language: unknown): string {
  const normalized = String(language || '').trim().toLowerCase();
  if (!normalized || isMixedChineseEnglishLanguage(normalized)) return '';
  if (normalized.startsWith('zh') || normalized.includes('chinese')) return 'zh';
  if (normalized.startsWith('en') || normalized.includes('english')) return 'en';
  const parts = normalized.split(/[^a-z]+/).filter(Boolean);
  return parts[0] || '';
}

function hasWhisperASRHints(asrConfig: RTCLocalAny = {}): boolean {
  const preset = normalizeWhisperPreset(
    asrConfig.Preset
    || asrConfig.preset
    || asrConfig.PresetId
    || asrConfig.presetId
    || asrConfig.Whisper?.Preset
    || asrConfig.Whisper?.preset
    || asrConfig.ProviderParams?.Preset
    || asrConfig.ProviderParams?.preset,
  );
  return !!(
    preset
    || asrConfig.Whisper
    || asrConfig.whisper
    || asrConfig.whisperEncoder
    || asrConfig.whisperDecoder
    || asrConfig.WhisperEncoder
    || asrConfig.WhisperDecoder
  );
}

function getDefaultASRFallbackProviders(preferredProvider: unknown): string[] {
  switch (preferredProvider) {
    case ASR_PROVIDER.WHISPER:
      return [ASR_PROVIDER.LOCAL_NEURAL, ASR_PROVIDER.WEB_SPEECH];
    case ASR_PROVIDER.LOCAL_NEURAL:
      return [ASR_PROVIDER.WEB_SPEECH];
    case ASR_PROVIDER.WEB_SPEECH:
    default:
      return [];
  }
}

function detectTTSLanguage(language: unknown, text: unknown = ''): string {
  const normalizedLanguage = String(language || '').toLowerCase();
  if (normalizedLanguage.startsWith('zh')) return 'zh';
  if (normalizedLanguage.startsWith('en')) return 'en';

  const sourceText = String(text || '');
  const hasChinese = /[\u3400-\u9fff]/.test(sourceText);
  const hasLatin = /[A-Za-z]/.test(sourceText);

  if (hasChinese && hasLatin) return 'mixed';
  if (hasChinese) return 'zh';
  if (hasLatin) return 'en';
  return 'en';
}

function getActiveLocalNeuralTTSPreset(presetId: unknown, language: unknown, text: unknown = ''): RTCLocalAny | null {
  const normalizedPreset = normalizeLocalNeuralTTSPreset(presetId) || DEFAULT_LOCAL_NEURAL_TTS_PRESET;
  const preset = LOCAL_NEURAL_TTS_PRESETS[normalizedPreset] || null;
  if (!preset) return null;
  if (!preset.variants) return preset;

  const languageKey = detectTTSLanguage(language, text);
  const variantId = preset.variants[languageKey] || preset.variants.en || DEFAULT_LOCAL_NEURAL_TTS_PRESET;
  return LOCAL_NEURAL_TTS_PRESETS[variantId] || null;
}

function downsampleFloat32(input: unknown, sourceSampleRate: number, targetSampleRate: number): Float32Array {
  if (!(input instanceof Float32Array) || !input.length) return new Float32Array(0);
  if (!sourceSampleRate || !targetSampleRate || sourceSampleRate === targetSampleRate) {
    return new Float32Array(input);
  }
  if (sourceSampleRate < targetSampleRate) {
    return new Float32Array(input);
  }

  const ratio = sourceSampleRate / targetSampleRate;
  const outputLength = Math.max(1, Math.round(input.length / ratio));
  const output = new Float32Array(outputLength);
  let inputOffset = 0;

  for (let index = 0; index < outputLength; index++) {
    const nextOffset = Math.min(input.length, Math.round((index + 1) * ratio));
    let accum = 0;
    let count = 0;
    for (let sampleIndex = inputOffset; sampleIndex < nextOffset; sampleIndex++) {
      accum += input[sampleIndex];
      count += 1;
    }
    output[index] = count > 0 ? accum / count : input[Math.min(inputOffset, input.length - 1)] || 0;
    inputOffset = nextOffset;
  }

  return output;
}

function buildSherpaWorkerSource() {
  return `
let recognizer = null;
let stream = null;
let expectedSampleRate = 16000;
let tailPaddingSeconds = 0.4;
let runtimeReady = false;
let assetSequence = 0;
let lastDecodedText = '';

function postMessageSafe(type, payload = {}) {
  self.postMessage({ type, ...payload });
}

function destroyStream() {
  if (stream && typeof stream.free === 'function') {
    try { stream.free(); } catch (_) {}
  }
  stream = null;
}

function resetStream() {
  destroyStream();
  if (!recognizer || typeof recognizer.createStream !== 'function') return;
  stream = recognizer.createStream();
}

function decodeCurrentStream() {
  if (!recognizer || !stream) return { text: '' };
  while (recognizer.isReady(stream)) {
    recognizer.decode(stream);
  }
  const result = recognizer.getResult(stream) || { text: '' };
  const text = (result.text || '').trim();
  if (text) {
    lastDecodedText = text;
  }
  return result;
}

function makeLocateFile(runtimeConfig) {
  return function locateFile(path) {
    if (/\.wasm$/i.test(path) && runtimeConfig.wasmBinaryUrl) return runtimeConfig.wasmBinaryUrl;
    if (/\.data$/i.test(path) && runtimeConfig.wasmDataUrl) return runtimeConfig.wasmDataUrl;
    if (runtimeConfig.runtimeModuleUrl) {
      return new URL(path, runtimeConfig.runtimeModuleUrl).toString();
    }
    return path;
  };
}

function isMaterializableAssetUrl(value) {
  return typeof value === 'string' && /^(blob:|https?:|data:)/i.test(value);
}

function sanitizeAssetName(value, fallback) {
  const base = String(value || fallback || 'asset.bin').split('?')[0].split('#')[0];
  const name = base.split('/').pop() || fallback || 'asset.bin';
  return name.replace(/[^a-zA-Z0-9._-]+/g, '_');
}

function ensureFsDir(Module, filePath) {
  const parts = String(filePath || '').split('/').filter(Boolean);
  if (parts.length < 2) return;
  const directoryPath = parts.slice(0, -1).join('/');

  if (typeof Module.FS_createPath === 'function') {
    try {
      Module.FS_createPath('/', directoryPath, true, true);
      return;
    } catch (_) {}
  }

  const fsApi = self.FS || Module.FS;
  if (!fsApi || typeof fsApi.mkdir !== 'function') return;

  let current = '';
  for (let index = 0; index < parts.length - 1; index++) {
    current += '/' + parts[index];
    try {
      fsApi.mkdir(current);
    } catch (_) {}
  }
}

function writeAssetToFs(Module, virtualPath, bytes) {
  const normalizedPath = String(virtualPath || '');
  const lastSlash = normalizedPath.lastIndexOf('/');
  const parentDir = lastSlash > 0 ? normalizedPath.slice(0, lastSlash) : '/';
  const fileName = lastSlash >= 0 ? normalizedPath.slice(lastSlash + 1) : normalizedPath;

  if (typeof Module.FS_createDataFile === 'function') {
    try {
      if (typeof Module.FS_unlink === 'function') {
        try { Module.FS_unlink(normalizedPath); } catch (_) {}
      }
      Module.FS_createDataFile(parentDir, fileName, bytes, true, true, true);
      return;
    } catch (_) {}
  }

  const fsApi = self.FS || Module.FS;
  if (fsApi && typeof fsApi.writeFile === 'function') {
    fsApi.writeFile(normalizedPath, bytes, { canOwn: true });
    return;
  }

  throw new Error('Sherpa runtime filesystem API is unavailable');
}

async function fetchAssetBytes(url, { asText = false } = {}) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error('Failed to fetch ASR asset: ' + url + ' (' + response.status + ')');
  }
  if (asText) {
    return new TextEncoder().encode(await response.text());
  }
  return new Uint8Array(await response.arrayBuffer());
}

async function materializeAssetToFs(Module, url, { asText = false, fallbackName = 'asset.bin' } = {}) {
  if (!isMaterializableAssetUrl(url)) return url;
  const fileName = sanitizeAssetName(url, fallbackName);
  const virtualPath = '/keepwork-asr-assets/' + (++assetSequence) + '-' + fileName;
  ensureFsDir(Module, virtualPath);
  const bytes = await fetchAssetBytes(url, { asText });
  writeAssetToFs(Module, virtualPath, bytes);
  return virtualPath;
}

async function materializeRecognizerConfig(Module, recognizerConfig) {
  const config = JSON.parse(JSON.stringify(recognizerConfig || {}));
  const modelConfig = config.modelConfig || {};
  const transducer = modelConfig.transducer || {};
  const paraformer = modelConfig.paraformer || {};
  const zipformer2Ctc = modelConfig.zipformer2Ctc || {};
  const nemoCtc = modelConfig.nemoCtc || {};
  const toneCtc = modelConfig.toneCtc || {};
  const ctcFstDecoderConfig = config.ctcFstDecoderConfig || {};

  transducer.encoder = await materializeAssetToFs(Module, transducer.encoder, { fallbackName: 'encoder.onnx' });
  transducer.decoder = await materializeAssetToFs(Module, transducer.decoder, { fallbackName: 'decoder.onnx' });
  transducer.joiner = await materializeAssetToFs(Module, transducer.joiner, { fallbackName: 'joiner.onnx' });

  paraformer.encoder = await materializeAssetToFs(Module, paraformer.encoder, { fallbackName: 'encoder.onnx' });
  paraformer.decoder = await materializeAssetToFs(Module, paraformer.decoder, { fallbackName: 'decoder.onnx' });

  zipformer2Ctc.model = await materializeAssetToFs(Module, zipformer2Ctc.model, { fallbackName: 'model.onnx' });
  nemoCtc.model = await materializeAssetToFs(Module, nemoCtc.model, { fallbackName: 'model.onnx' });
  toneCtc.model = await materializeAssetToFs(Module, toneCtc.model, { fallbackName: 'model.onnx' });

  modelConfig.tokens = await materializeAssetToFs(Module, modelConfig.tokens, { asText: true, fallbackName: 'tokens.txt' });
  modelConfig.bpeVocab = await materializeAssetToFs(Module, modelConfig.bpeVocab, { asText: true, fallbackName: 'bpe.vocab' });
  modelConfig.tokensBuf = modelConfig.tokensBuf || '';
  modelConfig.tokensBufSize = modelConfig.tokensBufSize || 0;

  config.hotwordsFile = await materializeAssetToFs(Module, config.hotwordsFile, { asText: true, fallbackName: 'hotwords.txt' });
  config.ruleFsts = await materializeAssetToFs(Module, config.ruleFsts, { fallbackName: 'rule.fst' });
  config.ruleFars = await materializeAssetToFs(Module, config.ruleFars, { fallbackName: 'rule.far' });
  ctcFstDecoderConfig.graph = await materializeAssetToFs(Module, ctcFstDecoderConfig.graph, { fallbackName: 'graph.fst' });

  modelConfig.transducer = transducer;
  modelConfig.paraformer = paraformer;
  modelConfig.zipformer2Ctc = zipformer2Ctc;
  modelConfig.nemoCtc = nemoCtc;
  modelConfig.toneCtc = toneCtc;
  config.modelConfig = modelConfig;
  config.ctcFstDecoderConfig = ctcFstDecoderConfig;

  return config;
}

async function initializeRuntime(runtimeConfig, recognizerConfig) {
  if (!runtimeConfig.asrScriptUrl) {
    throw new Error('Missing LocalNeural.Runtime.AsrScriptUrl');
  }
  if (!runtimeConfig.runtimeModuleUrl) {
    throw new Error('Missing LocalNeural.Runtime.MainURL');
  }

  await new Promise<void>((resolve, reject) => {
    try {
      self.Module = {
        locateFile: makeLocateFile(runtimeConfig),
        onRuntimeInitialized() {
          (async () => {
            if (typeof self.createOnlineRecognizer !== 'function') {
              throw new Error('createOnlineRecognizer() not found after loading Sherpa runtime');
            }
            const preparedConfig = await materializeRecognizerConfig(self.Module, recognizerConfig);
            recognizer = self.createOnlineRecognizer(self.Module, preparedConfig);
            if (!recognizer || !recognizer.handle) {
              throw new Error('Sherpa online recognizer creation failed');
            }
            expectedSampleRate = recognizer?.config?.featConfig?.sampleRate || preparedConfig?.featConfig?.sampleRate || 16000;
            tailPaddingSeconds = Number.isFinite(runtimeConfig.tailPaddingSeconds) ? runtimeConfig.tailPaddingSeconds : 0.4;
            resetStream();
            runtimeReady = true;
            resolve();
          })().catch(reject);
        },
      };

      importScripts(runtimeConfig.asrScriptUrl);
      importScripts(runtimeConfig.runtimeModuleUrl);
    } catch (error) {
      reject(error);
    }
  });
}

self.onmessage = async (event: RTCLocalAny) => {
  const data = event.data || {};
  try {
    switch (data.type) {
      case 'init': {
        await initializeRuntime(data.runtimeConfig || {}, data.recognizerConfig || {});
        postMessageSafe('ready', { sampleRate: expectedSampleRate });
        break;
      }

      case 'startUtterance': {
        if (!runtimeReady) throw new Error('Local neural ASR runtime is not ready');
        resetStream();
        lastDecodedText = '';
        postMessageSafe('utteranceStarted', { utteranceId: data.utteranceId || '' });
        break;
      }

      case 'audio': {
        if (!runtimeReady || !stream) break;
        const samples = data.samples instanceof Float32Array ? data.samples : new Float32Array(data.samples || []);
        if (!samples.length) break;
        stream.acceptWaveform(data.sampleRate || expectedSampleRate, samples);
        const result = decodeCurrentStream();
        postMessageSafe('partial', { text: (result.text || '').trim() });
        break;
      }

      case 'finishUtterance': {
        if (!runtimeReady || !stream) break;
        const paddingSeconds = Number.isFinite(data.tailPaddingSeconds) ? data.tailPaddingSeconds : tailPaddingSeconds;
        if (paddingSeconds > 0) {
          stream.acceptWaveform(expectedSampleRate, new Float32Array(Math.max(1, Math.floor(expectedSampleRate * paddingSeconds))));
        }
        stream.inputFinished();
        const result = decodeCurrentStream();
        postMessageSafe('final', { text: (result.text || '').trim() || lastDecodedText });
        postMessageSafe('utteranceFinished', { utteranceId: data.utteranceId || '' });
        if (recognizer && typeof recognizer.reset === 'function') {
          recognizer.reset(stream);
        } else {
          resetStream();
        }
        lastDecodedText = '';
        break;
      }

      case 'dispose': {
        destroyStream();
        if (recognizer && typeof recognizer.free === 'function') {
          try { recognizer.free(); } catch (_) {}
        }
        recognizer = null;
        runtimeReady = false;
        self.close();
        break;
      }
    }
  } catch (error) {
    postMessageSafe('error', {
      message: error?.message || String(error),
      fatal: data.type === 'init',
    });
  }
};
`;
}

function buildSherpaOfflineWhisperWorkerSource() {
  return `
let recognizer = null;
let runtimeReady = false;
let assetSequence = 0;
let expectedSampleRate = 16000;

function postMessageSafe(type, payload = {}) {
  self.postMessage({ type, ...payload });
}

function isMaterializableAssetUrl(value) {
  return typeof value === 'string' && /^(blob:|https?:|data:)/i.test(value);
}

function sanitizeAssetName(value, fallback) {
  const base = String(value || fallback || 'asset.bin').split('?')[0].split('#')[0];
  const name = base.split('/').pop() || fallback || 'asset.bin';
  return name.replace(/[^a-zA-Z0-9._-]+/g, '_');
}

function ensureFsDir(Module, filePath) {
  const parts = String(filePath || '').split('/').filter(Boolean);
  if (parts.length < 2) return;
  const directoryPath = parts.slice(0, -1).join('/');

  if (typeof Module.FS_createPath === 'function') {
    try {
      Module.FS_createPath('/', directoryPath, true, true);
      return;
    } catch (_) {}
  }

  const fsApi = self.FS || Module.FS;
  if (!fsApi || typeof fsApi.mkdir !== 'function') return;

  let current = '';
  for (let index = 0; index < parts.length - 1; index++) {
    current += '/' + parts[index];
    try {
      fsApi.mkdir(current);
    } catch (_) {}
  }
}

function writeAssetToFs(Module, virtualPath, bytes) {
  const normalizedPath = String(virtualPath || '');
  const lastSlash = normalizedPath.lastIndexOf('/');
  const parentDir = lastSlash > 0 ? normalizedPath.slice(0, lastSlash) : '/';
  const fileName = lastSlash >= 0 ? normalizedPath.slice(lastSlash + 1) : normalizedPath;

  if (typeof Module.FS_createDataFile === 'function') {
    try {
      if (typeof Module.FS_unlink === 'function') {
        try { Module.FS_unlink(normalizedPath); } catch (_) {}
      }
      Module.FS_createDataFile(parentDir, fileName, bytes, true, true, true);
      return;
    } catch (_) {}
  }

  const fsApi = self.FS || Module.FS;
  if (fsApi && typeof fsApi.writeFile === 'function') {
    fsApi.writeFile(normalizedPath, bytes, { canOwn: true });
    return;
  }

  throw new Error('Whisper runtime filesystem API is unavailable');
}

async function fetchAssetBytes(url, { asText = false } = {}) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error('Failed to fetch Whisper asset: ' + url + ' (' + response.status + ')');
  }
  if (asText) {
    return new TextEncoder().encode(await response.text());
  }
  return new Uint8Array(await response.arrayBuffer());
}

async function materializeAssetToFs(Module, url, { asText = false, fallbackName = 'asset.bin' } = {}) {
  if (!isMaterializableAssetUrl(url)) return url;
  const fileName = sanitizeAssetName(url, fallbackName);
  const virtualPath = '/keepwork-whisper-assets/' + (++assetSequence) + '-' + fileName;
  ensureFsDir(Module, virtualPath);
  const bytes = await fetchAssetBytes(url, { asText });
  writeAssetToFs(Module, virtualPath, bytes);
  return virtualPath;
}

function makeLocateFile(runtimeConfig) {
  return function locateFile(path) {
    if (/\.wasm$/i.test(path) && runtimeConfig.wasmBinaryUrl) return runtimeConfig.wasmBinaryUrl;
    if (/\.data$/i.test(path) && runtimeConfig.wasmDataUrl) return runtimeConfig.wasmDataUrl;
    if (runtimeConfig.runtimeModuleUrl) {
      return new URL(path, runtimeConfig.runtimeModuleUrl).toString();
    }
    return path;
  };
}

async function materializeRecognizerConfig(Module, recognizerConfig) {
  const config = JSON.parse(JSON.stringify(recognizerConfig || {}));
  const modelConfig = config.modelConfig || {};
  const whisper = modelConfig.whisper || {};

  whisper.encoder = await materializeAssetToFs(Module, whisper.encoder, { fallbackName: 'whisper-encoder.onnx' });
  whisper.decoder = await materializeAssetToFs(Module, whisper.decoder, { fallbackName: 'whisper-decoder.onnx' });
  modelConfig.tokens = await materializeAssetToFs(Module, modelConfig.tokens, { asText: true, fallbackName: 'tokens.txt' });

  modelConfig.whisper = whisper;
  config.modelConfig = modelConfig;

  return config;
}

async function initializeRuntime(runtimeConfig, recognizerConfig) {
  if (!runtimeConfig.asrScriptUrl) {
    throw new Error('Missing Whisper.Runtime.AsrScriptUrl');
  }
  if (!runtimeConfig.runtimeModuleUrl) {
    throw new Error('Missing Whisper.Runtime.MainURL');
  }

  await new Promise<void>((resolve, reject) => {
    try {
      self.Module = {
        locateFile: makeLocateFile(runtimeConfig),
        onRuntimeInitialized() {
          (async () => {
            if (typeof self.OfflineRecognizer !== 'function') {
              throw new Error('OfflineRecognizer class not found after loading Sherpa runtime');
            }
            const preparedConfig = await materializeRecognizerConfig(self.Module, recognizerConfig);
            recognizer = new self.OfflineRecognizer(preparedConfig, self.Module);
            if (!recognizer || !recognizer.handle) {
              throw new Error('Sherpa offline Whisper recognizer creation failed');
            }
            expectedSampleRate = preparedConfig?.featConfig?.sampleRate || 16000;
            runtimeReady = true;
            resolve();
          })().catch(reject);
        },
      };

      importScripts(runtimeConfig.asrScriptUrl);
      // Class declarations are lexically scoped and do not become
      // properties of the global object (unlike function declarations).
      // Promote OfflineRecognizer onto self so the rest of the worker
      // can access it via self.OfflineRecognizer.
      if (typeof OfflineRecognizer === 'function' && !self.OfflineRecognizer) {
        self.OfflineRecognizer = OfflineRecognizer;
      }
      importScripts(runtimeConfig.runtimeModuleUrl);
    } catch (error) {
      reject(error);
    }
  });
}

async function decodeUtterance(data) {
  if (!runtimeReady || !recognizer) {
    throw new Error('Whisper runtime is not ready');
  }

  const utteranceId = data.utteranceId || '';
  const samples = data.samples instanceof Float32Array ? data.samples : new Float32Array(data.samples || []);
  if (!samples.length) {
    postMessageSafe('final', { text: '', utteranceId });
    postMessageSafe('utteranceFinished', { utteranceId });
    return;
  }

  let stream = null;
  try {
    stream = recognizer.createStream();
    if (!stream || !stream.handle) {
      throw new Error('Failed to create Whisper stream');
    }
    stream.acceptWaveform(data.sampleRate || expectedSampleRate, samples);
    recognizer.decode(stream);
    const result = recognizer.getResult(stream) || { text: '' };
    postMessageSafe('final', {
      text: (result.text || '').trim(),
      utteranceId,
    });
    postMessageSafe('utteranceFinished', { utteranceId });
  } finally {
    if (stream && typeof stream.free === 'function') {
      try { stream.free(); } catch (_) {}
    }
  }
}

self.onmessage = async (event: RTCLocalAny) => {
  const data = event.data || {};
  try {
    switch (data.type) {
      case 'init': {
        await initializeRuntime(data.runtimeConfig || {}, data.recognizerConfig || {});
        postMessageSafe('ready', { sampleRate: expectedSampleRate });
        break;
      }

      case 'decodeUtterance': {
        await decodeUtterance(data);
        break;
      }

      case 'dispose': {
        if (recognizer && typeof recognizer.free === 'function') {
          try { recognizer.free(); } catch (_) {}
        }
        recognizer = null;
        runtimeReady = false;
        self.close();
        break;
      }
    }
  } catch (error) {
    postMessageSafe('error', {
      message: error?.message || String(error),
      fatal: data.type === 'init',
      utteranceId: data.utteranceId || '',
    });
  }
};
`;
}

function buildSherpaTTSWorkerSource() {
  return `
let tts = null;
let runtimeReady = false;
let assetSequence = 0;

function postMessageSafe(type, payload = {}) {
  self.postMessage({ type, ...payload });
}

function makeLocateFile(runtimeConfig) {
  return function locateFile(path) {
    if (/\.wasm$/i.test(path) && runtimeConfig.wasmBinaryUrl) return runtimeConfig.wasmBinaryUrl;
    if (/\.data$/i.test(path) && runtimeConfig.wasmDataUrl) return runtimeConfig.wasmDataUrl;
    if (runtimeConfig.runtimeModuleUrl) {
      return new URL(path, runtimeConfig.runtimeModuleUrl).toString();
    }
    return path;
  };
}

function destroyTts() {
  if (tts && typeof tts.free === 'function') {
    try { tts.free(); } catch (_) {}
  }
  tts = null;
}

function isMaterializableAssetUrl(value) {
  return typeof value === 'string' && /^(blob:|https?:|data:)/i.test(value);
}

function sanitizeAssetName(value, fallback) {
  const base = String(value || fallback || 'asset.bin').split('?')[0].split('#')[0];
  const name = base.split('/').pop() || fallback || 'asset.bin';
  return name.replace(/[^a-zA-Z0-9._-]+/g, '_');
}

function ensureFsDir(Module, filePath) {
  const parts = String(filePath || '').split('/').filter(Boolean);
  if (parts.length < 2) return;
  const directoryPath = parts.slice(0, -1).join('/');

  if (typeof Module.FS_createPath === 'function') {
    try {
      Module.FS_createPath('/', directoryPath, true, true);
      return;
    } catch (_) {}
  }

  const fsApi = self.FS || Module.FS;
  if (!fsApi || typeof fsApi.mkdir !== 'function') return;

  let current = '';
  for (let index = 0; index < parts.length - 1; index++) {
    current += '/' + parts[index];
    try {
      fsApi.mkdir(current);
    } catch (_) {}
  }
}

function writeAssetToFs(Module, virtualPath, bytes) {
  const normalizedPath = String(virtualPath || '');
  const lastSlash = normalizedPath.lastIndexOf('/');
  const parentDir = lastSlash > 0 ? normalizedPath.slice(0, lastSlash) : '/';
  const fileName = lastSlash >= 0 ? normalizedPath.slice(lastSlash + 1) : normalizedPath;

  if (typeof Module.FS_createDataFile === 'function') {
    try {
      if (typeof Module.FS_unlink === 'function') {
        try { Module.FS_unlink(normalizedPath); } catch (_) {}
      }
      Module.FS_createDataFile(parentDir, fileName, bytes, true, true, true);
      return;
    } catch (_) {}
  }

  const fsApi = self.FS || Module.FS;
  if (fsApi && typeof fsApi.writeFile === 'function') {
    fsApi.writeFile(normalizedPath, bytes, { canOwn: true });
    return;
  }

  throw new Error('Sherpa TTS runtime filesystem API is unavailable');
}

async function fetchAssetBytes(url, { asText = false } = {}) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error('Failed to fetch TTS asset: ' + url + ' (' + response.status + ')');
  }
  if (asText) {
    return new TextEncoder().encode(await response.text());
  }
  return new Uint8Array(await response.arrayBuffer());
}

async function materializeAssetToFs(Module, url, { asText = false, fallbackName = 'asset.bin' } = {}) {
  if (!isMaterializableAssetUrl(url)) return url;
  const fileName = sanitizeAssetName(url, fallbackName);
  const virtualPath = '/keepwork-tts-assets/' + (++assetSequence) + '-' + fileName;
  ensureFsDir(Module, virtualPath);
  const bytes = await fetchAssetBytes(url, { asText });
  writeAssetToFs(Module, virtualPath, bytes);
  return virtualPath;
}

async function materializeCsvAssetList(Module, value, { asText = false, fallbackPrefix = 'asset' } = {}) {
  const list = String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
  if (!list.length) return '';
  const resolved = [];
  for (let index = 0; index < list.length; index++) {
    resolved.push(await materializeAssetToFs(Module, list[index], {
      asText,
      fallbackName: fallbackPrefix + '-' + index,
    }));
  }
  return resolved.join(',');
}

async function materializeOfflineTtsConfig(Module, offlineTtsConfig) {
  const config = JSON.parse(JSON.stringify(offlineTtsConfig || {}));
  const modelConfig = config.offlineTtsModelConfig || {};
  const vits = modelConfig.offlineTtsVitsModelConfig || {};
  const matcha = modelConfig.offlineTtsMatchaModelConfig || {};
  const kokoro = modelConfig.offlineTtsKokoroModelConfig || {};

  vits.model = await materializeAssetToFs(Module, vits.model, { fallbackName: 'model.onnx' });
  vits.lexicon = await materializeAssetToFs(Module, vits.lexicon, { asText: true, fallbackName: 'lexicon.txt' });
  vits.tokens = await materializeAssetToFs(Module, vits.tokens, { asText: true, fallbackName: 'tokens.txt' });

  matcha.acousticModel = await materializeAssetToFs(Module, matcha.acousticModel, { fallbackName: 'acoustic-model.onnx' });
  matcha.vocoder = await materializeAssetToFs(Module, matcha.vocoder, { fallbackName: 'vocoder.onnx' });
  matcha.lexicon = await materializeAssetToFs(Module, matcha.lexicon, { asText: true, fallbackName: 'lexicon.txt' });
  matcha.tokens = await materializeAssetToFs(Module, matcha.tokens, { asText: true, fallbackName: 'tokens.txt' });

  kokoro.model = await materializeAssetToFs(Module, kokoro.model, { fallbackName: 'model.onnx' });
  kokoro.voices = await materializeAssetToFs(Module, kokoro.voices, { fallbackName: 'voices.bin' });
  kokoro.tokens = await materializeAssetToFs(Module, kokoro.tokens, { asText: true, fallbackName: 'tokens.txt' });
  kokoro.lexicon = await materializeCsvAssetList(Module, kokoro.lexicon, { asText: true, fallbackPrefix: 'lexicon' });

  modelConfig.offlineTtsVitsModelConfig = vits;
  modelConfig.offlineTtsMatchaModelConfig = matcha;
  modelConfig.offlineTtsKokoroModelConfig = kokoro;
  config.offlineTtsModelConfig = modelConfig;
  config.ruleFsts = await materializeCsvAssetList(Module, config.ruleFsts, { fallbackPrefix: 'rule-fst' });
  config.ruleFars = await materializeAssetToFs(Module, config.ruleFars, { fallbackName: 'rule.far' });
  return config;
}

async function initializeRuntime(runtimeConfig, offlineTtsConfig) {
  if (!runtimeConfig.ttsScriptUrl) {
    throw new Error('Missing LocalNeuralTTS.Runtime.TtsScriptUrl');
  }
  if (!runtimeConfig.runtimeModuleUrl) {
    throw new Error('Missing LocalNeuralTTS.Runtime.MainURL');
  }

  await new Promise<void>((resolve, reject) => {
    try {
      self.Module = {
        locateFile: makeLocateFile(runtimeConfig),
        onRuntimeInitialized() {
          (async () => {
            if (typeof self.createOfflineTts !== 'function') {
              throw new Error('createOfflineTts() not found after loading Sherpa TTS runtime');
            }
            const preparedConfig = await materializeOfflineTtsConfig(self.Module, offlineTtsConfig);
            tts = self.createOfflineTts(self.Module, preparedConfig);
            if (!tts || !tts.handle) {
              throw new Error('Sherpa offline TTS creation failed');
            }
            runtimeReady = true;
            resolve();
          })().catch(reject);
        },
      };

      importScripts(runtimeConfig.ttsScriptUrl);
      importScripts(runtimeConfig.runtimeModuleUrl);
    } catch (error) {
      reject(error);
    }
  });
}

self.onmessage = async (event: RTCLocalAny) => {
  const data = event.data || {};
  try {
    switch (data.type) {
      case 'init': {
        await initializeRuntime(data.runtimeConfig || {}, data.offlineTtsConfig || {});
        postMessageSafe('ready', {
          sampleRate: tts?.sampleRate || 0,
          numSpeakers: tts?.numSpeakers || 0,
        });
        break;
      }

      case 'synthesize': {
        if (!runtimeReady || !tts) throw new Error('Local neural TTS runtime is not ready');
        const requestId = data.requestId || '';
        const text = String(data.text || '').trim();
        if (!text) {
          postMessageSafe('synthesized', {
            requestId,
            samples: new Float32Array(0),
            sampleRate: tts.sampleRate || 0,
          });
          break;
        }

        const result = data.generationConfig
          ? tts.generateWithConfig(text, data.generationConfig)
          : tts.generate({ text, sid: 0, speed: 1.0 });

        postMessageSafe('synthesized', {
          requestId,
          samples: result.samples || new Float32Array(0),
          sampleRate: result.sampleRate || tts.sampleRate || 0,
        });
        break;
      }

      case 'dispose': {
        destroyTts();
        runtimeReady = false;
        self.close();
        break;
      }
    }
  } catch (error) {
    postMessageSafe('error', {
      requestId: data.requestId || '',
      message: error?.message || String(error),
      fatal: data.type === 'init',
    });
  }
};
`;
}

class BaseASRBackend {
  session: RTCLocalAny;
  config: RTCLocalAny;
  name: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;

  constructor(session: RTCLocalAny, config: RTCLocalAny = {}) {
    this.session = session;
    this.config = config;
    this.name = 'base';
  }

  async initialize(): Promise<void> {}
  async startUtterance(): Promise<void> {}
  async submitBufferedAudio(..._args: unknown[]): Promise<void> {}
  async stopUtterance(): Promise<void> {}
  async attachMediaStream(..._args: unknown[]): Promise<void> {}
  async destroy(): Promise<void> {}
}

class WebSpeechASRBackend extends BaseASRBackend {
  constructor(session: RTCLocalAny, config: RTCLocalAny = {}) {
    super(session, config);
    this.name = ASR_PROVIDER.WEB_SPEECH;
    this._recognition = null;
    this._finalText = '';
  }

  override async initialize() {
    const SpeechRecognition = _win.SpeechRecognition || _win.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      throw new Error('SpeechRecognition API not available in this browser. Use Chrome or Edge.');
    }

    this._recognition = new (SpeechRecognition as { new (): RTCLocalAny })();
    this._recognition.lang = this.config.Language || 'zh-CN';
    this._recognition.interimResults = true;
    this._recognition.continuous = false;
    this._recognition.maxAlternatives = 1;

    this._recognition.onresult = (event: RTCLocalAny) => {
      if (!this.session.isActive) return;
      let interim = '';
      let final = '';
      for (let index = event.resultIndex; index < event.results.length; index++) {
        const transcript = event.results[index][0]?.transcript || '';
        if (event.results[index].isFinal) {
          final += transcript;
        } else {
          interim += transcript;
        }
      }

      if (final) {
        this._finalText += final;
        this.session._handleASRFinalText(this._finalText);
      }
      if (interim) {
        this.session._handleASRInterimText(this._finalText + interim);
      }
    };

    this._recognition.onerror = (event: RTCLocalAny) => {
      if (event.error === 'no-speech' || event.error === 'aborted') return;
      console.warn('[LocalRTCSession] SpeechRecognition error:', event.error);
      const message = event.error === 'not-allowed'
        ? 'Microphone permission denied for speech recognition'
        : `SpeechRecognition error: ${event.error}`;
      this.session._handleASRError(message, { fatal: false });
    };

    this._recognition.onend = () => {
      this.session._handleASRUtteranceEnd();
    };
  }

  override async startUtterance() {
    if (!this._recognition || !this.session.isActive) return;
    this._finalText = '';
    try {
      this._recognition.start();
    } catch (error) {
      if ((error as Error)?.message && (error as Error).message.includes('already started')) return;
      throw error;
    }
  }

  override async stopUtterance() {
    if (!this._recognition) return;
    try {
      this._recognition.stop();
    } catch (_) {}
  }

  override async destroy() {
    if (!this._recognition) return;
    try { this._recognition.abort(); } catch (_) {}
    this._recognition = null;
    this._finalText = '';
  }
}

class WhisperASRBackend extends BaseASRBackend {
  constructor(session: RTCLocalAny, config: RTCLocalAny = {}) {
    super(session, config);
    this.name = ASR_PROVIDER.WHISPER;
    this._worker = null;
    this._workerUrl = '';
    this._readyPromise = null;
    this._expectedSampleRate = DEFAULT_WHISPER_ASR.sampleRate;
    this._utteranceActive = false;
    this._currentUtteranceId = '';
    this._pendingSamples = new Float32Array(0);
  }

  override async initialize() {
    if (typeof Worker === 'undefined') {
      throw new Error('Worker API not available for Whisper ASR');
    }

    const resolved = await this._resolveRuntimeConfig();
    this._expectedSampleRate = (resolved.recognizerConfig as RTCLocalAny)?.featConfig?.sampleRate || DEFAULT_WHISPER_ASR.sampleRate;

    this._workerUrl = URL.createObjectURL(new Blob([buildSherpaOfflineWhisperWorkerSource()], { type: 'application/javascript' }));
    this._worker = new Worker(this._workerUrl);

    this._readyPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timed out while loading Whisper ASR runtime'));
      }, resolved.initTimeoutMs);

      this._worker.onmessage = (event: RTCLocalAny) => {
        const data = event.data || {};
        if (data.type === 'ready') {
          clearTimeout(timeout);
          this._expectedSampleRate = data.sampleRate || this._expectedSampleRate;
          this.session._emitASRStatus('ready', {
            provider: this.name,
            sampleRate: this._expectedSampleRate,
          });
          resolve();
          return;
        }

        if (data.type === 'final') {
          this.session._handleASRFinalText(data.text || '');
          return;
        }

        if (data.type === 'utteranceFinished') {
          this._utteranceActive = false;
          this.session._handleASRUtteranceEnd();
          return;
        }

        if (data.type === 'error') {
          const error = new Error(data.message || 'Whisper ASR failed');
          this._utteranceActive = false;
          if (data.fatal) {
            clearTimeout(timeout);
            reject(error);
          } else {
            this.session._handleASRError(error.message, { fatal: false });
          }
        }
      };

      this._worker.onerror = (event: RTCLocalAny) => {
        clearTimeout(timeout);
        reject(new Error(event.message || 'Whisper ASR worker crashed'));
      };
    });

    this.session._emitASRStatus('loading', { provider: this.name });
    this._worker.postMessage({
      type: 'init',
      runtimeConfig: resolved.runtimeConfig,
      recognizerConfig: resolved.recognizerConfig,
    });

    await this._readyPromise;
  }

  async _resolveRuntimeConfig() {
    const localConfig = {
      ...DEFAULT_WHISPER_ASR,
      ...(this.config.ProviderParams || {}),
      ...(this.config.Whisper || {}),
      ...(this.config.LocalWhisper || {}),
      ...(this.config.Runtime || {}),
      ...this.config,
    };

    const presetId = normalizeWhisperPreset(
      localConfig.Preset || localConfig.preset || localConfig.PresetId || localConfig.presetId,
    ) || DEFAULT_WHISPER_PRESET;
    const preset = LOCAL_WHISPER_ASR_PRESETS[presetId] || null;
    const assetBaseUrl = trimTrailingSlash(
      localConfig.AssetBaseURL
      || localConfig.assetBaseUrl
      || localConfig.BaseAssetURL
      || localConfig.baseAssetUrl
      || DEFAULT_LOCAL_NEURAL_ASSET_BASE,
    );
    const mergedConfig = {
      ...(preset || {}),
      ...localConfig,
    };

    if (preset) {
      mergedConfig.Preset = preset.id;
      mergedConfig.preset = preset.id;
      if (!mergedConfig.RuntimeBaseURL && !mergedConfig.runtimeBaseUrl && !mergedConfig.AsrScriptUrl && !mergedConfig.asrScriptUrl && !mergedConfig.MainURL && !mergedConfig.mainUrl) {
        mergedConfig.RuntimeBaseURL = joinUrl(assetBaseUrl, preset.runtimeBasePath);
      }
      if (!mergedConfig.ModelBaseURL && !mergedConfig.modelBaseUrl && !mergedConfig.BaseURL && !mergedConfig.whisperEncoder && !mergedConfig.whisperDecoder && !mergedConfig.encoder && !mergedConfig.decoder && !mergedConfig.tokens) {
        mergedConfig.ModelBaseURL = joinUrl(assetBaseUrl, preset.modelBasePath);
      }
    }

    const runtimeBaseUrl = trimTrailingSlash(mergedConfig.RuntimeBaseURL || mergedConfig.runtimeBaseUrl || '');
    const modelBaseUrl = trimTrailingSlash(mergedConfig.ModelBaseURL || mergedConfig.modelBaseUrl || mergedConfig.BaseURL || '');
    const resolvedLanguage = resolveWhisperLanguage(
      mergedConfig.Language
      || mergedConfig.language
      || this.session.voiceChatConfig?.ASRConfig?.Language
      || '',
    );

    const runtimeConfig = {
      asrScriptUrl: absolutizeBrowserUrl(mergedConfig.AsrScriptUrl || mergedConfig.asrScriptUrl || joinUrl(runtimeBaseUrl, 'sherpa-onnx-asr.js')),
      runtimeModuleUrl: absolutizeBrowserUrl(mergedConfig.MainURL || mergedConfig.mainUrl || joinUrl(runtimeBaseUrl, 'sherpa-onnx-wasm-main-vad-asr.js')),
      wasmBinaryUrl: absolutizeBrowserUrl(mergedConfig.WasmURL || mergedConfig.wasmUrl || joinUrl(runtimeBaseUrl, 'sherpa-onnx-wasm-main-vad-asr.wasm')),
      wasmDataUrl: absolutizeBrowserUrl(mergedConfig.DataURL || mergedConfig.dataUrl || joinUrl(runtimeBaseUrl, 'sherpa-onnx-wasm-main-vad-asr.data')),
    };

    const recognizerConfig: RTCLocalAny = cloneJSON(mergedConfig.RecognizerConfig || mergedConfig.recognizerConfig) || {
      featConfig: {
        sampleRate: mergedConfig.sampleRate || DEFAULT_WHISPER_ASR.sampleRate,
        featureDim: mergedConfig.featureDim || DEFAULT_WHISPER_ASR.featureDim,
      },
      modelConfig: {
        whisper: {
          encoder: absolutizeBrowserUrl(mergedConfig.whisperEncoder || mergedConfig.WhisperEncoder || mergedConfig.encoder || joinUrl(modelBaseUrl, mergedConfig.encoderFileName || 'tiny-encoder.int8.onnx')),
          decoder: absolutizeBrowserUrl(mergedConfig.whisperDecoder || mergedConfig.WhisperDecoder || mergedConfig.decoder || joinUrl(modelBaseUrl, mergedConfig.decoderFileName || 'tiny-decoder.int8.onnx')),
          language: mergedConfig.whisperLanguage || mergedConfig.WhisperLanguage || resolvedLanguage,
          task: mergedConfig.task || mergedConfig.Task || DEFAULT_WHISPER_ASR.task,
          tailPaddings: Number.isFinite(mergedConfig.tailPaddings) ? mergedConfig.tailPaddings : DEFAULT_WHISPER_ASR.tailPaddings,
          enableTokenTimestamps: mergedConfig.enableTokenTimestamps ? 1 : 0,
          enableSegmentTimestamps: mergedConfig.enableSegmentTimestamps ? 1 : 0,
        },
        tokens: absolutizeBrowserUrl(mergedConfig.tokens || joinUrl(modelBaseUrl, mergedConfig.tokensFileName || 'tiny-tokens.txt')),
        numThreads: mergedConfig.numThreads || DEFAULT_WHISPER_ASR.numThreads,
        provider: mergedConfig.executionProvider || DEFAULT_WHISPER_ASR.executionProvider,
        debug: mergedConfig.debug ? 1 : 0,
        modelType: mergedConfig.modelType || 'whisper',
      },
      decodingMethod: mergedConfig.decodingMethod || DEFAULT_WHISPER_ASR.decodingMethod,
    };

    if (!runtimeConfig.asrScriptUrl || !runtimeConfig.runtimeModuleUrl) {
      throw new Error('Whisper ASR requires RuntimeBaseURL or explicit runtime URLs');
    }

    if (!recognizerConfig?.modelConfig?.tokens) {
      throw new Error('Whisper ASR requires tokens.txt or an explicit RecognizerConfig.modelConfig.tokens');
    }

    if (!recognizerConfig?.modelConfig?.whisper?.encoder || !recognizerConfig?.modelConfig?.whisper?.decoder) {
      throw new Error('Whisper ASR requires encoder and decoder model URLs or an explicit RecognizerConfig');
    }

    const cachedRuntimeConfig = await this._resolveRemoteUrls(runtimeConfig);
    const cachedRecognizerConfig = await this._resolveRemoteUrls(recognizerConfig);

    return {
      runtimeConfig: cachedRuntimeConfig,
      recognizerConfig: cachedRecognizerConfig,
      initTimeoutMs: Number.isFinite(mergedConfig.initTimeoutMs) ? mergedConfig.initTimeoutMs : DEFAULT_WHISPER_ASR.initTimeoutMs,
    };
  }

  async _resolveRemoteUrls(value: unknown): Promise<unknown> {
    if (Array.isArray(value)) {
      return Promise.all(value.map((item) => this._resolveRemoteUrls(item)));
    }
    if (value && typeof value === 'object') {
      const entries = await Promise.all(
        Object.entries(value).map(async ([key, child]) => [key, await this._resolveRemoteUrls(child)]),
      );
      return Object.fromEntries(entries);
    }
    if (typeof value === 'string' && value.includes(',') && !value.startsWith('data:')) {
      const parts = value.split(',').map((part) => part.trim()).filter(Boolean);
      const resolvedParts = await Promise.all(parts.map((part) => this._resolveRemoteUrls(part)));
      return resolvedParts.join(',');
    }
    if (!isRemoteLikeUrl(value)) return value;
    const fileName = sanitizeAssetName(value, 'asset.bin');
    return await this.session.parent._getOrCacheBinaryAssetURL(value, fileName) || value;
  }

  override async startUtterance() {
    this._utteranceActive = true;
    this._currentUtteranceId = `utt_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    this._pendingSamples = new Float32Array(0);
  }

  override async submitBufferedAudio(samples: unknown, sampleRate: number = this._expectedSampleRate) {
    if (!this._utteranceActive) return;
    const pcm = samples instanceof Float32Array ? samples : new Float32Array((samples as number[]) || []);
    if (!pcm.length) return;

    const effectiveSampleRate = Number.isFinite(sampleRate) && sampleRate > 0
      ? sampleRate
      : this._expectedSampleRate;
    const payload = downsampleFloat32(pcm, effectiveSampleRate, this._expectedSampleRate);
    if (!payload.length) return;

    this._pendingSamples = concatFloat32Arrays(this._pendingSamples, payload);
  }

  override async stopUtterance() {
    if (!this._worker) return;
    const payload = this._pendingSamples;
    this._pendingSamples = new Float32Array(0);
    this._worker.postMessage({
      type: 'decodeUtterance',
      utteranceId: this._currentUtteranceId,
      sampleRate: this._expectedSampleRate,
      samples: payload,
    }, payload.length ? [payload.buffer] : []);
  }

  override async destroy() {
    this._utteranceActive = false;
    this._pendingSamples = new Float32Array(0);
    if (this._worker) {
      try { this._worker.postMessage({ type: 'dispose' }); } catch (_) {}
      try { this._worker.terminate(); } catch (_) {}
      this._worker = null;
    }
    if (this._workerUrl) {
      URL.revokeObjectURL(this._workerUrl);
      this._workerUrl = '';
    }
  }
}

class LocalNeuralASRBackend extends BaseASRBackend {
  constructor(session: RTCLocalAny, config: RTCLocalAny = {}) {
    super(session, config);
    this.name = ASR_PROVIDER.LOCAL_NEURAL;
    this._worker = null;
    this._workerUrl = '';
    this._readyPromise = null;
    this._expectedSampleRate = DEFAULT_LOCAL_NEURAL_ASR.sampleRate;
    this._audioContext = null;
    this._sourceNode = null;
    this._processorNode = null;
    this._sinkNode = null;
    this._attachedStream = null;
    this._utteranceActive = false;
    this._currentUtteranceId = '';
  }

  override async initialize() {
    if (typeof Worker === 'undefined') {
      throw new Error('Worker API not available for local neural ASR');
    }
    const resolved = await this._resolveRuntimeConfig();
    this._expectedSampleRate = (resolved.recognizerConfig as RTCLocalAny)?.featConfig?.sampleRate || DEFAULT_LOCAL_NEURAL_ASR.sampleRate;

    this._workerUrl = URL.createObjectURL(new Blob([buildSherpaWorkerSource()], { type: 'application/javascript' }));
    this._worker = new Worker(this._workerUrl);

    this._readyPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timed out while loading local neural ASR runtime'));
      }, resolved.initTimeoutMs);

      this._worker.onmessage = (event: RTCLocalAny) => {
        const data = event.data || {};
        if (data.type === 'ready') {
          clearTimeout(timeout);
          this._expectedSampleRate = data.sampleRate || this._expectedSampleRate;
          this.session._emitASRStatus('ready', {
            provider: this.name,
            sampleRate: this._expectedSampleRate,
          });
          resolve();
          return;
        }

        if (data.type === 'partial') {
          if (this.config.emitPartials !== false) {
            this.session._handleASRInterimText(data.text || '');
          }
          return;
        }

        if (data.type === 'final') {
          this.session._handleASRFinalText(data.text || '');
          return;
        }

        if (data.type === 'utteranceFinished') {
          this._utteranceActive = false;
          this.session._handleASRUtteranceEnd();
          return;
        }

        if (data.type === 'error') {
          const error = new Error(data.message || 'Local neural ASR failed');
          if (data.fatal) {
            clearTimeout(timeout);
            reject(error);
          } else {
            this.session._handleASRError(error.message, { fatal: false });
          }
        }
      };

      this._worker.onerror = (event: RTCLocalAny) => {
        clearTimeout(timeout);
        reject(new Error(event.message || 'Local neural ASR worker crashed'));
      };
    });

    this.session._emitASRStatus('loading', { provider: this.name });
    this._worker.postMessage({
      type: 'init',
      runtimeConfig: resolved.runtimeConfig,
      recognizerConfig: resolved.recognizerConfig,
    });

    await this._readyPromise;
    if (this.session._mediaStream) {
      await this.attachMediaStream(this.session._mediaStream);
    }
  }

  async _resolveRuntimeConfig() {
    const localConfig = {
      ...DEFAULT_LOCAL_NEURAL_ASR,
      ...(this.config.ProviderParams || {}),
      ...(this.config.LocalNeural || {}),
      ...(this.config.Runtime || {}),
      ...this.config,
    };

    const presetId = normalizeLocalNeuralPreset(
      localConfig.Preset || localConfig.preset || localConfig.PresetId || localConfig.presetId,
    ) || DEFAULT_LOCAL_NEURAL_PRESET;
    const preset = LOCAL_NEURAL_ASR_PRESETS[presetId] || null;
    const assetBaseUrl = trimTrailingSlash(
      localConfig.AssetBaseURL
      || localConfig.assetBaseUrl
      || localConfig.BaseAssetURL
      || localConfig.baseAssetUrl
      || DEFAULT_LOCAL_NEURAL_ASSET_BASE,
    );
    const mergedConfig = {
      ...(preset || {}),
      ...localConfig,
    };

    const resolvedSpeakerId = parseOptionalInteger(
      mergedConfig.speakerId ?? mergedConfig.SpeakerId ?? mergedConfig.sid,
    );

    if (preset) {
      mergedConfig.Preset = preset.id;
      mergedConfig.preset = preset.id;
      if (!mergedConfig.RuntimeBaseURL && !mergedConfig.runtimeBaseUrl && !mergedConfig.AsrScriptUrl && !mergedConfig.asrScriptUrl && !mergedConfig.MainURL && !mergedConfig.mainUrl) {
        mergedConfig.RuntimeBaseURL = joinUrl(assetBaseUrl, preset.runtimeBasePath);
      }
      if (!mergedConfig.ModelBaseURL && !mergedConfig.modelBaseUrl && !mergedConfig.BaseURL && !mergedConfig.encoder && !mergedConfig.decoder && !mergedConfig.joiner && !mergedConfig.tokens && !mergedConfig.paraformerEncoder && !mergedConfig.paraformerDecoder) {
        mergedConfig.ModelBaseURL = joinUrl(assetBaseUrl, preset.modelBasePath);
      }
    }

    const runtimeBaseUrl = trimTrailingSlash(mergedConfig.RuntimeBaseURL || mergedConfig.runtimeBaseUrl || '');
    const modelBaseUrl = trimTrailingSlash(mergedConfig.ModelBaseURL || mergedConfig.modelBaseUrl || mergedConfig.BaseURL || '');
    const modelFamily = String(mergedConfig.modelFamily || mergedConfig.ModelFamily || 'transducer').toLowerCase();

    const runtimeConfig = {
      asrScriptUrl: absolutizeBrowserUrl(mergedConfig.AsrScriptUrl || mergedConfig.asrScriptUrl || joinUrl(runtimeBaseUrl, 'sherpa-onnx-asr.js')),
      runtimeModuleUrl: absolutizeBrowserUrl(mergedConfig.MainURL || mergedConfig.mainUrl || joinUrl(runtimeBaseUrl, 'sherpa-onnx-wasm-main-asr.js')),
      wasmBinaryUrl: absolutizeBrowserUrl(mergedConfig.WasmURL || mergedConfig.wasmUrl || joinUrl(runtimeBaseUrl, 'sherpa-onnx-wasm-main-asr.wasm')),
      wasmDataUrl: absolutizeBrowserUrl(mergedConfig.DataURL || mergedConfig.dataUrl || joinUrl(runtimeBaseUrl, 'sherpa-onnx-wasm-main-asr.data')),
      tailPaddingSeconds: Number.isFinite(mergedConfig.tailPaddingSeconds) ? mergedConfig.tailPaddingSeconds : DEFAULT_LOCAL_NEURAL_ASR.tailPaddingSeconds,
    };

    const recognizerConfig: RTCLocalAny = cloneJSON(mergedConfig.RecognizerConfig || mergedConfig.recognizerConfig) || {
      featConfig: {
        sampleRate: mergedConfig.sampleRate || DEFAULT_LOCAL_NEURAL_ASR.sampleRate,
        featureDim: mergedConfig.featureDim || DEFAULT_LOCAL_NEURAL_ASR.featureDim,
      },
      modelConfig: {
        transducer: {
          encoder: modelFamily === 'transducer'
            ? absolutizeBrowserUrl(mergedConfig.encoder || joinUrl(modelBaseUrl, mergedConfig.encoderFileName || 'encoder-epoch-99-avg-1.int8.onnx'))
            : '',
          decoder: modelFamily === 'transducer'
            ? absolutizeBrowserUrl(mergedConfig.decoder || joinUrl(modelBaseUrl, mergedConfig.decoderFileName || 'decoder-epoch-99-avg-1.onnx'))
            : '',
          joiner: modelFamily === 'transducer'
            ? absolutizeBrowserUrl(mergedConfig.joiner || joinUrl(modelBaseUrl, mergedConfig.joinerFileName || 'joiner-epoch-99-avg-1.int8.onnx'))
            : '',
        },
        paraformer: {
          encoder: modelFamily === 'paraformer'
            ? absolutizeBrowserUrl(mergedConfig.paraformerEncoder || joinUrl(modelBaseUrl, mergedConfig.paraformerEncoderFileName || 'encoder.int8.onnx'))
            : '',
          decoder: modelFamily === 'paraformer'
            ? absolutizeBrowserUrl(mergedConfig.paraformerDecoder || joinUrl(modelBaseUrl, mergedConfig.paraformerDecoderFileName || 'decoder.int8.onnx'))
            : '',
        },
        zipformer2Ctc: {
          model: absolutizeBrowserUrl(mergedConfig.zipformer2CtcModel || ''),
        },
        nemoCtc: {
          model: absolutizeBrowserUrl(mergedConfig.nemoCtcModel || ''),
        },
        toneCtc: {
          model: absolutizeBrowserUrl(mergedConfig.toneCtcModel || ''),
        },
        tokens: absolutizeBrowserUrl(mergedConfig.tokens || joinUrl(modelBaseUrl, mergedConfig.tokensFileName || 'tokens.txt')),
        numThreads: mergedConfig.numThreads || DEFAULT_LOCAL_NEURAL_ASR.numThreads,
        provider: mergedConfig.executionProvider || DEFAULT_LOCAL_NEURAL_ASR.executionProvider,
        debug: mergedConfig.debug ? 1 : 0,
        modelType: mergedConfig.modelType || '',
        modelingUnit: mergedConfig.modelingUnit || DEFAULT_LOCAL_NEURAL_ASR.modelingUnit,
        bpeVocab: absolutizeBrowserUrl(mergedConfig.bpeVocab || ''),
      },
      decodingMethod: mergedConfig.decodingMethod || DEFAULT_LOCAL_NEURAL_ASR.decodingMethod,
      maxActivePaths: Number.isFinite(mergedConfig.maxActivePaths) ? mergedConfig.maxActivePaths : 4,
      enableEndpoint: mergedConfig.enableEndpoint === false ? 0 : 1,
      rule1MinTrailingSilence: Number.isFinite(mergedConfig.rule1MinTrailingSilence) ? mergedConfig.rule1MinTrailingSilence : 2.4,
      rule2MinTrailingSilence: Number.isFinite(mergedConfig.rule2MinTrailingSilence) ? mergedConfig.rule2MinTrailingSilence : 1.2,
      rule3MinUtteranceLength: Number.isFinite(mergedConfig.rule3MinUtteranceLength) ? mergedConfig.rule3MinUtteranceLength : 20,
      hotwordsFile: absolutizeBrowserUrl(mergedConfig.hotwordsFile || ''),
      hotwordsScore: Number.isFinite(mergedConfig.hotwordsScore) ? mergedConfig.hotwordsScore : 1.5,
      ctcFstDecoderConfig: {
        graph: absolutizeBrowserUrl(mergedConfig.graph || ''),
        maxActive: Number.isFinite(mergedConfig.ctcMaxActive) ? mergedConfig.ctcMaxActive : 3000,
      },
      ruleFsts: absolutizeBrowserUrl(mergedConfig.ruleFsts || ''),
      ruleFars: absolutizeBrowserUrl(mergedConfig.ruleFars || ''),
    };

    if (!runtimeConfig.asrScriptUrl || !runtimeConfig.runtimeModuleUrl) {
      throw new Error('Local neural ASR requires RuntimeBaseURL or explicit runtime URLs');
    }

    if (!recognizerConfig?.modelConfig?.tokens) {
      throw new Error('Local neural ASR requires tokens.txt or an explicit RecognizerConfig.modelConfig.tokens');
    }

    if (!recognizerConfig?.modelConfig?.transducer?.encoder && !recognizerConfig?.modelConfig?.paraformer?.encoder && !recognizerConfig?.modelConfig?.zipformer2Ctc?.model && !recognizerConfig?.modelConfig?.nemoCtc?.model && !recognizerConfig?.modelConfig?.toneCtc?.model) {
      throw new Error('Local neural ASR requires model URLs or an explicit RecognizerConfig');
    }

    const cachedRuntimeConfig = await this._resolveRemoteUrls(runtimeConfig);
    const cachedRecognizerConfig = await this._resolveRemoteUrls(recognizerConfig);

    return {
      runtimeConfig: cachedRuntimeConfig,
      recognizerConfig: cachedRecognizerConfig,
      initTimeoutMs: Number.isFinite(mergedConfig.initTimeoutMs) ? mergedConfig.initTimeoutMs : DEFAULT_LOCAL_NEURAL_ASR.initTimeoutMs,
    };
  }

  async _resolveRemoteUrls(value: unknown): Promise<unknown> {
    if (Array.isArray(value)) {
      return Promise.all(value.map((item) => this._resolveRemoteUrls(item)));
    }
    if (value && typeof value === 'object') {
      const entries = await Promise.all(
        Object.entries(value).map(async ([key, child]) => [key, await this._resolveRemoteUrls(child)]),
      );
      return Object.fromEntries(entries);
    }
    if (typeof value === 'string' && value.includes(',') && !value.startsWith('data:')) {
      const parts = value.split(',').map((item) => item.trim()).filter(Boolean);
      if (parts.length > 1 && parts.every((item) => isRemoteLikeUrl(item))) {
        const resolvedParts = await Promise.all(parts.map((item) => this._resolveRemoteUrls(item)));
        return resolvedParts.join(',');
      }
    }
    if (!isRemoteLikeUrl(value)) return value;
    if (!this.session.parent.cacheBinaryAssetsToIndexedDB) return value;

    const fileName = (() => {
      try {
        return new URL(value as string).pathname.split('/').pop() || 'asset.bin';
      } catch (_) {
        return 'asset.bin';
      }
    })();

    return await this.session.parent._getOrCacheBinaryAssetURL(value, fileName) || value;
  }

  override async attachMediaStream(stream: RTCLocalAny) {
    if (this._attachedStream === stream) return;
    await this._teardownAudioTap();
    this._attachedStream = stream || null;
    if (!stream) return;

    const AudioContextCtor = _win.AudioContext || _win.webkitAudioContext;
    if (!AudioContextCtor) {
      throw new Error('Web Audio API not available for local neural ASR');
    }

    this._audioContext = new (AudioContextCtor as { new (o?: unknown): RTCLocalAny })();
    try {
      await this._audioContext.resume();
    } catch (_) {}

    this._sourceNode = this._audioContext.createMediaStreamSource(stream);
    this._processorNode = this._audioContext.createScriptProcessor(this.config.bufferSize || DEFAULT_LOCAL_NEURAL_ASR.bufferSize, 1, 1);
    this._sinkNode = this._audioContext.createGain();
    this._sinkNode.gain.value = 0;

    this._processorNode.onaudioprocess = (event: RTCLocalAny) => {
      if (!this._worker || !this._utteranceActive) return;
      const input = event.inputBuffer.getChannelData(0);
      const downsampled = downsampleFloat32(input, this._audioContext.sampleRate, this._expectedSampleRate);
      if (!downsampled.length) return;
      this._worker.postMessage({
        type: 'audio',
        sampleRate: this._expectedSampleRate,
        samples: downsampled,
      }, [downsampled.buffer]);
    };

    this._sourceNode.connect(this._processorNode);
    this._processorNode.connect(this._sinkNode);
    this._sinkNode.connect(this._audioContext.destination);
  }

  async _teardownAudioTap() {
    if (this._processorNode) {
      try { this._processorNode.disconnect(); } catch (_) {}
      this._processorNode.onaudioprocess = null;
      this._processorNode = null;
    }
    if (this._sourceNode) {
      try { this._sourceNode.disconnect(); } catch (_) {}
      this._sourceNode = null;
    }
    if (this._sinkNode) {
      try { this._sinkNode.disconnect(); } catch (_) {}
      this._sinkNode = null;
    }
    if (this._audioContext) {
      try { await this._audioContext.close(); } catch (_) {}
      this._audioContext = null;
    }
  }

  override async startUtterance() {
    if (!this._worker) return;
    this._utteranceActive = true;
    this._currentUtteranceId = `utt_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    this._worker.postMessage({ type: 'startUtterance', utteranceId: this._currentUtteranceId });
  }

  override async submitBufferedAudio(samples: unknown, sampleRate: number = this._expectedSampleRate) {
    if (!this._worker || !this._utteranceActive) return;
    const pcm = samples instanceof Float32Array ? samples : new Float32Array((samples as number[]) || []);
    if (!pcm.length) return;

    const effectiveSampleRate = Number.isFinite(sampleRate) && sampleRate > 0
      ? sampleRate
      : this._expectedSampleRate;
    const payload = downsampleFloat32(pcm, effectiveSampleRate, this._expectedSampleRate);
    if (!payload.length) return;

    this._worker.postMessage({
      type: 'audio',
      sampleRate: this._expectedSampleRate,
      samples: payload,
    }, [payload.buffer]);
  }

  override async stopUtterance() {
    if (!this._worker) return;
    this._worker.postMessage({
      type: 'finishUtterance',
      utteranceId: this._currentUtteranceId,
      tailPaddingSeconds: Number.isFinite(this.config.tailPaddingSeconds) ? this.config.tailPaddingSeconds : DEFAULT_LOCAL_NEURAL_ASR.tailPaddingSeconds,
    });
  }

  override async destroy() {
    this._utteranceActive = false;
    await this._teardownAudioTap();
    this._attachedStream = null;
    if (this._worker) {
      try { this._worker.postMessage({ type: 'dispose' }); } catch (_) {}
      try { this._worker.terminate(); } catch (_) {}
      this._worker = null;
    }
    if (this._workerUrl) {
      URL.revokeObjectURL(this._workerUrl);
      this._workerUrl = '';
    }
  }
}

class BaseTTSBackend {
  session: RTCLocalAny;
  config: RTCLocalAny;
  name: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;

  constructor(session: RTCLocalAny, config: RTCLocalAny = {}) {
    this.session = session;
    this.config = config;
    this.name = 'base';
  }

  async initialize(): Promise<void> {}
  async speak(..._args: unknown[]): Promise<void> {}
  cancel(): void {}
  async destroy(): Promise<void> {}
}

class BrowserSpeechTTSBackend extends BaseTTSBackend {
  constructor(session: RTCLocalAny, config: RTCLocalAny = {}) {
    super(session, config);
    this.name = TTS_PROVIDER.BROWSER_SPEECH;
    this._utterance = null;
    this._speakToken = 0;
  }

  override async initialize() {
    if (typeof window === 'undefined' || !('speechSynthesis' in window) || typeof window.SpeechSynthesisUtterance === 'undefined') {
      throw new Error('speechSynthesis API not available in this browser');
    }
  }

  override async speak(text: string, ttsConfig: RTCLocalAny = {}) {
    const content = String(text || '').trim();
    if (!content) return;
    const speakToken = ++this._speakToken;

    return new Promise<void>((resolve, reject) => {
      const utterance = new SpeechSynthesisUtterance(content);
      this._utterance = utterance;
      this.session._applyTTSConfig(utterance, ttsConfig);

      utterance.onend = () => {
        if (this._speakToken !== speakToken) {
          reject(createAbortError('Browser TTS playback was cancelled'));
          return;
        }
        this._utterance = null;
        resolve();
      };

      utterance.onerror = (event: RTCLocalAny) => {
        if (this._speakToken !== speakToken) {
          reject(createAbortError('Browser TTS playback was cancelled'));
          return;
        }
        this._utterance = null;
        reject(new Error(event?.error || 'Browser TTS playback failed'));
      };

      speechSynthesis.speak(utterance);
    });
  }

  override cancel() {
    this._speakToken += 1;
    this._utterance = null;
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      speechSynthesis.cancel();
    }
  }

  override async destroy() {
    this.cancel();
  }
}

class LocalNeuralTTSBackend extends BaseTTSBackend {
  constructor(session: RTCLocalAny, config: RTCLocalAny = {}) {
    super(session, config);
    this.name = TTS_PROVIDER.LOCAL_NEURAL;
    this._worker = null;
    this._workerUrl = '';
    this._audioContext = null;
    this._currentSource = null;
    this._currentRequestId = '';
    this._requestSerial = 0;
    this._readyPromise = null;
    this._sampleRate = 0;
    this._numSpeakers = 0;
    this._speakToken = 0;
    this._pendingRequests = new Map();
    this._resolvedConfig = null;
  }

  override async initialize() {
    if (typeof Worker === 'undefined') {
      throw new Error('Worker API not available for local neural TTS');
    }

    const resolved = await this._resolveRuntimeConfig();
    this._resolvedConfig = resolved;
    this._workerUrl = URL.createObjectURL(new Blob([buildSherpaTTSWorkerSource()], { type: 'application/javascript' }));
    this._worker = new Worker(this._workerUrl);

    this._readyPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timed out while loading local neural TTS runtime'));
      }, resolved.initTimeoutMs);

      this._worker.onmessage = (event: RTCLocalAny) => {
        const data = event.data || {};
        if (data.type === 'ready') {
          clearTimeout(timeout);
          this._sampleRate = data.sampleRate || this._sampleRate;
          this._numSpeakers = data.numSpeakers || 0;
          this.session._emitTTSStatus('active', {
            provider: this.name,
            sampleRate: this._sampleRate,
            numSpeakers: this._numSpeakers,
            preset: resolved.activePreset?.id || '',
          });
          resolve();
          return;
        }

        if (data.type === 'synthesized') {
          const pending = this._pendingRequests.get(data.requestId || '');
          if (!pending) return;
          this._pendingRequests.delete(data.requestId || '');
          pending.resolve({
            samples: data.samples instanceof Float32Array ? data.samples : new Float32Array(data.samples || []),
            sampleRate: data.sampleRate || this._sampleRate || this._resolvedConfig?.sampleRate || 22050,
          });
          return;
        }

        if (data.type === 'error') {
          const error = new Error(data.message || 'Local neural TTS failed');
          const pending = this._pendingRequests.get(data.requestId || '');
          if (pending) {
            this._pendingRequests.delete(data.requestId || '');
            pending.reject(error);
            return;
          }

          if (data.fatal) {
            clearTimeout(timeout);
            reject(error);
          } else {
            this.session._emitTTSStatus('error', {
              provider: this.name,
              message: error.message,
            });
          }
        }
      };

      this._worker.onerror = (event: RTCLocalAny) => {
        clearTimeout(timeout);
        reject(new Error(event.message || 'Local neural TTS worker crashed'));
      };
    });

    this.session._emitTTSStatus('loading', { provider: this.name });
    this._worker.postMessage({
      type: 'init',
      runtimeConfig: resolved.runtimeConfig,
      offlineTtsConfig: resolved.offlineTtsConfig,
    });

    await this._readyPromise;
  }

  async _resolveRuntimeConfig() {
    const sessionLanguage = this.config.Language || this.session.voiceChatConfig?.ASRConfig?.Language || 'zh-CN';
    const localConfig = {
      ...DEFAULT_LOCAL_NEURAL_TTS,
      ...(this.config.ProviderParams || {}),
      ...(this.config.LocalNeural || {}),
      ...(this.config.Runtime || {}),
      ...this.config,
    };

    const preset = getActiveLocalNeuralTTSPreset(
      localConfig.Preset || localConfig.preset || localConfig.PresetId || localConfig.presetId,
      sessionLanguage,
    ) || LOCAL_NEURAL_TTS_PRESETS[DEFAULT_LOCAL_NEURAL_TTS_PRESET];

    const assetBaseUrl = trimTrailingSlash(
      localConfig.AssetBaseURL
      || localConfig.assetBaseUrl
      || localConfig.BaseAssetURL
      || localConfig.baseAssetUrl
      || DEFAULT_LOCAL_NEURAL_TTS_ASSET_BASE,
    );
    const mergedConfig = {
      ...(preset || {}),
      ...localConfig,
    };

    const resolvedSpeakerId = parseOptionalInteger(
      mergedConfig.speakerId ?? mergedConfig.SpeakerId ?? mergedConfig.sid,
    );

    if (preset) {
      mergedConfig.Preset = preset.id;
      mergedConfig.preset = preset.id;
      if (!mergedConfig.RuntimeBaseURL && !mergedConfig.runtimeBaseUrl && !mergedConfig.TtsScriptUrl && !mergedConfig.ttsScriptUrl && !mergedConfig.MainURL && !mergedConfig.mainUrl) {
        mergedConfig.RuntimeBaseURL = joinUrl(assetBaseUrl, preset.runtimeBasePath);
      }
      if (!mergedConfig.ModelBaseURL && !mergedConfig.modelBaseUrl && !mergedConfig.BaseURL && !mergedConfig.baseUrl && !mergedConfig.model) {
        mergedConfig.ModelBaseURL = joinUrl(assetBaseUrl, preset.modelBasePath);
      }
    }

    const runtimeBaseUrl = trimTrailingSlash(mergedConfig.RuntimeBaseURL || mergedConfig.runtimeBaseUrl || '');
    const modelBaseUrl = trimTrailingSlash(mergedConfig.ModelBaseURL || mergedConfig.modelBaseUrl || mergedConfig.BaseURL || mergedConfig.baseUrl || '');
    const activePreset = preset || null;

    const runtimeConfig = {
      ttsScriptUrl: absolutizeBrowserUrl(mergedConfig.TtsScriptUrl || mergedConfig.ttsScriptUrl || joinUrl(runtimeBaseUrl, 'sherpa-onnx-tts.js')),
      runtimeModuleUrl: absolutizeBrowserUrl(mergedConfig.MainURL || mergedConfig.mainUrl || joinUrl(runtimeBaseUrl, 'sherpa-onnx-wasm-main-tts.js')),
      wasmBinaryUrl: absolutizeBrowserUrl(mergedConfig.WasmURL || mergedConfig.wasmUrl || joinUrl(runtimeBaseUrl, 'sherpa-onnx-wasm-main-tts.wasm')),
      wasmDataUrl: absolutizeBrowserUrl(mergedConfig.DataURL || mergedConfig.dataUrl || joinUrl(runtimeBaseUrl, 'sherpa-onnx-wasm-main-tts.data')),
    };

    const ruleFsts = Array.isArray(mergedConfig.ruleFsts)
      ? mergedConfig.ruleFsts.map((item: unknown) => absolutizeBrowserUrl(item)).join(',')
      : mergedConfig.ruleFsts
        ? absolutizeBrowserUrl(mergedConfig.ruleFsts)
        : (activePreset?.ruleFstsFileNames || []).map((fileName: unknown) => absolutizeBrowserUrl(joinUrl(modelBaseUrl, fileName))).join(',');

    const offlineTtsConfig = cloneJSON(mergedConfig.OfflineTtsConfig || mergedConfig.offlineTtsConfig) || {
      offlineTtsModelConfig: {
        offlineTtsVitsModelConfig: {
          model: absolutizeBrowserUrl(mergedConfig.model || joinUrl(modelBaseUrl, mergedConfig.modelFileName || 'model.onnx')),
          lexicon: absolutizeBrowserUrl(mergedConfig.lexicon || (mergedConfig.lexiconFileName ? joinUrl(modelBaseUrl, mergedConfig.lexiconFileName) : '')),
          tokens: absolutizeBrowserUrl(mergedConfig.tokens || joinUrl(modelBaseUrl, mergedConfig.tokensFileName || 'tokens.txt')),
          dataDir: '',
          noiseScale: Number.isFinite(mergedConfig.noiseScale) ? mergedConfig.noiseScale : 0.667,
          noiseScaleW: Number.isFinite(mergedConfig.noiseScaleW) ? mergedConfig.noiseScaleW : 0.8,
          lengthScale: Number.isFinite(mergedConfig.lengthScale) ? mergedConfig.lengthScale : 1.0,
        },
        offlineTtsMatchaModelConfig: {
          acousticModel: '',
          vocoder: '',
          lexicon: '',
          tokens: '',
          dataDir: '',
          noiseScale: 0.667,
          lengthScale: 1.0,
        },
        offlineTtsKokoroModelConfig: {
          model: '',
          voices: '',
          tokens: '',
          dataDir: '',
          lengthScale: 1.0,
          lexicon: '',
          lang: '',
        },
        offlineTtsKittenModelConfig: {
          model: '',
          voices: '',
          tokens: '',
          dataDir: '',
          lengthScale: 1.0,
        },
        offlineTtsZipVoiceModelConfig: {
          tokens: '',
          encoder: '',
          decoder: '',
          vocoder: '',
          dataDir: '',
          lexicon: '',
          featScale: 0.1,
          tShift: 0.5,
          targetRMS: 0.1,
          guidanceScale: 1.0,
        },
        offlineTtsPocketModelConfig: {
          lmFlow: '',
          lmMain: '',
          encoder: '',
          decoder: '',
          textConditioner: '',
          vocabJson: '',
          tokenScoresJson: '',
          voiceEmbeddingCacheCapacity: 50,
        },
        offlineTtsSupertonicModelConfig: {
          durationPredictor: '',
          textEncoder: '',
          vectorEstimator: '',
          vocoder: '',
          ttsJson: '',
          unicodeIndexer: '',
          voiceStyle: '',
        },
        numThreads: mergedConfig.numThreads || DEFAULT_LOCAL_NEURAL_TTS.numThreads,
        debug: mergedConfig.debug ? 1 : 0,
        provider: mergedConfig.executionProvider || DEFAULT_LOCAL_NEURAL_TTS.executionProvider,
      },
      ruleFsts,
      ruleFars: absolutizeBrowserUrl(mergedConfig.ruleFars || ''),
      maxNumSentences: Number.isFinite(mergedConfig.maxNumSentences) ? mergedConfig.maxNumSentences : DEFAULT_LOCAL_NEURAL_TTS.maxNumSentences,
      silenceScale: Number.isFinite(mergedConfig.silenceScale) ? mergedConfig.silenceScale : DEFAULT_LOCAL_NEURAL_TTS.silenceScale,
    };

    const cachedRuntimeConfig = await this._resolveRemoteUrls(runtimeConfig);
    const cachedOfflineTtsConfig = await this._resolveRemoteUrls(offlineTtsConfig);

    return {
      runtimeConfig: cachedRuntimeConfig,
      offlineTtsConfig: cachedOfflineTtsConfig,
      initTimeoutMs: Number.isFinite(mergedConfig.initTimeoutMs) ? mergedConfig.initTimeoutMs : DEFAULT_LOCAL_NEURAL_TTS.initTimeoutMs,
      defaultSpeakerId: Number.isFinite(resolvedSpeakerId) ? resolvedSpeakerId : (activePreset?.speakerId || 0),
      sampleRate: activePreset?.sampleRate || 0,
      activePreset,
    };
  }

  async _resolveRemoteUrls(value: unknown): Promise<unknown> {
    if (Array.isArray(value)) {
      return Promise.all(value.map((item) => this._resolveRemoteUrls(item)));
    }
    if (value && typeof value === 'object') {
      const entries = await Promise.all(
        Object.entries(value).map(async ([key, child]) => [key, await this._resolveRemoteUrls(child)]),
      );
      return Object.fromEntries(entries);
    }
    if (typeof value === 'string' && value.includes(',') && !value.startsWith('data:')) {
      const parts = value.split(',').map((item) => item.trim()).filter(Boolean);
      if (parts.length > 1 && parts.every((item) => isRemoteLikeUrl(item))) {
        const resolvedParts = await Promise.all(parts.map((item) => this._resolveRemoteUrls(item)));
        return resolvedParts.join(',');
      }
    }
    if (!isRemoteLikeUrl(value)) return value;
    if (!this.session.parent.cacheBinaryAssetsToIndexedDB) return value;

    const fileName = (() => {
      try {
        return new URL(value as string).pathname.split('/').pop() || 'asset.bin';
      } catch (_) {
        return 'asset.bin';
      }
    })();

    return await this.session.parent._getOrCacheBinaryAssetURL(value, fileName) || value;
  }

  async _ensureAudioContext() {
    if (!this._audioContext) {
      const AudioContextCtor = _win.AudioContext || _win.webkitAudioContext;
      if (!AudioContextCtor) {
        throw new Error('Web Audio API not available for local neural TTS playback');
      }
      this._audioContext = new (AudioContextCtor as { new (o?: unknown): RTCLocalAny })();
    }
    if (this._audioContext.state === 'suspended') {
      await this._audioContext.resume();
    }
    return this._audioContext;
  }

  async _synthesize(text: string, generationConfig: RTCLocalAny): Promise<RTCLocalAny> {
    await this._readyPromise;
    return new Promise<RTCLocalAny>((resolve, reject) => {
      const requestId = `tts_${Date.now()}_${++this._requestSerial}`;
      this._currentRequestId = requestId;
      this._pendingRequests.set(requestId, { resolve, reject });
      this._worker.postMessage({
        type: 'synthesize',
        requestId,
        text,
        generationConfig,
      });
    });
  }

  async _playAudio(samples: unknown, sampleRate: number, speakToken: number, playbackVolume: number): Promise<void> {
    const audioContext = await this._ensureAudioContext();
    const pcm = samples instanceof Float32Array ? samples : new Float32Array((samples as number[]) || []);
    if (!pcm.length) return;

    return new Promise<void>((resolve, reject) => {
      if (this._speakToken !== speakToken) {
        reject(createAbortError('Local neural TTS playback was cancelled'));
        return;
      }

      const buffer = audioContext.createBuffer(1, pcm.length, sampleRate || this._sampleRate || this._resolvedConfig?.sampleRate || 22050);
      buffer.copyToChannel(pcm, 0);

      const source = audioContext.createBufferSource();
      const gainNode = audioContext.createGain();
      source.buffer = buffer;
      gainNode.gain.value = Math.max(0, Math.min(3, Number.isFinite(playbackVolume) ? playbackVolume : DEFAULT_LOCAL_NEURAL_TTS.volume));
      source.connect(gainNode);
      gainNode.connect(audioContext.destination);
      this._currentSource = source;

      source.onended = () => {
        if (this._currentSource === source) {
          this._currentSource = null;
        }
        try { source.disconnect(); } catch (_) {}
        try { gainNode.disconnect(); } catch (_) {}
        if (this._speakToken !== speakToken) {
          reject(createAbortError('Local neural TTS playback was cancelled'));
          return;
        }
        resolve();
      };

      source.start();
    });
  }

  override async speak(text: string, ttsConfig: RTCLocalAny = {}) {
    const content = String(text || '').trim();
    if (!content) return;

    const speakToken = ++this._speakToken;
    let speakerId = this.session._resolveLocalNeuralTTSSpeakerId(ttsConfig, this._resolvedConfig?.defaultSpeakerId || 0);
    if (Number.isFinite(this._numSpeakers) && this._numSpeakers > 0) {
      if (speakerId < 0 || speakerId >= this._numSpeakers) {
        const fallbackSpeakerId = this._resolvedConfig?.defaultSpeakerId || 0;
        console.warn(`[LocalNeuralTTS] Speaker ${speakerId} is out of range for preset ${this._resolvedConfig?.activePreset?.id || 'unknown'} (numSpeakers=${this._numSpeakers}); using ${fallbackSpeakerId} instead.`);
        speakerId = fallbackSpeakerId >= 0 && fallbackSpeakerId < this._numSpeakers ? fallbackSpeakerId : 0;
      }
    }
    const playbackVolume = Number.isFinite(ttsConfig.Volume)
      ? ttsConfig.Volume
      : (Number.isFinite(this.config.Volume) ? this.config.Volume : DEFAULT_LOCAL_NEURAL_TTS.volume);
    const generationConfig = {
      sid: speakerId,
      speed: Number.isFinite(ttsConfig.Speed) ? ttsConfig.Speed : (Number.isFinite(this.config.Speed) ? this.config.Speed : DEFAULT_LOCAL_NEURAL_TTS.speed),
      silenceScale: Number.isFinite(ttsConfig.SilenceScale) ? ttsConfig.SilenceScale : DEFAULT_LOCAL_NEURAL_TTS.silenceScale,
    };

    const result = await this._synthesize(content, generationConfig);
    if (this._speakToken !== speakToken) {
      throw createAbortError('Local neural TTS playback was cancelled');
    }
    await this._playAudio(result.samples, result.sampleRate, speakToken, playbackVolume);
  }

  override cancel() {
    this._speakToken += 1;
    if (this._currentSource) {
      try { this._currentSource.stop(); } catch (_) {}
      this._currentSource = null;
    }
  }

  override async destroy() {
    this.cancel();
    for (const pending of this._pendingRequests.values()) {
      pending.reject(createAbortError('Local neural TTS backend was destroyed'));
    }
    this._pendingRequests.clear();
    if (this._worker) {
      try { this._worker.postMessage({ type: 'dispose' }); } catch (_) {}
      try { this._worker.terminate(); } catch (_) {}
      this._worker = null;
    }
    if (this._workerUrl) {
      URL.revokeObjectURL(this._workerUrl);
      this._workerUrl = '';
    }
    if (this._audioContext) {
      try { await this._audioContext.close(); } catch (_) {}
      this._audioContext = null;
    }
  }
}

/** Sentence-end regex for TTS chunking (Chinese & Western punctuation + newlines) */
const SENTENCE_END_RE = /[。！？!?\n]+/;

// ============================================================================
// Exports (backend classes + constants shared with core/session)
// ============================================================================

export {
  // Backend classes
  BaseASRBackend,
  WebSpeechASRBackend,
  WhisperASRBackend,
  LocalNeuralASRBackend,
  BaseTTSBackend,
  BrowserSpeechTTSBackend,
  LocalNeuralTTSBackend,
  // Constants used by core/session
  DEFAULT_VAD_CDN,
  DEFAULT_ASR_OPTIONS,
  DEFAULT_TTS_OPTIONS,
  DEFAULT_LOCAL_NEURAL_ASR,
  DEFAULT_WHISPER_ASR,
  DEFAULT_LOCAL_NEURAL_TTS,
  DEFAULT_LOCAL_NEURAL_TTS_PRESET,
  DEFAULT_LOCAL_NEURAL_TTS_ASSET_BASE,
  LOCAL_NEURAL_TTS_PRESETS,
  LOCAL_NEURAL_TTS_PRESET_ALIASES,
  DEFAULT_LOCAL_NEURAL_PRESET,
  DEFAULT_LOCAL_NEURAL_ASSET_BASE,
  LOCAL_NEURAL_ASR_PRESETS,
  LOCAL_NEURAL_ASR_PRESET_ALIASES,
  DEFAULT_WHISPER_PRESET,
  LOCAL_WHISPER_ASR_PRESETS,
  LOCAL_WHISPER_ASR_PRESET_ALIASES,
  DEFAULT_KEEPWORK_MODEL_CDN,
  getDefaultModelAssetBase,
  // Helper functions used by core/session
  normalizeASRProvider,
  normalizeTTSProvider,
  parseOptionalInteger,
  trimTrailingSlash,
  normalizeLocalNeuralTTSPreset,
  isMixedChineseEnglishLanguage,
  hasWhisperASRHints,
  getDefaultASRFallbackProviders,
  // Config constants / enums used by core/session
  DEFAULT_ASSET_CACHE,
  ENERGY_VAD,
  DEFAULT_AUDIO_CONSTRAINTS,
  ASR_PROVIDER,
  TTS_PROVIDER,
  SENTENCE_END_RE,
};
