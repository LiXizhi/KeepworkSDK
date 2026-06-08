/**
 * SDKLogger — KeepworkSDK 统一日志管理模块
 *
 * 通过模块级 console 代理对象，让宿主项目能够按模块粒度控制
 * SDK 的日志输出，而无需修改任何现有的 console.log() 调用点。
 *
 * ## 使用方式（每个 SDK 源文件顶部）
 * ```ts
 * import SDKLogger from './SDKLogger';
 * const console = SDKLogger.createModuleConsole('ModuleName');
 * ```
 * 之后文件内所有 `console.log/info/debug` 均受 SDKLogger 控制；
 * `console.warn/error` 始终透传，不受影响。
 *
 * ## 宿主项目控制示例
 * ```html
 * <!-- SDK 加载前预配置 -->
 * <script>window.__sdkLogConfig = { globalEnabled: false, modules: { AIChat: true } };</script>
 *
 * <!-- SDK 加载后动态控制 -->
 * <script>
 *   SDKLogger.setGlobalEnabled(false);
 *   SDKLogger.setModuleEnabled('DigitalHuman', false);
 *   SDKLogger.setOnlyEnabled(['AIChat', 'AgentRouter']);
 * </script>
 * ```
 *
 * ## 实现原理
 * `createModuleConsole` 返回的代理对象对 `log/info/debug` 使用 getter，
 * 每次访问时检查当前启用状态，返回原生绑定函数或 noop。
 * 这样 DevTools 的调用栈源码链接和 Source Map 仍指向原始调用点。
 */

// ──────────────────── 内部常量 ────────────────────

const _nativeConsole: Console =
  typeof console !== 'undefined' ? console : ({} as Console);

const _noop: (...args: unknown[]) => void = () => { /* intentional no-op */ };

/** 受控方法：可被静默 */
const _filteredMethods = ['log', 'info', 'debug'] as const;
type FilteredMethod = (typeof _filteredMethods)[number];

/** 透传方法：始终输出 */
const _passthroughMethods = [
  'warn', 'error', 'table', 'dir', 'group', 'groupCollapsed',
  'groupEnd', 'time', 'timeEnd', 'timeLog', 'trace', 'assert',
  'clear', 'count', 'countReset',
] as const;
type PassthroughMethod = (typeof _passthroughMethods)[number];

// ──────────────────── 代理对象类型 ────────────────────

/**
 * 模块 console 代理类型：
 * - 受控方法（log/info/debug）：通过 getter 动态检查启用状态
 * - 透传方法（warn/error 等）：始终指向原生方法
 *
 * 与 `Console` 接口的签名兼容，可安全遮蔽全局 `console`。
 */
export type ModuleConsole = Pick<Console, FilteredMethod | PassthroughMethod>;

// ──────────────────── SDKLogger ────────────────────

class SDKLogger {
  /** 全局启用开关（默认开启，向后兼容） */
  private static _globalEnabled = true;

  /**
   * 各模块的独立启用状态。
   * - `true`：该模块已明确启用
   * - `false`：该模块已明确禁用
   * - 未设置（undefined）：视为启用（默认开）
   */
  private static _modules: Record<string, boolean> = {};

  // ──────────────────── 公共静态 API ────────────────────

  /**
   * 检查指定模块的 log/info/debug 输出当前是否启用。
   *
   * 判断顺序：全局开关 → 模块开关（未设置视为 true）。
   */
  static isEnabled(moduleName: string): boolean {
    if (!SDKLogger._globalEnabled) return false;
    const flag = SDKLogger._modules[moduleName];
    return flag !== false; // undefined → 启用（默认开）
  }

  /**
   * 全局开关：启用或禁用所有模块的 log/info/debug 输出。
   *
   * @param enabled - true 启用，false 禁用全部
   */
  static setGlobalEnabled(enabled: boolean): void {
    SDKLogger._globalEnabled = enabled;
  }

  /**
   * 按模块名单独控制日志输出。
   *
   * @param moduleName - 与 createModuleConsole 传入的名称一致
   * @param enabled    - true 启用，false 禁用
   */
  static setModuleEnabled(moduleName: string, enabled: boolean): void {
    SDKLogger._modules[moduleName] = enabled;
  }

  /**
   * 便捷方法：只启用指定模块，其余全部禁用。
   * 适合调试时聚焦特定模块。
   *
   * @param names - 要保留输出的模块名数组
   */
  static setOnlyEnabled(names: string[]): void {
    // 先将所有已注册模块置为禁用
    for (const m of Object.keys(SDKLogger._modules)) {
      SDKLogger._modules[m] = false;
    }
    // 再启用指定模块
    for (const n of names) {
      SDKLogger._modules[n] = true;
    }
  }

  /**
   * 返回所有已注册模块及其当前启用状态的快照。
   * 可用于调试或在宿主页面展示日志控制面板。
   */
  static listModules(): Record<string, boolean> {
    const out: Record<string, boolean> = {};
    for (const m of Object.keys(SDKLogger._modules)) {
      out[m] = SDKLogger.isEnabled(m);
    }
    return out;
  }

  /**
   * 为指定模块创建 console 代理对象。
   *
   * 返回的代理对象与 `console` 接口兼容，可直接在文件顶部用
   * `const console = SDKLogger.createModuleConsole('X')` 遮蔽全局 console。
   *
   * - `log/info/debug`：通过 getter 惰性检查启用状态，每次调用前查询
   * - `warn/error` 等：直接绑定原生方法，始终透传
   * - DevTools 调用栈/Source Map 仍指向原始调用位置（因使用 .bind 而非包装函数）
   *
   * @param moduleName - 模块唯一标识（建议与类名或文件名一致）
   * @returns 与 Console 兼容的代理对象
   */
  static createModuleConsole(moduleName: string): ModuleConsole {
    // 首次注册时将模块标记为默认启用
    if (!(moduleName in SDKLogger._modules)) {
      SDKLogger._modules[moduleName] = true;
    }

    // 提前绑定原生方法，避免每次 getter 调用时重复 bind
    const boundFiltered = {} as Record<FilteredMethod, (...args: unknown[]) => void>;
    for (const m of _filteredMethods) {
      const native = _nativeConsole[m];
      boundFiltered[m] = typeof native === 'function'
        ? (native as (...args: unknown[]) => void).bind(_nativeConsole)
        : _noop;
    }

    // 构建代理对象
    const proxy = {} as ModuleConsole;

    // 受控方法：通过 getter 在每次访问时检查启用状态
    for (const m of _filteredMethods) {
      Object.defineProperty(proxy, m, {
        get(): (...args: unknown[]) => void {
          return SDKLogger.isEnabled(moduleName) ? boundFiltered[m]! : _noop;
        },
        enumerable: true,
        configurable: true,
      });
    }

    // 透传方法：直接绑定，无运行时检查开销
    for (const m of _passthroughMethods) {
      const native = _nativeConsole[m];
      (proxy as Record<string, unknown>)[m] = typeof native === 'function'
        ? (native as (...args: unknown[]) => void).bind(_nativeConsole)
        : _noop;
    }

    return proxy;
  }

  // ──────────────────── 内部初始化 ────────────────────

  /**
   * 读取 window.__sdkLogConfig 预配置（如果存在）。
   * 在模块求值时立即调用，支持宿主页面在 SDK 加载前配置日志行为。
   *
   * @internal
   */
  private static _applyPreConfig(): void {
    if (typeof window === 'undefined') return;
    const cfg = (window as { __sdkLogConfig?: { globalEnabled?: boolean; modules?: Record<string, boolean> } }).__sdkLogConfig;
    if (!cfg) return;
    if (typeof cfg.globalEnabled === 'boolean') {
      SDKLogger._globalEnabled = cfg.globalEnabled;
    }
    if (cfg.modules && typeof cfg.modules === 'object') {
      for (const [name, flag] of Object.entries(cfg.modules)) {
        SDKLogger._modules[name] = Boolean(flag);
      }
    }
  }
}

// 模块加载时立即应用预配置
SDKLogger['_applyPreConfig']();

export default SDKLogger;
