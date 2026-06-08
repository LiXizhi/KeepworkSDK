/**
 * WxAuth.ts — 微信网页授权登录模块（完整 TypeScript 实现）
 *
 * 提供微信 OAuth2.0 网页授权登录：环境检测、跳转授权、code 换 token、
 * code 探测绑定状态、自动授权流程。依赖 WxUtils 工具函数。
 */

import {
  detectWxEnvironment,
  isWechatBrowser,
  isInIframe,
  getApiBaseURL,
  getWechatRedirectOrigin,
  normalizeWechatRedirectUri,
  toUrlQueryString,
  parseUrlQueryString,
  getTokenFromCookie,
  setCookie,
} from './WxUtils';
import SDKLogger from '../utils/SDKLogger';
const console = SDKLogger.createModuleConsole('WxAuth');

// ──────────────────── 类型 ────────────────────

/** WxAuth 构造选项 */
export interface WxAuthOptions {
  /** 微信 App ID（默认 'wx7935c49369d421c1'） */
  appId?: string;
  /** 麦思星球微信 App ID */
  maisiAppId?: string;
  /** 授权 scope（'snsapi_base' / 'snsapi_userinfo'，默认后者） */
  scope?: string;
  /** 是否自动注册（默认 false） */
  autoRegister?: boolean;
  /** token Cookie 过期天数（默认 14） */
  tokenCookieDays?: number;
}

/** authorize() 选项 */
export interface WxAuthorizeOptions {
  appId?: string;
  redirectUri?: string;
  scope?: string;
  state?: string;
  extraParams?: Record<string, string>;
}

/** codeToToken() 选项 */
export interface CodeToTokenOptions {
  appId?: string;
  autoRegister?: boolean;
  channel?: string;
  onSuccess?: (response: unknown) => void;
  onFail?: (error: Error) => void;
  refreshPage?: boolean;
}

/** codeToToken() / codeToProbe() 返回结果 */
export interface WxAuthResult {
  success: boolean;
  data?: unknown;
  error?: string;
  isMaisi?: boolean;
}

/** autoAuth() 选项 */
export interface AutoAuthOptions extends WxAuthorizeOptions {
  autoRegister?: boolean;
  channel?: string;
  onSuccess?: (response: unknown) => void;
  onFail?: (error: Error) => void;
  /** 是否仅在生产环境执行（默认 true） */
  productionOnly?: boolean;
  refreshPage?: boolean;
}

/** autoAuth() 返回结果 */
export interface AutoAuthResult {
  success: boolean;
  reason?: string;
  message?: string;
  data?: unknown;
  error?: string;
  isMaisi?: boolean;
}

/** 当前配置 */
export interface WxAuthConfig {
  appId: string;
  maisiAppId: string;
  scope: string;
  autoRegister: boolean;
  isAuthFailed: boolean;
}

/** sdk 需提供的最小接口 */
interface WxAuthSdk {
  setToken(token: string): void;
}

// ──────────────────── 默认配置 ────────────────────

const DEFAULT_CONFIG = {
  appId: 'wx7935c49369d421c1',           // 默认微信 App ID
  maisiAppId: 'wx0ae11671f8e8adb8',      // 麦思星球微信 App ID
  scope: 'snsapi_userinfo',              // 需要用户确认授权
  wxAuthUrl: 'https://open.weixin.qq.com/connect/oauth2/authorize',
  autoRegister: false,                   // 是否自动注册
  tokenCookieDays: 14,                   // token Cookie 过期天数
};

// ──────────────────── WxAuth ────────────────────

export default class WxAuth {
  sdk: WxAuthSdk | null;
  appId: string;
  maisiAppId: string;
  scope: string;
  autoRegister: boolean;
  wxAuthUrl: string;
  tokenCookieDays: number;
  /** 授权失败状态标记，防止循环授权 */
  isAuthFailed: boolean;

  constructor(sdk: unknown, options: WxAuthOptions = {}) {
    this.sdk = (sdk as WxAuthSdk) || null;
    this.appId = options.appId || DEFAULT_CONFIG.appId;
    this.maisiAppId = options.maisiAppId || DEFAULT_CONFIG.maisiAppId;
    this.scope = options.scope || DEFAULT_CONFIG.scope;
    this.autoRegister = options.autoRegister ?? DEFAULT_CONFIG.autoRegister;
    this.wxAuthUrl = DEFAULT_CONFIG.wxAuthUrl;
    this.tokenCookieDays = options.tokenCookieDays || DEFAULT_CONFIG.tokenCookieDays;
    this.isAuthFailed = false;
  }

  /** 是否在微信浏览器中。 */
  isWechatBrowser(): boolean {
    return isWechatBrowser();
  }

  /** 获取微信环境详细信息。 */
  getEnvironment(): ReturnType<typeof detectWxEnvironment> {
    return detectWxEnvironment();
  }

  /** 是否在 iframe 中。 */
  isInIframe(): boolean {
    return isInIframe();
  }

  /** 获取当前 URL 中的授权 code。 */
  getCodeFromUrl(): string | null {
    if (typeof window === 'undefined') return null;
    const params = parseUrlQueryString(window.location.search);
    return params.code || null;
  }

  /** 检查当前是否已登录（有 token）。 */
  isLoggedIn(): boolean {
    return !!getTokenFromCookie();
  }

  /**
   * 跳转到微信授权页面。
   */
  authorize(options: WxAuthorizeOptions = {}): void {
    if (typeof window === 'undefined') {
      console.warn('WxAuth.authorize: Not in browser environment');
      return;
    }

    const appId = options.appId || this.appId;
    const scope = options.scope || this.scope;
    const state = options.state || 'auth';

    // 将 appId 存储到 sessionStorage，以便回调时使用
    if (appId) {
      sessionStorage.setItem('wxAuthAppId', appId);
    }

    // 构建重定向 URI
    let redirectUri: string;
    if (options.redirectUri) {
      redirectUri = normalizeWechatRedirectUri(options.redirectUri);
    } else {
      // 默认使用当前页面，去除 code 参数，添加 wxauth 标记
      const currentParams = parseUrlQueryString(window.location.search);
      delete currentParams.code;
      delete currentParams.state;
      currentParams.wxauth = '1';

      if (options.extraParams) {
        Object.assign(currentParams, options.extraParams);
      }

      const queryString = toUrlQueryString(currentParams);
      redirectUri = `${getWechatRedirectOrigin()}${window.location.pathname}${queryString ? '?' + queryString : ''}`;
    }

    const encodedRedirectUri = encodeURIComponent(redirectUri);
    const wxUrl = `${this.wxAuthUrl}?appid=${appId}&redirect_uri=${encodedRedirectUri}&response_type=code&scope=${scope}&state=${state}#wechat_redirect`;

    window.location.href = wxUrl;
  }

  /**
   * 使用授权 code 换取 token。
   */
  async codeToToken(code: string, options: CodeToTokenOptions = {}): Promise<WxAuthResult> {
    const appId = options.appId || sessionStorage.getItem('wxAuthAppId') || this.appId;
    const autoRegister = options.autoRegister ?? this.autoRegister;
    const channel = options.channel || '';
    const onSuccess = options.onSuccess || ((): void => {});
    const onFail = options.onFail || ((): void => {});
    const refreshPage = options.refreshPage !== false;

    try {
      const apiBaseURL = getApiBaseURL();
      let fetchUrl = `${apiBaseURL}/wxpublic/userTokenByCode?code=${encodeURIComponent(code)}&autoRegister=${autoRegister}&appId=${encodeURIComponent(appId)}`;
      if (channel) {
        fetchUrl += `&channel=${encodeURIComponent(channel)}`;
      }
      const response = await fetch(fetchUrl, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      });

      if (!response.ok) {
        throw new Error(`API request failed: ${response.statusText}`);
      }

      const res = await response.json() as { token?: string; code?: string } & Record<string, unknown>;

      // 麦思星球 App ID 的特殊处理
      if (appId === this.maisiAppId) {
        console.log('Using Maisi App ID for wxCodeToToken');
        onSuccess(res);
        return { success: true, data: res, isMaisi: true };
      }

      if (res && res.token) {
        // 设置 token Cookie（普通 + 跨站 SameSite=None;Secure）
        setCookie('token', res.token, this.tokenCookieDays);
        setCookie('token', res.token, this.tokenCookieDays, { sameSite: 'None', secure: true });

        // 更新 SDK 的 token
        if (this.sdk) {
          this.sdk.setToken(res.token);
        }

        onSuccess(res);
        sessionStorage.removeItem('wxAuthAppId');

        // 刷新页面，移除 URL 中的 code 参数
        if (refreshPage && typeof window !== 'undefined') {
          const currentParams = parseUrlQueryString(window.location.search);
          delete currentParams.code;
          delete currentParams.state;
          delete currentParams.wxauth;

          const queryString = toUrlQueryString(currentParams);
          const newUrl = `${window.location.pathname}${queryString ? '?' + queryString : ''}`;
          window.location.href = newUrl;
        }

        return { success: true, data: res };
      } else {
        // 未注册用户：存储 code 到 sessionStorage
        if (!autoRegister && res && res.code) {
          sessionStorage.setItem('wxCode', res.code);
        }
        this.isAuthFailed = true;
        onFail(new Error('No token in response'));
        return { success: false, error: 'No token in response', data: res };
      }
    } catch (error) {
      this.isAuthFailed = true;
      onFail(error as Error);
      return { success: false, error: (error as Error).message };
    }
  }

  /**
   * 使用授权 code「探测」是否已绑定账号（微信内公众号网页授权，不自动注册）。
   * 已绑定返回用户信息+token；未绑定返回 { needBind, ticket, ... } 由调用方确认。
   */
  async codeToProbe(code: string, options: { appId?: string } = {}): Promise<WxAuthResult> {
    const appId = options.appId || sessionStorage.getItem('wxAuthAppId') || this.appId;
    try {
      const apiBaseURL = getApiBaseURL();
      const fetchUrl = `${apiBaseURL}/wxpublic/userProbeByCode?code=${encodeURIComponent(code)}&appId=${encodeURIComponent(appId)}`;
      const response = await fetch(fetchUrl, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!response.ok) {
        throw new Error(`API request failed: ${response.statusText}`);
      }
      const res = await response.json() as { token?: string } & Record<string, unknown>;

      // 已绑定：设置 token，行为与 codeToToken 成功一致
      if (res && res.token) {
        setCookie('token', res.token, this.tokenCookieDays);
        setCookie('token', res.token, this.tokenCookieDays, { sameSite: 'None', secure: true });
        if (this.sdk) this.sdk.setToken(res.token);
        sessionStorage.removeItem('wxAuthAppId');
      }
      return { success: true, data: res };
    } catch (error) {
      this.isAuthFailed = true;
      return { success: false, error: (error as Error).message };
    }
  }

  /**
   * 自动授权流程入口：检测环境/登录状态，自动发起授权或处理回调。
   */
  async autoAuth(options: AutoAuthOptions = {}): Promise<AutoAuthResult> {
    if (typeof window === 'undefined') {
      return { success: false, reason: 'not_browser', message: 'Not in browser environment' };
    }

    // iframe 防护
    if (this.isInIframe()) {
      return { success: false, reason: 'in_iframe', message: 'Running inside iframe, skip auto auth' };
    }

    // 防止授权失败循环
    if (this.isAuthFailed) {
      return { success: false, reason: 'auth_failed', message: 'Previous auth failed, skip auto auth' };
    }

    // 微信环境检测
    if (!this.isWechatBrowser()) {
      return { success: false, reason: 'not_wechat', message: 'Not in WeChat browser' };
    }

    // 生产环境检测（可选）
    const productionOnly = options.productionOnly !== false;
    if (productionOnly) {
      const hostname = window.location.hostname;
      const isDev = hostname === 'localhost' || hostname.startsWith('127.') || hostname.startsWith('192.168.');
      if (isDev) {
        return { success: false, reason: 'dev_environment', message: 'Skip auto auth in development environment' };
      }
    }

    // 已登录检测
    if (this.isLoggedIn()) {
      return { success: true, reason: 'already_logged_in', message: 'User already logged in' };
    }

    // 检查 URL 中是否有 code
    const code = this.getCodeFromUrl();

    if (code) {
      // 有 code → 换取 token
      return this.codeToToken(code, {
        appId: options.appId,
        autoRegister: options.autoRegister,
        channel: options.channel,
        onSuccess: options.onSuccess,
        onFail: options.onFail,
        refreshPage: options.refreshPage,
      });
    } else {
      // 无 code → 跳转授权页
      this.authorize({
        appId: options.appId,
        scope: options.scope,
        state: options.state,
        extraParams: options.extraParams,
      });
      return { success: true, reason: 'redirecting', message: 'Redirecting to WeChat auth page' };
    }
  }

  /** 重置授权失败状态（用户手动登录或重试授权时调用）。 */
  resetAuthFailedState(): void {
    this.isAuthFailed = false;
  }

  /** 设置默认 App ID。 */
  setAppId(appId: string): void {
    this.appId = appId;
  }

  /** 设置授权作用域。 */
  setScope(scope: string): void {
    this.scope = scope;
  }

  /** 获取当前配置。 */
  getConfig(): WxAuthConfig {
    return {
      appId: this.appId,
      maisiAppId: this.maisiAppId,
      scope: this.scope,
      autoRegister: this.autoRegister,
      isAuthFailed: this.isAuthFailed,
    };
  }
}
