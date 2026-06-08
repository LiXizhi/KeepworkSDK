/**
 * CopilotTools.ts — AI 工具分类注册与调度中心（TypeScript 版）
 *
 * 管理所有可供 AI 会话使用的工具分类（category），提供：
 * - `registerToolCategory()`：注册自定义工具分类（含 definitions / executor / onConfig）
 * - `getToolDefinitions()`：按分类名获取 OpenAI 格式工具定义（支持按函数名过滤和排除）
 * - `execute()`：按函数名分发工具调用到对应分类的 executor
 * - `resolveEnabledCategories()`：将 toolsConfig 对象解析为分类名数组
 * - `setToolConfig()`：更新分类的运行时配置
 *
 * ## 内置工具分类
 * | 分类名       | 工具                        |
 * |-------------|----------------------------|
 * | mqtt         | mqtt_publish/get/subscribe  |
 * | read         | read_file, list_dir         |
 * | edit         | replace_string_in_file, create_file, multi_replace |
 * | search       | grep_search                 |
 * | fileOps      | read + edit + search 合集   |
 * | execute      | run_app_cmd                 |
 * | web          | fetch_webpage               |
 * | personalPage | personal_page_load/save     |
 * | agent        | runAsyncAgentTask 等        |
 * | app          | read_app, click_element 等  |
 * | summarize    | summarize_conversation 等   |
 */

import SDKLogger from '../utils/SDKLogger';
import MqttTool from '../tools/MqttTool';
import FileTools from '../tools/FileTools';
import AgentTool from '../tools/AgentTool';
import PersonalPageTool from '../tools/PersonalPageTool';
import ExecuteTool from '../tools/ExecuteTool';
import WebTool from '../tools/WebTool';
import AppTools from '../tools/AppTools';
import SummarizeTool from '../tools/SummarizeTool';

const console = SDKLogger.createModuleConsole('CopilotTools');

// ──────────────────── 类型定义 ────────────────────

/** 工具函数定义（OpenAI Function Calling 格式） */
export interface ToolDefinition {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

/** 工具分类注册表条目 */
export interface ToolCategoryEntry {
  definitions: ToolDefinition[];
  /** 工具执行器（fnName, fnArgs, config） => result */
  executor: (fnName: string, fnArgs: unknown, config?: unknown) => Promise<unknown>;
  /** 运行时配置更新回调 */
  onConfig?: (config: unknown) => void;
  /**
   * 为 true 时，此分类的工具不会被 SandboxToolEnv 的分类级代理自动路由；
   * 需通过 toolProxy.functions 明确指定才会走代理路径。
   */
  disableAutoProxy?: boolean;
}

/** SDK 最小接口 */
interface SDKRef {
  agentRouter?: {
    instanceId?: string;
    hasRemoteAgent?: (name: string) => boolean;
    submitTask?: (name: string, payload: unknown, callbacks?: unknown) => Promise<unknown>;
  };
  [key: string]: unknown;
}

// ──────────────────── CopilotTools ────────────────────

class CopilotTools {
  /** 工具分类注册表 */
  _registry: Record<string, ToolCategoryEntry> = {};
  /** 函数名 → 主分类名 反向索引 */
  _fnNameToCategory: Record<string, string> = {};
  /** 各分类的运行时配置 */
  toolConfigs: Record<string, unknown> = {};

  /** AppTools 类引用（供外部访问） */
  static AppTools: typeof AppTools;
  AppTools: typeof AppTools;

  // 内置工具实例
  private mqttTool: InstanceType<typeof MqttTool>;
  private fileTools: InstanceType<typeof FileTools>;
  private agentTool: InstanceType<typeof AgentTool>;
  private personalPageTool: InstanceType<typeof PersonalPageTool>;
  private executeTool: InstanceType<typeof ExecuteTool>;
  private webTool: InstanceType<typeof WebTool>;
  private summarizeTool: InstanceType<typeof SummarizeTool>;
  private appTools: InstanceType<typeof AppTools>;

  constructor(sdk: SDKRef) {
    this.AppTools = AppTools;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sdkAny = sdk as any;
    this.mqttTool = new MqttTool();
    this.fileTools = new FileTools(sdkAny);
    this.agentTool = new AgentTool(sdkAny);
    this.personalPageTool = new PersonalPageTool(sdkAny);
    this.executeTool = new ExecuteTool(sdkAny);
    this.webTool = new WebTool();
    this.summarizeTool = new SummarizeTool();
    this.appTools = new AppTools(sdkAny);

    this._registerBuiltinTools();
  }

  // ──────────────────── 工具分类注册 API ────────────────────

  /**
   * 注册一个工具分类。
   *
   * 同一函数名可属于多个分类；第一个注册该函数名的分类成为其主执行者。
   * 后续包含同名函数的分类（如 'fileOps' 包含 read/edit/search 中的所有函数）
   * 仍可通过 `getToolDefinitions` 暴露定义，但执行调度以先注册者为准。
   *
   * @param name  - 分类名（如 'mqtt' / 'fileOps'）
   * @param entry - 分类入口（definitions / executor / onConfig / disableAutoProxy）
   */
  registerToolCategory(name: string, entry: ToolCategoryEntry): void {
    this._registry[name] = {
      definitions: entry.definitions,
      executor: entry.executor,
      onConfig: entry.onConfig,
      disableAutoProxy: !!entry.disableAutoProxy,
    };
    for (const def of entry.definitions) {
      const fnName = def.function.name;
      if (!(fnName in this._fnNameToCategory)) {
        this._fnNameToCategory[fnName] = name;
      }
    }
  }

  /**
   * 获取指定分类列表对应的 OpenAI 格式工具定义（去重）。
   *
   * 支持格式：
   * - `"category"`：包含该分类所有函数
   * - `"category.fnName"`：仅包含指定函数
   * - `"-category.fnName"`：从完整分类包含中排除指定函数
   *
   * @param categoryNames - 分类名数组（空 / undefined 时返回 []）
   */
  getToolDefinitions(categoryNames?: string[]): ToolDefinition[] {
    if (!categoryNames || categoryNames.length === 0) return [];

    const fullCategories = new Set<string>();
    const perFunction = new Map<string, Set<string>>();
    const excluded = new Map<string, Set<string>>();

    for (const raw of categoryNames) {
      if (typeof raw !== 'string' || !raw) continue;

      if (raw.startsWith('-')) {
        const rest = raw.slice(1);
        const dot = rest.indexOf('.');
        if (dot === -1) continue;
        const cat = rest.slice(0, dot);
        const fn = rest.slice(dot + 1);
        if (!fn || !this._registry[cat]) continue;
        if (!excluded.has(cat)) excluded.set(cat, new Set());
        excluded.get(cat)!.add(fn);
        continue;
      }

      const dot = raw.indexOf('.');
      if (dot === -1) {
        if (this._registry[raw]) fullCategories.add(raw);
      } else {
        const cat = raw.slice(0, dot);
        const fn = raw.slice(dot + 1);
        if (!this._registry[cat] || !fn) continue;
        if (!perFunction.has(cat)) perFunction.set(cat, new Set());
        perFunction.get(cat)!.add(fn);
      }
    }

    const seen = new Set<string>();
    const result: ToolDefinition[] = [];

    for (const name of fullCategories) {
      const excludedFns = excluded.get(name);
      for (const def of this._registry[name]!.definitions) {
        const fnName = def.function.name;
        if (seen.has(fnName)) continue;
        if (excludedFns?.has(fnName)) continue;
        seen.add(fnName);
        result.push(def);
      }
    }

    for (const [cat, fnSet] of perFunction) {
      if (fullCategories.has(cat)) continue;
      const excludedFns = excluded.get(cat);
      for (const def of this._registry[cat]!.definitions) {
        const fnName = def.function.name;
        if (!fnSet.has(fnName)) continue;
        if (seen.has(fnName)) continue;
        if (excludedFns?.has(fnName)) continue;
        seen.add(fnName);
        result.push(def);
      }
    }

    return result;
  }

  /**
   * 导出指定分类的工具定义（可序列化格式）。
   * 供 DigitalHumanFrame 将父级工具定义传入子 iframe。
   *
   * @param categoryNames - 要导出的分类（空 / undefined 时导出全部）
   */
  getExportableDefinitions(categoryNames?: string[]): Record<string, ToolDefinition[]> {
    const names = categoryNames?.length ? categoryNames : Object.keys(this._registry);
    const result: Record<string, ToolDefinition[]> = {};
    for (const name of names) {
      if (this._registry[name]) result[name] = this._registry[name]!.definitions;
    }
    return result;
  }

  /**
   * 检查指定函数名是否在任意注册分类中可执行。
   * @param fnName - 工具函数名
   */
  canExecute(fnName: string): boolean {
    return fnName in this._fnNameToCategory;
  }

  /**
   * 按函数名执行工具，分发到对应分类的 executor。
   *
   * @param fnName - 工具函数名
   * @param fnArgs - 工具参数
   * @param config - 运行时配置
   */
  async execute(fnName: string, fnArgs: unknown, config: unknown = {}): Promise<unknown> {
    const categoryName = this._fnNameToCategory[fnName];
    if (!categoryName || !this._registry[categoryName]) {
      throw new Error(`Tool '${fnName}' not registered in any category`);
    }
    const sessionObj = (config as Record<string, unknown>)?.['_session'] as Record<string, unknown> | undefined;
    const sessionName = sessionObj?.['name'] || sessionObj?.['workspace'] || 'direct';
    const source = (config as Record<string, unknown>)?.['_proxied'] ? 'proxied' : 'local';
    const routerId =
      (this as unknown as { sdk?: SDKRef }).sdk?.agentRouter?.instanceId?.slice(0, 8) ||
      (typeof window !== 'undefined' && window.parent === window ? 'parent' : 'iframe');
    console.log(`[CopilotTools|${routerId}] ${source} execute: ${fnName} [category: ${categoryName}, session: ${sessionName}]`);
    return this._registry[categoryName]!.executor(fnName, fnArgs, config);
  }

  /**
   * 将 toolsConfig 对象解析为分类名数组（供 AIChat / SandboxToolEnv 使用）。
   *
   * 支持的 key 格式：
   * - `"category": { enabled: true }` — 启用整个分类
   * - `"category.fnName": { enabled: true }` — 仅启用该分类中的指定函数
   * - `"category.fnName": { enabled: false }` — 从完整分类包含中排除指定函数（生成 `-category.fnName` 条目）
   *
   * @param toolsConfig - 工具配置对象
   * @returns 已启用分类名数组（含点分函数名和排除标记）
   */
  resolveEnabledCategories(toolsConfig: Record<string, { enabled?: boolean }>): string[] {
    if (!toolsConfig || typeof toolsConfig !== 'object') return [];

    const ALIASES: Record<string, string> = {
      personal_page: 'personalPage',
      MqttTool: 'mqtt',
      PersonalPageTool: 'personalPage',
      ExecuteTool: 'execute',
      webFetch: 'web',
    };

    const enabled: string[] = [];

    for (const key in toolsConfig) {
      const value = toolsConfig[key];
      const dot = key.indexOf('.');

      if (dot !== -1 && value?.enabled === false) {
        const rawCat = key.slice(0, dot);
        const fnName = key.slice(dot + 1);
        if (!fnName) continue;
        const categoryName = ALIASES[rawCat] ?? rawCat;
        if (this._registry[categoryName]) enabled.push(`-${categoryName}.${fnName}`);
        continue;
      }

      if (!value || value.enabled === false) continue;

      if (dot === -1) {
        const categoryName = ALIASES[key] ?? key;
        if (this._registry[categoryName]) enabled.push(categoryName);
      } else {
        const rawCat = key.slice(0, dot);
        const fnName = key.slice(dot + 1);
        if (!fnName) continue;
        const categoryName = ALIASES[rawCat] ?? rawCat;
        if (this._registry[categoryName]) enabled.push(`${categoryName}.${fnName}`);
      }
    }

    return enabled;
  }

  /**
   * 设置指定分类的运行时配置。
   * 支持新名称（'mqtt' / 'personalPage'）和旧别名（'MqttTool' 等）。
   *
   * @param categoryName - 分类名或旧别名
   * @param config       - 运行时配置对象
   */
  setToolConfig(categoryName: string, config: unknown): void {
    const LEGACY_ALIASES: Record<string, string> = {
      MqttTool: 'mqtt',
      PersonalPageTool: 'personalPage',
      ExecuteTool: 'execute',
      webFetch: 'web',
    };
    const resolved = LEGACY_ALIASES[categoryName] ?? categoryName;
    this.toolConfigs[resolved] = config;
    const entry = this._registry[resolved];
    if (entry?.onConfig) entry.onConfig(config);
  }

  // ──────────────────── 内置工具注册 ────────────────────

  /**
   * 注册所有内置工具分类（构造函数内自动调用）。
   * 原子分类（read / edit / search）先注册，fileOps 作为合集后注册；
   * 原子分类的执行优先级高于 fileOps。
   * @private
   */
  private _registerBuiltinTools(): void {
    this.registerToolCategory('mqtt', {
      definitions: MqttTool.definitions,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      executor: (n, a, c = {}) => this.mqttTool.execute(n, a as any, { ...(this.toolConfigs['mqtt'] ?? {}), ...(c as Record<string, unknown>) } as any),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      onConfig: (c) => this.mqttTool.setConfig(c as any),
    });

    // 原子文件操作分类（优先取执行权）
    this.registerToolCategory('read', {
      definitions: FileTools.readDefinitions,
      executor: (n, a, c = {}) => this.fileTools.execute(n, a as Record<string, unknown>, { ...(this.toolConfigs['fileOps'] ?? {}), ...(c as Record<string, unknown>) }),
    });
    this.registerToolCategory('edit', {
      definitions: FileTools.editDefinitions,
      executor: (n, a, c = {}) => this.fileTools.execute(n, a as Record<string, unknown>, { ...(this.toolConfigs['fileOps'] ?? {}), ...(c as Record<string, unknown>) }),
    });
    this.registerToolCategory('search', {
      definitions: FileTools.searchDefinitions,
      executor: (n, a, c = {}) => this.fileTools.execute(n, a as Record<string, unknown>, { ...(this.toolConfigs['fileOps'] ?? {}), ...(c as Record<string, unknown>) }),
    });
    // fileOps 作为向后兼容合集
    this.registerToolCategory('fileOps', {
      definitions: FileTools.definitions,
      executor: (n, a, c = {}) => this.fileTools.execute(n, a as Record<string, unknown>, { ...(this.toolConfigs['fileOps'] ?? {}), ...(c as Record<string, unknown>) }),
    });

    this.registerToolCategory('execute', {
      definitions: ExecuteTool.definitions,
      executor: (n, a, c) => this.executeTool.execute(n, a as Record<string, unknown>, c as Record<string, unknown>),
      onConfig: (c) => this.executeTool.setConfig(c as Record<string, unknown>),
    });

    this.registerToolCategory('web', {
      definitions: WebTool.definitions,
      executor: (n, a, c) => this.webTool.execute(n, a as Record<string, unknown>, c as Record<string, unknown>),
      onConfig: (c) => this.webTool.setConfig(c as Record<string, unknown>),
    });

    this.registerToolCategory('personalPage', {
      definitions: PersonalPageTool.definitions,
      executor: (n, a, c = {}) => this.personalPageTool.execute(n, a as Record<string, unknown>, { ...(this.toolConfigs['personalPage'] ?? {}), ...(c as Record<string, unknown>) }),
    });

    this.registerToolCategory('agent', {
      definitions: AgentTool.definitions,
      executor: (n, a, c = {}) => this.agentTool.execute(n, a as Record<string, unknown>, { ...(this.toolConfigs['agent'] ?? {}), ...(c as Record<string, unknown>) }),
    });

    this.registerToolCategory('app', {
      definitions: AppTools.definitions,
      executor: (n, a, c) => this.appTools.execute(n, a as Record<string, unknown>, c as Record<string, unknown>),
      onConfig: (c) => this.appTools.setConfig(c as Record<string, unknown>),
    });

    this.registerToolCategory('summarize', {
      definitions: SummarizeTool.definitions,
      executor: (n, a, c) => this.summarizeTool.execute(n, a as Record<string, unknown>, c as Record<string, unknown>),
      onConfig: (c) => this.summarizeTool.setConfig(c as Record<string, unknown>),
      disableAutoProxy: true,
    });
  }
}

CopilotTools.AppTools = AppTools;

export default CopilotTools;
