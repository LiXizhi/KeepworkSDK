/**
 * ExecuteTool.ts — 在当前浏览器上下文中安全执行任意 JavaScript 的工具
 *
 * 以 `AsyncFunction` 动态编译并运行代码，捕获 `console` 输出，
 * 并通过 `copilot` 代理对象暴露 CopilotTools 的全部工具给代码内部调用。
 *
 * LLM 工具定义：`run_app_cmd`
 */

import SDKLogger from '../utils/SDKLogger';

const console = SDKLogger.createModuleConsole('ExecuteTool');

// AsyncFunction 构造器（动态执行核心）
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => (...params: unknown[]) => Promise<unknown>;

/** 工具函数定义（OpenAI Function Calling 格式） */
export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** 捕获的 console 日志条目 */
interface ConsoleLog {
  level: string;
  message: string;
}

/** execute() 调用配置 */
export interface ExecuteConfig {
  /** 关联的 ChatSession（用于访问 sandbox.copilot） */
  _session?: {
    sandbox?: {
      copilot?: Record<string, (...args: unknown[]) => Promise<unknown>>;
    };
  };
  [key: string]: unknown;
}

/** SDK 最小接口（避免循环引用） */
interface SDKRef {
  copilotTools?: {
    execute: (toolName: string, params: unknown, config: unknown) => Promise<unknown>;
  };
}

class ExecuteTool {
  /** LLM 可见的工具定义列表 */
  static readonly definitions: ToolDefinition[] = [
    {
      type: 'function',
      function: {
        name: 'run_app_cmd',
        description:
          'Run app specific command (mostly simple javascript). Prefer single line command. Each command runs in the same session so state is preserved between calls.',
        parameters: {
          type: 'object',
          properties: {
            command: {
              type: 'string',
              description:
                'The command (javascript) to execute. Use single line commands when possible.',
            },
            timeout: {
              type: 'number',
              description:
                'Maximum time in milliseconds to wait for the command to complete. Defaults to 30000 (30 seconds). Use 0 for no timeout.',
            },
          },
          required: ['command'],
        },
      },
    },
  ];

  private sdk: SDKRef;
  private config: ExecuteConfig = {};

  constructor(sdk: SDKRef) {
    this.sdk = sdk;
  }

  /** 更新工具运行时配置（由 CopilotTools.setToolConfig 调用）。 */
  setConfig(config: ExecuteConfig): void {
    this.config = config ?? {};
  }

  // ──────────────────── 工具分发 ────────────────────

  /**
   * 执行指定工具函数。
   *
   * @param name   - 工具名（目前仅支持 'run_app_cmd'）
   * @param args   - 工具参数
   * @param config - 运行时配置（含 _session 等）
   */
  async execute(
    name: string,
    args: { command?: string; timeout?: number } | string[] | unknown,
    config: ExecuteConfig = {}
  ): Promise<string> {
    if (name === 'run_app_cmd') {
      const command =
        Array.isArray(args)
          ? (args[0] as string)
          : ((args as Record<string, unknown>)?.['command'] as string | undefined) ?? '';
      if (!command || typeof command !== 'string') return 'Failed: command is required';
      const mergedConfig: ExecuteConfig = { ...this.config, ...config };
      return this.runAppCmd(command, mergedConfig);
    }
    return 'Unknown execute tool';
  }

  // ──────────────────── 核心执行逻辑 ────────────────────

  /**
   * 在安全沙箱中执行 JavaScript 代码。
   *
   * 执行环境：
   * - `sdk`：KeepworkSDK 实例
   * - `config`：调用方配置
   * - `window` / `document`：当前浏览器环境
   * - `console`：已捕获输出的代理 console
   * - `copilot`：CopilotTools 的 Proxy，可调用任意已注册工具
   *
   * 单行表达式自动加 `return`；多行代码以语句形式执行。
   *
   * @param code   - 要执行的 JavaScript 代码字符串
   * @param config - 运行时配置
   * @returns 格式化的执行输出（含 console 日志 + 返回值）
   */
  async runAppCmd(code: string, config: ExecuteConfig = {}): Promise<string> {
    const logs: ConsoleLog[] = [];

    try {
      // 构建捕获 console 的代理对象
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const originalConsole: any = console;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const wrappedConsole: any = Object.create(originalConsole);
      const consoleMethods = ['log', 'info', 'warn', 'error', 'debug'] as const;

      for (const level of consoleMethods) {
        wrappedConsole[level] = (...args: unknown[]): void => {
          logs.push({ level, message: args.map((a) => this.stringifyValue(a)).join(' ') });
          if (typeof originalConsole[level] === 'function') originalConsole[level](...args);
        };
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const executionWindow: any =
        typeof window !== 'undefined' ? Object.create(window) : undefined;
      if (executionWindow) executionWindow.console = wrappedConsole;

      const copilot = this.createCopilotProxy(config);

      const trimmedCode = code.trim();
      const expressionCandidate = trimmedCode.replace(/;+\s*$/, '');
      const body = this.isSingleExpression(expressionCandidate)
        ? `"use strict";\nreturn (${expressionCandidate});`
        : `"use strict";\n${code}`;

      const runner = new AsyncFunction('sdk', 'config', 'window', 'document', 'console', 'copilot', body);
      const result = await runner(
        this.sdk,
        config,
        executionWindow,
        typeof document !== 'undefined' ? document : undefined,
        wrappedConsole,
        copilot
      );

      return this.formatExecutionOutput(result, logs);
    } catch (error) {
      const consoleOutput = this.formatConsoleOutput(logs);
      const errorOutput = `Failed to execute JavaScript: ${(error as Error).message}`;
      return consoleOutput ? `${consoleOutput}\n\n${errorOutput}` : errorOutput;
    }
  }

  // ──────────────────── 工具代理 ────────────────────

  /**
   * 创建 copilot 工具代理对象。
   * 优先使用 session.sandbox.copilot（已配置完整代理）；
   * 否则创建一个直接调用 sdk.copilotTools.execute 的 Proxy。
   *
   * @param config - 运行时配置
   */
  createCopilotProxy(config: ExecuteConfig): Record<string, unknown> {
    const sandboxCopilot = config._session?.sandbox?.copilot;
    if (sandboxCopilot) return sandboxCopilot;

    return new Proxy({} as Record<string, unknown>, {
      get: (_target, toolName: string | symbol) => {
        if (typeof toolName !== 'string') return undefined;
        return async (...args: unknown[]): Promise<unknown> => {
          if (!this.sdk?.copilotTools?.execute) {
            throw new Error('CopilotTools not available on the SDK instance');
          }
          let params: unknown;
          if (args.length === 1 && args[0] && typeof args[0] === 'object' && !Array.isArray(args[0])) {
            params = args[0];
          } else if (args.length === 0) {
            params = {};
          } else {
            params = { args };
          }
          return this.sdk.copilotTools.execute(toolName, params, config);
        };
      },
    });
  }

  // ──────────────────── 输出格式化 ────────────────────

  /** 将任意值序列化为字符串（循环引用安全）。 */
  stringifyValue(value: unknown): string {
    if (typeof value === 'string') return value;
    try {
      const s = JSON.stringify(value);
      if (s !== undefined) return s;
    } catch { /* circular reference — fall through */ }
    return String(value);
  }

  /** 格式化捕获的 console 日志数组为字符串。 */
  formatConsoleOutput(logs: ConsoleLog[]): string {
    if (!logs.length) return '';
    return `Console output:\n${logs
      .map(({ level, message }) => (level === 'log' ? message : `[${level}] ${message}`))
      .join('\n')}`;
  }

  /** 组合 console 输出和执行结果为最终字符串。 */
  formatExecutionOutput(result: unknown, logs: ConsoleLog[]): string {
    const output: string[] = [];
    const consoleOutput = this.formatConsoleOutput(logs);
    if (consoleOutput) output.push(consoleOutput);
    if (result === undefined) {
      output.push('JavaScript executed successfully.');
      return output.join('\n\n');
    }
    output.push(this.stringifyValue(result));
    return output.join('\n\n');
  }

  // ──────────────────── 表达式检测 ────────────────────

  /**
   * 判断给定代码是否为单行 JS 表达式（可安全加 `return`）。
   * 任何包含换行、分号或语句关键字的代码视为语句块。
   */
  isSingleExpression(code: string): boolean {
    if (!code) return false;
    if (/[\r\n]/.test(code)) return false;
    if (code.includes(';')) return false;
    const statementStart =
      /^(?:var|let|const|if|else|for|while|do|switch|case|break|continue|return|throw|try|catch|finally|function|class|import|export|with|debugger|yield)\b/;
    if (statementStart.test(code)) return false;
    if (/^[{;]/.test(code)) return false;
    return true;
  }
}

export default ExecuteTool;
