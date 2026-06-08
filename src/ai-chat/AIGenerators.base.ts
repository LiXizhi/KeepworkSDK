/**
 * AIGenerators.base.ts — AI 生成器公共工具 + 聊天路由层
 *
 * 包含：
 * - 构造函数与基础工具（getModels / getAllModels / _getToken / _authHeaders 等）
 * - 请求头规范化（_normalizeHeaders）
 * - 模型/provider 解析（_resolveLocalModelSettings / _detectProvider / _shouldPreferDirect）
 * - 直连路由决策（shouldRouteDirect）
 * - 聊天核心路由（chat / chatViaProxy / chatCompletion）
 * - 直连底层方法（callLLM / _callOpenAILLM / _callOpenRouterLLM / _callGoogleLLM）
 * - SSE 读取（_readSSETextResponse / _readSSEImageResponse / _readChatCompletionSSE / _readKeepworkProxySSE）
 * - 消息格式化工具（_normalizeMessages / _normalizeOpenAIChatMessages / _messagesToGeminiContents 等）
 * - Reasoning 处理（_normalizeReasoningOption / _buildReasoningBodyField 等）
 */

import SDKLogger from '../utils/SDKLogger';

const console = SDKLogger.createModuleConsole('AIGenerators');

// ──────────────────── 常量 ────────────────────

export const DEFAULT_CHAT_MODEL = 'keepwork-flash';
export const DEFAULT_IMAGE_MODEL = 'keepwork-image';
export const DEFAULT_VIDEO_MODEL = 'keepwork-video';

// ──────────────────── 类型 ────────────────────

/** 聊天消息（OpenAI 格式） */
export interface GenMessage {
  role: string;
  content: unknown;
  tool_calls?: GenToolCall[];
  tool_call_id?: string;
  [key: string]: unknown;
}

/** 工具调用 */
export interface GenToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
  index?: number;
}

/** SDK 最小接口 */
export interface AIGeneratorsSDKRef {
  baseURL?: string;
  token?: string | null;
  userApiKey?: string | null;
  localAPIKeySettings?: {
    resolveModelSettings: (model: string, opts?: unknown) => { model?: string; apiKey?: string; provider?: string; preferDirect?: boolean };
    detectProvider?: (model: string) => string | null;
    getProviderApiKey?: (provider: string) => string | null;
  };
  get?: (url: string) => Promise<unknown>;
  cloudDrive?: { uploadTempFile: (file: File, opts?: { filename?: string; expire?: number }) => Promise<{ url?: string }> };
  [key: string]: unknown;
}

/** 本地模型设置 */
export interface LocalModelSettings {
  model?: string;
  apiKey?: string;
  provider?: string;
  preferDirect?: boolean;
}

/** 聊天选项 */
export interface GenChatOptions {
  messages?: GenMessage[];
  prompt?: string;
  model?: string;
  tools?: unknown[];
  stream?: boolean;
  temperature?: number;
  responseFormat?: string | { type: string };
  reasoning?: boolean | object;
  knowledgeBaseCodes?: string[];
  apiCacheKey?: string | null;
  abortController?: AbortController;
  extraHeaders?: Record<string, string>;
  localModelSettings?: LocalModelSettings;
  directProvider?: string;
  apiKey?: string;
  preferDirect?: boolean;
  directOnly?: boolean;
  returnRaw?: boolean;
  extraBody?: Record<string, unknown>;
  modalities?: string[];
  outputModalities?: string[];
  output_modalities?: string[];
  images?: Array<{ url?: string; image_url?: { url: string }; role?: string }>;
  onMessage?: (fullText: string, delta?: unknown, raw?: unknown, meta?: unknown) => void;
  onReasoning?: (fullReasoning: string, delta?: string, raw?: unknown) => void;
  onToolCall?: (toolCall: GenToolCall) => void;
  onComplete?: (result: unknown, fullResponse?: unknown) => void;
  onError?: (error: Error) => void;
  onImage?: (url: string, raw?: unknown, meta?: unknown) => void;
  [key: string]: unknown;
}

/** shouldRouteDirect 返回值 */
export interface RouteDirectDecision {
  route: boolean;
  provider?: string;
  apiKey?: string;
}

// ──────────────────── AIGeneratorsBase ────────────────────

/**
 * AIGeneratorsBase — AI 生成器公共工具 + 聊天路由基类。
 * 由 AIGenerators.media.ts 继承以添加 genImage / genVideo 等媒体生成方法。
 */
export class AIGeneratorsBase {
  sdk: AIGeneratorsSDKRef;
  /** 全量模型列表缓存（getAllModels 使用） */
  _allModelsCache?: unknown[];

  constructor(sdk: AIGeneratorsSDKRef) {
    this.sdk = sdk;
  }

  // ──────────────────── 基础工具 ────────────────────

  /** Keepwork gpt API 基础 URL */
  get _apiBase(): string {
    return `${this.sdk.baseURL ?? ''}/gpt`;
  }

  /**
   * 获取预设的常用模型列表。
   * @param type - 'chat' | 'image' | 'video'
   */
  getModels(type: 'chat' | 'image' | 'video' = 'chat'): string[] {
    const models: Record<string, string[]> = {
      chat: ['keepwork-pro', 'keepwork-flash', 'keepwork-lite'],
      image: ['keepwork-image', 'seedream-5.0-lite'],
      video: ['keepwork-video', 'seedance-2.0-fast', 'seedance-2.0'],
    };
    return models[type] ? [...models[type]!] : [];
  }

  /**
   * 从 Keepwork 获取完整模型列表（内存缓存）。
   * @param opts.forceRefresh - 是否绕过缓存（默认 false）
   */
  async getAllModels(opts: { forceRefresh?: boolean } = {}): Promise<unknown[]> {
    const { forceRefresh = false } = opts;
    if (!forceRefresh && this._allModelsCache) return this._allModelsCache;
    if (!this._getToken()) throw new Error('请先登录');
    const data = await this.sdk.get?.('/paracraftConfigs/gptModelForFrontend') as Record<string, unknown> | undefined;
    this._allModelsCache = (data?.['data'] as Record<string, unknown>)?.['config'] as unknown[] ?? [];
    return this._allModelsCache;
  }

  /** 获取认证 token（sdk.token → localStorage 回退）。 */
  _getToken(): string | null {
    if (this.sdk.token) return this.sdk.token;
    try { return localStorage.getItem('token'); } catch { return null; }
  }

  /**
   * 规范化请求头对象（过滤 null/undefined，拒绝含非 Latin-1 字符的 value）。
   * 用于防止 fetch API 因非法头值崩溃。
   */
  _normalizeHeaders(headers: Record<string, unknown> = {}, context = 'Request'): Record<string, string> {
    const normalized: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers)) {
      if (value === undefined || value === null) continue;
      const headerValue = String(value);
      if (/[^\u0000-\u00ff]/.test(headerValue)) {
        const field = /^authorization$/i.test(name) ? 'API key/token' : `header "${name}"`;
        throw new Error(
          `${context} ${field} 包含浏览器请求头不支持的字符，请检查是否粘贴了中文说明、全角符号或多余文本。`
        );
      }
      normalized[name] = headerValue;
    }
    return normalized;
  }

  /**
   * 构建 Keepwork API 鉴权请求头（含 Authorization / user-api-key）。
   * @param extra - 额外请求头
   */
  _authHeaders(extra: Record<string, string> = {}): Record<string, string> {
    const token = this._getToken();
    const h: Record<string, string> = { Accept: '*/*', 'Content-Type': 'application/json' };
    if (token) h['Authorization'] = `Bearer ${token}`;
    const userApiKey = this.sdk.userApiKey;
    if (userApiKey) h['user-api-key'] = userApiKey;
    return this._normalizeHeaders({ ...h, ...extra }, 'Keepwork API 请求');
  }

  // ──────────────────── 模型 / Provider 解析 ────────────────────

  /**
   * 解析模型的本地配置（model / apiKey / provider / preferDirect）。
   * 若 SDK 无 localAPIKeySettings 则直接返回 `{ model }`。
   */
  _resolveLocalModelSettings(model?: string, provider?: string): LocalModelSettings {
    return this.sdk.localAPIKeySettings?.resolveModelSettings(model ?? '', { provider }) ?? { model: model ?? '' };
  }

  /** 判断是否应优先使用直连路由。 */
  _shouldPreferDirect(localModelSettings: LocalModelSettings, opts: GenChatOptions = {}): boolean {
    if (opts['directOnly']) return true;
    if (opts['preferDirect'] !== undefined) return opts['preferDirect'] === true;
    return localModelSettings.preferDirect === true;
  }

  /** 解析直连 provider 名称（caller > localModelSettings > 自动检测）。 */
  _directProvider(localModelSettings: LocalModelSettings, opts: GenChatOptions = {}): string | null {
    return (opts['directProvider'] as string | undefined)
      ?? localModelSettings.provider
      ?? this._detectProvider(localModelSettings.model ?? opts['model'] as string | undefined ?? '')
      ?? null;
  }

  /**
   * 决定 chat 请求是否应绕过 Keepwork proxy 直连 provider。
   *
   * 规则：
   * - strict（无 key 则抛出）：directOnly=true 或 preferDirect=true 或 明确指定 apiKey+directProvider
   * - lenient（无 key 则回退代理）：localModelSettings.preferDirect=true
   *
   * @throws 严格模式下无 API key 时抛出
   */
  shouldRouteDirect(options: GenChatOptions = {}, localModelSettings: LocalModelSettings | null = null): RouteDirectDecision {
    const directOnly = options['directOnly'] === true;
    const explicitPreferDirect = options['preferDirect'] !== undefined
      ? options['preferDirect'] === true
      : localModelSettings?.preferDirect === true;
    const explicitDirectKey = !!(options['apiKey'] && options['directProvider']);
    if (!(directOnly || explicitPreferDirect || explicitDirectKey)) return { route: false };

    const strict = directOnly || options['preferDirect'] === true || explicitDirectKey;
    const model = localModelSettings?.model ?? (options['model'] as string | undefined) ?? '';
    const provider = (options['directProvider'] as string | undefined)
      ?? localModelSettings?.provider
      ?? this.sdk.localAPIKeySettings?.detectProvider?.(model)
      ?? this._detectProvider(model)
      ?? null;

    let apiKey = (options['apiKey'] as string | undefined) ?? localModelSettings?.apiKey ?? '';
    if (!apiKey && provider && this.sdk.localAPIKeySettings?.getProviderApiKey) {
      apiKey = this.sdk.localAPIKeySettings.getProviderApiKey(provider) ?? '';
    }
    if (!apiKey) {
      if (strict) throw new Error(`Direct chat requires API key for provider: ${provider ?? 'unknown'}`);
      return { route: false };
    }
    return { route: true, provider: provider ?? undefined, apiKey };
  }

  /**
   * 根据 model 名称自动检测 provider（OpenRouter / Doubao / Qwen / Claude / Gemini / OpenAI）。
   * 返回 null 表示无法识别（使用 Keepwork proxy）。
   */
  _detectProvider(model: string): string | null {
    const localSettings = this.sdk.localAPIKeySettings;
    if (typeof localSettings?.detectProvider === 'function') return localSettings.detectProvider(model);
    const value = String(model ?? '').trim().toLowerCase();
    if (!value) return null;
    if (/^openrouter|^[a-z0-9_.-]+\/[a-z0-9_.:-]+/i.test(value)) return 'openrouter';
    if (/^doubao|^seedream|^seedance/.test(value)) return 'doubao';
    if (/^qwen/.test(value)) return 'qwen';
    if (/^claude/.test(value)) return 'claude';
    if (/^gemini/.test(value)) return 'gemini';
    if (/^gpt-|^o[1-9]|^chatgpt|^dall-e/.test(value)) return 'openai';
    return null;
  }

  // ──────────────────── 消息格式化 ────────────────────

  /** 将 messages + prompt 规范化为消息数组（至少需要其中一个）。 */
  _normalizeMessages(messages?: GenMessage[], prompt?: string): GenMessage[] {
    if (Array.isArray(messages) && messages.length > 0) return messages;
    if (prompt) return [{ role: 'user', content: prompt }];
    throw new Error('messages or prompt is required');
  }

  /** 将消息数组规范化为 OpenAI Chat Completions 格式（含 tool_calls / tool 消息处理）。 */
  _normalizeOpenAIChatMessages(messages: GenMessage[], prompt?: string): GenMessage[] {
    const normalized = this._normalizeMessages(messages, prompt);
    return normalized.map((message) => {
      const role = message.role ?? 'user';
      const next: GenMessage = { role, content: '' };

      if (role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
        next.content = message.content ? message.content : null;
        next.tool_calls = message.tool_calls.map((toolCall, index) => ({
          id: toolCall.id ?? `tool_call_${index}`,
          type: toolCall.type ?? 'function',
          function: {
            name: toolCall.function?.name ?? '',
            arguments: typeof toolCall.function?.arguments === 'string'
              ? toolCall.function.arguments
              : JSON.stringify(toolCall.function?.arguments ?? {}),
          },
        }));
        return next;
      }

      if (role === 'tool') {
        next.tool_call_id = message.tool_call_id ?? (message['toolCallId'] as string | undefined) ?? '';
        next.content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
        return next;
      }

      next.content = message.content ?? '';
      return next;
    });
  }

  /** 将 OpenAI 格式消息转换为 Gemini contents 格式。 */
  _messagesToGeminiContents(messages: GenMessage[]): Array<{ role: string; parts: unknown[] }> {
    return messages.map((message) => ({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: this._contentToGeminiParts(message.content),
    }));
  }

  /** 将消息 content 转换为 Gemini parts 格式（支持文本/图片/视频）。 */
  _contentToGeminiParts(content: unknown): unknown[] {
    if (typeof content === 'string') return [{ text: content }];
    if (!Array.isArray(content)) return [{ text: String(content ?? '') }];
    return (content as Array<Record<string, unknown>>).map((part) => {
      if (part['type'] === 'text') return { text: part['text'] ?? '' };
      const imageUrl = (part['image_url'] as Record<string, string> | undefined)?.['url'] ?? part['url'] as string | undefined;
      if (part['type'] === 'image_url' && imageUrl) return this._urlToGeminiFilePart(imageUrl, 'image/png');
      const videoUrl = (part['video_url'] as Record<string, string> | undefined)?.['url'] ?? part['url'] as string | undefined;
      if (part['type'] === 'video_url' && videoUrl) return this._urlToGeminiFilePart(videoUrl, 'video/mp4', part['video_metadata']);
      return { text: JSON.stringify(part) };
    });
  }

  /** 将 URL 转换为 Gemini file_data 或 inline_data part。 */
  _urlToGeminiFilePart(url: string, fallbackMimeType: string, videoMetadata?: unknown): unknown {
    if (url.startsWith('data:')) {
      const match = url.match(/^data:([^;]+);base64,(.+)$/);
      const mimeType = match?.[1] ?? fallbackMimeType;
      const base64 = match?.[2] ?? '';
      return { inline_data: { mime_type: mimeType, data: base64 } };
    }
    const filePart: Record<string, unknown> = { file_data: { mime_type: fallbackMimeType, file_uri: url } };
    if (videoMetadata) filePart['video_metadata'] = videoMetadata;
    return filePart;
  }

  // ──────────────────── 文本提取工具 ────────────────────

  _extractOpenAIText(data: Record<string, unknown>): string {
    const message = (data?.['choices'] as Array<Record<string, unknown>> | undefined)?.[0]?.['message'] as Record<string, unknown> | undefined;
    if (typeof message?.['content'] === 'string') return message['content'];
    if (Array.isArray(message?.['content'])) return (message['content'] as Array<Record<string, string>>).map((p) => p['text'] ?? p['content'] ?? '').join('');
    return String((data?.['choices'] as Array<Record<string, unknown>> | undefined)?.[0]?.['text'] ?? '');
  }

  _extractGeminiText(data: Record<string, unknown>): string {
    const parts = ((data?.['candidates'] as Array<Record<string, unknown>> | undefined)?.[0]?.['content'] as Record<string, unknown> | undefined)?.['parts'] as Array<Record<string, string>> | undefined ?? [];
    return parts.map((p) => p['text'] ?? '').join('');
  }

  _extractReasoningText(data: Record<string, unknown>): string {
    const delta = ((data?.['choices'] as Array<Record<string, unknown>> | undefined)?.[0]?.['delta'] ?? (data?.['choices'] as Array<Record<string, unknown>> | undefined)?.[0]?.['message'] ?? {}) as Record<string, unknown>;
    if (typeof delta['reasoning_content'] === 'string' && delta['reasoning_content']) return delta['reasoning_content'];
    if (typeof delta['reasoning'] === 'string' && delta['reasoning']) return delta['reasoning'];
    if (Array.isArray(delta['reasoning_details'])) {
      let text = '';
      for (const item of delta['reasoning_details'] as Array<Record<string, string>>) {
        if (typeof item?.['text'] === 'string') text += item['text'];
      }
      if (text) return text;
    }
    return '';
  }

  // ──────────────────── Reasoning 处理 ────────────────────

  _shouldDisableReasoning(model: string): boolean {
    return typeof model === 'string' && model.toLowerCase().includes('flash');
  }

  _requiresReasoning(model: string): boolean {
    return typeof model === 'string' && model.toLowerCase().includes('gemini-3.5-flash');
  }

  _normalizeReasoningOption(model: string, reasoning: unknown): unknown {
    if (this._requiresReasoning(model)) {
      if (reasoning === false) return undefined;
      if (reasoning && typeof reasoning === 'object') {
        const value = { ...(reasoning as Record<string, unknown>) };
        if (value['enabled'] === false) delete value['enabled'];
        if (value['exclude'] === true) delete value['exclude'];
        return Object.keys(value).length > 0 ? value : undefined;
      }
      return reasoning;
    }
    if (this._shouldDisableReasoning(model)) return false;
    return reasoning;
  }

  _buildReasoningBodyField(provider: string, reasoning: unknown): { key: string; value: unknown } | null {
    if (reasoning === undefined) return null;
    if (provider === 'openrouter') {
      if (reasoning === true) return { key: 'reasoning', value: { enabled: true } };
      if (reasoning === false) return { key: 'reasoning', value: { enabled: false, exclude: true } };
      if (reasoning && typeof reasoning === 'object') {
        const value = { ...(reasoning as Record<string, unknown>) };
        if (value['enabled'] === undefined && value['effort'] === undefined && value['max_tokens'] === undefined && value['exclude'] === undefined) value['enabled'] = true;
        return { key: 'reasoning', value };
      }
      return null;
    }
    if (provider === 'openai') {
      if (reasoning && typeof reasoning === 'object' && typeof (reasoning as Record<string, unknown>)['effort'] === 'string') {
        return { key: 'reasoning_effort', value: (reasoning as Record<string, unknown>)['effort'] };
      }
      if (typeof reasoning === 'string') return { key: 'reasoning_effort', value: reasoning };
      return null;
    }
    return null;
  }

  // ──────────────────── Keepwork Proxy 请求头 ────────────────────

  _keepworkChatHeaders(extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = {
      'accept-language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
      'cache-control': 'no-cache', 'content-type': 'application/json', 'pragma': 'no-cache', 'priority': 'u=1, i',
      'sec-ch-ua': '"Not)A;Brand";v="8", "Chromium";v="138", "Google Chrome";v="138"',
      'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-site',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
    };
    const token = this._getToken();
    if (token) headers['authorization'] = `Bearer ${token}`;
    const userApiKey = this.sdk.userApiKey;
    if (userApiKey) headers['user-api-key'] = userApiKey;
    return { ...headers, ...extra };
  }

  // ──────────────────── 聊天路由 ────────────────────

  /**
   * 统一聊天入口：自动判断直连或 proxy 路由。
   * 两种传输路径都发出相同的回调格式（onMessage / onToolCall / onComplete / onError）。
   */
  async chat(options: GenChatOptions = {}): Promise<unknown> {
    const requestedModel = (options['model'] as string | undefined) ?? DEFAULT_CHAT_MODEL;
    const localModelSettings = this._resolveLocalModelSettings(requestedModel, options['directProvider'] as string | undefined);
    const model = localModelSettings.model && localModelSettings.model !== requestedModel ? localModelSettings.model : requestedModel;
    const directDecision = this.shouldRouteDirect({ ...options, model }, localModelSettings);
    if (directDecision.route) {
      return this.chatCompletion({ ...options, model, directProvider: directDecision.provider, apiKey: directDecision.apiKey });
    }
    return this.chatViaProxy({ ...options, model, localModelSettings });
  }

  /**
   * 通过 Keepwork `/gpt/chat` proxy 发送聊天请求。
   * 支持流式和非流式两种模式，统一发出 AIChat 兼容的回调。
   */
  async chatViaProxy(options: GenChatOptions = {}): Promise<unknown> {
    const { messages = [], stream = true, reasoning, knowledgeBaseCodes = [], apiCacheKey, abortController, extraHeaders, onMessage, onReasoning, onToolCall, onComplete, onError } = options;
    const requestedModel = (options['model'] as string | undefined) ?? 'keepwork-pro';
    const tools = (options['tools'] as unknown[] | undefined) ?? [];

    if (!messages || messages.length === 0) throw new Error('Messages array is required and cannot be empty');

    const localModelSettings = options.localModelSettings ?? this._resolveLocalModelSettings(requestedModel);
    const model = localModelSettings.model ? localModelSettings.model : requestedModel;

    try {
      const headers = this._keepworkChatHeaders();
      if (apiCacheKey) headers['api-cache-key'] = apiCacheKey;
      if (localModelSettings.apiKey) headers['x-api-key'] = localModelSettings.apiKey;
      if (extraHeaders) Object.assign(headers, extraHeaders);

      const requestBody: Record<string, unknown> = { messages, model, stream };
      if (localModelSettings.apiKey) requestBody['apiKey'] = localModelSettings.apiKey;
      const reasoningOpt = this._normalizeReasoningOption(model, reasoning);
      if (reasoningOpt !== undefined) requestBody['reasoning'] = reasoningOpt;
      if (knowledgeBaseCodes?.length > 0) requestBody['knowledgeBaseCodes'] = knowledgeBaseCodes;
      if (tools.length > 0) requestBody['localTools'] = tools;

      const sdkBaseURL = this.sdk.baseURL;
      if (!sdkBaseURL) throw new Error('sdk.baseURL is required for chatViaProxy');

      const response = await fetch(`${sdkBaseURL}/gpt/chat`, {
        method: 'POST',
        headers: this._normalizeHeaders(headers, 'Keepwork Chat 请求'),
        body: JSON.stringify(requestBody),
        signal: abortController?.signal,
      });

      if (!response.ok) {
        const msg = response.status === 429 ? '请求频率过高，请稍后重试' : `请求失败: ${response.status} ${response.statusText}`;
        throw new Error(msg);
      }

      if (stream) return await this._readKeepworkProxySSE(response, { onMessage, onReasoning, onToolCall, onComplete });

      const result = await response.json() as Record<string, unknown>;
      const fullResultText = typeof result['result'] === 'string' ? result['result'] : '';
      const reasoningText = typeof result['reasoning_content'] === 'string' ? result['reasoning_content'] : '';
      const toolCalls = Array.isArray(result['tool_calls']) ? result['tool_calls'] as GenToolCall[] : [];
      if (onReasoning && reasoningText) {
        try { onReasoning(reasoningText, reasoningText, result); } catch (e) { console.warn('onReasoning failed:', e); }
      }
      if (onToolCall) for (const tc of toolCalls) { try { onToolCall(tc); } catch (e) { console.warn('onToolCall failed:', e); } }
      if (onMessage && (fullResultText || reasoningText)) {
        try { onMessage(fullResultText, { result: fullResultText, reasoning_content: reasoningText, tool_calls: toolCalls }); } catch (e) { console.warn('onMessage failed:', e); }
      }
      if (onComplete) onComplete(fullResultText, { result: fullResultText, reasoning_content: reasoningText, tool_calls: toolCalls, raw: result, headers: Object.fromEntries(response.headers.entries()) });
      return fullResultText;
    } catch (error) {
      if (onError) onError(error as Error);
      throw error;
    }
  }

  /** @private 解析 Keepwork proxy SSE 流，返回累积文本。 */
  async _readKeepworkProxySSE(response: Response, { onMessage, onReasoning, onToolCall, onComplete }: { onMessage?: GenChatOptions['onMessage']; onReasoning?: GenChatOptions['onReasoning']; onToolCall?: GenChatOptions['onToolCall']; onComplete?: GenChatOptions['onComplete'] } = {}): Promise<string> {
    const reader = response.body?.getReader();
    const decoder = new TextDecoder('utf-8');
    let result = '', fullResult = '', fullReasoningContent = '';
    let emittedReasoningLen = 0;
    const toolCalls: GenToolCall[] = [];

    if (!reader) { if (onComplete) onComplete('', { result: '', reasoning_content: '', tool_calls: [] }); return ''; }

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        if (onComplete) onComplete(fullResult, { result: fullResult, reasoning_content: fullReasoningContent, tool_calls: toolCalls, headers: Object.fromEntries(response.headers.entries()) });
        break;
      }
      result += decoder.decode(value, { stream: true });
      const datas = result.split('\n');
      try {
        const responsesArray = datas.filter((d) => d.startsWith('data: {')).map((d) => JSON.parse(d.substring('data: '.length)) as Record<string, unknown>);
        const responseResult = responsesArray.map((r) => r['result']).filter((d) => d !== undefined).reduce((a, b) => (a as string) + (b as string), '') as string;
        const responseReasoning = responsesArray.map((r) => r['reasoning_content']).filter((d) => d !== undefined).reduce((a, b) => (a as string) + (b as string), '') as string;
        responsesArray.forEach((r) => {
          if (r['tool_calls'] && Array.isArray(r['tool_calls'])) {
            (r['tool_calls'] as GenToolCall[]).forEach((toolCall) => {
              if (!toolCalls.find((tc) => tc.id === toolCall.id)) {
                toolCalls.push(toolCall);
                if (onToolCall) onToolCall(toolCall);
              }
            });
          }
        });
        if (responseResult.length > 0) fullResult = responseResult;
        if (responseReasoning.length > 0) fullReasoningContent = responseReasoning;
        if (onReasoning && fullReasoningContent.length > emittedReasoningLen) {
          const reasoningDelta = fullReasoningContent.slice(emittedReasoningLen);
          emittedReasoningLen = fullReasoningContent.length;
          try { onReasoning(fullReasoningContent, reasoningDelta); } catch (e) { console.warn('onReasoning failed:', e); }
        }
        if ((responseResult.length > 0 || responseReasoning.length > 0) && onMessage) {
          onMessage(fullResult, { result: fullResult, reasoning_content: fullReasoningContent, tool_calls: toolCalls });
        }
      } catch (e) { console.warn('Error parsing stream response:', e); }
    }
    return fullResult;
  }

  /**
   * 直接调用 OpenAI/OpenRouter 等 provider（支持 tool-calls、streaming）。
   * 在绕过 Keepwork proxy 时使用。
   */
  async chatCompletion(options: GenChatOptions = {}): Promise<unknown> {
    const { messages, prompt, stream = false, temperature, responseFormat, abortController, extraHeaders, onMessage, onReasoning, onToolCall, onComplete, onError } = options;
    const requestedModel = (options['model'] as string | undefined) ?? DEFAULT_CHAT_MODEL;
    const tools = (options['tools'] as unknown[] | undefined);

    try {
      const localModelSettings = this._resolveLocalModelSettings(requestedModel, options['directProvider'] as string | undefined);
      const model = localModelSettings.model ?? requestedModel;
      const provider = this._directProvider(localModelSettings, { ...options, model });
      let apiKey = (options['apiKey'] as string | undefined) ?? localModelSettings.apiKey ?? '';
      if (!apiKey && provider && this.sdk.localAPIKeySettings?.getProviderApiKey) {
        apiKey = this.sdk.localAPIKeySettings.getProviderApiKey(provider) ?? '';
      }
      if (!apiKey) throw new Error(`Direct chat requires API key for provider: ${provider ?? 'unknown'}`);

      const normalizedMessages = this._normalizeMessages(messages, prompt);
      const isGemini = provider === 'gemini' || provider === 'google';

      if (isGemini && tools?.length) throw new Error('Direct chat with tools is not supported for provider: gemini');
      if (isGemini) {
        const wrappedOnMessage = stream && onMessage
          ? (fullText: string, _delta: unknown, raw: unknown) => onMessage(fullText, { result: fullText, reasoning_content: '', tool_calls: [] }, raw)
          : undefined;
        const result = await this._callGoogleLLM({ model, apiKey, messages: normalizedMessages, stream, temperature, responseFormat, onMessage: wrappedOnMessage, abortController, extraHeaders });
        const res = result as { text: string };
        if (stream) { if (onComplete) onComplete(res.text, { result: res.text, reasoning_content: '', tool_calls: [] }); return res.text; }
        if (onComplete) onComplete(res, { result: res.text });
        return res;
      }

      const isOpenRouter = provider === 'openrouter';
      const isOpenAI = provider === 'openai';
      if (!isOpenRouter && !isOpenAI) throw new Error(`Direct chat is not supported for provider: ${provider ?? 'unknown'}`);

      const url = isOpenRouter ? 'https://openrouter.ai/api/v1/chat/completions' : 'https://api.openai.com/v1/chat/completions';
      const headers: Record<string, string> = { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
      if (isOpenRouter) { headers['HTTP-Referer'] = typeof location !== 'undefined' ? location.origin : 'https://keepwork.com'; headers['X-Title'] = 'KeepworkSDK'; }
      if (extraHeaders) Object.assign(headers, extraHeaders);

      const body: Record<string, unknown> = { model, messages: this._normalizeOpenAIChatMessages(normalizedMessages), stream };
      if (temperature !== undefined) body['temperature'] = temperature;
      if (responseFormat) body['response_format'] = typeof responseFormat === 'string' ? { type: responseFormat } : responseFormat;
      if (tools?.length) body['tools'] = tools;

      const reasoningOpt = this._normalizeReasoningOption(model, options['reasoning']);
      const reasoningField = this._buildReasoningBodyField(provider!, reasoningOpt);
      if (reasoningField) body[reasoningField.key] = reasoningField.value;

      const response = await fetch(url, {
        method: 'POST',
        headers: this._normalizeHeaders(headers, `${isOpenRouter ? 'OpenRouter' : 'OpenAI'} 直连请求`),
        body: JSON.stringify(body),
        signal: abortController?.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`Direct chat request failed: ${response.status} ${response.statusText} ${text}`.trim());
      }

      if (!stream) {
        const data = await response.json() as Record<string, unknown>;
        const text = this._extractOpenAIText(data);
        const message = (data?.['choices'] as Array<Record<string, unknown>> | undefined)?.[0]?.['message'] as Record<string, unknown> | undefined ?? {};
        const tCalls = Array.isArray(message['tool_calls']) ? message['tool_calls'] as GenToolCall[] : [];
        const reasoningText = typeof message['reasoning_content'] === 'string' ? message['reasoning_content'] : (typeof message['reasoning'] === 'string' ? message['reasoning'] : '');
        if (onReasoning && reasoningText) {
          try { onReasoning(reasoningText, reasoningText, data); } catch (e) { console.warn('onReasoning failed:', e); }
        }
        if (onToolCall) for (const tc of tCalls) { try { onToolCall(tc); } catch (e) { console.warn('onToolCall failed:', e); } }
        if (onMessage && (text || reasoningText)) { try { onMessage(text, { result: text, reasoning_content: reasoningText, tool_calls: tCalls }); } catch (e) { console.warn('onMessage failed:', e); } }
        if (onComplete) onComplete(text, { result: text, reasoning_content: reasoningText, tool_calls: tCalls, raw: data, headers: Object.fromEntries(response.headers.entries()) });
        return text;
      }
      return await this._readChatCompletionSSE(response, { onMessage, onReasoning, onToolCall, onComplete });
    } catch (error) {
      if (onError) onError(error as Error);
      throw error;
    }
  }

  /** @private 解析 OpenAI/OpenRouter chat-completion SSE，返回累积文本。 */
  async _readChatCompletionSSE(response: Response, { onMessage, onReasoning, onToolCall, onComplete }: { onMessage?: GenChatOptions['onMessage']; onReasoning?: GenChatOptions['onReasoning']; onToolCall?: GenChatOptions['onToolCall']; onComplete?: GenChatOptions['onComplete'] } = {}): Promise<string> {
    const reader = response.body?.getReader();
    if (!reader) { if (onComplete) onComplete('', { result: '', reasoning_content: '', tool_calls: [] }); return ''; }
    const decoder = new TextDecoder('utf-8');
    let buffer = '', fullResult = '', fullReasoningContent = '';
    const toolCallsByIndex = new Map<number, GenToolCall>();
    const announcedKeys = new Set<string>();

    const announce = (): void => {
      if (!onToolCall) return;
      for (const tc of toolCallsByIndex.values()) {
        if (!tc.function?.name) continue;
        const key = tc.id ?? `${tc.function.name}:${tc.function.arguments}`;
        if (announcedKeys.has(key)) continue;
        announcedKeys.add(key);
        onToolCall(tc);
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let json: Record<string, unknown>;
        try { json = JSON.parse(payload) as Record<string, unknown>; } catch { continue; }
        if ((json?.['error'] as Record<string, unknown> | undefined)?.['message'] && !fullResult) throw new Error(String((json['error'] as Record<string, unknown>)['message']));
        const choice = ((json?.['choices'] as Array<Record<string, unknown>> | undefined)?.[0] ?? {}) as Record<string, unknown>;
        const delta = (choice['delta'] ?? choice['message'] ?? {}) as Record<string, unknown>;
        let changed = false;
        if (typeof delta['content'] === 'string' && delta['content']) { fullResult += delta['content']; changed = true; }
        else if (Array.isArray(delta['content'])) { const piece = (delta['content'] as Array<Record<string, string>>).map((p) => p['text'] ?? '').join(''); if (piece) { fullResult += piece; changed = true; } }
        let rPiece = '';
        if (typeof delta['reasoning_content'] === 'string' && delta['reasoning_content']) rPiece = delta['reasoning_content'];
        else if (typeof delta['reasoning'] === 'string' && delta['reasoning']) rPiece = delta['reasoning'];
        if (rPiece) {
          fullReasoningContent += rPiece;
          changed = true;
          if (onReasoning) {
            try { onReasoning(fullReasoningContent, rPiece, json); } catch (e) { console.warn('onReasoning failed:', e); }
          }
        }
        if (Array.isArray(delta['tool_calls'])) {
          for (const tc of delta['tool_calls'] as Array<Record<string, unknown>>) {
            const idx = (tc['index'] as number | undefined) ?? 0;
            let entry = toolCallsByIndex.get(idx);
            if (!entry) { entry = { id: (tc['id'] as string | undefined) ?? '', type: (tc['type'] as string | undefined) ?? 'function', function: { name: '', arguments: '' } }; toolCallsByIndex.set(idx, entry); }
            if (tc['id']) entry.id = tc['id'] as string;
            if (tc['type']) entry.type = tc['type'] as string;
            const fn = tc['function'] as Record<string, string> | undefined;
            if (fn?.['name']) entry.function!.name += fn['name'];
            if (fn?.['arguments']) entry.function!.arguments += fn['arguments'];
          }
        }
        if (choice['finish_reason'] === 'tool_calls') announce();
        if (changed && onMessage) onMessage(fullResult, { result: fullResult, reasoning_content: fullReasoningContent, tool_calls: Array.from(toolCallsByIndex.values()) });
      }
    }
    announce();
    const fullResponse = { result: fullResult, reasoning_content: fullReasoningContent, tool_calls: Array.from(toolCallsByIndex.values()), headers: Object.fromEntries(response.headers.entries()) };
    if (onComplete) onComplete(fullResult, fullResponse);
    return fullResult;
  }

  // ──────────────────── 直连底层 ────────────────────

  async callLLM(options: GenChatOptions & { returnRaw?: boolean } = {}): Promise<unknown> {
    const { prompt, messages, stream = false, temperature, responseFormat, onMessage, onReasoning, abortController, extraHeaders, returnRaw = false } = options;
    const requestedModel = (options['model'] as string | undefined) ?? DEFAULT_CHAT_MODEL;
    const localModelSettings = this._resolveLocalModelSettings(requestedModel, options['directProvider'] as string | undefined);
    const model = localModelSettings.model ?? requestedModel;
    const apiKey = (options['apiKey'] as string | undefined) ?? localModelSettings.apiKey ?? '';
    const provider = this._directProvider(localModelSettings, { ...options, model });
    if (!apiKey) throw new Error('Direct provider API key is required');
    const normalizedMessages = this._normalizeMessages(messages, prompt);
    let result: unknown;
    if (provider === 'gemini' || provider === 'google') {
      result = await this._callGoogleLLM({ model, apiKey, messages: normalizedMessages, stream, temperature, responseFormat, onMessage, onReasoning, abortController, extraHeaders });
    } else if (provider === 'openai') {
      result = await this._callOpenAILLM({ model, apiKey, messages: normalizedMessages, stream, temperature, responseFormat, onMessage, onReasoning, abortController, extraHeaders });
    } else if (provider === 'openrouter') {
      result = await this._callOpenRouterLLM({ model, apiKey, messages: normalizedMessages, stream, temperature, responseFormat, onMessage, onReasoning, abortController, extraHeaders });
    } else {
      throw new Error(`Direct provider is not supported: ${provider ?? 'unknown'}`);
    }
    return returnRaw ? result : (result as { text: string })?.text;
  }

  async _callOpenAILLM(opts: { model: string; apiKey: string; messages: GenMessage[]; stream?: boolean; temperature?: number; responseFormat?: unknown; onMessage?: GenChatOptions['onMessage']; onReasoning?: GenChatOptions['onReasoning']; abortController?: AbortController; extraHeaders?: Record<string, string> }): Promise<{ text: string; data?: unknown }> {
    const { model, apiKey, messages, stream = false, temperature, responseFormat, onMessage, onReasoning, abortController, extraHeaders } = opts;
    const body: Record<string, unknown> = { model, messages, stream };
    if (temperature !== undefined) body['temperature'] = temperature;
    if (responseFormat) body['response_format'] = typeof responseFormat === 'string' ? { type: responseFormat } : responseFormat;
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: this._normalizeHeaders({ 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json', ...(extraHeaders ?? {}) }, 'OpenAI 直连请求'),
      body: JSON.stringify(body),
      signal: abortController?.signal,
    });
    if (!resp.ok) throw new Error(`OpenAI 调用失败: ${resp.status} ${await resp.text()}`);
    if (stream) return { text: await this._readSSETextResponse(resp, 'openai', { onMessage, onReasoning }) } as unknown as { text: string; data?: unknown };
    const data = await resp.json() as Record<string, unknown>;
    return { text: this._extractOpenAIText(data), data } as unknown as { text: string; data?: unknown };
  }

  async _callOpenRouterLLM(opts: { model: string; apiKey: string; messages: GenMessage[]; stream?: boolean; temperature?: number; responseFormat?: unknown; onMessage?: GenChatOptions['onMessage']; onReasoning?: GenChatOptions['onReasoning']; onImage?: GenChatOptions['onImage']; abortController?: AbortController; extraHeaders?: Record<string, string>; extraBody?: Record<string, unknown> }): Promise<{ text: string; imageUrl?: string; data?: unknown; reasoning?: string }> {
    const { model, apiKey, messages, stream = false, temperature, responseFormat, onMessage, onReasoning, onImage, abortController, extraHeaders, extraBody } = opts;
    const body: Record<string, unknown> = { model, messages, stream };
    if (temperature !== undefined) body['temperature'] = temperature;
    if (responseFormat) body['response_format'] = typeof responseFormat === 'string' ? { type: responseFormat } : responseFormat;
    if (extraBody) Object.assign(body, extraBody);
    const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: this._normalizeHeaders({
        'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json',
        'HTTP-Referer': typeof location !== 'undefined' ? location.origin : 'https://keepwork.com',
        'X-Title': 'KeepworkSDK', ...(extraHeaders ?? {}),
      }, 'OpenRouter 直连请求'),
      body: JSON.stringify(body),
      signal: abortController?.signal,
    });
    if (!resp.ok) throw new Error(`OpenRouter 调用失败: ${resp.status} ${await resp.text()}`);
    if (stream) return await this._readSSEImageResponse(resp, 'openrouter', { onMessage, onReasoning, onImage }) as unknown as { text: string; imageUrl?: string; data?: unknown; reasoning?: string };
    const data = await resp.json() as Record<string, unknown>;
    return { text: this._extractOpenAIText(data), data } as unknown as { text: string; imageUrl?: string; data?: unknown; reasoning?: string };
  }

  async _callGoogleLLM(opts: { model: string; apiKey: string; messages: GenMessage[]; stream?: boolean; temperature?: number; responseFormat?: unknown; onMessage?: GenChatOptions['onMessage']; onReasoning?: GenChatOptions['onReasoning']; abortController?: AbortController; extraHeaders?: Record<string, string> }): Promise<{ text: string; data?: unknown }> {
    const { model, apiKey, messages, stream = false, temperature, responseFormat, onMessage, onReasoning, abortController, extraHeaders } = opts;
    const generationConfig: Record<string, unknown> = {};
    if (temperature !== undefined) generationConfig['temperature'] = temperature;
    if (responseFormat === 'json_object' || (responseFormat as Record<string, string>)?.['type'] === 'json_object') generationConfig['responseMimeType'] = 'application/json';
    const body: Record<string, unknown> = { contents: this._messagesToGeminiContents(messages) };
    if (Object.keys(generationConfig).length > 0) body['generationConfig'] = generationConfig;
    const action = stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
    const keySeparator = action.includes('?') ? '&' : '?';
    const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:${action}${keySeparator}key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: this._normalizeHeaders({ 'Content-Type': 'application/json', ...(extraHeaders ?? {}) }, 'Google Gemini 直连请求'),
      body: JSON.stringify(body),
      signal: abortController?.signal,
    });
    if (!resp.ok) throw new Error(`Google Gemini 调用失败: ${resp.status} ${await resp.text()}`);
    if (stream) return { text: await this._readSSETextResponse(resp, 'gemini', { onMessage, onReasoning }) };
    const data = await resp.json() as Record<string, unknown>;
    return { text: this._extractGeminiText(data), data };
  }

  // ──────────────────── SSE 读取 ────────────────────

  async _readSSETextResponse(resp: Response, provider: string, callbacks: { onMessage?: GenChatOptions['onMessage']; onReasoning?: GenChatOptions['onReasoning'] } = {}): Promise<string> {
    const { onMessage, onReasoning } = callbacks;
    const reader = resp.body?.getReader();
    if (!reader) throw new Error('Streaming response body is not available');
    const decoder = new TextDecoder();
    let buffer = '', fullText = '', reasoningText = '', sawChunk = false;
    const consumeLine = (line: string): void => {
      if (!line.startsWith('data:')) return;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') return;
      let json: Record<string, unknown>;
      try { json = JSON.parse(payload) as Record<string, unknown>; } catch (err) { console.warn('[AIGenerators] Ignoring malformed SSE payload:', payload, err); return; }
      sawChunk = true;
      if ((json?.['error'] as Record<string, unknown> | undefined)?.['message'] && !fullText) throw new Error(String((json['error'] as Record<string, unknown>)['message']));
      const reasoningPiece = provider === 'gemini' ? '' : this._extractReasoningText(json);
      if (reasoningPiece) { reasoningText += reasoningPiece; if (onReasoning) onReasoning(reasoningText, reasoningPiece, json); }
      let piece: string = provider === 'gemini'
        ? this._extractGeminiText(json)
        : String((((json?.['choices'] as Array<Record<string, unknown>> | undefined)?.[0]?.['delta'] as Record<string, unknown> | undefined)?.['content'] ?? ((json?.['choices'] as Array<Record<string, unknown>> | undefined)?.[0]?.['message'] as Record<string, unknown> | undefined)?.['content']) ?? '');
      if (Array.isArray(piece)) piece = (piece as unknown as Array<Record<string, string>>).map((p) => p['text'] ?? p['content'] ?? '').join('');
      if (piece) { fullText += piece; if (onMessage) onMessage(fullText, piece, json, { reasoning: reasoningText }); }
    };
    while (true) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try { result = await reader.read(); } catch (err) {
        if (fullText || reasoningText || sawChunk) { console.warn('[AIGenerators] SSE stream ended with read error after content:', err); return fullText || reasoningText; }
        throw err;
      }
      const { value, done } = result;
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) consumeLine(line);
    }
    if (buffer.trim()) consumeLine(buffer.trim());
    return fullText || reasoningText;
  }

  async _readSSEImageResponse(resp: Response, provider: string, callbacks: { onMessage?: GenChatOptions['onMessage']; onReasoning?: GenChatOptions['onReasoning']; onImage?: GenChatOptions['onImage'] } = {}): Promise<{ text: string; reasoning: string; imageUrl: string; data: unknown }> {
    const { onMessage, onReasoning, onImage } = callbacks;
    const reader = resp.body?.getReader();
    if (!reader) throw new Error('Streaming response body is not available');
    const decoder = new TextDecoder();
    let buffer = '', fullText = '', reasoningText = '', imageUrl = '';
    let lastData: unknown = null;
    const consumeLine = (line: string): void => {
      if (!line.startsWith('data:')) return;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') return;
      let json: Record<string, unknown>;
      try { json = JSON.parse(payload) as Record<string, unknown>; } catch (err) { console.warn('[AIGenerators] Ignoring malformed image SSE payload:', payload, err); return; }
      lastData = json;
      if ((json?.['error'] as Record<string, unknown> | undefined)?.['message'] && !fullText && !imageUrl) throw new Error(String((json['error'] as Record<string, unknown>)['message']));
      const reasoningPiece = provider === 'gemini' ? '' : this._extractReasoningText(json);
      if (reasoningPiece) { reasoningText += reasoningPiece; if (onReasoning) onReasoning(reasoningText, reasoningPiece, json); }
      const piece = provider === 'gemini'
        ? this._extractGeminiText(json)
        : String((((json?.['choices'] as Array<Record<string, unknown>> | undefined)?.[0]?.['delta'] as Record<string, unknown> | undefined)?.['content'] ?? ((json?.['choices'] as Array<Record<string, unknown>> | undefined)?.[0]?.['message'] as Record<string, unknown> | undefined)?.['content']) ?? '');
      if (piece) { fullText += piece; if (onMessage) onMessage(fullText, piece, json, { reasoning: reasoningText }); }
      const nextImageUrl = this._extractGeneratedImageUrl(json);
      if (nextImageUrl && nextImageUrl !== imageUrl) { imageUrl = nextImageUrl; if (onImage) onImage(imageUrl, json, { text: fullText, reasoning: reasoningText }); }
    };
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) consumeLine(line);
    }
    if (buffer.trim()) consumeLine(buffer.trim());
    return { text: fullText, reasoning: reasoningText, imageUrl, data: lastData };
  }

  // ──────────────────── 图片 URL 提取（media 层也需要） ────────────────────

  _extractGeneratedImageUrl(data: unknown): string | null {
    if (!data || typeof data !== 'object') return null;
    const d = data as Record<string, unknown>;
    const directUrl = d['imgUrl'] ?? d['url'] ?? d['imageUrl'] ?? d['outputUrl'] ?? d['output_url'];
    if (directUrl && typeof directUrl === 'string') return directUrl;
    const dataArr = Array.isArray(d['data']) ? d['data'] as Array<Record<string, unknown>> : [];
    const firstDataItem: Record<string, unknown> | undefined = dataArr[0];
    if (firstDataItem?.['url']) return firstDataItem['url'] as string;
    if (firstDataItem?.['b64_json']) return `data:image/png;base64,${firstDataItem['b64_json']}`;
    const choicesArr = (d['choices'] ?? (d['data'] as Record<string, unknown> | undefined)?.['choices']) as Array<Record<string, unknown>> | undefined;
    const choice: Record<string, unknown> = choicesArr?.[0] ?? {};
    const message = (choice['message'] ?? choice['delta'] ?? {}) as Record<string, unknown>;
    return this._findFirstImageInValue(message) ?? this._findFirstImageInValue(d['output']) ?? this._findFirstImageInValue(d['images']) ?? this._findFirstImageInValue(d['result']) ?? this._findFirstImageInValue(d) ?? null;
  }

  _findFirstImageInValue(value: unknown): string | null {
    if (!value) return null;
    if (typeof value === 'string') {
      if (value.startsWith('data:image/')) return value;
      return value.match(/https?:\/\/\S+?\.(?:png|jpe?g|webp|gif)(?:\?\S*)?/i)?.[0] ?? null;
    }
    if (Array.isArray(value)) {
      for (const item of value as unknown[]) { const img = this._findFirstImageInValue(item); if (img) return img; }
      return null;
    }
    if (typeof value !== 'object') return null;
    const v = value as Record<string, unknown>;
    if (v['b64_json']) return `data:image/png;base64,${v['b64_json']}`;
    const inlineDataObj = (v['inlineData'] ?? v['inline_data']) as Record<string, string> | undefined;
    if (inlineDataObj?.['data']) {
      const mimeType = inlineDataObj['mimeType'] ?? inlineDataObj['mime_type'] ?? 'image/png';
      return `data:${mimeType};base64,${inlineDataObj['data']}`;
    }
    const imgUrl = v['image_url'] as Record<string, string> | string | undefined;
    const url = (typeof imgUrl === 'object' ? imgUrl?.['url'] : imgUrl) ?? v['imageUrl'] ?? v['url'];
    if (typeof url === 'string' && (url.startsWith('data:image/') || /^https?:\/\//i.test(url))) return url;
    return this._findFirstImageInValue(v['images'] ?? v['content'] ?? v['parts'] ?? v['output'] ?? v['result']);
  }
}
