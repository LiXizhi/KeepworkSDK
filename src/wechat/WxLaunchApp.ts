/**
 * WxLaunchApp.ts — 微信"打开 App"开放标签集成（完整 TypeScript 实现）
 *
 * 在微信内置浏览器中通过 `wx-open-launch-app` 标签唤起原生 App，失败时回退到下载页。
 * 依赖 WxUtils 做环境检测、JS-SDK 加载和签名获取。
 */

import { detectWxEnvironment, loadWxSDK, getSignature as getWxSignature } from './WxUtils';
import SDKLogger from '../utils/SDKLogger';
const console = SDKLogger.createModuleConsole('WxLaunchApp');

// ──────────────────── 类型 ────────────────────

/** configure() 选项 */
export interface WxLaunchConfigureOptions {
  appId?: string;
  signature?: string;
  debug?: boolean;
}

/** initialize() 选项 */
export interface WxLaunchInitializeOptions {
  appId?: string;
  url?: string;
  debug?: boolean;
}

/** initialize() 返回结果 */
export interface WxLaunchInitResult {
  success: boolean;
  isWechat?: boolean;
  isDevTools?: boolean;
  message: string;
}

/** createLaunchButton() 选项 */
export interface WxLaunchButtonOptions {
  /** 目标 App 包名（Android） */
  package?: string;
  /** 唤起路径 */
  path?: string;
  /** 唤起参数 */
  params?: string;
  /** 按钮文案 */
  buttonText?: string;
  /** 未配置时是否自动初始化 */
  autoInit?: boolean;
  /** 自动初始化用的 appId */
  appId?: string;
  /** 自动初始化用的 url */
  url?: string;
  /** 调试模式 */
  debug?: boolean;
  /** 标签 ready 回调 */
  onReady?: () => void;
  /** 唤起成功回调 */
  onLaunch?: (e: Event) => void;
  /** 唤起失败回调 */
  onError?: (e: Event) => void;
}

/** 环境信息 */
export interface WxLaunchEnvironmentInfo {
  isWechat: boolean;
  isDevTools: boolean;
  isSdkLoaded: boolean;
  isConfigured: boolean;
  appId: string;
  launchAppId: string;
}

// ──────────────────── WxLaunchApp ────────────────────

export default class WxLaunchApp {
  sdk: unknown;
  wx: WxSDK.WxInstance | null;
  isSdkLoaded: boolean;
  isConfigured: boolean;
  appId: string;
  launchAppId: string;
  downloadUrl: string;
  isWechat: boolean;
  isDevTools: boolean;
  timestamp: number;
  nonceStr: string;

  constructor(sdk: unknown) {
    this.sdk = sdk;
    this.wx = null;
    this.isSdkLoaded = false;
    this.isConfigured = false;
    this.appId = 'wx0ae11671f8e8adb8';
    this.launchAppId = 'wxd8246d1bfd4a03b9';
    this.downloadUrl = 'https://keepwork.com/maisi/maisi/download?noJumpToWx';
    this.isWechat = false;
    this.isDevTools = false;
    this.timestamp = Math.floor(Date.now() / 1000);
    this.nonceStr = Math.random().toString(36).substring(2);

    this.detectEnvironment();
  }

  /** 检测运行环境（是否微信 / 开发者工具）。 */
  detectEnvironment(): void {
    const env = detectWxEnvironment();
    this.isWechat = env.isWeChat;
    this.isDevTools = env.isDevTools;
  }

  /** 加载微信 JS-SDK。 */
  async loadSDK(): Promise<boolean> {
    if (this.isSdkLoaded && typeof wx !== 'undefined') {
      return true;
    }
    this.wx = (await loadWxSDK()) ?? null;
    this.isSdkLoaded = true;
    return true;
  }

  /** 配置 JS-SDK（注入签名，启用 wx-open-launch-app 开放标签）。 */
  async configure(options: WxLaunchConfigureOptions = {}): Promise<boolean> {
    const { appId, signature } = options;

    if (!appId) throw new Error('appId is required');
    if (!signature) throw new Error('signature is required');

    await this.loadSDK();
    const wxInstance = this.wx;
    if (!wxInstance) throw new Error('WeChat JS-SDK not loaded');

    return new Promise<boolean>((resolve, reject) => {
      wxInstance.config({
        debug: options.debug || false,
        appId: appId,
        timestamp: this.timestamp,
        nonceStr: this.nonceStr,
        signature: signature,
        jsApiList: [],
        openTagList: ['wx-open-launch-app'],
      });

      wxInstance.ready(() => {
        this.isConfigured = true;
        this.appId = appId;
        resolve(true);
      });

      wxInstance.error((res) => {
        reject(new Error(`WeChat config failed: ${JSON.stringify(res)}`));
      });
    });
  }

  /** 获取指定 URL 的 JS-SDK 签名。 */
  async getSignature(url?: string): Promise<{ signature: string }> {
    const currentUrl = url || window.location.href.split('#')[0];
    const result = await getWxSignature(currentUrl, {
      timestamp: this.timestamp,
      nonceStr: this.nonceStr,
    });
    return { signature: result.signature };
  }

  /** 初始化（加载 SDK + 配置签名）。 */
  async initialize(options: WxLaunchInitializeOptions = {}): Promise<WxLaunchInitResult> {
    if (!this.isWechat) {
      return { success: false, isWechat: false, message: 'Not in WeChat environment' };
    }

    try {
      const res = await this.getSignature(options.url);
      await this.configure({
        appId: options.appId || this.appId,
        signature: res.signature,
        debug: options.debug || false,
      });
      return { success: true, message: 'Initialized successfully' };
    } catch (error) {
      return { success: false, message: (error as Error).message };
    }
  }

  /** 在容器中创建唤起按钮，返回按钮元素 id（失败返回 null）。 */
  createLaunchButton(container: HTMLElement, options: WxLaunchButtonOptions = {}): string | null {
    if (!container) {
      console.error('Container element is required');
      return null;
    }

    if (!this.isConfigured) {
      console.warn('WeChat SDK not configured. Please call initialize() first, or the button may not work properly.');
      console.warn('Example: await wxLaunchApp.initialize({ appId: "your-appid" })');

      // 提供自动初始化选项时尝试初始化
      if (options.autoInit && options.appId) {
        console.log('Attempting auto-initialization...');
        this.initialize({
          appId: options.appId,
          url: options.url,
          debug: options.debug,
        }).then(result => {
          if (result.success) {
            console.log('Auto-initialization successful, recreating button...');
            this.createLaunchButton(container, { ...options, autoInit: false });
          } else {
            console.error('Auto-initialization failed:', result.message);
          }
        }).catch(err => {
          console.error('Auto-initialization error:', err);
        });
        return null;
      }
      // 未配置且未提供自动初始化：继续创建（可能不工作），至少 UI 可显示
    }

    const scriptId = 'wx-launch-btn-' + Math.random().toString(36).slice(2);
    const packageName = options.package || 'com.maseai.msplanet';
    const path = options.path || '';
    const params = options.params || '';
    const extinfo = JSON.stringify({ package: packageName, path, params });

    const buttonHtml = `
      <wx-open-launch-app
        id="${scriptId}"
        appid="${this.launchAppId}"
        extinfo='${extinfo}'
        style="display: block; width: 100%; max-width: 200px; height: 50px; margin: 0 auto;"
      >
        <script type="text/wxtag-template">
          <style>
            .btn {
              display: block;
              width: 100%;
              height: 100%;
              background-color: #07c160;
              color: white;
              border: none;
              border-radius: 8px;
              font-size: 16px;
              font-weight: 500;
              line-height: 50px;
              text-align: center;
              padding: 0;
              margin: 0;
              text-decoration: none;
            }
          </style>
          <button class="btn">${options.buttonText || '打开App'}</button>
        </` + `script>
      </wx-open-launch-app>
    `;

    container.innerHTML = buttonHtml;

    setTimeout(() => {
      const btn = document.getElementById(scriptId);
      if (btn) {
        btn.addEventListener('ready', () => {
          if (options.onReady) options.onReady();
        });
        btn.addEventListener('launch', (e) => {
          if (options.onLaunch) options.onLaunch(e);
        });
        btn.addEventListener('error', (e) => {
          if (options.onError) options.onError(e);
        });
      }
    }, 100);

    return scriptId;
  }

  /** 唤起失败时跳转下载页。 */
  handleFallback(url?: string): void {
    const downloadUrl = url || this.downloadUrl;
    window.location.href = downloadUrl;
  }

  /** 获取环境信息。 */
  getEnvironmentInfo(): WxLaunchEnvironmentInfo {
    return {
      isWechat: this.isWechat,
      isDevTools: this.isDevTools,
      isSdkLoaded: this.isSdkLoaded,
      isConfigured: this.isConfigured,
      appId: this.appId,
      launchAppId: this.launchAppId,
    };
  }

  /** 设置唤起 AppId。 */
  setLaunchAppId(appId: string): void {
    this.launchAppId = appId;
  }

  /** 设置下载 URL。 */
  setDownloadUrl(url: string): void {
    this.downloadUrl = url;
  }
}
