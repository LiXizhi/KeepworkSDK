/**
 * WebTool.ts — 网页内容抓取工具
 *
 * 通过 `fetch_webpage` 工具获取一个或多个 URL 的页面文本，
 * 提取正文并按 `query` 关键词定位相关片段，供 AI 分析使用。
 *
 * LLM 工具定义：`fetch_webpage`
 */

import SDKLogger from '../utils/SDKLogger';

const console = SDKLogger.createModuleConsole('WebTool');

/** 工具函数定义（OpenAI Function Calling 格式） */
export interface ToolDefinition {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

/** WebTool 运行时配置 */
export interface WebToolConfig {
  /** 单个 URL 返回的最大字符数（默认 6000） */
  maxContentLength?: number;
  /** 请求超时毫秒数（默认 15000） */
  timeoutMs?: number;
  [key: string]: unknown;
}

/** 单个 URL 的抓取结果 */
export interface FetchResult {
  url: string;
  title?: string;
  contentType?: string;
  matchedQuery?: boolean;
  truncated?: boolean;
  content?: string;
  error?: string;
}

/** fetch_webpage 工具返回值 */
export interface FetchWebpageResult {
  query: string;
  results: FetchResult[];
}

/** parseWebpageContent 返回值 */
interface ParsedContent {
  title: string;
  content: string;
}

class WebTool {
  /** LLM 可见的工具定义列表 */
  static readonly definitions: ToolDefinition[] = [
    {
      type: 'function',
      function: {
        name: 'fetch_webpage',
        description:
          'Fetches the main content from a web page. This tool is useful for summarizing or analyzing the content of a webpage. You should use this tool when you think the user is looking for information from a specific webpage.',
        parameters: {
          type: 'object',
          properties: {
            urls: {
              type: 'array',
              items: { type: 'string' },
              description: 'An array of URLs to fetch content from.',
            },
            query: {
              type: 'string',
              description:
                'The query to search for in the web page content. Should be a clear and concise description of the content you want to find.',
            },
          },
          required: ['urls', 'query'],
        },
      },
    },
  ];

  private config: WebToolConfig = {};

  /** 更新工具运行时配置（由 CopilotTools.setToolConfig 调用）。 */
  setConfig(config: WebToolConfig): void {
    this.config = config ?? {};
  }

  // ──────────────────── 工具分发 ────────────────────

  /**
   * 执行指定工具函数。
   *
   * @param name   - 工具名（目前仅支持 'fetch_webpage'）
   * @param args   - 工具参数（urls 数组 + query 字符串）
   * @param config - 运行时配置
   */
  async execute(
    name: string,
    args: { urls?: string[]; query?: string } | unknown,
    config: WebToolConfig = {}
  ): Promise<string | FetchWebpageResult> {
    if (name !== 'fetch_webpage') return 'Unknown web fetch tool';

    const { urls, query } = (args as { urls?: string[]; query?: string }) ?? {};
    if (!Array.isArray(urls) || urls.length === 0) {
      return 'Failed: urls is required and must be a non-empty array';
    }
    if (!query || typeof query !== 'string') {
      return 'Failed: query is required';
    }

    const mergedConfig: WebToolConfig = { ...this.config, ...config };
    const maxContentLength = mergedConfig.maxContentLength ?? 6000;
    const timeoutMs = mergedConfig.timeoutMs ?? 15000;

    const results = await Promise.all(
      urls.map((url) => this.fetchWebpageContent(url, query, { maxContentLength, timeoutMs }))
    );

    return { query, results };
  }

  // ──────────────────── 网页抓取 ────────────────────

  /**
   * 抓取单个 URL 的页面内容，按 query 提取相关片段。
   *
   * @param url     - 目标 URL
   * @param query   - 用于定位相关内容的查询词
   * @param options - 配置（maxContentLength / timeoutMs）
   */
  async fetchWebpageContent(
    url: string,
    query: string,
    options: { maxContentLength?: number; timeoutMs?: number } = {}
  ): Promise<FetchResult> {
    const { maxContentLength = 6000, timeoutMs = 15000 } = options;

    try {
      const normalizedUrl = new URL(url).toString();
      const abortController =
        typeof AbortController !== 'undefined' ? new AbortController() : null;
      let timer: ReturnType<typeof setTimeout> | null = null;

      if (abortController && timeoutMs > 0) {
        timer = setTimeout(() => abortController.abort(), timeoutMs);
      }

      const response = await fetch(normalizedUrl, {
        method: 'GET',
        headers: {
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
        },
        signal: abortController?.signal,
      });

      if (timer) clearTimeout(timer);

      if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);

      const contentType = response.headers.get('content-type') ?? '';
      const rawText = await response.text();

      if (this.shouldReturnRawContent(normalizedUrl, contentType)) {
        return { url: normalizedUrl, title: '', contentType, matchedQuery: false, truncated: false, content: rawText };
      }

      const parsed = this.parseWebpageContent(rawText, contentType);
      const querySnippet = this.buildQuerySnippet(parsed.content, query, Math.min(maxContentLength, 1800));
      const sourceContent = querySnippet || parsed.content;
      const finalContent = sourceContent.slice(0, maxContentLength);

      return {
        url: normalizedUrl,
        title: parsed.title,
        contentType,
        matchedQuery: Boolean(querySnippet),
        truncated: finalContent.length < sourceContent.length,
        content: finalContent,
      };
    } catch (error) {
      return { url, error: (error as Error).message || 'Failed to fetch webpage' };
    }
  }

  // ──────────────────── 内容解析 ────────────────────

  /**
   * 判断是否应直接返回原始内容（Markdown / JSON / 非 HTML）。
   */
  shouldReturnRawContent(url: string, contentType = ''): boolean {
    const pathname = new URL(url).pathname.toLowerCase();
    if (pathname.endsWith('.md') || pathname.endsWith('.json')) return true;
    const normalized = contentType.toLowerCase();
    return normalized.includes('markdown') || normalized.includes('application/json');
  }

  /**
   * 解析原始 HTML / 文本，提取标题和正文。
   * 浏览器环境使用 DOMParser；SSR 环境使用正则兜底。
   *
   * @param rawText     - 原始页面文本
   * @param contentType - HTTP Content-Type 响应头
   */
  parseWebpageContent(rawText: string, contentType = ''): ParsedContent {
    const isHtml =
      contentType.includes('text/html') ||
      /<html[\s>]/i.test(rawText) ||
      /<body[\s>]/i.test(rawText);

    if (!isHtml) {
      return { title: '', content: this.normalizeWebpageText(rawText) };
    }

    if (typeof DOMParser === 'undefined') {
      return {
        title: this.extractTitleFromHtml(rawText),
        content: this.normalizeWebpageText(rawText.replace(/<[^>]+>/g, ' ')),
      };
    }

    const doc = new DOMParser().parseFromString(rawText, 'text/html');
    const removable = ['script', 'style', 'noscript', 'svg', 'canvas', 'iframe', 'header', 'footer', 'nav', 'form', 'aside'];
    removable.forEach((sel) => doc.querySelectorAll(sel).forEach((node) => node.remove()));

    const title = this.normalizeWebpageText(doc.title ?? '');
    const contentRoot = this.selectMainContentNode(doc);
    const content = this.normalizeWebpageText(contentRoot?.textContent ?? '');

    return { title, content };
  }

  /**
   * 从 document 中选取主内容节点（main / article / [role="main"] 等优先）。
   * 回退到 document.body。
   */
  selectMainContentNode(doc: Document): Element | null {
    const selectors = ['main', 'article', '[role="main"]', '.main', '.content', '.article', '#main', '#content'];
    for (const selector of selectors) {
      const nodes = Array.from(doc.querySelectorAll(selector)).sort(
        (a, b) => (b.textContent ?? '').length - (a.textContent ?? '').length
      );
      if (nodes[0] && (nodes[0].textContent ?? '').trim()) return nodes[0];
    }
    return doc.body ?? doc.documentElement;
  }

  /** 从原始 HTML 字符串提取 `<title>` 内容（DOMParser 不可用时兜底）。 */
  extractTitleFromHtml(rawText: string): string {
    const match = rawText.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    return this.normalizeWebpageText(match?.[1] ?? '');
  }

  /** 压缩多余空白字符，返回干净的单行文本。 */
  normalizeWebpageText(text: string): string {
    return (text ?? '').replace(/\s+/g, ' ').replace(/\u00a0/g, ' ').trim();
  }

  /**
   * 在正文中找到 query 词汇最早出现位置，提取上下文片段。
   * 未匹配时返回空字符串。
   *
   * @param content   - 已规范化的正文文本
   * @param query     - 查询关键词（空格分隔）
   * @param maxLength - 返回片段最大字符数（默认 1800）
   */
  buildQuerySnippet(content: string, query: string, maxLength = 1800): string {
    const normalizedContent = this.normalizeWebpageText(content);
    if (!normalizedContent) return '';

    const loweredContent = normalizedContent.toLowerCase();
    const queryTerms = query
      .toLowerCase()
      .split(/\s+/)
      .map((t) => t.trim())
      .filter(Boolean)
      .filter((t, i, list) => list.indexOf(t) === i);

    let matchIndex = -1;
    for (const term of queryTerms) {
      const idx = loweredContent.indexOf(term);
      if (idx !== -1 && (matchIndex === -1 || idx < matchIndex)) matchIndex = idx;
    }

    if (matchIndex === -1) return '';

    const halfWindow = Math.floor(maxLength / 2);
    const start = Math.max(0, matchIndex - halfWindow);
    const end = Math.min(normalizedContent.length, start + maxLength);
    return normalizedContent.slice(start, end).trim();
  }
}

export default WebTool;
