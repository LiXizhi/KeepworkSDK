/**
 * SummarizeTool.ts — 对话历史摘要工具（TypeScript 完整实现）
 *
 * 提供两个类：
 * - SummarizeTool：CopilotTools 工具执行类（summarize_conversation / get_history_messages）
 * - SummarizeAgent：专用摘要 agent 管理类，含静默计时器和自动触发阈值检查
 */

import AIChat from '../ai-chat/AIChat';
import SDKLogger from '../utils/SDKLogger';

const console = SDKLogger.createModuleConsole('SummarizeTool');

// ──────────────────── 公共类型 ────────────────────

/** OpenAI Function Calling 工具定义 */
export interface ToolDefinition {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

/** 聊天消息（支持 ChatSession messages 和 RTCChatSession _history 两种来源） */
export interface SummarizeChatMessage {
  role: string;
  content?: unknown;
  text?: string;
  tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
  tool_call_id?: string;
  _contextOnly?: boolean;
  _ts?: number;
}

/** filterSessionMessages 的过滤条件 */
export interface MessageFilters {
  role?: string;
  keyword?: string;
  excludeSystem?: boolean;
  excludeToolCalls?: boolean;
}

/** summarize() 返回值 */
export interface SummarizeResult {
  summary: string;
  removedCount: number;
  remainingCount: number;
  status?: 'pending' | 'merged';
  mode?: string;
  summarizeBeginTime?: number;
}

/** summarize() 调用选项 */
export interface SummarizeOptions {
  keepRecentRounds?: number;
  prompt?: string;
  model?: string;
  enableTools?: string[];
  mode?: 'replace' | 'append';
  async?: boolean;
}

/** ChatSession / RTCChatSession 最小接口（避免循环引用） */
export interface SummarizeSessionRef {
  messages?: SummarizeChatMessage[];
  _history?: Array<{ role: string; text?: string; content?: string; roundId?: unknown }>;
  sdk?: { aiChat?: unknown; copilotTools?: { resolveEnabledCategories?: (t: Record<string, unknown>) => string[] } };
  aiChat?: { sdk?: unknown };
  model?: string;
  workspace?: string;
  mountFolder?: unknown;
  sandbox?: {
    processTemplate?: (s: string) => Promise<string>;
    registerAPI?: (name: string, fn: (...args: unknown[]) => Promise<unknown>) => void;
  };
  _isSummarizing?: boolean;
  _pendingChildResults?: Array<unknown>;
  skipHistory?: boolean;
  chatId?: string;
  modId?: string;
  historyId?: string;
  [key: string]: unknown;
}

/** SummarizeAgent 构造参数 */
export interface SummarizeAgentParams {
  session: SummarizeSessionRef;
  sdk: unknown;
  getOptions: (opts?: Record<string, unknown>) => SummarizeAgentOptions;
  getRtcSession?: () => SummarizeSessionRef | null;
  onEvent?: (eventName: string, data: unknown) => void;
}

/** SummarizeAgent.getOptions 返回值 */
export interface SummarizeAgentOptions {
  enabled?: boolean;
  keepRecentRounds?: number;
  maxRounds?: number;
  maxTextLength?: number;
  silentTickInterval?: number;
  mode?: 'replace' | 'append';
  model?: string;
  enableTools?: string[];
  prompt?: string;
  async?: boolean;
}

// ──────────────────── SummarizeTool ────────────────────

/**
 * SummarizeTool — 对话摘要工具（供 CopilotTools 注册为 'summarize' 分类）。
 *
 * 向 LLM 暴露三个工具：
 * - `summarize_conversation`：压缩会话历史（replace / append 两种模式）
 * - `get_history_messages`：获取最近 N 条消息（支持角色/关键词过滤）
 * - `get_history_messages_count`：获取消息数量
 */
class SummarizeTool {
  static readonly definitions: ToolDefinition[] = [
    {
      type: 'function',
      function: {
        name: 'summarize_conversation',
        description:
          "Summarize the current conversation history to reduce context length. Older messages are compressed into a concise summary while recent messages are preserved. Call this when the conversation is getting long, when you notice context is being lost, or when you need to free up context space for complex tasks.",
        parameters: {
          type: 'object',
          properties: {
            reason: { type: 'string', description: 'Brief reason for triggering summarization (for logging).' },
            mode: {
              type: 'string',
              enum: ['replace', 'append'],
              description: "How to apply the summary. 'append' (default): insert summary as a normal tool result without removing old messages. 'replace': compress old messages into a summary, removing them from history.",
            },
            async: { type: 'boolean', description: 'If true, run summarization in background and return immediately.' },
          },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_history_messages',
        description: 'Retrieve recent conversation history messages from the current AI chat session.',
        parameters: {
          type: 'object',
          properties: {
            count: { type: 'integer', description: 'Maximum number of messages to return. Defaults to 50.' },
            filters: {
              type: 'object',
              description: 'Optional filters.',
              properties: {
                role: { type: 'string', description: 'Filter by role: user, assistant, system, or tool.' },
                keyword: { type: 'string', description: 'Filter messages containing this keyword (case-insensitive).' },
                excludeSystem: { type: 'boolean', description: 'If true, exclude system messages.' },
              },
            },
          },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_history_messages_count',
        description: 'Get the count of conversation history messages, optionally filtered.',
        parameters: {
          type: 'object',
          properties: {
            filters: {
              type: 'object',
              description: 'Optional filters.',
              properties: {
                role: { type: 'string' },
                keyword: { type: 'string' },
                excludeSystem: { type: 'boolean' },
              },
            },
          },
          required: [],
        },
      },
    },
  ];

  config: Record<string, unknown> = {};

  constructor() {
    this.config = {};
  }

  /** 更新运行时配置（由 CopilotTools.setToolConfig 调用）。 */
  setConfig(config: Record<string, unknown>): void {
    this.config = config ?? {};
  }

  // ──────────────────── 工具分发 ────────────────────

  /**
   * 执行摘要分类工具（CopilotTools 分发入口）。
   * @param name   - 工具名
   * @param args   - 工具参数
   * @param config - 运行时配置（含 `_session`）
   */
  async execute(
    name: string,
    args: Record<string, unknown>,
    config: Record<string, unknown> = {}
  ): Promise<string> {
    if (name === 'summarize_conversation') return this.executeSummarize(args, config);
    if (name === 'get_history_messages') return this.executeGetHistoryMessages(args, config);
    if (name === 'get_history_messages_count') return this.executeGetHistoryMessagesCount(args, config);
    return 'Unknown summarize tool';
  }

  // ──────────────────── 历史消息工具 ────────────────────

  /**
   * 过滤会话消息。
   * 同时支持 ChatSession（messages 数组）和 RTCChatSession（_history 数组）。
   *
   * @param session - 会话对象
   * @param filters - 可选过滤条件（role / keyword / excludeSystem / excludeToolCalls）
   */
  filterSessionMessages(session: SummarizeSessionRef, filters?: MessageFilters | null): SummarizeChatMessage[] {
    let messages: SummarizeChatMessage[];
    if (Array.isArray(session.messages)) {
      messages = session.messages;
    } else if (Array.isArray(session._history)) {
      messages = session._history.map((h) => ({
        role: h.role === 'peer' ? 'user' : h.role,
        content: h.text ?? h.content ?? '',
      }));
    } else {
      return [];
    }

    if (!filters) return messages;
    const f = filters as MessageFilters & { excludeToolCalls?: boolean };

    return messages.filter((msg) => {
      if (f.excludeSystem && msg.role === 'system') return false;
      if (f.excludeToolCalls) {
        if (msg.role === 'tool') return false;
        if (msg.role === 'assistant' && (msg.tool_calls?.length ?? 0) > 0 && !msg.content) return false;
      }
      if (f.role && msg.role !== f.role) return false;
      if (f.keyword) {
        const content = msg.content ?? msg.text ?? '';
        const text = typeof content === 'string' ? content : JSON.stringify(content);
        if (!text.toLowerCase().includes(f.keyword.toLowerCase())) return false;
      }
      return true;
    });
  }

  /**
   * 执行 get_history_messages 工具。
   * 返回 JSON 序列化的消息数组（默认过滤 system 和纯工具调用消息）。
   */
  executeGetHistoryMessages(args: Record<string, unknown>, config: Record<string, unknown> = {}): string {
    const session = config['_session'] as SummarizeSessionRef | undefined;
    if (!session) return JSON.stringify({ error: 'No active session' });
    const count = Number(args['count']) || 50;
    const filters: MessageFilters & { excludeToolCalls?: boolean } = {
      excludeSystem: true,
      excludeToolCalls: true,
      ...((args['filters'] as Record<string, unknown>) ?? {}),
    };
    const filtered = this.filterSessionMessages(session, filters);
    const result = filtered.slice(-count);
    console.log(`[SummarizeTool] get_history_messages: ${result.length}/${filtered.length} messages (count=${count})`);
    return JSON.stringify(
      result.map((msg) => ({
        role: msg.role,
        content: msg.content ?? msg.text ?? '',
        ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}),
        ...(msg.tool_call_id ? { tool_call_id: msg.tool_call_id } : {}),
      }))
    );
  }

  /**
   * 执行 get_history_messages_count 工具。
   * 返回 `{ count: number, total: number }` 的 JSON 字符串。
   */
  executeGetHistoryMessagesCount(args: Record<string, unknown>, config: Record<string, unknown> = {}): string {
    const session = config['_session'] as SummarizeSessionRef | undefined;
    if (!session) return JSON.stringify({ error: 'No active session' });
    const filters = (args['filters'] as MessageFilters | null) ?? null;
    const filtered = this.filterSessionMessages(session, filters);
    const total = Array.isArray(session.messages)
      ? session.messages.length
      : Array.isArray(session._history)
      ? session._history.length
      : 0;
    console.log(`[SummarizeTool] get_history_messages_count: ${filtered.length}/${total}`);
    return JSON.stringify({ count: filtered.length, total });
  }

  /**
   * 执行 summarize_conversation 工具（CopilotTools 分发入口）。
   * 通过 SummarizeAgent 创建临时摘要会话，支持 replace / append / async 三种模式。
   */
  async executeSummarize(args: Record<string, unknown>, config: Record<string, unknown> = {}): Promise<string> {
    const session = config['_session'] as SummarizeSessionRef | undefined;
    if (!session) return 'Failed: No active session with summarization support';
    const result = await this.summarize(session, {
      keepRecentRounds: (config['keepRecentRounds'] as number) || 3,
      prompt: config['summarizationPrompt'] as string | undefined,
      model: config['summarizationModel'] as string | undefined,
      enableTools: config['summarizationEnableTools'] as string[] | undefined,
      mode: (args['mode'] as 'replace' | 'append') || 'append',
      async: args['async'] === true,
    });
    if (result.status === 'pending') return 'Summarization started in background. Results will be available in the next message.';
    if (result.status === 'merged') return 'Summarization already in progress. Results will be available in the next message.';
    if (result.summary) {
      if (result.removedCount > 0) {
        return `Conversation summarized: ${result.removedCount} messages compressed into summary. ${result.remainingCount} messages remaining.\n\nSummary:\n${result.summary}`;
      }
      return `Conversation summary:\n${result.summary}`;
    }
    return 'No summarization needed — conversation is short enough.';
  }

  // ──────────────────── 核心摘要 ────────────────────

  /**
   * 对指定会话的对话历史进行摘要压缩。
   *
   * 创建一个临时 SummarizeAgent，其系统 prompt 通过
   * `${await copilot.get_history_messages()}` 注入完整对话历史。
   *
   * @param session - 要摘要的会话（ChatSession 或 RTCChatSession）
   * @param options - 摘要选项（保留轮数 / 自定义 prompt / 模型 / 模式 / 异步等）
   */
  async summarize(session: SummarizeSessionRef, options: SummarizeOptions = {}): Promise<SummarizeResult> {
    const mode = options.mode ?? 'replace';
    const isAsync = options.async === true;
    const messages = SummarizeTool.getMessages(session);
    const messageBased = SummarizeTool.isMessageBased(session);

    // 异步模式：立即返回，后台执行
    if (isAsync) {
      if (session._isSummarizing) {
        console.log('[SummarizeTool] Async summarization already running, merging');
        return { summary: '', removedCount: 0, remainingCount: messages.length, status: 'merged' };
      }
      session._isSummarizing = true;
      const asyncOptions = { ...options, async: false };
      void Promise.resolve().then(() => this._runAsyncSummarize(session, asyncOptions)).catch(() => { /* 静默 */ });
      return { summary: '', removedCount: 0, remainingCount: messages.length, status: 'pending' };
    }

    const sdk = (session.sdk ?? (session.aiChat as { sdk?: unknown } | undefined)?.sdk) as {
      aiChat?: { createSession?: (...args: unknown[]) => SummarizeSessionRef; updateChatHistory?: (...args: unknown[]) => Promise<void> };
      copilotTools?: { resolveEnabledCategories?: (t: Record<string, unknown>) => string[] };
      token?: string | null;
    } | undefined;

    if (!sdk?.aiChat) {
      console.error('[SummarizeTool] No SDK instance available on session');
      return { summary: '', removedCount: 0, remainingCount: messages.length };
    }

    const keepRecentRounds = Number(options.keepRecentRounds) || 3;
    const summaryModel = options.model ?? (session.model as string | undefined) ?? 'keepwork-flash';
    const enableTools = options.enableTools;

    const defaultPrompt = [
      '你是一个对话摘要助手。',
      '',
      '对话历史消息:',
      '${await copilot.get_history_messages()}',
      '',
      '请将以上对话历史压缩为简洁的摘要。保留关键信息、重要决策、用户偏好和未完成的任务。摘要应该让后续对话能够无缝继续。用中文回复。',
    ].join('\n');

    const agentConfig: Record<string, unknown> = {
      system_prompt: options.prompt ?? defaultPrompt,
      llm_model: summaryModel,
      stream: false,
      workspace: session.workspace,
      mountFolder: session.mountFolder,
    };
    if (enableTools) {
      const tools: Record<string, unknown> = {};
      for (const cat of enableTools) tools[cat] = { enabled: true };
      agentConfig['tools'] = tools;
    }

    const agentSession = messageBased
      ? session
      : Object.create(session, { messages: { value: messages, writable: true, configurable: true } }) as SummarizeSessionRef;

    const agent = new SummarizeAgent({
      session: agentSession,
      sdk,
      getOptions: () => ({ enabled: true, keepRecentRounds, mode, model: summaryModel, enableTools }),
    });

    try {
      await agent.loadConfig(agentConfig, { skipCopilotToolsOverride: true });
      const result = await agent.run({ mode, keepRecentRounds });

      // RTCChatSession replace 模式：将压缩后的 messages 同步回 _history
      if (!messageBased && mode === 'replace' && result.removedCount > 0) {
        const newHistory: Array<{ role: string; text: string; roundId: null }> = [];
        for (const msg of (agentSession.messages ?? [])) {
          const text = typeof msg.content === 'string' ? msg.content : '';
          if (!text) continue;
          newHistory.push({ role: msg.role, text, roundId: null });
        }
        session._history = newHistory as unknown as typeof session._history;
      }

      return result;
    } catch (e) {
      console.error('[SummarizeTool] Summarization failed:', e);
      return { summary: '', removedCount: 0, remainingCount: messages.length };
    } finally {
      agent.destroy();
    }
  }

  /** @private 后台异步执行摘要，结果推入 _pendingChildResults。 */
  private async _runAsyncSummarize(session: SummarizeSessionRef, options: SummarizeOptions): Promise<void> {
    try {
      const result = await this.summarize(session, options);
      if (result.summary) {
        const taskId = (AIChat as unknown as { generateUUID?: () => string }).generateUUID?.() ?? crypto.randomUUID();
        session._pendingChildResults?.push({
          taskId,
          agentName: '__summarizer__',
          taskSummary: 'Conversation summarization',
          result: result.summary,
        });
        console.log(`[SummarizeTool] Async summary queued as pending result (taskId=${taskId})`);
      }
    } catch (e) {
      console.error('[SummarizeTool] Async summarization failed:', e);
    } finally {
      session._isSummarizing = false;
    }
  }

  // ──────────────────── 静态工具方法 ────────────────────

  /** 从会话获取 AIChat 实例（兼容 ChatSession 和 RTCChatSession）。 */
  static getAIChat(session: SummarizeSessionRef): unknown {
    return (session as Record<string, unknown>)['aiChat']
      ?? ((session.sdk as Record<string, unknown> | undefined)?.['aiChat'])
      ?? null;
  }

  /**
   * 获取规范化的消息数组（统一 ChatSession 和 RTCChatSession 格式）。
   * RTCChatSession 的 _history `{ role, text }` 条目转换为 `{ role, content }`。
   */
  static getMessages(session: SummarizeSessionRef): SummarizeChatMessage[] {
    if (Array.isArray(session.messages)) return session.messages;
    if (Array.isArray(session._history)) {
      return session._history.map((h) => ({
        role: h.role === 'peer' ? 'user' : h.role,
        content: h.text ?? h.content ?? '',
      }));
    }
    return [];
  }

  /** 检查会话是否为基于 messages 数组的 ChatSession（可直接修改）。 */
  static isMessageBased(session: SummarizeSessionRef): boolean {
    return Array.isArray(session.messages);
  }

  /**
   * 将消息数组序列化为人类可读的文本块（供摘要 LLM 消费）。
   * 工具结果和纯工具调用消息做特殊格式化。
   */
  static serializeMessages(messages: SummarizeChatMessage[]): string {
    return messages
      .map((msg) => {
        const content = msg.content ?? msg.text ?? '';
        if (msg.role === 'tool') {
          const text = typeof content === 'string' ? content.slice(0, 500) : JSON.stringify(content).slice(0, 500);
          return `[Tool Result (${msg.tool_call_id ?? 'unknown'})]: ${text}`;
        }
        if (msg.role === 'assistant' && (msg.tool_calls?.length ?? 0) > 0) {
          const calls = (msg.tool_calls ?? []).map(
            (tc) => `${tc.function?.name ?? 'unknown'}(${typeof tc.function?.arguments === 'string' ? tc.function.arguments.slice(0, 200) : '...'})`
          ).join(', ');
          return `Assistant [tool_calls: ${calls}]${content ? ': ' + content : ''}`;
        }
        const textContent = typeof content === 'string' ? content : JSON.stringify(content);
        return `${msg.role === 'user' ? 'User' : 'Assistant'}: ${textContent}`;
      })
      .join('\n');
  }
}

// ──────────────────── SummarizeAgent ────────────────────

/**
 * SummarizeAgent — 专用摘要 agent 管理类。
 *
 * 管理一个独立的 agent ChatSession，提供：
 * - 静默计时器（silentTickInterval）：闲置一段时间后自动触发摘要
 * - 自动触发阈值检查（maxRounds / maxTextLength）：超过阈值时触发
 * - CopilotTools executor 覆盖：使摘要工具使用 agent 而非内置 SummarizeTool
 * - RTC 历史同步（syncHistoryToRTC）
 *
 * 通常由 DigitalHuman 创建：
 * ```ts
 * const agent = new SummarizeAgent({ session, sdk, getOptions: () => opts });
 * await agent.loadConfig(config);
 * agent.startTimer();
 * ```
 */
class SummarizeAgent {
  readonly session: SummarizeSessionRef;
  readonly sdk: unknown;

  private _getOptions: (opts?: Record<string, unknown>) => SummarizeAgentOptions;
  private _getRtcSession: () => SummarizeSessionRef | null;
  private _onEvent: (eventName: string, data: unknown) => void;
  private _tool: SummarizeTool;
  private _config: Record<string, unknown> | null = null;
  private _agentSession: SummarizeSessionRef | null = null;
  private _running = false;
  private _timer: ReturnType<typeof setInterval> | null = null;
  private _lastActivity = 0;
  private _tickSummarizing = false;
  private _autoTriggerSignature: string | null = null;
  private _pendingAutoCheck: { options: Record<string, unknown>; signature: string | null } | null = null;
  private _checkAndTriggerRunning = false;

  constructor({ session, sdk, getOptions, getRtcSession, onEvent }: SummarizeAgentParams) {
    this.session = session;
    this.sdk = sdk;
    this._getOptions = getOptions;
    this._getRtcSession = getRtcSession ?? (() => null);
    this._onEvent = onEvent ?? (() => { /* noop */ });
    this._tool = new SummarizeTool();
  }

  /** 当前已加载的 agent 配置（未加载时为 null）。 */
  get config(): Record<string, unknown> | null { return this._config; }

  // ──────────────────── 生命周期 ────────────────────

  /**
   * 加载 agent 配置，创建专用摘要 ChatSession。
   *
   * @param config - 解析后的 agent 配置（model / system_prompt / tools 等）
   * @param opts   - skipCopilotToolsOverride：true 时跳过 CopilotTools executor 覆盖
   */
  async loadConfig(
    config: Record<string, unknown>,
    { skipCopilotToolsOverride = false } = {}
  ): Promise<Record<string, unknown>> {
    this._config = config;
    console.log('[SummarizeAgent] Config loaded:', Object.keys(config).join(', '));
    if (this.session) await this._createAgentSession();
    if (!skipCopilotToolsOverride) this._overrideCopilotToolsExecutor();
    return config;
  }

  /**
   * 启动静默计时器（间隔由 getOptions().silentTickInterval 控制，单位秒）。
   * 若已存在计时器则先停止再重新启动。
   */
  startTimer(): void {
    this.stopTimer();
    const opts = this._getOptions();
    const interval = opts.silentTickInterval;
    if (!opts.enabled || !interval || interval <= 0) return;
    this._lastActivity = Date.now();
    this._timer = setInterval(() => { void this._onTick(); }, interval * 1000);
    console.log(`[SummarizeAgent] Silent-tick timer started (${interval}s)`);
  }

  /** 停止静默计时器。 */
  stopTimer(): void {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    this._tickSummarizing = false;
  }

  /** 记录当前时刻为最近活动时间（重置闲置计时）。 */
  resetActivity(): void { this._lastActivity = Date.now(); }

  /**
   * 检查是否超过自动摘要阈值并触发摘要。
   * 优先通过已加载的 agent 会话执行，否则回退到内置 SummarizeTool。
   *
   * @param options - 可选的运行时选项覆盖
   */
  async checkAndTrigger(options?: Record<string, unknown>): Promise<void> {
    const opts = this._getOptions(options);
    if (!opts.enabled) { this._autoTriggerSignature = null; this._pendingAutoCheck = null; return; }

    const metrics = this._collectConversationMetrics();
    if (!metrics) return;

    const { session, roundCount, totalTextLength } = metrics;
    if (roundCount < (opts.maxRounds ?? 0) && totalTextLength < (opts.maxTextLength ?? 0)) {
      this._autoTriggerSignature = null;
      return;
    }

    const signature = this._getAutoTriggerSignature(metrics, opts);
    if (signature && this._autoTriggerSignature === signature) return;

    if (this._checkAndTriggerRunning || this._running || this._tickSummarizing || session._isSummarizing) {
      this._queuePendingAutoCheck(options ?? {}, signature);
      return;
    }

    this._checkAndTriggerRunning = true;
    this._autoTriggerSignature = signature;
    console.log(`[SummarizeAgent] Auto-summarization triggered: ${roundCount} rounds, ${totalTextLength} chars`);

    try {
      if (this._config) {
        try {
          const result = await this.run();
          if (result.removedCount > 0 || result.summary) {
            this._onEvent('summarized', { summary: result.summary, removedCount: result.removedCount, remainingCount: result.remainingCount, trigger: 'auto', mode: result.mode, summarizeBeginTime: result.summarizeBeginTime });
          }
        } catch (e) {
          console.error('[SummarizeAgent] Auto-summarization (agent) failed:', e);
        }
        return;
      }
      try {
        const result = await this._tool.summarize(session, { keepRecentRounds: opts.keepRecentRounds, prompt: opts.prompt, model: opts.model, enableTools: opts.enableTools, mode: opts.mode, async: opts.async });
        if (result.status === 'pending' || result.status === 'merged') { this._onEvent('summarized', { trigger: 'auto', status: result.status }); return; }
        if (result.removedCount > 0 || result.summary) {
          this._onEvent('summarized', { summary: result.summary, removedCount: result.removedCount, remainingCount: result.remainingCount, trigger: 'auto', mode: result.mode, summarizeBeginTime: result.summarizeBeginTime });
        }
      } catch (e) {
        console.error('[SummarizeAgent] Auto-summarization fallback failed:', e);
      }
    } finally {
      this._checkAndTriggerRunning = false;
      if (this._pendingAutoCheck) this._drainPendingAutoCheck();
    }
  }

  /**
   * 运行一次专用 agent 摘要。
   * 若 agent 会话不存在或尚未加载配置则立即返回空结果。
   *
   * @param options - 可选覆盖（mode / keepRecentRounds）
   */
  async run(options: { mode?: string; keepRecentRounds?: number } = {}): Promise<SummarizeResult> {
    if (this._running) {
      console.log('[SummarizeAgent] Already running, skipping');
      return { summary: '', removedCount: 0, remainingCount: this.session?.messages?.length ?? 0 };
    }

    const session = this.session;
    if (!session?.messages) return { summary: '', removedCount: 0, remainingCount: 0 };
    if (!this._config) return { summary: '', removedCount: 0, remainingCount: session.messages.length };

    if (!this._agentSession) await this._createAgentSession();
    if (!this._agentSession) {
      console.error('[SummarizeAgent] Failed to create agent session');
      return { summary: '', removedCount: 0, remainingCount: session.messages.length };
    }

    const opts = this._getOptions();
    const mode = options.mode ?? opts.mode ?? 'append';
    const keepRecentRounds = options.keepRecentRounds ?? opts.keepRecentRounds;
    const summarizeBeginTime = Date.now();

    const conversationMessages = session.messages.filter((m) => m.role !== 'system');
    if (conversationMessages.length < 2) {
      console.log('[SummarizeAgent] Not enough messages to summarize');
      return { summary: '', removedCount: 0, remainingCount: session.messages.length };
    }

    this._running = true;
    console.log(`[SummarizeAgent] Running: ${conversationMessages.length} messages, mode=${mode}`);

    try {
      const agentSession = this._agentSession;
      const agentConfig = this._config;
      const rawPrompt = (agentConfig['system_prompt'] ?? agentConfig['content'] ?? '') as string;
      let systemPrompt: string;
      try {
        systemPrompt = agentSession.sandbox?.processTemplate
          ? await agentSession.sandbox.processTemplate(rawPrompt)
          : rawPrompt;
      } catch (e) {
        console.warn('[SummarizeAgent] Prompt template failed, using raw:', e);
        systemPrompt = rawPrompt;
      }

      const serialized = SummarizeTool.serializeMessages(conversationMessages);
      let userMessage: string;
      if (systemPrompt) {
        agentSession.messages = [{ role: 'system', content: systemPrompt }];
        userMessage = '请根据以上内容执行任务。';
      } else {
        agentSession.messages = [];
        userMessage = ['你是一个对话摘要助手。', '', '对话历史消息:', serialized, '', '请将以上对话历史压缩为简洁的摘要。保留关键信息、重要决策、用户偏好和未完成的任务。摘要应该让后续对话能够无缝继续。用中文回复。'].join('\n');
      }

      const llmModel = agentConfig['llm_model'];
      const model = ((typeof llmModel === 'object' ? (llmModel as Record<string, unknown>)['model'] : llmModel) ?? 'keepwork-flash') as string;
      const sdk = this.sdk as { copilotTools?: { resolveEnabledCategories?: (t: Record<string, unknown>) => string[] } };
      let enableTools: string[] | undefined;
      if (sdk.copilotTools?.resolveEnabledCategories && agentConfig['tools']) {
        enableTools = sdk.copilotTools.resolveEnabledCategories(agentConfig['tools'] as Record<string, unknown>);
      }
      const stream = agentConfig['stream'] !== undefined ? agentConfig['stream'] : true;

      const agentSend = (agentSession as unknown as { send?: (msg: string, opts: unknown) => Promise<unknown> }).send;
      if (agentSend) {
        await agentSend.call(agentSession, userMessage, { enableTools, model, stream, reasoning: false, maxIterations: 10 });
      }

      const lastAssistant = [...(agentSession.messages ?? [])].reverse().find(
        (m) => m.role === 'assistant' && m.content
      );
      const summaryText = (lastAssistant?.content as string | undefined) ?? '';
      if (!summaryText) {
        console.warn('[SummarizeAgent] Empty summary returned');
        return { summary: '', removedCount: 0, remainingCount: session.messages.length };
      }

      const cleanedMessages = session.messages.filter(
        (msg) => msg.role === 'system' || (msg._ts != null && msg._ts >= summarizeBeginTime)
      );
      const removedCount = session.messages.length - cleanedMessages.length;

      try {
        const aiChat = SummarizeTool.getAIChat(session) as { updateChatHistory?: (...args: unknown[]) => Promise<void> } | null;
        const sdk2 = this.sdk as { token?: string | null };
        if (!session.skipHistory && session.chatId && session.modId && session.historyId && sdk2?.token?.trim()) {
          await aiChat?.updateChatHistory?.(session.historyId, { id: session.historyId, chatId: session.chatId, modId: session.modId, model: session.model, messages: cleanedMessages });
        }
      } catch (e) {
        console.warn('[SummarizeAgent] Failed to persist summarized history:', e);
      }

      if (mode === 'replace') {
        session.messages = cleanedMessages;
        this.syncHistoryToRTC();
      }

      const remainingCount = session.messages.length;
      console.log(`[SummarizeAgent] ${mode} mode: removed ${removedCount} from history, session ${mode === 'replace' ? 'updated' : 'unchanged'}`);
      return { summary: summaryText, removedCount, remainingCount, mode, summarizeBeginTime };
    } catch (e) {
      console.error('[SummarizeAgent] Failed:', e);
      return { summary: '', removedCount: 0, remainingCount: session.messages.length };
    } finally {
      this._running = false;
    }
  }

  /** 将 ChatSession messages 同步回 RTCChatSession 的 _history。 */
  syncHistoryToRTC(): void {
    const vcSession = this._getRtcSession();
    if (!vcSession?._history) return;
    const messages = this.session?.messages;
    if (!messages) return;
    const newHistory: Array<{ role: string; text: string; roundId: null }> = [];
    for (const msg of messages) {
      if (msg.role === 'tool') continue;
      if (msg.role === 'assistant' && (msg.tool_calls?.length ?? 0) > 0 && !msg.content) continue;
      const text = typeof msg.content === 'string' ? msg.content : '';
      if (!text) continue;
      newHistory.push({ role: msg.role, text, roundId: null });
    }
    vcSession._history = newHistory as unknown as typeof vcSession._history;
    console.log(`[SummarizeAgent] Synced history to RTC (${newHistory.length} entries)`);
  }

  /** 完全销毁 agent：停止计时器，清除所有状态。 */
  destroy(): void {
    this.stopTimer();
    this._pendingAutoCheck = null;
    this._autoTriggerSignature = null;
    this._checkAndTriggerRunning = false;
    this._config = null;
    this._agentSession = null;
    this._running = false;
  }

  // ──────────────────── 私有方法 ────────────────────

  /** @private 采集当前会话对话指标（用于自动触发阈值判断）。 */
  private _collectConversationMetrics(): { session: SummarizeSessionRef; roundCount: number; totalTextLength: number } | null {
    const session = this.session;
    if (!session?.messages) return null;
    let roundCount = 0, totalTextLength = 0;
    for (const msg of session.messages) {
      if (msg.role === 'system' || msg._contextOnly) continue;
      if (msg.role === 'user') roundCount++;
      if (typeof msg.content === 'string') totalTextLength += msg.content.length;
    }
    return { session, roundCount, totalTextLength };
  }

  /** @private 生成触发签名（轮次桶 + 文本长度桶，用于去重判断）。 */
  private _getAutoTriggerSignature(
    metrics: { roundCount: number; totalTextLength: number },
    opts: SummarizeAgentOptions
  ): string | null {
    const roundBucket = Math.floor(metrics.roundCount / Math.max(1, Number(opts.maxRounds) || 1));
    const textBucket = Math.floor(metrics.totalTextLength / Math.max(1, Number(opts.maxTextLength) || 1));
    return `${roundBucket}:${textBucket}`;
  }

  /** @private 排队一次待处理的自动摘要检查（当前正在运行时使用）。 */
  private _queuePendingAutoCheck(options: Record<string, unknown>, signature: string | null): void {
    this._pendingAutoCheck = { options: { ...options }, signature };
  }

  /** @private 当前运行结束后处理排队的自动触发检查。 */
  private _drainPendingAutoCheck(): void {
    if (!this._pendingAutoCheck) return;
    const pending = this._pendingAutoCheck;
    this._pendingAutoCheck = null;
    void this.checkAndTrigger(pending.options);
  }

  /** @private 定时器 tick 处理器（闲置超时后触发摘要）。 */
  private async _onTick(): Promise<void> {
    if (this._tickSummarizing) return;
    const opts = this._getOptions();
    const intervalMs = (opts.silentTickInterval ?? 0) * 1000;
    if (!intervalMs || Date.now() - this._lastActivity < intervalMs) return;
    const metrics = this._collectConversationMetrics();
    if (!metrics) return;
    const { session, roundCount, totalTextLength } = metrics;
    if (roundCount < (opts.maxRounds ?? 0) && totalTextLength < (opts.maxTextLength ?? 0)) { this._autoTriggerSignature = null; return; }
    const signature = this._getAutoTriggerSignature(metrics, opts);
    if (signature && this._autoTriggerSignature === signature) return;
    if (this._running || this._checkAndTriggerRunning || session._isSummarizing) { this._queuePendingAutoCheck({}, signature); return; }
    this._tickSummarizing = true;
    this._autoTriggerSignature = signature;
    console.log(`[SummarizeAgent] Silent-tick triggered: ${roundCount} rounds, ${totalTextLength} chars`);
    try {
      let result: SummarizeResult;
      if (this._config) {
        result = await this.run();
      } else {
        result = await this._tool.summarize(session, { keepRecentRounds: opts.keepRecentRounds, prompt: opts.prompt, model: opts.model, enableTools: opts.enableTools, mode: opts.mode, async: false });
        if (result.removedCount > 0 && this._getRtcSession()?._history) this.syncHistoryToRTC();
      }
      if ((result?.removedCount ?? 0) > 0 || result?.summary) {
        this._onEvent('summarized', { summary: result.summary, removedCount: result.removedCount, remainingCount: result.remainingCount, trigger: 'silentTick', mode: result.mode, summarizeBeginTime: result.summarizeBeginTime });
      }
    } catch (e) {
      console.error('[SummarizeAgent] Silent-tick failed:', e);
    } finally {
      this._tickSummarizing = false;
      if (this._pendingAutoCheck) this._drainPendingAutoCheck();
    }
  }

  /** @private 创建专用摘要 agent ChatSession（共享父会话的 sandbox）。 */
  private async _createAgentSession(): Promise<SummarizeSessionRef | null> {
    const agentConfig = this._config;
    if (!agentConfig) return null;
    const sdk = this.sdk as {
      aiChat?: { createSession?: (opts: Record<string, unknown>) => SummarizeSessionRef };
      copilotTools?: { resolveEnabledCategories?: (t: Record<string, unknown>) => string[] };
    };
    if (!sdk?.aiChat?.createSession) return null;
    const llmModel = agentConfig['llm_model'];
    const model = ((typeof llmModel === 'object' ? (llmModel as Record<string, unknown>)['model'] : llmModel) ?? 'keepwork-flash') as string;
    const workspace = (agentConfig['workspace'] ?? this.session?.workspace) as string | undefined;
    const mountFolder = agentConfig['mountFolder'] ?? this.session?.mountFolder;
    let enableTools: string[] | undefined;
    if (sdk.copilotTools?.resolveEnabledCategories && agentConfig['tools']) {
      enableTools = sdk.copilotTools.resolveEnabledCategories(agentConfig['tools'] as Record<string, unknown>);
    }
    if (!enableTools || enableTools.length === 0) enableTools = ['fileOps'];
    this._agentSession = sdk.aiChat.createSession({ model, workspace, mountFolder, enableTools, skipHistory: true });
    if (this.session?.sandbox) (this._agentSession as Record<string, unknown>)['sandbox'] = this.session.sandbox;
    this._registerHistoryAPIsOnSandbox((this._agentSession as Record<string, unknown>)['sandbox'] as SummarizeSessionRef['sandbox']);
    console.log(`[SummarizeAgent] Agent session created (model=${model}, tools=${enableTools.join(',')})`);
    return this._agentSession;
  }

  /** @private 覆盖 CopilotTools 的 summarize 分类 executor，使其通过 agent 执行。 */
  private _overrideCopilotToolsExecutor(): void {
    const sdk = this.sdk as { copilotTools?: { _registry?: Record<string, { definitions: ToolDefinition[]; executor: (...args: unknown[]) => Promise<unknown> }>; registerToolCategory?: (name: string, entry: unknown) => void } };
    const copilotTools = sdk?.copilotTools;
    if (!copilotTools) return;
    const agent = this;
    const currentDefs = copilotTools._registry?.['summarize']?.definitions ?? [];
    const agentSummarizeDef: ToolDefinition = {
      type: 'function',
      function: {
        name: 'summarize_conversation',
        description: 'Summarize the current conversation history using the dedicated summarize agent.',
        parameters: { type: 'object', properties: { reason: { type: 'string', description: 'Brief reason for triggering summarization (for logging).' } }, required: [] },
      },
    };
    const otherDefs = currentDefs.filter((d) => d.function?.name !== 'summarize_conversation');
    const mergedDefs = [agentSummarizeDef, ...otherDefs];
    const originalExecutor = copilotTools._registry?.['summarize']?.executor;
    copilotTools.registerToolCategory?.('summarize', {
      definitions: mergedDefs,
      executor: async (fnName: unknown, fnArgs: unknown, config: unknown) => {
        if (fnName === 'summarize_conversation') {
          console.log(`[SummarizeAgent] summarize_conversation tool called: ${(fnArgs as Record<string, unknown>)?.['reason'] ?? '(no reason)'}`);
          try {
            const result = await agent.run();
            if (result.summary) {
              return result.removedCount > 0
                ? `Conversation summarized: ${result.removedCount} messages compressed. ${result.remainingCount} remaining.\n\nSummary:\n${result.summary}`
                : `Conversation summary:\n${result.summary}`;
            }
            return 'No summarization needed — conversation is short enough.';
          } catch (e) {
            console.error('[SummarizeAgent] summarize_conversation tool failed:', e);
            return `Summarization failed: ${(e as Error).message}`;
          }
        }
        if (originalExecutor) return originalExecutor(fnName, fnArgs, config);
        return 'Unknown summarize tool: ' + fnName;
      },
    });
    this._registerHistoryAPIsOnSandbox(this.session?.sandbox);
    console.log('[SummarizeAgent] Overrode CopilotTools summarize executor');
  }

  /**
   * @private 在 sandbox 上注册 get_history_messages / get_history_messages_count 自定义 API，
   * 使其可在 `${await copilot.get_history_messages()}` 模板表达式中调用。
   */
  private _registerHistoryAPIsOnSandbox(sandbox?: SummarizeSessionRef['sandbox']): void {
    if (!sandbox?.registerAPI) return;
    const agent = this;
    const tool = new SummarizeTool();
    sandbox.registerAPI('get_history_messages', async (countOrArgs: unknown, filters?: unknown) => {
      const args: Record<string, unknown> =
        countOrArgs && typeof countOrArgs === 'object' && !filters
          ? (countOrArgs as Record<string, unknown>)
          : { count: countOrArgs, filters };
      return tool.executeGetHistoryMessages(args, { _session: agent.session });
    });
    sandbox.registerAPI('get_history_messages_count', async (filtersOrArgs: unknown) => {
      const args: Record<string, unknown> =
        filtersOrArgs && typeof filtersOrArgs === 'object' && (filtersOrArgs as Record<string, unknown>)['filters']
          ? (filtersOrArgs as Record<string, unknown>)
          : { filters: filtersOrArgs };
      return tool.executeGetHistoryMessagesCount(args, { _session: agent.session });
    });
  }
}

export { SummarizeTool, SummarizeAgent };
export default SummarizeTool;