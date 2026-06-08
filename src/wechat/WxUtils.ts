/**
 * WxUtils — 微信公共工具模块
 *
 * 提供微信环境检测、JS-SDK 加载、签名获取、Cookie 工具等共享功能。
 * 被 WxAuth、WxLaunchApp 等模块依赖，也可在宿主页面直接使用。
 */

// ──────────────────── 域名 / URL 工具 ────────────────────

/**
 * 提取主域名（去掉子域名前缀）。
 * 本地开发地址（localhost、127.x、192.168.x）回退为 `keepwork.com`。
 *
 * @param hostname - 完整的 hostname（如 `www.keepwork.com`）
 * @returns 主域名（如 `keepwork.com`）
 */
export function extractMainDomain(hostname: string): string {
  if (
    hostname === 'localhost' ||
    hostname.startsWith('127.') ||
    hostname.startsWith('192.168.') ||
    hostname.trim() === ''
  ) {
    return 'keepwork.com';
  }
  const parts = hostname.split('.');
  if (parts.length <= 2) return hostname;
  return parts.slice(-2).join('.');
}

/**
 * 获取 Keepwork 核心 API 基础 URL（根据当前域名动态推导）。
 *
 * @returns 如 `https://api.keepwork.com/core/v0`
 */
export function getApiBaseURL(): string {
  const hostname =
    typeof window !== 'undefined' ? window.location.hostname : 'keepwork.com';
  const domain = extractMainDomain(hostname);
  return `https://api.${domain}/core/v0`;
}

/** 视为本地开发环境的 hostname 列表 */
const LOCAL_WECHAT_REDIRECT_HOSTS = ['localhost', '0.0.0.0', '::1', '[::1]'];

/**
 * 判断是否为本地开发 hostname（含 127.x 和 192.168.x 段）。
 */
export function isLocalDevHostname(hostname: string): boolean {
  return (
    LOCAL_WECHAT_REDIRECT_HOSTS.includes(hostname) ||
    hostname.startsWith('127.') ||
    hostname.startsWith('192.168.')
  );
}

/**
 * 获取微信授权 `redirect_uri` 所用的 origin。
 *
 * 本地开发时将 hostname 替换为 `keepwork.com`（保持端口），
 * 避免微信回调因域名白名单问题失败。
 */
export function getWechatRedirectOrigin(): string {
  if (typeof window === 'undefined') return '';
  const url = new URL(window.location.origin);
  if (isLocalDevHostname(url.hostname)) url.hostname = 'keepwork.com';
  return url.origin;
}

/**
 * 规范化微信授权 redirect_uri：本地域名替换为 keepwork.com。
 *
 * @param redirectUri - 原始 redirect_uri
 */
export function normalizeWechatRedirectUri(redirectUri: string): string {
  if (!redirectUri) return redirectUri;
  try {
    const url = new URL(
      redirectUri,
      typeof window !== 'undefined' ? window.location.href : undefined
    );
    if (isLocalDevHostname(url.hostname)) url.hostname = 'keepwork.com';
    return url.toString();
  } catch {
    return redirectUri;
  }
}

// ──────────────────── 微信环境检测 ────────────────────

/** 微信环境检测结果 */
export interface WxEnvironment {
  /** 是否在微信内置浏览器中 */
  isWeChat: boolean;
  /** 是否在微信小程序 WebView 中 */
  isMiniProgram: boolean;
  /** 是否在企业微信中 */
  isWorkWeChat: boolean;
  /** 是否在微信开发者工具中 */
  isDevTools: boolean;
  /** 是否处于任意微信环境（以上任一为 true） */
  isAnyWeChat: boolean;
}

/**
 * 检测当前运行环境是否为微信系列环境。
 * 服务端渲染环境（无 navigator）会返回全 false。
 */
export function detectWxEnvironment(): WxEnvironment {
  if (typeof navigator === 'undefined') {
    return {
      isWeChat: false,
      isMiniProgram: false,
      isWorkWeChat: false,
      isDevTools: false,
      isAnyWeChat: false,
    };
  }

  const userAgent = navigator.userAgent.toLowerCase();
  const isWeChat = /micromessenger/i.test(userAgent);
  const isMiniProgram = /miniprogram/i.test(userAgent);
  const isWorkWeChat = /wxwork/i.test(userAgent);
  const isDevTools = /wechatdevtools/i.test(userAgent);

  return {
    isWeChat,
    isMiniProgram,
    isWorkWeChat,
    isDevTools,
    isAnyWeChat: isWeChat || isMiniProgram || isWorkWeChat,
  };
}

/**
 * 简单判断是否在微信内置浏览器中运行。
 */
export function isWechatBrowser(): boolean {
  return detectWxEnvironment().isWeChat;
}

/**
 * 判断当前页面是否处于 iframe 中。
 * 跨域 iframe 访问 `window.parent` 会抛出异常，此时也返回 true。
 */
export function isInIframe(): boolean {
  try {
    return typeof window !== 'undefined' && window.parent !== window;
  } catch {
    return true;
  }
}

// ──────────────────── 微信 JS-SDK 加载 ────────────────────

let wxSdkLoaded = false;
let wxSdkLoading: Promise<typeof wx> | null = null;

/**
 * 懒加载微信 JS-SDK（jweixin-1.6.0.js）。
 *
 * - 若已加载则直接返回全局 `wx` 对象
 * - 若正在加载则等待同一 Promise 完成（防止重复插入 script）
 *
 * @returns 微信 wx 全局对象
 * @throws 若 SDK 加载失败或 wx 对象不可用
 */
export async function loadWxSDK(): Promise<typeof wx> {
  if (wxSdkLoaded && typeof wx !== 'undefined') return wx!;
  if (wxSdkLoading) return wxSdkLoading;

  wxSdkLoading = new Promise<typeof wx>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://res.wx.qq.com/open/js/jweixin-1.6.0.js';
    script.onload = () => {
      if (typeof wx !== 'undefined') {
        wxSdkLoaded = true;
        resolve(wx!);
      } else {
        reject(new Error('wx object not available'));
      }
    };
    script.onerror = () => {
      wxSdkLoading = null;
      reject(new Error('Failed to load WeChat SDK'));
    };
    document.head.appendChild(script);
  });

  return wxSdkLoading;
}

// ──────────────────── 微信签名 ────────────────────

/** getSignature 的参数 */
export interface GetSignatureOptions {
  /** 时间戳（默认当前时间） */
  timestamp?: number;
  /** 随机字符串（默认随机生成） */
  nonceStr?: string;
  /** 平台标识（默认 7） */
  platform?: number;
}

/** 微信签名结果 */
export interface WxSignatureResult {
  signature: string;
  timestamp: number;
  nonceStr: string;
}

/**
 * 从 Keepwork 后端获取微信 JS-SDK 签名。
 *
 * @param url     - 需要签名的 URL（默认当前页面 URL，不含 hash）
 * @param options - 可选参数：timestamp、nonceStr、platform
 */
export async function getSignature(
  url?: string,
  options: GetSignatureOptions = {}
): Promise<WxSignatureResult> {
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
  const nonceStr =
    options.nonceStr ?? Math.random().toString(36).substring(2);
  const currentUrl =
    url ??
    (typeof window !== 'undefined'
      ? window.location.href.split('#')[0]
      : '');
  const platform = options.platform ?? 7;

  const apiBaseURL = getApiBaseURL();

  const response = await fetch(`${apiBaseURL}/wxpublic/signature`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ timestamp, url: currentUrl, noncestr: nonceStr, platform }),
  });

  if (!response.ok) {
    throw new Error(`Failed to get signature: ${response.statusText}`);
  }

  const res = (await response.json()) as { signature: string };
  return { signature: res.signature, timestamp, nonceStr };
}

// ──────────────────── URL 工具 ────────────────────

/**
 * 将对象序列化为 URL 查询字符串（如 `key=value&key2=value2`）。
 * 值为 null/undefined 的键会被过滤掉。
 */
export function toUrlQueryString(obj: Record<string, unknown>): string {
  return Object.keys(obj)
    .filter((key) => obj[key] !== undefined && obj[key] !== null)
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(String(obj[key]))}`)
    .join('&');
}

/**
 * 将 URL 查询字符串解析为对象。
 * 支持带或不带前导 `?` 的字符串。
 */
export function parseUrlQueryString(queryString: string): Record<string, string> {
  if (!queryString) return {};
  const query = queryString.startsWith('?') ? queryString.slice(1) : queryString;
  const params: Record<string, string> = {};
  query.split('&').forEach((pair) => {
    const [key, value] = pair.split('=') as [string, string | undefined];
    if (key) {
      params[decodeURIComponent(key)] = value ? decodeURIComponent(value) : '';
    }
  });
  return params;
}

// ──────────────────── Cookie 工具 ────────────────────

/**
 * 从当前页面的 document.cookie 中提取 token 值。
 *
 * @returns token 字符串，或 null（未找到 / 非浏览器环境）
 */
export function getTokenFromCookie(): string | null {
  if (typeof document === 'undefined') return null;
  try {
    const cookies = document.cookie;
    if (!cookies) return null;
    for (const cookie of cookies.split('; ')) {
      if (cookie.startsWith('token=')) return cookie.substring(6);
    }
  } catch (error) {
    console.warn('Unable to access cookies:', error);
  }
  return null;
}

/** setCookie 的可选配置 */
export interface SetCookieOptions {
  /** SameSite 属性（默认 'Lax'） */
  sameSite?: 'Lax' | 'Strict' | 'None';
  /** 是否添加 Secure 标志（默认 false） */
  secure?: boolean;
  /** Cookie 路径（默认 '/'） */
  path?: string;
}

/**
 * 设置 Cookie。
 *
 * @param name    - Cookie 名称
 * @param value   - Cookie 值
 * @param days    - 过期天数（默认 14 天；-1 表示立即过期/删除）
 * @param options - SameSite、Secure、path 等可选配置
 */
export function setCookie(
  name: string,
  value: string,
  days = 14,
  options: SetCookieOptions = {}
): void {
  if (typeof document === 'undefined') return;

  let expires = '';
  if (days) {
    const date = new Date();
    date.setTime(date.getTime() + days * 24 * 60 * 60 * 1000);
    expires = `; expires=${date.toUTCString()}`;
  }

  const sameSite = options.sameSite ?? 'Lax';
  const secure = options.secure ? '; Secure' : '';
  const path = options.path ?? '/';

  document.cookie = `${name}=${value}${expires}; path=${path}; SameSite=${sameSite}${secure}`;
}

// ──────────────────── 默认导出（兼容性） ────────────────────

export default {
  extractMainDomain,
  getApiBaseURL,
  detectWxEnvironment,
  isWechatBrowser,
  isInIframe,
  loadWxSDK,
  getSignature,
  toUrlQueryString,
  parseUrlQueryString,
  getTokenFromCookie,
  setCookie,
};
