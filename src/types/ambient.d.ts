/**
 * ambient.d.ts — 运行时动态加载的第三方库 ambient 类型声明
 *
 * 这些库不在 package.json 中，在运行时由 CDN 或宿主页面注入到 window。
 * 类型声明以"够用"为原则：覆盖 SDK 实际调用到的方法/属性，
 * 未使用的细节可留作 unknown 或日后补全。
 */

// ──────────────────── MQTT (mqtt.js via CDN) ────────────────────

/** mqtt.js 客户端实例（运行时 CDN 加载，CDN 全局为 mqtt / Paho.MQTT 等） */
declare namespace MqttClient {
  interface IClientOptions {
    username?: string;
    password?: string;
    clientId?: string;
    clean?: boolean;
    reconnectPeriod?: number;
    connectTimeout?: number;
    keepalive?: number;
    [key: string]: unknown;
  }

  interface ISubscribeOptions {
    qos?: 0 | 1 | 2;
  }

  interface IPublishOptions {
    qos?: 0 | 1 | 2;
    retain?: boolean;
  }

  interface MqttClientInstance {
    on(event: 'connect' | 'reconnect' | 'disconnect' | 'offline' | 'error' | 'end', listener: (...args: unknown[]) => void): this;
    on(event: 'message', listener: (topic: string, payload: Buffer | Uint8Array, packet: unknown) => void): this;
    subscribe(topic: string | string[], opts: ISubscribeOptions, callback?: (err: Error | null, granted: unknown) => void): this;
    unsubscribe(topic: string | string[], callback?: (err: Error | null) => void): this;
    publish(topic: string, message: string | Buffer, opts?: IPublishOptions, callback?: (err?: Error) => void): this;
    end(force?: boolean, opts?: object, callback?: () => void): this;
    connected: boolean;
    disconnected: boolean;
    reconnecting: boolean;
  }

  function connect(brokerUrl: string, opts?: IClientOptions): MqttClientInstance;
}

// ──────────────────── WeChat JS-SDK (wx) ────────────────────

/** WeChat JS-SDK 全局对象 wx，运行时由微信内置环境提供 */
declare namespace WxSDK {
  interface ConfigOptions {
    debug?: boolean;
    appId: string;
    timestamp: string | number;
    nonceStr: string;
    signature: string;
    jsApiList: string[];
    openTagList?: string[];
  }

  interface LaunchMiniProgramOptions {
    userName: string;
    path?: string;
    miniProgramType?: 0 | 1 | 2;
    success?: (res: unknown) => void;
    fail?: (res: unknown) => void;
    complete?: (res: unknown) => void;
  }

  interface WxInstance {
    config(options: ConfigOptions): void;
    ready(callback: () => void): void;
    error(callback: (res: { errMsg: string }) => void): void;
    launchMiniProgram(options: LaunchMiniProgramOptions): void;
    miniProgram: {
      navigateTo(options: { url: string }): void;
      postMessage(options: { data: unknown }): void;
      getEnv(callback: (res: { miniprogram: boolean }) => void): void;
    };
    [key: string]: unknown;
  }
}

declare var wx: WxSDK.WxInstance | undefined;

// ──────────────────── VolcEngine RTC SDK ────────────────────

/** VolcEngine (火山引擎) RTC SDK，运行时从火山 CDN 加载 */
declare namespace VRTC {
  interface RTCEngineOptions {
    appId: string;
    roomId?: string;
    userId?: string;
    token?: string;
    [key: string]: unknown;
  }

  interface RTCEngineInstance {
    joinRoom(options: {
      token: string;
      roomId: string;
      userId: string;
      userInfo?: { extraInfo?: string };
    }): Promise<void>;
    leaveRoom(): Promise<void>;
    startAudioCapture(deviceId?: string): Promise<void>;
    stopAudioCapture(): Promise<void>;
    publishStream(type: number): Promise<void>;
    unpublishStream(type: number): Promise<void>;
    sendBinaryMessage(uid: string | null, data: Uint8Array | ArrayBuffer): number;
    sendMessage(uid: string | null, message: string): number;
    on(event: string, callback: (...args: unknown[]) => void): void;
    off(event: string, callback?: (...args: unknown[]) => void): void;
    destroy(): Promise<void>;
    [key: string]: unknown;
  }

  interface RTCSDK {
    createEngine(appId: string): RTCEngineInstance;
    createEngineWithConfig(config: RTCEngineOptions): RTCEngineInstance;
    getSupportedCodecs(): Promise<unknown>;
    [key: string]: unknown;
  }
}

declare var VERTC: VRTC.RTCSDK | undefined;

// ──────────────────── Live2D Cubism SDK ────────────────────

/** Live2D Cubism Web SDK，运行时加载 */
declare var PIXI: unknown;
declare var Live2DCubismCore: unknown;

// ──────────────────── NPL / Paracraft 桥接 ────────────────────

/** Paracraft 内置 NPL JavaScript 桥，仅在 Paracraft WebView 环境中存在 */
declare var NPL: {
  activate(filename: string, msg?: unknown): void;
  call(filename: string, msg?: unknown): void;
  load(filename: string): void;
  [key: string]: unknown;
} | undefined;

// ──────────────────── 构建期注入常量（Vite define） ────────────────────

/**
 * maisi 项目 API Key —— 由 Vite `define` 在构建期替换为字面量字符串。
 *
 * - CDN/IIFE 构建：从本地 `.env` 的 `MAISI_API_KEY` 注入真实 key（自用，不进 npm 包）。
 * - npm 构建：注入空字符串 `''`，确保发布到 npm 的产物不含任何 key。
 *
 * 源码中不得硬编码真实 key，统一通过此常量读取。
 */
declare const __MAISI_API_KEY__: string;
