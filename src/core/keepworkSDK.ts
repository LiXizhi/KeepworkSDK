/**
 * keepworkSDK.ts — KeepworkSDK 主类（TypeScript 版，组合层）
 *
 * 本文件只保留：
 * 1. 依赖服务的 import
 * 2. 类骨架：静态 getSharedAudioEngine + constructor
 * 3. aiChat / speechRTC 懒加载 getter/setter
 * 4. 三个 mixin 注入（applyCoreMixin / applyPagesMixin / applyUtilsMixin）
 * 5. 静态属性（API_KEYS / source / sourceIsModule / _API_BASE_URL）
 * 6. 浏览器环境自动初始化 + export
 *
 * 具体方法全部由 mixin 文件注入，避免单文件过大。
 */

// ── 服务依赖 ──
import PersonalPageStore from '../store/PersonalPageStore';
import SDKLogger from '../utils/SDKLogger';
import RemoteLog from './RemoteLog';
import AudioEngine from '../audio/AudioEngine';
import Speech from '../audio/Speech';
import CopilotTools from '../ai-chat/CopilotTools';
import WxLaunchApp from '../wechat/WxLaunchApp';
import WxAuth from '../wechat/WxAuth';
import LoginWindow from '../ui/LoginWindow';
import ProfileWindow from '../ui/ProfileWindow';
import CloudDrive from '../store/CloudDrive';
import LocalAPIKeySettings from '../ui/LocalAPIKeySettings';
import AIGenerators from '../ai-chat/AIGenerators';
import UserWorks from '../user/UserWorks';
import SocialFriends from '../user/SocialFriends';

// ── Mixin 注入器 ──
import { applyCoreMixin, type KeepworkSDKOptions } from './keepworkSDK.core';
import { applyPagesMixin } from './keepworkSDK.pages';
import { applyUtilsMixin } from './keepworkSDK.utils';

// ── SDKLogger console 遮蔽（控制 KeepworkSDK 模块日志） ──
const console = SDKLogger.createModuleConsole('KeepworkSDK');

/**
 * ★ API 接口地址配置（调试用）。
 * 留空 '' → 按当前域名自动推导线上地址；
 * 调试完成后务必改回 '' 再提交。
 *
 * 示例（本地 egg）：`'http://localhost:7001/v0'`
 * （注意本地前缀为 `/v0`，线上为 `/core/v0`）
 */
const API_BASE_URL = '';

// ──────────────────── KeepworkSDK 主类 ────────────────────

class KeepworkSDK {

  // ── 静态属性（由 mixin 和 index.ts 写入） ──

  /**
   * 内置 API key 常量。
   *
   * 真实 key 不在源码中硬编码，而是由 Vite `define` 在构建期注入 `__MAISI_API_KEY__`：
   * - CDN/IIFE 构建：从本地 `.env` 的 `MAISI_API_KEY` 注入真实值（自用，不进 npm 包）。
   * - npm 构建：注入空字符串 `''`，确保发布产物不含 key。
   *
   * 因此 npm 包中 `API_KEYS.maisi` 为 `''`；如需鉴权请通过 `setUserApiKey()` 自行提供。
   */
  static API_KEYS: Record<string, string> = {
    maisi: __MAISI_API_KEY__,
  };

  /** bundle 自身 URL（由 index.ts 在加载时写入，供 DigitalHumanFrame 等推导 CDN 路径）。 */
  static source = '';
  static sourceIsModule = false;

  /** 调试用 API 基地址（供 core mixin 的 _initCore 读取）。 */
  static _API_BASE_URL = API_BASE_URL;

  // ── 实例字段声明（具体初始化在 _initCore 中完成） ──
  declare baseURL: string;
  declare token: string | null;
  declare timeout: number;
  declare retryCount: number;
  declare retryDelay: number;
  declare userApiKey: string | null;
  declare user: unknown;
  declare userCacheTimestamp: number | null;
  declare userCacheTimeout: number;
  declare logger: typeof SDKLogger;

  declare personalPageStore: InstanceType<typeof PersonalPageStore>;
  declare remoteLog: InstanceType<typeof RemoteLog>;
  declare speech: InstanceType<typeof Speech>;
  declare copilotTools: InstanceType<typeof CopilotTools>;
  declare wxLaunchApp: InstanceType<typeof WxLaunchApp>;
  declare wxAuth: InstanceType<typeof WxAuth>;
  declare loginWindow: InstanceType<typeof LoginWindow>;
  declare profileWindow: InstanceType<typeof ProfileWindow>;
  declare cloudDrive: InstanceType<typeof CloudDrive>;
  declare localAPIKeySettings: InstanceType<typeof LocalAPIKeySettings>;
  declare aiGenerators: InstanceType<typeof AIGenerators>;
  declare userWorks: InstanceType<typeof UserWorks>;
  declare socialFriends: InstanceType<typeof SocialFriends>;
  /** @deprecated 向后兼容大写别名，请使用 socialFriends */
  declare SocialFriends: InstanceType<typeof SocialFriends>;
  declare audioEngine: unknown;
  declare minigame: { openSkill: (opts?: unknown) => boolean; close: (opts?: unknown) => boolean };

  /** 私有字段（由 _initCore / _patchAIChat 注入） */
  declare _aiChat: unknown;
  declare _speechRTC: unknown;
  declare _authStateChangeListeners: Set<unknown>;
  declare _userProfilePromise: unknown;
  declare _lastKnownUserKey: string | null;
  declare _loadAIChatPromise: Promise<void> | null;
  declare _siteTreeCache: Record<string, { data: unknown; time: number }>;

  // ── 方法声明（由 mixin 注入，在此声明供 TS 识别） ──

  // —— core mixin ——
  /** 全局识别微信网页授权回调（wxauth=1&code=...）并自动完成登录。 */
  declare handleWechatRedirectLogin: () => Promise<boolean>;
  /** 设置认证 token，同步写入 cookie 并触发 authStateChange。 */
  declare setToken: (token: string | null) => void;
  /** 设置 token 并立即刷新用户档案缓存。 */
  declare setTokenAndRefresh: (token: string | null) => Promise<import('./keepworkSDK.core').KwUserProfile | null>;
  /** 设置 LLM user-api-key。 */
  declare setUserApiKey: (key: string | null) => this;
  /** 清除 user-api-key（内存 + localStorage）。 */
  declare clearUserApiKey: () => this;
  /** 获取当前 HTTP 请求头。 */
  declare getAuthHeaders: () => Record<string, string>;
  /** 清除用户档案内存缓存。 */
  declare clearUserCache: (options?: { clearIdentity?: boolean }) => void;
  /** 手动写入用户档案缓存。 */
  declare setCachedUser: (profile: import('./keepworkSDK.core').KwUserProfile) => void;
  /** 注册认证状态变更监听器，返回取消订阅函数。 */
  declare onAuthStateChange: (handler: (change: import('./keepworkSDK.core').AuthStateChange) => void) => () => void;
  /** 取消注册认证状态变更监听器。 */
  declare offAuthStateChange: (handler: (change: import('./keepworkSDK.core').AuthStateChange) => void) => void;
  /** 通用 HTTP 请求（含指数退避重试）。 */
  declare request: (url: string, options?: import('./keepworkSDK.core').RequestOptions) => Promise<unknown>;
  /** GET 请求便捷方法。 */
  declare get: (url: string, params?: Record<string, string | number | boolean>, options?: import('./keepworkSDK.core').RequestOptions) => Promise<unknown>;
  /** POST 请求便捷方法。 */
  declare post: (url: string, data?: unknown, options?: import('./keepworkSDK.core').RequestOptions) => Promise<unknown>;
  /** PUT 请求便捷方法。 */
  declare put: (url: string, data?: unknown, options?: import('./keepworkSDK.core').RequestOptions) => Promise<unknown>;
  /** DELETE 请求便捷方法。 */
  declare delete: (url: string, data?: unknown, options?: import('./keepworkSDK.core').RequestOptions) => Promise<unknown>;
  /** 用户名/密码登录。 */
  declare login: (credentials: { username: string; password: string; captcha?: string; captchaKey?: string }) => Promise<unknown>;
  /** 弹出登录窗口 UI。 */
  declare showLoginWindow: (options?: Record<string, unknown>) => Promise<unknown>;
  /** 弹出用户档案编辑窗口 UI。 */
  declare showProfileWindow: (options?: Record<string, unknown>) => Promise<void>;
  /** 退出登录。 */
  declare logout: () => Promise<unknown>;
  /**
   * 获取当前用户档案（内置内存缓存）。
   * @param options - useCache（默认 true）/ forceRefresh（默认 false）
   */
  declare getUserProfile: (options?: import('./keepworkSDK.core').GetProfileOptions) => Promise<import('./keepworkSDK.core').KwUserProfile>;
  /** 绑定第三方服务账号。 */
  declare bindThirdPartyService: (serviceName: string, authData: Record<string, unknown>) => Promise<unknown>;
  /** 通过 Maisi token 进行 OAuth 登录。 */
  declare loginWithMaisi: (maisiToken: string, callback?: (result: unknown) => void, from?: string) => Promise<unknown>;
  /** 检查用户是否为 VIP。 */
  declare isUserVip: (options?: import('./keepworkSDK.core').GetProfileOptions) => Promise<boolean>;
  /** 检查用户是否为 SVIP。 */
  declare isUserSvip: (options?: import('./keepworkSDK.core').GetProfileOptions) => Promise<boolean>;
  /** 获取普通 VIP 到期日期。 */
  declare getUserVipExpiration: (options?: import('./keepworkSDK.core').GetProfileOptions) => Promise<Date | null>;
  /** 获取 SVIP 到期日期。 */
  declare getUserSvipExpiration: (options?: import('./keepworkSDK.core').GetProfileOptions) => Promise<Date | null>;
  /** 检查用户是否已实名认证。 */
  declare isUserRealNameVerified: (options?: import('./keepworkSDK.core').GetProfileOptions) => Promise<boolean>;
  /** 获取用户 ID。 */
  declare getUserId: (options?: import('./keepworkSDK.core').GetProfileOptions) => Promise<number | null>;
  /** 获取用户名。 */
  declare getUsername: (options?: import('./keepworkSDK.core').GetProfileOptions) => Promise<string | null>;
  /** 获取用户邮箱。 */
  declare getUserEmail: (options?: import('./keepworkSDK.core').GetProfileOptions) => Promise<string | null>;
  /** 获取用户显示名（优先 nickname，回退 username）。 */
  declare getUserDisplayName: (options?: import('./keepworkSDK.core').GetProfileOptions) => Promise<string | null>;
  /** 获取用户头像 URL。 */
  declare getUserPortrait: (options?: import('./keepworkSDK.core').GetProfileOptions) => Promise<string | null>;
  /** 检查用户档案中是否存在指定字段（dot notation）。 */
  declare hasUserField: (fieldPath: string, options?: import('./keepworkSDK.core').GetProfileOptions) => Promise<boolean>;
  /** 获取用户档案中的指定字段值（dot notation）。 */
  declare getUserField: (fieldPath: string, defaultValue?: unknown, options?: import('./keepworkSDK.core').GetProfileOptions) => Promise<unknown>;
  /** 动态加载 AIChat chunk。 */
  declare loadAIChat: () => Promise<void>;

  // ──────────────────── 静态方法声明（mixin 注入，在此声明供 TS 识别） ────────────────────
  static initializeGlobals: () => void;
  static getSystem: () => string;
  static getQueryString: (name: string) => string;
  static isWeChatBrowser: () => unknown;
  static getWeChatInfo: () => unknown;
  static isMobileDevice: () => boolean;
  static isMobilePortrait: () => boolean;
  static checkFullscreen: () => boolean;

  // ──────────────────── 静态方法 ────────────────────

  /**
   * 获取（或创建）全局共享的 AudioEngine 实例。
   * 多个 SDK 实例共用同一音频引擎，避免重复初始化开销。
   *
   * @param options - AudioEngine 初始化选项
   */
  static getSharedAudioEngine(options: Record<string, unknown> = {}): unknown {
    return (AudioEngine as unknown as { getShared: (o: Record<string, unknown>) => unknown }).getShared(options);
  }

  // ──────────────────── 构造函数 ────────────────────

  /**
   * 创建 KeepworkSDK 实例，初始化所有子服务。
   *
   * 构造顺序：
   * 1. `_initCore(options)` — 初始化 token / baseURL / 缓存等基础字段（由 core mixin 注入）
   * 2. 按依赖顺序实例化各子服务
   * 3. `_patchAIChat()` — 若 AIChat chunk 已加载则立即绑定（由 core mixin 注入）
   *
   * @param options - 初始化选项
   */
  constructor(options: KeepworkSDKOptions = {}) {
    // _initCore 由 keepworkSDK.core.ts mixin 注入
    (this as unknown as { _initCore: (o: KeepworkSDKOptions) => void })._initCore(options);

    // ── 子服务初始化（按依赖顺序） ──
    this.audioEngine = KeepworkSDK.getSharedAudioEngine(options.audioEngine ?? {});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sdk = this as any;
    this.personalPageStore = new PersonalPageStore(sdk);
    this.remoteLog = new RemoteLog(sdk);
    this.speech = new Speech(sdk);
    this.copilotTools = new CopilotTools(sdk);
    this.wxLaunchApp = new WxLaunchApp(sdk);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.wxAuth = new WxAuth(sdk, (options.wxAuth ?? {}) as any);
    this.loginWindow = new LoginWindow(sdk);
    this.profileWindow = new ProfileWindow(sdk);
    this.cloudDrive = new CloudDrive(sdk);
    this.localAPIKeySettings = new LocalAPIKeySettings(sdk, options.localAPIKeySettings ?? {});
    this.aiGenerators = new AIGenerators(sdk);
    this.userWorks = new UserWorks(sdk);
    this.socialFriends = new SocialFriends(sdk);
    this.SocialFriends = this.socialFriends; // 向后兼容大写别名
    this.minigame = sdk._createMinigameBridge();
    this.logger = SDKLogger;

    // AIChat / SpeechRTC 来自独立的 AIChat chunk，按需懒加载注入。
    // 通过 _patchAIChat() 绑定，或在首次访问 aiChat / speechRTC 属性时自动触发。
    this._aiChat = null;
    this._speechRTC = null;
    this._loadAIChatPromise = null;
    (this as unknown as { _patchAIChat: () => void })._patchAIChat();

    // 全局识别微信网页授权回调（URL 带 wxauth=1&code=...）并自动完成登录。
    // 延迟到构造结束后的微任务执行，避免阻塞实例化；方法由 core mixin 注入。
    if (typeof window !== 'undefined') {
      Promise.resolve().then(() =>
        (this as unknown as { handleWechatRedirectLogin?: () => Promise<boolean> })
          .handleWechatRedirectLogin?.()
      ).catch(() => { /* 全局兜底登录失败不影响 SDK 初始化 */ });
    }
  }

  // ──────────────────── AIChat / SpeechRTC 懒加载 getter/setter ────────────────────
  // 实际方法（_patchAIChat / loadAIChat）由 keepworkSDK.core.ts mixin 注入

  /**
   * AIChat 实例（来自 AIChat chunk）。
   * 首次访问时自动触发懒加载（调用 `_patchAIChat()`）。
   */
  get aiChat(): unknown {
    (this as unknown as { _patchAIChat: () => void })._patchAIChat();
    return this._aiChat;
  }
  set aiChat(v: unknown) { this._aiChat = v; }

  /**
   * SpeechRTC 实例（来自 AIChat chunk）。
   * 首次访问时自动触发懒加载（调用 `_patchAIChat()`）。
   */
  get speechRTC(): unknown {
    (this as unknown as { _patchAIChat: () => void })._patchAIChat();
    return this._speechRTC;
  }
  set speechRTC(v: unknown) { this._speechRTC = v; }
}

// ──────────────────── 注入 mixin 方法 ────────────────────
// 顺序：core（基础） → pages（依赖 core 的 request）→ utils（依赖 pages 的 savePage 等）
applyCoreMixin(KeepworkSDK);
applyPagesMixin(KeepworkSDK);
applyUtilsMixin(KeepworkSDK);

// ──────────────────── 浏览器环境自动初始化 ────────────────────
if (typeof window !== 'undefined') {
  KeepworkSDK.initializeGlobals();
  window.KeepworkSDK = KeepworkSDK;
}

export default KeepworkSDK;

// 同时导出常用类型，方便外部使用
export type { KeepworkSDKOptions } from './keepworkSDK.core';
export type { SavePageData, LoadPageInfo, DeletePageInfo, PageResult, PageMetadata, CreateSiteData } from './keepworkSDK.pages';
export type { ParsedPagePath, WeChatInfo } from './keepworkSDK.utils';
