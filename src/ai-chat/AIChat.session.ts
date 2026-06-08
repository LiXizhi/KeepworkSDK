/**
 * AIChat.session.ts — ChatSession 类
 *
 * 包含：
 * - ChatSession 构造函数（历史/sandbox/子 session/AgentRouter 注册）
 * - send()（含子 agent 结果注入、模板展开、图片压缩/上传、历史持久化）
 * - 消息管理（addUserMessage / addAssistantMessage / clear / getHistory）
 * - 消息修剪（_evictMessages / _evictExcessImages）
 * - 工作空间管理（setWorkspace / setMountFolder）
 * - AgentRouter 集成（executeTool / unregisterAgent）
 * - restartAgent（配置文件加载 + 状态重置）
 *
 * 该文件导出 `ChatSession` 类，并在模块求值时将其挂载到 AIChat.prototype.createSession。
 */

import AIChat, { type ChatMessage, type ChatOptions } from './AIChat.core';
import { initChildSessionState, childSessionMethods, type ChildSessionHost } from './ChildSessionMixin';
import SandboxToolEnv from './SandboxToolEnv';
import { compressContentImages, uploadTempVisionImage, DEFAULT_MAX_BYTES } from '../utils/ImageUtils';
import SDKLogger from '../utils/SDKLogger';

const console = SDKLogger.createModuleConsole('AIChat');

// ──────────────────── 类型 ────────────────────

/** ChatSession 构造选项 */
export interface ChatSessionOptions {
  chatId?: string;
  modId?: string;
  persistedId?: string;
  skipHistory?: boolean;
  model?: string;
  apiCacheKey?: string | null;
  historyLength?: number;
  systemPrompt?: string;
  system_prompt?: string;
  workspace?: string | null;
  mountFolder?: unknown;
  enabledCategories?: string[];
  toolProxy?: unknown;
  name?: string;
  parentSession?: unknown;
  onChildStream?: ((event: unknown) => void) | null;
  backgroundAgent?: boolean;
  _depth?: number;
  _maxDepth?: number;
  [key: string]: unknown;
}

/** 默认设置（restartAgent 回退用） */
interface DefaultSettings {
  model: string;
  historyLength: number;
  workspace: string | null;
  mountFolder: unknown;
  systemPrompt: string | null;
  enabledCategories: string[];
}

// ──────────────────── ChatSession ────────────────────

/**
 * ChatSession — 单个 AI 对话会话。
 *
 * 管理：
 * - 对话消息历史（messages 数组）
 * - 工具执行 sandbox（SandboxToolEnv）
 * - 子 agent 任务队列（via ChildSessionMixin）
 * - 历史持久化（upsertChatHistory / updateChatHistory）
 * - AgentRouter 注册（命名顶层 session 自动注册）
 * - agent 重启（restartAgent + AgentConfig 配置文件加载）
 */
class ChatSession implements ChildSessionHost {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  aiChat: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  messages: any[] = [];
  chatId: string;
  modId: string | null;
  skipHistory: boolean;
  historyId?: string;
  historyRows: unknown[] | null = null;
  model: string;
  apiCacheKey: string | null;
  historyLength: number;
  options: ChatSessionOptions;
  sandbox: SandboxToolEnv;

  _workspaceExplicitlySet: boolean;
  workspace: string | null;
  mountFolder: unknown;
  _pendingContexts: string[] = [];
  _restartedWithPromptFile = false;
  _savedMessages?: ChatMessage[] | null;
  _restartSignal?: unknown;
  _registeredAsAgent = false;
  _defaultSettings: DefaultSettings;

  // ChildSessionHost fields (injected by initChildSessionState)
  name!: string | null;
  parentSession!: ChildSessionHost | null;
  _childSessions!: Record<string, import('./ChildSessionMixin').ChildSessionEntry>;
  _pendingChildResults!: import('./ChildSessionMixin').PendingChildResult[];
  _debounceTimers!: ReturnType<typeof setTimeout>[];
  _isSending!: boolean;
  _lastSendOptions!: Record<string, unknown>;
  _maxChildSessions!: number;
  _depth!: number;
  _maxDepth!: number;
  onChildStream!: ((event: import('./ChildSessionMixin').ChildStreamEvent) => void) | null;

  constructor(aiChat: AIChat, options: ChatSessionOptions = {}) {
    const normalizedOptions = { ...options };
    if (normalizedOptions.systemPrompt === undefined && normalizedOptions.system_prompt !== undefined) {
      normalizedOptions.systemPrompt = normalizedOptions.system_prompt;
    }

    this.aiChat = aiChat;
    this.messages = [];
    this.chatId = normalizedOptions.chatId ?? AIChat.generateUUID();

    let persistedId = normalizedOptions.persistedId;
    if (!normalizedOptions.modId && !persistedId) {
      persistedId = Math.floor(1000 + Math.random() * 9000).toString();
    }
    this.modId = normalizedOptions.modId ?? aiChat._generateModId(persistedId) ?? null;
    this.skipHistory = !!normalizedOptions.skipHistory;
    this.historyId = undefined;
    this.historyRows = null;
    this.model = normalizedOptions.model ?? 'keepwork-flash';
    this.apiCacheKey = normalizedOptions.apiCacheKey ?? null;
    this.historyLength = (normalizedOptions.historyLength ?? 0) > 0 ? normalizedOptions.historyLength! : 0;
    this.options = normalizedOptions;

    if (normalizedOptions.systemPrompt) {
      this.messages.push({ role: 'system', content: normalizedOptions.systemPrompt });
    }

    this._workspaceExplicitlySet = normalizedOptions.workspace !== undefined;
    this.workspace = normalizedOptions.workspace ?? null;
    this.mountFolder = normalizedOptions.mountFolder ?? null;
    this._pendingContexts = [];

    this.sandbox = new SandboxToolEnv(aiChat.sdk, {
      workspace: this.workspace ?? '',
      mountFolder: this.mountFolder,
      enabledCategories: normalizedOptions.enabledCategories ?? ['fileOps', 'execute'],
      toolProxy: normalizedOptions.toolProxy ?? undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      session: this as any,
    });

    // sdk getter（通过 aiChat.sdk 访问）
    Object.defineProperty(this, 'sdk', { get: () => this.aiChat.sdk, configurable: true });

    // 注入子 agent 状态
    initChildSessionState(this as unknown as ChildSessionHost, normalizedOptions as import('./ChildSessionMixin').ChildSessionInitOptions);

    this._defaultSettings = {
      model: this.model,
      historyLength: this.historyLength,
      workspace: this.workspace,
      mountFolder: this.mountFolder,
      systemPrompt: normalizedOptions.systemPrompt ?? null,
      enabledCategories: normalizedOptions.enabledCategories ?? ['fileOps', 'execute'],
    };

    // 自动向 AgentRouter 注册命名顶层 session
    this._registeredAsAgent = false;
    if (this.name && !this.parentSession) {
      const router = (aiChat.sdk as Record<string, unknown>)?.['agentRouter'] as
        | { register?: (name: string, session: ChatSession) => boolean } | undefined;
      if (router) {
        this._registeredAsAgent = router.register?.(this.name, this) ?? false;
        if (!this._registeredAsAgent) {
          console.warn(`[ChatSession] Failed to register agent '${this.name}' — name may already be taken.`);
        }
      }
    }
  }

  // ──────────────────── 消息 API ────────────────────

  /** sdk 访问器（指向 aiChat.sdk） */
  get sdk(): unknown { return this.aiChat.sdk; }

  /**
   * 入队后台上下文（将在下一次 send() 时注入到用户消息前）。
   * 多次调用会累积；下次 send() 时统一冲刷。
   * @param text - 要注入的上下文文本
   */
  sendContext(text: string): void {
    if (!text) return;
    this._pendingContexts.push(String(text));
  }

  /**
   * 取消注册 AgentRouter 中的 agent 名称。
   * 当此 session 不再处理该 agent 任务时调用。
   */
  unregisterAgent(): void {
    if (this._registeredAsAgent && this.name) {
      const router = (this.aiChat.sdk as Record<string, unknown>)?.['agentRouter'] as
        | { unregister?: (name: string) => void } | undefined;
      router?.unregister?.(this.name);
      this._registeredAsAgent = false;
    }
  }

  /**
   * 直接通过 sandbox 执行工具（AgentRouter.toolCallOnly 路径使用）。
   */
  executeTool(fnName: string, fnArgs: unknown): Promise<unknown> {
    return this.sandbox.execute(fnName, fnArgs as Record<string, unknown>, { _proxied: true });
  }

  /**
   * 设置文件操作工作空间。
   * 同步更新 `this.workspace` 和 `this.sandbox.workspace`。
   * @param wsName - 工作空间名，null/'' 表示清除
   */
  setWorkspace(wsName: string | null): void {
    const nextWorkspace = wsName || null;
    const nextSandboxWorkspace = nextWorkspace ?? '';
    if (this.workspace === nextWorkspace && (!this.sandbox || this.sandbox.workspace === nextSandboxWorkspace)) return;
    this._workspaceExplicitlySet = true;
    this.workspace = nextWorkspace;
    if (this.sandbox) this.sandbox.workspace = nextSandboxWorkspace;
    console.log(`[ChatSession] Workspace set to: ${this.workspace ?? '(none)'}`);
  }

  /**
   * 设置只读回退层的 mountFolder 配置。
   * @param mountFolderConfig - 挂载文件夹路径/对象，或 null 清除
   */
  setMountFolder(mountFolderConfig: unknown): void {
    this.mountFolder = mountFolderConfig ?? null;
    if (this.sandbox) this.sandbox.mountFolder = this.mountFolder;
    console.log(`[ChatSession] MountFolder set to: ${this.mountFolder ?? '(none)'}`);
  }

  /** 设置 API 缓存 Key（传递给 aiGenerators.chat）。 */
  setAPICacheKey(key: string): void { this.apiCacheKey = key; }

  /**
   * 向会话历史追加用户消息（自动冲刷 _pendingContexts 并注入到消息前）。
   * @param content - 消息内容（字符串或多模态数组）
   */
  addUserMessage(content: unknown): ChatMessage {
    const contextPrefix = this._flushPendingContexts();
    let resolvedContent = content;
    if (contextPrefix && typeof resolvedContent === 'string') {
      resolvedContent = contextPrefix + '\n' + resolvedContent;
    } else if (contextPrefix && Array.isArray(resolvedContent)) {
      resolvedContent = [{ type: 'text', text: contextPrefix }, ...resolvedContent];
    }
    const message: ChatMessage = { role: 'user', content: resolvedContent, _ts: Date.now() };
    this.messages.push(message);
    return message;
  }

  /**
   * 冲刷并返回所有待注入的上下文（包裹在 context_begin…context_end 块中）。
   * 若无待处理上下文则返回空字符串。
   * @private
   */
  _flushPendingContexts(): string {
    if (!this._pendingContexts?.length) return '';
    const contexts = this._pendingContexts.splice(0);
    return '(context_begin)\n' + contexts.join('\n') + '\n(context_end)';
  }

  /**
   * 向会话历史追加助手消息。
   * @param content    - 助手文本内容
   * @param gptChatId  - 可选的 GPT Chat ID（用于历史关联）
   */
  addAssistantMessage(content: string | null | unknown, gptChatId?: string): void {
    const message: ChatMessage = { role: 'assistant', content: content as string, _ts: Date.now() };
    if (gptChatId) message.gptChatId = gptChatId;
    this.messages.push(message);
  }

  // ──────────────────── send() ────────────────────

  /**
   * 发送消息并更新会话历史（主发送入口）。
   *
   * 处理流程：
   * 1. 取消 debounce 定时器
   * 2. 若 runCode=true，通过 sandbox.processTemplate 展开 ${...} 表达式
   * 3. 注入待处理的子 agent 结果（tool call 形式）
   * 4. 冲刷 _pendingContexts
   * 5. 压缩 / 上传内联 base64 图片
   * 6. 添加用户消息，修剪历史
   * 7. 调用 aiChat.chat()
   * 8. 追加助手消息，持久化历史
   *
   * @param userMessage - 用户消息（字符串、多模态数组，或 null 仅消费子 agent 结果）
   * @param options     - 发送选项（model / tools / enableTools / 流式回调等）
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async send(userMessage: unknown, options: any = {}): Promise<unknown> {
    (this as any)._cancelDebounceTimers?.();
    this._isSending = true;
    const summarizeDebugValue = (v: unknown): string => {
      const s = typeof v === 'string' ? v : JSON.stringify(v);
      return s.length > 180 ? s.slice(0, 180) + '...' : s;
    };
    console.log(`[ChatSession.send] start session='${this.name ?? 'root'}' userMessage=${summarizeDebugValue(userMessage)}`);

    try {
      let resolvedUserMessage = userMessage;
      const effectiveOptions: ChatOptions = {
        ...this.options,
        ...options,
        apiCacheKey: this.apiCacheKey,
      };
      if (this._workspaceExplicitlySet) effectiveOptions.workspace = this.workspace;

      // 模板展开
      const shouldProcessTemplate = effectiveOptions.runCode === true && typeof userMessage === 'string';
      if (shouldProcessTemplate) {
        resolvedUserMessage = await this.sandbox.processTemplate(userMessage as string);
        console.log(`[ChatSession.send] runCode resolved userMessage=${summarizeDebugValue(resolvedUserMessage)}`);
      }

      // 注入子 agent 结果
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const childResults: import('./ChildSessionMixin').PendingChildResult[] = (this as any)._consumePendingChildResults?.() ?? [];
      if (childResults.length > 0) {
        console.log(`[ChatSession.send] injecting ${childResults.length} pending child result(s) into session='${this.name ?? 'root'}'`);
        const toolCalls = childResults.map((cr) => ({
          id: cr.taskId, type: 'function',
          function: { name: 'async_agent_task', arguments: JSON.stringify({ agent: cr.agentName, task: cr.taskSummary }) },
        }));
        this.messages.push({ role: 'assistant', content: null, tool_calls: toolCalls });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const cr of childResults as any[]) {
          this.messages.push({
            role: 'tool', tool_call_id: cr.taskId,
            content: typeof cr.result === 'string' ? cr.result : JSON.stringify(cr.result),
          });
        }
      }

      // 冲刷上下文
      const contextPrefix = this._flushPendingContexts();
      if (contextPrefix) {
        if (resolvedUserMessage == null) resolvedUserMessage = contextPrefix;
        else if (typeof resolvedUserMessage === 'string') resolvedUserMessage = contextPrefix + '\n' + resolvedUserMessage;
        else if (Array.isArray(resolvedUserMessage)) resolvedUserMessage = [{ type: 'text', text: contextPrefix }, ...resolvedUserMessage];
      }

      // 空模板结果跳过
      if (
        effectiveOptions.skipIfMessageTextEmpty === true &&
        shouldProcessTemplate &&
        typeof resolvedUserMessage === 'string' &&
        resolvedUserMessage.trim() === '' &&
        childResults.length === 0
      ) {
        console.log(`[ChatSession.send] skipped empty runCode result in session='${this.name ?? 'root'}'`);
        return '';
      }

      // 图片压缩 / 上传
      if (Array.isArray(resolvedUserMessage)) {
        const imageConfig = effectiveOptions.imageConfig ?? {};
        const maxImageBytes = imageConfig.maxImageBytes ?? DEFAULT_MAX_BYTES;
        resolvedUserMessage = await compressContentImages(resolvedUserMessage as import('../utils/ImageUtils').ContentItem[], { maxBytes: maxImageBytes });
        if (imageConfig.autoConvertBase64ToURL !== false) {
          resolvedUserMessage = await this._uploadInlineImages(resolvedUserMessage as import('../utils/ImageUtils').ContentItem[]);
        }
      }

      // 追加用户消息
      let userMessageEntry: ChatMessage | null = null;
      if (resolvedUserMessage != null) {
        userMessageEntry = this.addUserMessage(resolvedUserMessage);
        if (typeof effectiveOptions.onUserMessage === 'function') {
          try { (effectiveOptions.onUserMessage as (m: ChatMessage) => void)(userMessageEntry); } catch (e) {
            console.warn('[ChatSession.send] onUserMessage callback failed:', e);
          }
        }
      }

      if (this._restartedWithPromptFile) this._restartedWithPromptFile = false;

      // 修剪消息历史
      this._evictMessages();
      if (effectiveOptions.imageConfig?.maxImageHistoryCount != null) {
        this._evictExcessImages(effectiveOptions.imageConfig.maxImageHistoryCount!);
      }

      this._lastSendOptions = effectiveOptions;
      console.log('[ChatSession.send] options:', effectiveOptions);

      let currentGptChatId: string | undefined;
      const response = await this.aiChat.chat({
        ...effectiveOptions,
        _session: this,
        messages: this.messages,
        onComplete: (result: string, fullResponse?: unknown) => {
          const fr = fullResponse as Record<string, unknown> | undefined;
          if (fr?.['headers']) {
            currentGptChatId = (fr['headers'] as Record<string, string>)?.['x-gpt-chat-id'];
          }
          effectiveOptions.onComplete?.(result, fullResponse);
        },
      });

      const assistantContent =
        typeof response === 'string'
          ? response
          : (response as Record<string, unknown>)?.['result']
          ?? null;

      this.addAssistantMessage(assistantContent, currentGptChatId);

      // 持久化历史
      try {
        const sdkRef = this.aiChat.sdk as { token?: string | null } | undefined;
        if (!this.skipHistory && this.chatId && this.modId && sdkRef?.token?.trim()) {
          const usedModel = options.model ?? this.model;
          if (this.historyId) {
            await this.aiChat.updateChatHistory(this.historyId, {
              id: this.historyId, chatId: this.chatId, modId: this.modId, model: usedModel, messages: this.messages,
            });
          } else {
            await this.aiChat.upsertChatHistory({
              title: typeof resolvedUserMessage === 'string' ? resolvedUserMessage.substring(0, 50) : '',
              chatId: this.chatId, modId: this.modId, model: usedModel, messages: this.messages,
            });
            if (this.historyRows === null) this.historyRows = [];
          }
          try {
            const historyRes = await this.aiChat.getChatHistory(this.modId);
            if (historyRes?.rows) {
              this.historyRows = historyRes.rows;
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const history = historyRes.rows.find((h: any) => h.chatId === this.chatId);
              if (history) this.historyId = history.id;
            }
          } catch (e) { console.warn('Failed to fetch chat history', e); }
        }
      } catch (e) { console.error('Failed to save chat history', e); }

      return response;
    } finally {
      this._isSending = false;
    }
  }

  // ──────────────────── 图片处理 ────────────────────

  /**
   * 将多模态 content 数组中的内联 base64 图片上传到临时 CDN，
   * 并将 data-URI 替换为远程 URL。
   * @private
   */
  async _uploadInlineImages(contentArray: import('../utils/ImageUtils').ContentItem[]): Promise<import('../utils/ImageUtils').ContentItem[]> {
    if (!Array.isArray(contentArray)) return contentArray;
    return Promise.all(
      contentArray.map(async (item) => {
        if (item.type !== 'image_url') return item;
        const url = item.image_url?.url;
        if (!url || !url.startsWith('data:')) return item;
        try {
          const cdnUrl = await uploadTempVisionImage(url, { sdk: this.aiChat.sdk });
          console.log('[ChatSession] Uploaded inline image to CDN:', cdnUrl);
          return { ...item, image_url: { ...item.image_url, url: cdnUrl } };
        } catch (e) {
          console.warn('[ChatSession] Failed to upload inline image, keeping data-URI:', e);
          return item;
        }
      })
    );
  }

  // ──────────────────── 消息修剪 ────────────────────

  /**
   * 按 historyLength 修剪旧消息轮次。
   * 保留所有前置 system 消息 + 最后 `historyLength` 轮对话。
   * @private
   */
  _evictMessages(): void {
    const limit = this.historyLength;
    if (!limit || limit <= 0) return;

    let systemEnd = 0;
    while (systemEnd < this.messages.length && this.messages[systemEnd]!.role === 'system') systemEnd++;

    const roundStarts: number[] = [];
    for (let i = systemEnd; i < this.messages.length; i++) {
      if (this.messages[i]!.role === 'user') roundStarts.push(i);
    }

    if (roundStarts.length <= limit) return;
    const keepFrom = roundStarts[roundStarts.length - limit]!;
    const evicted = keepFrom - systemEnd;
    this.messages = [...this.messages.slice(0, systemEnd), ...this.messages.slice(keepFrom)];
    console.log(`[ChatSession] Evicted ${evicted} message(s), kept ${limit} round(s)`);
  }

  /**
   * 从历史中移除超出 maxCount 限制的旧图片，
   * 将被移除的 image_url 替换为 `(user_image)` 文本占位符。
   * @private
   */
  _evictExcessImages(maxCount: number): void {
    if (maxCount < 0) return;
    const positions: Array<{ msgIdx: number; partIdx: number }> = [];
    for (let i = 0; i < this.messages.length; i++) {
      const msg = this.messages[i]!;
      if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;
      for (let j = 0; j < (msg.content as unknown[]).length; j++) {
        if ((msg.content as Array<Record<string, unknown>>)[j]?.['type'] === 'image_url') {
          positions.push({ msgIdx: i, partIdx: j });
        }
      }
    }
    if (positions.length <= maxCount) return;
    const toRemove = positions.slice(0, positions.length - maxCount);
    let removedCount = 0;
    for (const { msgIdx, partIdx } of toRemove) {
      const msg = this.messages[msgIdx]!;
      (msg.content as Array<Record<string, unknown>>)[partIdx] = { type: 'text', text: '(user_image)' };
      removedCount++;
    }
    if (removedCount > 0) console.log(`[ChatSession] Evicted ${removedCount} image(s) from history, kept ${maxCount}`);
  }

  // ──────────────────── 历史管理 ────────────────────

  /** 清空对话历史（仅清空 messages 数组）。 */
  clear(): void { this.messages = []; }

  /** 获取当前对话历史的副本。 */
  getHistory(): ChatMessage[] { return [...this.messages]; }

  // ──────────────────── restartAgent ────────────────────

  /**
   * 重启 agent 会话（可选加载配置文件）。
   *
   * 行为：
   * - 无 promptFile：恢复所有设置到构造时的默认值
   * - 纯 Markdown（只有 system_prompt）：仅更换系统提示，其他设置保持默认
   * - 完整配置：临时覆盖设置；下次无 promptFile 的重启会恢复全部默认值
   *
   * @param promptFile - 配置文件 URL 或路径（.json / .yml / .yaml / .md）
   * @param tools      - 可选工具分类覆盖（空表示继承默认值）
   * @param _options   - 高级选项（预留）
   * @returns `{ configSource }`
   */
  async restartAgent(promptFile?: string, tools?: string[], _options?: unknown): Promise<{ configSource: string }> {
    console.log(`[ChatSession] restartAgent session='${this.name ?? 'root'}' promptFile=${promptFile ?? '(none)'}`);
    const normalizedTools = Array.isArray(tools) ? tools.filter((t) => typeof t === 'string' && t.trim()) : [];

    const cleanupFn = (this as Record<string, unknown>)['_cleanupChildSessions'] as (() => void) | undefined;
    cleanupFn?.call(this);

    // 恢复默认设置
    const defaults = this._defaultSettings;
    this.model = defaults.model ?? 'keepwork-flash';
    this.historyLength = defaults.historyLength ?? 0;
    if (defaults.workspace !== undefined) this.setWorkspace(defaults.workspace);
    if (defaults.mountFolder !== undefined) this.setMountFolder(defaults.mountFolder);
    if (this.sandbox && defaults.enabledCategories) {
      (this.sandbox as unknown as { setEnabledCategories?: (c: string[]) => void }).setEnabledCategories?.(defaults.enabledCategories);
    }

    // 加载配置文件
    let loadedConfig: Record<string, unknown> | null = null;
    const hasPromptFile = !!(promptFile && typeof promptFile === 'string' && promptFile.trim());
    if (hasPromptFile) {
      try {
        const AgentConfig = (await import('../core/AgentConfig')).default as unknown as { fetch: (url: string) => Promise<Record<string, unknown>> };
        loadedConfig = await AgentConfig.fetch(promptFile!.trim());
      } catch (e) {
        console.warn(`[ChatSession] restartAgent failed to load '${promptFile}': ${(e as Error).message}`);
      }
    }

    const systemPrompt = loadedConfig
      ? ((loadedConfig['system_prompt'] ?? loadedConfig['systemPrompt'] ?? defaults.systemPrompt) as string | null)
      : defaults.systemPrompt;

    if (hasPromptFile && loadedConfig) {
      this._savedMessages = this.messages.filter((m) => m.role !== 'system');
      console.log(`[ChatSession] restartAgent: saved ${this._savedMessages.length} history messages`);
    } else if (!hasPromptFile && this._savedMessages) {
      console.log(`[ChatSession] restartAgent: keeping ${this._savedMessages.length} saved history messages for summarizer`);
    }

    this.messages = [];
    if (systemPrompt) this.messages.push({ role: 'system', content: systemPrompt });

    if (!hasPromptFile && this._savedMessages) this._savedMessages = null;

    // 应用临时覆盖
    if (loadedConfig) {
      if (loadedConfig['model']) this.model = loadedConfig['model'] as string;
      if (loadedConfig['historyLength'] !== undefined) this.historyLength = loadedConfig['historyLength'] as number;
      if (loadedConfig['workspace']) this.setWorkspace(loadedConfig['workspace'] as string);
      if (loadedConfig['mountFolder']) this.setMountFolder(loadedConfig['mountFolder']);
      if (loadedConfig['tools'] && this.sandbox) {
        const cats = loadedConfig['tools'] as Record<string, { enabled?: boolean }>;
        const enabledCategories = Object.keys(cats).filter((k) => cats[k]?.enabled !== false);
        if (enabledCategories.length > 0) {
          (this.sandbox as unknown as { setEnabledCategories?: (c: string[]) => void }).setEnabledCategories?.(enabledCategories);
        }
      }
    }

    if (this.sandbox && normalizedTools.length > 0) {
      (this.sandbox as unknown as { setEnabledCategories?: (c: string[]) => void }).setEnabledCategories?.(normalizedTools);
    }

    this._pendingContexts = [];
    this._restartedWithPromptFile = hasPromptFile && !!loadedConfig;

    if (this.sandbox) {
      (this.sandbox as unknown as { _activePromptFile?: string | null })._activePromptFile = promptFile ?? null;
      (this.sandbox as unknown as { _templateSourceFile?: string | null })._templateSourceFile = promptFile ?? null;
    }

    return { configSource: loadedConfig ? (promptFile ?? 'unknown') : 'default' };
  }

  // ChildSessionHost 必须实现的方法占位（由 mixin 注入）
  _triggerImmediateCallback(): Promise<void> {
    return Promise.resolve();
  }
}

// ──────────────────── 挂载到 AIChat / 注入 ChildSessionMixin ────────────────────

/**
 * 安装 ChatSession 相关的全部 prototype 注册：
 * 1. 将 childSessionMethods 混入 ChatSession.prototype
 * 2. 覆盖 ChatSession.prototype._triggerImmediateCallback
 * 3. 将 AIChat.prototype.createSession 指向 ChatSession 工厂
 *
 * 注意：必须用「导出函数 + 在聚合入口实际调用」的方式注册，而非模块顶层裸语句
 * （如 `Object.assign(ChatSession.prototype, ...)` / `AIChat.prototype.createSession = ...`）。
 * 后者是对「跨模块导入/被聚合 re-export 的类」的无返回值顶层副作用语句，Rollup
 * tree-shaking 会因其无外部可观测副作用而删除，导致 createSession 退回 AIChat.core.ts
 * 的抛错占位符（createSession not yet initialized）、子 agent 方法缺失。
 * 把它们集中到本函数并由 AIChat.ts 引用调用，可被 Rollup 当作有副作用的调用保留。
 */
export function installAIChatSessionFactory(): void {
  // 1. ChildSessionMixin 方法注入
  Object.assign(ChatSession.prototype, childSessionMethods);

  // 2. ChatSession 的立即回调实现：等待当前 send() 完成后，调用 send(null)
  //    将子 agent 结果注入对话。
  Object.assign(ChatSession.prototype, {
    async _triggerImmediateCallback(this: ChatSession): Promise<void> {
      console.log(
        `[ChatSession] _triggerImmediateCallback session='${this.name ?? 'root'}' ` +
        `pendingChildResults=${this._pendingChildResults.length} isSending=${this._isSending}`
      );
      if (this._isSending) {
        await new Promise<void>((resolve) => {
          const check = (): void => {
            if (!this._isSending) resolve();
            else setTimeout(check, 50);
          };
          setTimeout(check, 50);
        });
      }
      if (this._pendingChildResults.length === 0) return;
      console.log('[ChatSession] Immediate callback: sending child results to parent');
      try {
        await this.send(null, this._lastSendOptions as ChatOptions);
      } catch (e) {
        console.error('[ChatSession] Immediate callback send failed:', e);
      }
    },
  });

  // 3. createSession 工厂挂载
  Object.assign(AIChat.prototype, {
    createSession(this: AIChat, options: ChatSessionOptions = {}): ChatSession {
      return new ChatSession(this, options);
    },
  });
}

// 模块求值时立即执行（副作用注册）。
// 注意：仅靠这里的模块顶层调用不够 —— 当聚合入口对本模块只做「纯副作用 import」
// （import './AIChat.session'）或仅 re-export 类型/类时，Rollup tree-shaking 会判定
// 该顶层调用语句无外部可观测副作用而删除它，导致 AIChat.prototype.createSession 退回
// AIChat.core.ts 的抛错占位符。因此 AIChat.ts 必须 import 并实际调用本函数（见该文件），
// 让 Rollup 把它当作被引用的有副作用调用予以保留。
installAIChatSessionFactory();

export { ChatSession };
export default ChatSession;
