/**
 * DigitalHumanBridge.ts — DigitalHuman 外部上下文与 page-router 心跳桥接工具
 *
 * 这些函数操作传入的 DigitalHuman 实例（target）内部字段，用于：
 * - 管理"外部上下文"的去抖自动 flush（注入额外上下文后延迟发送 "(continue)"）
 * - 停止 page-router 心跳调度
 */

/** 外部上下文消息 */
export interface ExternalContextMessage {
  /** 上下文文本 */
  text?: string;
  /** 去抖毫秒数；省略或非有限值表示一直缓存到下次用户消息 */
  debounce?: number;
  /** 是否跳过历史记录 */
  skipHistory?: boolean;
}

/**
 * 桥接函数操作的目标对象（DigitalHuman 实例需具备的字段/方法）。
 * 用结构化接口而非 any，保持类型安全。
 */
export interface ExternalContextTarget {
  _externalContextDebounceTimer: ReturnType<typeof setTimeout> | null;
  _externalContextSkipHistory: boolean;
  _pageRouterHeartbeatToken: number;
  _pageRouterHeartbeatTimer: ReturnType<typeof setTimeout> | null;
  /** 缓存外部上下文 */
  sendContext(text: string): void;
  /** 发送用户消息 */
  send(text: string, options?: Record<string, unknown>): Promise<unknown>;
  /** 内部 auto-flush 实现（由 autoFlushExternalContext 触发） */
  _autoFlushExternalContext(): Promise<unknown> | void;
}

/**
 * 清除待发送的外部上下文去抖定时器。
 * 外部上下文本身已被 sendContext() 入队，此处仅停止延迟的 "(continue)" auto-flush。
 */
export function clearExternalContextDebounce(target: ExternalContextTarget): void {
  if (target._externalContextDebounceTimer) {
    clearTimeout(target._externalContextDebounceTimer);
    target._externalContextDebounceTimer = null;
  }
}

/**
 * 停止 page-router 心跳调度并使在途定时器失效（通过自增 token）。
 */
export function stopPageRouterHeartbeat(target: ExternalContextTarget): void {
  target._pageRouterHeartbeatToken += 1;
  if (target._pageRouterHeartbeatTimer) {
    clearTimeout(target._pageRouterHeartbeatTimer);
    target._pageRouterHeartbeatTimer = null;
  }
}

/**
 * 缓存外部上下文，并可选地启动 auto-flush 去抖定时器。
 * 默认去抖为 Infinity（上下文一直排队，直到下一条显式用户消息）；
 * 有限去抖值会在到期后自动发送 "(continue)"。
 * @returns 是否成功处理（text 非空）
 */
export function handleExternalContextMessage(
  target: ExternalContextTarget,
  msg: ExternalContextMessage = {},
): boolean {
  const text = String(msg.text || '').trim();
  if (!text) return false;

  target.sendContext(text);

  const debounceMs = msg.debounce !== undefined ? Number(msg.debounce) : Infinity;
  clearExternalContextDebounce(target);
  target._externalContextSkipHistory = !!msg.skipHistory;

  if (Number.isFinite(debounceMs) && debounceMs >= 0) {
    target._externalContextDebounceTimer = setTimeout(() => {
      target._externalContextDebounceTimer = null;
      target._autoFlushExternalContext();
    }, debounceMs);
  }

  return true;
}

/**
 * 通过发送合成的 "(continue)" 用户消息来 auto-flush 缓存的外部上下文。
 * 当缓存上下文请求了 skipHistory 时，转发 fullHistoryOnly 以保留原行为。
 */
export async function autoFlushExternalContext(target: ExternalContextTarget): Promise<unknown> {
  const fullHistoryOnly = target._externalContextSkipHistory;
  target._externalContextSkipHistory = false;
  return target.send('(continue)', fullHistoryOnly ? { fullHistoryOnly: true } : {});
}
