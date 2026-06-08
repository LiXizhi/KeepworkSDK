/**
 * AgentRouter.ts — 跨 iframe Agent 注册、发现与任务转发路由器
 *
 * 每个 KeepworkSDK 实例（在任意 window / iframe 中）持有一个 AgentRouter。
 * 命名 ChatSession 可向本地路由器注册；路由器通过 `window.postMessage`
 * 在整个 iframe 树中广播可用性，使任何 `submitTask` 调用都能发现并委托远程 agent。
 *
 * ## 协议约定
 * - 所有 AgentRouter 消息携带 `is_agent_router: true` 标志
 * - NPL 模块使用 `is_paracraft_message: true`，两者互不干扰
 * - 同一消息的 `instanceId` / `sourceInstanceId` 等于本路由器 ID 时视为自回显，丢弃
 *
 * ## 使用示例
 * ```ts
 * // 在拥有 agent 的 iframe 中
 * const router = window.keepwork.agentRouter;
 * router.register('codeHelper', session);
 *
 * // 在父页面或其他 iframe 中
 * const router = window.keepwork.agentRouter;
 * router.addChildWindow(iframe.contentWindow);
 * const result = await router.submitTask('codeHelper', { task: 'Explain KeepworkSDK' });
 * ```
 */

import SDKLogger from '../utils/SDKLogger';

const console = SDKLogger.createModuleConsole('AgentRouter');

// ──────────────────── 类型定义 ────────────────────

/** AgentRouter 协议消息类型字符串 */
const MSG = {
  REGISTER:          'agent_register',
  REGISTER_ACK:      'agent_register_ack',
  REGISTER_REJECT:   'agent_register_reject',
  UNREGISTER:        'agent_unregister',
  WINDOW_DISCONNECT: 'agent_window_disconnect',
  TASK:              'agent_task',
  TASK_RESULT:       'agent_task_result',
  STREAM:            'agent_stream',
  SYNC_ACK:          'agent_sync_ack',
} as const;

type MsgType = typeof MSG[keyof typeof MSG];

/** AgentRouter 协议消息信封 */
interface RouterMessage {
  is_agent_router: true;
  type: MsgType;
  agentName?: string;
  instanceId?: string;
  sourceInstanceId?: string;
  taskId?: string;
  payload?: TaskPayload;
  result?: unknown;
  error?: string | null;
  reason?: string;
  syncId?: string;
  request?: boolean;
  syncBackfill?: boolean;
  streamType?: string;
  content?: unknown;
  fullResponse?: unknown;
  isRestartAgentSignal?: boolean;
  promptFile?: string;
  tools?: unknown[];
  options?: Record<string, unknown>;
}

/** 任务载荷（submitTask 时传入） */
export interface TaskPayload {
  task?: string;
  description?: string;
  /** LLM 工具列表（传给 session.send） */
  tools?: unknown;
  maxIterations?: number;
  systemPrompt?: string;
  model?: string;
  thinking?: unknown;
  callbackMode?: string;
  debounceSeconds?: number;
  /** 是否绕过 LLM 直接执行工具 */
  toolCallOnly?: boolean;
  fnName?: string;
  fnArgs?: unknown;
  [key: string]: unknown;
}

/** 路由表条目 */
interface RouteRecord {
  windowRef: WindowProxy | NPLWindowProxy;
  sourceInstanceId: string;
  learnedFrom: WindowProxy | NPLWindowProxy;
  updatedAt: number;
}

/** 任务注册表条目 */
interface OriginTaskRecord {
  kind: 'origin';
  agentName: string;
  createdAt: number;
  outboundWindow: WindowProxy | NPLWindowProxy;
  replyWindow: null;
  onStream: ((msg: RouterMessage) => void) | null;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timeoutId: ReturnType<typeof setTimeout> | null;
}

interface RelayTaskRecord {
  kind: 'relay';
  agentName: string;
  createdAt: number;
  outboundWindow: WindowProxy | NPLWindowProxy;
  replyWindow: WindowProxy | NPLWindowProxy;
  onStream: null;
  resolve: null;
  reject: null;
  timeoutId: null;
}

type TaskRecord = OriginTaskRecord | RelayTaskRecord;

/** 本地 agent session 接口（ChatSession 的最小接口） */
interface AgentSession {
  handleTask?: (taskId: string, payload: TaskPayload, streamCb: (event: unknown) => void) => Promise<unknown>;
  executeTool?: (fnName: string, fnArgs: unknown) => Promise<unknown>;
  clear?: () => void;
  send?: (task: string, options: Record<string, unknown>) => Promise<unknown>;
  messages?: unknown[];
  options?: Record<string, unknown>;
}

/** submitTask 的回调选项 */
export interface SubmitTaskCallbacks {
  onStream?: (msg: RouterMessage) => void;
}

/** 默认任务超时（ms） */
const DEFAULT_TASK_TIMEOUT_MS = 30_000;

// ──────────────────── 工具函数 ────────────────────

function generateUUID(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function summarizeDebugValue(value: unknown, maxLength = 180): string {
  if (value === null || value === undefined) return String(value);
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}

// ──────────────────── NPLWindowProxy ────────────────────

/**
 * NPLWindowProxy — 通过 NPLJS 向 Lua 端转发 postMessage 的虚拟 WindowProxy。
 *
 * 从 AgentRouter 的视角，此对象与真实 WindowProxy 完全等价：
 * 同样存储在 `connectedWindows` 和 `routeTable` 中。
 * `_sendTo()` 通过检测 `_isNPLWindowProxy` 标志选择 NPLJS 通道而非 postMessage。
 */
class NPLWindowProxy {
  readonly _isNPLWindowProxy = true;
  private _npljs: { SendMsg: (event: string, msg: unknown) => void };
  private _sendEventName: string;

  /**
   * @param npljs         - NPLJS 实例（需暴露 SendMsg / OnMsg）
   * @param sendEventName - JS→Lua 方向的 NPLJS 事件名
   */
  constructor(npljs: { SendMsg: (event: string, msg: unknown) => void }, sendEventName: string) {
    this._npljs = npljs;
    this._sendEventName = sendEventName;
  }

  /**
   * 模拟 window.postMessage，通过 NPLJS 发送消息到 Lua 端。
   * @param msg - 要发送的消息对象
   */
  postMessage(msg: unknown): void {
    this._npljs?.SendMsg(this._sendEventName, msg);
  }
}

// ──────────────────── AgentRouter ────────────────────

class AgentRouter {
  /** 开启详细日志（调试用）。 */
  static debug = false;

  static _log(msgOrFn: string | (() => string), ...rest: unknown[]): void {
    if (!AgentRouter.debug) return;
    const msg = typeof msgOrFn === 'function' ? msgOrFn() : msgOrFn;
    console.log(msg, ...rest);
  }

  /** 此路由器实例的唯一 ID。 */
  readonly instanceId: string;

  /** 本地注册的 agent（agentName → session）。 */
  readonly localAgents = new Map<string, { session: AgentSession }>();

  /**
   * 远程 agent 路由表（agentName → RouteRecord）。
   * 记录消息应该发往哪个 windowRef 才能抵达对应 agent。
   */
  readonly routeTable = new Map<string, RouteRecord>();

  /**
   * 任务注册表（taskId → TaskRecord）。
   * origin 任务：由本路由器提交，持有 resolve/reject 回调。
   * relay 任务：上游转发过来，需要将结果/流转发回 replyWindow。
   */
  readonly taskRegistry = new Map<string, TaskRecord>();

  /** window → 从该 window 学到的 agent 名集合（O(1) 清理索引）。 */
  readonly windowAgents = new Map<WindowProxy | NPLWindowProxy, Set<string>>();

  /** window → 通过该 window 流转的 taskId 集合（O(1) 清理索引）。 */
  readonly windowTasks = new Map<WindowProxy | NPLWindowProxy, Set<string>>();

  /** 已连接的子 iframe window 集合。 */
  readonly connectedWindows = new Set<WindowProxy | NPLWindowProxy>();

  private _isDestroyed = false;
  private _disconnectAnnounced = false;
  private _messageHandler: (event: MessageEvent) => void;
  private _lifecycleHandler: (event: Event) => void;
  private _pendingSyncs = new Map<string, () => void>();
  private _nplWindowProxy: NPLWindowProxy | null = null;
  private _nplRecvEventName: string | null = null;
  /** 关联的 SDK 实例（用于读取 timeout 配置）。 */
  _sdk?: { timeout?: number };

  constructor() {
    this.instanceId = generateUUID();
    this._messageHandler = this._onMessage.bind(this);
    this._lifecycleHandler = this._handleLifecycleTeardown.bind(this);
    if (typeof window !== 'undefined') {
      window.addEventListener('message', this._messageHandler);
      window.addEventListener('pagehide', this._lifecycleHandler);
    }
  }

  // ─────────────────────── 公共 API ───────────────────────

  /**
   * 在本路由器注册命名 agent，并向 iframe 树广播可用性。
   * 若名称已被占用（本地或远程），返回 false。
   *
   * @param agentName - agent 唯一名称
   * @param session   - 处理该 agent 任务的 ChatSession 实例
   * @returns 注册成功返回 true，名称冲突返回 false
   */
  register(agentName: string, session: AgentSession): boolean {
    if (!agentName) return false;
    if (this.localAgents.has(agentName) || this.routeTable.has(agentName)) {
      console.warn(`[AgentRouter] Agent '${agentName}' already registered.`);
      return false;
    }
    this.localAgents.set(agentName, { session });
    console.log(`[AgentRouter] Registered local agent '${agentName}'`);
    this._broadcast({ is_agent_router: true, type: MSG.REGISTER, agentName, instanceId: this.instanceId }, null);
    return true;
  }

  /**
   * 注销本地 agent 并广播移除消息。
   * @param agentName - 要注销的 agent 名称
   */
  unregister(agentName: string): void {
    if (!this.localAgents.has(agentName)) return;
    this.localAgents.delete(agentName);
    console.log(`[AgentRouter] Unregistered local agent '${agentName}'`);
    this._broadcast({ is_agent_router: true, type: MSG.UNREGISTER, agentName, instanceId: this.instanceId }, null);
  }

  /**
   * 检查 agent（本地或远程）是否已知。
   * @param agentName - agent 名称
   */
  hasAgent(agentName: string): boolean {
    return this.localAgents.has(agentName) || this.routeTable.has(agentName);
  }

  /**
   * 检查 agent 是否只存在于路由表（即在另一个 iframe 中）。
   * @param agentName - agent 名称
   */
  hasRemoteAgent(agentName: string): boolean {
    return !this.localAgents.has(agentName) && this.routeTable.has(agentName);
  }

  /**
   * 等待 agent 出现（轮询路由表 / 注册事件），若已存在则立即 resolve。
   *
   * @param agentName - agent 名称
   * @param timeout   - 最大等待毫秒数（默认 5000）
   */
  waitForAgent(agentName: string, timeout = 5000): Promise<void> {
    if (this.hasAgent(agentName)) return Promise.resolve();
    const POLL = 100;
    const start = Date.now();
    return new Promise((resolve, reject) => {
      const check = (): void => {
        if (this.hasAgent(agentName)) return resolve();
        if (Date.now() - start > timeout) {
          return reject(new Error(`[AgentRouter] Agent '${agentName}' not found after ${timeout}ms`));
        }
        setTimeout(check, POLL);
      };
      check();
    });
  }

  /**
   * 向远程 agent 提交任务，返回 Promise 等待结果。
   *
   * @param agentName - 目标 agent 名称
   * @param payload   - 任务载荷（task / tools / maxIterations / systemPrompt / model 等）
   * @param callbacks - 可选：onStream 流式回调
   * @returns agent 任务结果
   */
  submitTask(agentName: string, payload: TaskPayload, callbacks: SubmitTaskCallbacks = {}): Promise<unknown> {
    const route = this.routeTable.get(agentName);
    if (!route) {
      console.warn(`[AgentRouter] submitTask failed: no route to '${agentName}'`);
      return Promise.reject(new Error(`No route to remote agent '${agentName}'`));
    }
    const taskId = generateUUID();
    AgentRouter._log(() => `[AgentRouter] submitTask -> taskId=${taskId} agent='${agentName}' task=${summarizeDebugValue(payload?.task)}`);

    return new Promise((resolve, reject) => {
      this._createOriginTask(taskId, agentName, route.windowRef, callbacks.onStream ?? null, resolve, reject);
      this._sendTo(route.windowRef, {
        is_agent_router: true, type: MSG.TASK, taskId, agentName, payload,
        sourceInstanceId: this.instanceId,
      });
    });
  }

  /**
   * 注册子 iframe 的 contentWindow 以加入路由树。
   * 自动发起同步重试，直到子窗口确认。
   *
   * @param windowRef - 子 iframe 的 contentWindow（或 NPLWindowProxy）
   */
  addChildWindow(windowRef: WindowProxy | NPLWindowProxy): void {
    if (!windowRef || this.connectedWindows.has(windowRef)) return;
    this.connectedWindows.add(windowRef);
    this._syncWithRetry(windowRef);
  }

  /**
   * 移除子 iframe window，清理其相关路由和任务。
   * @param windowRef - 要移除的 window
   */
  removeChildWindow(windowRef: WindowProxy | NPLWindowProxy): void {
    this._cleanupWindow(windowRef, true);
  }

  /**
   * 销毁路由器：广播断开通知、注销所有 agent、拒绝所有待处理任务、清理监听器。
   * 调用后此实例不可再使用。
   */
  destroy(): void {
    if (this._isDestroyed) return;
    this._isDestroyed = true;
    this._announceWindowDisconnect();
    for (const [agentName] of [...this.localAgents]) { this.unregister(agentName); }

    for (const [taskId, record] of [...this.taskRegistry]) {
      if (record.kind === 'relay') {
        this._sendTo(record.replyWindow, {
          is_agent_router: true, type: MSG.TASK_RESULT, taskId,
          result: null, error: `AgentRouter destroyed (relay agent '${record.agentName}')`,
          sourceInstanceId: this.instanceId,
        });
      }
      const cleared = this._clearTask(taskId, 'destroy');
      if (cleared?.kind === 'origin') cleared.reject(new Error('AgentRouter destroyed'));
    }

    this.taskRegistry.clear();
    this.routeTable.clear();
    this.connectedWindows.clear();
    this.windowAgents.clear();
    this.windowTasks.clear();

    if (typeof window !== 'undefined') {
      window.removeEventListener('message', this._messageHandler);
      window.removeEventListener('pagehide', this._lifecycleHandler);
    }
  }

  // ─────────────────────── NPLJS 桥接 ───────────────────────

  /**
   * 将本路由器与 Lua 侧 AgentRouter.lua 通过 NPLJS 连接。
   *
   * 创建 NPLWindowProxy 并将其插入现有路由基础设施，
   * AgentRouter 协议消息通过 NPLJS 透明转发，而非 postMessage。
   *
   * @param npljs   - NPLJS 实例（需提供 SendMsg / OnMsg）
   * @param options - sendEventName（JS→Lua）/ recvEventName（Lua→JS）
   * @returns this（链式调用）
   */
  attachNPLJS(
    npljs: { SendMsg: (event: string, msg: unknown) => void; OnMsg: (event: string, cb: (data: unknown) => void) => void; OffMsg: (event: string) => void },
    options: { sendEventName?: string; recvEventName?: string } = {}
  ): this {
    if (!npljs) { console.warn('[AgentRouter] attachNPLJS: npljs instance is required'); return this; }

    const sendEventName = options.sendEventName ?? '@webparacraft_backgroundAgent';
    const recvEventName = options.recvEventName ?? '@keepwork_backgroundAgent';

    // 幂等：已连接相同通道则跳过
    if (this._nplWindowProxy && (this._nplWindowProxy as unknown as { _sendEventName: string })._sendEventName === sendEventName) return this;

    if (this._nplWindowProxy) {
      this.removeChildWindow(this._nplWindowProxy);
      if (this._nplRecvEventName) npljs.OffMsg(this._nplRecvEventName);
      this._nplWindowProxy = null;
    }

    const proxy = new NPLWindowProxy(npljs, sendEventName);
    this._nplWindowProxy = proxy;
    this._nplRecvEventName = recvEventName;

    npljs.OnMsg(recvEventName, (msgdata: unknown) => {
      const msg = msgdata as RouterMessage | null;
      if (!msg || msg.is_agent_router !== true) return;
      this._onMessage({ data: msg, source: proxy } as unknown as MessageEvent);
    });

    this.addChildWindow(proxy);
    console.log(`[AgentRouter] attachNPLJS: send=${sendEventName} recv=${recvEventName}`);
    return this;
  }

  /**
   * 断开通过 attachNPLJS 建立的 NPLJS 桥接。
   *
   * @param npljs - 与 attachNPLJS 相同的 NPLJS 实例
   */
  detachNPLJS(npljs: { OffMsg: (event: string) => void }): void {
    if (!this._nplWindowProxy) return;
    this.removeChildWindow(this._nplWindowProxy);
    if (npljs && this._nplRecvEventName) npljs.OffMsg(this._nplRecvEventName);
    this._nplWindowProxy = null;
    this._nplRecvEventName = null;
    console.log('[AgentRouter] detachNPLJS: bridge removed');
  }

  // ─────────────────────── 传输帮助 ───────────────────────

  /**
   * 向指定 window 发送消息。
   * NPLWindowProxy 通过 NPLJS 路由，普通 WindowProxy 通过 postMessage。
   * @private
   */
  private _sendTo(windowRef: WindowProxy | NPLWindowProxy, msg: RouterMessage): void {
    try {
      if (windowRef === this._nplWindowProxy) {
        (windowRef as NPLWindowProxy).postMessage(msg);
        return;
      }
      (windowRef as WindowProxy).postMessage(msg, '*');
    } catch (e) {
      console.warn('[AgentRouter] _sendTo failed:', e);
    }
  }

  /**
   * 广播消息到父窗口和所有子 iframe，排除指定 window（防止回显循环）。
   * @private
   */
  private _broadcast(msg: RouterMessage, excludeWindow: WindowProxy | NPLWindowProxy | null): void {
    if (typeof window === 'undefined') return;
    if (window.parent && window.parent !== window && window.parent !== excludeWindow) {
      this._sendTo(window.parent as WindowProxy, msg);
    }
    for (const child of this.connectedWindows) {
      if (child !== excludeWindow) this._sendTo(child, msg);
    }
  }

  // ─────────────────────── 消息调度 ───────────────────────

  /** @private 主消息事件处理器。 */
  private _onMessage(event: MessageEvent): void {
    const msg = event.data as RouterMessage | null;
    if (!msg || msg.is_agent_router !== true) return;
    // 自回显防护
    if (msg.instanceId === this.instanceId || msg.sourceInstanceId === this.instanceId) return;

    const source = event.source as WindowProxy | NPLWindowProxy;

    switch (msg.type) {
      case MSG.REGISTER:          this._handleRegister(msg, source); break;
      case MSG.REGISTER_ACK:      this._handleRegisterAck(msg); break;
      case MSG.REGISTER_REJECT:   this._handleRegisterReject(msg); break;
      case MSG.UNREGISTER:        this._handleUnregister(msg, source); break;
      case MSG.WINDOW_DISCONNECT: this._handleWindowDisconnect(source); break;
      case MSG.TASK:              void this._handleTask(msg, source); break;
      case MSG.TASK_RESULT:       this._handleTaskResult(msg, source); break;
      case MSG.STREAM:            this._handleStream(msg, source); break;
      case MSG.SYNC_ACK:          this._handleSyncAck(msg, source); break;
    }
  }

  // ─────────────────────── 注册消息处理 ───────────────────────

  /** @private 处理 agent_register 消息：存储路由并转发。 */
  private _handleRegister(msg: RouterMessage, sourceWindow: WindowProxy | NPLWindowProxy): void {
    const { agentName = '', instanceId = '', syncBackfill } = msg;

    if (this.localAgents.has(agentName)) {
      this._sendTo(sourceWindow, {
        is_agent_router: true, type: MSG.REGISTER_REJECT, agentName, instanceId: this.instanceId,
        reason: `Agent '${agentName}' already registered locally on instance ${this.instanceId}`,
      });
      return;
    }

    const existing = this.routeTable.get(agentName);
    if (existing) {
      if (existing.sourceInstanceId === instanceId && existing.windowRef === sourceWindow) {
        existing.updatedAt = Date.now();
        return;
      }
      this._sendTo(sourceWindow, {
        is_agent_router: true, type: MSG.REGISTER_REJECT, agentName, instanceId: this.instanceId,
        reason: `Agent '${agentName}' already registered by instance ${existing.sourceInstanceId}`,
      });
      return;
    }

    this.routeTable.set(agentName, { windowRef: sourceWindow, sourceInstanceId: instanceId, learnedFrom: sourceWindow, updatedAt: Date.now() });
    this._indexWindowAgent(sourceWindow, agentName);
    console.log(`[AgentRouter] Discovered remote agent '${agentName}' via instance ${instanceId}`);

    if (sourceWindow !== window.parent) this.connectedWindows.add(sourceWindow);

    if (!syncBackfill) {
      this._sendTo(sourceWindow, { is_agent_router: true, type: MSG.REGISTER_ACK, agentName, instanceId: this.instanceId });
      this._syncKnownAgentsToWindow(sourceWindow, agentName, instanceId);
    }

    this._broadcast(msg, sourceWindow);
  }

  /** @private 处理 agent_register_ack（当前仅记录日志）。 */
  private _handleRegisterAck(msg: RouterMessage): void {
    console.log(`[AgentRouter] Registration of '${msg.agentName}' acknowledged by instance ${msg.instanceId}`);
  }

  /** @private 处理 agent_register_reject（回滚本地乐观注册）。 */
  private _handleRegisterReject(msg: RouterMessage): void {
    console.warn(`[AgentRouter] Registration of '${msg.agentName}' rejected: ${msg.reason}`);
    if (this.localAgents.has(msg.agentName ?? '')) {
      this.localAgents.delete(msg.agentName ?? '');
      console.warn(`[AgentRouter] Rolled back local registration of '${msg.agentName}'`);
    }
  }

  /** @private 处理 agent_unregister（验证来源后删除路由，防止劫持）。 */
  private _handleUnregister(msg: RouterMessage, sourceWindow: WindowProxy | NPLWindowProxy): void {
    const { agentName = '', instanceId = '' } = msg;
    const existing = this.routeTable.get(agentName);
    if (existing) {
      if (existing.windowRef !== sourceWindow || existing.sourceInstanceId !== instanceId) {
        console.warn(`[AgentRouter] _handleUnregister ignored stale unregister for '${agentName}'`);
        return;
      }
      this.routeTable.delete(agentName);
      this.windowAgents.get(sourceWindow)?.delete(agentName);
      AgentRouter._log(`[AgentRouter] Remote agent '${agentName}' unregistered`);
    }
    this._broadcast(msg, sourceWindow);
  }

  /** @private 处理 agent_window_disconnect：清理该 window 的所有路由和任务。 */
  private _handleWindowDisconnect(sourceWindow: WindowProxy | NPLWindowProxy): void {
    if (!sourceWindow) return;
    this._cleanupWindow(sourceWindow, true);
  }

  // ─────────────────────── 任务消息处理 ───────────────────────

  /** @private 处理 agent_task：本地执行或转发到正确的 window。 */
  private async _handleTask(msg: RouterMessage, sourceWindow: WindowProxy | NPLWindowProxy): Promise<void> {
    const { taskId = '', agentName = '', payload = {}, sourceInstanceId } = msg;
    AgentRouter._log(() => `[AgentRouter] _handleTask taskId=${taskId} agent='${agentName}' from=${sourceInstanceId} task=${summarizeDebugValue(payload?.task)}`);

    const localEntry = this.localAgents.get(agentName);
    if (localEntry) {
      await this._executeLocalTask(localEntry.session, taskId, payload, sourceWindow);
      return;
    }

    const route = this.routeTable.get(agentName);
    if (route) {
      this._sendTo(route.windowRef, msg);
      this._createRelayTask(taskId, agentName, route.windowRef, sourceWindow);
      return;
    }

    console.warn(`[AgentRouter] _handleTask no route found for agent='${agentName}' taskId=${taskId}`);
    this._sendTo(sourceWindow, {
      is_agent_router: true, type: MSG.TASK_RESULT, taskId,
      result: null, error: `Agent '${agentName}' not found`, sourceInstanceId: this.instanceId,
    });
  }

  /** @private 在本地 session 上执行任务（handleTask 接口 或 legacy send 接口）。 */
  private async _executeLocalTask(
    session: AgentSession,
    taskId: string,
    payload: TaskPayload,
    replyWindow: WindowProxy | NPLWindowProxy
  ): Promise<void> {
    try {
      if (payload.toolCallOnly) {
        await this._executeLocalToolCall(session, taskId, payload, replyWindow);
        return;
      }

      if (typeof session.handleTask === 'function') {
        const streamCb = (event: unknown): void => {
          const e = event as RouterMessage;
          this._sendTo(replyWindow, { is_agent_router: true, type: MSG.STREAM, taskId, streamType: e.streamType, content: e.content, fullResponse: e.fullResponse, sourceInstanceId: this.instanceId });
        };
        const result = await session.handleTask(taskId, payload, streamCb);
        const resultStr = typeof result === 'string' ? result : (result as Record<string, unknown>)?.['result'] ?? '';
        this._sendTo(replyWindow, { is_agent_router: true, type: MSG.TASK_RESULT, taskId, result: resultStr, error: null, sourceInstanceId: this.instanceId });
        return;
      }

      // Legacy ChatSession API
      const { task, tools, maxIterations, systemPrompt, model, thinking } = payload;
      session.clear?.();
      const effectiveSystemPrompt = (systemPrompt ?? (session.options?.['systemPrompt'] as string | undefined));
      if (effectiveSystemPrompt && Array.isArray(session.messages)) {
        session.messages.push({ role: 'system', content: effectiveSystemPrompt });
      }

      const sendOptions: Record<string, unknown> = { maxIterations: maxIterations ?? 10, stream: true };
      if (tools !== undefined && tools !== null) sendOptions['enableTools'] = tools;
      if (model) sendOptions['model'] = model;
      if (thinking) sendOptions['thinking'] = thinking;

      sendOptions['onMessage'] = (text: string, fullResponse: unknown): void => {
        this._sendTo(replyWindow, { is_agent_router: true, type: MSG.STREAM, taskId, streamType: 'message', content: text, fullResponse, sourceInstanceId: this.instanceId });
      };
      sendOptions['onToolCall'] = (toolCall: unknown): void => {
        this._sendTo(replyWindow, { is_agent_router: true, type: MSG.STREAM, taskId, streamType: 'toolCall', content: toolCall, sourceInstanceId: this.instanceId });
      };
      sendOptions['onComplete'] = (result: unknown, fullResponse: unknown): void => {
        this._sendTo(replyWindow, { is_agent_router: true, type: MSG.STREAM, taskId, streamType: 'complete', content: result, fullResponse, sourceInstanceId: this.instanceId });
      };
      sendOptions['onError'] = (error: Error): void => {
        this._sendTo(replyWindow, { is_agent_router: true, type: MSG.STREAM, taskId, streamType: 'error', content: error.message ?? String(error), sourceInstanceId: this.instanceId });
      };

      const response = await session.send!(task ?? '', sendOptions);
      const result = typeof response === 'string' ? response : (response as Record<string, unknown>)?.['result'] ?? '';
      this._sendTo(replyWindow, { is_agent_router: true, type: MSG.TASK_RESULT, taskId, result, error: null, sourceInstanceId: this.instanceId });
    } catch (e) {
      console.error('[AgentRouter] Local task execution failed:', e);
      this._sendTo(replyWindow, {
        is_agent_router: true, type: MSG.TASK_RESULT, taskId, result: null,
        error: (e as Error).message ?? 'Task execution failed', sourceInstanceId: this.instanceId,
      });
    }
  }

  /**
   * @private 直接执行工具调用（bypasses LLM，payload.toolCallOnly=true 时调用）。
   * 支持 RestartAgentSignal 跨 iframe 序列化。
   */
  private async _executeLocalToolCall(
    session: AgentSession,
    taskId: string,
    payload: TaskPayload,
    replyWindow: WindowProxy | NPLWindowProxy
  ): Promise<void> {
    const { fnName = '', fnArgs } = payload;
    try {
      let result: unknown;
      if (typeof session.executeTool === 'function') {
        result = await session.executeTool(fnName, fnArgs);
      } else if (typeof session.handleTask === 'function') {
        result = await session.handleTask(taskId, payload, () => { /* noop */ });
      } else {
        throw new Error(`Agent session does not support direct tool execution for '${fnName}'`);
      }
      this._sendTo(replyWindow, {
        is_agent_router: true, type: MSG.TASK_RESULT, taskId,
        result: result != null ? String(result) : '', error: null, sourceInstanceId: this.instanceId,
      });
    } catch (e) {
      const err = e as Record<string, unknown> & Error;
      if (err?.isRestartAgentSignal) {
        this._sendTo(replyWindow, {
          is_agent_router: true, type: MSG.TASK_RESULT, taskId, result: null,
          error: 'RestartAgentSignal', isRestartAgentSignal: true,
          promptFile: err['promptFile'] as string | undefined,
          tools: Array.isArray(err['tools']) ? (err['tools'] as unknown[]) : undefined,
          options: (err['options'] as Record<string, unknown> | undefined),
          sourceInstanceId: this.instanceId,
        });
        return;
      }
      this._sendTo(replyWindow, {
        is_agent_router: true, type: MSG.TASK_RESULT, taskId, result: null,
        error: err.message ?? 'Tool execution failed', sourceInstanceId: this.instanceId,
      });
    }
  }

  /** @private 处理 agent_task_result：resolve origin 任务或向上游中继。 */
  private _handleTaskResult(msg: RouterMessage, sourceWindow: WindowProxy | NPLWindowProxy): void {
    const { taskId = '', result, error } = msg;
    const record = this.taskRegistry.get(taskId);
    if (!record) { console.warn(`[AgentRouter] _handleTaskResult dropped taskId=${taskId}: no task record`); return; }
    if (!this._isExpectedTaskSource(record, sourceWindow)) { console.warn(`[AgentRouter] _handleTaskResult dropped taskId=${taskId}: unexpected source`); return; }

    if (record.kind === 'origin') {
      const cleared = this._clearTask(taskId, 'result') as OriginTaskRecord | null;
      if (!cleared) return;
      if (error) {
        if (msg.isRestartAgentSignal) {
          cleared.reject({ promptFile: msg.promptFile, tools: msg.tools, options: msg.options, isRestartAgentSignal: true });
        } else {
          cleared.reject(new Error(error));
        }
      } else {
        cleared.resolve(result);
      }
    } else {
      this._clearTask(taskId, 'result');
      this._sendTo((record as RelayTaskRecord).replyWindow, msg);
    }
  }

  /** @private 处理 agent_stream：转发给 origin 回调或向上游中继。 */
  private _handleStream(msg: RouterMessage, sourceWindow: WindowProxy | NPLWindowProxy): void {
    const { taskId = '' } = msg;
    const record = this.taskRegistry.get(taskId);
    if (!record) { console.warn(`[AgentRouter] _handleStream dropped taskId=${taskId}: no task record`); return; }
    if (!this._isExpectedTaskSource(record, sourceWindow)) return;

    if (record.kind === 'origin') {
      record.onStream?.(msg);
    } else {
      this._sendTo((record as RelayTaskRecord).replyWindow, msg);
    }
  }

  /** @private 处理 agent_sync_ack：响应或确认同步。 */
  private _handleSyncAck(msg: RouterMessage, sourceWindow: WindowProxy | NPLWindowProxy): void {
    if (msg.request) {
      this._sendTo(sourceWindow, { is_agent_router: true, type: MSG.SYNC_ACK, syncId: msg.syncId, instanceId: this.instanceId, request: false });
    } else {
      const cb = this._pendingSyncs.get(msg.syncId ?? '');
      if (cb) { cb(); this._pendingSyncs.delete(msg.syncId ?? ''); }
    }
  }

  // ─────────────────────── 任务注册表 ───────────────────────

  /** @private 创建 origin 任务记录（带超时自动拒绝）。 */
  private _createOriginTask(
    taskId: string, agentName: string, outboundWindow: WindowProxy | NPLWindowProxy,
    onStream: ((msg: RouterMessage) => void) | null,
    resolve: (value: unknown) => void, reject: (reason: unknown) => void
  ): OriginTaskRecord {
    const timeoutMs = this._sdk?.timeout ?? DEFAULT_TASK_TIMEOUT_MS;
    const timeoutId = setTimeout(() => {
      if (!this.taskRegistry.has(taskId)) return;
      this._clearTask(taskId, 'timeout');
      reject(new Error(`Remote agent '${agentName}' task timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const record: OriginTaskRecord = { kind: 'origin', agentName, createdAt: Date.now(), outboundWindow, replyWindow: null, onStream, resolve, reject, timeoutId };
    this.taskRegistry.set(taskId, record);
    this._indexWindowTask(outboundWindow, taskId);
    return record;
  }

  /** @private 创建 relay 任务记录（转发上游任务）。 */
  private _createRelayTask(
    taskId: string, agentName: string,
    outboundWindow: WindowProxy | NPLWindowProxy,
    replyWindow: WindowProxy | NPLWindowProxy
  ): RelayTaskRecord {
    const record: RelayTaskRecord = { kind: 'relay', agentName, createdAt: Date.now(), outboundWindow, replyWindow, onStream: null, resolve: null, reject: null, timeoutId: null };
    this.taskRegistry.set(taskId, record);
    this._indexWindowTask(outboundWindow, taskId);
    return record;
  }

  /**
   * @private 幂等移除任务：清理超时、删除 window 索引，返回被删除的记录（已删除返回 null）。
   */
  private _clearTask(taskId: string, reason: string): TaskRecord | null {
    const record = this.taskRegistry.get(taskId);
    if (!record) return null;
    this.taskRegistry.delete(taskId);
    if (record.timeoutId !== null) clearTimeout(record.timeoutId as ReturnType<typeof setTimeout>);
    if (record.outboundWindow) this.windowTasks.get(record.outboundWindow)?.delete(taskId);
    AgentRouter._log(`[AgentRouter] _clearTask taskId=${taskId} reason=${reason} kind=${record.kind}`);
    return record;
  }

  // ─────────────────────── Window 索引 ───────────────────────

  private _indexWindowAgent(windowRef: WindowProxy | NPLWindowProxy, agentName: string): void {
    if (!windowRef) return;
    let set = this.windowAgents.get(windowRef);
    if (!set) { set = new Set(); this.windowAgents.set(windowRef, set); }
    set.add(agentName);
  }

  private _indexWindowTask(windowRef: WindowProxy | NPLWindowProxy, taskId: string): void {
    if (!windowRef) return;
    let set = this.windowTasks.get(windowRef);
    if (!set) { set = new Set(); this.windowTasks.set(windowRef, set); }
    set.add(taskId);
  }

  private _isExpectedTaskSource(record: TaskRecord, sourceWindow: WindowProxy | NPLWindowProxy): boolean {
    return record?.outboundWindow === sourceWindow;
  }

  /**
   * @private 断开 window 时的确定性清理：
   * 1. 从 connectedWindows 删除
   * 2. 删除该 window 持有的所有路由，广播 UNREGISTER
   * 3. 失败该 window 关联的所有任务（origin reject / relay 通知上游）
   */
  private _cleanupWindow(windowRef: WindowProxy | NPLWindowProxy, shouldBroadcast: boolean): void {
    if (!windowRef) return;
    this.connectedWindows.delete(windowRef);

    const agentNames = this.windowAgents.get(windowRef) ?? new Set<string>();
    for (const agentName of agentNames) {
      if (this.routeTable.has(agentName)) {
        this.routeTable.delete(agentName);
        if (shouldBroadcast) {
          this._broadcast({ is_agent_router: true, type: MSG.UNREGISTER, agentName, instanceId: this.instanceId }, windowRef);
        }
      }
    }
    this.windowAgents.delete(windowRef);

    const taskIds = this.windowTasks.get(windowRef) ?? new Set<string>();
    for (const taskId of [...taskIds]) {
      const record = this.taskRegistry.get(taskId);
      if (!record) continue;
      const errMsg = `Route window disconnected for agent '${record.agentName}'`;
      if (record.kind === 'origin') {
        const cleared = this._clearTask(taskId, 'window-disconnect') as OriginTaskRecord | null;
        cleared?.reject(new Error(errMsg));
      } else {
        this._sendTo(record.replyWindow, { is_agent_router: true, type: MSG.TASK_RESULT, taskId, result: null, error: errMsg, sourceInstanceId: this.instanceId });
        this._clearTask(taskId, 'window-disconnect');
      }
    }
    this.windowTasks.delete(windowRef);
  }

  /**
   * @private 将已知的所有 agent（本地 + 路由表）同步到指定 window。
   * backfill 消息携带 syncBackfill:true，防止接收方递归回传。
   */
  private _syncKnownAgentsToWindow(
    windowRef: WindowProxy | NPLWindowProxy,
    excludeAgentName?: string,
    excludeInstanceId?: string
  ): void {
    for (const [agentName] of this.localAgents) {
      if (agentName === excludeAgentName && this.instanceId === excludeInstanceId) continue;
      this._sendTo(windowRef, { is_agent_router: true, type: MSG.REGISTER, agentName, instanceId: this.instanceId, syncBackfill: true });
    }
    for (const [agentName, route] of this.routeTable) {
      if (agentName === excludeAgentName && route.sourceInstanceId === excludeInstanceId) continue;
      this._sendTo(windowRef, { is_agent_router: true, type: MSG.REGISTER, agentName, instanceId: route.sourceInstanceId, syncBackfill: true });
    }
  }

  /**
   * @private 带重试的 agent 同步（Phase 1 快速重试 ~5s，Phase 2 每 5s 一次）。
   * 子窗口确认后停止。
   */
  private _syncWithRetry(windowRef: WindowProxy | NPLWindowProxy): void {
    const syncId = generateUUID();
    let attempt = 0;
    let confirmed = false;
    const PHASE1 = [200, 400, 600, 800, 1000, 1000];
    const PHASE2 = 5000;

    this._pendingSyncs.set(syncId, () => { confirmed = true; });

    const doSync = (): void => {
      if (confirmed || !this.connectedWindows.has(windowRef)) { this._pendingSyncs.delete(syncId); return; }
      attempt++;
      this._syncKnownAgentsToWindow(windowRef);
      this._sendTo(windowRef, { is_agent_router: true, type: MSG.SYNC_ACK, syncId, instanceId: this.instanceId, request: true });
      const next = attempt <= PHASE1.length ? PHASE1[attempt - 1]! : PHASE2;
      setTimeout(doSync, next);
    };
    doSync();
  }

  /** @private 广播 window_disconnect 通知（幂等）。 */
  private _announceWindowDisconnect(): void {
    if (this._disconnectAnnounced) return;
    this._disconnectAnnounced = true;
    this._broadcast({ is_agent_router: true, type: MSG.WINDOW_DISCONNECT, instanceId: this.instanceId }, null);
  }

  /** @private 页面生命周期钩子：pagehide 时销毁（bfcache 保留的页面除外）。 */
  private _handleLifecycleTeardown(event: Event): void {
    if (event.type === 'pagehide' && (event as PageTransitionEvent).persisted) return;
    this.destroy();
  }
}

export default AgentRouter;
export { NPLWindowProxy };
