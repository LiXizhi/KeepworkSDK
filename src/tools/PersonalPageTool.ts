/**
 * PersonalPageTool.ts — 个人页面数据存取工具（供 CopilotTools 注册为 'personalPage' 分类）
 *
 * 封装 sdk.personalPageStore，向 LLM 暴露两个工具函数：
 * - `personal_page_load`：按 pageName/key 读取持久化数据
 * - `personal_page_save`：按 pageName/key 写入持久化数据
 *
 * 数据层级：`[Root] → [Category (pageName)] → [Property (key)]`
 */

import SDKLogger from '../utils/SDKLogger';

const console = SDKLogger.createModuleConsole('PersonalPageTool');

/** 工具函数定义（OpenAI Function Calling 格式） */
export interface ToolDefinition {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

/** PersonalPageTool 运行时配置 */
export interface PersonalPageToolConfig {
  /** 页面名称前缀（从 config 或 args 中取） */
  pageName?: string;
  /** key 前缀 */
  key?: string;
  [key: string]: unknown;
}

/** SDK 最小接口 */
interface SDKRef {
  personalPageStore?: {
    loadPageData(pageName: string, key?: string): Promise<unknown>;
    savePageData(pageName: string, key: string | undefined, data: unknown, bForceFlush?: boolean): Promise<void>;
  };
}

class PersonalPageTool {
  /** LLM 可见的工具定义列表 */
  static readonly definitions: ToolDefinition[] = [
    {
      type: 'function',
      function: {
        name: 'personal_page_load',
        description:
          '加载个人页面数据。用于获取用户的持久化数据。当用户询问"是什么"、"有没有"、"查一下"某项信息时使用。',
        parameters: {
          type: 'object',
          properties: {
            pageName: {
              type: 'string',
              description:
                "数据的逻辑分类名称（Category），用于区分不同模块的数据，例如 'farm_config', 'user_status'。如果不确定分类，可以不传，将检索所有数据。然后根据key来筛选数据。",
            },
            key: {
              type: 'string',
              description:
                "分类下的具体属性名（Property）。例如 'level', 'money'。如果不传，则获取Root结构下的所有数据，从所有数据中筛选出和用户描述相关的数据。",
            },
          },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'personal_page_save',
        description:
          '保存个人页面数据。用于"记住"、"设置"或"更新"用户信息（持久化存储）。\n' +
          '**数据结构**：`[Root] -> [Category (pageName)] -> [Property (key)]`。\n' +
          '**使用说明**：\n' +
          '1. **逻辑分类（必须）**：必须使用 `pageName` 对数据进行分类（如 `farm_config`）。\n' +
          '2. **保存模式**：\n' +
          '   - **单属性模式**：传入 `key` 和 `data`（设置单个属性）。\n' +
          '   - **全分类模式**：不传 `key`，`data` 为包含多个属性的对象。\n' +
          '3. **先查后改**：如果不确定当前数据状态，建议先调用 load 工具查询。\n' +
          '**命名规范**：`pageName` 和 `key` 请使用 snake_case。',
        parameters: {
          type: 'object',
          properties: {
            pageName: {
              type: 'string',
              description: "数据的逻辑分类名称（Category），例如 'farm_config', 'user_status'。",
            },
            key: {
              type: 'string',
              description:
                "分类下的具体属性名（Property）。例如 'level', 'money'。如果保存的是整个分类的数据对象（data包含多个属性），则不要传 key。",
            },
            data: {
              type: 'object',
              description: '要保存的具体内容（可以是数字、字符串或 JSON 对象）。',
            },
            bForceFlush: {
              type: 'boolean',
              description: '是否强制写入磁盘。默认为 true。',
            },
          },
          required: ['pageName', 'data'],
        },
      },
    },
  ];

  private sdk: SDKRef;
  private config: PersonalPageToolConfig = {};

  constructor(sdk: SDKRef) {
    this.sdk = sdk;
  }

  /** 更新工具运行时配置（由 CopilotTools.setToolConfig 调用）。 */
  setConfig(config: PersonalPageToolConfig): void {
    this.config = config ?? {};
  }

  // ──────────────────── 工具分发 ────────────────────

  /**
   * 执行个人页面工具操作。
   *
   * @param name   - 工具名（'personal_page_load' | 'personal_page_save'）
   * @param args   - 工具参数
   * @param config - 运行时配置（含 pageName / key 前缀）
   */
  async execute(
    name: string,
    args: {
      pageName?: string;
      key?: string;
      data?: unknown;
      bForceFlush?: boolean;
    } = {},
    config: PersonalPageToolConfig = {}
  ): Promise<string> {
    const mergedConfig: PersonalPageToolConfig = { ...this.config, ...config };
    const filePageName = mergedConfig.pageName ?? args.pageName;
    if (!filePageName) {
      return "Failed: Configuration error - 'pageName' (file name) is missing.";
    }

    let storageKey = mergedConfig.key ?? '';

    if (name === 'personal_page_load') {
      if (args.pageName) {
        storageKey = storageKey ? `${storageKey}.${args.pageName}` : args.pageName;
        if (args.key) {
          storageKey = storageKey ? `${storageKey}.${args.key}` : args.key;
        }
      }
    } else {
      if (args.pageName) {
        storageKey = storageKey ? `${storageKey}.${args.pageName}` : args.pageName;
      }
      if (args.key) {
        storageKey = storageKey ? `${storageKey}.${args.key}` : args.key;
      }
    }

    if (name === 'personal_page_load') {
      try {
        console.log(`[PersonalPageTool] Loading data from file '${filePageName}', key '${storageKey}'`);
        if (!this.sdk.personalPageStore) throw new Error('SDK PersonalPageStore not available');
        const data = storageKey
          ? await this.sdk.personalPageStore.loadPageData(filePageName, storageKey)
          : await this.sdk.personalPageStore.loadPageData(filePageName);
        return JSON.stringify(data);
      } catch (e) {
        console.error('[PersonalPageTool] Load failed:', e);
        return `Failed to load data: ${(e as Error).message}`;
      }
    }

    if (name === 'personal_page_save') {
      const { data, bForceFlush } = args;
      try {
        console.log(`[PersonalPageTool] Saving data to file '${filePageName}', key '${storageKey}'`, data);
        if (!this.sdk.personalPageStore) throw new Error('SDK PersonalPageStore not available');
        await this.sdk.personalPageStore.savePageData(
          filePageName,
          storageKey || undefined,
          data,
          bForceFlush
        );
        return 'Data saved successfully.';
      } catch (e) {
        console.error('[PersonalPageTool] Save failed:', e);
        return `Failed to save data: ${(e as Error).message}`;
      }
    }

    return 'Unknown personal page tool';
  }
}

export default PersonalPageTool;
