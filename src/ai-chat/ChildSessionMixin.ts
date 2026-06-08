/**
 * ChildSessionMixin.ts — 子 agent 会话共享逻辑
 *
 * 向任意 session 类（ChatSession、RTCChatSession 等）注入子 agent 状态和方法。
 * 子 session 始终是通过 `sdk.aiChat.createSession()` 创建的文本型 ChatSession。
 *
 * ## 使用方式
 * ```ts
 * // 构造函数中：
 * initChildSessionState(this, options);
 *
 * // prototype 上（只需一次）：
 * Object.assign(MySession.prototype, childSessionMethods);
 * ```
 *
 * ## 宿主类要求
 * - `this.sdk` — KeepworkSDK 实例（需有 `.aiChat.createSession()`）
 * - `this.model` — 默认模型名称
 * - `this.options` — 会话选项（可含 `.enableTools`）
 * - `this._triggerImmediateCallback()` — **必须**在宿主类中覆盖实现
 */

import SDKLogger from '../utils/SDKLogger';

const console = SDKLogger.createModuleConsole('ChildSessionMixin');

// ──────────────────── 类型定义 ────────────────────

/** 子任务对象 */
export interface ChildTask {
  id: string;
  task: string;
  description: string | null;
  tools: string[];
  maxIterations: number;
  systemPrompt: string | null;
  model: string | null;
  thinking: unknown;
  callbackMode: string;
  debounceSeconds: number;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  promise: Promise<unknown>;
}

/** 子 session 注册表条目 */
export interface ChildSessionEntry {
  session: ChildSessionHost;
  queue: ChildTask[];
  isRunning: boolean;
}

/** 待处理子 agent 结果 */
export interface PendingChildResult {
  agentName: string;
  taskId: string;
  taskSummary: string;
  result: unknown;
}

/** 子 agent 流式事件 */
export interface ChildStreamEvent {
  agentPath: string;
  agentName: string;
  taskId: string;
  type: 'message' | 'toolCall' | 'complete' | 'error' | string;
  content: unknown;
  fullResponse?: unknown;
}

/** 宿主 session 最小接口（避免循环引用） */
export interface ChildSessionHost {
  name?: string | null;
  parentSession?: ChildSessionHost | null;
  sdk?: unknown;
  aiChat?: { sdk?: unknown; createSession?: (opts: unknown) => ChildSessionHost };
  model?: string;
  workspace?: string | null;
  sandbox?: unknown;
  options?: { enableTools?: string[]; [key: string]: unknown };
  customTools?: unknown[];
  enabledToolCategories?: string[];
  messages?: Array<{ role: string; content: string }>;
  _history?: unknown[];
  // 以下由 initChildSessionState 注入
  _childSessions: Record<string, ChildSessionEntry>;
  _pendingChildResults: PendingChildResult[];
  _debounceTimers: ReturnType<typeof setTimeout>[];
  _isSending: boolean;
  _lastSendOptions: Record<string, unknown>;
  _maxChildSessions: number;
  _depth: number;
  _maxDepth: number;
  onChildStream: ((event: ChildStreamEvent) => void) | null;
  // 由宿主覆盖的方法
  _triggerImmediateCallback(): Promise<void>;
  // 由 mixin 注入的方法（供类型推断）
  send?: (msg: unknown, opts?: unknown) => Promise<unknown>;
  clear?: () => void;
}

/** initChildSessionState 选项 */
export interface ChildSessionInitOptions {
  name?: string;
  parentSession?: ChildSessionHost | null;
  onChildStream?: ((event: ChildStreamEvent) => void) | null;
  _depth?: number;
  _maxDepth?: number;
  [key: string]: unknown;
}

// ──────────────────── 工具函数 ────────────────────

/** 生成 UUID v4（浏览器原生优先）。 */
export function _generateUUID(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * 将值截断为可读摘要字符串，用于日志输出。
 * @param value     - 任意值
 * @param maxLength - 截断字符数（默认 180）
 */
export function _summarize(value: unknown, maxLength = 180): string {
  if (value === null || value === undefined) return String(value);
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}

// ──────────────────── 状态初始化 ────────────────────

/**
 * 在 session 实例上初始化子 agent 状态字段。
 * 在宿主类构造函数内调用。
 *
 * @param self    - session 实例（`this`）
 * @param options - 构造选项
 */
export function initChildSessionState(
  self: ChildSessionHost,
  options: ChildSessionInitOptions = {}
): void {
  self.name = options.name ?? (self.name ?? null);
  self.parentSession = options.parentSession ?? (self.parentSession ?? null);
  self._childSessions = {};
  self._pendingChildResults = [];
  self._debounceTimers = [];
  self._isSending = self._isSending ?? false;
  self._lastSendOptions = self._lastSendOptions ?? {};
  self._maxChildSessions = 2;
  self._depth = options._depth ?? 0;
  self._maxDepth = options._maxDepth ?? 3;
  self.onChildStream = options.onChildStream ?? (self.onChildStream ?? null);
}

// ──────────────────── Mixin 方法集 ────────────────────

/**
 * 要注入到宿主类 prototype 的子 agent 方法集。
 *
 * 宿主类最低要求：
 * - `this.sdk`（或 `this.aiChat`）——有 `.aiChat.createSession()`
 * - `this.model`——默认模型名
 * - `this.options`——选项（可含 `enableTools`）
 * - `this._triggerImmediateCallback()`——**必须在宿主类中覆盖**
 */
export const childSessionMethods: Partial<ChildSessionHost> & {
  createChildSession(name: string, options?: Record<string, unknown>): ChildSessionEntry;
  enqueueChildTask(name: string, task: string, tools?: string[], maxIterations?: number, systemPrompt?: string, extra?: Record<string, unknown>): Promise<unknown>;
  _processChildQueue(name: string): Promise<void>;
  _buildAgentPath(childName: string): string;
  _emitChildStream(event: ChildStreamEvent): void;
  _bubbleChildStream(event: ChildStreamEvent): void;
  _consumePendingChildResults(): PendingChildResult[];
  _handleChildCallback(mode: string, debounceSeconds?: number): void;
  _triggerImmediateCallback(): Promise<void>;
  _triggerDebounceCallback(seconds?: number): void;
  _cancelDebounceTimers(): void;
  getParentContext(messageCount?: number): { systemPrompt: string | null; recentMessages: unknown[]; model?: string; workspace?: string | null } | null;
  getChildSession(name: string): ChildSessionEntry | undefined;
  getChildSessionNames(): string[];
  _cleanupChildSessions(): void;
} = {

  /**
   * 创建命名子 session（agent 队友）。
   * 子 session 始终是文本型 ChatSession 实例。
   *
   * @param name    - 唯一 agent 名称
   * @param options - 额外的 session 选项（model / workspace 等）
   * @returns 子 session 注册表条目
   * @throws 超出最大子 session 数或嵌套深度时抛出
   */
  createChildSession(
    this: ChildSessionHost,
    name: string,
    options: Record<string, unknown> = {}
  ): ChildSessionEntry {
    if (this._childSessions[name]) return this._childSessions[name]!;

    if (Object.keys(this._childSessions).length >= this._maxChildSessions) {
      throw new Error(
        `Cannot create child session '${name}': maximum of ${this._maxChildSessions} child sessions reached`
      );
    }
    if (this._depth >= this._maxDepth) {
      throw new Error(
        `Cannot create child session '${name}': maximum nesting depth of ${this._maxDepth} reached`
      );
    }

    const aiChat = (this.sdk as { aiChat?: { createSession?: (opts: unknown) => ChildSessionHost } } | undefined)?.aiChat
      ?? this.aiChat;
    if (!aiChat?.createSession) {
      throw new Error('Cannot create child session: sdk.aiChat not available');
    }

    const childSession = aiChat.createSession({
      ...options,
      name,
      parentSession: this,
      model: (options['model'] as string | undefined) ?? this.model,
      workspace: options['workspace'] !== undefined ? options['workspace'] : this.workspace,
      _depth: this._depth + 1,
      _maxDepth: this._maxDepth,
        onChildStream: (event: ChildStreamEvent) => (this as unknown as Record<string, (e: ChildStreamEvent) => void>)['_bubbleChildStream']?.(event),
    });

    // 共享父 session 的 sandbox，使子 session 使用相同的工作空间作用域工具执行环境
    if (this.sandbox) (childSession as unknown as Record<string, unknown>)['sandbox'] = this.sandbox;

    const entry: ChildSessionEntry = { session: childSession, queue: [], isRunning: false };
    this._childSessions[name] = entry;
    console.log(`[ChildSessionMixin] Child agent '${name}' created`);
    return entry;
  },

  /**
   * 向命名子 agent 入队一个任务（子 agent 不存在时自动创建）。
   * 若子 agent 繁忙且队列中已有任务，新任务会与最后一个排队任务合并。
   *
   * @param name           - 子 agent 名称
   * @param task           - 任务描述 / prompt
   * @param tools          - 工具分类名称数组
   * @param maxIterations  - 最大工具调用迭代次数（默认 10）
   * @param systemPrompt   - 可选自定义系统提示
   * @param extra          - 额外选项 `{ model, thinking, callbackMode, debounceSeconds, description }`
   * @returns 任务完成时 resolve 的 Promise
   */
  enqueueChildTask(
    this: ChildSessionHost,
    name: string,
    task: string,
    tools?: string[],
    maxIterations = 10,
    systemPrompt?: string,
    extra: Record<string, unknown> = {}
  ): Promise<unknown> {
    const selfAny = this as unknown as Record<string, (...args: unknown[]) => unknown>;
    const entry = this._childSessions[name] ?? (selfAny['createChildSession'] as (n: string) => ChildSessionEntry)(name);
    const resolvedTools =
      tools ??
      (this.options?.enableTools as string[] | undefined) ??
      this.enabledToolCategories ??
      [];

    if (entry.isRunning && entry.queue.length > 0) {
      const last = entry.queue[entry.queue.length - 1]!;
      last.task = `Complete these tasks:\n1. ${last.task}\n2. ${task}`;
      if (tools) last.tools = [...new Set([...last.tools, ...tools])];
      last.maxIterations = Math.max(last.maxIterations, maxIterations);
      console.log(`[ChildSessionMixin] Merged task into queue for child '${name}'`);
      return last.promise;
    }

    let resolve!: (v: unknown) => void;
    let reject!: (r: unknown) => void;
    const promise = new Promise<unknown>((res, rej) => { resolve = res; reject = rej; });

    const taskObj: ChildTask = {
      id: _generateUUID(),
      task,
      description: (extra['description'] as string | undefined) ?? null,
      tools: resolvedTools as string[],
      maxIterations,
      systemPrompt: systemPrompt ?? null,
      model: (extra['model'] as string | undefined) ?? null,
      thinking: extra['thinking'] ?? null,
      callbackMode: (extra['callbackMode'] as string | undefined) ?? 'delay',
      debounceSeconds: (extra['debounceSeconds'] as number | undefined) ?? 5,
      resolve,
      reject,
      promise,
    };
    entry.queue.push(taskObj);

    const processFn = (this as unknown as Record<string, (n: string) => Promise<void>>)['_processChildQueue'];
    if (!entry.isRunning && processFn) void processFn.call(this, name);
    return promise;
  },

  /**
   * 顺序执行命名子 agent 的任务队列（fire-and-forget）。
   * 每个任务完成后将结果推入 `_pendingChildResults` 并触发回调。
   * @private
   */
  async _processChildQueue(this: ChildSessionHost, name: string): Promise<void> {
    const entry = this._childSessions[name];
    if (!entry) return;
    entry.isRunning = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const self = this as any;

    while (entry.queue.length > 0) {
      const taskObj = entry.queue.shift()!;
      try {
        entry.session.clear?.();

        const sysPrompt =
          taskObj.systemPrompt ??
          `You are agent '${name}', a teammate working in parallel with the main agent. Complete the assigned task and return your final answer.`;
        entry.session.messages?.push({ role: 'system', content: sysPrompt });

        const sendOptions: Record<string, unknown> = {
          enableTools: taskObj.tools,
          maxIterations: taskObj.maxIterations,
          stream: true,
        };
        if (this.customTools?.length) sendOptions['tools'] = this.customTools;
        if (taskObj.model) sendOptions['model'] = taskObj.model;
        if (taskObj.thinking) sendOptions['thinking'] = taskObj.thinking;

        const agentPath: string = self._buildAgentPath?.(name) ?? name;
        sendOptions['onMessage'] = (text: unknown, fullResponse: unknown): void => {
          self._emitChildStream?.({ agentPath, agentName: name, taskId: taskObj.id, type: 'message', content: text, fullResponse });
        };
        sendOptions['onToolCall'] = (toolCall: unknown): void => {
          self._emitChildStream?.({ agentPath, agentName: name, taskId: taskObj.id, type: 'toolCall', content: toolCall });
        };
        sendOptions['onComplete'] = (result: unknown, fullResponse: unknown): void => {
          self._emitChildStream?.({ agentPath, agentName: name, taskId: taskObj.id, type: 'complete', content: result, fullResponse });
        };
        sendOptions['onError'] = (error: Error): void => {
          self._emitChildStream?.({ agentPath, agentName: name, taskId: taskObj.id, type: 'error', content: error.message ?? String(error) });
        };

        const response = await entry.session.send?.(taskObj.task, sendOptions);
        const result = typeof response === 'string' ? response : ((response as Record<string, unknown>)?.['result'] ?? '');
        const taskSummary = taskObj.description ?? (taskObj.task.length > 80 ? taskObj.task.slice(0, 80) + '...' : taskObj.task);
        this._pendingChildResults.push({ agentName: name, taskId: taskObj.id, taskSummary, result });
        console.log(`[ChildSessionMixin] Child '${name}' completed task ${taskObj.id}; pendingChildResults=${this._pendingChildResults.length}; result=${_summarize(result)}`);
        self._handleChildCallback?.(taskObj.callbackMode, taskObj.debounceSeconds);
        taskObj.resolve(result);
      } catch (e) {
        console.error(`[ChildSessionMixin] Child '${name}' task ${taskObj.id} failed:`, e);
        const errorResult = { error: (e as Error).message ?? 'Child agent task failed' };
        const taskSummary = taskObj.description ?? (taskObj.task.length > 80 ? taskObj.task.slice(0, 80) + '...' : taskObj.task);
        this._pendingChildResults.push({ agentName: name, taskId: taskObj.id, taskSummary, result: errorResult });
        console.warn(`[ChildSessionMixin] Child '${name}' failure queued; taskId=${taskObj.id}; pendingChildResults=${this._pendingChildResults.length}; result=${_summarize(errorResult)}`);
        self._handleChildCallback?.(taskObj.callbackMode, taskObj.debounceSeconds);
        taskObj.reject(e);
      }
    }
    entry.isRunning = false;
  },

  /**
   * 构建子 agent 的路径字符串（如 `"parent > child > grandchild"`）。
   * @private
   */
  _buildAgentPath(this: ChildSessionHost, childName: string): string {
    const parts: string[] = [];
    let s: ChildSessionHost | null | undefined = this;
    while (s) {
      if (s.name) parts.unshift(s.name);
      s = s.parentSession;
    }
    parts.push(childName);
    return parts.join(' > ');
  },

  /**
   * 触发子 agent 流式事件回调。
   * @private
   */
  _emitChildStream(this: ChildSessionHost, event: ChildStreamEvent): void {
    if (this.onChildStream) {
      try { this.onChildStream(event); } catch (e) {
        console.warn('[ChildSessionMixin] onChildStream callback error:', e);
      }
    }
  },

  /**
   * 将来自后代的流式事件向上传播。
   * @private
   */
  _bubbleChildStream(this: ChildSessionHost, event: ChildStreamEvent): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this as any)._emitChildStream?.(event);
  },

  /**
   * 消费并清空待处理的子 agent 结果。
   * 由 `send()` 在每个发送周期开始时调用。
   */
  _consumePendingChildResults(this: ChildSessionHost): PendingChildResult[] {
    const results = this._pendingChildResults;
    this._pendingChildResults = [];
    if (results.length > 0) {
      console.log(
        `[ChildSessionMixin] _consumePendingChildResults session='${this.name ?? 'root'}' consumed ${results.length} result(s): ` +
        results.map((item) => `${item.agentName}:${item.taskId}:${_summarize(item.result, 80)}`).join(' | ')
      );
    }
    return results;
  },

  /**
   * 根据 callbackMode 处理子任务完成回调。
   *
   * - `immediate`：立即触发（调用 `_triggerImmediateCallback`）
   * - `debounce`：延迟触发（调用 `_triggerDebounceCallback`）
   * - `delay`（默认）：什么都不做，结果在下一次 `send()` 时消费
   *
   * @private
   */
  _handleChildCallback(this: ChildSessionHost, mode: string, debounceSeconds?: number): void {
    console.log(
      `[ChildSessionMixin] _handleChildCallback session='${this.name ?? 'root'}' mode=${mode ?? 'delay'} ` +
      `debounceSeconds=${debounceSeconds ?? 5} pendingChildResults=${this._pendingChildResults.length}`
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const selfCb = this as any;
    if (mode === 'immediate') {
      void selfCb._triggerImmediateCallback?.();
    } else if (mode === 'debounce') {
      selfCb._triggerDebounceCallback?.(debounceSeconds);
    }
    // 'delay'：什么都不做
  },

  /**
   * 默认立即回调（宿主类必须覆盖此方法）。
   * 若未覆盖，结果会累积直到下一次 `send()`。
   * @private
   */
  async _triggerImmediateCallback(this: ChildSessionHost): Promise<void> {
    console.warn('[ChildSessionMixin] _triggerImmediateCallback not overridden — child results will accumulate until next send.');
  },

  /**
   * 延迟执行 `_triggerImmediateCallback`（用于 debounce 模式）。
   * @param seconds - 延迟秒数（默认 5）
   * @private
   */
  _triggerDebounceCallback(this: ChildSessionHost, seconds = 5): void {
    const timerId = setTimeout(async () => {
      this._debounceTimers = this._debounceTimers.filter((t) => t !== timerId);
      await this._triggerImmediateCallback!();
    }, seconds * 1000);
    this._debounceTimers.push(timerId);
    console.log(`[ChildSessionMixin] Debounce callback set: ${seconds}s pendingChildResults=${this._pendingChildResults.length}`);
  },

  /**
   * 取消所有待处理的 debounce 定时器。
   * 在 `send()` 开始时调用，确保本次发送周期包含最新结果。
   * @private
   */
  _cancelDebounceTimers(this: ChildSessionHost): void {
    for (const t of this._debounceTimers) clearTimeout(t);
    this._debounceTimers = [];
  },

  /**
   * 获取父 session 的上下文（供子 agent 请求更多背景信息时使用）。
   *
   * @param messageCount - 返回的最近消息数（默认 10）
   * @returns 父上下文对象，或 null（无父 session 时）
   */
  getParentContext(
    this: ChildSessionHost,
    messageCount = 10
  ): { systemPrompt: string | null; recentMessages: unknown[]; model?: string; workspace?: string | null } | null {
    if (!this.parentSession) return null;
    const parent = this.parentSession;
    const messages = (parent.messages ?? parent._history ?? []) as Array<{ role: string; content: string }>;
    const sysMsg = messages.find((m) => m.role === 'system');
    return {
      systemPrompt: sysMsg ? sysMsg.content : null,
      recentMessages: messages.slice(-messageCount),
      model: parent.model,
      workspace: parent.workspace,
    };
  },

  /**
   * 按名称获取子 session 条目。
   * @param name - 子 agent 名称
   */
  getChildSession(this: ChildSessionHost, name: string): ChildSessionEntry | undefined {
    return this._childSessions[name];
  },

  /**
   * 获取所有子 session 的名称列表。
   */
  getChildSessionNames(this: ChildSessionHost): string[] {
    return Object.keys(this._childSessions);
  },

  /**
   * 清理子 session 状态（取消所有 debounce 定时器，清空子 session 和待处理结果）。
   * 在宿主类的 `restartAgent` / `destroy` 方法中调用。
   * @private
   */
  _cleanupChildSessions(this: ChildSessionHost): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this as any)._cancelDebounceTimers?.();
    this._childSessions = {};
    this._pendingChildResults = [];
  },
};

export { initChildSessionState as default };
