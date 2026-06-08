/**
 * MqttManager.ts — MQTT 客户端管理器
 *
 * 运行时按需从 CDN 加载 mqtt.js，封装连接/订阅/发布等操作，
 * 并通过内置事件系统通知状态变化和消息到达。
 *
 * ## 使用示例
 * ```ts
 * const mqtt = new MqttManager();
 * mqtt.on('message', ({ topic, message }) => console.log(topic, message));
 * await mqtt.connect({ host: 'broker.example.com', port: 8083, topics: ['my/topic'] });
 * mqtt.publish('my/topic', 'hello');
 * ```
 *
 * 注意：`mqtt.js` 在运行时从 CDN 加载（`window.mqtt`），
 * 不包含在构建产物中。
 */

import SDKLogger from '../utils/SDKLogger';

const console = SDKLogger.createModuleConsole('MqttManager');

// ──────────────────── 类型定义 ────────────────────

/** MQTT 连接配置 */
export interface MqttConfig {
  /** 协议（默认 'wss'） */
  protocol?: string;
  host: string;
  port: number | string;
  username?: string;
  password?: string;
  /** 客户端 ID（默认随机生成） */
  clientId?: string;
  /** KeepAlive 间隔秒数（默认 60） */
  keepalive?: number;
  /** 连接成功后自动订阅的 topic 列表 */
  topics?: string[];
  /** 兼容旧格式：单个 topic（自动转换为 topics 数组） */
  topic?: string;
}

/** 连接状态 */
export type MqttStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

/** message 事件载荷 */
export interface MqttMessageEvent {
  topic: string;
  message: string;
}

/** MqttManager 支持的事件类型 */
export type MqttEventName = 'statusChange' | 'message' | 'error';

/** window.mqtt（运行时 CDN 加载） */
declare const mqtt: {
  connect(options: Record<string, unknown>): MqttClientInstance;
};

/** mqtt.js 客户端实例（简化接口） */
interface MqttClientInstance {
  connected: boolean;
  on(event: string, cb: (...args: unknown[]) => void): void;
  subscribe(topic: string, cb: (err: Error | null) => void): void;
  publish(topic: string, message: string): void;
  end(): void;
}

// ──────────────────── MqttManager ────────────────────

class MqttManager {
  private client: MqttClientInstance | null = null;
  private listeners: Record<string, Array<(data: unknown) => void>> = {};
  private config: MqttConfig | null = null;
  private retryCount = 0;
  private maxRetries = 3;
  status: MqttStatus = 'disconnected';

  // ──────────────────── 事件 API ────────────────────

  /**
   * 注册事件监听器。
   * @param event    - 事件名（'statusChange' | 'message' | 'error'）
   * @param callback - 回调函数
   */
  on(event: MqttEventName, callback: (data: unknown) => void): void {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event]!.push(callback);
  }

  /**
   * 取消注册事件监听器。
   * @param event    - 事件名
   * @param callback - 要取消的回调
   */
  off(event: MqttEventName, callback: (data: unknown) => void): void {
    if (!this.listeners[event]) return;
    this.listeners[event] = this.listeners[event]!.filter((cb) => cb !== callback);
  }

  /** @private 触发事件。 */
  private emit(event: MqttEventName, data?: unknown): void {
    this.listeners[event]?.forEach((cb) => cb(data));
  }

  // ──────────────────── 初始化 ────────────────────

  /**
   * 懒加载 mqtt.js（从 CDN）。
   * 若已加载（window.mqtt 存在）则立即 resolve。
   */
  async LoadMQTT(): Promise<void> {
    if (typeof window !== 'undefined' && (window as Window & { mqtt?: unknown }).mqtt) return;
    const src = 'https://cdn.keepwork.com/keepwork/cdn/mqtt.min.js';
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error(`Failed to load mqtt.js from ${src}`));
      document.body.appendChild(script);
    });
  }

  // ──────────────────── 连接管理 ────────────────────

  /**
   * 建立 MQTT 连接。
   *
   * 优先级：传入 config → 上次缓存的 config → localStorage 中保存的 config。
   * 连接成功后自动订阅 `config.topics`（或 `config.topic`）中的所有 topic。
   *
   * @param config - 连接配置（可选，省略时使用缓存配置）
   */
  async connect(config?: MqttConfig): Promise<void> {
    let effectiveConfig: MqttConfig | null = config ?? this.config;

    if (!effectiveConfig) {
      try {
        const saved = localStorage.getItem('mqtt_config');
        if (saved) {
          effectiveConfig = JSON.parse(saved) as MqttConfig;
          if (!effectiveConfig.topics && effectiveConfig.topic) {
            effectiveConfig.topics = [effectiveConfig.topic];
          }
        }
      } catch (e) {
        console.error('Failed to load MQTT config from storage:', e);
      }
    }

    if (!effectiveConfig) {
      console.error('MQTT connect: No config provided and no stored config');
      this.status = 'error';
      this.emit('statusChange', this.status);
      return;
    }

    try {
      await this.LoadMQTT();
    } catch (e) {
      console.error('Failed to load MQTT library:', e);
      this.status = 'error';
      this.emit('statusChange', this.status);
      return;
    }

    if (this.client?.connected) this.disconnect();

    this.config = effectiveConfig;
    this.status = 'connecting';
    this.emit('statusChange', this.status);

    const { protocol, host, port, username, password, clientId, keepalive, topics } = effectiveConfig;
    const cleanProtocol = (protocol ?? 'wss').replace('://', '');

    const connectOptions: Record<string, unknown> = {
      protocol: cleanProtocol,
      host,
      port: parseInt(String(port)),
      path: '/mqtt',
      clientId: clientId ?? `mqtt_client_${Math.random().toString(16).substring(2, 10)}`,
      keepalive: keepalive ?? 60,
      username,
      password,
      clean: true,
      reconnectPeriod: 5000,
      connectTimeout: 30 * 1000,
    };

    console.log('Connecting to MQTT with options:', connectOptions);

    try {
      this.client = mqtt.connect(connectOptions);

      this.client.on('connect', () => {
        this.OnConnect();
        topics?.forEach((topic) => this.subscribe(topic));
      });

      this.client.on('error', (err: unknown) => {
        console.error('MQTT Error:', err);
        this.status = 'error';
        this.emit('statusChange', this.status);
        this.emit('error', err);
      });

      this.client.on('close', () => { this.OnClose(); });

      this.client.on('message', (topic: unknown, message: unknown) => {
        this.OnMessage(String(topic), { toString: () => String(message) });
      });

      this.client.on('reconnect', () => {
        this.retryCount++;
        console.log(`MQTT Reconnecting... (${this.retryCount}/${this.maxRetries})`);
        if (this.retryCount > this.maxRetries) {
          this.client?.end();
          this.status = 'error';
          this.emit('statusChange', this.status);
          this.emit('error', new Error('Max reconnect attempts reached'));
        }
      });
    } catch (e) {
      console.error('MQTT Connection Exception:', e);
      this.status = 'error';
      this.emit('statusChange', this.status);
    }
  }

  /** @private 连接成功回调。 */
  private OnConnect(): void {
    console.log('MQTT Connected');
    this.status = 'connected';
    this.retryCount = 0;
    this.emit('statusChange', this.status);
  }

  /** @private 连接关闭回调。 */
  private OnClose(): void {
    console.log('MQTT Closed');
    if (this.status !== 'disconnected') {
      this.status = 'disconnected';
      this.emit('statusChange', this.status);
    }
  }

  /**
   * @private 收到消息回调（持久化到 localStorage 并触发 message 事件）。
   */
  private OnMessage(topic: string, message: { toString(): string }): void {
    const msgStr = String(message);
    console.log(`message ${msgStr}\nOn topic: ${topic}`);
    localStorage.setItem(`mqtt_msg_${topic}`, msgStr);
    this.emit('message', { topic, message: msgStr } as MqttMessageEvent);
  }

  /**
   * 断开 MQTT 连接并清理客户端实例。
   */
  disconnect(): void {
    if (this.client) {
      this.client.end();
      this.client = null;
    }
    this.status = 'disconnected';
    this.emit('statusChange', this.status);
  }

  // ──────────────────── Topic 操作 ────────────────────

  /**
   * 订阅指定 topic。
   * 若当前未连接则静默跳过（不抛错）。
   *
   * @param topic - MQTT topic 路径
   */
  subscribe(topic: string): void {
    if (this.client?.connected) {
      this.client.subscribe(topic, (err) => {
        if (!err) console.log(`Subscribed to ${topic}`);
      });
    }
  }

  /**
   * 等待指定 topic 的下一条消息（Promise 封装）。
   * 若 localStorage 中已有缓存消息则立即 resolve。
   *
   * @param topic   - MQTT topic 路径
   * @param timeout - 超时毫秒数（默认 5000）
   * @returns 消息字符串
   */
  get(topic: string, timeout = 5000): Promise<string> {
    this.subscribe(topic);
    return new Promise((resolve, reject) => {
      const cached = localStorage.getItem(`mqtt_msg_${topic}`);
      if (cached !== null) { resolve(cached); return; }

      if (!this.client?.connected) {
        reject(new Error('MQTT not connected'));
        return;
      }

      let resolved = false;
      const timer = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        this.off('message', handler);
        reject(new Error(`Timeout waiting for message on ${topic}`));
      }, timeout);

      const handler = (data: unknown): void => {
        if (resolved) return;
        const evt = data as MqttMessageEvent;
        if (evt.topic === topic) {
          resolved = true;
          clearTimeout(timer);
          this.off('message', handler);
          resolve(evt.message);
        }
      };

      this.on('message', handler);
    });
  }

  /**
   * 向指定 topic 发布消息。
   * 若当前未连接则返回 false。
   *
   * @param topic   - MQTT topic 路径
   * @param message - 消息字符串
   * @returns 是否成功发布
   */
  publish(topic: string, message: string): boolean {
    if (this.client?.connected) {
      this.client.publish(topic, message);
      return true;
    }
    return false;
  }

  /**
   * 更新连接配置（不立即重连，下次 connect() 时生效）。
   * @param config - 新的连接配置
   */
  setConfig(config: MqttConfig): void {
    this.config = config;
  }
}

export default MqttManager;
