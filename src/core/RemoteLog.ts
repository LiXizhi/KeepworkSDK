/**
 * RemoteLog — 行为事件远程上报模块
 *
 * 模拟 Lua 端 EventTrackingService 的埋点行为：
 * - 单次点击事件（type=1）：发生即上报
 * - 时长事件（type=2）：开始/结束各上报一次，自动计算 duration
 *
 * 失败后按指数退避重试（默认最多 3 次）。
 */
import { extractMainDomain } from '../wechat/WxUtils';

/** 单次点击事件（eventType=1）数据包 */
export interface ClickEventPacket {
  userId: string;
  projectId: number | null;
  traceId: string;
  currentAt: number;
  [key: string]: unknown;
}

/** 时长事件（eventType=2）数据包 */
export interface DurationEventPacket {
  userId: string;
  projectId: number | null;
  traceId: string;
  beginAt: number;
  endAt: number;
  duration: number;
  [key: string]: unknown;
}

export type EventPacket = ClickEventPacket | DurationEventPacket;

/** sendEvent 的参数结构 */
export interface EventData {
  /** 事件分类（如 'new-behavior'） */
  category: string;
  /** 事件动作（如 'duration.world.stay'） */
  action: string;
  /** 事件数据负载 */
  data: EventPacket;
}

/** send() 的 extra 参数 */
export interface SendExtra {
  /** 时长事件开始标志 */
  started?: boolean;
  /** 时长事件结束标志 */
  ended?: boolean;
  /** 是否使用匿名 ID */
  useNoId?: boolean;
  [key: string]: unknown;
}

/** SDK 实例的最小接口（避免循环引用） */
interface SDKRef {
  token: string | null;
  getUsername(): Promise<string | null>;
}

class RemoteLog {
  private apiEndpoint: string;
  private sdk: SDKRef;
  private maxRetries = 3;
  private retryDelay = 1000;
  /** 进行中的时长事件缓存，key = `${userId}_${action}` */
  private pendingEvents = new Map<string, DurationEventPacket>();
  /** 缓存的请求头（含 User-Agent / Referer，首次调用后复用） */
  private headers: Record<string, string> | null = null;

  constructor(sdk: SDKRef) {
    const hostname =
      typeof window !== 'undefined' ? window.location.hostname : 'keepwork.com';
    const domain = extractMainDomain(hostname);
    this.apiEndpoint = `https://api.${domain}/event-gateway/events/send`;
    this.sdk = sdk;
  }

  // ──────────────────── 域名 / 工具 ────────────────────

  /**
   * 从 hostname 提取主域名（保持与重构前 RemoteLog.js 一致的原型方法表面）。
   * 委托给 WxUtils.extractMainDomain，逻辑等价。
   */
  extractMainDomain(hostname: string): string {
    return extractMainDomain(hostname);
  }

  /**
   * 获取当前时间戳（毫秒），对应 Lua 的 `GetServerTime`。
   */
  getServerTime(): number {
    return Date.now();
  }

  /**
   * 生成 UUID v4 格式的 traceId，用于追踪单条事件链路。
   */
  generateTraceId(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  // ──────────────────── 事件包生成 ────────────────────

  /**
   * 生成事件数据包（对应 Lua `GenerateDataPacket`）。
   *
   * - type=1（单次事件）：立即构建含 `currentAt` 的包
   * - type=2（时长事件）：首次调用记录开始时间；再次调用计算 duration
   *
   * @param eventType - 1 单次事件，2 时长事件
   * @param userId    - 用户 ID
   * @param action    - 动作名称
   * @param started   - 时长事件专用：true 表示事件已在计时中
   * @param projectId - 项目 ID（可选）
   */
  generateDataPacket(
    eventType: 1 | 2,
    userId: string,
    action: string,
    started = false,
    projectId: number | null = null
  ): EventPacket | null {
    if (!userId || !action) return null;

    const basePacket = {
      userId,
      projectId,
      traceId: this.generateTraceId(),
    };

    if (eventType === 1) {
      return { ...basePacket, currentAt: this.getServerTime() } as ClickEventPacket;
    }

    if (eventType === 2) {
      const eventKey = `${userId}_${action}`;
      const previousEvent = this.pendingEvents.get(eventKey);

      if (!previousEvent) {
        const packet: DurationEventPacket = {
          ...basePacket,
          beginAt: this.getServerTime(),
          endAt: 0,
          duration: 0,
        };
        this.pendingEvents.set(eventKey, packet);
        return packet;
      } else {
        if (started) {
          return { ...previousEvent, duration: this.getServerTime() - previousEvent.beginAt };
        } else {
          const endAt = this.getServerTime();
          const finalPacket: DurationEventPacket = {
            ...previousEvent,
            endAt,
            duration: endAt - previousEvent.beginAt,
          };
          this.pendingEvents.delete(eventKey);
          return finalPacket;
        }
      }
    }

    return null;
  }

  // ──────────────────── 发送 ────────────────────

  /**
   * 发送事件（对应 Lua `EventTrackingService:Send`）。
   *
   * 自动从 SDK 实例获取用户 ID（若调用方未提供）。
   * 时长事件未正确结束时会跳过发送，避免写入无效数据。
   *
   * @param eventType    - 1 单次事件，2 时长事件
   * @param action       - 动作名称
   * @param extra        - 附加数据（started/ended 标志 + 业务字段）
   * @param offlineMode  - 是否离线模式（当前未实现，预留）
   * @param useNewCatalog - 是否使用新分类（决定 category 前缀）
   * @param userId       - 用户 ID（可选，为空时从 SDK 获取）
   * @param projectId    - 项目 ID（可选）
   * @returns 成功返回事件包，失败返回 false
   */
  async send(
    eventType: 1 | 2,
    action: string,
    extra: SendExtra = {},
    offlineMode = false,
    useNewCatalog = true,
    userId: string | null = null,
    projectId: number | null = null
  ): Promise<EventPacket | false> {
    if (eventType !== 1 && eventType !== 2) {
      console.error('Invalid eventType. Must be 1 (one-click) or 2 (duration)');
      return false;
    }
    if (!action || typeof action !== 'string') {
      console.error('Invalid action. Must be a non-empty string');
      return false;
    }

    const resolvedUserId = userId ?? (await this.getUserId());
    if (!resolvedUserId) return false;

    const dataPacket = this.generateDataPacket(
      eventType,
      resolvedUserId,
      action,
      extra.started ?? false,
      projectId
    );

    if (!dataPacket) {
      console.error('Failed to generate data packet');
      return false;
    }

    // 将 extra 中的业务字段合并到包（排除控制字段）
    const cleanExtra = { ...extra };
    delete cleanExtra.started;
    delete cleanExtra.ended;
    delete cleanExtra.useNoId;
    Object.assign(dataPacket, cleanExtra);

    // 时长事件未完整结束时跳过
    if (eventType === 2) {
      const durationPacket = dataPacket as DurationEventPacket;
      if (extra.ended && (durationPacket.duration === 0 || durationPacket.endAt === 0)) {
        const eventKey = `${resolvedUserId}_${action}`;
        this.pendingEvents.delete(eventKey);
        return false;
      }
    }

    const category = useNewCatalog ? 'new-behavior' : 'behavior';
    try {
      await this.sendEvent({ category, action, data: dataPacket });
      return dataPacket;
    } catch (error) {
      console.error('Failed to send event', error);
      return false;
    }
  }

  /**
   * 构建浏览器特征请求头（首次调用后缓存，避免重复构建）。
   * @internal
   */
  getBrowserHeaders(): Record<string, string> {
    if (!this.headers) {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (typeof window !== 'undefined' && navigator) {
        if (navigator.userAgent) headers['User-Agent'] = navigator.userAgent;
        if (window.location) headers['Referer'] = window.location.href;
      }
      this.headers = headers;
    }
    return this.headers;
  }

  /**
   * 向远端发送事件日志，失败后按指数退避重试。
   *
   * @param eventData   - 事件数据对象
   * @param retryCount  - 当前已重试次数（内部递归使用）
   */
  async sendEvent(eventData: EventData, retryCount = 0): Promise<unknown> {
    try {
      const headers = this.getBrowserHeaders();
      if (this.sdk.token) headers['Authorization'] = `Bearer ${this.sdk.token}`;

      const content = JSON.stringify(eventData);
      const response = await fetch(this.apiEndpoint, {
        method: 'POST',
        headers,
        body: content,
      });

      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
      const result = await response.json();
      console.log('RemoteLog Sent: ', content);
      return result;
    } catch (error) {
      console.error(`Failed to send event (attempt ${retryCount + 1}):`, error);
      if (retryCount < this.maxRetries) {
        const delay = this.retryDelay * Math.pow(2, retryCount); // 指数退避
        await new Promise((resolve) => setTimeout(resolve, delay));
        return this.sendEvent(eventData, retryCount + 1);
      }
      throw error;
    }
  }

  /**
   * 获取当前登录用户的用户名（代理到 sdk.getUsername）。
   */
  async getUserId(): Promise<string | null> {
    return this.sdk.getUsername();
  }

  // ──────────────────── 便捷方法 ────────────────────

  /**
   * 上报自由格式的行为事件（直接构建事件包，不经过 generateDataPacket）。
   *
   * @param action   - 动作名称
   * @param data     - 事件数据（会附加 traceId 和 currentAt）
   * @param category - 事件分类（默认 'new-behavior'）
   */
  async logBehavior(
    action: string,
    data: Record<string, unknown>,
    category = 'new-behavior'
  ): Promise<unknown> {
    const eventData: EventData = {
      category,
      action,
      data: {
        userId: '',
        projectId: null,
        traceId: this.generateTraceId(),
        currentAt: Date.now(),
        ...data,
      } as ClickEventPacket,
    };
    return this.sendEvent(eventData);
  }

  /**
   * 上报单次点击事件（eventType=1 的便捷封装）。
   *
   * @param action       - 动作名称
   * @param extra        - 附加业务数据
   * @param useNewCatalog - 是否使用新分类
   * @param userId       - 用户 ID（可选）
   * @param projectId    - 项目 ID（可选）
   */
  async logClick(
    action: string,
    extra: SendExtra = {},
    useNewCatalog = true,
    userId: string | null = null,
    projectId: number | null = null
  ): Promise<EventPacket | false> {
    return this.send(1, action, extra, false, useNewCatalog, userId, projectId);
  }
}

export default RemoteLog;
