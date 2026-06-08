/**
 * AgentConfig.ts — Agent 配置读取器（完整 TypeScript 实现）
 *
 * 统一入口：从 JSON / YAML / Markdown(frontmatter) / Markdown 表格 多种格式
 * 读取并解析 agent 配置。原先是 DigitalHuman 的静态方法，抽出后任何模块
 * （SummarizeTool / AIChatRTC / 独立脚本等）都可加载配置而不依赖 DigitalHuman。
 *
 * @example
 *   import AgentConfig from './AgentConfig';
 *   const cfg = await AgentConfig.fetch('https://example.com/agent.yaml'); // URL（.json/.yml/.yaml/.md）
 *   const cfg2 = AgentConfig.parse('{ "llm_model": "keepwork-flash" }');   // 内联 JSON 字符串
 *   const cfg3 = AgentConfig.normalize({ workspace: 'ws', content: 'You are a helper.' }); // 仅归一化
 */

import YMLParser from '../store/YMLParser';

// ──────────────────── 类型声明 ────────────────────

/** 配置文件格式 */
export type AgentConfigFormat = 'json' | 'yml' | 'md';

/** fileOps 工具配置 */
export interface AgentFileOpsConfig {
  enabled?: boolean;
  workspace?: string;
  mountFolder?: string | Record<string, unknown>;
  [key: string]: unknown;
}

/** 归一化后的 agent 配置对象 */
export interface NormalizedAgentConfig {
  /** 系统提示词（由 .md frontmatter 的 content 转换而来） */
  system_prompt?: string;
  /** 顶层工作区，会传播到 tools.fileOps.workspace */
  workspace?: string;
  /** 挂载文件夹，会传播到 tools.fileOps.mountFolder */
  mountFolder?: string | Record<string, unknown>;
  /** 历史长度（history_length 的 camelCase 别名） */
  historyLength?: number;
  /** 工具配置块 */
  tools?: {
    fileOps?: AgentFileOpsConfig;
    [category: string]: unknown;
  };
  /** Markdown frontmatter 的正文（解析后会转为 system_prompt 并删除） */
  content?: string;
  /** snake_case 历史长度（解析后会转为 historyLength 并删除） */
  history_length?: number;
  [key: string]: unknown;
}

// ──────────────────── 格式检测 ────────────────────

/**
 * 根据 URL 文件扩展名检测配置格式。匹配前会剥离 query / fragment。
 */
function detectFormat(url: string): AgentConfigFormat | null {
  if (!url || typeof url !== 'string') return null;
  const path = url.split(/[?#]/)[0].toLowerCase();
  if (path.endsWith('.json')) return 'json';
  if (path.endsWith('.yml') || path.endsWith('.yaml')) return 'yml';
  if (path.endsWith('.md')) return 'md';
  return null;
}

// ──────────────────── 归一化 ────────────────────

/**
 * 就地归一化已解析的配置对象：
 * - .md frontmatter 的 `content` → `system_prompt`
 * - 顶层 `workspace`   → `tools.fileOps.workspace`
 * - 顶层 `mountFolder` → `tools.fileOps.mountFolder`
 * - `history_length`   → `historyLength`
 */
function normalize(config: NormalizedAgentConfig): NormalizedAgentConfig {
  if (!config || typeof config !== 'object') return config;

  // .md frontmatter：正文存为 content，转为 system_prompt
  if (config.content && !config.system_prompt) {
    const body = String(config.content).trim();
    if (body) config.system_prompt = body;
  }
  delete config.content;

  // 便利项：顶层 workspace → tools.fileOps.workspace
  if (config.workspace) {
    if (!config.tools) config.tools = {};
    if (!config.tools.fileOps) config.tools.fileOps = { enabled: false };
    if (!config.tools.fileOps.workspace) {
      config.tools.fileOps.workspace = config.workspace;
    }
  }

  // 便利项：顶层 mountFolder → tools.fileOps.mountFolder
  if (config.mountFolder) {
    if (!config.tools) config.tools = {};
    if (!config.tools.fileOps) config.tools.fileOps = { enabled: false };
    if (!config.tools.fileOps.mountFolder) {
      config.tools.fileOps.mountFolder = config.mountFolder;
    }
  }

  // history_length → historyLength（snake_case 别名）
  if (config.history_length !== undefined && config.historyLength === undefined) {
    config.historyLength = config.history_length;
  }
  delete config.history_length;

  return config;
}

// ──────────────────── 表格解析 ────────────────────

/**
 * 把 Markdown 表格解析为对象或对象数组。
 *
 * 期望管道分隔的表格（含表头行 + 分隔行）：
 *   | key        | value          |
 *   |------------|----------------|
 *   | llm_model  | keepwork-flash |
 *
 * 两列 key/value 表会折叠为一个扁平对象；多列则返回按表头键名的行对象数组。
 */
function parseTable(tableText: string): Record<string, unknown> | Array<Record<string, unknown>> {
  if (!tableText || typeof tableText !== 'string') return {};

  const lines = tableText.split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('|'));

  if (lines.length < 2) return {};

  // 提取表头单元格
  const headerCells = lines[0].split('|')
    .map(c => c.trim())
    .filter(Boolean);

  // 跳过分隔行（lines[1]），解析数据行
  const dataLines = lines.slice(2);
  const rows: Array<Record<string, string>> = dataLines.map(line => {
    const cells = line.split('|').map(c => c.trim()).filter(Boolean);
    const row: Record<string, string> = {};
    headerCells.forEach((h, i) => {
      row[h] = cells[i] !== undefined ? cells[i] : '';
    });
    return row;
  });

  // 两列 key/value 简写：折叠为扁平对象
  if (headerCells.length === 2) {
    const [keyCol, valCol] = headerCells;
    const isKV = keyCol.toLowerCase() === 'key' && valCol.toLowerCase() === 'value';
    if (isKV) {
      const obj: Record<string, unknown> = {};
      for (const row of rows) {
        const k = row[keyCol];
        if (k) obj[k] = _coerceValue(row[valCol]);
      }
      return obj;
    }
  }

  return rows;
}

/**
 * 尝试把字符串值强转为原生类型（boolean / number / null）。
 */
function _coerceValue(v: string): unknown {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null' || v === '') return null;
  const n = Number(v);
  if (!isNaN(n) && v.trim() !== '') return n;
  return v;
}

// ──────────────────── 同步解析 ────────────────────

/**
 * 把配置字符串（JSON / YAML / Markdown frontmatter / Markdown 表格）解析为
 * 归一化配置对象。**不**发起任何网络请求。
 *
 * 检测顺序：
 *   1. JSON（以 `{` 或 `[` 开头）
 *   2. Markdown frontmatter（以 `---` 开头）
 *   3. Markdown 表格（首个非空行以 `|` 开头）
 *   4. 纯 YAML
 *
 * @param text       - 原始配置文本
 * @param formatHint - 来自 URL 扩展名的可选格式提示
 */
function parse(text: string, formatHint?: AgentConfigFormat | null): NormalizedAgentConfig {
  if (!text || typeof text !== 'string') return {};

  const trimmed = text.trim();

  // 显式 JSON
  if (formatHint === 'json' || trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return normalize(JSON.parse(trimmed));
  }

  // Markdown frontmatter
  if (trimmed.startsWith('---\n') || trimmed.startsWith('---\r\n')) {
    const YML = _getYMLParser();
    if (YML) return normalize(YML.yamlToObject(trimmed, true) as NormalizedAgentConfig);
  }

  // Markdown 表格（首个非空行以 | 开头）
  const firstLine = trimmed.split('\n').find(l => l.trim());
  if (firstLine && firstLine.trim().startsWith('|')) {
    return normalize(parseTable(trimmed) as NormalizedAgentConfig);
  }

  // 兜底：先试 JSON，再试 YAML
  try {
    return normalize(JSON.parse(trimmed));
  } catch {
    const YML = _getYMLParser();
    if (YML) return normalize(YML.yamlToObject(trimmed, true) as NormalizedAgentConfig);
  }

  return {};
}

// ──────────────────── 异步获取 ────────────────────

/**
 * 从 URL / 内联 JSON 字符串 / 对象异步获取并解析 agent 配置。
 *
 * 支持的来源：
 *   - 普通对象 → 归一化后原样返回
 *   - JSON 字符串（以 `{`/`[` 开头）→ JSON.parse
 *   - `.json` URL → fetch + JSON.parse
 *   - `.yml`/`.yaml` URL → fetch + YMLParser
 *   - `.md` URL → fetch + YMLParser frontmatter
 *   - 未知扩展名 URL → 自动检测（JSON → frontmatter → YAML）
 */
async function fetchConfig(source: string | Record<string, unknown>): Promise<NormalizedAgentConfig> {
  // 对象直通
  if (source && typeof source === 'object') {
    return normalize({ ...source });
  }

  if (typeof source !== 'string' || !(source as string).trim()) {
    throw new Error('AgentConfig.fetch: source must be a non-empty string or object');
  }

  const trimmed = (source as string).trim();

  // 内联 JSON 字符串
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return normalize(JSON.parse(trimmed));
  }

  // URL — 拉取内容
  const resp = await fetch(trimmed);
  if (!resp.ok) {
    throw new Error(`AgentConfig.fetch: fetch failed (${resp.status}) for ${trimmed}`);
  }
  let text = await resp.text();

  // 剥离 VS Code Live Preview 注入的 script 标签（通过 Live Preview dev server 时存在）
  text = text.replace(
    /<script[^>]*\/___vscode_livepreview_injected_script[^>]*><\/script>\s*/gi,
    '',
  );

  const format = detectFormat(trimmed);
  return parse(text, format);
}

// ──────────────────── 辅助 ────────────────────

/** 从 import 或全局解析 YMLParser。 */
function _getYMLParser(): typeof YMLParser | null {
  if (typeof YMLParser !== 'undefined') return YMLParser;
  if (typeof window !== 'undefined' && (window as { YMLParser?: typeof YMLParser }).YMLParser) {
    return (window as { YMLParser?: typeof YMLParser }).YMLParser as typeof YMLParser;
  }
  return null;
}

// ──────────────────── 公开 API ────────────────────

/** AgentConfig 模块公开 API */
export interface IAgentConfig {
  detectFormat(url: string): AgentConfigFormat | null;
  normalize(config: NormalizedAgentConfig): NormalizedAgentConfig;
  parse(text: string, formatHint?: AgentConfigFormat | null): NormalizedAgentConfig;
  parseTable(tableText: string): Record<string, unknown> | Array<Record<string, unknown>>;
  fetch(source: string | Record<string, unknown>): Promise<NormalizedAgentConfig>;
}

const AgentConfig: IAgentConfig = {
  detectFormat,
  normalize,
  parse,
  parseTable,
  fetch: fetchConfig,
};

export default AgentConfig;
export { detectFormat, normalize, parse, parseTable, fetchConfig };
