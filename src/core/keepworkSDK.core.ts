/**
 * keepworkSDK.core.ts — KeepworkSDK 核心方法 mixin（TypeScript 版）
 *
 * 包含：
 * - 构造辅助（_initCore）
 * - Token / 认证管理（setToken / getAuthHeaders / setUserApiKey 等）
 * - 用户档案缓存与 auth-state 事件通知
 * - HTTP 请求帮助方法（request / get / post / put / delete）
 * - 用户认证接口（login / logout / getUserProfile / VIP 检查等）
 * - AIChat 懒加载（_patchAIChat / loadAIChat）
 *
 * 通过 `applyCoreMixin(KeepworkSDK)` 将所有方法注入到主类 prototype，
 * 不单独导出类，避免循环引用。
 */

import { setCookie } from '../wechat/WxUtils';

// ──────────────────── 公共类型（供 pages / utils / 外部消费） ────────────────────

/** KeepworkSDK 构造选项 */
export interface KeepworkSDKOptions {
  /** 覆盖默认 API 基地址（调试用，生产保持空） */
  baseURL?: string;
  /** 初始认证 token */
  token?: string;
  /** 请求超时 ms（默认 30000） */
  timeout?: number;
  /** 失败重试次数（默认 1） */
  retryCount?: number;
  /** 首次重试延迟 ms（默认 1000，指数退避） */
  retryDelay?: number;
  /** LLM user-api-key */
  userApiKey?: string;
  /** 用户档案缓存时长 ms（默认 30000000 ≈ 500 分钟） */
  userCacheTimeout?: number;
  /** AudioEngine 初始化选项 */
  audioEngine?: Record<string, unknown>;
  /** WxAuth 初始化选项 */
  wxAuth?: Record<string, unknown>;
  /** LocalAPIKeySettings 初始化选项 */
  localAPIKeySettings?: Record<string, unknown>;
}

/** 认证状态变更事件载荷 */
export interface AuthStateChange {
  /** 变更原因 */
  reason: 'tokenChanged' | 'signedOut' | 'userChanged' | 'setCachedUser' | 'profileChanged' | string;
  previousToken?: string | null;
  token?: string | null;
  previousUserKey?: string | null;
  nextUserKey?: string | null;
}

/** 用户档案对象（Keepwork /users/profile 返回结构） */
export interface KwUserProfile {
  id?: number;
  username?: string;
  nickname?: string;
  portrait?: string;
  email?: string;
  mobile?: string;
  /** 普通 VIP 到期时间字符串 */
  commonVipDeadline?: string;
  /** 普通 VIP 标志 */
  commonVip?: boolean | number;
  /** 超级 VIP 到期时间字符串 */
  vipDeadline?: string;
  /** 超级 VIP 标志 */
  vip?: boolean | number;
  /** 实名认证姓名 */
  realname?: string;
  [key: string]: unknown;
}

/** HTTP 请求选项（扩展 RequestInit，支持直接传 body 对象） */
export interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  headers?: Record<string, string>;
}

/** getUserProfile 选项 */
export interface GetProfileOptions {
  useCache?: boolean;
  forceRefresh?: boolean;
}

// ──────────────────── 扩展 Error（携带 status / code 等字段） ────────────────────

interface HttpError extends Error {
  status?: number;
  code?: string;
  attempts?: number;
  originalError?: Error;
  url?: string;
  method?: string;
}

// ──────────────────── Mixin 注入 ────────────────────

/**
 * 将核心方法注入到 KeepworkSDK 类的 prototype（及静态属性）。
 * 调用方式：`applyCoreMixin(KeepworkSDK)`
 *
 * @param TargetClass - KeepworkSDK 主类（带 `_API_BASE_URL` 静态字段）
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function applyCoreMixin(TargetClass: any): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const proto: any = TargetClass.prototype;

  // ─────────────── 构造辅助 ───────────────

  /**
   * 初始化核心字段（由 constructor 内调用）。
   * 包含 baseURL、token、重试策略、用户档案缓存、authStateChange 监听器等。
   *
   * @param options - KeepworkSDKOptions
   */
  proto._initCore = function (options: KeepworkSDKOptions): void {
    const hostname =
      typeof window !== 'undefined' ? window.location.hostname : 'keepwork.com';
    const domain = this.extractMainDomain(hostname) as string;
    this.baseURL =
      options.baseURL ||
      (TargetClass._API_BASE_URL as string) ||
      `https://api.${domain}/core/v0`;
    this.token = options.token ?? this.getTokenFromCookieOrUrl() ?? null;
    this.timeout = options.timeout ?? 30000;
    this.retryCount = options.retryCount ?? 1;
    this.retryDelay = options.retryDelay ?? 1000;
    this.userApiKey = options.userApiKey ?? this._getUserApiKeyFromCacheOrUrl() ?? null;

    this.user = null as KwUserProfile | null;
    this.userCacheTimestamp = null as number | null;
    this.userCacheTimeout = options.userCacheTimeout ?? 30_000_000;
    this._userProfilePromise = null as Promise<KwUserProfile> | null;
    this._lastKnownUserKey = null as string | null;
    this._authStateChangeListeners = new Set<(change: AuthStateChange) => void>();

    this._aiChat = null;
    this._speechRTC = null;
  };

  // ─────────────── 域名 / Token 工具 ───────────────

  /**
   * 提取主域名（去除子域名前缀）。
   * localhost / 127.x / 192.168.x 一律回退到 `keepwork.com`。
   *
   * @param hostname - 完整的 hostname 字符串
   * @returns 主域名（如 `keepwork.com`）
   */
  proto.extractMainDomain = function (hostname: string): string {
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
  };

  /**
   * 依次从以下来源读取认证 token：
   * URL search 参数 → URL hash 参数 → 自身 cookie → 父 frame cookie（跨域安全忽略）。
   *
   * @returns token 字符串，未找到时返回 null
   */
  proto.getTokenFromCookieOrUrl = function (): string | null {
    if (typeof window === 'undefined') return null;

    const urlParams = new URLSearchParams(window.location.search);
    const tokenFromUrl = urlParams.get('token');
    if (tokenFromUrl) return tokenFromUrl;

    if (window.location.hash) {
      const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
      const tokenFromHash = hashParams.get('token');
      if (tokenFromHash) return tokenFromHash;
    }

    function extractFromCookies(cookies: string): string | null {
      if (!cookies) return null;
      for (const cookie of cookies.split('; ')) {
        if (cookie.startsWith('token=')) return cookie.substring(6);
      }
      return null;
    }

    const ownToken = extractFromCookies(document.cookie);
    if (ownToken) return ownToken;

    if (window.parent !== window) {
      try {
        const parentToken = extractFromCookies(window.parent.document.cookie);
        if (parentToken) return parentToken;
      } catch {
        // 跨域 frame 访问受限，属于预期情况
      }
    }
    return null;
  };

  /**
   * 从 URL / hash 参数或 localStorage 读取 `user_api_key`。
   * URL 中找到时自动持久化到 localStorage。
   *
   * @returns API key 字符串，未找到时返回 null
   * @private
   */
  proto._getUserApiKeyFromCacheOrUrl = function (): string | null {
    if (typeof window === 'undefined') return null;

    const urlParams = new URLSearchParams(window.location.search);
    const fromUrl = urlParams.get('user_api_key');
    if (fromUrl) {
      try { localStorage.setItem('keepwork_user_api_key', fromUrl); } catch { /* 忽略 */ }
      return fromUrl;
    }

    if (window.location.hash) {
      const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
      const fromHash = hashParams.get('user_api_key');
      if (fromHash) {
        try { localStorage.setItem('keepwork_user_api_key', fromHash); } catch { /* 忽略 */ }
        return fromHash;
      }
    }

    try {
      const cached = localStorage.getItem('keepwork_user_api_key');
      if (cached) return cached;
    } catch { /* 忽略 */ }
    return null;
  };

  // ─────────────── Token / API key 管理 ───────────────

  /**
   * 设置认证 token，同步写入 cookie，并触发 authStateChange 通知。
   * 传入 null / undefined / '' 视为退出登录。
   *
   * @param token - JWT token 字符串，或 null 以退出
   */
  proto.setToken = function (token: string | null): void {
    const normalizedToken = token || null;
    const previousToken = (this.token as string | null) || null;
    if (previousToken === normalizedToken) return;

    const previousUserKey =
      (this._lastKnownUserKey as string | null) ||
      this._getUserIdentityKey(this.user as KwUserProfile | null);

    this.token = normalizedToken;
    if (normalizedToken) {
      setCookie('token', normalizedToken, 14);
      setCookie('token', normalizedToken, 14, { sameSite: 'None', secure: true });
    } else {
      setCookie('token', '', -1);
      setCookie('token', '', -1, { sameSite: 'None', secure: true });
    }
    this.clearUserCache({ clearIdentity: true });
    this._handleAuthStateChange({
      reason: normalizedToken ? 'tokenChanged' : 'signedOut',
      previousToken,
      token: normalizedToken,
      previousUserKey,
      nextUserKey: null,
    });
  };

  /**
   * 设置 token 并立即刷新用户档案缓存（forceRefresh）。
   *
   * @param token - JWT token 或 null
   * @returns 刷新后的用户档案，或 null（token 为空时）
   */
  proto.setTokenAndRefresh = async function (
    token: string | null
  ): Promise<KwUserProfile | null> {
    this.setToken(token);
    if (token) return (await this.getUserProfile({ forceRefresh: true })) as KwUserProfile;
    return null;
  };

  /**
   * 设置 LLM user-api-key，持久化到 localStorage。
   * 传入 null 仅清除内存，不删除 localStorage（需调用 `clearUserApiKey`）。
   *
   * @param key - API key 字符串，或 null
   * @returns this（链式调用）
   */
  proto.setUserApiKey = function (key: string | null): typeof proto {
    this.userApiKey = key || null;
    if (key) {
      try { localStorage.setItem('keepwork_user_api_key', key); } catch { /* 忽略 */ }
    }
    return this;
  };

  /**
   * 清除 user-api-key（内存 + localStorage）。
   * 清除后，后续 SDK 初始化不再自动恢复此 key。
   *
   * @returns this（链式调用）
   */
  proto.clearUserApiKey = function (): typeof proto {
    this.userApiKey = null;
    try { localStorage.removeItem('keepwork_user_api_key'); } catch { /* 忽略 */ }
    return this;
  };

  /**
   * 获取当前 HTTP 请求头（包含认证 token 和 user-api-key）。
   *
   * @returns 请求头对象
   */
  proto.getAuthHeaders = function (): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
    };
    if (this.token) headers['Authorization'] = `Bearer ${this.token as string}`;
    if (this.userApiKey) headers['user-api-key'] = this.userApiKey as string;
    return headers;
  };

  // ─────────────── 用户档案缓存 ───────────────

  /**
   * 清除用户档案内存缓存。
   * `clearIdentity:true` 时同时重置 `_lastKnownUserKey`。
   *
   * @param options.clearIdentity - 是否同时清除身份标识缓存
   */
  proto.clearUserCache = function (options: { clearIdentity?: boolean } = {}): void {
    this.user = null;
    this.userCacheTimestamp = null;
    this._userProfilePromise = null;
    if (options.clearIdentity === true) this._lastKnownUserKey = null;
  };

  /**
   * 手动写入用户档案缓存（跳过网络请求）。
   *
   * @param profile - 用户档案对象
   */
  proto.setCachedUser = function (profile: KwUserProfile): void {
    this._setUserProfileCache(profile, { reason: 'setCachedUser' });
  };

  /** @private 从 profile 对象提取稳定的用户唯一标识字符串。 */
  proto._getUserIdentityKey = function (
    profile: KwUserProfile | null | undefined
  ): string | null {
    if (!profile || typeof profile !== 'object') return null;
    const raw =
      profile.id ??
      (profile as Record<string, unknown>)['_id'] ??
      (profile as Record<string, unknown>)['userId'] ??
      (profile as Record<string, unknown>)['userid'] ??
      profile.username ??
      (profile as Record<string, unknown>)['name'];
    return raw === undefined || raw === null ? null : String(raw);
  };

  /**
   * @private 写入用户档案缓存，若用户标识发生变化则触发 authStateChange。
   */
  proto._setUserProfileCache = function (
    profile: KwUserProfile,
    options: { reason?: string } = {}
  ): KwUserProfile {
    const previousUserKey =
      (this._lastKnownUserKey as string | null) ||
      this._getUserIdentityKey(this.user as KwUserProfile | null);
    const nextUserKey = this._getUserIdentityKey(profile);

    this.user = profile;
    this.userCacheTimestamp = Date.now();
    if (nextUserKey) this._lastKnownUserKey = nextUserKey;

    if (previousUserKey && nextUserKey && previousUserKey !== nextUserKey) {
      this._handleAuthStateChange({
        reason: options.reason ?? 'userChanged',
        previousUserKey,
        nextUserKey,
        token: (this.token as string | null) ?? null,
      });
    }
    return profile;
  };

  /**
   * 注册认证状态变更监听器（token 变更 / 用户切换 / 登出）。
   * 返回取消订阅函数。
   *
   * @param handler - 变更回调
   * @returns unsubscribe 函数
   */
  proto.onAuthStateChange = function (
    handler: (change: AuthStateChange) => void
  ): () => void {
    if (typeof handler !== 'function') return (): void => { /* noop */ };
    (this._authStateChangeListeners as Set<typeof handler>).add(handler);
    return () => this.offAuthStateChange(handler);
  };

  /** 取消注册认证状态变更监听器。 */
  proto.offAuthStateChange = function (
    handler: (change: AuthStateChange) => void
  ): void {
    (this._authStateChangeListeners as Set<typeof handler>).delete(handler);
  };

  /**
   * @private 触发所有认证状态变更监听器，同时清理 PersonalPageStore 内存缓存。
   */
  proto._handleAuthStateChange = function (change: AuthStateChange): void {
    try {
      (this.personalPageStore as { clearMemoryCache?: () => void } | undefined)
        ?.clearMemoryCache?.();
    } catch (e) {
      console.warn('[KeepworkSDK] Failed to clear PersonalPageStore memory cache:', e);
    }
    const listeners = Array.from(
      (this._authStateChangeListeners as Set<(c: AuthStateChange) => void>) ?? []
    );
    for (const handler of listeners) {
      Promise.resolve(handler(change)).catch((error: unknown) => {
        console.warn('[KeepworkSDK] Auth state change listener failed:', error);
      });
    }
  };

  // ─────────────── HTTP 请求帮助 ───────────────

  /**
   * 通用 HTTP 请求（含指数退避重试）。
   * - 404 错误不重试（资源不存在）
   * - body 为对象时自动 JSON 序列化
   *
   * @param url     - 相对路径（会拼接 baseURL）
   * @param options - 请求选项（method / headers / body 等）
   * @returns 解析后的 JSON 对象或文本字符串
   */
  proto.request = async function (
    url: string,
    options: RequestOptions = {}
  ): Promise<unknown> {
    const { headers: customHeaders = {}, ...customOptions } = options;
    // 先处理 body 序列化，再构建最终 RequestInit
    let resolvedBody: BodyInit | null | undefined = undefined;
    const rawBody = (customOptions as RequestOptions).body;
    if (rawBody !== undefined && rawBody !== null) {
      if (
        rawBody instanceof FormData ||
        rawBody instanceof URLSearchParams ||
        rawBody instanceof Blob ||
        rawBody instanceof ArrayBuffer ||
        typeof rawBody === 'string'
      ) {
        resolvedBody = rawBody as BodyInit;
      } else {
        resolvedBody = JSON.stringify(rawBody);
      }
    }

    const { body: _body, ...restCustomOptions } = customOptions as RequestOptions;
    const requestOptions: RequestInit = {
      method: 'GET',
      ...restCustomOptions,
      headers: {
        ...this.getAuthHeaders(),
        ...(customHeaders as Record<string, string>),
      },
      ...(resolvedBody !== undefined ? { body: resolvedBody } : {}),
    };

    let lastError: HttpError = new Error('Unknown error') as HttpError;

    for (let attempt = 0; attempt < (this.retryCount as number); attempt++) {
      try {
        const response = await fetch(`${this.baseURL as string}${url}`, requestOptions);
        if (!response.ok) {
          const errorData = await response.text();
          const err = new Error(`HTTP ${response.status}: ${errorData}`) as HttpError;
          err.status = response.status;
          throw err;
        }
        const contentType = response.headers.get('content-type');
        if (contentType?.includes('application/json')) return await response.json();
        return await response.text();
      } catch (error) {
        lastError = error as HttpError;
        if (lastError.status === 404) throw lastError;
        if (attempt < (this.retryCount as number) - 1) {
          await this.delay(
            (this.retryDelay as number) * Math.pow(2, attempt)
          );
        }
      }
    }

    const retryExceededError = new Error(
      `Request failed after ${this.retryCount as number} attempts. Last error: ${lastError.message}`
    ) as HttpError;
    retryExceededError.code = 'MAX_RETRY_EXCEEDED';
    retryExceededError.attempts = this.retryCount as number;
    retryExceededError.originalError = lastError;
    retryExceededError.url = `${this.baseURL as string}${url}`;
    retryExceededError.method = (requestOptions.method as string | undefined) ?? 'GET';
    throw retryExceededError;
  };

  /** 延迟工具（用于重试退避）。 */
  proto.delay = function (ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  };

  /**
   * GET 请求便捷方法。
   *
   * @param url    - 相对路径
   * @param params - Query 参数对象
   * @param options - 其他请求选项
   */
  proto.get = async function (
    url: string,
    params: Record<string, string | number | boolean> = {},
    options: RequestOptions = {}
  ): Promise<unknown> {
    const queryString =
      Object.keys(params).length > 0
        ? '?' + new URLSearchParams(
            Object.fromEntries(
              Object.entries(params).map(([k, v]) => [k, String(v)])
            )
          ).toString()
        : '';
    return this.request(`${url}${queryString}`, options);
  };

  /** POST 请求便捷方法。 */
  proto.post = async function (
    url: string,
    data: unknown = {},
    options: RequestOptions = {}
  ): Promise<unknown> {
    return this.request(url, { ...options, method: 'POST', body: data });
  };

  /** PUT 请求便捷方法。 */
  proto.put = async function (
    url: string,
    data: unknown = {},
    options: RequestOptions = {}
  ): Promise<unknown> {
    return this.request(url, { ...options, method: 'PUT', body: data });
  };

  /** DELETE 请求便捷方法（body 可选）。 */
  proto.delete = async function (
    url: string,
    data: unknown = null,
    options: RequestOptions = {}
  ): Promise<unknown> {
    const requestOptions: RequestOptions = { ...options, method: 'DELETE' };
    if (data) requestOptions.body = data;
    return this.request(url, requestOptions);
  };

  // ─────────────── 用户档案工具 ───────────────

  /**
   * @private 通过 dot notation 路径读取对象嵌套属性（如 `'vip.isVip'`）。
   * 任意层级为 null / undefined 时返回 undefined。
   */
  proto._getNestedValue = function (
    obj: Record<string, unknown>,
    path: string
  ): unknown {
    if (!obj || typeof obj !== 'object') return undefined;
    let current: unknown = obj;
    for (const key of path.split('.')) {
      if (current === null || current === undefined || typeof current !== 'object') {
        return undefined;
      }
      current = (current as Record<string, unknown>)[key];
    }
    return current;
  };

  /**
   * @private 读取用户档案（优先内存缓存），并通过 extractor 提取目标字段。
   * 用于消除各 getUserXxx 方法中的重复缓存逻辑。
   */
  proto._getUserDataWithCache = async function <T>(
    extractor: (profile: KwUserProfile) => T,
    options: GetProfileOptions = {}
  ): Promise<T> {
    const { useCache = true } = options;
    if (useCache && this.user) return extractor(this.user as KwUserProfile);
    const profile = await this.getUserProfile(options) as KwUserProfile;
    return extractor(profile);
  };

  // ─────────────── 用户认证接口 ───────────────

  /**
   * 用户名/密码登录。成功后自动调用 `setToken` 更新认证状态。
   *
   * @param credentials - 登录凭证
   */
  proto.login = async function (credentials: {
    username: string;
    password: string;
    captcha?: string;
    captchaKey?: string;
  }): Promise<unknown> {
    const response = await this.post('/users/login', {
      ...credentials,
      platform: 'WEB',
    }) as Record<string, unknown>;
    if (response.token) {
      console.log('user login success: ', response.token);
      this.setToken(response.token as string);
    }
    return response;
  };

  /**
   * 弹出登录窗口 UI（用户名/密码），关闭时 resolve 登录结果。
   *
   * @param options - 窗口显示选项（title 等）
   */
  proto.showLoginWindow = async function (
    options: Record<string, unknown> = {}
  ): Promise<unknown> {
    const response = await (this.loginWindow as { show: (o: unknown) => Promise<Record<string, unknown>> }).show(options);
    if (response?.token) setCookie('token', response.token as string, 14);
    return response;
  };

  /**
   * 弹出用户档案编辑窗口 UI。
   *
   * @param options - 窗口显示选项（title / enablePassword / enableVip 等）
   */
  proto.showProfileWindow = async function (
    options: Record<string, unknown> = {}
  ): Promise<void> {
    return (this.profileWindow as { show: (o: unknown) => Promise<void> }).show(options);
  };

  /**
   * 全局识别微信网页授权回调（URL 带 `wxauth=1&code=...`）并自动完成登录。
   *
   * 微信「使用微信登录」按钮经 `WxAuth.authorize()` 整页跳转授权后，会带着
   * `wxauth=1&code=...&state=auth` 回到本页。此时登录弹窗早已随导航销毁，
   * 没有任何上下文消费该 code，因此放在 SDK 构造时全局兜底处理：
   *  - 已绑定账号：`codeToProbe` 内部已写入 token+cookie 并触发 setToken，
   *    这里仅清理 URL 上的回调参数；
   *  - 未绑定账号：拉起登录弹窗的「设置账号」视图完成绑定。
   *
   * 微信授权 code 一次性，使用 sessionStorage 去重，避免刷新 / 多实例重复消费。
   *
   * @returns 是否识别并处理了回调
   */
  proto.handleWechatRedirectLogin = async function (): Promise<boolean> {
    if (typeof window === 'undefined') return false;
    let url: URL;
    try {
      url = new URL(window.location.href);
    } catch {
      return false;
    }
    const code = url.searchParams.get('code');
    const wxauth = url.searchParams.get('wxauth');
    if (!code || wxauth !== '1') return false;

    // 微信 code 一次性：防止刷新 / 多实例重复消费同一 code
    const guardKey = `kwWxRedirectLogin:${code}`;
    try {
      if (sessionStorage.getItem(guardKey)) return false;
      sessionStorage.setItem(guardKey, '1');
    } catch { /* sessionStorage 不可用时退化为不去重 */ }

    try {
      const result = await this.wxAuth.codeToProbe(code) as {
        success?: boolean;
        data?: Record<string, unknown>;
      };
      const data = result && result.data;

      // 已绑定：codeToProbe 已写入 token+cookie 并触发 setToken。清理 URL 上的
      // 回调参数后整页刷新，使宿主页面以登录态重新初始化（与登录弹窗内的微信
      // 整页跳转登录行为一致）。URL 已无 code + sessionStorage 去重，刷新不会重复触发。
      if (result && result.success && data && data.token) {
        this._clearWechatRedirectQuery();
        if (typeof window !== 'undefined' && window.location && typeof window.location.reload === 'function') {
          window.location.reload();
        }
        return true;
      }

      // 未绑定：拉起登录弹窗的「设置账号」视图完成绑定
      if (result && result.success && data && data.needBind && data.ticket) {
        this._clearWechatRedirectQuery();
        if (data.provider == null) data.provider = 'wechat';
        (this.loginWindow as { showWechatBindSetup?: (d: Record<string, unknown>) => unknown })
          .showWechatBindSetup?.(data);
        return true;
      }
    } catch (err) {
      console.warn('[KeepworkSDK] WeChat redirect login failed:', err);
    }
    return true;
  };

  /** @private 清理当前 URL 上的微信回调参数（code / state / wxauth）。 */
  proto._clearWechatRedirectQuery = function (): void {
    if (typeof window === 'undefined' || !window.history || !window.history.replaceState) return;
    try {
      const url = new URL(window.location.href);
      if (!url.searchParams.has('code') && !url.searchParams.has('state') && !url.searchParams.has('wxauth')) return;
      url.searchParams.delete('code');
      url.searchParams.delete('state');
      url.searchParams.delete('wxauth');
      window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
    } catch { /* ignore */ }
  };

  /**
   * 退出登录。无论 API 成败都清除本地 token。
   */
  proto.logout = async function (): Promise<unknown> {
    let response: unknown;
    try {
      response = await this.post('/users/logout');
    } finally {
      this.setToken(null);
    }
    return response;
  };

  /**
   * 获取当前用户档案，内置内存缓存与并发请求合并（coalesce）。
   *
   * 缓存策略：`useCache && !forceRefresh` 时，若缓存未过期直接返回；
   * 并发调用时只发起一个网络请求，后续调用共享同一 Promise。
   *
   * @param options - useCache（默认 true）/ forceRefresh（默认 false）
   * @returns 用户档案对象
   */
  proto.getUserProfile = async function (
    options: GetProfileOptions = {}
  ): Promise<KwUserProfile> {
    const { useCache = true, forceRefresh = false } = options;
    if (!this.token) throw new Error('Authentication token is required to get user profile');

    if (useCache && !forceRefresh && this.user && this.userCacheTimestamp) {
      if (Date.now() - (this.userCacheTimestamp as number) < (this.userCacheTimeout as number)) {
        return this.user as KwUserProfile;
      }
    }

    if (!forceRefresh && this._userProfilePromise) {
      return this._userProfilePromise as Promise<KwUserProfile>;
    }

    this._userProfilePromise = (this.get('/users/profile') as Promise<KwUserProfile>)
      .then((profile) => {
        this._setUserProfileCache(profile, { reason: 'profileChanged' });
        this._userProfilePromise = null;
        return profile;
      })
      .catch((err: unknown) => {
        this._userProfilePromise = null;
        throw err;
      });

    return this._userProfilePromise as Promise<KwUserProfile>;
  };

  /** 绑定第三方服务账号（如 maisi）。 */
  proto.bindThirdPartyService = async function (
    serviceName: string,
    authData: Record<string, unknown>
  ): Promise<unknown> {
    return this.post(`/oauth_users/${serviceName}`, authData);
  };

  /**
   * 通过 Maisi token 进行 OAuth 登录。
   *
   * @param maisiToken - Maisi 第三方 token
   * @param callback   - 可选回调（result 或 false）
   * @param from       - 来源标识（默认 'prod'）
   */
  proto.loginWithMaisi = async function (
    maisiToken: string,
    callback?: (result: unknown) => void,
    from = 'prod'
  ): Promise<unknown> {
    try {
      const response = await this.bindThirdPartyService('maisi', { maisiToken, from }) as Record<string, unknown>;
      if (response?.token) {
        this.setToken(response.token as string);
        callback?.(response);
        return response;
      }
      callback?.(false);
      return false;
    } catch (error) {
      callback?.(false);
      throw error;
    }
  };

  // ── 用户属性便捷方法（均带缓存） ──

  /** 检查用户是否为 VIP（普通 VIP 或 SVIP）。 */
  proto.isUserVip = function (options?: GetProfileOptions): Promise<boolean> {
    return this._getUserDataWithCache(
      (p: KwUserProfile) => !!(p.commonVip || p.vip),
      options
    );
  };

  /** 检查用户是否为 SVIP。 */
  proto.isUserSvip = function (options?: GetProfileOptions): Promise<boolean> {
    return this._getUserDataWithCache(
      (p: KwUserProfile) => !!p.vip,
      options
    );
  };

  /** 获取普通 VIP 到期日期，未开通时返回 null。 */
  proto.getUserVipExpiration = function (options?: GetProfileOptions): Promise<Date | null> {
    return this._getUserDataWithCache(
      (p: KwUserProfile) => (p.commonVipDeadline ? new Date(p.commonVipDeadline) : null),
      options
    );
  };

  /** 获取 SVIP 到期日期，未开通时返回 null。 */
  proto.getUserSvipExpiration = function (options?: GetProfileOptions): Promise<Date | null> {
    return this._getUserDataWithCache(
      (p: KwUserProfile) => (p.vipDeadline ? new Date(p.vipDeadline) : null),
      options
    );
  };

  /** 检查用户是否已完成实名认证。 */
  proto.isUserRealNameVerified = function (options?: GetProfileOptions): Promise<boolean> {
    return this._getUserDataWithCache(
      (p: KwUserProfile) => !!(p.realname && p.realname.trim()),
      options
    );
  };

  /** 获取用户 ID（数字），不存在时返回 null。 */
  proto.getUserId = function (options?: GetProfileOptions): Promise<number | null> {
    return this._getUserDataWithCache(
      (p: KwUserProfile) => p.id ?? null,
      options
    );
  };

  /** 获取用户名，不存在时返回 null。 */
  proto.getUsername = function (options?: GetProfileOptions): Promise<string | null> {
    return this._getUserDataWithCache(
      (p: KwUserProfile) => p.username ?? null,
      options
    );
  };

  /** 获取用户邮箱，不存在时返回 null。 */
  proto.getUserEmail = function (options?: GetProfileOptions): Promise<string | null> {
    return this._getUserDataWithCache(
      (p: KwUserProfile) => p.email ?? null,
      options
    );
  };

  /** 获取用户显示名（优先 nickname，回退 username），不存在时返回 null。 */
  proto.getUserDisplayName = function (options?: GetProfileOptions): Promise<string | null> {
    return this._getUserDataWithCache(
      (p: KwUserProfile) => p.nickname ?? p.username ?? null,
      options
    );
  };

  /** 获取用户头像 URL，不存在时返回 null。 */
  proto.getUserPortrait = function (options?: GetProfileOptions): Promise<string | null> {
    return this._getUserDataWithCache(
      (p: KwUserProfile) => p.portrait ?? null,
      options
    );
  };

  /**
   * 检查用户档案中是否存在指定字段（dot notation 路径）。
   *
   * @param fieldPath - 如 `'vip'`、`'settings.theme'`
   */
  proto.hasUserField = function (
    fieldPath: string,
    options?: GetProfileOptions
  ): Promise<boolean> {
    return this._getUserDataWithCache(
      (p: KwUserProfile) =>
        this._getNestedValue(p as Record<string, unknown>, fieldPath) !== undefined,
      options
    );
  };

  /**
   * 获取用户档案中的指定字段值（dot notation 路径）。
   *
   * @param fieldPath    - 如 `'vip'`、`'settings.theme'`
   * @param defaultValue - 字段不存在时的默认值
   */
  proto.getUserField = function (
    fieldPath: string,
    defaultValue: unknown = null,
    options?: GetProfileOptions
  ): Promise<unknown> {
    return this._getUserDataWithCache(
      (p: KwUserProfile) => {
        const v = this._getNestedValue(p as Record<string, unknown>, fieldPath);
        return v !== undefined ? v : defaultValue;
      },
      options
    );
  };

  // ─────────────── AIChat 懒加载 ───────────────

  /**
   * 将 AIChat / SpeechRTC 实例注入 SDK（幂等，多次调用只创建一次）。
   * 由 AIChat chunk 加载后调用，或首次访问 `aiChat` / `speechRTC` 属性时自动触发。
   */
  proto._patchAIChat = function (): void {
    if (!this._aiChat && typeof window !== 'undefined' && window.AIChat) {
      this._aiChat = new (window.AIChat as new (sdk: unknown) => unknown)(this);
    }
    if (!this._speechRTC && typeof window !== 'undefined' && window.SpeechRTC) {
      this._speechRTC = new (window.SpeechRTC as new (sdk: unknown) => unknown)(this);
    }
  };

  /**
   * 动态加载 AIChat chunk（`keepworkSDK.AIChat.iife.js`）。
   * URL 由 `KeepworkSDK.source` 推导，保留原始 query string（如 `?v=xxx`）。
   * 若 AIChat 已加载则立即 resolve。
   *
   * @returns 加载完成后 resolve 的 Promise
   */
  proto.loadAIChat = function (): Promise<void> {
    if (this._aiChat) return Promise.resolve();
    if (this._loadAIChatPromise) return this._loadAIChatPromise as Promise<void>;
    this._loadAIChatPromise = new Promise<void>((resolve, reject) => {
      const base = (TargetClass.source as string) || '';
      const [pathPart, ...rest] = base.split('?');
      const qs = rest.length ? '?' + rest.join('?') : '';
      const url =
        (pathPart ?? '').replace(/\/[^/]*$/, '/keepworkSDK.AIChat.iife.js') + qs;
      const script = document.createElement('script');
      script.src = url;
      script.onload = () => { this._patchAIChat(); resolve(); };
      script.onerror = () =>
        reject(new Error(`Failed to load AIChat chunk: ${url}`));
      document.head.appendChild(script);
    });
    return this._loadAIChatPromise as Promise<void>;
  };
}
