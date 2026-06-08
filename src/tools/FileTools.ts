/**
 * FileTools.ts — 工作空间文件操作工具（供 CopilotTools 注册为 'read'/'edit'/'search'/'fileOps' 分类）
 *
 * 所有文件操作均在 `sdk.personalPageStore` 的工作空间作用域内执行，
 * 不允许访问主机文件系统。
 *
 * 支持的工具函数：
 * - `read_file`：按行范围读取文件内容（可选 `${...}` 模板展开）
 * - `list_dir`：列出目录内容
 * - `replace_string_in_file`：单次字符串替换
 * - `multi_replace_string_in_file`：批量字符串替换
 * - `create_file`：创建新文件
 * - `grep_search`：文本/正则搜索
 */

import SDKLogger from '../utils/SDKLogger';

const console = SDKLogger.createModuleConsole('FileTools');

/** 工具函数定义（OpenAI Function Calling 格式） */
export interface ToolDefinition {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

/** FileTools 运行时配置 */
export interface FileToolsConfig {
  /** 文件路径前缀（所有路径都会被拼接到此前缀下） */
  pathPrefix?: string;
  /** 工作空间名称（传递给 personalPageStore.withConfig） */
  workspace?: string;
  /** Mounted folder 配置 */
  mountFolder?: unknown;
  /** 关联的 ChatSession（用于 processTemplate 展开） */
  _session?: {
    sandbox?: {
      processTemplate?: (content: string) => Promise<string>;
      _templateSourceFile?: string | null;
    };
  };
  [key: string]: unknown;
}

/** PersonalPageStore 作用域实例的最小接口 */
interface ScopedStore {
  readFile(pageName: string, startLine?: number, endLine?: number): Promise<string | null>;
  replaceStringInFile(pageName: string, oldString: string, newString: string): Promise<string>;
  grepSearch(query: string, isRegexp?: boolean, includePattern?: string, maxResults?: number): Promise<string>;
  createFile(pageName: string, content?: string): Promise<string>;
  listDir(path: string, recursive?: boolean): Promise<string>;
  withConfig(config: Record<string, unknown>): ScopedStore;
}

/** SDK 最小接口 */
interface SDKRef {
  personalPageStore?: ScopedStore;
}

/** multi_replace_string_in_file 单条操作 */
interface ReplaceOperation {
  filePath: string;
  oldString: string;
  newString: string;
}

class FileTools {
  // ──────────────────── 工具定义 ────────────────────

  static readonly readDefinitions: ToolDefinition[] = [
    {
      type: 'function',
      function: {
        name: 'read_file',
        description:
          'Read the contents of a file.\n\nYou must specify the line range you\'re interested in. Line numbers are 1-indexed. If the file contents returned are insufficient for your task, you may call this tool again to retrieve more content. Prefer reading larger ranges over doing many small reads.',
        parameters: {
          type: 'object',
          properties: {
            filePath: { type: 'string', description: 'The path of the file to read.' },
            startLine: { type: 'number', description: 'The line number to start reading from, 1-based.' },
            endLine: { type: 'number', description: 'The inclusive line number to end reading at, 1-based.' },
            allowScript: {
              type: 'boolean',
              description: 'If true, run any inline ${...} template expressions in the file content through the sandbox environment after reading. Defaults to false.',
            },
          },
          required: ['filePath', 'startLine', 'endLine'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'list_dir',
        description:
          'List the contents of a directory. Result will have the name of the child. If the name ends in /, it\'s a folder, otherwise a file. By default only lists direct children; set recursive to true for a full recursive listing.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'The absolute path to the directory to list.' },
            recursive: { type: 'boolean', description: 'Whether to list recursively. Defaults to false.' },
          },
          required: ['path'],
        },
      },
    },
  ];

  static readonly editDefinitions: ToolDefinition[] = [
    {
      type: 'function',
      function: {
        name: 'replace_string_in_file',
        description:
          'Make edits in an existing file. Provide: 1) filePath, 2) oldString (exact literal text to replace), 3) newString (replacement). Each use replaces exactly ONE occurrence of oldString.',
        parameters: {
          type: 'object',
          properties: {
            filePath: { type: 'string', description: 'The path of the file to edit.' },
            oldString: { type: 'string', description: 'The exact literal text to replace.' },
            newString: { type: 'string', description: 'The exact literal text to replace oldString with.' },
          },
          required: ['filePath', 'oldString', 'newString'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'create_file',
        description: 'Create a new file (overwriting old file) in the workspace with the specified content.',
        parameters: {
          type: 'object',
          properties: {
            filePath: { type: 'string', description: 'The absolute path to the file to create.' },
            content: { type: 'string', description: 'The content to write to the file.' },
          },
          required: ['filePath', 'content'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'multi_replace_string_in_file',
        description:
          'Apply multiple replace_string_in_file operations in a single call. More efficient than calling replace_string_in_file multiple times.',
        parameters: {
          type: 'object',
          properties: {
            explanation: { type: 'string', description: 'Brief explanation of what the multi-replace will accomplish.' },
            replacements: {
              type: 'array',
              description: 'Array of replacement operations.',
              items: {
                type: 'object',
                properties: {
                  filePath: { type: 'string' },
                  oldString: { type: 'string' },
                  newString: { type: 'string' },
                },
                required: ['filePath', 'oldString', 'newString'],
              },
              minItems: 1,
            },
          },
          required: ['explanation', 'replacements'],
        },
      },
    },
  ];

  static readonly searchDefinitions: ToolDefinition[] = [
    {
      type: 'function',
      function: {
        name: 'grep_search',
        description: 'Do a fast text search across files. Use this tool to search with an exact string or regex.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'The pattern to search for in files. Is case-insensitive.' },
            isRegexp: { type: 'boolean', description: 'Whether the pattern is a regex.' },
            includePattern: { type: 'string', description: 'Search files matching this glob pattern.' },
            maxResults: { type: 'number', description: 'Maximum number of results to return. Default is 100.' },
          },
          required: ['query', 'isRegexp'],
        },
      },
    },
  ];

  /** 所有工具定义的合并（read + edit + search） */
  static get definitions(): ToolDefinition[] {
    return [...this.readDefinitions, ...this.editDefinitions, ...this.searchDefinitions];
  }

  // ──────────────────── 实例 ────────────────────

  private sdk: SDKRef;
  private config: FileToolsConfig = {};

  constructor(sdk: SDKRef) {
    this.sdk = sdk;
  }

  /** 更新工具运行时配置（由 CopilotTools.setToolConfig 调用）。 */
  setConfig(config: FileToolsConfig): void {
    this.config = config ?? {};
  }

  // ──────────────────── 工具分发 ────────────────────

  /**
   * 执行文件操作工具。
   * 所有路径经 `pathPrefix` 拼接后传入 `personalPageStore`，
   * 不会直接操作主机文件系统。
   *
   * @param name   - 工具名
   * @param args   - 工具参数
   * @param config - 运行时配置（含 workspace / pathPrefix / _session 等）
   */
  async execute(
    name: string,
    args: Record<string, unknown> = {},
    config: FileToolsConfig = {}
  ): Promise<string> {
    if (!this.sdk.personalPageStore) return 'Failed: PersonalPageStore not available';

    const baseStore = this.sdk.personalPageStore;
    const toolConfig: FileToolsConfig = { ...this.config, ...config };
    const pathPrefix = toolConfig.pathPrefix ?? '';

    const resolvePageName = (filePath: string): string =>
      pathPrefix ? `${pathPrefix}/${filePath}` : filePath;

    const store = baseStore.withConfig(toolConfig as Record<string, unknown>);

    try {
      if (name === 'read_file') {
        const { filePath, startLine, endLine, allowScript } = args as {
          filePath?: string; startLine?: number; endLine?: number; allowScript?: boolean;
        };
        if (!filePath) return 'Failed: filePath is required';

        let content = await store.readFile(resolvePageName(filePath), startLine, endLine);

        // SKILL.md 文件自动展开模板，除非 allowScript 显式为 false
        const shouldExpand =
          allowScript === false
            ? false
            : (allowScript === true || /SKILL\.md$/i.test(filePath));

        if (shouldExpand && content && typeof content === 'string') {
          const sandbox = toolConfig._session?.sandbox;
          if (sandbox && typeof sandbox.processTemplate === 'function') {
            const prevSourceFile = sandbox._templateSourceFile;
            sandbox._templateSourceFile = resolvePageName(filePath);
            try {
              content = await sandbox.processTemplate(content);
            } finally {
              sandbox._templateSourceFile = prevSourceFile;
            }
          }
        }
        return content ?? '';
      }

      if (name === 'replace_string_in_file') {
        const { filePath, oldString, newString } = args as { filePath?: string; oldString?: string; newString?: string };
        if (!filePath) return 'Failed: filePath is required';
        if (oldString === undefined || oldString === null) return 'Failed: oldString is required';
        if (newString === undefined || newString === null) return 'Failed: newString is required';
        return await store.replaceStringInFile(resolvePageName(filePath), oldString, newString);
      }

      if (name === 'grep_search') {
        const { query, isRegexp, includePattern, maxResults } = args as {
          query?: string; isRegexp?: boolean; includePattern?: string; maxResults?: number;
        };
        if (!query) return 'Failed: query is required';
        return await store.grepSearch(query, isRegexp, includePattern, maxResults);
      }

      if (name === 'create_file') {
        const { filePath, content } = args as { filePath?: string; content?: string };
        if (!filePath) return 'Failed: filePath is required';
        return await store.createFile(resolvePageName(filePath), content);
      }

      if (name === 'list_dir') {
        const { path, recursive } = args as { path?: string; recursive?: boolean };
        if (!path) return 'Failed: path is required';
        return await store.listDir(resolvePageName(path), !!recursive);
      }

      if (name === 'multi_replace_string_in_file') {
        const { explanation, replacements } = args as {
          explanation?: string;
          replacements?: ReplaceOperation[];
        };
        if (!replacements || !Array.isArray(replacements) || replacements.length === 0) {
          return 'Failed: replacements array is required and must not be empty';
        }

        const results: Array<{ index: number; status: string; message: string }> = [];
        for (let i = 0; i < replacements.length; i++) {
          const r = replacements[i]!;
          if (!r.filePath) { results.push({ index: i, status: 'failed', message: 'filePath is required' }); continue; }
          if (r.oldString === undefined || r.oldString === null) { results.push({ index: i, status: 'failed', message: 'oldString is required' }); continue; }
          if (r.newString === undefined || r.newString === null) { results.push({ index: i, status: 'failed', message: 'newString is required' }); continue; }
          try {
            const res = await store.replaceStringInFile(resolvePageName(r.filePath), r.oldString, r.newString);
            results.push({ index: i, status: res.startsWith('Failed') ? 'failed' : 'success', message: res });
          } catch (e) {
            results.push({ index: i, status: 'failed', message: (e as Error).message });
          }
        }

        const succeeded = results.filter((r) => r.status === 'success').length;
        const failed = results.filter((r) => r.status === 'failed').length;
        let summary = `Multi-replace: ${succeeded} succeeded, ${failed} failed.`;
        if (explanation) summary = `${explanation}\n${summary}`;
        if (failed > 0) {
          summary +=
            '\nFailures:\n' +
            results
              .filter((r) => r.status === 'failed')
              .map((r) => `  [${r.index}]: ${r.message}`)
              .join('\n');
        }
        return summary;
      }
    } catch (e) {
      // RestartAgentSignal 需向上传播
      if (e && (e as Record<string, unknown>)['isRestartAgentSignal']) throw e;
      return `Failed: ${(e as Error).message}`;
    }

    return 'Unknown file operation tool';
  }
}

export default FileTools;
