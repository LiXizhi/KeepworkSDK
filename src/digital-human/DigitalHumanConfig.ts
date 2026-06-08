/**
 * DigitalHumanConfig.ts — DigitalHuman 配置解析工具
 *
 * 把 DigitalHuman 的原始配置对象拆解为各子系统所需的配置片段：
 * ChatSession 配置、Frame 状态、工具分类、FileOps、searchPaths、keepHistory 等。
 *
 * 这些函数处理用户提供的松散配置对象，故大量使用 `Record<string, unknown>` /
 * 可选字段；难以静态约束处用 unknown + 运行时判断，避免 any。
 */

/** DigitalHuman 原始配置（松散结构，仅声明常用字段，其余通过索引签名） */
export type DigitalHumanConfigInput = Record<string, unknown> & {
  _configSourceUrl?: string;
  system_prompt?: string;
  enable_system_prompt?: boolean;
  llm_model?: string;
  tools?: Record<string, unknown>;
  workspace?: string;
  mountFolder?: string;
  searchPaths?: SearchPathInput[];
};

/** searchPath 原始条目 */
export interface SearchPathInput {
  prefix?: string;
  baseUrl?: string;
  baseUrlLocal?: string;
  [key: string]: unknown;
}

/** 解析后的 searchPath 条目 */
export interface ResolvedSearchPathEntry {
  prefix: string;
  baseUrl: string;
}

/**
 * 在解析后的配置对象上记录原始配置源 URL，
 * 以便后续将相对资源（如 searchPaths）解析为绝对地址。
 * 内联 JSON（以 `{` 开头）默认不记录，除非 allowInlineJson=true。
 */
export function markConfigSourceUrl<T extends Record<string, unknown>>(
  config: T,
  source: string | Record<string, unknown>,
  options: { allowInlineJson?: boolean } = {},
): T {
  if (!config || !source || typeof source !== 'string') return config;

  const trimmedSource = source.trim();
  if (!trimmedSource) return config;

  const allowInlineJson = options.allowInlineJson === true;
  if (!allowInlineJson && trimmedSource.startsWith('{')) return config;

  (config as Record<string, unknown>)._configSourceUrl = trimmedSource;
  return config;
}

/**
 * 从 DigitalHuman 配置派生出 ChatSession 所需的配置片段。
 */
export function buildDigitalHumanSessionConfig(
  config: DigitalHumanConfigInput = {},
): Record<string, unknown> {
  const c = config as Record<string, any>;
  return {
    system_prompt: c.enable_system_prompt !== false ? c.system_prompt : undefined,
    llm_model: c.llm_model,
    tools: c.tools,
    workspace: c.workspace,
    mountFolder: c.mountFolder,
    bracketAction: c.bracketAction ?? c.autoBracketAction,
    textToSpeech: c.textToSpeech
      ?? c.nonVoiceChat?.textToSpeech
      ?? c.textChat?.textToSpeech
      ?? c.chat?.textToSpeech,
    autoReadReply: c.autoReadReply
      ?? c.nonVoiceChat?.autoReadReply
      ?? c.textChat?.autoReadReply
      ?? c.chat?.autoReadReply,
    summarization: c.summarization,
    summarizeAgent: c.summarizeAgent,
    historyLength: c.historyLength,
    keepHistory: c.keepHistory,
  };
}

/** DigitalHumanFrame 初始状态片段 */
export interface DigitalHumanFrameState {
  characterInfo: Record<string, unknown>;
  initialMessage: string;
  quickReplies: unknown[];
  objective: unknown;
  completionMessages: unknown;
  voiceChatConfig: Record<string, unknown>;
  subtitleConfig: unknown;
  avatarOnlyMode: boolean;
}

/**
 * 从配置中提取 DigitalHumanFrame 的初始状态。
 */
export function extractDigitalHumanFrameState(
  config: DigitalHumanConfigInput = {},
): DigitalHumanFrameState {
  const c = config as Record<string, any>;
  return {
    characterInfo: c.character || {},
    initialMessage: c.initial?.message || '',
    quickReplies: c.quick_replies || [],
    objective: c.objective || null,
    completionMessages: c.completion_messages || null,
    voiceChatConfig: c.voiceChat || {},
    subtitleConfig: c.subtitle,
    avatarOnlyMode: c.avatar_only === true,
  };
}

/**
 * 根据配置构建启用的工具分类列表。
 * 若提供 options.resolveEnabledCategories（来自 CopilotTools），优先使用其结果。
 */
export function resolveEnabledToolCategories(
  config: DigitalHumanConfigInput = {},
  options: { resolveEnabledCategories?: (tools: unknown) => string[] } = {},
): string[] {
  const tools = config?.tools as Record<string, any> | undefined;
  const resolveEnabledCategories = options.resolveEnabledCategories;

  if (resolveEnabledCategories) {
    const result = resolveEnabledCategories(tools);
    if (Array.isArray(result) && result.length > 0) return result;
  }

  const enableTools: string[] = [];
  if (!tools) return enableTools;

  if (tools.mqtt && tools.mqtt.enabled !== false) enableTools.push('mqtt');
  const ppConfig = tools.personalPage || tools.personal_page;
  if (ppConfig && ppConfig.enabled !== false) enableTools.push('personalPage');
  if (tools.fileOps && tools.fileOps.enabled !== false) enableTools.push('fileOps');
  if (tools.web && tools.web.enabled !== false) enableTools.push('web');
  if (tools.execute && tools.execute.enabled !== false) enableTools.push('execute');
  if (tools.agent && tools.agent.enabled !== false) enableTools.push('agent');
  if (tools.digitalhuman && tools.digitalhuman.enabled !== false) enableTools.push('digitalhuman');

  return enableTools;
}

/**
 * 重建 restartAgent 的工具配置：保留非分类键，并把指定分类强制 enabled=true。
 */
export function buildRestartToolConfig(
  enabledCategories: string[] = [],
  sourceTools: Record<string, unknown> = {},
  options: { registry?: Record<string, unknown> } = {},
): Record<string, unknown> {
  const tools = sourceTools && typeof sourceTools === 'object' ? sourceTools : {};
  const aliases: Record<string, string> = {
    personal_page: 'personalPage',
    MqttTool: 'mqtt',
    PersonalPageTool: 'personalPage',
    ExecuteTool: 'execute',
    webFetch: 'web',
  };
  const registry = options.registry || {};
  const isKnownCategoryKey = (key: string): boolean => {
    if (typeof key !== 'string' || !key) return false;
    const dot = key.indexOf('.');
    const cat = dot === -1 ? key : key.slice(0, dot);
    return !!(registry[cat] || registry[aliases[cat]]);
  };

  const nextTools: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(tools)) {
    if (!isKnownCategoryKey(key)) {
      nextTools[key] = value;
    }
  }

  for (const rawCategory of enabledCategories) {
    const category = aliases[rawCategory] || rawCategory;
    const existingKey = Object.prototype.hasOwnProperty.call(tools, category)
      ? category
      : Object.keys(aliases).find(
          (key) => aliases[key] === category && Object.prototype.hasOwnProperty.call(tools, key),
        );
    const existingConfig = existingKey ? tools[existingKey] : null;
    nextTools[category] = {
      ...(existingConfig && typeof existingConfig === 'object' ? existingConfig : {}),
      enabled: true,
    };
  }

  return nextTools;
}

/** resolveFileOpsConfig 返回结构 */
export interface ResolvedFileOpsConfig {
  fileOps: Record<string, unknown>;
  workspace: string | undefined;
  mountFolder: string | undefined;
  pathPrefix: string | undefined;
  searchPaths: SearchPathInput[];
}

/**
 * 从 DigitalHuman 配置中解析 FileOps 的 workspace / pathPrefix / searchPaths。
 */
export function resolveFileOpsConfig(config: DigitalHumanConfigInput = {}): ResolvedFileOpsConfig {
  const c = config as Record<string, any>;
  const fileOps = c?.tools?.fileOps || {};
  return {
    fileOps,
    workspace: fileOps.workspace || c.workspace,
    mountFolder: fileOps.mountFolder || c.mountFolder,
    pathPrefix: fileOps.pathPrefix,
    searchPaths: fileOps.searchPaths || c.searchPaths || [],
  };
}

/** 判断是否本地主机名 */
function isLocalHostname(hostname: string): boolean {
  if (typeof hostname !== 'string') return false;
  const normalizedHost = hostname.trim().toLowerCase();
  return normalizedHost === 'localhost'
    || normalizedHost.endsWith('.localhost')
    || normalizedHost === '127.0.0.1'
    || normalizedHost === '::1';
}

/** 当前是否运行在本地主机（决定是否优先 baseUrlLocal） */
function shouldPreferLocalBaseUrl(): boolean {
  if (typeof window === 'undefined' || !window?.location) return false;
  return isLocalHostname(window.location.hostname);
}

/**
 * 解析并绝对化 PersonalPageStore 的 search-path 条目。
 * 相对 baseUrl 会基于记录的配置源 URL 展开；本地主机下 baseUrlLocal 优先。
 */
export function resolveSearchPathEntries(
  config: DigitalHumanConfigInput = {},
  fallbackConfig: DigitalHumanConfigInput | null = null,
): ResolvedSearchPathEntry[] {
  const primary = resolveFileOpsConfig(config);
  const fallback = fallbackConfig ? resolveFileOpsConfig(fallbackConfig) : null;
  const searchPaths = primary.searchPaths?.length ? primary.searchPaths : (fallback?.searchPaths || []);
  const configSourceUrl = config?._configSourceUrl || fallbackConfig?._configSourceUrl || '';
  const configBaseUrl = configSourceUrl
    ? configSourceUrl.substring(0, configSourceUrl.lastIndexOf('/') + 1)
    : '';
  const preferLocalBaseUrl = shouldPreferLocalBaseUrl();

  if (!Array.isArray(searchPaths) || searchPaths.length === 0) return [];

  return searchPaths.reduce<ResolvedSearchPathEntry[]>((entries, sp) => {
    if (!sp || !sp.prefix) return entries;

    const rawBaseUrl = preferLocalBaseUrl && sp.baseUrlLocal ? sp.baseUrlLocal : sp.baseUrl;
    if (!rawBaseUrl) return entries;

    let resolvedUrl = rawBaseUrl;
    if (
      configBaseUrl
      && !rawBaseUrl.startsWith('http://')
      && !rawBaseUrl.startsWith('https://')
      && !rawBaseUrl.startsWith('/')
    ) {
      try {
        resolvedUrl = new URL(rawBaseUrl, configBaseUrl).href;
      } catch {
        resolvedUrl = rawBaseUrl;
      }
    }

    entries.push({ prefix: sp.prefix, baseUrl: resolvedUrl });
    return entries;
  }, []);
}

/** keepHistory 配置解析结果 */
export interface ResolvedKeepHistoryConfig {
  enabled: boolean;
  historyLength: number;
  fileName: string;
  keepFullHistory: boolean;
  dailyDeltaThreshold: number;
  autoSummarizeContentThreshold: number;
}

/**
 * 从 createSession / characterConfig / constructor 解析 keepHistory 配置。
 * @param source - true 表示使用默认值；对象则覆盖默认值；其余返回 null。
 */
export function resolveKeepHistoryConfig(
  source: boolean | Record<string, unknown> | null | undefined,
): ResolvedKeepHistoryConfig | null {
  if (!source) return null;
  const defaults: ResolvedKeepHistoryConfig = {
    enabled: true,
    historyLength: 50,
    fileName: 'history',
    keepFullHistory: false,
    dailyDeltaThreshold: 10 * 1024,
    autoSummarizeContentThreshold: 10 * 1024,
  };

  if (source === true) return defaults;
  if (typeof source !== 'object') return null;

  const s = source as Record<string, any>;
  return {
    enabled: s.enabled !== false,
    historyLength: Number(s.historyLength) || defaults.historyLength,
    fileName: s.fileName || defaults.fileName,
    keepFullHistory: s.keepFullHistory === true,
    dailyDeltaThreshold: Number(s.dailyDeltaThreshold) || defaults.dailyDeltaThreshold,
    autoSummarizeContentThreshold: Number(s.autoSummarizeContentThreshold) || defaults.autoSummarizeContentThreshold,
  };
}
