/**
 * LocalAPIKeySettings — per-model LLM API key and endpoint configuration
 * with a self-contained settings modal UI.
 *
 * Stores per-model overrides (modelId, apiKey, category).
 * When the SDK makes an LLM request
 * for a model that has local settings, those settings take priority over
 * the server-side defaults.
 *
 * Persistence is pluggable: pass `storage: 'personalPageStore'` to use
 * Keepwork cloud storage, or `storage: 'localStorage'` (default) for
 * browser-local persistence.
 *
 * Usage:
 *   const settings = sdk.localAPIKeySettings;
 *   await settings.load();
 *   settings.show();           // opens the config modal
 *   settings.show({ onClose: () => console.log('closed') });
 */

const STORAGE_KEY = 'localAPIKeySettings';
const STORAGE_FILE = 'config/localAPIKeySettings.keys.json';
const CATEGORIES = ['Chat', 'Image', 'Video'];

// ── i18n (English / Chinese, auto-detected from system language) ─────
type LAKStrings = Record<string, string>;
const LAK_TRANSLATIONS: Record<string, LAKStrings> = {
  zhCN: {
    title: '模型接口配置',
    statusOn: '✅ 已启用本地 API Key 配置',
    statusOff: '⛔ 未启用 (使用 Keepwork 默认)',
    globalSwitchTitle: '全局本地 API Key 配置开关',
    tabPresets: '预设',
    newModelPlaceholder: '模型名称，例如 GPT-4o',
    add: '+ 添加',
    storageMode: '存储方式',
    workspacePlaceholder: 'workspace 名称',
    import: '导入',
    export: '导出',
    clearAll: '清空',
    reset: '重置',
    resetTitle: '重置预设模型列表与开关，保留所有 API Key 与抽象模型映射',
    close: '关闭',
    emptyModels: '暂无模型配置',
    mismatchWarn: '⚠ 与预设不一致',
    mismatchTitle: '与「{provider}」预设 API Key 不一致，点击"同步"按预设更新',
    delete: '删除',
    modelToggleTitle: '模型开关',
    eyeTitle: '显示/隐藏',
    sync: '同步',
    syncTitle: '使用预设 API Key 覆盖',
    selectModel: '-- 选择模型 --',
    providerToggleTitle: '服务商预设开关',
    presetKeyPlaceholder: '输入 {provider} 的 API Key',
    preferDirectTitle: '开启后，支持的 SDK 调用会优先从浏览器直连该服务商；默认关闭，继续走 Keepwork 代理。',
    preferDirect: '优先直连服务商 API',
    userApiKey: 'User API Key',
    userApiKeyHint: '全局 User API Key，应用于所有 /gpt/ 接口请求的 user-api-key header',
    configured: '✅ 已配置',
    notConfigured: '未配置',
    save: '保存',
    clearKey: '清除',
    abstractMapping: '抽象模型映射',
    abstractMappingHint: 'Keepwork 使用抽象模型名称（如 keepwork-pro），在此配置映射到实际服务商模型',
    servicePresets: '服务商预设',
    servicePresetsHint: '快速配置常用 AI 服务商，输入 API Key 即可一键启用全部模型',
    custom: '自定义',
    importError: 'JSON 格式错误: ',
    confirmClear: '确认清空所有模型配置？',
    confirmReset: '重置预设模型列表与开关？\n\n所有 API Key 和"抽象模型映射"会保留。',
  },
  enUS: {
    title: 'Model API Configuration',
    statusOn: '✅ Local API Key config enabled',
    statusOff: '⛔ Disabled (using Keepwork defaults)',
    globalSwitchTitle: 'Global local API Key config switch',
    tabPresets: 'Presets',
    newModelPlaceholder: 'Model name, e.g. GPT-4o',
    add: '+ Add',
    storageMode: 'Storage',
    workspacePlaceholder: 'workspace name',
    import: 'Import',
    export: 'Export',
    clearAll: 'Clear',
    reset: 'Reset',
    resetTitle: 'Reset preset model list and switches, keep all API Keys and abstract model mappings',
    close: 'Close',
    emptyModels: 'No models configured',
    mismatchWarn: '⚠ Differs from preset',
    mismatchTitle: 'Differs from "{provider}" preset API Key. Click "Sync" to update from preset.',
    delete: 'Delete',
    modelToggleTitle: 'Model switch',
    eyeTitle: 'Show / hide',
    sync: 'Sync',
    syncTitle: 'Overwrite with preset API Key',
    selectModel: '-- Select model --',
    providerToggleTitle: 'Provider preset switch',
    presetKeyPlaceholder: 'Enter API Key for {provider}',
    preferDirectTitle: 'When enabled, supported SDK calls prefer connecting directly to this provider from the browser. Disabled by default, continuing to use the Keepwork proxy.',
    preferDirect: 'Prefer direct provider API',
    userApiKey: 'User API Key',
    userApiKeyHint: 'Global User API Key, applied to the user-api-key header of all /gpt/ requests',
    configured: '✅ Configured',
    notConfigured: 'Not configured',
    save: 'Save',
    clearKey: 'Clear',
    abstractMapping: 'Abstract Model Mapping',
    abstractMappingHint: 'Keepwork uses abstract model names (e.g. keepwork-pro). Map them to real provider models here.',
    servicePresets: 'Service Provider Presets',
    servicePresetsHint: 'Quickly configure common AI providers. Enter an API Key to enable all models at once.',
    custom: 'Custom',
    importError: 'Invalid JSON: ',
    confirmClear: 'Clear all model configurations?',
    confirmReset: 'Reset preset model list and switches?\n\nAll API Keys and abstract model mappings will be kept.',
  },
};

function detectLakLang(): string {
  if (typeof navigator === 'undefined') return 'enUS';
  const lang = navigator.language || (navigator as Navigator & { userLanguage?: string }).userLanguage || '';
  return lang.toLowerCase().startsWith('zh') ? 'zhCN' : 'enUS';
}

// ── Service Provider Presets ────────────────────────────────────────
interface PresetModel { name: string; modelId: string; endpointId?: string; category: string; [key: string]: unknown; }
interface ServicePreset { name: string; models: PresetModel[]; note?: string; [key: string]: unknown; }
const SERVICE_PRESETS: Record<string, ServicePreset> = {
  openrouter: {
    name: 'OpenRouter',
    models: [
      { name: 'openrouter-gemini-pro', modelId: 'google/gemini-2.5-pro', category: 'Chat' },
      { name: 'openrouter-gemini-flash', modelId: 'google/gemini-2.5-flash', category: 'Chat' },
      { name: 'openrouter-gemini-3.5-flash', modelId: 'google/gemini-3.5-flash', category: 'Chat' },
      { name: 'openrouter-deepseek-v4-flash', modelId: 'deepseek/deepseek-v4-flash', category: 'Chat' },
      { name: 'openrouter-deepseek-v4-pro', modelId: 'deepseek/deepseek-v4-pro', category: 'Chat' },
      { name: 'openrouter-qwen3-14b', modelId: 'qwen/qwen3-14b', category: 'Chat' },
      { name: 'openrouter-qwen3.7-max', modelId: 'qwen/qwen3.7-max', category: 'Chat' },
      { name: 'openrouter-gpt-5.5', modelId: 'openai/gpt-5.5', category: 'Chat' },
      { name: 'openrouter-claude-opus-4-8', modelId: 'anthropic/claude-4.8-opus', category: 'Chat' },
      { name: 'openrouter-claude', modelId: 'anthropic/claude-4.8-opus', category: 'Chat' },
      { name: 'openrouter-claude-sonnet', modelId: 'anthropic/claude-4.6-sonnet', category: 'Chat' },
      { name: 'openrouter-gemini-3.1-flash-image-preview', modelId: 'google/gemini-3.1-flash-image-preview', category: 'Image' },
      { name: 'openrouter-gemini-3-pro-image-preview', modelId: 'google/gemini-3-pro-image-preview', category: 'Image' },
      { name: 'openrouter-gemini-image', modelId: 'google/gemini-2.5-flash-image', category: 'Image' },
      { name: 'openrouter-gpt-image', modelId: 'openai/gpt-5.4-image-2', category: 'Image' },
      { name: 'openrouter-seedream-4.5', modelId: 'bytedance-seed/seedream-4.5', category: 'Image' },
      { name: 'openrouter-kling-v3.0-pro', modelId: 'kwaivgi/kling-v3.0-pro', category: 'Video' },
      { name: 'openrouter-veo-3.1-fast', modelId: 'google/veo-3.1-fast', category: 'Video' },
      { name: 'openrouter-gemini-video', modelId: 'google/gemini-2.5-pro', category: 'Video' },
      { name: 'openrouter-seedance-2.0', modelId: 'bytedance/seedance-2.0', category: 'Video' },
      { name: 'openrouter-seedance-2.0-fast', modelId: 'bytedance/seedance-2.0-fast', category: 'Video' },
    ],
    note: 'OpenRouter 模型使用 provider/model 格式，直连模式会调用 openrouter.ai。视频模型 (如 bytedance/seedance-2.0) 通过 /api/v1/videos 异步接口生成。',
  },
  doubao: {
    name: '豆包 (Doubao)',
    // modelId is the friendly model name (used by Keepwork proxy / tokenRateConfigs).
    // endpointId is the Volcano Engine Endpoint ID used only when calling Volcano directly.
    models: [
      { name: 'doubao-seed-2-0-pro', modelId: 'doubao-seed-2-0-pro', endpointId: 'ep-20260225155953-hhjsd', category: 'Chat' },
      { name: 'doubao-seed-2-0-mini', modelId: 'doubao-seed-2-0-mini', endpointId: 'ep-20260315160200-s6fg7', category: 'Chat' },
      { name: 'doubao-seed-2-0-lite', modelId: 'doubao-seed-2-0-lite', endpointId: 'ep-20260330142752-whgdc', category: 'Chat' },
      { name: 'seedream-5.0-lite', modelId: 'seedream-5.0-lite', endpointId: 'ep-20260421124003-d8cgg', category: 'Image' },
      { name: 'seedream-4.5', modelId: 'seedream-4.5', endpointId: 'ep-20260417151428-sfjkt', category: 'Image' },
      { name: 'seedance-2.0', modelId: 'seedance-2.0', endpointId: 'ep-20260409105722-x6jsk', category: 'Video' },
      { name: 'seedance-2.0-fast', modelId: 'seedance-2.0-fast', endpointId: 'ep-20260409104905-4gvcs', category: 'Video' },
    ],
  },
  qwen: {
    name: '通义千问 (Qwen)',
    models: [
      { name: 'qwen3.6-plus', modelId: 'qwen3.6-plus', category: 'Chat' },
      { name: 'qwen3.6-flash', modelId: 'qwen3.6-flash', category: 'Chat' },
    ],
  },
  claude: {
    name: 'Claude (Anthropic)',
    models: [
      { name: 'claude-opus-4-8', modelId: 'claude-opus-4-8', category: 'Chat' },
      { name: 'claude-opus-4-6', modelId: 'claude-opus-4-6', category: 'Chat' },
      { name: 'claude-sonnet-4-6', modelId: 'claude-sonnet-4-6', category: 'Chat' },
    ],
  },
  gemini: {
    name: 'Gemini (Google)',
    models: [
      { name: 'gemini-3.1-pro-preview', modelId: 'gemini-3.1-pro-preview', category: 'Chat' },
      { name: 'gemini-3-flash-preview', modelId: 'gemini-3-flash-preview', category: 'Chat' },
      { name: 'gemini-2.5-flash-image-preview', modelId: 'gemini-2.5-flash-image-preview', category: 'Image' },
    ],
  },
  openai: {
    name: 'OpenAI',
    models: [
      { name: 'gpt-5.5', modelId: 'gpt-5.5', category: 'Chat' },
      { name: 'gpt-5.4-mini', modelId: 'gpt-5.4-mini', category: 'Chat' },
      { name: 'gpt-5.4-nano', modelId: 'gpt-5.4-nano', category: 'Chat' },
      { name: 'gpt-image-1', modelId: 'gpt-image-1', category: 'Image' },
    ],
  },
};

// ── Abstract model name → real model mapping ────────────────────────
// keepwork abstract names resolve through this table first,
// then the resolved modelId is looked up in the per-model settings.
const DEFAULT_ABSTRACT_MODEL_MAP: Record<string, string> = {
  'keepwork-pro':        'doubao-seed-2-0-pro',
  'keepwork-flash':      'doubao-seed-2-0-lite',
  'keepwork-image':      'seedream-5.0-lite',
  'keepwork-video':      'seedance-2.0-fast',
};

const DEFAULT_ABSTRACT_MODEL_LABEL_MAP: Record<string, string> = {
  'keepwork-pro': 'doubao-seed-2-0-pro',
  'keepwork-flash': 'doubao-seed-2-0-lite',
  'keepwork-image': 'seedream-5.0-lite',
  'keepwork-video': 'seedance-2.0-fast',
};

// ── Auto-detect provider from model ID ──────────────────────────────
const MODEL_PROVIDER_PATTERNS: Array<{ pattern: RegExp; provider: string }> = [
  { pattern: /^openrouter|^[a-z0-9_.-]+\/[a-z0-9_.:-]+/i, provider: 'openrouter' },
  { pattern: /^doubao|^seedream|^seedance|^ep-/i, provider: 'doubao' },
  { pattern: /^qwen/i, provider: 'qwen' },
  { pattern: /^claude/i, provider: 'claude' },
  { pattern: /^gemini/i, provider: 'gemini' },
  { pattern: /^gpt-|^gpt\d|^o[1-9]|^chatgpt/i, provider: 'openai' },
];

// ──────────────────────────────── 类型声明 ────────────────────────────────

/** 单个模型配置 */
interface ModelConfig {
  modelId: string;
  endpointId: string;
  apiKey: string;
  category: string;
  enabled: boolean;
  preferDirect: boolean;
  [key: string]: unknown;
}

/** 单 provider 设置 */
interface ProviderSetting {
  enabled: boolean;
  apiKey: string;
  preferDirect: boolean;
  [key: string]: unknown;
}

/** 构造选项 */
export interface LocalAPIKeySettingsOptions {
  storage?: 'personalPageStore' | 'localStorage';
  workspace?: string;
  /** 'zhCN' | 'enUS'，缺省时按系统语言自动检测 */
  lang?: string;
  [key: string]: unknown;
}

/** LocalAPIKeySettings 依赖的 SDK 表面 */
interface LAKStore {
  readFile(path: string): Promise<string>;
  createFile(path: string, content: string): Promise<unknown>;
  [key: string]: unknown;
}
interface LAKSdk {
  personalPageStore?: {
    withWorkspace(workspace: string, mountFolder?: string | null): LAKStore;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export default class LocalAPIKeySettings {
  sdk: LAKSdk;
  storageMode: string;
  workspace: string;
  _enabled: boolean;
  _models: Map<string, ModelConfig>;
  _providerSettings: Record<string, ProviderSetting>;
  _abstractModelMap: Record<string, string>;
  _loaded: boolean;
  _loadPromise: Promise<void> | null;
  _saveTimer?: ReturnType<typeof setTimeout> | null;
  _overlay: HTMLElement | null;
  _activeCategory: string;
  _activePresetTab: boolean;
  _styleInjected: boolean;
  _showOptions?: Record<string, unknown>;
  _presetClickHandler?: (e: Event) => void;
  _lang: string;
  _strings: LAKStrings;
  [key: string]: unknown;

  /**
   * @param {object} sdk  - KeepworkSDK instance
   * @param {object} [options]
   * @param {'personalPageStore'|'localStorage'} [options.storage='localStorage']
   * @param {string} [options.workspace]
   */
  constructor(sdk: unknown, options: LocalAPIKeySettingsOptions = {}) {
    this.sdk = sdk as LAKSdk;
    this.storageMode = options.storage || 'localStorage';
    this.workspace = options.workspace || 'workspace_default';

    this._enabled = false;
    /** @type {Map<string, {modelId:string,apiKey:string,category:string,enabled:boolean,preferDirect?:boolean}>} */
    this._models = new Map();
    /** @type {Object<string, {enabled:boolean, apiKey:string, preferDirect:boolean}>} per-provider settings */
    this._providerSettings = {};
    this._initProviderSettings();

    /** @type {Object<string,string>} abstract name → real model ID */
    this._abstractModelMap = { ...DEFAULT_ABSTRACT_MODEL_MAP };
    this._ensureDefaultServicePresets();

    this._loaded = false;
    this._loadPromise = null;

    // UI state
    this._overlay = null;
    this._activeCategory = 'Chat';
    this._activePresetTab = true; // default to Presets tab
    this._styleInjected = false;

    // i18n: explicit option overrides system-detected language
    this._lang = (options.lang as string) || detectLakLang();
    this._strings = LAK_TRANSLATIONS[this._lang] || LAK_TRANSLATIONS.enUS;
  }

  /** Translate a key, optionally interpolating {placeholders}. */
  _t(key: string, vars?: Record<string, string>): string {
    let s = this._strings[key] || LAK_TRANSLATIONS.enUS[key] || key;
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        s = s.replace(new RegExp(`\\{${k}\\}`, 'g'), v);
      }
    }
    return s;
  }

  // ── Public getters / setters ──────────────────────────────────────

  get enabled(): boolean { return this._enabled; }
  set enabled(val: boolean) {
    this._enabled = !!val;
    this._scheduleSave();
  }

  // ── Model CRUD ────────────────────────────────────────────────────

  setModel(name: string, config: Record<string, unknown> = {}): void {
    this._models.set(name, {
      modelId: (config.modelId as string) || name,
      endpointId: (config.endpointId as string) || '',
      apiKey: ((config.apiKey as string) || '').trim(),
      category: (config.category as string) || 'Chat',
      enabled: config.enabled !== false,
      preferDirect: config.preferDirect === true,
    });
    this._scheduleSave();
  }

  removeModel(name: string): void {
    this._models.delete(name);
    this._scheduleSave();
  }

  getModel(name: string): ModelConfig | undefined {
    return this._models.get(name);
  }

  listModels(category?: string): Array<ModelConfig & { name: string }> {
    const result: Array<ModelConfig & { name: string }> = [];
    for (const [name, cfg] of this._models) {
      if (!category || cfg.category === category) {
        result.push({ name, ...cfg });
      }
    }
    return result;
  }

  setAllModels(models: Array<Record<string, unknown>>): void {
    this._models.clear();
    for (const m of models) {
      this.setModel(m.name as string, m);
    }
  }

  // ── Resolution (used by AIChat) ───────────────────────────────────

  /**
   * Resolve a model ID (possibly abstract like 'keepwork-pro') to
   * { apiKey, realModelId }.
   * Resolution chain:
   *   1. If modelId is an abstract name, map it to a real model ID.
   *   2. Look up the real model ID in per-model settings.
   *   3. Fall back to provider-level defaults, using an explicit provider hint when supplied.
   */
  resolve(modelId: string, options: Record<string, unknown> = {}): Record<string, unknown> | null {
    if (!this._enabled) return null;
    const providerHint = (options.provider as string) || (options.providerKey as string) || null;

    // Step 1: resolve abstract name
    const mappedModelId = this._abstractModelMap[modelId] || modelId;
    const realModelId = this._resolveAbstractTarget(modelId, mappedModelId);
    const isAbstract = mappedModelId !== modelId;

    // Step 2: exact match in per-model settings
    let matched = null;
    let hasDisabledExactMatch = false;
    for (const [, cfg] of this._models) {
      if (cfg.modelId === realModelId) {
        if (cfg.enabled) {
          matched = cfg;
          break;
        }
        hasDisabledExactMatch = true;
      }
    }

    if (!matched && hasDisabledExactMatch) return null;

    // Step 3: auto-detect provider if no exact match
    if (!matched) {
      const providerKey = providerHint || this.detectProvider(realModelId);
      if (providerKey) {
        const providerModels = this.listModels().filter(m =>
          m.enabled !== false && this.detectProvider(m.modelId) === providerKey
        );
        const donor = providerModels[0];
        const apiKey = this._getProviderPresetKey(providerKey) || donor?.apiKey || '';
        if (apiKey) {
          return {
            apiKey,
            provider: providerKey,
            preferDirect: this._providerSettings[providerKey]?.preferDirect === true,
            ...(isAbstract ? { realModelId } : {}),
          };
        }
      }
    }

    const providerKey = providerHint || this._getPresetProviderByModelName([...this._models.entries()].find(([, cfg]) => cfg === matched)?.[0]) || this.detectProvider(realModelId);
    const apiKey = matched?.apiKey || this._getProviderPresetKey(providerKey) || '';
    if (!apiKey) return null;
    return {
      apiKey,
      provider: providerKey,
      preferDirect: matched?.preferDirect === true || (providerKey ? this._providerSettings[providerKey]?.preferDirect === true : false),
      ...(isAbstract ? { realModelId } : {}),
    };
  }

  _resolveAbstractTarget(abstractName: string, mappedModelId: string): string {
    if (!mappedModelId) return mappedModelId;

    // Support both custom model labels and built-in preset names stored by the UI.
    return this.resolveModelName(mappedModelId);
  }

  _getAbstractDisplayValue(abstractName: string, mappedModelId: string): string {
    const linkedLabel = DEFAULT_ABSTRACT_MODEL_LABEL_MAP[abstractName];
    const linkedModel = linkedLabel ? this.getModel(linkedLabel) : null;

    if (
      linkedLabel &&
      linkedModel?.modelId &&
      (mappedModelId === linkedLabel || mappedModelId === DEFAULT_ABSTRACT_MODEL_MAP[abstractName])
    ) {
      return linkedLabel;
    }

    return mappedModelId;
  }

  _getDropdownOptions(category: string): Array<{ name: string; modelId: string }> {
    const options: Array<{ name: string; modelId: string }> = [];
    const seen = new Set<string>();

    // Preset models
    for (const preset of Object.values(SERVICE_PRESETS)) {
      for (const m of preset.models) {
        if (m.category === category && !seen.has(m.modelId)) {
          seen.add(m.modelId);
          options.push({ name: m.name, modelId: m.modelId });
        }
      }
    }

    // User-configured models
    for (const [name, cfg] of this._models) {
      if (cfg.category === category && !seen.has(cfg.modelId)) {
        seen.add(cfg.modelId);
        options.push({ name, modelId: cfg.modelId });
      }
    }

    return options;
  }

  /**
   * Resolve settings for requests that must remain on Keepwork's `/gpt/*`
   * endpoints. This intentionally strips any direct provider baseURL.
   * @param {string} modelId
   * @returns {{apiKey:string, realModelId?:string}|null}
   */
  resolveProxyConfig(modelId: string): Record<string, unknown> | null {
    const resolved = this.resolve(modelId);
    if (!resolved) return null;

    const proxyConfig: Record<string, unknown> = {};
    if (resolved.apiKey) proxyConfig.apiKey = resolved.apiKey;
    if (resolved.realModelId) proxyConfig.realModelId = resolved.realModelId;

    return Object.keys(proxyConfig).length > 0 ? proxyConfig : null;
  }

  /**
   * Resolve settings for direct provider compatibility checks.
   * @param {string} modelId
   * @returns {{apiKey:string, realModelId?:string}|null}
   */
  resolveDirectConfig(modelId: string, options: Record<string, unknown> = {}): Record<string, unknown> | null {
    return this.resolve(modelId, options);
  }

  /**
   * Set whether a provider should prefer direct browser calls over Keepwork proxy calls.
   * Defaults to false for every provider to preserve existing behavior.
   */
  setProviderPreferDirect(providerKey: string, preferDirect: boolean): void {
    const ps = this._providerSettings[providerKey] || (this._providerSettings[providerKey] = { enabled: true, apiKey: '', preferDirect: false });
    ps.preferDirect = preferDirect === true;
    this._scheduleSave();
  }

  /** Get the saved API key for a provider preset. */
  getProviderApiKey(providerKey: string): string {
    return this._getProviderPresetKey(providerKey);
  }

  /**
   * Detect which service provider a model ID belongs to.
   * @param {string} modelId
   * @returns {string|null} provider key (e.g. 'doubao', 'openai') or null
   */
  detectProvider(modelId: string): string | null {
    if (!modelId) return null;
    for (const { pattern, provider } of MODEL_PROVIDER_PATTERNS) {
      if (pattern.test(modelId)) return provider;
    }
    return null;
  }

  // ── Abstract model mapping ────────────────────────────────────────

  /** Get the full abstract model map. */
  get abstractModelMap() { return { ...this._abstractModelMap }; }

  /** Set a single abstract mapping: keepwork-pro → real-model-id */
  setAbstractMapping(abstractName: string, realModelId: string): void {
    this._abstractModelMap[abstractName] = realModelId;
    this._scheduleSave();
  }

  /** Remove an abstract mapping. */
  removeAbstractMapping(abstractName: string): void {
    delete this._abstractModelMap[abstractName];
    this._scheduleSave();
  }

  /**
   * Reset all settings except API keys (per-provider + per-model) and the
   * abstract model mapping. Useful when the user wants to restore default
   * model lists / enabled flags / direct-call preferences without losing
   * the API keys they have already entered.
   */
  resetExceptApiKeysAndAbstractMap(): void {
    // 1. Snapshot per-model API keys so we can restore them after rebuild.
    const modelApiKeys = new Map<string, string>();
    for (const [name, cfg] of this._models) {
      if (cfg.apiKey) modelApiKeys.set(name, cfg.apiKey);
    }
    // 2. Snapshot per-provider API keys and preferDirect flags.
    const providerApiKeys: Record<string, string> = {};
    const providerPreferDirect: Record<string, boolean> = {};
    for (const [key, ps] of Object.entries(this._providerSettings)) {
      if (ps?.apiKey) providerApiKeys[key] = ps.apiKey;
      if (ps?.preferDirect === true) providerPreferDirect[key] = true;
    }
    // 3. Snapshot per-model preferDirect flags.
    const modelPreferDirect = new Map<string, boolean>();
    for (const [name, cfg] of this._models) {
      if (cfg.preferDirect === true) modelPreferDirect.set(name, true);
    }
    // 4. Clear models and provider settings, then re-init defaults.
    this._models.clear();
    this._providerSettings = {};
    this._initProviderSettings();
    // 5. Restore provider API keys and preferDirect flags.
    for (const [key, apiKey] of Object.entries(providerApiKeys)) {
      if (this._providerSettings[key]) this._providerSettings[key].apiKey = apiKey;
    }
    for (const key of Object.keys(providerPreferDirect)) {
      if (this._providerSettings[key]) this._providerSettings[key].preferDirect = true;
    }
    // 6. Re-create preset model entries (will pick up restored provider keys).
    this._ensureDefaultServicePresets();
    // 7. Restore any per-model API keys and preferDirect flags that may have
    //    been stronger than the provider-level fallback.
    for (const [name, apiKey] of modelApiKeys) {
      const existing = this._models.get(name);
      if (existing) {
        existing.apiKey = apiKey;
        this._models.set(name, existing);
      }
    }
    for (const [name] of modelPreferDirect) {
      const existing = this._models.get(name);
      if (existing) {
        existing.preferDirect = true;
        this._models.set(name, existing);
      }
    }
    this._scheduleSave();
  }

  /** Get the real model ID for an abstract name (or return the name unchanged). */
  resolveAbstractName(name: string): string {
    return this._abstractModelMap[name] || name;
  }

  /**
   * Resolve a display name (e.g. "Doubao Seedance 2.0 fast") to its modelId
   * (e.g. "seedance-2.0-fast").  Returns the input unchanged if no match found.
   * @param {string} name
   * @returns {string}
   */
  resolveModelName(name: string): string {
    if (!name) return name;

    // 1. Check user-configured models (keys are display names)
    const model = this._models.get(name);
    if (model?.modelId) return model.modelId;

    // 2. Check SERVICE_PRESETS
    for (const preset of Object.values(SERVICE_PRESETS)) {
      for (const m of preset.models) {
        if (m.name === name) return m.modelId;
      }
    }

    return name;
  }

  get hasSettings(): boolean {
    return this._enabled && this._models.size > 0;
  }

  /**
   * Resolve a model name/ID to { model, apiKey } for use by AIChat / AIChatRTC / AIGenerators.
   * Handles display-name resolution, abstract-name mapping, and enabled checks.
   * @param {string} model
   * @param {object|string} [options] - Optional { provider } hint, or provider key string.
   * @returns {{model: string, apiKey: string, provider?: string, preferDirect?: boolean}}
   */
  resolveModelSettings(model: string, options: Record<string, unknown> | string = {}): Record<string, unknown> {
    if (!model) return { model: '', apiKey: '' };

    const resolveOptions: Record<string, unknown> = typeof options === 'string' ? { provider: options } : (options || {});

    // When the local API key feature is not globally enabled, pass the model
    // name through unchanged. No abstract-name mapping, no per-model lookup,
    // no provider inference — the caller is responsible for whatever the
    // server-side defaults expect.
    if (!this._enabled) {
      return {
        model,
        apiKey: '',
        provider: resolveOptions.provider || resolveOptions.providerKey || null,
        preferDirect: false,
      };
    }

    const modelId = this.resolveModelName(model);

    // Always resolve abstract mapping + detect provider so callers (e.g. direct
    // image/video generation) get the correct provider even when no per-model
    // settings are configured (but the master toggle is on).
    const mappedModelId = this._abstractModelMap[modelId] || modelId;
    const realModelId = this._resolveAbstractTarget(modelId, mappedModelId) || modelId;
    const detectedProvider = resolveOptions.provider || resolveOptions.providerKey || this.detectProvider(realModelId);

    if (!this.hasSettings) {
      return {
        model: realModelId,
        apiKey: '',
        provider: detectedProvider,
        preferDirect: false,
      };
    }

    const resolved = this.resolve(modelId, resolveOptions);
    if (!resolved) {
      return {
        model: realModelId,
        apiKey: '',
        provider: detectedProvider,
        preferDirect: false,
      };
    }

    return {
      model: resolved.realModelId || realModelId,
      apiKey: resolved.apiKey || '',
      provider: resolved.provider || this.detectProvider((resolved.realModelId as string) || realModelId),
      preferDirect: resolved.preferDirect === true,
    };
  }

  // ── Persistence ───────────────────────────────────────────────────

  async load(): Promise<void> {
    if (this._loaded) return;
    if (this._loadPromise) return this._loadPromise;
    this._loadPromise = this._doLoad();
    await this._loadPromise;
    this._loaded = true;
    this._loadPromise = null;
  }

  _getStore(): LAKStore | null {
    const pps = this.sdk?.personalPageStore;
    return pps ? pps.withWorkspace(this.workspace) : null;
  }

  async _doLoad(): Promise<void> {
    try {
      let data: Record<string, unknown> | null = null;
      if (this.storageMode === 'personalPageStore') {
        const store = this._getStore();
        if (store) {
          const raw = await store.readFile(STORAGE_FILE);
          if (raw) data = JSON.parse(raw);
        }
      } else {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) data = JSON.parse(raw);
      }
      if (data) this._applyData(data);
      const changed = this._ensureDefaultServicePresets();
      if (changed && data) this._scheduleSave();
    } catch (e) {
      console.warn('[LocalAPIKeySettings] Failed to load settings:', e);
    }
  }

  async save(): Promise<void> {
    const data = this._serializeData();
    try {
      if (this.storageMode === 'personalPageStore') {
        const store = this._getStore();
        if (store) {
          await store.createFile(STORAGE_FILE, JSON.stringify(data, null, 2));
        }
      } else {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data, null, 2));
      }
    } catch (e) {
      console.warn('[LocalAPIKeySettings] Failed to save settings:', e);
    }
  }

  async clear(): Promise<void> {
    this._models.clear();
    this._providerSettings = {};
    this._initProviderSettings();
    this._abstractModelMap = { ...DEFAULT_ABSTRACT_MODEL_MAP };
    this._ensureDefaultServicePresets();
    try {
      if (this.storageMode === 'personalPageStore') {
        const store = this._getStore();
        if (store) await store.createFile(STORAGE_FILE, '');
      } else {
        localStorage.removeItem(STORAGE_KEY);
      }
    } catch (e) {
      console.warn('[LocalAPIKeySettings] Failed to clear settings:', e);
    }
  }

  // ── Serialization helpers ─────────────────────────────────────────

  _serializeData(): Record<string, unknown> {
    const models: Array<Record<string, unknown>> = [];
    for (const [name, cfg] of this._models) {
      models.push({ name, ...cfg });
    }
    const providers: Record<string, unknown> = {};
    for (const [key, ps] of Object.entries(this._providerSettings)) {
      providers[key] = { enabled: ps.enabled, apiKey: ps.apiKey, preferDirect: ps.preferDirect === true };
    }
    return {
      enabled: this._enabled,
      models,
      providers,
      abstractModelMap: { ...this._abstractModelMap },
    };
  }

  /**
   * Build a one-shot map of legacy Volcano Endpoint IDs to friendly model names.
   * Older builds persisted `modelId: 'ep-...'`; we transparently rewrite them.
   */
  _endpointIdToFriendlyName(endpointId: string): string | null {
    if (!endpointId || typeof endpointId !== 'string' || !endpointId.startsWith('ep-')) return null;
    for (const preset of Object.values(SERVICE_PRESETS)) {
      for (const m of preset.models) {
        if (m.endpointId === endpointId) return m.modelId;
      }
    }
    return null;
  }

  _applyData(data: Record<string, unknown>): void {
    if (!data) return;
    this._enabled = data.enabled !== false;
    this._models.clear();
    // Load provider settings (new format) or migrate from old format
    this._providerSettings = {};
    this._initProviderSettings();
    if (data.providers && typeof data.providers === 'object') {
      for (const [key, psRaw] of Object.entries(data.providers as Record<string, unknown>)) {
        const ps = psRaw as Record<string, unknown>;
        if (this._providerSettings[key]) {
          this._providerSettings[key].enabled = ps.enabled !== false;
          this._providerSettings[key].apiKey = (ps.apiKey as string) || '';
          this._providerSettings[key].preferDirect = ps.preferDirect === true;
        }
      }
    } else {
      // Migrate from old format
      const oldDisabledProviders = new Set(
        Array.isArray(data.disabledPresetProviders) ? data.disabledPresetProviders : []
      );
      const oldApiKeys: Record<string, string> = (data.providerApiKeys && typeof data.providerApiKeys === 'object')
        ? (data.providerApiKeys as Record<string, string>) : {};
      for (const key of Object.keys(this._providerSettings)) {
        this._providerSettings[key].enabled = !oldDisabledProviders.has(key);
        if (oldApiKeys[key]) this._providerSettings[key].apiKey = oldApiKeys[key];
      }
    }
    if (Array.isArray(data.models)) {
      for (const mRaw of data.models) {
        const m = mRaw as Record<string, unknown>;
        const key = (m.name as string) || (m.label as string);
        const storedModelId = (m.modelId as string) || key;
        const migratedModelId = this._endpointIdToFriendlyName(storedModelId) || storedModelId;
        // If the stored modelId was actually an endpointId, recover it.
        const recoveredEndpointId = (storedModelId !== migratedModelId) ? storedModelId : '';
        // Look up preset endpointId as fallback so existing saves still surface it.
        const presetEndpointId = (() => {
          for (const preset of Object.values(SERVICE_PRESETS)) {
            const hit = preset.models.find(pm => pm.name === key || pm.modelId === migratedModelId);
            if (hit?.endpointId) return hit.endpointId;
          }
          return '';
        })();
        this._models.set(key, {
          modelId: migratedModelId,
          endpointId: (m.endpointId as string) || recoveredEndpointId || presetEndpointId,
          apiKey: (m.apiKey as string) || '',
          category: (m.category as string) || 'Chat',
          enabled: m.enabled !== false,
          preferDirect: m.preferDirect === true,
        });
      }
    }
    // Merge persisted abstract mappings over defaults
    this._abstractModelMap = { ...DEFAULT_ABSTRACT_MODEL_MAP };
    if (data.abstractModelMap && typeof data.abstractModelMap === 'object') {
      for (const [abs, realRaw] of Object.entries(data.abstractModelMap as Record<string, unknown>)) {
        const real = realRaw as string;
        this._abstractModelMap[abs] = this._endpointIdToFriendlyName(real) || real;
      }
    }
  }

  /** Ensure _providerSettings has an entry for every SERVICE_PRESETS key. */
  _initProviderSettings(): void {
    for (const key of Object.keys(SERVICE_PRESETS)) {
      if (!this._providerSettings[key]) {
        this._providerSettings[key] = { enabled: true, apiKey: '', preferDirect: false };
      } else if (this._providerSettings[key].preferDirect !== true) {
        this._providerSettings[key].preferDirect = false;
      }
    }
  }

  _ensureDefaultServicePresets(): boolean {
    let changed = false;
    for (const [providerKey, preset] of Object.entries(SERVICE_PRESETS)) {
      const ps = this._providerSettings[providerKey];
      if (!ps?.enabled) continue;

      const existingProviderModel = this.listModels().find(m => this.detectProvider(m.modelId) === providerKey);
      const apiKey = ps.apiKey || existingProviderModel?.apiKey || '';

      for (const m of preset.models) {
        if (this._models.has(m.name)) continue;
        this._models.set(m.name, {
          modelId: m.modelId,
          endpointId: m.endpointId || '',
          apiKey,
          category: m.category,
          enabled: true,
          preferDirect: false,
        });
        changed = true;
      }
    }
    return changed;
  }

  _getPresetProviderByModelName(name: string | undefined): string | null {
    for (const [providerKey, preset] of Object.entries(SERVICE_PRESETS)) {
      if (preset.models.some(m => m.name === name)) return providerKey;
    }
    return null;
  }

  _scheduleSave(): void {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => { void this.save(); }, 500);
  }

  toJSON(): Record<string, unknown> { return this._serializeData(); }

  fromJSON(data: Record<string, unknown>): void {
    this._applyData(data);
    this._ensureDefaultServicePresets();
    this._scheduleSave();
  }

  // ══════════════════════════════════════════════════════════════════
  // ── Self-contained Settings Modal UI ─────────────────────────────
  // ══════════════════════════════════════════════════════════════════

  /**
   * Open the settings modal.
   * @param {object} [options]
   * @param {Function} [options.onClose]  - Called when the modal is dismissed.
   * @param {Function} [options.onSave]   - Called after settings are saved.
   * @param {string}   [options.title]    - Modal title override.
   * @param {string}   [options.lang]     - 'zhCN' | 'enUS' (auto-detected if omitted).
   * @param {boolean}  [options.fullscreen=false] - Use the full viewport instead of a centered dialog.
   */
  show(options: Record<string, unknown> = {}): void {
    if (this._overlay) this.hide();
    this._showOptions = options;
    // Allow per-show language override
    if (options.lang) {
      this._lang = options.lang as string;
      this._strings = LAK_TRANSLATIONS[this._lang] || LAK_TRANSLATIONS.enUS;
    }
    this._injectStyles();

    const overlay = document.createElement('div');
    overlay.className = `lak-overlay${options.fullscreen ? ' lak-overlay-fullscreen' : ''}`;
    // Inline the critical viewport-locking styles so the modal renders correctly
    // even when the host page's CSS (e.g. Tailwind preflight) or a transformed /
    // scaled ancestor would otherwise constrain it. Inline styles win over the
    // injected stylesheet for these specific properties.
    overlay.style.cssText =
      'position:fixed;top:0;left:0;right:0;bottom:0;' +
      'width:100vw;height:100vh;height:100dvh;' +
      'z-index:2147483647;margin:0;';
    overlay.innerHTML = this._buildHTML(options);
    // Always portal to the top-level <body> so we escape any transformed /
    // filtered / contained ancestor that would trap a fixed-positioned element.
    (document.body || document.documentElement).appendChild(overlay);
    this._overlay = overlay;

    this._populateFields();
    this._renderActivePanel();
    this._bindEvents();

    // Animate in
    requestAnimationFrame(() => overlay.classList.add('lak-visible'));
  }

  /** Close the modal. */
  hide() {
    if (!this._overlay) return;
    this._overlay.classList.remove('lak-visible');
    setTimeout(() => {
      this._overlay?.remove();
      this._overlay = null;
    }, 200);
    const onClose = this._showOptions?.onClose;
    if (typeof onClose === 'function') (onClose as () => void)();
  }

  /** Toggle: show if hidden, hide if shown. */
  toggle(options?: Record<string, unknown>): void {
    if (this._overlay) { this.hide(); } else { this.show(options); }
  }

  // ── HTML builder ──────────────────────────────────────────────────

  _buildHTML(options: Record<string, unknown> = {}): string {
    const title = (options.title as string) || this._t('title');
    const tabs = CATEGORIES.map(cat =>
      `<button class="lak-tab ${cat === this._activeCategory ? 'lak-tab-active' : ''}" data-lak-cat="${cat}">${cat} <span class="lak-badge" data-lak-count="${cat}">0</span></button>`
    ).join('');

    return `
      <div class="lak-box">
        <div class="lak-header">
          <h2 class="lak-title">${this._esc(title)}</h2>
          <span class="lak-global-status ${this._enabled ? 'lak-global-status-on' : 'lak-global-status-off'}" data-lak="globalStatus">
            ${this._enabled ? this._esc(this._t('statusOn')) : this._esc(this._t('statusOff'))}
          </span>
          <label class="lak-switch lak-global-switch" title="${this._attr(this._t('globalSwitchTitle'))}">
            <input type="checkbox" data-lak="globalEnabled" ${this._enabled ? 'checked' : ''} />
            <span class="lak-switch-slider"></span>
          </label>
          <button class="lak-close" data-lak="close">&times;</button>
        </div>

        <div class="lak-tabs">${tabs}<button class="lak-tab ${this._activePresetTab ? 'lak-tab-active' : ''}" data-lak-cat="Presets">${this._esc(this._t('tabPresets'))}</button></div>

        <div class="lak-model-list" data-lak="modelList"></div>
        <div class="lak-presets-panel" data-lak="presetsPanel" style="display:none"></div>

        <div class="lak-add-row" data-lak="addRow">
          <input class="lak-input lak-add-input" data-lak="newLabel" type="text" placeholder="${this._attr(this._t('newModelPlaceholder'))}" />
          <button class="lak-btn lak-btn-primary" data-lak="addModel">${this._esc(this._t('add'))}</button>
        </div>

        <div class="lak-storage-row" ${options.showStorage ? '' : 'style="display:none"'}>
          <label class="lak-label">${this._esc(this._t('storageMode'))}</label>
          <div style="display:flex;gap:8px;margin-top:6px;align-items:center">
            <select class="lak-input" data-lak="storageMode" style="width:auto;flex:0 0 160px">
              <option value="localStorage"${this.storageMode === 'localStorage' ? ' selected' : ''}>localStorage</option>
              <option value="personalPageStore"${this.storageMode === 'personalPageStore' ? ' selected' : ''}>PersonalPageStore</option>
            </select>
            <input class="lak-input" data-lak="workspace" type="text" placeholder="${this._attr(this._t('workspacePlaceholder'))}"
              value="${this._attr(this.workspace)}" style="flex:1;${this.storageMode === 'localStorage' ? 'opacity:0.4;pointer-events:none' : ''}" />
          </div>
        </div>

        <div class="lak-footer">
          <button class="lak-btn lak-btn-default" data-lak="import">${this._esc(this._t('import'))}</button>
          <button class="lak-btn lak-btn-default" data-lak="export">${this._esc(this._t('export'))}</button>
          <button class="lak-btn lak-btn-danger" data-lak="clearAll">${this._esc(this._t('clearAll'))}</button>
          <button class="lak-btn lak-btn-default" data-lak="resetExceptKeys" title="${this._attr(this._t('resetTitle'))}">${this._esc(this._t('reset'))}</button>
          <span style="flex:1"></span>
          <button class="lak-btn lak-btn-primary" data-lak="close">${this._esc(this._t('close'))}</button>
        </div>
      </div>`;
  }

  // ── Populate fields from state ────────────────────────────────────

  _populateFields() {
    // placeholder for future field population
  }

  _renderModels() {
    const container = this._overlay?.querySelector('[data-lak="modelList"]');
    if (!container) return;
    const models = this.listModels(this._activeCategory);

    if (models.length === 0) {
      container.innerHTML = `<div class="lak-empty">${this._esc(this._t('emptyModels'))}</div>`;
    } else {
      container.innerHTML = models.map(m => {
        const provKey = this._getPresetProviderByModelName(m.name) || this.detectProvider(m.modelId);
        const presetKey = this._getProviderPresetKey(provKey);
        const mismatch = !!(provKey && presetKey && m.apiKey !== presetKey);
        const providerName = provKey ? (SERVICE_PRESETS[provKey]?.name || provKey) : '';
        const warnTitle = mismatch
          ? this._t('mismatchTitle', { provider: providerName })
          : '';
        return `
        <div class="lak-model-card">
          <div class="lak-model-head">
            <span class="lak-dot ${m.enabled ? 'lak-dot-on' : ''}"></span>
            <span class="lak-model-label">${this._esc(m.name)}</span>
            <span class="lak-model-cat">${this._esc(m.category)}</span>
            <span style="flex:1"></span>
            <button type="button" class="lak-switch lak-card-switch" data-lak-action="toggle" data-lak-label="${this._attr(m.name)}" aria-pressed="${m.enabled ? 'true' : 'false'}" title="${this._attr(this._t('modelToggleTitle'))}">
              <span class="lak-switch-slider"></span>
            </button>
            <button class="lak-link lak-link-danger" data-lak-action="delete" data-lak-label="${this._attr(m.name)}">${this._esc(this._t('delete'))}</button>
          </div>
          <div class="lak-field-row">
            <label class="lak-field-label">${m.endpointId ? 'ENDPOINT ID' : 'MODEL ID'}</label>
            <input class="lak-input lak-model-input" data-lak-field="${m.endpointId ? 'endpointId' : 'modelId'}" data-lak-label="${this._attr(m.name)}" value="${this._attr(m.endpointId || m.modelId)}" />
          </div>
          <div class="lak-field-row">
            <label class="lak-field-label">API KEY${mismatch ? ` <span class="lak-key-warn" title="${this._attr(warnTitle)}">${this._esc(this._t('mismatchWarn'))}</span>` : ''}</label>
            <div class="lak-key-wrap">
              <input class="lak-input lak-model-input ${mismatch ? 'lak-input-warn' : ''}" data-lak-field="apiKey" data-lak-label="${this._attr(m.name)}" type="password" value="${this._attr(m.apiKey)}" placeholder="sk-..." ${mismatch ? `title="${this._attr(warnTitle)}"` : ''} />
              <button class="lak-eye" data-lak-eye title="${this._attr(this._t('eyeTitle'))}">${this._eyeIcon(false)}</button>
              ${mismatch ? `<button class="lak-link lak-key-sync" data-lak-action="syncPresetKey" data-lak-label="${this._attr(m.name)}" title="${this._attr(this._t('syncTitle'))}">${this._esc(this._t('sync'))}</button>` : ''}
            </div>
          </div>
        </div>`;
      }).join('');
    }
    this._updateCounts();
  }

  /**
   * Return the "canonical" API key for a provider preset — the first
   * configured preset model's apiKey (matches what Presets tab shows).
   * Returns '' when no preset model for this provider is configured.
   */
  _getProviderPresetKey(providerKey: string | null): string {
    if (!providerKey) return '';
    // Prefer stored provider-level key
    const ps = this._providerSettings[providerKey];
    if (ps?.apiKey) return ps.apiKey;
    const preset = SERVICE_PRESETS[providerKey];
    if (!preset) return '';
    // Fallback: first configured preset model with a key
    for (const [name, cfg] of this._models) {
      if (this.detectProvider(cfg.modelId) === providerKey && cfg.apiKey) {
        return cfg.apiKey;
      }
    }
    for (const m of preset.models) {
      const cfg = this._models.get(m.name);
      if (cfg && cfg.apiKey) return cfg.apiKey;
    }
    return '';
  }

  /** Set provider-level API key and propagate to models whose key matched the old value. */
  setProviderApiKey(providerKey: string, newApiKey: string): void {
    const ps = this._providerSettings[providerKey] || (this._providerSettings[providerKey] = { enabled: true, apiKey: '', preferDirect: false });
    const oldKey = ps.apiKey || '';
    ps.apiKey = newApiKey;
    const preset = SERVICE_PRESETS[providerKey];
    if (!preset) { this._scheduleSave(); return; }
    for (const m of preset.models) {
      const existing = this.getModel(m.name);
      if (existing && (!existing.apiKey || existing.apiKey === oldKey)) {
        existing.apiKey = newApiKey;
        this._models.set(m.name, existing);
      }
    }
    this._scheduleSave();
  }

  _updateCounts(): void {
    if (!this._overlay) return;
    const overlay = this._overlay;
    CATEGORIES.forEach(cat => {
      const badge = overlay.querySelector(`[data-lak-count="${cat}"]`);
      if (badge) badge.textContent = String(this.listModels(cat).length);
    });
  }

  _renderActivePanel() {
    if (this._activePresetTab) {
      this._switchToPresets();
      return;
    }
    this._switchToCategory(this._activeCategory);
  }

  // ── Presets panel ─────────────────────────────────────────────────

  _switchToPresets(): void {
    this._activePresetTab = true;
    const o = this._overlay;
    if (!o) return;
    (o.querySelector('[data-lak="modelList"]') as HTMLElement).style.display = 'none';
    (o.querySelector('[data-lak="addRow"]') as HTMLElement).style.display = 'none';
    (o.querySelector('[data-lak="presetsPanel"]') as HTMLElement).style.display = '';
    o.querySelectorAll('.lak-tab').forEach(t => {
      t.classList.toggle('lak-tab-active', (t as HTMLElement).dataset.lakCat === 'Presets');
    });
    this._renderPresets();
  }

  _switchToCategory(cat: string): void {
    this._activePresetTab = false;
    this._activeCategory = cat;
    const o = this._overlay;
    if (!o) return;
    (o.querySelector('[data-lak="modelList"]') as HTMLElement).style.display = '';
    (o.querySelector('[data-lak="addRow"]') as HTMLElement).style.display = '';
    (o.querySelector('[data-lak="presetsPanel"]') as HTMLElement).style.display = 'none';
    o.querySelectorAll('.lak-tab').forEach(t => {
      t.classList.toggle('lak-tab-active', (t as HTMLElement).dataset.lakCat === cat);
    });
    this._renderModels();
  }

  _renderPresets(): void {
    const container = this._overlay?.querySelector('[data-lak="presetsPanel"]') as HTMLElement | null;
    if (!container) return;
    this._updateCounts();

    // Build abstract model mapping section
    const abstractRows = Object.entries(this._abstractModelMap).map(([abs, real]) => {
      const category = abs === 'keepwork-image' ? 'Image' : abs === 'keepwork-video' ? 'Video' : 'Chat';
      const options = this._getDropdownOptions(category);
      const currentModelId = this._resolveAbstractTarget(abs, real);
      if (currentModelId && !options.some(o => o.modelId === currentModelId)) {
        options.unshift({ name: currentModelId, modelId: currentModelId });
      }
      return `
      <div class="lak-field-row" style="display:flex;gap:8px;align-items:center">
        <input class="lak-input" style="flex:0 0 140px;font-weight:500" value="${this._attr(abs)}" readonly />
        <span style="color:#666;flex-shrink:0">→</span>
        <select class="lak-input lak-abstract-select" data-lak-abs="${this._attr(abs)}" style="flex:1">
          <option value="">${this._esc(this._t('selectModel'))}</option>
          ${options.map(opt => `
            <option value="${this._attr(opt.modelId)}" ${opt.modelId === currentModelId ? 'selected' : ''}>
              ${this._esc(opt.name)}
            </option>
          `).join('')}
        </select>
        <span class="lak-provider-badge" data-lak-abs-provider="${this._attr(abs)}">${this._esc(this._providerLabel(currentModelId))}</span>
      </div>`;
    }).join('');

    // Build provider cards
    const providerCards = Object.entries(SERVICE_PRESETS).map(([key, preset]) => {
      const configured = this.listModels().filter(m => this.detectProvider(m.modelId) === key);
      const ps = this._providerSettings[key];
      const isEnabled = ps?.enabled !== false && configured.length > 0;
      const preferDirect = ps?.preferDirect === true;
      const apiKeyValue = ps?.apiKey || configured[0]?.apiKey || '';
      return `
      <div class="lak-preset-card ${isEnabled ? 'lak-preset-on' : ''}" data-lak-provider="${key}">
        <div class="lak-preset-head">
          <span class="lak-dot ${isEnabled ? 'lak-dot-on' : ''}"></span>
          <span class="lak-preset-name">${this._esc(preset.name)}</span>
          <span class="lak-model-cat">${preset.models.map(m => m.category).filter((v,i,a) => a.indexOf(v) === i).join('/')}</span>
          <span style="flex:1"></span>
          <button type="button" class="lak-switch lak-card-switch" data-lak-preset-action="${isEnabled ? 'disable' : 'enable'}" data-lak-provider="${key}" aria-pressed="${isEnabled ? 'true' : 'false'}" title="${this._attr(this._t('providerToggleTitle'))}">
            <span class="lak-switch-slider"></span>
          </button>
        </div>
        <div class="lak-field-row">
          <label class="lak-field-label">API KEY</label>
          <div class="lak-key-wrap">
            <input class="lak-input lak-preset-key" data-lak-provider="${key}" type="password"
              value="${this._attr(apiKeyValue)}" placeholder="${this._attr(this._t('presetKeyPlaceholder', { provider: preset.name }))}" />
            <button class="lak-eye" data-lak-eye title="${this._attr(this._t('eyeTitle'))}">${this._eyeIcon(false)}</button>
          </div>
        </div>
        <label class="lak-direct-row" title="${this._attr(this._t('preferDirectTitle'))}">
          <input type="checkbox" class="lak-preset-direct" data-lak-provider="${key}" ${preferDirect ? 'checked' : ''} />
          <span>${this._esc(this._t('preferDirect'))}</span>
        </label>
        ${preset.note ? `<p class="lak-hint" style="margin-top:4px">${this._esc(preset.note)}</p>` : ''}
        <div class="lak-preset-models">
          ${preset.models.map(m => {
            const existing = this.getModel(m.name);
            const isOn = existing?.enabled !== false;
            return `<span class="lak-preset-model-tag ${existing ? (isOn ? 'lak-tag-on' : 'lak-tag-off') : ''}" data-lak-toggle-model="${this._attr(m.name)}" style="cursor:pointer" title="${this._attr(this._t('modelToggleTitle'))}">${this._esc(m.name)} <span style="color:#888;font-size:10px">${this._esc(m.category)}</span></span>`;
          }).join('')}
        </div>
      </div>`;
    }).join('');

    // Build User API Key section
    const currentUserApiKey = this.sdk?.userApiKey || '';
    const userApiKeySection = `
      <div style="padding:12px 20px 0">
        <div class="lak-section-title">${this._esc(this._t('userApiKey'))}</div>
        <p class="lak-hint" style="margin-bottom:10px">${this._esc(this._t('userApiKeyHint'))}</p>
        <div class="lak-field-row">
          <div class="lak-key-wrap">
            <input class="lak-input" data-lak-user-api-key type="password"
              value="${this._attr(currentUserApiKey)}" placeholder="sk-..." style="margin-top:0" />
            <button class="lak-eye" data-lak-eye title="${this._attr(this._t('eyeTitle'))}">${this._eyeIcon(false)}</button>
          </div>
          <div style="display:flex;gap:8px;margin-top:8px;align-items:center">
            <span class="lak-hint" style="margin:0;flex:1">${currentUserApiKey ? this._esc(this._t('configured')) : this._esc(this._t('notConfigured'))}</span>
            <button class="lak-btn lak-btn-primary" data-lak-action="saveUserApiKey" style="padding:4px 12px;font-size:12px">${this._esc(this._t('save'))}</button>
            <button class="lak-btn lak-btn-danger" data-lak-action="clearUserApiKey" style="padding:4px 12px;font-size:12px" ${currentUserApiKey ? '' : 'disabled'}>${this._esc(this._t('clearKey'))}</button>
          </div>
        </div>
      </div>
    `;

    container.innerHTML = `
      ${userApiKeySection}
      <div style="padding:12px 20px">
        <div class="lak-section-title">${this._esc(this._t('abstractMapping'))}</div>
        <p class="lak-hint" style="margin-bottom:10px">${this._esc(this._t('abstractMappingHint'))}</p>
        ${abstractRows}
      </div>
      <div style="padding:0 20px 12px">
        <div class="lak-section-title">${this._esc(this._t('servicePresets'))}</div>
        <p class="lak-hint" style="margin-bottom:10px">${this._esc(this._t('servicePresetsHint'))}</p>
        ${providerCards}
      </div>
    `;

    this._bindPresetEvents(container);
  }

  _bindPresetEvents(container: HTMLElement): void {
    // User API Key — save button
    const userApiKeyInput = container.querySelector('[data-lak-user-api-key]') as HTMLInputElement | null;
    container.querySelector('[data-lak-action="saveUserApiKey"]')?.addEventListener('click', () => {
      const val = userApiKeyInput?.value?.trim();
      if (val) {
        (this.sdk as Record<string, unknown> & { setUserApiKey?: (v: string) => void }).setUserApiKey?.(val);
      } else {
        (this.sdk as Record<string, unknown> & { clearUserApiKey?: () => void }).clearUserApiKey?.();
      }
      this._renderPresets();
    });

    // User API Key clear button
    container.querySelector('[data-lak-action="clearUserApiKey"]')?.addEventListener('click', () => {
      const clearFn = (this.sdk as Record<string, unknown> & { clearUserApiKey?: () => void }).clearUserApiKey;
      if (clearFn) clearFn();
      if (userApiKeyInput) userApiKeyInput.value = '';
      this._renderPresets();
    });

    // Abstract model mapping changes
    container.querySelectorAll('.lak-abstract-select').forEach(select => {
      select.addEventListener('change', (e) => {
        const target = e.target as HTMLInputElement;
        const absName = target.dataset.lakAbs as string;
        const newModelId = target.value.trim();
        if (newModelId) {
          this.setAbstractMapping(absName, newModelId);
        }
        // Update provider badge
        const badge = container.querySelector(`[data-lak-abs-provider="${absName}"]`);
        if (badge) badge.textContent = this._providerLabel(newModelId);
      });
    });

    // Preset add/remove actions
    // 先移除旧监听器，防止重复绑定导致多次触发和卡死
    if (this._presetClickHandler) {
      container.removeEventListener('click', this._presetClickHandler);
    }
    this._presetClickHandler = (e: Event) => {
      const btn = (e.target as HTMLElement)?.closest('[data-lak-preset-action]') as HTMLElement | null;
      if (!btn) return;
      const providerKey = btn.dataset.lakProvider as string;
      const action = btn.dataset.lakPresetAction;
      const preset = SERVICE_PRESETS[providerKey];
      if (!preset) return;

      if (action === 'enable') {
        const ps = this._providerSettings[providerKey] || (this._providerSettings[providerKey] = { enabled: true, apiKey: '', preferDirect: false });
        ps.enabled = true;
        const keyInput = container.querySelector(`.lak-preset-key[data-lak-provider="${providerKey}"]`) as HTMLInputElement | null;
        const apiKey = keyInput?.value?.trim() || ps.apiKey || '';
        ps.apiKey = apiKey;
        for (const m of preset.models) {
          this.setModel(m.name, {
            modelId: m.modelId,
            apiKey,
            category: m.category,
            enabled: true,
            preferDirect: false,
          });
        }
        this._renderPresets();
      } else if (action === 'disable') {
        const ps = this._providerSettings[providerKey] || (this._providerSettings[providerKey] = { enabled: true, apiKey: '', preferDirect: false });
        ps.enabled = false;
        for (const m of preset.models) {
          const existing = this.getModel(m.name);
          if (existing) {
            existing.enabled = false;
            this._models.set(m.name, existing);
          }
        }
        this._scheduleSave();
        this._renderPresets();
      }
    };
    container.addEventListener('click', this._presetClickHandler);

    // API key change → update models whose key matched the old provider key
    container.querySelectorAll('.lak-preset-key').forEach(input => {
      const sync = (e: Event) => {
        const target = e.target as HTMLInputElement;
        const providerKey = target.dataset.lakProvider;
        if (!providerKey) return;
        const newApiKey = target.value.trim();
        this.setProviderApiKey(providerKey, newApiKey);
      };
      input.addEventListener('input', sync);
      input.addEventListener('change', sync);
    });

    container.querySelectorAll('.lak-preset-direct').forEach(input => {
      input.addEventListener('change', (e) => {
        const target = e.target as HTMLInputElement;
        const providerKey = target.dataset.lakProvider;
        if (!providerKey) return;
        this.setProviderPreferDirect(providerKey, target.checked);
      });
    });

    // Individual model toggle
    container.addEventListener('click', (e) => {
      const tag = (e.target as HTMLElement)?.closest('[data-lak-toggle-model]') as HTMLElement | null;
      if (!tag) return;
      const name = tag.dataset.lakToggleModel as string;
      const cfg = this.getModel(name);
      if (!cfg) return;
      cfg.enabled = !cfg.enabled;
      this._models.set(name, cfg);
      this._scheduleSave();
      this._renderPresets();
    });
  }

  _providerLabel(modelId: string): string {
    const p = this.detectProvider(modelId);
    return p ? (SERVICE_PRESETS[p]?.name || p) : this._t('custom');
  }

  // ── Event binding ─────────────────────────────────────────────────

  _bindEvents(): void {
    const o = this._overlay;
    if (!o) return;

    // Close
    o.addEventListener('click', (e) => {
      if (e.target === o || (e.target as HTMLElement)?.closest('[data-lak="close"]')) {
        this.hide();
      }
    });

    // Eye toggle for API key visibility
    o.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement)?.closest('[data-lak-eye]') as HTMLElement | null;
      if (!btn) return;
      const wrap = btn.closest('.lak-key-wrap');
      const input = wrap?.querySelector('input') as HTMLInputElement | null;
      if (!input) return;
      const showing = input.type === 'text';
      input.type = showing ? 'password' : 'text';
      btn.innerHTML = this._eyeIcon(!showing);
    });

    // Tab switching
    o.addEventListener('click', (e) => {
      const tab = (e.target as HTMLElement)?.closest('.lak-tab[data-lak-cat]') as HTMLElement | null;
      if (!tab) return;
      const cat = tab.dataset.lakCat as string;
      if (cat === 'Presets') {
        this._switchToPresets();
      } else {
        this._switchToCategory(cat);
      }
    });

    // Global enabled toggle
    o.querySelector('[data-lak="globalEnabled"]')?.addEventListener('change', (e) => {
      this.enabled = (e.target as HTMLInputElement).checked;
      const status = o.querySelector('[data-lak="globalStatus"]');
      if (status) {
        status.textContent = this._enabled ? this._t('statusOn') : this._t('statusOff');
        status.classList.toggle('lak-global-status-on', this._enabled);
        status.classList.toggle('lak-global-status-off', !this._enabled);
      }
    });

    // Add model
    o.querySelector('[data-lak="addModel"]')?.addEventListener('click', () => {
      const input = o.querySelector('[data-lak="newLabel"]') as HTMLInputElement | null;
      const name = input?.value?.trim();
      if (!name) return;
      this.setModel(name, {
        modelId: name.toLowerCase().replace(/\s+/g, '-'),
        category: this._activeCategory,
      });
      if (input) input.value = '';
      this._renderModels();
    });

    // newLabel enter key
    o.querySelector('[data-lak="newLabel"]')?.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') (o.querySelector('[data-lak="addModel"]') as HTMLElement | null)?.click();
    });

    // Model list: field changes
    o.querySelector('[data-lak="modelList"]')?.addEventListener('change', (e) => {
      const input = (e.target as HTMLElement)?.closest('.lak-model-input') as HTMLInputElement | null;
      if (!input) return;
      const name = input.dataset.lakLabel as string;
      const field = input.dataset.lakField as string;
      const cfg = this.getModel(name);
      if (cfg) {
        cfg[field] = input.value.trim();
        this.setModel(name, cfg);
        if (field === 'apiKey') this._renderModels();
      }
    });

    // Model list: actions
    o.querySelector('[data-lak="modelList"]')?.addEventListener('click', async (e) => {
      const btn = (e.target as HTMLElement)?.closest('[data-lak-action]') as HTMLElement | null;
      if (!btn) return;
      const name = btn.dataset.lakLabel as string;
      const action = btn.dataset.lakAction;

      if (action === 'toggle') {
        const cfg = this.getModel(name);
        if (cfg) {
          cfg.enabled = !cfg.enabled;
          this._models.set(name, cfg);
          this._scheduleSave();
          this._renderModels();
        }
      } else if (action === 'delete') {
        this.removeModel(name);
        this._renderModels();
      } else if (action === 'syncPresetKey') {
        const cfg = this.getModel(name);
        if (!cfg) return;
        const provKey = this._getPresetProviderByModelName(name) || this.detectProvider(cfg.modelId);
        const presetKey = this._getProviderPresetKey(provKey);
        if (!presetKey) return;
        cfg.apiKey = presetKey;
        this.setModel(name, cfg);
        this._renderModels();
      }
    });

    // Import / Export / Clear
    o.querySelector('[data-lak="export"]')?.addEventListener('click', () => {
      const json = JSON.stringify(this.toJSON(), null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'api-key-settings.json';
      a.click();
      URL.revokeObjectURL(url);
    });

    o.querySelector('[data-lak="import"]')?.addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json,application/json';
      input.onchange = () => {
        const file = input.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          try {
            this.fromJSON(JSON.parse(reader.result as string));
            this._populateFields();
            this._renderActivePanel();
          } catch (e) {
            alert(this._t('importError') + (e as Error)?.message);
          }
        };
        reader.readAsText(file);
      };
      input.click();
    });

    o.querySelector('[data-lak="clearAll"]')?.addEventListener('click', async () => {
      if (!confirm(this._t('confirmClear'))) return;
      await this.clear();
      this._populateFields();
      this._renderActivePanel();
    });

    o.querySelector('[data-lak="resetExceptKeys"]')?.addEventListener('click', () => {
      if (!confirm(this._t('confirmReset'))) return;
      this.resetExceptApiKeysAndAbstractMap();
      this._populateFields();
      this._renderActivePanel();
    });

    // Storage mode / workspace
    const storageModeSelect = o.querySelector('[data-lak="storageMode"]');
    const workspaceInput = o.querySelector('[data-lak="workspace"]') as HTMLInputElement | null;
    storageModeSelect?.addEventListener('change', async (e) => {
      const target = e.target as HTMLInputElement;
      this.storageMode = target.value;
      const isPPS = target.value === 'personalPageStore';
      if (workspaceInput) {
        workspaceInput.style.opacity = isPPS ? '1' : '0.4';
        workspaceInput.style.pointerEvents = isPPS ? 'auto' : 'none';
      }
      // Reload from new backend
      this._loaded = false;
      await this.load();
      this._populateFields();
      this._renderActivePanel();
    });
    workspaceInput?.addEventListener('change', async (e) => {
      this.workspace = (e.target as HTMLInputElement).value.trim() || 'workspace_default';
      // Reload from new workspace
      this._loaded = false;
      await this.load();
      this._populateFields();
      this._renderActivePanel();
    });
  }

  // ── Style injection ───────────────────────────────────────────────

  _injectStyles(): void {
    if (this._styleInjected) return;
    this._styleInjected = true;
    const style = document.createElement('style');
    style.textContent = `
      .lak-overlay {
        position: fixed; inset: 0;
        /* Explicit width/height in addition to inset:0 so the overlay always
         * fills the screen even when a transformed/filter/perspective ancestor
         * turns it into the fixed-positioning containing block (e.g. a scaled
         * app shell). vw/vh are resolved against the viewport regardless. */
        width: 100vw; height: 100vh; height: 100dvh;
        z-index: 2147483647;
        background: rgba(0,0,0,0.55);
        display: flex; align-items: center; justify-content: center;
        opacity: 0; transition: opacity 0.2s;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      }
      .lak-overlay, .lak-overlay *, .lak-overlay *::before, .lak-overlay *::after {
        box-sizing: border-box;
      }
      .lak-overlay button, .lak-overlay input, .lak-overlay select {
        font: inherit;
      }
      .lak-overlay.lak-visible { opacity: 1; }

      .lak-overlay-fullscreen {
        background: #1e1e2e;
        align-items: stretch;
        justify-content: stretch;
      }

      .lak-box {
        background: #1e1e2e; color: #e0e0e0;
        border-radius: 12px; width: 560px; max-width: 95vw;
        max-height: 90vh; display: flex; flex-direction: column;
        box-shadow: 0 20px 60px rgba(0,0,0,0.5);
        overflow: hidden;
      }

      .lak-overlay-fullscreen .lak-box {
        /* Fill the overlay (which already spans the viewport) rather than
         * re-deriving from vw/dvh. This keeps the box correct even if the
         * overlay is clamped by an ancestor containing block. */
        width: 100%;
        max-width: none;
        height: 100%;
        max-height: none;
        border-radius: 0;
        box-shadow: none;
      }

      .lak-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 16px 20px 12px; border-bottom: 1px solid #2d2d3d;
      }
      .lak-title { margin: 0; font-size: 16px; font-weight: 600; }
      .lak-close {
        background: none; border: none; color: #888; font-size: 22px;
        cursor: pointer; padding: 0 4px; line-height: 1;
      }
      .lak-close:hover { color: #fff; }

      .lak-switch {
        --lak-switch-width: 40px;
        --lak-switch-height: 22px;
        --lak-switch-knob: 18px;
        position: relative; display: inline-flex !important; align-items: center;
        width: var(--lak-switch-width) !important; min-width: var(--lak-switch-width) !important;
        height: var(--lak-switch-height) !important; min-height: var(--lak-switch-height) !important;
        padding: 0 !important; margin: 0; border: none !important; background: transparent !important;
        border-radius: 999px; cursor: pointer;
        flex: 0 0 var(--lak-switch-width); user-select: none;
        line-height: 1; appearance: none; -webkit-appearance: none; transform: none;
      }
      .lak-global-switch { margin-right: 12px; }
      .lak-global-status { margin-left: auto; margin-right: 10px; font-size: 12px; font-weight: 600; padding: 3px 10px; border-radius: 12px; white-space: nowrap; }
      .lak-global-status-on { background: rgba(16,185,129,0.15); color: #6ee7b7; border: 1px solid rgba(16,185,129,0.4); }
      .lak-global-status-off { background: rgba(239,68,68,0.12); color: #fca5a5; border: 1px solid rgba(239,68,68,0.4); }
      .lak-card-switch { --lak-switch-width: 42px; --lak-switch-height: 22px; --lak-switch-knob: 18px; }
      .lak-switch input[type="checkbox"] {
        position: absolute; inset: 0; width: 100%; height: 100%; margin: 0;
        opacity: 0; cursor: pointer;
      }
      .lak-switch-slider {
        position: absolute; inset: 0; border-radius: 999px; background: #3f3f4d;
        transition: background 0.18s ease, box-shadow 0.18s ease;
        box-shadow: inset 0 0 0 1px rgba(255,255,255,0.08);
      }
      .lak-switch-slider::after {
        content: ''; position: absolute; top: 2px; left: 2px;
        width: var(--lak-switch-knob); height: var(--lak-switch-knob);
        border-radius: 50%; background: #c7c7d1;
        transition: transform 0.18s ease, background 0.18s ease;
        box-shadow: 0 1px 4px rgba(0,0,0,0.35);
      }
      .lak-switch input[type="checkbox"]:checked + .lak-switch-slider,
      .lak-switch[aria-pressed="true"] .lak-switch-slider {
        background: #22c55e;
        box-shadow: 0 0 0 2px rgba(34,197,94,0.18), inset 0 0 0 1px rgba(255,255,255,0.1);
      }
      .lak-switch input[type="checkbox"]:checked + .lak-switch-slider::after,
      .lak-switch[aria-pressed="true"] .lak-switch-slider::after {
        transform: translateX(calc(var(--lak-switch-width) - var(--lak-switch-knob) - 4px));
        background: #fff;
      }
      .lak-switch:focus-visible { outline: none; }
      .lak-switch:focus-visible .lak-switch-slider,
      .lak-switch input[type="checkbox"]:focus-visible + .lak-switch-slider {
        box-shadow: 0 0 0 3px rgba(34,197,94,0.3), inset 0 0 0 1px rgba(255,255,255,0.12);
      }

      .lak-tabs {
        display: flex; gap: 4px; padding: 0 20px;
        border-bottom: 1px solid #2d2d3d;
      }
      .lak-tab {
        background: none; border: none; border-bottom: 2px solid transparent;
        color: #888; font-size: 13px; padding: 10px 12px; cursor: pointer;
        transition: all 0.15s;
      }
      .lak-tab:hover { color: #ccc; }
      .lak-tab-active { color: #818cf8; border-bottom-color: #6366f1; }
      .lak-badge {
        display: inline-block; font-size: 11px; background: #333;
        border-radius: 4px; padding: 1px 5px; margin-left: 4px;
      }

      .lak-label { display: block; font-size: 11px; color: #888; text-transform: uppercase; letter-spacing: 0.5px; }
      .lak-hint { font-size: 11px; color: #555; margin: 4px 0 0; }
      .lak-input {
        display: block; width: 100%; background: #2a2a3a; border: 1px solid #3a3a4a;
        border-radius: 6px; padding: 8px 12px; color: #e0e0e0; font-size: 13px;
        margin-top: 6px; box-sizing: border-box;
        transition: border-color 0.15s;
      }
      .lak-input:focus { outline: none; border-color: #6366f1; box-shadow: 0 0 0 2px rgba(99,102,241,0.25); }

      .lak-input-warn {
        border-color: #f59e0b !important;
        background: rgba(245,158,11,0.08);
      }
      .lak-input-warn:focus {
        box-shadow: 0 0 0 2px rgba(245,158,11,0.3) !important;
      }
      .lak-key-warn {
        color: #f59e0b; font-size: 10px; font-weight: 500;
        text-transform: none; letter-spacing: 0; margin-left: 6px;
      }
      .lak-key-sync {
        position: absolute; right: 36px; top: 50%; transform: translateY(-50%);
        background: rgba(245,158,11,0.15); border: 1px solid #f59e0b;
        color: #f59e0b; font-size: 11px; border-radius: 4px;
        padding: 2px 8px; cursor: pointer;
      }
      .lak-key-sync:hover { background: rgba(245,158,11,0.25); }
      .lak-key-wrap:has(.lak-key-sync) .lak-input { padding-right: 96px; }

      .lak-key-wrap {
        position: relative; display: flex; align-items: center;
      }
      .lak-key-wrap .lak-input { flex: 1; padding-right: 36px; }
      .lak-eye {
        position: absolute; right: 8px; top: 50%; transform: translateY(-50%);
        background: none; border: none; color: #666; cursor: pointer;
        padding: 2px; display: flex; align-items: center; justify-content: center;
      }
      .lak-eye:hover { color: #aaa; }

      .lak-model-list {
        flex: 1; overflow-y: auto; padding: 12px 20px;
        min-height: 120px; max-height: 50vh;
      }
      .lak-overlay-fullscreen .lak-model-list { max-height: none; }
      .lak-model-list::-webkit-scrollbar { width: 5px; }
      .lak-model-list::-webkit-scrollbar-thumb { background: #444; border-radius: 3px; }
      .lak-empty { text-align: center; color: #555; padding: 32px 0; font-size: 13px; }

      .lak-model-card {
        background: #252535; border: 1px solid #333; border-radius: 8px;
        padding: 14px; margin-bottom: 10px; transition: border-color 0.15s;
      }
      .lak-model-card:hover { border-color: #6366f1; }

      .lak-model-head {
        display: flex; align-items: center; gap: 8px; margin-bottom: 10px;
      }
      .lak-dot {
        width: 8px; height: 8px; border-radius: 50%; background: #555; flex-shrink: 0;
      }
      .lak-dot-on { background: #4ade80; }
      .lak-model-label { font-size: 14px; font-weight: 500; }
      .lak-model-cat { font-size: 11px; color: #818cf8; background: rgba(99,102,241,0.15); border-radius: 4px; padding: 1px 6px; }
      .lak-link {
        background: none; border: none; color: #818cf8; font-size: 12px;
        cursor: pointer; padding: 2px 6px;
      }
      .lak-link:hover { text-decoration: underline; }
      .lak-link-danger { color: #f87171; }

      .lak-field-row { margin-bottom: 6px; }
      .lak-field-label { font-size: 11px; color: #666; text-transform: uppercase; }
      .lak-model-input { margin-top: 2px; }

      .lak-add-row {
        display: flex; gap: 8px; padding: 12px 20px;
        border-top: 1px solid #2d2d3d;
      }
      .lak-add-input { flex: 1; }

      .lak-footer {
        display: flex; align-items: center; gap: 8px;
        padding: 12px 20px; border-top: 1px solid #2d2d3d;
      }

      .lak-storage-row {
        padding: 12px 20px; border-top: 1px solid #2d2d3d;
      }

      .lak-btn {
        border: none; border-radius: 6px; padding: 7px 16px;
        font-size: 13px; cursor: pointer; transition: background 0.15s;
      }
      .lak-btn-primary { background: #6366f1; color: #fff; }
      .lak-btn-primary:hover { background: #5558e6; }
      .lak-btn-danger { background: #dc2626; color: #fff; }
      .lak-btn-danger:hover { background: #b91c1c; }
      .lak-btn-default { background: #333; color: #ccc; }
      .lak-btn-default:hover { background: #444; }

      /* Presets panel */
      .lak-presets-panel {
        flex: 1; overflow-y: auto; min-height: 120px; max-height: 50vh;
      }
      .lak-overlay-fullscreen .lak-presets-panel { max-height: none; }
      .lak-presets-panel::-webkit-scrollbar { width: 5px; }
      .lak-presets-panel::-webkit-scrollbar-thumb { background: #444; border-radius: 3px; }
      .lak-section-title {
        font-size: 13px; font-weight: 600; color: #c0c0d0;
        margin-bottom: 8px; padding-bottom: 4px;
        border-bottom: 1px solid #2d2d3d;
      }
      .lak-preset-card {
        background: #252535; border: 1px solid #333; border-radius: 8px;
        padding: 14px; margin-bottom: 10px; transition: border-color 0.15s;
      }
      .lak-preset-card:hover { border-color: #555; }
      .lak-preset-on { border-color: #4ade80; }
      .lak-preset-head {
        display: flex; align-items: center; gap: 8px; margin-bottom: 10px;
      }
      .lak-preset-name { font-size: 14px; font-weight: 500; }
      .lak-preset-models {
        display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px;
      }
      .lak-direct-row {
        display: inline-flex !important; flex-direction: row !important;
        align-items: center !important; justify-content: flex-start !important;
        flex-wrap: nowrap !important; gap: 6px; width: auto;
        color: #c0c0d0; font-size: 12px; margin: 8px 0 0;
        cursor: pointer; user-select: none;
        line-height: 1.2; text-align: left;
      }
      .lak-direct-row input[type="checkbox"] {
        display: inline-block !important;
        width: 14px !important; min-width: 14px !important;
        height: 14px !important; min-height: 14px !important;
        flex: 0 0 14px;
        margin: 0 !important; padding: 0; accent-color: #6366f1; transform: none !important;
        appearance: auto; -webkit-appearance: checkbox;
        position: static !important; inset: auto !important;
      }
      .lak-direct-row span {
        display: inline !important; width: auto !important; min-width: 0;
        white-space: nowrap; flex: 0 0 auto; line-height: 1.2;
      }
      .lak-preset-model-tag {
        font-size: 11px; background: #333; color: #999;
        padding: 2px 8px; border-radius: 4px;
      }
      .lak-tag-on { background: rgba(99,102,241,0.2); color: #a5b4fc; }
      .lak-tag-off { background: rgba(255,255,255,0.05); color: #555; text-decoration: line-through; }
      .lak-provider-badge {
        font-size: 11px; color: #818cf8; background: rgba(99,102,241,0.15);
        border-radius: 4px; padding: 2px 8px; white-space: nowrap;
      }

      .lak-abstract-select {
        cursor: pointer;
        appearance: none;
        -webkit-appearance: none;
        background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");
        background-repeat: no-repeat;
        background-position: right 10px center;
        padding-right: 30px;
      }

      /* ── Mini-design (mobile): uniformly scale the whole panel down so it
            stays usable on a phone while making text & controls smaller.
            We use CSS zoom on the box — it shrinks every px-based size
            (text, padding, inputs, switches, icons) by the same factor AND
            still reflows content, unlike transform: scale(). A transform:
            scale() fallback is provided for the rare browser without zoom
            support (older Firefox). ── */
      @media (max-width: 600px) {
        .lak-overlay { align-items: stretch; justify-content: stretch; background: #1e1e2e; }
        .lak-box {
          /* zoom shrinks rendered size, so vw/dvh are divided by the zoom
             factor (1/0.7 ≈ 142.86%) to still fill the whole viewport. */
          width: 142.86vw; max-width: none; height: 142.86vh; height: 142.86dvh;
          max-height: none; border-radius: 0; box-shadow: none;
          zoom: 0.7;
        }
        .lak-model-list, .lak-presets-panel { max-height: none; }
        /* Keep footer action buttons on a single row, never wrapping. */
        .lak-footer { flex-wrap: nowrap; overflow-x: auto; }
        .lak-footer .lak-btn { white-space: nowrap; flex-shrink: 0; }
      }

      /* Fallback for browsers without zoom: scale via transform.
         (zoom wins where supported; this block only applies when the
          browser does not support the zoom property.) */
      @supports not (zoom: 1) {
        @media (max-width: 600px) {
          .lak-box {
            transform: scale(0.7);
            transform-origin: top left;
            width: 142.86vw;   /* 100 / 0.7 so scaled width fills viewport */
            height: 142.86dvh;
          }
        }
        @media (max-width: 380px) {
          .lak-box {
            transform: scale(0.62);
            width: 161.3vw;    /* 100 / 0.62 */
            height: 161.3dvh;
          }
        }
      }

      /* ── Extra-narrow phones: shrink a touch more ── */
      @media (max-width: 380px) {
        .lak-box {
          /* 1 / 0.62 ≈ 161.3% so the zoomed box still fills the viewport. */
          width: 161.3vw; height: 161.3vh; height: 161.3dvh;
          zoom: 0.62;
        }
      }
    `;
    document.head.appendChild(style);
  }

  // ── Helpers ───────────────────────────────────────────────────────

  _esc(s: unknown): string { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  _attr(s: unknown): string { return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  _eyeIcon(open: boolean): string {
    if (open) {
      return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
    }
    return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;
  }
}
