/**
 * AIChat.core.ts — AIChat 核心类（不含 ChatSession）
 *
 * 包含：
 * - AIChat 构造函数（域名推导）
 * - 请求头构造 / 消息过滤 / modId 生成
 * - `chat()` / `_chatRequest()` / `executeTool()` / `sendMessage()`
 * - 历史记录持久化（upsertChatHistory / updateChatHistory / getChatHistory）
 * - 静态工具（generateUUID）
 */

import SDKLogger from '../utils/SDKLogger';

const console = SDKLogger.createModuleConsole('AIChat');

// ──────────────────── 公共类型 ────────────────────

/** 聊天消息 */
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool' | string;
  content: unknown;
  tool_calls?: LLMToolCall[];
  tool_call_id?: string;
  gptChatId?: string;
  _ts?: number;
  _contextOnly?: boolean;
  [key: string]: unknown;
}

/** LLM 工具调用（Function Calling） */
export interface LLMToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
  index?: number;
}

/** chat() / _chatRequest() 调用选项 */
export interface ChatOptions {
  messages?: ChatMessage[];
  model?: string;
  tools?: unknown[];
  enableTools?: string[] | null;
  stream?: boolean;
  maxIterations?: number;
  _iteration?: number;
  _session?: unknown;
  needMqttTools?: boolean;
  needPersonalTools?: boolean;
  knowledgeBaseCodes?: string[];
  apiCacheKey?: string | null;
  reasoning?: boolean | object;
  abortController?: AbortController;
  onMessage?: (text: string, fullResponse?: unknown) => void;
  onToolCall?: (toolCall: LLMToolCall) => void;
  onToolResult?: (result: { name?: string; toolCallId?: string; result: unknown }) => void;
  onComplete?: (result: string, fullResponse?: unknown) => void;
  onError?: (error: Error) => void;
  imageConfig?: { maxImageBytes?: number; autoConvertBase64ToURL?: boolean; maxImageHistoryCount?: number };
  runCode?: boolean;
  skipIfMessageTextEmpty?: boolean;
  workspace?: string | null;
  [key: string]: unknown;
}

/** upsertChatHistory / updateChatHistory 载荷 */
export interface ChatHistoryPayload {
  title?: string;
  chatId?: string;
  modId?: string;
  model?: string;
  messages?: ChatMessage[];
  id?: string;
  [key: string]: unknown;
}

/** getChatHistory 响应 */
export interface ChatHistoryResponse {
  rows?: Array<{ id: string; chatId: string; modId?: string; model?: string; messages?: ChatMessage[] }>;
  [key: string]: unknown;
}

/** SDK 最小接口（避免循环引用） */
export interface AIChatSDKRef {
  token?: string | null;
  baseURL?: string;
  copilotTools?: {
    getToolDefinitions: (categories: string[]) => unknown[];
    canExecute: (name: string) => boolean;
    execute: (name: string, args: unknown, options: unknown) => Promise<unknown>;
  };
  aiGenerators?: {
    chat: (options: ChatOptions) => Promise<unknown>;
  };
  localAPIKeySettings?: {
    resolveModelSettings: (model: string) => { model?: string; apiKey?: string };
  };
  [key: string]: unknown;
}

// ──────────────────── AIChat ────────────────────

/**
 * AIChat — Keepwork AI 聊天核心类。
 *
 * 负责：
 * - API 路由与认证头构建
 * - `chat()` 调用循环（含 tool-call 递归）
 * - 工具执行（executeTool）
 * - 历史记录持久化
 * - ChatSession 工厂（`createSession()`，实现在 AIChat.session.ts）
 */
class AIChat {
  sdk: AIChatSDKRef;
  baseURL: string;

  constructor(sdk: AIChatSDKRef) {
    this.sdk = sdk;
    const hostname = typeof window !== 'undefined' ? window.location.hostname : 'keepwork.com';
    const domain = this.extractMainDomain(hostname);
    this.baseURL = `https://api.${domain}/core/v0`;
  }

  // ──────────────────── 工具方法 ────────────────────

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
    ) {
      return 'keepwork.com';
    }
    const parts = hostname.split('.');
    return parts.length <= 2 ? hostname : parts.slice(-2).join('.');
  }

  /**
   * 从 LocalAPIKeySettings 解析本地模型配置（model / apiKey）。
   * 若 SDK 无此服务则直接返回原始 model。
   */
  _resolveLocalModelSettings(model: string): { model?: string; apiKey?: string } {
    return this.sdk?.localAPIKeySettings?.resolveModelSettings(model) ?? { model: model ?? '' };
  }

  /** 生成 UUID v4（浏览器原生优先）。 */
  static generateUUID(): string {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  /**
   * 从当前 URL 路径提取站点信息（username / project / pagePath）。
   * 用于 _generateModId。
   */
  _getSiteInfo(): { username?: string; project?: string; pagePath?: string } {
    if (typeof window === 'undefined') return {};
    const paths = window.location.pathname.split('/');
    let usernameIndex = 1;
    if (paths.length > 1 && paths[1] === 'ed') usernameIndex = 2;
    return {
      username: paths[usernameIndex],
      project: paths[usernameIndex + 1],
      pagePath: paths.slice(usernameIndex + 2).join('/'),
    };
  }

  /**
   * 根据 persistedId 构建完整的 modId 路径。
   * 若 persistedId 已含 `/` 则直接返回；否则拼接当前 URL 的站点路径。
   */
  _generateModId(persistedId?: string): string | null {
    if (!persistedId) return null;
    if (persistedId.includes('/')) return persistedId;
    const { username, project, pagePath } = this._getSiteInfo();
    if (username && project) {
      const cleanPagePath = pagePath ? pagePath.replace(/^\/+|\/+$/g, '') : '';
      return `${username}/${project}/${cleanPagePath}/${persistedId}`.replace(/\/+/g, '/');
    }
    return persistedId;
  }

  /**
   * 构建 Keepwork AI API 的请求头（含认证 token）。
   * 先查 sdk.token，再回退 localStorage。
   */
  _getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'accept-language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
      'cache-control': 'no-cache',
      'content-type': 'application/json',
      'pragma': 'no-cache',
      'priority': 'u=1, i',
      'sec-ch-ua': '"Not)A;Brand";v="8", "Chromium";v="138", "Google Chrome";v="138"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-site',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
    };

    let token = this.sdk.token;
    if (!token && typeof window !== 'undefined' && window.localStorage) {
      try { token = window.localStorage.getItem('token'); } catch (e) {
        console.warn('Failed to get token from localStorage:', e);
      }
    }
    if (token) headers['authorization'] = `Bearer ${token}`;
    return headers;
  }

  /**
   * 过滤消息数组中非远程的 image_url（只保留 http/https 开头的远程链接）。
   * 用于持久化历史时去掉 base64 大图。
   */
  _filterMessages(messages: ChatMessage[] | null | undefined): ChatMessage[] | null | undefined {
    if (!messages || !Array.isArray(messages)) return messages;
    return messages.map((message) => {
      if (!Array.isArray(message.content)) return message;
      const filteredContent = (message.content as unknown[]).filter((item) => {
        const i = item as Record<string, unknown>;
        if (i['type'] !== 'image_url') return true;
        const imageUrl = (i['image_url'] as Record<string, string> | undefined)?.['url'];
        if (!imageUrl) return false;
        return imageUrl.startsWith('http://') || imageUrl.startsWith('https://');
      });
      return { ...message, content: filteredContent };
    });
  }

  /** 判断 model 是否应禁用 reasoning（包含 'flash' 的模型）。 */
  _shouldDisableReasoning(model: string): boolean {
    return typeof model === 'string' && model.toLowerCase().includes('flash');
  }

  // ──────────────────── 历史记录持久化 ────────────────────

  /**
   * 插入或更新 AI 聊天历史记录。
   * 自动过滤非远程 image_url，避免 base64 写入历史表。
   */
  async upsertChatHistory(payload: ChatHistoryPayload): Promise<unknown> {
    const filteredPayload = { ...payload, messages: this._filterMessages(payload.messages) };
    const response = await fetch(`${this.baseURL}/gpt/aiChatHistory/upsert`, {
      method: 'POST', headers: this._getHeaders(), body: JSON.stringify(filteredPayload),
    });
    if (!response.ok) throw new Error(`Failed to upsert chat history: ${response.statusText}`);
    return response.json();
  }

  /**
   * 更新指定历史记录。
   * 自动过滤非远程 image_url。
   */
  async updateChatHistory(id: string, payload: ChatHistoryPayload): Promise<unknown> {
    const filteredPayload = { ...payload, messages: this._filterMessages(payload.messages) };
    const response = await fetch(`${this.baseURL}/gpt/aiChatHistory/${id}`, {
      method: 'PUT', headers: this._getHeaders(), body: JSON.stringify(filteredPayload),
    });
    if (!response.ok) throw new Error(`Failed to update chat history: ${response.statusText}`);
    return response.json();
  }

  /**
   * 查询指定 modId 下的历史记录列表。
   */
  async getChatHistory(modId: string): Promise<ChatHistoryResponse> {
    const response = await fetch(
      `${this.baseURL}/gpt/aiChatHistory?modId=${encodeURIComponent(modId)}`,
      { method: 'GET', headers: this._getHeaders() }
    );
    if (!response.ok) throw new Error(`Failed to get chat history: ${response.statusText}`);
    return response.json() as Promise<ChatHistoryResponse>;
  }

  // ──────────────────── 核心 chat 循环 ────────────────────

  /**
   * 发起一次 AI 对话，支持 tool-call 递归循环。
   *
   * 流程：
   * 1. 调用 `_chatRequest()` 获取响应
   * 2. 若响应包含 tool_calls，执行所有工具并追加结果到 messages
   * 3. 递归调用 `chat()` 继续对话（受 maxIterations 限制）
   *
   * @param options - 包含 messages / model / tools / enableTools / 流式回调等
   * @returns 最终的 assistant 文本响应
   */
  async chat(options: ChatOptions = {}): Promise<unknown> {
    const { messages } = options;
    if (!messages || messages.length === 0) throw new Error('Messages array is required and cannot be empty');

    options._iteration = (options._iteration ?? 0) + 1;
    if (options.maxIterations && options._iteration > options.maxIterations) {
      return messages.filter((m) => m.role === 'assistant').pop()?.content ?? '';
    }

    let toolCallsCollected: LLMToolCall[] = [];
    const originalOnToolCall = options.onToolCall;
    const wrappedOnToolCall = (toolCall: LLMToolCall): void => {
      const normalized: LLMToolCall = {
        ...toolCall,
        id: toolCall.id ?? `tool_call_${AIChat.generateUUID()}`,
        type: toolCall.type ?? 'function',
      };
      toolCallsCollected.push(normalized);
      originalOnToolCall?.(normalized);
    };

    const response = await this._chatRequest({ ...options, onToolCall: wrappedOnToolCall });

    const toolCalls = toolCallsCollected;
    const assistantContent =
      typeof response === 'string'
        ? response
        : ((response as Record<string, unknown>)?.['result'] ??
           ((response as Record<string, unknown>)?.['choices'] as Array<Record<string, unknown>> | undefined)?.[0]?.['message'] as string | null ??
           '').toString();

    if (toolCalls.length > 0) {
      const assistantMsg: ChatMessage = {
        role: 'assistant',
        content: assistantContent as string,
        tool_calls: toolCalls,
      };
      messages.push(assistantMsg);

      const toolResults: Array<{ tool_call_id?: string; result: unknown }> = [];
      const session = options._session as { _restartSignal?: unknown } | undefined;

      for (const toolCall of toolCalls) {
        if (session?._restartSignal) {
          console.log('[AIChat] _restartSignal detected, aborting tool loop');
          break;
        }
        const fnName = toolCall.function?.name;
        try {
          const toolResult = await this.executeTool(toolCall, options);
          toolResults.push({ tool_call_id: toolCall.id, result: toolResult });
          options.onToolResult?.({ name: fnName, toolCallId: toolCall.id, result: toolResult });
        } catch (error) {
          if ((error as Record<string, unknown>)?.['isRestartAgentSignal']) {
            if (session) (session as Record<string, unknown>)['_restartSignal'] = error;
            throw error;
          }
          console.error('Tool call execution failed:', error);
          const errorResult = { error: (error as Error).message ?? 'Tool execution failed' };
          toolResults.push({ tool_call_id: toolCall.id, result: errorResult });
          options.onToolResult?.({ name: fnName, toolCallId: toolCall.id, result: errorResult });
        }
      }

      if (session?._restartSignal) {
        console.log('[AIChat] _restartSignal detected, aborting chat recursion');
        return assistantContent as string ?? '';
      }

      for (const toolResult of toolResults) {
        messages.push({
          role: 'tool',
          tool_call_id: toolResult.tool_call_id,
          content: typeof toolResult.result === 'string' ? toolResult.result : JSON.stringify(toolResult.result),
        });
      }

      return this.chat(options);
    }

    return response;
  }

  /**
   * 构建工具列表并委托给 `sdk.aiGenerators.chat()` 执行实际请求。
   * 统一了 Keepwork proxy 和直连两种传输方式。
   * @private
   */
  async _chatRequest(options: ChatOptions = {}): Promise<unknown> {
    let tools = options.tools ? [...options.tools] : [];
    const copilotTools = this.sdk?.copilotTools;

    if (copilotTools) {
      let enableTools = options.enableTools;
      if (!enableTools) {
        enableTools = [];
        if (options.needMqttTools) enableTools.push('mqtt');
        if (options.needPersonalTools) enableTools.push('personalPage');
      }
      if (enableTools.length > 0) {
        tools = [...tools, ...copilotTools.getToolDefinitions(enableTools)];
      }
    }

    const { messages = [] } = options;
    if (!messages || messages.length === 0) throw new Error('Messages array is required and cannot be empty');

    const generators = this.sdk?.aiGenerators;
    if (!generators?.chat) throw new Error('sdk.aiGenerators.chat is required for chat');

    return generators.chat({ ...options, model: options.model ?? 'keepwork-pro', tools });
  }

  /**
   * 简便发送：将单条文本消息包装为 messages 数组发送。
   */
  async sendMessage(text: string, options: ChatOptions = {}): Promise<unknown> {
    const messages: ChatMessage[] = [{ role: 'user', content: text }];
    return this.chat({ ...options, messages });
  }

  /**
   * 执行单次工具调用。
   *
   * 路由顺序：
   * 1. session.sandbox（自定义 API → 代理 → 内置）
   * 2. sdk.copilotTools
   * 3. options.onToolCall 回退
   *
   * @param toolCall - 工具调用对象（含 function.name 和 function.arguments）
   * @param options  - 调用上下文（含 _session）
   */
  async executeTool(toolCall: LLMToolCall, options: ChatOptions = {}): Promise<unknown> {
    const fnName = toolCall.function?.name ?? '';
    const fnArgs = JSON.parse(toolCall.function?.arguments ?? '{}') as Record<string, unknown>;

    const sandbox = (options._session as Record<string, unknown> | undefined)?.['sandbox'] as
      | { execute: (name: string, args: unknown, opts: unknown) => Promise<unknown> }
      | undefined;
    if (sandbox) return sandbox.execute(fnName, fnArgs, options);

    const copilotTools = this.sdk?.copilotTools;
    if (copilotTools?.canExecute(fnName)) return copilotTools.execute(fnName, fnArgs, options);

    if (options.onToolCall) return options.onToolCall(toolCall);

    throw new Error(`Tool '${fnName}' not implemented`);
  }

  /**
   * 创建新的 ChatSession 实例（实现在 AIChat.session.ts 中，由 AIChat.ts 注入）。
   * 此声明仅供类型推断，运行时会被 AIChat.ts 覆盖。
   */
  createSession(_options: Record<string, unknown> = {}): unknown {
    throw new Error('createSession not yet initialized — ensure AIChat.session.ts is imported');
  }
}

export default AIChat;
