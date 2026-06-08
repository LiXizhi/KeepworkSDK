/**
 * NPL.ts — Paracraft / NPL（神经并行语言）通信桥接模块
 *
 * 提供 Keepwork 前端与 Paracraft 引擎之间的双向消息通信能力：
 * - `NPLUtil`：静态工具集（postMessage 监听、系统检测、微信检测）
 * - `NPLJS`：高级 NPL 通信类，带消息 ID 回调和加载握手
 * - `ParacraftEvent`：Keepwork↔Paracraft 事件总线（前缀隔离）
 *
 * ## 使用前提
 * 打开 HTML 时需在 URL 中带以下参数之一（由 Paracraft /open 命令自动注入）：
 * - `?asWebviewInParacraftClient=true`
 * - `?asIframeInWebParacraft=true`
 *
 * ## 快速上手
 * ```ts
 * // 初始化监听（由 index.ts 自动调用）
 * NPLUtil.initializeMessageListeners();
 *
 * // 高级通信
 * window.NPLJSInstance = new NPLJS();
 * window.paracraftEvent = new ParacraftEvent(window.NPLJSInstance);
 * ```
 *
 * ## 消息前缀约定
 * - 进入方向（Paracraft → Keepwork）：`@keepwork_`
 * - 发出方向（Keepwork → Paracraft）：`@webparacraft_`
 */

// ──────────────────── 内部工具函数 ────────────────────

/**
 * 从 URL search 参数读取指定参数值。
 * @param name - 参数名
 * @returns 参数值，不存在时返回空字符串
 */
function getQueryString(name: string): string {
  if (typeof window === 'undefined') return '';
  return new URLSearchParams(window.location.search).get(name) ?? '';
}

/** 微信浏览器检测结果 */
interface WxEnv {
  isWeChat: boolean;
  isMiniProgram: boolean;
  isWorkWeChat: boolean;
  isAnyWeChat: boolean;
}

/**
 * 检测当前是否运行在微信系列环境中。
 * 非浏览器环境（SSR）返回全 false。
 */
function isWeChatBrowser(): WxEnv {
  if (typeof window === 'undefined') {
    return { isWeChat: false, isMiniProgram: false, isWorkWeChat: false, isAnyWeChat: false };
  }
  const ua = navigator.userAgent.toLowerCase();
  const isWeChat = /micromessenger/i.test(ua);
  const isMiniProgram = /miniprogram/i.test(ua);
  const isWorkWeChat = /wxwork/i.test(ua);
  return { isWeChat, isMiniProgram, isWorkWeChat, isAnyWeChat: isWeChat || isMiniProgram || isWorkWeChat };
}

/**
 * 获取当前运行平台标识。
 * 优先读取 `window.paracraft_platform`，然后 URL 参数，最后 UA 检测。
 */
function getSystem(): string {
  if (typeof window === 'undefined') return 'server';
  const win = window as Window & { paracraft_platform?: string; Module?: unknown };
  if (win.paracraft_platform) return win.paracraft_platform;
  const platform = getQueryString('platform');
  if (platform !== '') return platform;
  const w = window as Window & { chrome?: { webview?: unknown; app?: unknown } };
  if (w.chrome?.webview) return 'windows';
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/i.test(ua)) return 'iPhone';
  if (/Mac/i.test(ua)) return 'macos';
  if (/Windows/i.test(ua)) return 'windows';
  if (/Android/i.test(ua)) return 'android';
  if (win.Module) return 'emscripten';
  return 'unknown';
}

// ──────────────────── NPL 核心对象 ────────────────────

/** 文件名 → 消息回调映射 */
const allMsg: Record<string, (msg: unknown) => void> = {};

/** NPL 消息 activate 参数（各平台通用） */
interface NplActivateParams {
  filename: string;
  msg: unknown;
}

/**
 * NPL 底层通信对象。
 * 根据当前平台（iOS/macOS/Windows WebView/Emscripten/Android）选择对应的通信机制。
 */
const NPL = {
  /**
   * 向 Paracraft 发送 NPL 消息（跨平台派发）。
   *
   * @param filename - NPL 文件名（作为消息路由 key）
   * @param msg      - 消息体（任意可序列化对象）
   */
  activate: (filename: string, msg: unknown): void => {
    const system = getSystem();
    const w = window as Window & {
      webkit?: { messageHandlers?: { activate?: { postMessage?: (p: unknown) => void } } };
      chrome?: { webview?: { postMessage?: (s: string) => void } };
    };

    if (system === 'iPhone' || system === 'macos') {
      const params: NplActivateParams = { filename, msg: JSON.stringify(msg) };
      w.webkit?.messageHandlers?.activate?.postMessage?.(params);
    } else if (system === 'windows') {
      if (w.chrome?.webview?.postMessage) {
        w.chrome.webview.postMessage(JSON.stringify({ filename, msg }));
        return;
      }
      window.location.href = 'paracraft://sendMsg?' + JSON.stringify({ filename, msg });
    } else if (system === 'emscripten') {
      if (window.parent !== window) {
        window.parent.postMessage(
          { is_paracraft_message: true, cmd: 'PostMessage', paracraft_platform: 'emscripten', filename, msg },
          '*'
        );
      }
    } else if (system === 'android') {
      const android = (window as Window & { android?: { nplActivate?: (f: string, m: string) => void } }).android;
      android?.nplActivate?.(filename, JSON.stringify(msg));
    }
  },

  /**
   * 注册指定文件名的消息接收回调。
   *
   * @param callback - 消息回调函数
   * @param params   - 包含 filename 的参数对象
   */
  this: (callback: (msg: unknown) => void, params?: { filename?: string }): void => {
    if (params?.filename) {
      allMsg[params.filename] = callback;
    }
  },

  /**
   * 接收来自 Paracraft 的 NPL 消息并派发给已注册的回调。
   *
   * @param filename - NPL 文件名（消息路由 key）
   * @param msg      - 消息体
   */
  receive: (filename: string, msg: unknown): void => {
    if (allMsg[filename]) {
      allMsg[filename](msg);
    }
  },
};

// ──────────────────── 全局消息监听器 ────────────────────

/** Emscripten 环境下的 postMessage 消息结构 */
interface ParacraftPostMessage {
  is_paracraft_message?: boolean;
  cmd?: string;
  platform?: string;
  filename?: string;
  msg?: unknown;
}

/**
 * 初始化全局 window.message 监听器（Emscripten/iframe 环境）。
 *
 * 仅当非 WebView / Android / iOS 原生环境（或处于微信环境）时注册，
 * 防止与原生通道冲突。由 `index.ts` 在 SDK 加载时自动调用。
 */
function initializeMessageListeners(): void {
  if (typeof window === 'undefined') return;

  const weChatInfo = isWeChatBrowser();
  const w = window as Window & {
    chrome?: { webview?: unknown };
    android?: unknown;
    webkit?: unknown;
  };

  const hasChromeWebview = !!(w.chrome?.webview);
  const hasAndroid = !!(w.android);
  const hasWebkit = !!(w.webkit);
  if (
    ((!hasChromeWebview && !hasAndroid && !hasWebkit) || weChatInfo.isAnyWeChat) &&
    !messageListenersInitialized
  ) {
    messageListenersInitialized = true;
    window.addEventListener('message', (event: MessageEvent) => {
      const msg = event.data as ParacraftPostMessage;
      if (!msg?.is_paracraft_message) return;
      const cmd = msg.cmd;
      if (cmd === 'load') {
        if (msg.platform) {
          (window as Window & { paracraft_platform?: string }).paracraft_platform = msg.platform;
        }
        (event.source as Window | null)?.postMessage(msg, '*');
      } else if (cmd === 'PostMessage') {
        NPL.receive(msg.filename ?? '', msg.msg);
      }
    });
  }
}

let messageListenersInitialized = false;

// ──────────────────── NPLUtil ────────────────────

/**
 * NPLUtil — NPL 通信静态工具集。
 * 暴露底层 NPL 对象和初始化方法，供外部直接调用。
 */
class NPLUtil {
  static readonly allMsg = allMsg;
  static readonly NPL = NPL;
  static readonly initializeMessageListeners = initializeMessageListeners;
  static readonly getSystem = getSystem;
  static readonly getQueryString = getQueryString;
  static readonly isWeChatBrowser = isWeChatBrowser;
}

// ──────────────────── NPLJS ────────────────────

/** NPLJS 消息体结构 */
interface NPLJSMessage {
  msgid?: string;
  msgname?: string;
  msgdata?: unknown;
  request_reply?: boolean;
  response_reply?: boolean;
}

/**
 * NPLJS — 高级 NPL 通信类，提供消息 ID 回调、加载握手、消息订阅/发布。
 *
 * 通常以单例形式使用：
 * ```ts
 * window.NPLJSInstance = new NPLJS();
 * window.NPLJSInstance.OnLoad(() => { console.log('ready'); });
 * ```
 */
class NPLJS {
  private m_msg_callbacks: Record<string, Record<string, (data: unknown, msgid?: string) => void>>;
  private m_ready: boolean;
  private m_msgid: number;
  private m_msgid_callbacks: Record<string, (data: unknown) => void>;
  private m_loaded: boolean;
  private m_onload_callback: Array<() => void>;
  private m_onload_timerid: ReturnType<typeof setInterval> | null;

  constructor() {
    this.m_msg_callbacks = {};
    this.m_ready = false;
    this.m_msgid = 0;
    this.m_msgid_callbacks = {};
    this.m_loaded = false;
    this.m_onload_callback = [];
    this.m_onload_timerid = null;
    this.registerNPLJSReceive();
    this.CheckLoadWebview();
  }

  /** 是否已与 Paracraft WebView 建立连接。 */
  IsLoaded(): boolean { return this.m_loaded; }

  /**
   * 触发加载握手流程（向 Paracraft 发送 'load' 消息，等待确认）。
   * 若已加载则立即返回。
   */
  Load(): void {
    if (this.m_loaded) return;
    this.SendMsg('load');
    this.m_onload_timerid = setInterval(() => { this.SendMsg('load'); }, 200);
  }

  /** @private 处理 Paracraft 返回的 load 确认消息。 */
  private HandleLoadMsg(): void {
    if (this.m_loaded) return;
    console.debug('==========================NPLJS Loaded=========================', (window as Window & { chrome?: { webview?: unknown } }).chrome?.webview);
    if (this.m_onload_timerid !== null) {
      clearInterval(this.m_onload_timerid);
      this.m_onload_timerid = null;
    }
    this.m_loaded = true;
    this.SendMsg('load');
    this.m_onload_callback.forEach((cb) => cb());
  }

  /**
   * 注册加载完成回调（若已加载则立即触发）。
   * @param callback - 连接建立后的回调
   */
  OnLoad(callback: () => void): void {
    if (this.IsLoaded()) { callback(); return; }
    this.m_onload_callback.push(callback);
  }

  /** @private 生成自增消息 ID（格式：`js_N`）。 */
  private GetNextMsgId(): string {
    return `js_${++this.m_msgid}`;
  }

  /** @private 发送原始 NPL 消息到 NPLJS 文件。 */
  private Send(msg: NPLJSMessage): void {
    NPL.activate('NPLJS', msg);
  }

  /**
   * 发送命名消息（可选回调）。
   *
   * @param msgname - 消息名
   * @param msgdata - 消息数据
   * @param msgid   - 消息 ID（可选，用于回调关联）
   * @param callback - 收到响应时触发的回调
   */
  SendMsg(
    msgname: string,
    msgdata?: unknown,
    msgid?: string,
    callback?: (data: unknown) => void
  ): void {
    if (!msgid) msgid = this.GetNextMsgId();
    if (typeof callback === 'function') {
      this.m_msgid_callbacks[msgid] = callback;
    }
    this.Send({ msgid, msgname, msgdata });
  }

  /**
   * 接收并派发来自 Paracraft 的 NPLJS 消息。
   * @private
   */
  RecvMsg(msg: NPLJSMessage): void {
    const { msgid = '', msgname = '', msgdata } = msg;
    const msgidCallback = this.m_msgid_callbacks[msgid];

    if (msgidCallback) {
      msgidCallback(msgdata);
      delete this.m_msgid_callbacks[msgid];
    }

    const hasSubscribers = !!(msgidCallback ?? Object.keys(this.m_msg_callbacks[msgname] ?? {}).length);
    if (msg.request_reply && hasSubscribers) {
      this.Send({ ...msg, response_reply: true });
    }

    if (msgname === 'load') {
      this.HandleLoadMsg();
    } else {
      this.EmitMsg(msgname, msgdata, msgid);
    }
  }

  /**
   * 订阅指定消息名（可同时有多个订阅者）。
   * @param msgname  - 消息名
   * @param callback - 回调函数
   */
  OnMsg(msgname: string, callback: (data: unknown, msgid?: string) => void): void {
    if (!this.m_msg_callbacks[msgname]) this.m_msg_callbacks[msgname] = {};
    this.m_msg_callbacks[msgname][String(callback)] = callback;
  }

  /**
   * 取消订阅指定消息名的回调。
   * @param msgname  - 消息名
   * @param callback - 要取消的回调
   */
  OffMsg(msgname: string, callback: (data: unknown, msgid?: string) => void): void {
    if (!this.m_msg_callbacks[msgname]) return;
    delete this.m_msg_callbacks[msgname][String(callback)];
  }

  /** @private 派发消息给所有订阅者。 */
  private EmitMsg(msgname: string, msgdata: unknown, msgid: string): void {
    const callbacks = this.m_msg_callbacks[msgname];
    if (!callbacks) return;
    for (const cb of Object.values(callbacks)) {
      cb(msgdata, msgid);
    }
  }

  /**
   * 检测 WebView 环境并在就绪时调用 Load()。
   * 仅在 Windows + Edge 环境下执行，最多重试 3 次（每次间隔 1s）。
   * @private
   */
  private CheckLoadWebview(): void {
    const platform = getSystem();
    const isEdge = navigator.userAgent.includes('Edg');
    if (platform !== 'windows' || !isEdge) return;

    let retryCount = 0;
    const MAX_RETRIES = 3;
    const RETRY_INTERVAL = 1000;
    const w = window as Window & { chrome?: { webview?: unknown; app?: unknown; csi?: unknown } };

    const checkWebView = (): void => {
      if (w.chrome?.webview !== undefined && w.chrome?.app !== undefined && w.chrome?.csi !== undefined) {
        window.sessionStorage.setItem('refresh_count', '0');
        console.debug('This is a WebView environment.');
        this.Load();
      } else {
        retryCount++;
        if (retryCount < MAX_RETRIES) {
          console.debug(`webview 未定义，尝试重新获取 (${retryCount})`);
          window.sessionStorage.setItem(
            'refresh_count',
            String(parseInt(window.sessionStorage.getItem('refresh_count') ?? '0') + 1)
          );
          setTimeout(checkWebView, RETRY_INTERVAL);
        } else {
          console.debug('This is a pure web environment.');
        }
      }
    };

    if (document.readyState === 'complete') {
      checkWebView();
    } else {
      window.addEventListener('load', () => { retryCount = 0; checkWebView(); });
    }
  }

  /**
   * 注册 NPLJS 文件的消息接收回调（构造函数内自动调用）。
   * @private
   */
  private registerNPLJSReceive(): void {
    NPL.this(
      (rawMsg: unknown) => {
        let msg: NPLJSMessage;
        try {
          msg = JSON.parse(rawMsg as string) as NPLJSMessage;
          if (typeof msg.msgdata === 'string') {
            msg.msgdata = JSON.parse(atob(msg.msgdata));
          }
        } catch (e) {
          console.log(e);
          console.log(rawMsg);
          return;
        }
        this.RecvMsg(msg);
      },
      { filename: 'NPLJS' }
    );
  }
}

// ──────────────────── ParacraftEvent ────────────────────

/**
 * ParacraftEvent — Keepwork ↔ Paracraft 事件总线。
 *
 * 通过消息前缀隔离，防止与其他 postMessage 用途冲突：
 * - 进入方向（Paracraft → Keepwork）使用前缀 `@keepwork_`
 * - 发出方向（Keepwork → Paracraft）使用前缀 `@webparacraft_`
 *
 * @param npljsInstance - 可选的 NPLJS 实例；不提供时回退到 window.NPLJSInstance
 */
class ParacraftEvent {
  private npljsInstance: NPLJS | null;
  private asIframeInWebParacraft: boolean;
  private asWebviewInParacraftClient: boolean;
  /** 进入消息前缀（Paracraft → Keepwork） */
  readonly eventPrefix = '@keepwork_';
  /** 发出消息前缀（Keepwork → Paracraft） */
  readonly msgPrefix = '@webparacraft_';
  private events: Record<string, (data: unknown) => void>;

  constructor(npljsInstance?: NPLJS) {
    this.npljsInstance = npljsInstance ?? null;
    this.asIframeInWebParacraft = getQueryString('asIframeInWebParacraft') === 'true';
    this.asWebviewInParacraftClient = getQueryString('asWebviewInParacraftClient') === 'true';
    this.events = {};

    if (typeof window !== 'undefined') {
      window.addEventListener('message', this.messageListener.bind(this));
    }
  }

  /** 获取当前有效的 NPLJS 实例（优先构造时注入，回退 window.NPLJSInstance）。 */
  getNPLJSInstance(): NPLJS | null {
    return this.npljsInstance ??
      ((typeof window !== 'undefined' ? (window as Window & { NPLJSInstance?: NPLJS }).NPLJSInstance : null) ?? null);
  }

  /** 是否需要通过 NPLJS 发送出站消息（处于 iframe 或 WebView 模式）。 */
  outGoingMsgNeedToBeSent(): boolean {
    if (typeof window === 'undefined') return false;
    return (window.parent !== window && this.asIframeInWebParacraft) || this.asWebviewInParacraftClient;
  }

  /**
   * 订阅来自 Paracraft 的事件消息。
   *
   * @param name     - 事件名（不含前缀）
   * @param callback - 事件处理回调
   */
  onMsg(name: string, callback: (data: unknown) => void): void {
    this.events[name] = callback;
    const npljs = this.getNPLJSInstance();
    if (this.outGoingMsgNeedToBeSent() && npljs) {
      npljs.OnMsg(this.eventPrefix + name, callback);
    }
  }

  /**
   * 向 Paracraft 发送消息事件。
   *
   * @param name - 事件名（不含前缀）
   * @param data - 消息数据
   */
  sendMsg(name: string, data?: unknown): void {
    const npljs = this.getNPLJSInstance();
    if (this.outGoingMsgNeedToBeSent() && npljs) {
      npljs.SendMsg(this.msgPrefix + name, data);
    }
  }

  /**
   * window message 事件监听器（在构造函数中绑定）。
   * 仅处理带 eventPrefix 前缀的消息。
   */
  messageListener(event: MessageEvent): void {
    const data = event.data as { msgname?: string; msgdata?: unknown } | undefined;
    if (data?.msgname?.startsWith(this.eventPrefix)) {
      const eventName = data.msgname.substring(this.eventPrefix.length);
      this.events[eventName]?.(data.msgdata);
    }
  }
}

// ──────────────────── 导出 ────────────────────

// window 全局挂载：与重构前 NPL.js 一致，保留 window.NPL（供 emscripten 直接调用 window.NPL.receive）。
if (typeof window !== 'undefined') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).NPL = NPL;
}

export { NPL, NPLUtil, NPLJS, ParacraftEvent };
