/**
 * DigitalHumanUtils.ts — DigitalHuman / DigitalHumanFrame 共享轻量工具
 *
 * 提供事件发射器 mixin 和心跳/时长解析工具。
 */

/** 事件监听回调 */
export type EventListener<T = unknown> = (data: T) => void;

/** 事件发射器 mixin 提供的方法集合 */
export interface EventEmitterMixin {
  /** 内部监听表，由 _initEvents 初始化 */
  _listeners?: Record<string, EventListener[]>;
  /** 初始化监听表（构造时调用） */
  _initEvents(this: EventEmitterMixin): void;
  /** 注册事件监听 */
  on(this: EventEmitterMixin, event: string, callback: EventListener): EventEmitterMixin;
  /** 移除事件监听 */
  off(this: EventEmitterMixin, event: string, callback: EventListener): EventEmitterMixin;
  /** 触发事件 */
  emit(this: EventEmitterMixin, event: string, data?: unknown): void;
}

/** createEventEmitterMixin 选项 */
export interface EventEmitterMixinOptions {
  /** 日志前缀标签 */
  label?: string;
  /** 自定义 logger（默认全局 console） */
  logger?: Pick<Console, 'warn'>;
}

/**
 * 创建一个可被 Object.assign 到类原型上的事件发射器 mixin。
 * 被 DigitalHuman 和 DigitalHumanFrame 共用。
 */
export function createEventEmitterMixin(
  { label, logger = console }: EventEmitterMixinOptions = {},
): EventEmitterMixin {
  const prefix = label ? `[${label}]` : '[EventEmitter]';
  return {
    _initEvents(this: EventEmitterMixin): void {
      this._listeners = {};
    },

    on(this: EventEmitterMixin, event: string, callback: EventListener): EventEmitterMixin {
      if (!this._listeners) this._listeners = {};
      if (!this._listeners[event]) this._listeners[event] = [];
      this._listeners[event].push(callback);
      return this;
    },

    off(this: EventEmitterMixin, event: string, callback: EventListener): EventEmitterMixin {
      const list = this._listeners?.[event];
      if (list && this._listeners) {
        this._listeners[event] = list.filter((fn) => fn !== callback);
      }
      return this;
    },

    emit(this: EventEmitterMixin, event: string, data?: unknown): void {
      const list = this._listeners?.[event];
      if (!list) return;
      for (const fn of list) {
        try {
          fn(data);
        } catch (error) {
          logger.warn(`${prefix} Event '${event}' listener error:`, error);
        }
      }
    },
  };
}

/**
 * 解析心跳间隔（数字或时长字符串如 "5s" / "500ms"）为毫秒。
 * 纯数字按 page-router 心跳约定视为「秒」。
 * @param value       - 间隔值
 * @param defaultUnit - 默认单位（默认 's'）
 * @returns 毫秒数，无效时返回 0
 */
export function parseIntervalToMs(value: number | string, defaultUnit: string = 's'): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value * 1000 : 0;
  }
  if (typeof value !== 'string') return 0;

  const match = value.trim().match(/^(\d+(?:\.\d+)?)(?:\s*(ms|s|m|h))?$/i);
  if (!match) return 0;

  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return 0;

  const unit = (match[2] || defaultUnit).toLowerCase();
  const multipliers: Record<string, number> = { ms: 1, s: 1000, m: 60000, h: 3600000 };
  return amount * (multipliers[unit] || 1);
}

/**
 * 解析心跳最大次数，钳制为非负整数。
 * @param value    - 次数值
 * @param fallback - 缺省回退（默认 3）
 */
export function parseHeartbeatMaxCount(value: number | string | null | undefined, fallback: number = 3): number {
  if (value === undefined || value === null || value === '') return fallback;
  const count = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(count) || count < 0) return fallback;
  return Math.floor(count);
}

/**
 * 解析通用毫秒时长（数字或 "500ms" / "5s" / "1m" 字符串）。
 * @param value     - 时长值
 * @param fallbackMs - 回退毫秒（默认 0）
 */
export function parseDurationMs(value: number | string | null | undefined, fallbackMs: number = 0): number {
  if (value === undefined || value === null || value === '') return fallbackMs;
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : fallbackMs;
  return parseIntervalToMs(String(value), 'ms') || fallbackMs;
}
