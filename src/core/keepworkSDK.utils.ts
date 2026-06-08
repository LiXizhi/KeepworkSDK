/**
 * keepworkSDK.utils.ts — KeepworkSDK 工具方法 mixin（TypeScript 版）
 *
 * 包含：
 * - Minigame postMessage 桥接（_createMinigameBridge）
 * - SandboxToolEnv Paracraft 快捷入口（createParacraftSandbox）
 * - AgentRouter 全局单例 getter
 * - 通用编码工具（encodeUserData / parsePagePath）
 * - 浏览器/设备检测静态方法（isWeChatBrowser / getSystem 等）
 * - 全局初始化（initializeGlobals）
 * - 全路径快捷方法（autoCreateSiteAndSavePage / getMarkdownByFullPath 等）
 *
 * 依赖：keepworkSDK.core.ts（request/get/post/delete）、
 *       keepworkSDK.pages.ts（savePage/loadPage/deletePage/pageExists）
 */

import SandboxToolEnv from '../ai-chat/SandboxToolEnv';
import AgentRouter from './AgentRouter';
import type { SavePageData, PageResult } from './keepworkSDK.pages';

// ──────────────────── 类型定义 ────────────────────

/** 微信浏览器检测结果 */
export interface WeChatInfo {
  isWeChat: boolean;
  isMiniProgram: boolean;
  isWorkWeChat: boolean;
  isAnyWeChat: boolean;
  userAgent?: string;
  version?: string | null;
  platform?: string | null;
}

/** parsePagePath 结果 */
export interface ParsedPagePath {
  username: string;
  sitename: string;
  pagename: string;
  sitePath: string;
  fullPath: string;
  barePath: string;
}

// ──────────────────── Mixin 注入 ────────────────────

/**
 * 将工具方法注入到 KeepworkSDK 类的 prototype / 静态属性。
 * 调用方式：`applyUtilsMixin(KeepworkSDK)`
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function applyUtilsMixin(TargetClass: any): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const proto: any = TargetClass.prototype;

  // ─────────────── Minigame postMessage 桥接 ───────────────

  /**
   * 创建 minigame 消息桥对象（挂载到 `this.minigame`）。
   * 通过 `window.parent.postMessage` 向父 frame 发送 minigame 控制指令。
   *
   * @returns `{ openSkill, close }` 对象
   */
  proto._createMinigameBridge = function (): {
    openSkill: (options?: string | Record<string, unknown>) => boolean;
    close: (options?: Record<string, unknown>) => boolean;
  } {
    return {
      /**
       * 打开技能面板。
       * @param options - 技能路径字符串或完整选项对象（含 skillPath / promptFile）
       */
      openSkill: (options: string | Record<string, unknown> = {}): boolean => {
        const payload: Record<string, unknown> =
          typeof options === 'string' ? { skillPath: options } : { ...options };
        const promptFile = payload['promptFile'] ?? payload['skillPath'];
        if (!promptFile) return false;
        if (typeof window === 'undefined' || !window.parent) return false;
        window.parent.postMessage(
          { type: 'keepwork:minigame:openSkill', ...payload, promptFile },
          '*'
        );
        return true;
      },
      /**
       * 关闭 minigame 面板。
       */
      close: (options: Record<string, unknown> = {}): boolean => {
        if (typeof window === 'undefined' || !window.parent) return false;
        window.parent.postMessage({ type: 'keepwork:minigame:close', ...options }, '*');
        return true;
      },
    };
  };

  // ─────────────── SandboxToolEnv / AgentRouter ───────────────

  /**
   * 创建连接到 Paracraft Lua 端工具的 SandboxToolEnv（远程代理模式）。
   * 适合需要在 AI session 中调用 Paracraft 内置工具的场景。
   *
   * @param options - 可选：categories（授权工具分类）、workspace（文件操作工作空间）
   * @returns SandboxToolEnv 实例
   */
  proto.createParacraftSandbox = function (
    options: { categories?: string[]; workspace?: string; [key: string]: unknown } = {}
  ): InstanceType<typeof SandboxToolEnv> {
    return new SandboxToolEnv(this, { remoteAgent: 'paracraft', ...options });
  };

  /**
   * AgentRouter 全局单例 getter。
   * 同一 window 下所有 KeepworkSDK 实例共享同一个 AgentRouter，
   * 保证跨 iframe 的 agent 注册与任务转发正常工作。
   */
  Object.defineProperty(proto, 'agentRouter', {
    get(): InstanceType<typeof AgentRouter> | null {
      if (typeof window === 'undefined') return null;
      if (!window.__keepworkAgentRouter) {
        window.__keepworkAgentRouter = new AgentRouter() as unknown;
      }
      return window.__keepworkAgentRouter as InstanceType<typeof AgentRouter>;
    },
    configurable: true,
  });

  // ─────────────── 通用编码工具 ───────────────

  /**
   * 将用户数据编码为 base64 字符串（前缀随机 2 字符，轻度混淆）。
   *
   * @param userData - 任意可序列化对象
   * @returns 混淆后的 base64 字符串
   */
  proto.encodeUserData = function (userData: Record<string, unknown>): string {
    const base64Data = btoa(JSON.stringify(userData));
    const randomPrefix = Math.random().toString(36).substring(2, 4);
    return `${randomPrefix}${base64Data}`;
  };

  /**
   * 将 `"username/sitename/pagename"` 格式路径解析为各组成部分。
   *
   * @param pagePath - 完整页面路径
   * @returns 解析结果对象
   * @throws 路径段不足 3 部分时抛出错误
   */
  proto.parsePagePath = function (pagePath: string): ParsedPagePath {
    const parts = pagePath.split('/');
    if (parts.length < 3) {
      throw new Error('Invalid page path format. Expected: username/sitename/pagename');
    }
    return {
      username: parts[0] ?? '',
      sitename: parts[1] ?? '',
      pagename: parts.slice(2).join('/'),
      sitePath: `${parts[0]}/${parts[1]}`,
      fullPath: `${pagePath}.md`,
      barePath: pagePath,
    };
  };

  // ─────────────── 浏览器 / 设备检测（静态方法） ───────────────

  /**
   * 检测微信浏览器环境（内置浏览器 / 小程序 WebView / 企业微信）。
   *
   * @returns WeChatInfo 检测结果
   */
  TargetClass.isWeChatBrowser = function (): WeChatInfo {
    const userAgent = navigator.userAgent.toLowerCase();
    const isWeChat = /micromessenger/i.test(userAgent);
    const isMiniProgram = /miniprogram/i.test(userAgent);
    const isWorkWeChat = /wxwork/i.test(userAgent);
    return {
      isWeChat,
      isMiniProgram,
      isWorkWeChat,
      isAnyWeChat: isWeChat || isMiniProgram || isWorkWeChat,
    };
  };

  /**
   * 获取详细的微信浏览器信息（版本号、运行平台等）。
   * 非微信环境返回 null。
   *
   * @returns 详细的微信信息对象，或 null
   */
  TargetClass.getWeChatInfo = function (): (WeChatInfo & { userAgent: string; version: string | null; platform: string | null }) | null {
    const userAgent = navigator.userAgent;
    const weChatInfo = (TargetClass as typeof TargetClass).isWeChatBrowser() as WeChatInfo;
    if (!weChatInfo.isAnyWeChat) return null;

    const info: WeChatInfo & { userAgent: string; version: string | null; platform: string | null } = {
      ...weChatInfo,
      userAgent,
      version: null,
      platform: null,
    };

    const versionMatch = userAgent.match(/MicroMessenger\/(\d+\.\d+\.\d+)/i);
    if (versionMatch) info.version = versionMatch[1] ?? null;

    if (/iPhone|iPad|iPod/i.test(userAgent)) info.platform = 'iOS';
    else if (/Android/i.test(userAgent)) info.platform = 'Android';
    else if (/Windows/i.test(userAgent)) info.platform = 'Windows';
    else if (/Mac/i.test(userAgent)) info.platform = 'macOS';

    return info;
  };

  /**
   * 判断是否为移动设备（综合屏幕尺寸、视口宽度和像素密度）。
   *
   * @returns true 表示为移动设备
   */
  TargetClass.isMobileDevice = function (): boolean {
    const screenWidth = window.screen.width;
    const screenHeight = window.screen.height;
    const viewportWidth = window.innerWidth;
    const maxMobileWidth = 768;
    const isSmallScreen = Math.min(screenWidth, screenHeight) <= maxMobileWidth;
    const isSmallViewport = viewportWidth <= maxMobileWidth;
    const highDPI = !!(window.devicePixelRatio && window.devicePixelRatio > 1);
    return (isSmallScreen || isSmallViewport) && (highDPI || isSmallViewport);
  };

  /**
   * 判断是否为手机竖屏模式（宽高比 < 0.75 或 iOS 设备）。
   *
   * @returns true 表示为手机竖屏
   */
  TargetClass.isMobilePortrait = function (): boolean {
    if (typeof document === 'undefined') return false;
    const container =
      (document.querySelector('.iframe-container') as HTMLElement | null) ??
      document.body;
    if (!container) return false;
    const containerWidth = container.clientWidth || window.innerWidth;
    const containerHeight = container.clientHeight || window.innerHeight;
    const aspectRatio = containerWidth / containerHeight;
    return aspectRatio < 0.75 || /iPhone|iPad|iPod/i.test(navigator.userAgent);
  };

  /**
   * 检测当前是否处于全屏模式（兼容各浏览器私有前缀）。
   *
   * @returns true 表示全屏
   */
  TargetClass.checkFullscreen = function (): boolean {
    if (typeof document === 'undefined') return false;
    const doc = document as Document & {
      webkitFullscreenElement?: Element | null;
      mozFullScreenElement?: Element | null;
      msFullscreenElement?: Element | null;
    };
    return !!(
      doc.fullscreenElement ??
      doc.webkitFullscreenElement ??
      doc.mozFullScreenElement ??
      doc.msFullscreenElement
    );
  };

  /**
   * 获取当前运行平台标识字符串。
   * 优先级：`window.paracraft_platform` → URL `?platform` → Chrome WebView → UA 检测。
   *
   * @returns 平台字符串，如 `'windows'` / `'macos'` / `'iPhone'` / `'android'` / `'unknown'`
   */
  TargetClass.getSystem = function (): string {
    if (typeof window !== 'undefined' && (window as Window & { paracraft_platform?: string }).paracraft_platform) {
      return (window as Window & { paracraft_platform?: string }).paracraft_platform!;
    }
    const platform = (TargetClass as typeof TargetClass).getQueryString('platform') as string;
    if (platform && platform !== '') return platform;
    if (typeof window !== 'undefined' && (window as Window & { chrome?: { webview?: unknown } }).chrome?.webview) {
      return 'windows';
    }
    const ua = navigator.userAgent;
    if (/iPhone|iPad|iPod/i.test(ua)) return 'iPhone';
    if (/Mac/i.test(ua)) return 'macos';
    if (/Windows/i.test(ua)) return 'windows';
    if (/Android/i.test(ua)) return 'android';
    if (typeof window !== 'undefined' && (window as Window & { Module?: unknown }).Module) return 'emscripten';
    return 'unknown';
  };

  /**
   * 读取 URL search 参数中的指定参数值。
   *
   * @param name - 参数名
   * @returns 参数值，不存在时返回空字符串
   */
  TargetClass.getQueryString = function (name: string): string {
    if (typeof window === 'undefined') return '';
    return new URLSearchParams(window.location.search).get(name) ?? '';
  };

  // ─────────────── 全局初始化 ───────────────

  /**
   * 初始化浏览器环境全局变量（由 index.ts 的 IIFE 自动调用）。
   * 注入：`window.local_debug` / `window.paracraft_platform` / `window.is_edge_browser`
   */
  TargetClass.initializeGlobals = function (): void {
    if (typeof window === 'undefined') return;
    const win = window as Window & {
      local_debug?: boolean;
      paracraft_platform?: string;
      is_edge_browser?: boolean;
    };
    win.local_debug =
      window.location.hostname === '127.0.0.1' ||
      window.location.hostname === 'localhost';
    win.paracraft_platform = (TargetClass as typeof TargetClass).getSystem() as string;
    win.is_edge_browser = navigator.userAgent.includes('Edg');
  };

  // ─────────────── 全路径快捷方法 ───────────────

  /**
   * 将 `"username/sitename/folder/file"` 全路径自动拆解并调用 `savePage`。
   * 站点不存在时自动建站（`autoCreateSite:true`）。
   *
   * @param fullPath  - 完整路径（不含 .md）
   * @param content   - 页面内容
   * @param callback  - 可选回调 `(result, error?)`
   * @param useCache  - 是否写入服务端缓存
   */
  proto.autoCreateSiteAndSavePage = async function (
    fullPath: string,
    content: string,
    callback?: (result: PageResult | null, error?: Error) => void,
    useCache?: boolean
  ): Promise<PageResult> {
    if (!fullPath || typeof fullPath !== 'string')
      throw new Error('fullPath is required and must be a string');
    const parts = fullPath.split('/');
    if (parts.length < 2) throw new Error('fullPath must contain at least username/sitename');
    const sitePath = `${parts[0]}/${parts[1]}`;
    let pagePath = parts.slice(2).join('/');
    if (!pagePath.endsWith('.md')) pagePath += '.md';
    try {
      const result = await this.savePage({
        sitePath, pagePath, content, autoCreateSite: true, useCache: useCache ?? false,
      } as SavePageData) as PageResult;
      callback?.(result);
      return result;
    } catch (error) {
      callback?.(null, error as Error);
      throw error;
    }
  };

  /**
   * 按全路径读取页面 Markdown 内容，失败时返回 null（不抛出）。
   *
   * @param fullPath  - 完整路径（不含 .md）
   * @param callback  - 可选回调 `(content, error?)`
   * @param useCache  - 是否使用服务端缓存
   */
  proto.getMarkdownByFullPath = async function (
    fullPath: string,
    callback?: (content: string | null, error?: Error) => void,
    useCache?: boolean
  ): Promise<string | null> {
    if (!fullPath || typeof fullPath !== 'string')
      throw new Error('fullPath is required and must be a string');
    const parts = fullPath.split('/');
    if (parts.length < 2) throw new Error('fullPath must contain at least username/sitename');
    const sitePath = `${parts[0]}/${parts[1]}`;
    let pagePath = parts.slice(2).join('/');
    if (!pagePath.endsWith('.md')) pagePath += '.md';
    try {
      const result = await this.loadPage({ sitePath, pagePath, useServerCache: useCache }) as PageResult;
      const content = result.content ?? '';
      callback?.(content);
      return content;
    } catch (error) {
      callback?.(null, error as Error);
      return null;
    }
  };

  /**
   * 按全路径编辑（不存在则创建）页面内容。等同于 `autoCreateSiteAndSavePage`。
   *
   * @param fullPath  - 完整路径（不含 .md）
   * @param content   - 新内容
   * @param callback  - 可选回调
   * @param useCache  - 是否写入服务端缓存
   */
  proto.editMarkdownByFullPath = async function (
    fullPath: string,
    content: string,
    callback?: (result: PageResult | null, error?: Error) => void,
    useCache?: boolean
  ): Promise<PageResult> {
    return this.autoCreateSiteAndSavePage(fullPath, content, callback, useCache) as Promise<PageResult>;
  };

  /**
   * 按全路径删除页面。
   *
   * @param fullPath  - 完整路径（不含 .md）
   * @param callback  - 可选回调 `(result, error?)`
   */
  proto.deleteMarkdownByFullPath = async function (
    fullPath: string,
    callback?: (result: PageResult | null, error?: Error) => void
  ): Promise<PageResult> {
    if (!fullPath || typeof fullPath !== 'string')
      throw new Error('fullPath is required and must be a string');
    const parts = fullPath.split('/');
    if (parts.length < 2) throw new Error('fullPath must contain at least username/sitename');
    const sitePath = `${parts[0]}/${parts[1]}`;
    let pagePath = parts.slice(2).join('/');
    if (!pagePath.endsWith('.md')) pagePath += '.md';
    try {
      const result = await this.deletePage({ sitePath, pagePath }) as PageResult;
      callback?.(result);
      return result;
    } catch (error) {
      callback?.(null, error as Error);
      throw error;
    }
  };

  /**
   * 按全路径检查页面是否存在，失败时返回 false（不抛出）。
   *
   * @param fullPath  - 完整路径（不含 .md）
   * @param callback  - 可选回调 `(exists, error?)`
   */
  proto.checkPageExists = async function (
    fullPath: string,
    callback?: (exists: boolean, error?: Error) => void
  ): Promise<boolean> {
    if (!fullPath || typeof fullPath !== 'string') {
      callback?.(false);
      return false;
    }
    const parts = fullPath.split('/');
    if (parts.length < 2) {
      callback?.(false);
      return false;
    }
    const sitePath = `${parts[0]}/${parts[1]}`;
    let pagePath = parts.slice(2).join('/');
    if (!pagePath.endsWith('.md')) pagePath += '.md';
    try {
      const result = await this.pageExists({ sitePath, pagePath }) as boolean;
      callback?.(result);
      return result;
    } catch (error) {
      callback?.(false, error as Error);
      return false;
    }
  };
}
