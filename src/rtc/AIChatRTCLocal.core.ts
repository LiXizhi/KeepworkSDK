/**
 * AIChatRTCLocal.core.ts — AIChatRTCLocal 主类
 *
 * 提供 createSession() 入口，管理共享单例和会话生命周期。
 * backend 类在 AIChatRTCLocal.backends.ts，会话类在 AIChatRTCLocal.session.ts。
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
  DEFAULT_KEEPWORK_MODEL_CDN, getDefaultModelAssetBase,
  DEFAULT_ASSET_CACHE,
} from './AIChatRTCLocal.backends';
// installLocalRTCSessionMixin 必须显式 import 并调用（见下方），否则 LocalRTCSession 的
// ChildSessionMixin prototype 注册会被 Rollup tree-shaking 删除。
import LocalRTCSession, { installLocalRTCSessionMixin } from './AIChatRTCLocal.session';
const console = SDKLogger.createModuleConsole('AIChatRTCLocal');

installLocalRTCSessionMixin();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CoreAny = Record<string, any>;
declare const vad: CoreAny;
declare const ort: CoreAny;

class AIChatRTCLocal {
  static AGENT_STATE = AGENT_STATE;
  static AGENT_STATE_LABELS = AGENT_STATE_LABELS;
  static LOCAL_NEURAL_ASR_PRESETS = LOCAL_NEURAL_ASR_PRESETS;
  static DEFAULT_LOCAL_NEURAL_PRESET = DEFAULT_LOCAL_NEURAL_PRESET;
  static LOCAL_WHISPER_ASR_PRESETS = LOCAL_WHISPER_ASR_PRESETS;
  static DEFAULT_WHISPER_PRESET = DEFAULT_WHISPER_PRESET;

  sdk: CoreAny;
  _loadPromise: Promise<void> | null = null;
  _assetDBPromise: Promise<unknown> | null = null;
  _assetBlobUrls: Map<string, string> = new Map();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;

  /**
   * @param {Object} sdk  - KeepworkSDK instance
   * @param {Object} [options]
   * @param {string} [options.ortUrl]          - Override ORT standalone script CDN URL
   * @param {string} [options.onnxWASMBasePath]  - Override ONNX WASM CDN base
   * @param {string} [options.vadBundleUrl]      - Override VAD bundle CDN URL
   * @param {string} [options.vadModelURL]       - Override Silero model URL
   * @param {string} [options.vadWorkletURL]     - Override VAD worklet URL
   * @param {boolean} [options.cacheBinaryAssetsToIndexedDB=false] - Cache ONNX/WASM blobs in IndexedDB
   * @param {string} [options.assetCacheNamespace] - Cache namespace/version for invalidation
   */
  constructor(sdk: unknown, options: CoreAny = {}) {
    this.sdk = sdk as CoreAny;
    this.ortUrl = options.ortUrl || DEFAULT_VAD_CDN.ortUrl;
    this.onnxWASMBasePath = options.onnxWASMBasePath || DEFAULT_VAD_CDN.onnxWASMBasePath;
    this.vadBundleUrl = options.vadBundleUrl || DEFAULT_VAD_CDN.bundleUrl;
    this.vadModelURL = options.vadModelURL || DEFAULT_VAD_CDN.modelURL;
    this.vadWorkletURL = options.vadWorkletURL || DEFAULT_VAD_CDN.workletURL;
    this.cacheBinaryAssetsToIndexedDB = !!options.cacheBinaryAssetsToIndexedDB;
    this.assetCacheNamespace = options.assetCacheNamespace || DEFAULT_ASSET_CACHE.namespace;
    this._loadPromise = null;
    this._vadAvailable = false;
    this._assetDBPromise = null;
    this._assetBlobUrls = new Map();
    this._resolvedVadModelURL = this.vadModelURL;
  }

  /**
   * Preload the Silero VAD library. Called automatically by session.start(),
   * but can be invoked earlier for faster startup.
   * If loading fails, sessions will fall back to energy-based VAD.
   * @returns {Promise<void>}
   */
  loadSDK() {
    if (typeof vad !== 'undefined' && vad.MicVAD) {
      this._vadAvailable = true;
      return Promise.resolve();
    }
    if (this._loadPromise) return this._loadPromise;
    this._loadPromise = this._loadScripts().then(() => {
      this._vadAvailable = !!(typeof vad !== 'undefined' && vad.MicVAD);
      if (this._vadAvailable) {
        console.log('[AIChatRTCLocal] Silero VAD loaded');
      } else {
        console.warn('[AIChatRTCLocal] VAD bundle loaded but vad.MicVAD not found — using energy fallback');
      }
    }).catch(() => {
      console.warn('[AIChatRTCLocal] Failed to load Silero VAD — using energy fallback');
      this._vadAvailable = false;
      this._loadPromise = null;
    });
    return this._loadPromise;
  }

  /**
   * Load ORT + VAD scripts sequentially.
   * ORT must be loaded first (window.ort) because vad-web's bundle.min.js
   * declares onnxruntime-web as an external and reads window.ort at init time.
   */
  async _loadScripts() {
    // Step 1: Load ORT if not already present
    if (typeof ort === 'undefined') {
      await this._loadScript(this.ortUrl);
      if (typeof ort === 'undefined') throw new Error('ORT not available');
    }

    const assetUrls = await this._resolveBinaryAssetUrls();

    // Step 2: Configure WASM paths + single thread before any inference
    try {
      ort.env.wasm.wasmPaths = assetUrls.wasmPaths;
      ort.env.wasm.numThreads = 1;
    } catch (_) { /* best-effort */ }

    this._resolvedVadModelURL = assetUrls.modelURL;

    // Step 3: Load VAD bundle (uses window.ort)
    await this._loadScript(this.vadBundleUrl);
  }

  /** Load a single script tag and return a promise. */
  _loadScript(url: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = url;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error(`Failed to load ${url}`));
      document.head.appendChild(script);
    });
  }

  async _resolveBinaryAssetUrls() {
    if (!this.cacheBinaryAssetsToIndexedDB || typeof indexedDB === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
      return {
        modelURL: this.vadModelURL,
        wasmPaths: this.onnxWASMBasePath,
      };
    }

    const modelURL = await this._getOrCacheBinaryAssetURL(
      this.vadModelURL,
      DEFAULT_ASSET_CACHE.modelFileName,
    ) || this.vadModelURL;

    const wasmPaths: Record<string, unknown> = {};
    let usesCachedWasm = false;

    for (const fileName of DEFAULT_ASSET_CACHE.wasmFileNames) {
      const remoteUrl = new URL(fileName, this.onnxWASMBasePath).toString();
      const cachedUrl = await this._getOrCacheBinaryAssetURL(remoteUrl, fileName);
      wasmPaths[fileName] = cachedUrl || remoteUrl;
      usesCachedWasm = usesCachedWasm || !!cachedUrl;
    }

    return {
      modelURL,
      wasmPaths: usesCachedWasm ? wasmPaths : this.onnxWASMBasePath,
    };
  }

  async _getOrCacheBinaryAssetURL(remoteUrl: string, fileName: string) {
    const cacheKey = `${this.assetCacheNamespace}:${remoteUrl}`;

    if (this._assetBlobUrls.has(cacheKey)) {
      return this._assetBlobUrls.get(cacheKey);
    }

    try {
      const cached = await this._readCachedBinaryAsset(cacheKey) as Blob | null;
      if (cached) {
        return this._rememberBlobURL(cacheKey, cached);
      }
    } catch (error) {
      console.warn(`[AIChatRTCLocal] IndexedDB cache read failed for ${fileName}:`, (error as Error)?.message || error);
    }

    try {
      const response = await fetch(remoteUrl);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      await this._writeCachedBinaryAsset(cacheKey, {
        key: cacheKey,
        blob,
        fileName,
        sourceURL: remoteUrl,
        updatedAt: Date.now(),
      });
      return this._rememberBlobURL(cacheKey, blob);
    } catch (error) {
      console.warn(`[AIChatRTCLocal] Failed to cache ${fileName}:`, (error as Error)?.message || error);
      return null;
    }
  }

  _rememberBlobURL(cacheKey: string, blob: Blob) {
    const blobUrl = URL.createObjectURL(blob);
    this._assetBlobUrls.set(cacheKey, blobUrl);
    return blobUrl;
  }

  _getAssetDB() {
    if (this._assetDBPromise) return this._assetDBPromise;

    this._assetDBPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DEFAULT_ASSET_CACHE.dbName, 1);

      request.onerror = () => {
        this._assetDBPromise = null;
        reject(request.error);
      };

      request.onsuccess = () => {
        const db = request.result;
        db.onclose = () => {
          this._assetDBPromise = null;
        };
        resolve(db);
      };

      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(DEFAULT_ASSET_CACHE.storeName)) {
          request.result.createObjectStore(DEFAULT_ASSET_CACHE.storeName, { keyPath: 'key' });
        }
      };
    });

    return this._assetDBPromise;
  }

  async _withAssetStore(mode: IDBTransactionMode, callback: (store: CoreAny, resolve: (v?: unknown) => void, reject: (e?: unknown) => void) => void) {
    const db = await this._getAssetDB() as IDBDatabase;
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(DEFAULT_ASSET_CACHE.storeName, mode);
      const store = transaction.objectStore(DEFAULT_ASSET_CACHE.storeName);

      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);

      callback(store, resolve, reject);
    });
  }

  async _readCachedBinaryAsset(cacheKey: string) {
    return this._withAssetStore('readonly', (store, resolve, reject) => {
      const request = store.get(cacheKey);
      request.onsuccess = () => {
        const result = request.result;
        resolve(result?.blob || null);
      };
      request.onerror = () => reject(request.error);
    });
  }

  async _writeCachedBinaryAsset(cacheKey: string, record: CoreAny) {
    return this._withAssetStore('readwrite', (store, resolve, reject) => {
      const request = store.put({ ...record, key: cacheKey });
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Create a new local voice chat session.
   * @param {Object} config - Session configuration (compatible with AIChatRTC.createSession)
   * @param {Object} [config.agentConfig] - Agent config (WelcomeMessage, SystemMessages, etc.)
   * @param {Object} [config.config] - Config block (LLMConfig, ASRConfig, TTSConfig)
   * @param {string} [config.workspace] - SandboxToolEnv workspace name
   * @param {string[]} [config.enabledToolCategories=['fileOps','agent']] - Tool categories for SandboxToolEnv
   * @param {Array} [config.tools] - Additional custom tool definitions (OpenAI format)
   * @param {Object} [config.toolProxy] - Tool proxy config for AgentRouter
   * @returns {LocalRTCSession}
   */
  createSession(config = {}) {
    return new LocalRTCSession(this, config);
  }
}

// ── Static properties (model CDN base) ──
/** Expose the CDN base so external pages can read it without hardcoding. */
(AIChatRTCLocal as CoreAny).DEFAULT_MODEL_CDN = DEFAULT_KEEPWORK_MODEL_CDN;
/** Expose the resolved base (CDN on production, ./models on localhost). */
(AIChatRTCLocal as CoreAny).DEFAULT_MODEL_BASE = getDefaultModelAssetBase();

export default AIChatRTCLocal;
export { AIChatRTCLocal };
