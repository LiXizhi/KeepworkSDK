/**
 * SandboxToolEnv.ts — 工具沙箱执行环境（TypeScript 版）
 *
 * 为 AI 会话提供一个受控的工具执行上下文，包含：
 * - `copilot` 代理对象：通过属性访问调用任意已注册工具
 * - `processTemplate()`：展开 `${...}` 模板表达式
 * - `registerAPI()`：注册自定义 API（优先于 CopilotTools）
 * - 工具代理路由（toolProxy）：将指定工具委托给远程 agent
 * - 远程 agent 模式（remoteAgent）：所有工具调用发往远程 agent
 *
 * ## 使用示例
 * ```ts
 * const sandbox = new SandboxToolEnv(sdk, {
 *   workspace: 'myApp',
 *   enabledCategories: ['fileOps', 'execute', 'agent'],
 * });
 * sandbox.registerAPI('get_weather', async (city) => fetchWeather(city));
 * const expanded = await sandbox.processTemplate(
 *   'Current time: ${new Date().toLocaleString()}'
 * );
 * ```
 */

// AsyncFunction 构造器
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => (...params: unknown[]) => Promise<unknown>;

// ──────────────────── RestartAgentSignal ────────────────────

/**
 * 由 `copilot.restartAgent()` 在 `processTemplate()` 内部抛出的哨兵错误。
 * 调用方（如 DigitalHuman._sendViaText）捕获此信号后触发 agent 会话重启。
 */
export class RestartAgentSignal {
  readonly promptFile: string | null | undefined;
  readonly tools: string[] | undefined;
  readonly options: Record<string, unknown> | undefined;
  /** 便于跨 iframe 传递时识别此信号类型 */
  readonly isRestartAgentSignal = true;

  /**
   * @param promptFile - 新会话要加载的配置文件 URL 或路径（null/undefined 表示使用默认）
   * @param tools      - 新会话启用的工具分类列表（undefined 表示继承）
   * @param options    - 高级重启选项（minigameSlot / frameOptions 等）
   */
  constructor(
    promptFile?: string | null,
    tools?: string[],
    options?: Record<string, unknown>
  ) {
    this.promptFile = promptFile;
    this.tools = Array.isArray(tools) ? tools : undefined;
    this.options = options && typeof options === 'object' ? options : undefined;
  }
}

// ──────────────────── 类型定义 ────────────────────

/** 工具代理路由配置 */
export interface ToolProxyRoute {
  /** 目标 agent 名称 */
  agent: string;
  /** 可选：任务描述 */
  task?: string;
}

/** SandboxToolEnv 构造选项 */
export interface SandboxToolEnvOptions {
  /** 文件操作工作空间名（对应 personalPageStore 的 workspace 参数） */
  workspace?: string;
  /** 只读回退目录（挂载的外部公开文件夹） */
  mountFolder?: unknown;
  /** 启用的 CopilotTools 分类（默认 ['fileOps', 'execute']） */
  enabledCategories?: string[];
  /** 远程 agent 名称（设置后所有工具调用委托给该 agent） */
  remoteAgent?: string;
  /** 远程模式下授权的工具分类列表 */
  categories?: string[];
  /** 工具代理路由配置 */
  toolProxy?: {
    /** 按函数名代理：`{ 'read_file': { agent: 'fileAgent' } }` */
    functions?: Record<string, ToolProxyRoute>;
    /** 按分类代理：`{ 'fileOps': { agent: 'fileAgent' } }` */
    categories?: Record<string, ToolProxyRoute>;
  };
  /** 关联的 ChatSession（允许工具通过 config._session 访问） */
  session?: AgentSessionRef;
}

/** ChatSession 最小接口（避免循环引用） */
interface AgentSessionRef {
  name?: string;
  workspace?: string;
  _restartSignal?: unknown;
  sandbox?: unknown;
  [key: string]: unknown;
}

/** SDK 最小接口 */
interface SDKRef {
  copilotTools?: {
    execute: (name: string, args: unknown, config: unknown) => Promise<unknown>;
    getToolDefinitions: (categories: string[]) => unknown[];
    _fnNameToCategory?: Record<string, string>;
    _registry?: Record<string, { disableAutoProxy?: boolean }>;
  };
  agentRouter?: {
    hasAgent: (name: string) => boolean;
    waitForAgent: (name: string) => Promise<void>;
    submitTask: (name: string, payload: unknown) => Promise<unknown>;
  };
}

// ──────────────────── SandboxToolEnv ────────────────────

class SandboxToolEnv {
  readonly sdk: SDKRef;
  workspace: string;
  mountFolder: unknown;
  enabledCategories: string[];
  session: AgentSessionRef | null;
  remoteAgent: string | null;
  categories: string[];

  _activePromptFile: string | null = null;
  _templateSourceFile: string | null = null;

  private _customAPIs: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  private _copilotProxy: Record<string, unknown> | null = null;
  private _toolProxy: SandboxToolEnvOptions['toolProxy'] | null;
  private _cachedDefinitions: unknown[] | null = null;

  constructor(sdk: SDKRef, options: SandboxToolEnvOptions = {}) {
    this.sdk = sdk;
    this.workspace = options.workspace ?? '';
    this.mountFolder = options.mountFolder ?? null;
    this.enabledCategories = options.enabledCategories ?? ['fileOps', 'execute'];
    this._toolProxy = options.toolProxy ?? null;
    this.session = options.session ?? null;
    this.remoteAgent = options.remoteAgent ?? null;
    this.categories = options.categories ?? [];
  }

  // ──────────────────── 公共 API ────────────────────

  /**
   * copilot 代理对象：通过属性访问（如 `copilot.read_file(...)`）调用任意工具。
   * 解析顺序：自定义 API → 工具代理（toolProxy）→ CopilotTools 内置工具。
   */
  get copilot(): Record<string, (...args: unknown[]) => Promise<string>> {
    if (!this._copilotProxy) this._copilotProxy = this._buildProxy();
    return this._copilotProxy as Record<string, (...args: unknown[]) => Promise<string>>;
  }

  /**
   * 注册自定义可调用 API（优先于同名 CopilotTools 工具）。
   * 注册后 `copilot.myTool(args)` 将直接调用此函数。
   *
   * @param name - 工具/函数名称
   * @param fn   - 异步回调函数 `(...args) => result`
   */
  registerAPI(name: string, fn: (...args: unknown[]) => Promise<unknown>): void {
    if (typeof name !== 'string' || !name) throw new Error('registerAPI: name must be a non-empty string');
    if (typeof fn !== 'function') throw new Error('registerAPI: fn must be a function');
    this._customAPIs[name] = fn;
    this._copilotProxy = null; // 重置代理缓存
  }

  /**
   * 执行指定工具。
   * - 远程 agent 模式：委托给 remoteAgent
   * - 自定义 API：直接调用
   * - 工具代理：通过 AgentRouter 路由到远程 agent
   * - 内置工具：调用 sdk.copilotTools.execute
   *
   * @param fnName     - 工具/函数名称
   * @param fnArgs     - 参数对象
   * @param extraConfig - 附加配置（如 { _session }）
   */
  async execute(fnName: string, fnArgs: unknown, extraConfig: Record<string, unknown> = {}): Promise<unknown> {
    if (this.remoteAgent) {
      const result = await this._executeRemote(fnName, fnArgs);
      return this._normalizeToolResult(result);
    }

    if (this._customAPIs[fnName]) return this._customAPIs[fnName](fnArgs);

    const proxyRoute = this._resolveToolProxy(fnName);
    if (proxyRoute) {
      try {
        const result = await this._executeViaProxy(fnName, fnArgs, proxyRoute);
        return this._normalizeToolResult(result);
      } catch (e) {
        if (e && (e as Record<string, unknown>)['isRestartAgentSignal']) {
          if (this.session) this.session['_restartSignal'] = e;
          throw e;
        }
        throw e;
      }
    }

    if (!this.sdk?.copilotTools?.execute) throw new Error('CopilotTools not available on the SDK instance');
    const options: Record<string, unknown> = { ...extraConfig };
    if (this.workspace) options['workspace'] = this.workspace;
    if (this.mountFolder) options['mountFolder'] = this.mountFolder;
    if (this.session && !options['_session']) options['_session'] = this.session;
    return this.sdk.copilotTools.execute(fnName, fnArgs, options);
  }

  /**
   * 获取已启用分类的 OpenAI 格式工具定义。
   * 远程 agent 模式下从远端获取（带缓存）。
   *
   * @param forceRefresh - 是否强制刷新远程缓存（默认 false）
   */
  getToolDefinitions(forceRefresh = false): Promise<unknown[]> | unknown[] {
    if (this.remoteAgent) return this._getRemoteToolDefinitions(forceRefresh);
    if (!this.sdk?.copilotTools?.getToolDefinitions) return [];
    return this.sdk.copilotTools.getToolDefinitions(this.enabledCategories);
  }

  /** 检查沙箱是否可用（远程模式下检查 agent 是否已连接）。 */
  isAvailable(): boolean {
    if (!this.remoteAgent) return true;
    return !!(this.sdk?.agentRouter?.hasAgent(this.remoteAgent));
  }

  /** 从远程 agent 获取所有可用工具分类列表。 */
  async getCategories(): Promise<unknown> {
    return this._submitRemoteTask({ action: 'getCategories' });
  }

  /**
   * 批量顺序执行工具调用，收集所有结果。
   *
   * @param calls - 工具调用列表 `[{ tool, args }]`
   */
  async executeBatch(calls: Array<{ tool: string; args?: unknown }> = []): Promise<Array<{ tool: string; success: boolean; result?: unknown; error?: string }>> {
    const results = [];
    for (const call of calls) {
      try {
        const result = await this.execute(call.tool, call.args ?? {});
        results.push({ tool: call.tool, success: true, result });
      } catch (e) {
        results.push({ tool: call.tool, success: false, error: (e as Error).message });
      }
    }
    return results;
  }

  /** 清除远程工具定义缓存。 */
  clearCache(): void {
    this._cachedDefinitions = null;
  }

  /**
   * 在沙箱上下文中运行任意 async JavaScript 代码。
   * 代码可访问 `copilot` 代理和 `context` 中的所有键。
   *
   * @param code    - 要执行的 JavaScript 代码字符串
   * @param context - 注入到执行上下文的变量映射
   */
  async runCode(code: string, context: Record<string, unknown> = {}): Promise<unknown> {
    if (typeof code !== 'string' || !code.trim()) return undefined;
    const executionContext = this._createRunCodeContext(context);
    const argNames = Object.keys(executionContext);
    const argValues = argNames.map((name) => executionContext[name]);
    const runner = this._createCodeRunner(code, argNames);
    return runner(...argValues);
  }

  // ──────────────────── 模板引擎 ────────────────────

  /**
   * 展开文本中的 `${...}` 模板表达式。
   * 表达式可使用 `copilot` 代理和 `await`。
   * 支持最多 3 层嵌套递归展开。
   * 表达式执行出错时保留原始 `${...}` 标记不变。
   *
   * 示例：
   * ```ts
   * const result = await sandbox.processTemplate(
   *   'Notes: ${await copilot.read_file("notes.md", 1, 50)}'
   * );
   * ```
   *
   * @param text   - 包含 `${...}` 表达式的模板字符串
   * @param _depth - 内部递归深度计数器（请勿手动传入）
   */
  async processTemplate(text: string, _depth = 0): Promise<string> {
    const MAX_DEPTH = 3;
    if (!text) return text;

    // 支持 `/promptfile` 简写
    text = text.replace(/^(\s*)\/(\S+)/, '$1${await copilot.read_file("$2", 1, -1, true)}');
    // 反转义：\${...} → ${...}
    text = text.replace(/\\\$\{/g, '${');
    if (!text.includes('${')) return text;

    // 用括号计数扫描所有 ${...} 匹配（支持嵌套括号）
    interface TemplateMatch { start: number; end: number; fullMatch: string; expr: string }
    const matches: TemplateMatch[] = [];
    const regex = /\$\{/g;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(text)) !== null) {
      const startIdx = m.index;
      let depth = 1, i = startIdx + 2;
      while (i < text.length && depth > 0) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}') depth--;
        i++;
      }
      if (depth === 0) {
        const fullMatch = text.substring(startIdx, i);
        const expr = text.substring(startIdx + 2, i - 1);
        matches.push({ start: startIdx, end: i, fullMatch, expr });
        regex.lastIndex = i;
      }
    }
    if (matches.length === 0) return text;

    const resolved: string[] = [];
    for (const { fullMatch, expr } of matches) {
      try {
        const result = await this.runCode(expr);
        if (result && (result as Record<string, unknown>)['isRestartAgentSignal']) throw result;
        let value = result != null ? String(result) : '';
        if (_depth < MAX_DEPTH && value.includes('${')) {
          value = await this.processTemplate(value, _depth + 1);
        }
        resolved.push(value);
      } catch (e) {
        if (e && (e as Record<string, unknown>)['isRestartAgentSignal']) throw e;
        console.warn('[SandboxToolEnv] Template expression error:', expr, e);
        resolved.push(fullMatch);
      }
    }

    let result = text;
    for (let i = matches.length - 1; i >= 0; i--) {
      result = result.substring(0, matches[i]!.start) + resolved[i] + result.substring(matches[i]!.end);
    }
    return result;
  }

  // ──────────────────── 私有方法 ────────────────────

  /** @private 解析函数名对应的工具代理路由。 */
  private _resolveToolProxy(fnName: string): ToolProxyRoute | null {
    if (!this._toolProxy) return null;
    const fnProxy = this._toolProxy.functions?.[fnName];
    if (fnProxy?.agent) return fnProxy;
    if (this._toolProxy.categories && this.sdk?.copilotTools) {
      const categoryName = this.sdk.copilotTools._fnNameToCategory?.[fnName];
      if (categoryName && !this.sdk.copilotTools._registry?.[categoryName]?.disableAutoProxy) {
        const catProxy = this._toolProxy.categories[categoryName];
        if (catProxy?.agent) return catProxy;
      }
    }
    return null;
  }

  /** @private 通过 AgentRouter 将工具调用代理给远程 agent（绕过 LLM）。 */
  private async _executeViaProxy(fnName: string, fnArgs: unknown, route: ToolProxyRoute): Promise<unknown> {
    const router = this.sdk?.agentRouter;
    if (!router) throw new Error(`[SandboxToolEnv] AgentRouter not available — cannot proxy ${fnName} to agent '${route.agent}'`);
    await router.waitForAgent(route.agent);
    return router.submitTask(route.agent, { toolCallOnly: true, fnName, fnArgs });
  }

  /** @private 从远程 agent 获取工具定义（带缓存）。 */
  private async _getRemoteToolDefinitions(forceRefresh = false): Promise<unknown[]> {
    if (this._cachedDefinitions && !forceRefresh) return this._cachedDefinitions;
    const result = await this._submitRemoteTask({ action: 'getToolDefinitions', categories: this.categories });
    this._cachedDefinitions = result as unknown[];
    return this._cachedDefinitions;
  }

  /** @private 在远程 agent 模式下执行工具调用。 */
  private async _executeRemote(toolName: string, args: unknown): Promise<unknown> {
    const payload: Record<string, unknown> = { action: 'executeTool', tool: toolName, args, categories: this.categories };
    if (this.workspace) payload['workspace'] = this.workspace;
    return this._submitRemoteTask(payload);
  }

  /** @private 向远程 agent 提交任务（via AgentRouter.submitTask）。 */
  private async _submitRemoteTask(payload: unknown): Promise<unknown> {
    const router = this.sdk?.agentRouter;
    if (!router || !router.hasAgent(this.remoteAgent!)) {
      throw new Error(`Agent '${this.remoteAgent}' not available. Is the remote side connected?`);
    }
    return router.submitTask(this.remoteAgent!, payload);
  }

  /** @private 将任意工具执行结果规范化为字符串。 */
  private _normalizeToolResult(result: unknown): string {
    if (result == null) return '';
    if (typeof result === 'string') return result;
    if (typeof result === 'object') {
      const r = result as Record<string, unknown>;
      if (r['llm_result'] != null) return String(r['llm_result']);
      if (r['result'] != null) return String(r['result']);
      return JSON.stringify(result);
    }
    return String(result);
  }

  /** @private 构建 runCode 的执行上下文（注入 copilot 代理和 context 键）。 */
  private _createRunCodeContext(context: Record<string, unknown>): Record<string, unknown> {
    const executionContext: Record<string, unknown> = { context };
    for (const [key, value] of Object.entries(context)) {
      if (key !== 'context' && this._isValidIdentifier(key)) executionContext[key] = value;
    }
    if (!Object.prototype.hasOwnProperty.call(executionContext, 'copilot')) {
      executionContext['copilot'] = this.copilot;
    }
    return executionContext;
  }

  /** @private 将代码包装为 AsyncFunction（优先尝试表达式形式，回退语句形式）。 */
  private _createCodeRunner(code: string, argNames: string[]): (...args: unknown[]) => Promise<unknown> {
    try {
      return new AsyncFunction(...argNames, '"use strict";\nreturn (\n' + code + '\n);');
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    return new AsyncFunction(...argNames, '"use strict";\n' + code);
  }

  /** @private 检查字符串是否为合法 JS 标识符（用于安全注入执行上下文）。 */
  private _isValidIdentifier(name: string): boolean {
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);
  }

  /**
   * @private 构建 copilot Proxy——将属性访问映射到工具调用。
   * 内置常用工具（read_file / list_dir 等）的位置参数自动转换为命名参数。
   */
  private _buildProxy(): Record<string, unknown> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return new Proxy({} as Record<string, unknown>, {
      get(_target, toolName: string | symbol): unknown {
        if (typeof toolName !== 'string') return undefined;
        return async (...args: unknown[]): Promise<string> => {
          if (self._customAPIs[toolName]) {
            try {
              const result = await self._customAPIs[toolName]!(...args);
              return result != null ? String(result) : '';
            } catch (e) {
              console.warn(`[SandboxToolEnv] Custom API ${toolName} error:`, (e as Error).message);
              return '';
            }
          }

          let params: unknown;
          const isNamedCall =
            args.length === 1 &&
            typeof args[0] === 'object' &&
            args[0] !== null &&
            !Array.isArray(args[0]);

          if (isNamedCall) {
            params = args[0];
          } else if (toolName === 'read_file') {
            const p: Record<string, unknown> = { filePath: args[0], startLine: args[1] ?? 1, endLine: args[2] ?? 200 };
            if (args[3] !== undefined) p['allowScript'] = !!args[3];
            params = p;
          } else if (toolName === 'list_dir') {
            params = { path: args[0] ?? '' };
          } else if (toolName === 'load_minigame') {
            const p: Record<string, unknown> = { relativePath: args[0] };
            if (args[1] !== undefined) p['width'] = args[1];
            if (args[2] !== undefined) p['height'] = args[2];
            params = p;
          } else if (toolName === 'restartAgent') {
            const p: Record<string, unknown> = { promptFile: args[0] };
            if (Array.isArray(args[1])) p['tools'] = args[1];
            if (args[2] && typeof args[2] === 'object' && !Array.isArray(args[2])) p['options'] = args[2];
            params = p;
          } else if (args.length === 0) {
            params = {};
          } else {
            params = { args };
          }

          const proxyRoute = self._resolveToolProxy(toolName);
          if (proxyRoute) {
            try {
              const result = await self._executeViaProxy(toolName, params, proxyRoute);
              return self._normalizeToolResult(result);
            } catch (e) {
              if (e && (e as Record<string, unknown>)['isRestartAgentSignal']) {
                if (self.session) self.session['_restartSignal'] = e;
                throw e;
              }
              console.warn(`[SandboxToolEnv] proxy ${toolName} → ${proxyRoute.agent} error:`, (e as Error).message);
              return '';
            }
          }

          if (!self.sdk?.copilotTools?.execute) {
            console.warn('[SandboxToolEnv] copilotTools not available for:', toolName);
            return '';
          }
          const options: Record<string, unknown> = self.workspace ? { workspace: self.workspace } : {};
          if (self.session) options['_session'] = self.session;
          try {
            const result = await self.sdk.copilotTools.execute(toolName, params, options);
            return result != null ? String(result) : '';
          } catch (e) {
            if (e && (e as Record<string, unknown>)['isRestartAgentSignal']) throw e;
            console.warn(`[SandboxToolEnv] copilot.${toolName} error:`, (e as Error).message);
            return '';
          }
        };
      },
    });
  }
}

export default SandboxToolEnv;
