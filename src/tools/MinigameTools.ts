/**
 * MinigameTools.ts — 小游戏 iframe 覆盖层管理工具（TypeScript 完整实现）
 *
 * 向 LLM 暴露两个工具：
 * - `load_minigame`：将工作空间相对路径的 HTML 加载到 iframe 覆盖层
 * - `configure_minigame`：运行时更新 iframe 外观（位置/大小/标题栏等）
 *
 * 特性：
 * - 多 slot 并发（每个 slot 独立 iframe + z-index）
 * - 拖拽标题栏、关闭按钮
 * - postMessage 双向通信 + gameLoaded / gameFinished 生命周期事件
 * - persistKey 防止重复加载同一游戏
 * - backdrop 遮罩层支持
 * - 前景元素提升（setSlotForegroundElements）
 * - 与 DigitalHuman 集成（launchSkill / openSkill 消息桥）
 */

import SDKLogger from '../utils/SDKLogger';

const console = SDKLogger.createModuleConsole('MinigameTools');

// ──────────────────── 常量 ────────────────────

const LOAD_TIMEOUT_MS = 10_000;
const OPEN_SKILL_MESSAGE = 'keepwork:minigame:openSkill';
const CLOSE_MESSAGE = 'keepwork:minigame:close';
const Z_INDEX_STEP = 20;

// ──────────────────── 类型 ────────────────────

/** OpenAI Function Calling 工具定义 */
export interface ToolDefinition {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

/** 帧外观选项（load_minigame / configure_minigame 参数） */
export interface FrameOptions {
  width?: number | string;
  height?: number | string;
  left?: string;
  top?: string;
  right?: string;
  bottom?: string;
  zIndex?: number;
  showTitleBar?: boolean;
  showCloseButton?: boolean;
  titleText?: string;
  borderRadius?: string;
  boxShadow?: string;
  background?: string;
  backdrop?: string | boolean;
  slot?: string;
  layout?: string;
  preset?: string;
  frameOptions?: FrameOptions;
  [key: string]: unknown;
}

/** Slot 内部数据结构 */
interface Slot {
  name: string;
  container: HTMLDivElement;
  iframe: HTMLIFrameElement;
  title: HTMLSpanElement;
  header: HTMLDivElement;
  closeBtn: HTMLButtonElement;
  persistKey: string | null;
  defaultFrameOptions: FrameOptions | null;
  backdropEl: HTMLDivElement | null;
  foregroundElements?: Array<{ element: HTMLElement; style: { position: string; zIndex: string; isolation: string } }> | null;
  foregroundOptions?: Record<string, unknown> | null;
}

/** Slot 会话信息 */
export interface SlotSession {
  slot: string;
  parentSlot: string | null;
  promptFile: string;
  tools?: string[];
  parentPromptFile: string;
  parentTools?: string[];
  root: boolean;
  restorePolicy: string;
  closePolicy: string;
  frameOptions: FrameOptions | null;
  title: string;
  sourceSlot: string;
  openedAt: number;
  preload: boolean;
  revealed: boolean;
  [key: string]: unknown;
}

/** MinigameTools 构造选项 */
export interface MinigameToolsOptions {
  width?: number;
  height?: number;
  zIndex?: number;
  containerId?: string;
  onEvent?: (data: Record<string, unknown>) => void;
  log?: (msg: string) => void;
}

/** openSlotSession 选项 */
export interface OpenSlotSessionOptions extends FrameOptions {
  slot?: string;
  root?: boolean;
  parentSlot?: string;
  sourceSlot?: string;
  promptFile?: string;
  skillPath?: string;
  tools?: string[];
  parentPromptFile?: string;
  parentTools?: string[];
  restorePolicy?: string;
  closePolicy?: string;
  gameTitle?: string;
  title?: string;
  preload?: boolean;
  foregroundElements?: HTMLElement | HTMLElement[] | string | string[];
  foregroundOptions?: Record<string, unknown>;
  autoContinue?: boolean;
  [key: string]: unknown;
}

/** SDK 最小接口 */
interface SDKRef {
  copilotTools?: {
    registerToolCategory?: (name: string, entry: Record<string, unknown>) => void;
    resolveEnabledCategories?: (tools: Record<string, unknown>) => string[];
  };
  personalPageStore?: {
    withConfig: (config: Record<string, unknown>) => { getAbsUrl: (path: string) => string; workspace?: string; mountedFolder?: unknown };
  };
  getToken?: () => string;
  constructor?: { source?: string; sourceIsModule?: boolean };
  token?: string | null;
  __minigameTools?: MinigameTools;
  [key: string]: unknown;
}

// ──────────────────── 工具定义 ────────────────────

const FRAME_OPTION_PROPS: Record<string, ToolDefinition['function']['parameters']['properties']> = {
  width:           { type: ['number', 'string'], description: 'Container width. Number = pixels (default 500). String = any CSS length, e.g. "100vw", "80%", "600px".' },
  height:          { type: ['number', 'string'], description: 'Container height. Number = pixels (default 600). String = any CSS length, e.g. "100vh", "80%", "600px".' },
  left:            { type: 'string',  description: 'CSS left value, e.g. "100px" or "10%". Overrides centering.' },
  top:             { type: 'string',  description: 'CSS top value, e.g. "50px" or "5%". Overrides centering.' },
  right:           { type: 'string',  description: 'CSS right value, e.g. "20px". Clears left when set.' },
  bottom:          { type: 'string',  description: 'CSS bottom value, e.g. "20px". Clears top when set.' },
  zIndex:          { type: 'number',  description: 'CSS z-index for the overlay (default 9999).' },
  showTitleBar:    { type: 'boolean', description: 'Whether to show the draggable title bar (default true).' },
  showCloseButton: { type: 'boolean', description: 'Whether to show the close button in the title bar (default true).' },
  titleText:       { type: 'string',  description: 'Custom title text for the title bar.' },
  borderRadius:    { type: 'string',  description: 'CSS border-radius, e.g. "0" for sharp corners (default "12px").' },
  boxShadow:       { type: 'string',  description: 'CSS box-shadow, e.g. "none" to remove shadow.' },
  background:      { type: 'string',  description: 'CSS background, e.g. "transparent" or "none" (default "#ffffff").' },
} as unknown as Record<string, ToolDefinition['function']['parameters']['properties']>;

const DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'load_minigame',
      description: 'Load a minigame HTML page into an iframe overlay. Returns a status message.',
      parameters: {
        type: 'object',
        properties: {
          relativePath: { type: 'string', description: 'Workspace-relative path to the minigame HTML file, e.g. "skills/memory-practice/index.html"' },
          width: FRAME_OPTION_PROPS['width']!,
          height: FRAME_OPTION_PROPS['height']!,
          persistKey: { type: 'string', description: 'When provided, subsequent load_minigame calls with the same persistKey skip iframe reload if the game is already visible.' },
        },
        required: ['relativePath'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'configure_minigame',
      description: 'Update the minigame frame appearance at runtime (position, size, chrome). Only effective when a minigame is loaded.',
      parameters: { type: 'object', properties: FRAME_OPTION_PROPS as Record<string, unknown> },
    },
  },
];

// ──────────────────── MinigameTools ────────────────────

/**
 * MinigameTools — 小游戏 iframe 管理工具（供 CopilotTools 注册为 'minigame' 分类）。
 *
 * 使用工厂方法创建实例：
 * ```ts
 * const minigame = MinigameTools.register(sdk, { onEvent: (d) => console.log(d) });
 * ```
 */
export default class MinigameTools {
  static readonly definitions = DEFINITIONS;

  readonly sdk: SDKRef;
  defaultWidth: number;
  defaultHeight: number;
  zIndex: number;
  containerId: string;

  private _listeners = new Set<(data: Record<string, unknown>) => void>();
  private _log: ((msg: string) => void) | null;
  private _slots = new Map<string, Slot>();
  private _slotSessions = new Map<string, SlotSession>();
  private _sessionStack: string[] = [];
  private _launchHost: { launchSkill?: (promptFile: string, opts: Record<string, unknown>) => Promise<void> } | null = null;
  private _zIndexCursor: number;
  private _activeSlot = 'default';
  _defaultSlot: string | null = null;
  private _msgListener: ((e: MessageEvent) => void) | null = null;

  constructor(sdk: SDKRef, options: MinigameToolsOptions = {}) {
    if (!sdk) throw new Error('MinigameTools requires a KeepworkSDK instance');
    this.sdk = sdk;
    this.defaultWidth = Number(options.width) || 500;
    this.defaultHeight = Number(options.height) || 600;
    this.zIndex = Number(options.zIndex) || 9999;
    this.containerId = options.containerId ?? 'keepwork-minigame-container';
    if (typeof options.onEvent === 'function') this._listeners.add(options.onEvent);
    this._log = typeof options.log === 'function' ? options.log : null;
    this._zIndexCursor = this.zIndex;
  }

  // ── 向后兼容 getters（代理到 active slot） ──
  get _container(): HTMLDivElement | null { return this._getActiveSlotField('container') as HTMLDivElement | null; }
  get _iframe(): HTMLIFrameElement | null { return this._getActiveSlotField('iframe') as HTMLIFrameElement | null; }
  get _title(): HTMLSpanElement | null { return this._getActiveSlotField('title') as HTMLSpanElement | null; }
  get _header(): HTMLDivElement | null { return this._getActiveSlotField('header') as HTMLDivElement | null; }
  get _closeBtn(): HTMLButtonElement | null { return this._getActiveSlotField('closeBtn') as HTMLButtonElement | null; }

  private _getActiveSlotField(field: keyof Slot): unknown {
    return this._slots.get(this._activeSlot)?.[field] ?? null;
  }

  // ──────────────────── 工厂方法 ────────────────────

  /**
   * 创建并注册 MinigameTools 实例（幂等）。
   * 若 sdk 上已有实例则复用，并追加 onEvent / log。
   */
  static register(sdk: SDKRef, options: MinigameToolsOptions = {}): MinigameTools {
    if (sdk?.__minigameTools instanceof MinigameTools) {
      const existing = sdk.__minigameTools;
      if (typeof options.onEvent === 'function') existing.addEventListener(options.onEvent);
      if (typeof options.log === 'function' && !existing._log) existing._log = options.log;
      return existing;
    }
    const tools = new MinigameTools(sdk, options);
    tools.register();
    if (sdk) sdk.__minigameTools = tools;
    return tools;
  }

  /**
   * 向 CopilotTools 注册 'minigame' 工具分类并启动 postMessage 监听。
   */
  register(): this {
    const copilotTools = this.sdk.copilotTools;
    if (!copilotTools) throw new Error('MinigameTools requires sdk.copilotTools');
    copilotTools.registerToolCategory?.('minigame', {
      definitions: DEFINITIONS,
      executor: (fnName: unknown, fnArgs: unknown, config: unknown) =>
        this.execute(fnName as string, fnArgs as Record<string, unknown>, config as Record<string, unknown>),
      disableAutoProxy: true,
    });
    this._ensureMessageListener();
    return this;
  }

  // ──────────────────── Slot 管理 ────────────────────

  private _resolveSlot(explicit?: string): string {
    return explicit ?? this._defaultSlot ?? this._activeSlot ?? 'default';
  }

  private _getOrCreateSlot(name: string): Slot {
    if (this._slots.has(name)) return this._slots.get(name)!;
    const slot = this._createSlotDOM(name);
    this._slots.set(name, slot);
    return slot;
  }

  private _getSlot(name: string): Slot | null { return this._slots.get(name) ?? null; }

  /**
   * 设置当前活跃 slot，将 `id="minigame-iframe"` 移动到目标 slot 的 iframe。
   */
  setActiveSlot(name: string): void {
    if (this._activeSlot === name) return;
    const prev = this._getSlot(this._activeSlot);
    if (prev?.iframe) prev.iframe.id = `minigame-iframe-${this._activeSlot}`;
    this._activeSlot = name;
    const next = this._getSlot(name);
    if (next?.iframe) next.iframe.id = 'minigame-iframe';
  }

  /** 当前活跃 slot 名称。 */
  get activeSlot(): string { return this._activeSlot; }

  setLaunchHost(host: typeof this._launchHost): void { this._launchHost = host ?? null; }

  getLaunchSession(slotName?: string): SlotSession | null {
    return this._slotSessions.get(slotName ?? this._activeSlot ?? 'default') ?? null;
  }

  finishSlotSession(slotName?: string): SlotSession | null {
    const name = slotName ?? this._activeSlot ?? 'default';
    const session = this._slotSessions.get(name) ?? null;
    this._slotSessions.delete(name);
    this._sessionStack = this._sessionStack.filter((s) => s !== name);
    return session;
  }

  /**
   * 打开一个命名 slot 会话（设置尺寸/层级/前景元素并激活 slot）。
   */
  openSlotSession(options: OpenSlotSessionOptions = {}): SlotSession {
    const slotName = options.slot ?? (options.root ? 'default' : this._createSessionSlotName());
    const parentSlot = options.parentSlot ?? (slotName === this._activeSlot ? null : this._activeSlot);
    const frameOptions = this._resolveFrameOptions(options);
    if ((options.title ?? options.gameTitle) && frameOptions.titleText == null) {
      frameOptions.titleText = options.title ?? options.gameTitle;
    }
    const zIndex = Number(frameOptions.zIndex) || this._nextZIndex(options.root ?? false);
    const slot = this._getOrCreateSlot(slotName);
    slot.defaultFrameOptions = { ...(slot.defaultFrameOptions ?? {}), ...frameOptions, zIndex };
    this._applyFrameOptions(slot, options.preload ? this._withoutBackdrop(slot.defaultFrameOptions) : slot.defaultFrameOptions!);
    if (!options.preload) this.setSlotForegroundElements(slotName, options.foregroundElements, options.foregroundOptions);
    this.setActiveSlot(slotName);

    const session: SlotSession = {
      slot: slotName, parentSlot,
      promptFile: (options.promptFile ?? options.skillPath ?? '') as string,
      tools: Array.isArray(options.tools) ? options.tools as string[] : undefined,
      parentPromptFile: (options.parentPromptFile ?? '') as string,
      parentTools: Array.isArray(options.parentTools) ? options.parentTools as string[] : undefined,
      root: options.root === true,
      restorePolicy: (options.restorePolicy ?? (options.root ? 'none' : 'resumeParent')) as string,
      closePolicy: (options.closePolicy ?? (options.root ? 'emitOnly' : 'restoreParent')) as string,
      frameOptions: slot.defaultFrameOptions,
      title: (options.title ?? options.gameTitle ?? '') as string,
      sourceSlot: (options.sourceSlot ?? parentSlot ?? '') as string,
      openedAt: Date.now(),
      preload: options.preload === true,
      revealed: options.preload !== true,
    };
    this._slotSessions.set(slotName, session);
    this._sessionStack = this._sessionStack.filter((s) => s !== slotName);
    this._sessionStack.push(slotName);
    return session;
  }

  restorePreviousActiveSlot(preferredSlot?: string): string | null {
    const target = preferredSlot ?? [...this._sessionStack].reverse().find((name) => {
      const slot = this._getSlot(name);
      return slot?.container && slot.container.style.display !== 'none';
    });
    if (target) this.setActiveSlot(target);
    return target ?? null;
  }

  // ──────────────────── 公共 API ────────────────────

  /**
   * 运行时更新 slot 的帧外观配置（可在加载前后调用）。
   */
  configure(options: FrameOptions = {}): void {
    const slotName = this._resolveSlot(options.slot as string | undefined);
    const slot = this._getOrCreateSlot(slotName);
    slot.defaultFrameOptions = { ...(slot.defaultFrameOptions ?? {}), ...options };
    this._applyFrameOptions(slot, options);
  }

  setSlotForegroundElements(
    slotName: string | undefined,
    elements?: HTMLElement | HTMLElement[] | string | string[],
    options: Record<string, unknown> = {}
  ): void {
    const slot = this._getOrCreateSlot(slotName ?? this._activeSlot ?? 'default');
    this._restoreForegroundElements(slot);
    const list = this._normalizeForegroundElements(elements);
    if (!list.length) return;
    slot.foregroundOptions = { ...(options ?? {}) };
    slot.foregroundElements = list.map((element) => ({
      element,
      style: { position: element.style.position, zIndex: element.style.zIndex, isolation: element.style.isolation },
    }));
    this._applyForegroundElements(slot);
  }

  /**
   * 执行工具函数（CopilotTools 分发入口）。
   */
  async execute(fnName: string, fnArgs: Record<string, unknown> = {}, config: Record<string, unknown> = {}): Promise<unknown> {
    if (fnName === 'configure_minigame') {
      const slotName = this._resolveSlot(fnArgs['slot'] as string | undefined);
      const slot = this._getSlot(slotName);
      if (!slot?.container || slot.container.style.display === 'none') return { error: 'No minigame is currently loaded.' };
      this._applyFrameOptions(slot, fnArgs as FrameOptions);
      return '[小游戏窗口已更新]';
    }
    if (fnName !== 'load_minigame') return { error: `Unknown minigame tool: ${fnName}` };
    return this._loadMinigame(fnArgs, config, { visible: true });
  }

  /**
   * 预加载（隐藏加载）小游戏页面。
   */
  async preload(fnArgs: Record<string, unknown> = {}, config: Record<string, unknown> = {}): Promise<unknown> {
    return this._loadMinigame(fnArgs, config, { visible: false });
  }

  /**
   * 显示已预加载的 slot（使其可见）。
   */
  showSlot(slotName: string | undefined, options: Record<string, unknown> = {}): boolean {
    const name = slotName ?? (options['slot'] as string | undefined) ?? this._activeSlot ?? 'default';
    const slot = this._getSlot(name);
    if (!slot?.container) return false;
    const frameOptions = { ...(slot.defaultFrameOptions ?? {}), ...(options['frameOptions'] as Record<string, unknown> ?? {}), ...options };
    delete frameOptions['frameOptions'];
    this._applyFrameOptions(slot, frameOptions as FrameOptions);
    this.setSlotForegroundElements(name, options['foregroundElements'] as HTMLElement | undefined, options['foregroundOptions'] as Record<string, unknown> | undefined);
    slot.container.style.display = 'flex';
    this.setActiveSlot(name);
    const session = this.getLaunchSession(name);
    if (session) { session.preload = false; session.revealed = true; }
    return true;
  }

  private async _loadMinigame(
    fnArgs: Record<string, unknown>,
    config: Record<string, unknown>,
    options: { visible?: boolean }
  ): Promise<string> {
    const relativePath = (fnArgs['relativePath'] ?? (fnArgs['args'] as unknown[])?.[0]) as string | undefined;
    if (!relativePath) return '{ "error": "relativePath is required" }';
    const visible = options.visible !== false;

    const slotName = this._resolveSlot(fnArgs['slot'] as string | undefined);
    const slot = this._getOrCreateSlot(slotName);
    const session = this.getLaunchSession(slotName);
    const shouldShow = visible && !(session?.preload && session.revealed === false);

    const pKey = (fnArgs['persistKey'] ?? null) as string | null;
    if (pKey && pKey === slot.persistKey && slot.iframe?.src) {
      this._log?.(`[load_minigame] cached (persistKey=${pKey}, slot=${slotName})`);
      if (shouldShow) { this.showSlot(slotName, fnArgs); return `[小游戏已加载(cached): ${relativePath}]\n小游戏iframe仍在运行，已显示缓存窗口。`; }
      this.setActiveSlot(slotName);
      return `[小游戏已预加载(cached): ${relativePath}]\n小游戏iframe仍在隐藏运行，跳过重载。`;
    }

    const store = this.sdk.personalPageStore?.withConfig(config);
    const url = store ? store.getAbsUrl(relativePath) : relativePath;
    this._log?.(`[load_minigame] slot=${slotName}, ${relativePath} → ${url}`);

    const c = slot.container;
    c.style.left = '50%'; c.style.top = '50%'; c.style.right = ''; c.style.bottom = '';
    c.style.transform = 'translate(-50%, -50%)';
    c.style.display = shouldShow ? 'flex' : 'none';
    slot.title.textContent = '🎮 ' + relativePath.split('/').pop()!;
    if (slot.defaultFrameOptions) this._applyFrameOptions(slot, shouldShow ? slot.defaultFrameOptions : this._withoutBackdrop(slot.defaultFrameOptions));
    this._applyFrameOptions(slot, (shouldShow ? fnArgs : this._withoutBackdrop(fnArgs as FrameOptions)) as FrameOptions);
    this.setActiveSlot(slotName);

    const iframe = slot.iframe;
    const loaded = await new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => resolve(false), LOAD_TIMEOUT_MS);
      const handler = (e: MessageEvent): void => {
        if (e.source === iframe.contentWindow && (e.data as Record<string, unknown>)?.['type'] === 'gameLoaded') {
          clearTimeout(timeout);
          window.removeEventListener('message', handler);
          resolve(true);
        }
      };
      window.addEventListener('message', handler);
      const token = this.sdk.getToken?.() ?? '';
      const sdkConstructor = this.sdk.constructor as { source?: string; sourceIsModule?: boolean } | undefined;
      const sdkSrc = sdkConstructor?.source ?? document.querySelector<HTMLScriptElement>('script[src*="keepworkSDK"]')?.src ?? '';
      const sdkIsModule = !!(sdkConstructor?.sourceIsModule) && !/iife/i.test(sdkSrc);
      const iframeUrl = new URL(url, window.location.href);
      if (sdkSrc) iframeUrl.searchParams.set('sdk', sdkSrc);
      if (sdkIsModule) iframeUrl.searchParams.set('module', '1');
      if (token) iframeUrl.searchParams.set('token', token);
      iframe.src = iframeUrl.href;
    });

    slot.persistKey = pKey;
    if (loaded) {
      this._log?.(`[load_minigame] gameLoaded received (slot=${slotName})`);
      return shouldShow ? `[小游戏已加载: ${relativePath}]\n小游戏iframe已在用户界面中显示，URL: ${url}` : `[小游戏已预加载: ${relativePath}]\n小游戏iframe已隐藏加载完成，URL: ${url}`;
    }
    this._log?.(`[load_minigame] gameLoaded timeout (slot=${slotName})`);
    return shouldShow ? `[小游戏加载超时: ${relativePath}]\niframe已设置但未收到gameLoaded确认，URL: ${url}` : `[小游戏预加载超时: ${relativePath}]\n隐藏iframe已设置但未收到gameLoaded确认，URL: ${url}`;
  }

  /**
   * 隐藏并清除 slot 的 iframe src。
   * @param opts - slot 名称和关闭原因
   */
  close(opts: { slot?: string; reason?: string } = {}): void {
    const slotName = opts.slot ?? this._activeSlot ?? 'default';
    const slot = this._getSlot(slotName);
    if (!slot) return;
    const reason = opts.reason ?? 'user';
    const wasVisible = slot.container?.style.display !== 'none';
    if (slot.container) slot.container.style.display = 'none';
    if (slot.iframe) slot.iframe.src = '';
    slot.persistKey = null;
    this._hideBackdrop(slot);
    this._restoreForegroundElements(slot);

    if (slotName === this._activeSlot) {
      let fallback: string | null = null;
      for (const [name, s] of this._slots) {
        if (name !== slotName && s.container?.style.display !== 'none') { fallback = name; break; }
      }
      if (fallback) this.setActiveSlot(fallback);
    }

    if (wasVisible && reason !== 'finished') {
      const data: Record<string, unknown> = { type: 'gameClosed', reason, _slot: slotName };
      for (const fn of this._listeners) { try { fn(data); } catch (err) { console.warn('[MinigameTools] listener error:', err); } }
    }
  }

  /** 销毁所有 slot 并移除 DOM 和监听器。 */
  destroy(): void {
    for (const [name] of this._slots) this.close({ slot: name, reason: 'destroy' });
    if (this._msgListener) { window.removeEventListener('message', this._msgListener); this._msgListener = null; }
    this._listeners.clear();
    for (const [, slot] of this._slots) {
      if (slot.backdropEl?.parentNode) slot.backdropEl.parentNode.removeChild(slot.backdropEl);
      if (slot.container?.parentNode) slot.container.parentNode.removeChild(slot.container);
    }
    this._slots.clear();
    if (this.sdk && this.sdk.__minigameTools === this) delete this.sdk.__minigameTools;
  }

  /**
   * 注册 iframe 事件监听器（gameLoaded / gameFinished / 自定义）。
   * @returns unsubscribe 函数
   */
  addEventListener(fn: (data: Record<string, unknown>) => void): () => void {
    if (typeof fn !== 'function') return (): void => { /* noop */ };
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  removeEventListener(fn: (data: Record<string, unknown>) => void): void { this._listeners.delete(fn); }

  /**
   * 向指定 slot 的 minigame iframe 发送 postMessage。
   * @param data - 结构化可克隆的消息载荷
   * @param opts - 目标 slot（默认当前活跃 slot）
   */
  postMessageToMinigame(data: Record<string, unknown>, opts: { slot?: string } = {}): boolean {
    if (!data || typeof data !== 'object') return false;
    const slotName = opts.slot ?? this._activeSlot ?? 'default';
    const slot = this._getSlot(slotName);
    if (!slot?.iframe?.contentWindow) return false;
    if (!slot.container || slot.container.style.display === 'none') return false;
    slot.iframe.contentWindow.postMessage(data, '*');
    return true;
  }

  // ──────────────────── 私有工具方法 ────────────────────

  private _createSessionSlotName(): string {
    return `skill-${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
  }

  private _withoutBackdrop(options: FrameOptions | null): FrameOptions {
    if (!options || typeof options !== 'object' || options.backdrop == null) return options ?? {};
    const next = { ...options };
    delete next.backdrop;
    return next;
  }

  private _nextZIndex(root: boolean): number {
    if (root) return this.zIndex;
    this._zIndexCursor = Math.max(this._zIndexCursor + Z_INDEX_STEP, this.zIndex + Z_INDEX_STEP);
    return this._zIndexCursor;
  }

  private _resolveFrameOptions(options: OpenSlotSessionOptions): FrameOptions {
    const preset = (options.layout ?? options.preset ?? 'custom') as string;
    let presetOptions: FrameOptions = {};
    if (preset === 'fullscreen') {
      presetOptions = { left: '0', top: '0', width: '100vw', height: '100vh', showTitleBar: false, showCloseButton: false, borderRadius: '0', boxShadow: 'none', background: 'transparent' };
    } else if (preset === 'modal') {
      presetOptions = { width: 'min(800px, 82vw)', height: 'min(700px, 84vh)', showTitleBar: true, showCloseButton: true, borderRadius: '12px', boxShadow: '0 10px 40px rgba(0,0,0,0.25)', background: '#ffffff', backdrop: 'rgba(0,0,0,0.35)' };
    } else if (preset === 'panel') {
      presetOptions = { right: '16px', top: '80px', width: 'min(520px, 90vw)', height: 'calc(100vh - 96px)', showTitleBar: true, showCloseButton: true };
    }
    return { ...presetOptions, ...(options.frameOptions ?? {}) };
  }

  private _applyFrameOptions(slot: Slot, opts: FrameOptions): void {
    const c = slot.container;
    if (!c) return;
    const s = c.style;

    const sizeToCss = (v: unknown): string | null => {
      if (v == null || v === '') return null;
      if (typeof v === 'number') return v > 0 ? v + 'px' : null;
      const str = String(v).trim();
      if (!str) return null;
      if (/^-?\d+(\.\d+)?$/.test(str)) { const n = Number(str); return n > 0 ? n + 'px' : null; }
      return str;
    };
    const wCss = sizeToCss(opts.width), hCss = sizeToCss(opts.height);
    if (wCss) s.width = wCss;
    if (hCss) s.height = hCss;

    const hasExplicitPos = opts.left != null || opts.top != null || opts.right != null || opts.bottom != null;
    if (hasExplicitPos) s.transform = 'none';
    if (opts.left != null) { s.left = opts.left; s.right = ''; }
    if (opts.right != null) { s.right = opts.right; s.left = ''; }
    if (opts.top != null) { s.top = opts.top; s.bottom = ''; }
    if (opts.bottom != null) { s.bottom = opts.bottom; s.top = ''; }

    if (opts.zIndex != null) {
      s.zIndex = String(Number(opts.zIndex) || this.zIndex);
      if (slot.backdropEl && slot.backdropEl.style.display !== 'none') {
        slot.backdropEl.style.zIndex = String((Number(opts.zIndex) || this.zIndex) - 1);
      }
      this._applyForegroundElements(slot);
    }

    if (opts.backdrop != null) {
      if (opts.backdrop) { this._showBackdrop(slot, typeof opts.backdrop === 'string' ? opts.backdrop : 'rgba(0,0,0,0.3)'); }
      else { this._hideBackdrop(slot); }
    }
    if (opts.borderRadius != null) s.borderRadius = opts.borderRadius;
    if (opts.boxShadow != null) s.boxShadow = opts.boxShadow;
    if (opts.background != null) s.background = opts.background;

    if (slot.header) {
      if (opts.showTitleBar === false) slot.header.style.display = 'none';
      else if (opts.showTitleBar === true) slot.header.style.display = 'flex';
    }
    if (slot.closeBtn) {
      if (opts.showCloseButton === false) slot.closeBtn.style.display = 'none';
      else if (opts.showCloseButton === true) slot.closeBtn.style.display = '';
    }
    if (opts.titleText != null && slot.title) slot.title.textContent = opts.titleText;
  }

  private _showBackdrop(slot: Slot, bg: string): void {
    if (!slot.backdropEl) {
      const el = document.createElement('div');
      Object.assign(el.style, { position: 'fixed', top: '0', left: '0', width: '100vw', height: '100vh', pointerEvents: 'auto', display: 'none', transition: 'opacity 0.2s', opacity: '0' });
      document.body.appendChild(el);
      slot.backdropEl = el;
    }
    const zIndex = parseInt(slot.container?.style.zIndex || String(this.zIndex), 10) - 1;
    slot.backdropEl.style.zIndex = String(zIndex);
    slot.backdropEl.style.background = bg;
    slot.backdropEl.style.display = 'block';
    void slot.backdropEl.offsetWidth; // force reflow
    slot.backdropEl.style.opacity = '1';
  }

  private _hideBackdrop(slot: Slot): void {
    if (slot.backdropEl) { slot.backdropEl.style.opacity = '0'; slot.backdropEl.style.display = 'none'; }
  }

  private _normalizeForegroundElements(
    elements?: HTMLElement | HTMLElement[] | string | string[]
  ): HTMLElement[] {
    const source = Array.isArray(elements) ? elements : (elements ? [elements] : []);
    const out: HTMLElement[] = [];
    const seen = new Set<HTMLElement>();
    for (const item of source) {
      let element: HTMLElement | null = item instanceof HTMLElement ? item : document.querySelector<HTMLElement>(item as string);
      if (element && !seen.has(element)) { seen.add(element); out.push(element); }
    }
    return out;
  }

  private _applyForegroundElements(slot: Slot): void {
    if (!slot.foregroundElements?.length || !slot.container) return;
    const baseZIndex = parseInt(slot.container.style.zIndex || String(this.zIndex), 10) || this.zIndex;
    const offset = Number((slot.foregroundOptions?.['zIndexOffset'] as number | undefined));
    const zIndex = baseZIndex + (Number.isFinite(offset) ? offset : 2);
    for (const entry of slot.foregroundElements) {
      const el = entry.element;
      if (!(el instanceof HTMLElement)) continue;
      if (window.getComputedStyle(el).position === 'static') el.style.position = 'relative';
      el.style.zIndex = String(zIndex);
      el.style.isolation = 'isolate';
    }
  }

  private _restoreForegroundElements(slot: Slot): void {
    if (!slot.foregroundElements?.length) return;
    for (const entry of slot.foregroundElements) {
      const el = entry.element;
      if (!(el instanceof HTMLElement)) continue;
      el.style.position = entry.style.position;
      el.style.zIndex = entry.style.zIndex;
      el.style.isolation = entry.style.isolation;
    }
    slot.foregroundElements = null;
    slot.foregroundOptions = null;
  }

  private _ensureMessageListener(): void {
    if (this._msgListener) return;
    this._msgListener = (e: MessageEvent) => {
      const data = e.data as Record<string, unknown>;
      if (!data || typeof data !== 'object') return;

      let sourceSlot: string | null = null;
      for (const [name, slot] of this._slots) {
        if (slot.iframe && e.source === slot.iframe.contentWindow) { sourceSlot = name; break; }
      }
      if (!sourceSlot) return;

      if (data['type'] === OPEN_SKILL_MESSAGE) {
        if (!this._launchHost?.launchSkill) { console.warn('[MinigameTools] openSkill ignored: no launch host is registered'); return; }
        this._launchHost.launchSkill(
          (data['promptFile'] ?? data['skillPath']) as string,
          { ...data, sourceSlot, parentSlot: data['parentSlot'] ?? this.activeSlot ?? sourceSlot }
        ).catch((err) => {
          console.warn('[MinigameTools] openSkill failed:', err);
          try { (e.source as Window).postMessage({ type: 'keepwork:minigame:openSkillResult', ok: false, error: (err as Error)?.message ?? String(err) }, '*'); } catch { /* ignore */ }
        });
        return;
      }

      if (data['type'] === CLOSE_MESSAGE) { this.close({ slot: (data['slot'] ?? sourceSlot) as string, reason: (data['reason'] ?? 'user') as string }); return; }

      const annotated: Record<string, unknown> = { ...data, _slot: sourceSlot };
      for (const fn of this._listeners) { try { fn(annotated); } catch (err) { console.warn('[MinigameTools] listener error:', err); } }

      if (data['type'] === 'gameFinished') { this._log?.(`[Minigame] gameFinished received (slot=${sourceSlot}), closing`); this.close({ slot: sourceSlot, reason: 'finished' }); }
    };
    window.addEventListener('message', this._msgListener);
  }

  private _createSlotDOM(name: string): Slot {
    const container = document.createElement('div');
    container.id = `${this.containerId}-${name}`;
    Object.assign(container.style, { position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', width: this.defaultWidth + 'px', height: this.defaultHeight + 'px', background: '#ffffff', borderRadius: '12px', boxShadow: '0 10px 40px rgba(0,0,0,0.25)', overflow: 'hidden', zIndex: String(this.zIndex), display: 'none', flexDirection: 'column' });

    const header = document.createElement('div');
    Object.assign(header.style, { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 12px', background: '#f8fafc', borderBottom: '1px solid #e2e8f0', fontSize: '12px', color: '#64748b', cursor: 'grab', userSelect: 'none', flexShrink: '0' });

    const title = document.createElement('span');
    title.textContent = '🎮 小游戏';

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button'; closeBtn.textContent = '✕'; closeBtn.title = '关闭';
    Object.assign(closeBtn.style, { border: 'none', background: 'transparent', cursor: 'pointer', color: '#64748b', fontSize: '14px', padding: '2px 6px', lineHeight: '1' });
    closeBtn.addEventListener('click', () => this.close({ slot: name }));

    header.appendChild(title); header.appendChild(closeBtn);

    const iframe = document.createElement('iframe');
    iframe.id = (name === this._activeSlot) ? 'minigame-iframe' : `minigame-iframe-${name}`;
    iframe.setAttribute('data-ai-hint', `Minigame iframe (slot: ${name})`);
    Object.assign(iframe.style, { flex: '1', width: '100%', border: 'none', minHeight: '0' });

    this._wireDrag(container, header, closeBtn);
    container.appendChild(header); container.appendChild(iframe);
    document.body.appendChild(container);

    return { name, container, iframe, title, header, closeBtn, persistKey: null, defaultFrameOptions: null, backdropEl: null };
  }

  private _wireDrag(container: HTMLDivElement, handle: HTMLDivElement, closeBtn: HTMLButtonElement): void {
    let dragging = false, startX = 0, startY = 0, originX = 0, originY = 0;
    handle.addEventListener('pointerdown', (e) => {
      if (e.target === closeBtn) return;
      dragging = true; startX = e.clientX; startY = e.clientY;
      const rect = container.getBoundingClientRect();
      originX = rect.left; originY = rect.top;
      container.style.transform = 'none'; container.style.left = originX + 'px'; container.style.top = originY + 'px';
      handle.setPointerCapture(e.pointerId); handle.style.cursor = 'grabbing'; e.preventDefault();
    });
    handle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      container.style.left = (originX + e.clientX - startX) + 'px';
      container.style.top = (originY + e.clientY - startY) + 'px';
    });
    const end = (): void => { dragging = false; handle.style.cursor = 'grab'; };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }
}